# Appointment Patch Authority

27 October 2026, local base `c112cf3`, G2-C21 / G7-C56. This advances the
existing G1-G8 goal, not a new scope or completion of the platform. No cloud
SQL, deployment, real Auth account, tenant session or external provider is used.

Later G2-C22 / G7-C57 adds the [open-form version](APPOINTMENT-OPEN-VERSION-2026-10-27.md)
and coordinated 117. The current metadata gate has 108 conditions; the 100-check
receipt below remains historical evidence for this earlier actor-only candidate.
Later C23 in that document adds 118 and a separate version-bound service facade;
its 112-condition gate supersedes the 108/100-condition receipts.

## Defect

The existing full HTTP catch-all authorized a caller, read the appointment
and directory, then performed a separate service-role UPDATE. Seven native
HTTP/SQL cases reproduced an unauthorized/stale success:

- Role replaced by marketer or another allowed role after HTTP authorization.
- Auth account rebound on the same staff row, or staff deactivated.
- Doctor's appointment reassigned, or its specialist card rebound.
- Another writer changed the row while reusing updated_at.

The response still returned 200 and appointment data, including a synthetic
phone, and the old write could replace the concurrent note. The diagnostic
also exposed the pre-write outside-schedule journal event. Five ordinary role
updates and the unregistered DELETE refusal are retained as positive controls.
The diagnostic is `node_modules/.cache/appointment-patch-actor-red.log`.

## Change

The API calls `patch_crm_appointment_as_actor` from forward **116**, with the
original verified Auth ID, staff ID, exact HTTP role, workspace, appointment,
server-read preimage and normalized patch. Browser actor fields are not trusted.

The SQL operation pins the active staff row, locks the appointment, then checks
current own-work identity. Wrong original authority is 403; lost/missing own
work is 404 without row echo. The complete typed preimage must still match,
including writers which reuse updated_at. Conflict is 409 and no automatic
retry, field stripping or direct UPDATE fallback is permitted. Non-READ-COMMITTED
snapshots are refused. This pins the request's advisory reads, not a version
captured when a user first opened a form minutes earlier.

Only the fixed editable-column whitelist can reach parameter-bound dynamic
SQL. Column names use identifier formatting; values and both tenant keys stay
bound. Only offered columns fire UPDATE OF triggers. Arrival-trigger changes
are read inside the same transaction, eliminating the unguarded post-commit
appointment reread. An outside-schedule journal event is written only after
successful domain mutation; the secondary journal itself remains a separate
best-effort transaction, not crash-atomic audit or durable PATCH recovery.

116 retains service SELECT and closes direct service INSERT/UPDATE/DELETE on
appointments. Residual effective column/inherited writes make the migration
roll back rather than silently claiming closure. Current v2 create/replay and
actor PATCH execute as reviewed definer functions. DELETE is still not a CRM
route. No browser/table grant, new account, role or commercial setting is added.
Native admission tests distinguish PostgreSQL's direct-column REVOKE behavior
from inherited table/column privileges. Direct column grants are recorded before
the raw migration and then closed; inherited privileges require atomic refusal.

## Evidence

The owned native fixture uses the actual handler/Auth/workspace logic, synthetic
Auth identities and real SQL. Its adapter now serializes rows with PostgreSQL
row_to_json, matching PostgREST timestamp precision instead of losing
microseconds through a JavaScript Date. Fixtures include explicit six-digit
timestamps; the typed preimage check is not weakened to make them pass.

The composed React action slice uses actual appointment state/actions/client,
owned SDK/context delivery, full HTTP routing and real SQL. It tests successful
edit plus deactivation/reassignment while saving: old form/phone/notes and row
disappear on 403/404, with no success or denied mutation. It is not a complete
calendar-rendering/mobile-pixel or real cloud Auth acceptance.

Additional native cases cover actual browser-role execution refusals, closed
legacy service DML, protected/unknown keys, stronger-isolation refusal, offered
trigger columns and both real staff row-lock winners. Known 115 create/replay,
capacity and every raw 009-116 migration must pass with final grants; results
and final log receipts are recorded in DELIVERY-CYCLES after verification.

