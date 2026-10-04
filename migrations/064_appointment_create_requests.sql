-- Apply after 063. Preparation only: the CRM API must explicitly opt into this RPC.
-- No existing appointments, roles, workspace settings or financial rules change.
begin;

create table if not exists public.crm_appointment_create_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  staff_user_id uuid not null,
  request_key uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  appointment_id uuid unique references public.appointments(id) on delete set null,
  client_created boolean not null,
  client_match text not null check (client_match in ('created', 'provided', 'phone')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, staff_user_id, request_key)
);
alter table public.crm_appointment_create_requests enable row level security;
revoke all on public.crm_appointment_create_requests from public, anon, authenticated, service_role;

-- The server computes the fingerprint from the original normalized request,
-- excluding generated client IDs/timestamps. It must never accept a browser hash.
create or replace function public.read_crm_appointment_create_request(
  p_workspace_id uuid, p_staff_user_id uuid, p_request_key uuid, p_request_fingerprint text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  receipt public.crm_appointment_create_requests%rowtype;
  appointment public.appointments%rowtype;
begin
  if p_workspace_id is null or p_staff_user_id is null or p_request_key is null
    or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P6401', message = 'appointment_request_invalid';
  end if;
  if not exists (select 1 from public.staff_users where id = p_staff_user_id
    and workspace_id = p_workspace_id and status = 'active') then
    raise exception using errcode = 'P6404', message = 'appointment_request_access_denied';
  end if;
  select * into receipt from public.crm_appointment_create_requests
    where workspace_id = p_workspace_id and staff_user_id = p_staff_user_id and request_key = p_request_key;
  if not found then return null; end if;
  if receipt.request_fingerprint <> p_request_fingerprint then
    raise exception using errcode = 'P6402', message = 'appointment_request_conflict';
  end if;
  select * into appointment from public.appointments
    where id = receipt.appointment_id and workspace_id = p_workspace_id;
  if not found then
    raise exception using errcode = 'P6403', message = 'appointment_request_unavailable';
  end if;
  -- Return current data, not a stale copy of a visit later edited or cancelled.
  -- The API must still apply its current own-work and contact-privacy checks.
  return jsonb_build_object('appointment', to_jsonb(appointment), 'replayed', true,
    'clientCreated', receipt.client_created, 'clientMatch', receipt.client_match);
end;
$$;

create or replace function public.create_crm_appointment_once(
  p_workspace_id uuid, p_staff_user_id uuid, p_request_key uuid, p_request_fingerprint text,
  p_new_client jsonb, p_appointment jsonb, p_client_match text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  a public.appointments%rowtype;
  saved public.appointments%rowtype;
begin
  -- Scope the lock and receipt to the verified workspace AND actor. A hash
  -- collision can only cause extra waiting, never a cross-scope replay.
  if p_workspace_id is null or p_staff_user_id is null or p_request_key is null then
    raise exception using errcode = 'P6401', message = 'appointment_request_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'crm-appointment:' || p_workspace_id::text || ':' || p_staff_user_id::text || ':' || p_request_key::text, 0));
  replay := public.read_crm_appointment_create_request(p_workspace_id, p_staff_user_id,
    p_request_key, p_request_fingerprint);
  if replay is not null then return replay; end if;

  if jsonb_typeof(p_appointment) is distinct from 'object'
    or p_appointment - array['workspace_id','client_id','client_name','client_phone',
      'whatsapp','service','doctor_name','starts_at','duration_minutes','price_minor',
      'status','notes','source','updated_at','created_by_staff_user_id','doctor_id',
      'service_id','service_items']::text[] <> '{}'::jsonb then
    raise exception using errcode = 'P6401', message = 'appointment_request_invalid';
  end if;
  a := jsonb_populate_record(null::public.appointments, p_appointment);
  if a.workspace_id is distinct from p_workspace_id
    or a.created_by_staff_user_id is distinct from p_staff_user_id
    or a.client_id is null or p_client_match is null then
    raise exception using errcode = 'P6401', message = 'appointment_request_invalid';
  end if;

  if p_new_client is not null then
    if p_client_match <> 'created' then
      raise exception using errcode = 'P6401', message = 'appointment_request_invalid';
    end if;
    select * into saved from jsonb_populate_record(null::public.appointments,
      public.create_crm_appointment_with_new_client(p_workspace_id, p_new_client, p_appointment));
  else
    if p_client_match not in ('provided', 'phone') then
      raise exception using errcode = 'P6401', message = 'appointment_request_invalid';
    end if;
    perform 1 from public.clients where id = a.client_id and workspace_id = p_workspace_id for share;
    if not found then
      raise exception using errcode = 'P6401', message = 'appointment_request_invalid';
    end if;
    if (a.doctor_id is not null and not exists (
        select 1 from public.clinic_doctors where id = a.doctor_id and workspace_id = p_workspace_id))
      or (a.service_id is not null and not exists (
        select 1 from public.clinic_services where id = a.service_id and workspace_id = p_workspace_id)) then
      raise exception using errcode = 'P6401', message = 'appointment_request_invalid';
    end if;
    insert into public.appointments(workspace_id, client_id, client_name, client_phone,
      whatsapp, service, doctor_name, starts_at, duration_minutes, price_minor, status,
      notes, source, updated_at, created_by_staff_user_id, doctor_id, service_id, service_items)
      values(p_workspace_id, a.client_id, a.client_name, a.client_phone, a.whatsapp,
        a.service, a.doctor_name, a.starts_at, a.duration_minutes, a.price_minor,
        a.status, a.notes, a.source, coalesce(a.updated_at, now()),
        p_staff_user_id, a.doctor_id, a.service_id, coalesce(a.service_items, '[]'::jsonb))
      returning * into saved;
    select * into saved from public.appointments where id = saved.id and workspace_id = p_workspace_id;
  end if;
  -- Receipt and domain writes commit together, including arrival/sale triggers.
  insert into public.crm_appointment_create_requests(workspace_id, staff_user_id, request_key,
    request_fingerprint, appointment_id, client_created, client_match)
    values(p_workspace_id, p_staff_user_id, p_request_key, p_request_fingerprint,
      saved.id, p_new_client is not null, p_client_match);
  return jsonb_build_object('appointment', to_jsonb(saved), 'replayed', false,
    'clientCreated', p_new_client is not null, 'clientMatch', p_client_match);
end;
$$;

revoke all on function public.read_crm_appointment_create_request(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.create_crm_appointment_once(uuid, uuid, uuid, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.read_crm_appointment_create_request(uuid, uuid, uuid, text) to service_role;
grant execute on function public.create_crm_appointment_once(uuid, uuid, uuid, text, jsonb, jsonb, text) to service_role;

comment on table public.crm_appointment_create_requests is
  'Server-only creation receipts. No patient names, phones, request bodies, tokens or payment credentials. A deleted visit keeps its receipt and cannot be recreated by retry.';
commit;
notify pgrst, 'reload schema';
