# Complete Own Operator Workday: Local Acceptance

28 October 2026. Local candidate after `9f6ad92`, not a cloud migration or
deployment receipt. Production, Baspana, working salons, WhatsApp, real accounts,
commercial settings and providers were not accessed or changed. No spend.

## Implementation

- `migrations/123_operator_workday_read.sql`, raw SHA256
  `789e5443268b1c4079686b9e6a69585834f6ca42cd1095d47cad8c2b592217f3`.
  Additive read index, two private invoker timezone helpers and one service-only
  reader. No business-row backfill, memberships, financial or contact-event writes.
- `lib/crm/operator-workday-contracts.ts`: strict complete report parser, exact
  int64 decimal-string counts, company manifest, dates/bounds, ordering and pages.
- `lib/crm/operator-workday.ts`: verified-actor GET through the existing catch-all,
  no identity/workspace/clock selectors, no-store, no private database diagnostics.
- Actual `OperatorWorkday` and `OperatorPortal`: all-company summary, current
  authorized company selection and existing lead workflow; combined Today agenda,
  explicit company dates/timezones, separate current status and arrival receipt,
  20-row paging, retry, true empty and unavailable states. Scoped mobile styling.

The report first locks the complete accepted-request set in UUID order, then
the currently approved operator profile, matching existing authority writers.
Its business manifest, totals, current permissions and Today page use one later
READ COMMITTED statement snapshot with an in-statement clock. A newly accepted
unlocked request or >1000 companies refuses the entire report, not a partial page.

Meaning is deliberately narrow:

- Available leads are current distinct company/lead stock, assigned and clinic
  scopes separate. Clinic availability does not mean personal assignment.
- Created bookings and recorded clinic arrivals are own accepted-request
  historical facts; removing a current lead assignment does not rewrite them.
- Today requires current lead access. Contacts come from that current authorized
  lead, never a mutable appointment-client fallback. Specialist/services match
  original booking IDs to active public catalogue entries only.
- Status is current appointment status, not proof of arrival or payment. Unknown,
  terminal and undated records remain distinct. No initial-contact or conversion
  metric is manufactured: contacts explicitly show that tracking is unavailable.
- Each company has its own native-zone current day. Any missing/invalid company
  timezone makes the whole Today portion unavailable with null totals, not UTC
  fallback or successful zero. The independent complete stock summary remains.
- Pages are replacement snapshots, not a combined exported snapshot. The UI
  never appends page totals or adds values from separate report generations.

## Fresh Evidence

Logs are ignored local files under `node_modules/.cache/`. Overlapping suites
below must not be added together or relabelled as real Auth/cloud proof.

| Layer | Exact Scope | Result |
|---|---|---|
| Final cumulative SQL/HTTP | 115 exact raw SQL files 009-123 with final 789e5443 source, all previous domain/ACL cases plus new reader/native HTTP | 738/738, `operator-workday-chain123-final.log`, exit 0; every owned business row removed |
| Focused native SQL + actual HTTP | Earlier raw 4f7020 candidate on the exact local dependency chain; compiled handler/Auth/router/parser and native service-role SQL; synthetic Auth/SDK only | 29/29, `operator-workday-native-zone-recheck.log`; final named-zone candidate rechecked below |
| Strict contract | Actual compiled production parser; exact numeric/date/page/status/privacy refusals, including named-zone regression | 255/255 in final frozen portal/operator suites |
| Workday lifetime | Actual component/hooks/parser/transports; reconciled synthetic host, SDK/fetch and opaque leads boundary | 50/50; actor/ABA/denial/late body/page/company/focus checks and genuine in-memory guard mutants |
| Portal regression | Standard portal UI on frozen final UI/parser/transports and existing partner/creator workflows | 643/643, `operator-workday-portal-ui-frozen.log`, exit 0; earlier 642 retained separately |
| Operators regression | Complete standard operator command on frozen final UI/contract | 1038/1038, `operator-workday-operators-frozen.log`, exit 0 |
| Auth/API regression | Actual shared route classification and authorization foundations, no real sessions | 65/65, `operator-workday-auth-regression.log` |
| Fixture/source/checkout review | Source and Git-byte gates (67) plus pure in-memory model/server gate/bundle (12); overlapping earlier receipts | 79/79, `operator-workday-review-compact-final.log`; preceded the last CSS/header-label-only edit |
| Actual local browser | Owned disposable Edge, blocked external requests, actual frozen React portals and synthetic Auth/API; 375x900 and 1440x1000, scale 1 | 30/30, `operator-workday-browser-compact-final.log`; includes real detail disclosure and final header behavior |
| Full standard build | Library/API and Node16 API typechecks, seven artifact/scripts typechecks, compiled CRM cold start and production Vite | Exit 0, `operator-workday-build-compact-final.log`; before last CSS/header-label-only edit |
| Frozen frontend | Actual final Root/UI/CSS after that last visual edit; frontend typecheck and production Vite build | Both exit 0, `operator-workday-frontend-{types,build}-frozen.log` |
| CRM cold start | Normal and deliberately broken site renderer, network forbidden; actual final shared API imports | 353 checks, exit 0 in full build; explicit `operator-workday-cold-start-final.log` also retained |

