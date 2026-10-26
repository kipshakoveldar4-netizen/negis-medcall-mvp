-- Local foundation only. The API/UI still need a coordinated command-key rollout.
-- Receipts contain IDs/digests, not proposal text, contacts or financial entries.
-- Do not delete/expire receipts: an absent read is not proof a delayed request
-- cannot arrive later. Retention/admission policy needs review before cloud use.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare dependency record; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'operator_command_dependencies_unconfirmed'; end if;
  for dependency in select * from (values
    ('public.lock_clinic_operator_actor(uuid,uuid,uuid)','7b12160ab7e25e7aaf3586d4695c869d89b6a13eb42d55a3ccd38671618c42e3'),
    ('public.create_clinic_operator_request(uuid,uuid,uuid,uuid,text,bigint,text)','d2cbaea527b13854bcab02f0a1b1447d2ff88f9dc2e094f79c96d8241ca1ca70'),
    ('public.transition_clinic_operator_request(uuid,uuid,uuid,uuid,text)','7fa3cf9652cd3fb6516a748bbe1dcc875fc76b5e551068a60c574a8256df85ea'),
    ('public.transition_growth_operator_request(uuid,uuid,text)','d8e84b433185d5d6382c4fd6497bfe2d8e4d516defbefd17ce121d699890c207')
  ) expected(signature,digest) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature)
      and p.prosecdef and p.proowner=to_regrole('postgres') and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'operator_command_dependencies_unconfirmed'; end if;
  end loop;
end $$;

-- Deliberately no cascading FK: deleting an old collaboration must not free its
-- command key for another proposal. No public reader or automatic GC is added.
create table if not exists public.growth_operator_request_commands (
  command_id uuid primary key,
  actor_auth_user_id uuid not null,
  actor_staff_user_id uuid,
  origin text not null check(origin in ('clinic','operator')),
  workspace_id uuid not null,
  operator_id uuid not null,
  request_id uuid not null,
  action text not null,
  intent_hash text not null check(intent_hash ~ '^[0-9a-f]{64}$'),
  status_at_commit text not null,
  committed_at timestamptz not null default clock_timestamp() check(isfinite(committed_at)),
  check(((origin='clinic' and actor_staff_user_id is not null and action in ('propose','withdraw','end'))
    or (origin='operator' and actor_staff_user_id is null and action in ('accept','decline','end'))) is true),
  check(status_at_commit=case when action='propose' then 'requested' when action='accept' then 'accepted'
    when action in ('decline','withdraw') then 'declined' when action='end' then 'ended' else '' end)
);
alter table public.growth_operator_request_commands enable row level security;
revoke all on public.growth_operator_request_commands from public,anon,authenticated,service_role;

do $$ begin
  if (select jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) order by attnum)
      from pg_attribute where attrelid='public.growth_operator_request_commands'::regclass and attnum>0 and not attisdropped)
    is distinct from '[
      ["command_id","uuid",true],["actor_auth_user_id","uuid",true],["actor_staff_user_id","uuid",false],
      ["origin","text",true],["workspace_id","uuid",true],["operator_id","uuid",true],["request_id","uuid",true],
      ["action","text",true],["intent_hash","text",true],["status_at_commit","text",true],
      ["committed_at","timestamp with time zone",true]]'::jsonb
    or not exists(select 1 from pg_constraint where conrelid='public.growth_operator_request_commands'::regclass
      and contype='p' and pg_get_constraintdef(oid)='PRIMARY KEY (command_id)')
    or not exists(select 1 from pg_class where oid='public.growth_operator_request_commands'::regclass
      and relowner=to_regrole('postgres') and relrowsecurity and relkind='r')
    then raise exception 'operator_command_receipt_shape_unconfirmed'; end if;
end $$;

create or replace function public.operator_request_command_receipt(p_command public.growth_operator_request_commands)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('commandId',p_command.command_id,'requestId',p_command.request_id,
    'action',p_command.action,'statusAtCommit',p_command.status_at_commit,'committedAt',p_command.committed_at);
