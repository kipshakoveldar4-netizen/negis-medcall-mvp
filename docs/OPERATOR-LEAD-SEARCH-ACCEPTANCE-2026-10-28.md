# Operator Lead Search: Local Evidence And Remaining Gates

28 October 2026. Local candidate after `6756053`. No cloud migration, Preview or
Production release, real authentication, external send or spend in this cycle.
Baspana, working salons, WhatsApp, existing accounts, commercial settings and
provider configurations were not accessed or changed.

## Implemented Scope

- `124_operator_lead_search.sql`, raw SHA256
  `0ffb000be6c33ff6cf431bf6ae269ac39499a5b7dc762235ef37adf62b5f287b`:
  one private service-only read function, no business-row or financial backfill.
- `operator-lead-search-contracts.ts`: strict query/path/report contracts,
  complete accepted-company manifest, seven selectors including all/other,
  exact int64 decimal-string counts and replacement 20-row pages.
- `operator-lead-search.ts`, existing catch-all and authorization catalogue:
  verified-actor GET, no-store, explicit input/denial/unavailability responses.
  No identity, workspace, clock, limit or nonempty GET-body override is accepted.
- Actual `OperatorLeadExplorer`, integrated independently from the Today report:
  search, company/group filters, exact counts, paging, row details and original
  booking/stage controls. Desktop uses buttons; small mobile uses a native select
  with the same seven values/counts. The first lead remains in the initial mobile
  viewport, including the fixture-only toolbar.

The reader locks the complete current accepted-request set in UUID order and
the approved operator profile, following the existing authority writers. One
later READ COMMITTED statement snapshot supplies the manifest, eligible leads,
classification, counts, page and active stage choices. A phantom acceptance,
unconfirmed dependency, inconsistent data or oversized manifest refuses the whole
report; it never becomes an incomplete successful list or a successful zero.

Search is literal across authorized lead name, raw phone and company name. Phone
queries use the existing 028/application normalization, including 8/+7/007 forms.
Names/phones shared by different companies remain different company/lead rows.
Current same-company stage semantics outrank contradictory legacy status, even
for an inactive assigned stage. Active target choices are page-company scoped.
Lost/postponed/unknown meanings are preserved, not silently reclassified.

Counts apply search/company filtering across all groups; matched applies the
selected group. Pages are replacement snapshots, not accumulated totals. Current
lead stock is not a count of contacts, appointments, sales or conversions.

Existing stage actions retain original request/lead/actor identity and both CAS
expectations. Pending sends do not unlock merely because filters change. A late
old 403 cannot clear a fresh same-actor page or notify its parent. Booking callbacks
retain the actual receipt's cancelled/no-show/incomplete states, time, specialist,
service and exact price; missing callback data is not manufactured success.

## Evidence

Ignored logs below live in `node_modules/.cache/`. Results overlap and must not
be added together or presented as real Auth, cloud acceptance or a percentage.

| Layer | Scope | Result |
|---|---|---|
| Cumulative native SQL/HTTP | 116 exact raw files 009-124, including the protected current 059/065 bytes and final 124 | 759/759, exit 0, `operator-search-chain124.log` |
| Focused native SQL + actual HTTP | Exact dependency chain, current router/Auth/handler/parser, native service RPC; only Auth/SDK identity boundaries synthetic | 24/24, exit 0, `operator-search-native-http-final.log` |
| Strict parser | Actual production parser, exact counts/order/echo/metadata/privacy and query refusals | 297 checks included in both final standard suites |
| Portal UI | Actual components/hooks/parsers/transports with synthetic reconciled host/SDK/fetch and opaque booking boundary | 1052/1052, exit 0, `operator-search-portal-ui-compact-recheck.log` |
| Operator regression | Complete standard operator command, including new Explorer/parent lifetime cases and mobile retained callbacks | 1447/1447, exit 0, `operator-search-operators-compact-recheck.log` |
| Shared Auth/API regression | Actual route classification and authentication foundations, no real login | 35/35 + 30/30, `operator-search-api-auth-verified.log`, `operator-search-auth-foundation-verified.log` |
| Review/checkout/model/bundle | Raw SQL/Git-byte review plus isolated in-memory fixture/server/bundle checks | 82/82, exit 0, `operator-search-review-compact-recheck.log` |
| Full standard build | Libraries, API in both module modes, seven artifact/scripts typechecks, compiled CRM cold start and Vite | Exit 0, `operator-search-build-compact-recheck.log`; cold-start 353 checks |
| Actual local browser | Owned disposable Edge, actual portals, synthetic Auth/API, external requests blocked, 375x900 / 1440x1000 at scale 1 | 31/31, exit 0, `operator-search-browser-compact-recheck.log` |
| Reference-state browser | Same final UI, additional operator in-progress and partner October captures, all previous assertions retained | 31/31, exit 0, `operator-search-browser-reference-state.log` |

Final production UI/CSS edits were written by 15:52:35 UTC. The final standard
UI/operator suites started after 15:54:45, full build at 15:56:24 and browser at
15:59:53 UTC. The later 16:03:08 browser run only adds matching-state captures;
it includes no later application-source change. Existing nonfatal Vite sourcemap
warnings remain visible in build logs, not concealed as a warning-free build.

Final raw hashes:

| Source | SHA256 |
|---|---|
| Search handler | `687a1f50db8e32fa9c2f3c55b53c8761ea4852e296085d203fcb8952db9c20a9` |
| Search contract | `c71e37ba1628f55191589ce3da4ad8bdc9192e78398f7fcf2a3b03ed8b4b6b64` |
| Explorer TSX | `07067ac5ed1930e7c7e4a613e3cf77f162841834eda637b34635bc12561997e6` |
| Explorer CSS | `4e0cc245bd84d665e1e488fcd58405964e20b75328d57338cacf1c28935e4dd5` |
| Workday parent | `d16b9382236e3c3146646821d3e3f44b6170c2d37f21264ae531a094c06dcc65` |

