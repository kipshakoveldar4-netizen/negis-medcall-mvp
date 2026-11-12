-- Negis CRM6: workspace-scoped lead pipeline stages and lead sources.
-- Apply after 014_meta_ad_launches.sql. Legacy status/source/campaign snapshots
-- remain intact so older clients and local demo data continue to work.

create table if not exists public.lead_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  stage_key text not null,
  name text not null,
  color text,
  semantic_group text not null check (semantic_group in ('new', 'in_progress', 'booked', 'lost')),
  sort_order integer not null default 0,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, stage_key)
);

create table if not exists public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_key text not null,
  name text not null,
  channel text,
  color text,
  sort_order integer not null default 0,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_key)
);

alter table public.leads
  add column if not exists stage_id uuid,
  add column if not exists source_id uuid,
  add column if not exists meta_campaign_launch_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.leads'::regclass and conname = 'leads_stage_id_fkey'
  ) then
    alter table public.leads
      add constraint leads_stage_id_fkey foreign key (stage_id)
      references public.lead_stages(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.leads'::regclass and conname = 'leads_source_id_fkey'
  ) then
    alter table public.leads
      add constraint leads_source_id_fkey foreign key (source_id)
      references public.lead_sources(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.leads'::regclass and conname = 'leads_meta_campaign_launch_id_fkey'
  ) then
    alter table public.leads
      add constraint leads_meta_campaign_launch_id_fkey foreign key (meta_campaign_launch_id)
      references public.meta_campaign_launches(id) on delete set null;
  end if;
end;
$$;

create index if not exists lead_stages_workspace_sort_idx
  on public.lead_stages(workspace_id, sort_order);
create index if not exists lead_stages_workspace_semantic_idx
  on public.lead_stages(workspace_id, semantic_group);
create index if not exists lead_sources_workspace_sort_idx
  on public.lead_sources(workspace_id, sort_order);
create index if not exists lead_sources_workspace_channel_idx
  on public.lead_sources(workspace_id, channel);
create index if not exists leads_workspace_stage_idx
  on public.leads(workspace_id, stage_id);
create index if not exists leads_workspace_source_idx
  on public.leads(workspace_id, source_id);
create index if not exists leads_workspace_meta_campaign_launch_idx
  on public.leads(workspace_id, meta_campaign_launch_id);

