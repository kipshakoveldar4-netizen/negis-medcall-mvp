-- Local candidate only. Requires 015/082/085/087 and staff_users.
begin;
do $$ begin
  if to_regclass('public.staff_users') is null
    or not exists(select 1 from pg_attribute where attrelid='public.ad_creative_assets'::regclass and attname='verified_upload_key' and not attisdropped)
    or not (select relrowsecurity from pg_class where oid='public.ad_creative_assets'::regclass)
    or has_any_column_privilege('anon','public.ad_creative_assets','SELECT,INSERT,UPDATE,REFERENCES')
    or has_any_column_privilege('authenticated','public.ad_creative_assets','SELECT,INSERT,UPDATE,REFERENCES')
    then raise exception 'creative_upload_workflow_dependencies_unconfirmed'; end if;
end $$;

create table if not exists public.creative_upload_operations(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  staff_user_id uuid not null,
  auth_user_id uuid not null,
  request_key uuid not null,
  file_name text not null,
  mime_type text not null check(mime_type in ('image/jpeg','image/png','image/webp')),
  file_size bigint not null check(file_size between 1 and 10485760),
  source text not null check(source in ('signed','inline')),
  issued_at bigint not null,
  expires_at bigint not null check(expires_at=issued_at+7200000),
  status text not null default 'reserved' check(status in ('reserved','finalized','rejected')),
  asset_id uuid references public.ad_creative_assets(id) on delete set null,
  result jsonb,
  error_code text,
  raw_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,auth_user_id,request_key)
);
alter table public.creative_upload_operations enable row level security;
revoke all on table public.creative_upload_operations from public,anon,authenticated;
do $$ declare names text; begin
  select string_agg(quote_ident(attname),',' order by attnum) into names from pg_attribute
    where attrelid='public.creative_upload_operations'::regclass and attnum>0 and not attisdropped;
  execute format('revoke select (%s),insert (%s),update (%s),references (%s) on table public.creative_upload_operations from public,anon,authenticated',names,names,names,names);
end $$;
grant select,insert,update,delete on table public.creative_upload_operations to service_role;

-- A real technical-row write makes stale RR/Serializable snapshots abort;
-- an advisory lock alone serializes execution but cannot refresh their view.
create table if not exists public.creative_upload_admission_guards(
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  revision bigint not null default 0
);
alter table public.creative_upload_admission_guards enable row level security;
revoke all on table public.creative_upload_admission_guards from public,anon,authenticated;
revoke select(workspace_id,revision),insert(workspace_id,revision),update(workspace_id,revision),references(workspace_id,revision)
  on table public.creative_upload_admission_guards from public,anon,authenticated;
grant select,insert,update,delete on table public.creative_upload_admission_guards to service_role;

create or replace function public.assert_creative_upload_actor(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid)
returns void language plpgsql security invoker set search_path='' as $$ begin
  perform 1 from public.staff_users where id=p_staff_user_id and workspace_id=p_workspace_id and auth_user_id=p_auth_user_id
    and status='active' and role in ('owner','admin','marketer') for share;
  if not found then raise exception using errcode='P8804',message='creative_upload_access_denied'; end if;
end $$;

create or replace function public.protect_creative_upload_operation() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
  if row(new.id,new.workspace_id,new.staff_user_id,new.auth_user_id,new.request_key,new.file_name,new.mime_type,new.file_size,new.source,new.issued_at,new.expires_at)
    is distinct from row(old.id,old.workspace_id,old.staff_user_id,old.auth_user_id,old.request_key,old.file_name,old.mime_type,old.file_size,old.source,old.issued_at,old.expires_at)
    or (old.status<>'reserved' and new.status is distinct from old.status)
    or (old.result is not null and new.result is distinct from old.result)
    or (old.raw_deleted_at is not null and new.raw_deleted_at is distinct from old.raw_deleted_at)
    then raise exception 'creative_upload_operation_immutable'; end if;
  return new;
end $$;
drop trigger if exists protect_creative_upload_operation on public.creative_upload_operations;
create trigger protect_creative_upload_operation before update on public.creative_upload_operations
  for each row execute function public.protect_creative_upload_operation();

create or replace function public.creative_upload_ticket(o public.creative_upload_operations)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('v',1,'id',o.id,'workspaceId',o.workspace_id,'userId',o.auth_user_id,'staffUserId',o.staff_user_id,
    'fileName',o.file_name,'mimeType',o.mime_type,'fileSize',o.file_size,'issuedAt',o.issued_at,'expiresAt',o.expires_at)
$$;

