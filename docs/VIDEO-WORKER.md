# Video Optimization Worker

Background worker for the large-video pipeline (`artifacts/video-worker`, `@workspace/video-worker`).
**G5-C54 is a local candidate, not a deployed worker or a cloud migration.** It
requires 086 after 015/016/017/018, 082 and 085. Do not deploy this source against
an older schema. Production, Baspana and other working tenants were not tested
or changed. The acceptance below uses synthetic files and disposable PostgreSQL.

The integrated G5-C56 generated-video producer additionally requires **090**.
This remains a local candidate: no 090/cloud worker/Preview rollout was made.
The API reserves private input capacity before its paid quota/provider dispatch,
records a dispatch nonce and provider id, then binds the immutable input hash to
one private asset and native job. A lost response resumes that identity rather
than starting another render. Completed provider output is not a public receipt.
Only 086 native promotion, exact public video/thumbnail byte verification and
090 generated-identity finalization permit delivery to the browser. Old public
generated assets are not rewritten or grandfathered as native-validated.

It runs **outside Vercel** (Railway or any Docker host) and processes `video_processing_jobs`
created by the CRM API. The UI's signed raw-upload handshake still uses `POST /api/crm/video-jobs`;
the public foundation contract is `POST /api/crm/video-processing-jobs` plus
`GET /api/crm/video-processing-jobs/:id` and `POST /api/crm/video-processing-jobs/:id/retry`
(migrations 016, 017, and 018).

## What it does

1. Polls `video_processing_jobs` for `status = queued` with `attempts < VIDEO_WORKER_MAX_ATTEMPTS`.
2. Claims one job atomically: `UPDATE ... SET status='downloading', claimed_by, claimed_at, attempts+1 WHERE id = ? AND status = 'queued'`. If zero rows return, another worker won the job.
3. Rechecks the exact workspace, asset/raw identity, size, MIME and asset version.
   Immutable generated originals (085 or known legacy metadata) are refused:
   their optimization needs a separate variant workflow, not an in-place rewrite.
4. Streams the raw original from the configured **private** bucket, using only
   the configured HTTPS Supabase origin, no redirects, a 60-second deadline and
   exact byte count. It does not allocate the whole download in memory.
   Generated-native inputs additionally require the immutable SHA-256 bound by
   090; a same-length replacement fails before decode or any public upload.
5. Probes container/codec/geometry/duration/frame bounds, transcodes to H.264/AAC
   MP4, probes and fully decodes the result, then takes its first frame as JPEG.
   Global/stream metadata and chapters are removed from the published video.
6. Uploads both validated files create-only to the configured public bucket:
   - `optimized/{workspaceId}/{jobId}-{claimTag}.mp4`
   - `optimized/{workspaceId}/{jobId}-{claimTag}-thumbnail.jpg`
   The tag is derived from worker, claim timestamp and attempt. An old claim
   cannot overwrite a newer claim's objects. Upload receipts and public URLs
   must exactly match the server-derived identity.
7. Calls the service-only 086 `finalize_video_job` RPC. It locks and checks the
   exact claim and matching asset version, then commits asset + ready job in
   **one database transaction**, preserving unrelated metadata and the 018 API
   fields. The job stores an exact promotion receipt, including sizes/hashes.
8. A lost RPC response gets one identical reconciliation call. An already
   committed matching receipt returns without rewriting rows or uploading again.
   A changed claim/version/receipt refuses; an unconfirmed result is not success.
9. Deletes ordinary raw **only after a matching promotion acknowledgement**. A cleanup
   failure keeps the confirmed result ready and records a generic cleanup error.
   With two lost acknowledgements a committed ready result retains raw; manual
   reconciliation/retention cleanup remains necessary.
   Generated-native raw is **never deleted** here: a parallel create-only
   producer may still be finishing its upload. Instead, the worker replaces the
   same private key with a fixed 56-byte MP4-container fence, proves its bytes
   through a bounded private GET, then calls the claim-scoped 090 reclamation
   ACK. Late create-only writes cannot overwrite an occupied key. Only that
   exact receipt releases the original 100 MiB admission reserve; the 56 bytes
   remain charged. A legacy `raw_deleted_at` alone cannot release it. For this
   flow that timestamp means original live bytes replaced, not physical backend
   or version deletion. Never remove these fences with generic raw cleanup.
   Explicit enabled/suspended bucket versioning refuses reclamation. An absent
   versioning field still requires real backend acceptance before deployment.
