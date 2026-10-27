# Recovery Calendar: 27 October 2026

G2-C20, local base `4b2028e`. This continues the existing G1-G8 goal, not a
new scope or whole-platform completion. No deployment, cloud SQL, real Auth,
provider, advertisement, generation, payment or customer data is involved.

## Reproduced Defect

The actual React appointment actions, real API client, compiled full CRM
catch-all and actual raw 009-115 SQL on owned PostgreSQL 17.11 reproduced this:

1. Create a two-service appointment, commit, lose the response body.
2. An owned editor reschedules the stored appointment before reconciliation.
3. Reload and reconcile with the same unchanged request key and payload.
4. The API correctly returns the current stored appointment, but the browser
   selects the day from the original draft. The recovered row is on another
   day, so the opened calendar appears to have no recovered appointment.

Four new owner/admin x confirmed/cancelled cases failed on that exact date
assertion before the change; the enclosing failed test is not a fifth defect.
The diagnostic reported 33 passes, four failed children and a failed parent,
not an all-green run. The new denial scenario passed independently.

A second diagnostic, after the day fix, bound a synthetic lead to the pending
intent. Both owner/admin cancelled-recovery cases still called `markLeadBooked`.
That run had 36 passes, two failed children and a failed parent. The callback
is an explicit spy: it proves the wrong dispatch decision, not a real lead
write, lead endpoint authorization or the complete lead/appointment transaction.

## Narrow Change

`AppointmentsPage.createAppointment` now returns the confirmed appointment's
start time and status as well as the existing recovery result. Its live submit
handler selects that day in the clinic timezone, not the unconfirmed draft's
day. Only a currently occupying status dispatches the linked-lead booked
callback; a recovered cancelled visit clears its local prefill without that
dispatch. The confirmed-visit positive callback remains tested.
The local demo keeps its original appointment time. Account/lifetime guards,
same-key immutable intent, uncertainty retention, refusal rules and edit
behavior are unchanged. No API, permission, schema or commercial rule changed.

## Composed Acceptance

The bounded browser fixture executes the actual React state/actions and real
client/transport code, not a rewritten recovery model. Its SDK/session/context
and collection delivery remain synthetic. The full HTTP handler performs its
own actual authorization against synthetic Auth identities and owned SQL rows;
its SQL adapter executes the real RPCs, not fabricated domain outcomes.

The expanded cases cover:

- Owner/admin recovery with two bound service IDs, 75 minutes and fractional
  agreed amount 700050 minor units; the complete original request survives
  reload unchanged even after catalogues become inactive and change prices.
- A present confirmed start at 20:30 UTC opens the next clinic day at UTC+5;
  a cancelled visit at 23:30 clinic time retains its original 75-minute span
  across midnight. The response has current status and explicit zero price,
  not old price/status/time. No sale or automatic payment is created.
  Its linked-lead callback runs once for confirmed recovery and not at all for
  cancelled recovery; no actual lead is provisioned or changed by that spy.
- Actual membership deactivation before reconciliation returns 403. Client,
  phone and notes disappear from the form immediately after the denial while
  the uncertain original request key remains. An explicit storage reread does
  not resurrect those fields or dispatch another request. After authority is
  restored and the owned browser reloads, exactly the original ID is recovered
  once and the durable pending receipt clears.
- Three different HTTP request keys all reach their SQL writer barrier before
  release, racing for a capacity-two slot. Even `allowConflict:true` must not
  bypass the database guard. The expected result is two commits and one 409;
  the failed writer must leave no extra receipt, origin, client or journal.

The editor used to change the stored row is an owned database fixture. This
does not prove generic PATCH/delete authority or the real calendar edit UI.
The browser fixture is an action slice, not full-route mobile/desktop pixel
acceptance or a real cloud account/session switch.

## Verification Receipt

Final serial checks passed: native suite 39/39, six-file calendar regression
334/334, fixed no-network suite 931/931, both API compiler modes, workspace and
scripts types, 353 cold-start checks and root Vite build. Counts overlap;
they are not a unique total or a platform readiness percentage. No new skips.
Two earlier regression attempts failed on old source-expression/index checks;
their exact-key/actor/ordering checks were preserved and updated to the shared
confirmed variable before the successful rerun. The original behavioral red
run was not counted as green. The first combined root build emitted its bundle
but crashed with the Windows `UV_HANDLE_CLOSING` assertion, exit 3221226505;
it was not accepted. The unchanged full root-build retry exited 0. Existing
tooltip sourcemap and mixed static/dynamic serverAuth import warnings remain.

Final logs in the ignored `node_modules/.cache` directory:
`appointment-current-day-final-native.log`,
`appointment-current-day-final-regression.log`,
`appointment-current-day-final-no-network.log`, `appointment-current-day-final-build-retry.log`.
The failed build remains in `appointment-current-day-final-build.log`.
The earlier diagnostics are `appointment-current-day-red.log` and
`appointment-current-day-lead-red.log`. Earlier green calendar-only runs do
not silently attest the later cancelled-lead change.
More detail is recorded in `DELIVERY-CYCLES.md`, G2-C20.
No migration or reader snapshot is changed here.
Native helpers validate their own loopback server/profile/data directory before
cleanup. The test checks removal of its exact workspace-bound rows as well.

## Remaining Gates

The [fresh Preview preflight](PREVIEW-PREFLIGHT-2026-10-27.md) still identifies
old 6c11l89kr/f18f411 with no proven effective bindings for the current branch.
No new Preview was created. API+115 still needs a selected coordinated delta,
legacy pending inventory/drain, current target metadata and real Auth/Preview
acceptance. General task replay, PATCH/delete atomic authorization, other G2
compositions and all unaccepted G1-G8 families remain open.

Production, Baspana, salons, WhatsApp, roles, passwords, settings and protected
059/065 are unchanged. Five existing user demo servers are not test fixtures
to stop or remove.
