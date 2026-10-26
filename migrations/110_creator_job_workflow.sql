-- Local foundation only: explicit creator terms and durable commands, no payments.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare relation text; dependency record; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'creator_job_dependencies_unconfirmed'; end if;
  foreach relation in array array['workspaces','staff_users','growth_contributor_profiles'] loop
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      and c.relname=relation and c.relkind='r' and c.relowner=to_regrole('postgres') and c.relrowsecurity)
      then raise exception 'creator_job_dependencies_unconfirmed'; end if;
  end loop;
  for dependency in select * from (values
    ('public.apply_growth_contributor(uuid,text,boolean,boolean,text[])','a88222425af811b7667b56fbc172cb021c8669c13563bfa618fb6f83900b501d'),
    ('public.review_growth_contributor(uuid,uuid,uuid,text,text)','b08def2be56535257431253433b0cff8ebf10f55823ab33143f8a65d29d8d0ab')
  ) expected(signature,digest) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature)
      and p.proowner=to_regrole('postgres') and p.prosecdef and p.provolatile='v' and not p.proretset
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'creator_job_dependencies_unconfirmed'; end if;
  end loop;
end $$;

create table if not exists public.growth_creator_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  creator_id uuid not null references public.growth_contributor_profiles(id),
  created_by uuid not null,
  title text not null check(char_length(title) between 1 and 120),
  brief text not null check(char_length(brief) between 1 and 4000),
  rights_terms text not null check(char_length(rights_terms) between 1 and 3000),
  fee_minor bigint not null check(fee_minor>0),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  due_at timestamptz not null check(isfinite(due_at)),
  terms_revision uuid not null default gen_random_uuid(),
  revision uuid not null default gen_random_uuid(),
  state text not null default 'offered' check(state in ('offered','in_progress','submitted','changes_requested','approved','declined','cancelled')),
  accepted_at timestamptz,
  accepted_by uuid,
  approved_at timestamptz,
  submission_count integer not null default 0 check(submission_count>=0),
  feedback text check(char_length(feedback) between 1 and 2000),
  created_at timestamptz not null default clock_timestamp(),
  check((accepted_at is not null and accepted_by is not null)=(state in ('in_progress','submitted','changes_requested','approved'))),
  check((approved_at is not null)=(state='approved')),
  check((feedback is not null)=(state='changes_requested')),
  check((submission_count>0)=(state in ('submitted','changes_requested','approved')) or state='in_progress')
);
create index if not exists growth_creator_jobs_workspace_idx on public.growth_creator_jobs(workspace_id,created_at desc,id);
create index if not exists growth_creator_jobs_creator_idx on public.growth_creator_jobs(creator_id,created_at desc,id);
create table if not exists public.growth_creator_submissions (
  job_id uuid not null references public.growth_creator_jobs(id),
  sequence integer not null check(sequence>0),
  links jsonb not null check(jsonb_typeof(links)='array' and jsonb_array_length(links) between 1 and 5),
  note text not null check(char_length(note)<=2000),
  submitted_by uuid not null,
  submitted_at timestamptz not null default clock_timestamp(),
  primary key(job_id,sequence)
);
create table if not exists public.growth_creator_commands (
  actor_id uuid not null,
  request_key uuid not null,
  job_id uuid not null references public.growth_creator_jobs(id),
  intent jsonb not null check(jsonb_typeof(intent)='object'),
  applied_revision uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_id,request_key)
);
create table if not exists public.growth_creator_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.growth_creator_jobs(id),
  actor_id uuid not null,
  request_key uuid not null,
  action text not null check(action in ('create','accept','decline','submit','request_changes','approve','cancel')),
  previous_state text,
  next_state text not null,
  feedback text,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(actor_id,request_key) references public.growth_creator_commands(actor_id,request_key),
  unique(actor_id,request_key)
);
alter table public.growth_creator_jobs enable row level security;
alter table public.growth_creator_submissions enable row level security;
alter table public.growth_creator_commands enable row level security;
alter table public.growth_creator_events enable row level security;
revoke all on public.growth_creator_jobs,public.growth_creator_submissions,public.growth_creator_commands,public.growth_creator_events
  from public,anon,authenticated,service_role;

