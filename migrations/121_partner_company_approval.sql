-- Local foundation for an already authenticated applicant and explicit platform
-- approval. No Auth user, password, subscription, payment or public intake is
-- created here. A future HTTP caller must supply verified subjects and the
-- approved immutable consent registry snapshot, never browser-selected actors.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare relation text; dependency record; begin
  if current_user<>'postgres' or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'partner_company_dependencies_unconfirmed'; end if;
  foreach relation in array array['workspaces','workspace_settings','staff_users','growth_partner_sources','growth_partner_payment_windows',
    'growth_partners','growth_contributor_profiles'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||relation) and relkind='r' and relowner=to_regrole('postgres') and relrowsecurity)
      then raise exception 'partner_company_dependencies_unconfirmed'; end if;
  end loop;
  for dependency in select * from (values
    ('public.valid_crm_site_consent_receipt(jsonb)','58ddaa8757c4944e1ff498db0de0e800060e51acaa2044883203bceca36c054d',false,'i'),
    ('public.claim_growth_partner_source(uuid,uuid,text)','db75769d24cb04c0fca14392383034577a64b0d798651a5bd4000226331423b3',true,'v'),
    ('public.partner_source_profile(uuid)','09c3adddbebc73f9251ca1cd25a1d295d669c4560be93fb9b658c76b4f0853b2',true,'v'),
    ('public.partner_source_owner(uuid,uuid)','3f452d692e08f57a3c75207de741965355c38b9bcadb7bd59e87ac828aa4b7a8',true,'v'),
    ('public.partner_source_result(public.growth_partner_sources)','eb608197f49139b80c3c348ee32bb09e99bad00dfa7bdfbb95c72bbc9ef6f4dd',true,'v'),
    ('public.purge_growth_partner_sources(integer)',case when to_regclass('public.growth_partner_company_applications') is null then
      '0881c506bfb92de7a99cdf3518bc97df38a8ef957d69711fd274fcc5501e2202' else '68d1d4c274a1ffcdc5af5d0efd635c024da00cfaf18341a48d76402c28f05671' end,true,'v'),
    ('public.bind_growth_partner_source(uuid,uuid,uuid)','6be3c2e0636043a945fcbfe847a16e945f00f9374429a6ae2a7a2ce4843dfd3f',true,'v')
  ) expected(signature,digest,definer,volatility) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef=dependency.definer and p.provolatile::text=dependency.volatility and not p.proretset and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'partner_company_dependencies_unconfirmed'; end if;
  end loop;
end $$;

create or replace function public.valid_partner_company(p_company jsonb)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare key text;
begin
  if p_company is null or jsonb_typeof(p_company)<>'object'
    or not(p_company ?& array['name','purpose','vertical','timeZone','ownerName'])
    or exists(select 1 from jsonb_object_keys(p_company) k where k not in ('name','purpose','vertical','timeZone','ownerName'))
    then return false; end if;
  foreach key in array array['name','purpose','timeZone','ownerName'] loop
    if jsonb_typeof(p_company->key) is distinct from 'string' or p_company->>key<>btrim(p_company->>key)
      or p_company->>key ~ '[[:cntrl:]]' then return false; end if;
  end loop;
  if length(p_company->>'name') not between 2 and 120 or length(p_company->>'ownerName') not between 1 and 120
    or p_company->>'purpose' not in ('clinic_services','marketing','mortgage_leads')
    or length(p_company->>'timeZone') not between 1 and 80
    or not exists(select 1 from pg_timezone_names where name=p_company->>'timeZone') then return false; end if;
  return case when p_company->>'purpose'='clinic_services' then jsonb_typeof(p_company->'vertical')='string'
    and p_company->>'vertical' in ('beauty','dental','clinic') else p_company->'vertical'='null'::jsonb end;
end $$;