All needed processes above completed normally. Final Root/UI/CSS edits were
written by 14:45:35 UTC; the actual-browser process started at 14:45:51 UTC,
then the frozen frontend build, 643 UI and 1038 operator suites were run again.
No post-verification production-source edits are included in this receipt.
The full API/library integration and final frontend verification are separate
layers, not a claim that an earlier bundle contains a later CSS change.

Final raw source hashes: handler `140781b507a5e91de8cdcf0851347a2e784ca65b1846729286c5f7cb681d6347`,
contract `95d6a4e793fb3c1f4d4f2362103913c6639e7b5c642ac3ef116ab4b1d5e759cf`.
Current screenshots/comparisons/report are in
`output/design-qa/contributors-2026-10-28/workday/`; the owned temporary render
was `medina-portal-design-render-RUaWAA`. See `design-qa.md` for the remaining
source-mock gaps and the exact normalization rather than assuming full parity.

Browser cases cover all three portals' ready/empty/error views, actual navigation,
drawer and controls. New operator cases prove 20+1 paging with unchanged complete
totals, company-date disclosure, missing-zone unavailable state, reload, failed
report/retry, cooperation end and access denial with no remaining old contacts.
They do not simulate a real login or a provider/database-backed browser session.

## Native Fixture And Cleanup Boundaries

The disposable local PostgreSQL fixture applies exact reviewed raw files; it
reads no environment DSN. Only minimal local roles and a Storage catalogue are
synthetic. Existing request lifecycle/identity/RLS triggers are not disabled.
Request fixtures enter `requested` before `accepted`/`declined`.

Coverage includes 25 accepted companies behind 25 newer declined proposals,
74 available leads, 27 own attributed appointments, one undated booking and
26 authorized Today visits split 20+6; another operator/company is independent.
One lead/multiple visits/two services do not inflate totals. Mutable private
appointment data and inactive catalogue entries cannot supply contact/details.
Removing assignment hides its Today rows but retains historical counts. Ending
then accepting a new request for the same company cannot inherit old attribution.

Real database sessions cover waiting profile suspension, assignment removal and
new-acceptance phantoms; 1001 actual accepted requests refuse instead of truncating.
Missing/invalid schedules, nonfinite receipts, orphan/cross-company booking links,
wrong isolation, dependency/authority drift, helper/browser ACL and idempotent
read-only reapplication are tested. All owned public business rows are removed
and asserted empty before fixture shutdown. These are not real customer records.

Native calendar expectations independently cover UTC/+5, New York 23/25-hour
days, Havana's folded midnight, Santiago's missing midnight and Apia's skipped
next date. This is selected-case native proof, not a theorem about every historical
timezone transition or a guarantee of identical PostgreSQL/Intl tzdata versions.
If the browser/runtime cannot validate a server timezone, parsing safely refuses.

