-- Local candidate: coordinate with keyed API/UI and drain legacy writers.
-- Closing a key never reverses an already committed cooperation action.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare dependency record; begin
  if current_user<>'postgres' or to_regclass('public.growth_operator_request_commands') is null
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'operator_command_closure_dependencies_unconfirmed'; end if;
  for dependency in select * from (values
    ('public.operator_request_command_receipt(public.growth_operator_request_commands)','94b0b66181447c53b77a284c2fb4f2450a89428011d8dc130d8458155b6e78f1'),
    ('public.confirm_operator_request_command(uuid,uuid,text,uuid,uuid,text)','7329d00708e12970041c1af7f2b5b217df5fed3a0025d1b6b61ff7c7f57cbf37'),
    ('public.execute_clinic_operator_command(uuid,uuid,uuid,uuid,text,uuid,uuid,text,bigint,text)','13f5d89a9de4b975cd62568413ab8b56d88ce45411bc1fbad136475b08e89eb3'),
    ('public.execute_growth_operator_command(uuid,uuid,uuid,text)','7b8a815ebd99469d61c0fb9e7664c31583b0adbcac19bb6e2b32829287db14bf'),
    ('public.read_operator_request_command(uuid,uuid,text,uuid,uuid)','000a277aab002e10792ee2155590af2fe8e0f4f8c500b25c29884e230db038a2')
  ) expected(signature,digest) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature)
      and p.proowner=to_regrole('postgres') and 'search_path=""'=any(p.proconfig)
      and p.prorettype='jsonb'::regtype and not p.proretset
      and p.prosecdef=(p.proname<>'operator_request_command_receipt')
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'operator_command_closure_dependencies_unconfirmed'; end if;
  end loop;
end $$;

create table if not exists public.growth_operator_command_fences (
  command_id uuid primary key,
  actor_auth_user_id uuid not null,
  actor_staff_user_id uuid,
  workspace_id uuid,
  origin text not null,
  action text not null,
  target_id uuid not null,
  closed_at timestamptz not null default clock_timestamp() check(isfinite(closed_at)),
  check(((origin='clinic' and actor_staff_user_id is not null and workspace_id is not null and action in ('propose','withdraw','end'))
    or (origin='operator' and actor_staff_user_id is null and workspace_id is null and action in ('accept','decline','end'))) is true)
);
alter table public.growth_operator_command_fences enable row level security;
revoke all on public.growth_operator_command_fences from public,anon,authenticated,service_role;

do $$ begin
  if (select jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) order by attnum)
      from pg_attribute where attrelid='public.growth_operator_command_fences'::regclass and attnum>0 and not attisdropped)
    is distinct from '[["command_id","uuid",true],["actor_auth_user_id","uuid",true],["actor_staff_user_id","uuid",false],
      ["workspace_id","uuid",false],["origin","text",true],["action","text",true],["target_id","uuid",true],
      ["closed_at","timestamp with time zone",true]]'::jsonb
    or not exists(select 1 from pg_constraint where conrelid='public.growth_operator_command_fences'::regclass
      and contype='p' and pg_get_constraintdef(oid)='PRIMARY KEY (command_id)')
    or not exists(select 1 from pg_class where oid='public.growth_operator_command_fences'::regclass
      and relowner=to_regrole('postgres') and relrowsecurity and relkind='r')
    then raise exception 'operator_command_closure_shape_unconfirmed'; end if;
end $$;

