-- Apply after 057. This hardens operator compensation attribution only.
-- It does not mark appointments arrived, create clinic sales or transfer money.
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

  perform 1 from public.staff_users s
    where s.id = p_clinic_staff_id and s.workspace_id = r.workspace_id
      and s.status = 'active' and s.role in ('owner', 'admin', 'manager', 'receptionist')
      and s.auth_user_id is not null
      and s.auth_user_id <> (
        select auth_user_id from public.growth_operator_profiles where id = r.operator_id
      );
  if not found then raise exception 'clinic_confirmation_required'; end if;

  -- Compensation can only be attributed to the exact appointment created by
  -- this accepted operator request. A same-clinic appointment is not enough.
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

  -- The clinic's ordinary appointment workflow remains the source of truth.
  -- This receipt records agreed operator compensation only after that arrival.
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

revoke all on function public.confirm_growth_operator_arrival(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_growth_operator_arrival(uuid, uuid, uuid)
  to service_role;

comment on function public.confirm_growth_operator_arrival(uuid, uuid, uuid) is
  'Records agreed operator compensation only for an arrived appointment created through the same operator request.';

commit;
notify pgrst, 'reload schema';
