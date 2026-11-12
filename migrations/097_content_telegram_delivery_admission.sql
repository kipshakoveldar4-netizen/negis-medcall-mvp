-- Local candidate. Durable no-blind-retry fence; no external calls or TTL cleanup.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog, public;
do $$ begin
  if to_regclass('public.content_videos') is null or to_regclass('public.staff_users') is null
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls)
    or not has_schema_privilege('service_role','public','USAGE')
    then raise exception 'telegram_delivery_dependencies_unconfirmed'; end if;
end $$;

create table public.content_telegram_delivery_guards(
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  revision bigint not null default 0
);
create table public.content_telegram_deliveries(
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  video_id uuid not null,
  package_version timestamptz not null,
  kind text not null check(kind in ('package','test')),
  dispatch_id uuid not null,
  staff_user_id uuid not null,
  auth_user_id uuid not null,
  content_sha256 text not null check(content_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_sha256 text not null check(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  recipient_sha256 text not null check(recipient_sha256 ~ '^[0-9a-f]{64}$'),
  part_sha256 jsonb not null check(jsonb_typeof(part_sha256)='array' and jsonb_array_length(part_sha256) between 1 and 64),
  acknowledgements jsonb not null default '[]'::jsonb check(jsonb_typeof(acknowledgements)='array'),
  in_flight integer,
  status text not null default 'admitted' check(status in ('admitted','dispatching','succeeded')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,video_id,package_version,kind),
  unique(workspace_id,video_id,kind,content_sha256),
  check(in_flight is null or in_flight between 0 and 63),
  check(jsonb_array_length(acknowledgements)<=jsonb_array_length(part_sha256)),
  check(status<>'succeeded' or (in_flight is null and jsonb_array_length(acknowledgements)=jsonb_array_length(part_sha256)))
);
alter table public.content_telegram_deliveries enable row level security;
alter table public.content_telegram_delivery_guards enable row level security;
revoke all on public.content_telegram_deliveries,public.content_telegram_delivery_guards from public,anon,authenticated,service_role;

create or replace function public.admit_content_telegram_delivery(
  p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_video_id uuid,p_package_version timestamptz,
  p_kind text,p_dispatch_id uuid,p_recipient_sha256 text,p_manifest jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v public.content_telegram_deliveries; v_video public.content_videos;
  v_snapshot jsonb; v_text text; v_parts jsonb; v_content text; v_part_hashes jsonb; v_snapshot_hash text;
begin
  if p_workspace_id is null or p_staff_user_id is null or p_auth_user_id is null or p_video_id is null
    or p_package_version is null or p_dispatch_id is null or p_kind is null or p_kind not in ('package','test')
    or p_recipient_sha256 is null or p_recipient_sha256 !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_manifest) is distinct from 'object' or octet_length(p_manifest::text)>1000000
    or jsonb_typeof(p_manifest->'text') is distinct from 'string'
    or jsonb_typeof(p_manifest->'snapshot') is distinct from 'object'
    or jsonb_typeof(p_manifest->'parts') is distinct from 'array' then
    raise exception using errcode='P9701',message='telegram_delivery_invalid'; end if;
  v_text:=p_manifest->>'text'; v_parts:=p_manifest->'parts';
  if octet_length(v_text) not between 1 and 240000 or jsonb_array_length(v_parts) not between 1 and 64
    or exists(select 1 from jsonb_array_elements(v_parts) x where jsonb_typeof(x)<>'string' or length(x#>>'{}') not between 1 and 4096) then
    raise exception using errcode='P9701',message='telegram_delivery_invalid'; end if;
  v_content:=encode(sha256(convert_to(v_text,'UTF8')),'hex');
  v_snapshot_hash:=encode(sha256(convert_to((p_manifest->'snapshot')::text,'UTF8')),'hex');
  select jsonb_agg(encode(sha256(convert_to(x#>>'{}','UTF8')),'hex') order by n) into v_part_hashes
    from jsonb_array_elements(v_parts) with ordinality as a(x,n);
  if p_kind='test' then
    if p_video_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or p_package_version<>'2000-01-01T00:00:00Z'::timestamptz
      or p_manifest->'snapshot'<>'{}'::jsonb or v_text<>'✅ Telegram подключён к Medina OS Content Studio'
      or v_parts<>jsonb_build_array(v_text) then
      raise exception using errcode='P9701',message='telegram_delivery_invalid'; end if;
  end if;
  insert into public.content_telegram_delivery_guards(workspace_id) values(p_workspace_id) on conflict do nothing;
  update public.content_telegram_delivery_guards set revision=revision+1 where workspace_id=p_workspace_id;
  -- Resolve the live actor after serialization, never a pre-wait snapshot.
  perform 1 from public.staff_users where id=p_staff_user_id and workspace_id=p_workspace_id and auth_user_id=p_auth_user_id
    and status='active' and role in ('owner','admin','marketer') for share;
  if not found then raise exception using errcode='P9704',message='telegram_delivery_access_denied'; end if;
  select * into v from public.content_telegram_deliveries where workspace_id=p_workspace_id and video_id=p_video_id
    and package_version=p_package_version and kind=p_kind for update;
  if not found then
    -- A status-only updated_at bump is not a new content delivery.
    select * into v from public.content_telegram_deliveries where workspace_id=p_workspace_id and video_id=p_video_id
      and content_sha256=v_content and kind=p_kind for update;
  end if;
  if found then
    if v.content_sha256<>v_content or v.snapshot_sha256<>v_snapshot_hash or v.part_sha256<>v_part_hashes or v.recipient_sha256<>p_recipient_sha256 then
      raise exception using errcode='P9702',message='telegram_delivery_conflict'; end if;
    if v.status<>'succeeded' then raise exception using errcode='P9703',message='telegram_delivery_quarantined'; end if;
    return jsonb_build_object('state','succeeded','contentSha256',v.content_sha256,'partSha256',v.part_sha256,'recipientSha256',v.recipient_sha256);
  end if;
  if p_kind='package' then
    select * into v_video from public.content_videos where id=p_video_id and workspace_id=p_workspace_id for share;
    if not found or v_video.updated_at is distinct from p_package_version then
      raise exception using errcode='P9702',message='telegram_delivery_conflict'; end if;
    v_snapshot:=jsonb_build_object('title',coalesce(v_video.title,''),'hook',coalesce(v_video.hook,''),'script',coalesce(v_video.script,''),
      'voiceover',coalesce(v_video.voiceover,''),'cta',coalesce(v_video.cta,''),'caption',coalesce(v_video.caption,''),
      'hashtags',coalesce(v_video.hashtags,'[]'::jsonb),'avatarPrompt',coalesce(v_video.avatar_prompt,''),'tapnowPrompt',coalesce(v_video.tapnow_prompt,''));
    if p_manifest->'snapshot'<>v_snapshot then raise exception using errcode='P9702',message='telegram_delivery_conflict'; end if;
    if jsonb_typeof(v_snapshot->'hashtags')<>'array' then raise exception using errcode='P9701',message='telegram_delivery_invalid'; end if;
    if v_text is distinct from concat_ws(E'\n\n---\n\n','ИИ студия контента: '||coalesce(nullif(v_video.title,''),'ролик'),
      case when coalesce(v_video.hook,'')<>'' then E'Hook:\n'||v_video.hook end,
      case when coalesce(v_video.script,'')<>'' then E'Script:\n'||v_video.script end,
      case when coalesce(v_video.voiceover,'')<>'' then E'Voiceover:\n'||v_video.voiceover end,
      case when coalesce(v_video.cta,'')<>'' then E'CTA:\n'||v_video.cta end,
      case when coalesce(v_video.caption,'')<>'' then E'Caption:\n'||v_video.caption end,
      case when jsonb_array_length(v_snapshot->'hashtags')>0 then E'Hashtags:\n'||(select string_agg(x#>>'{}',' ' order by n) from jsonb_array_elements(v_snapshot->'hashtags') with ordinality as a(x,n)) end,
      case when coalesce(v_video.avatar_prompt,'')<>'' then E'Avatar prompt:\n'||v_video.avatar_prompt end,
      case when coalesce(v_video.tapnow_prompt,'')<>'' then E'TapNow prompt:\n'||v_video.tapnow_prompt end) then
      raise exception using errcode='P9702',message='telegram_delivery_conflict'; end if;
  end if;
  -- A bounded append-only fence, not an expiring lease. Capacity requires an
  -- explicit retention/reconciliation decision; unknown deliveries never expire.
  if (select count(*) from public.content_telegram_deliveries where workspace_id=p_workspace_id)>=10000 then
    raise exception using errcode='P9705',message='telegram_delivery_capacity'; end if;
  insert into public.content_telegram_deliveries(workspace_id,video_id,package_version,kind,dispatch_id,staff_user_id,auth_user_id,
    content_sha256,snapshot_sha256,recipient_sha256,part_sha256) values(p_workspace_id,p_video_id,p_package_version,p_kind,p_dispatch_id,p_staff_user_id,p_auth_user_id,
    v_content,v_snapshot_hash,p_recipient_sha256,v_part_hashes);
  return jsonb_build_object('state','admitted','dispatchId',p_dispatch_id,'contentSha256',v_content,'partSha256',v_part_hashes,'recipientSha256',p_recipient_sha256);
end $$;

create or replace function public.advance_content_telegram_delivery(
  p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_video_id uuid,p_package_version timestamptz,p_kind text,
  p_dispatch_id uuid,p_part_index integer,p_part_sha256 text,p_acknowledgement_sha256 text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.content_telegram_deliveries; v_version timestamptz;
begin
  if p_part_index is null or p_part_index not between 0 and 63 or p_dispatch_id is null
    or p_part_sha256 is null or p_part_sha256 !~ '^[0-9a-f]{64}$'
    or (p_acknowledgement_sha256 is not null and p_acknowledgement_sha256 !~ '^[0-9a-f]{64}$') then
    raise exception using errcode='P9701',message='telegram_delivery_invalid'; end if;
  select * into v from public.content_telegram_deliveries where workspace_id=p_workspace_id and video_id=p_video_id
    and package_version=p_package_version and kind=p_kind for update;
  if not found or v.dispatch_id<>p_dispatch_id or v.staff_user_id is distinct from p_staff_user_id or v.auth_user_id is distinct from p_auth_user_id then
    raise exception using errcode='P9704',message='telegram_delivery_access_denied'; end if;
  perform 1 from public.staff_users where id=p_staff_user_id and workspace_id=p_workspace_id and auth_user_id=p_auth_user_id
    and status='active' and role in ('owner','admin','marketer') for share;
  if not found then raise exception using errcode='P9704',message='telegram_delivery_access_denied'; end if;
  if v.part_sha256->>p_part_index is distinct from p_part_sha256 then
    raise exception using errcode='P9702',message='telegram_delivery_conflict'; end if;
  if p_acknowledgement_sha256 is null then
    if v.status='succeeded' or v.in_flight is not null or jsonb_array_length(v.acknowledgements)<>p_part_index then
      raise exception using errcode='P9703',message='telegram_delivery_quarantined'; end if;
    if p_kind='package' then
      select updated_at into v_version from public.content_videos where id=p_video_id and workspace_id=p_workspace_id for share;
      if not found or v_version is distinct from p_package_version then
        raise exception using errcode='P9702',message='telegram_delivery_conflict'; end if;
    end if;
    update public.content_telegram_deliveries set in_flight=p_part_index,status='dispatching',updated_at=clock_timestamp()
      where workspace_id=p_workspace_id and video_id=p_video_id and package_version=p_package_version and kind=p_kind;
    return jsonb_build_object('state','dispatching','part',p_part_index);
  end if;
  -- Idempotent receipt ACK never grants permission to dispatch again.
  if jsonb_array_length(v.acknowledgements)>p_part_index then
    if v.acknowledgements->>p_part_index is distinct from p_acknowledgement_sha256 then
      raise exception using errcode='P9702',message='telegram_delivery_conflict'; end if;
  else
    if v.in_flight is distinct from p_part_index or jsonb_array_length(v.acknowledgements)<>p_part_index then
      raise exception using errcode='P9703',message='telegram_delivery_quarantined'; end if;
    if v.acknowledgements ? p_acknowledgement_sha256 then
      raise exception using errcode='P9702',message='telegram_delivery_conflict'; end if;
    update public.content_telegram_deliveries set acknowledgements=acknowledgements||jsonb_build_array(p_acknowledgement_sha256),
      in_flight=null,status=case when p_part_index=jsonb_array_length(part_sha256)-1 then 'succeeded' else 'admitted' end,updated_at=clock_timestamp()
      where workspace_id=p_workspace_id and video_id=p_video_id and package_version=p_package_version and kind=p_kind;
  end if;
  return jsonb_build_object('state',case when p_part_index=jsonb_array_length(v.part_sha256)-1 then 'succeeded' else 'acknowledged' end,'part',p_part_index);
end $$;
revoke all on function public.admit_content_telegram_delivery(uuid,uuid,uuid,uuid,timestamptz,text,uuid,text,jsonb),
  public.advance_content_telegram_delivery(uuid,uuid,uuid,uuid,timestamptz,text,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.admit_content_telegram_delivery(uuid,uuid,uuid,uuid,timestamptz,text,uuid,text,jsonb),
  public.advance_content_telegram_delivery(uuid,uuid,uuid,uuid,timestamptz,text,uuid,integer,text,text) to service_role;
do $$ declare v_role text; v_table text; v_function regprocedure; begin
  foreach v_role in array array['anon','authenticated','service_role'] loop
    foreach v_table in array array['public.content_telegram_deliveries','public.content_telegram_delivery_guards'] loop
      if has_table_privilege(v_role,v_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(v_role,v_table,'SELECT,INSERT,UPDATE,REFERENCES') then
        if v_role='service_role' then raise exception 'telegram_delivery_server_acl_unconfirmed';
        else raise exception 'telegram_delivery_browser_acl_unconfirmed'; end if;
      end if;
    end loop;
    foreach v_function in array array[
      'public.admit_content_telegram_delivery(uuid,uuid,uuid,uuid,timestamptz,text,uuid,text,jsonb)'::regprocedure,
      'public.advance_content_telegram_delivery(uuid,uuid,uuid,uuid,timestamptz,text,uuid,integer,text,text)'::regprocedure] loop
      if v_role<>'service_role' and has_function_privilege(v_role,v_function,'EXECUTE')
        then raise exception 'telegram_delivery_browser_acl_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
commit;
