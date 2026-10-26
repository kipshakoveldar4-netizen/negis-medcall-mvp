# G3 Analytics Completion Evidence, 26 October 2026

Base: `1339cc7`. Scope: G3 only; [matrix](../TEST-RELEASE-CANDIDATE-2026-10-25.md). This card is not release approval or a readiness percentage.
Only this new card is owned. Protected 059/065 remain untouched. No runtime/tests/package/shared-document edits, installs, builds, native PG, real DB, worker, external service, secrets or user-browser access. Main owns current Preview availability and any later authorization.

## Proven Local Today

From `scripts/`: `node --import tsx --test --test-concurrency=1 ./src/medina-analytics-report-lifetime.test.ts`: **17 passed, 0 failed/skipped**, exit 0; the only suite run.
The [fixture](../../scripts/src/medina-analytics-report-lifetime.test.ts#L11) evaluates the actual component and server normalizer with deterministic hooks/native JSON; DB/network imports are refused. This is not React DOM, real Auth, SQL execution or Preview acceptance.
Its [positive/formula controls](../../scripts/src/medina-analytics-report-lifetime.test.ts#L197) prove weighted booked/assigned totals, lazy load, period change and refresh. [Lifetime assertions](../../scripts/src/medina-analytics-report-lifetime.test.ts#L220) prove period/account/workspace/role A/B/A, late HTTP/body refusal, retained controls, unmount and fresh mount. [Failures](../../scripts/src/medina-analytics-report-lifetime.test.ts#L286) hide old values and allow authorized recovery; unavailable activity is not zero activity.

## Current Contract And Inspected Assertions

The following source/test assertions were inspected, not rerun unless covered above.

- **Booking:** [component](../../artifacts/negis/src/components/crm/lead-team-analytics.tsx#L52) computes booked/current assigned, rounded to one decimal; zero denominator is a dash. Team rate divides summed counts, not averaged staff rates. [095 classification](../../migrations/095_lead_team_analytics_clock.sql#L51) prioritizes structured stage over exact legacy aliases; owner/admin/lead_manager rows include inactive staff. Unassigned/other assignees are outside that denominator. This all-time current portfolio is not period conversion or a completed meeting.
- **Activity:** [083 private STABLE helper](../../migrations/083_lead_team_analytics_snapshot.sql#L20) counts manual lead created/updated audit events, credits recorded actor, and distinct normalized lead UUIDs, including deleted leads. Inclusive rolling period applies to events, not current assignments; saves are not proof of every real-world action.
- **Snapshot/completeness:** [095](../../migrations/095_lead_team_analytics_clock.sql#L30) has one business SELECT including the private helper. Caps: 1,000 staff/stages and 20,000 leads; overflow fails the whole report. Over 30,000 relevant events, journal failure or malformed relevant member activity yields unavailable/null activity while preserving workload. [Native assertions](../../scripts/fixtures/lead-team-analytics-postgres.test.mjs#L315) cover outage, [caps](../../scripts/fixtures/lead-team-analytics-postgres.test.mjs#L430), and [601 same-cardinality changes](../../scripts/fixtures/lead-team-analytics-postgres.test.mjs#L475). The [API](../../lib/crm/lead-team-analytics.ts#L25) checks workspace, sums, IDs, timestamps and exact duration; missing RPC is 503, not table fallback/zero report.
- **Meetings/contracts:** [078 results](../../migrations/078_mortgage_signed_contracts.sql#L112) counts distinct current-assignee leads: held means a done meeting ended by report time; signed means an unvoided manual contract signed by report time; heldSigned additionally requires the done meeting to end before/equal signing. Rates are held/assigned, signed/assigned, heldSigned/held, with [weighted totals/dashes](../../artifacts/negis/src/components/mortgage/MortgageResults.tsx#L219). [Tests](../../scripts/fixtures/mortgage-contracts-postgres.test.mjs#L268) distinguish repeated/future/reversed/old meetings and signing. This is recorded CRM outcome, not payment or independent verification of attendance/signature.
- **Attribution:** [reassignment assertions](../../scripts/fixtures/mortgage-contracts-postgres.test.mjs#L248) move current portfolio but preserve original responsible-at-signing `signedInPeriod`; [correction](../../scripts/fixtures/mortgage-contracts-postgres.test.mjs#L217) retains history and excludes voided contracts. Separately, [070 action metrics](../../migrations/070_mortgage_workspace.sql#L155) count distinct activities per recorded completion/missed actor within the period, not held-client conversion; [tests](../../scripts/fixtures/mortgage-workspace-postgres.test.mjs#L174) cover toggles/actor credit.
- **Exact access:** [route policy](../../lib/crm/authorization.ts#L172), [handlers](../../lib/crm/lead-team-analytics.ts#L77), [outcomes handler](../../lib/crm/mortgage-outcomes.ts#L35), [page guard](../../artifacts/negis/src/pages/MortgageAnalytics.tsx#L22) and [navigation](../../artifacts/negis/src/components/layout/Sidebar.tsx#L55) restrict team reports to owner/admin in mortgage purpose. Active staff/workspace/auth binding is rechecked under [070 share locks](../../migrations/070_mortgage_workspace.sql#L47). lead_manager can read/create own-lead contracts, cannot correct or read team results; generic manager is not lead_manager. Report RPC is service-only; private helper denies even service_role. [Assertions](../../scripts/fixtures/lead-team-analytics-postgres.test.mjs#L345) and [contract assertions](../../scripts/fixtures/mortgage-contracts-postgres.test.mjs#L154) exercise refusals, not only hidden navigation.
- **095 clock:** [native fixture](../../scripts/fixtures/lead-team-analytics-locks-postgres.test.mjs#L159) reproduces 083's stale pre-lock cutoff, then checks owner/admin x 7/30/90 x membership/purpose waits: fresh upper/lower bounds, old event excluded, two new events included. [Revocation](../../scripts/fixtures/lead-team-analytics-locks-postgres.test.mjs#L228) covers inactive/demotion/auth-rebind/purpose in both lock orders and serialization refusal. [Snapshot/grant assertions](../../scripts/fixtures/lead-team-analytics-locks-postgres.test.mjs#L336) preserve business/audit coherence and private ACLs. This verifies the test's intended proof, not today's installed SQL.
- **Refresh/composition:** [current page](../../artifacts/negis/src/pages/MortgageAnalytics.tsx#L33) has three independently loaded/period-controlled reports; its header refresh is workload-only, child refreshes are separate. [Composed tests](../../scripts/src/medina-analytics-composed-scope.test.ts#L158) cover actual React/owned Chromium/HTTP, same-actor token refresh, all-panel role/workspace/account changes, [period ABA](../../scripts/src/medina-analytics-composed-scope.test.ts#L207), late bodies, unmount and sibling-403 revocation. Fake Auth/replies prove frontend lifetime, not SQL authority or a common page snapshot.

## Historical Evidence Only

[G3-C6](../DELIVERY-CYCLES.md) records native 083 31/31; [G7-C22](../DELIVERY-CYCLES.md) records 095 24/24 and separate source-contract 1/1. These were not repeated here; totals are not added to today's suite.
[G7-C11](../DELIVERY-CYCLES.md): `6wg1y3bnf` / `e58a0b5`, selected 078 on site-test, owner/admin/manager A/B positive and foreign/general-report refusals. Temporary timezone was **UTC**; owner mobile passed, fresh admin mobile did not. This does not cover 083/095 or current candidate/schema/configuration.
[Outstanding B -> A form](../DELIVERY-CYCLES.md) never completed the actual account switch; fixtures were removed. Local A/B/A cannot close that historical Preview gap.

## Missing Acceptance And Owner Decisions

- No current isolated-target receipt, deployed 083 -> 095 dependency/body/ACL proof, or matching current API/UI report acceptance was established here. Schema files and old role passes are not installed-schema evidence.
- 095 changes **only team analytics**. [070 workload](../../migrations/070_mortgage_workspace.sql#L69) and [078 results](../../migrations/078_mortgage_signed_contracts.sql#L116) still initialize `statement_timestamp()` before authorization waits; 095's post-lock guarantee cannot be credited to them. Inspected contracts tests do not exercise a waiting results read with newly committed period-edge data.
- Exact 24-hour periods are checked for team analytics. Results use `make_interval(days=>p_days)`; [results parser](../../artifacts/negis/src/components/mortgage/MortgageResults.tsx#L66) checks requested day label and `from < to <= generatedAt`, not exact duration/equal endpoint. Its [test](../../scripts/src/medina-mortgage-results-ui.test.ts#L224) intentionally accepts a microsecond-long interval labelled 30 days. This is a precise missing exact-period guarantee, not proof the current SQL always returns bad periods.
- Timezone completeness is narrower than the page caption: [070](../../migrations/070_mortgage_workspace.sql#L77) requires workspace zone and uses it for meetingsToday; [missing-zone test](../../scripts/fixtures/mortgage-workspace-postgres.test.mjs#L167) proves refusal. Team/results format timestamps in the **device zone** ([team](../../artifacts/negis/src/components/crm/lead-team-analytics.tsx#L105), [results](../../artifacts/negis/src/components/mortgage/MortgageResults.tsx#L110)); 083 does not require schedule timezone. UTC Preview and offset-parser checks do not prove workspace +5/device UTC, local-midnight or DST/session-zone report behavior.
- Main/owner must select candidate/target/dependency rollout and confirm intended timezone/window acceptance for these existing panels. No formula redesign, common-snapshot promise, new metrics, financial inference or feature enablement is proposed.

## Next Single Acceptance Lane

**Main follow-up G7-C29, local base 85c481e:** the later
[clock acceptance](../ANALYTICS-CLOCK-2026-10-26.md) supersedes the selected
070/078 stale-clock and exact-period residuals above. Actual native waits first
reproduced both failures; forward 103 and matching results/team parsers now
pass their scoped receipts. Original formulas, write RPCs, attribution and
access policy are unchanged. The old one-microsecond acceptance test is now
a refusal regression, not current behavior. Device-zone rendering, workspace
metadata consumption, real current Preview and the unfinished B-to-A form are
still open; neither the historical audit nor this local follow-up proves them.

**Main follow-up G7-C30, application base 9a260e2:**
[zone acceptance](../ANALYTICS-TIMEZONE-2026-10-26.md) closes the selected local
device-zone and workspace metadata gaps. 104 returns a locked, validated zone
inside each child report RPC; API/UI require it and format dates explicitly.
The workspace consumer validates 103's exact requested period and microsecond
cutoff. Final native 009-104, device-zone UI matrix and actual React/owned HTTP
A(+5) -> B(UTC) -> A controls pass. The prior component reproduced five failures
under UTC. No formula, common-page snapshot or actual Supabase/Preview acceptance
is inferred; the older findings above remain historical to their named bases.

**Main-gated exact-candidate G3 report parity/clock lane:** once Main proves an available isolated Preview and separately authorizes schema/owned fixtures, verify 029/070 -> 083 -> 095 and 078 -> 103 -> 104 plus matching API/UI; use one owned nonzero portfolio to reconcile current booking, held/signing order, void/re-record and reassignment credit at 7/30/90 with workspace +5/device UTC. Observe authorization and zone-lock waits with period-edge events and revocation. Finish with real B -> A unfinished-form plus report refresh/late-response refusal, owner/admin positive and manager/foreign denials, then owned cleanup equality. Record each unmet exact-period/zone expectation as pending or owner-decided; do not make the whole page green from one report's pass. This cloud lane is proposed, not executed by this card.
