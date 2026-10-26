-- Coordinate the HTTP caller cutover. No public intake, scheduler or approval is enabled.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $$ declare dependency record; role_name text; begin
  if current_user<>'postgres' or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    or not exists(select 1 from pg_class where oid=to_regclass('public.growth_partner_sources') and relkind='r'
      and relowner=to_regrole('postgres') and relrowsecurity)
    then raise exception 'partner_entry_dependencies_unconfirmed'; end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(role_name,'public.growth_partner_sources','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.growth_partner_sources','SELECT,INSERT,UPDATE,REFERENCES')
      then raise exception 'partner_entry_dependencies_unconfirmed'; end if;
  end loop;
  for dependency in select * from (values
    ('public.partner_source_profile(uuid)','09c3adddbebc73f9251ca1cd25a1d295d669c4560be93fb9b658c76b4f0853b2'),
    ('public.partner_source_result(public.growth_partner_sources)','bb5fea320dc455ca6e2324a32c39d21e3f27f783b25f84a918fbb56aa4dc337c'),
    ('public.partner_source_owner(uuid,uuid)','3f452d692e08f57a3c75207de741965355c38b9bcadb7bd59e87ac828aa4b7a8'),
    ('public.capture_growth_partner_source(uuid,text,text,text)','6922c003e0b2028268d59b84e5b36160251d4eb94914e38469fa958576477651'),
    ('public.claim_growth_partner_source(uuid,uuid,text)','db75769d24cb04c0fca14392383034577a64b0d798651a5bd4000226331423b3'),
    ('public.read_growth_partner_source(uuid,uuid)','deedb2b03d63985d27cbfae1ba93452749863bb88b8a855f559f20adcac39436'),
    ('public.bind_growth_partner_source(uuid,uuid,uuid)','aa3134ec3cb383b7be5d540a230cdcdd2cb0c1229d40de616246b8ed0f57c738')
  ) expected(signature,digest) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef and p.provolatile='v' and not p.proretset and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'partner_entry_dependencies_unconfirmed'; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if role_name<>'service_role' or dependency.signature in (
        'public.partner_source_profile(uuid)','public.partner_source_result(public.growth_partner_sources)','public.partner_source_owner(uuid,uuid)'
      ) then
        if has_function_privilege(role_name,dependency.signature,'EXECUTE')
          then raise exception 'partner_entry_dependencies_unconfirmed'; end if;
      elsif dependency.signature<>'public.capture_growth_partner_source(uuid,text,text,text)'
        and not has_function_privilege(role_name,dependency.signature,'EXECUTE')
        then raise exception 'partner_entry_dependencies_unconfirmed'; end if;
    end loop;
  end loop;
end $$;

create index if not exists growth_partner_sources_expiry_idx
  on public.growth_partner_sources(expires_at,id) where workspace_id is null;

create or replace function public.capture_growth_partner_source_v2(
  p_intent uuid,p_capability_hash text,p_code text,p_source text,p_started_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_sources; existed boolean;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_started_at is null or not isfinite(p_started_at)
    or p_started_at>clock_timestamp()+interval '30 seconds'
    then raise exception using errcode='P1132',message='partner_entry_unconfirmed'; end if;
  if p_started_at+interval '168 hours'<=clock_timestamp()
    then raise exception using errcode='P1133',message='partner_entry_expired'; end if;
  if p_intent is null then raise exception using errcode='P1132',message='partner_entry_unconfirmed'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-source:'||p_intent::text,0));
  select * into saved from public.growth_partner_sources where id=p_intent;
  existed:=found;
  if existed and saved.captured_at is distinct from p_started_at
    then raise exception using errcode='P1132',message='partner_entry_unconfirmed'; end if;
  -- The old definer still supplies the original authority/first-source checks.
  perform public.capture_growth_partner_source(p_intent,p_capability_hash,p_code,p_source);
  if p_started_at+interval '168 hours'<=clock_timestamp()
    then raise exception using errcode='P1133',message='partner_entry_expired'; end if;
  if not existed then
    update public.growth_partner_sources set captured_at=p_started_at,expires_at=p_started_at+interval '168 hours'
      where id=p_intent and capability_hash=p_capability_hash and actor_auth_user_id is null and workspace_id is null returning * into saved;
    if not found then raise exception using errcode='P1132',message='partner_entry_unconfirmed'; end if;
  end if;
  return public.partner_source_result(saved)-'workspaceId'-'state'-'source';
end $$;

create or replace function public.purge_growth_partner_sources(p_limit integer)
returns integer language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare candidate record; removed integer:=0; affected integer;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_limit is null or p_limit not between 1 and 100
    then raise exception using errcode='P1132',message='partner_entry_unconfirmed'; end if;
  for candidate in select id from public.growth_partner_sources where workspace_id is null and expires_at<=clock_timestamp()
    order by expires_at,id limit p_limit loop
    -- Never invert the normal intent -> row lock order or wait behind intake.
    if not pg_try_advisory_xact_lock(hashtextextended('partner-source:'||candidate.id::text,0)) then continue; end if;
    perform 1 from public.growth_partner_sources where id=candidate.id and workspace_id is null and expires_at<=clock_timestamp() for update skip locked;
    if not found then continue; end if;
    delete from public.growth_partner_sources where id=candidate.id and workspace_id is null and expires_at<=clock_timestamp();
    get diagnostics affected=row_count; removed:=removed+affected;
  end loop;
  return removed;
end $$;

revoke all on function public.capture_growth_partner_source(uuid,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.capture_growth_partner_source_v2(uuid,text,text,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.purge_growth_partner_sources(integer) from public,anon,authenticated,service_role;
grant execute on function public.capture_growth_partner_source_v2(uuid,text,text,text,timestamptz) to service_role;
grant execute on function public.purge_growth_partner_sources(integer) to service_role;
do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(role_name,'public.capture_growth_partner_source(uuid,text,text,text)','EXECUTE')
      or has_function_privilege(role_name,'public.capture_growth_partner_source_v2(uuid,text,text,text,timestamptz)','EXECUTE') is distinct from (role_name='service_role')
      or has_function_privilege(role_name,'public.purge_growth_partner_sources(integer)','EXECUTE') is distinct from (role_name='service_role')
      then raise exception 'partner_entry_executors_unconfirmed'; end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
