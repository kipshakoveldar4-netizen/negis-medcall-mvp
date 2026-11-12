-- One server-configured TikTok advertiser belongs to one workspace.
-- Credentials stay in server environment variables, never in this table.
begin;

create table if not exists public.tiktok_ad_account_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  advertiser_id text not null unique check (advertiser_id ~ '^[0-9]{5,32}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  account_timezone text not null check (char_length(account_timezone) between 1 and 100),
  enabled boolean not null default true,
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Upsert may refresh this exact pair, but cannot reassign either side.
  unique(workspace_id, advertiser_id)
);

alter table public.tiktok_ad_account_connections enable row level security;
revoke all on table public.tiktok_ad_account_connections from public, anon, authenticated;
grant select, insert, update on table public.tiktok_ad_account_connections to service_role;

commit;
notify pgrst, 'reload schema';
