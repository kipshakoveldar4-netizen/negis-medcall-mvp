-- Local candidate only. Depends on 070. No payment, refund or commission ledger.
begin;

create table public.mortgage_signed_contracts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null references public.leads(id),
  reference text not null default '' check (char_length(reference)<=100),
  signed_at timestamptz not null check (isfinite(signed_at)),
  responsible_staff_user_id uuid not null references public.staff_users(id),
  recorded_by_staff_user_id uuid not null references public.staff_users(id),
  created_at timestamptz not null default clock_timestamp() check (signed_at<=created_at),
  voided_at timestamptz,
  voided_by_staff_user_id uuid references public.staff_users(id),
  void_reason text not null default '',
  check ((voided_at is null and voided_by_staff_user_id is null and void_reason='')
    or (voided_at is not null and voided_by_staff_user_id is not null and char_length(btrim(void_reason)) between 1 and 500))
);
create unique index mortgage_signed_contracts_active_lead_idx on public.mortgage_signed_contracts(workspace_id,lead_id) where voided_at is null;
create index mortgage_signed_contracts_results_idx on public.mortgage_signed_contracts(workspace_id,signed_at,responsible_staff_user_id) where voided_at is null;
create table public.mortgage_contract_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  staff_user_id uuid not null references public.staff_users(id),
  request_id uuid not null,
  contract_id uuid not null references public.mortgage_signed_contracts(id),
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,staff_user_id,request_id)
);
alter table public.mortgage_signed_contracts enable row level security;
alter table public.mortgage_contract_requests enable row level security;
revoke all on public.mortgage_signed_contracts,public.mortgage_contract_requests from public,anon,authenticated;
grant select,insert,update,delete on public.mortgage_signed_contracts,public.mortgage_contract_requests to service_role;

