# Auth Session Authority: Local Candidate

Date: 2026-10-29; final local receipts completed 2026-10-30. Parent: `0f7b410`.
This document records a local candidate,
not a release or permission to enable public registration.

## Scope

The three approved operator, referral-partner and content-author references
remain the design source. This cycle changes authentication lifetime handling,
not their visual design, business roles or financial rules.

Only the CRM frontend pins Supabase JS `2.118.0`. Root, server and control
applications retain their existing dependency resolution. The package manager's
minimum release-age rule remains enabled. No SDK source is patched.

The old `2.105.4` characterization is kept as a separate negative control.
It proves the old raw SDK behavior; passing that test is not evidence that an
application race has been fixed. An upgrade alone is not the mitigation.

## Commit Boundary

`authSessionAuthority.ts` uses the SDK's public storage, fetch and lock adapters.
Each explicit mutation captures the original session before its first await,
claims an opaque intent under the shared SDK lock, and uses a short-lived real
AuthClient. Immediately before replacing or removing the main stored session,
the adapter checks the original caller, latest intent, exact saved bytes and
an opaque write revision. This also rejects exact-byte account ABA.

The main SDK keeps the existing session storage key and uses the same lock.
Token refreshes or other writes retire an older explicit operation. Operation
PKCE/user-storage scratch keys cannot remove the main client's verifier keys.
There are no copied SDK internals, JWT-based permission grants or extra saved
passwords. Main-session parsing is used only for an optional expected-actor
lifetime check, never to authorize CRM data.

Every operation has a bounded fetch, optional caller abort and a finally block
that disposes the temporary SDK client after the operation has settled. A
current operation may return its own committed receipt after that commit
unmounted its form, but cannot return ownership of a newer session. Receipt
permission covers isolated scratch cleanup, not a new remote dispatch or shared
write: an intermediate token refresh must not authorize an obsolete global logout.

Explicit mutation fails closed without Web Locks. The read-side fallback is
not represented as cross-tab atomic mutation support. The supported SDK custom
lock currently emits its own deprecation notice; that is not suppressed or
treated as an application exception. A future SDK major-version change needs
a new coordination review.

## Application Wiring

Password/signup entry in the operator, contributor, company, general login,
landing and join-request forms uses the authority. Anonymous portal forms also
require that no saved user has appeared before dispatch. General login retains
its existing explicit account-switch behavior.

AuthProvider and the invitation account-switch exit use the scoped sign-out.
Global sign-out scope is preserved, not silently weakened to local. A logout
already accepted by the remote provider cannot be undone by a browser guard;
these checks prevent obsolete local dispatch/commit, not reversal of a remote
global revocation.

Observers in the frontend use the facade so same-document storage commits and
cross-document storage events cause a fresh main-SDK read. Temporary operation
clients do not impersonate the main SDK's private broadcast protocol. A stale
native event must not publish an account different from current storage.

The join-request form separately binds reads and submission to the original
account, cancels its old lifetime, clears private form/list state on an account
change and ignores late bodies, errors and completion handlers. Mode changes
and duplicate or retained submission callbacks cannot acquire a newer form.

The advertising history refresh now uses its original-actor read guard rather
than the private campaign-control guard. This repairs an enabled but ineffective
refresh for a marketing reader. It only repeats the existing authorized GET;
private CRM/Insights checks, campaign controls and server permissions are unchanged.

## Verification Receipts

Final frozen-source runs completed with zero failures/cancellations/skips:

- `pnpm run test:auth-authority`: 215/215. Actual frontend SDK entry/session
  adapters plus real React landing/join-request lifetime checks. The ready-state
  cleanup/setup regression uses public Suspense hide/reveal retaining state,
  not a claimed post-ready StrictMode replay or private React API.
