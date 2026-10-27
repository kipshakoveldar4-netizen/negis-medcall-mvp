# G2 Capacity Identity Acceptance

Local cycle G7-C28, base `922e691`, 26 October 2026. This is not release
approval, current Preview acceptance, a cloud migration receipt or a readiness
percentage. Production, Baspana, working salons, WhatsApp, providers and
expenses are outside this cycle. No subagents were restarted after the
confirmed service limit.

## Defect And Contract

The actual calendar already compares two explicit doctor UUIDs before using
labels. API advisory selection still filtered by exact `doctor_name`, and the
073 SQL guard counted both linked UUID matches and all matching labels. This
produced a false refusal for distinct resources sharing an appointment label;
the API could also miss the same resource after its label changed.

Preserved contract: two known IDs identify separate resources; if either ID is
missing, normalized labels remain a conservative legacy fallback. Same-ID
capacity, half-open peak intervals, transaction locking, inactive appointments,
legacy history and keyed creation/recovery are not bypassed. Two *active*
directory entries cannot share the normalized name because the existing unique
index forbids that. Fixtures use different current directory names with shared
historical booking labels, or one archived directory namesake; no index is
removed to manufacture the scenario.

## Scoped Change

- `lib/crm/server.ts`: read the existing workspace/time window without the
  label-only predicate, then compare explicit IDs or normalized legacy labels.
  This remains advisory: its 24-hour lookback and PostgREST row limit are not a
  complete conflict snapshot. The SQL trigger is still authoritative. The
  own-work refusal redaction remains active for ambiguous legacy identities.
- Local forward migration `102_appointment_capacity_explicit_identity.sql`
  replaces only `guard_appointment_capacity()`. Its sole executable body delta
  from 073 restricts the name branch to rows where either side lacks an ID.
  Existing row-before-name lock order, peak calculation and isolation refusal
  are preserved. There is no table/data/backfill/tenant/price/account change.
- Dependency admission checks the reviewed 073 or 102 function body, postgres
  owner, SECURITY DEFINER, volatility/search path, exact enabled trigger event
  and update-column set, and absence of direct browser/service EXECUTE. Unknown
  baselines are refused, not silently repaired. Reapply is accepted only for the
  reviewed new body. Neither 073 nor protected 059/065 was edited.

102 raw SHA-256:
`e0bebcea54224c0c0184a0aa4d2d554596a059c22827755955d36aadcf19beef`.
Normalized 073 guard body SHA-256:
`37ff4acb613a66b1e1341b3c76336acf224b5eee7764ee3ef3c07aaafba955d2`.
Normalized 102 guard body SHA-256:
`73e57a6f89277b4fd543d709be37896c6876252d304be4c200ce0a1d56032a07`.

The 41-reader isolation snapshot remains based on C26/41865a8, with this one
reviewed server delta pinned as normalized SHA-256
`5b01ce6561fb6eac4d32b2d193dabb57d5aaa5d7e64f768ce4603c59039e48fa`.
No broad snapshot regeneration, transport exception or TSX-IPC allowance was
added to the no-network runner.

## Acceptance Lanes

1. Actual API/router spy: four new identity cases first failed with the old
   code, then passed. Spy equality now models PostgreSQL UUID canonicalization
   and explicit doctors are active fixtures. Historical privacy test OW24 now
   expects a free separate resource, with an additional legacy refusal that
   still must redact the linked patient's name.
2. Actual router/server plus a **separate PGlite database** composes
   063/064/072/073/076/102. Two full historical-label rows of B do not block two
   places of A; A's third request refuses with unchanged client/visit/receipt/
   audit counts. Suppressing only the advisory SELECT still reaches the real
   SQL trigger and rolls back the losing RPC. Dropping the observed success
   then retrying the same body/key returns the original item. One explicit
   pending sale for 700050 minor units replays through 076 without a second
   sale/receipt. A later label change does not free A's capacity.
   Auth/transport are synthetic; only 009's unavailable pgcrypto declaration is
   omitted for WASM. SQL DATE fields are serialized like PostgREST, not JS Date
   timestamps. The adapter preserves only the safe capacity-error marker for
   real RPC error mapping. This is not native locking or a browser/React lane.
3. Focused native PG17.11 uses actual 035 grants and 073/076/102 plus their
   stated dependencies. It reproduces the old false refusal before 102, checks
   six unknown-baseline refusals/reapply and runs seven identity cases with
   rollback. Existing real lock-wait, peak, replay, reschedule, cancellation,
   isolation and operator-vs-CRM cases remain. The new race includes a full
   second resource with the same stored label. The focused operator subset
   predates 096; these cases do not attest current operator-actor authorization.
4. Full native **raw 009-102 / 94-file** application chain repeats the old
   refusal and the same migration-admission/identity proofs after all previous
   candidates, including 076/096/100/101. No SQL is stripped or substituted in
   this lane. Every synthetic identity case rolls back; final catalogue, empty
   business-data, RLS/ACL and outward-facility checks remain mandatory.

Final local receipts: focused native 36/36, raw full native 167/167 (one serial
process 203/203, overlapping cases); API/neighbors 279/279; source review 39/39;
isolation runner 608/608. Full build exit 0 includes both API resolution modes,
workspace/scripts types, 143 cold-start assertions and Vite. One earlier build
failed with a Windows libuv closing assertion after bundling; it is not accepted
as a pass. The unchanged full-build retry succeeded.

Detailed final counts and build receipt are in DELIVERY-CYCLES G7-C28. Counts
overlap and must not be summed into unique coverage. All native execution uses
the existing ownership-attested loopback helper; no Docker/DSN/cloud fallback,
install, download, worker or external provider is used. Cleanup must finish
before accepting the native process exit.

## Remaining Gates

Later local [G2-C20](CRM-RECOVERY-CALENDAR-2026-10-27.md) accepts selected
actual React/client/full HTTP/native 009-115 recovery compositions and a
three-distinct-writer capacity-two race. Together with G2-C19 it supersedes
the corresponding missing local composed lane below, not the remaining real
Auth/Preview, general task or complete G2 acceptance gates.

This closes the local explicit-ID parity defect and the missing combined
router/SQL capacity/replay lane, not all G2 or platform readiness. The same
actual React caller -> native router/SQL lane, committed reload/remount and
pending A/B/A still need their own composed acceptance. Generic task replay,
G3 clock/period behavior and fresh full-route mobile pixels remain separate.
The current old Preview does not contain this candidate; effective test-only
bindings/schema/ACL and the selected release manifest are still unverified.
Do not apply 102 or publish this accumulated branch to a shared environment
from this local receipt. See the release matrix and read-only preflight.