create or replace function public.reserve_creative_upload(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_request_key uuid,p_file_name text,p_mime_type text,p_file_size bigint,p_source text default 'signed')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.creative_upload_operations%rowtype; clock_ms bigint; extension text; pending bigint; retained_bytes numeric; recent bigint;
begin
  perform public.assert_creative_upload_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if p_request_key is null or p_request_key::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_file_name is null or octet_length(p_file_name)>255 or p_file_name ~ '[[:cntrl:]/]' or strpos(p_file_name,chr(92))>0
    or p_mime_type is null or p_mime_type not in ('image/jpeg','image/png','image/webp')
    or p_file_size is null or p_file_size<1 or p_file_size>10485760 or p_source is null or p_source not in ('signed','inline')
    then raise exception using errcode='P8801',message='creative_upload_invalid'; end if;
  extension:=lower(regexp_replace(p_file_name,'^.*\.',''));
  if not(case p_mime_type when 'image/jpeg' then extension in ('jpg','jpeg') when 'image/png' then extension='png' when 'image/webp' then extension='webp' else false end)
    then raise exception using errcode='P8801',message='creative_upload_invalid'; end if;
  insert into public.creative_upload_admission_guards(workspace_id,revision) values(p_workspace_id,1)
    on conflict(workspace_id) do update set revision=public.creative_upload_admission_guards.revision+1;
  clock_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  select * into o from public.creative_upload_operations where workspace_id=p_workspace_id and auth_user_id=p_auth_user_id and request_key=p_request_key for update;
  if found then
    if row(o.staff_user_id,o.file_name,o.mime_type,o.file_size,o.source) is distinct from row(p_staff_user_id,p_file_name,p_mime_type,p_file_size,p_source)
      then raise exception using errcode='P8802',message='creative_upload_request_conflict'; end if;
    if o.expires_at<=clock_ms or o.status='rejected' then raise exception using errcode='P8803',message='creative_upload_unavailable'; end if;
  else
    -- Signed Storage tokens constrain the object key, not the claimed length.
    -- Reserve the entire bucket maximum until deletion is acknowledged.
    select count(*) filter(where status='reserved' and expires_at>clock_ms),
      coalesce(sum(case when source='signed' and raw_deleted_at is null then 104857600 else 0 end),0), count(*) filter(where issued_at>clock_ms-7200000)
      into pending,retained_bytes,recent from public.creative_upload_operations where workspace_id=p_workspace_id;
    -- Technical abuse/resource bounds, not subscription or payment allowances.
    if pending>=4 or recent>=128 or retained_bytes+(case when p_source='signed' then 104857600 else 0 end)>268435456
      then raise exception using errcode='P8805',message='creative_upload_capacity_exhausted'; end if;
    insert into public.creative_upload_operations(workspace_id,staff_user_id,auth_user_id,request_key,file_name,mime_type,file_size,source,issued_at,expires_at,raw_deleted_at)
      values(p_workspace_id,p_staff_user_id,p_auth_user_id,p_request_key,p_file_name,p_mime_type,p_file_size,p_source,clock_ms,clock_ms+7200000,
        case when p_source='inline' then clock_timestamp() else null end) returning * into o;
  end if;
  return jsonb_build_object('ticket',public.creative_upload_ticket(o),'requestKey',o.request_key,'status',o.status);
end $$;

