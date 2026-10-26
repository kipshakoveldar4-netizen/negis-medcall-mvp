-- Local candidate after 095/103. Report-owned timezone; no settings/data/role changes.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $guard$
declare v_signature text; v_hashes text[]; v_current text;
begin
  if current_user<>'postgres' then raise exception 'analytics_timezone_dependencies_unconfirmed'; end if;
  for v_signature,v_hashes in select * from (values
    ('public.read_lead_team_analytics(uuid,uuid,uuid,integer)',array['89ed713eea73bfb167fbb6c3bd89b9c86fbf7b73643a0d6eb6a7f9df1c9a64a6','54700f304954a2124cf19b21b6a2520d048a49e444a3f1e4cd6e9f22a7f57497']),
    ('public.read_mortgage_results(uuid,uuid,uuid,integer)',array['655c80e9b84f039a95aa40fe3e946eef5f9561e192c52539ba3833738c20e9fb','14c2e75845a2b0b2652bbc2dde29259a3b00715189d79056f55a1ecb97084b01']),
    ('public.mortgage_actor_role(uuid,uuid,uuid)',array['a3c9bd5b6b174a158748d93474193fcb3a76aad034d8e7cbca087544b38528be'])
  ) expected(signature,hashes) loop
    select encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex') into v_current
      from pg_proc p where p.oid=to_regprocedure(v_signature) and p.proowner=to_regrole('postgres')
        and p.prosecdef and p.provolatile='v' and p.proconfig=array['search_path=""']::text[];
    if v_current is null or not(v_current=any(v_hashes)) then
      raise exception 'analytics_timezone_dependencies_unconfirmed'; end if;
    if not exists(select 1 from pg_roles where rolname='service_role' and has_function_privilege(oid,v_signature,'EXECUTE'))
      or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and has_function_privilege(oid,v_signature,'EXECUTE'))
      then raise exception 'analytics_timezone_acl_unconfirmed'; end if;
  end loop;
end $guard$;

create or replace function public.read_lead_team_analytics(
  p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_days integer default 30
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_role text; v_zone text;
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
  select w.value->>'timeZone' into v_zone from public.workspace_settings w
    where w.workspace_id=p_workspace_id and w.key='clinic_schedule' for share;
  if v_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_zone) then
    raise exception using errcode='P7008',message='timezone_not_configured'; end if;
  -- Every business-data read belongs to this one statement/MVCC snapshot.
  -- Cap+1 samples bound the work but are never exposed as complete totals.
  -- Capture time inside that statement, after authorization and its lock waits,
  -- so a separate clock assignment cannot precede the business snapshot either.
  with report_clock as materialized (
    select clock_timestamp() as at
  ), staff as materialized (
    select s.id,s.full_name,s.role,s.status from public.staff_users s
      where s.workspace_id=p_workspace_id limit 1001
  ), stages as materialized (
    select s.id,s.semantic_group from public.lead_stages s
      where s.workspace_id=p_workspace_id limit 1001
  ), leads as materialized (
    select l.id,l.responsible_user_id,l.status,l.stage_id from public.leads l
      where l.workspace_id=p_workspace_id limit 20001
  ), activity_snapshot as materialized (
    select public.read_lead_team_activity_snapshot(p_workspace_id,
      c.at-p_days*interval '24 hours',c.at) as value from report_clock c
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
    'workspaceId',p_workspace_id,'timeZone',v_zone,'generatedAt',c.at,'period',jsonb_build_object('days',p_days,'from',c.at-p_days*interval '24 hours','to',c.at),
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
  into v_result,v_core_complete from activity_quality q cross join report_clock c;
  if not v_core_complete then
    raise exception using errcode='P8304',message='analytics_incomplete';
  end if;
  return v_result;
end; $$;

create or replace function public.read_mortgage_results(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_days integer default 30)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_zone text; v_result jsonb;
begin
  v_role:=public.mortgage_actor_role(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if v_role not in ('owner','admin') then raise exception using errcode='P7001',message='mortgage_access_denied'; end if;
  if p_days is null or p_days not in (7,30,90) then raise exception using errcode='P7803',message='invalid_period'; end if;
  select w.value->>'timeZone' into v_zone from public.workspace_settings w
    where w.workspace_id=p_workspace_id and w.key='clinic_schedule' for share;
  if v_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_zone) then
    raise exception using errcode='P7008',message='timezone_not_configured'; end if;
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
  ) select jsonb_build_object('timeZone',v_zone,'generatedAt',c.at,'period',jsonb_build_object('days',p_days,'from',c.at-p_days*interval '24 hours','to',c.at),
    'unassignedLeads',(select count(*) from portfolio p where p.responsible_user_id is null),
    'otherAssigneeLeads',(select count(*) from portfolio p where p.responsible_user_id is not null and not exists(select 1 from members s where s.id=p.responsible_user_id)),
    'members',coalesce((select jsonb_agg(jsonb_build_object('staffId',m.id,'name',coalesce(m.full_name,''),'role',m.role,'status',m.status,
      'assignedLeads',m.assigned,'heldLeads',m.held,'signedLeads',m.signed,'heldSignedLeads',m.held_signed,'signedInPeriod',m.signed_in_period)
      order by m.full_name,m.id) from members m),'[]'::jsonb)) into v_result from report_clock c;
  return v_result;
end; $$;

revoke all on function public.read_lead_team_analytics(uuid,uuid,uuid,integer),public.read_mortgage_results(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_lead_team_analytics(uuid,uuid,uuid,integer),public.read_mortgage_results(uuid,uuid,uuid,integer) to service_role;
commit;
notify pgrst,'reload schema';
