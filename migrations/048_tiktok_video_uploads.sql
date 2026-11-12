-- Server-only upload receipts. No campaigns, tokens, raw responses or URLs.
begin;

create table if not exists public.tiktok_video_uploads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  asset_id uuid not null references public.ad_creative_assets(id) on delete cascade,
  advertiser_id text not null check (advertiser_id ~ '^[0-9]{5,32}$'),
  source_fingerprint text not null check (source_fingerprint ~ '^[a-f0-9]{64}$'),
  asset_revision timestamptz not null,
  status text not null default 'uploading' check (status in ('uploading', 'uploaded', 'failed', 'unknown')),
  video_id text check (video_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  error_code text check (error_code in ('provider_rejected', 'upload_unknown', 'persistence_failed', 'connection_revoked')),
  attempt integer not null default 1 check (attempt between 1 and 3),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'uploaded') = (video_id is not null)),
  unique (workspace_id, advertiser_id, asset_id, source_fingerprint)
);
create index if not exists tiktok_video_uploads_asset_idx
  on public.tiktok_video_uploads (workspace_id, advertiser_id, asset_id, updated_at desc);
alter table public.tiktok_video_uploads enable row level security;
revoke all on table public.tiktok_video_uploads from public, anon, authenticated;
grant select, insert, update on table public.tiktok_video_uploads to service_role;
comment on table public.tiktok_video_uploads is
  'A receipt claim precedes each upload. Unknown/stale uploading receipts cannot be automatically retried. Only explicit known rejections allow bounded retries.';

commit;
notify pgrst, 'reload schema';
