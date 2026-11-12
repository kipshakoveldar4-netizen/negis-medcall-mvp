-- Local candidate. Requires 029 and 070; never applies to live workspaces implicitly.
begin;

do $$
begin
  if to_regprocedure('public.mortgage_actor_role(uuid,uuid,uuid)') is null
    or to_regclass('public.workspace_settings') is null
    or to_regclass('public.lead_stages') is null
    or to_regclass('public.leads') is null
    or not exists (select 1 from information_schema.columns where table_schema='public'
      and table_name='audit_logs' and column_name='actor_staff_user_id')
    or not exists (select 1 from information_schema.columns where table_schema='public'
      and table_name='audit_logs' and column_name='actor_kind') then
    raise exception 'lead_team_analytics_dependencies_missing';
  end if;
end; $$;

-- STABLE inherits the enclosing SELECT snapshot. A failed journal read must
-- not invent zero activity or hide an otherwise complete workload report.
create or replace function public.read_lead_team_activity_snapshot(
  p_workspace_id uuid,p_from timestamptz,p_to timestamptz
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_result jsonb;
  v_trim constant text:=E' \t\n\r\f\013'||U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  with events as materialized (
    select e.actor_staff_user_id,e.entity_id,e.action,e.created_at from public.audit_logs e
      where e.workspace_id=p_workspace_id and e.entity_type='lead' and e.actor_kind='manual'
        and e.action in ('created','updated') and e.created_at between p_from and p_to limit 30001
  ), actors as (
    select actor_staff_user_id as id,count(*) filter(where action='created') as created,
      count(*) filter(where action='updated') as updated,count(distinct lower(btrim(entity_id,v_trim))) as touched,
      max(created_at) as last_at,
      bool_and(entity_id is not null and btrim(entity_id,v_trim) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') as valid
      from events group by actor_staff_user_id
  ) select jsonb_build_object('complete',(select count(*) from events)<=30000,
    'actors',coalesce((select jsonb_agg(to_jsonb(a)) from actors a),'[]'::jsonb)) into v_result;
  return v_result;
exception when others then
  return jsonb_build_object('complete',false,'actors','[]'::jsonb);
end; $$;
revoke all on function public.read_lead_team_activity_snapshot(uuid,timestamptz,timestamptz) from public,anon,authenticated,service_role;

create or replace function public.read_lead_team_analytics(
  p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_days integer default 30
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_role text; v_now timestamptz:=statement_timestamp(); v_from timestamptz;
  v_result jsonb; v_core_complete boolean;
  v_trim constant text:=E' \t\n\r\f\013'||U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  -- The existing helper holds the membership and purpose rows FOR SHARE until
  -- this transaction finishes, so revocation cannot cross an accepted identity.
  v_role:=public.mortgage_actor_role(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if v_role not in ('owner','admin') then
    raise exception using errcode='P7001',message='mortgage_access_denied';
  end if;
  if p_days is null or p_days not in (7,30,90) then
    raise exception using errcode='P8303',message='invalid_period';
  end if;
  v_from:=v_now-p_days*interval '24 hours';

  -- Every business-data read belongs to this one statement/MVCC snapshot.
  -- Cap+1 samples bound the work but are never exposed as complete totals.
  with staff as materialized (
    select s.id,s.full_name,s.role,s.status from public.staff_users s
      where s.workspace_id=p_workspace_id limit 1001
  ), stages as materialized (
    select s.id,s.semantic_group from public.lead_stages s
      where s.workspace_id=p_workspace_id limit 1001
  ), leads as materialized (
    select l.id,l.responsible_user_id,l.status,l.stage_id from public.leads l
      where l.workspace_id=p_workspace_id limit 20001
  ), activity_snapshot as materialized (
    select public.read_lead_team_activity_snapshot(p_workspace_id,v_from,v_now) as value
  ), activity_rows as materialized (
    select a.* from jsonb_to_recordset((select value->'actors' from activity_snapshot))
      as a(id uuid,created bigint,updated bigint,touched bigint,last_at timestamptz,valid boolean)
  ), members as materialized (
    select * from staff where role in ('owner','admin','lead_manager')
  ), classified as (
    select l.id,l.responsible_user_id,
      coalesce(nullif(btrim(s.semantic_group,v_trim),''),translate(btrim(coalesce(l.status,''),v_trim),
        'ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
        'abcdefghijklmnopqrstuvwxyzабвгдеёжзийклмнопрстуфхцчшщъыьэюя')) as bucket
      from leads l left join stages s on s.id=l.stage_id
  ), activity_quality as (
    select (select (value->>'complete')::boolean from activity_snapshot) and not exists (
      select 1 from activity_rows a join members m on m.id=a.id where not a.valid
    ) as available
  ), workload as (
    select m.id,count(l.id) as total,
      count(l.id) filter(where l.bucket in ('new','новая')) as fresh,
      count(l.id) filter(where l.bucket in ('in_progress','в работе')) as in_progress,
      count(l.id) filter(where l.bucket in ('booked','записана')) as booked,
      count(l.id) filter(where l.bucket in ('postponed','deferred','отложена','отложенные','отложено','отложен')) as postponed,
      count(l.id) filter(where l.bucket in ('lost','потеряна')) as lost
      from members m left join classified l on l.responsible_user_id=m.id group by m.id
  ), activity as (
    select m.id,coalesce(a.created,0) as created,coalesce(a.updated,0) as updated,
      coalesce(a.touched,0) as touched,a.last_at
      from members m left join activity_rows a on a.id=m.id
  ) select jsonb_build_object(
    'workspaceId',p_workspace_id,'generatedAt',v_now,'period',jsonb_build_object('days',p_days,'from',v_from,'to',v_now),
    'totalLeads',(select count(*) from leads),
    'unassignedLeads',(select count(*) from leads where responsible_user_id is null),
    'otherAssigneeLeads',(select count(*) from leads l where l.responsible_user_id is not null
      and not exists(select 1 from members m where m.id=l.responsible_user_id)),
    'activityStatus',case when q.available then 'available' else 'unavailable' end,
    'members',coalesce((select jsonb_agg(jsonb_build_object(
      'staffId',m.id,'name',coalesce(nullif(btrim(m.full_name,v_trim),''),'Сотрудник'),'role',m.role,'status',m.status,
      'assigned',jsonb_build_object('total',w.total,'new',w.fresh,'inProgress',w.in_progress,'booked',w.booked,
        'postponed',w.postponed,'lost',w.lost,'other',w.total-w.fresh-w.in_progress-w.booked-w.postponed-w.lost),
      'activity',case when q.available then jsonb_build_object('createdEvents',a.created,'updatedEvents',a.updated,
        'touchedLeads',a.touched,'lastRecordedAt',a.last_at) else null end
    ) order by m.full_name,m.id) from members m join workload w on w.id=m.id join activity a on a.id=m.id),'[]'::jsonb)
  ), (select count(*) from staff)<=1000 and (select count(*) from stages)<=1000 and (select count(*) from leads)<=20000
  into v_result,v_core_complete from activity_quality q;
  if not v_core_complete then
    raise exception using errcode='P8304',message='analytics_incomplete';
  end if;
  return v_result;
end; $$;

revoke all on function public.read_lead_team_analytics(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_lead_team_analytics(uuid,uuid,uuid,integer) to service_role;
notify pgrst,'reload schema';
commit;
