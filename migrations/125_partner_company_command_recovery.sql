-- Local-only candidate. An approved Auth subject submits; only the protected
-- platform HTTP caller supplies p_owner. No signup, payment or provider call.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare dependency record; signature text; relation text; role_name text; begin
  if current_user<>'postgres' or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'partner_company_recovery_dependencies_unconfirmed'; end if;
  foreach relation in array array['growth_partner_company_applications','growth_partner_sources'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||relation) and relkind='r'
      and relowner=to_regrole('postgres') and relrowsecurity) then raise exception 'partner_company_recovery_dependencies_unconfirmed'; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_table_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'partner_company_recovery_acl_unconfirmed'; end if;
    end loop;
  end loop;
  if md5((select jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) order by attnum)::text
    from pg_attribute where attrelid='public.growth_partner_company_applications'::regclass and attnum>0 and not attisdropped))
      is distinct from 'f8f347c4dccb9b3f4f6737bf223fae3b'
    or md5((select string_agg(pg_get_constraintdef(oid),E'\n' order by conname) from pg_constraint
      where conrelid='public.growth_partner_company_applications'::regclass)) is distinct from '5a67000f5aee8cf53e56ac76a1b163e3'
    then raise exception 'partner_company_recovery_shape_unconfirmed'; end if;
  if exists(select 1 from public.growth_partner_company_applications a join public.growth_partner_sources s on s.id=a.source_id
      where a.submitted_at>=s.expires_at)
    or not exists(select 1 from pg_trigger where tgrelid='public.growth_partner_company_applications'::regclass
      and not tgisinternal and tgname='guard_partner_company_application' and tgenabled='O' and tgtype=19 and tgnargs=0 and tgqual is null
      and tgfoid='public.guard_partner_company_application()'::regprocedure)
    or exists(select 1 from pg_trigger where tgrelid='public.growth_partner_company_applications'::regclass and not tgisinternal
      and tgname<>'guard_partner_company_application') then raise exception 'partner_company_recovery_rows_unconfirmed'; end if;
  for dependency in select * from (values
    ('public.read_growth_partner_company(uuid,uuid)','e6d4c87100c65a384d553e3af598b32c93e7d4624f80d9f422da9a3321a2faa6',true,'v'),
    ('public.partner_company_result(public.growth_partner_company_applications)','1b58fd9384093a5656909ac474424fd321e883845d0c6ea900811d43a03d6789',true,'v'),
    ('public.valid_partner_company(jsonb)','2f941d993e6f5e54ddcbc7a2e3fd8ce1ff02b4898cfd78598a4c468f5b9c6574',true,'s'),
    ('public.guard_partner_company_application()','da89733522f4308e2f9785105d6795ab21607fffc5baf7187cf8b3a75b114fc8',true,'v'),
    ('public.valid_crm_site_consent_receipt(jsonb)','58ddaa8757c4944e1ff498db0de0e800060e51acaa2044883203bceca36c054d',false,'i'),
    ('public.claim_growth_partner_source(uuid,uuid,text)','db75769d24cb04c0fca14392383034577a64b0d798651a5bd4000226331423b3',true,'v'),
    ('public.partner_source_profile(uuid)','09c3adddbebc73f9251ca1cd25a1d295d669c4560be93fb9b658c76b4f0853b2',true,'v'),
    ('public.partner_source_owner(uuid,uuid)','3f452d692e08f57a3c75207de741965355c38b9bcadb7bd59e87ac828aa4b7a8',true,'v'),
    ('public.partner_source_result(public.growth_partner_sources)','eb608197f49139b80c3c348ee32bb09e99bad00dfa7bdfbb95c72bbc9ef6f4dd',true,'v'),
    ('public.bind_growth_partner_source(uuid,uuid,uuid)','6be3c2e0636043a945fcbfe847a16e945f00f9374429a6ae2a7a2ce4843dfd3f',true,'v')
  ) expected(signature,digest,definer,volatility) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef=dependency.definer and p.provolatile::text=dependency.volatility and not p.proretset and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'partner_company_recovery_dependencies_unconfirmed'; end if;
  end loop;
  for dependency in select * from (values
    ('submit_growth_partner_company','uuid,uuid,text,uuid,jsonb,text,jsonb','7b53ff409fb8c28301bc931aa0f407c1735d53e6d0a6177ff9d8b75a22858279','aab2850f3cf27e05cc7da9c4911554a699eb3ba294b4a9b091bb714be79b985f'),
    ('review_growth_partner_company','uuid,uuid,uuid,uuid,text','9d001316ba795deefe5160539206b17522b272055ed16987b054e7accb438120','849799061ffc12610420a0e99a50f42b3f5e397907c97c017bd7ffb1c01394c5')
  ) expected(name,args,original_digest,wrapper_digest) loop
    signature:='public.'||dependency.name||case when to_regprocedure('public.'||dependency.name||'_121('||dependency.args||')') is null then '' else '_121' end||'('||dependency.args||')';
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef and p.provolatile='v' and not p.proretset and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.original_digest)
      then raise exception 'partner_company_recovery_original_unconfirmed'; end if;
    if position('_121(' in signature)>0 and not exists(select 1 from pg_proc p where
      p.oid=to_regprocedure('public.'||dependency.name||'('||dependency.args||')') and p.proowner=to_regrole('postgres')
      and p.prosecdef and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.wrapper_digest)
      then raise exception 'partner_company_recovery_wrapper_unconfirmed'; end if;
  end loop;
