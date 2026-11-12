# Operator Cooperation Command Workflow

G1-C10/G7-C39, base 093eba7, 27 October 2026. Local API/UI/SQL integration,
not a deployment or permission to test working customers. This follows the
[107 foundation](OPERATOR-COMMAND-RECEIPTS-2026-10-26.md); both blogger intake
roles remain covered by the separate contributor milestone, not this change.

## Coordinated Contract

- Existing clinic proposal and clinic/operator transition endpoints require an
  original command UUID. Verified actor, staff and workspace remain server-owned.
  Extra identity, approval, monetary/status fields are rejected, not forwarded.
- API and both actual forms use only four V2 entry RPCs. Local migration 108
  revokes service/browser/public execution on the old unbound 096 and V1 107
  writers/readers. There is no fallback to them when the new schema is absent.
- The result parser accepts only an exact original command/action/target with
  complete, consistent committed or abandoned metadata. Invalid or partial 200,
  transport failure, 401/403 and an unconfirmed read retain the original key.
- Before dispatch, the form stores only actor/workspace/channel/command/action/
  target identifiers in this tab's sessionStorage. No proposal text, amount,
  patient contact, password or token is stored. Unavailable/corrupt storage
  blocks new admission rather than silently forgetting an uncertain operation.
- Recovery reads the original result without repeating the business POST/PATCH.
  Explicit closure uses the same SQL advisory key lock as execution: if commit
  won, it returns that immutable result; if closure won, a late original cannot
  mutate cooperation. Closure does not undo a committed action. An unconfirmed
  read alone is not evidence of rollback, cancellation or safe new admission.
- A private fence table holds closure identifiers only. Historical result reads
  still require current actor authority, even after the business row disappears.
  Result metadata grants no renewed access to requests, leads or contacts.
- Form drafts remain editable while a result is uncertain. A confirmed proposal
  clears only the unchanged draft from the same in-memory submission; it cannot
  erase a newer edit. Reload restores the opaque key, not the private draft.
- Parent session/view guards compose with command ownership. Late old-account,
  old-view and returned-A responses cannot consume another command, release a
  replacement command or publish stale success/denial. Recovery itself is keyed
  to the exact command and has its own independent pending lifetime.

108 raw SHA-256:
`292fd8647bac6411c2131427c4c834f9c6d25441db1b9a5f969ce24b2487fae7`.
It pins exact 107 function bodies/owners/search_path/return/security attributes,
refuses incompatible fence shape or inherited executor/table grants, enables
RLS and grants only the four V2 entry functions to service_role. Neither browser
nor service_role gets direct fence table/column access. No cascade/expiry/GC,
new Auth user, staff role, membership, rate or financial record is introduced.

## Local Acceptance

- Focused 108 native SQL: 32/32 including parent on owned PostgreSQL 17.11.
  All six clinic/operator action origins, both real lock-winner orders, delayed
  admission after an unknown read, deleted-row historical result, current-role
  revocation during waits, foreign intent/identity refusal, legacy executor
  denial and exact rerun/cleanup are covered. Raw source review: 44/44.
- Expanded API/contract/parent/transport/UI regression: 953/953 in 17 files.
  This includes the actual nested-hook lane (319), actual React/Chromium denial
  lane (25), real AdminCenter forwarding (82), parser/storage controls and
  positive original-actor transport. Counts overlap, not additive coverage.
- Actual forms + owned HTTP + current handler + service-role SQL: 19/19
  including parent, after applying exact raw 009-108, 100 files to a fresh
  owned native database. The 18 scenarios cover six action/origin combinations
  at 375/1440 after committed lost ACK, early closure, late ACK after commit,
  partial 200 and A-to-B-to-A. Exactly one business request is sent; both lock
  winners are established before recovery, not guessed from scheduling.
- Initial native HTTP failures exposed a snapshot before the independent
  refreshed list settled and a test that had not established commit-first.
  Scheduling was corrected with explicit loaded/held/SQL-state assertions,
  not by removing the old-response or no-duplicate assertions. Old fixture
  response/grant expectations were updated to the real V2 contract; denied
  legacy executors were not re-granted to make tests pass.
- Four component-fixture PNGs in
  `node_modules/.cache/operator-cooperation-http-V7OUSl/`: 375/1440 clinic
  proposal and operator acceptance. Current built application CSS/local Inter,
  measured no document overflow and visible controls fitting their containers;
  mobile acceptance and desktop acceptance were visually inspected. This is
  not a complete application-shell or physical-device visual receipt.
- The HTTP lane uses synthetic Auth/SDK, a strict Node adapter for current
  handlers, real React/transport/native SQL and owned loopback HTTP only. It
  does not emulate Supabase service behavior, Vercel or real account login.
  All owned rows/fileservers/browsers/native database are removed by cleanup.
- Fixed no-network isolation: 931/931, same 41 readers, key set and network/IPC
  guards. New suites remain separate explicit commands. Full root build passes
  both API module modes, all workspace types, Vite and 169 compiled catch-all
  normal/broken-renderer auth/denial checks. Existing build warnings remain.

The separate final cumulative native lane passed 306/306 including parent on
exact raw 009-108 / 100 files: current function bodies, RLS/table/column/function
privileges, future defaults, representative V2 workflow after author departure,
existing application scenarios and all-table empty cleanup. Initial failures
were old cumulative service calls to now-revoked 096 RPCs, not a reason to
restore those grants. Those scenarios now assert the full keyed V2 result and
preserve their original business/authority checks. No raw SQL was rewritten.
All required handles reached terminal success. No matching owned test process
or newly created native run directory remains. Five older run directories dated
25-26 October predate this cycle and were left unchanged, not recursively erased
as part of current cleanup. Both user demos remain.

## Remaining Rollout Gates

1. Select exact coordinated API/UI + 107/108 candidate; attest new Preview
   effective build/runtime test database and schema/ACL. Old cloud acceptance
   and inherited shared Production settings do not establish this boundary.
2. Stop/drain already-admitted legacy writers before closing their execution
   rights in a cloud target. Revocation cannot cancel a function already running.
   Do not independently publish the V2 UI against an unprepared database.
3. Review admission bounds, linkable identifier/digest retention and approved
   erasure/tombstone handling. Journals are not anonymous, and deleting them
   can reopen old-key admission. No purge or universal exactly-once claim.
4. Complete current Preview role/session matrix and remaining G1-G8 families.
   Blogger application approval is not paid partner activation, referrals,
   payout accounting, creator jobs, briefs, deliverables or content rights.

No cloud inspection/SQL/config/deployment, real account, working CRM, Baspana,
salon, WhatsApp, real message, provider, paid generation, ad or expense changed.
Protected 059/065 retain their saved raw hashes and are excluded from staging.
User demos on loopback 5260 and 5264 remain separate and are not test cleanup.
