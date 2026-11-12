-- Local candidate after 070/078; no business-data, formula, role or tenant changes.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $guard$
declare v_signature text; v_hashes text[]; v_current text;
begin
  if current_user<>'postgres' then raise exception 'mortgage_report_clock_dependencies_unconfirmed'; end if;
  for v_signature,v_hashes in select * from (values
    ('public.read_mortgage_workspace(uuid,uuid,uuid,text,integer,uuid,timestamp with time zone,timestamp with time zone,integer)',array['f7cfbdf21b042a303c98bc23f1aee6e536190954369b80cbb8f2b8275d32b54a','f617e0776d8c2323c5a5b4e9b0210c27455faf02e22cd51d22e5ebf111a4d177']),
    ('public.read_mortgage_results(uuid,uuid,uuid,integer)',array['ba42c347cdd9f9b25ce119cce3912fe8b2184b75d66cf6431475f347708f5514','655c80e9b84f039a95aa40fe3e946eef5f9561e192c52539ba3833738c20e9fb']),
    ('public.mortgage_actor_role(uuid,uuid,uuid)',array['a3c9bd5b6b174a158748d93474193fcb3a76aad034d8e7cbca087544b38528be'])
  ) expected(signature,hashes) loop
    select encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex') into v_current
      from pg_proc p where p.oid=to_regprocedure(v_signature) and p.proowner=to_regrole('postgres')
        and p.prosecdef and p.provolatile='v' and p.proconfig=array['search_path=""']::text[];
    if v_current is null or not(v_current=any(v_hashes)) then
      raise exception 'mortgage_report_clock_dependencies_unconfirmed'; end if;
    if not exists(select 1 from pg_roles where rolname='service_role'
      and has_function_privilege(oid,v_signature,'EXECUTE'))
      or exists(select 1 from pg_roles where rolname in ('anon','authenticated')
      and has_function_privilege(oid,v_signature,'EXECUTE')) then
      raise exception 'mortgage_report_clock_acl_unconfirmed'; end if;
  end loop;
end $guard$;

create or replace function public.read_mortgage_workspace(
  p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_query text default '',p_page integer default 0,p_lead_id uuid default null,
  p_from timestamptz default null,p_to timestamptz default null,p_days integer default 30
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_role text; v_zone text; v_now timestamptz;
  v_from timestamptz; v_to timestamptz; v_period timestamptz;
  v_ids uuid[]; v_contacts jsonb; v_activities jsonb; v_members jsonb; v_events jsonb;
  v_metrics jsonb; v_member_metrics jsonb; v_count bigint; v_activity_count bigint;
begin
  v_role:=public.mortgage_actor_role(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if p_page is null or p_page<0 or p_page>100000 or char_length(coalesce(p_query,''))>100 or p_days is null or p_days not in (7,30,90) then
    raise exception using errcode='P7003',message='invalid_filter'; end if;
  select w.value->>'timeZone' into v_zone from public.workspace_settings w
    where w.workspace_id=p_workspace_id and w.key='clinic_schedule' for share;
  if v_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_zone) then
    raise exception using errcode='P7008',message='timezone_not_configured'; end if;

  -- Locks close the reassignment window while this scoped snapshot is read.
  if v_role='lead_manager' then
    select coalesce(array_agg(owned.id),'{}'::uuid[]) into v_ids from (
      select l.id from public.leads l where l.workspace_id=p_workspace_id and l.responsible_user_id=p_staff_user_id for share
    ) owned;
  else
    select coalesce(array_agg(l.id),'{}'::uuid[]) into v_ids from public.leads l where l.workspace_id=p_workspace_id;
  end if;
  if p_lead_id is not null and not (p_lead_id=any(v_ids)) then raise exception using errcode='P7002',message='lead_not_found'; end if;

  -- Capture after membership, purpose, timezone and own-lead authorization waits.
  v_now:=clock_timestamp();
  v_from:=coalesce(p_from,case when p_to is not null then p_to-interval '180 days' else v_now-interval '90 days' end);
  v_to:=coalesce(p_to,case when p_from is not null then p_from+interval '180 days' else v_now+interval '90 days' end);
  v_period:=v_now-p_days*interval '24 hours';
  if v_to<=v_from or v_to-v_from>interval '366 days' then raise exception using errcode='P7003',message='invalid_range'; end if;

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
    'metrics',v_metrics,'memberMetrics',v_member_metrics,'periodDays',p_days,
    'generatedAt',v_now,'period',jsonb_build_object('days',p_days,'from',v_period,'to',v_now));
