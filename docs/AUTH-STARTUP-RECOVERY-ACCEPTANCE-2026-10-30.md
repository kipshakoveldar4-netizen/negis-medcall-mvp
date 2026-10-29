# Auth Startup And Recovery: Local Acceptance

Date: 2026-10-30. Parent: `1f58ba1`. Local candidate only, not a Preview,
Production release, actual password reset or real Control/provider acceptance.

## Implemented Boundaries

- Provider setup has an explicit mount lifetime and setup generation. Layout
  setup quarantines old session/role/read state before a retained-state reveal;
  late bootstrap and subscription callbacks cannot own a newer setup.
- Credential startup captures the original authority stamp before asynchronous
  work. Control verification, session exchange, OTP receipt and target membership
  must remain current. The URL is cleaned before transport. A bounded startup
  retires abandoned work; an unrelated new account is resolved normally.
- Impersonation metadata grants no role. A successful native OTP must match the
  verified owner email and current SDK session; a fresh server response must list
  the exact owner target before a bound routing/banner hint is saved. Restored
  hints can select only a matching current user's freshly confirmed owner row.
  Invalid, legacy-unbound and malformed hints cannot create owner permissions.
- Cached staff privileges are ignored when real Supabase configuration exists.
  Offline staff and the existing local demo remain separate local modes.
- Normal sign-out captures its original stamp and UI subject synchronously,
  before clearing UI or scheduling SDK work. Its old subscription is retired.
  A stale original exit cannot revoke the newer account; it re-resolves the live
  account instead. Old completions cannot clear a newer exit's dedupe reference.
  A retained public A exit callback cannot adopt a later B or A-after-B identity.
- The password method uses the real SDK through the same guarded storage/lock
  boundary. Its PUT uses the original session, a late result cannot overwrite B,
  and the observer receives the owned `USER_UPDATED` meaning rather than a new
  login. Rechecks overtaken by another write do not transfer an old event hint.
- A mutation receipt is checked after SDK disposal, not just before that await.
  `onReceipt` captures a synchronous non-authorizing stamp; callers must check it
  again after awaiting. It cannot authorize another dispatch or shared write.
- A URL recovery marker is not permission. A module-level observer captures the
  actual validated SDK `PASSWORD_RECOVERY` event before page mount. The form also
  confirms the matching live subject. A different account/session, sign-out,
  unmount or original expiry retires the form and pending callback.
- Recovery receipts last no longer than the native session expiry or 15 minutes
  from issuance. Refresh can retain the same recovery lifetime but cannot extend
  that original deadline. Successful reset consumes its local receipt; late
  errors, results, retained handlers and redirects cannot revive another form.
- Provider unlinked-account notices no longer interrupt `/reset-password`.
- Partner-company application reads now require both visibility and focus;
  `blur -> hidden -> visible` cannot reload private fields before focus returns.

These are frontend lifetime and server-membership-consumption boundaries, not a
replacement for provider authentication, server RLS, abuse policy or legal consent.

## Verification

Frozen-source aggregate `pnpm run test:auth-startup`: **164/164**, zero failures,
cancellations or skips. It contains 86 actual-provider/source tests with explicit
SDK/HTTP/hook doubles, 37 real-SDK password tests with fake HTTP/storage, 37
recovery-form tests and four synthetic company-focus cases. These layers are not
all native browser or server authorization acceptance.

The retained-state lifecycle cases use a public Suspense hide/reveal retaining
state; they are not a claimed post-ready StrictMode replay or private React API.
The desired stale-subscription defense initially failed; setup retirement fixes
the lifecycle instead of pretending an unfiltered fake callback came from the SDK.

The prior `test:auth-authority` **215/215** and actual-SDK App browser **25/25**
were repeated successfully against this candidate. The latter still includes one
parent/iframe case, not independent tabs/processes. Both documents, SDK/facade
observers, held replies, sockets and the browser closed cleanly.

Final entry/workspace/profile compatibility: **477/477**. The retired-provider
exit test now requires the recovery fence and its revision to remain unchanged;
it cannot declare a future provider's recovery successful. Unbound impersonation
cache now has explicit fresh-owner acceptance/fresh-nonowner refusal cases,
alongside refusal for a genuinely actor-bound, freshly confirmed delegated view.
No cached metadata was promoted into permission or an automatic denial.

