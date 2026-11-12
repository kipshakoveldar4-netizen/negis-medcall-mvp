-- Complete own-operator workday read; no memberships, contacts events or money writes.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare relation text; dependency record; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'operator_workday_dependencies_unconfirmed'; end if;
  foreach relation in array array['growth_operator_profiles','growth_operator_requests','growth_operator_lead_assignments',
    'growth_operator_bookings','growth_operator_arrivals','workspaces','workspace_settings','leads','appointments','clinic_doctors','clinic_services'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||relation) and relkind='r'
      and relowner=to_regrole('postgres') and relrowsecurity)
      then raise exception 'operator_workday_dependencies_unconfirmed'; end if;
  end loop;
  -- These authority writers share the request-before-profile lock order.
  for dependency in select * from (values
    ('public.transition_growth_operator_request(uuid,uuid,text)','d8e84b433185d5d6382c4fd6497bfe2d8e4d516defbefd17ce121d699890c207','uuid'),
    ('public.set_growth_operator_lead_assignment(uuid,uuid,uuid,boolean)','1414aecb54c86ab00265e57f313373e4752dbfa80b16e46bc61fc841b3e0fd34','void'),
    ('public.operator_booking_workspace(uuid,uuid,uuid)','190bebc20cff64517c89233d96fd198b4cab40944369183a60a6180bccc19386','uuid')
  ) expected(signature,digest,result_type) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef and p.provolatile='v' and not p.proretset and p.prorettype=to_regtype(dependency.result_type)
      and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'operator_workday_dependencies_unconfirmed'; end if;
  end loop;
end $$;

create index if not exists growth_operator_bookings_workday_idx
  on public.growth_operator_bookings(operator_request_id,workspace_id,appointment_id);

create or replace function public.operator_workday_zone(p_zone text)
returns text language plpgsql stable security invoker set search_path='' as $$
begin
  -- Abbreviations such as CST have different meanings in PostgreSQL and Intl.
  -- Accept supported geographic/Etc paths and explicit UTC/GMT only.
  if p_zone is null or char_length(p_zone) not between 1 and 80
    or p_zone!~'^(UTC|GMT|(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Etc|Europe|Indian|Pacific)/[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*)$'
    then return null; end if;
  -- Validate only configured names through PostgreSQL's native converter. A
  -- full pg_timezone_names enumeration per read is unnecessary and expensive.
  perform pg_catalog.timezone(p_zone,'2000-01-01T00:00:00Z'::timestamptz);
  return p_zone;
exception when invalid_parameter_value then return null;
end $$;
revoke all on function public.operator_workday_zone(text) from public,anon,authenticated,service_role;

-- PostgreSQL's midnight cast chooses the later occurrence of a folded midnight.
-- Find the boundary through the native zone engine; never assume a 24-hour day.
create or replace function public.operator_workday_day_start(p_day date,p_zone text)
returns timestamptz language plpgsql stable security invoker set search_path='' as $$
declare lo timestamptz; hi timestamptz; midpoint timestamptz;
begin
  if p_day is null or not isfinite(p_day) or public.operator_workday_zone(p_zone) is null
    then raise exception using errcode='P1232',message='operator_workday_unconfirmed'; end if;
  hi:=p_day::timestamp at time zone p_zone;
  if (hi at time zone p_zone)::date>=p_day and ((hi-interval '1 microsecond') at time zone p_zone)::date<p_day then return hi; end if;
  lo:=hi-interval '2 days';
  if (lo at time zone p_zone)::date>=p_day or (hi at time zone p_zone)::date<p_day
    then raise exception using errcode='P1232',message='operator_workday_unconfirmed'; end if;
  while hi-lo>interval '1 microsecond' loop
    midpoint:=lo+(hi-lo)/2;
    if (midpoint at time zone p_zone)::date>=p_day then hi:=midpoint; else lo:=midpoint; end if;
  end loop;
  if ((hi-interval '1 microsecond') at time zone p_zone)::date>=p_day or (hi at time zone p_zone)::date<p_day
    then raise exception using errcode='P1232',message='operator_workday_unconfirmed'; end if;
  return hi;
end $$;
revoke all on function public.operator_workday_day_start(date,text) from public,anon,authenticated,service_role;

