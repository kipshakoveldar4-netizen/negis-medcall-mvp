-- Prepare only; do not enable or execute on a live site without release approval.
-- No expiry, scheduled purge, clinical cascade or public deletion RPC.
begin;

alter table public.crm_intake_sites
  add column if not exists manual_deletion_enabled boolean not null default false;
create index if not exists crm_site_inquiries_lead_deletion_idx
  on public.crm_site_inquiries(lead_id, id) where lead_id is not null;

create table if not exists public.crm_site_inquiry_deletions (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_key uuid not null,
  site_id uuid not null references public.crm_intake_sites(id),
  lead_id uuid not null, -- Intentionally not an FK to the deleted lead.
  confirmed_by_staff_user_id uuid references public.staff_users(id) on delete set null,
  scope_fingerprint text not null check (scope_fingerprint ~ '^[a-f0-9]{64}$'),
  receipts_deleted integer not null check (receipts_deleted between 1 and 200),
  completed_at timestamptz not null default now(),
  primary key (workspace_id, request_key),
  unique (workspace_id, lead_id)
);

-- Retain only random transport keys, not deleted contact/consent contents. A late
-- retry of a removed submission must not recreate its lead after erasure.
create table if not exists public.crm_site_inquiry_erased_requests (
  site_id uuid not null references public.crm_intake_sites(id) on delete cascade,
  request_key uuid not null,
  erased_at timestamptz not null default now(),
  primary key (site_id, request_key)
);
alter table public.crm_site_inquiry_deletions enable row level security;
alter table public.crm_site_inquiry_erased_requests enable row level security;
revoke all on public.crm_site_inquiry_deletions, public.crm_site_inquiry_erased_requests
  from public, anon, authenticated, service_role;
grant select on public.crm_site_inquiry_deletions, public.crm_site_inquiry_erased_requests to service_role;

create or replace function public.reject_erased_site_inquiry_retry()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.crm_site_inquiry_erased_requests
    where site_id = new.site_id and request_key = new.request_key) then
    raise exception using message = 'inquiry_erased', errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.reject_erased_site_inquiry_retry() from public, anon, authenticated, service_role;
drop trigger if exists reject_erased_site_inquiry_retry on public.crm_site_inquiries;
create trigger reject_erased_site_inquiry_retry before insert on public.crm_site_inquiries
  for each row execute function public.reject_erased_site_inquiry_retry();