10. Controlled failures use fixed public error codes. Failure updates are scoped
    to the exact claim and original asset version. Job/asset failure marking is
    still two conditional writes, not the atomic success-promotion transaction.

Status flow: `awaiting_upload → queued → downloading (10%) → transcoding (40%) → uploading (80%) → ready (100%)`, or `failed`. Retry (`POST /api/crm/video-processing-jobs/:id/retry`) resets a failed job to `queued`.

Concurrency: the current loop processes one job at a time. The guarded
`queued → downloading` update chooses a claimant. Subsequent updates and final
promotion additionally require its timestamp/attempt/worker identity. This does
not promise exactly-once rendering across a manual requeue or a crashed worker.

## Native Media Limits

The executable arguments live in `src/ffmpeg.ts`; do not copy an older width-only
command. Both width (1080) and height (1920) are capped, preserving aspect ratio,
with even dimensions, no crop/upscale, and configurable output fps (default 30).
Only the first video and optional first audio stream are mapped. First-frame
thumbnails also support clips shorter than one second.

Admission limits: input 500 MiB, duration 600 seconds, side 8192 pixels,
16,777,216 pixels/frame, 120 fps and 72,000 declared/estimated frames. Output
is checked at 100 MiB and JPEG at 10 MiB before reading/uploading them. These
post-process checks do not constitute a scratch-disk quota during encoding.

Native children have no shell, no inherited service credentials/FFREPORT, a
256 KiB stdout/stderr cap, 15-second probe / 120-second processing deadlines,
single-thread decode/encode, restricted container/protocol options and a
128 MiB single-allocation limit. A corrupt payload with readable MP4 metadata
is still rejected by full decoding. These are **not** a total memory budget or
an OS security sandbox. Container filesystem/network/CPU/RAM/disk limits and the
actual Linux FFmpeg version remain a deployment gate, not a Windows test result.

## Env vars

| Var | Default | Notes |
|---|---|---|
| `SUPABASE_URL` | required | exact HTTPS project origin; trailing slash removed |
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
| `FFPROBE_PATH` | `ffprobe` | required native probe binary |
| `VIDEO_WORKER_CRF` | `23` | quality (lower = better/larger) |
| `VIDEO_WORKER_PRESET` | `medium` | libx264 preset |
| `VIDEO_WORKER_MAX_WIDTH` | `1080` | width cap |
| `VIDEO_WORKER_MAX_HEIGHT` | `1920` | active height cap |
| `VIDEO_WORKER_FPS` | `30` | output fps |

## Run locally

Requires Node 20+, `ffmpeg` and `ffprobe` on PATH. The worker command processes
the configured queue: do not start it with working credentials for local QA.
Run the isolated tests instead (no real SDK client, real credentials or sends):

```bash
pnpm test:video-worker-media
pnpm test:video-worker-contract
pnpm test:video-job-promotion-postgres
pnpm test:generated-video-workflow
pnpm test:generated-video-client
pnpm test:generated-video-workflow-postgres
```

The PostgreSQL fixture requires the existing local Docker image; on this
Windows workstation the verified, separately provisioned native fixture can be
selected with `MEDINA_TEST_POSTGRES_NATIVE=1`. It accepts no external DB URL and
removes only its own cluster. Actual table migrations are tested, not Storage
policies or the complete application migration chain.

Within `artifacts/video-worker`, `pnpm run build` compiles to `dist/`;
`pnpm run start` starts the queue processor only after a separately approved
deployment gate.

## Deploy to Railway

**Deferred instructions, not authorization or a record of deployment.** First
accept 086 and the private/public bucket contract in an isolated test environment,
then accept the Linux runtime/resource sandbox. Obtain a separate release scope
before changing a shared database, cloud worker or working credentials.

