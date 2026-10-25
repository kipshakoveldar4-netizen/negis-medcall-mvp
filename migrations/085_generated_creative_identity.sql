-- Dependencies: 015 table and 082 server-only access. Local candidate only.
begin;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.ad_creative_assets'::regclass and relrowsecurity)
    or pg_catalog.has_table_privilege('anon','public.ad_creative_assets','SELECT,INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('authenticated','public.ad_creative_assets','SELECT,INSERT,UPDATE,DELETE')
    or not pg_catalog.has_table_privilege('service_role','public.ad_creative_assets','SELECT')
    or not pg_catalog.has_table_privilege('service_role','public.ad_creative_assets','INSERT')
    or not pg_catalog.has_table_privilege('service_role','public.ad_creative_assets','UPDATE')
  then raise exception 'generated_creative_requires_082_server_only_access'; end if;
end $$;

alter table public.ad_creative_assets add column if not exists generated_key text;
alter table public.ad_creative_assets add column if not exists generated_sha256 text;

-- Refuse ambiguous legacy data rather than choosing or deleting an existing file.
do $$
begin
  if exists (select 1 from public.ad_creative_assets where generated_key is not null and
    (workspace_id is null or left(generated_key,3) <> 'v1:' or length(btrim(substr(generated_key,4))) = 0
      or octet_length(generated_key) > 2051 or (generated_sha256 is not null and generated_sha256 !~ '^[0-9a-f]{64}$')))
  then raise exception 'generated_creative_identity_invalid'; end if;
  if exists (
    select 1 from public.ad_creative_assets
    where metadata->>'uploadMode' = 'ai-generated' and metadata->>'kind' = 'generated-video'
      and (workspace_id is null or jsonb_typeof(metadata->'jobId') is distinct from 'string'
        or length(btrim(metadata->>'jobId')) = 0 or octet_length(metadata->>'jobId') > 2048)
  ) then raise exception 'generated_creative_legacy_identity_invalid'; end if;
  if exists (
    select 1 from public.ad_creative_assets
    where generated_key is not null or (metadata->>'uploadMode' = 'ai-generated' and metadata->>'kind' = 'generated-video')
    group by workspace_id, coalesce(generated_key, 'v1:' || (metadata->>'jobId')) having count(*) > 1
  ) then raise exception 'generated_creative_identity_duplicates'; end if;
end $$;

update public.ad_creative_assets set generated_key = 'v1:' || (metadata->>'jobId')
where generated_key is null and metadata->>'uploadMode' = 'ai-generated' and metadata->>'kind' = 'generated-video';

create unique index if not exists ad_creative_assets_generated_key_uidx
  on public.ad_creative_assets(workspace_id, generated_key) where generated_key is not null;

do $$
declare idx record;
begin
  select i.* into idx from pg_catalog.pg_index i
    where i.indexrelid = 'public.ad_creative_assets_generated_key_uidx'::regclass;
  if not idx.indisunique or not idx.indisvalid or idx.indrelid <> 'public.ad_creative_assets'::regclass
    or idx.indnkeyatts <> 2 or idx.indnatts <> 2
    or idx.indkey::text <> (
      select string_agg(a.attnum::text, ' ' order by k.position)
      from (values ('workspace_id',1),('generated_key',2)) k(name,position)
      join pg_catalog.pg_attribute a on a.attrelid = 'public.ad_creative_assets'::regclass and a.attname = k.name)
    or pg_catalog.pg_get_expr(idx.indpred, idx.indrelid) is distinct from '(generated_key IS NOT NULL)'
  then raise exception 'generated_creative_identity_index_unconfirmed'; end if;
end $$;

create or replace function public.protect_generated_creative_identity() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.generated_key is not null then
    if row(new.id,new.workspace_id,new.generated_key,new.file_name,new.file_type,new.mime_type,
      new.file_size,new.storage_bucket,new.storage_path,new.public_url)
      is distinct from row(old.id,old.workspace_id,old.generated_key,old.file_name,old.file_type,old.mime_type,
      old.file_size,old.storage_bucket,old.storage_path,old.public_url)
      or (old.generated_sha256 is not null and new.generated_sha256 is distinct from old.generated_sha256)
    then raise exception 'generated_creative_identity_immutable'; end if;
  end if;
  if new.generated_key is null and new.metadata->>'uploadMode' = 'ai-generated' and new.metadata->>'kind' = 'generated-video' then
    if jsonb_typeof(new.metadata->'jobId') is distinct from 'string' then raise exception 'generated_creative_identity_invalid'; end if;
    new.generated_key := 'v1:' || (new.metadata->>'jobId');
  end if;
  if new.generated_key is not null and (new.workspace_id is null or left(new.generated_key,3) <> 'v1:'
    or length(btrim(substr(new.generated_key,4))) = 0 or octet_length(new.generated_key) > 2051)
    or (new.generated_sha256 is not null and (new.generated_key is null or new.generated_sha256 !~ '^[0-9a-f]{64}$'))
  then raise exception 'generated_creative_identity_invalid'; end if;
  return new;
end $$;

revoke all on function public.protect_generated_creative_identity() from public, anon, authenticated;
grant execute on function public.protect_generated_creative_identity() to service_role;
drop trigger if exists protect_generated_creative_identity on public.ad_creative_assets;
create trigger protect_generated_creative_identity before insert or update on public.ad_creative_assets
  for each row execute function public.protect_generated_creative_identity();

comment on column public.ad_creative_assets.generated_key is 'Server-only immutable generation identity; not a browser idempotency key.';
comment on column public.ad_creative_assets.generated_sha256 is 'Verified immutable generated content digest; null only for legacy files.';
commit;
