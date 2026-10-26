# Durable Operator Cooperation Command Foundation

Later local follow-up: [G1-C10/G7-C39](OPERATOR-COMMAND-WORKFLOW-2026-10-27.md)
adds coordinated V2 API/UI, explicit closure and local 108. The original scope
and historical acceptance below remain the receipt for 107 alone, not current
cloud behavior or an independent rollout instruction.

G1-C9/G7-C38, base f3a89f4, 26 October 2026. Local SQL foundation, not a
production fix or completed UI workflow. The previous goal turn made verified
progress on booking result validation. This increment advances the original
G1-G8 plan; it does not replace its remaining families or recruitment gates.

## Reproduced Business Risk

The actual 096 proposal RPC has no operation identity. Discard its committed
result, accept/end that collaboration, then repeat the original proposal: it
creates an unintended replacement. This was reproduced on owned PostgreSQL,
not inferred from a source search. Its normal one-live-collaboration constraint
cannot distinguish a new proposal from an old delayed retry after termination.

List reconciliation remains useful for current status, but cannot establish
which command committed. Main selected a durable result as the server-side
foundation instead of labelling a later list read an exactly-once receipt.

## Candidate 107

- One server-private table, five local SQL/plpgsql functions, no new application
  endpoint. The new clinic executor covers propose/withdraw/end; the operator
  executor covers accept/decline/end. A separate reader confirms a known key.
- The original command UUID serializes admission. Its receipt and the actual
  existing 096 mutation commit or roll back together. Same-key execution can
  return only the original result, never create a replacement collaboration.
- Original actor, clinic staff identity, workspace/origin and a SHA-256 digest
  bind the command. Changed terms, target, scope or action conflict; another
  actor/origin cannot borrow the receipt. No proposal text, contact or amount
  is copied into the journal, and no financial row or membership is created.
- Replay/read recheck live authority under the same workspace/operator lock
  ordering as 096, including profile approval/Auth binding and current clinic
  role/status/Auth binding. A receipt does not restore revoked lead access.
- The DTO contains only commandId, requestId, action, statusAtCommit and
  committedAt. These are historical command evidence, NOT the current status
  of cooperation or a grant to act. Current lists still require fresh reading.
- No cascading FK frees a command key when an old collaboration disappears.
  Such a replay refuses instead of creating another proposal; the retained
  receipt acts as a tombstone. No expiry, delete RPC, automatic retry or GC.
- Unknown authorized reads return null, not a rollback receipt. A delayed
  request might still arrive. A future caller MUST retain the unresolved key
  and must not allocate a new key or claim failure just because this read is
  empty. Re-executing the original exact intent/key is distinct from sending
  a new proposal. This foundation does not implement abandon/cancellation.

Migration preflight pins all four 096 implementation bodies, postgres ownership,
SECURITY DEFINER/empty search_path and role requirements. Missing or altered
dependencies refuse before schema creation. The journal has RLS and no direct
browser or service table/column access; only the three entry RPCs are granted
to service_role. Helpers are private even to that role. Inherited browser grants
cause atomic refusal; an incompatible existing table is not repurposed.

Raw 107 SHA-256:
`5c71da01a45aed17d8225e9801047b5e0deb5da3f7c3c59e08b40aae9fd94312`.

## Local Acceptance

Initial focused native acceptance passed 33/33 including parent. The expanded
root command `test:operator-command-recovery-postgres` passed 44/44 including
parent, with explicit MEDINA_TEST_POSTGRES_NATIVE=1 on owned PostgreSQL 17.11.
No DSN, installation, container fallback, Auth service or remote client.

The focused lane covers dependency/security/shape refusal, the actual old
replacement-proposal baseline, every clinic/operator mutation replay, six
same-key real lock waits, concurrent outcome reads, changed-identity/intent
refusal, live revocation waits, stronger-isolation serialization refusal,
atomic rollback on failed receipt insertion, explicit transaction rollback,
deleted-request tombstones, unknown reads, DTO privacy and exact rerun.
Both request and journal rows are compared before/after replay. Owned data and
native servers are cleaned. Counts overlap and are not cumulative coverage.

The current helper subsequently establishes the stronger-isolation snapshot by
reading the actual request relation without authority row locks. Its exact
cumulative acceptance passed 277/277 including parent on raw 009-107, 99 files.
This includes the shared current command helper, cumulative relation/function
bodies, RLS, browser table/column/function refusal, private server boundaries,
future-function defaults, existing application scenarios and all-table empty
cleanup. No SQL was stripped or rewritten to make the chain execute.

Raw-chain review passed 43/43. Fixed no-network isolation passed 931/931 with
the same 41 readers, environment-key set and network/IPC guards. New native
tests are separate explicit-opt-in commands, not additions to that fixed runner.
All required native/isolation handles have terminal success; no matching owned
test process remains. Both user demos stay available. Full application build
was not repeated: application runtime/types/dependencies did not change here,
and its f3a89f4 acceptance remains the prior receipt, not new proof for this SQL.
Protected 059/065 raw hashes still match their saved original values.

## Deliberate Rollout Boundary

107 is additive and keeps 096 EXECUTE rights unchanged. Current API/UI still
use those legacy RPCs and have NOT gained durable recovery from this file's
presence. Applying 107 alone does not fix the user-facing old proposal risk.
Do not publish this foundation independently as a ready cooperation feature.

Next coordinated increment must add the exact command DTO/key/unknown-outcome
contract to handlers and both actual callers, original-session persistence,
same-key recovery after reload, positive and late A/B/A controls, actual local
HTTP/React committed lost-ACK tests, and explicit closure of the unbound legacy
writers once matching callers are verified. No fallback to legacy execution.
Unknown reads must never be treated as proof of rollback or cancellation.

Receipt identifiers/digests remain personal/linkable metadata, not anonymous
data. Admission capacity, retention, approved erasure/tombstone handling and
operator legal/commercial terms require review before cloud use. No purge or
universal exactly-once/cancellation guarantee is inferred from these SQL tests.
Current Preview isolation/target schema/ACL proof and the original G1-G8 and
both recruitment-role workflows remain open.

No API/UI runtime, cloud schema/configuration/deployment, real account, Baspana,
working salon, WhatsApp, provider, ad, paid generation or expense changed.
Protected raw 059/065 are unchanged and excluded from the commit.
