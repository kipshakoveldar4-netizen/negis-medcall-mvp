# Appointment Open-Form Version

27 October 2026. Base `b3c46f3`, G2-C22 / G7-C57. This continues G1-G8,
not a new platform or completion of all acceptance gates. No cloud database,
deployment, real Auth account, customer workspace or external provider is used.

## Reproduction

116 compares the server-read preimage under a row lock, protecting a change
which happens during the HTTP request. It cannot know what the user saw when
opening a form earlier. Two actual React/client/full HTTP/native SQL cases
reproduced the gap: B saved first, then A's older full form returned 200 and
overwrote B's note. Updating A's item collection before submitting did not
make the original form safe. The first diagnostic had 29 passing and two
failing children plus their failed parent, not a production incident.

Diagnostic: `node_modules/.cache/appointment-open-version-red.log`.

## Candidate

117 adds a non-null opaque UUID `edit_version`. A constant zero UUID fast
default supplies old rows without an UPDATE/backfill; a subsequent default
change gives every future insert an independent PostgreSQL UUID. A private
SECURITY INVOKER BEFORE UPDATE trigger always rotates the token, even for a
no-op, an attempted explicit token reset or a writer reusing updated_at.
It has an empty search_path and no browser or service EXECUTE grant. Existing
actor/capacity routines, RLS and closed direct service writes remain unchanged.

The migration locks the table with bounded lock/statement timeouts and refuses
unknown existing token/trigger objects, unreviewed BEFORE UPDATE triggers,
changed 116 authority or reopened service writes. It is a one-time coordinated
candidate, not an idempotent repair or instruction to replay the whole chain.
The native old-row proof compares every previous field, ctid, xmin and relation
file before/after the actual raw migration. No old tuple or business value
changes in that owned fixture. The lock/target impact on a real database still
requires inventory and cutover approval.

API DTOs carry `editVersion` from the stored row. The form freezes it on the
actual openEdit path, including through background collection refreshes.
Status actions use their displayed row's version. Neither the POST body nor
the editable column mapping can select a stored version. Appointment PATCH
requires `expectedEditVersion` at the top-level request, not in mutable fields:

- Missing precondition: 428; malformed precondition: 400.
- Missing schema/version metadata: 503, without a writer fallback.
- The frozen opening version replaces only edit_version in the typed server
  preimage passed to 116. Live original-actor and own-work checks execute first
  inside its transaction; the whole-row CAS then refuses a stale version with
  409 before mutation or secondary audit. Later changes are covered by that CAS.
- A successful RPC must return the correct row/workspace and a different
  valid stored token. An unconfirmed response is not claimed as a rollback.

The token is not rejected early in HTTP: such a conflict could mask live
revocation and leave a private form visible. Mixed owner/doctor cases revoke
staff and change the note after HTTP authentication but before the row read;
SQL returns 403 and the actual form, phone and collection clear. This does not
generalize that ordering to every other validation or ancillary service error.
Foreign rows are not echoed to a doctor. Override flags cannot bypass the version. Empty appointment PATCH
also refuses: it cannot return an invented demo-shaped confirmed row. No
DELETE endpoint, automatic merge, blind retry or compatibility write bypass
is added. Old browsers without the precondition need a refresh.

A confirmed conflict preserves the unsaved form and gets its own Russian
message, not the previous misleading lost-connection text. It does not guess
which person changed the row or claim that a prior lost-ACK edit rolled back.
An actual committed/lost-response test keeps one mutation and one audit, then
refuses the old token without a second writer or a false success. Reopening the
actual current item explicitly permits a new edit. This is not durable PATCH
recovery or an automatic draft merge. A lost success response still needs
refresh/reconciliation rather than a new blind write.

## Evidence Boundaries

The native lane uses actual React openEdit/form/actions, actual client/session
code, the full HTTP router and PostgreSQL SQL. Auth identities and SDK transport
remain explicit doubles. Cases cover stale forms with/without collection
refresh, fresh reopen/save, stale status, override flags, unchanged timestamp,
missing/malformed/stale/absent schema versions, token reset attempts, empty
PATCH (including timestamp-only normalization) and the previous live-role/ownership/lock-wait cases. Denied mutations
and audit absence are checked in the database. This is an action slice, not
full calendar pixels, physical mobile devices or real cloud Auth acceptance.

The current read-only metadata gate now has 108 conditions. Before 117 an
otherwise complete 116 schema has eight explicit blockers. New conditions pin
the column/default/nullability, private invoker body/ACL, exact enabled trigger
and reviewed BEFORE UPDATE trigger inventory. No domain row or RPC is read.

