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

Endpoints:

- `POST /api/crm/video-processing-jobs`
- `GET /api/crm/video-processing-jobs/:id`
- `POST /api/crm/video-processing-jobs/:id/retry`

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
VIDEO_OPTIMIZATION_WORKER_SECRET=
```

Worker-side env:

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
VIDEO_WORKER_POLL_INTERVAL_MS=5000
VIDEO_WORKER_ID=
VIDEO_WORKER_MAX_ATTEMPTS=3
VIDEO_WORKER_TMP_DIR=/tmp
VIDEO_WORKER_CRF=23
VIDEO_WORKER_PRESET=medium
VIDEO_WORKER_MAX_WIDTH=1080
VIDEO_WORKER_MAX_HEIGHT=1920
VIDEO_WORKER_FPS=30
```

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

## Future Worker Command

The existing worker package lives at:

```text
artifacts/video-worker
```

Planned command:

```bash
cd artifacts/video-worker
pnpm run dev
```

The worker will later:

1. poll `video_processing_jobs`;
2. download raw video from `ad-creatives-raw`;
3. transcode to MP4/H.264;
4. generate a thumbnail;
5. upload optimized files to `ad-creatives`;
6. update `ad_creative_assets`;
7. mark the job `ready`;
8. delete the raw original.

## Not Implemented In This Step

- No new full ffmpeg worker behavior was enabled.
- No ACTIVE launch was enabled.
- No database schema change is required for existing photo/small-video launches.
- No Meta launch logic was rewritten.
