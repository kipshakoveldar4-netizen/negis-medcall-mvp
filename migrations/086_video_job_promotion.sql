-- Local candidate only. Dependencies: 015/016/017/018, 082 and 085.
begin;
do $$
begin
  if to_regclass('public.video_processing_jobs') is null
    or not exists (select 1 from pg_attribute where attrelid='public.ad_creative_assets'::regclass and attname='generated_key' and not attisdropped)
    or not exists (select 1 from pg_roles where rolname='service_role' and rolbypassrls)
    or not (select relrowsecurity from pg_class where oid='public.ad_creative_assets'::regclass)
    or has_table_privilege('anon','public.ad_creative_assets','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','public.ad_creative_assets','SELECT,INSERT,UPDATE,DELETE')
    or has_any_column_privilege('anon','public.ad_creative_assets','SELECT,INSERT,UPDATE,REFERENCES')
    or has_any_column_privilege('authenticated','public.ad_creative_assets','SELECT,INSERT,UPDATE,REFERENCES')
  then raise exception 'video_promotion_dependencies_unconfirmed'; end if;
end $$;

lock table public.video_processing_jobs in share row exclusive mode;
alter table public.video_processing_jobs add column if not exists promotion_receipt jsonb;
alter table public.video_processing_jobs enable row level security;
revoke all on table public.video_processing_jobs from public, anon, authenticated;
do $$
declare names text;
begin
  select string_agg(quote_ident(attname),',' order by attnum) into names from pg_attribute
    where attrelid='public.video_processing_jobs'::regclass and attnum>0 and not attisdropped;
  execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table public.video_processing_jobs from public, anon, authenticated',names,names,names,names);
end $$;
grant select,insert,update,delete on table public.video_processing_jobs to service_role;