create or replace function public.creator_job_actor(p_actor uuid,p_workspace uuid,p_staff uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare creator uuid;
begin
  if p_actor is null or current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
  if p_workspace is not null and p_staff is not null then
    perform 1 from public.staff_users where id=p_staff and workspace_id=p_workspace and auth_user_id=p_actor
      and status='active' and role in ('owner','admin') for update;
    if not found then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
    return null;
  elsif p_workspace is null and p_staff is null then
    select id into creator from public.growth_contributor_profiles where auth_user_id=p_actor and creator_status='approved' for update;
    if found then return creator; end if;
  end if;
  raise exception using errcode='P1101',message='creator_job_access_denied';
end $$;

create or replace function public.creator_job_keys(p_value jsonb,p_required text[])
returns boolean language sql immutable set search_path='' as $$
  select jsonb_typeof(p_value)='object' and p_value ?& p_required
    and not exists(select 1 from jsonb_object_keys(p_value) k where not k=any(p_required));
$$;
create or replace function public.creator_job_text(p_value jsonb,p_limit integer)
returns boolean language sql immutable set search_path='' as $$
  select jsonb_typeof(p_value)='string' and char_length(p_value#>>'{}') between 1 and p_limit
    and p_value#>>'{}'=btrim(p_value#>>'{}') and replace(p_value#>>'{}',E'\n','') !~ '[[:cntrl:]]';
$$;
create or replace function public.creator_job_links(p_value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare link jsonb; host text;
begin
  if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value) not between 1 and 5 then return false; end if;
  if (select count(distinct v) from jsonb_array_elements(p_value) v)<>jsonb_array_length(p_value) then return false; end if;
  for link in select * from jsonb_array_elements(p_value) loop
    if jsonb_typeof(link)<>'string' or char_length(link#>>'{}')>500
      or link#>>'{}' !~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}([/?#][^[:space:][:cntrl:]\\]*)?$'
      then return false; end if;
    host=lower(split_part(substring(link#>>'{}' from 9),'/',1));host=split_part(split_part(host,'?',1),'#',1);
    if host ~ '(^|\.)(localhost|local|internal|invalid|test)$' then return false; end if;
  end loop;
  return true;
end $$;

create or replace function public.creator_job_dto(p_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',j.id,'revision',j.revision,'termsRevision',j.terms_revision,'title',j.title,'brief',j.brief,
    'rightsTerms',j.rights_terms,'feeMinor',j.fee_minor::text,'currency',j.currency,'state',j.state,'creatorName',p.display_name,
    'dueAt',to_char(j.due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'acceptedAt',case when j.accepted_at is not null then to_char(j.accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'approvedAt',case when j.approved_at is not null then to_char(j.approved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'submissionCount',j.submission_count,'feedback',j.feedback,
    'latestSubmission',(select jsonb_build_object('sequence',s.sequence,'links',s.links,'note',s.note,
      'submittedAt',to_char(s.submitted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      from public.growth_creator_submissions s where s.job_id=j.id and s.sequence=j.submission_count))
  from public.growth_creator_jobs j join public.growth_contributor_profiles p on p.id=j.creator_id where j.id=p_id;
$$;

create or replace function public.execute_growth_creator_job(
  p_actor uuid,p_workspace uuid,p_staff uuid,p_request uuid,p_job uuid,p_revision uuid,p_action text,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare creator uuid; target_creator uuid; job public.growth_creator_jobs%rowtype;
  prior public.growth_creator_commands%rowtype; intent jsonb; previous text; target_state text; due timestamptz; fee numeric;
begin
  if p_actor is null or p_request is null then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
  if p_action is null or p_action not in ('create','accept','decline','submit','request_changes','approve','cancel')
    or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>16000
    then raise exception using errcode='P1102',message='invalid_creator_command'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_request::text,0));
  creator=public.creator_job_actor(p_actor,p_workspace,p_staff);
  intent=jsonb_build_object('workspace',p_workspace,'staff',p_staff,'job',p_job,'revision',p_revision,'action',p_action,'payload',p_payload);
  select * into prior from public.growth_creator_commands where actor_id=p_actor and request_key=p_request;
  if found and prior.intent<>intent then raise exception using errcode='P1103',message='creator_command_conflict'; end if;
  if p_action='create' then
    if creator is not null or p_job is not null or p_revision is not null then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
    if not public.creator_job_keys(p_payload,array['creatorId','title','brief','rightsTerms','feeMinor','currency','dueAt'])
      or jsonb_typeof(p_payload->'creatorId')<>'string' or p_payload->>'creatorId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      or not public.creator_job_text(p_payload->'title',120) or p_payload->>'title' ~ E'\n' or not public.creator_job_text(p_payload->'brief',4000)
      or not public.creator_job_text(p_payload->'rightsTerms',3000) or jsonb_typeof(p_payload->'feeMinor')<>'string'
      or p_payload->>'feeMinor' !~ '^[1-9][0-9]{0,18}$' or jsonb_typeof(p_payload->'currency')<>'string'
      or p_payload->>'currency' !~ '^[A-Z]{3}$' or jsonb_typeof(p_payload->'dueAt')<>'string'
      or p_payload->>'dueAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      then raise exception using errcode='P1102',message='invalid_creator_terms'; end if;
    fee=(p_payload->>'feeMinor')::numeric;
    if fee>9223372036854775807 then raise exception using errcode='P1102',message='invalid_creator_terms'; end if;
    begin due=(p_payload->>'dueAt')::timestamptz;
      if to_char(due at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p_payload->>'dueAt' then raise exception 'invalid_date'; end if;
    exception when others then raise exception using errcode='P1102',message='invalid_creator_terms'; end;
    target_creator=(p_payload->>'creatorId')::uuid;
  else
    if p_job is null or p_revision is null then raise exception using errcode='P1102',message='invalid_creator_command'; end if;
    select creator_id into target_creator from public.growth_creator_jobs where id=p_job
      and ((creator is null and workspace_id=p_workspace) or creator_id=creator);
    if not found then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
  end if;
  -- Common profile-before-job ordering coordinates commands with approval/revocation.
  perform 1 from public.growth_contributor_profiles where id=target_creator for update;
  if not found then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
  if prior.job_id is not null then
    select * into job from public.growth_creator_jobs where id=prior.job_id
      and ((creator is null and workspace_id=p_workspace) or creator_id=creator) for update;
    if not found then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
    return jsonb_build_object('requestId',p_request,'appliedRevision',prior.applied_revision,'replayed',true,'job',public.creator_job_dto(job.id));
  end if;
  if p_action='create' then
    perform 1 from public.growth_contributor_profiles where id=target_creator and creator_status='approved';
    if not found then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
    insert into public.growth_creator_jobs(workspace_id,creator_id,created_by,title,brief,rights_terms,fee_minor,currency,due_at)
      values(p_workspace,target_creator,p_actor,p_payload->>'title',p_payload->>'brief',p_payload->>'rightsTerms',fee::bigint,p_payload->>'currency',due) returning * into job;
    previous=null; target_state='offered';
  else
    select * into job from public.growth_creator_jobs where id=p_job
      and ((creator is null and workspace_id=p_workspace) or creator_id=creator) for update;
    if not found then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
    if job.revision<>p_revision then raise exception using errcode='P1104',message='creator_job_changed'; end if;
    previous=job.state;
    if creator is not null and p_action='accept' and job.state='offered' then
      if not public.creator_job_keys(p_payload,array['termsRevision']) or lower(p_payload->>'termsRevision') is distinct from job.terms_revision::text
        then raise exception using errcode='P1104',message='creator_terms_changed'; end if;
      target_state='in_progress';
    elsif creator is not null and p_action='decline' and job.state='offered' and p_payload='{}'::jsonb then target_state='declined';
    elsif creator is not null and p_action='submit' and job.state in ('in_progress','changes_requested') then
      if not public.creator_job_keys(p_payload,array['links','note']) or not public.creator_job_links(p_payload->'links')
        or jsonb_typeof(p_payload->'note')<>'string' or char_length(p_payload->>'note')>2000 or replace(p_payload->>'note',E'\n','') ~ '[[:cntrl:]]'
        then raise exception using errcode='P1102',message='invalid_creator_submission'; end if;
      insert into public.growth_creator_submissions(job_id,sequence,links,note,submitted_by)
        values(job.id,job.submission_count+1,p_payload->'links',p_payload->>'note',p_actor);
      target_state='submitted';
    elsif creator is null and p_action='request_changes' and job.state='submitted' then
      if not public.creator_job_keys(p_payload,array['feedback']) or not public.creator_job_text(p_payload->'feedback',2000)
        then raise exception using errcode='P1102',message='invalid_creator_feedback'; end if;
      target_state='changes_requested';
    elsif creator is null and p_action='approve' and job.state='submitted' and p_payload='{}'::jsonb then target_state='approved';
    elsif creator is null and p_action='cancel' and job.state='offered' and p_payload='{}'::jsonb then target_state='cancelled';
    else raise exception using errcode='P1104',message='creator_job_changed'; end if;
    update public.growth_creator_jobs set state=target_state,revision=gen_random_uuid(),
      accepted_at=case when p_action='accept' then clock_timestamp() else accepted_at end,
      accepted_by=case when p_action='accept' then p_actor else accepted_by end,
      approved_at=case when p_action='approve' then clock_timestamp() else approved_at end,
      feedback=case when p_action='request_changes' then p_payload->>'feedback' end,
      submission_count=submission_count+case when p_action='submit' then 1 else 0 end
      where id=job.id returning * into job;
  end if;
  insert into public.growth_creator_commands(actor_id,request_key,job_id,intent,applied_revision)
    values(p_actor,p_request,job.id,intent,job.revision);
  insert into public.growth_creator_events(job_id,actor_id,request_key,action,previous_state,next_state,feedback)
    values(job.id,p_actor,p_request,p_action,previous,target_state,case when p_action='request_changes' then p_payload->>'feedback' end);
  return jsonb_build_object('requestId',p_request,'appliedRevision',job.revision,'replayed',false,'job',public.creator_job_dto(job.id));
end $$;

create or replace function public.read_growth_creator_jobs(p_actor uuid,p_workspace uuid,p_staff uuid,p_offset integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare creator uuid; job record; result jsonb='[]'; more boolean=false;
begin
  creator=public.creator_job_actor(p_actor,p_workspace,p_staff);
  if p_offset is null or p_offset not between 0 and 1000000 then raise exception using errcode='P1102',message='invalid_creator_page'; end if;
  for job in select id from public.growth_creator_jobs where (creator is null and workspace_id=p_workspace) or creator_id=creator
    order by created_at desc,id limit 21 offset p_offset for update loop
    if jsonb_array_length(result)=20 then more=true;exit; end if;
    result=result||jsonb_build_array(public.creator_job_dto(job.id));
  end loop;
  return jsonb_build_object('items',result,'hasMore',more);
end $$;

create or replace function public.read_growth_creator_command(p_actor uuid,p_workspace uuid,p_staff uuid,p_request uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare creator uuid; receipt public.growth_creator_commands%rowtype; job public.growth_creator_jobs%rowtype;
begin
  if p_actor is null or p_request is null then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_request::text,0));
  creator=public.creator_job_actor(p_actor,p_workspace,p_staff);
  select * into receipt from public.growth_creator_commands where actor_id=p_actor and request_key=p_request;
  if not found then return null; end if;
  select * into job from public.growth_creator_jobs where id=receipt.job_id
    and ((creator is null and workspace_id=p_workspace) or creator_id=creator) for update;
  if not found then raise exception using errcode='P1101',message='creator_job_access_denied'; end if;
  return jsonb_build_object('requestId',p_request,'appliedRevision',receipt.applied_revision,'replayed',true,'job',public.creator_job_dto(job.id));
end $$;

revoke all on function public.creator_job_actor(uuid,uuid,uuid),public.creator_job_keys(jsonb,text[]),public.creator_job_text(jsonb,integer),
  public.creator_job_links(jsonb),public.creator_job_dto(uuid),public.execute_growth_creator_job(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb),
  public.read_growth_creator_jobs(uuid,uuid,uuid,integer),public.read_growth_creator_command(uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.execute_growth_creator_job(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb),
  public.read_growth_creator_jobs(uuid,uuid,uuid,integer),public.read_growth_creator_command(uuid,uuid,uuid,uuid) to service_role;
do $$ declare role_name text; relation text; signature text; begin
  foreach relation in array array['growth_creator_jobs','growth_creator_submissions','growth_creator_commands','growth_creator_events'] loop
    if not exists(select 1 from pg_class c where c.oid=to_regclass('public.'||relation) and c.relowner=to_regrole('postgres')
      and c.relkind='r' and not c.relispartition and c.relrowsecurity
      and not exists(select 1 from pg_inherits i where i.inhrelid=c.oid or i.inhparent=c.oid)
      and not exists(select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
      and not exists(select 1 from pg_policy p where p.polrelid=c.oid))
      then raise exception 'creator_job_relations_unconfirmed'; end if;
  end loop;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    foreach relation in array array['growth_creator_jobs','growth_creator_submissions','growth_creator_commands','growth_creator_events'] loop
      if has_table_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'creator_job_direct_access_unconfirmed'; end if;
    end loop;
    foreach signature in array array['creator_job_actor(uuid,uuid,uuid)','creator_job_keys(jsonb,text[])','creator_job_text(jsonb,integer)',
      'creator_job_links(jsonb)','creator_job_dto(uuid)','execute_growth_creator_job(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb)',
      'read_growth_creator_jobs(uuid,uuid,uuid,integer)','read_growth_creator_command(uuid,uuid,uuid,uuid)'] loop
      if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.'||signature) and p.proowner=to_regrole('postgres')
        and 'search_path=""'=any(p.proconfig)) then raise exception 'creator_job_executor_unconfirmed'; end if;
      if has_function_privilege(role_name,'public.'||signature,'EXECUTE') is distinct from
        (role_name='service_role' and signature in ('execute_growth_creator_job(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb)',
          'read_growth_creator_jobs(uuid,uuid,uuid,integer)','read_growth_creator_command(uuid,uuid,uuid,uuid)'))
        then raise exception 'creator_job_executor_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
