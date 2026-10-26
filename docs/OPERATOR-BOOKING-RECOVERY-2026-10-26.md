# Operator Booking Session Lifetime And Committed Recovery

G1-C8 / G2-C17, 26 October 2026, base c7851ac. Local only. The preceding
goal turn made verified progress on arrival/control-call leases and the portal
epoch. This cycle continues the original operator/booking/revocation scope.
No cloud database/Preview/configuration, Production, Baspana, salon, WhatsApp,
real account, provider, advertisement, paid generation or expense changed.

## Reproduced Defects

LeadList did not forward its existing parent lifetime to OperatorBookingForm
or BookingFields. A queued POST could dispatch after raw session expiry; late
success/refusal could publish, clear the original recovery key or invalidate
the current parent before cleanup. Retained unmounted submit handlers also
performed storage/state work before their eventual dispatch guard refused them.

The booking context GET had only a passive AbortController fence, no original
actor or rendered-scope fence. Its old form could remain under a new actor,
agreement or lead before the effect ran. A context refusal also deleted an
earlier potentially committed receipt. A current POST 401/403 did the same:
access denial does not prove that the previous same-key write never committed.

Actual composed baseline: 282 tests, 265 pass / 17 fail. All 17 new cases
reproduced these defects; the prior 265 remained green.

## Narrow Runtime Fix

- LeadList forwards its live parent/list lifetime to the booking form. Its
  denial callback also respects raw session retirement.
- Context is tagged with actor/request/lead/revision/parent-guard identity.
  New scope hides the prior form synchronously, not after passive cleanup.
  GET pins the original actor and guards both dispatch and response handling.
- BookingFields checks its rendered lifetime before storage, state or transport
  work, before publication and before releasing busy. Raw expiry, remount and
  late outcomes cannot write into a replacement/returned account.
- A legitimate current access refusal hides the form and propagates denial,
  but does not delete the original actor-scoped recovery key. Reopening while
  denied also preserves it. It is metadata only, not a right to read/book.
- Actual same-key recovery still passes live native authority. A different or
  suspended operator cannot obtain the saved appointment. Existing validation/
  business refusal policy is unchanged; 401/403 are no longer rollback proof.

Only three frontend runtime sources change. No API or migration, appointment
capacity rule, financial/rate/role setting or native RPC body changes. There is
no automatic new-key retry, invented auth token or fallback database in runtime.

## Local Acceptance

The actual component/hook/transport simulation plus existing booking SQL/storage
tests pass 302/302 after the fix. That includes the new 17 cases. The booking
SQL unit tests use PGlite and are not real concurrent backend/Auth proof.
Final expanded regression: 819/819 across fourteen test files, including real
React/Chromium arrival/request-refusal neighbors and the existing operator
catalogue/actor/transport/list/profile/booking coverage. The smaller 302 set
overlaps and is not added again. Full root build has terminal success: both API
compiler modes, all library/app/scripts types, 169 compiled cold-start/auth/
denial checks and Vite. Existing nonfatal tooltip sourcemap and mixed serverAuth
import warnings remain. Final fixed-isolation/cleanup is in DELIVERY-CYCLES.

Fixed no-network regression: 931/931 with terminal success. The fixed test list,
41-reader hashes/key set, network denial and IPC guards are unchanged. All
native/browser/VM/build/isolation handles have terminal outcomes. No owned test
PostgreSQL/browser or matching test Node process remains; user demos are kept.
Protected raw 059/065 hashes match their original receipts and are excluded.

A new explicit-opt-in fixture additionally composes:

1. Actual React OperatorBookingForm, operatorApi, crmFetch and serverAuth in an
   owned Chromium profile, with normal same-tab sessionStorage across reload.
2. Actual loopback HTTP and actual operator-booking/catalog handler sources.
   A narrow synthetic SDK adapter maps their read queries and two booking RPCs
   to real SQL. HTTP response/header handling uses a small Node adapter, not a
   Vercel runtime or the compiled catch-all. Auth identities/SDK are fake.
