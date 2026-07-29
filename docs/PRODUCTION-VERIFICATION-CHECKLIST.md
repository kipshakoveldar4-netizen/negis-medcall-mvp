# Production verification checklist

How to check that a deployment is safe without changing anything or reading
anything you should not.

The short version: **a production verification pass is read-only.** Every
assertion below can be made from a status code and an error code. If a check
seems to need a write, the check is wrong.

## Before you start

- Know the commit you are verifying and confirm the deployment serving it is
  `Ready`.
- Route every request through `assertVerificationRequestAllowed` in
  `scripts/src/production-verification-guard.ts`. It refuses production
  mutations, probe records and Meta endpoints. Do not work around it.
- Never print an `Authorization` header, a token, a service-role key, an HMAC
  secret, a database URI, or a Vercel environment value. Use
  `redactAuthorization` before logging headers.

## Hard rules

| Rule | Why |
|---|---|
| No `POST` / `PATCH` / `PUT` / `DELETE` against production | A denial is provable from the response; a write is not needed. See `docs/SECURITY-INCIDENTS.md`, 2026-07-29. |
| `PRODUCTION_MUTATION_ALLOWLIST` stays empty | An entry means a named human approved one named operation. Remove it when that operation is done. |
| No record named `__probe_*`, at any target | Probe records are how the 2026-07-29 incident happened. |
| No Meta endpoint, not even a dry run | A dry run still builds a payload against the live ad account. |
| No business row contents | Assert counts and codes. Never read, quote, log or persist a lead, client, appointment or launch row. |
| No repeated status tallies over business tables | Counting rows is still reading the table. Use what the deployment reports about itself. |

## Public surface — no credentials

Expect a refusal, and expect it to say nothing useful about what is behind it.

- `GET /api/crm/health`, `/api/crm/storage-health`, `/api/crm/auth-context`,
  `/api/crm/leads` → `401 authentication_required`
- `POST /api/crm/staff`, `/api/crm/meta-insights-sync` → `401`
- `POST /api/crm/meta-insights-background-cycle` → `401 worker_unauthorized`
  (a browser token must not satisfy it either)
- `POST /api/content-studio/generate-package`, `/api/content-studio/send-telegram`
  → `401` (and no OpenAI or Telegram call is made)
- `GET /api/targeting/health`, `POST /api/targeting/launch` → `401`
- `POST /api/auth/register` → `410 self_registration_disabled`
- `POST /api/leads/webhook/<anything>` → `410 legacy_webhook_disabled`
- `GET /api/crm/<unregistered>` and an encoded traversal → `404 resource_not_found`
- `DELETE /api/crm/leads` → `405 method_not_allowed`

## Authenticated surface — your own account only

Sign in as yourself. Use a random UUID for the foreign-workspace checks; never
another clinic's real identifier.

- `GET /api/crm/auth-context` → `200`, one membership, the role you expect, and
  the selector in `localStorage` matching it.
- Foreign selector on `leads`, `clients`, `appointments`, `meta-launches`,
  `staff` → `403 workspace_access_denied` for every one.
- Tamper with client state — set the workspace selector and the legacy demo
  blobs to a foreign id — and repeat: still `403`. The client is not authority.
- `POST /api/crm/staff` for your own workspace → `409 staff_invitation_required`
  (authorization first, then the closure).
- `GET /api/crm/health` → `200`, and the body carries presence flags only: no
  environment variable names, no Meta identifiers, no secret values.
- Content Studio with a foreign selector → `403`; `/api/content-studio/videos`
  → `410 route_disabled`.
- Walk every page. Confirm the only workspace in the query string is your own,
  no request carries `demo-workspace`, and the console is clean. Do not open a
  record.

## Meta

- Confirm from the deployment's own reporting that no campaign is `ACTIVE` and
  that real launches remain `paused` / `PAUSED`.
- Do not call Meta. Do not re-tally launch rows.

## Logs

- Read the deployment log window for the requests you generated.
- Confirm denials appear without tokens, signatures, canonical payloads, body
  hashes or row contents.

## Finishing

- Record: commit, deployment id, every check with its status and code, and
  explicitly `mutations = 0` and `Meta calls = 0`.
- If any check fails, the gate stays closed. Fix, redeploy, verify again.
