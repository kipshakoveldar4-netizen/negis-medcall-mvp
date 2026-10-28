# Local Readiness: Connected Actions And Explicit Advertising Approval

28 October 2026. Candidate after `d6c7962`, local only. No cloud migration,
Preview/Production release, real Auth/user creation, provider call, real message,
payment or spend. Baspana, working salons, WhatsApp and their data/settings were
not accessed or changed. The existing G1-G8 objective is not replaced by this slice.

## Operator: Browser To Native Business SQL

The previously missing connected proof is now implemented by
`scripts/fixtures/operator-explorer-native-ui.test.mjs` and its fixture helper.
The actual `OperatorLeadExplorer`, `OperatorBookingForm`, parsers and transports
run in an owned disposable Edge profile. Requests travel over real loopback HTTP
through the compiled CRM catch-all, authorization and actual business handlers.
A narrowly allowlisted SDK adapter performs actual service-role SQL/RPC calls
on disposable native PostgreSQL using the exact reviewed raw chain 009-124.

Only identity/session responses, the parent frame and the SDK wire are synthetic.
The host is the actual standalone Explorer plus actual booking form, not the full
Portal and not a standalone booking-form substitute. Business HTTP is not
intercepted in the browser, RPC results are not canned, and SQL guards are not
disabled. This proves selected connected local actions, not real Supabase login,
hosted runtime, isolated Preview acceptance or a release decision.

Final **15/15**, exit 0, no skipped/cancelled tests:
`node_modules/.cache/operator-explorer-native-ui-agent-verified.log`.
Fourteen scenarios plus their parent cover:

- 375x900 and 1440x1000 at scale 1. Thirty authorized leads form actual 20+10
  pages. Two companies have the same contact name/phone but independent IDs.
  Each viewport changes stages and creates bookings from both original companies.
- Original request/lead/actor, stage target and both CAS expectations are asserted
  in actual HTTP and native arguments. Independent database-only stage-ID and
  legacy-status changes each produce 409 without overwriting the new state.
- A custom lost stage updates only its lead and its semantic group/counts;
  it is not a sale or a contact-success event. Booking does not pretend to change
  the lead's stage. Counters are reread through the actual native search function.
- The selected native services total exactly `150050` minor units and 75 minutes.
  Original UTC and Asia/Almaty local starts produce independently expected UTC
  instants, with one appointment/client/booking receipt/creation audit per booking.
- Closing a filled unsent form and closing/reopening its lead issues no booking
  POST, creates no business row and leaves no recovery key.
- A real native commit followed by truncated HTTP JSON leaves an uncertain
  original key. A real document reload and reopening the original row restores
  locked recovery. Explicit retry sends exactly the original ordered payload/key;
  one appointment/client/receipt/audit remains, not two.
- Current scheduled, cancelled, no-show and incomplete appointments are recovered
  truthfully. The Explorer notice preserves actual outcome/current fields rather
  than falsely reporting a new active booking. Rescheduling is not a separate
  connected case in this matrix and is not inferred from these four outcomes.
- Held committed stage replies across company filtering, paging and actor A-B-A
  do not retarget or publish success into a replacement view. The original send
  remains locked while unresolved and clears its pending indicator after settling.
- Profile suspension after synthetic Auth verification but before native stage
  execution refuses the write. Assignment withdrawal at the corresponding booking
  boundary also refuses; current contacts/forms disappear. A denied booking keeps
  its original uncertain key, which grants no data access or new authority.

Each scenario independently compares full snapshots of subscription payments,
partner commissions/payouts, deals and operator arrivals. They remain unchanged.
Every owned public business-table count returns to the clean baseline, including
failure cleanup; owned HTTP/browser/SQL resources close normally. The PostgreSQL
data directory and browser profile are owned disposable resources, not customer
data or a remote DSN. No operator production fix was needed for these cases.