3. An owned PostgreSQL 17.11 cluster, exact raw 009-106/98 source files, with
   the established minimal Storage catalogues only. Each handler SQL call uses
   an actual service_role connection; no DSN/Auth/Storage/cloud fallback exists.

Native HTTP acceptance: 7/7 including parent, six end-to-end cases at 375/1440:

- The original POST commits; its JSON body is cut after HTTP headers. A same-tab
  reload restores the original key; explicit recovery returns that appointment.
- After that commit, the operator is suspended and cannot reopen the form. Its
  key remains. Restored approval permits the same-key recovery, not a new visit.
- A committed POST reply is held while A changes to B and back. B is denied by
  actual SQL. The late A reply cannot publish/erase the returned A's key. A's
  explicit recovery returns the original appointment.

Every case proves one client, one appointment, one booking receipt and one
creation audit. There are exactly two successful handler POSTs: original and
explicit same-key recovery, with identical key/id. The catalogue is changed
after admission; the saved appointment still reports original 150050 minor KZT,
75 minutes, its exact doctor/services and 10:00 Asia/Almaty = 05:00 UTC.
Neither a new client nor another creation audit is introduced by recovery.
Receipts contain no client/contact/portfolio text. Responses are no-store.

Owned HTTP servers, Chromium profiles and native cluster are closed/removed.
After per-case cleanup, eight directly involved business tables are asserted
empty. This is selected local persistence/authority/transport composition, not
the entire raw-chain concurrency suite, cloud acceptance, styled screenshots
or a physical phone test. Only the owned origin is allowed over HTTP; the one
observed inline native calendar icon is byte-pinned, not a data/host wildcard.

## Harness Findings, Not Credited Passes

The first attempt's workspace deletion violated an existing restrictive request
FK and hid its original assertion. Cleanup now removes only owned booking/
assignment/request rows in dependency order and retains both original/cleanup
errors. No schema/FK is weakened.

A reset before headers was transparently retried by Chromium. The real native
receipt prevented duplicates, but that is not a deterministic lost-body test.
The final transport fault sends headers then truncates JSON, so the application
must enter its uncertain state. The suspend fixture now changes accepting_requests
with status, respecting the original CHECK. Chromium's datetime-local control
emits an inline SVG calendar icon; only its observed SHA-256 is accepted as a
non-network resource. All actual HTTP remains same-origin; no broader network
permission or production response behavior is changed to make tests pass.
Earlier failed logs and partial assertions are not final native acceptance.

## Reproduction And Remaining Gates

Root command: `test:operator-booking-native-http`, with explicit
`MEDINA_TEST_POSTGRES_NATIVE=1`. It requires the existing owned PostgreSQL and
local Chromium runtimes; absence fails, never downloads/installs or selects a
remote DSN. The default no-network profile is not expanded to include it.

This closes the selected LOCAL operator committed-replay/revoked-reopen path.
It does not close every staff-calendar committed replay, pending ABA role,
capacity/time-zone/report matrix or the required exact Preview/live-session
acceptance. The separate durable cooperation/proposal mutation decision remains;
an operator booking receipt does not make end/withdraw/create commands durable.
Current Preview isolation, G7 release/dependency attestation and all other
G1-G8 and recruitment legal/commercial/creator-job gates remain open.
Protected raw 059/065 are unchanged and excluded; no migration is prepared here.

Later G2-C18 [result validation](OPERATOR-BOOKING-RECEIPT-2026-10-26.md) checks
the original key/time-zone identity and complete safe receipt on both handler
and form. It also distinguishes existing cancelled/no-show results from a new
active booking. Cleared current metadata receives explicit review-required
labels without applying new-admission limits to the stored result. Native HTTP
acceptance expands to 11/11 with actual changed/null-metadata appointments and
synthetic partial-result delivery after the real commit;
this does not expand the cloud/real-Auth scope or make proposals durable.
