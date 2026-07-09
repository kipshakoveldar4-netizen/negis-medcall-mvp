# Large Video Pipeline Foundation

## Why It Exists

Clinic staff can upload normal photos and small MP4/MOV videos directly for Ads Automation. Large videos are different: they can hit Supabase direct-upload limits, take too long for Vercel functions, and should not be sent to Meta as raw originals.

For MVP safety, a large video is not treated as a ready creative. It becomes a processing job first. A future worker will create an optimized MP4 for Meta.

## Storage Model

- Raw bucket: `ad-creatives-raw`
- Final bucket: `ad-creatives`
- Raw originals are temporary and private.
- Optimized MP4 files are written to `ad-creatives`.
- Meta must use `optimized_public_url` later, never the raw original URL.
- Raw originals should be deleted only after the optimized MP4 and thumbnail are saved successfully.

## Database

Migration:

```text
migrations/018_video_processing_jobs_contract.sql
```

Table:

```text
video_processing_jobs
```

Important status values:

- `queued`
- `downloading`
- `transcoding`
- `uploading`
- `ready`
- `failed`
- `deleted_original`

The current upload handshake can still use `awaiting_upload` before the browser confirms raw upload completion.

## API Contract

All endpoints live in the existing CRM catch-all function:

```text
api/crm/[...path].ts
```

**Canonical browser upload endpoint: `/api/crm/video-jobs`.** This is the endpoint Ads
Automation uses to upload a large video. Its `POST` returns a **signed upload URL** for the
raw bucket and creates the job (`awaiting_upload`); the browser uploads the raw original to
`ad-creatives-raw`, then `PATCH` confirms the upload and moves the job to `queued`. Polling
uses `GET /api/crm/video-jobs?id=...`.

```text
POST  /api/crm/video-jobs         → signed raw upload + create job (awaiting_upload)
PATCH /api/crm/video-jobs         → confirm raw upload → queued
GET   /api/crm/video-jobs?id=...  → poll safe job status
```

`/api/crm/video-processing-jobs` is a **lower-level job CRUD/status/retry** endpoint (it does
not issue signed uploads). Ads Automation uses only its retry action:

- `POST /api/crm/video-processing-jobs`
- `GET /api/crm/video-processing-jobs/:id`
- `POST /api/crm/video-processing-jobs/:id/retry` — used by the “Повторить обработку” button

Both endpoints write/read the same `video_processing_jobs` table, and the worker claims
`queued` jobs from that table regardless of which endpoint created them.

The response exposes safe fields only:

- `id`
- `status`
- `progress`
- `optimizedPublicUrl`
- `thumbnailUrl`
- `inputSizeBytes`
- `outputSizeBytes`
- `compressionRatio`
- `errorMessage`
- timestamps

Raw storage paths, raw public URLs, worker claim fields, service role keys, and worker secrets are not returned to the frontend.

## Env Vars

```text
VIDEO_OPTIMIZATION_ENABLED=false
VIDEO_OPTIMIZATION_THRESHOLD_MB=50
VIDEO_OPTIMIZATION_MAX_INPUT_MB=500
VIDEO_OPTIMIZATION_RAW_BUCKET=ad-creatives-raw
VIDEO_OPTIMIZATION_OUTPUT_BUCKET=ad-creatives
VIDEO_OPTIMIZATION_WORKER_SECRET=
```

Worker-side env (Railway):

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
VIDEO_OPTIMIZATION_RAW_BUCKET=ad-creatives-raw
VIDEO_OPTIMIZATION_OUTPUT_BUCKET=ad-creatives
VIDEO_WORKER_POLL_INTERVAL_MS=5000
VIDEO_WORKER_ID=
VIDEO_WORKER_MAX_ATTEMPTS=3
VIDEO_WORKER_MAX_CONCURRENT_JOBS=1
VIDEO_WORKER_TMP_DIR=/tmp
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
VIDEO_WORKER_CRF=23
VIDEO_WORKER_PRESET=medium
VIDEO_WORKER_MAX_WIDTH=1080
VIDEO_WORKER_FPS=30
```

ffmpeg optimization (implemented in `artifacts/video-worker/src/ffmpeg.ts`):

```text
-vf "scale='min(1080,iw)':-2,fps=30" -c:v libx264 -preset medium -crf 23
-pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -map_metadata -1
```

Width-capped, aspect/orientation preserved, no crop, metadata stripped, H.264 + AAC + faststart.

Secrets stay server-side only. Do not add service role keys or worker secrets to Vite frontend env.

## UI Behavior

Small photo and small video flow stays unchanged.

If a video is above `VIDEO_OPTIMIZATION_THRESHOLD_MB`:

- it is not marked `ready_for_meta`;
- the “Дальше” and real launch buttons stay disabled;
- client mode shows a friendly optimization message;
- admin mode shows file size, threshold, MIME type, optimization flag, raw bucket plan, and internal readiness status;
- raw Supabase errors are hidden from clinic users.

If optimization is disabled, the UI asks the user to upload a video below the threshold or MP4/H.264.

## Worker (implemented)

The worker package lives at:

```text
artifacts/video-worker
```

Commands:

```bash
cd artifacts/video-worker
pnpm install         # or npm install
pnpm run dev         # run locally (needs ffmpeg on PATH + Supabase env)
pnpm run build       # compile to dist/
pnpm run start       # run compiled worker
```

Deploy to Railway with **Root Directory** `artifacts/video-worker` (the Dockerfile installs ffmpeg). See `docs/VIDEO-WORKER.md`.

The worker (see `artifacts/video-worker/src/worker.ts`):

1. polls `video_processing_jobs` for `status = queued`;
2. claims one atomically (`queued → downloading` guarded by `status = 'queued'`);
3. downloads the raw video from `ad-creatives-raw` (service role);
4. transcodes to MP4/H.264 + AAC (`transcoding`);
5. generates a thumbnail from the optimized MP4;
6. uploads optimized files to `ad-creatives` (`uploading`);
7. updates `ad_creative_assets`;
8. marks the job `ready` with the 018 contract fields (`optimized_public_url`, `thumbnail_url`, `output_size_bytes`, `compression_ratio`, `completed_at`, …);
9. deletes the raw original (records `raw_deleted_at`; a delete failure never fails the ready video).

## Current implementation status

Implemented (browser side, via `/api/crm/video-jobs`):

- Raw large-video upload to `ad-creatives-raw` through a signed upload URL.
- `video_processing_jobs` record creation.
- Polling of the job by id (every ~5s), stopping on `ready` or `failed`.
- Launch/preview blocked until the job is `ready` (`ready_for_meta` is never true for a raw video).
- Friendly Russian client statuses; raw bucket/path/URL hidden in client mode, shown only in admin technical details.
- Retry of a failed job via `POST /api/crm/video-processing-jobs/:id/retry` (“Повторить обработку”).

Pending (future ffmpeg worker):

- The worker is not running in production yet, so a `queued` job stays `queued` — the UI treats this as a normal pending state, not a failure.
- Meta optimized-video usage: the launch will use the worker’s `optimized_public_url`; the raw original is never sent to Meta.
- Raw original deletion after successful optimization.

## Not Implemented In This Step

- No new full ffmpeg worker behavior was enabled.
- No ACTIVE launch was enabled.
- No database schema change is required for existing photo/small-video launches.
- No Meta launch logic was rewritten.
- No new Vercel API files were added (existing catch-all only).
