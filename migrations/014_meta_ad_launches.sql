create table if not exists public.meta_campaign_launches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  launched_by text,
  launched_by_role text,
  source_module text,
  source_id text,
  campaign_name text not null,
  objective text,
  status text default 'draft',
  meta_campaign_id text,
  meta_adset_id text,
  meta_creative_id text,
  meta_ad_id text,
  meta_status text,
  budget_daily_minor integer,
  budget_total_minor integer,
  currency text default 'USD',
  start_time timestamptz,
  end_time timestamptz,
  page_id text,
  instagram_actor_id text,
  ad_account_id text,
  payload jsonb,
  compliance jsonb,
  meta_response jsonb,
  last_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.meta_launch_audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  launch_id uuid references public.meta_campaign_launches(id) on delete cascade,
  actor_name text,
  actor_role text,
  action text not null,
  details jsonb,
  created_at timestamptz default now()
);

create index if not exists meta_campaign_launches_workspace_id_idx
  on public.meta_campaign_launches(workspace_id);

create index if not exists meta_campaign_launches_status_idx
  on public.meta_campaign_launches(status);

create index if not exists meta_campaign_launches_meta_campaign_id_idx
  on public.meta_campaign_launches(meta_campaign_id);

create index if not exists meta_campaign_launches_created_at_idx
  on public.meta_campaign_launches(created_at desc);

create index if not exists meta_launch_audit_logs_workspace_id_idx
  on public.meta_launch_audit_logs(workspace_id);

create index if not exists meta_launch_audit_logs_created_at_idx
  on public.meta_launch_audit_logs(created_at desc);
