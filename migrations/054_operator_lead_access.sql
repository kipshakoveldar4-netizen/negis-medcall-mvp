-- Apply after 053. Existing agreements receive no patient access by default.
begin;

alter table public.growth_operator_requests
  add column if not exists lead_scope text not null default 'assigned'
    check (lead_scope in ('assigned', 'clinic'));

create or replace function public.check_growth_operator_lead_scope()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Scope is part of the proposal. A broader scope requires a new agreement.
  if new.lead_scope is distinct from old.lead_scope then
    raise exception 'operator_scope_immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists growth_operator_lead_scope_guard on public.growth_operator_requests;
create trigger growth_operator_lead_scope_guard before update
  on public.growth_operator_requests for each row
  execute function public.check_growth_operator_lead_scope();

create unique index if not exists leads_id_workspace_operator_idx on public.leads(id, workspace_id);
create table if not exists public.growth_operator_lead_assignments (
  operator_request_id uuid not null,
  workspace_id uuid not null,
  lead_id uuid not null,
  assigned boolean not null default true,
  changed_by_staff_user_id uuid not null references public.staff_users(id),
  updated_at timestamptz not null default now(),
  primary key (operator_request_id, lead_id),
  foreign key (operator_request_id, workspace_id)
    references public.growth_operator_requests(id, workspace_id),
  foreign key (lead_id, workspace_id) references public.leads(id, workspace_id) on delete cascade
);
create index if not exists growth_operator_lead_workspace_idx
  on public.growth_operator_lead_assignments(workspace_id, operator_request_id);
alter table public.growth_operator_lead_assignments enable row level security;
revoke all on public.growth_operator_lead_assignments from public, anon, authenticated, service_role;
grant select on public.growth_operator_lead_assignments to service_role;

create or replace function public.set_growth_operator_lead_assignment(
  p_request_id uuid, p_lead_id uuid, p_staff_id uuid, p_assigned boolean
)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.growth_operator_requests%rowtype; staff_role text;
begin
  select * into r from public.growth_operator_requests where id = p_request_id for update;
  if not found or r.status <> 'accepted' or r.lead_scope <> 'assigned'
  then raise exception 'operator_assignment_unavailable'; end if;
  select s.role into staff_role from public.staff_users s
    where s.id = p_staff_id and s.workspace_id = r.workspace_id
      and s.status = 'active' and s.role in ('owner', 'admin', 'manager')
      and s.auth_user_id is not null;
  if not found then raise exception 'clinic_manager_required'; end if;
  if p_assigned is null then raise exception 'assignment_value_required'; end if;
  perform 1 from public.leads where id = p_lead_id and workspace_id = r.workspace_id for share;
  if not found then raise exception 'lead_unavailable'; end if;
  -- Revocation remains possible while the operator is suspended.
  if p_assigned then
    perform 1 from public.growth_operator_profiles where id = r.operator_id and status = 'approved' for share;
    if not found then raise exception 'approved_operator_required'; end if;
  end if;
  insert into public.growth_operator_lead_assignments
    (operator_request_id, workspace_id, lead_id, assigned, changed_by_staff_user_id)
  values (r.id, r.workspace_id, p_lead_id, p_assigned, p_staff_id)
  on conflict (operator_request_id, lead_id) do update
    set assigned = excluded.assigned, changed_by_staff_user_id = excluded.changed_by_staff_user_id, updated_at = now()
    where public.growth_operator_lead_assignments.assigned is distinct from excluded.assigned;
  if found then
    insert into public.audit_logs(workspace_id, actor_role, action, entity_type, entity_id, metadata)
    values (r.workspace_id, staff_role, 'operator_lead_assignment', 'lead', p_lead_id::text,
      jsonb_build_object('operator_request_id', r.id, 'assigned', p_assigned, 'staff_user_id', p_staff_id));
  end if;
end;
$$;

create or replace function public.read_growth_operator_leads(
  p_request_id uuid, p_operator_user_id uuid, p_offset integer default 0
)
returns table(id uuid, full_name text, phone text, status text, source text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare r public.growth_operator_requests%rowtype;
begin
  if p_offset is null or p_offset < 0 or p_offset > 999999 then raise exception 'invalid_offset'; end if;
  select q.* into r from public.growth_operator_requests q
    where q.id = p_request_id and q.status = 'accepted' for share;
  if not found then raise exception 'operator_access_denied'; end if;
  perform 1 from public.growth_operator_profiles o where o.id = r.operator_id
    and o.auth_user_id = p_operator_user_id and o.status = 'approved' for share;
  if not found then raise exception 'operator_access_denied'; end if;
  -- Read-only, minimal contact data. No CRM membership, notes or medical history.
  return query select l.id, l.full_name, l.phone, l.status, l.source, l.created_at
    from public.leads l where l.workspace_id = r.workspace_id and (
      r.lead_scope = 'clinic' or exists (
        select 1 from public.growth_operator_lead_assignments a
        where a.operator_request_id = r.id and a.workspace_id = r.workspace_id
          and a.lead_id = l.id and a.assigned
      )
    ) order by l.created_at desc nulls last, l.id
    limit 21 offset p_offset;
end;
$$;

revoke all on function public.check_growth_operator_lead_scope() from public, anon, authenticated;
revoke all on function public.set_growth_operator_lead_assignment(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.read_growth_operator_leads(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.set_growth_operator_lead_assignment(uuid, uuid, uuid, boolean) to service_role;
grant execute on function public.read_growth_operator_leads(uuid, uuid, integer) to service_role;

commit;
notify pgrst, 'reload schema';
