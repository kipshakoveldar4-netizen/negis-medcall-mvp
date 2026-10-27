# Appointment Open-Form Version

27 October 2026. Base `b3c46f3`, G2-C22 / G7-C57. This continues G1-G8,
not a new platform or completion of all acceptance gates. No cloud database,
deployment, real Auth account, customer workspace or external provider is used.

This first records C22 (`bdaad3e`) and its 108-check gate. The subsequent
[C23 version-bound entry](#c23-version-bound-service-entry) below also requires
118 and a 112-check gate; it supersedes the legacy-entry cutover gap recorded
under Still Required. Neither candidate has been released or applied remotely.

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

## C23 Version-Bound Service Entry

G2-C23 / G7-C58, local base bdaad3e. The prior service writer could accept a
freshly fetched preimage, bypassing the new browser's opening-version intent.
118 introduces patch_crm_appointment_v2 with an independent required UUID
argument. The API forwards the frozen client token separately from the fresh
server preimage. SQL replaces only its edit_version and delegates to the
source-pinned 116 owner-only implementation. Live original-actor/own-work
authorization still precedes typed-row CAS; no extra read or DML path is added.

118 revokes the legacy service entry and checks effective privileges, including
inherited grants. If any legacy EXECUTE remains, the entire migration refuses.
Browser roles cannot call either entry; service_role keeps only the new facade.
The raw migration checks original function bodies, the enabled version trigger,
non-null UUID column and closed direct table writes. It is one-time, has bounded
timeouts and changes no business rows, table grants, accounts or commercial rules.
The full 112-condition metadata gate is still mandatory; this migration alone
does not attest every dependency or authorize a remote cutover.

New SQL cases reproduce the legacy overwrite before cutover and then exercise
real role denials, null/stale independent tokens, a fresh token with stale other
fields, correct save/token rotation, inherited-grant refusal and exact-rerun
refusal. The complete live-authority/lock-wait suite is also exercised through
the new facade after 118, not only directly through historical 116. The full
HTTP fixture checks that a missing new writer yields 503 with no legacy call,
direct UPDATE or audit. SDK spies explicitly name the new protocol, not SQL proof.

Current gate: 112 conditions, exact facade body/argument names/owner/ACL and
legacy closure. A complete 117 schema has five blockers, not a ready result.
Raw 118 SHA-256: aaa99158d91016da7fc358962a31f499fb26d6bf86d50a9ecbc52d1f5b2edf75.
Facade body SHA-256: d5f8355441890ab3bb910adcb34a0cd9e3211685431ffee7826e0eb283bb11a8.
Generated local read-only query: node_modules/.cache/appointment-version-entry-118-readiness.sql,
SHA-256 8f16cfe53e02a51450623a2d2d10dbe48b0efeb784053b25e27317aadc20e5bd.
It was not executed remotely and never reads domain rows or invokes a writer.

Verification receipts (local logs only, prefix appointment-version-entry-):

- preflight: 310/310, review/metadata/SQL ACL/WASM API.
- native-rest: 643/643, actual creation/recovery and exact raw 009-118 chain
  (110 SQL files), including before/after legacy entry proof and real privilege,
  independent-token, inherited-grant and lock-wait assertions. Owned rows are
  removed/rolled back and owned helpers close; no external facilities exist.
- native-patch-final: 46/46, actual React/client/router/native SQL, including
  missing current writer, stale forms and mixed revocation. The earlier
  45-case run predates the added missing-writer test and is not its receipt.
- regression-final: 1186/1186, 26 explicit existing modules, no duplicate or
  silently ignored missing file arguments. Existing companion assertions and
  the two strengthened neighboring tests remain enabled.
- isolation-final: 931/931, the same fixed no-network/IPC lane and 41-reader
  keyset. Only the reviewed server digest changes to
  d7d52202d5d782a88ff5ffdc8a31f1d92c929c1f7dad450bc1514d0959267167.

- build-final: full production-mode build exit 0, both API compiler modes,
  all workspace types, 353 cold-start checks and Vite. No runtime/SQL changes
  after the successful final runs. Protected source hashes and five original
  demo listeners are unchanged; these are not customer environment fingerprints.

No whole-platform readiness or unique requirement count is inferred from these
overlapping suites. Fresh-checkout byte portability is a separate G7 gate:
current reviewed migrations 116-118 have LF bytes, but text/eol attributes are
unset and Git warns about future CRLF conversion. No automatic normalization,
raw-hash repinning or protected 059/065 repair is performed by this candidate.
This closes the known legacy-code entry, not compromise of a trusted service key:
the backend must still authenticate the caller and supply its original identity.
Real Auth/current Preview bindings, selected SQL delta and existing outcomes,
durable PATCH/task recovery, crash-atomic secondary audit and remaining G1-G8
acceptance gates are unchanged and remain required.

Later G7-C59 pins the original raw format of each reviewed migration in
.gitattributes, without SQL edits or receipt repinning. Actual Git checkouts
reproduce all 110 SQL files under four autocrlf/eol modes. This closes the
scoped SQL-byte portability gap above, not a whole-repository clean build.
The current target was also checked read-only: 69/112 true, with explicit
missing-protocol/legacy-body reasons. The five-file appointment source delta
102 + 115-118 is compatible with a disposable baseline matching that catalog
slice; it is not applied remotely or approval to release all accumulated code.
See [the later preflight receipt](PREVIEW-PREFLIGHT-2026-10-27.md#later-read-only-recheck).

## C24 Transactional PATCH Journal

G2-C24/G7-C60, local base eed7092. The existing versioned PATCH committed its
domain RPC before a separate best-effort audit INSERT. An owned native SQL
reproduction proves that the visit can persist while the later journal fails.
It demonstrates that two-statement gap, not a production incident or a full
pre-fix HTTP test.

Local 119 adds patch_crm_appointment_journaled and closes effective service
execution of 118. The API uses only this new entry; there is no legacy RPC,
direct UPDATE or second audit INSERT fallback. 118/116 still enforce original
live staff/Auth/role, own-work, typed preimage, frozen opening token and capacity
under their existing locks. Journal INSERTs and any arrival-sale side effects
belong to the same transaction. A failed, suppressed or mismatching audit row
rolls back the visit, its token and both events, not an already committed save.

The verified server computes the existing privacy-classified field diff and
email snapshot; request data cannot choose the audit actor, workspace, entity
or event type. SQL bounds its shape, unique allowed offered fields, exact Russian
labels, fact-only notes and masked contacts. It does not independently recompute
the JavaScript diff or attest a compromised trusted service caller. The original
policy still omits unclassified fields and no-op updates; this is not a promise
to record every physical column change. Non-appointment/create journals retain
their existing separate best-effort behavior and are not declared crash-atomic.

The shared name masker now preserves one Unicode code point instead of half a
surrogate. The actual PostgreSQL JSON path accepts a masked non-BMP fixture;
free-form notes and full contacts do not enter those audit values. This changes
neither roles, contact-read rules nor journal field classification.

119 raw SHA-256: 38730dd70d0a717855066a898aa11616f21dc904ce946ef68651450eda6001fe.
Journaled body SHA-256: d9e7877ab5f1c0b30db564ac961ed3ef6b686c0743d544279d03925b5672d9ae.
Current metadata contract: 130 conditions including journal shape/privacy ACL,
the new entry and closure of 118. 118 alone produces five blockers. The prior
112-check query remains a distinct historical export for the observed catalog
receipt; that observation has not been rerun against the new candidate.
Generated local read-only SQL: node_modules/.cache/appointment-journal-119-readiness.sql,
SHA-256 079cfd2335099d741cbb626a2f51fba9718a889f3c7caea5c84c44eba6b3f190.
The CLI generated it only; it was not executed against any cloud database.

Verification artifacts are local logs with prefix appointment-journal-:

- native-chain-final: 655/655, raw 009-119 / 111 sources on owned PostgreSQL
  17.11. Before/after gap, journal/dependency/ACL refusal, both-event rollback,
  Unicode/phone policy, current facade live-authority waits and all-table empty
  cleanup pass. An initial import failure was fixed by using this repository's
  existing CJS/TS interop, not by excluding the new SQL cases.
- native-patch-final: 64/64, two parent suites. 13 source-baseline/cutover cases
  plus 51 actual React/HTTP/native PATCH cases. Four audit-failure modes roll
  back arrival-sale effects; a retained real form saves once after repair.
  Lost ACK, stale independent versions, replacement account, own-work refusal
  and live-role waits remain. Auth identities and SDK transport are doubles;
  the SQL/HTTP/React domain path is real and loopback-only.
- verified-preflight: 118/118, current WASM metadata, SQL outward-effect review
  and actual Git checkouts. 111 original byte receipts survive four EOL modes;
  protected SQL and earlier raw hashes are not normalized or repinned.
- verified-isolation: 931/931, unchanged 41-reader key set/network/IPC guards.
  Only reviewed server digest changes to
  1779ab67fc10014e464d234385c2f203d3696bef5e924dd8d594626673b97322.
- verified-build-final: full production-mode build, both API compiler modes, workspace
  types, Vite and 47+130 / 47+129 compiled cold-start checks pass.

The initial nine-module regression was 495/521, not green. Three expectations
still counted the removed second SDK audit although the real SQL audit existed;
23 old column-lag cases had no RPC transport and demanded the pre-115 practice
of dropping columns and retrying direct writes. That practice is not restored.
Their current-contract replacements require refusal without column stripping,
exact capacity/error classification, author preservation and no invented audit;
the original SQL-repair and task-fallback checks remain. A diagnostic rerun was
524/525: its last assertion still expected advisory capacity before the current
create RPC. Real capacity is covered by the existing native concurrent two-seat
case, not a query double. The corrected nine-module run passed 525/525; after
restoring its two neighboring non-appointment capacity checks,
verified-regression-final passes 527/527, with the current schema-safe assertions.
Counts overlap and do not measure whole-platform requirements or percentage.

No cloud migration/release, real Auth, financial action, external provider or
customer workspace was accessed in this cycle. The six-source appointment
candidate still needs effective isolated Preview binding and approved coordinated
API/UI/schema cutover, existing-outcome reconciliation and real Auth acceptance.
Durable PATCH/task command recovery, other crash-atomic audit paths, shared
schedule/catalogue races, physical devices, commercial/legal/provider gates and
all other unaccepted G1-G8 work remain open. This does not close the full goal.
