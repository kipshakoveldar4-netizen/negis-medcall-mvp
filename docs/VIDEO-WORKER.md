# Video Optimization Worker

Background worker for the large-video pipeline (`artifacts/video-worker`, `@workspace/video-worker`).
It runs **outside Vercel** (Railway or any Docker host) and processes `video_processing_jobs`
created by the CRM API. The UI's signed raw-upload handshake still uses `POST /api/crm/video-jobs`;
the public foundation contract is `POST /api/crm/video-processing-jobs` plus
`GET /api/crm/video-processing-jobs/:id` and `POST /api/crm/video-processing-jobs/:id/retry`
(migrations 016, 017, and 018).

## What it does

1. Polls `video_processing_jobs` for `status = queued` with `attempts < VIDEO_WORKER_MAX_ATTEMPTS`.
2. Claims one job atomically: `UPDATE ... SET status='downloading', claimed_by, claimed_at, attempts+1 WHERE id = ? AND status = 'queued'`. If zero rows return, another worker won the job.
3. Downloads the raw original from the **private** `ad-creatives-raw` bucket.
4. Transcodes with ffmpeg to an ads-friendly MP4 (see command below).
5. Generates a JPG thumbnail from the **optimized** video at ~1 second.
6. Uploads both to the public `ad-creatives` bucket:
   - `optimized/{workspaceId|demo}/{jobId}.mp4`
   - `optimized/{workspaceId|demo}/{jobId}-thumbnail.jpg`
7. Updates the `ad_creative_assets` row: `public_url`/`storage_bucket`/`storage_path` now point at the optimized MP4, `status = ready`, metadata gets `optimized`, `optimizationStatus`, `thumbnailUrl`, `thumbnailSource: worker`, `inputSizeBytes`, `outputSizeBytes`, `compressionRatio`. Meta launches read `public_url`, so the raw original can never reach Meta.
8. Marks the job `ready` (progress 100) with the migration-018 contract fields: `optimized_bucket`, `optimized_path`, `optimized_public_url`, `thumbnail_url`, `thumbnail_source = worker`, `output_mime_type = video/mp4`, `input_size_bytes`, `output_size_bytes`, `compression_ratio`, `completed_at`.
9. Deletes the raw original **after** the optimized upload succeeded. Success sets `raw_deleted_at`; a failed delete keeps `status = ready` and records `raw_delete_error` (a raw-deletion failure never fails a ready optimized video). The job stays `status = ready` rather than flipping to `deleted_original`, so the app's ready check still matches.
10. On any controlled failure (raw object missing, ffmpeg failed, upload failed, thumbnail failed) the job becomes `status = failed` with a truncated `error_message`; the UI shows a controlled Russian message and offers retry.

Status flow: `awaiting_upload → queued → downloading (10%) → transcoding (40%) → uploading (80%) → ready (100%)`, or `failed`. Retry (`POST /api/crm/video-processing-jobs/:id/retry`) resets a failed job to `queued`.

Concurrency: one job at a time by default (`VIDEO_WORKER_MAX_CONCURRENT_JOBS = 1`). The `queued → downloading` UPDATE guarded by `status = 'queued'` is the lock — two workers can never process the same job.

## ffmpeg command

```
ffmpeg -y -i input.<ext> \
  -vf "scale='min(1080,iw)':-2,fps=30" \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  -map_metadata -1 \
  optimized.mp4

ffmpeg -y -ss 1 -i optimized.mp4 -frames:v 1 -q:v 3 thumbnail.jpg
```

Cap width to `MAX_WIDTH` (1080) and auto-compute height with `-2` — this preserves aspect
ratio and orientation, keeps an even height for libx264, and never crops faces. `-map_metadata -1`
strips source metadata; output is MP4 H.264 + AAC with `+faststart`. CRF/preset/width/fps are
tunable via env. The thumbnail is taken from the **optimized** MP4 (~1s frame), never the raw original.

## Env vars

| Var | Default | Notes |
|---|---|---|
| `SUPABASE_URL` | required | same project as the app |
| `SUPABASE_SERVICE_ROLE_KEY` | required | server-side only — never in the frontend |
| `VIDEO_OPTIMIZATION_RAW_BUCKET` | `ad-creatives-raw` | private raw-original (input) bucket |
| `VIDEO_OPTIMIZATION_OUTPUT_BUCKET` | `ad-creatives` | public optimized (output) bucket |
| `VIDEO_OPTIMIZATION_WORKER_SECRET` | optional | reserved for protected worker callbacks; never expose to frontend |
| `VIDEO_WORKER_POLL_INTERVAL_MS` | `5000` | queue poll interval |
| `VIDEO_WORKER_ID` | `video-worker-<host>-<pid>` | shown in `claimed_by` |
| `VIDEO_WORKER_MAX_ATTEMPTS` | `3` | jobs at the limit stay failed/unclaimed |
| `VIDEO_WORKER_MAX_CONCURRENT_JOBS` | `1` | jobs processed at once (kept at 1 for MVP) |
| `VIDEO_WORKER_TMP_DIR` | OS tmp (`/tmp`) | scratch space for downloads/transcodes |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary path |
| `FFPROBE_PATH` | `ffprobe` | ffprobe binary path (reserved) |
| `VIDEO_WORKER_CRF` | `23` | quality (lower = better/larger) |
| `VIDEO_WORKER_PRESET` | `medium` | libx264 preset |
| `VIDEO_WORKER_MAX_WIDTH` | `1080` | width cap |
| `VIDEO_WORKER_MAX_HEIGHT` | `1920` | reserved (not used by the width-cap filter) |
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
   The package is fully standalone: its `tsconfig.json` inlines all compiler options and it must never reference the repo root (`tsconfig.base.json`, `workspace:`/`catalog:` deps) — the Docker build context contains only `package.json`, `tsconfig.json`, and `src/`.
3. Variables: set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (plus any `VIDEO_WORKER_*` overrides).
4. Start command: none needed — the image `CMD` is `npm start`.
5. Deploy. Logs show `[video-worker] started as ...`; the worker logs only job ids, statuses, and byte sizes — never URLs or credentials.
6. Scale: one instance is enough for MVP. Multiple instances are safe — claims are atomic — but keep one until volume demands more.

## Troubleshooting

- `Node.js 20 detected without native WebSocket support` (fatal at startup):
  supabase-js requires a WebSocket transport on Node < 22. The worker ships the fix already —
  the `ws` dependency plus `realtime: { transport: WebSocket }` in `createSupabase`
  (`src/worker.ts`). If it reappears, check that `ws` is still in `package.json` and the
  transport option was not removed. Do not use a browser WebSocket polyfill.
- `ffmpeg is not available`: the container image must include ffmpeg (the provided Dockerfile installs it via apt).
- Jobs stay `queued`: worker not running or `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` missing; check Railway logs for `[video-worker] started`.

## Security

- The service role key exists only in Vercel and Railway env — never in `artifacts/negis` (enforced by a smoke test).
- Raw originals live in a private bucket, are never publicly served, and are deleted after successful optimization.
- The UI polls safe job endpoints, which expose only safe fields (no raw paths, no claim data).
