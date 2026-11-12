-- Apply after 043, 045, 055 and 061. Server-only; no backfill or settings changes.
-- The API still validates actor access, references, prices and the time slot.
begin;

create or replace function public.create_crm_appointment_with_new_client(
  p_workspace_id uuid, p_client jsonb, p_appointment jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.clients%rowtype;
  a public.appointments%rowtype;
  saved public.appointments%rowtype;
begin
  if p_workspace_id is null
    or jsonb_typeof(p_client) is distinct from 'object'
    or jsonb_typeof(p_appointment) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'appointment_create_invalid';
  end if;
  -- Explicit fields keep receipt links, generated columns and future columns
  -- outside this RPC's write surface. Never accept a raw browser payload here.
  if p_client - array['id','workspace_id','full_name','phone','whatsapp','source',
      'status','notes','last_visit_at','updated_at']::text[] <> '{}'::jsonb
    or p_appointment - array['workspace_id','client_id','client_name','client_phone',
      'whatsapp','service','doctor_name','starts_at','duration_minutes','price_minor',
      'status','notes','source','updated_at','created_by_staff_user_id','doctor_id',
      'service_id','service_items']::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'appointment_create_invalid';
  end if;
  c := jsonb_populate_record(null::public.clients, p_client);
  a := jsonb_populate_record(null::public.appointments, p_appointment);
  if c.id is null or c.workspace_id is distinct from p_workspace_id
    or a.workspace_id is distinct from p_workspace_id
    or a.client_id is distinct from c.id then
    raise exception using errcode = '22023', message = 'appointment_create_invalid';
  end if;
  if (a.doctor_id is not null and not exists (
      select 1 from public.clinic_doctors where id = a.doctor_id and workspace_id = p_workspace_id))
    or (a.service_id is not null and not exists (
      select 1 from public.clinic_services where id = a.service_id and workspace_id = p_workspace_id))
    or (a.created_by_staff_user_id is not null and not exists (
      select 1 from public.staff_users where id = a.created_by_staff_user_id and workspace_id = p_workspace_id)) then
    raise exception using errcode = '22023', message = 'appointment_create_invalid';
  end if;

  -- An exception in either INSERT or an arrival trigger rolls back both writes.
  -- Do not catch it, upsert an existing client, or compensate with a DELETE.
  insert into public.clients(id, workspace_id, full_name, phone, whatsapp, source,
    status, notes, last_visit_at, updated_at)
    values(c.id, p_workspace_id, c.full_name, c.phone, c.whatsapp, c.source,
      c.status, c.notes, c.last_visit_at, coalesce(c.updated_at, now()));
  insert into public.appointments(workspace_id, client_id, client_name, client_phone,
    whatsapp, service, doctor_name, starts_at, duration_minutes, price_minor, status,
    notes, source, updated_at, created_by_staff_user_id, doctor_id, service_id, service_items)
    values(p_workspace_id, c.id, a.client_name, a.client_phone, a.whatsapp,
      a.service, a.doctor_name, a.starts_at, a.duration_minutes, a.price_minor,
      a.status, a.notes, a.source, coalesce(a.updated_at, now()),
      a.created_by_staff_user_id, a.doctor_id, a.service_id, coalesce(a.service_items, '[]'::jsonb))
    returning * into saved;
  -- AFTER triggers may have attached a receipt after INSERT RETURNING.
  select * into saved from public.appointments where id = saved.id and workspace_id = p_workspace_id;
  return to_jsonb(saved);
end;
$$;

revoke all on function public.create_crm_appointment_with_new_client(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_crm_appointment_with_new_client(uuid, jsonb, jsonb)
  to service_role;

comment on function public.create_crm_appointment_with_new_client(uuid, jsonb, jsonb) is
  'Server-only atomic insert of a new client and its API-validated appointment. No name matching, upsert, retry deduplication or authorization bypass for browser callers.';
commit;
notify pgrst, 'reload schema';
