-- Apply after 019 and 054. No memberships, appointments or payments are created.
begin;

create or replace function public.read_growth_operator_lead_pipeline(
  p_request_id uuid, p_operator_user_id uuid, p_offset integer default 0
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare items jsonb; stages jsonb; clinic_id uuid;
begin
  -- The existing read holds agreement/profile locks and verifies identity/scope,
  -- including when the result is empty. Keep its 21-row pagination contract.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'full_name', l.full_name, 'phone', l.phone,
    'status', l.status, 'source', l.source, 'created_at', l.created_at,
    'stage_id', original.stage_id, 'stage_name', s.name
  ) order by l.created_at desc nulls last, l.id), '[]'::jsonb) into items
  from public.read_growth_operator_leads(p_request_id, p_operator_user_id, p_offset) l
  join public.leads original on original.id = l.id
  left join public.lead_stages s on s.id = original.stage_id
    and s.workspace_id = original.workspace_id;

  select workspace_id into clinic_id from public.growth_operator_requests where id = p_request_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)
    order by s.sort_order, s.id), '[]'::jsonb) into stages
  from public.lead_stages s where s.workspace_id = clinic_id and s.is_active;
  return jsonb_build_object('items', items, 'stages', stages);
end;
$$;

create or replace function public.set_growth_operator_lead_stage(
  p_request_id uuid, p_operator_user_id uuid, p_lead_id uuid,
  p_stage_id uuid, p_expected_stage_id uuid, p_expected_status text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.growth_operator_requests%rowtype;
  l public.leads%rowtype;
  s public.lead_stages%rowtype;
begin
  select * into r from public.growth_operator_requests
    where id = p_request_id and status = 'accepted' for share;
  if not found then raise exception 'operator_access_denied'; end if;
  perform 1 from public.growth_operator_profiles
    where id = r.operator_id and auth_user_id = p_operator_user_id and status = 'approved' for share;
  if not found then raise exception 'operator_access_denied'; end if;
  select * into l from public.leads
    where id = p_lead_id and workspace_id = r.workspace_id for update;
  if not found then raise exception 'operator_access_denied'; end if;
  if r.lead_scope = 'assigned' then
    perform 1 from public.growth_operator_lead_assignments
      where operator_request_id = r.id and workspace_id = r.workspace_id
        and lead_id = l.id and assigned for share;
    if not found then raise exception 'operator_access_denied'; end if;
  elsif r.lead_scope <> 'clinic' then
    raise exception 'operator_access_denied';
  end if;
  select * into s from public.lead_stages
    where id = p_stage_id and workspace_id = r.workspace_id and is_active for share;
  if not found then raise exception using errcode = 'PT409', message = 'operator_stage_unavailable'; end if;
  -- Compare both fields: older CRM clients may update only the text status.
  if l.stage_id is distinct from p_expected_stage_id
    or coalesce(l.status, '') is distinct from p_expected_status then
    raise exception using errcode = 'PT409', message = 'operator_stage_conflict';
  end if;
  if l.stage_id = s.id and l.status = s.name then return; end if;
  update public.leads set stage_id = s.id, status = s.name, updated_at = now() where id = l.id;
  insert into public.audit_logs(workspace_id, actor_role, action, entity_type, entity_id, metadata)
  values (r.workspace_id, 'operator', 'operator_lead_stage_changed', 'lead', l.id::text,
    jsonb_build_object('operator_request_id', r.id, 'operator_id', r.operator_id,
      'previous_stage_id', l.stage_id, 'stage_id', s.id));
end;
$$;

revoke all on function public.read_growth_operator_lead_pipeline(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.set_growth_operator_lead_stage(uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.read_growth_operator_lead_pipeline(uuid, uuid, integer) to service_role;
grant execute on function public.set_growth_operator_lead_stage(uuid, uuid, uuid, uuid, uuid, text) to service_role;

commit;
notify pgrst, 'reload schema';
