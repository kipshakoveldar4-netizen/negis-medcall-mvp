-- Local candidate only: 015 + 082 + 085 and the existing Supabase Storage schema.
-- This is the quarantine/immutable-receipt foundation, not API finalization.
begin;
do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null
    or not (select relrowsecurity from pg_class where oid='storage.objects'::regclass)
    or not (select relrowsecurity from pg_class where oid='public.ad_creative_assets'::regclass)
    or not exists(select 1 from pg_attribute where attrelid='public.ad_creative_assets'::regclass and attname='generated_key' and not attisdropped)
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls)
    or has_any_column_privilege('anon','public.ad_creative_assets','SELECT,INSERT,UPDATE,REFERENCES')
    or has_any_column_privilege('authenticated','public.ad_creative_assets','SELECT,INSERT,UPDATE,REFERENCES')
    then raise exception 'creative_staging_dependencies_unconfirmed'; end if;
end $$;

lock table storage.buckets in share row exclusive mode;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('ad-creatives-staging','ad-creatives-staging',false,104857600,
  array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm']) on conflict(id) do nothing;
do $$
declare b record; types text[] := array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'];
begin
  select * into b from storage.buckets where id='ad-creatives-staging' for update;
  if not found or b.name is distinct from 'ad-creatives-staging' or b.public is distinct from false
    or b.file_size_limit is distinct from 104857600::bigint or b.allowed_mime_types is null
    or not(b.allowed_mime_types @> types and b.allowed_mime_types <@ types)
    then raise exception 'creative_staging_bucket_unconfirmed'; end if;
end $$;

-- A restrictive guard also defeats unrelated broad permissive Storage policies.
-- It changes neither their definitions nor visibility in other buckets.
drop policy if exists medina_staged_creatives_browser_guard on storage.objects;
create policy medina_staged_creatives_browser_guard on storage.objects as restrictive
  for all to anon,authenticated using(bucket_id is distinct from 'ad-creatives-staging') with check(bucket_id is distinct from 'ad-creatives-staging');

alter table public.ad_creative_assets add column if not exists verified_upload_key uuid;
alter table public.ad_creative_assets add column if not exists verified_upload_sha256 text;
alter table public.ad_creative_assets add column if not exists verified_upload_actor_id uuid;

create or replace function public.protect_verified_creative_upload() returns trigger
language plpgsql security invoker set search_path='' as $$
declare extension text; kind text; max_bytes bigint; origin text;
begin
  if tg_op='UPDATE' and old.verified_upload_key is not null then
    if row(new.id,new.workspace_id,new.verified_upload_key,new.verified_upload_sha256,new.verified_upload_actor_id,
      new.file_name,new.file_type,new.mime_type,new.file_size,new.storage_bucket,new.storage_path,new.public_url)
      is distinct from row(old.id,old.workspace_id,old.verified_upload_key,old.verified_upload_sha256,old.verified_upload_actor_id,
      old.file_name,old.file_type,old.mime_type,old.file_size,old.storage_bucket,old.storage_path,old.public_url)
      then raise exception 'verified_creative_upload_immutable'; end if;
  end if;
  if new.verified_upload_key is null and new.verified_upload_sha256 is null and new.verified_upload_actor_id is null then return new; end if;
  if new.verified_upload_key is null or new.verified_upload_sha256 is null or new.verified_upload_actor_id is null
    or new.workspace_id is null or new.id is distinct from new.verified_upload_key or new.generated_key is not null
    or new.verified_upload_sha256 !~ '^[0-9a-f]{64}$' or new.file_name is null or octet_length(new.file_name)>255
    or new.file_name ~ '[[:cntrl:]/]' or strpos(new.file_name,chr(92))>0
    then raise exception 'verified_creative_upload_invalid'; end if;
  extension := lower(regexp_replace(new.file_name,'^.*\.',''));
  kind := case when new.mime_type in ('image/jpeg','image/png','image/webp') then 'image'
    when new.mime_type in ('video/mp4','video/quicktime','video/webm') then 'video' end;
  max_bytes := case when kind='image' then 10485760 when kind='video' then 104857600 end;
  origin := split_part(new.public_url,'/storage/v1/object/public/ad-creatives/',1);
  if kind is null or new.file_type is distinct from kind or new.file_size is null or new.file_size<1 or new.file_size>max_bytes
    or not(case new.mime_type when 'image/jpeg' then extension in ('jpg','jpeg') when 'image/png' then extension='png'
      when 'image/webp' then extension='webp' when 'video/mp4' then extension='mp4' when 'video/quicktime' then extension='mov'
      when 'video/webm' then extension='webm' else false end)
    or new.storage_bucket is distinct from 'ad-creatives' or new.storage_path is distinct from
      (new.workspace_id::text || '/verified/' || new.verified_upload_key::text || '/' || new.verified_upload_sha256 || '.' || extension)
    or origin is null or origin !~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'
    or new.public_url is distinct from (origin || '/storage/v1/object/public/ad-creatives/' || new.storage_path)
    then raise exception 'verified_creative_upload_invalid'; end if;
  return new;
end $$;
revoke all on function public.protect_verified_creative_upload() from public,anon,authenticated;
grant execute on function public.protect_verified_creative_upload() to service_role;
drop trigger if exists protect_verified_creative_upload on public.ad_creative_assets;
create trigger protect_verified_creative_upload before insert or update on public.ad_creative_assets
  for each row execute function public.protect_verified_creative_upload();
comment on column public.ad_creative_assets.verified_upload_key is 'Immutable server verified upload identity; never a browser-provided assertion.';
commit;
