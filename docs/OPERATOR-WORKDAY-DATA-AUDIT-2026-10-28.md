# Operator Workday Data Audit

28 October 2026. Task 2, operator-only G6/G7 handoff. Audited base:
`codex/blog-publication-runtime-fix`, `b2c92d0`. Read `CLAUDE.md`.
Static source/fixture investigation only: no database queries, account access,
environment reads, browser use, external requests, deployments or test execution.
No partner/payment implementation or multi-clinic architecture/SQL is proposed.
Only this new document is written; protected dirty migrations 059/065 and
`output/` are untouched. References below are repository-relative file:line.

## Decision For Main

**Not ready to claim an all-company workday summary, contact funnel or Today
agenda from existing list responses.** Existing tables support authoritative
current lead access, attributed bookings and clinic-confirmed arrival receipts,
but no operator aggregate/agenda read contract currently exposes them together.
The immediate gate is a narrow authorized read contract with explicit counting
units and dates, not additional illustrative statistics or a workload threshold.

## Existing Authority And Meanings

| Item | Authoritative source and exact boundary |
| --- | --- |
| Accepted cooperations | `lib/crm/operators.ts:247` authenticates, checks an approved profile, then pages **all** request statuses at `:263`. `artifacts/negis/src/components/operators/OperatorWorkday.tsx:14` filters only that loaded page for `accepted`, selects one request and mounts its leads at `:38`. This is neither all accepted cooperations nor an aggregate; page one can show no accepted companies even when later pages contain them. The live uniqueness rule is per workspace/operator (`migrations/052_operators_and_partner_ledger.sql:39`), not a global capacity limit. |
| Assigned/available leads | `migrations/054_operator_lead_access.sql:78` checks accepted request, authenticated operator and current approval under locks, then returns current workspace leads satisfying `lead_scope='clinic'` or an `assigned=true` assignment. It returns 21 rows, not a total (`:100`); server exposes 20 plus `hasMore` (`lib/crm/operator-leads.ts:119`). For `assigned`, count distinct current `(workspace_id, lead_id)` authorized through that request. For `clinic`, call these **available**, not explicitly assigned. Assignment PK is `(operator_request_id, lead_id)` (`054:24`), so other operators can also have that lead. CRM `responsible_user_id` is a different assignment system. |
| Contact | No operator lead-contact event/outcome is supplied by `OperatorLead` (`lib/crm/operator-contracts.ts:23`) or the pipeline reader (`migrations/056_operator_lead_processing.sql:4`). Current `in_progress` stage means current work state, not a successful conversation. Existing generic `calls` has client/phone/result but no operator-request or lead attribution (`migrations/010_staff_ready_crm.sql:63`); its writer accepts free-text result (`lib/crm/server.ts:2036`) and its route requires CRM membership/permissions (`lib/crm/authorization.ts:122`). Do not join by phone to invent operator contact history. Post-arrival `operator_check_result` is a separate control call, not initial lead contact. |
| Booked | Two incompatible valid meanings exist: **leads currently in booked stage**, or **appointments created through this operator request**. The former is mutable stage state (`migrations/056_operator_lead_processing.sql:60`); stage semantic groups include `booked` (`migrations/080_postponed_lead_stage.sql:27`). The latter is `growth_operator_bookings`, with unique request key/appointment and explicit request/lead links (`migrations/057_operator_catalog_booking.sql:5`). Latest booking writer is `migrations/073_peak_appointment_capacity.sql:141`: replay reads the current appointment (`:160`); new booking creates `scheduled` appointment and ledger atomically (`:234`), without setting the lead's booked stage. GET `operator-bookings` returns booking timezone context only, not appointments (`lib/crm/operator-bookings.ts:119`). |
| Confirmed arrival | A `growth_operator_arrivals` receipt, unique per workspace/appointment (`migrations/052_operators_and_partner_ledger.sql:45`). Latest confirmation requires an accepted request, authorized separate clinic employee, exact attributed booking and appointment status `arrived`; retry returns the existing receipt (`migrations/074_operator_arrival_access_locks.sql:15`). Operator read checks current approval/accepted request and joins exact booking/request/workspace (`migrations/066_operator_arrival_control_calls.sql:139`). It returns **only receipts**, newest confirmation first, 21 rows. Appointment `confirmed`, appointment `arrived`, clinic receipt, and patient control-call `confirmed` are four different facts. Control-call results can change (`074:89`), never create another arrival or prove payment (`066:265`). |

The existing team report is a useful completeness/clock precedent, **not an
operator endpoint**: `lib/crm/lead-team-analytics.ts:83` requires owner/admin in
`mortgage_leads`; latest `migrations/104_analytics_report_timezone.sql:26` counts
staff-responsible leads, uses semantic stage classification, one business-data
snapshot/report clock, explicit timezone, and refuses overflow at `:106`.
Do not grant operators that report or reuse its staff assignment totals.

## Counting And Today Hazards

- **Partial pages:** inbox, leads and arrivals independently page at 20 plus a
  sentinel (`lib/crm/operator-contracts.ts:147`, `lib/crm/operator-arrivals.ts:81`).
  Counting visible rows or filtering an inbox page is not a complete total.
  Even fetching every offset page can skip/repeat moving rows or mix snapshots;
  failed pages must not become zero or a complete summary.
- **Double counts:** one lead can have several bookings and one booking several
  services. Joining/expanding them multiplies lead counts. Count leads by
  workspace/lead and bookings/receipts by workspace/appointment independently;
  never deduplicate people by name/phone across companies. These are not
  mutually exclusive funnel steps and cannot establish conversion rates.
