-- Local candidate: coordinate API/UI adoption and stop/drain legacy 110 writers.
-- A stop fence does not cancel a committed job or reverse its business actions.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare dependency record; relation text; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'creator_closure_dependencies_unconfirmed'; end if;
  foreach relation in array array['growth_creator_jobs','growth_creator_submissions','growth_creator_commands','growth_creator_events',
    'growth_contributor_profiles','staff_users','workspaces'] loop
    if not exists(select 1 from pg_class c where c.oid=to_regclass('public.'||relation) and c.relowner=to_regrole('postgres')
      and c.relkind='r' and not c.relispartition and c.relrowsecurity)
      then raise exception 'creator_closure_dependencies_unconfirmed'; end if;
  end loop;
  for dependency in select * from (values
    ('public.creator_job_actor(uuid,uuid,uuid)','c841140867d61cd13859e1f93bb1c91b0e14db87d82011010dad7b8ab72bdc7c','uuid',true,'v'),
    ('public.creator_job_keys(jsonb,text[])','5cc3281990849186719198b61b4105ae6c865d3b7575c56423ef02754c50e6c8','boolean',false,'i'),
    ('public.creator_job_text(jsonb,integer)','0fb5c1218b27ce12161e2df6bef0b05fa57ae83441ca625f9c2e7a59152f36f6','boolean',false,'i'),
    ('public.creator_job_links(jsonb)','e9bfdf44bf3fc9a6b0a1a5c5d491f4d70aee5602424c076c470747c58a0a6752','boolean',false,'i'),
    ('public.creator_job_dto(uuid)','9a4099a01f836bbb5fc35e116f357558d80ae3ea69310958f4958e220d1dca7d','jsonb',true,'s'),
    ('public.execute_growth_creator_job(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb)','e8db830dba82d834b6a237b9c8f7e1067aae33369633a0d64c4795102b6202c7','jsonb',true,'v'),
    ('public.read_growth_creator_jobs(uuid,uuid,uuid,integer)','fa8ede08a81b16a3745f9a9f66f08e78031fd567e780256cd7de5b5861362b12','jsonb',true,'v'),
    ('public.read_growth_creator_command(uuid,uuid,uuid,uuid)','eff780faf0e347fa143ffdeb278e6eb05c51406224ed781c3140380eddb9ee69','jsonb',true,'v')
  ) expected(signature,digest,result_type,definer,volatility) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef=dependency.definer and p.provolatile::text=dependency.volatility
      and p.prorettype=to_regtype(dependency.result_type) and not p.proretset and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'creator_closure_dependencies_unconfirmed'; end if;
  end loop;
end $$;

