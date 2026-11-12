-- After 070. Local candidate: no existing assignments, users or roles change.
-- An administrator may schedule her own explicitly assigned mortgage lead.
begin;

create or replace function public.save_mortgage_admin_self_lead(
  p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_lead_id uuid,p_row jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_lead public.leads%rowtype;
  v_saved public.leads%rowtype;
begin
  -- mortgage_actor_role holds the verified actor and purpose rows FOR SHARE.
  v_role:=public.mortgage_actor_role(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if v_role<>'admin' then raise exception using errcode='P7703',message='admin_self_access_denied'; end if;
  if jsonb_typeof(p_row) is distinct from 'object'
    or p_row - array['workspace_id','full_name','phone','notes','status','source','campaign',
      'client_id','stage_id','source_id','meta_campaign_launch_id','responsible_user_id','updated_at']::text[]<>'{}'::jsonb
    or p_row->>'responsible_user_id' is distinct from p_staff_user_id::text
    or (p_row ? 'workspace_id' and p_row->>'workspace_id' is distinct from p_workspace_id::text) then
    raise exception using errcode='P7701',message='admin_self_invalid';
  end if;
  if p_lead_id is not null then
    select * into v_lead from public.leads where id=p_lead_id and workspace_id=p_workspace_id for update;
    if not found then raise exception using errcode='P7702',message='lead_not_found'; end if;
  end if;
  v_lead:=jsonb_populate_record(v_lead,p_row);
  v_lead.workspace_id:=p_workspace_id;
  v_lead.responsible_user_id:=p_staff_user_id;
  if v_lead.client_id is not null then
    perform 1 from public.clients where id=v_lead.client_id and workspace_id=p_workspace_id for share;
    if not found then raise exception using errcode='P7701',message='admin_self_invalid'; end if;
  end if;
  if v_lead.stage_id is not null then
    perform 1 from public.lead_stages where id=v_lead.stage_id and workspace_id=p_workspace_id for share;
    if not found then raise exception using errcode='P7701',message='admin_self_invalid'; end if;
  end if;
  if v_lead.source_id is not null then
    perform 1 from public.lead_sources where id=v_lead.source_id and workspace_id=p_workspace_id for share;
    if not found then raise exception using errcode='P7701',message='admin_self_invalid'; end if;
  end if;
  if v_lead.meta_campaign_launch_id is not null then
    perform 1 from public.meta_campaign_launches where id=v_lead.meta_campaign_launch_id and workspace_id=p_workspace_id for share;
    if not found then raise exception using errcode='P7701',message='admin_self_invalid'; end if;
  end if;
  if p_lead_id is null then
    insert into public.leads(workspace_id,full_name,phone,notes,status,source,campaign,client_id,
      stage_id,source_id,meta_campaign_launch_id,responsible_user_id,updated_at)
      values(p_workspace_id,v_lead.full_name,v_lead.phone,v_lead.notes,coalesce(v_lead.status,'new'),
        v_lead.source,v_lead.campaign,v_lead.client_id,v_lead.stage_id,v_lead.source_id,
        v_lead.meta_campaign_launch_id,p_staff_user_id,coalesce(v_lead.updated_at,now())) returning * into v_saved;
  else
    update public.leads set full_name=v_lead.full_name,phone=v_lead.phone,notes=v_lead.notes,
      status=v_lead.status,source=v_lead.source,campaign=v_lead.campaign,client_id=v_lead.client_id,
      stage_id=v_lead.stage_id,source_id=v_lead.source_id,meta_campaign_launch_id=v_lead.meta_campaign_launch_id,
      responsible_user_id=p_staff_user_id,updated_at=coalesce(v_lead.updated_at,now())
      where id=p_lead_id and workspace_id=p_workspace_id returning * into v_saved;
  end if;
  return to_jsonb(v_saved)||jsonb_build_object(
    'stage_definition',(select jsonb_build_object('id',s.id,'stage_key',s.stage_key,'name',s.name,'color',s.color,
      'semantic_group',s.semantic_group,'sort_order',s.sort_order,'is_default',s.is_default,'is_active',s.is_active)
      from public.lead_stages s where s.id=v_saved.stage_id and s.workspace_id=p_workspace_id),
    'source_definition',(select jsonb_build_object('id',s.id,'source_key',s.source_key,'name',s.name,'channel',s.channel,
      'color',s.color,'sort_order',s.sort_order,'is_default',s.is_default,'is_active',s.is_active)
      from public.lead_sources s where s.id=v_saved.source_id and s.workspace_id=p_workspace_id));
end; $$;

create or replace function public.save_mortgage_activity(
  p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_activity_id uuid,p_expected_updated_at timestamptz,p_request_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_role text; v_lead public.leads%rowtype; v_before public.mortgage_activities%rowtype;
  v_after public.mortgage_activities%rowtype; v_receipt public.mortgage_activity_requests%rowtype;
  v_kind text; v_status text; v_start timestamptz; v_end timestamptz; v_due timestamptz;
begin
  v_role:=public.mortgage_actor_role(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or exists(select 1 from jsonb_object_keys(p_payload) k
      where k not in ('kind','leadId','title','notes','status','priority','startsAt','endsAt','dueAt'))
    or exists(select 1 from jsonb_each(p_payload) e where e.key in ('kind','leadId','title','notes','status','priority') and jsonb_typeof(e.value)<>'string')
    or jsonb_typeof(p_payload->'leadId')<>'string' or coalesce(p_payload->>'leadId','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(char_length(btrim(p_payload->>'title')),0) not between 1 and 200
    or char_length(coalesce(p_payload->>'notes',''))>10000 or coalesce(p_payload->>'priority','') not in ('low','normal','high') then
    raise exception using errcode='P7003',message='invalid_activity'; end if;
  v_kind:=p_payload->>'kind'; v_status:=p_payload->>'status';
  if (v_kind='meeting' and v_status not in ('open','done','cancelled','missed'))
    or (v_kind='task' and v_status not in ('open','in_progress','done','cancelled'))
    or v_kind is null or v_status is null or v_kind not in ('meeting','task') then
    raise exception using errcode='P7003',message='invalid_activity'; end if;
  begin
    v_start:=(p_payload->>'startsAt')::timestamptz; v_end:=(p_payload->>'endsAt')::timestamptz; v_due:=(p_payload->>'dueAt')::timestamptz;
  exception when others then raise exception using errcode='P7003',message='invalid_time'; end;
  if (v_kind='meeting' and (v_start is null or v_end is null or v_end-v_start<interval '5 minutes' or v_end-v_start>interval '24 hours' or v_due is not null))
    or (v_kind='task' and (v_start is not null or v_end is not null)) then raise exception using errcode='P7003',message='invalid_time'; end if;
  if p_activity_id is null then
    if p_request_id is null then raise exception using errcode='P7003',message='request_required'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||p_staff_user_id::text||p_request_id::text,0));
  end if;
  select * into v_lead from public.leads l where l.id=(p_payload->>'leadId')::uuid and l.workspace_id=p_workspace_id
    and (v_role<>'lead_manager' or l.responsible_user_id=p_staff_user_id) for update;
  if not found then raise exception using errcode='P7002',message='lead_not_found'; end if;
  if p_activity_id is null then
    select * into v_receipt from public.mortgage_activity_requests r where r.workspace_id=p_workspace_id
      and r.staff_user_id=p_staff_user_id and r.request_id=p_request_id;
    if found then
      if v_receipt.payload is distinct from p_payload then raise exception using errcode='P7007',message='request_conflict'; end if;
      return jsonb_build_object('id',v_receipt.activity_id,'replayed',true);
    end if;
  else
    select * into v_before from public.mortgage_activities a where a.id=p_activity_id and a.workspace_id=p_workspace_id and a.lead_id=v_lead.id for update;
    if not found then raise exception using errcode='P7002',message='activity_not_found'; end if;
    if v_before.updated_at is distinct from p_expected_updated_at then raise exception using errcode='P7005',message='activity_changed'; end if;
    if v_before.kind<>v_kind then raise exception using errcode='P7003',message='kind_immutable'; end if;
  end if;
  if v_kind='meeting' and v_status='open' then
    perform 1 from public.staff_users s where s.id=v_lead.responsible_user_id and s.workspace_id=p_workspace_id
      and s.status='active' and (s.role='lead_manager'
        or (v_role='admin' and s.role='admin' and s.id=p_staff_user_id)) for share;
    if not found then raise exception using errcode='P7006',message='lead_requires_assignment'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||v_lead.responsible_user_id::text,1));
    if exists(select 1 from public.mortgage_activities a join public.leads l on l.id=a.lead_id and l.workspace_id=p_workspace_id
      where a.workspace_id=p_workspace_id and l.responsible_user_id=v_lead.responsible_user_id and a.kind='meeting' and a.status='open'
        and (p_activity_id is null or a.id<>p_activity_id) and a.starts_at<v_end and a.ends_at>v_start) then
      raise exception using errcode='P7004',message='meeting_conflict'; end if;
  end if;
  if p_activity_id is null then
    insert into public.mortgage_activities(workspace_id,lead_id,kind,title,notes,status,priority,starts_at,ends_at,due_at,created_by_staff_user_id)
      values(p_workspace_id,v_lead.id,v_kind,btrim(p_payload->>'title'),coalesce(p_payload->>'notes',''),v_status,p_payload->>'priority',v_start,v_end,v_due,p_staff_user_id)
      returning * into v_after;
    insert into public.mortgage_activity_requests(workspace_id,staff_user_id,request_id,activity_id,payload)
      values(p_workspace_id,p_staff_user_id,p_request_id,v_after.id,p_payload);
  else
    update public.mortgage_activities set title=btrim(p_payload->>'title'),notes=coalesce(p_payload->>'notes',''),status=v_status,
      priority=p_payload->>'priority',starts_at=v_start,ends_at=v_end,due_at=v_due,updated_at=clock_timestamp()
      where id=p_activity_id and workspace_id=p_workspace_id returning * into v_after;
  end if;
  if p_activity_id is null or v_before.status is distinct from v_status or v_before.title is distinct from v_after.title
    or v_before.notes is distinct from v_after.notes or v_before.starts_at is distinct from v_start or v_before.ends_at is distinct from v_end
    or v_before.due_at is distinct from v_due or v_before.priority is distinct from v_after.priority then
    insert into public.mortgage_activity_events(workspace_id,activity_id,actor_staff_user_id,action,title)
      values(p_workspace_id,v_after.id,p_staff_user_id,
        case when v_status in ('done','missed') and (p_activity_id is null or v_before.status is distinct from v_status) then v_status
          when p_activity_id is null then 'created' else 'updated' end,v_after.title);
  end if;
  return jsonb_build_object('id',v_after.id,'updatedAt',v_after.updated_at,'replayed',false);
end; $$;

alter table public.mortgage_activities enable row level security;
alter table public.mortgage_activity_events enable row level security;
alter table public.mortgage_activity_requests enable row level security;
alter table public.leads enable row level security;
grant select,insert,update on public.leads to service_role;
revoke all on public.mortgage_activities,public.mortgage_activity_events,public.mortgage_activity_requests from public,anon,authenticated;
grant select,insert,update,delete on public.mortgage_activities,public.mortgage_activity_events,public.mortgage_activity_requests to service_role;
revoke all on function public.save_mortgage_activity(uuid,uuid,uuid,uuid,timestamptz,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_mortgage_activity(uuid,uuid,uuid,uuid,timestamptz,uuid,jsonb) to service_role;
revoke all on function public.save_mortgage_admin_self_lead(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_mortgage_admin_self_lead(uuid,uuid,uuid,uuid,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
