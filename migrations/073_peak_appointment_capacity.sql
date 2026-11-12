-- Apply after 057 and 072, only to an explicitly approved database.
-- Peak simultaneous occupancy, not the number of intersecting visits.
-- No backfill, account, tenant setting, price or mortgage-activity changes.
begin;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.appointments'::regclass and tgname = 'guard_appointment_capacity'
      and tgenabled = 'O' and not tgisinternal)
    or pg_catalog.to_regprocedure('public.create_growth_operator_booking(uuid,uuid,uuid,uuid,uuid,uuid[],timestamp without time zone,text)') is null then
    raise exception 'appointment_capacity_dependencies_required';
  end if;
end;
$$;

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
  with intervals as (
    select greatest(a.starts_at, new.starts_at) as begins,
      least(a.starts_at + pg_catalog.make_interval(
        mins => case when a.duration_minutes > 0 then a.duration_minutes else 60 end), ends_at) as finishes
    from public.appointments a
    where a.workspace_id = new_workspace and a.id is distinct from new.id
      and (a.doctor_id = any(doctor_ids) or pg_catalog.lower(pg_catalog.btrim(a.doctor_name)) = any(doctor_names))
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
  'Server-only atomic peak appointment capacity. READ COMMITTED; no history backfill or client data in errors.';

create or replace function public.create_growth_operator_booking(
  p_request_id uuid, p_operator_user_id uuid, p_lead_id uuid, p_request_key uuid,
  p_doctor_id uuid, p_service_ids uuid[], p_starts_local timestamp, p_time_zone text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  w uuid; tz text; start_at timestamptz; end_at timestamptz;
  l public.leads%rowtype; d public.clinic_doctors%rowtype;
  s public.clinic_services%rowtype; saved public.growth_operator_bookings%rowtype;
  a public.appointments%rowtype; service_id uuid;
  items jsonb := '[]'::jsonb; service_text text := ''; total bigint := 0; minutes integer := 0;
  allowed tstzmultirange; phone_key text; client_ids uuid[]; v_client_id uuid;
begin
  if p_request_key is null or p_doctor_id is null or p_starts_local is null
    or not isfinite(p_starts_local) or coalesce(cardinality(p_service_ids), 0) not between 1 and 20
    or exists (select 1 from unnest(p_service_ids) x where x is null)
    or (select count(distinct x) from unnest(p_service_ids) x) <> cardinality(p_service_ids)
    then raise exception 'operator_booking_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended('operator-booking:' || p_request_key::text, 0));
  w := public.operator_booking_workspace(p_request_id, p_operator_user_id, p_lead_id);
  select * into saved from public.growth_operator_bookings where request_key = p_request_key;
  if found then
    if saved.operator_request_id <> p_request_id or saved.lead_id <> p_lead_id
      or saved.doctor_id <> p_doctor_id or saved.service_ids <> p_service_ids
      or saved.starts_local <> p_starts_local or saved.time_zone is distinct from p_time_zone
      then raise exception 'operator_booking_retry_conflict'; end if;
    select * into a from public.appointments where id = saved.appointment_id and workspace_id = w;
  else
    select * into l from public.leads where id = p_lead_id and workspace_id = w;
    if nullif(btrim(l.full_name), '') is null or nullif(btrim(l.phone), '') is null
      then raise exception 'operator_booking_contact_required'; end if;
    select value->>'timeZone' into tz from public.workspace_settings
      where workspace_id = w and key = 'clinic_schedule' for share;
    if tz is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = tz)
      then raise exception 'operator_booking_schedule_required'; end if;
    if tz is distinct from p_time_zone then raise exception 'operator_booking_timezone_changed'; end if;
    start_at := p_starts_local at time zone tz;
    if start_at <= now() or date_trunc('minute', p_starts_local) <> p_starts_local
      or (start_at at time zone tz) <> p_starts_local
      then raise exception 'operator_booking_invalid'; end if;
    if exists (select 1 from public.growth_operator_bookings b join public.appointments existing
      on existing.id = b.appointment_id and existing.workspace_id = b.workspace_id
      where b.workspace_id = w and b.lead_id = l.id and existing.starts_at = start_at
        and lower(btrim(coalesce(existing.status, ''))) not in ('cancelled', 'no_show'))
      then raise exception 'operator_booking_already_exists'; end if;
    -- Serializes operator bookings for one master. Existing CRM write paths are unchanged.
    select * into d from public.clinic_doctors
      where id = p_doctor_id and workspace_id = w and is_active for update;
    if not found then raise exception 'operator_booking_doctor_unavailable'; end if;
    -- Lock in a stable order even when the client selected services in a different order.
    perform 1 from public.clinic_services where workspace_id = w and id = any(p_service_ids) order by id for share;
    foreach service_id in array p_service_ids loop
      select * into s from public.clinic_services where id = service_id and workspace_id = w
        and is_active and (doctor_id = d.id or doctor_id is null);
      if not found then raise exception 'operator_booking_service_unavailable'; end if;
      if s.base_price_minor is null or s.duration_minutes is null
        then raise exception 'operator_booking_price_required'; end if;
      total := total + s.base_price_minor; minutes := minutes + s.duration_minutes;
      if minutes > 600 or total > 10000000000 then raise exception 'operator_booking_invalid'; end if;
      items := items || jsonb_build_array(jsonb_build_object('serviceId', s.id, 'name', s.name,
        'priceMinor', s.base_price_minor, 'durationMinutes', s.duration_minutes));
      service_text := concat_ws(' + ', nullif(service_text, ''), s.name);
    end loop;
    end_at := start_at + make_interval(mins => minutes);
    perform 1 from public.clinic_doctor_shifts where workspace_id = w and doctor_id = d.id for share;
    select range_agg(tstzrange(
      (day + make_interval(mins => lower(part))) at time zone tz,
      (day + make_interval(mins => upper(part))) at time zone tz, '[)')) into allowed
    from (values (p_starts_local::date - 1), (p_starts_local::date), (p_starts_local::date + 1)) dates(day)
    cross join lateral unnest(public.operator_booking_day_minutes(w, d.id, day)) part;
    if allowed is null or not (tstzrange(start_at, end_at, '[)') <@ allowed)
      then raise exception 'operator_booking_outside_schedule'; end if;
    -- The 072/073 trigger is the single capacity authority, shared with CRM.
    -- A rejected INSERT rolls back the client, lead link and receipt as well.
    phone_key := regexp_replace(l.phone, '\D', '', 'g');
    if phone_key = '' then raise exception 'operator_booking_contact_required'; end if;
    phone_key := case when length(phone_key) > 11 and left(phone_key, 2) = '00' then '+' || substr(phone_key, 3)
      when length(phone_key) = 11 and left(phone_key, 1) = '8' then '+7' || substr(phone_key, 2)
      else '+' || phone_key end;
    perform pg_advisory_xact_lock(hashtextextended('operator-client:' || w::text || phone_key, 0));
    if l.client_id is not null then
      select id into v_client_id from public.clients where id = l.client_id and workspace_id = w for share;
      if not found then raise exception 'operator_booking_client_unavailable'; end if;
    else
      select array_agg(id) into client_ids from public.clients where workspace_id = w
        and (phone_normalized = phone_key or whatsapp_normalized = phone_key);
      if cardinality(client_ids) > 1 then raise exception 'operator_booking_client_ambiguous'; end if;
      v_client_id := client_ids[1];
      if v_client_id is null then
        insert into public.clients(workspace_id, full_name, phone, source, status)
          values(w, l.full_name, l.phone, coalesce(l.source, 'Запись'), 'new') returning id into v_client_id;
      end if;
      update public.leads set client_id = v_client_id, updated_at = now() where id = l.id;
    end if;
    insert into public.appointments(id, workspace_id, client_id, client_name, client_phone,
      doctor_id, doctor_name, service_id, service, service_items, price_minor, duration_minutes, starts_at, status, source)
      values(p_request_key, w, v_client_id, l.full_name, l.phone, d.id, d.full_name,
        case when cardinality(p_service_ids) = 1 then p_service_ids[1] else null end,
        service_text, items, total, minutes, start_at, 'scheduled', l.source) returning * into a;
    insert into public.growth_operator_bookings(request_key, workspace_id, operator_request_id, lead_id,
      appointment_id, doctor_id, service_ids, starts_local, time_zone)
      values(p_request_key, w, p_request_id, l.id, a.id, d.id, p_service_ids, p_starts_local, tz);
    insert into public.audit_logs(workspace_id, actor_role, action, entity_type, entity_id, metadata)
      values(w, 'operator', 'operator_appointment_created', 'appointment', a.id::text,
        jsonb_build_object('operator_request_id', p_request_id, 'lead_id', l.id));
  end if;
  return jsonb_build_object('id', a.id, 'startsAt', a.starts_at, 'service', a.service,
    'doctorName', a.doctor_name, 'priceMinor', a.price_minor::text, 'durationMinutes', a.duration_minutes,
    'status', a.status, 'timeZone', p_time_zone);
end;
$$;

revoke all on function public.create_growth_operator_booking(uuid, uuid, uuid, uuid, uuid, uuid[], timestamp, text) from public, anon, authenticated;
grant execute on function public.create_growth_operator_booking(uuid, uuid, uuid, uuid, uuid, uuid[], timestamp, text) to service_role;

commit;
notify pgrst, 'reload schema';
