-- Phase B: track when a video optimization job finished processing.
alter table public.video_processing_jobs
  add column if not exists completed_at timestamptz;
