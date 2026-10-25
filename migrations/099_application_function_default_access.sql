-- Local candidate: 023's per-schema REVOKE cannot remove global PUBLIC EXECUTE.
-- Only future routines created by the known application owner postgres change.
-- PostgreSQL defaults are global here: future postgres routines in all schemas
-- are affected. Existing routines, tables, data and other creators are untouched.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path=pg_catalog,public;

do $$ begin
  if current_user<>'postgres' or to_regnamespace('public') is null
    or not exists(select 1 from pg_roles where rolname='anon')
    or not exists(select 1 from pg_roles where rolname='authenticated')
    then raise exception 'application_function_defaults_dependencies_unconfirmed'; end if;
end $$;

alter default privileges for role postgres revoke execute on functions from public;

do $$ declare browser_role text; creator oid:=to_regrole('postgres'); begin
  if not exists(select 1 from pg_default_acl where defaclrole=creator
    and defaclnamespace=0 and defaclobjtype='f')
    then raise exception 'application_function_defaults_unconfirmed'; end if;
  foreach browser_role in array array['anon','authenticated'] loop
    -- Schema defaults add to global defaults. Do not silently remove a separate
    -- direct/inherited browser grant; refuse this database for a separate review.
    if exists(select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
      where d.defaclrole=creator and d.defaclobjtype='f'
      and d.defaclnamespace in (0,to_regnamespace('public')::oid)
      and a.privilege_type='EXECUTE'
      and case when a.grantee=0 then true
        else pg_has_role(browser_role,a.grantee,'USAGE') end)
      then raise exception 'application_function_defaults_browser_access_unconfirmed'; end if;
  end loop;
end $$;
commit;
