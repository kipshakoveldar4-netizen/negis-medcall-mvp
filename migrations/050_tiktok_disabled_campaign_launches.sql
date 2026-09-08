-- Durable receipts for the first TikTok write flow.
-- Every provider object is explicitly created disabled; no token, destination
-- URL, payload or raw provider response is stored in this table.
begin;

create table if not exists public.tiktok_campaign_launches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  advertiser_id text not null check (advertiser_id ~ '^[0-9]{5,32}$'),
  video_upload_id uuid not null references public.tiktok_video_uploads(id) on delete restrict,
  requested_by_staff_user_id uuid references public.staff_users(id) on delete set null,
  idempotency_key uuid not null,
  campaign_name text not null check (char_length(campaign_name) between 1 and 128),
  service text not null check (char_length(service) between 1 and 160),
  city text not null check (char_length(city) between 1 and 100),
  daily_budget_minor bigint not null check (daily_budget_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  destination_fingerprint text not null check (destination_fingerprint ~ '^[a-f0-9]{64}$'),
  operation_status text not null default 'DISABLE' check (operation_status = 'DISABLE'),
  status text not null default 'creating' check (
    status in ('creating', 'campaign_created', 'adgroup_created', 'created_disabled', 'failed', 'unknown')
  ),
  current_step text not null default 'campaign' check (
    current_step in ('campaign', 'adgroup', 'ad', 'complete')
  ),
  campaign_id text check (campaign_id is null or campaign_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  adgroup_id text check (adgroup_id is null or adgroup_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  ad_id text check (ad_id is null or ad_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  error_step text check (error_step is null or error_step in ('campaign', 'adgroup', 'ad', 'persistence')),
  error_code text check (
    error_code is null or error_code in (
      'provider_auth',
      'provider_permission',
      'provider_rate_limited',
      'provider_rejected',
      'provider_response_unknown',
      'request_timeout',
      'connection_revoked',
      'persistence_failed'
    )
  ),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  check (status <> 'creating' or (campaign_id is null and adgroup_id is null and ad_id is null)),
  check (status <> 'campaign_created' or (campaign_id is not null and adgroup_id is null and ad_id is null)),
  check (status <> 'adgroup_created' or (campaign_id is not null and adgroup_id is not null and ad_id is null)),
  check (status <> 'created_disabled' or (
    campaign_id is not null and adgroup_id is not null and ad_id is not null and
    current_step = 'complete' and finished_at is not null and error_step is null and error_code is null
  )),
  check ((status in ('failed', 'unknown')) = (error_step is not null and error_code is not null)),
  check (status not in ('failed', 'unknown') or finished_at is not null)
);

create index if not exists tiktok_campaign_launches_workspace_created_idx
  on public.tiktok_campaign_launches (workspace_id, created_at desc);
create index if not exists tiktok_campaign_launches_workspace_status_idx
  on public.tiktok_campaign_launches (workspace_id, status, updated_at desc);
create unique index if not exists tiktok_campaign_launches_provider_campaign_idx
  on public.tiktok_campaign_launches (advertiser_id, campaign_id)
  where campaign_id is not null;

alter table public.tiktok_campaign_launches enable row level security;
revoke all on table public.tiktok_campaign_launches from public, anon, authenticated;
grant select, insert, update on table public.tiktok_campaign_launches to service_role;

comment on table public.tiktok_campaign_launches is
  'Server-only idempotency and progress receipts for TikTok DISABLE campaign creation. Unknown outcomes are never retried automatically.';
comment on column public.tiktok_campaign_launches.destination_fingerprint is
  'SHA-256 evidence only. The destination URL is never persisted in this receipt.';

commit;
notify pgrst, 'reload schema';
