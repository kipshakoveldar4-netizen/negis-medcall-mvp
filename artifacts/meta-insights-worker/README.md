# Meta Insights background worker (`@workspace/meta-insights-worker`)

A short-lived Railway Cron worker for CRM11e.2. Each run performs **exactly one
cycle**: it signs an HMAC-SHA256 request and `POST`s it to the production CRM
catch-all endpoint `/api/crm/meta-insights-background-cycle`, prints a safe
summary, and exits. There is no polling loop and no long-lived state.

This worker is deliberately separate from `@workspace/video-worker`. Do not merge
them.

## Secret separation (important)

The worker holds **only** the shared worker HMAC secret. It must never contain or
read:

- `META_ACCESS_TOKEN`
- `META_APP_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`

Those secrets live only on the Vercel deployment, behind the authenticated
endpoint. The worker never talks to Meta or Supabase directly — it only calls the
Negis API with a signed request.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEGIS_API_BASE_URL` | yes | Absolute base URL of the production deployment, e.g. `https://app.example.com`. |
| `META_INSIGHTS_WORKER_SECRET` | yes | Shared HMAC secret. Must match the server's `META_INSIGHTS_WORKER_SECRET`. |
| `META_INSIGHTS_WORKSPACE_IDS` | no | Comma/space separated workspace UUIDs. Omit to let the server use its own allowlist. Intersected with the server allowlist. |
| `META_INSIGHTS_WORKER_ID` | no | Worker identity used for leasing. Defaults to `meta-insights-worker-<host>-<pid>`. |
| `META_INSIGHTS_MAX_LAUNCHES` | no | Max launches per cycle. Default `2`. Server clamps to `[1, 10]`. |
| `META_INSIGHTS_REQUEST_TIMEOUT_MS` | no | HTTP timeout in ms. Default `60000`. |

The signed request headers are `x-negis-worker-timestamp`,
`x-negis-worker-nonce`, `x-negis-worker-signature`, and
`x-negis-worker-request-id`. The canonical signed payload is
`METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(body)`, signed with
`HMAC-SHA256(worker secret, canonical payload)`. The secret and the signature are
never printed.

## Local build and run

```sh
# From the repository root
pnpm --filter @workspace/meta-insights-worker run build

# Run one cycle locally against a target deployment
NEGIS_API_BASE_URL="https://app.example.com" \
META_INSIGHTS_WORKER_SECRET="<shared-secret>" \
META_INSIGHTS_WORKSPACE_IDS="9eb6f100-bb6a-4f99-9719-e85c34513a03" \
META_INSIGHTS_WORKER_ID="crm11e-canary" \
META_INSIGHTS_MAX_LAUNCHES="2" \
pnpm --filter @workspace/meta-insights-worker run start
```

`dev` runs the same single cycle through `tsx` without a build step. The process
exits `0` on a successful cycle and non-zero otherwise, which is what a cron
scheduler needs to detect failures.

## Railway deployment

- **Root directory:** `artifacts/meta-insights-worker`.
- **Build:** the included `Dockerfile` (Node 20 slim, self-contained
  `npm install && npm run build`). No ffmpeg and no workspace dependencies.
- **Service type:** Cron. Schedule the container to run on a daily cadence during
  the canary (for example once per day). Each invocation runs one cycle and
  exits; enable "skip if previous run is still active" so cycles never overlap.
- Do not run it as an always-on service and do not add a polling loop.

## Canary rollout

The initial production canary runs against a single authorized workspace with
conservative limits:

- workspace `9eb6f100-bb6a-4f99-9719-e85c34513a03`
- `META_INSIGHTS_WORKER_ID=crm11e-canary`
- `META_INSIGHTS_MAX_LAUNCHES=2` (server concurrency is 1)

During the canary, keep the schedule disabled and invoke a single signed cycle
manually to observe the safe summary before enabling any recurring schedule.
