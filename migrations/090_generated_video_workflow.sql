-- Local candidate only. Requires 015/016/017/018, 082/085/086 and staff_users.
-- No provider call or Storage mutation is performed by this migration.
begin;

do $$ begin
  if to_regclass('public.staff_users') is null
    or to_regprocedure('public.finalize_video_job(uuid,uuid,text,timestamptz,integer,timestamptz,jsonb)') is null
    or not exists(select 1 from pg_attribute where attrelid='public.video_processing_jobs'::regclass and attname='promotion_receipt' and not attisdropped)
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls)
    or not (select relrowsecurity from pg_class where oid='public.ad_creative_assets'::regclass)
    or not (select relrowsecurity from pg_class where oid='public.video_processing_jobs'::regclass)
    or has_any_column_privilege('anon','public.ad_creative_assets','SELECT,INSERT,UPDATE,REFERENCES')
    or has_any_column_privilege('authenticated','public.ad_creative_assets','SELECT,INSERT,UPDATE,REFERENCES')
    then raise exception 'generated_video_dependencies_unconfirmed'; end if;
end $$;

create table public.generated_video_workflows(
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  generation_key text not null check(octet_length(generation_key) between 1 and 512 and generation_key=btrim(generation_key) and generation_key !~ '[[:cntrl:]]'),
  request_digest text check(request_digest ~ '^[0-9a-f]{64}$'),
  key_digest text not null check(key_digest ~ '^[0-9a-f]{64}$'),
  asset_id uuid not null unique,
  job_id uuid not null unique default gen_random_uuid(),
  file_name text not null,
  created_by_staff_user_id uuid not null,
  created_by_auth_user_id uuid not null,
  status text not null default 'reserved' check(status in ('reserved','dispatching','rendering','awaiting_upload','queued','ready','failed','cancelled')),
  reserved_until timestamptz not null default clock_timestamp()+interval '120 seconds',
  dispatch_id uuid,
  provider_job_id text check(octet_length(provider_job_id) between 1 and 512 and provider_job_id=btrim(provider_job_id) and provider_job_id !~ '[[:cntrl:]]'),
  input_size bigint check(input_size between 1 and 104857600),
  input_sha256 text check(input_sha256 ~ '^[0-9a-f]{64}$'),
  raw_bucket text,
  raw_path text,
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,generation_key),
  unique(workspace_id,provider_job_id),
  check((input_size is null and input_sha256 is null and raw_bucket is null and raw_path is null)
    or (input_size is not null and input_sha256 is not null and raw_bucket is not null and raw_path is not null)),
  check(status<>'ready' or result is not null)
);
create table public.generated_video_admission_guards(
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  revision bigint not null default 0
);
alter table public.generated_video_workflows enable row level security;
alter table public.generated_video_admission_guards enable row level security;
alter table public.ad_creative_assets add column generated_video_job_id uuid
  references public.video_processing_jobs(id) deferrable initially deferred;
alter table public.video_processing_jobs add column raw_reclamation_receipt jsonb;

create or replace function public.assert_generated_video_actor(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid)
returns void language plpgsql security invoker set search_path='' as $$ begin
  perform 1 from public.staff_users where id=p_staff_user_id and workspace_id=p_workspace_id and auth_user_id=p_auth_user_id
    and status='active' and role in ('owner','admin','marketer') for share;
  if not found then raise exception using errcode='P9004',message='generated_video_access_denied'; end if;
end $$;

create or replace function public.protect_generated_video_workflow() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
  if row(new.workspace_id,new.generation_key,new.request_digest,new.key_digest,new.asset_id,new.job_id,new.file_name,
    new.created_by_staff_user_id,new.created_by_auth_user_id,new.created_at)
    is distinct from row(old.workspace_id,old.generation_key,old.request_digest,old.key_digest,old.asset_id,old.job_id,old.file_name,
    old.created_by_staff_user_id,old.created_by_auth_user_id,old.created_at)
    or (old.dispatch_id is not null and new.dispatch_id is distinct from old.dispatch_id)
    or (old.provider_job_id is not null and new.provider_job_id is distinct from old.provider_job_id)
    or (old.input_size is not null and row(new.input_size,new.input_sha256,new.raw_bucket,new.raw_path)
      is distinct from row(old.input_size,old.input_sha256,old.raw_bucket,old.raw_path))
    or (old.result is not null and new.result is distinct from old.result)
    or (old.status in ('ready','cancelled') and new.status is distinct from old.status)
    then raise exception using errcode='P9002',message='generated_video_identity_immutable'; end if;
  return new;
