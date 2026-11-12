# Appointment Creation Authority: Local Candidate

Date: 27 October 2026. Base: 2e6150b. Scope: G2-C19 / G7-C53.

No deployment or cloud migration was performed. Production, Baspana, salons,
WhatsApp, advertising, providers, financial settings and real payments were not
accessed or changed. This is not completion of G1-G8 or cloud acceptance.

This records the earlier create/replay candidate and its historical receipts.
The later [actor PATCH candidate](APPOINTMENT-PATCH-AUTHORITY-2026-10-27.md)
adds coordinated 116, closes direct service appointment writes and supersedes
the 93-check metadata gate with 100 checks. The old generated SQL below is
retained as evidence, not the current API's rollout checklist.
The subsequent [open-form version candidate](APPOINTMENT-OPEN-VERSION-2026-10-27.md)
also requires 117 and supersedes that 100-check gate with 108 conditions.
The later C23 section in that document requires 118, closes the legacy service
PATCH entry and supersedes the earlier gates with 112 conditions.
The later C24 section also requires journal transaction 119 and the current
130-condition gate. Historical 112-check cloud observations do not attest 119.

## Reproduced Failure

The actual compiled CRM catch-all, real Auth/workspace resolution code and
service-role SQL ran against an owned, disposable PostgreSQL 17.11 cluster.
Only the Auth identity response and SDK transport were synthetic.

After HTTP authorization, replacing either the staff role with `marketer` or
its `auth_user_id` immediately before the old receipt-reader or writer still
produced HTTP 201 and a persisted appointment. The four denial assertions
failed before the fix. Existing `inactive` checks already refused these cases.
No production incident or customer-data exposure is inferred from this test.

## Candidate

- 115 pins live workspace/staff/Auth identity and the exact role used by HTTP.
  The staff row remains locked through the domain transaction. Unsupported
  stronger transaction snapshots fail closed rather than using stale authority.
- Doctor creation/recovery rechecks the linked card and own-work target under
  the current identity. Explicit conflicting IDs never become a name fallback.
  Existing name-only legacy behavior remains; this is not a migration of it.
- New receipts receive private immutable Auth-origin metadata in the same
  transaction. The current account on a reused staff row cannot adopt the
  previous account's result. Old receipts without origin metadata are not
  backfilled: return a safe conflict for manual reconciliation.
- Only two v2 RPCs are service-callable. Old 063/064 entries and new internal
  helpers are explicitly closed. Both receipt relations have RLS and no direct
  table or column grants, including to the service role.
- All appointment POSTs use v2, including browsers without a request key. For
  those legacy requests a server-generated key preserves single-attempt
  behavior; it does not promise recoverability to that old browser. Missing
  v2/schema support cannot fall back to a separate client/appointment INSERT.
- Appointment POST responses explicitly use `private, no-store`.
- Replay reads one current MVCC appointment row without taking a row lock after
  the doctor lock. This avoids inverting the editor/capacity-trigger lock order.
  The transaction still pins the actor and doctor-card authority.

115 verifies owners, private receipt access, exact reviewed dependency bodies
and the unique staff/doctor identity index before creating anything. It is a
one-time coordinated candidate, not an instruction to rerun earlier migrations.
Its raw SHA-256 is
`3a8f70cd9878ecad79e48acb9f4c847b37ff7589f3e0981398fa95170675cffb`.

## Verification Boundaries

`crm-appointment-native-http` composes actual appointment React actions,
`crmFetch`/session guards, the compiled catch-all and native SQL. Its frontend
is an exact bounded action slice, not the complete calendar. SDK/context and
collection delivery are fictional. It does not prove real Supabase Auth,
cloud credentials, the full visible calendar or physical mobile devices.

The native cases cover real backend lock waits in both authority orders,
same-key concurrent HTTP requests, current account/role replacement, private
origin metadata, legacy non-adoption, old stronger snapshots, doctor-card
reassignment and replay versus an uncommitted appointment editor. Lost HTTP
replies and pending A-B-A callbacks do not create a second row or revive an
obsolete frontend result. Changed catalogues do not replace the stored quote.

Historical query spies now recognize v2 and retain their original query/role/
advisory assertions. They do not simulate atomicity or database authorization.
The WASM SQL suite discards cached plans after rolling back DDL-refusal cases;
native PostgreSQL remains the source for real lock/concurrency acceptance.

