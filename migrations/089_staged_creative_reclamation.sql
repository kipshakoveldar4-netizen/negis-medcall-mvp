-- Local candidate only. Requires 088; no Storage object is deleted by this SQL.
begin;

do $$ begin
  if to_regclass('public.creative_upload_operations') is null
    or to_regclass('public.creative_upload_admission_guards') is null
    or not (select relrowsecurity from pg_class where oid='public.creative_upload_operations'::regclass)
    then raise exception 'creative_reclamation_dependencies_unconfirmed'; end if;
end $$;

alter table public.creative_upload_operations
  add column if not exists raw_cleanup_claim_id uuid,
  add column if not exists raw_cleanup_claimed_until timestamptz,
  add column if not exists raw_cleanup_kind text,
  add column if not exists raw_cleanup_size bigint,
  add column if not exists raw_cleanup_sha256 text;

alter table public.creative_upload_operations drop constraint if exists creative_upload_cleanup_receipt;
alter table public.creative_upload_operations add constraint creative_upload_cleanup_receipt check(
  (raw_cleanup_claim_id is null) = (raw_cleanup_claimed_until is null)
  and (raw_cleanup_size is null or raw_cleanup_size between 1 and 2048)
  and (raw_cleanup_sha256 is null or raw_cleanup_sha256 ~ '^[0-9a-f]{64}$')
  and (raw_cleanup_kind is null or raw_cleanup_kind='tombstone')
  and (source='signed' or (raw_cleanup_claim_id is null and raw_cleanup_claimed_until is null
    and raw_cleanup_kind is null and raw_cleanup_size is null and raw_cleanup_sha256 is null))
  and (source<>'signed' or raw_deleted_at is null or
    (raw_cleanup_kind='tombstone' and raw_cleanup_size between 1 and 2048
      and raw_cleanup_sha256 ~ '^[0-9a-f]{64}$' and raw_cleanup_claim_id is not null) is true)
);

create or replace function public.protect_creative_cleanup_receipt() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
  if old.source='signed' and old.raw_deleted_at is not null and
    row(new.raw_cleanup_claim_id,new.raw_cleanup_claimed_until,new.raw_cleanup_kind,new.raw_cleanup_size,new.raw_cleanup_sha256)
      is distinct from row(old.raw_cleanup_claim_id,old.raw_cleanup_claimed_until,old.raw_cleanup_kind,old.raw_cleanup_size,old.raw_cleanup_sha256)
    then raise exception 'creative_cleanup_receipt_immutable'; end if;
  return new;
end $$;
drop trigger if exists protect_creative_cleanup_receipt on public.creative_upload_operations;
create trigger protect_creative_cleanup_receipt before update on public.creative_upload_operations
  for each row execute function public.protect_creative_cleanup_receipt();

-- Keep nonempty claim identities after a lease is replaced; otherwise an old
-- delayed request could acquire a different operation (an ABA retry).
create table if not exists public.creative_upload_reclamation_claims(
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  claim_id uuid not null,
  batch_limit integer not null check(batch_limit between 1 and 2),
  claimed_until timestamptz not null,
  manifest jsonb not null check(jsonb_typeof(manifest)='array' and jsonb_array_length(manifest) between 1 and 2),
  primary key(workspace_id,claim_id)
);
alter table public.creative_upload_reclamation_claims enable row level security;
revoke all on table public.creative_upload_reclamation_claims from public,anon,authenticated,service_role;
revoke select(workspace_id,claim_id,batch_limit,claimed_until,manifest),insert(workspace_id,claim_id,batch_limit,claimed_until,manifest),
  update(workspace_id,claim_id,batch_limit,claimed_until,manifest),references(workspace_id,claim_id,batch_limit,claimed_until,manifest)
  on table public.creative_upload_reclamation_claims from public,anon,authenticated,service_role;
grant select,insert on table public.creative_upload_reclamation_claims to service_role;

create or replace function public.claim_creative_upload_reclamation(p_workspace_id uuid,p_claim_id uuid,p_limit integer default 1)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.creative_upload_operations%rowtype; b public.creative_upload_reclamation_claims%rowtype;
  at_time timestamptz:=clock_timestamp(); reply jsonb:='[]'::jsonb;