end $$;

-- Capability-free recovery metadata contains no company/contact/consent body.
-- Deliberately no FK to the expiring source: its cleanup cannot revive a closed
-- request ID. The authenticated actor remains part of every private lookup.
create table if not exists public.growth_partner_company_submission_fences (
  actor_id uuid not null, request_id uuid not null, source_id uuid not null,
  closed_at timestamptz not null default clock_timestamp(), primary key(actor_id,request_id)
);
create table if not exists public.growth_partner_company_review_fences (
  owner_id uuid not null, request_id uuid not null, application_id uuid not null,
  revision uuid not null, action text not null check(action in ('approve','reject')),
  closed_at timestamptz not null default clock_timestamp(), primary key(owner_id,request_id)
);
alter table public.growth_partner_company_submission_fences enable row level security;
alter table public.growth_partner_company_review_fences enable row level security;
revoke all on public.growth_partner_company_submission_fences,public.growth_partner_company_review_fences from public,anon,authenticated,service_role;

do $$ begin
  if to_regprocedure('public.submit_growth_partner_company_121(uuid,uuid,text,uuid,jsonb,text,jsonb)') is null then
    alter function public.submit_growth_partner_company(uuid,uuid,text,uuid,jsonb,text,jsonb) rename to submit_growth_partner_company_121;
  end if;
  if to_regprocedure('public.review_growth_partner_company_121(uuid,uuid,uuid,uuid,text)') is null then
    alter function public.review_growth_partner_company(uuid,uuid,uuid,uuid,text) rename to review_growth_partner_company_121;
  end if;
