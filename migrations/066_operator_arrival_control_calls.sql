-- Apply after 052, 057 and 065. This repairs the guarded operator-arrival path
-- and adds control-call results. It does not mark visits arrived, create sales,
-- transfer money, launch ads or change existing workspace memberships.
begin;

alter table public.growth_operator_arrivals
  drop constraint if exists growth_operator_arrivals_operator_check_result_check;
alter table public.growth_operator_arrivals
  add constraint growth_operator_arrivals_operator_check_result_check
  check (operator_check_result in ('confirmed', 'unconfirmed', 'unreachable'))
  not valid;
alter table public.growth_operator_arrivals
  validate constraint growth_operator_arrivals_operator_check_result_check;

create index if not exists growth_operator_arrivals_request_idx
  on public.growth_operator_arrivals(operator_request_id, clinic_confirmed_at desc, id);

-- Keep the original RPC safe as well: only an arrived appointment created by
-- this exact accepted operator agreement can receive an attribution receipt.
create or replace function public.confirm_growth_operator_arrival(
  p_request_id uuid, p_appointment_id uuid, p_clinic_staff_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  r public.growth_operator_requests%rowtype;
  existing public.growth_operator_arrivals%rowtype;
  appointment_status text;
  result_id uuid;
begin
  select * into r from public.growth_operator_requests
    where id = p_request_id and status = 'accepted' for update;
  if not found then raise exception 'accepted_assignment_required'; end if;

  perform 1 from public.staff_users s
    where s.id = p_clinic_staff_id and s.workspace_id = r.workspace_id
      and s.status = 'active' and s.role in ('owner', 'admin', 'manager', 'receptionist')
      and s.auth_user_id is not null
      and s.auth_user_id <> (
        select auth_user_id from public.growth_operator_profiles where id = r.operator_id
      );
  if not found then raise exception 'clinic_confirmation_required'; end if;

  select lower(btrim(coalesce(a.status, ''))) into appointment_status
    from public.growth_operator_bookings b
    join public.appointments a
      on a.id = b.appointment_id and a.workspace_id = b.workspace_id
    where b.operator_request_id = r.id
      and b.workspace_id = r.workspace_id
      and b.appointment_id = p_appointment_id
    for update of a;
  if not found then raise exception 'operator_arrival_unavailable'; end if;

  select * into existing from public.growth_operator_arrivals
    where workspace_id = r.workspace_id and appointment_id = p_appointment_id;
  if found then
    if existing.operator_request_id <> r.id
      then raise exception 'arrival_already_assigned'; end if;
    return existing.id;
  end if;

  if appointment_status <> 'arrived'
    then raise exception 'clinic_arrival_required'; end if;

  insert into public.growth_operator_arrivals (
    workspace_id, operator_request_id, appointment_id,
    clinic_confirmed_by_staff_user_id, price_minor, currency
  ) values (
    r.workspace_id, r.id, p_appointment_id,
    p_clinic_staff_id, r.price_per_arrival_minor, r.currency
  ) returning id into result_id;
  return result_id;
end;
$$;

-- The API uses a migration-specific name so it cannot fall back to the older,
-- broader 052 implementation during a rolling deployment.
create or replace function public.confirm_growth_operator_booking_arrival(
  p_request_id uuid, p_appointment_id uuid, p_clinic_staff_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  return public.confirm_growth_operator_arrival(
    p_request_id, p_appointment_id, p_clinic_staff_id
  );
end;
$$;

create or replace function public.read_clinic_operator_arrivals(
  p_request_id uuid, p_clinic_staff_id uuid, p_offset integer default 0
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.growth_operator_requests%rowtype;
  items jsonb;
begin
  if p_offset is null or p_offset < 0 or p_offset > 999999
    then raise exception 'invalid_offset'; end if;
  select * into r from public.growth_operator_requests
    where id = p_request_id and status = 'accepted' for share;
  if not found then raise exception 'operator_arrival_access_denied'; end if;
  perform 1 from public.staff_users s
    where s.id = p_clinic_staff_id and s.workspace_id = r.workspace_id
      and s.status = 'active' and s.role in ('owner', 'admin', 'manager')
      and s.auth_user_id is not null;
  if not found then raise exception 'operator_arrival_access_denied'; end if;

  select coalesce(jsonb_agg(item.payload order by item.starts_at desc nulls last, item.appointment_id), '[]'::jsonb)
    into items
  from (
    select a.starts_at, a.id as appointment_id, jsonb_build_object(
      'appointment_id', a.id,
      'arrival_id', arrival.id,
      'client_name', a.client_name,
      'starts_at', a.starts_at,
      'service', a.service,
      'doctor_name', a.doctor_name,
      'status', a.status,
      'price_minor', case when arrival.id is null then null else arrival.price_minor::text end,
      'currency', case when arrival.id is null then null else arrival.currency end,
      'clinic_confirmed_at', arrival.clinic_confirmed_at,
      'operator_checked_at', arrival.operator_checked_at,
      'operator_check_result', arrival.operator_check_result
    ) as payload
    from public.growth_operator_bookings booking
    join public.appointments a
      on a.id = booking.appointment_id and a.workspace_id = booking.workspace_id
    left join public.growth_operator_arrivals arrival
      on arrival.appointment_id = booking.appointment_id
      and arrival.workspace_id = booking.workspace_id
      and arrival.operator_request_id = booking.operator_request_id
    where booking.operator_request_id = r.id and booking.workspace_id = r.workspace_id
    order by a.starts_at desc nulls last, a.id
    limit 21 offset p_offset
  ) item;
  return jsonb_build_object('items', items);
end;
$$;

create or replace function public.read_growth_operator_arrivals(
  p_request_id uuid, p_operator_user_id uuid, p_offset integer default 0
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.growth_operator_requests%rowtype;
  items jsonb;
begin
  if p_offset is null or p_offset < 0 or p_offset > 999999
    then raise exception 'invalid_offset'; end if;
  select * into r from public.growth_operator_requests
    where id = p_request_id and status = 'accepted' for share;
  if not found then raise exception 'operator_arrival_access_denied'; end if;
  perform 1 from public.growth_operator_profiles o
    where o.id = r.operator_id and o.auth_user_id = p_operator_user_id
      and o.status = 'approved' for share;
  if not found then raise exception 'operator_arrival_access_denied'; end if;

  -- The operator receives only the contact needed for the agreed control call;
  -- notes, medical history, sale details and unrelated patients are excluded.
  select coalesce(jsonb_agg(item.payload order by item.confirmed_at desc, item.arrival_id), '[]'::jsonb)
    into items
  from (
    select arrival.clinic_confirmed_at as confirmed_at, arrival.id as arrival_id,
      jsonb_build_object(
        'appointment_id', a.id,
        'arrival_id', arrival.id,
        'client_name', a.client_name,
        'client_phone', a.client_phone,
        'starts_at', a.starts_at,
        'service', a.service,
        'doctor_name', a.doctor_name,
        'status', a.status,
        'price_minor', arrival.price_minor::text,
        'currency', arrival.currency,
        'clinic_confirmed_at', arrival.clinic_confirmed_at,
        'operator_checked_at', arrival.operator_checked_at,
        'operator_check_result', arrival.operator_check_result
      ) as payload
    from public.growth_operator_arrivals arrival
    join public.growth_operator_bookings booking
      on booking.appointment_id = arrival.appointment_id
      and booking.workspace_id = arrival.workspace_id
      and booking.operator_request_id = arrival.operator_request_id
    join public.appointments a
      on a.id = booking.appointment_id and a.workspace_id = booking.workspace_id
    where arrival.operator_request_id = r.id and arrival.workspace_id = r.workspace_id
    order by arrival.clinic_confirmed_at desc, arrival.id
    limit 21 offset p_offset
  ) item;
  return jsonb_build_object('items', items);
end;
$$;

create or replace function public.record_growth_operator_check(
  p_arrival_id uuid, p_operator_user_id uuid, p_result text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  receipt public.growth_operator_arrivals%rowtype;
begin
  if p_result is null or p_result not in ('confirmed', 'unconfirmed', 'unreachable')
    then raise exception 'operator_check_invalid'; end if;
  select arrival.* into receipt
    from public.growth_operator_arrivals arrival
    join public.growth_operator_requests r
      on r.id = arrival.operator_request_id and r.workspace_id = arrival.workspace_id
    join public.growth_operator_profiles o on o.id = r.operator_id
    where arrival.id = p_arrival_id and r.status = 'accepted'
      and o.auth_user_id = p_operator_user_id and o.status = 'approved'
    for update of arrival;
  if not found then raise exception 'operator_arrival_access_denied'; end if;
  if receipt.operator_check_result is not distinct from p_result then
    return receipt.id;
  end if;
  update public.growth_operator_arrivals
    set operator_checked_at = now(), operator_check_result = p_result
    where id = receipt.id;
  insert into public.audit_logs(
    workspace_id, actor_role, action, entity_type, entity_id, metadata
  ) values (
    receipt.workspace_id, 'operator', 'operator_arrival_control_call',
    'operator_arrival', receipt.id::text,
    jsonb_build_object(
      'operator_request_id', receipt.operator_request_id,
      'previous_result', receipt.operator_check_result,
      'result', p_result
    )
  );
  return receipt.id;
end;
$$;

create or replace function public.record_growth_operator_control_call(
  p_arrival_id uuid, p_operator_user_id uuid, p_result text
)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  return public.record_growth_operator_check(
    p_arrival_id, p_operator_user_id, p_result
  );
end;
$$;

revoke all on function public.confirm_growth_operator_arrival(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_growth_operator_booking_arrival(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.read_clinic_operator_arrivals(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.read_growth_operator_arrivals(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.record_growth_operator_check(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_growth_operator_control_call(uuid, uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.confirm_growth_operator_booking_arrival(uuid, uuid, uuid)
  to service_role;
grant execute on function public.read_clinic_operator_arrivals(uuid, uuid, integer)
  to service_role;
grant execute on function public.read_growth_operator_arrivals(uuid, uuid, integer)
  to service_role;
grant execute on function public.record_growth_operator_control_call(uuid, uuid, text)
  to service_role;

comment on function public.confirm_growth_operator_booking_arrival(uuid, uuid, uuid) is
  'Records agreed operator attribution only after the clinic marks the exact operator-created appointment arrived.';
comment on function public.record_growth_operator_control_call(uuid, uuid, text) is
  'Records confirmed, unconfirmed or unreachable control-call result; never confirms a payment.';

commit;
notify pgrst, 'reload schema';
