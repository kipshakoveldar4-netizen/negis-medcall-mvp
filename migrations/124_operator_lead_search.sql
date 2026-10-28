-- Complete authorized operator lead search. No business rows or rights are changed.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare relation text; dependency record; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'operator_lead_search_dependencies_unconfirmed'; end if;
  foreach relation in array array['growth_operator_profiles','growth_operator_requests','growth_operator_lead_assignments',
    'workspaces','leads','lead_stages'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||relation) and relkind='r'
      and relowner=to_regrole('postgres') and relrowsecurity)
      then raise exception 'operator_lead_search_dependencies_unconfirmed'; end if;
  end loop;
  if not exists(select 1 from pg_attribute where attrelid='public.leads'::regclass
    and attname='phone_normalized' and atttypid='text'::regtype and attgenerated='s' and not attisdropped)
    then raise exception 'operator_lead_search_dependencies_unconfirmed'; end if;
  for dependency in select * from (values
    ('public.transition_growth_operator_request(uuid,uuid,text)','d8e84b433185d5d6382c4fd6497bfe2d8e4d516defbefd17ce121d699890c207','uuid'),
    ('public.set_growth_operator_lead_assignment(uuid,uuid,uuid,boolean)','1414aecb54c86ab00265e57f313373e4752dbfa80b16e46bc61fc841b3e0fd34','void'),
    ('public.set_growth_operator_lead_stage(uuid,uuid,uuid,uuid,uuid,text)','8993fb602249da16616bc6cd47126244acef911e0a5470cb68751ec753ac08d2','void'),
    ('public.read_growth_operator_workday(uuid,integer)','9cfaa2d709a4d5f8c610ffc161a446eac68bd582b9d70dbfc7dc251a1ac49c73','jsonb')
  ) expected(signature,digest,result_type) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef and p.provolatile='v' and not p.proretset and p.prorettype=to_regtype(dependency.result_type)
      and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'operator_lead_search_dependencies_unconfirmed'; end if;
  end loop;
end $$;

create or replace function public.read_growth_operator_lead_search(
  p_actor uuid,p_search text default '',p_group text default 'all',p_request_id uuid default null,p_offset integer default 0
) returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare
  v_operator uuid; v_request uuid; v_locked uuid[]:='{}'::uuid[]; v_result jsonb; v_consistent boolean;
  v_upper constant text:='ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯӘҒҚҢӨҰҮҺІ';
  v_lower constant text:='abcdefghijklmnopqrstuvwxyzабвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһі';
  v_trim constant text:=E' \t\n\r\f\013'||U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  v_search text; v_phone text;