create or replace function public.read_growth_operator_workday(p_actor uuid,p_offset integer default 0)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare v_operator uuid; v_request uuid; v_locked uuid[]:='{}'::uuid[]; v_result jsonb; v_consistent boolean;
begin
  if p_offset is null or p_offset<0 or p_offset>1000000
    then raise exception using errcode='P1233',message='operator_workday_query_invalid'; end if;
  if current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P1232',message='operator_workday_unconfirmed'; end if;
  select p.id into v_operator from public.growth_operator_profiles p where p.auth_user_id=p_actor and p.status='approved';
  if not found then raise exception using errcode='P1231',message='operator_workday_access_denied'; end if;
  -- Match existing writers: requests first, profile second. No profile-first
  -- lock inversion and no authorization based on an inbox page from the browser.
  for v_request in select q.id from public.growth_operator_requests q
    where q.operator_id=v_operator and q.status='accepted' order by q.id limit 1001 for share loop
    v_locked:=array_append(v_locked,v_request);
  end loop;
  if cardinality(v_locked)>1000 then raise exception using errcode='P1232',message='operator_workday_unconfirmed'; end if;
  perform 1 from public.growth_operator_profiles p where p.id=v_operator and p.auth_user_id=p_actor and p.status='approved' for share;
  if not found then raise exception using errcode='P1231',message='operator_workday_access_denied'; end if;
  -- All business data, completeness checks, totals and page use ONE subsequent
  -- READ COMMITTED snapshot. A newly accepted, not-locked request refuses the
  -- whole report instead of silently supplying a partial company manifest.
  with report_clock as materialized (select clock_timestamp() at_time), eligible_raw as materialized (
    select q.id request_id,q.workspace_id,q.lead_scope,w.name,
      case when jsonb_typeof(s.value->'timeZone')='string'
        and char_length(s.value->>'timeZone') between 1 and 80
        then s.value->>'timeZone' else null end proposed_zone
    from public.growth_operator_requests q join public.workspaces w on w.id=q.workspace_id
    left join public.workspace_settings s on s.workspace_id=q.workspace_id and s.key='clinic_schedule'
    where q.operator_id=v_operator and q.status='accepted'
  ), configured_zones as materialized (
    select distinct proposed_zone from eligible_raw where proposed_zone is not null
  ), zone_catalog as materialized (
    select proposed_zone,public.operator_workday_zone(proposed_zone) time_zone from configured_zones
  ), eligible as materialized (
    select e.request_id,e.workspace_id,e.lead_scope,e.name,z.time_zone from eligible_raw e
      left join zone_catalog z on z.proposed_zone=e.proposed_zone
  ), days as materialized (
    select *,case when time_zone is not null then ((select at_time from report_clock) at time zone time_zone)::date end local_day
    from eligible
  ), companies as materialized (
    select *,case when time_zone is not null then public.operator_workday_day_start(local_day,time_zone) end day_start,
      case when time_zone is not null then public.operator_workday_day_start(local_day+1,time_zone) end day_end from days
  ), accessible as materialized (
    select c.request_id,c.workspace_id,c.lead_scope,l.id lead_id,l.full_name client_name,l.phone client_phone
    from companies c join public.leads l on l.workspace_id=c.workspace_id
    where c.lead_scope='clinic' or exists(select 1 from public.growth_operator_lead_assignments x
      where x.operator_request_id=c.request_id and x.workspace_id=c.workspace_id and x.lead_id=l.id and x.assigned)
  ), bookings as materialized (
    select b.operator_request_id request_id,b.workspace_id,b.lead_id,b.appointment_id,
      a.starts_at,a.duration_minutes,a.status,
      coalesce((select string_agg(s.name,' / ' order by item.position)
        from unnest(b.service_ids) with ordinality item(id,position) join public.clinic_services s
        on s.id=item.id and s.workspace_id=b.workspace_id and s.is_active and (s.doctor_id is null or s.doctor_id=b.doctor_id)
        where exists(select 1 from public.clinic_doctors d where d.id=b.doctor_id and d.workspace_id=b.workspace_id and d.is_active)), '') service,
      coalesce((select d.full_name from public.clinic_doctors d where d.id=b.doctor_id and d.workspace_id=b.workspace_id and d.is_active),'') doctor_name
    from companies c join public.growth_operator_bookings b on b.operator_request_id=c.request_id and b.workspace_id=c.workspace_id
    join public.appointments a on a.id=b.appointment_id and a.workspace_id=b.workspace_id
  ), confirmations as materialized (
    select r.* from public.growth_operator_arrivals r join bookings b on b.request_id=r.operator_request_id
      and b.workspace_id=r.workspace_id and b.appointment_id=r.appointment_id
  ), today as materialized (
    select b.*,c.time_zone,c.day_start,c.day_end,x.client_name,x.client_phone,r.clinic_confirmed_at,r.operator_check_result
    from bookings b join companies c on c.request_id=b.request_id
    join accessible x on x.request_id=b.request_id and x.lead_id=b.lead_id and x.workspace_id=b.workspace_id
    left join confirmations r on r.operator_request_id=b.request_id and r.workspace_id=b.workspace_id and r.appointment_id=b.appointment_id
    where isfinite(b.starts_at) and b.starts_at>=c.day_start and b.starts_at<c.day_end
  ), selected as (
    select * from today order by starts_at,request_id,appointment_id offset p_offset limit 20
  ) select
    not exists(select 1 from eligible where not(request_id=any(v_locked)) or lead_scope not in ('assigned','clinic')
      or name is null or char_length(btrim(name)) not between 1 and 200)
    and (select count(*) from eligible)=cardinality(v_locked)
    and (select count(*) from eligible)=(select count(distinct workspace_id) from eligible)
    and not exists(select 1 from public.growth_operator_bookings b join eligible c on c.request_id=b.operator_request_id and c.workspace_id=b.workspace_id
      where not exists(select 1 from public.appointments a where a.id=b.appointment_id and a.workspace_id=b.workspace_id))
    and not exists(select 1 from public.growth_operator_arrivals r join eligible c on c.request_id=r.operator_request_id and c.workspace_id=r.workspace_id
      where not exists(select 1 from bookings b where b.request_id=r.operator_request_id and b.workspace_id=r.workspace_id and b.appointment_id=r.appointment_id))
    and not exists(select 1 from confirmations where not isfinite(clinic_confirmed_at)
      or (operator_checked_at is null)<>(operator_check_result is null)
      or operator_check_result not in ('confirmed','unconfirmed','unreachable')
      or (operator_checked_at is not null and not isfinite(operator_checked_at))),
    jsonb_build_object(
      'generatedAt',(select to_char(at_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from report_clock),
      'offset',p_offset,
      'companies',(select coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'displayName',name,'leadScope',lead_scope,
        'timeZone',time_zone,'localDate',to_char(local_day,'YYYY-MM-DD'),
        'dayStart',to_char(day_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'dayEnd',to_char(day_end at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by request_id),'[]'::jsonb) from companies),
      'summary',jsonb_build_object(
        'availableLeads',(select count(*)::text from accessible),
        'assignedLeads',(select count(*)::text from accessible where lead_scope='assigned'),
        'clinicLeads',(select count(*)::text from accessible where lead_scope='clinic'),
        'attributedBookings',(select count(*)::text from bookings),
        'clinicConfirmedArrivals',(select count(*)::text from confirmations),
        'undatedBookings',(select count(*)::text from bookings where starts_at is null or not isfinite(starts_at)),
        'bookingStatuses',jsonb_build_object(
          'scheduled',(select count(*)::text from bookings where lower(btrim(coalesce(status,'')))='scheduled'),
          'confirmed',(select count(*)::text from bookings where lower(btrim(coalesce(status,'')))='confirmed'),
          'arrived',(select count(*)::text from bookings where lower(btrim(coalesce(status,'')))='arrived'),
          'no_show',(select count(*)::text from bookings where lower(btrim(coalesce(status,'')))='no_show'),
          'cancelled',(select count(*)::text from bookings where lower(btrim(coalesce(status,'')))='cancelled'),
          'unknown',(select count(*)::text from bookings where lower(btrim(coalesce(status,''))) not in ('scheduled','confirmed','arrived','no_show','cancelled'))),
        'contacts','not_tracked'),
      'today',case when exists(select 1 from companies where time_zone is null) then
        jsonb_build_object('state','unavailable_timezone','total',null,'actionable',null,'items','[]'::jsonb,'hasMore',false)
      else jsonb_build_object('state','ready','total',(select count(*)::text from today),
        'actionable',(select count(*)::text from today where lower(btrim(coalesce(status,''))) in ('scheduled','confirmed')),
        'items',(select coalesce(jsonb_agg(jsonb_build_object(
          'appointmentId',appointment_id,'requestId',request_id,
          'startsAt',to_char(starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'endsAt',case when duration_minutes between 1 and 2880 then to_char((starts_at+duration_minutes*interval '1 minute') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') else null end,
          'status',case when lower(btrim(coalesce(status,''))) in ('scheduled','confirmed','arrived','no_show','cancelled') then lower(btrim(status)) else 'unknown' end,
          'clientName',coalesce(client_name,''),'clientPhone',coalesce(client_phone,''),'service',service,'doctorName',doctor_name,
          'clinicConfirmedAt',to_char(clinic_confirmed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'operatorCheckResult',operator_check_result
        ) order by starts_at,request_id,appointment_id),'[]'::jsonb) from selected),
        'hasMore',(select count(*)>p_offset::bigint+20 from today)) end
    ) into v_consistent,v_result;

  if not v_consistent then raise exception using errcode='P1232',message='operator_workday_unconfirmed'; end if;
  return v_result;
end $$;

revoke all on function public.read_growth_operator_workday(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_growth_operator_workday(uuid,integer) to service_role;
do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(role_name,'public.read_growth_operator_workday(uuid,integer)','EXECUTE') is distinct from (role_name='service_role')
      or has_function_privilege(role_name,'public.operator_workday_day_start(date,text)','EXECUTE')
      or has_function_privilege(role_name,'public.operator_workday_zone(text)','EXECUTE')
      then raise exception 'operator_workday_executor_unconfirmed'; end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
