-- Companion to 021. Keep existing foundation history unchanged.
-- Insights are served by authorized APIs, never by browser Data API clients.
begin;

do $dependency$
begin
  if to_regclass('public.meta_campaign_insights') is null
    or to_regclass('public.meta_insights_sync_runs') is null then
    raise exception using errcode = 'P7901', message = 'meta_insights_access_requires_021';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_roles where rolname = 'authenticated')
    or not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls) then
    raise exception using errcode = 'P7902', message = 'meta_insights_access_requires_server_roles';
  end if;
end
$dependency$;

lock table public.meta_campaign_insights, public.meta_insights_sync_runs in share row exclusive mode;

alter table public.meta_campaign_insights enable row level security;
alter table public.meta_insights_sync_runs enable row level security;
revoke all on table public.meta_campaign_insights, public.meta_insights_sync_runs from public, anon, authenticated;

-- Table REVOKE alone does not remove legacy per-column grants.
do $column_access$
declare
  target text;
  columns text;
begin
  foreach target in array array['meta_campaign_insights', 'meta_insights_sync_runs'] loop
    select string_agg(quote_ident(attname), ',' order by attnum) into columns
    from pg_attribute
    where attrelid = format('public.%I', target)::regclass and attnum > 0 and not attisdropped;
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table public.%I from public, anon, authenticated',
      columns, columns, columns, columns, target);
  end loop;
end
$column_access$;

grant select, insert, update, delete on table public.meta_campaign_insights, public.meta_insights_sync_runs to service_role;

do $contract$
declare
  target text;
  browser_role text;
begin
  foreach target in array array['meta_campaign_insights', 'meta_insights_sync_runs'] loop
    if not (select relrowsecurity from pg_class where oid = format('public.%I', target)::regclass) then
      raise exception using errcode = 'P7903', message = 'meta_insights_access_contract_mismatch';
    end if;
    foreach browser_role in array array['anon', 'authenticated'] loop
      if has_table_privilege(browser_role, format('public.%I', target), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(browser_role, format('public.%I', target), 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception using errcode = 'P7903', message = 'meta_insights_access_contract_mismatch';
      end if;
    end loop;
  end loop;
end
$contract$;

commit;
