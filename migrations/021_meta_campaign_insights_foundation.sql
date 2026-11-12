-- Negis CRM11a: Meta Insights schema foundation.
-- Apply after 020_crm_deals_foundation.sql.
-- This migration stores normalized daily metrics only. It does not fetch Meta
-- data and intentionally has no columns for raw responses or paging URLs.

create table if not exists public.meta_campaign_insights (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_campaign_launch_id uuid not null references public.meta_campaign_launches(id) on delete cascade,
  meta_campaign_id text not null,
  ad_account_id text,
  date_start date not null,
  date_stop date not null,
  spend_minor bigint not null default 0 check (spend_minor >= 0),
  currency text not null,
  currency_exponent integer not null default 2 check (currency_exponent >= 0 and currency_exponent <= 6),
  impressions bigint not null default 0 check (impressions >= 0),
  reach bigint not null default 0 check (reach >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  inline_link_clicks bigint not null default 0 check (inline_link_clicks >= 0),
  meta_leads bigint check (meta_leads is null or meta_leads >= 0),
  action_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(action_counts) = 'object'),
  api_version text,
  account_timezone text,
  attribution_setting text,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, meta_campaign_launch_id, date_start, date_stop),
  check (date_stop >= date_start)
);

create index if not exists meta_campaign_insights_workspace_launch_date_idx
  on public.meta_campaign_insights(workspace_id, meta_campaign_launch_id, date_start desc);
create index if not exists meta_campaign_insights_workspace_date_idx
  on public.meta_campaign_insights(workspace_id, date_start desc);
create index if not exists meta_campaign_insights_workspace_campaign_date_idx
  on public.meta_campaign_insights(workspace_id, meta_campaign_id, date_start desc);
create index if not exists meta_campaign_insights_workspace_fetched_at_idx
  on public.meta_campaign_insights(workspace_id, fetched_at desc);

create table if not exists public.meta_insights_sync_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_campaign_launch_id uuid references public.meta_campaign_launches(id) on delete set null,
  sync_scope text not null default 'campaign',
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed')),
  date_start date,
  date_stop date,
  rows_upserted integer not null default 0 check (rows_upserted >= 0),
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (date_start is null or date_stop is null or date_stop >= date_start)
);

create index if not exists meta_insights_sync_runs_workspace_created_at_idx
  on public.meta_insights_sync_runs(workspace_id, created_at desc);
create index if not exists meta_insights_sync_runs_workspace_status_created_at_idx
  on public.meta_insights_sync_runs(workspace_id, status, created_at desc);
create index if not exists meta_insights_sync_runs_workspace_launch_created_at_idx
  on public.meta_insights_sync_runs(workspace_id, meta_campaign_launch_id, created_at desc);