1. Railway → New Service → Deploy from GitHub repo (`negis-medcall-mvp`).
2. Service settings → **Root Directory**: `artifacts/video-worker`. Railway picks up the `Dockerfile` there (it installs ffmpeg — do not switch to plain Nixpacks Node without adding ffmpeg).
   The package is fully standalone: its `tsconfig.json` inlines all compiler options and it must never reference the repo root (`tsconfig.base.json`, `workspace:`/`catalog:` deps) — the Docker build context contains only `package.json`, `tsconfig.json`, and `src/`.
3. Variables: set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (plus any `VIDEO_WORKER_*` overrides).
4. Start command: none needed — the image `CMD` runs `node dist/index.js` directly.
5. Deploy. Logs show `[video-worker] started as ...`; the worker logs only job ids, statuses, and byte sizes — never URLs or credentials.
6. Keep one instance until failover/requeue and orphan retention are accepted.

## Troubleshooting

- `Node.js 20 detected without native WebSocket support` (fatal at startup):
  supabase-js requires a WebSocket transport on Node < 22. The worker ships the fix already —
  the `ws` dependency plus `realtime: { transport: WebSocket }` in `createSupabase`
  (`src/worker.ts`). If it reappears, check that `ws` is still in `package.json` and the
  transport option was not removed. Do not use a browser WebSocket polyfill.
- `ffmpeg is not available`: the container image must include ffmpeg (the provided Dockerfile installs it via apt).
- Jobs stay `queued`: worker not running or `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` missing; check Railway logs for `[video-worker] started`.

## Security

### Local process-hardening candidate, 25 October 2026

The runtime Docker stage now contains only compiled code and production
dependencies, runs as `node`, and makes `/app` non-writable. This source change
has not been built or accepted on a Linux/container host. It retains the
existing base tag and package installation contract; it is not an image-version
or dependency-vulnerability acceptance.

Each decoder/probe invocation has a fresh private cwd/HOME/cache/temp tree,
an allowlisted environment, no shell, separate 256 KiB stdout/stderr limits and
a bounded deadline. Local input/output paths are resolved before changing cwd.
On POSIX the invocation owns a detached process group; group termination also
covers descendants after the direct child exits. Windows terminates only the
direct child: no process-tree containment is claimed there.

Cleanup checks canonical path, non-link directory identity and
`dev/ino/birthtimeNs` before launch and before every removal attempt. Actual
Windows junction/rename/replacement tests preserved an external synthetic
canary. The targeted local set passed **78/78** using local processes/media,
without a queue processor, cloud credentials, Docker build or external provider.

This is not atomic openat-style filesystem protection against same-UID native
code execution. HOME separation does not prevent absolute-path, network,
RAM/disk or secret access. Read-only filesystem, resource/PID quotas, network
restrictions, seccomp/capabilities and the actual Linux decoder/runtime remain
separate deployment gates. Do not enable a working worker on this evidence alone.

- The service role key belongs only in approved server environments, never in
  `artifacts/negis` or browser requests (enforced by a smoke test).
- Worker raw originals must live in a private bucket and are retained until
  database promotion is acknowledged. Validated orphan output may remain after
  an unconfirmed upload/promotion; a retention/reconciliation process is pending.
- The UI polls safe job endpoints, which expose only safe fields (no raw paths, no claim data).
- 086 enables queue RLS and revokes browser/PUBLIC table, column and RPC access;
  service-role access remains. A synthetic broad-grants scaffold tests this
  boundary; it is not evidence of the ACL state of a working cloud database.
- This worker does not validate the separate direct/signed-upload or generated
  provider-video paths. Private staging/finalization and generated variants,
  provider-independent replay and cloud acceptance remain open.

Read-only environment observation, 28 October: the installed Docker CLI's
currently configured default endpoint returned no `docker_engine` pipe.
No context was changed and no daemon, container, WSL service or cloud fallback
was started. This does not prove that every Docker context is unavailable.
Actual Linux worker/cgroup/seccomp/container acceptance remains open; the
local Telegram recipient tests do not satisfy that separate gate.