create table if not exists public.growth_partner_company_applications (
  id uuid primary key,
  source_id uuid not null unique references public.growth_partner_sources(id),
  applicant_auth_user_id uuid not null,
  company jsonb not null check(public.valid_partner_company(company)),
  owner_email text not null check(length(owner_email)<=254 and owner_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  consent_snapshot jsonb not null check(public.valid_crm_site_consent_receipt(consent_snapshot) and consent_snapshot->>'purpose'='partner_company_registration'),
  state text not null default 'pending' check(state in ('pending','approved','rejected')),
  revision uuid not null default gen_random_uuid(),
  workspace_id uuid unique references public.workspaces(id),
  submitted_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  decision_request uuid unique,
  decision_revision uuid,
  check(case when state='pending' then workspace_id is null and reviewed_by is null and reviewed_at is null and decision_request is null and decision_revision is null
    else reviewed_by is not null and reviewed_at is not null and decision_request is not null and decision_revision is not null
      and ((state='approved')=(workspace_id is not null)) end)
);
alter table public.growth_partner_company_applications enable row level security;
revoke all on table public.growth_partner_company_applications from public,anon,authenticated,service_role;

create or replace function public.guard_partner_company_application()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (new.id,new.source_id,new.applicant_auth_user_id,new.company,new.owner_email,new.consent_snapshot,new.submitted_at)
    is distinct from (old.id,old.source_id,old.applicant_auth_user_id,old.company,old.owner_email,old.consent_snapshot,old.submitted_at)
    or old.state<>'pending' then raise exception using errcode='P1212',message='partner_company_immutable'; end if;
  return new;
end $$;
drop trigger if exists guard_partner_company_application on public.growth_partner_company_applications;
create trigger guard_partner_company_application before update on public.growth_partner_company_applications
  for each row execute function public.guard_partner_company_application();

create or replace function public.partner_company_result(p_application public.growth_partner_company_applications)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare source public.growth_partner_sources; source_result jsonb;
begin
  select * into source from public.growth_partner_sources where id=p_application.source_id;
  if not found or source.actor_auth_user_id is distinct from p_application.applicant_auth_user_id
    or (p_application.state='approved' and source.workspace_id is distinct from p_application.workspace_id)
    or (p_application.state<>'approved' and source.workspace_id is not null)
    then raise exception using errcode='P1212',message='partner_company_inconsistent'; end if;
  source_result:=public.partner_source_result(source);
  return jsonb_build_object('id',p_application.id,'revision',p_application.revision,'state',p_application.state,'company',p_application.company,
    'workspaceId',p_application.workspace_id,'sourceState',source_result->>'state','expiresAt',source_result->>'expiresAt',
    'submittedAt',to_char(p_application.submitted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'reviewedAt',case when p_application.reviewed_at is null then null else to_char(p_application.reviewed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end);
end $$;

create or replace function public.submit_growth_partner_company(
  p_actor uuid,p_source uuid,p_capability_hash text,p_request uuid,p_company jsonb,p_email text,p_consent jsonb
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_company_applications; source public.growth_partner_sources;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_actor is null or p_source is null or p_request is null
    or not public.valid_partner_company(p_company) or p_email is null or length(p_email)>254
    or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or not public.valid_crm_site_consent_receipt(p_consent) or p_consent->>'purpose'<>'partner_company_registration'
    then raise exception using errcode='P1212',message='partner_company_unconfirmed'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-company-command:'||p_request::text,0));
  perform pg_advisory_xact_lock(hashtextextended('partner-source:'||p_source::text,0));
  perform public.claim_growth_partner_source(p_actor,p_source,p_capability_hash);
  select * into source from public.growth_partner_sources where id=p_source and actor_auth_user_id=p_actor;
  if not found then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
  select * into saved from public.growth_partner_company_applications where source_id=p_source or id=p_request for update;
  if found then
    if saved.id<>p_request or saved.source_id<>p_source or saved.applicant_auth_user_id<>p_actor or saved.company is distinct from p_company
      or saved.owner_email<>p_email or saved.consent_snapshot is distinct from p_consent
      then raise exception using errcode='P1213',message='partner_company_request_conflict'; end if;
    return public.partner_company_result(saved);
  end if;
  if source.workspace_id is not null or source.expires_at<=clock_timestamp()
    then raise exception using errcode='P1213',message='partner_company_source_expired_or_used'; end if;
  insert into public.growth_partner_company_applications(id,source_id,applicant_auth_user_id,company,owner_email,consent_snapshot)
    values(p_request,p_source,p_actor,p_company,p_email,p_consent) returning * into saved;
  return public.partner_company_result(saved);
end $$;

create or replace function public.read_growth_partner_company(p_actor uuid,p_application uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_company_applications;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_actor is null or p_application is null
    then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
  select * into saved from public.growth_partner_company_applications where id=p_application and applicant_auth_user_id=p_actor;
  if not found then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-source:'||saved.source_id::text,0));
  select * into saved from public.growth_partner_company_applications where id=p_application and applicant_auth_user_id=p_actor;
  if saved.state='approved' then perform public.partner_source_owner(p_actor,saved.workspace_id); end if;
  return public.partner_company_result(saved);
end $$;

-- p_owner is the verified platform allowlist subject supplied by its protected
-- HTTP caller; it is NOT a staff role or a browser-selected company owner.
create or replace function public.review_growth_partner_company(
  p_owner uuid,p_application uuid,p_revision uuid,p_request uuid,p_action text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_company_applications; source public.growth_partner_sources; partner_actor uuid;
  workspace uuid; created timestamptz; source_result jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_owner is null or p_application is null or p_revision is null or p_request is null
    or p_action is null or p_action not in ('approve','reject') then raise exception using errcode='P1212',message='partner_company_unconfirmed'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-company-command:'||p_request::text,0));
  select * into saved from public.growth_partner_company_applications where id=p_application;
  if not found then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-source:'||saved.source_id::text,0));
  select * into saved from public.growth_partner_company_applications where id=p_application for update;
  if saved.state<>'pending' then
    if saved.decision_request=p_request and saved.reviewed_by=p_owner and saved.decision_revision=p_revision
      and saved.state=(case when p_action='approve' then 'approved' else 'rejected' end) then return public.partner_company_result(saved); end if;
    raise exception using errcode='P1213',message='partner_company_review_changed';
  end if;
  if saved.revision<>p_revision then raise exception using errcode='P1213',message='partner_company_review_changed'; end if;
  select * into source from public.growth_partner_sources where id=saved.source_id and actor_auth_user_id=saved.applicant_auth_user_id;
  if not found or source.workspace_id is not null then raise exception using errcode='P1212',message='partner_company_source_changed'; end if;
  if p_action='approve' then
    partner_actor:=public.partner_source_profile(source.partner_id);
    perform 1 from public.growth_partners where id=source.partner_id and auth_user_id=partner_actor and status='active' for update;
    if not found then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
    created:=clock_timestamp();
    if created<source.captured_at then raise exception using errcode='P1212',message='partner_company_clock_unconfirmed'; end if;
    insert into public.workspaces(name,owner_email,created_at) values(saved.company->>'name',saved.owner_email,created) returning id into workspace;
    insert into public.workspace_settings(workspace_id,key,value) values
      (workspace,case when saved.company->>'purpose'='clinic_services' then 'workspace_vertical' else 'workspace_purpose' end,
        case when saved.company->>'purpose'='clinic_services' then jsonb_build_object('vertical',saved.company->>'vertical') else jsonb_build_object('purpose',saved.company->>'purpose') end),
      (workspace,'clinic_schedule',jsonb_build_object('timeZone',saved.company->>'timeZone'));
    insert into public.staff_users(workspace_id,email,full_name,role,status,auth_user_id,invited_at,password_reset_required)
      values(workspace,saved.owner_email,saved.company->>'ownerName','owner','active',saved.applicant_auth_user_id,created,false);
    if source.expires_at>clock_timestamp() then
      source_result:=public.bind_growth_partner_source(saved.applicant_auth_user_id,source.id,workspace);
      if source_result->>'state'<>'pending_payment' then raise exception using errcode='P1212',message='partner_company_source_changed'; end if;
    else
      -- Late approval may create the company, never renew the original window.
      -- Since this workspace was created after expiry, no future legitimate
      -- first payment can qualify under 120's paid_at >= created_at rule.
      update public.growth_partner_sources set workspace_id=workspace,bound_at=created where id=source.id;
      insert into public.growth_partner_payment_windows(workspace_id,source_id,policy_version)
        values(workspace,source.id,'2026-10-28-first-paid-7d-self-v2');
    end if;
  end if;
  update public.growth_partner_company_applications set state=case when p_action='approve' then 'approved' else 'rejected' end,
    workspace_id=workspace,reviewed_by=p_owner,reviewed_at=clock_timestamp(),decision_request=p_request,decision_revision=p_revision,revision=gen_random_uuid()
    where id=saved.id returning * into saved;
  return public.partner_company_result(saved);
end $$;

create or replace function public.purge_growth_partner_sources(p_limit integer)
returns integer language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare candidate record; removed integer:=0; affected integer;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_limit is null or p_limit not between 1 and 100
    then raise exception using errcode='P1132',message='partner_entry_unconfirmed'; end if;
  for candidate in select s.id from public.growth_partner_sources s where s.workspace_id is null and s.expires_at<=clock_timestamp()
    and not exists(select 1 from public.growth_partner_company_applications a where a.source_id=s.id)
    order by s.expires_at,s.id limit p_limit loop
    if not pg_try_advisory_xact_lock(hashtextextended('partner-source:'||candidate.id::text,0)) then continue; end if;
    perform 1 from public.growth_partner_sources s where s.id=candidate.id and s.workspace_id is null and s.expires_at<=clock_timestamp()
      and not exists(select 1 from public.growth_partner_company_applications a where a.source_id=s.id) for update skip locked;
    if not found then continue; end if;
    delete from public.growth_partner_sources s where s.id=candidate.id and s.workspace_id is null and s.expires_at<=clock_timestamp()
      and not exists(select 1 from public.growth_partner_company_applications a where a.source_id=s.id);
    get diagnostics affected=row_count; removed:=removed+affected;
  end loop;
  return removed;
end $$;

revoke all on function public.valid_partner_company(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.guard_partner_company_application() from public,anon,authenticated,service_role;
revoke all on function public.partner_company_result(public.growth_partner_company_applications) from public,anon,authenticated,service_role;
revoke all on function public.submit_growth_partner_company(uuid,uuid,text,uuid,jsonb,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.read_growth_partner_company(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.review_growth_partner_company(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.purge_growth_partner_sources(integer) from public,anon,authenticated,service_role;
-- Approval is now the only external service entry that may reserve the source.
revoke all on function public.bind_growth_partner_source(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.submit_growth_partner_company(uuid,uuid,text,uuid,jsonb,text,jsonb) to service_role;
grant execute on function public.read_growth_partner_company(uuid,uuid) to service_role;
grant execute on function public.review_growth_partner_company(uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.purge_growth_partner_sources(integer) to service_role;
do $$ declare role_name text; signature text; begin
  if not exists(select 1 from pg_class where oid='public.growth_partner_company_applications'::regclass and relkind='r' and relowner=to_regrole('postgres') and relrowsecurity)
    or (select jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull) order by attnum)
      from pg_attribute where attrelid='public.growth_partner_company_applications'::regclass and attnum>0 and not attisdropped)
      is distinct from '[["id","uuid",true],["source_id","uuid",true],["applicant_auth_user_id","uuid",true],["company","jsonb",true],
        ["owner_email","text",true],["consent_snapshot","jsonb",true],["state","text",true],["revision","uuid",true],["workspace_id","uuid",false],
        ["submitted_at","timestamp with time zone",true],["reviewed_by","uuid",false],["reviewed_at","timestamp with time zone",false],
        ["decision_request","uuid",false],["decision_revision","uuid",false]]'::jsonb
    then raise exception 'partner_company_schema_unconfirmed'; end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(role_name,'public.growth_partner_company_applications','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.growth_partner_company_applications','SELECT,INSERT,UPDATE,REFERENCES')
      then raise exception 'partner_company_executors_unconfirmed'; end if;
    foreach signature in array array['public.valid_partner_company(jsonb)','public.guard_partner_company_application()',
      'public.partner_company_result(public.growth_partner_company_applications)','public.bind_growth_partner_source(uuid,uuid,uuid)'] loop
      if has_function_privilege(role_name,signature,'EXECUTE') then raise exception 'partner_company_executors_unconfirmed'; end if;
    end loop;
    foreach signature in array array['public.submit_growth_partner_company(uuid,uuid,text,uuid,jsonb,text,jsonb)',
      'public.read_growth_partner_company(uuid,uuid)','public.review_growth_partner_company(uuid,uuid,uuid,uuid,text)','public.purge_growth_partner_sources(integer)'] loop
      if has_function_privilege(role_name,signature,'EXECUTE') is distinct from (role_name='service_role')
        then raise exception 'partner_company_executors_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