create or replace function public.finalize_video_job(
  p_job_id uuid, p_workspace_id uuid, p_claimed_by text, p_claimed_at timestamptz, p_attempt integer,
  p_asset_version timestamptz, p_result jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  j public.video_processing_jobs%rowtype;
  a public.ad_creative_assets%rowtype;
  v_bucket text;
  origin text;
  object_path text;
  thumb_path text;
  v_bytes bigint;
  input_size bigint;
  thumb_size bigint;
  receipt jsonb;
  at_time timestamptz := clock_timestamp();
begin
  select * into j from public.video_processing_jobs where id=p_job_id and workspace_id=p_workspace_id for update;
  if not found or j.claimed_by is distinct from p_claimed_by or j.claimed_at is distinct from p_claimed_at
    or j.attempts is distinct from p_attempt or p_claimed_by is null or p_claimed_at is null or p_attempt is null or p_attempt<1
    then raise exception 'video_promotion_claim_refused'; end if;
  if jsonb_typeof(p_result) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_result) k where k not in
    ('storage_origin','storage_bucket','storage_path','public_url','file_size','sha256','thumbnail_path','thumbnail_public_url','thumbnail_size','thumbnail_sha256','input_size'))
    then raise exception 'video_promotion_result_invalid'; end if;
  foreach origin in array array['storage_origin','storage_bucket','storage_path','public_url','sha256','thumbnail_path','thumbnail_public_url','thumbnail_sha256'] loop
    if jsonb_typeof(p_result->origin) is distinct from 'string' then raise exception 'video_promotion_result_invalid'; end if;
  end loop;
  if jsonb_typeof(p_result->'file_size') is distinct from 'number' or (p_result->>'file_size') !~ '^[1-9][0-9]{0,8}$'
    or jsonb_typeof(p_result->'input_size') is distinct from 'number' or (p_result->>'input_size') !~ '^[1-9][0-9]{0,8}$'
    or jsonb_typeof(p_result->'thumbnail_size') is distinct from 'number' or (p_result->>'thumbnail_size') !~ '^[1-9][0-9]{0,8}$'
    then raise exception 'video_promotion_result_invalid'; end if;
  v_bytes := (p_result->>'file_size')::bigint;
  input_size := (p_result->>'input_size')::bigint;
  thumb_size := (p_result->>'thumbnail_size')::bigint;
  v_bucket := coalesce(nullif(j.optimized_bucket,''),nullif(j.output_bucket,''),'ad-creatives');
  origin := p_result->>'storage_origin'; object_path := p_result->>'storage_path'; thumb_path := p_result->>'thumbnail_path';
  if input_size is distinct from j.raw_size or input_size>524288000 or v_bytes>104857600 or thumb_size>10485760
    or j.raw_bucket is null or j.raw_bucket !~ '^[a-z0-9][a-z0-9._-]{0,62}$'
    or j.raw_path is null or length(j.raw_path)>1024 or left(j.raw_path,37) is distinct from (p_workspace_id::text || '/')
    or j.raw_path ~ '[[:cntrl:]%]' or strpos(j.raw_path,chr(92))>0
    or exists(select 1 from unnest(string_to_array(j.raw_path,'/')) s where s in ('','.','..'))
    or v_bucket !~ '^[a-z0-9][a-z0-9._-]{0,62}$' or v_bucket is not distinct from j.raw_bucket
    or (p_result->>'storage_bucket') is distinct from v_bucket
    or origin !~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'
    or object_path !~ ('^optimized/' || p_workspace_id::text || '/' || p_job_id::text || '-[0-9a-f]{20}\.mp4$')
    or thumb_path is distinct from (left(object_path,length(object_path)-4) || '-thumbnail.jpg')
    or (p_result->>'public_url') is distinct from (origin || '/storage/v1/object/public/' || v_bucket || '/' || object_path)
    or (p_result->>'thumbnail_public_url') is distinct from (origin || '/storage/v1/object/public/' || v_bucket || '/' || thumb_path)
    or (p_result->>'sha256') !~ '^[0-9a-f]{64}$' or (p_result->>'thumbnail_sha256') !~ '^[0-9a-f]{64}$'
    then raise exception 'video_promotion_result_invalid'; end if;
  receipt := jsonb_build_object('asset_version',p_asset_version,'result',p_result);
  if j.asset_id is not null then
    select * into a from public.ad_creative_assets where id=j.asset_id and workspace_id=p_workspace_id for update;
    if not found then raise exception 'video_promotion_asset_refused'; end if;
  end if;
  if j.status='ready' then
    if j.promotion_receipt is distinct from receipt or (j.asset_id is not null and
      (a.storage_bucket is distinct from v_bucket or a.storage_path is distinct from object_path
        or a.public_url is distinct from p_result->>'public_url' or a.mime_type is distinct from 'video/mp4'
        or a.file_size is distinct from v_bytes)) then raise exception 'video_promotion_replay_refused'; end if;
  else
    if j.status<>'uploading' then raise exception 'video_promotion_claim_refused'; end if;
    if j.asset_id is not null then
      if p_asset_version is null or a.updated_at is distinct from p_asset_version or a.generated_key is not null
        or (a.metadata->>'uploadMode'='ai-generated' and a.metadata->>'kind'='generated-video')
        or a.storage_bucket is distinct from j.raw_bucket or a.storage_path is distinct from j.raw_path
        or a.mime_type is distinct from j.source_mime_type or a.file_type is distinct from 'video' or a.file_size is distinct from input_size
        then raise exception 'video_promotion_asset_refused'; end if;
      update public.ad_creative_assets set storage_bucket=v_bucket,storage_path=object_path,
        public_url=p_result->>'public_url',mime_type='video/mp4',file_size=v_bytes,file_type='video',
        file_name=regexp_replace(coalesce(j.source_file_name,'video'),'\.[^.]*$','') || '.mp4',status='ready',updated_at=at_time,
        metadata=coalesce(a.metadata,'{}'::jsonb) || jsonb_build_object('optimized',true,'optimizationStatus','ready',
          'thumbnailUrl',p_result->>'thumbnail_public_url','thumbnailSource','worker','thumbnailMimeType','image/jpeg',
          'thumbnailGeneratedAt',at_time,'inputSizeBytes',input_size,'outputSizeBytes',v_bytes,
          'compressionRatio',round(v_bytes::numeric/input_size,3),'contentSha256',p_result->>'sha256')
        where id=j.asset_id and workspace_id=p_workspace_id;
    end if;
    update public.video_processing_jobs set status='ready',progress=100,output_bucket=v_bucket,
      output_path=object_path,output_public_url=p_result->>'public_url',output_size=v_bytes,
      optimized_bucket=v_bucket,optimized_path=object_path,optimized_public_url=p_result->>'public_url',
      input_mime_type=j.source_mime_type,output_mime_type='video/mp4',input_size_bytes=input_size,output_size_bytes=v_bytes,
      compression_ratio=round(v_bytes::numeric/input_size,3),thumbnail_path=thumb_path,thumbnail_public_url=p_result->>'thumbnail_public_url',
      thumbnail_url=p_result->>'thumbnail_public_url',thumbnail_source='worker',completed_at=at_time,
      raw_deleted_at=null,raw_delete_error=null,error=null,error_message=null,updated_at=at_time,promotion_receipt=receipt
      where id=p_job_id and workspace_id=p_workspace_id;
  end if;
  return jsonb_build_object('jobId',j.id,'workspaceId',j.workspace_id,'assetId',j.asset_id,'status','ready','promotion',p_result);
end $$;
revoke all on function public.finalize_video_job(uuid,uuid,text,timestamptz,integer,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_video_job(uuid,uuid,text,timestamptz,integer,timestamptz,jsonb) to service_role;
do $$
declare browser_role text;
begin
  foreach browser_role in array array['anon','authenticated'] loop
    if has_table_privilege(browser_role,'public.video_processing_jobs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(browser_role,'public.video_processing_jobs','SELECT,INSERT,UPDATE,REFERENCES')
      or has_function_privilege(browser_role,'public.finalize_video_job(uuid,uuid,text,timestamptz,integer,timestamptz,jsonb)','EXECUTE')
      then raise exception 'video_promotion_browser_access_unconfirmed'; end if;
  end loop;
end $$;
commit;
