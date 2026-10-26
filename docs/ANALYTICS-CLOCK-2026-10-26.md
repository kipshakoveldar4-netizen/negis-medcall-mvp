# G3 Report Clock Acceptance

Cycle G7-C29, 26 October 2026, local base `85c481e`. No cloud deployment or
schema application, real tenant/account access, providers, advertising or
expenses. This is not readiness percentage, financial/legal acceptance or
current Preview proof. Subagents were not restarted after the service limit.

## Confirmed Defects

- The original 070 workspace report and 078 results report captured
  `statement_timestamp()` before membership/purpose authorization waits. On
  actual owned PostgreSQL, newly committed leads were visible, but the period
  counted one expired-edge event and omitted two fresh events/contracts.
- 078 used calendar-day subtraction. Across DST this differs from the existing
  095 contract of `days * interval '24 hours'`. The results UI accepted even a
  one-microsecond interval labelled 30 days and an upper bound preceding its
  generation time. The changed test first failed on that actual acceptance.
- The team API validated after ISO millisecond normalization, accepting a
  one-microsecond duration/cutoff mismatch. Three actual-router tests reproduced
  HTTP 200 for these malformed aggregates before the fix.

## Scoped Local Changes

Forward [103](../migrations/103_mortgage_report_clock.sql) replaces only two
existing read functions; it does not alter tables, data, write RPCs, formulas,
membership or tenant configuration. It refuses unknown function/authorization
bodies, owner/search-path/volatility/SECURITY DEFINER changes and unexpected
browser/server execution access instead of repairing an unknown baseline.

- Workspace time is captured after membership, purpose, schedule-zone and
  lead-manager own-lead lock waits. The existing zone row is held FOR SHARE.
  The response adds `generatedAt` and `period` metadata; activity counts use
  exact elapsed 7/30/90-day windows. Existing display/query date-range defaults
  and business calculations are retained. This multi-statement workspace read
  is **not** promoted to a common MVCC snapshot by the new clock.
- Results use one materialized clock inside their existing business-data SQL
  statement, after authorization. All current-portfolio/time comparisons and
  historical signing credit use it; period subtraction is exact elapsed time.
  Completed-meeting/signing order, current-assignee cohorts, voided-contract
  exclusion and original responsible-at-signing attribution remain unchanged.
- [Results parser](../artifacts/negis/src/components/mortgage/MortgageResults.tsx)
  validates exact duration and generation/upper-bound equality, including
  PostgreSQL microseconds and equivalent explicit offsets.
- [Team API](../lib/crm/lead-team-analytics.ts) checks sub-millisecond remainder
  equality before its existing ISO normalization. Valid matching nonzero
  fractions still pass; the established millisecond response format is retained.

Raw 103 SHA-256:
`e77b5457680a491e421748a79d3ac74b5e39116db204f78ac6e98aa4585d0a11`.
Normalized body hashes are admitted explicitly in its preflight. Original
070/078 and protected 059/065 are not modified. The source contract proves
that only the stated timing, zone lock and additive metadata differ from the
original business bodies; no status, money or conversion-rule replacement.

## Final Evidence

- [Focused native fixture](../scripts/fixtures/mortgage-report-clock-postgres.test.mjs):
  **37/37** on owned PG17.11. Reproduces both old failures before 103; verifies
  six unknown-baseline/access refusals plus reapply; owner/admin x 7/30/90 x
  membership/purpose waits; workspace schedule/own-lead waits; inactive, role,
  Auth rebinding and purpose revocations during actual lock waits. The expired
  lower-edge event is excluded and two fresh ones included; a contract preceding
  its meeting still does not count as a post-meeting conversion.
- Shared [native cases](../scripts/fixtures/mortgage-report-clock-cases.mjs)
  run after the complete raw **009-103 / 95-file** chain as well: **180/180**.
  Exact periods are checked under UTC, Asia/Almaty, Europe/Berlin and
  America/New_York SQL session zones. A fixed March 2026 DST expression proves
  the old/new calendar-versus-elapsed difference independently of current date.
  Each shared case rolls back rows/role/zone changes; full-chain final empty
  business data, source hashes, RLS/ACL and outward-facility checks remain green.
  Serial process total **217/217** includes overlapping cases, not unique coverage.
- Actual API/normalizer, results parser/lifetimes and composed actual
  React/owned Chromium/HTTP report scope: **421/421**. This includes the
  previously accepted A/B/A, late-body, role/workspace change, unmount and
  sibling-denial controls; fake Auth/responses are not SQL authorization or
  a real Supabase account-switch proof. The results parser suite alone is 41/41.
- Source review **41/41**, including unchanged business-body contracts.
  Fixed-list no-network runner **649/649**, now including results UI cases;
  transport/IPC guard and the 41-reader snapshot are not weakened/regenerated.
- Full build exit 0: both API module-resolution modes, workspace/scripts types,
  143 cold-start checks (16+56 normal, 16+55 broken-site), and Vite.

Initial fixture failures are not passes: an anonymous-parameter replacement
was rejected by PostgreSQL before reaching the intended preflight; the fixture
now mutates volatility and the correctly named authorization helper. Another
assertion incorrectly counted a contract predating its meeting as converted;
the expectation was corrected to the original 078 business rule, not SQL
changed to fit it. No real document was signed, paid, sent or uploaded.

## Unclosed Boundaries

This closes the selected **local** stale-clock/exact-period defects. Device-zone
timestamp rendering is still separate from workspace-zone calendar semantics:
the results/team panels still format in the device zone. The workspace consumer
does not yet validate/use the new exact-period metadata. No single snapshot or
single refresh across all three panels is promised. +5/local-midnight/browser
rendering, current Preview schema/bindings/Auth/roles and the unfinished real
B-to-A form cycle still need their own acceptance. Later G1/G2/worker/storage,
legal, retention, banking and operational gates in the release matrix remain.

The user-facing local visual fixture on loopback port 5260 remains a synthetic
demonstration; it does not apply 103 or certify a database-backed report.
No new Preview or Production release is authorized by this receipt.
