-- Local candidate only. Requires 019; accepts the existing 080 seed function.
-- No stage/source rows, workspace settings, memberships or business rules change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path=pg_catalog,public;

do $$
declare relation_name text;
begin
  foreach relation_name in array array['lead_stages','lead_sources'] loop
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=relation_name and c.relkind='r' and not c.relispartition)
      then raise exception 'lead_taxonomy_dependencies_unconfirmed'; end if;
  end loop;
  if to_regprocedure('public.seed_default_lead_taxonomy(uuid)') is null
    or to_regprocedure('public.seed_default_lead_taxonomy_after_workspace_insert()') is null
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls)
    or not has_schema_privilege('service_role','public','USAGE')
    then raise exception 'lead_taxonomy_dependencies_unconfirmed'; end if;
end $$;

lock table public.lead_stages,public.lead_sources in access exclusive mode;
alter table public.lead_stages enable row level security;
alter table public.lead_sources enable row level security;
revoke all on table public.lead_stages,public.lead_sources from public,anon,authenticated;

-- Table REVOKE does not remove column ACLs, including inherited/default grants.
do $$
declare relation_name text; columns text;
begin
  foreach relation_name in array array['lead_stages','lead_sources'] loop
    select string_agg(quote_ident(attname),',' order by attnum) into columns from pg_attribute
      where attrelid=('public.'||relation_name)::regclass and attnum>0 and not attisdropped;
    execute format('revoke select (%s),insert (%s),update (%s),references (%s) on table public.%I from public,anon,authenticated',
      columns,columns,columns,columns,relation_name);
  end loop;
end $$;

grant select,insert,update,delete on table public.lead_stages,public.lead_sources to service_role;
revoke all on function public.seed_default_lead_taxonomy(uuid),public.seed_default_lead_taxonomy_after_workspace_insert()
  from public,anon,authenticated;
grant execute on function public.seed_default_lead_taxonomy(uuid),public.seed_default_lead_taxonomy_after_workspace_insert() to service_role;

-- Refuse inherited access that this narrowly scoped migration cannot revoke.
do $$
declare browser_role text; relation_name text; signature regprocedure;
begin
  foreach browser_role in array array['anon','authenticated'] loop
    foreach relation_name in array array['lead_stages','lead_sources'] loop
      if has_table_privilege(browser_role,('public.'||relation_name)::regclass,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(browser_role,('public.'||relation_name)::regclass,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'lead_taxonomy_browser_access_unconfirmed'; end if;
    end loop;
    foreach signature in array array['public.seed_default_lead_taxonomy(uuid)'::regprocedure,
      'public.seed_default_lead_taxonomy_after_workspace_insert()'::regprocedure] loop
      if has_function_privilege(browser_role,signature,'EXECUTE')
        then raise exception 'lead_taxonomy_browser_function_access_unconfirmed'; end if;
    end loop;
  end loop;
  foreach relation_name in array array['lead_stages','lead_sources'] loop
    if not(select relrowsecurity from pg_class where oid=('public.'||relation_name)::regclass)
      or not has_table_privilege('service_role',('public.'||relation_name)::regclass,'SELECT')
      or not has_table_privilege('service_role',('public.'||relation_name)::regclass,'INSERT')
      or not has_table_privilege('service_role',('public.'||relation_name)::regclass,'UPDATE')
      or not has_table_privilege('service_role',('public.'||relation_name)::regclass,'DELETE')
      then raise exception 'lead_taxonomy_server_access_unconfirmed'; end if;
  end loop;
end $$;
commit;