The actual component lifetime suite gained 17 durable counterexample checks:
stage sends waiting for token lookup after filter/page/company/refresh/close/ABA,
dispatched stage outcomes after unmount, and booking-panel-only close/reopen or
ABA callbacks. Focused **123/123** passed with the actual component/hooks/
transports under a synthetic reconciled host, not browser/native proof.
`operator-lead-search-isolation-regression-2026-10-28T16-22-18-021Z.tap.log`.

## Creator Acceptance Recovery

The existing native creator matrix now also drops the committed acceptance ACK,
reloads the actual document, reads the retained command and resumes submission
without accepting twice. Assertions retain exactly one command/event, the exact
accepted timestamp/terms revision, cleared recovery metadata and available result
submission. Existing create/submit, revision/approval, revocation and A-B-A cases
remain. Final **14/14**, exit 0, no skips:
`creator-accept-recovery-native-recheck.log`.

The current creator CSS import exposed an outdated browser-fixture build: it had
no output path and could not bundle CSS. The fixture now serves real extracted
component CSS, existing built global styles, local Inter/fonts and owned thumbnails
under a self-only CSP. Empty-string raw HTTP mode remains supported. No production
creator behavior, schema or Auth implementation was changed to make tests pass.

## Advertising: Strict Persisted ACTIVE Approval

One production-source line changes in `readMetaLiveLaunchEnabled`:
`readBoolean(value.enabled)` becomes `value.enabled === true`.
Only an explicit saved JSON boolean is permission. Missing, false, malformed and
unreadable settings remain disabled. The generic boolean helper, owner/admin
authorization, exact ACTIVE confirmation, budget caps, Meta payload and existing
PAUSED/dry-run behavior are unchanged. No saved setting was rewritten.

This was a source-confirmed type-coercion weakness, not a demonstrated live launch
or unauthorized-role bypass. The new real-loopback Auth/router/launch regression
proved it before the fix: **26/43 passed, 17 failed**, no skips, because malformed
saved values reached later validation instead of the exact ACTIVE-disabled refusal.
`meta-active-setting-http-before.log` is retained unchanged.

Final focused HTTP suite: **47/47**, `meta-active-setting-http-paused-journal.log`.
The standard gate now includes that runtime suite plus the five existing source
checks: **52/52**, `meta-active-gate-final.log`. The original ACTIVE denial,
forged-body-role and budget cases assert zero SDK writes/RPCs and zero provider
attempts, including caught attempts. Boolean-true controls reach only a later
safe city-key validation boundary; they do not create campaigns.

Four additional PAUSED dry-run controls return actual HTTP 200 with campaign,
adset and ad all PAUSED. Only allowlisted synthetic launch-history/audit INSERTs
tagged `dry_run`/`DRY_RUN` are acknowledged by an in-memory SDK double; there is no
real database persistence or provider call. The handler's `mode: "supabase"`
label in this control is not a claim of real Supabase access. Invalid ACTIVE
cases retain strict zero-write assertions. The initial zero-journal expectation
for PAUSED was wrong: the application intentionally records dry-run history.
Production behavior was not changed to conceal that distinction.

Network traps reject non-owned HTTP/HTTPS, sockets, DNS, TLS, HTTP2, datagrams and
fetch. Only the owned loopback transport and exact synthetic Auth responder are
used. No real credentials, environment files, images or provider resources are
loaded. SDK writes in positive dry-run controls are captured calls, not mutations
of a live or local business database. True real-provider PAUSED/ACTIVE behavior
is not accepted by this no-expense fixture.

## Final Regression And Evidence

Logs live under ignored `node_modules/.cache/`. Layers overlap and are not summed
or converted into a readiness percentage.

