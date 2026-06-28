create table if not exists public.workspace_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(workspace_id, key)
);

create table if not exists public.integration_statuses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  provider text not null,
  status text not null default 'not_configured',
  masked_identifier text,
  last_checked_at timestamptz,
  last_error text,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(workspace_id, provider)
);

create table if not exists public.ai_provider_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  provider text not null,
  purpose text not null,
  enabled boolean default false,
  model_name text,
  config jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(workspace_id, provider, purpose)
);

create table if not exists public.meta_ad_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  meta_business_id text,
  ad_account_id text,
  page_id text,
  instagram_actor_id text,
  account_name text,
  currency text,
  timezone_name text,
  status text default 'draft',
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.release_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  check_key text not null,
  status text not null default 'pending',
  notes text,
  checked_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(workspace_id, check_key)
);

create index if not exists workspace_settings_workspace_id_idx on public.workspace_settings(workspace_id);
create index if not exists workspace_settings_key_idx on public.workspace_settings(key);

create index if not exists integration_statuses_workspace_id_idx on public.integration_statuses(workspace_id);
create index if not exists integration_statuses_provider_idx on public.integration_statuses(provider);
create index if not exists integration_statuses_status_idx on public.integration_statuses(status);

create index if not exists ai_provider_settings_workspace_id_idx on public.ai_provider_settings(workspace_id);
create index if not exists ai_provider_settings_provider_idx on public.ai_provider_settings(provider);
create index if not exists ai_provider_settings_purpose_idx on public.ai_provider_settings(purpose);

create index if not exists meta_ad_accounts_workspace_id_idx on public.meta_ad_accounts(workspace_id);
create index if not exists meta_ad_accounts_status_idx on public.meta_ad_accounts(status);
create index if not exists meta_ad_accounts_ad_account_id_idx on public.meta_ad_accounts(ad_account_id);

create index if not exists release_checks_workspace_id_idx on public.release_checks(workspace_id);
create index if not exists release_checks_status_idx on public.release_checks(status);
