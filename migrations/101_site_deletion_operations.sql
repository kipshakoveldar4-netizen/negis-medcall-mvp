-- Local candidate. Requires 062; deploy only with the matching prepare/recovery UI/API.
-- No contact data, automatic retry, expiry/GC or historical backfill. Receipt
-- retention and the 10,000-row workspace ceiling need review before cloud use.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ begin
  if current_user<>'postgres'
    or to_regprocedure('public.delete_crm_site_inquiry(uuid,text,uuid,uuid[],timestamp with time zone,uuid,uuid,uuid,boolean)') is null
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'site_deletion_operations_dependencies_unconfirmed'; end if;
  if not exists(select 1 from pg_proc p where p.oid=
    to_regprocedure('public.delete_crm_site_inquiry(uuid,text,uuid,uuid[],timestamp with time zone,uuid,uuid,uuid,boolean)')
    and p.prosecdef and p.proowner=to_regrole('postgres') and 'search_path=""'=any(p.proconfig)
    and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=
      'b220eb795f2d610fe1ad4af204fe9079b49bbcc1400a8e2278c9b19f5b15846a')
    then raise exception 'site_deletion_operations_dependencies_unconfirmed'; end if;
end $$;

create function public.validate_site_deletion_operation_request(p_request jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_key text; v_version timestamptz; v_count integer; v_distinct integer;
begin
  if jsonb_typeof(p_request) is distinct from 'object'
    or not(p_request ?& array['leadId','receiptIds','leadUpdatedAt','requestKey','confirmed'])
    or p_request-array['leadId','receiptIds','leadUpdatedAt','requestKey','confirmed']<>'{}'::jsonb
    or p_request->'confirmed' is distinct from 'true'::jsonb
    or jsonb_typeof(p_request->'receiptIds') is distinct from 'array'
    then raise exception using errcode='22023',message='invalid_deletion_request'; end if;
  foreach v_key in array array['leadId','requestKey','leadUpdatedAt'] loop
    if jsonb_typeof(p_request->v_key) is distinct from 'string'
      then raise exception using errcode='22023',message='invalid_deletion_request'; end if;
  end loop;
  if (p_request->>'leadId') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    or (p_request->>'requestKey') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    or (p_request->>'leadUpdatedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
    or jsonb_array_length(p_request->'receiptIds') not between 1 and 200
    then raise exception using errcode='22023',message='invalid_deletion_request'; end if;
  if exists(select 1 from jsonb_array_elements(p_request->'receiptIds') x
    where jsonb_typeof(x)<>'string' or (x#>>'{}') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    then raise exception using errcode='22023',message='invalid_deletion_request'; end if;
  select count(*),count(distinct value::uuid) into v_count,v_distinct
    from jsonb_array_elements_text(p_request->'receiptIds');
  if v_count<>v_distinct then raise exception using errcode='22023',message='invalid_deletion_request'; end if;
  begin
    v_version:=(p_request->>'leadUpdatedAt')::timestamptz;
    if not isfinite(v_version) then raise invalid_datetime_format; end if;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode='22023',message='invalid_deletion_request';
  end;
  return p_request;
end $$;
revoke all on function public.validate_site_deletion_operation_request(jsonb) from public,anon,authenticated,service_role;

create table public.site_deletion_operations (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_key uuid not null,
  site_id uuid not null references public.crm_intake_sites(id) on delete cascade,
  actor_staff_user_id uuid not null,
  actor_auth_user_id uuid not null,
  lead_id uuid not null,
  request jsonb not null check(jsonb_typeof(request)='object'),
  state text not null check(state in ('prepared','committed','abandoned')),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  acknowledged_at timestamptz,
  receipts_deleted integer,
  primary key(workspace_id,request_key),
  check(((state='prepared' and completed_at is null and receipts_deleted is null and acknowledged_at is null)
    or (state='committed' and completed_at is not null and receipts_deleted between 1 and 200)
    or (state='abandoned' and completed_at is not null and receipts_deleted is null)) is true)
);
create index site_deletion_operations_owner on public.site_deletion_operations
  (workspace_id,actor_auth_user_id,actor_staff_user_id,created_at,request_key) where acknowledged_at is null;
alter table public.site_deletion_operations enable row level security;
revoke all on public.site_deletion_operations from public,anon,authenticated,service_role;

create function public.lock_site_deletion_operation_actor(p_workspace uuid,p_staff uuid,p_actor uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_workspace is null or p_staff is null or p_actor is null then
    raise exception using errcode='42501',message='workspace_access_denied'; end if;
  perform 1 from public.staff_users where id=p_staff and auth_user_id=p_actor
    and workspace_id=p_workspace and status='active' and role in ('owner','admin') for share;
  if not found then raise exception using errcode='42501',message='workspace_access_denied'; end if;
end $$;
revoke all on function public.lock_site_deletion_operation_actor(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.site_deletion_operation_receipt(p_operation public.site_deletion_operations,p_replayed boolean)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('workspaceId',p_operation.workspace_id,'actorId',p_operation.actor_auth_user_id,
    'requestKey',p_operation.request_key,'leadId',p_operation.lead_id,'request',p_operation.request,
    'state',p_operation.state,'createdAt',p_operation.created_at,'completedAt',p_operation.completed_at,
    'acknowledgedAt',p_operation.acknowledged_at,'receiptsDeleted',p_operation.receipts_deleted,'replayed',p_replayed);
$$;
revoke all on function public.site_deletion_operation_receipt(public.site_deletion_operations,boolean) from public,anon,authenticated,service_role;

create function public.prepare_site_deletion_operation(p_workspace uuid,p_site_key text,p_staff uuid,p_actor uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare v_site public.crm_intake_sites%rowtype; v_operation public.site_deletion_operations%rowtype;
  v_request jsonb; v_key uuid; v_lead uuid;
begin
  v_request:=public.validate_site_deletion_operation_request(p_request);
  v_key:=(v_request->>'requestKey')::uuid; v_lead:=(v_request->>'leadId')::uuid;
  perform public.lock_site_deletion_operation_actor(p_workspace,p_staff,p_actor);
  -- Serializes capacity admission only within this workspace, never other tenants.
  perform 1 from public.workspaces where id=p_workspace for update;
  if not found then raise exception using errcode='42501',message='workspace_access_denied'; end if;
  select * into v_site from public.crm_intake_sites where workspace_id=p_workspace and site_key=p_site_key for update;
  if not found then raise exception using errcode='42501',message='site_deletion_disabled'; end if;
  select * into v_operation from public.site_deletion_operations where workspace_id=p_workspace and request_key=v_key for update;
  if found then
    if v_operation.actor_staff_user_id<>p_staff or v_operation.actor_auth_user_id<>p_actor
      or v_operation.site_id<>v_site.id or v_operation.request is distinct from v_request then
      raise exception using errcode='22023',message='deletion_request_conflict'; end if;
    return public.site_deletion_operation_receipt(v_operation,true);
  end if;
  if not v_site.manual_deletion_enabled then raise exception using errcode='42501',message='site_deletion_disabled'; end if;
  if (select count(*) from public.site_deletion_operations where workspace_id=p_workspace)>=10000
    or (select count(*) from public.site_deletion_operations where workspace_id=p_workspace
      and actor_staff_user_id=p_staff and actor_auth_user_id=p_actor and acknowledged_at is null)>=64 then
    raise exception using errcode='54000',message='deletion_operation_capacity'; end if;
  perform 1 from public.leads where id=v_lead and workspace_id=p_workspace
    and updated_at=(v_request->>'leadUpdatedAt')::timestamptz for share;
  if not found then raise exception using errcode='40001',message='deletion_scope_changed'; end if;
  -- Preparation records intent only. Existing 062 rechecks the complete receipt
  -- set, dependencies and live authority at execution; no deletion occurs here.
  insert into public.site_deletion_operations(workspace_id,request_key,site_id,actor_staff_user_id,
    actor_auth_user_id,lead_id,request,state) values(p_workspace,v_key,v_site.id,p_staff,p_actor,v_lead,v_request,'prepared')
    returning * into v_operation;
  return public.site_deletion_operation_receipt(v_operation,false);
end $$;

create function public.read_site_deletion_operations(p_workspace uuid,p_site_key text,p_staff uuid,p_actor uuid,p_request_key uuid default null)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare v_site public.crm_intake_sites%rowtype; v_operation public.site_deletion_operations%rowtype; v_items jsonb:='[]';
begin
  perform public.lock_site_deletion_operation_actor(p_workspace,p_staff,p_actor);
  select * into v_site from public.crm_intake_sites where workspace_id=p_workspace and site_key=p_site_key for share;
  if not found then raise exception using errcode='42501',message='site_deletion_disabled'; end if;
  for v_operation in select * from public.site_deletion_operations where workspace_id=p_workspace and site_id=v_site.id
    and actor_staff_user_id=p_staff and actor_auth_user_id=p_actor
    and (p_request_key is null and acknowledged_at is null or request_key=p_request_key)
    order by created_at,request_key limit 65 for share loop
    v_items:=v_items||jsonb_build_array(public.site_deletion_operation_receipt(v_operation,true));
  end loop;
  if jsonb_array_length(v_items)>64 then raise exception using errcode='54000',message='deletion_operation_capacity'; end if;
  return jsonb_build_object('operations',v_items,'complete',true,'deletionEnabled',v_site.manual_deletion_enabled);
end $$;

create function public.execute_site_deletion_operation(p_workspace uuid,p_site_key text,p_staff uuid,p_actor uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare v_site public.crm_intake_sites%rowtype; v_operation public.site_deletion_operations%rowtype;
  v_request jsonb; v_key uuid; v_result jsonb; v_ids uuid[];
begin
  v_request:=public.validate_site_deletion_operation_request(p_request); v_key:=(v_request->>'requestKey')::uuid;
  perform public.lock_site_deletion_operation_actor(p_workspace,p_staff,p_actor);
  select * into v_site from public.crm_intake_sites where workspace_id=p_workspace and site_key=p_site_key for update;
  if not found then raise exception using errcode='42501',message='site_deletion_disabled'; end if;
  select * into v_operation from public.site_deletion_operations where workspace_id=p_workspace and request_key=v_key for update;
  if not found then raise exception using errcode='22023',message='deletion_operation_not_prepared'; end if;
  if v_operation.actor_staff_user_id<>p_staff or v_operation.actor_auth_user_id<>p_actor
    or v_operation.site_id<>v_site.id or v_operation.request is distinct from v_request then
    raise exception using errcode='22023',message='deletion_request_conflict'; end if;
  if v_operation.state='abandoned' then raise exception using errcode='22023',message='deletion_operation_abandoned'; end if;
  if v_operation.state='committed' then return public.site_deletion_operation_receipt(v_operation,true); end if;
  select array_agg(value::uuid order by value::uuid) into v_ids from jsonb_array_elements_text(v_request->'receiptIds');
  v_result:=public.delete_crm_site_inquiry(p_workspace,p_site_key,v_operation.lead_id,v_ids,
    (v_request->>'leadUpdatedAt')::timestamptz,p_staff,p_actor,v_key,true);
  if v_result->'deleted' is distinct from 'true'::jsonb
    or v_result->'receiptsDeleted' is distinct from to_jsonb(cardinality(v_ids))
    or jsonb_typeof(v_result->'replayed') is distinct from 'boolean' then
    raise exception using errcode='22023',message='deletion_operation_unavailable'; end if;
  update public.site_deletion_operations set state='committed',completed_at=clock_timestamp(),
    receipts_deleted=cardinality(v_ids) where workspace_id=p_workspace and request_key=v_key returning * into v_operation;
  return public.site_deletion_operation_receipt(v_operation,false);
end $$;

create function public.close_site_deletion_operation(p_workspace uuid,p_site_key text,p_staff uuid,p_actor uuid,p_request_key uuid,p_action text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare v_site public.crm_intake_sites%rowtype; v_operation public.site_deletion_operations%rowtype; v_replayed boolean:=false;
begin
  if p_action is null or p_action not in ('abandon','acknowledge') or p_request_key is null then
    raise exception using errcode='22023',message='invalid_deletion_request'; end if;
  perform public.lock_site_deletion_operation_actor(p_workspace,p_staff,p_actor);
  select * into v_site from public.crm_intake_sites where workspace_id=p_workspace and site_key=p_site_key for update;
  if not found then raise exception using errcode='42501',message='site_deletion_disabled'; end if;
  select * into v_operation from public.site_deletion_operations where workspace_id=p_workspace and request_key=p_request_key for update;
  if not found or v_operation.actor_staff_user_id<>p_staff or v_operation.actor_auth_user_id<>p_actor
    or v_operation.site_id<>v_site.id then raise exception using errcode='42501',message='workspace_access_denied'; end if;
  if p_action='abandon' then
    if v_operation.state='prepared' then
      update public.site_deletion_operations set state='abandoned',completed_at=clock_timestamp()
        where workspace_id=p_workspace and request_key=p_request_key returning * into v_operation;
    else v_replayed:=true; end if;
  else
    if v_operation.state='prepared' then raise exception using errcode='22023',message='deletion_operation_pending'; end if;
    v_replayed:=v_operation.acknowledged_at is not null;
    update public.site_deletion_operations set acknowledged_at=coalesce(acknowledged_at,clock_timestamp())
      where workspace_id=p_workspace and request_key=p_request_key returning * into v_operation;
  end if;
  -- A concurrent commit wins truthfully: abandon returns committed, never cancelled.
  return public.site_deletion_operation_receipt(v_operation,v_replayed);
end $$;

revoke all on function public.prepare_site_deletion_operation(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.read_site_deletion_operations(uuid,text,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.execute_site_deletion_operation(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.close_site_deletion_operation(uuid,text,uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_site_deletion_operation(uuid,text,uuid,uuid,jsonb) to service_role;
grant execute on function public.read_site_deletion_operations(uuid,text,uuid,uuid,uuid) to service_role;
grant execute on function public.execute_site_deletion_operation(uuid,text,uuid,uuid,jsonb) to service_role;
grant execute on function public.close_site_deletion_operation(uuid,text,uuid,uuid,uuid,text) to service_role;
-- Old servers fail closed; only the operation executor may call 062 as owner.
revoke all on function public.delete_crm_site_inquiry(uuid,text,uuid,uuid[],timestamptz,uuid,uuid,uuid,boolean)
  from public,anon,authenticated,service_role;

do $$ declare v_role text; v_function regprocedure; begin
  if not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'site_deletion_operations_access_unconfirmed'; end if;
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(v_role,'public.site_deletion_operations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(v_role,'public.site_deletion_operations','SELECT,INSERT,UPDATE,REFERENCES')
      or has_function_privilege(v_role,'public.delete_crm_site_inquiry(uuid,text,uuid,uuid[],timestamptz,uuid,uuid,uuid,boolean)','EXECUTE')
      then raise exception 'site_deletion_operations_access_unconfirmed'; end if;
    if has_function_privilege(v_role,'public.validate_site_deletion_operation_request(jsonb)','EXECUTE')
      or has_function_privilege(v_role,'public.lock_site_deletion_operation_actor(uuid,uuid,uuid)','EXECUTE')
      or has_function_privilege(v_role,'public.site_deletion_operation_receipt(public.site_deletion_operations,boolean)','EXECUTE')
      then raise exception 'site_deletion_operations_access_unconfirmed'; end if;
    for v_function in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('prepare_site_deletion_operation','read_site_deletion_operations',
        'execute_site_deletion_operation','close_site_deletion_operation') loop
      if has_function_privilege(v_role,v_function,'EXECUTE')<>(v_role='service_role')
        then raise exception 'site_deletion_operations_access_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
commit;
