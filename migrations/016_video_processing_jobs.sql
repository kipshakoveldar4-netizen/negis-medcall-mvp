-- Large video optimization pipeline (Phase A).
-- Jobs are created as awaiting_upload, become queued only after the browser
-- confirms the raw upload, and the worker (Phase B) picks up queued jobs.
-- ready is the usable terminal state; raw cleanup is tracked by raw_deleted_at,
-- not by a separate status.

create table if not exists public.video_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  asset_id uuid references public.ad_creative_assets(id) on delete set null,
  -- awaiting_upload | queued | downloading | transcoding | uploading | ready | failed
  status text not null default 'awaiting_upload',
  progress integer default 0,
  raw_bucket text default 'ad-creatives-raw',
  raw_path text,
  raw_public_url text,
  raw_size bigint,
  source_file_name text,
  source_mime_type text,
  output_bucket text default 'ad-creatives',
  output_path text,
  output_public_url text,
  output_size bigint,
  thumbnail_path text,
  thumbnail_public_url text,
  thumbnail_source text,
  error text,
  attempts integer default 0,
  claimed_by text,
  claimed_at timestamptz,
  raw_deleted_at timestamptz,
  raw_delete_error text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists video_processing_jobs_workspace_id_idx
  on public.video_processing_jobs(workspace_id);

create index if not exists video_processing_jobs_status_idx
  on public.video_processing_jobs(status);

create index if not exists video_processing_jobs_created_at_idx
  on public.video_processing_jobs(created_at desc);

create index if not exists video_processing_jobs_asset_id_idx
  on public.video_processing_jobs(asset_id);

-- Private bucket for raw originals. Never public: raw files are temporary and
-- must never be served to Meta or end users; only signed uploads/downloads.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ad-creatives-raw',
  'ad-creatives-raw',
  false,
  524288000,
  array[
    'video/mp4',
    'video/quicktime',
    'video/webm'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
