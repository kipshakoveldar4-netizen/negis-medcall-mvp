# Workspace Time Zone Analytics Acceptance

G7-C30, 26 October 2026, application base `9a260e2`; owned native cleanup
follow-up `2a371d3`. The selected local report-zone and workspace-period gaps
from [clock acceptance](ANALYTICS-CLOCK-2026-10-26.md) are closed. No Preview,
remote database, Production, real account, tenant, provider or expense was used.

## Reproduced Defects

The actual previous team component was executed from `9a260e2` with a UTC device
and the new controls: **18 pass, 5 fail**, exit 1. Four failures reproduced
device-zone rendering instead of the report zone, including +5 local midnight,
Chatham's fractional offset and New York's DST transition. The fifth reproduced
acceptance of a missing zone. Current controls additionally cover invalid zones
and sub-millisecond period metadata. This
intentional baseline run is not counted as a passing current regression.

The focused native fixture also observes that both pre-104 child report RPCs
omit the workspace zone. A separate API settings query or another panel's zone
would not make that zone belong to the accepted report read.

## Scoped Changes

- Forward [104](../migrations/104_analytics_report_timezone.sql) requires the
  reviewed 095 team body and 103 results body, known actor helper, owner,
  volatility, search path and closed browser/server execution permissions.
  Only the two read bodies change: after authorization they read and hold the
  workspace schedule row FOR SHARE, validate its zone in PostgreSQL's registry,
  and include `timeZone` in their own report. Missing/invalid zone raises P7008;
  no default UTC/device zone or settings write is introduced.
- The source-body comparison proves the business statements, materialized
  clock, formulas, current cohorts, meeting/signing order, void exclusion and
  original signing attribution are unchanged. Each child report retains its
  existing one-statement business snapshot; the whole page is not one snapshot.
- [Team API](../lib/crm/lead-team-analytics.ts) and
  [results API](../lib/crm/mortgage-outcomes.ts) require a valid report-owned
  zone and return a sanitized 503 for P7008. They retain one scoped RPC and do
  not read settings separately or fall back to direct tables.
- [Team UI](../artifacts/negis/src/components/crm/lead-team-analytics.tsx) and
  [results UI](../artifacts/negis/src/components/mortgage/MortgageResults.tsx)
  format snapshot, range and activity dates with that report's explicit zone.
  Both refuse invalid zones; the team parser now also retains exact
  microsecond period/cutoff validation before formatting.
- The [workspace consumer](../artifacts/negis/src/lib/mortgage-workspace.tsx)
  requires 103's `generatedAt` and `period`, the actual requested 7/30/90 days,
  exact elapsed duration and equal generation/upper-bound instants, including
  PostgreSQL microseconds. Contact search validates its own default 30-day
  response even while the main report requests 90. Calendar range, write
  payloads, request keys, mutation/recovery and authority rules are unchanged.

Raw 104 SHA-256:
`3a8afb0ec9229728f584943755f436e1b3ef8b04bcfe7a7ad36cc5c77c5bc929`.
No old migration, protected 059/065, account, membership, role or client setting
was edited. Synthetic fixtures now supply this exact additive read contract.

## Final Local Evidence

| Gate | Accepted result and scope |
|---|---|
| Source and native-helper review | 48/48: 42 exact-source/effect/refusal tests plus six existing owned-helper safety tests. No body/hash check or ownership restriction waived. |
| Native PG17.11 | 211/211 in the final serial focused + raw 009-104 run: 18 focused and 193 cumulative, with overlapping coverage. All 96 SQL files execute as read, including original protected bytes. |
| Zone and authority cases | UTC, Asia/Almaty, America/New_York and Pacific/Chatham under a different SQL session zone; malformed zones, manager/foreign denials, five preflight refusals and reapply. Owner/admin x team/results wait on a real schedule-row lock, then use the newly committed zone and post-wait clock. |
| UI period and date matrix | 172/172 independently with device TZ=UTC and TZ=America/New_York. Exact periods, offset equivalence, midnight, fractional offsets, both sides of DST, late response, scope and unmount controls. Repeated runs are not additional unique guarantees. |
| Actual API and composed frontend | 661/661, including actual React/owned Chromium/loopback HTTP. An A(+5) -> B(UTC) -> A cycle asserts both report dates and removal of the old zone in the actual DOM. Auth and HTTP data are synthetic, not Supabase session evidence. |
| Overview neighbor | 40/40 presentation checks. The fixture now uses supported 90 days instead of the old artificial 37-day label; it still proves the server-supplied period is rendered rather than a hard-coded 30. |
| Fixed no-network gate | 780/780 after explicitly adding the two pure whole-source workspace/team UI suites to the fixed list; 41-reader snapshot and transport/IPC denials unchanged. This gate is not an OS sandbox or a live worker test. |
| Full build | Both API module-resolution modes, all workspace/scripts types, normal 16+56 and broken-site 16+55 cold-start checks (143 total), Vite: exit 0. |

Native entry point:
`MEDINA_TEST_POSTGRES_NATIVE=1 node --test --test-concurrency=1 scripts/fixtures/analytics-timezone-postgres.test.mjs scripts/fixtures/migration-chain-native.test.mjs`.
No DSN/cloud fallback, installation, stripped SQL, Auth service or real Storage
service is used. [Shared cases](../scripts/fixtures/analytics-timezone-cases.mjs)
run both on the focused dependency set and after the full reviewed chain.

The local visual demonstration remains on loopback port 5260, with four report
tables and explicit GMT+5 timestamps observed. Its screenshot at 987x871 is
synthetic UI evidence, not phone/desktop pixel acceptance or a database-backed
Preview receipt. No real Baspana data is loaded into this demonstration.

## Failed Runs And Cleanup

The first combined native run was **210 pass / 1 cleanup-hook failure**: Windows
returned EBUSY after the owned PostgreSQL shutdown. The helper now gives its
already ownership-checked recursive removal at most five short retries. PID,
directory, marker, loopback and final path guards remain unchanged; permanent
failure still fails the test. The repeated final run passed and removed both
of its newly owned clusters normally.

The stopped first-run cache directory `d9471539-e288-496c-b3db-ea2df8b3a3ba`
remains. Its own log confirms database shutdown; the failed removal had already
removed its marker. A manual cleanup request was denied and was not retried via
another mechanism. Four earlier unowned cache remnants were also untouched.
This is not a claim that every historical cache directory was removed.

The initial build caught a negative fixture assigning malformed zone types to
a string-inferred object; only that fixture's explicit record type was fixed.
The first overview run was 38/40 because its expectations still said 37 after
the fixture changed to the supported 90-day contract; both exact expectations
were updated without changing the runtime. These failed runs are retained and
are not represented as passes.

## Remaining Release And Project Gates

103 and 104 plus matching API/frontend require a coordinated, separately
verified isolated rollout after their dependencies. A new parser with old SQL
or the old API fails closed; it must not be released alone. Prove exact selected
source, test database bindings, target schema/body/ACLs and real owner/admin/
manager switch/refusal behavior before claiming Preview acceptance.

Separate reports still have independent snapshot and refresh lifetimes. The
workspace read remains multi-statement; neither this zone lock nor its metadata
creates a page-wide common snapshot. The unfinished real B-to-A form scenario,
fresh mobile/desktop pixels, G1/G2 scenarios, private media/worker host and legacy
token acceptance, legal/retention/backup and merchant decisions remain in the
[release matrix](TEST-RELEASE-CANDIDATE-2026-10-25.md). No readiness percentage,
legal approval, bank readiness or authorization for Production is inferred.
