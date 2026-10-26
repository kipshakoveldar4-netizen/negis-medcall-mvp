-- Local candidate after 073. No backfill, tenant settings or account changes.
-- Linked namesakes have separate capacity; missing IDs retain the legacy barrier.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ begin
  if current_user<>'postgres' or not exists(
    select 1 from pg_catalog.pg_proc p
    where p.oid=pg_catalog.to_regprocedure('public.guard_appointment_capacity()')
      and p.proowner=pg_catalog.to_regrole('postgres') and p.prosecdef
      and p.provolatile='v' and p.proconfig=array['search_path=""']::text[]
      and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex') in (
          '37ff4acb613a66b1e1341b3c76336acf224b5eee7764ee3ef3c07aaafba955d2',
          '73e57a6f89277b4fd543d709be37896c6876252d304be4c200ce0a1d56032a07'))
    or not exists(
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid=pg_catalog.to_regclass('public.appointments')
        and t.tgname='guard_appointment_capacity' and not t.tgisinternal
        and t.tgfoid=pg_catalog.to_regprocedure('public.guard_appointment_capacity()')
        and t.tgenabled='O' and t.tgtype=31 and t.tgqual is null
        and array(select a.attname::text from pg_catalog.pg_attribute a
          where a.attrelid=t.tgrelid and a.attnum=any(t.tgattr::smallint[]) order by a.attname)
          =array['doctor_id','doctor_name','duration_minutes','starts_at','status','workspace_id']::text[])
    then raise exception 'appointment_capacity_identity_dependencies_unconfirmed'; end if;
  if exists(select 1 from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated','service_role')
    and pg_catalog.has_function_privilege(r.oid,'public.guard_appointment_capacity()','EXECUTE'))
    then raise exception 'appointment_capacity_identity_acl_unconfirmed'; end if;
end $$;

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

  -- Preserve 057/073 row-before-name locking, including ambiguous legacy labels.
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

  -- Retaining/shrinking existing occupancy is not a new booking.
  if tg_op = 'UPDATE' and old_workspace is not distinct from new_workspace
    and old_doctor is not distinct from new_doctor and old_name is not distinct from new_name
    and pg_catalog.lower(pg_catalog.btrim(coalesce(old.status, ''))) not in ('cancelled', 'no_show')
    and old.starts_at is not null and new.starts_at >= old.starts_at
    and ends_at <= old.starts_at + pg_catalog.make_interval(
      mins => case when old.duration_minutes > 0 then old.duration_minutes else 60 end) then
    return new;
  end if;

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
  with intervals as (
    select greatest(a.starts_at, new.starts_at) as begins,
      least(a.starts_at + pg_catalog.make_interval(
        mins => case when a.duration_minutes > 0 then a.duration_minutes else 60 end), ends_at) as finishes
    from public.appointments a
    where a.workspace_id = new_workspace and a.id is distinct from new.id
      and (a.doctor_id = any(doctor_ids)
        or ((new_doctor is null or a.doctor_id is null)
          and pg_catalog.lower(pg_catalog.btrim(a.doctor_name)) = any(doctor_names)))
      and pg_catalog.lower(pg_catalog.btrim(coalesce(a.status, ''))) not in ('cancelled', 'no_show')
      and a.starts_at < ends_at
      and a.starts_at + pg_catalog.make_interval(
        mins => case when a.duration_minutes > 0 then a.duration_minutes else 60 end) > new.starts_at
  ), events as (
    select begins as at_time, 1 as delta from intervals
    union all select finishes, -1 from intervals
  ), deltas as (
    select at_time, pg_catalog.sum(delta) as delta from events group by at_time
  ), occupancy as (
    select pg_catalog.sum(delta) over (order by at_time rows unbounded preceding) as used from deltas
  )
  select coalesce(pg_catalog.max(used), 0) into occupied from occupancy;
  if occupied >= capacity_limit then
    raise exception using errcode = '23P01', message = 'appointment_capacity_exceeded';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_appointment_capacity() from public, anon, authenticated, service_role;
comment on function public.guard_appointment_capacity() is
  'Server-only peak capacity by explicit doctor identity; legacy names remain conservative. READ COMMITTED; no history backfill.';
commit;
notify pgrst, 'reload schema';