The broader readiness-lifetime run initially passed 130/132. Its two failures
were in an unchanged operator-request fixture: rendering a new actor started an
automatic GET, then manual refresh retired it, but the helper answered only that
old GET and left the current GET unresolved. The corrected helper asserts the
old signal is aborted, delivers its late reply and requires zero visible cards,
then answers exactly one current GET and checks its actual label. The full run
now passes **132/132**; the request component/transport were not changed.

Main terminal receipts: `node_modules/.cache/auth-startup-checkpoint-RDNAP7/`
(164/215/477 plus the preserved initial 130/132 failure), and
`node_modules/.cache/auth-startup-acceptance-AIIMT6/` (final 132/132 and the
new browser/build receipts recorded below). Earlier incomplete/failed runs are
not acceptance; overlapping suites must not be summed into a readiness percent.

Final actual startup/recovery browser: **25/25**, 22 scoped scenarios, 24
individual screenshots at 375/1440. Evidence:
`output/auth-startup-recovery-browser/run-53Kyv2/{receipt,sources,close}.json`.
All 245 pinned source hashes were rechecked unchanged after the terminal run.
The positive native owner-Control case enters the actual Dashboard, using four
exact read-only empty list DTOs. This does not prove the selected hosted Control
endpoint, server authorization, real provider or operational business data.
The native implicit-recovery route validates the user before opening the form;
held validation/OTP/password PUT responses cannot mutate switched B or revive a
retired form. Parent App, facade, SDK, observers, held replies, sockets, browser
and build service close cleanly. Screenshots were inspected at native density;
this is not full portal/mockup parity or physical-device acceptance.

The previous actual authority App browser also repeated **25/25** with native
parent/iframe storage events and its own clean close receipt:
`output/auth-session-authority-browser/run-iF5im2/`. This remains one parent/iframe
case, not independent-tab/process acceptance.

Normal production-mode **local** build completed with exit 0, 7/7 workspace
typechecks (including both scripts typecheck projects), API in both normal and
broken-site modes, and 449 anonymous/authenticated-denial/company-routing
cold-start checks. This compiles a production bundle locally; it does not deploy
anything. Log: `node_modules/.cache/auth-startup-acceptance-AIIMT6/build.log`.

Final portal compatibility: **15/15** design fixture/bundle checks and
**1071/1071** portal UI/contract cases. Logs:
`node_modules/.cache/auth-startup-portals-w7DAZK/`. These are compatibility and
synthetic workflow checks, not a new whole-mockup browser comparison. The
unchanged approved design references and prior scoped visual receipts remain
in `design-qa.md`; the synthetic loopback design server at port 5262 was health
checked and left available. All verification runners reached terminal exit 0.

## Important Unclosed Exit-Recovery Boundary

Normal exit now binds its original UI actor and stamp. An older persisted
`negis_signout_pending_v1` boolean, however, has no original subject/session
witness after a full reload. The existing recovery branch with no UI subject
still resolves its current SDK session. The normal-exit tests must not be used
to claim that an A-exit/B-login/reload combination is covered by that branch.

Next safe local task: characterize that exact reload race and implement a bound
exit witness plus an explicit new-login path for legacy/unbound markers. Do not
simply clear the marker and revive A, revoke whichever B is now stored, or weaken
global sign-out to local while calling it equivalent. This is a technical release
gate, not a request to change a working account or a declaration of full Auth
readiness. No current candidate is approved for a multi-user/working release.

## Other Remaining Gates

- Selected real isolated Auth, independent-tab/process behavior, actual recovery
  email/PKCE and target-specific Control session endpoint deployment remain
  unaccepted. The Express impersonation session contract is not proof of a
  working endpoint on the selected Vercel target.
- Control-app authentication and the legacy, currently unreachable Landing
  new-password modal are outside this migration. Do not reactivate that raw
  password writer as a replacement for the proven recovery path.
- An already accepted remote password PUT or global revocation cannot be undone
  by client cancellation; tests prove original dispatch/local persistence and
  UI ownership, not remote rollback or memory zeroization.
- Browser tests use synthetic users, tokens, API/Control HTTP and only loopback.
  No real provider, database, email, account/password, business workspace, role,
  payment, advertisement, Baspana, salon or WhatsApp was modified.
- Public company signup/consent, payment provenance, operational data lifecycle
  and the rest of G1-G8 remain in [READINESS-EVIDENCE](READINESS-EVIDENCE-2026-10-30.md).

Protected migrations 059/065 retain their original raw hashes. Their read-only
source check confirms only declared LF/CRLF differences, not a SQL-content delta;
no restore, staging, index refresh or migration application was performed.
