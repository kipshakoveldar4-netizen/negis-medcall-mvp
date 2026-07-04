# Video Optimization Worker

Background worker for the large-video pipeline (`artifacts/video-worker`, `@workspace/video-worker`).
It runs **outside Vercel** (Railway or any Docker host) and processes `video_processing_jobs`
created by `POST /api/crm/video-jobs` (Phase A, migration 016; `completed_at` added in migration 017).

## What it does

1. Polls `video_processing_jobs` for `status = queued` with `attempts < VIDEO_WORKER_MAX_ATTEMPTS`.
2. Claims one job atomically: `UPDATE ... SET status='downloading', claimed_by, claimed_at, attempts+1 WHERE id = ? AND status = 'queued'`. If zero rows return, another worker won the job.
3. Downloads the raw original from the **private** `ad-creatives-raw` bucket.
4. Transcodes with ffmpeg to an ads-friendly MP4 (see command below).
5. Generates a JPG thumbnail from the **optimized** video at ~1 second.
6. Uploads both to the public `ad-creatives` bucket:
   - `optimized/{workspaceId|demo}/{jobId}.mp4`
   - `optimized/{workspaceId|demo}/{jobId}-thumbnail.jpg`
7. Updates the `ad_creative_assets` row: `public_url`/`storage_bucket`/`storage_path` now point at the optimized MP4, `status = ready`, metadata gets `optimized`, `optimizationStatus`, `thumbnailUrl`, `thumbnailSource: worker_frame`, `inputSizeBytes`, `outputSizeBytes`, `compressionRatio`. Meta launches read `public_url`, so the raw original can never reach Meta.
8. Marks the job `ready` (progress 100) with output/thumbnail fields and `completed_at`.
9. Deletes the raw original **after** the optimized upload succeeded. Success sets `raw_deleted_at`; a failed delete keeps `status = ready` and records `raw_delete_error` instead.
10. On any failure the job becomes `failed` with a truncated error message; the UI shows a controlled Russian message.

Status flow: `awaiting_upload → queued → downloading (10%) → transcoding (40%) → uploading (80%) → ready (100%)`, or `failed`.

## ffmpeg command

```
ffmpeg -y -i input.<ext> \
  -vf "scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30" \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  optimized.mp4

ffmpeg -y -ss 1 -i optimized.mp4 -frames:v 1 -q:v 3 thumbnail.jpg
```

Downscale-only fit inside 1080x1920, aspect ratio preserved (no crop), even dimensions enforced, 30 fps. CRF/preset/dimensions/fps are tunable via env.

## Env vars

| Var | Default | Notes |
|---|---|---|
| `SUPABASE_URL` | required | same project as the app |
| `SUPABASE_SERVICE_ROLE_KEY` | required | server-side only — never in the frontend |
| `VIDEO_WORKER_POLL_INTERVAL_MS` | `5000` | queue poll interval |
| `VIDEO_WORKER_ID` | `video-worker-<host>-<pid>` | shown in `claimed_by` |
| `VIDEO_WORKER_MAX_ATTEMPTS` | `3` | jobs at the limit stay failed/unclaimed |
| `VIDEO_WORKER_TMP_DIR` | OS tmp (`/tmp`) | scratch space for downloads/transcodes |
| `VIDEO_WORKER_CRF` | `23` | quality (lower = better/larger) |
| `VIDEO_WORKER_PRESET` | `medium` | libx264 preset |
| `VIDEO_WORKER_MAX_WIDTH` | `1080` | fit box width |
| `VIDEO_WORKER_MAX_HEIGHT` | `1920` | fit box height |
| `VIDEO_WORKER_FPS` | `30` | output fps |

## Run locally

Requires Node 20+ and `ffmpeg` on PATH.

```bash
cd artifacts/video-worker
pnpm install            # or npm install
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm run dev
```

`pnpm run build` compiles to `dist/`, `pnpm run start` runs the compiled worker.

## Deploy to Railway

1. Railway → New Service → Deploy from GitHub repo (`negis-medcall-mvp`).
2. Service settings → **Root Directory**: `artifacts/video-worker`. Railway picks up the `Dockerfile` there (it installs ffmpeg — do not switch to plain Nixpacks Node without adding ffmpeg).
3. Variables: set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (plus any `VIDEO_WORKER_*` overrides).
4. Start command: none needed — the image `CMD` is `npm start`.
5. Deploy. Logs show `[video-worker] started as ...`; the worker logs only job ids, statuses, and byte sizes — never URLs or credentials.
6. Scale: one instance is enough for MVP. Multiple instances are safe — claims are atomic — but keep one until volume demands more.

## Security

- The service role key exists only in Vercel and Railway env — never in `artifacts/negis` (enforced by a smoke test).
- Raw originals live in a private bucket, are never publicly served, and are deleted after successful optimization.
- The UI polls `GET /api/crm/video-jobs`, which exposes only safe fields (no raw paths, no claim data).
