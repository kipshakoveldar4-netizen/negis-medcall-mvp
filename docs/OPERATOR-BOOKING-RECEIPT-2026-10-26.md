# Confirm The Original Operator Booking Result Before Acknowledgement

G2-C18, 26 October 2026, base 1b7a754. Local only. The prior goal turn made
verified progress on booking session retirement and committed recovery. This
cycle continues the original G2/G1 readiness work without redefining G1-G8.
No cloud Preview/database/configuration, Production, Baspana, salon, WhatsApp,
real account, provider, ad, paid generation or expense is changed.

## Reproduced Failure

The booking handler checked only that the RPC returned a UUID. A partial result
or another appointment's UUID could still be published as success. The form
trusted its TypeScript type, cleared the recovery key and only then passed the
unvalidated object to its caller. Bad date/zone/money fields could throw there
after that key was gone. Invalid context metadata could also open a form or
silently look like an unconfigured schedule instead of being unavailable.

Baseline: 346 tests, 330 pass / 16 fail. The failures were 14 new UI cases,
one new router subtest and its enclosing test. Existing positives were changed
only to deliver a realistic native receipt with the original dynamic request
key, status and duration; the prior lifetime/denial assertions stayed intact.

## Shared Runtime Contract

Both the existing server handler and the actual form use the same pure parser:

- The UUID must match the original request key; a valid foreign UUID is not a
  receipt. The time-zone label must match that original request too, not merely
  be another zone with a currently similar offset.
- A non-null StartsAt must be an absolute, finite, real calendar instant with an offset,
  including native PostgreSQL microseconds. Normalized impossible dates, local
  timestamps, whitespace and invalid hour/minute/second forms are refused.
- The time zone must be supported by the renderer. Context null still means
  genuinely unconfigured; absent, empty, malformed or unsupported data is an
  explicit unavailable response instead of success.
- Every result field must be present. An explicit null is different from an
  absent or malformed field: existing appointment time, service, doctor, price,
  duration and status can be cleared. Empty service/doctor text is also preserved.
- A non-null price is a canonical nonnegative integer string in the PostgreSQL
  bigint domain, never a floating conversion. Non-null duration is a positive
  PostgreSQL integer. These are read-result bounds, not permission to admit a
  new booking outside its unchanged 10,000,000,000-minor/600-minute limits.
- Non-null status must be one of the existing five statuses. Private/unknown
  RPC fields are not copied into the public DTO. No clinical contact is added.

A malformed RPC result gives a safe 503 with no data and no fallback writer.
A malformed browser result retains the original attempt and offers only its
existing same-key recovery path. A valid response alone permits acknowledgement.
The parser does not mutate a returned source or invent a new appointment.

Recovery reads the current existing appointment, not an immutable snapshot of
all its attributes. A clinic may legitimately have rescheduled or cancelled it
after the original commit. Such a same-ID result remains recoverable, but the
notice now explicitly reflects cancellation/no-show rather than claiming a new
active booking. Cleared metadata is shown with explicit missing-value labels and
a review-required notice, never an invented zero price or Unix-epoch date.
The original request/time-zone identity still matches. No
existing appointment, status, amount, role or booking rule is rewritten here.

## Current Local Evidence

The focused actual-component/router/contract set passes 360/360. All malformed
UI cases retain one key, reject a false success and then accept a valid reply
using exactly the original body/key. The separate pure parser cases cover
native offsets/microseconds, calendar validity, nullable current metadata,
PostgreSQL read bounds, private
field stripping, original identity/zone and supported existing statuses. An
intermediate pure contract run caught the missing original-zone comparison;
that run is not final acceptance. Schema review also caught a regression in
the first strict candidate: it incorrectly reused creation limits on mutable
existing rows. The additional baseline was 356 pass / 4 fail out of 360 (three
new cases plus the router parent). Current nullable/extended metadata now passes
pure, actual-form and handler tests without relaxing admission or identity checks.

The existing native HTTP fixture is expanded to ten real end-to-end cases at
375/1440: the prior loss/revoked-reopen/account-switch matrix, a genuinely
rescheduled/cancelled existing appointment with cleared service/doctor/price and
720-minute current duration, and a deliberately partial JSON
result after its real SQL commit. The latter corruption is only in the local
HTTP adapter, not the production handler. The production router's malformed
RPC behavior is separately tested with explicit SDK doubles.

Native acceptance passed 11/11 including parent, using the root
`test:operator-booking-native-http` command with explicit local opt-in. It
retains the original timeout; this is not a hosting performance benchmark.
The ten cases keep one original appointment/client/booking receipt/creation
audit and exactly one explicit recovery POST. The changed-result case returns
the actual next-day cancelled appointment with null price/service/doctor and
720-minute duration rather than re-creating the original slot. This checks
actual stored-row compatibility beyond the new-admission limits. The
partial-result case retains its key through reload and then accepts
the full actual response for that original ID. Owned HTTP/browser/database
cleanup completed and the directly involved eight tables were empty.

Final expanded regression passed 898/898 across sixteen test files, including
growth neighbors, original actor/denial/lifetime cases, real React/Chromium
controls and the pure parser suite. The smaller 360 set overlaps and is not
added again. Full root build has terminal success: both API compiler modes,
all library/app/scripts types, 169 compiled cold-start/auth/denial checks and
Vite. Existing nonfatal tooltip sourcemap and mixed serverAuth import warnings
remain. Final fixed-isolation/cleanup receipts are in DELIVERY-CYCLES.
The final fixed no-network suite passed 931/931 with the same 41 readers,
environment-key set, network denial and IPC guards. A final 8/8 parser pass
also uses an actual alphabetic UUID to exercise case normalization. These
overlap the expanded regression and are not summed as additional coverage.
All native/VM/build/isolation command handles completed successfully. No
matching owned test process remains; the user's two local demos stay available.
Protected raw 059/065 match their original hashes and are not staged.
The native fixture still uses
exact raw 009-106/98 on an owned PostgreSQL 17.11 cluster, actual service-role
queries and the existing actual handler/component/transport. Auth/SDK and the
Node response adapter remain synthetic, not real Supabase/Auth, a Vercel
runtime or compiled catch-all acceptance. Sizes are control/transport checks,
not styled screenshot or physical-device proof. Only owned-origin HTTP and
the previously byte-pinned inline native calendar icon are allowed.

The pure parser suite is included in the normal operators/growth commands;
the separate native command still requires explicit local opt-in. No dependency
is installed or changed, and no tests are added to the fixed no-network profile.

## Remaining Gates

This is local operator result/recovery acceptance, not the entire staff
calendar/role/ABA matrix, target schema compatibility, legacy malformed-row
reconciliation, cloud session or provider acceptance. Unsupported historical
results fail closed rather than being silently reclassified. A receipt still
does not grant a revoked user access or make proposal/end/withdraw mutations
durable. Exact Preview isolation/release attestation, all other G1-G8 and
recruitment legal/commercial/creator workflow gates remain. No new migration
is prepared; protected raw 059/065 are unchanged and not staged.