Raw SHA-256 117:
`6ddda2adbaddb36f64d959127dd2bd005e52d116724dee840cf31c62bc362fdf`.
Only the CLI-generated local query
`node_modules/.cache/appointment-open-version-117-readiness.sql` was created,
SHA-256 `8ce3886838868c6cf9dffcf7ae56778e33540f46dc292085bffda29613408754`.
It was not executed in a cloud database. Historical 93/100-check files remain
receipts for older candidates, not the current rollout checklist.

Query-spy tests explicitly declare synthetic before tokens and a synthetic
after token. They preserve their original role/directory/advisory assertions,
not SQL concurrency or token-authority proof. Stateless WASM API cases start
with a freshly read token; their contact/authorship assertions separately
require token rotation and exact other fields. The frozen-form concurrency
proof is native and independent of these fixture conveniences.

The first broader run was not accepted: an added helper
accidentally shadowed the SDK refresh method; old fixture rows/snapshots did
not declare the new token; and two pre-115 catalogue tests still expected a
lossy column fallback. The helper is now refreshItems, the original SDK refresh
remains, and those two tests require atomic refusal with their offered link
intact. No test was skipped or production guard relaxed to fix these failures.

## Local Verification

- Native patch authority: 45/45, including actual React stale-form/lost-ACK and
  mixed stale-version/revocation cases. Log: appointment-open-version-native-patch-authority.log.
- Related 17-module regression: 792/792. The initial launcher misspelled the
  SQL ACL test path and Node ignored that absent argument. It is not counted
  as an 18-module run. The missing 55 ACL checks passed in the explicit,
  existence-checked nine-module neighbor run below.
- Nine neighbor modules: 389/389, including those 55 ACL checks and 334
  appointment/privacy/navigation checks. The first neighbor run was 387/389:
  FD1 still searched for the old nearby create/handoff source shape; VT11
  did not support existing useRef/portal/SDK imports. FD1 now selects the
  actual awaited result and active-status/current-scope guard structurally,
  with two rejected in-memory mutants. VT11 keeps its role/purpose/label
  matrix and mutants, supplies stable hook slots and a body-checked fake
  portal, and forbids SDK access. This label fixture is not DOM-modality proof.
- Native creation/recovery plus exact cumulative SQL 009-117: 609/609.
  Migration 117 preserves the owned pre-existing tuple and previous fields;
  temporary rows are removed/rolled back and owned services close. These
  suites partially repeat shared SQL cases; their counts are not unique
  platform requirements or whole-platform acceptance.
- Fixed no-network isolation lane: 931/931, unchanged 41-reader keyset and
  network/IPC boundaries. Only reviewed server source digest advances to
  415f0c8b4092b4acc193de81010e2d9671b683ffdc7d5e0a8351d845cbcf9c7c.
- Full production-mode build after the test repairs: exit 0, both API compiler
  modes, all workspace types, 353 cold-start checks and Vite. Log:
  appointment-open-version-build-final.log. No runtime source changed after
  the successful native/regression/isolation runs. Protected 059/065 hashes
  and the five pre-existing user demo listeners remain unchanged.

Logs above live only under node_modules/.cache, using the prefix
appointment-open-version-. The successful final native-rest/isolation logs
are suffixed authority; the final neighbor log is neighbor-verified. Earlier
failed diagnostics are retained, not overwritten or reported as passing.
Both empty-PATCH failures in the intermediate 652-case native run were real:
normalization supplied only updated_at and invoked a writer. That lone
synthetic timestamp is now removed before the explicit no-fields refusal;
both current full-HTTP cases pass without a writer or audit.

## Still Required

Select and verify the exact isolated API/UI/SQL delta, effective build/runtime
database and sender/worker bindings, current target metadata and legacy pending
outcomes. Drain incompatible writers and coordinate the new UI/API with
115/116/117. Do not restore old direct DML or run incompatible seed:clinic.
Never treat the raw local 009-117 test chain as a cloud deployment plan.

The new HTTP handler currently places the opening-version precondition into
the 116 typed preimage; the original service RPC still accepts a fresh preimage without
an independent opening token. It is not browser-callable, but an old service
API could still use it. This is an explicit remaining cutover/security gate:
add a version-bound SQL entry and close that old service entry before claiming
protection of every server writer or releasing this candidate. A green
108-check result alone does not close that gate. The local new-API browser
acceptance below must not be generalized to legacy server addresses.

Real Auth/Preview, durable PATCH/task recovery, crash-atomic secondary audit,
global schedule/catalogue changes, physical devices, provider/private Storage,
commercial/legal approval and other unaccepted G1-G8 gates remain open.
Production, Baspana, salons, WhatsApp, roles, passwords, commercial settings,
protected 059/065, advertising, generations, external sends and expenses are
unchanged. Existing user demo servers are retained.
