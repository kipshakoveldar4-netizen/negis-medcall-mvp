# Operator Workday Rollout Gates

28 October 2026. **Local acceptance is now recorded separately; nothing is
cloud-applied.** See [fresh evidence, failures and remaining gates](OPERATOR-WORKDAY-ACCEPTANCE-2026-10-28.md).
The checklist below was written before Main's API/native/browser execution;
its unchecked boxes preserve original criteria, not a claim that no work was
performed. Use the dated acceptance receipt for actual current results.

## Exact Sources

- [Data audit](OPERATOR-WORKDAY-DATA-AUDIT-2026-10-28.md): authority, counting units,
  privacy boundaries and the proposed complete read contract; not runtime proof.
- [New contract](../lib/crm/operator-workday-contracts.ts):
  `OperatorWorkdayReport`, `parseOperatorWorkday`, page size 20 and company limit
  1000. Source presence is not parser, SQL, transport or integration acceptance.
- Integration surfaces: `api/crm/[...path].ts`, `lib/crm/authorization.ts`,
  `artifacts/negis/src/lib/operatorApi.ts`,
  `artifacts/negis/src/components/operators/OperatorWorkday.tsx` and
  `artifacts/negis/src/components/operators/OperatorWorkday.css`.
  Record Main's final exact migration-123, handler and test filenames with their
  candidate hashes before acceptance; do not invent filenames or completed wiring.

## Meaning Gate

- [ ] `summary.availableLeads` is current authorized distinct
  `(workspace_id, lead_id)` stock, split into `assignedLeads` and `clinicLeads`;
  the contract requires their sum. Clinic-scope leads are available, not assigned.
- [ ] `attributedBookings` counts distinct operator-request-attributed appointments,
  not booked-stage leads, people, services or active visits. Use current appointment
  time/status; replay, cancellation and rescheduling do not rewrite attribution.
- [ ] `clinicConfirmedArrivals` counts distinct recorded clinic arrival receipts,
  not appointment `confirmed`/`arrived`, control-call success or payment. Show any
  receipt/current-status conflict without silently erasing the receipt.
- [ ] Own currently accepted-request booking and confirmed-receipt counts include
  historical bookings even after lead-assignment removal. Today rows, unlike those
  counts, require current lead permission; their totals need not match historical totals.
- [ ] Today `clientName`/`clientPhone` come from the **current authorized lead**,
  never the appointment client. Resolve `doctorName` from the original booking's
  doctor ID and `service` from its original service IDs, matching the active public
  catalog. No appointment-client or unrelated/private/inactive catalog fallback.
- [ ] `contacts: "not_tracked"` is visibly unavailable, never zero or a conversion
  rate. Stage changes, phone matches and `operatorCheckResult` do not prove initial
  contact. Stock, appointments and receipts are not a cohort funnel; invent no rates.
- [ ] Today means current visits starting within each company's `[dayStart, dayEnd)`
  on its `localDate`, derived from one server `generatedAt` and validated `timeZone`.
  It is not the operator-device-zone day, booking-creation day or receipt-entry day.
  Any missing company timezone requires `unavailable_timezone`, null totals, no
  items and `hasMore: false`, not a device/UTC fallback or successful empty Today.

## Required Fresh Evidence

All execution below belongs to Main's subsequent isolated acceptance, not this
document task. No active clinic/salon data. Retain candidate revision plus dirty-file
hashes, exact command, timestamp, fixture IDs, expected/actual results, failures,
skips and cleanup receipt, without secrets or real contact details.

- [ ] **Local native PostgreSQL:** run the actual final migration chain including
  123 in a disposable fixture; verify RPC/ACL and current approval/accepted-request
  checks, tenant isolation and current lead-scope enforcement. Verify locks on the
  complete own-request set **before** the profile lock, then one business snapshot
  for manifest/totals/Today. More than 1000 companies, a snapshot phantom or any
  incomplete read refuses the **whole report**, never a partial report or zero.
- [ ] **Contract + actual HTTP:** test `parseOperatorWorkday` with real multi-digit
  decimal-string counts, bounds, exact keys, offset, identities, ordering, page
  length and `hasMore`; reject malformed payloads. Exercise the final catch-all
  route and real handler over loopback HTTP against native fixture SQL, including
  verified actor, unauthenticated/foreign actor, query/method refusals and delayed
  responses. Mocked fetch, direct handler calls or booking-only HTTP are not enough.