end $$;
revoke all on function public.submit_growth_partner_company_121(uuid,uuid,text,uuid,jsonb,text,jsonb),
  public.review_growth_partner_company_121(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role;

create or replace function public.submit_growth_partner_company(
  p_actor uuid,p_source uuid,p_capability_hash text,p_request uuid,p_company jsonb,p_email text,p_consent jsonb
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare result jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_actor is null or p_source is null or p_request is null
    then raise exception using errcode='P1212',message='partner_company_unconfirmed'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-company-command:'||p_request::text,0));
  if exists(select 1 from public.growth_partner_company_submission_fences where actor_id=p_actor and request_id=p_request)
    then raise exception using errcode='P1253',message='partner_company_submission_closed'; end if;
  result:=public.submit_growth_partner_company_121(p_actor,p_source,p_capability_hash,p_request,p_company,p_email,p_consent);
  -- The final insert can cross expiry after 121's pre-insert clock check.
  if (result->>'submittedAt')::timestamptz >= (result->>'expiresAt')::timestamptz
    then raise exception using errcode='P1213',message='partner_company_source_expired_or_used'; end if;
  return result;
end $$;

create or replace function public.review_growth_partner_company(
  p_owner uuid,p_application uuid,p_revision uuid,p_request uuid,p_action text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
begin
  if current_setting('transaction_isolation')<>'read committed' or p_owner is null or p_application is null or p_revision is null or p_request is null
    or p_action is null or p_action not in ('approve','reject') then raise exception using errcode='P1212',message='partner_company_unconfirmed'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-company-command:'||p_request::text,0));
  if exists(select 1 from public.growth_partner_company_review_fences where owner_id=p_owner and request_id=p_request)
    then raise exception using errcode='P1253',message='partner_company_review_closed'; end if;
  return public.review_growth_partner_company_121(p_owner,p_application,p_revision,p_request,p_action);
end $$;

create or replace function public.read_growth_partner_company_submission(p_actor uuid,p_source uuid,p_request uuid,p_close boolean)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_company_applications; fence public.growth_partner_company_submission_fences;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_actor is null or p_source is null or p_request is null or p_close is null
    then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-company-command:'||p_request::text,0));
  select * into fence from public.growth_partner_company_submission_fences where actor_id=p_actor and request_id=p_request;
  if found then
    if fence.source_id<>p_source then raise exception using errcode='P1213',message='partner_company_request_conflict'; end if;
    return jsonb_build_object('state','abandoned','requestId',p_request,'sourceId',p_source);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-source:'||p_source::text,0));
  select * into saved from public.growth_partner_company_applications where id=p_request;
  if found then
    if saved.applicant_auth_user_id<>p_actor or saved.source_id<>p_source
      then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
    return jsonb_build_object('state','committed','requestId',p_request,'sourceId',p_source,
      'application',public.read_growth_partner_company(p_actor,p_request));
  end if;
  perform 1 from public.growth_partner_sources where id=p_source and actor_auth_user_id=p_actor;
  if not found then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
  if p_close then
    insert into public.growth_partner_company_submission_fences(actor_id,request_id,source_id) values(p_actor,p_request,p_source);
  end if;
  return jsonb_build_object('state',case when p_close then 'abandoned' else 'unconfirmed' end,'requestId',p_request,'sourceId',p_source);
end $$;

create or replace function public.read_growth_partner_company_review(
  p_owner uuid,p_application uuid,p_revision uuid,p_request uuid,p_action text,p_close boolean
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_company_applications; fence public.growth_partner_company_review_fences; result jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_owner is null or p_application is null or p_revision is null or p_request is null
    or p_action is null or p_action not in ('approve','reject') or p_close is null then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-company-command:'||p_request::text,0));
  result:=jsonb_build_object('requestId',p_request,'applicationId',p_application,'revision',p_revision,'action',p_action);
  select * into fence from public.growth_partner_company_review_fences where owner_id=p_owner and request_id=p_request;
  if found then
    if (fence.application_id,fence.revision,fence.action) is distinct from (p_application,p_revision,p_action)
      then raise exception using errcode='P1213',message='partner_company_request_conflict'; end if;
    return result||jsonb_build_object('state','abandoned');
  end if;
  select * into saved from public.growth_partner_company_applications where id=p_application;
  if not found then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-source:'||saved.source_id::text,0));
  select * into saved from public.growth_partner_company_applications where id=p_application;
  if not found then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
  if saved.state<>'pending' then
    if (saved.decision_request,saved.reviewed_by,saved.decision_revision,saved.state)
      is distinct from (p_request,p_owner,p_revision,case when p_action='approve' then 'approved' else 'rejected' end)
      then raise exception using errcode='P1213',message='partner_company_review_changed'; end if;
    return result||jsonb_build_object('state','committed','application',public.partner_company_result(saved));
  end if;
  if saved.revision<>p_revision then raise exception using errcode='P1213',message='partner_company_review_changed'; end if;
  if p_close then
    insert into public.growth_partner_company_review_fences(owner_id,request_id,application_id,revision,action)
      values(p_owner,p_request,p_application,p_revision,p_action);
  end if;
  return result||jsonb_build_object('state',case when p_close then 'abandoned' else 'unconfirmed' end);
end $$;

create or replace function public.list_growth_partner_companies(p_owner uuid,p_offset integer,p_state text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare candidate record; saved public.growth_partner_company_applications; items jsonb:='[]'; more boolean:=false; count_rows integer:=0;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_owner is null or p_offset is null or p_offset not between 0 and 1000000
    or (p_state is not null and p_state not in ('pending','approved','rejected'))
    then raise exception using errcode='P1212',message='partner_company_unconfirmed'; end if;
  for candidate in select id,source_id,revision from public.growth_partner_company_applications
    where p_state is null or state=p_state order by submitted_at desc,id desc offset p_offset limit 21 loop
    perform pg_advisory_xact_lock(hashtextextended('partner-source:'||candidate.source_id::text,0));
    select * into saved from public.growth_partner_company_applications where id=candidate.id;
    if not found or saved.revision<>candidate.revision or (p_state is not null and saved.state<>p_state)
      then raise exception using errcode='P1252',message='partner_company_page_changed'; end if;
    count_rows:=count_rows+1;
    if count_rows<=20 then items:=items||jsonb_build_array(public.partner_company_result(saved)); else more:=true; end if;
  end loop;
  return jsonb_build_object('items',items,'offset',p_offset,'state',p_state,'hasMore',more);
end $$;

revoke all on function public.submit_growth_partner_company(uuid,uuid,text,uuid,jsonb,text,jsonb),
  public.review_growth_partner_company(uuid,uuid,uuid,uuid,text),
  public.read_growth_partner_company_submission(uuid,uuid,uuid,boolean),
  public.read_growth_partner_company_review(uuid,uuid,uuid,uuid,text,boolean),
  public.list_growth_partner_companies(uuid,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.submit_growth_partner_company(uuid,uuid,text,uuid,jsonb,text,jsonb),
  public.review_growth_partner_company(uuid,uuid,uuid,uuid,text),
  public.read_growth_partner_company_submission(uuid,uuid,uuid,boolean),
  public.read_growth_partner_company_review(uuid,uuid,uuid,uuid,text,boolean),
  public.list_growth_partner_companies(uuid,integer,text) to service_role;

do $$ declare relation text; role_name text; signature text; columns jsonb; begin
  foreach relation in array array['growth_partner_company_submission_fences','growth_partner_company_review_fences'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||relation) and relkind='r' and relowner=to_regrole('postgres') and relrowsecurity)
      or exists(select 1 from pg_policy where polrelid=to_regclass('public.'||relation)) then raise exception 'partner_company_recovery_acl_unconfirmed'; end if;
    select jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) order by attnum) into columns
      from pg_attribute where attrelid=to_regclass('public.'||relation) and attnum>0 and not attisdropped;
    if columns is distinct from (case when relation='growth_partner_company_submission_fences' then
      '[["actor_id","uuid",true],["request_id","uuid",true],["source_id","uuid",true],["closed_at","timestamp with time zone",true]]'::jsonb
      else '[["owner_id","uuid",true],["request_id","uuid",true],["application_id","uuid",true],["revision","uuid",true],["action","text",true],["closed_at","timestamp with time zone",true]]'::jsonb end)
      or exists(select 1 from pg_inherits where inhrelid=to_regclass('public.'||relation) or inhparent=to_regclass('public.'||relation))
      or exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||relation) and not tgisinternal)
      or exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||relation) and attnum>0 and not attisdropped and (attidentity<>'' or attgenerated<>''))
      or (select count(*) from pg_attrdef where adrelid=to_regclass('public.'||relation))<>1
      or not exists(select 1 from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
        where d.adrelid=to_regclass('public.'||relation) and a.attname='closed_at' and pg_get_expr(d.adbin,d.adrelid)='clock_timestamp()')
      or not exists(select 1 from pg_constraint where conrelid=to_regclass('public.'||relation) and contype='p' and conkey=array[1,2]::smallint[]
        and not condeferrable and convalidated)
      or (select count(*) from pg_constraint where conrelid=to_regclass('public.'||relation))<>(case when relation='growth_partner_company_submission_fences' then 1 else 2 end)
      then raise exception 'partner_company_recovery_fence_shape_unconfirmed'; end if;
    if relation='growth_partner_company_review_fences' and not exists(select 1 from pg_constraint
      where conrelid=to_regclass('public.'||relation) and contype='c' and convalidated and not connoinherit
      and pg_get_constraintdef(oid)='CHECK ((action = ANY (ARRAY[''approve''::text, ''reject''::text])))')
      then raise exception 'partner_company_recovery_fence_shape_unconfirmed'; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_table_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'partner_company_recovery_acl_unconfirmed'; end if;
    end loop;
  end loop;
  foreach signature in array array['public.submit_growth_partner_company_121(uuid,uuid,text,uuid,jsonb,text,jsonb)',
    'public.review_growth_partner_company_121(uuid,uuid,uuid,uuid,text)'] loop
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(role_name,signature,'EXECUTE') then raise exception 'partner_company_recovery_original_exposed'; end if;
    end loop;
  end loop;
  foreach signature in array array['public.submit_growth_partner_company(uuid,uuid,text,uuid,jsonb,text,jsonb)',
    'public.review_growth_partner_company(uuid,uuid,uuid,uuid,text)',
    'public.read_growth_partner_company_submission(uuid,uuid,uuid,boolean)',
    'public.read_growth_partner_company_review(uuid,uuid,uuid,uuid,text,boolean)',
    'public.list_growth_partner_companies(uuid,integer,text)'] loop
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(role_name,signature,'EXECUTE') is distinct from (role_name='service_role')
        then raise exception 'partner_company_recovery_rpc_acl_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