Additional raw hashes/timestamps, screenshots, combined comparisons and browser
report: `output/design-qa/contributors-2026-10-28/lead-search/`. The latest owned
temporary render was `medina-portal-design-render-wTIJHW`. See `design-qa.md` for
normalization, intentional product differences and the remaining overall blocker.

## What The Evidence Actually Covers

Native cases use 25 accepted cooperations behind 25 newer declines, 104 authorized
leads, independent operators/companies, assigned and clinic scopes, exact global
counts, 20-row pages, stable microsecond ordering and null dates. Cases cover
literal percent/underscore, Russian/Kazakh case, equivalent phones, identical
contacts in different companies, inactive semantic stages, active choices,
existing stage CAS and stale replay with one audit. Real independent database
sessions cover suspension, assignment withdrawal and acceptance phantoms.
Ending and reaccepting the same company cannot inherit an old assignment.

Oversized companies/stages, malformed/foreign-stage references, nonfinite dates,
isolation/lock failures, dependency drift and effective browser ACL refuse safely.
Reapplication writes no business rows. All owned public business rows are asserted
empty before shutdown; financial snapshots remain unchanged. PostgreSQL, minimal
local roles and Storage catalogue are disposable, not an environment DSN or cloud.
Existing lifecycle/RLS protections were not disabled to make fixtures pass.

Actual loopback HTTP covers the new read route, input/method/header/privacy
refusals, native snapshot/lock failures and revocation after synthetic Auth but
before RPC. It is not a real Supabase authentication acceptance. Stage CAS is
tested through native SQL and actual UI/transports with synthetic fetch, not a
new browser-to-native stage-write round trip in this cycle.

Browser cases cover three portals' ready/empty/error states, real navigation,
reload/retry, company/group/search/page changes, normalized phones, original-row
booking-form reads, opening/closing cards, ended cooperation, denial and sign-out.
Search/lead/booking/service interactions in this browser fixture are read-only;
it does not pretend to save a booking or stage through a real backend. Its final
report has 49 layout checks and 53 screenshots, no uncaught exceptions, console
errors, blocked external attempts or real `/api/` network requests. Synthetic
transport intercepts those requests in memory; static assets are loopback only.

## Failures Retained

- Initial native fixture collided with the workspace's seeded stage key. Fixed
  fixture-owned keys, not uniqueness rules: `operator-search-native-initial.log`,
  3/4 including parent failure.
- Next HTTP fixture incorrectly expected no active stages although five are
  seeded by the real workspace path. Expected values now come from that exact
  company's catalogue. Explicit GET-byte refusal was also added to production:
  `operator-search-native-http-recheck.log`, 17/24. Final focused 24/24 supersedes it.
- Three real counterexamples proved late old stage-denial responses could erase
  a fresh query/page/refresh. Tightened denial to the original request lifetime:
  `operator-search-stage-denial-counterexample.log`, 0/3 before the fix.
- First browser run found the parent guard false during the initial child render,
  before layout setup. A separate unmounted guard and a first-render regression
  fix it. The earlier mixed-HMR run (`operator-search-browser-final.log`, 27/31)
  is not final acceptance.
- Next frozen run (`operator-search-browser-frozen.log`, 28/31) exposed test
  orchestration errors: typing into a form already removed by denial and observing
  the old document immediately after reload. Revalidate via focus and require a
  new-document marker; contact-clearing assertions remain. A fresh run passed
  31/31 before the later mobile refinement.
- Visual comparison found tall wrapping mobile group buttons that pushed the
  first lead below the initial viewport. A native group selector fixes it without
  changing desktop controls or authority. New UI assertions cover all choices,
  forged/no-op values and retained callbacks. Its first test compared cross-VM
  Array prototypes (`operator-search-portal-ui-compact.log`, 1051/1052); normalizing
  only the test-host array fixes that fixture error. Final UI/browser tests pass.

## Remaining Gates

- At this receipt's original checkpoint, stage/booking submission/recovery from
  the Explorer still lacked connected browser-to-native proof. The later local
  cycle supplies 15/15 actual connected cases and closes that selected R7/H/B
  workflow: [current actions evidence](LOCAL-READINESS-ACTIONS-2026-10-28.md).
  It does not relabel these earlier split-layer passes or close real Auth/cloud
  gates; broader unexercised matrix corners remain explicit in the new criteria.
- No 124, API/UI candidate or environment change has been applied to any cloud
  target. A separately scoped release/dependency/recovery plan, isolated Preview
  Auth and actual database-backed browser receipt remain before rollout.
- Initial-contact success/next-contact tracking has no authoritative event
  definition. Created time is explicitly UTC, not a fabricated next-contact date.
- Verified partner URL/public company intake/review, approved canonical consent,
  sandbox payment and commercial activation remain separate unfinished work.
  The existing G1-G8 plan is not replaced by this search slice or declared 100%.

Six disjoint agents handled Explorer UI, parser tests, lifetime tests, native HTTP
fixture/parent regression, rollout criteria and browser fixture work. Main kept
architecture, SQL, integration, defect fixes and final decisions. All needed test
processes finished normally. Only the owned synthetic preview on port 5290 remains
available for inspection; no real-user browser profile was used by the tests.

Protected pre-existing raw bytes unchanged: 059
`c56c820f9b29b28f96de34b51cb63af44f29be207b7c76740c491c9811aaae47`, 065
`ccc908b1a91126540b78dedcbfb75ae86e191d057fbeeeb4742241e8a0c61984`.
No push, release, external send, purchase or working-space cleanup is implied.
