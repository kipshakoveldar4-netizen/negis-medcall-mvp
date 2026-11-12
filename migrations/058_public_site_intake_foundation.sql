-- Server-only foundation. No sites are enabled or provisioned by this migration.
-- Apply after 057. Public HTTP intake is intentionally NOT enabled yet.
begin;

create table if not exists public.crm_intake_sites (
  id uuid primary key default gen_random_uuid(),
  site_key text not null unique check (site_key ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  enabled boolean not null default false,
  consent_version text not null check (consent_version ~ '^[a-zA-Z0-9._-]{1,40}$'),
  allowed_page_paths text[] not null check (cardinality(allowed_page_paths) between 1 and 200
    and array_position(allowed_page_paths, null) is null),
  hourly_limit integer not null default 100 check (hourly_limit between 1 and 1000),
  phone_daily_limit integer not null default 5 check (phone_daily_limit between 1 and 20),
  created_at timestamptz not null default now()
);

create table if not exists public.crm_site_inquiries (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.crm_intake_sites(id) on delete cascade,
  request_key uuid not null,
  lead_id uuid references public.leads(id) on delete set null,
  inquiry jsonb not null check (jsonb_typeof(inquiry) = 'object'),
  consent_received_at timestamptz not null default now(),
  unique (site_id, request_key)
);
create index if not exists crm_site_inquiries_recent_idx
  on public.crm_site_inquiries(site_id, consent_received_at desc);
create index if not exists crm_site_inquiries_phone_idx
  on public.crm_site_inquiries(site_id, (inquiry->>'phone'), consent_received_at desc);

alter table public.crm_intake_sites enable row level security;
alter table public.crm_site_inquiries enable row level security;
revoke all on public.crm_intake_sites, public.crm_site_inquiries from public, anon, authenticated;
grant select, insert, update, delete on public.crm_intake_sites, public.crm_site_inquiries to service_role;

create or replace function public.accept_crm_site_inquiry(
  p_site_key text, p_request_key uuid, p_inquiry jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_site public.crm_intake_sites%rowtype;
  v_existing public.crm_site_inquiries%rowtype;
  v_lead uuid;
  v_stage uuid;
  v_source uuid;
  v_status text;
begin
  if p_request_key is null or p_inquiry is null or jsonb_typeof(p_inquiry) <> 'object' then
    raise exception using message = 'invalid_inquiry', errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_inquiry) k where k not in
    ('name','phone','business','service','pagePath','consentVersion','consent'))
    or not (p_inquiry ?& array['name','phone','business','service','pagePath','consentVersion','consent'])
    or p_inquiry->'consent' <> 'true'::jsonb then
    raise exception using message = 'invalid_inquiry', errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(p_inquiry) e where e.key <> 'consent' and jsonb_typeof(e.value) <> 'string')
    or length(btrim(p_inquiry->>'name')) not between 1 and 100
    or length(btrim(p_inquiry->>'business')) not between 1 and 160
    or (p_inquiry->>'phone') !~ '^\+[1-9][0-9]{9,14}$'
    or (p_inquiry->>'service') not in ('targeted-advertising','lead-generation','call-center','advertising-and-operations')
    or length(p_inquiry->>'pagePath') > 240
    or (p_inquiry->>'pagePath') !~ '^/ru/([a-z0-9-]+/)*$'
    or (p_inquiry->>'consentVersion') !~ '^[a-zA-Z0-9._-]{1,40}$'
    or exists (select 1 from jsonb_each_text(p_inquiry) e where e.value ~ '[[:cntrl:]<>]') then
    raise exception using message = 'invalid_inquiry', errcode = '22023';
  end if;

  -- Serialize requests for one site: retry/dedup/rate checks and lead insert are atomic.
  select * into v_site from public.crm_intake_sites where site_key = p_site_key for update;
  if not found or not v_site.enabled then
    raise exception using message = 'site_unavailable', errcode = '22023';
  end if;
  if p_inquiry->>'consentVersion' <> v_site.consent_version
    or not coalesce((p_inquiry->>'pagePath') = any(v_site.allowed_page_paths), false) then
    raise exception using message = 'invalid_inquiry', errcode = '22023';
  end if;

  select * into v_existing from public.crm_site_inquiries
    where site_id = v_site.id and request_key = p_request_key;
  if found then
    if v_existing.inquiry <> p_inquiry then
      raise exception using message = 'request_conflict', errcode = '22023';
    end if;
    return jsonb_build_object('accepted', true);
  end if;

  if (select count(*) from public.crm_site_inquiries where site_id = v_site.id
      and consent_received_at > now() - interval '1 hour') >= v_site.hourly_limit
    or (select count(*) from public.crm_site_inquiries where site_id = v_site.id
      and inquiry->>'phone' = p_inquiry->>'phone'
      and consent_received_at > now() - interval '1 day') >= v_site.phone_daily_limit then
    raise exception using message = 'intake_rate_limited', errcode = '22023';
  end if;

  -- Repeated clicks with new request keys can reuse only this site's recent lead.
  -- Never merge unrelated historical CRM contacts merely because a phone matches.
  select i.lead_id into v_lead from public.crm_site_inquiries i
    join public.leads l on l.id = i.lead_id and l.workspace_id = v_site.workspace_id
    where i.site_id = v_site.id and i.inquiry->>'phone' = p_inquiry->>'phone'
      and i.inquiry->>'service' = p_inquiry->>'service'
      and i.inquiry->>'business' = p_inquiry->>'business'
      and i.inquiry->>'name' = p_inquiry->>'name'
      and i.consent_received_at > now() - interval '1 day'
    order by i.consent_received_at desc limit 1;

  if v_lead is null then
    select id, stage_key into v_stage, v_status from public.lead_stages
      where workspace_id = v_site.workspace_id and is_active and semantic_group = 'new'
      order by is_default desc, sort_order, id limit 1;
    select id into v_source from public.lead_sources
      where workspace_id = v_site.workspace_id and is_active and source_key = 'website'
      order by id limit 1;
    insert into public.leads(workspace_id, full_name, phone, source, status, stage_id, source_id, notes)
      values(v_site.workspace_id, p_inquiry->>'name', p_inquiry->>'phone', 'website',
        coalesce(v_status, 'new'), v_stage, v_source,
        'Организация: ' || (p_inquiry->>'business') || E'\nНаправление: ' ||
        case p_inquiry->>'service'
          when 'targeted-advertising' then 'Таргетированная реклама'
          when 'lead-generation' then 'Маркетинг и лидогенерация'
          when 'call-center' then 'Колл-центр и обработка заявок'
          when 'advertising-and-operations' then 'Реклама + обработка обращений'
        end)
      returning id into v_lead;
  end if;
  insert into public.crm_site_inquiries(site_id, request_key, lead_id, inquiry)
    values(v_site.id, p_request_key, v_lead, p_inquiry);
  -- No tenant identifiers, lead identifiers or personal data in the public result.
  return jsonb_build_object('accepted', true);
end;
$$;

revoke all on function public.accept_crm_site_inquiry(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.accept_crm_site_inquiry(text, uuid, jsonb) to service_role;
comment on table public.crm_site_inquiries is
  'Server-only consent receipts containing personal data. Include in data deletion handling; never expose through generic CRM resources.';
commit;
notify pgrst, 'reload schema';