end $$;
create trigger protect_generated_video_workflow before update on public.generated_video_workflows
  for each row execute function public.protect_generated_video_workflow();

create or replace function public.protect_generated_video_asset_proof() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
  if old.generated_video_job_id is not null and new.generated_video_job_id is distinct from old.generated_video_job_id
    then raise exception using errcode='P9002',message='generated_video_proof_immutable'; end if;
  return new;
end $$;
create trigger protect_generated_video_asset_proof before update on public.ad_creative_assets
  for each row execute function public.protect_generated_video_asset_proof();

create or replace function public.generated_video_envelope(o public.generated_video_workflows)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('operation',to_jsonb(o),
    'job',(select to_jsonb(j) from public.video_processing_jobs j where j.id=o.job_id and j.workspace_id=o.workspace_id),
    'asset',(select to_jsonb(a) from public.ad_creative_assets a where a.id=o.asset_id and a.workspace_id=o.workspace_id))
$$;

create or replace function public.read_generated_video_workflow(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_generation_key text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype;
begin
  perform public.assert_generated_video_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  select * into o from public.generated_video_workflows where workspace_id=p_workspace_id and generation_key=p_generation_key for share;
  if not found then return null; end if;
  return public.generated_video_envelope(o);
end $$;

create or replace function public.admit_generated_video_workflow(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_generation_key text,p_request_digest text,p_key_digest text,p_asset_id uuid,p_file_name text,p_provider_job_id text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype; at_time timestamptz; retained numeric; pending bigint; recent bigint; expected_digest text;
begin
  perform public.assert_generated_video_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  expected_digest:=encode(sha256(convert_to('["medina-generated-v1",'||to_json(p_workspace_id::text)::text||','||to_json(p_generation_key)::text||']','UTF8')),'hex');
  if p_generation_key is null or octet_length(p_generation_key) not between 1 and 512 or p_generation_key<>btrim(p_generation_key)
    or p_generation_key ~ '[[:cntrl:]]' or p_key_digest is distinct from expected_digest
    or p_asset_id is null or p_asset_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_file_name is distinct from ('negis-video-'||left(p_key_digest,20)||'.mp4')
    or (p_provider_job_id is null and (p_generation_key !~ '^v2:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$'))
    or (p_provider_job_id is not null and (p_provider_job_id is distinct from p_generation_key or p_request_digest is not null))
    then raise exception using errcode='P9001',message='generated_video_request_invalid'; end if;
  insert into public.generated_video_admission_guards(workspace_id,revision) values(p_workspace_id,1)
    on conflict(workspace_id) do update set revision=public.generated_video_admission_guards.revision+1;
  select * into o from public.generated_video_workflows where workspace_id=p_workspace_id and generation_key=p_generation_key for update;
  at_time:=clock_timestamp();
  if found then
    if row(o.request_digest,o.key_digest,o.asset_id,o.file_name) is distinct from row(p_request_digest,p_key_digest,p_asset_id,p_file_name)
      or (p_provider_job_id is not null and o.provider_job_id is distinct from p_provider_job_id)
      then raise exception using errcode='P9002',message='generated_video_request_conflict'; end if;
    if o.status='cancelled' or (o.status='reserved' and o.reserved_until<=at_time)
      then raise exception using errcode='P9003',message='generated_video_reservation_expired'; end if;
  else
    if exists(select 1 from public.ad_creative_assets where id=p_asset_id or (workspace_id=p_workspace_id and generated_key='v1:'||p_generation_key))
      then raise exception using errcode='P9002',message='generated_video_legacy_identity_conflict'; end if;
    -- Reserve the full bounded input before a paid render. Unknown dispatches
    -- remain charged until explicitly reconciled; time alone cannot free them.
    select count(*) filter(where w.status not in ('ready','cancelled') and not(w.status='reserved' and w.reserved_until<=at_time)),
      coalesce(sum(case when w.status='cancelled' or (w.status='reserved' and w.reserved_until<=at_time) then 0
        when w.status='ready' and j.raw_deleted_at is not null and j.raw_reclamation_receipt=
          '{"kind":"occupied-key-v1","size":56,"sha256":"7522cc049e7a011985341bb575c7634f6333318a191b08beb1196b7e7426c1e2"}'::jsonb
        then 56 else 104857600 end),0),
      count(*) filter(where w.created_at>at_time-interval '2 hours') into pending,retained,recent
      from public.generated_video_workflows w left join public.video_processing_jobs j on j.id=w.job_id and j.workspace_id=w.workspace_id
      where w.workspace_id=p_workspace_id;
    if pending>=2 or retained+104857600>268435456 or recent>=128
      then raise exception using errcode='P9005',message='generated_video_capacity_exhausted'; end if;
    insert into public.generated_video_workflows(workspace_id,generation_key,request_digest,key_digest,asset_id,file_name,
      created_by_staff_user_id,created_by_auth_user_id,status,provider_job_id,reserved_until)
      values(p_workspace_id,p_generation_key,p_request_digest,p_key_digest,p_asset_id,p_file_name,p_staff_user_id,p_auth_user_id,
        case when p_provider_job_id is null then 'reserved' else 'rendering' end,p_provider_job_id,at_time+interval '120 seconds') returning * into o;
  end if;
  return public.generated_video_envelope(o);
end $$;

-- Create-only writers may still be in flight after native promotion. Do not
-- free capacity on deletion: only an occupied-key fence prevents resurrection.
create or replace function public.ack_generated_video_raw_reclamation(p_job_id uuid,p_workspace_id uuid,p_claimed_by text,
  p_claimed_at timestamptz,p_attempt integer,p_fence_size bigint,p_fence_sha256 text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype; j public.video_processing_jobs%rowtype; a public.ad_creative_assets%rowtype;
  receipt jsonb:='{"kind":"occupied-key-v1","size":56,"sha256":"7522cc049e7a011985341bb575c7634f6333318a191b08beb1196b7e7426c1e2"}'::jsonb;
begin
  if p_job_id is null or p_workspace_id is null or p_claimed_by is null or p_claimed_at is null or p_attempt is null or p_attempt<1
    or p_fence_size is distinct from 56::bigint or p_fence_sha256 is distinct from '7522cc049e7a011985341bb575c7634f6333318a191b08beb1196b7e7426c1e2'
    then raise exception using errcode='P9001',message='generated_video_reclamation_invalid'; end if;
  insert into public.generated_video_admission_guards(workspace_id,revision) values(p_workspace_id,1)
    on conflict(workspace_id) do update set revision=public.generated_video_admission_guards.revision+1;
  select * into o from public.generated_video_workflows where job_id=p_job_id and workspace_id=p_workspace_id for update;
  select * into j from public.video_processing_jobs where id=p_job_id and workspace_id=p_workspace_id for update;
  if o.job_id is null or j.id is null or o.status not in ('queued','ready','failed') or j.status is distinct from 'ready'
    or j.claimed_by is distinct from p_claimed_by or j.claimed_at is distinct from p_claimed_at or j.attempts is distinct from p_attempt
    or j.asset_id is distinct from o.asset_id or o.input_size is null or j.promotion_receipt is null
    or (j.promotion_receipt->'result'->>'input_size') is distinct from o.input_size::text
    or row(j.raw_bucket,j.raw_path,j.raw_size) is distinct from row(o.raw_bucket,o.raw_path,o.input_size)
    or j.metadata->>'inputSha256' is distinct from o.input_sha256
    or o.raw_bucket='ad-creatives' or o.raw_path is distinct from (p_workspace_id::text||'/generated-raw/'||o.key_digest||'/original.mp4')
    then raise exception using errcode='P9002',message='generated_video_reclamation_refused'; end if;
  select * into a from public.ad_creative_assets where id=o.asset_id and workspace_id=p_workspace_id for share;
  if a.id is null or a.status is distinct from 'ready' or a.public_url is null or a.storage_bucket is distinct from 'ad-creatives'
    or a.storage_path is distinct from (j.promotion_receipt->'result'->>'storage_path')
    then raise exception using errcode='P9002',message='generated_video_reclamation_refused'; end if;
  if j.raw_reclamation_receipt is not null then
    if j.raw_reclamation_receipt is distinct from receipt or j.raw_deleted_at is null
      then raise exception using errcode='P9002',message='generated_video_reclamation_conflict'; end if;
  else
    update public.video_processing_jobs set raw_reclamation_receipt=receipt,raw_deleted_at=clock_timestamp(),raw_delete_error=null,
      updated_at=clock_timestamp() where id=p_job_id and workspace_id=p_workspace_id;
  end if;
  return jsonb_build_object('jobId',p_job_id,'workspaceId',p_workspace_id,'status','reclaimed','fenceSize',56,'fenceSha256',p_fence_sha256);
end $$;

create or replace function public.begin_generated_video_dispatch(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_generation_key text,p_dispatch_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype; accepted boolean:=false;
begin
  perform public.assert_generated_video_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if p_dispatch_id is null or p_dispatch_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then raise exception using errcode='P9001',message='generated_video_dispatch_invalid'; end if;
  select * into o from public.generated_video_workflows where workspace_id=p_workspace_id and generation_key=p_generation_key for update;
  if not found then raise exception using errcode='P9003',message='generated_video_unavailable'; end if;
  if o.status='reserved' then
    if o.reserved_until<=clock_timestamp() then raise exception using errcode='P9003',message='generated_video_reservation_expired'; end if;
    update public.generated_video_workflows set status='dispatching',dispatch_id=p_dispatch_id,updated_at=clock_timestamp()
      where workspace_id=p_workspace_id and generation_key=p_generation_key returning * into o;
    accepted:=true;
  elsif o.status='dispatching' and o.dispatch_id=p_dispatch_id then accepted:=true;
  end if;
  return public.generated_video_envelope(o)||jsonb_build_object('dispatchAccepted',accepted);
end $$;

create or replace function public.link_generated_video_provider(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_generation_key text,p_dispatch_id uuid,p_provider_job_id text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype;
begin
  perform public.assert_generated_video_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if p_provider_job_id is null or octet_length(p_provider_job_id) not between 1 and 512 or p_provider_job_id<>btrim(p_provider_job_id)
    or p_provider_job_id ~ '[[:cntrl:]]' then raise exception using errcode='P9001',message='generated_video_provider_invalid'; end if;
  select * into o from public.generated_video_workflows where workspace_id=p_workspace_id and generation_key=p_generation_key for update;
  if not found or p_dispatch_id is null or o.dispatch_id is distinct from p_dispatch_id
    or o.status not in ('dispatching','rendering','awaiting_upload','queued','ready','failed')
    or (o.provider_job_id is not null and o.provider_job_id is distinct from p_provider_job_id)
    then raise exception using errcode='P9002',message='generated_video_dispatch_conflict'; end if;
  if o.provider_job_id is null then
    update public.generated_video_workflows set provider_job_id=p_provider_job_id,status='rendering',updated_at=clock_timestamp()
      where workspace_id=p_workspace_id and generation_key=p_generation_key returning * into o;
  end if;
  return public.generated_video_envelope(o);
end $$;

create or replace function public.cancel_generated_video_workflow(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_generation_key text,p_dispatch_id uuid default null,p_known_failure boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype;
begin
  perform public.assert_generated_video_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  select * into o from public.generated_video_workflows where workspace_id=p_workspace_id and generation_key=p_generation_key for update;
  if not found then raise exception using errcode='P9003',message='generated_video_unavailable'; end if;
  if o.status<>'cancelled' then
    if o.input_size is not null or o.provider_job_id is not null or not(o.status='reserved'
      or (o.status='dispatching' and p_known_failure is true and p_dispatch_id is not null and o.dispatch_id=p_dispatch_id))
      then raise exception using errcode='P9002',message='generated_video_cancellation_refused'; end if;
    update public.generated_video_workflows set status='cancelled',updated_at=clock_timestamp()
      where workspace_id=p_workspace_id and generation_key=p_generation_key returning * into o;
  end if;
  return public.generated_video_envelope(o);
end $$;

create or replace function public.bind_generated_video_input(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_generation_key text,p_input_size bigint,p_input_sha256 text,p_raw_bucket text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype; a public.ad_creative_assets%rowtype; j public.video_processing_jobs%rowtype; object_path text;
begin
  perform public.assert_generated_video_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if p_input_size is null or p_input_size not between 1 and 104857600 or p_input_sha256 is null or p_input_sha256 !~ '^[0-9a-f]{64}$'
    or p_raw_bucket is null or p_raw_bucket !~ '^[a-z0-9][a-z0-9._-]{0,62}$' or p_raw_bucket='ad-creatives'
    then raise exception using errcode='P9001',message='generated_video_input_invalid'; end if;
  select * into o from public.generated_video_workflows where workspace_id=p_workspace_id and generation_key=p_generation_key for update;
  if not found or o.provider_job_id is null or o.status not in ('rendering','awaiting_upload','queued','ready','failed')
    then raise exception using errcode='P9003',message='generated_video_unavailable'; end if;
  object_path:=p_workspace_id::text||'/generated-raw/'||o.key_digest||'/original.mp4';
  if o.input_size is not null then
    if row(o.input_size,o.input_sha256,o.raw_bucket,o.raw_path) is distinct from row(p_input_size,p_input_sha256,p_raw_bucket,object_path)
      then raise exception using errcode='P9002',message='generated_video_input_conflict'; end if;
    select * into a from public.ad_creative_assets where id=o.asset_id and workspace_id=p_workspace_id;
    select * into j from public.video_processing_jobs where id=o.job_id and workspace_id=p_workspace_id;
    if a.id is null or j.id is null or a.status='archived' or j.asset_id is distinct from a.id
      then raise exception using errcode='P9003',message='generated_video_unavailable'; end if;
  else
    if o.status<>'rendering' then raise exception using errcode='P9003',message='generated_video_unavailable'; end if;
    insert into public.ad_creative_assets(id,workspace_id,uploaded_by,file_name,file_type,mime_type,file_size,storage_bucket,storage_path,public_url,status,metadata)
      values(o.asset_id,p_workspace_id,p_auth_user_id::text,o.file_name,'video','video/mp4',p_input_size,p_raw_bucket,object_path,null,'uploaded',
        jsonb_build_object('uploadMode','native-generated-pending','kind','generated-video-pending','generationKey',o.generation_key,'contentSha256',p_input_sha256));
    insert into public.video_processing_jobs(id,workspace_id,asset_id,status,progress,raw_bucket,raw_path,raw_public_url,raw_size,
      source_file_name,source_mime_type,output_bucket,optimized_bucket,metadata)
      values(o.job_id,p_workspace_id,o.asset_id,'awaiting_upload',0,p_raw_bucket,object_path,null,p_input_size,o.file_name,'video/mp4','ad-creatives','ad-creatives',
        jsonb_build_object('kind','generated-video-native','generationKey',o.generation_key,'inputSha256',p_input_sha256));
    update public.generated_video_workflows set status='awaiting_upload',input_size=p_input_size,input_sha256=p_input_sha256,raw_bucket=p_raw_bucket,
      raw_path=object_path,updated_at=clock_timestamp() where workspace_id=p_workspace_id and generation_key=p_generation_key returning * into o;
  end if;
  return public.generated_video_envelope(o);
end $$;

create or replace function public.queue_generated_video_workflow(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_generation_key text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype; j public.video_processing_jobs%rowtype; a public.ad_creative_assets%rowtype;
begin
  perform public.assert_generated_video_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  select * into o from public.generated_video_workflows where workspace_id=p_workspace_id and generation_key=p_generation_key for update;
  if not found or o.input_size is null or o.status not in ('awaiting_upload','queued','ready','failed')
    then raise exception using errcode='P9003',message='generated_video_unavailable'; end if;
  select * into j from public.video_processing_jobs where id=o.job_id and workspace_id=p_workspace_id for update;
  select * into a from public.ad_creative_assets where id=o.asset_id and workspace_id=p_workspace_id for update;
  if j.id is null or a.id is null or a.status='archived' or j.asset_id is distinct from a.id
    or row(j.raw_bucket,j.raw_path,j.raw_size,j.source_mime_type,j.source_file_name) is distinct from row(o.raw_bucket,o.raw_path,o.input_size,'video/mp4'::text,o.file_name)
    or j.metadata->>'inputSha256' is distinct from o.input_sha256
    then raise exception using errcode='P9002',message='generated_video_input_conflict'; end if;
  if o.status='awaiting_upload' then
    if j.status<>'awaiting_upload' or a.generated_key is not null or a.public_url is not null
      or row(a.storage_bucket,a.storage_path,a.file_size,a.mime_type) is distinct from row(o.raw_bucket,o.raw_path,o.input_size,'video/mp4'::text)
      then raise exception using errcode='P9002',message='generated_video_input_conflict'; end if;
    update public.video_processing_jobs set status='queued',updated_at=clock_timestamp() where id=o.job_id and workspace_id=p_workspace_id;
    update public.generated_video_workflows set status='queued',updated_at=clock_timestamp()
      where workspace_id=p_workspace_id and generation_key=p_generation_key returning * into o;
  end if;
  return public.generated_video_envelope(o);
end $$;

create or replace function public.finalize_generated_video_workflow(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_generation_key text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype; j public.video_processing_jobs%rowtype; a public.ad_creative_assets%rowtype; r jsonb; proof jsonb; origin text; bucket text; object_path text; expected jsonb;
begin
  perform public.assert_generated_video_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  select * into o from public.generated_video_workflows where workspace_id=p_workspace_id and generation_key=p_generation_key for update;
  if not found or o.status not in ('queued','ready','failed') or o.input_size is null
    then raise exception using errcode='P9003',message='generated_video_unavailable'; end if;
  select * into j from public.video_processing_jobs where id=o.job_id and workspace_id=p_workspace_id for update;
  select * into a from public.ad_creative_assets where id=o.asset_id and workspace_id=p_workspace_id for update;
  r:=j.promotion_receipt->'result'; origin:=r->>'storage_origin'; bucket:=r->>'storage_bucket'; object_path:=r->>'storage_path';
  if j.id is null or a.id is null or j.asset_id is distinct from o.asset_id or j.status is distinct from 'ready' or a.status is distinct from 'ready'
    or jsonb_typeof(r) is distinct from 'object' or (r->>'input_size') is distinct from o.input_size::text
    or j.metadata->>'inputSha256' is distinct from o.input_sha256
    or row(j.raw_bucket,j.raw_path,j.raw_size) is distinct from row(o.raw_bucket,o.raw_path,o.input_size)
    or (r->>'sha256') is null or (r->>'sha256') !~ '^[0-9a-f]{64}$' or (r->>'thumbnail_sha256') is null or (r->>'thumbnail_sha256') !~ '^[0-9a-f]{64}$'
    or (r->>'file_size') is null or (r->>'file_size') !~ '^[1-9][0-9]{0,8}$' or (r->>'file_size')::bigint>104857600
    or (r->>'thumbnail_size') is null or (r->>'thumbnail_size') !~ '^[1-9][0-9]{0,7}$' or (r->>'thumbnail_size')::bigint>10485760
    or origin is null or origin !~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'
    or bucket is distinct from 'ad-creatives' or bucket=o.raw_bucket
    or object_path is null or object_path !~ ('^optimized/'||p_workspace_id::text||'/'||o.job_id::text||'-[0-9a-f]{20}\.mp4$')
    or r->>'thumbnail_path' is distinct from (left(object_path,length(object_path)-4)||'-thumbnail.jpg')
    or r->>'public_url' is distinct from (origin||'/storage/v1/object/public/'||bucket||'/'||object_path)
    or r->>'thumbnail_public_url' is distinct from (origin||'/storage/v1/object/public/'||bucket||'/'||(r->>'thumbnail_path'))
    or row(a.file_name,a.file_type,a.mime_type,a.file_size,a.storage_bucket,a.storage_path,a.public_url)
      is distinct from row(o.file_name,'video'::text,'video/mp4'::text,(r->>'file_size')::bigint,bucket,object_path,r->>'public_url')
    or row(j.output_bucket,j.output_path,j.output_public_url,j.output_size,j.output_mime_type,j.thumbnail_path,j.thumbnail_public_url)
      is distinct from row(bucket,object_path,r->>'public_url',(r->>'file_size')::bigint,'video/mp4'::text,r->>'thumbnail_path',r->>'thumbnail_public_url')
    or row(j.optimized_bucket,j.optimized_path,j.optimized_public_url,j.output_size_bytes,j.input_size_bytes,j.thumbnail_url)
      is distinct from row(bucket,object_path,r->>'public_url',(r->>'file_size')::bigint,o.input_size,r->>'thumbnail_public_url')
    then raise exception using errcode='P9002',message='generated_video_native_proof_unconfirmed'; end if;
  expected:=jsonb_build_object('assetId',a.id,'validationJobId',j.id,'nativeValidated',true,'fileName',a.file_name,'mimeType','video/mp4',
    'fileSize',a.file_size,'storageBucket',a.storage_bucket,'storagePath',a.storage_path,'creativeUrl',a.public_url,'sha256',r->>'sha256',
    'thumbnailUrl',r->>'thumbnail_public_url','thumbnailPath',r->>'thumbnail_path','thumbnailSize',(r->>'thumbnail_size')::bigint,'thumbnailSha256',r->>'thumbnail_sha256');
  if o.status='ready' then
    if o.result is distinct from expected or a.generated_key is distinct from ('v1:'||o.generation_key)
      or a.generated_sha256 is distinct from r->>'sha256' or a.generated_video_job_id is distinct from o.job_id
      then raise exception using errcode='P9002',message='generated_video_ready_replay_refused'; end if;
  else
    if a.generated_key is not null or a.generated_sha256 is not null or a.generated_video_job_id is not null
      then raise exception using errcode='P9002',message='generated_video_identity_conflict'; end if;
    update public.ad_creative_assets set generated_key='v1:'||o.generation_key,generated_sha256=r->>'sha256',generated_video_job_id=o.job_id,
      metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('uploadMode','ai-generated','kind','generated-video','jobId',o.generation_key,'nativeValidated',true),
      updated_at=clock_timestamp() where id=o.asset_id and workspace_id=p_workspace_id;
    update public.generated_video_workflows set status='ready',result=expected,updated_at=clock_timestamp()
      where workspace_id=p_workspace_id and generation_key=p_generation_key returning * into o;
  end if;
  return public.generated_video_envelope(o);
end $$;

do $$ declare t text; names text; f record; browser_role text; begin
  foreach t in array array['generated_video_workflows','generated_video_admission_guards'] loop
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
    select string_agg(quote_ident(attname),',' order by attnum) into names from pg_attribute where attrelid=('public.'||t)::regclass and attnum>0 and not attisdropped;
    execute format('revoke select (%s),insert (%s),update (%s),references (%s) on table public.%I from public,anon,authenticated,service_role',names,names,names,names,t);
  end loop;
  revoke all on table public.ad_creative_assets from public,anon,authenticated;
  revoke select(generated_video_job_id),insert(generated_video_job_id),update(generated_video_job_id),references(generated_video_job_id)
    on table public.ad_creative_assets from public,anon,authenticated;
  revoke select(raw_reclamation_receipt),insert(raw_reclamation_receipt),update(raw_reclamation_receipt),references(raw_reclamation_receipt)
    on table public.video_processing_jobs from public,anon,authenticated;
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('assert_generated_video_actor','protect_generated_video_workflow','protect_generated_video_asset_proof','generated_video_envelope',
      'read_generated_video_workflow','admit_generated_video_workflow','begin_generated_video_dispatch','link_generated_video_provider',
      'cancel_generated_video_workflow','bind_generated_video_input','queue_generated_video_workflow','finalize_generated_video_workflow',
      'ack_generated_video_raw_reclamation') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
    foreach browser_role in array array['anon','authenticated'] loop
      if has_function_privilege(browser_role,f.signature,'EXECUTE') then raise exception 'generated_video_browser_function_access_unconfirmed'; end if;
    end loop;
  end loop;
  foreach browser_role in array array['anon','authenticated'] loop
    foreach t in array array['generated_video_workflows','generated_video_admission_guards','ad_creative_assets','video_processing_jobs'] loop
      if has_table_privilege(browser_role,('public.'||t)::regclass,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(browser_role,('public.'||t)::regclass,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'generated_video_browser_table_access_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
grant select,insert,update,delete on table public.generated_video_workflows to service_role;
grant select,insert,update,delete on table public.generated_video_admission_guards to service_role;
comment on table public.generated_video_workflows is 'Server-only native video admission and dispatch replay journal. Unknown paid dispatches require explicit reconciliation, never automatic rerender.';
comment on column public.ad_creative_assets.generated_video_job_id is 'Immutable native promotion proof for the generated workflow; never a browser-selected job.';
comment on column public.video_processing_jobs.raw_reclamation_receipt is 'Generated inputs only: verified occupied-key fence, not physical object/version deletion. Retain the fence while late create-only writes can exist.';
commit;
