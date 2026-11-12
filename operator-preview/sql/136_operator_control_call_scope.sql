-- Reviewed independently of the cumulative 009-126 chain. Install before the
-- scoped API; keep the 066 wrapper for deployed versions during rollout.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

do $$
begin
  if current_user <> 'postgres'
    or not exists (
      select 1 from pg_proc
      where oid = to_regprocedure('public.record_growth_operator_check(uuid,uuid,text)')
        and proowner = to_regrole('postgres') and prosecdef and provolatile = 'v'
        and proconfig = array['search_path=""']::text[]
        and encode(sha256(convert_to(replace(prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex')
          = '6bff5a7b4d88888ce0b1709d5ab854e6cecfef1229a4800cb1b51352ec7878ec'
    )
    or not has_function_privilege('service_role',
      'public.record_growth_operator_control_call(uuid,uuid,text)', 'EXECUTE')
    or has_function_privilege('service_role',
      'public.record_growth_operator_check(uuid,uuid,text)', 'EXECUTE')
  then raise exception 'operator_control_call_dependencies_unconfirmed'; end if;
end;
$$;

create function public.record_growth_operator_control_call_scoped(
  p_request_id uuid, p_arrival_id uuid, p_operator_user_id uuid, p_result text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  request_row public.growth_operator_requests%rowtype;
  receipt public.growth_operator_arrivals%rowtype;
begin
  if p_result is null or p_result not in ('confirmed', 'unconfirmed', 'unreachable')
    then raise exception 'operator_check_invalid'; end if;

  -- Preserve 074's lock order and recheck live authority before touching the receipt.
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

revoke all on function public.record_growth_operator_control_call_scoped(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_growth_operator_control_call_scoped(uuid,uuid,uuid,text)
  to service_role;

do $$
declare
  target regprocedure := 'public.record_growth_operator_control_call_scoped(uuid,uuid,uuid,text)'::regprocedure;
begin
  if not has_function_privilege('service_role', target, 'EXECUTE')
    or has_function_privilege('anon', target, 'EXECUTE')
    or has_function_privilege('authenticated', target, 'EXECUTE')
  then raise exception 'operator_control_call_grants_unconfirmed'; end if;
end;
$$;

commit;
notify pgrst, 'reload schema';