create or replace function public.finalize_creative_image_upload(p_operation_id uuid,p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_result jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.creative_upload_operations%rowtype; a public.ad_creative_assets%rowtype; field text; replayed boolean;
begin
  perform public.assert_creative_upload_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  select * into o from public.creative_upload_operations where id=p_operation_id and workspace_id=p_workspace_id
    and staff_user_id=p_staff_user_id and auth_user_id=p_auth_user_id for update;
  if not found then raise exception using errcode='P8803',message='creative_upload_unavailable'; end if;
  if jsonb_typeof(p_result) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_result) k
    where k not in ('file_name','file_type','mime_type','file_size','storage_bucket','storage_path','public_url','sha256'))
    then raise exception using errcode='P8801',message='creative_upload_result_invalid'; end if;
  foreach field in array array['file_name','file_type','mime_type','storage_bucket','storage_path','public_url','sha256'] loop
    if jsonb_typeof(p_result->field) is distinct from 'string' then raise exception using errcode='P8801',message='creative_upload_result_invalid'; end if;
  end loop;
  if jsonb_typeof(p_result->'file_size') is distinct from 'number' or (p_result->>'file_size') !~ '^[1-9][0-9]{0,7}$'
    then raise exception using errcode='P8801',message='creative_upload_result_invalid'; end if;
  if (p_result->>'file_size')::bigint>10485760 or p_result->>'file_name' is distinct from o.file_name
    or p_result->>'file_type' is distinct from 'image' or p_result->>'mime_type' is distinct from o.mime_type
    then raise exception using errcode='P8801',message='creative_upload_result_invalid'; end if;
  replayed:=o.status='finalized';
  if replayed then
    if o.result is distinct from p_result then raise exception using errcode='P8802',message='creative_upload_result_conflict'; end if;
    select * into a from public.ad_creative_assets where id=o.asset_id and workspace_id=p_workspace_id for update;
    if not found or a.verified_upload_key is distinct from o.id or a.verified_upload_actor_id is distinct from p_auth_user_id
      or a.verified_upload_sha256 is distinct from (p_result->>'sha256') or a.status not in ('uploaded','ready')
      or row(a.file_name,a.file_type,a.mime_type,a.file_size,a.storage_bucket,a.storage_path,a.public_url) is distinct from
        row(p_result->>'file_name',p_result->>'file_type',p_result->>'mime_type',(p_result->>'file_size')::bigint,p_result->>'storage_bucket',p_result->>'storage_path',p_result->>'public_url')
      then raise exception using errcode='P8803',message='creative_upload_unavailable'; end if;
  else
    if o.status<>'reserved' or o.expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint
      then raise exception using errcode='P8803',message='creative_upload_unavailable'; end if;
    insert into public.ad_creative_assets(id,workspace_id,uploaded_by,file_name,file_type,mime_type,file_size,storage_bucket,storage_path,public_url,status,metadata,
      verified_upload_key,verified_upload_sha256,verified_upload_actor_id)
      values(o.id,p_workspace_id,p_auth_user_id::text,o.file_name,'image',o.mime_type,(p_result->>'file_size')::bigint,
        p_result->>'storage_bucket',p_result->>'storage_path',p_result->>'public_url','uploaded',
        jsonb_build_object('uploadMode','verified-staged','contentSha256',p_result->>'sha256'),o.id,p_result->>'sha256',p_auth_user_id)
      returning * into a;
    update public.creative_upload_operations set status='finalized',asset_id=a.id,result=p_result,updated_at=clock_timestamp() where id=o.id;
  end if;
  return jsonb_build_object('operationId',o.id,'status','finalized','asset',to_jsonb(a),'replayed',replayed);
end $$;

create or replace function public.reject_creative_upload(p_operation_id uuid,p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid)
returns void language plpgsql security invoker set search_path='' as $$ begin
  perform public.assert_creative_upload_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  update public.creative_upload_operations set status='rejected',error_code='invalid_image',updated_at=clock_timestamp()
    where id=p_operation_id and workspace_id=p_workspace_id and staff_user_id=p_staff_user_id and auth_user_id=p_auth_user_id and status='reserved';
end $$;

revoke all on function public.assert_creative_upload_actor(uuid,uuid,uuid),public.protect_creative_upload_operation(),
  public.creative_upload_ticket(public.creative_upload_operations),public.reserve_creative_upload(uuid,uuid,uuid,uuid,text,text,bigint,text),
  public.finalize_creative_image_upload(uuid,uuid,uuid,uuid,jsonb),public.reject_creative_upload(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.assert_creative_upload_actor(uuid,uuid,uuid),public.protect_creative_upload_operation(),
  public.creative_upload_ticket(public.creative_upload_operations),public.reserve_creative_upload(uuid,uuid,uuid,uuid,text,text,bigint,text),
  public.finalize_creative_image_upload(uuid,uuid,uuid,uuid,jsonb),public.reject_creative_upload(uuid,uuid,uuid,uuid) to service_role;
do $$ declare browser_role text; begin
  foreach browser_role in array array['anon','authenticated'] loop
    if has_table_privilege(browser_role,'public.creative_upload_operations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(browser_role,'public.creative_upload_operations','SELECT,INSERT,UPDATE,REFERENCES')
      or has_table_privilege(browser_role,'public.creative_upload_admission_guards','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(browser_role,'public.creative_upload_admission_guards','SELECT,INSERT,UPDATE,REFERENCES')
      or has_function_privilege(browser_role,'public.reserve_creative_upload(uuid,uuid,uuid,uuid,text,text,bigint,text)','EXECUTE')
      or has_function_privilege(browser_role,'public.finalize_creative_image_upload(uuid,uuid,uuid,uuid,jsonb)','EXECUTE')
      then raise exception 'creative_upload_browser_access_unconfirmed'; end if;
  end loop;
end $$;
commit;
