# Video Provider Metadata: Deadline And Unknown Outcome

G5-C58, 26 October 2026, base e9baacc. Local only. No release, migration,
cloud/provider access, real account, Baspana/salon, WhatsApp, send or expense.

## Defect And Narrow Fix

Both createVideoJob and fetchVideoJob previously awaited provider headers and
response.text without a deadline. Two fake-clock baseline cases failed: neither
POST nor GET settled after 15 seconds when fetch ignored cancellation.

The shared video-metadata reader now gives headers and the complete JSON stream
one 15-second deadline, not a fresh timeout per fragment. Abort plus Promise.race
bounds an uncooperative fetch/read; late headers are cancelled and cannot publish
a result. Cleanup is best effort and is never awaited. A shorter internal test
override is allowed; invalid or larger overrides fail before dispatch. No API
payload or new environment setting exposes this override.

Successful metadata is streamed, capped at 64 KiB and 2048 retained fragments,
copied before another read can mutate its bytes, decoded as strict UTF-8 and
required to be a JSON object. Missing/empty/truncated/oversized/malformed streams
fail closed without text/arrayBuffer fallback. For compressed HTTP responses the
cap applies to decoded bytes; encoded Content-Length is not mistaken for their
length. Redirects, redirected receipts and a changed response URL are refused;
the credential-bearing request uses redirect:error, credentials:omit, no-store.

Only received, nonredirected HTTP error status is preserved. Error bodies are
not read and provider diagnostics are not returned. A transport exception, even
one shaped like a typed 429 error, remains 502/unknown. This prevents a fake
rejection from incorrectly cancelling a paid dispatch or refunding its quota.
Image generation, provider request payload/model/duration and all SQL are unchanged.

## Composed Recovery Evidence

The actual API controller, provider parser and workflow run with explicit Auth,
quota, Storage/SDK and network doubles. These are not live service or new SQL proofs.

- POST header/body timeout returns accepted dispatch_unconfirmed. The operation
  retains dispatching, its original nonce, null provider ID and unknown accounting;
  there is no cancellation, linking, upload, asset or native job. Same-key replay
  creates no second provider request or reservation. Late accepted bytes cannot
  alter the settled quarantine.
- GET timeout retains the original signed handle and paid job, never records
  terminal provider failure and never frees quota. A later successful free GET
  queues the same input and POST replay returns the same handle without a render.
- Revocation/account replacement during the wait gives 403 with no handle or
  file; conservative unknown accounting and the dispatch reservation remain.
- A received HTTP 429 still follows the existing confirmed-refusal path.
- The actual ContentStudio generation callback separately proves that an
  accepted unknown result with no provider handle retains its browser receipt;
  an unchanged retry transmits exactly the same paid request key.

The first composed test run had two harness expectations wrong: the generic paid
helper alone omits ContentStudio's accepted:true guard, and the controller keeps
the typed 502 status rather than replacing it with 503. Tests were corrected to
execute the actual browser callback and preserve the actual status contract;
no product guard was relaxed. Broader regression also found nine failing test
entries (including parent) from three stale legacy toast expectations after C57.
Only those expectations were aligned with the already
accepted inline completion; file, handle, auth, retry, GET and timer checks remain.

## Acceptance And Isolation

- Metadata transport: 70/70 synthetic cases, including the two failed baseline
  scenarios, stalled headers/body, one absolute deadline, ignored abort, hung
  cleanup, late resolve/reject, redirect, byte/fragment bounds and compressed JSON.
- Controller/workflow recovery: 8/8. Actual ContentStudio/receipt/loopback-HTTP
  file: 163/163 including its one new no-handle retry case.
- Combined expanded media/content/replay/terminal-failure/download set: 1325/1325.
  Counts overlap the smaller sets and historical evidence; do not add them.
- Full root build passed: library/app/scripts types, both API compiler modes,
  169 compiled cold-start/auth/denial checks and Vite. The existing tooltip
  sourcemap warning remains nonfatal. Fixed no-network runner: 931/931.
  All test/build processes ended. No current Preview acceptance follows.

The generation source's normalized SHA-256 is
3adcc6f50faf9fe4796468d31837cbfb847fda073a7b984c216b9338520ab5fb.
Only that reviewed entry in the 41-reader manifest changes. The environment
reader/key set is unchanged; test lists, network denial and IPC guards are not
weakened. No .env, CLI/auth secrets or customer files were inspected.
Protected raw 059/065 hashes are unchanged from the previous receipts; neither
file is staged. The existing owned loopback HTTP test closes its temporary
server; no database or browser instance was created by this cycle. User demo
servers and browser sessions were not used or changed.

## Not Closed By This Cycle

Later local G5-C59 [request-budget acceptance](VIDEO-REQUEST-BUDGET-2026-10-26.md)
supersedes the selected two-route application-wait gap below. Unknown provider-ID
reconciliation, real service/host acceptance and all unrelated gates remain.

This is a provider-metadata stage bound, NOT an end-to-end API request budget.
Authorization, RPC/accounting, SDK bucket/upload and finalization waits still
need their own bounded/coordinated recovery acceptance. The existing 15-second
MP4 download bound is separate and is not restarted by this metadata helper.

A POST with no received provider ID remains quarantined: this cycle deliberately
does not invent a provider lookup/idempotency capability, late background linking
or an automatic paid redispatch. Reconciliation/manual review of such operations
and the real isolated provider/Storage/native-worker matrix remain open. A changed
prompt is still a deliberate new intent under the existing UI contract; same-key
no-duplicate proof is not global cross-intent spend prohibition.

All G1-G8 release, commercial/legal, real Auth, cross-device, private Storage,
native/Linux and Telegram gates remain unless specifically superseded by another
receipt. Recruitment intake still supports both approved blogger roles locally;
it is not a referral earnings ledger or creator job/payment activation.
