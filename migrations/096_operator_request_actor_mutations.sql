-- Local candidate after 052/053/054/094. No memberships, terms or payments change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
  if to_regprocedure('public.check_growth_operator_request()') is null
    or to_regprocedure('public.accept_growth_operator_request(uuid,uuid)') is null
    or not exists(select 1 from pg_attribute where attrelid='public.growth_operator_requests'::regclass
      and attname='lead_scope' and not attisdropped)
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls)
    or not (select relrowsecurity from pg_class where oid='public.growth_operator_requests'::regclass)
    or not (select relrowsecurity from pg_class where oid='public.growth_operator_profiles'::regclass)
    then raise exception 'operator_actor_mutation_dependencies_unconfirmed'; end if;
end $$;

create or replace function public.lock_clinic_operator_actor(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.staff_users where id=p_staff_user_id and workspace_id=p_workspace_id
    and auth_user_id=p_auth_user_id and status='active' and role in ('owner','admin','manager') for share;
  if not found then raise exception using errcode='P9601',message='operator_actor_access_denied'; end if;
end $$;

create or replace function public.create_clinic_operator_request(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_operator_id uuid,p_clinic_brief text,p_price_minor bigint,p_lead_scope text)
returns uuid language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare result_id uuid;
begin
  if p_workspace_id is null or p_operator_id is null or p_clinic_brief is null
    or char_length(btrim(p_clinic_brief)) not between 1 and 2000
    or p_price_minor is null or p_price_minor not between 0 and 9007199254740991
    or p_lead_scope is null or p_lead_scope not in ('assigned','clinic')
    then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  -- One lock order for every new request mutation, including accept. A stale
  -- non-locking lookup cannot change identity; the row is rechecked below.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'operator-request-v1:'||p_workspace_id::text||':'||p_operator_id::text,0));
  perform public.lock_clinic_operator_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if exists(select 1 from public.growth_operator_requests where workspace_id=p_workspace_id
    and operator_id=p_operator_id and status in ('requested','accepted'))
    then raise exception using errcode='P9602',message='operator_request_transition_conflict'; end if;
  perform 1 from public.growth_operator_profiles where id=p_operator_id and status='approved' and accepting_requests for share;
  if not found then raise exception using errcode='P9602',message='operator_request_transition_conflict'; end if;
  insert into public.growth_operator_requests(workspace_id,requested_by_staff_user_id,operator_id,clinic_brief,
    price_per_arrival_minor,currency,lead_scope,status)
    values(p_workspace_id,p_staff_user_id,p_operator_id,btrim(p_clinic_brief),p_price_minor,'KZT',p_lead_scope,'requested')
    returning id into result_id;
  return result_id;
end $$;

create or replace function public.transition_clinic_operator_request(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_request_id uuid,p_action text)
returns uuid language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare r public.growth_operator_requests%rowtype; v_operator_id uuid;
begin
  if p_action is null or p_action not in ('withdraw','end')
    then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  select q.operator_id into v_operator_id from public.growth_operator_requests q
    where q.id=p_request_id and q.workspace_id=p_workspace_id;
  if not found then raise exception using errcode='P9603',message='operator_request_unavailable'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'operator-request-v1:'||p_workspace_id::text||':'||v_operator_id::text,0));
  perform public.lock_clinic_operator_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  select * into r from public.growth_operator_requests q where q.id=p_request_id
    and q.workspace_id=p_workspace_id and q.operator_id=v_operator_id for update;
  if not found then raise exception using errcode='P9603',message='operator_request_unavailable'; end if;
  if (p_action='withdraw' and r.status<>'requested') or (p_action='end' and r.status<>'accepted')
    then raise exception using errcode='P9602',message='operator_request_transition_conflict'; end if;
  update public.growth_operator_requests set status=case when p_action='end' then 'ended' else 'declined' end,
    ended_at=case when p_action='end' then greatest(clock_timestamp(),r.accepted_at) else null end where id=r.id;
  return r.id;
end $$;

create or replace function public.transition_growth_operator_request(p_request_id uuid,p_operator_user_id uuid,p_action text)
returns uuid language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare r public.growth_operator_requests%rowtype; v_workspace_id uuid; v_operator_id uuid;
begin
  if p_action is null or p_action not in ('accept','decline','end')
    then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  select q.workspace_id,q.operator_id into v_workspace_id,v_operator_id from public.growth_operator_requests q
    where q.id=p_request_id;
  if not found then raise exception using errcode='P9603',message='operator_request_unavailable'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'operator-request-v1:'||v_workspace_id::text||':'||v_operator_id::text,0));
  select * into r from public.growth_operator_requests q where q.id=p_request_id
    and q.workspace_id=v_workspace_id and q.operator_id=v_operator_id for update;
  if not found then raise exception using errcode='P9603',message='operator_request_unavailable'; end if;
  perform 1 from public.growth_operator_profiles p where p.id=r.operator_id
    and p.auth_user_id=p_operator_user_id and p.status='approved' for update;
  if not found then raise exception using errcode='P9601',message='operator_actor_access_denied'; end if;
  if p_action='accept' then
    if r.status='accepted' then return r.id; end if;
    if r.status<>'requested' or r.price_per_arrival_minor is null
      then raise exception using errcode='P9602',message='operator_request_transition_conflict'; end if;
    update public.growth_operator_requests set status='accepted',accepted_at=clock_timestamp() where id=r.id;
  else
    if (p_action='decline' and r.status<>'requested') or (p_action='end' and r.status<>'accepted')
      then raise exception using errcode='P9602',message='operator_request_transition_conflict'; end if;
    update public.growth_operator_requests set status=case when p_action='end' then 'ended' else 'declined' end,
      ended_at=case when p_action='end' then greatest(clock_timestamp(),r.accepted_at) else null end where id=r.id;
  end if;
  return r.id;
end $$;

-- Old servers must fail closed instead of using a separate authorization read
-- followed by an unguarded write. Platform profile approval is unchanged.
revoke insert,update on table public.growth_operator_requests from service_role;
revoke all on function public.accept_growth_operator_request(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.lock_clinic_operator_actor(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.create_clinic_operator_request(uuid,uuid,uuid,uuid,text,bigint,text),
  public.transition_clinic_operator_request(uuid,uuid,uuid,uuid,text),
  public.transition_growth_operator_request(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.create_clinic_operator_request(uuid,uuid,uuid,uuid,text,bigint,text),
  public.transition_clinic_operator_request(uuid,uuid,uuid,uuid,text),
  public.transition_growth_operator_request(uuid,uuid,text) to service_role;

do $$ declare browser_role text; f record; begin
  if has_table_privilege('service_role','public.growth_operator_requests','INSERT,UPDATE,DELETE,TRUNCATE')
    or has_any_column_privilege('service_role','public.growth_operator_requests','INSERT,UPDATE')
    then raise exception 'operator_actor_direct_writer_not_closed'; end if;
  foreach browser_role in array array['anon','authenticated'] loop
    if has_table_privilege(browser_role,'public.growth_operator_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(browser_role,'public.growth_operator_requests','SELECT,INSERT,UPDATE,REFERENCES')
      then raise exception 'operator_actor_browser_table_access_unconfirmed'; end if;
    for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('lock_clinic_operator_actor','create_clinic_operator_request',
        'transition_clinic_operator_request','transition_growth_operator_request','accept_growth_operator_request') loop
      if has_function_privilege(browser_role,f.signature,'EXECUTE')
        then raise exception 'operator_actor_browser_function_access_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