create or replace function public.seed_default_lead_taxonomy(target_workspace_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  insert into public.lead_stages (
    workspace_id,
    stage_key,
    name,
    color,
    semantic_group,
    sort_order,
    is_default
  )
  values
    (target_workspace_id, 'new', 'Новая', '#2563eb', 'new', 10, true),
    (target_workspace_id, 'in_progress', 'В работе', '#d97706', 'in_progress', 20, true),
    (target_workspace_id, 'booked', 'Записана', '#059669', 'booked', 30, true),
    (target_workspace_id, 'lost', 'Потеряна', '#dc2626', 'lost', 40, true)
  on conflict (workspace_id, stage_key) do nothing;

  insert into public.lead_sources (
    workspace_id,
    source_key,
    name,
    channel,
    color,
    sort_order,
    is_default
  )
  values
    (target_workspace_id, 'manual', 'Вручную', 'manual', '#64748b', 10, true),
    (target_workspace_id, 'meta_ads', 'Meta Ads', 'ads', '#2563eb', 20, true),
    (target_workspace_id, 'instagram', 'Instagram', 'social', '#db2777', 30, true),
    (target_workspace_id, 'whatsapp', 'WhatsApp', 'messenger', '#059669', 40, true),
    (target_workspace_id, 'website', 'Сайт', 'website', '#0891b2', 50, true),
    (target_workspace_id, 'referral', 'Рекомендация', 'referral', '#7c3aed', 60, true),
    (target_workspace_id, 'webhook', 'Webhook', 'integration', '#475569', 70, true),
    (target_workspace_id, 'other', 'Другое', 'other', '#78716c', 80, true)
  on conflict (workspace_id, source_key) do nothing;
end;
$$;

do $$
declare
  workspace_row record;
begin
  for workspace_row in select id from public.workspaces loop
    perform public.seed_default_lead_taxonomy(workspace_row.id);
  end loop;
end;
$$;

-- Future workspaces receive the same defaults without API-specific setup.
create or replace function public.seed_default_lead_taxonomy_after_workspace_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.seed_default_lead_taxonomy(new.id);
  return new;
end;
$$;

drop trigger if exists seed_default_lead_taxonomy_on_workspace on public.workspaces;
create trigger seed_default_lead_taxonomy_on_workspace
  after insert on public.workspaces
  for each row
  execute function public.seed_default_lead_taxonomy_after_workspace_insert();

-- Every unknown historical source gets a stable workspace-local definition.
insert into public.lead_sources (
  workspace_id,
  source_key,
  name,
  channel,
  color,
  sort_order,
  is_default
)
select distinct on (lead.workspace_id, md5(lower(trim(lead.source))))
  lead.workspace_id,
  'legacy_' || md5(lower(trim(lead.source))),
  trim(lead.source),
  'other',
  '#78716c',
  900,
  false
from public.leads lead
where lead.workspace_id is not null
  and nullif(trim(lead.source), '') is not null
  and case
    when lower(trim(lead.source)) in ('meta', 'meta ads', 'facebook', 'facebook ads', 'instagram ads') then 'meta_ads'
    when lower(trim(lead.source)) in ('instagram', 'инстаграм') then 'instagram'
    when lower(trim(lead.source)) in ('whatsapp', 'what''s app', 'ватсап', 'вотсап') then 'whatsapp'
    when lower(trim(lead.source)) in ('website', 'site', 'сайт', 'landing', 'лендинг') then 'website'
    when lower(trim(lead.source)) in ('referral', 'recommendation', 'рекомендация') then 'referral'
    when lower(trim(lead.source)) in ('webhook') then 'webhook'
    when lower(trim(lead.source)) in ('manual', 'вручную') then 'manual'
    when lower(trim(lead.source)) in ('other', 'другое') then 'other'
    else null
  end is null
order by lead.workspace_id, md5(lower(trim(lead.source))), lead.created_at nulls last
on conflict (workspace_id, source_key) do nothing;

-- Structured stage backfill follows the current CRM semantic normalization.
update public.leads lead
set stage_id = stage.id
from public.lead_stages stage
where lead.stage_id is null
  and lead.workspace_id = stage.workspace_id
  and stage.stage_key = case
    when lower(trim(coalesce(lead.status, ''))) ~ '(работ|обработ|прогресс|progress|contact|follow|связ|звон)' then 'in_progress'
    when lower(trim(coalesce(lead.status, ''))) ~ '(запис|book|appointment|schedul|приш|arriv|visit|came|показ)' then 'booked'
    when lower(trim(coalesce(lead.status, ''))) ~ '(потер|отказ|lost|reject|declin|cancel|отмен|fail|неудач|спам)' then 'lost'
    when lower(trim(coalesce(lead.status, ''))) ~ '(нов|new)' then 'new'
    else 'new'
  end;

-- Known sources map to defaults; custom values map to their legacy_<hash> row.
update public.leads lead
set source_id = source.id
from public.lead_sources source
where lead.source_id is null
  and lead.workspace_id = source.workspace_id
  and source.source_key = case
    when nullif(trim(coalesce(lead.source, '')), '') is null then 'manual'
    when lower(trim(lead.source)) in ('meta', 'meta ads', 'facebook', 'facebook ads', 'instagram ads') then 'meta_ads'
    when lower(trim(lead.source)) in ('instagram', 'инстаграм') then 'instagram'
    when lower(trim(lead.source)) in ('whatsapp', 'what''s app', 'ватсап', 'вотсап') then 'whatsapp'
    when lower(trim(lead.source)) in ('website', 'site', 'сайт', 'landing', 'лендинг') then 'website'
    when lower(trim(lead.source)) in ('referral', 'recommendation', 'рекомендация') then 'referral'
    when lower(trim(lead.source)) = 'webhook' then 'webhook'
    when lower(trim(lead.source)) in ('manual', 'вручную') then 'manual'
    when lower(trim(lead.source)) in ('other', 'другое') then 'other'
    else 'legacy_' || md5(lower(trim(lead.source)))
  end;

-- Campaign attribution is intentionally exact-only. A name/meta id/internal id
-- is linked only when it resolves to one launch in the same workspace.
with exact_campaign_matches as (
  select
    lead.id as lead_id,
    min(launch.id::text)::uuid as launch_id
  from public.leads lead
  join public.meta_campaign_launches launch
    on launch.workspace_id = lead.workspace_id
   and (
     trim(lead.campaign) = launch.id::text
     or (
       nullif(trim(launch.meta_campaign_id), '') is not null
       and lower(trim(lead.campaign)) = lower(trim(launch.meta_campaign_id))
     )
     or (
       nullif(trim(launch.meta_campaign_id), '') is not null
       and lower(trim(launch.meta_campaign_id)) not like 'dryrun_%'
       and lower(trim(lead.campaign)) = lower(trim(launch.campaign_name))
     )
   )
  where lead.meta_campaign_launch_id is null
    and lead.workspace_id is not null
    and nullif(trim(lead.campaign), '') is not null
  group by lead.id
  having count(distinct launch.id) = 1
)
update public.leads lead
set meta_campaign_launch_id = matched.launch_id
from exact_campaign_matches matched
where lead.id = matched.lead_id;