- **Cancellation/rescheduling:** ledger rows are creation/attribution facts, not
  active appointments. `073:180` permits a replacement after cancelled/no-show;
  `073:166` replays current appointment values. Use current `appointments.status`
  and `starts_at`, not immutable booking `starts_local/time_zone`. Arrival reader
  `066:178` does not require current status `arrived`: a receipt can coexist with
  a later status/time change. Label it recorded clinic confirmation; surface a
  conflict rather than silently erasing the receipt or calling it a current visit.
- **Reassignment/access withdrawal:** `054:64` overwrites current assignment;
  `updated_at` is last change, not first assignment or a daily assignment count.
  It does not reattribute old bookings. Existing arrival read checks request and
  approval but **not current lead assignment** (`066:149`, `:185`), preserving a
  separate receipt/control-call scope. Do not extend that historical contact
  permission to future agenda contacts automatically. Ended cooperation is no
  longer readable; a later accepted request must not inherit its old attribution.
- **Revoked approval/stale UI:** accepted rows can remain while profile is pending
  or suspended. Lead/arrival SQL denies access even for empty results (`054:86`,
  `066:149`). Inbox approval is a separate preflight/query (`operators.ts:254`),
  not an authorization snapshot to copy for the new report. Preserve owned
  request lifetimes and stale-response clearing (`artifacts/negis/src/lib/operatorApi.ts:93`);
  an A -> B -> A response must not revive private data.
- **Today is undefined today:** operator arrivals lack timezone metadata
  (`lib/crm/operator-contracts.ts:120`); existing formatter uses device timezone
  (`artifacts/negis/src/components/operators/OperatorArrivals.tsx:37`). There is
  no upcoming operator appointment list: clinic reader includes bookings but is
  staff-only (`migrations/066_operator_arrival_control_calls.sql:88`,
  `lib/crm/operator-arrivals.ts:180`). Neither is an operator agenda. Visit date,
  booking creation date and clinic confirmation date are different clocks.

## Minimal Trustworthy Read Contract

Main owns route placement, authentication, SQL and integration. Required behavior,
not an implementation/architecture prescription:

1. Derive actor from verified authentication and eligible requests server-side;
   require current approved profile and accepted cooperation. Apply existing
   lead scopes, including revocation, and keep unrelated CRM/private fields out.
   Never authorize from browser workspace/request lists or infer staff membership.
2. Return a complete eligible-cooperation manifest with opaque request identity,
   company display name, scope and server-validated clinic timezone. Totals cover
   that complete eligible set, independently of selected company or visible pages.
   Declare `generatedAt`, completeness and counting basis. Use a consistent
   business snapshot; unavailable/incomplete reads must not report successful zero.
3. Keep metric units explicit: current assigned/available distinct leads;
   contact **unavailable**, not `0`; operator-attributed distinct appointments
   with current status breakdown; distinct recorded clinic-confirmed appointments.
   A booked-stage count may be separate, clearly named current pipeline state.
   Do not sum clinic-scope availability into a number labelled assigned, or compare
   current lead stock with historical appointment/receipt counts as a funnel.
4. Define Today minimally as **visits starting on each company's current local
   date**, derived from the same server instant and validated `clinic_schedule`
   timezone (`migrations/057_operator_catalog_booking.sql:73`). Return each
   company's local date and half-open UTC day bounds. A global operator-local-day
   view would be a separate explicit product decision. No device/UTC fallback for
   missing timezone; calendar-day boundaries must handle DST, not assume 24 hours.
5. Return agenda rows for exact operator-attributed bookings using current
   appointment time/status, optional linked clinic receipt and control-call state.
   Keep appointment, receipt and control-call confirmation separate. Include
   company/request identity, timezone and only permitted contact/service/doctor
   fields. For future contact details, conservatively retain current lead-scope
   eligibility; Main must explicitly decide any broader historical-booking policy.
6. Today is a visit-date view, not bookings-created-today or receipts-entered-today.
   Cancelled/no-show rows must not inflate actionable/upcoming counts. If retained
   in Today, return them explicitly as terminal history, alongside status buckets.
   Give undated/malformed appointments an explicit exclusion/unavailable state.
   Page agenda with stable ordering and a declared freshness/completeness contract;
   return the complete Today total separately from `items`/`hasMore`.

## Next Local G6/G7 Gate

- Main pins the metric names/units, Today definition and reassigned-booking contact
  policy before wiring summary cards or agenda. Contact stays unavailable until
  an actual attributable outcome contract exists; no invented rates/thresholds.
- Synthetic read acceptance must exceed one page of mixed-status cooperations,
  leads and visits; verify accepted requests after page one, true empty state,
  incomplete page failure and exact totals independent of UI selection.
- Cover one lead/multiple visits/multiple services, same-key replay, cancelled
  rebooking, rescheduling, receipt/current-status disagreement, assignment removal,
  ended/new cooperation, pending/suspended approval and late A/B/A responses.
- Cover UTC/+5 company-local midnight, device-zone mismatch, differing company
  dates, DST and invalid/missing timezone. Verify visit-day versus creation-day
  versus confirmation-day explicitly and preserve no-contact disclosure on denial.
- Existing fixtures are starting points, not new acceptance receipts:
  `scripts/fixtures/operator-access-postgres.test.mjs:187` covers approval,
  assignment/end denial and replay; `scripts/fixtures/operator-booking-native-http.test.mjs:195`
  includes changed-current-appointment recovery. No existing all-company
  aggregate/Today acceptance is established by those cases. Main retains final
  browser QA and integration; this audit establishes no runtime or release approval.
