-- Companion to the table/index foundation in 015. Does not change Storage.
begin;

do $dependency$
begin
  if to_regclass('public.ad_creative_assets') is null then
    raise exception using errcode = 'P8201', message = 'ad_creative_access_requires_015_table';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_roles where rolname = 'authenticated')
    or not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls) then
    raise exception using errcode = 'P8202', message = 'ad_creative_access_requires_server_roles';
  end if;
end
$dependency$;

lock table public.ad_creative_assets in share row exclusive mode;
alter table public.ad_creative_assets enable row level security;
revoke all on table public.ad_creative_assets from public, anon, authenticated;

-- Remove legacy per-column grants as well as table grants.
do $columns$
declare
  names text;
begin
  select string_agg(quote_ident(attname), ',' order by attnum) into names
  from pg_attribute
  where attrelid = 'public.ad_creative_assets'::regclass and attnum > 0 and not attisdropped;
  execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table public.ad_creative_assets from public, anon, authenticated',
    names, names, names, names);
end
$columns$;

grant select, insert, update, delete on table public.ad_creative_assets to service_role;

do $contract$
declare
  browser_role text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.ad_creative_assets'::regclass) then
    raise exception using errcode = 'P8203', message = 'ad_creative_access_contract_mismatch';
  end if;
  foreach browser_role in array array['anon', 'authenticated'] loop
    if has_table_privilege(browser_role, 'public.ad_creative_assets', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(browser_role, 'public.ad_creative_assets', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception using errcode = 'P8203', message = 'ad_creative_access_contract_mismatch';
    end if;
  end loop;
end
$contract$;

commit;
