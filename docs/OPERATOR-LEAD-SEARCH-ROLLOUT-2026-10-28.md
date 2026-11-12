# Operator Lead Search Rollout Criteria

28 October 2026. Baseline `6756053` plus the local search candidate.
Current exact evidence: [local receipts and remaining gates](OPERATOR-LEAD-SEARCH-ACCEPTANCE-2026-10-28.md).
Main owns migration 124 and integration; no cloud application is claimed.
Checkboxes describe the whole named criterion, not just one passing layer.
Source presence and earlier workday results do not establish search acceptance,
readiness percentages, cloud permission or a production decision. This document
authorizes no execution, environment/key access, migration, deployment or commit.

## Current Sources

- [Search contract](../lib/crm/operator-lead-search-contracts.ts): query/path helpers,
  strict report parser, six groups, decimal-string counts and 20-row pages.
- [Search handler](../lib/crm/operator-lead-search.ts): verified-actor GET,
  `read_growth_operator_lead_search`, `P1241` denial, unavailable refusal, no-store.
  [Catch-all](../api/crm/%5B...path%5D.ts) and
  [authorization](../lib/crm/authorization.ts) contain the current route wiring.
- Integration surfaces, not proof of completed global search:
  [OperatorWorkday](../artifacts/negis/src/components/operators/OperatorWorkday.tsx),
  [OperatorLeadExplorer](../artifacts/negis/src/components/operators/OperatorLeadExplorer.tsx),
  [OperatorLeads](../artifacts/negis/src/components/operators/OperatorLeads.tsx) and
  [operatorApi](../artifacts/negis/src/lib/operatorApi.ts).
- Existing boundaries: [054 access](../migrations/054_operator_lead_access.sql),
  [056 stage/CAS](../migrations/056_operator_lead_processing.sql),
  [080 postponed taxonomy](../migrations/080_postponed_lead_stage.sql),
  [104 semantic/status precedent](../migrations/104_analytics_report_timezone.sql),
  [phone normalization](../lib/crm/phone.ts) and
  [028 database counterpart](../migrations/028_leads_phone_normalized.sql).
- [Workday audit](OPERATOR-WORKDAY-DATA-AUDIT-2026-10-28.md) and
  [workday acceptance](OPERATOR-WORKDAY-ACCEPTANCE-2026-10-28.md) retain their
  original scope. Main must attach the final actual 124/integration/test filenames
  and candidate hashes; no migration filename or completed wiring is inferred here.

## Requirement Checklist

- [x] **R1 - Global authorized scope.** Search covers the complete current own
  accepted-request set of an approved operator, not the loaded inbox/company page.
  Each lead satisfies that exact request's current `assigned` or `clinic` scope.
  Clinic availability is not personal assignment. `requestId` only narrows this
  authorized set; knowing a request/company ID never grants access.
- [x] **R2 - Counts and meaning.** `totals` applies search plus optional company
  (`requestId`) filtering across **all groups**, independent of selected group
  and offset. Its six buckets sum to `all`; `matched = totals[selected group]`.
  Counts are exact nonnegative int64 decimal strings, not visible-row counts.
  Count distinct company/lead stock; never merge leads across companies by name/phone.
  Booked/lost groups describe current leads, not appointments, contacts, sales,
  arrival receipts or a booking/conversion funnel; no new rates/outcomes are invented.
- [x] **R3 - Classification.** The lead's same-company stage `semantic_group` is
  authoritative, including an inactive assigned stage and custom/renamed labels
  that contradict legacy status. Only when same-company stage semantics are absent
  does the accepted legacy status fallback apply; unknowns remain `other`. Preserve existing
  meanings, including postponed and lost; do not redefine taxonomy in this rollout.
- [x] **R4 - Exact request/page metadata.** `companies` is the current authorized
  accepted-request manifest, including eligible companies beyond inbox page one.
  Row/company/stage metadata binds to the exact accepted request, not a workspace
  guess or earlier cooperation lifetime. `stageOptions` contains exactly one entry
  per request represented on this page, none for absent-page requests, and only
  that company's active stages. An inactive current stage still classifies the
  lead but is not an active target option; another company's options never substitute.
