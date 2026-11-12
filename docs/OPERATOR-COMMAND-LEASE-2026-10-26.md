# Pending Operator Commands And Cumulative Intake Acceptance

26 October 2026, local-only cycle, base 3007a23. Previous goal turn made
concrete progress: contributor intake/review was implemented and verified locally.
This cycle advances G1 command safety and the G7 schema-composition gate; it
does not replace the G1-G8 objective with intake alone.

## Reproduced Operator Defect

OperatorRequests depended on React's disabled render, not a synchronous pending
command owner. Repeated retained handlers dispatched a second PATCH. Refreshing
the list also reset busy while the first HTTP response was unresolved, permitting
another action. Baseline: 14 pass / 8 fail in the expanded actual-component /
transport hook suite; all eight failures were new repeat/refresh cases.

The component now owns a command before confirmation/render and retains it
across data refresh/page changes. A new actor/path retires the old owner. Only
the owning settled attempt can release busy in its still-live scope; an old
completion cannot release a replacement actor's command. Canceled confirmation
remains a no-op. Access refusals still invalidate live scopes even after refresh;
request-specific refusals still close only that request's panes.

Two older synthetic controls assumed refresh could admit a second pending PATCH.
They now assert the stronger single-command contract while retaining the original
401/403 fresh-view invalidation checks. A canceled queued lookup may perform
exactly one busy=false write to release its same-scope lease, not publish old data.

## Current Acceptance

- Actual component + operatorApi/crmFetch/serverAuth hook tests: 22/22. Adjacent
  actor/mutation/composed controls: 323/323 including that 22, not additive.
- Actual React + owned Chromium + real transport: 25/25 including parent, nine
  new pending-command cases. Acceptance/decline/end/withdraw, fresh-list busy,
  late 200/503, account/workspace/ABA, immediate 401/403, exact-request 404/409
  and retained unknown booking receipt controls pass. Fake SDK/HTTP/descendants,
  no external connectivity or actual SQL; no CSS/pixel/device coverage claimed.
- Full root build passes types in both API modes, 169 compiled normal/broken-site
  cold-start checks, Vite. Fixed no-network runner remains 931/931, unchanged
  reader/network/IPC boundaries. New operator tests are not added to that fixed
  profile or counted as cloud evidence.

## Full Raw Schema Chain

105 was inspected and added to the raw-byte preflight without rewriting SQL.
SHA-256: f392419d625826ece3d002737b8ebc5ebd82b769b9b2b615a62fbfd07bfdfa5c.
Fresh owned native PostgreSQL 17.11: 203/203 including parent, exact 009-105,
97 files. No invented Auth service or application-table baseline. Synthetic
Storage catalogue tables do not prove actual Supabase Storage behavior.

Added composition controls prove that 105 works after 099's global function
default restrictions, preserves independent review/replay/second-role behavior,
keeps browser table/column/RPC access closed, retains only service SELECT/RPC
access, and preserves a committed reviewed synthetic profile on exact rerun.
Even an accidental browser SELECT grant does not expose rows under RLS.
Approvals create no clinic membership, partner activation, commission or expense.
All fixtures are rolled back or the one specifically owned committed row removed.
The final all-table empty-data, exact-function, effective ACL/RLS, source-byte and
no-external-facility gates pass. Owned database/server cleanup completed.

Four previously missing G1 native positives now pass on this entire chain:
operator accept/decline after original author's deactivation or Auth rebind.
Original author, brief, scope, currency and technical 0-KZT terms stay unchanged;
the departed actor is still denied. No actual rate/payment is established.

Protected dirty 059/065 raw hashes remain exactly as previously recorded.
This is worktree compatibility evidence, not a clean Git/cloud release manifest.

## Remaining Gates

This in-memory UI lease is NOT a durable operation receipt, automatic retry
protocol, or exactly-once guarantee after unmount/reload/unknown commit. The
existing list-reconciliation versus durable proposal/transition recovery decision
remains open; a network error is not proof of rollback. Native SQL still decides
authorization and legal transitions. Current Preview isolation/configuration,
matching 094/096 and 105 cloud application, real session-switch matrix, legal
terms, recruitment commercial activation and all unrelated G1-G8 gates remain.
No deployment, real account/database, Baspana, salon, WhatsApp, provider, ad,
paid generation or expense changed.

Later G1-C9/G7-C38 [command-receipt foundation](OPERATOR-COMMAND-RECEIPTS-2026-10-26.md)
reproduces an actual old proposal replay creating an unintended replacement
after cooperation ends, and adds local 107 keyed atomic result/replay/read
primitives. It does not silently make this existing UI lease durable: matching
API/callers, persisted unresolved commands, committed HTTP/session tests and
closure of the old unbound executors remain a coordinated next increment.

## Later Arrival And Portal Lifetime Cycle

G1-C7 [arrival command ownership](OPERATOR-ARRIVAL-COMMANDS-2026-10-26.md)
extends live ownership to confirmation/control-call rows without serializing
independent patients, and forwards the actual portal profile/session epoch to
descendants. It does not supersede the durable unknown-outcome/reload gate above.
