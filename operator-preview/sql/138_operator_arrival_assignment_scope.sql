-- Apply after 136. Re-check assigned-lead authority at the final operator-arrival
-- boundary so a revoked assignment cannot leak a phone number or accept a call.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

do $$
begin
  if current_user <> 'postgres'
    or to_regclass('public.growth_operator_lead_assignments') is null
    or to_regclass('public.growth_operator_arrivals') is null
    or to_regclass('public.growth_operator_bookings') is null
    or not exists (
      select 1 from pg_proc
      where oid = to_regprocedure('public.read_growth_operator_arrivals(uuid,uuid,integer)')
        and proowner = to_regrole('postgres') and prosecdef
    )
    or not exists (
      select 1 from pg_proc
      where oid = to_regprocedure('public.record_growth_operator_control_call_scoped(uuid,uuid,uuid,text)')
        and proowner = to_regrole('postgres') and prosecdef
    )
    or not has_function_privilege('service_role',
      'public.record_growth_operator_control_call_scoped(uuid,uuid,uuid,text)', 'EXECUTE')
  then raise exception 'operator_arrival_assignment_dependencies_unconfirmed'; end if;
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

  -- An assigned-only agreement with no live assignments has no readable
  -- scope. Return the same denial as the other authorization boundaries
  -- instead of turning a revoked agreement into a misleading empty list.
  if r.lead_scope = 'assigned' then
    perform 1 from public.growth_operator_lead_assignments assignment
      where assignment.operator_request_id = r.id
        and assignment.workspace_id = r.workspace_id
        and assignment.assigned;
    if not found then raise exception 'operator_arrival_access_denied'; end if;
  end if;

  -- Assigned leads remain visible only while the live assignment is active.
  -- The check is deliberately inside the same RPC that returns the phone.
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
      and (
        r.lead_scope = 'clinic'
        or exists (
          select 1 from public.growth_operator_lead_assignments assignment
          where assignment.operator_request_id = r.id
            and assignment.workspace_id = r.workspace_id
            and assignment.lead_id = booking.lead_id
            and assignment.assigned
        )
      )
    order by arrival.clinic_confirmed_at desc, arrival.id
    limit 21 offset p_offset
  ) item;
  return jsonb_build_object('items', items);
end;
$$;

create or replace function public.record_growth_operator_control_call_scoped(
  p_request_id uuid, p_arrival_id uuid, p_operator_user_id uuid, p_result text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  request_row public.growth_operator_requests%rowtype;
  receipt public.growth_operator_arrivals%rowtype;
begin
  if p_result is null or p_result not in ('confirmed', 'unconfirmed', 'unreachable')
    then raise exception 'operator_check_invalid'; end if;

  -- Preserve the request lock so revocation and a control call cannot observe
  -- different authority states during the same operation.
  select q.* into request_row from public.growth_operator_requests q
    where q.id = p_request_id and q.status = 'accepted'
    for share;
  if not found then raise exception 'operator_arrival_access_denied'; end if;
  perform 1 from public.growth_operator_profiles o
    where o.id = request_row.operator_id and o.auth_user_id = p_operator_user_id
      and o.status = 'approved' for share;
  if not found then raise exception 'operator_arrival_access_denied'; end if;
  select a.* into receipt from public.growth_operator_arrivals a
    where a.id = p_arrival_id and a.operator_request_id = request_row.id
      and a.workspace_id = request_row.workspace_id
    for update;
  if not found then raise exception 'operator_arrival_access_denied'; end if;

  perform 1
  from public.growth_operator_bookings booking
  where booking.operator_request_id = request_row.id
    and booking.workspace_id = request_row.workspace_id
    and booking.appointment_id = receipt.appointment_id
    and (
      request_row.lead_scope = 'clinic'
      or exists (
        select 1 from public.growth_operator_lead_assignments assignment
        where assignment.operator_request_id = request_row.id
          and assignment.workspace_id = request_row.workspace_id
          and assignment.lead_id = booking.lead_id
          and assignment.assigned
      )
    );
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

revoke all on function public.read_growth_operator_arrivals(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_growth_operator_arrivals(uuid,uuid,integer)
  to service_role;
revoke all on function public.record_growth_operator_control_call_scoped(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_growth_operator_control_call_scoped(uuid,uuid,uuid,text)
  to service_role;

do $$
declare
  read_target regprocedure := 'public.read_growth_operator_arrivals(uuid,uuid,integer)'::regprocedure;
  write_target regprocedure := 'public.record_growth_operator_control_call_scoped(uuid,uuid,uuid,text)'::regprocedure;
begin
  if not has_function_privilege('service_role', read_target, 'EXECUTE')
    or has_function_privilege('anon', read_target, 'EXECUTE')
    or has_function_privilege('authenticated', read_target, 'EXECUTE')
    or not has_function_privilege('service_role', write_target, 'EXECUTE')
    or has_function_privilege('anon', write_target, 'EXECUTE')
    or has_function_privilege('authenticated', write_target, 'EXECUTE')
  then raise exception 'operator_arrival_assignment_grants_unconfirmed'; end if;
end;
$$;

commit;
notify pgrst, 'reload schema';
