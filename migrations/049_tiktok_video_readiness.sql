-- Server-only TikTok video processing/displayability state.
-- No provider IDs, media URLs, tokens or raw responses are added here.
begin;

alter table public.tiktok_video_uploads
  add column if not exists readiness_status text not null default 'not_checked',
  add column if not exists displayable boolean,
  add column if not exists tiktok_placement_allowed boolean,
  add column if not exists readiness_checked_at timestamptz,
  add column if not exists readiness_error_code text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tiktok_video_uploads'::regclass
      and conname = 'tiktok_video_uploads_readiness_status_check'
  ) then
    alter table public.tiktok_video_uploads
      add constraint tiktok_video_uploads_readiness_status_check
      check (readiness_status in ('not_checked', 'processing', 'ready', 'not_displayable', 'unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tiktok_video_uploads'::regclass
      and conname = 'tiktok_video_uploads_readiness_error_check'
  ) then
    alter table public.tiktok_video_uploads
      add constraint tiktok_video_uploads_readiness_error_check
      check (readiness_error_code is null or readiness_error_code in ('provider_rejected', 'check_unknown', 'connection_revoked'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tiktok_video_uploads'::regclass
      and conname = 'tiktok_video_uploads_readiness_consistency_check'
  ) then
    alter table public.tiktok_video_uploads
      add constraint tiktok_video_uploads_readiness_consistency_check
      check (
        (readiness_status = 'not_checked'
          and readiness_checked_at is null
          and readiness_error_code is null
          and displayable is null
          and tiktok_placement_allowed is null)
        or (readiness_status = 'processing'
          and readiness_checked_at is not null
          and readiness_error_code is null)
        or (readiness_status = 'ready'
          and readiness_checked_at is not null
          and readiness_error_code is null
          and displayable is true
          and tiktok_placement_allowed is true)
        or (readiness_status = 'not_displayable'
          and readiness_checked_at is not null
          and readiness_error_code is null
          and (displayable is false or tiktok_placement_allowed is false))
        or (readiness_status = 'unknown'
          and readiness_checked_at is not null
          and readiness_error_code is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tiktok_video_uploads'::regclass
      and conname = 'tiktok_video_uploads_readiness_requires_upload_check'
  ) then
    alter table public.tiktok_video_uploads
      add constraint tiktok_video_uploads_readiness_requires_upload_check
      check (status = 'uploaded' or readiness_status = 'not_checked');
  end if;
end $$;

create index if not exists tiktok_video_uploads_readiness_idx
  on public.tiktok_video_uploads (workspace_id, advertiser_id, readiness_status, readiness_checked_at desc);

alter table public.tiktok_video_uploads enable row level security;
revoke all on table public.tiktok_video_uploads from public, anon, authenticated;
grant select, insert, update on table public.tiktok_video_uploads to service_role;

comment on column public.tiktok_video_uploads.readiness_status is
  'Safe provider readiness only. No temporary preview URLs or raw TikTok response are persisted.';

commit;
notify pgrst, 'reload schema';