## Failures Retained, Not Hidden

- Initial lifecycle fixture inserted `accepted`; the existing trigger correctly
  refused it. Fixed fixture requested-to-accepted transitions, not domain guards.
  `operator-workday-native-initial.log`: 6/7 including parent failure.
- Next native/HTTP attempt used SQL NULL for a NOT NULL JSON setting and queried
  nonexistent `crm_sales`. Corrected JSON null encoding and the real `deals` table.
  `operator-workday-native-http-initial.log`: 25/28 including parent failure.
- Strict-parser and reconciled-host agents found inconsistent count/page/bucket
  inputs and denial with no fresh React state. Fixed production validation and
  explicit denial-state publication; all focused checks then passed.
- The first full build failed TS6059: test-only type imports crossed scripts'
  rootDir. Replaced only test-local fixture annotations, preserving execution of
  the real production parser; scripts typecheck and focused 74/74 plus 50/50 passed.
  Root config/typechecking was not weakened. Original build log is retained.
- Additional independent review found `CST` has PostgreSQL fixed-offset and Intl
  Chicago/DST meanings: a configured company could make the whole report 503.
  Both reader and parser now admit only supported geographic/Etc paths plus
  explicit UTC/GMT; ambiguous abbreviations, POSIX and legacy root aliases become
  an unavailable Today zone instead. Existing settings are not rewritten. Native
  and parser regressions cover CST and an explicit fixed `Etc/GMT+6` counterpart.
  The prior full-chain run (738/738, raw 4f7020) is historical evidence only;
  `operator-workday-chain123.log` is retained, not relabelled final acceptance.
- Visual inspection after a passing browser run found duplicate heading,
  standalone profile-refresh row and over-tall mobile metric bands (P2). The
  actual portal now relies on its existing H1/header action and suppresses the
  redundant inner header; standalone Workday keeps its own heading/refresh.
  Mobile metrics use three compact columns. A later P2 Today-density finding
  was fixed with compact totals and working native detail disclosures. The last
  30/30 actual-browser pass, frozen frontend build and 643/1038 suites cover this
  final UI, including the corrected contact label and supported-zone warning.

## Remaining Gates

- No migration 123, API/UI candidate or environment change is applied to any cloud
  target. A separate exact release/recovery plan, approval, isolated Preview Auth
  and database-backed browser receipt are still required before rollout.
- Current safety revalidation replaces report lifetimes; preserving an unsent
  child lead draft across ordinary focus/agenda refresh is not accepted by this
  cycle. Never trade stale-contact protection for draft retention silently.
- Initial contact-outcome tracking is not implemented. Its definition/retention
  needs a distinct product decision; existing booking or status facts are not it.
- Verified partner URL/public company intake/review and canonical consent registry,
  real sandbox payment and public/commercial activation remain separate unfinished
  work. Overall design QA stays blocked by the partner-link gap, not this local
  report's presence. No claim of whole-project 100% or public readiness.
- The source mock's global lead search/stage filters are not implemented by the
  guarded per-company lead list. That remaining product/design gap is explicit,
  not a fake global count/filter; it needs a separate scoped read/interaction cycle.
  This describes the original 123 checkpoint. The later local 124/Explorer cycle
  now implements that read/filter scope; its distinct evidence and still-open
  integration/cloud gates are in [the search receipt](OPERATOR-LEAD-SEARCH-ACCEPTANCE-2026-10-28.md).

Six earlier disjoint agents handled UI, contract tests, lifetime tests, existing
actor regression adaptation, read-only review and rollout criteria. Additional
bounded review found the CST issue; test-only integration repaired TS6059.
Main retained architecture, migration writes, integration and final decisions.

Protected pre-existing files were left unchanged: 059 raw SHA256
`c56c820f9b29b28f96de34b51cb63af44f29be207b7c76740c491c9811aaae47`,
065 `ccc908b1a91126540b78dedcbfb75ae86e191d057fbeeeb4742241e8a0c61984`.
No push, deployment, purchase, external send or working-space cleanup is implied.
