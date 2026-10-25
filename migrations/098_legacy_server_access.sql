-- Local fresh-source-chain candidate, not evidence about existing cloud ACLs.
-- 009/010/013/014 created these tables before explicit service-role grants.
-- Only 17 current API privileges are added; no data/default/policy/role changes.
-- RLS is enabled only for these seven server-owned tables. Existing policies
-- and FORCE flags are retained; unexpected browser/inherited access aborts.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path=pg_catalog,public;

do $$
declare relation_name text;
begin
  if not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls)
    or not exists(select 1 from pg_roles where rolname='anon')
    or not exists(select 1 from pg_roles where rolname='authenticated')
    or not has_schema_privilege('service_role','public','USAGE')
    then raise exception 'legacy_server_dependencies_unconfirmed'; end if;
  foreach relation_name in array array['content_videos','meta_ad_accounts','meta_campaign_launches',
    'meta_launch_audit_logs','release_checks','targeting_campaigns','targeting_reports'] loop
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=relation_name and c.relkind='r' and not c.relispartition)
      then raise exception 'legacy_server_dependencies_unconfirmed'; end if;
  end loop;
end $$;

lock table public.content_videos,public.meta_ad_accounts,public.meta_campaign_launches,
  public.meta_launch_audit_logs,public.release_checks,public.targeting_campaigns,public.targeting_reports
  in access exclusive mode;

do $$
declare
  required constant jsonb := $required${
    "content_videos":{"id":"uuid","workspace_id":"uuid","title":"text","niche":"text","goal":"text","duration":"text","style":"text","audience":"text","hook":"text","script":"text","voiceover":"text","cta":"text","caption":"text","hashtags":"jsonb","avatar_prompt":"text","tapnow_prompt":"text","status":"text","raw_payload":"jsonb","created_at":"timestamptz","updated_at":"timestamptz"},
    "meta_ad_accounts":{"id":"uuid","workspace_id":"uuid","meta_business_id":"text","ad_account_id":"text","page_id":"text","instagram_actor_id":"text","account_name":"text","currency":"text","timezone_name":"text","status":"text","metadata":"jsonb","created_at":"timestamptz","updated_at":"timestamptz"},
    "meta_campaign_launches":{"id":"uuid","workspace_id":"uuid","launched_by":"text","launched_by_role":"text","source_module":"text","source_id":"text","campaign_name":"text","objective":"text","status":"text","meta_campaign_id":"text","meta_adset_id":"text","meta_creative_id":"text","meta_ad_id":"text","meta_status":"text","budget_daily_minor":"integer","budget_total_minor":"integer","currency":"text","start_time":"timestamptz","end_time":"timestamptz","page_id":"text","instagram_actor_id":"text","ad_account_id":"text","payload":"jsonb","compliance":"jsonb","meta_response":"jsonb","last_error":"text","created_at":"timestamptz","updated_at":"timestamptz"},
    "meta_launch_audit_logs":{"id":"uuid","workspace_id":"uuid","launch_id":"uuid","actor_name":"text","actor_role":"text","action":"text","details":"jsonb","created_at":"timestamptz"},
    "release_checks":{"id":"uuid","workspace_id":"uuid","check_key":"text","status":"text","notes":"text","checked_at":"timestamptz","created_at":"timestamptz","updated_at":"timestamptz"},
    "targeting_campaigns":{"id":"uuid","workspace_id":"uuid","campaign_name":"text","niche":"text","city":"text","offer":"text","budget":"numeric","status":"text","raw_payload":"jsonb","created_at":"timestamptz"},
    "targeting_reports":{"id":"uuid","campaign_id":"uuid","summary":"text","metrics":"jsonb","insights":"jsonb","recommendations":"jsonb","raw_payload":"jsonb","created_at":"timestamptz"}
  }$required$::jsonb;
  relation_entry record; column_entry record; relation regclass; browser_role text; privilege text;
begin
  for relation_entry in select * from jsonb_each(required) loop
    relation:=to_regclass('public.'||relation_entry.key);
    for column_entry in select * from jsonb_each_text(relation_entry.value) loop
      if not exists(select 1 from pg_attribute a where a.attrelid=relation and a.attname=column_entry.key
        and a.attnum>0 and not a.attisdropped and a.attgenerated=''
        and a.atttypid=to_regtype(column_entry.value))
        then raise exception 'legacy_server_columns_unconfirmed'; end if;
    end loop;
    foreach browser_role in array array['anon','authenticated'] loop
      if has_table_privilege(browser_role,relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(browser_role,relation,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'legacy_server_browser_access_unconfirmed'; end if;
    end loop;
    -- Do not silently rewrite unrelated/inherited existing grants. Such a
    -- database needs a separate review, not a claim that this bootstrap fits.
    if has_table_privilege('service_role',relation,'DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege('service_role',relation,'REFERENCES')
      or (relation_entry.key in ('meta_launch_audit_logs','targeting_reports') and
        (has_table_privilege('service_role',relation,'SELECT,UPDATE')
          or has_any_column_privilege('service_role',relation,'SELECT,UPDATE')))
      then raise exception 'legacy_server_unreviewed_server_access'; end if;
    foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('service_role',relation,privilege||' WITH GRANT OPTION')
        then raise exception 'legacy_server_unreviewed_server_access'; end if;
      if privilege in ('SELECT','INSERT','UPDATE','REFERENCES') then
        if has_any_column_privilege('service_role',relation,privilege||' WITH GRANT OPTION')
          then raise exception 'legacy_server_unreviewed_server_access'; end if;
      end if;
    end loop;
  end loop;
end $$;

alter table public.content_videos enable row level security;
alter table public.meta_ad_accounts enable row level security;
alter table public.meta_campaign_launches enable row level security;
alter table public.meta_launch_audit_logs enable row level security;
alter table public.release_checks enable row level security;
alter table public.targeting_campaigns enable row level security;
alter table public.targeting_reports enable row level security;

-- GET/list + POST/returning and upsert + PATCH/returning, including the
-- existing guarded Meta binding and verified targeting-campaign ownership.
grant select,insert,update on table public.content_videos,public.meta_ad_accounts,
  public.meta_campaign_launches,public.release_checks,public.targeting_campaigns to service_role;
-- Internal append-only persistence does not request returning rows.
grant insert on table public.meta_launch_audit_logs,public.targeting_reports to service_role;

do $$
declare relation_name text; relation regclass; browser_role text; privilege text; expected boolean;
begin
  foreach relation_name in array array['content_videos','meta_ad_accounts','meta_campaign_launches',
    'meta_launch_audit_logs','release_checks','targeting_campaigns','targeting_reports'] loop
    relation:=to_regclass('public.'||relation_name);
    if not(select relrowsecurity from pg_class where oid=relation)
      then raise exception 'legacy_server_rls_unconfirmed'; end if;
    foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      expected:=privilege='INSERT' or (privilege in ('SELECT','UPDATE')
        and relation_name not in ('meta_launch_audit_logs','targeting_reports'));
      if has_table_privilege('service_role',relation,privilege) is distinct from expected
        or has_table_privilege('service_role',relation,privilege||' WITH GRANT OPTION')
        then raise exception 'legacy_server_access_unconfirmed'; end if;
      if privilege in ('SELECT','INSERT','UPDATE','REFERENCES') then
        if has_any_column_privilege('service_role',relation,privilege||' WITH GRANT OPTION')
          then raise exception 'legacy_server_access_unconfirmed'; end if;
      end if;
    end loop;
    foreach browser_role in array array['anon','authenticated'] loop
      if has_table_privilege(browser_role,relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(browser_role,relation,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'legacy_server_browser_access_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
commit;