begin
  if p_workspace_id is null or p_claim_id is null
    or p_claim_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_limit is null or p_limit<1 or p_limit>2
    then raise exception using errcode='P8901',message='creative_reclamation_invalid'; end if;
  insert into public.creative_upload_admission_guards(workspace_id,revision) values(p_workspace_id,1)
    on conflict(workspace_id) do update set revision=public.creative_upload_admission_guards.revision+1;
  -- A lost claim ACK must not lease a different object on the same retry.
  select * into b from public.creative_upload_reclamation_claims where workspace_id=p_workspace_id and claim_id=p_claim_id;
  if found then
    at_time:=clock_timestamp();
    if b.claimed_until<=at_time
      then raise exception using errcode='P8902',message='creative_reclamation_claim_unconfirmed'; end if;
    if b.batch_limit is distinct from p_limit then raise exception using errcode='P8901',message='creative_reclamation_invalid'; end if;
    return b.manifest;
  end if;
  at_time:=clock_timestamp();
  for o in select * from public.creative_upload_operations
    where workspace_id=p_workspace_id and source='signed' and raw_deleted_at is null
      and (status in ('finalized','rejected') or expires_at<=floor(extract(epoch from at_time)*1000)::bigint)
      and (raw_cleanup_claimed_until is null or raw_cleanup_claimed_until<=at_time)
    order by issued_at,id limit p_limit for update skip locked
  loop
    update public.creative_upload_operations set raw_cleanup_claim_id=p_claim_id,
      raw_cleanup_claimed_until=at_time+interval '120 seconds',updated_at=at_time where id=o.id;
    reply:=reply || jsonb_build_array(jsonb_build_object('operationId',o.id,'workspaceId',o.workspace_id,
      'fileName',o.file_name,'mimeType',o.mime_type,'fileSize',o.file_size,'issuedAt',o.issued_at,'expiresAt',o.expires_at,
      'claimId',p_claim_id,'claimedUntil',at_time+interval '120 seconds'));
  end loop;
  if jsonb_array_length(reply)>0 then
    insert into public.creative_upload_reclamation_claims(workspace_id,claim_id,batch_limit,claimed_until,manifest)
      values(p_workspace_id,p_claim_id,p_limit,at_time+interval '120 seconds',reply);
  end if;
  return reply;
end $$;

