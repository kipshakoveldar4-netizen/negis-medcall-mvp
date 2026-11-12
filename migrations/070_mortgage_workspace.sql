-- Local candidate only. Apply first to an explicitly approved isolated database.
begin;

create table if not exists public.mortgage_activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null references public.leads(id),
  kind text not null check (kind in ('meeting','task')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  notes text not null default '' check (char_length(notes) <= 10000),
  status text not null default 'open',
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  starts_at timestamptz, ends_at timestamptz, due_at timestamptz,
  created_by_staff_user_id uuid not null references public.staff_users(id),
  resolved_by_staff_user_id uuid references public.staff_users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((kind = 'meeting' and status in ('open','done','cancelled','missed') and starts_at is not null and ends_at is not null
    and ends_at - starts_at between interval '5 minutes' and interval '24 hours' and due_at is null)
    or (kind = 'task' and status in ('open','in_progress','done','cancelled') and starts_at is null and ends_at is null))
);
create index if not exists mortgage_activities_workspace_lead_idx on public.mortgage_activities(workspace_id,lead_id,created_at desc);
create index if not exists mortgage_activities_calendar_idx on public.mortgage_activities(workspace_id,starts_at,ends_at) where kind = 'meeting';
create table if not exists public.mortgage_activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  activity_id uuid not null references public.mortgage_activities(id),
  actor_staff_user_id uuid not null references public.staff_users(id),
  action text not null, title text not null, created_at timestamptz not null default clock_timestamp()
);
create index if not exists mortgage_activity_events_activity_idx on public.mortgage_activity_events(workspace_id,activity_id,created_at desc);
create table if not exists public.mortgage_activity_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  staff_user_id uuid not null references public.staff_users(id),
  request_id uuid not null,
  activity_id uuid not null references public.mortgage_activities(id),
  payload jsonb not null,
  primary key (workspace_id,staff_user_id,request_id)
);
alter table public.mortgage_activities enable row level security;
alter table public.mortgage_activity_events enable row level security;
alter table public.mortgage_activity_requests enable row level security;
revoke all on public.mortgage_activities,public.mortgage_activity_events,public.mortgage_activity_requests from public,anon,authenticated;
grant select,insert,update,delete on public.mortgage_activities,public.mortgage_activity_events,public.mortgage_activity_requests to service_role;