$$;

-- Callers hold the command-key lock first. Replay rechecks live authority using
-- 096's workspace/operator -> clinic actor -> request -> operator profile order.
create or replace function public.confirm_operator_request_command(p_command_id uuid,p_actor uuid,p_origin text,
  p_workspace uuid,p_staff uuid,p_intent_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.growth_operator_request_commands%rowtype;
begin
  select * into c from public.growth_operator_request_commands where command_id=p_command_id;
  if not found then return null; end if;
  if c.actor_auth_user_id is distinct from p_actor or c.origin is distinct from p_origin
    or (p_origin='clinic' and (c.workspace_id is distinct from p_workspace or c.actor_staff_user_id is distinct from p_staff))
    then raise exception using errcode='P9601',message='operator_actor_access_denied'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'operator-request-v1:'||c.workspace_id::text||':'||c.operator_id::text,0));
  if p_origin='clinic' then
    perform public.lock_clinic_operator_actor(c.workspace_id,c.actor_staff_user_id,p_actor);
  end if;
  perform 1 from public.growth_operator_requests where id=c.request_id and workspace_id=c.workspace_id
    and operator_id=c.operator_id for update;
  if not found then raise exception using errcode='P9603',message='operator_request_unavailable'; end if;
  if p_origin='operator' then
    perform 1 from public.growth_operator_profiles where id=c.operator_id and auth_user_id=p_actor and status='approved' for update;
    if not found then raise exception using errcode='P9601',message='operator_actor_access_denied'; end if;
  end if;
  if p_intent_hash is not null and c.intent_hash<>p_intent_hash
    then raise exception using errcode='P1072',message='operator_command_intent_conflict'; end if;
  return public.operator_request_command_receipt(c);
end $$;

