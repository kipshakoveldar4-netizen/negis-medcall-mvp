-- Preparation only: apply to an explicitly approved isolated database first.
-- Existing staff roles, assignments and tenant data are not changed.
begin;

create index if not exists leads_workspace_responsible_created_idx
  on public.leads(workspace_id, responsible_user_id, created_at desc);

-- The join approval path uses a constraint rather than the TypeScript catalog.
alter table public.staff_join_requests drop constraint if exists staff_join_requests_role_check;
alter table public.staff_join_requests add constraint staff_join_requests_role_check
  check (granted_role is null or granted_role in ('admin','manager','receptionist','marketer','doctor','lead_manager'));

create or replace function public.read_assigned_crm_leads(
  p_workspace_id uuid, p_staff_user_id uuid, p_auth_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_items jsonb;
begin
  -- Hold membership while reading: a concurrent revocation serializes with this
  -- operation. Auth identity comes only from the verified server context.
  perform 1 from public.staff_users
    where id = p_staff_user_id and workspace_id = p_workspace_id
      and auth_user_id = p_auth_user_id and status = 'active' and role = 'lead_manager'
    for share;
  if not found then raise exception using errcode = 'P6901', message = 'assigned_lead_access_denied'; end if;

  select coalesce(jsonb_agg(to_jsonb(owned) order by owned.created_at desc, owned.id), '[]'::jsonb)
    into v_items
  from (
    select l.id, l.full_name, l.phone, l.notes, l.status, l.source, l.campaign,
      l.responsible_user_id, l.stage_id, l.source_id, l.created_at, l.updated_at,
      to_jsonb(s) as stage_definition, to_jsonb(src) as source_definition
    from public.leads l
    left join public.lead_stages s on s.id = l.stage_id and s.workspace_id = l.workspace_id
    left join public.lead_sources src on src.id = l.source_id and src.workspace_id = l.workspace_id
    where l.workspace_id = p_workspace_id and l.responsible_user_id = p_staff_user_id
    order by l.created_at desc, l.id limit 1000
  ) owned;
  return v_items;
end;
$$;

create or replace function public.patch_assigned_crm_lead(
  p_workspace_id uuid, p_staff_user_id uuid, p_auth_user_id uuid,
  p_lead_id uuid, p_patch jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_before public.leads%rowtype;
  v_after public.leads%rowtype;
  v_stage public.lead_stages%rowtype;
  v_item jsonb;
begin
  perform 1 from public.staff_users
    where id = p_staff_user_id and workspace_id = p_workspace_id
      and auth_user_id = p_auth_user_id and status = 'active' and role = 'lead_manager'
    for share;
  if not found then raise exception using errcode = 'P6901', message = 'assigned_lead_access_denied'; end if;

  -- The row lock rechecks the predicate after a waiting reassignment commits.
  -- Missing, foreign, unassigned and another employee's lead are indistinguishable.
  select * into v_before from public.leads
    where id = p_lead_id and workspace_id = p_workspace_id
      and responsible_user_id = p_staff_user_id for update;
  if not found then raise exception using errcode = 'P6902', message = 'assigned_lead_not_found'; end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception using errcode = 'P6903', message = 'assigned_lead_patch_invalid';
  end if;
  if exists (select 1 from jsonb_each(p_patch) e where
      e.key not in ('full_name','phone','notes','status','stage_id')
      or jsonb_typeof(e.value) not in ('string','null'))
    or char_length(coalesce(p_patch->>'full_name','')) > 500
    or char_length(coalesce(p_patch->>'phone','')) > 100
    or char_length(coalesce(p_patch->>'notes','')) > 10000
    or char_length(coalesce(p_patch->>'status','')) > 100 then
    raise exception using errcode = 'P6903', message = 'assigned_lead_patch_invalid';
  end if;

  if p_patch ? 'stage_id' then
    if coalesce(p_patch->>'stage_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P6903', message = 'assigned_lead_stage_invalid';
    end if;
    select * into v_stage from public.lead_stages
      where id = (p_patch->>'stage_id')::uuid and workspace_id = p_workspace_id and is_active for share;
    if not found or (p_patch ? 'status' and (p_patch->>'status') is distinct from v_stage.stage_key) then
      raise exception using errcode = 'P6903', message = 'assigned_lead_stage_invalid';
    end if;
  elsif p_patch ? 'status' then
    select * into v_stage from public.lead_stages
      where stage_key = p_patch->>'status' and workspace_id = p_workspace_id and is_active for share;
    if not found then raise exception using errcode = 'P6903', message = 'assigned_lead_stage_invalid'; end if;
  end if;

  update public.leads set
    full_name = case when p_patch ? 'full_name' then nullif(btrim(p_patch->>'full_name'),'') else full_name end,
    phone = case when p_patch ? 'phone' then nullif(btrim(p_patch->>'phone'),'') else phone end,
    notes = case when p_patch ? 'notes' then nullif(btrim(p_patch->>'notes'),'') else notes end,
    status = coalesce(v_stage.stage_key, status),
    stage_id = coalesce(v_stage.id, stage_id),
    updated_at = statement_timestamp()
    where id = v_before.id and workspace_id = p_workspace_id and responsible_user_id = p_staff_user_id
    returning * into v_after;
  if nullif(btrim(coalesce(v_after.full_name,'')),'') is null
    and nullif(btrim(coalesce(v_after.phone,'')),'') is null then
    raise exception using errcode = 'P6903', message = 'assigned_lead_contact_required';
  end if;

  select jsonb_build_object(
    'id',l.id,'full_name',l.full_name,'phone',l.phone,'notes',l.notes,'status',l.status,
    'source',l.source,'campaign',l.campaign,'responsible_user_id',l.responsible_user_id,
    'stage_id',l.stage_id,'source_id',l.source_id,'created_at',l.created_at,'updated_at',l.updated_at,
    'stage_definition',to_jsonb(s),'source_definition',to_jsonb(src)) into v_item
    from public.leads l
    left join public.lead_stages s on s.id = l.stage_id and s.workspace_id = l.workspace_id
    left join public.lead_sources src on src.id = l.source_id and src.workspace_id = l.workspace_id
    where l.id = v_after.id and l.workspace_id = p_workspace_id;
  return jsonb_build_object('before',to_jsonb(v_before),'item',v_item);
end;
$$;

revoke all on function public.read_assigned_crm_leads(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.patch_assigned_crm_lead(uuid,uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.read_assigned_crm_leads(uuid,uuid,uuid) to service_role;
grant execute on function public.patch_assigned_crm_lead(uuid,uuid,uuid,uuid,jsonb) to service_role;
commit;
