# Video Quota: Recover A Lost Pre-Dispatch Acknowledgement

G5-C60 / G7-C37, 26 October 2026, base 059ad35. Local only. No release,
cloud database/configuration, real account/data, provider call, Baspana, salon,
WhatsApp, advertisement, paid generation or expense. This is not G1-G8 completion.

## Reproduced Failure

The actual video controller cancelled its native reservation when quota returned
an error, although the quota RPC could already have committed. A same-key retry
then found a cancelled operation and could never dispatch its first render.
The new regression failed before the fix: expected reserved, received cancelled.
Original 081 also returns duplicate receipts without proving their actor,
operation/kind, units, model or provider; blindly treating every duplicate as
permission to render would introduce an accounting/identity bypass.

## Coordinated Local Candidate

The controller keeps the original native reservation on an uncertain quota ACK.
An unchanged retry can consider an existing tracked receipt only when the freshly
read video entitlement is a bounded positive limit sufficient for its duration.
It then must pass the new atomic SQL bridge; duplicate alone is never permission.
Access denial still hides contacts/results. Ambiguous dispatch replies retain
the browser key rather than encouraging a replacement paid request.

Forward 106 requires the 051/081 quota contract and native 090 schema/actor gate:

- The service-only bridge locks the original workflow and quota receipt, requires
  its original staff/Auth author and request digest, and checks workspace/key,
  generated_video/video_seconds, units, OpenAI provider and exact model.
- Only an original reserved receipt with no completion/error permits the first
  dispatch. Its timestamp must not predate native admission and its UTC period
  must match its creation timestamp. No legacy/pre-native receipt is adopted.
  A valid original receipt may cross a month boundary within its still-valid
  native lease; its original period/units are preserved, not recharged or moved.
- Native expiry is checked after row-lock waits. An expired/cancelled operation,
  changed author/configuration, missing/foreign/mismatched or unknown/failed/
  succeeded quota is not reactivated. Time alone never permits another render.
- The first accepted nonce binds an immutable unique quota_usage_id FK. Replay
  of the same admitted nonce is idempotent; a competing nonce is not accepted.
  The bridge does not insert/change a quota row, refund it or call a provider.
- The old unbound service RPC loses EXECUTE. Effective inherited access is
  checked, not assumed from REVOKE text; superuser service roles are refused.
  Existing linked jobs still use their read/free-poll path. Deploying 106 and
  the new consumer is a coordinated change: old producers must fail closed.
- RLS/effective browser grants are checked after DDL locks; the new column/FK,
  unique index and final function privileges are verified. Bad same-name index,
  cascading FK, missing foundation or authority drift aborts the transaction.
  No existing operation/receipt is backfilled, cancelled, rebound or rewritten.

The server requires 106, validates the bound receipt ID/digest and accepted nonce,
and never falls back to the old RPC when the new one is missing. No new API file,
account, staff role, subscription, rate, public URL or provider setting is added.
Image/text generation is unchanged. Existing quota and provider checks remain.

## Acceptance Scope And Harness Corrections

Actual API/parser/workflow tests use explicit fake Auth, quota, SDK and network.
They prove lost ACK and concurrently pending ACK recovery with one receipt and
one provider dispatch, stable replay, missing-106 refusal, and negative duration,
model/provider/operation/kind/staff/status/age/entitlement/expiry/access scenarios.
The main and terminal-failure fixtures now share one stable synthetic quota
receipt instead of creating a new receipt ID for each duplicate response.
These doubles are not the SQL authority.

Real PostgreSQL acceptance executes the raw 009-106 chain on the existing owned
17.11 runtime, with only the established minimal Storage catalogues scaffolded.
No Auth service, Storage server, DSN/container/download or external network exists.
It exercises actual service/browser roles, row-lock waits, quota immutability,
competing nonces, revocation/rebinding, expiry and reapplication with committed
synthetic data. A pre-106 control demonstrates original unbound service dispatch.
Every negative receipt scenario first passes an actual dispatch control, rolled
back to its savepoint, before altering only its target evidence.

Early native runs are not final passes: one helper hid the original failure with
RESET ROLE after an aborted transaction; another looked up a deliberately changed
key. The next proof exposed test-clock mismatch: quota now() used an outer test
transaction's start, while native admission uses clock_timestamp(). Fixtures now
match the application's separate committed RPC calls, preserving the strict
pre-native-receipt rejection instead of weakening SQL to accommodate the harness.

Two older selected-handler extractors also lacked the newer caller lifetime and
streamed JSON fixture/TextDecoder. They now pass the actual lifetime and a real
synthetic Response, close timers, and keep network denial. Privacy expectations
now match 092's terminal acknowledgement/progress and the retained uncertain
quota reservation; raw-error/asset/billing/no-repeat assertions remain.
The review test's stale 009-104/96 count is explicitly pinned to 009-106/98;
all source-byte, membership, order and outward-effect rejection checks remain.

One cumulative run hit the existing statement_timeout inside unchanged 103 report
code while the large VM suite was also running. That run stopped and is not
credited; the final cumulative run is separate, with unchanged query/time limits.
Its cause is not proven by a successful later run; no timeout/query was relaxed.

Final frozen-source acceptance:

- Raw 009-106: 98 exact SQL files on owned PostgreSQL 17.11, 237/237 including
  the parent. Actual lock waits, revocation, expiry and nonempty reapplication
  pass; final business tables are empty and the owned cluster is removed.
- Expanded actual-handler/provider/quota/media/privacy/browser and chain-review
  set: 1524/1524. The new quota recovery file is 16/16; the media/privacy set is
  108/108. These overlapping sets are not added to the expanded total.
- Full root build completed: both API compiler modes, library/app/scripts types,
  169 compiled cold-start/auth/denial checks and Vite. The existing tooltip
  sourcemap and mixed serverAuth import warnings remain nonfatal.
- Fixed no-network regression: 931/931, unchanged test list, 41 readers,
  environment keys and network/IPC guards. Only the reviewed content-studio API
  normalized hash changed to
  bf4eb91dd1dfdf4855cf9fcdec28f4bcdb9db7573d5984b5f66346a77d91243c.
  The C59 generation reader hash remains unchanged.

Raw 106 SHA-256 is
15267fb3ffd06ad4e67120661c3938eb580eaa8c39e50ae5cf08c5780e2b246f,
pinned by the chain reviewer. Earlier failed/intermediate logs are not this
receipt. Native/VM/isolation processes have terminal outcomes; the completed
build has no remaining process. Protected 059/065 match their original raw
hashes and are excluded. Existing user demo servers and browser sessions remain.

## Remaining Gates

Only an unexpired, original pre-dispatch reservation is automatically recoverable.
Previously cancelled native rows, unknown provider dispatches with no provider ID,
ambiguous/expired/mismatched quota and legacy pre-native receipts still require
explicit reconciliation. No lookup capability or paid idempotency guarantee is
invented. This is quota-unit accounting, not merchant payment/refund integration.

106 is not applied to site-test or any other cloud database. Prove the exact
target baseline, ACLs and current test-only build/runtime binding before selecting
and separately approving a coordinated Preview candidate. Do not apply the raw
chain to an existing target. Real private Storage/native worker/provider, actual
Auth/session acceptance, hosting/legal/commercial and the other G1-G8 gates remain.
