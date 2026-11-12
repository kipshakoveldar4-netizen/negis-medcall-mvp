-- Apply after 036. Preparation only; do not apply to a working database without approval.
-- No backfill, price/status changes or mortgage-workspace changes.
begin;

create or replace function public.guard_appointment_capacity()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare
  old_workspace uuid;
  old_doctor uuid;
  old_name text;
  new_workspace uuid;
  new_doctor uuid;
  new_name text;
  locked_doctor record;
  lock_keys bigint[] := '{}'::bigint[];
  lock_key bigint;
  doctor_ids uuid[];
  doctor_names text[];
  capacity_limit integer;
  minutes integer;
  ends_at timestamptz;
  occupied bigint;
begin
  if tg_op <> 'INSERT' then
    old_workspace := old.workspace_id;
    old_doctor := old.doctor_id;
    old_name := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(old.doctor_name, ''))), '');
  end if;
  if tg_op <> 'DELETE' then
    new_workspace := new.workspace_id;
    new_doctor := new.doctor_id;
    new_name := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(new.doctor_name, ''))), '');
  end if;

  -- Operator booking 057 already takes the doctor row first. Keep that order
  -- before legacy-name locks so its later FK checks cannot form an inversion.
  for locked_doctor in
    select d.id, d.workspace_id, d.full_name from public.clinic_doctors d
    where (d.workspace_id = old_workspace and
      (d.id = old_doctor or (old_doctor is null and pg_catalog.lower(pg_catalog.btrim(d.full_name)) = old_name)))
      or (d.workspace_id = new_workspace and
      (d.id = new_doctor or (new_doctor is null and pg_catalog.lower(pg_catalog.btrim(d.full_name)) = new_name)))
    order by d.id for update
  loop
    lock_keys := pg_catalog.array_append(lock_keys, pg_catalog.hashtextextended(
      'appointment-capacity:' || locked_doctor.workspace_id::text || ':' ||
        pg_catalog.lower(pg_catalog.btrim(locked_doctor.full_name)), 0));
  end loop;
  if old_workspace is not null and old_name is not null then
    lock_keys := pg_catalog.array_append(lock_keys, pg_catalog.hashtextextended(
      'appointment-capacity:' || old_workspace::text || ':' || old_name, 0));
  end if;
  if new_workspace is not null and new_name is not null then
    lock_keys := pg_catalog.array_append(lock_keys, pg_catalog.hashtextextended(
      'appointment-capacity:' || new_workspace::text || ':' || new_name, 0));
  end if;
  for lock_key in select distinct k from pg_catalog.unnest(lock_keys) k order by k loop
    perform pg_catalog.pg_advisory_xact_lock(lock_key);
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  if pg_catalog.lower(pg_catalog.btrim(coalesce(new.status, ''))) in ('cancelled', 'no_show')
    or new.starts_at is null or (new_doctor is null and new_name is null) then
    return new;
  end if;
  if new_workspace is null or not pg_catalog.isfinite(new.starts_at) then
    raise exception using errcode = '22023', message = 'appointment_capacity_invalid';
  end if;
  minutes := case when new.duration_minutes > 0 then new.duration_minutes else 60 end;
  ends_at := new.starts_at + pg_catalog.make_interval(mins => minutes);

  -- An already occupied interval may be retained or shortened, even if legacy
  -- data exceeds today's capacity. Arrival/payment transitions are not bookings.
  if tg_op = 'UPDATE' and old_workspace is not distinct from new_workspace
    and old_doctor is not distinct from new_doctor and old_name is not distinct from new_name
    and pg_catalog.lower(pg_catalog.btrim(coalesce(old.status, ''))) not in ('cancelled', 'no_show')
    and old.starts_at is not null and new.starts_at >= old.starts_at
    and ends_at <= old.starts_at + pg_catalog.make_interval(
      mins => case when old.duration_minutes > 0 then old.duration_minutes else 60 end) then
    return new;
  end if;

  -- A snapshot fixed before the wait could miss its winner. PostgREST uses
  -- READ COMMITTED; other isolation levels fail closed instead of overbooking.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '40001', message = 'appointment_capacity_requires_read_committed';
  end if;
  select pg_catalog.array_agg(d.id), pg_catalog.array_agg(pg_catalog.lower(pg_catalog.btrim(d.full_name))),
      coalesce(pg_catalog.min(d.capacity), 1)
    into doctor_ids, doctor_names, capacity_limit
    from public.clinic_doctors d where d.workspace_id = new_workspace and
      (d.id = new_doctor or (new_doctor is null and pg_catalog.lower(pg_catalog.btrim(d.full_name)) = new_name));
  if new_doctor is not null and doctor_ids is null then
    raise exception using errcode = '23503', message = 'appointment_doctor_workspace_mismatch';
  end if;
  doctor_names := pg_catalog.array_append(coalesce(doctor_names, '{}'::text[]), new_name);
  select pg_catalog.count(*) into occupied from public.appointments a
    where a.workspace_id = new_workspace and a.id is distinct from new.id
      and (a.doctor_id = any(doctor_ids) or pg_catalog.lower(pg_catalog.btrim(a.doctor_name)) = any(doctor_names))
      and pg_catalog.lower(pg_catalog.btrim(coalesce(a.status, ''))) not in ('cancelled', 'no_show')
      and a.starts_at < ends_at
      and a.starts_at + pg_catalog.make_interval(
        mins => case when a.duration_minutes > 0 then a.duration_minutes else 60 end) > new.starts_at;
  if occupied >= capacity_limit then
    raise exception using errcode = '23P01', message = 'appointment_capacity_exceeded';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_appointment_capacity() from public, anon, authenticated, service_role;
drop trigger if exists guard_appointment_capacity on public.appointments;
create trigger guard_appointment_capacity
  before insert or update of workspace_id, doctor_id, doctor_name, starts_at, duration_minutes, status or delete
  on public.appointments for each row execute function public.guard_appointment_capacity();
create index if not exists appointments_workspace_capacity_name_idx
  on public.appointments(workspace_id, pg_catalog.lower(pg_catalog.btrim(doctor_name)), starts_at);
alter table public.appointments enable row level security;
grant select, insert, update, delete on public.appointments to service_role;
comment on function public.guard_appointment_capacity() is
  'Server-only atomic appointment capacity guard. READ COMMITTED; no client data in errors, no history backfill or mortgage activities changes.';
commit;
notify pgrst, 'reload schema';
