-- Apply after 030, 033, 036, 040, 045, 055 and 056.
-- Operator-only booking: no staff membership, payments, arrival confirmation or ads.
begin;

create table if not exists public.growth_operator_bookings (
  request_key uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  operator_request_id uuid not null,
  lead_id uuid not null,
  appointment_id uuid not null unique references public.appointments(id),
  doctor_id uuid not null references public.clinic_doctors(id),
  service_ids uuid[] not null,
  starts_local timestamp not null,
  time_zone text not null,
  created_at timestamptz not null default now(),
  foreign key (operator_request_id, workspace_id)
    references public.growth_operator_requests(id, workspace_id),
  foreign key (lead_id, workspace_id) references public.leads(id, workspace_id)
);
create index if not exists growth_operator_bookings_workspace_lead_idx
  on public.growth_operator_bookings(workspace_id, lead_id, created_at desc);
alter table public.growth_operator_bookings enable row level security;
revoke all on public.growth_operator_bookings from public, anon, authenticated, service_role;
grant select on public.growth_operator_bookings to service_role;

create or replace function public.operator_booking_workspace(
  p_request_id uuid, p_user_id uuid, p_lead_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.growth_operator_requests%rowtype;
begin
  select * into r from public.growth_operator_requests
    where id = p_request_id and status = 'accepted' for share;
  if not found then raise exception 'operator_access_denied'; end if;
  perform 1 from public.growth_operator_profiles
    where id = r.operator_id and auth_user_id = p_user_id and status = 'approved' for share;
  if not found then raise exception 'operator_access_denied'; end if;
  perform 1 from public.leads where id = p_lead_id and workspace_id = r.workspace_id for update;
  if not found then raise exception 'operator_access_denied'; end if;
  if r.lead_scope = 'assigned' then
    perform 1 from public.growth_operator_lead_assignments where operator_request_id = r.id
      and workspace_id = r.workspace_id and lead_id = p_lead_id and assigned for share;
    if not found then raise exception 'operator_access_denied'; end if;
  elsif r.lead_scope <> 'clinic' then raise exception 'operator_access_denied';
  end if;
  return r.workspace_id;
end;
$$;

-- Weekly rules, dated overrides and closed windows use the existing schedule model.
-- Output is local minutes; values above 1440 represent an overnight shift.
create or replace function public.operator_booking_day_minutes(
  p_workspace uuid, p_doctor uuid, p_day date
) returns int4multirange language sql stable security definer set search_path = '' as $$
  with relevant as (
    select *, (is_working or start_minute is null) as defines_day,
      (on_date is not null) as dated
    from public.clinic_doctor_shifts where workspace_id = p_workspace and doctor_id = p_doctor
      and ((on_date <= p_day and coalesce(on_date_end, on_date) >= p_day)
        or (on_date is null and weekday = extract(isodow from p_day)))
  ), chosen as (
    select * from relevant where dated
      or not exists (select 1 from relevant where dated and defines_day)
  )
  select case when coalesce(bool_or(not is_working and start_minute is null), false)
    then '{}'::int4multirange
    else coalesce(range_agg(int4range(start_minute, end_minute, '[)'))
        filter (where is_working and start_minute is not null), '{}'::int4multirange)
      - coalesce(range_agg(int4range(start_minute, end_minute, '[)'))
        filter (where not is_working and start_minute is not null), '{}'::int4multirange)
    end from chosen;
$$;

create or replace function public.read_growth_operator_booking_context(
  p_request_id uuid, p_operator_user_id uuid, p_lead_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare w uuid; tz text;
begin
  w := public.operator_booking_workspace(p_request_id, p_operator_user_id, p_lead_id);
  select value->>'timeZone' into tz from public.workspace_settings
    where workspace_id = w and key = 'clinic_schedule';
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = tz) then tz := null; end if;
  return jsonb_build_object('timeZone', tz);
end;
$$;

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
    if (select count(*) from public.appointments where workspace_id = w
      and (doctor_id = d.id or (doctor_id is null and doctor_name = d.full_name))
      and lower(btrim(coalesce(status, ''))) not in ('cancelled', 'no_show')
      and starts_at < end_at
      and starts_at + make_interval(mins => case when duration_minutes > 0 then duration_minutes else 60 end) > start_at
    ) >= d.capacity then raise exception 'operator_booking_time_taken'; end if;
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

revoke all on function public.operator_booking_workspace(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.operator_booking_day_minutes(uuid, uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.read_growth_operator_booking_context(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_growth_operator_booking(uuid, uuid, uuid, uuid, uuid, uuid[], timestamp, text) from public, anon, authenticated;
grant execute on function public.read_growth_operator_booking_context(uuid, uuid, uuid) to service_role;
grant execute on function public.create_growth_operator_booking(uuid, uuid, uuid, uuid, uuid, uuid[], timestamp, text) to service_role;

commit;
notify pgrst, 'reload schema';
