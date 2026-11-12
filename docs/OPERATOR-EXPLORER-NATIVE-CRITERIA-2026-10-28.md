# Explorer To Native Actions: Acceptance Criteria

28 October 2026. Source baseline: `d6c7962` plus the exact candidate's owned edits.
Originally criteria-only. Current selected connected proof is now recorded in
[the local actions receipt](LOCAL-READINESS-ACTIONS-2026-10-28.md): 15/15 cases.
The broad checklist below is not automatically marked complete: it includes
additional matrix corners and keyboard/full-Portal evidence beyond that run.
This document authorizes no execution, migration, release, staging or commit.
Main retains architecture, migrations, shared API integration and final decisions.

## Evidence Baseline

- [Search rollout](OPERATOR-LEAD-SEARCH-ROLLOUT-2026-10-28.md) R7/H/B and
  [search acceptance](OPERATOR-LEAD-SEARCH-ACCEPTANCE-2026-10-28.md) explicitly leave
  Explorer browser-to-native stage/booking submission and recovery incomplete.
- [Workday acceptance](OPERATOR-WORKDAY-ACCEPTANCE-2026-10-28.md),
  [booking recovery](OPERATOR-BOOKING-RECOVERY-2026-10-26.md) and
  [booking receipt](OPERATOR-BOOKING-RECEIPT-2026-10-26.md) retain their original scopes.
  Earlier split-layer passes do not satisfy this connected gate.
- Actual action sources: [Explorer](../artifacts/negis/src/components/operators/OperatorLeadExplorer.tsx),
  [booking form](../artifacts/negis/src/components/operators/OperatorBookingForm.tsx),
  [attempt storage](../artifacts/negis/src/lib/operatorBookingAttempt.ts),
  [transport](../artifacts/negis/src/lib/operatorApi.ts),
  [stage handler](../lib/crm/operator-leads.ts), [booking handler](../lib/crm/operator-bookings.ts),
  [catch-all](../api/crm/%5B...path%5D.ts) and [authorization](../lib/crm/authorization.ts).

## Required Boundary

- [ ] Use an owned disposable browser profile and native disposable PostgreSQL;
  no user browser, environment/secrets, remote DSN, cloud, real accounts/data,
  providers, external sends, downloads, deployment or spend. Block external traffic.
- [ ] Freeze revision and raw hashes of relevant UI/API/fixture/SQL sources.
  Main identifies the exact reviewed raw migration/dependency chain; preserve native
  lifecycle, identity, RLS and capacity guards. No emulated SQL or weakened guards.
- [ ] Exercise the built actual portal's Explorer, form, parsers and transport over
  real loopback HTTP through the compiled existing catch-all/authorization/handlers
  to real service-role SQL/RPC calls, including search, catalogue and booking context.
  Direct handlers, intercepted business fetches, canned RPCs or a standalone booking
  form do not prove the Explorer connection. Disclose any narrow SDK/HTTP adapters.
- [ ] Label synthetic Auth/session identities and SDK boundaries explicitly.
  Native business authorization/persistence is proven only by actual SQL outcomes;
  a real browser and compiled router do not establish real Supabase login, hosted
  runtime, Preview/cloud application or release approval.

## Connected Action Checklist

- [ ] At both **375x900** and **1440x1000**, scale 1, open an actual search result
  and submit stage and booking actions. Include a later-page result and two companies
  with matching names/phones; independent fixture expectations identify each row.
  Capture readable Russian controls/notices, keyboard interaction and screenshots
  without clipping/overlap; network and SQL assertions, not screenshots alone, prove writes.
- [ ] Record the original actor/session lifetime, accepted `requestId`, company and
  `leadId` at selection. Stage PATCH uses `/api/crm/operator-leads?requestId=...`
  with original `leadId`, target `stageId`, `expectedStageId` and `expectedStatus`;
  native `set_growth_operator_lead_stage` receives the authenticated original actor.
  Neither selected company, filter/page changes nor a replacement actor retarget it.