The current metadata-only gate has 100 boolean checks, including exact 116
body/argument/owner/ACL and effective service read-only table access. A schema
with only 115 is explicitly not ready for this API. It still does not attest
target identity, real Auth, legacy pending outcomes or migration safety on
existing customer data. No read-only query was run in a cloud database.

The bounded ACL checker recognizes the dynamic DML statement only under the
complete raw-source review receipt for 116 plus its exact parameter expression.
Every changed/extended source is rejected; appended browser grants, untrusted
assignments, missing tenant predicate and forged parameters are negative tests.
Other dynamic SQL/ACL parsing stays strict. Native execution never strips SQL.

## Final Local Receipt

Accepted serial runs: 622/622 native cases across three roots (create/recovery,
PATCH and raw 009-116, 108 files), 531/531 scoped ten-file regression, 247/247
six-file calendar regression, and the unchanged 931/931 no-network set. Both
API compiler modes, workspace/scripts types, 353 cold-start checks and the
root Vite build passed, exit 0. No new skips. Existing tooltip sourcemap and
mixed serverAuth import warnings remain. Counts overlap; they are not a
unique platform total or completion percentage.

Final logs in `node_modules/.cache`:
`appointment-patch-native-closure-final.log`,
`appointment-patch-regression-closed.log`,
`appointment-patch-calendar-closure-final.log`,
`appointment-patch-isolation-closed.log`, `appointment-patch-build-closed.log`.
The earlier `appointment-patch-native-closed.log` failed on a mistaken test
expectation for direct column REVOKE. The final test records those direct
grants before raw 116, proves their closure after it and separately proves
atomic refusal of inherited table and column rights. Earlier precision,
fixture dependency and obsolete query-spy failures were not counted as green.

Raw SHA-256 116:
`567eb91556edeb94d74f76b3fe32115e5347164203f3cffa6d4fc9a49ef9ec75`.
The CLI created only `node_modules/.cache/appointment-patch-116-readiness.sql`,
SHA-256 `535b28f081dec49c7ac1afb9de44f52cc0b088ddd1bcb7e0bfd1758925948e81`.
The generated query was not executed in a cloud database. The 41-reader set
and environment/network/IPC guards are unchanged; only the reviewed server
source hash changed from `26bf696b...` to `d9f1468a...`, with no new environment
reader, API import or external destination. Protected 059/065 and all five
user demo servers are preserved. Owned test servers and profiles are cleaned.

## Rollout Gates

1. Select exact API/SQL/UI delta and independently verify test-only build and
   runtime bindings, target schema/ACL, workers and senders. The old
   [Preview preflight](PREVIEW-PREFLIGHT-2026-10-27.md) does not provide this.
2. Drain incompatible in-flight writers before 115/116. New API without 116
   refuses PATCH. SQL without the coordinated API closes old direct writers;
   do not reopen table grants to restore compatibility.
3. The legacy `seed:clinic` CLI inserts appointments directly and is incompatible
   after this closure. Do not run it against the cutover database; an approved
   actor-bound replacement or retirement is a separate prerequisite for anyone
   relying on that maintenance workflow. No seeding tool was run here.
4. Inventory pending legacy receipts and verify real Auth/Preview role changes,
   trigger configuration and current schema. Never apply the raw whole local
   009-116 chain to an existing cloud database as a deployment plan.

Global catalogue/schedule locking, client-open-version concurrency, generic
task replay, crash-atomic journal, private media/provider delivery, physical
devices, commercial/legal approval and remaining G1-G8 gates stay open.

An exploratory broader test run also found the old signed-upload F6 fixture
missing the now-required request key and staged workflow: it receives 400
before reaching its mocked Storage failure. This file was not changed or
silently skipped; it is not part of the accepted scoped G2 regression and
needs a separate current-workflow fixture before claiming that broader suite
green. It is not evidence of a live Storage outage. The failed exploratory
log is `appointment-patch-regression-first.log` in the ignored cache directory.
Later G5-C61 in DELIVERY-CYCLES reconciles that test-only fixture with the
current staged workflow and pins the actual Storage refusal. This preserves
the historical failed receipt above; it does not turn the scoped G2 run into
acceptance of the entire platform test set or real Storage delivery.

Production, Baspana, salons, WhatsApp, protected 059/065, advertising,
generations, external sends and expenses are unchanged.