- [x] **R5 - Query and page contract.** Accept only contract-defined search/group/
  requestId/offset inputs (plus internal route `path`); trim search, enforce its
  120-character limit, UUID/group/offset bounds, exact keys and scalar types.
  Reject caller identity, clock and workspace selectors and nonempty GET bodies.
  Return `min(20, max(matched - offset, 0))` rows, exact filter/offset echo and
  `hasMore`; order by created time descending/nulls last, then request ID/lead ID
  ascending, preserving microsecond ties. Each page replaces a report snapshot;
  there is no cross-page snapshot token and pages/totals must not be accumulated.
- [x] **R6 - Privacy and refusal.** Expose only the current authorized lead's
  contact and the allowlisted report fields: no appointment/client contact lookup,
  private notes or extra private payload keys, including hidden network data.
  Missing schema/RPC, incomplete reads, overflow, malformed reports and unavailable
  metadata refuse the whole report, not partial success or zero. Verify route-level
  unauthenticated denial, invalid-input/method refusals, `P1241` -> 403 and other
  search unavailability -> 503, no-store and no private database diagnostics.
- [x] **R7 - Existing actions and lifetimes.** Search is read-only. Stage/booking
  actions retain existing endpoints and exact row request/lead identity, not the
  currently selected company's identity. Stage writes retain both `expectedStageId`
  and `expectedStatus` CAS checks; conflict/denial cannot become success. Refresh
  reconciles rows, counts and options. Actor/session/request/filter/page changes,
  reload, focus/visibility revalidation and revocation cannot restore old contacts,
  metadata, forms, drafts or mutation callbacks from a superseded lifetime.

## Mandatory Cases And Evidence

All cases require independent expected/actual results, not assertions copied from
the implementation. Evidence codes below are separate obligations, not one pass.

| Case | Required acceptance | Evidence |
| --- | --- | --- |
| Beyond page one | >20 accepted cooperations behind >20 newer declines; >20 authorized leads across companies, assigned/clinic scopes, stable ties/null dates, 20 + remainder, later-page failure and refresh after changes. Complete manifest/counts never derive from inbox or visible rows. | N, H, U, B |
| Search and company identity | Same name/phone in different companies remains separate; combined search/company/group filters, literal `%` and `_`, Kazakh and Russian names/case, positive matches and nonmatches. Equivalent formatted phones (`8`, `+7`, digits, spaces/punctuation, international prefix) follow existing normalization, without broadening authority. | N, H; U, B controls/results |
| Semantic groups | Custom names and conflicting statuses, inactive assigned stage, no-stage legacy fallback statuses, postponed, unknown/`other`, every group and zero-match selection. Assert exact buckets, unchanged all-group totals on group changes and page-scoped active options. | N, H, U |
| Loss and stage CAS | Custom-named lost semantic stage remains a lost lead outcome, not a contact/sale fact. Correct stage change updates classification/counts on reload; stale stage ID or status, inactive/foreign target and revoked access refuse. A lost mutation response reconciles by authorized reload without false success or automatic overwrite. | N, H, U; B workflow |
| Privacy and completeness | Current lead differs from appointment/client/private notes; only current authorized contact appears. Missing function/table/column, malformed or extra-key payload, count/page/order mismatch, >1000 companies or oversized/incomplete stage options refuse, never successful empty. True empty is tested separately. | N, H, U; B empty/refusal |
| Actor and revocation races | Actor A -> B -> A, delayed headers/bodies/success/errors, same-ID new lifetimes, pending/suspended approval, assignment withdrawal, cooperation end then new acceptance for same company, cross-operator/company attempts. Revalidate authority even on empty reads; superseded callbacks cannot leak or mutate another view. | N concurrency, H, U; B reload/revocation |

## Separate Acceptance Receipts

