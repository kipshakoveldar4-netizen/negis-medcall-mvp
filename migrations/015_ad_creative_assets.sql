create table if not exists public.ad_creative_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  launch_id uuid references public.meta_campaign_launches(id) on delete set null,
  uploaded_by text,
  file_name text,
  file_type text,
  mime_type text,
  file_size bigint,
  storage_bucket text default 'ad-creatives',
  storage_path text,
  public_url text,
  meta_asset_id text,
  meta_video_id text,
  status text default 'uploaded',
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists ad_creative_assets_workspace_id_idx
  on public.ad_creative_assets(workspace_id);

create index if not exists ad_creative_assets_launch_id_idx
  on public.ad_creative_assets(launch_id);

create index if not exists ad_creative_assets_file_type_idx
  on public.ad_creative_assets(file_type);

create index if not exists ad_creative_assets_status_idx
  on public.ad_creative_assets(status);

create index if not exists ad_creative_assets_created_at_idx
  on public.ad_creative_assets(created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ad-creatives',
  'ad-creatives',
  true,
  104857600,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'video/webm'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