The old static receipt checker also needed reconciliation with the 107-115
command protocols. Their explicit relation inventory now requires the exact
raw reviewed chain, closed table/column access and final service entry ACLs.
Unknown source changes, grant injections and unreviewed readers are rejected;
no direct service grants or test skips were added to make it pass. Native
cumulative tests independently verify actual final privileges.

The isolated no-network inventory retains 41 readers and the same 931 tests,
environment key set, network and IPC prohibitions. Only the reviewed CRM
server source fingerprint changed, from `5b01ce65...` to `26bf696b...`.
The diff adds no environment reader, new import or external destination.

Final exact runs passed: composed React/HTTP/native suite 33/33; cumulative raw
009-115 chain, 107 files, 502/502; eight-file regression 495/495; unchanged
no-network test set 931/931. The two native suites share SQL cases; their counts
are not independent unique proofs. Both API compiler modes, all workspace
types, 353 cold-start checks and the root Vite build passed. No new skips.
The existing tooltip sourcemap and mixed static/dynamic serverAuth warnings
remain. Protected 059/065 hashes and all five local demo servers are unchanged.

The final native log is `node_modules/.cache/appointment-v2-final-native-verified.log`;
regression log is `appointment-v2-final-regression-verified.log` in the same
ignored directory. The first build attempt after the new checker found missing
TypeScript declarations and readonly collection types; these were repaired,
and `appointment-v2-root-build-verified.log` records the successful root build.

## Before Any Cloud Acceptance

Later G2-C20 [recovery calendar](CRM-RECOVERY-CALENDAR-2026-10-27.md) fixes a
confirmed-visit day selection defect and extends the actual React/HTTP/native
lane to +5/two services/zero price/revoked recovery and distinct-key group
capacity. It does not change 115, attest cloud bindings or close PATCH/delete.

### Historical Read-Only Metadata Gate (G7-C54)

Follow-up base 0dd8d22. The default `appointment-preview-readiness.mjs` CLI and
exports now generate the post-115 contract, not the historical 063/064 service
grant expectations. The old query and builder have explicit `legacy` names.
The before-115 false-ready result was reproduced on the raw native chain; a
green historical gate cannot authorize the new API. After 115, old entries
must be closed, not reopened to satisfy the old checklist.

The current query emits 93 unique boolean metadata checks. It reads only
`pg_catalog`, never domain rows or domain RPCs. It verifies eight exact routine
bodies and PostgREST argument names, owner/security/search_path/volatility,
non-delegated final EXECUTE, required column types, receipt RLS/shape/ACL/FK,
doctor identity uniqueness and the capacity trigger. Missing objects return
blockers rather than an exception or apparent success. It deliberately does
not inventory actual legacy pending results or prove a deployed target's
identity, current Auth behavior or full application compatibility.

Both current and historical suites passed 38/38, including CLI generation,
exclusive output creation and argument-name drift with unchanged routine body
and restored grants. Shared cases passed on the full raw 009-115 chain:
528/528. The no-network suite 931/931, both API modes, all types, 353 cold-start
checks and root build passed. These native cases overlap the WASM cases.
No reader hash, test key set, network/IPC guard or SQL migration changed here.

The generator wrote only `node_modules/.cache/appointment-v2-current-readiness.sql`,
SHA-256 `eed50ca8f1d22f8b68adf89e010392d795d3e0ac6a04d5329f8df4f07e18448c`.
It was not run against a cloud database. Final logs:
`appointment-v2-readiness-wasm-final.log`, `appointment-readiness-native-verified.log`
and `appointment-readiness-guard-build.log` in that ignored cache directory.

### Required Rollout Evidence

1. Inventory the approved test database's actual schema, owner, RLS, function
   ACLs and legacy pending receipts. The local raw chain is not a cloud plan.
2. Drain old appointment writers and release the v2 API together with 115.
   Applying only the SQL closes old entries; deploying only the API refuses
   creation where v2 is absent. Do not reopen v1 as a fallback.
3. Confirm the exact isolated Preview and test database in the built artifact.
   Repeat real authenticated role/account switching and committed recovery.
4. Reconcile any pending legacy receipts explicitly, without guessing their
   original Auth account or creating duplicate appointments.

PATCH/delete authority, general calendar concurrency, external operator flows,
provider delivery, physical devices, legal/commercial approval and all remaining
G1-G8 gates are not completed by this appointment-create candidate.