- [ ] Valid active same-company stage changes only that lead. Independently stale
  stage-ID and status CAS values return 409 without overwrite; inactive/foreign
  targets and revoked authority refuse. Refresh/reload reconciles row, semantic group,
  counts and active options; custom lost semantics remain a lead outcome, not a sale.
- [ ] Hold a stage reply while changing query/page or closing details: pending send
  cannot unlock a duplicate write; late success/403 cannot modify a replacement view.
  Commit then truncate the response body after headers: show unconfirmed outcome,
  perform an authorized read/reload and never automatically resend or claim success.
- [ ] Open booking from that row, read its context/catalogue, select valid native
  doctor/services and company-local time, then POST `/api/crm/operator-bookings?requestId=...`.
  Assert original actor/request/lead, `requestKey`, doctor, service IDs, `startsLocal`
  and `timeZone` through `create_growth_operator_booking` and stored attribution.
  Exact price-minor string, duration and UTC instant match independent expectations.
- [ ] Closing an unsent form issues no booking POST and creates no business rows.
  Closing/navigating away after dispatch is not rollback or appointment cancellation;
  it must not erase uncertain recovery or allow a stale callback to acknowledge it.
- [ ] After a real booking commit, truncate JSON after headers or deliver a declared
  malformed result. No false success or key clearing. Same-tab full reload/reopen
  restores the actor/request/lead-scoped original attempt; fields stay locked and
  explicit recovery resends exactly the original key/payload, never a fresh key.
  Storage failure prevents initial dispatch; rapid duplicate submits stay fenced.
- [ ] Native before/after evidence proves one appointment, one booking receipt and
  one creation audit, plus exactly one client in the deliberately new-client fixture.
  Recovery returns the same appointment ID; repeat recovery creates nothing else.
  Receipt validation binds ID to requestKey and zone to the original request.
- [ ] Change only the owned committed appointment to rescheduled/cancelled/no-show
  or nullable current metadata. Recovery returns its actual current state, not a new
  active visit; Explorer notice preserves cancellation/no-show or review-required
  labels, exact known money/time/specialist/services and explicit missing values.

## Revocation, Invariants And Receipts

- [ ] Revoke role/approval, assignment or accepted cooperation after synthetic Auth
  but before native action/recovery, and after commit before reopen. Actual SQL denies
  unauthorized read/write/replay; 401/403 clears contacts/forms but retains uncertain
  attempt metadata, which grants no access. Restoring authority permits only the
  original same-key recovery. End/reaccept for the same company cannot inherit rights.
- [ ] Delay success/error bodies across actor A -> B -> A, sign-out, reload and
  focus/visibility revalidation. Old drafts, contacts, options and callbacks cannot
  publish, clear another lifetime's recovery key or mutate another actor/request/lead.
- [ ] Compare full native before/after snapshots, not counts alone, of
  `platform_subscription_payments`, `growth_partner_commissions`, `growth_partner_payouts`,
  `deals` and `growth_operator_arrivals`: unchanged. Booking price is not payment;
  no arrival, commission, payout, membership, commercial-setting or provider mutation.
- [ ] Attach per-case expected/actual results, timestamps, source hashes, fixture IDs,
  sanitized HTTP method/path/body/status/no-store evidence, native rows/counts and
  browser assertions/screenshots. Retain failures/skips and adapter/fault disclosures;
  missing native/HTTP/browser linkage leaves this gate open, regardless of older passes.
- [ ] Independently assert all owned fixture/business rows absent after dependency-order
  cleanup, including failure paths; close owned HTTP/browser/SQL sessions/processes
  and remove only owned temporary resources. Preserve unrelated agents' work, user
  demos, untracked `output/` and protected dirty migrations 059/065 byte-for-byte,
  with before/after raw hashes. Missing cleanup evidence leaves acceptance incomplete.

No other edit or operational action is implied; cloud/real-Auth gates remain separate.