create or replace function public.lock_operator_command_reader(p_actor uuid,p_origin text,p_workspace uuid,p_staff uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_actor is null or p_origin is null or p_origin not in ('clinic','operator')
    or (p_origin='clinic' and (p_workspace is null or p_staff is null))
    or (p_origin='operator' and (p_workspace is not null or p_staff is not null))
    then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  if p_origin='clinic' then
    perform public.lock_clinic_operator_actor(p_workspace,p_staff,p_actor);
  else
    perform 1 from public.growth_operator_profiles where auth_user_id=p_actor and status='approved' for update;
    if not found then raise exception using errcode='P9601',message='operator_actor_access_denied'; end if;
  end if;
end $$;

-- The caller holds the same key lock as 107. Historical receipts expose only
-- their immutable result, not a deleted request's contacts or renewed access.
create or replace function public.operator_command_result_v2(p_command_id uuid,p_actor uuid,p_origin text,
  p_workspace uuid,p_staff uuid,p_action text,p_target uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.growth_operator_request_commands%rowtype; f public.growth_operator_command_fences%rowtype;
  has_command boolean; has_fence boolean; target uuid;
begin
  select * into c from public.growth_operator_request_commands where command_id=p_command_id;has_command:=found;
  select * into f from public.growth_operator_command_fences where command_id=p_command_id;has_fence:=found;
  if has_command and has_fence then raise exception using errcode='P1082',message='operator_command_state_unconfirmed'; end if;
  if has_command then
    if c.actor_auth_user_id is distinct from p_actor or c.origin is distinct from p_origin
      or (p_origin='clinic' and (c.workspace_id is distinct from p_workspace or c.actor_staff_user_id is distinct from p_staff))
      then raise exception using errcode='P9601',message='operator_actor_access_denied'; end if;
    target:=case when c.action='propose' then c.operator_id else c.request_id end;
  elsif has_fence then
    if f.actor_auth_user_id is distinct from p_actor or f.origin is distinct from p_origin
      or (p_origin='clinic' and (f.workspace_id is distinct from p_workspace or f.actor_staff_user_id is distinct from p_staff))
      then raise exception using errcode='P9601',message='operator_actor_access_denied'; end if;
    target:=f.target_id;
  end if;
  perform public.lock_operator_command_reader(p_actor,p_origin,p_workspace,p_staff);
  if (has_command or has_fence) and p_action is not null and
    ((case when has_command then c.action else f.action end) is distinct from p_action or target is distinct from p_target)
    then raise exception using errcode='P1072',message='operator_command_intent_conflict'; end if;
  if has_command then return public.operator_request_command_receipt(c)||jsonb_build_object('state','committed','targetId',target); end if;
  if has_fence then return jsonb_build_object('state','abandoned','commandId',f.command_id,'action',f.action,'targetId',f.target_id,'closedAt',f.closed_at); end if;
  return jsonb_build_object('state','unconfirmed','commandId',p_command_id);
end $$;

create or replace function public.execute_clinic_operator_command_v2(p_command_id uuid,p_workspace_id uuid,p_staff_user_id uuid,
  p_auth_user_id uuid,p_action text,p_request_id uuid,p_operator_id uuid,p_clinic_brief text,p_price_minor bigint,p_lead_scope text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare result jsonb; target uuid;
begin
  if p_command_id is null or p_workspace_id is null or p_staff_user_id is null or p_auth_user_id is null
    or p_action is null or p_action not in ('propose','withdraw','end')
    or (p_action='propose' and (p_request_id is not null or p_operator_id is null or p_clinic_brief is null
      or char_length(btrim(p_clinic_brief)) not between 1 and 2000 or p_price_minor is null
      or p_price_minor not between 0 and 9007199254740991 or p_lead_scope is null or p_lead_scope not in ('assigned','clinic')))
    or (p_action<>'propose' and (p_request_id is null or p_operator_id is not null or p_clinic_brief is not null or p_price_minor is not null or p_lead_scope is not null))
    then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  target:=case when p_action='propose' then p_operator_id else p_request_id end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operator-command-v1:'||p_command_id::text,0));
  if exists(select 1 from public.growth_operator_command_fences where command_id=p_command_id) then
    return public.operator_command_result_v2(p_command_id,p_auth_user_id,'clinic',p_workspace_id,p_staff_user_id,p_action,target);
  end if;
  result:=public.execute_clinic_operator_command(p_command_id,p_workspace_id,p_staff_user_id,p_auth_user_id,
    p_action,p_request_id,p_operator_id,p_clinic_brief,p_price_minor,p_lead_scope);
  return result||jsonb_build_object('state','committed','targetId',target);
end $$;

create or replace function public.execute_growth_operator_command_v2(p_command_id uuid,p_request_id uuid,p_operator_user_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare result jsonb;
begin
  if p_command_id is null or p_request_id is null or p_operator_user_id is null or p_action is null or p_action not in ('accept','decline','end')
    then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operator-command-v1:'||p_command_id::text,0));
  if exists(select 1 from public.growth_operator_command_fences where command_id=p_command_id) then
    return public.operator_command_result_v2(p_command_id,p_operator_user_id,'operator',null,null,p_action,p_request_id);
  end if;
  result:=public.execute_growth_operator_command(p_command_id,p_request_id,p_operator_user_id,p_action);
  return result||jsonb_build_object('state','committed','targetId',p_request_id);
end $$;

create or replace function public.read_operator_request_command_v2(p_command_id uuid,p_actor_user_id uuid,p_origin text,
  p_workspace_id uuid,p_staff_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
begin
  if p_command_id is null then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operator-command-v1:'||p_command_id::text,0));
  return public.operator_command_result_v2(p_command_id,p_actor_user_id,p_origin,p_workspace_id,p_staff_user_id,null,null);
end $$;

create or replace function public.close_operator_request_command_v2(p_command_id uuid,p_actor_user_id uuid,p_origin text,
  p_workspace_id uuid,p_staff_user_id uuid,p_action text,p_target_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare result jsonb;
begin
  if p_command_id is null or p_target_id is null or p_action is null
    or (p_origin='clinic' and p_action not in ('propose','withdraw','end'))
    or (p_origin='operator' and p_action not in ('accept','decline','end'))
    then raise exception using errcode='P9604',message='operator_mutation_input_invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operator-command-v1:'||p_command_id::text,0));
  result:=public.operator_command_result_v2(p_command_id,p_actor_user_id,p_origin,p_workspace_id,p_staff_user_id,p_action,p_target_id);
  if result->>'state'<>'unconfirmed' then return result; end if;
  insert into public.growth_operator_command_fences(command_id,actor_auth_user_id,actor_staff_user_id,workspace_id,origin,action,target_id)
    values(p_command_id,p_actor_user_id,p_staff_user_id,p_workspace_id,p_origin,p_action,p_target_id);
  return public.operator_command_result_v2(p_command_id,p_actor_user_id,p_origin,p_workspace_id,p_staff_user_id,p_action,p_target_id);
end $$;

-- A late legacy call must not bypass the fence. Already admitted legacy work
-- needs a separately reviewed stop/drain boundary before a cloud rollout.
revoke all on function public.create_clinic_operator_request(uuid,uuid,uuid,uuid,text,bigint,text),
  public.transition_clinic_operator_request(uuid,uuid,uuid,uuid,text),public.transition_growth_operator_request(uuid,uuid,text),
  public.execute_clinic_operator_command(uuid,uuid,uuid,uuid,text,uuid,uuid,text,bigint,text),
  public.execute_growth_operator_command(uuid,uuid,uuid,text),public.read_operator_request_command(uuid,uuid,text,uuid,uuid),
  public.lock_operator_command_reader(uuid,text,uuid,uuid),public.operator_command_result_v2(uuid,uuid,text,uuid,uuid,text,uuid),
  public.execute_clinic_operator_command_v2(uuid,uuid,uuid,uuid,text,uuid,uuid,text,bigint,text),
  public.execute_growth_operator_command_v2(uuid,uuid,uuid,text),public.read_operator_request_command_v2(uuid,uuid,text,uuid,uuid),
  public.close_operator_request_command_v2(uuid,uuid,text,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.execute_clinic_operator_command_v2(uuid,uuid,uuid,uuid,text,uuid,uuid,text,bigint,text),
  public.execute_growth_operator_command_v2(uuid,uuid,uuid,text),public.read_operator_request_command_v2(uuid,uuid,text,uuid,uuid),
  public.close_operator_request_command_v2(uuid,uuid,text,uuid,uuid,text,uuid) to service_role;

do $$ declare role_name text; f record; begin
  if exists(select 1 from public.growth_operator_command_fences f join public.growth_operator_request_commands c using(command_id))
    then raise exception 'operator_command_closure_state_unconfirmed'; end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(role_name,'public.growth_operator_command_fences','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.growth_operator_command_fences','SELECT,INSERT,UPDATE,REFERENCES')
      then raise exception 'operator_command_closure_access_unconfirmed'; end if;
    for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
      ('create_clinic_operator_request','transition_clinic_operator_request','transition_growth_operator_request',
      'execute_clinic_operator_command','execute_growth_operator_command','read_operator_request_command',
      'lock_operator_command_reader','operator_command_result_v2','execute_clinic_operator_command_v2','execute_growth_operator_command_v2',
      'read_operator_request_command_v2','close_operator_request_command_v2') loop
      if has_function_privilege(role_name,f.oid,'EXECUTE') is distinct from
        (role_name='service_role' and f.proname in ('execute_clinic_operator_command_v2','execute_growth_operator_command_v2',
          'read_operator_request_command_v2','close_operator_request_command_v2'))
        then raise exception 'operator_command_closure_executor_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