- `pnpm run test:auth-authority-browser`: 25/25, actual App/AuthProvider,
  actual frontend SDK and closed loopback Auth/profile/context HTTP. 37
  screenshots at 375/1440, 245 source hashes and explicit cleanup receipts.
  The runner rejects a missing freeze flag rather than silently skipping.
- `pnpm run test:portal-auth-entry`: 474/474; `test:portal-ui`: 1071/1071.
- `pnpm run test:portal-design`: 15/15. This is the synthetic design/build
  layer, not new visual parity or native business acceptance.
- `pnpm run test:portal-auth-entry-browser`: 15/15, including the separate
  root-SDK `2.105.4` negative control and the older explicitly synthetic SDK UI
  layer. It is not relabelled as native persistence coverage.
- Compatibility regression: 1557/1557; advertising privacy/session/outcomes:
  242/242; goal/read-refresh: 50/50; invitation lifetime: 90/90 twice;
  staff-join source contracts: 12/12. These layers overlap and are not a sum
  or readiness percentage.
- Normal `pnpm run build`: exit 0, all seven workspace typechecks, API in both
  configured module modes and 449 compiled cold-start checks. The scripts
  typecheck always runs both its Node-only project and the separate DOM-enabled
  project for the two native frontend-adapter tests; those files are not simply
  excluded from verification. Existing chunk/source-map warnings remain.

Final unit/legacy logs: `node_modules/.cache/auth-authority-final-*.log`.
Normal build receipt: `.cache/auth-authority-build-final.log` and
`.cache/auth-authority-typed-fixtures-wDyv9X/results.json`.
Native browser evidence: `output/auth-session-authority-browser/run-X6wlPZ/`,
with separate `receipt.json`, `sources.json` and `close.json`. Browser, server,
sockets, temporary SDK clients, observers and held replies closed. The older
synthetic design server at `http://127.0.0.1:5262/` remains for the user.

Earlier failures are retained, not counted as acceptance: stale native initial
delivery; global logout following a retiring intermediate refresh; post-ready
layout setup exposing old state; private-control coupling blocking history
refresh; contextual fixture getter types and a Node/DOM test-project mismatch.
The browser initially mistook public shell markup for private identity; its
assertions now target actual private identity/data and still require absence.
The initial `node --test` wrapper lost the explicit freeze argument; the final
alias forwards it directly and a missing argument is a hard failure.

Test transports use synthetic users/tokens and closed local HTTP routes.
No real Supabase login, email, provider data, advertisement or payment is used.
Most composed browser cases use a same-document controlled second caller.
One genuine parent/same-origin iframe case loads independent App/SDK instances,
shares actual Web Locks/localStorage, observes native storage events and proves
that a held parent A cannot overwrite a committed child B. This is two-document
coverage, not independent tabs/processes or a real cloud session handoff.

## Remaining Gates

- AuthContext startup impersonation and development `setSession`/`verifyOtp`
  paths remain on their original SDK flow. Factory coverage of those methods
  is not application acceptance of the startup flow.
- Password update/recovery, control-app authentication and provider callback
  flows have not been migrated by this cycle.
- Isolated real-Auth acceptance and independent-tab/process coverage remain
  necessary before calling this a complete cross-tab authentication fix.
- Public company-applicant signup, confirmed-email/abuse policy, canonical
  consent texts and retention approval remain separate product/legal gates.
- Remaining visual/product gaps in `design-qa.md` are not closed by auth tests.

No Production, Baspana, working salons, WhatsApp, cloud migration, account,
password, membership, provider setting, advertisement or expense was changed.
Protected local migrations 059/065 must retain their original raw hashes.

## Primary References

- [Client initialization](https://supabase.com/docs/reference/javascript/initializing)
- [Authentication](https://supabase.com/docs/reference/javascript/auth)
- [Sign-out scopes](https://supabase.com/docs/reference/javascript/auth-signout)
- [SDK coordination migration](https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/migrations/lockless-coordination.md)
- [Official SDK releases](https://github.com/supabase/supabase-js/releases)