create function public.save_mortgage_contract(
  p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_lead_id uuid,
  p_contract_id uuid,p_request_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_role text; v_lead public.leads%rowtype; v_contract public.mortgage_signed_contracts%rowtype;
  v_receipt public.mortgage_contract_requests%rowtype; v_signed timestamptz; v_payload jsonb;
begin
  v_role:=public.mortgage_actor_role(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if p_request_id is null or p_lead_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception using errcode='P7803',message='invalid_contract'; end if;
  if p_contract_id is not null and v_role not in ('owner','admin') then
    raise exception using errcode='P7001',message='mortgage_access_denied'; end if;
  select * into v_lead from public.leads l where l.workspace_id=p_workspace_id and l.id=p_lead_id
    and (v_role<>'lead_manager' or l.responsible_user_id=p_staff_user_id) for update;
  if not found then raise exception using errcode='P7002',message='lead_not_found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||p_staff_user_id::text||p_request_id::text,78));
  v_payload:=jsonb_build_object('leadId',p_lead_id,'contractId',p_contract_id,'data',p_payload);
  select * into v_receipt from public.mortgage_contract_requests r where r.workspace_id=p_workspace_id
    and r.staff_user_id=p_staff_user_id and r.request_id=p_request_id;
  if found then
    if v_receipt.payload is distinct from v_payload then raise exception using errcode='P7807',message='request_conflict'; end if;
    return jsonb_build_object('id',v_receipt.contract_id,'replayed',true);
  end if;
  if p_contract_id is null then
    if exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('signedAt','reference'))
      or jsonb_typeof(p_payload->'signedAt') is distinct from 'string'
      or jsonb_typeof(p_payload->'reference') is distinct from 'string'
      or char_length(p_payload->>'reference')>100 then
      raise exception using errcode='P7803',message='invalid_contract'; end if;
    begin v_signed:=(p_payload->>'signedAt')::timestamptz;
    exception when others then raise exception using errcode='P7803',message='invalid_contract'; end;
    if not isfinite(v_signed) or v_signed>statement_timestamp() then
      raise exception using errcode='P7803',message='invalid_signed_at'; end if;
    perform 1 from public.staff_users s where s.workspace_id=p_workspace_id and s.id=v_lead.responsible_user_id
      and s.role in ('owner','admin','lead_manager') and s.status='active' for share;
    if not found then raise exception using errcode='P7806',message='lead_requires_assignment'; end if;
    if exists(select 1 from public.mortgage_signed_contracts c where c.workspace_id=p_workspace_id and c.lead_id=p_lead_id and c.voided_at is null) then
      raise exception using errcode='P7804',message='contract_already_recorded'; end if;
    insert into public.mortgage_signed_contracts(workspace_id,lead_id,reference,signed_at,responsible_staff_user_id,recorded_by_staff_user_id)
      values(p_workspace_id,p_lead_id,btrim(p_payload->>'reference'),v_signed,v_lead.responsible_user_id,p_staff_user_id) returning * into v_contract;
  else
    if exists(select 1 from jsonb_object_keys(p_payload) k where k<>'reason')
      or jsonb_typeof(p_payload->'reason') is distinct from 'string'
      or coalesce(char_length(btrim(p_payload->>'reason')),0) not between 1 and 500 then
      raise exception using errcode='P7803',message='invalid_correction'; end if;
    select * into v_contract from public.mortgage_signed_contracts c
      where c.workspace_id=p_workspace_id and c.lead_id=p_lead_id and c.id=p_contract_id for update;
    if not found then raise exception using errcode='P7002',message='contract_not_found'; end if;
    if v_contract.voided_at is not null then raise exception using errcode='P7805',message='contract_already_corrected'; end if;
    update public.mortgage_signed_contracts set voided_at=clock_timestamp(),voided_by_staff_user_id=p_staff_user_id,
      void_reason=btrim(p_payload->>'reason') where id=v_contract.id returning * into v_contract;
  end if;
  insert into public.mortgage_contract_requests(workspace_id,staff_user_id,request_id,contract_id,payload)
    values(p_workspace_id,p_staff_user_id,p_request_id,v_contract.id,v_payload);
  return jsonb_build_object('id',v_contract.id,'replayed',false);
end; $$;

create function public.read_mortgage_contracts(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_lead_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_result jsonb;
begin
  v_role:=public.mortgage_actor_role(p_workspace_id,p_staff_user_id,p_auth_user_id);
  perform 1 from public.leads l where l.workspace_id=p_workspace_id and l.id=p_lead_id
    and (v_role<>'lead_manager' or l.responsible_user_id=p_staff_user_id) for share;
  if not found then raise exception using errcode='P7002',message='lead_not_found'; end if;
  select jsonb_build_object('truncated',(select count(*)>100 from public.mortgage_signed_contracts c where c.workspace_id=p_workspace_id and c.lead_id=p_lead_id),
    'records',coalesce(jsonb_agg(jsonb_build_object('id',c.id,'leadId',c.lead_id,'reference',c.reference,'signedAt',c.signed_at,
      'responsibleStaffId',c.responsible_staff_user_id,'responsibleName',coalesce(s.full_name,''),'recordedByName',coalesce(a.full_name,''),
      'voidedAt',c.voided_at,'voidReason',c.void_reason) order by c.voided_at nulls first,c.created_at desc,c.id),'[]'::jsonb)) into v_result
    from (select * from public.mortgage_signed_contracts c where c.workspace_id=p_workspace_id and c.lead_id=p_lead_id
      order by c.voided_at nulls first,c.created_at desc,c.id limit 100) c
    left join public.staff_users s on s.id=c.responsible_staff_user_id and s.workspace_id=p_workspace_id
    left join public.staff_users a on a.id=c.recorded_by_staff_user_id and a.workspace_id=p_workspace_id;
  return v_result;
end; $$;

-- One SQL snapshot, one current-assignee cohort. Never divide period events by
-- today's assignments or attribute old signed contracts to a new assignee.
create function public.read_mortgage_results(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_days integer default 30)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_now timestamptz:=statement_timestamp(); v_from timestamptz; v_result jsonb;
begin
  v_role:=public.mortgage_actor_role(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if v_role not in ('owner','admin') then raise exception using errcode='P7001',message='mortgage_access_denied'; end if;
  if p_days is null or p_days not in (7,30,90) then raise exception using errcode='P7803',message='invalid_period'; end if;
  v_from:=v_now-make_interval(days=>p_days);
  with portfolio as (
    select l.id,l.responsible_user_id,
      exists(select 1 from public.mortgage_activities a where a.workspace_id=p_workspace_id and a.lead_id=l.id
        and a.kind='meeting' and a.status='done' and a.ends_at<=v_now) as held,
      exists(select 1 from public.mortgage_signed_contracts c where c.workspace_id=p_workspace_id and c.lead_id=l.id and c.voided_at is null and c.signed_at<=v_now) as signed,
      exists(select 1 from public.mortgage_signed_contracts c join public.mortgage_activities a
        on a.workspace_id=p_workspace_id and a.lead_id=c.lead_id and a.kind='meeting' and a.status='done' and a.ends_at<=c.signed_at
        where c.workspace_id=p_workspace_id and c.lead_id=l.id and c.voided_at is null and c.signed_at<=v_now) as converted
      from public.leads l where l.workspace_id=p_workspace_id
  ), members as (
    select s.id,s.full_name,s.role,s.status,
      (select count(*) from portfolio p where p.responsible_user_id=s.id) as assigned,
      (select count(*) from portfolio p where p.responsible_user_id=s.id and p.held) as held,
      (select count(*) from portfolio p where p.responsible_user_id=s.id and p.signed) as signed,
      (select count(*) from portfolio p where p.responsible_user_id=s.id and p.converted) as held_signed,
      (select count(*) from public.mortgage_signed_contracts c where c.workspace_id=p_workspace_id and c.responsible_staff_user_id=s.id
        and c.voided_at is null and c.signed_at between v_from and v_now) as signed_in_period
    from public.staff_users s where s.workspace_id=p_workspace_id and s.role in ('owner','admin','lead_manager')
  ) select jsonb_build_object('generatedAt',v_now,'period',jsonb_build_object('days',p_days,'from',v_from,'to',v_now),
    'unassignedLeads',(select count(*) from portfolio p where p.responsible_user_id is null),
    'otherAssigneeLeads',(select count(*) from portfolio p where p.responsible_user_id is not null and not exists(select 1 from members s where s.id=p.responsible_user_id)),
    'members',coalesce((select jsonb_agg(jsonb_build_object('staffId',m.id,'name',coalesce(m.full_name,''),'role',m.role,'status',m.status,
      'assignedLeads',m.assigned,'heldLeads',m.held,'signedLeads',m.signed,'heldSignedLeads',m.held_signed,'signedInPeriod',m.signed_in_period)
      order by m.full_name,m.id) from members m),'[]'::jsonb)) into v_result;
  return v_result;
end; $$;

revoke all on function public.save_mortgage_contract(uuid,uuid,uuid,uuid,uuid,uuid,jsonb),
  public.read_mortgage_contracts(uuid,uuid,uuid,uuid),public.read_mortgage_results(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.save_mortgage_contract(uuid,uuid,uuid,uuid,uuid,uuid,jsonb),
  public.read_mortgage_contracts(uuid,uuid,uuid,uuid),public.read_mortgage_results(uuid,uuid,uuid,integer) to service_role;
notify pgrst,'reload schema';
commit;