create or replace function public.complete_creative_upload_reclamation(p_workspace_id uuid,p_operation_id uuid,p_claim_id uuid,
  p_tombstone_sha256 text,p_tombstone_size bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.creative_upload_operations%rowtype; at_time timestamptz;
begin
  if p_workspace_id is null or p_operation_id is null or p_claim_id is null
    or p_tombstone_sha256 is null or p_tombstone_sha256 !~ '^[0-9a-f]{64}$'
    or p_tombstone_size is null or p_tombstone_size<1 or p_tombstone_size>2048
    then raise exception using errcode='P8901',message='creative_reclamation_invalid'; end if;
  -- Match the admission lock order and invalidate stale RR/Serializable quota snapshots.
  insert into public.creative_upload_admission_guards(workspace_id,revision) values(p_workspace_id,1)
    on conflict(workspace_id) do update set revision=public.creative_upload_admission_guards.revision+1;
  select * into o from public.creative_upload_operations where id=p_operation_id and workspace_id=p_workspace_id for update;
  at_time:=clock_timestamp();
  if not found or o.source<>'signed' or o.raw_cleanup_claim_id is distinct from p_claim_id
    then raise exception using errcode='P8902',message='creative_reclamation_claim_unconfirmed'; end if;
  if o.raw_deleted_at is not null then
    if o.raw_cleanup_kind is distinct from 'tombstone' or o.raw_cleanup_size is distinct from p_tombstone_size
      or o.raw_cleanup_sha256 is distinct from p_tombstone_sha256
      then raise exception using errcode='P8902',message='creative_reclamation_claim_unconfirmed'; end if;
  else
    if o.raw_cleanup_claimed_until is null or o.raw_cleanup_claimed_until<=at_time
      or (o.status not in ('finalized','rejected') and o.expires_at>floor(extract(epoch from at_time)*1000)::bigint)
      then raise exception using errcode='P8902',message='creative_reclamation_claim_unconfirmed'; end if;
    update public.creative_upload_operations set raw_deleted_at=at_time,raw_cleanup_kind='tombstone',
      raw_cleanup_size=p_tombstone_size,raw_cleanup_sha256=p_tombstone_sha256,updated_at=at_time where id=o.id
      returning * into o;
  end if;
  return jsonb_build_object('operationId',o.id,'workspaceId',o.workspace_id,'rawDeletedAt',o.raw_deleted_at,
    'cleanupKind',o.raw_cleanup_kind,'size',o.raw_cleanup_size,'sha256',o.raw_cleanup_sha256);
end $$;

-- Preserve the admission contract, charging tiny permanent fences instead of
-- pretending an expired token or an uncertain delete has reclaimed any bytes.
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
    select count(*) filter(where status='reserved' and expires_at>clock_ms),
      coalesce(sum(case when source='signed' then case when raw_deleted_at is null then 104857600 else coalesce(raw_cleanup_size,0) end else 0 end),0),
      count(*) filter(where issued_at>clock_ms-7200000)
      into pending,retained_bytes,recent from public.creative_upload_operations where workspace_id=p_workspace_id;
    if pending>=4 or recent>=128 or retained_bytes+(case when p_source='signed' then 104857600 else 0 end)>268435456
      then raise exception using errcode='P8805',message='creative_upload_capacity_exhausted'; end if;
    insert into public.creative_upload_operations(workspace_id,staff_user_id,auth_user_id,request_key,file_name,mime_type,file_size,source,issued_at,expires_at,raw_deleted_at)
      values(p_workspace_id,p_staff_user_id,p_auth_user_id,p_request_key,p_file_name,p_mime_type,p_file_size,p_source,clock_ms,clock_ms+7200000,
        case when p_source='inline' then clock_timestamp() else null end) returning * into o;
  end if;
  return jsonb_build_object('ticket',public.creative_upload_ticket(o),'requestKey',o.request_key,'status',o.status);
end $$;

revoke all on table public.creative_upload_operations from public,anon,authenticated;
do $$ declare names text; begin
  select string_agg(quote_ident(attname),',' order by attnum) into names from pg_attribute
    where attrelid='public.creative_upload_operations'::regclass and attnum>0 and not attisdropped;
  execute format('revoke select (%s),insert (%s),update (%s),references (%s) on table public.creative_upload_operations from public,anon,authenticated',names,names,names,names);
end $$;
revoke all on function public.protect_creative_cleanup_receipt(),public.claim_creative_upload_reclamation(uuid,uuid,integer),
  public.complete_creative_upload_reclamation(uuid,uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.protect_creative_cleanup_receipt(),public.claim_creative_upload_reclamation(uuid,uuid,integer),
  public.complete_creative_upload_reclamation(uuid,uuid,uuid,text,bigint) to service_role;
comment on column public.creative_upload_operations.raw_deleted_at is 'Original live raw replaced by a verified small permanent tombstone; NOT proof of physical backend/version deletion.';

do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated'] loop
    if has_table_privilege(role_name,'public.creative_upload_operations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.creative_upload_operations','SELECT,INSERT,UPDATE,REFERENCES')
      or has_table_privilege(role_name,'public.creative_upload_reclamation_claims','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.creative_upload_reclamation_claims','SELECT,INSERT,UPDATE,REFERENCES')
      or has_function_privilege(role_name,'public.claim_creative_upload_reclamation(uuid,uuid,integer)','EXECUTE')
      or has_function_privilege(role_name,'public.complete_creative_upload_reclamation(uuid,uuid,uuid,text,bigint)','EXECUTE')
      then raise exception 'creative_reclamation_browser_access_unconfirmed'; end if;
  end loop;
  if has_table_privilege('service_role','public.creative_upload_reclamation_claims','UPDATE,DELETE,TRUNCATE')
    or has_any_column_privilege('service_role','public.creative_upload_reclamation_claims','UPDATE')
    then raise exception 'creative_reclamation_history_not_append_only'; end if;
end $$;
commit;