create table if not exists public.growth_creator_command_fences (
  actor_auth_user_id uuid not null,
  request_key uuid not null,
  actor_staff_user_id uuid,
  workspace_id uuid,
  action text not null,
  target_id uuid not null,
  closed_at timestamptz not null default clock_timestamp() check(isfinite(closed_at)),
  primary key(actor_auth_user_id,request_key),
  check(((workspace_id is not null and actor_staff_user_id is not null and action in ('create','request_changes','approve','cancel'))
    or (workspace_id is null and actor_staff_user_id is null and action in ('accept','decline','submit'))) is true)
);
alter table public.growth_creator_command_fences enable row level security;
revoke all on public.growth_creator_command_fences from public,anon,authenticated,service_role;
do $$ begin
  if (select jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) order by attnum)
      from pg_attribute where attrelid='public.growth_creator_command_fences'::regclass and attnum>0 and not attisdropped)
    is distinct from '[["actor_auth_user_id","uuid",true],["request_key","uuid",true],["actor_staff_user_id","uuid",false],
      ["workspace_id","uuid",false],["action","text",true],["target_id","uuid",true],["closed_at","timestamp with time zone",true]]'::jsonb
    or not exists(select 1 from pg_constraint where conrelid='public.growth_creator_command_fences'::regclass
      and contype='p' and pg_get_constraintdef(oid)='PRIMARY KEY (actor_auth_user_id, request_key)')
    or not exists(select 1 from pg_class c where c.oid='public.growth_creator_command_fences'::regclass
      and c.relowner=to_regrole('postgres') and c.relrowsecurity and c.relkind='r' and not c.relispartition
      and not exists(select 1 from pg_inherits i where i.inhrelid=c.oid or i.inhparent=c.oid)
      and not exists(select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
      and not exists(select 1 from pg_policy p where p.polrelid=c.oid))
    then raise exception 'creator_closure_shape_unconfirmed'; end if;
end $$;

-- The caller holds the same actor/key lock as 110. No missing read is a stop.
create or replace function public.creator_command_result_v2(p_actor uuid,p_workspace uuid,p_staff uuid,p_request uuid,p_action text,p_target uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.growth_creator_commands%rowtype; f public.growth_creator_command_fences%rowtype;
  has_command boolean; has_fence boolean; action text; target_text text; target uuid; result jsonb;
begin
  perform public.creator_job_actor(p_actor,p_workspace,p_staff);
  select * into c from public.growth_creator_commands where actor_id=p_actor and request_key=p_request;has_command=found;
  select * into f from public.growth_creator_command_fences where actor_auth_user_id=p_actor and request_key=p_request;has_fence=found;
  if has_command and has_fence then raise exception using errcode='P1112',message='creator_command_state_unconfirmed'; end if;
  if has_command then
    if c.intent->'workspace' is distinct from coalesce(to_jsonb(p_workspace),'null'::jsonb)
      or c.intent->'staff' is distinct from coalesce(to_jsonb(p_staff),'null'::jsonb)
      then raise exception using errcode='P1111',message='creator_command_access_denied'; end if;
    action=c.intent->>'action';target_text=case when action='create' then c.intent->'payload'->>'creatorId' else c.intent->>'job' end;
    if action is null or action not in ('create','accept','decline','submit','request_changes','approve','cancel')
      or (p_workspace is null and action not in ('accept','decline','submit'))
      or (p_workspace is not null and action not in ('create','request_changes','approve','cancel'))
      or target_text is null or target_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      then raise exception using errcode='P1112',message='creator_command_state_unconfirmed'; end if;
    target=target_text::uuid;
  elsif has_fence then
    if f.workspace_id is distinct from p_workspace or f.actor_staff_user_id is distinct from p_staff
      then raise exception using errcode='P1111',message='creator_command_access_denied'; end if;
    action=f.action;target=f.target_id;
  end if;
  if (has_command or has_fence) and p_action is not null and (action is distinct from p_action or target is distinct from p_target)
    then raise exception using errcode='P1113',message='creator_command_intent_conflict'; end if;
  if has_command then
    result=public.read_growth_creator_command(p_actor,p_workspace,p_staff,p_request);
    if result is null then raise exception using errcode='P1112',message='creator_command_state_unconfirmed'; end if;
    return jsonb_build_object('state','committed','requestId',p_request,'action',action,'targetId',target,'result',result);
  end if;
  if has_fence then return jsonb_build_object('state','abandoned','requestId',p_request,'action',action,'targetId',target,
    'closedAt',to_char(f.closed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')); end if;
  return jsonb_build_object('state','unconfirmed','requestId',p_request);
end $$;

create or replace function public.execute_growth_creator_job_v2(p_actor uuid,p_workspace uuid,p_staff uuid,p_request uuid,
  p_job uuid,p_revision uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare target uuid; result jsonb;
begin
  if p_actor is null or p_request is null or p_action is null
    or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>16000
    or (p_action='create' and (p_job is not null or p_revision is not null or jsonb_typeof(p_payload->'creatorId') is distinct from 'string'
      or p_payload->>'creatorId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'))
    or (p_action<>'create' and (p_job is null or p_revision is null))
    or (p_workspace is null and p_action not in ('accept','decline','submit'))
    or (p_workspace is not null and p_action not in ('create','request_changes','approve','cancel'))
    then raise exception using errcode='P1102',message='invalid_creator_command'; end if;
  target=case when p_action='create' then (p_payload->>'creatorId')::uuid else p_job end;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_request::text,0));
  if exists(select 1 from public.growth_creator_command_fences where actor_auth_user_id=p_actor and request_key=p_request) then
    return public.creator_command_result_v2(p_actor,p_workspace,p_staff,p_request,p_action,target);
  end if;
  result=public.execute_growth_creator_job(p_actor,p_workspace,p_staff,p_request,p_job,p_revision,p_action,p_payload);
  return jsonb_build_object('state','committed','requestId',p_request,'action',p_action,'targetId',target,'result',result);
end $$;

create or replace function public.read_growth_creator_command_v2(p_actor uuid,p_workspace uuid,p_staff uuid,p_request uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
begin
  if p_actor is null or p_request is null then raise exception using errcode='P1111',message='creator_command_access_denied'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_request::text,0));
  return public.creator_command_result_v2(p_actor,p_workspace,p_staff,p_request,null,null);
end $$;

create or replace function public.close_growth_creator_command_v2(p_actor uuid,p_workspace uuid,p_staff uuid,p_request uuid,p_action text,p_target uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare result jsonb;
begin
  if p_actor is null or p_request is null or p_target is null or p_action is null
    or (p_workspace is null and p_action not in ('accept','decline','submit'))
    or (p_workspace is not null and p_action not in ('create','request_changes','approve','cancel'))
    then raise exception using errcode='P1102',message='invalid_creator_command'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_request::text,0));
  result=public.creator_command_result_v2(p_actor,p_workspace,p_staff,p_request,p_action,p_target);
  if result->>'state'<>'unconfirmed' then return result; end if;
  insert into public.growth_creator_command_fences(actor_auth_user_id,request_key,actor_staff_user_id,workspace_id,action,target_id)
    values(p_actor,p_request,p_staff,p_workspace,p_action,p_target);
  return public.creator_command_result_v2(p_actor,p_workspace,p_staff,p_request,p_action,p_target);
end $$;

create or replace function public.read_growth_creator_directory(p_actor uuid,p_workspace uuid,p_staff uuid,p_offset integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare creator uuid; item record; result jsonb='[]'; more boolean=false;
begin
  creator=public.creator_job_actor(p_actor,p_workspace,p_staff);
  if creator is not null or p_workspace is null or p_staff is null then raise exception using errcode='P1111',message='creator_command_access_denied'; end if;
  if p_offset is null or p_offset not between 0 and 1000000 then raise exception using errcode='P1102',message='invalid_creator_page'; end if;
  for item in select id,display_name,portfolio_urls from public.growth_contributor_profiles where creator_status='approved'
    order by created_at desc,id limit 21 offset p_offset loop
    if jsonb_array_length(result)=20 then more=true;exit; end if;
    result=result||jsonb_build_array(jsonb_build_object('id',item.id,'displayName',item.display_name,'portfolioUrls',item.portfolio_urls));
  end loop;
  return jsonb_build_object('items',result,'hasMore',more);
end $$;

create or replace function public.read_growth_creator_job_detail(p_actor uuid,p_workspace uuid,p_staff uuid,p_job uuid,p_offset integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare creator uuid; job public.growth_creator_jobs%rowtype; company text; submission record; history jsonb='[]'; n integer=0; more boolean=false;
begin
  creator=public.creator_job_actor(p_actor,p_workspace,p_staff);
  if p_job is null or p_offset is null or p_offset not between 0 and 1000000 then raise exception using errcode='P1102',message='invalid_creator_page'; end if;
  select * into job from public.growth_creator_jobs where id=p_job
    and ((creator is null and workspace_id=p_workspace) or creator_id=creator) for update;
  if not found then raise exception using errcode='P1111',message='creator_command_access_denied'; end if;
  select btrim(name) into company from public.workspaces where id=job.workspace_id;
  if company is null or char_length(company) not between 1 and 200 or company ~ '[[:cntrl:]]'
    then raise exception using errcode='P1112',message='creator_job_detail_unconfirmed'; end if;
  -- 110's writer locks the same job before appending a version. Read one page
  -- by the immutable sequence index, never an unbounded history or offset scan.
  for submission in select * from public.growth_creator_submissions where job_id=job.id and sequence<=job.submission_count-p_offset
    order by sequence desc limit 21 loop
    if submission.sequence<>job.submission_count-p_offset-n then raise exception using errcode='P1112',message='creator_job_detail_unconfirmed'; end if;
    n=n+1;
    if n=21 then more=true;exit; end if;
    history=history||jsonb_build_array(jsonb_build_object('sequence',submission.sequence,'links',submission.links,'note',submission.note,
      'submittedAt',to_char(submission.submitted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end loop;
  if n<>least(21,greatest(0,job.submission_count-p_offset)) then raise exception using errcode='P1112',message='creator_job_detail_unconfirmed'; end if;
  return jsonb_build_object('job',public.creator_job_dto(job.id),'companyName',company,
    'history',jsonb_build_object('offset',p_offset,'items',history,'hasMore',more));
end $$;

-- Closing 110 EXECUTE is part of this coordinated candidate, not an optional grant.
revoke all on function public.execute_growth_creator_job(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb),
  public.read_growth_creator_command(uuid,uuid,uuid,uuid),public.creator_command_result_v2(uuid,uuid,uuid,uuid,text,uuid),
  public.execute_growth_creator_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb),
  public.read_growth_creator_command_v2(uuid,uuid,uuid,uuid),public.close_growth_creator_command_v2(uuid,uuid,uuid,uuid,text,uuid),
  public.read_growth_creator_directory(uuid,uuid,uuid,integer),public.read_growth_creator_job_detail(uuid,uuid,uuid,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.execute_growth_creator_job_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb),
  public.read_growth_creator_command_v2(uuid,uuid,uuid,uuid),public.close_growth_creator_command_v2(uuid,uuid,uuid,uuid,text,uuid),
  public.read_growth_creator_directory(uuid,uuid,uuid,integer),public.read_growth_creator_job_detail(uuid,uuid,uuid,uuid,integer) to service_role;
do $$ declare role_name text; f record; begin
  if exists(select 1 from public.growth_creator_command_fences fence_row join public.growth_creator_commands c
    on c.actor_id=fence_row.actor_auth_user_id and c.request_key=fence_row.request_key)
    then raise exception 'creator_closure_state_unconfirmed'; end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
    ('execute_growth_creator_job','read_growth_creator_command','creator_command_result_v2','execute_growth_creator_job_v2',
    'read_growth_creator_command_v2','close_growth_creator_command_v2','read_growth_creator_directory','read_growth_creator_job_detail'))<>8
    then raise exception 'creator_closure_executor_unconfirmed'; end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(role_name,'public.growth_creator_command_fences','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.growth_creator_command_fences','SELECT,INSERT,UPDATE,REFERENCES')
      then raise exception 'creator_closure_access_unconfirmed'; end if;
    for f in select p.oid,p.proname,p.proowner,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
      ('execute_growth_creator_job','read_growth_creator_command','creator_command_result_v2','execute_growth_creator_job_v2',
      'read_growth_creator_command_v2','close_growth_creator_command_v2','read_growth_creator_directory','read_growth_creator_job_detail') loop
      if f.proowner is distinct from to_regrole('postgres') or f.prosecdef is distinct from true
        or ('search_path=""'=any(f.proconfig)) is distinct from true
        or has_function_privilege(role_name,f.oid,'EXECUTE') is distinct from
        (role_name='service_role' and f.proname in ('execute_growth_creator_job_v2','read_growth_creator_command_v2','close_growth_creator_command_v2',
          'read_growth_creator_directory','read_growth_creator_job_detail'))
        then raise exception 'creator_closure_executor_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