create or replace function public.execute_clinic_operator_command(p_command_id uuid,p_workspace_id uuid,p_staff_user_id uuid,
  p_auth_user_id uuid,p_action text,p_request_id uuid,p_operator_id uuid,p_clinic_brief text,p_price_minor bigint,p_lead_scope text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare result_id uuid; result jsonb; digest text; r public.growth_operator_requests%rowtype;
  c public.growth_operator_request_commands%rowtype;
begin
  if p_command_id is null or p_workspace_id is null or p_staff_user_id is null or p_auth_user_id is null
    or p_action is null or p_action not in ('propose','withdraw','end')
    or (p_action='propose' and (p_request_id is not null or p_operator_id is null or p_clinic_brief is null
      or char_length(btrim(p_clinic_brief)) not between 1 and 2000 or p_price_minor is null
      or p_price_minor not between 0 and 9007199254740991 or p_lead_scope is null or p_lead_scope not in ('assigned','clinic')))
    or (p_action<>'propose' and (p_request_id is null or p_operator_id is not null or p_clinic_brief is not null
      or p_price_minor is not null or p_lead_scope is not null))
    then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  digest:=encode(sha256(convert_to(jsonb_build_array(p_action,p_request_id,p_operator_id,btrim(p_clinic_brief),
    p_price_minor::text,p_lead_scope)::text,'UTF8')),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operator-command-v1:'||p_command_id::text,0));
  result:=public.confirm_operator_request_command(p_command_id,p_auth_user_id,'clinic',p_workspace_id,p_staff_user_id,digest);
  if result is not null then return result; end if;
  if p_action='propose' then
    result_id:=public.create_clinic_operator_request(p_workspace_id,p_staff_user_id,p_auth_user_id,
      p_operator_id,p_clinic_brief,p_price_minor,p_lead_scope);
  else
    result_id:=public.transition_clinic_operator_request(p_workspace_id,p_staff_user_id,p_auth_user_id,p_request_id,p_action);
  end if;
  select * into strict r from public.growth_operator_requests where id=result_id;
  insert into public.growth_operator_request_commands(command_id,actor_auth_user_id,actor_staff_user_id,origin,
    workspace_id,operator_id,request_id,action,intent_hash,status_at_commit)
    values(p_command_id,p_auth_user_id,p_staff_user_id,'clinic',r.workspace_id,r.operator_id,r.id,p_action,digest,r.status) returning * into c;
  return public.operator_request_command_receipt(c);
end $$;

create or replace function public.execute_growth_operator_command(p_command_id uuid,p_request_id uuid,p_operator_user_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare result_id uuid; result jsonb; digest text; r public.growth_operator_requests%rowtype;
  c public.growth_operator_request_commands%rowtype;
begin
  if p_command_id is null or p_request_id is null or p_operator_user_id is null
    or p_action is null or p_action not in ('accept','decline','end')
    then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  digest:=encode(sha256(convert_to(jsonb_build_array(p_action,p_request_id)::text,'UTF8')),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operator-command-v1:'||p_command_id::text,0));
  result:=public.confirm_operator_request_command(p_command_id,p_operator_user_id,'operator',null,null,digest);
  if result is not null then return result; end if;
  result_id:=public.transition_growth_operator_request(p_request_id,p_operator_user_id,p_action);
  select * into strict r from public.growth_operator_requests where id=result_id;
  insert into public.growth_operator_request_commands(command_id,actor_auth_user_id,origin,workspace_id,operator_id,
    request_id,action,intent_hash,status_at_commit)
    values(p_command_id,p_operator_user_id,'operator',r.workspace_id,r.operator_id,r.id,p_action,digest,r.status) returning * into c;
  return public.operator_request_command_receipt(c);
end $$;

create or replace function public.read_operator_request_command(p_command_id uuid,p_actor_user_id uuid,p_origin text,
  p_workspace_id uuid,p_staff_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare result jsonb;
begin
  if p_command_id is null or p_actor_user_id is null or p_origin is null or p_origin not in ('clinic','operator')
    or (p_origin='clinic' and (p_workspace_id is null or p_staff_user_id is null))
    or (p_origin='operator' and (p_workspace_id is not null or p_staff_user_id is not null))
    then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operator-command-v1:'||p_command_id::text,0));
  result:=public.confirm_operator_request_command(p_command_id,p_actor_user_id,p_origin,p_workspace_id,p_staff_user_id,null);
  if result is not null then return result; end if;
  if p_origin='clinic' then
    perform public.lock_clinic_operator_actor(p_workspace_id,p_staff_user_id,p_actor_user_id);
  else
    perform 1 from public.growth_operator_profiles where auth_user_id=p_actor_user_id and status='approved' for share;
    if not found then raise exception using errcode='P9601',message='operator_actor_access_denied'; end if;
  end if;
  return null;
end $$;

revoke all on function public.operator_request_command_receipt(public.growth_operator_request_commands),
  public.confirm_operator_request_command(uuid,uuid,text,uuid,uuid,text),
  public.execute_clinic_operator_command(uuid,uuid,uuid,uuid,text,uuid,uuid,text,bigint,text),
  public.execute_growth_operator_command(uuid,uuid,uuid,text),
  public.read_operator_request_command(uuid,uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.execute_clinic_operator_command(uuid,uuid,uuid,uuid,text,uuid,uuid,text,bigint,text),
  public.execute_growth_operator_command(uuid,uuid,uuid,text),
  public.read_operator_request_command(uuid,uuid,text,uuid,uuid) to service_role;

do $$ declare role_name text; f record; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(role_name,'public.growth_operator_request_commands','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.growth_operator_request_commands','SELECT,INSERT,UPDATE,REFERENCES')
      then raise exception 'operator_command_direct_access_unconfirmed'; end if;
    for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('operator_request_command_receipt','confirm_operator_request_command',
        'execute_clinic_operator_command','execute_growth_operator_command','read_operator_request_command') loop
      if has_function_privilege(role_name,f.oid,'EXECUTE') is distinct from
        (role_name='service_role' and f.proname in ('execute_clinic_operator_command','execute_growth_operator_command','read_operator_request_command'))
        then raise exception 'operator_command_function_access_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