create or replace function public.mortgage_actor_role(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  select s.role::text into v_role from public.staff_users s
    where s.id=p_staff_user_id and s.workspace_id=p_workspace_id and s.auth_user_id=p_auth_user_id
      and s.status='active' and s.role in ('owner','admin','lead_manager') for share;
  if not found then raise exception using errcode='P7001',message='mortgage_access_denied'; end if;
  perform 1 from public.workspace_settings w where w.workspace_id=p_workspace_id
    and w.key='workspace_purpose' and w.value->>'purpose'='mortgage_leads' for share;
  if not found then
    raise exception using errcode='P7001',message='mortgage_access_denied';
  end if;
  return v_role;
end; $$;

create or replace function public.read_mortgage_workspace(
  p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_query text default '',p_page integer default 0,p_lead_id uuid default null,
  p_from timestamptz default null,p_to timestamptz default null,p_days integer default 30
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_role text; v_zone text; v_now timestamptz := statement_timestamp();
  v_from timestamptz; v_to timestamptz; v_period timestamptz;
  v_ids uuid[]; v_contacts jsonb; v_activities jsonb; v_members jsonb; v_events jsonb;
  v_metrics jsonb; v_member_metrics jsonb; v_count bigint; v_activity_count bigint;
begin
  v_role:=public.mortgage_actor_role(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if p_page is null or p_page<0 or p_page>100000 or char_length(coalesce(p_query,''))>100 or p_days is null or p_days not in (7,30,90) then
    raise exception using errcode='P7003',message='invalid_filter'; end if;
  select w.value->>'timeZone' into v_zone from public.workspace_settings w
    where w.workspace_id=p_workspace_id and w.key='clinic_schedule';
  if v_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_zone) then
    raise exception using errcode='P7008',message='timezone_not_configured'; end if;
  v_from:=coalesce(p_from,case when p_to is not null then p_to-interval '180 days' else v_now-interval '90 days' end);
  v_to:=coalesce(p_to,case when p_from is not null then p_from+interval '180 days' else v_now+interval '90 days' end);
  v_period:=v_now-make_interval(days=>p_days);
  if v_to<=v_from or v_to-v_from>interval '366 days' then raise exception using errcode='P7003',message='invalid_range'; end if;

  -- Locks close the reassignment window while this scoped snapshot is read.
  if v_role='lead_manager' then
    select coalesce(array_agg(owned.id),'{}'::uuid[]) into v_ids from (
      select l.id from public.leads l where l.workspace_id=p_workspace_id and l.responsible_user_id=p_staff_user_id for share
    ) owned;
  else
    select coalesce(array_agg(l.id),'{}'::uuid[]) into v_ids from public.leads l where l.workspace_id=p_workspace_id;
  end if;
  if p_lead_id is not null and not (p_lead_id=any(v_ids)) then raise exception using errcode='P7002',message='lead_not_found'; end if;

  select count(*) into v_count from public.leads l where l.workspace_id=p_workspace_id and l.id=any(v_ids)
    and (p_lead_id is null or l.id=p_lead_id)
    and (coalesce(p_query,'')='' or strpos(lower(coalesce(l.full_name,'')),lower(p_query))>0 or strpos(coalesce(l.phone,''),p_query)>0);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',l.id,'name',coalesce(l.full_name,''),'phone',coalesce(l.phone,''),'notes',coalesce(l.notes,''),'status',l.status,
    'source',coalesce(l.source,''),'createdAt',l.created_at,'updatedAt',l.updated_at,
    'responsibleUserId',l.responsible_user_id,'responsibleName',s.full_name) order by l.created_at desc,l.id),'[]'::jsonb)
    into v_contacts from (
      select * from public.leads c where c.workspace_id=p_workspace_id and c.id=any(v_ids)
        and (p_lead_id is null or c.id=p_lead_id)
        and (coalesce(p_query,'')='' or strpos(lower(coalesce(c.full_name,'')),lower(p_query))>0 or strpos(coalesce(c.phone,''),p_query)>0)
      order by c.created_at desc,c.id limit 100 offset p_page*100
    ) l left join public.staff_users s on s.id=l.responsible_user_id and s.workspace_id=p_workspace_id;

  select count(*) into v_activity_count from public.mortgage_activities a
    where a.workspace_id=p_workspace_id and a.lead_id=any(v_ids) and (p_lead_id is null or a.lead_id=p_lead_id)
      and ((p_lead_id is not null and p_from is null and p_to is null) or (a.kind='meeting' and a.starts_at<v_to and a.ends_at>v_from)
        or (a.kind='task' and (a.due_at is null or a.due_at between v_from and v_to or a.status in ('open','in_progress'))));
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'kind',a.kind,'leadId',a.lead_id,'title',a.title,'notes',a.notes,'status',a.status,'priority',a.priority,
    'startsAt',a.starts_at,'endsAt',a.ends_at,'dueAt',a.due_at,'createdAt',a.created_at,'updatedAt',a.updated_at,
    'contactName',coalesce(l.full_name,l.phone,''),'responsibleUserId',l.responsible_user_id,'responsibleName',s.full_name)
    order by coalesce(a.starts_at,a.due_at,a.created_at),a.id),'[]'::jsonb) into v_activities
    from (select * from public.mortgage_activities a where a.workspace_id=p_workspace_id and a.lead_id=any(v_ids)
      and (p_lead_id is null or a.lead_id=p_lead_id)
      and ((p_lead_id is not null and p_from is null and p_to is null) or (a.kind='meeting' and a.starts_at<v_to and a.ends_at>v_from)
        or (a.kind='task' and (a.due_at is null or a.due_at between v_from and v_to or a.status in ('open','in_progress'))))
      order by coalesce(a.starts_at,a.due_at,a.created_at),a.id limit 1000) a
    join public.leads l on l.id=a.lead_id and l.workspace_id=p_workspace_id
    left join public.staff_users s on s.id=l.responsible_user_id and s.workspace_id=p_workspace_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',coalesce(s.full_name,''),'role',s.role,'status',s.status)
    order by s.full_name,s.id),'[]'::jsonb) into v_members from public.staff_users s
    where s.workspace_id=p_workspace_id and s.role in ('owner','admin','lead_manager') and (v_role<>'lead_manager' or s.id=p_staff_user_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'activityId',e.activity_id,'action',e.action,'title',e.title,
    'actorName',coalesce(s.full_name,''),'createdAt',e.created_at) order by e.created_at desc,e.id),'[]'::jsonb) into v_events
    from (select e.* from public.mortgage_activity_events e join public.mortgage_activities a on a.id=e.activity_id and a.workspace_id=p_workspace_id
      where e.workspace_id=p_workspace_id and a.lead_id=any(v_ids) and (p_lead_id is null or a.lead_id=p_lead_id)
      order by e.created_at desc,e.id limit 200) e
    left join public.staff_users s on s.id=e.actor_staff_user_id and s.workspace_id=p_workspace_id;

  select jsonb_build_object('totalLeads',count(*),'unassignedLeads',count(*) filter(where l.responsible_user_id is null),
    'inProgressLeads',count(*) filter(where l.status='in_progress')) into v_metrics
    from public.leads l where l.workspace_id=p_workspace_id and l.id=any(v_ids);
  v_metrics:=v_metrics||jsonb_build_object(
    'meetingsToday',(select count(*) from public.mortgage_activities a where a.workspace_id=p_workspace_id and a.lead_id=any(v_ids)
      and a.kind='meeting' and a.status<>'cancelled' and (a.starts_at at time zone v_zone)::date=(v_now at time zone v_zone)::date),
    'overdueTasks',(select count(*) from public.mortgage_activities a where a.workspace_id=p_workspace_id and a.lead_id=any(v_ids)
      and a.kind='task' and a.status in ('open','in_progress') and a.due_at<v_now),
    'activeManagers',(select count(*) from public.staff_users s where s.workspace_id=p_workspace_id and s.role='lead_manager' and s.status='active'
      and (v_role<>'lead_manager' or s.id=p_staff_user_id)));
  if v_role<>'lead_manager' then
    select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',coalesce(s.full_name,''),'role',s.role,
      'assignedLeads',(select count(*) from public.leads l where l.workspace_id=p_workspace_id and l.responsible_user_id=s.id),
      'openTasks',(select count(*) from public.mortgage_activities a join public.leads l on l.id=a.lead_id and l.workspace_id=p_workspace_id
        where a.workspace_id=p_workspace_id and l.responsible_user_id=s.id and a.kind='task' and a.status in ('open','in_progress')),
      'overdueTasks',(select count(*) from public.mortgage_activities a join public.leads l on l.id=a.lead_id and l.workspace_id=p_workspace_id
        where a.workspace_id=p_workspace_id and l.responsible_user_id=s.id and a.kind='task' and a.status in ('open','in_progress') and a.due_at<v_now),
      'plannedMeetings',(select count(*) from public.mortgage_activities a join public.leads l on l.id=a.lead_id and l.workspace_id=p_workspace_id
        where a.workspace_id=p_workspace_id and l.responsible_user_id=s.id and a.kind='meeting' and a.status='open'),
      'doneTasks',(select count(distinct e.activity_id) from public.mortgage_activity_events e join public.mortgage_activities a on a.id=e.activity_id and a.workspace_id=p_workspace_id
        where e.workspace_id=p_workspace_id and e.actor_staff_user_id=s.id and e.action='done' and a.kind='task' and e.created_at between v_period and v_now),
      'doneMeetings',(select count(distinct e.activity_id) from public.mortgage_activity_events e join public.mortgage_activities a on a.id=e.activity_id and a.workspace_id=p_workspace_id
        where e.workspace_id=p_workspace_id and e.actor_staff_user_id=s.id and e.action='done' and a.kind='meeting' and e.created_at between v_period and v_now),
      'missedMeetings',(select count(distinct e.activity_id) from public.mortgage_activity_events e join public.mortgage_activities a on a.id=e.activity_id and a.workspace_id=p_workspace_id
        where e.workspace_id=p_workspace_id and e.actor_staff_user_id=s.id and e.action='missed' and a.kind='meeting' and e.created_at between v_period and v_now)
    ) order by s.full_name,s.id),'[]'::jsonb) into v_member_metrics
    from public.staff_users s where s.workspace_id=p_workspace_id and s.role in ('owner','admin','lead_manager');
  else v_member_metrics:='[]'::jsonb; end if;
  return jsonb_build_object('timeZone',v_zone,'contacts',v_contacts,'contactsTotal',v_count,'page',p_page,'pageSize',100,
    'activities',v_activities,'activitiesTruncated',v_activity_count>1000,'members',v_members,'events',v_events,
    'metrics',v_metrics,'memberMetrics',v_member_metrics,'periodDays',p_days);
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
    perform 1 from public.staff_users s where s.id=v_lead.responsible_user_id and s.workspace_id=p_workspace_id and s.role='lead_manager' and s.status='active' for share;
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

revoke all on function public.mortgage_actor_role(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.read_mortgage_workspace(uuid,uuid,uuid,text,integer,uuid,timestamptz,timestamptz,integer) from public,anon,authenticated;
revoke all on function public.save_mortgage_activity(uuid,uuid,uuid,uuid,timestamptz,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.mortgage_actor_role(uuid,uuid,uuid) to service_role;
grant execute on function public.read_mortgage_workspace(uuid,uuid,uuid,text,integer,uuid,timestamptz,timestamptz,integer) to service_role;
grant execute on function public.save_mortgage_activity(uuid,uuid,uuid,uuid,timestamptz,uuid,jsonb) to service_role;
commit;