| Layer | Final Receipt |
|---|---|
| Operator connected browser/HTTP/native | 15/15, `operator-explorer-native-ui-agent-verified.log` |
| Creator connected browser/HTTP/native | 14/14, `creator-accept-recovery-native-recheck.log` |
| Actual Explorer isolated lifetime | 123/123, timestamped focused log above |
| Standard portal UI | 1069/1069, `operator-explorer-portal-ui-final.log` |
| Standard operators | 1464/1464, `operator-explorer-operators-final.log` |
| Shared Auth/API foundations | 35/35 and 30/30, `operator-explorer-api-auth-final.log`, `operator-explorer-auth-foundation-final.log` |
| Advertising runtime/source gate | 52/52, `meta-active-gate-final.log` |
| Meta payload/compliance | 29/29 and 30/30, `meta-active-payload-final.log`, `meta-active-compliance-final.log` |
| Review/checkout/fixture/bundle | 82/82, `operator-explorer-review-frozen.log` |
| Full standard build | Exit 0, `operator-explorer-build-frozen.log`: libraries, both API module modes, seven artifact/scripts typechecks, compiled CRM cold start 177+176 checks and Vite |

All listed processes completed normally. Final native operator execution imported
the candidate after the gate fix; the final shared build began at 16:45:06 UTC.
No later production-source edit is included in this receipt. Existing nonfatal
Vite sourcemap warnings remain in the log, not a warning-free-build claim.

Durable generated artifacts:
`output/design-qa/contributors-2026-10-28/native-actions/` contains six operator
screenshots, fourteen sanitized HTTP/native per-case receipts, two creator
screenshots and a raw source-hash/timestamp manifest. Native source folders were
`operator-explorer-native-ui-J04ujA` and `creator-native-http-CN4T8h`. Screenshots
were opened at native size. The selected forms fit their viewport/containers and
text fits controls. Natural scroll cropping of unrelated rows at viewport edges
is not mislabeled as control clipping. These are actual action-state captures,
not comparisons claiming full approved-mock or real Portal/Auth parity.

Preserved failures, not relabelled as final passes:

- Operator initial 12/15: the test selected the intended pending spinner/status
  as a settled notice. The corrected test retains pending-lock assertions and
  separately checks that old replies cannot publish success or change a new view.
- Next operator run 13/15: an unrelated scrolled row opener crossed the top edge
  by eight pixels. Capture now deterministically centers the selected action
  surface and verifies its actual controls/text/ancestors, instead of requiring
  every row intersecting a long scrolled viewport to be fully visible.
- Creator first full run failed before browser scenarios because the fixture
  omitted CSS bundling. That failed log remains; the repaired styled run is 14/14.
- ACTIVE harness/DNS/tagging iterations and the initial PAUSED zero-journal
  expectation remain in their original ignored logs. No guard, case or budget
  test was removed to manufacture the final results.

## Remaining Work

The connected Explorer stage/booking submission and selected recovery gate left
open by the preceding search receipt now has actual local browser/HTTP/native
evidence. The broader native criteria document still distinguishes unexercised
matrix corners, trusted keyboard input and full Portal/real-Auth/cloud acceptance;
it is not an assertion that every possible race has been tested.

No cloud migration or release is implied. Next technical work remains the verified
partner-link entry, company submission/recovery and protected review queue using
the existing 120/121 foundations. Canonical legal notices are still empty; public
registration/confirmed-email policy, final notices, payments and commercial release
need separate owner decisions. There is still no authoritative initial-contact
or next-contact event; no fabricated metric was added. Other G1-G8 gates retain
their original scope and unfinished status.

Final server raw SHA256 is `79a41aa8c50a717cf16c6e0cc7fce5944ae1b565e34655d1596cd71e6647a672`
(before `8fcfb3f2c2451c00a901458d8e19f34953d39e13b1c4361530c6ad84467946da`).
Meta marketing/cities bytes remain unchanged. Protected pre-existing 059/065 raw
hashes remain `c56c820f9b29b28f96de34b51cb63af44f29be207b7c76740c491c9811aaae47`
and `ccc908b1a91126540b78dedcbfb75ae86e191d057fbeeeb4742241e8a0c61984`.
No migration source changed. Six distinct agents handled lifetime tests, connected
action cases, creator recovery, advertising counterexamples, next-partner inventory
and criteria. Main retained architecture, the native helper, production fix and
final integration. No push, purchase, real send or working-space cleanup occurred.
