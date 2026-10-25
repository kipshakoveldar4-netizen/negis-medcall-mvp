-- Local candidate: deny-by-default browser RLS on seven legacy server tables.
-- Existing grants, policies, FORCE flags, identities and business rows stay as-is.
-- service_role must already have its reviewed server grants and BYPASSRLS.
-- This does not make service-role queries tenant-scoped; API authorization stays
-- essential. Do not apply to an unknown cloud schema without its own review.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path=pg_catalog,public;

do $$ declare relation_name text; begin
  if current_user<>'postgres' or to_regnamespace('public') is null
    or (select count(*) from pg_roles where rolname in ('service_role','anon','authenticated'))<>3
    then raise exception 'legacy_crm_rls_roles_unconfirmed'; end if;
  foreach relation_name in array array['ai_provider_settings','calls','chat_messages','clients',
    'integration_statuses','staff_users','workspace_settings'] loop
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=relation_name and c.relkind='r'
      and not c.relispartition)
      then raise exception 'legacy_crm_rls_relations_unconfirmed'; end if;
  end loop;
end $$;

lock table public.ai_provider_settings,public.calls,public.chat_messages,public.clients,
  public.integration_statuses,public.staff_users,public.workspace_settings in access exclusive mode;

do $$ declare relation_name text; relation regclass; browser_role text; privilege text; begin
  -- Recheck authority after every DDL lock wait, not an earlier snapshot.
  if not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or not has_schema_privilege('service_role','public','USAGE')
    or (select count(*) from pg_roles where rolname in ('anon','authenticated') and not rolsuper and not rolbypassrls)<>2
    then raise exception 'legacy_crm_rls_roles_unconfirmed'; end if;
  if exists(select 1 from pg_roles b cross join pg_roles privileged
    where b.rolname in ('anon','authenticated')
    and (privileged.rolsuper or privileged.rolbypassrls or privileged.rolname='postgres')
    and pg_has_role(b.oid,privileged.oid,'MEMBER'))
    then raise exception 'legacy_crm_rls_role_membership_unconfirmed'; end if;
  foreach relation_name in array array['ai_provider_settings','calls','chat_messages','clients',
    'integration_statuses','staff_users','workspace_settings'] loop
    relation:=to_regclass('public.'||relation_name);
    if not exists(select 1 from pg_class c where c.oid=relation and c.relkind='r' and not c.relispartition
      and c.relowner=to_regrole('postgres')
      and (not c.relforcerowsecurity or exists(select 1 from pg_roles owner
        where owner.oid=c.relowner and (owner.rolsuper or owner.rolbypassrls)))
      and not exists(select 1 from pg_inherits i where i.inhrelid=c.oid or i.inhparent=c.oid))
      then raise exception 'legacy_crm_rls_relations_unconfirmed'; end if;
    if not exists(select 1 from pg_attribute where attrelid=relation and attname='id'
      and attnum>0 and not attisdropped and atttypid='uuid'::regtype and attgenerated='')
      or not exists(select 1 from pg_attribute where attrelid=relation and attname='workspace_id'
      and attnum>0 and not attisdropped and atttypid='uuid'::regtype and attgenerated='')
      then raise exception 'legacy_crm_rls_columns_unconfirmed'; end if;
    foreach privilege in array array['SELECT','INSERT','UPDATE'] loop
      if not has_table_privilege('service_role',relation,privilege)
        then raise exception 'legacy_crm_rls_server_access_unconfirmed'; end if;
    end loop;
    foreach browser_role in array array['anon','authenticated'] loop
      if has_table_privilege(browser_role,relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(browser_role,relation,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'legacy_crm_rls_browser_access_unconfirmed'; end if;
      -- Never reinterpret or silently remove an unknown browser policy.
      if exists(select 1 from pg_policy p cross join lateral unnest(p.polroles) r(oid)
        where p.polrelid=relation and p.polpermissive and case when r.oid=0 then true
          else pg_has_role(browser_role,r.oid,'MEMBER') end)
        then raise exception 'legacy_crm_rls_browser_policy_unconfirmed'; end if;
    end loop;
  end loop;
end $$;

alter table public.ai_provider_settings enable row level security;
alter table public.calls enable row level security;
alter table public.chat_messages enable row level security;
alter table public.clients enable row level security;
alter table public.integration_statuses enable row level security;
alter table public.staff_users enable row level security;
alter table public.workspace_settings enable row level security;

do $$ declare relation_name text; begin
  foreach relation_name in array array['ai_provider_settings','calls','chat_messages','clients',
    'integration_statuses','staff_users','workspace_settings'] loop
    if not(select relrowsecurity from pg_class where oid=to_regclass('public.'||relation_name))
      then raise exception 'legacy_crm_rls_not_enabled'; end if;
  end loop;
end $$;
commit;
