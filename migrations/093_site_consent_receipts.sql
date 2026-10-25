-- Local candidate only. Requires 058; works with 062 erasure when it is present.
-- No legal approval, registry population, site activation or historical backfill.
begin;

create or replace function public.valid_crm_site_consent_receipt(p_receipt jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  v_key text;
  v_binding text;
begin
  if p_receipt is null or jsonb_typeof(p_receipt) <> 'object' then return false; end if;
  if not (p_receipt ?& array['version','text','purpose','policyRevision','policyUrl','sha256'])
    or exists (select 1 from jsonb_object_keys(p_receipt) k
      where k not in ('version','text','purpose','policyRevision','policyUrl','sha256')) then return false; end if;
  foreach v_key in array array['version','text','purpose','policyRevision','policyUrl','sha256'] loop
    if jsonb_typeof(p_receipt->v_key) is distinct from 'string'
      or length(btrim(p_receipt->>v_key)) = 0 then return false; end if;
  end loop;
  if (p_receipt->>'version') !~ '^[a-zA-Z0-9._-]{1,40}$'
    or length(p_receipt->>'text') > 32768 or length(p_receipt->>'purpose') > 4096
    or length(p_receipt->>'policyRevision') > 200 or length(p_receipt->>'policyUrl') > 2048
    or (p_receipt->>'policyUrl') !~ '^https://[^/?#@[:space:]]+([/?][^#[:space:]]*)?$'
    or (p_receipt->>'sha256') !~ '^[a-f0-9]{64}$' then return false; end if;
  -- Same UTF-8 JSON string array as the immutable server registry, without SQL's separator spaces.
  v_binding := '[' || to_json(p_receipt->>'version')::text || ',' || to_json(p_receipt->>'text')::text
    || ',' || to_json(p_receipt->>'purpose')::text || ',' || to_json(p_receipt->>'policyRevision')::text
    || ',' || to_json(p_receipt->>'policyUrl')::text || ']';
  return encode(sha256(convert_to(v_binding, 'UTF8')), 'hex') = p_receipt->>'sha256';
end;
$$;
revoke all on function public.valid_crm_site_consent_receipt(jsonb) from public, anon, authenticated, service_role;

create table public.crm_site_consent_receipts (
  inquiry_id uuid primary key references public.crm_site_inquiries(id) on delete cascade,
  site_id uuid not null references public.crm_intake_sites(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  notice_snapshot jsonb not null check (public.valid_crm_site_consent_receipt(notice_snapshot)),
  binding_version text not null default 'site-consent-v1' check (binding_version = 'site-consent-v1'),
  consent_received_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.crm_site_consent_receipts enable row level security;
revoke all on public.crm_site_consent_receipts from public, anon, authenticated, service_role;
grant select on public.crm_site_consent_receipts to service_role;
comment on table public.crm_site_consent_receipts is
  'Server-only immutable notice binding supplied by the approved code registry, not legal approval. No historical backfill. Removed with inquiry by the existing explicit erasure flow.';

create or replace function public.guard_crm_site_consent_receipt()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'crm_site_consent_receipts' then
    if tg_op = 'UPDATE' then
      raise exception using message = 'consent_receipt_immutable', errcode = '23001';
    end if;
    perform 1 from public.crm_site_inquiries i join public.crm_intake_sites s on s.id = i.site_id
      where i.id = new.inquiry_id and i.site_id = new.site_id and s.workspace_id = new.workspace_id
        and i.inquiry->>'consentVersion' = new.notice_snapshot->>'version'
        and i.consent_received_at = new.consent_received_at;
    if not found then raise exception using message = 'consent_receipt_mismatch', errcode = '22023'; end if;
  else
    if (new.id, new.site_id, new.request_key, new.inquiry, new.consent_received_at)
      is distinct from (old.id, old.site_id, old.request_key, old.inquiry, old.consent_received_at) then
      raise exception using message = 'consent_receipt_immutable', errcode = '23001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_crm_site_consent_receipt() from public, anon, authenticated, service_role;
create trigger guard_crm_site_consent_receipt before insert or update on public.crm_site_consent_receipts
  for each row execute function public.guard_crm_site_consent_receipt();
create trigger guard_crm_site_inquiry_binding before update on public.crm_site_inquiries
  for each row execute function public.guard_crm_site_consent_receipt();

create or replace function public.require_crm_site_consent_receipt()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Only new inquiries are checked; legacy version-only rows are not rewritten.
  if exists (select 1 from public.crm_site_inquiries where id = new.id)
    and not exists (select 1 from public.crm_site_consent_receipts where inquiry_id = new.id) then
    raise exception using message = 'consent_receipt_required', errcode = '23514';
  end if;
  return null;
end;
$$;
revoke all on function public.require_crm_site_consent_receipt() from public, anon, authenticated, service_role;
create constraint trigger require_crm_site_consent_receipt after insert on public.crm_site_inquiries
  deferrable initially deferred for each row execute function public.require_crm_site_consent_receipt();

create or replace function public.accept_crm_site_inquiry_with_consent(
  p_site_key text, p_request_key uuid, p_inquiry jsonb, p_consent_receipt jsonb
) returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_site public.crm_intake_sites%rowtype;
  v_inquiry public.crm_site_inquiries%rowtype;
  v_snapshot jsonb;
  v_result jsonb;
begin
  -- Approval is exclusively the immutable server registry's job. SQL verifies
  -- the binding and transport identity; neither visitor input nor DB labels approve text.
  if not public.valid_crm_site_consent_receipt(p_consent_receipt)
    or p_inquiry is null or jsonb_typeof(p_inquiry) <> 'object'
    or (p_inquiry->>'consentVersion') is distinct from (p_consent_receipt->>'version') then
    raise exception using message = 'invalid_consent_receipt', errcode = '22023';
  end if;
  select * into v_site from public.crm_intake_sites where site_key = p_site_key for update;
  if not found or not v_site.enabled then
    raise exception using message = 'site_unavailable', errcode = '22023';
  end if;
  select * into v_inquiry from public.crm_site_inquiries
    where site_id = v_site.id and request_key = p_request_key;
  if found then
    select notice_snapshot into v_snapshot from public.crm_site_consent_receipts where inquiry_id = v_inquiry.id;
    if not found then
      raise exception using message = 'consent_receipt_unavailable', errcode = '22023';
    end if;
    if v_snapshot is distinct from p_consent_receipt then
      raise exception using message = 'request_conflict', errcode = '22023';
    end if;
  end if;
  -- Retain 058 validation, deduplication, rate checks and 062 erased-key protection.
  v_result := public.accept_crm_site_inquiry(p_site_key, p_request_key, p_inquiry);
  if v_result is distinct from '{"accepted":true}'::jsonb then
    raise exception using message = 'intake_unavailable', errcode = '22023';
  end if;
  if v_snapshot is null then
    select * into strict v_inquiry from public.crm_site_inquiries
      where site_id = v_site.id and request_key = p_request_key;
    insert into public.crm_site_consent_receipts(inquiry_id, site_id, workspace_id, notice_snapshot, consent_received_at)
      values(v_inquiry.id, v_site.id, v_site.workspace_id, p_consent_receipt, v_inquiry.consent_received_at);
  end if;
  return jsonb_build_object('accepted', true);
end;
$$;
revoke all on function public.accept_crm_site_inquiry_with_consent(text, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.accept_crm_site_inquiry_with_consent(text, uuid, jsonb, jsonb) to service_role;
-- The wrapper alone may call 058. Old servers fail closed instead of accepting version-only consent.
revoke all on function public.accept_crm_site_inquiry(text, uuid, jsonb) from public, anon, authenticated, service_role;

do $$
declare v_role text;
begin
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if (v_role <> 'service_role' and (
        has_any_column_privilege(v_role, 'public.crm_site_consent_receipts', 'SELECT,INSERT,UPDATE,REFERENCES')
        or has_table_privilege(v_role, 'public.crm_site_consent_receipts', 'DELETE,TRUNCATE,TRIGGER')
        or has_function_privilege(v_role, 'public.accept_crm_site_inquiry_with_consent(text,uuid,jsonb,jsonb)', 'EXECUTE')))
      or has_function_privilege(v_role, 'public.accept_crm_site_inquiry(text,uuid,jsonb)', 'EXECUTE')
      or has_function_privilege(v_role, 'public.valid_crm_site_consent_receipt(jsonb)', 'EXECUTE')
      or has_function_privilege(v_role, 'public.guard_crm_site_consent_receipt()', 'EXECUTE')
      or has_function_privilege(v_role, 'public.require_crm_site_consent_receipt()', 'EXECUTE')
      or has_any_column_privilege(v_role, 'public.crm_site_consent_receipts', 'INSERT,UPDATE,REFERENCES')
      or has_table_privilege(v_role, 'public.crm_site_consent_receipts', 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') then
      raise exception 'site_consent_privileges_not_closed';
    end if;
  end loop;
end;
$$;
commit;
notify pgrst, 'reload schema';
