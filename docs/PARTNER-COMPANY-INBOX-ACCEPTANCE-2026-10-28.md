# Own Company Applications: Local Acceptance

Date: 2026-10-28. Base: `01c2eb3`. Local only; no cloud deployment or migration,
real Auth/account creation, working workspace, provider, payment or spend.
The full G1-G8 goal and G6 definition remain unchanged and incomplete.

## Implemented

- `/partner-company` defaults to an authenticated applicant inbox. Explicit
  `?new=1` mounts the existing submission/recovery form; the entry CTA selects
  that mode. Actor and mode changes retire previous children and callbacks.
- GET `partner-company?view=list` uses the verified immutable Auth subject only.
  It requires no attribution cookie, tab metadata, current email confirmation,
  intake flag or approved notice. Those requirements still guard new submissions.
- Local 126 adds one private service RPC, no tables or business writes. Original
  applicant identity and current active owner authority for approved companies
  filter eligibility before offset/21-row lookahead. Every candidate is locked
  and rechecked; changed rows fail the whole page, including row 21.
- The inbox stores nothing in the browser and never infers a command outcome,
  clears recovery keys, creates a source/company, or renews the payment window.
  Empty means no currently visible saved applications, not proof of rollback.
- List/detail, status selection, refresh, paging and failure/denial states reuse
  the existing Inter/mint shell. The shared transport refuses foreign API origins,
  credentials/fragment/query injection, redirects and stale actor completions.
- Removed generic dashboard shortcuts from approved inbox and receipt details:
  they could retain a previously selected different company. Generic team entry
  remains in navigation; a verified target-workspace handoff remains separate.

## Evidence

| Layer | Accepted result | Scope |
| --- | --- | --- |
| Focused current modules/HTTP | 147/147 | 45 actual inbox/parser/client cases, 77 actual parent/client cases, 25 compiled HTTP cases. Includes 59 preserved parent/client cases plus 18 new cases. Synthetic hook scheduling/Auth/HTTP where identified. |
| Existing/new HTTP | 51/51 | Previous 26 plus new 25; real compiled catch-all, synthetic Auth/RPCs. This overlaps the focused set. |
| Inbox browser | 15/15 | Actual inbox and PortalShell at 375/1440; data/identity transport doubles. 29 captures, actor/filter/page ABA, blur/focus, empty/error/denial, no storage/mutation/external requests or runtime exceptions. |
| Existing submission browser | 22/22 | Fresh run after removing the misleading workspace shortcut; original metadata, reload, exact replay/close and status behavior retained. |
| Native SQL/HTTP | 23/23 | Fresh owned PostgreSQL 17.11 through exact 009-126, current apply/reapply, six rerun refusals, real source/workspace/staff row waits, P1262 whole-page failure, eligibility before paging, immutable dates/finance, actual compiled GET and exact cleanup. Synthetic Auth only. |
| Full native chain compatibility | 761/761 | Existing behavior through all 118 exact 009-126 sources; final body identities, private helpers, closed browser/server privileges and RLS, no external facilities or business residue. Separate targeted matrix is not rerun or substituted. |
| Raw SQL review/checkout | 70/70 | Exact 118-file chain; new 126 LF rule without changing older hashes or protected sources. |
| Standard root build | exit 0 | Seven workspace typechecks, both API module modes, 437 compiled cold-start checks, normal Vite/PWA build. |

Full cumulative compatibility exited normally with code 0. Separate target
tests do not substitute for that broader result. Counts overlap and are not
summed into a project-readiness percentage.

Logs: `node_modules/.cache/partner-inbox-focused-main.log`,
`partner-inbox-build-main.log`, `partner-inbox-cumulative-main.log`, and
`partner-company-inbox-native.log`. The native log distinguishes an initial
old-digest retained session from the accepted fresh normal `node --test` run;
both retained sessions were closed, not silently reused as fresh acceptance.

Accepted 126 raw digest:
`54aa252bf9252aeac1cd489230f485924deba6a64d5264260c96b23f76e2b6b5`.
Inbox source digest:
`3d8710dc914b559731278c64512f6650aa0c8b97136590aed417bd17098f0b33`.
Existing 059/065 and historical 121/125 were not changed.

Main inspected current mobile/desktop captures. Representative images/reports:
`output/design-qa/partner-company-inbox-2026-10-28/`; complete synthetic browser
receipt: `node_modules/.cache/partner-company-inbox-browser/run-YSSWSY/`.
These extension captures are not a same-state comparison proving all approved
mock parity. The previous receipt's tab-only discovery limit is closed locally,
not retroactively represented as having been accepted in that earlier commit.

## Remaining Gates

Verified handoff to the selected company's CRM, complete real applicant
entry/signup/confirmation policy, approved canonical notices, abuse quotas,
retention/deletion and isolated cloud Auth/schema/deployment acceptance remain.
Canonical consent registry stays empty and new-company intake stays off by
default. No commercial activation or payment/refund/payout provenance is proved.
All other unaccepted G1-G8 items and full design parity remain open. See
[criteria](PARTNER-COMPANY-INBOX-CRITERIA-2026-10-28.md) and
[delivery plan](DELIVERY-CYCLES.md).
