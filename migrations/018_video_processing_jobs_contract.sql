-- Large video optimization pipeline contract fields.
-- Extends migration 016 without breaking the current /api/crm/video-jobs raw-upload flow.

alter table public.video_processing_jobs
  add column if not exists optimized_bucket text,
  add column if not exists optimized_path text,
  add column if not exists optimized_public_url text,
  add column if not exists thumbnail_url text,
  add column if not exists input_mime_type text,
  add column if not exists output_mime_type text,
  add column if not exists input_size_bytes bigint,
  add column if not exists output_size_bytes bigint,
  add column if not exists compression_ratio numeric,
  add column if not exists meta_video_id text,
  add column if not exists error_message text,
  add column if not exists started_at timestamptz;

update public.video_processing_jobs
set
  optimized_bucket = coalesce(optimized_bucket, output_bucket),
  optimized_path = coalesce(optimized_path, output_path),
  optimized_public_url = coalesce(optimized_public_url, output_public_url),
  thumbnail_url = coalesce(thumbnail_url, thumbnail_public_url),
  input_mime_type = coalesce(input_mime_type, source_mime_type),
  input_size_bytes = coalesce(input_size_bytes, raw_size),
  output_size_bytes = coalesce(output_size_bytes, output_size),
  error_message = coalesce(error_message, error)
where
  optimized_bucket is null
  or optimized_path is null
  or optimized_public_url is null
  or thumbnail_url is null
  or input_mime_type is null
  or input_size_bytes is null
  or output_size_bytes is null
  or error_message is null;

alter table public.video_processing_jobs
  drop constraint if exists video_processing_jobs_status_check;

alter table public.video_processing_jobs
  add constraint video_processing_jobs_status_check
  check (
    status in (
      'awaiting_upload',
      'queued',
      'downloading',
      'transcoding',
      'uploading',
      'ready',
      'failed',
      'deleted_original'
    )
  );
