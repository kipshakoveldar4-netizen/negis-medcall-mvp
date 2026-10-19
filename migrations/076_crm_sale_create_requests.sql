-- Apply after 011, 020 and 032. Prepared locally; not an instruction to deploy.
-- A manual sale intent is distinct from another sale for the same appointment.
begin;

create table if not exists public.crm_sale_create_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  staff_user_id uuid not null,
  request_key uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  sale_id uuid unique references public.deals(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, staff_user_id, request_key)
);
alter table public.crm_sale_create_requests enable row level security;
revoke all on public.crm_sale_create_requests from public, anon, authenticated, service_role;
alter table public.deals enable row level security;
grant select, insert, update on public.deals to service_role;

create or replace function public.read_crm_sale_create_request(
  p_workspace_id uuid, p_staff_user_id uuid, p_auth_user_id uuid,
  p_request_key uuid, p_request_fingerprint text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  receipt public.crm_sale_create_requests%rowtype;
  sale public.deals%rowtype;
begin
  if p_workspace_id is null or p_staff_user_id is null or p_auth_user_id is null
    or p_request_key is null or p_request_fingerprint is null
    or p_request_key::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='P7601', message='sale_request_invalid';
  end if;
  -- Keep current authorization stable until this RPC's transaction ends.
  perform 1 from public.staff_users where id=p_staff_user_id and workspace_id=p_workspace_id
    and auth_user_id=p_auth_user_id and status='active'
    and role in ('owner','admin','receptionist','manager') for share;
  if not found then
    raise exception using errcode='P7604', message='sale_request_access_denied';
  end if;
  select * into receipt from public.crm_sale_create_requests where workspace_id=p_workspace_id
    and staff_user_id=p_staff_user_id and request_key=p_request_key;
  if not found then return null; end if;
  if receipt.request_fingerprint<>p_request_fingerprint then
    raise exception using errcode='P7602', message='sale_request_conflict';
  end if;
  select * into sale from public.deals where id=receipt.sale_id and workspace_id=p_workspace_id;
  if not found then
    raise exception using errcode='P7603', message='sale_request_unavailable';
  end if;
  -- Later edits/refunds are current truth; replay never overwrites them.
  return jsonb_build_object('sale',to_jsonb(sale),'replayed',true);
end;
$$;

create or replace function public.create_crm_sale_once(
  p_workspace_id uuid, p_staff_user_id uuid, p_auth_user_id uuid,
  p_request_key uuid, p_request_fingerprint text, p_sale jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  s public.deals%rowtype;
  saved public.deals%rowtype;
begin
  if p_workspace_id is null or p_staff_user_id is null or p_request_key is null then
    raise exception using errcode='P7601', message='sale_request_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'crm-sale:'||p_workspace_id::text||':'||p_staff_user_id::text||':'||p_request_key::text,0));
  replay:=public.read_crm_sale_create_request(p_workspace_id,p_staff_user_id,p_auth_user_id,
    p_request_key,p_request_fingerprint);
  if replay is not null then return replay; end if;

  if jsonb_typeof(p_sale) is distinct from 'object'
    or p_sale - array['workspace_id','title','amount_minor','currency','status','paid_at','closed_at',
      'payment_method','notes','updated_at','client_id','lead_id','appointment_id',
      'meta_campaign_launch_id','responsible_user_id','service_id']::text[] <> '{}'::jsonb then
    raise exception using errcode='P7601', message='sale_request_invalid';
  end if;
  s:=jsonb_populate_record(null::public.deals,p_sale);
  if s.workspace_id is distinct from p_workspace_id or s.title is null or s.title !~ '[^[:space:]]'
    or s.amount_minor is null or s.amount_minor<0 or s.amount_minor>9007199254740991 or s.currency is null
    or s.status is null or s.status not in ('pending','paid','cancelled','refunded') then
    raise exception using errcode='P7601', message='sale_request_invalid';
  end if;

  -- The API validates these links too; lock their tenant membership at INSERT.
  if s.client_id is not null then
    perform 1 from public.clients where id=s.client_id and workspace_id=p_workspace_id for share;
    if not found then raise exception using errcode='P7601',message='sale_request_invalid'; end if;
  end if;
  if s.lead_id is not null then
    perform 1 from public.leads where id=s.lead_id and workspace_id=p_workspace_id for share;
    if not found then raise exception using errcode='P7601',message='sale_request_invalid'; end if;
  end if;
  if s.appointment_id is not null then
    -- 061 takes the same UPDATE lock; avoid a SHARE-to-UPDATE upgrade race.
    perform 1 from public.appointments where id=s.appointment_id and workspace_id=p_workspace_id for update;
    if not found then raise exception using errcode='P7601',message='sale_request_invalid'; end if;
  end if;
  if s.meta_campaign_launch_id is not null then
    perform 1 from public.meta_campaign_launches where id=s.meta_campaign_launch_id and workspace_id=p_workspace_id for share;
    if not found then raise exception using errcode='P7601',message='sale_request_invalid'; end if;
  end if;
  if s.responsible_user_id is not null then
    perform 1 from public.staff_users where id=s.responsible_user_id and workspace_id=p_workspace_id for share;
    if not found then raise exception using errcode='P7601',message='sale_request_invalid'; end if;
  end if;
  if s.service_id is not null then
    perform 1 from public.clinic_services where id=s.service_id and workspace_id=p_workspace_id and is_active for share;
    if not found then raise exception using errcode='P7601',message='sale_request_invalid'; end if;
  end if;

  insert into public.deals(workspace_id,title,amount_minor,currency,status,paid_at,closed_at,
    payment_method,notes,updated_at,client_id,lead_id,appointment_id,meta_campaign_launch_id,
    responsible_user_id,service_id)
    values(p_workspace_id,s.title,s.amount_minor,s.currency,s.status,s.paid_at,s.closed_at,
      s.payment_method,s.notes,coalesce(s.updated_at,now()),s.client_id,s.lead_id,s.appointment_id,
      s.meta_campaign_launch_id,s.responsible_user_id,s.service_id) returning * into saved;
  insert into public.crm_sale_create_requests(workspace_id,staff_user_id,request_key,request_fingerprint,sale_id)
    values(p_workspace_id,p_staff_user_id,p_request_key,p_request_fingerprint,saved.id);
  return jsonb_build_object('sale',to_jsonb(saved),'replayed',false);
end;
$$;

revoke all on function public.read_crm_sale_create_request(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.create_crm_sale_once(uuid,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.read_crm_sale_create_request(uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.create_crm_sale_once(uuid,uuid,uuid,uuid,text,jsonb) to service_role;
comment on table public.crm_sale_create_requests is
  'Server-only manual-sale intent receipts. No request payload, client contacts or credentials. A removed sale keeps its tombstone and cannot be recreated by replay.';
commit;
notify pgrst,'reload schema';