- [ ] **UI:** exercise the actual report consumer and workday component with
  loading, true empty, failure, retry/reload, timezone-unavailable and paging states.
  Denial clears private data; stale success/error/callbacks cannot restore it.
  Summary stays all-company when selected company or agenda page changes. Show
  current appointment status, separate receipt/control-call facts and company zone.
- [ ] **Browser:** Main captures fresh desktop/mobile screenshots and network/assertion
  receipts from the built integrated candidate using synthetic accounts. Cover
  reload, selection, paging, refusal and unavailable states; verify Russian labels,
  no clipped/overlapping content, no misleading totals and no stale private details.
  Fixture-only render proof must be labelled as such, not deployed acceptance.
- [ ] **Integration:** fresh `pnpm run typecheck`, `pnpm run test:crm-cold-start`,
  `pnpm run build` and affected operator/portal regressions on the same candidate.
  Reconcile the audit's status-breakdown and completeness/freshness requirements
  with final SQL/API/UI: the current contract has per-item `status`, aggregate
  `bookingStatuses` and `generatedAt`. There is no cross-page snapshot token:
  completeness is within each report read, and paging replaces rather than
  appends a snapshot. Never sum pages from different snapshots.

## Mandatory Fixtures

- [ ] **Beyond page one:** >20 mixed-status cooperation requests with eligible
  accepted companies after page one; >20 authorized leads and >20 Today visits.
  Assert exact independent totals, stable tie ordering, page boundaries, true empty,
  failed later page and refresh after data changes. Company selection cannot narrow
  the manifest/summary; do not count visible rows.
- [ ] **Independent facts:** one lead/multiple appointments/multiple services,
  same-key replay, cancelled/no-show rebooking, current reschedule across midnight,
  unknown status, undated booking and receipt/status disagreement. No join inflation;
  terminal/unknown rows cannot inflate actionable visits; undated exclusion is explicit.
- [ ] **Current assignment withdrawal:** remove an assigned lead while read/reload
  is pending; fresh stock loses eligibility and Today rows disappear, not merely
  their phones. Own accepted-request historical booking/receipt counts remain.
  Preserve separate receipt/control-call authority without extending Today access
  or reattributing old bookings.
- [ ] **Privacy provenance:** make appointment-client name/phone disagree with the
  current lead and change appointment doctor/services away from original booking
  IDs. Assert only authorized current-lead contact and original-booking IDs matched
  to active public catalog are exposed; missing/inactive matches cannot leak fallback data.
- [ ] **Whole-report refusal:** exceed 1000 companies and race own-request changes
  across lock acquisition/business snapshot to create a snapshot phantom. Assert
  complete refusal through native SQL, HTTP and UI, with no partial or stale report.
- [ ] **Lifetime changes:** end cooperation, then accept a new request for the same
  company; old request attribution/data/actions cannot transfer to the new request.
  Include pending/suspended approval and cross-operator/company denial, even on empty reads.
- [ ] **Reload + A -> B -> A:** delay headers, bodies, success and errors across
  actor/session, company, request-lifetime and page changes; also full reload after
  withdrawal/end. Returning to the same ID must not revive an earlier lifetime's data.
- [ ] **Company-local calendar:** UTC/+5 midnight, differing simultaneous company
  dates, mismatched device zone, exact start/end boundary, absent/invalid timezone,
  DST spring/fall 23/25-hour days. Assert visit date independently of booking and
  receipt dates; never compute a local calendar day by adding 24 hours.

## Owner-Input Gates Only

- [ ] **Actual cloud release:** explicit owner authorization for the exact candidate,
  migration/API/UI combination and target, with release/recovery plan. Before an
  approved release, obtain authentication evidence on a separate preview deployment;
  actual migration/deployment and post-release checks need their own receipts.
  Local passes do not mean cloud-applied. This checklist authorizes no cloud action.
- [ ] **Legal/contact-outcome choice:** owner/legal decision on any broader historical
  contact access or new attributable contact-outcome definition/retention. Until
  approved and implemented/tested, retain conservative current-scope contact access
  and `not_tracked`; do not manufacture contact/conversion metrics or thresholds.
  Ordinary local correctness/fixture work is Main's responsibility, not an owner-input gate.

Existing `scripts/fixtures/operator-access-postgres.test.mjs`,
`scripts/fixtures/operator-booking-native-http.test.mjs`,
`scripts/src/medina-operator-list-original-actor.test.ts` and
`scripts/fixtures/portal-design-browser.render.test.mjs` are regression starting
points only. Earlier audit/booking/portal receipts must retain their original scope
and hashes; never relabel them as new workday acceptance or release approval.
