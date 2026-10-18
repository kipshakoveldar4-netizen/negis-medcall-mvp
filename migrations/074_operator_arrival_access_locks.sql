-- Apply after 066. Serialize arrival writes with permission revocation.
-- No memberships, commercial terms, appointments, sales or payments are changed.
begin;

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

  -- Retain the acting employee's permission until this transaction completes.
  perform 1 from public.staff_users s
    where s.id = p_clinic_staff_id and s.workspace_id = r.workspace_id
      and s.status = 'active' and s.role in ('owner', 'admin', 'manager', 'receptionist')
      and s.auth_user_id is not null
      and s.auth_user_id <> (
        select auth_user_id from public.growth_operator_profiles where id = r.operator_id
      )
    for share;
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

create or replace function public.record_growth_operator_check(
  p_arrival_id uuid, p_operator_user_id uuid, p_result text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  r public.growth_operator_requests%rowtype;
  receipt public.growth_operator_arrivals%rowtype;
begin
  if p_result is null or p_result not in ('confirmed', 'unconfirmed', 'unreachable')
    then raise exception 'operator_check_invalid'; end if;

  -- Match the established request -> profile -> protected-row lock order.
  -- Locking only the receipt leaves joined approval/status on an old snapshot.
  select q.* into r from public.growth_operator_requests q
    where q.id = (select a.operator_request_id from public.growth_operator_arrivals a where a.id = p_arrival_id)
      and q.status = 'accepted'
    for share;
  if not found then raise exception 'operator_arrival_access_denied'; end if;
  perform 1 from public.growth_operator_profiles o
    where o.id = r.operator_id and o.auth_user_id = p_operator_user_id
      and o.status = 'approved' for share;
  if not found then raise exception 'operator_arrival_access_denied'; end if;
  select a.* into receipt from public.growth_operator_arrivals a
    where a.id = p_arrival_id and a.operator_request_id = r.id and a.workspace_id = r.workspace_id
    for update;
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

-- Existing 066 server-only wrappers remain the public API; do not expose bases.
revoke all on function public.confirm_growth_operator_arrival(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.record_growth_operator_check(uuid, uuid, text)
  from public, anon, authenticated, service_role;

commit;
notify pgrst, 'reload schema';