begin
  if p_search is null or char_length(p_search)>120 or p_search~'[[:cntrl:]]'
    or p_group is null or p_group not in ('all','new','in_progress','booked','postponed','lost','other')
    or p_offset is null or p_offset<0 or p_offset>1000000
    then raise exception using errcode='P1243',message='operator_lead_search_query_invalid'; end if;
  if current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P1242',message='operator_lead_search_unconfirmed'; end if;
  p_search:=btrim(p_search,v_trim); v_search:=translate(p_search,v_upper,v_lower);
  v_phone:=case when p_search~'^[+()0-9 .-]+$' then regexp_replace(p_search,'[^0-9]','','g') else '' end;
  -- Match the existing 028/lib/crm/phone.ts canonical form, including KZ trunk 8.
  if char_length(v_phone)>11 and left(v_phone,2)='00' then v_phone:=substr(v_phone,3);
  elsif char_length(v_phone)=11 and left(v_phone,1)='8' then v_phone:='7'||substr(v_phone,2); end if;
  select p.id into v_operator from public.growth_operator_profiles p where p.auth_user_id=p_actor and p.status='approved';
  if not found then raise exception using errcode='P1241',message='operator_lead_search_access_denied'; end if;
  -- Same request-before-profile order as assignment, stage and cooperation writers.
  for v_request in select q.id from public.growth_operator_requests q
    where q.operator_id=v_operator and q.status='accepted' order by q.id limit 1001 for share loop
    v_locked:=array_append(v_locked,v_request);
  end loop;
  if cardinality(v_locked)>1000 then raise exception using errcode='P1242',message='operator_lead_search_unconfirmed'; end if;
  perform 1 from public.growth_operator_profiles p where p.id=v_operator and p.auth_user_id=p_actor and p.status='approved' for share;
  if not found or p_request_id is not null and not(p_request_id=any(v_locked))
    then raise exception using errcode='P1241',message='operator_lead_search_access_denied'; end if;

  with report_clock as materialized (select clock_timestamp() at_time), companies as materialized (
    select q.id request_id,q.workspace_id,q.lead_scope,w.name
    from public.growth_operator_requests q join public.workspaces w on w.id=q.workspace_id
    where q.operator_id=v_operator and q.status='accepted'
  ), authorized as materialized (
    select c.request_id,c.workspace_id,c.name company_name,l.id,l.full_name,l.phone,l.phone_normalized,l.status,l.source,l.created_at,l.stage_id,
      s.name stage_name,coalesce(nullif(btrim(s.semantic_group,v_trim),''),translate(btrim(coalesce(l.status,''),v_trim),v_upper,v_lower)) bucket
    from companies c join public.leads l on l.workspace_id=c.workspace_id
    left join public.lead_stages s on s.id=l.stage_id and s.workspace_id=l.workspace_id
    where (c.lead_scope='clinic' or exists(select 1 from public.growth_operator_lead_assignments x
      where x.operator_request_id=c.request_id and x.workspace_id=c.workspace_id and x.lead_id=l.id and x.assigned))
      and (p_request_id is null or c.request_id=p_request_id)
  ), filtered as materialized (
    select *,case when bucket in ('new','новая') then 'new'
      when bucket in ('in_progress','в работе') then 'in_progress'
      when bucket in ('booked','записана') then 'booked'
      when bucket in ('postponed','deferred','отложена','отложенные','отложено','отложен') then 'postponed'
      when bucket in ('lost','потеряна') then 'lost' else 'other' end group_name
    from authorized where v_search='' or strpos(translate(coalesce(full_name,''),v_upper,v_lower),v_search)>0
      or strpos(translate(coalesce(phone,''),v_upper,v_lower),v_search)>0
      or strpos(translate(coalesce(company_name,''),v_upper,v_lower),v_search)>0
      or v_phone<>'' and strpos(regexp_replace(coalesce(phone_normalized,''),'[^0-9]','','g'),v_phone)>0
  ), matched as materialized (
    select * from filtered where p_group='all' or group_name=p_group
  ), page as materialized (
    select * from matched order by created_at desc nulls last,request_id,id offset p_offset limit 20
  ), page_requests as materialized (
    select distinct request_id,workspace_id from page
  ), options as materialized (
    select p.request_id,s.id,s.name,s.sort_order from page_requests p
    join public.lead_stages s on s.workspace_id=p.workspace_id and s.is_active
  ) select
    not exists(select 1 from companies where not(request_id=any(v_locked)) or lead_scope not in ('assigned','clinic')
      or name is null or char_length(btrim(name)) not between 1 and 200)
    and (select count(*) from companies)=cardinality(v_locked)
    and (select count(*) from companies)=(select count(distinct workspace_id) from companies)
    and not exists(select 1 from filtered where created_at is not null and not isfinite(created_at))
    and not exists(select 1 from filtered where stage_id is not null and stage_name is null)
    and not exists(select 1 from options group by request_id having count(*)>1000),
    jsonb_build_object(
      'generatedAt',(select to_char(at_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from report_clock),
      'offset',p_offset,'filters',jsonb_build_object('search',p_search,'group',p_group,'requestId',p_request_id),
      'companies',(select coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'displayName',name,'leadScope',lead_scope) order by request_id),'[]'::jsonb) from companies),
      'totals',(select jsonb_build_object('all',count(*)::text,'new',count(*) filter(where group_name='new')::text,
        'in_progress',count(*) filter(where group_name='in_progress')::text,'booked',count(*) filter(where group_name='booked')::text,
        'postponed',count(*) filter(where group_name='postponed')::text,'lost',count(*) filter(where group_name='lost')::text,
        'other',count(*) filter(where group_name='other')::text) from filtered),
      'matched',(select count(*)::text from matched),
      'items',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'requestId',request_id,
        'name',coalesce(full_name,''),'phone',coalesce(phone,''),'status',coalesce(status,''),'stageId',stage_id,
        'stageName',coalesce(stage_name,''),'group',group_name,'source',coalesce(source,''),
        'createdAt',case when isfinite(created_at) then to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') else null end)
        order by created_at desc nulls last,request_id,id),'[]'::jsonb) from page),
      'stageOptions',(select coalesce(jsonb_agg(jsonb_build_object('requestId',p.request_id,'items',
        (select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.sort_order,o.id),'[]'::jsonb)
          from options o where o.request_id=p.request_id)) order by p.request_id),'[]'::jsonb) from page_requests p),
      'hasMore',(select count(*)>p_offset::bigint+20 from matched)
    ) into v_consistent,v_result;
  if not v_consistent then raise exception using errcode='P1242',message='operator_lead_search_unconfirmed'; end if;
  return v_result;
end $$;
revoke all on function public.read_growth_operator_lead_search(uuid,text,text,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_growth_operator_lead_search(uuid,text,text,uuid,integer) to service_role;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(r,'public.read_growth_operator_lead_search(uuid,text,text,uuid,integer)','EXECUTE') is distinct from (r='service_role')
      then raise exception 'operator_lead_search_executor_unconfirmed'; end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