create or replace function public.delete_crm_site_inquiry(
  p_workspace_id uuid, p_site_key text, p_lead_id uuid,
  p_expected_receipt_ids uuid[], p_expected_lead_updated_at timestamptz,
  p_staff_user_id uuid, p_auth_user_id uuid, p_request_key uuid, p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_site public.crm_intake_sites%rowtype;
  v_lead public.leads%rowtype;
  v_done public.crm_site_inquiry_deletions%rowtype;
  v_expected uuid[];
  v_actual uuid[];
  v_fingerprint text;
  v_fk record;
  v_join text;
  v_linked boolean;
  v_count integer;
begin
  if p_confirmed is distinct from true or p_workspace_id is null or p_site_key is null
    or p_lead_id is null or p_staff_user_id is null or p_auth_user_id is null
    or p_request_key is null or p_expected_lead_updated_at is null
    or not isfinite(p_expected_lead_updated_at)
    or p_expected_receipt_ids is null
    or cardinality(p_expected_receipt_ids) not between 1 and 200
    or array_ndims(p_expected_receipt_ids) <> 1
    or array_position(p_expected_receipt_ids, null) is not null then
    raise exception using message = 'invalid_deletion_request', errcode = '22023';
  end if;
  select array_agg(distinct item order by item) into v_expected from unnest(p_expected_receipt_ids) item;
  if cardinality(v_expected) <> cardinality(p_expected_receipt_ids) then
    raise exception using message = 'invalid_deletion_request', errcode = '22023';
  end if;

  -- The future HTTP handler must verify Bearer first, then supply these actor
  -- IDs from its server context. Browser-provided identities are never trusted.
  perform 1 from public.staff_users where id = p_staff_user_id
    and auth_user_id = p_auth_user_id and workspace_id = p_workspace_id
    and status = 'active' and role in ('owner', 'admin') for share;
  if not found then
    raise exception using message = 'workspace_access_denied', errcode = '42501';
  end if;
  -- Same first data lock as accept_crm_site_inquiry: fresh intake and deletion
  -- serialize per site, not across all clinics. Other leads remain writable.
  select * into v_site from public.crm_intake_sites
    where workspace_id = p_workspace_id and site_key = p_site_key for update;
  if not found or not v_site.manual_deletion_enabled then
    raise exception using message = 'site_deletion_disabled', errcode = '42501';
  end if;
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'lead', p_lead_id, 'receipts', v_expected,
    'updatedAtEpoch', extract(epoch from p_expected_lead_updated_at)
  )::text, 'UTF8')), 'hex');
  select * into v_done from public.crm_site_inquiry_deletions
    where workspace_id = p_workspace_id and request_key = p_request_key;
  if found then
    if v_done.site_id <> v_site.id or v_done.lead_id <> p_lead_id or v_done.scope_fingerprint <> v_fingerprint then
      raise exception using message = 'deletion_request_conflict', errcode = '22023';
    end if;
    return jsonb_build_object('deleted', true, 'receiptsDeleted', v_done.receipts_deleted, 'replayed', true);
  end if;

  -- Stabilize FK metadata without a table lock that blocks other CRM writes.
  lock table public.leads in row exclusive mode;
  select * into v_lead from public.leads where id = p_lead_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception using message = 'site_inquiry_not_found', errcode = 'P0002';
  end if;
  if v_lead.updated_at is distinct from p_expected_lead_updated_at then
    raise exception using message = 'deletion_scope_changed', errcode = '40001';
  end if;
  if v_lead.source is distinct from 'website' or v_lead.client_id is not null
    or v_lead.responsible_user_id is not null or v_lead.meta_campaign_launch_id is not null
    or coalesce(btrim(v_lead.campaign), '') <> ''
    or (v_lead.stage_id is null and v_lead.status is distinct from 'new')
    or (v_lead.stage_id is not null and not exists (
      select 1 from public.lead_stages where id = v_lead.stage_id
        and workspace_id = p_workspace_id and semantic_group = 'new'
    )) then
    raise exception using message = 'deletion_requires_review', errcode = '23001';
  end if;
  select array_agg(i.id order by i.id), bool_or(i.site_id <> v_site.id) into v_actual, v_linked
    from (select id, site_id from public.crm_site_inquiries where lead_id = p_lead_id
      order by id limit 201 for update) i;
  if v_linked then
    raise exception using message = 'deletion_requires_review', errcode = '23001';
  end if;
  if v_actual is distinct from v_expected then
    raise exception using message = 'deletion_scope_changed', errcode = '40001';
  end if;
  if exists (select 1 from public.audit_logs
    where entity_type = 'lead' and lower(entity_id) = p_lead_id::text) then
    raise exception using message = 'deletion_requires_review', errcode = '23001';
  end if;

  -- All inbound FKs, including composite/new ones, stop automatic erasure.
  -- Never rely on ON DELETE SET NULL/CASCADE to remove a clinical dependency.
  for v_fk in select conrelid, conkey, confkey from pg_catalog.pg_constraint
    where contype = 'f' and confrelid = 'public.leads'::regclass
      and conrelid <> 'public.crm_site_inquiries'::regclass
  loop
    select string_agg(format('child.%I = parent.%I', ca.attname, pa.attname), ' and ' order by k.ordinality)
      into v_join from unnest(v_fk.conkey, v_fk.confkey) with ordinality k(child_key, parent_key, ordinality)
      join pg_catalog.pg_attribute ca on ca.attrelid = v_fk.conrelid and ca.attnum = k.child_key
      join pg_catalog.pg_attribute pa on pa.attrelid = 'public.leads'::regclass and pa.attnum = k.parent_key;
    execute format('select exists (select 1 from %s child join public.leads parent on %s where parent.id = $1)',
      v_fk.conrelid::regclass, v_join) into v_linked using p_lead_id;
    if v_linked then
      raise exception using message = 'deletion_requires_review', errcode = '23001';
    end if;
  end loop;

  insert into public.crm_site_inquiry_erased_requests(site_id, request_key)
    select site_id, request_key from public.crm_site_inquiries where id = any(v_actual);
  delete from public.crm_site_inquiries where site_id = v_site.id and lead_id = p_lead_id and id = any(v_actual);
  get diagnostics v_count = row_count;
  if v_count <> cardinality(v_expected) then
    raise exception using message = 'deletion_scope_changed', errcode = '40001';
  end if;
  delete from public.leads where id = p_lead_id and workspace_id = p_workspace_id;
  if not found then
    raise exception using message = 'deletion_scope_changed', errcode = '40001';
  end if;
  insert into public.crm_site_inquiry_deletions(
    workspace_id, request_key, site_id, lead_id, confirmed_by_staff_user_id, scope_fingerprint, receipts_deleted
  ) values(p_workspace_id, p_request_key, v_site.id, p_lead_id, p_staff_user_id, v_fingerprint, v_count);
  return jsonb_build_object('deleted', true, 'receiptsDeleted', v_count, 'replayed', false);
end;
$$;
revoke all on function public.delete_crm_site_inquiry(uuid, text, uuid, uuid[], timestamptz, uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.delete_crm_site_inquiry(uuid, text, uuid, uuid[], timestamptz, uuid, uuid, uuid, boolean)
  to service_role;
comment on table public.crm_site_inquiry_deletions is
  'Server-only minimal deletion receipt; random IDs/counts only. No contact data, consent JSON, tokens or notes.';
comment on table public.crm_site_inquiry_erased_requests is
  'Server-only replay protection for erased submissions. New consent with a new transport key is not a phone ban.';
commit;
notify pgrst, 'reload schema';
