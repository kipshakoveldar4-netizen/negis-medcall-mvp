-- Local-only read path. No company creation, new identity, payment or provider.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare dependency record; relation text; role_name text; begin
  if current_user<>'postgres' or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'partner_company_inbox_dependencies_unconfirmed'; end if;
  foreach relation in array array['growth_partner_company_applications','growth_partner_sources','workspaces','staff_users',
    'growth_partner_company_submission_fences','growth_partner_company_review_fences'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||relation) and relkind='r'
      and relowner=to_regrole('postgres') and relrowsecurity) then raise exception 'partner_company_inbox_dependencies_unconfirmed'; end if;
  end loop;
  foreach relation in array array['growth_partner_company_applications','growth_partner_sources',
    'growth_partner_company_submission_fences','growth_partner_company_review_fences'] loop
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_table_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'partner_company_inbox_acl_unconfirmed'; end if;
    end loop;
  end loop;
  if md5((select jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) order by attnum)::text
    from pg_attribute where attrelid='public.growth_partner_company_applications'::regclass and attnum>0 and not attisdropped))
      is distinct from 'f8f347c4dccb9b3f4f6737bf223fae3b'
    or md5((select string_agg(pg_get_constraintdef(oid),E'\n' order by conname) from pg_constraint
      where conrelid='public.growth_partner_company_applications'::regclass)) is distinct from '5a67000f5aee8cf53e56ac76a1b163e3'
    then raise exception 'partner_company_inbox_shape_unconfirmed'; end if;
  for dependency in select * from (values
    ('public.read_growth_partner_company(uuid,uuid)','e6d4c87100c65a384d553e3af598b32c93e7d4624f80d9f422da9a3321a2faa6',true),
    ('public.partner_source_owner(uuid,uuid)','3f452d692e08f57a3c75207de741965355c38b9bcadb7bd59e87ac828aa4b7a8',false),
    ('public.partner_company_result(public.growth_partner_company_applications)','1b58fd9384093a5656909ac474424fd321e883845d0c6ea900811d43a03d6789',false),
    ('public.partner_source_result(public.growth_partner_sources)','eb608197f49139b80c3c348ee32bb09e99bad00dfa7bdfbb95c72bbc9ef6f4dd',false),
    ('public.submit_growth_partner_company(uuid,uuid,text,uuid,jsonb,text,jsonb)','aab2850f3cf27e05cc7da9c4911554a699eb3ba294b4a9b091bb714be79b985f',true),
    ('public.review_growth_partner_company(uuid,uuid,uuid,uuid,text)','849799061ffc12610420a0e99a50f42b3f5e397907c97c017bd7ffb1c01394c5',true)
  ) expected(signature,digest,server_allowed) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef and p.provolatile='v' and not p.proretset and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'partner_company_inbox_dependencies_unconfirmed'; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(role_name,dependency.signature,'EXECUTE') is distinct from (role_name='service_role' and dependency.server_allowed)
        then raise exception 'partner_company_inbox_acl_unconfirmed'; end if;
    end loop;
  end loop;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(role_name,'public.submit_growth_partner_company_121(uuid,uuid,text,uuid,jsonb,text,jsonb)','EXECUTE')
      or has_function_privilege(role_name,'public.review_growth_partner_company_121(uuid,uuid,uuid,uuid,text)','EXECUTE')
      then raise exception 'partner_company_inbox_acl_unconfirmed'; end if;
  end loop;
  if to_regprocedure('public.list_own_growth_partner_companies(uuid,integer,text)') is not null then
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.list_own_growth_partner_companies(uuid,integer,text)')
      and p.proowner=to_regrole('postgres') and p.prosecdef and p.provolatile='v' and not p.proretset
      and p.prorettype='jsonb'::regtype and p.pronargdefaults=0
      and p.proconfig=array['search_path=""','lock_timeout=3s','statement_timeout=8s']::text[]
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')='5e9aea4c22f44c35c5ea243af89c5231172834ebc7a10ec11a38ce9f336e6fe7')
      then raise exception 'partner_company_inbox_reader_unconfirmed'; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(role_name,'public.list_own_growth_partner_companies(uuid,integer,text)','EXECUTE')
        is distinct from (role_name='service_role') then raise exception 'partner_company_inbox_acl_unconfirmed'; end if;
    end loop;
  end if;
end $$;

create or replace function public.list_own_growth_partner_companies(p_actor uuid,p_offset integer,p_state text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare candidate record; saved public.growth_partner_company_applications; item jsonb;
  items jsonb:='[]'; more boolean:=false; count_rows integer:=0;
begin
  if p_actor is null then raise exception using errcode='P1211',message='partner_company_unavailable'; end if;
  if current_setting('transaction_isolation')<>'read committed' or p_offset is null or p_offset not between 0 and 1000000
    or (p_state is not null and p_state not in ('pending','approved','rejected'))
    then raise exception using errcode='P1212',message='partner_company_unconfirmed'; end if;
  -- Apply all applicant/current-owner authority before lookahead and pagination.
  for candidate in select a.id,a.source_id,a.revision,a.state from public.growth_partner_company_applications a
    where a.applicant_auth_user_id=p_actor and (p_state is null or a.state=p_state)
      and (a.state<>'approved' or exists(select 1 from public.staff_users s where s.workspace_id=a.workspace_id
        and s.auth_user_id=p_actor and s.role='owner' and s.status='active'))
    order by a.submitted_at desc,a.id desc offset p_offset limit 21 loop
    perform pg_advisory_xact_lock(hashtextextended('partner-source:'||candidate.source_id::text,0));
    select * into saved from public.growth_partner_company_applications where id=candidate.id and applicant_auth_user_id=p_actor;
    if not found or saved.revision<>candidate.revision or saved.state<>candidate.state
      then raise exception using errcode='P1262',message='partner_company_page_changed'; end if;
    -- This existing private reader also locks and rechecks active owner authority.
    item:=public.read_growth_partner_company(p_actor,candidate.id);
    count_rows:=count_rows+1;
    if count_rows<=20 then items:=items||jsonb_build_array(item); else more:=true; end if;
  end loop;
  return jsonb_build_object('items',items,'offset',p_offset,'state',p_state,'hasMore',more);
end $$;

revoke all on function public.list_own_growth_partner_companies(uuid,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.list_own_growth_partner_companies(uuid,integer,text) to service_role;

do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(role_name,'public.list_own_growth_partner_companies(uuid,integer,text)','EXECUTE')
      is distinct from (role_name='service_role') then raise exception 'partner_company_inbox_acl_unconfirmed'; end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