- [x] **N - Native PostgreSQL.** Exact final raw migration chain including Main's
  124 in a disposable local fixture; actual RPC, service-only ACL, current authority,
  concurrency/completeness and independent count/search/classification/page checks.
  Preserve lifecycle/RLS guards. Model SQL, source inspection or workday-123 passes
  do not satisfy this gate.
- [x] **H - Actual HTTP.** Real loopback requests through the current catch-all,
  authorization, handler and parser to native fixture SQL, including refusal/header
  and existing stage-CAS paths. Direct handler calls or mocked fetch are not HTTP
  proof; identify any synthetic Auth/SDK boundary, never label it real authentication.
- [x] **U - Synthetic UI.** Actual production consumer/hooks/components under an
  explicitly synthetic host/transport: loading, real empty, no matches, failure,
  retry, filter reset to first page, paging, row-specific actions and delayed races.
  Verify totals versus matched and clearing stale private state; this is not browser
  or native database acceptance.
- [x] **B - Real browser.** Fresh desktop/mobile screenshots plus network and
  interaction assertions on the integrated candidate: search/filter/company/page,
  reload, retry, lost-stage/conflict and denial. Russian labels, keyboard-accessible
  controls, readable counts and no clipping/overlap or stale contacts. Disclose
  synthetic accounts/backend; a real browser alone proves neither real Auth nor cloud.
- [x] **Integration regression.** Same frozen candidate has separate typecheck,
  build, shared CRM cold-start and affected operator/workday/booking/portal receipts.
  Earlier hashes/results and overlapping suites retain their scope; do not sum or
  relabel them as lead-search proof. No execution is part of this document task.
- [ ] **C - Actual cloud.** Unverified/unapplied here, with no permission inferred.
  Only a separately, explicitly owner-authorized exact candidate/target can receive
  Main's isolated Preview authentication, actual migration/API/UI application and
  database-backed browser/post-application receipts, with release/recovery scope.
  Native, loopback, synthetic UI and local-browser passes never substitute for C.

The later [connected actions cycle](LOCAL-READINESS-ACTIONS-2026-10-28.md) supplies
15/15 actual Explorer/browser -> compiled HTTP/Auth/router -> native SQL cases:
original stage CAS, both companies and viewports, booking and exact-key recovery,
current receipt outcomes, delayed replies/ABA and native revocation. It closes the
selected connected local R7/H/B workflow in addition to the prior read/unit layers.
This is not exhaustive testing of every matrix combination, full Portal login or
cloud evidence. Expanded criteria retain unexercised corners explicitly; C remains
entirely unverified/unapplied.

## Receipt Hygiene And Cleanup

- [x] Main attaches revision plus dirty-source/raw SQL hashes, exact evidence/test
  paths, execution details, timestamps, fixture IDs, expected/actual outcomes,
  failures/skips and boundary disclosures to each applicable gate. Until then,
  unchecked means unverified, not a measured readiness percentage.
- [x] Use disposable synthetic fixtures only: no production or working clinic/salon
  datasets, real accounts/contact exports, environment secrets, keys or external sends.
  Remove and independently assert absence of every owned fixture/business row;
  close owned sessions/processes and remove owned temporary resources. Preserve
  unrelated dirty work and `output/`; never clean a working dataset. A missing cleanup
  receipt leaves acceptance incomplete.
- [x] Preserve the already-dirty protected files byte-for-byte. Main's before/after
  raw SHA256 receipts must match these recorded baselines, not merely normalized SQL:

| Protected file | Required raw SHA256 |
| --- | --- |
| [059](../migrations/059_site_blog_drafts.sql) | `c56c820f9b29b28f96de34b51cb63af44f29be207b7c76740c491c9811aaae47` |
| [065](../migrations/065_operator_arrival_attribution.sql) | `ccc908b1a91126540b78dedcbfb75ae86e191d057fbeeeb4742241e8a0c61984` |

No other document edit, test run, operational command, environment/cloud change,
staging or commit is authorized by this criteria-only handoff. Product definitions,
production decisions and final SQL/integration remain with Main and the owner.