end; $$;

create or replace function public.read_mortgage_results(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_days integer default 30)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_result jsonb;
begin
  v_role:=public.mortgage_actor_role(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if v_role not in ('owner','admin') then raise exception using errcode='P7001',message='mortgage_access_denied'; end if;
  if p_days is null or p_days not in (7,30,90) then raise exception using errcode='P7803',message='invalid_period'; end if;
  -- One post-authorization clock inside the same business-data statement.
  with report_clock as materialized (select clock_timestamp() as at), portfolio as (
    select l.id,l.responsible_user_id,
      exists(select 1 from public.mortgage_activities a where a.workspace_id=p_workspace_id and a.lead_id=l.id
        and a.kind='meeting' and a.status='done' and a.ends_at<=(select at from report_clock)) as held,
      exists(select 1 from public.mortgage_signed_contracts c where c.workspace_id=p_workspace_id and c.lead_id=l.id and c.voided_at is null and c.signed_at<=(select at from report_clock)) as signed,
      exists(select 1 from public.mortgage_signed_contracts c join public.mortgage_activities a
        on a.workspace_id=p_workspace_id and a.lead_id=c.lead_id and a.kind='meeting' and a.status='done' and a.ends_at<=c.signed_at
        where c.workspace_id=p_workspace_id and c.lead_id=l.id and c.voided_at is null and c.signed_at<=(select at from report_clock)) as converted
      from public.leads l where l.workspace_id=p_workspace_id
  ), members as (
    select s.id,s.full_name,s.role,s.status,
      (select count(*) from portfolio p where p.responsible_user_id=s.id) as assigned,
      (select count(*) from portfolio p where p.responsible_user_id=s.id and p.held) as held,
      (select count(*) from portfolio p where p.responsible_user_id=s.id and p.signed) as signed,
      (select count(*) from portfolio p where p.responsible_user_id=s.id and p.converted) as held_signed,
      (select count(*) from public.mortgage_signed_contracts c where c.workspace_id=p_workspace_id and c.responsible_staff_user_id=s.id
        and c.voided_at is null and c.signed_at between (select at-p_days*interval '24 hours' from report_clock) and (select at from report_clock)) as signed_in_period
    from public.staff_users s where s.workspace_id=p_workspace_id and s.role in ('owner','admin','lead_manager')
  ) select jsonb_build_object('generatedAt',c.at,'period',jsonb_build_object('days',p_days,'from',c.at-p_days*interval '24 hours','to',c.at),
    'unassignedLeads',(select count(*) from portfolio p where p.responsible_user_id is null),
    'otherAssigneeLeads',(select count(*) from portfolio p where p.responsible_user_id is not null and not exists(select 1 from members s where s.id=p.responsible_user_id)),
    'members',coalesce((select jsonb_agg(jsonb_build_object('staffId',m.id,'name',coalesce(m.full_name,''),'role',m.role,'status',m.status,
      'assignedLeads',m.assigned,'heldLeads',m.held,'signedLeads',m.signed,'heldSignedLeads',m.held_signed,'signedInPeriod',m.signed_in_period)
      order by m.full_name,m.id) from members m),'[]'::jsonb)) into v_result from report_clock c;
  return v_result;
end; $$;

revoke all on function public.read_mortgage_workspace(uuid,uuid,uuid,text,integer,uuid,timestamp with time zone,timestamp with time zone,integer),public.read_mortgage_results(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_mortgage_workspace(uuid,uuid,uuid,text,integer,uuid,timestamp with time zone,timestamp with time zone,integer),public.read_mortgage_results(uuid,uuid,uuid,integer) to service_role;
commit;
notify pgrst,'reload schema';
