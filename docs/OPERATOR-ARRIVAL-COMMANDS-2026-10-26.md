# Operator Arrival Commands And Portal Session Lifetime

G1-C7, 26 October 2026, base 1731c9a. Local only. The previous turn was
progress: it committed and verified original video-quota ACK recovery. This
turn advances the original G1 action/revocation and operator readiness scope.
No Production, cloud Preview/database/configuration, Baspana, salon, WhatsApp,
real account, advertisement, provider, paid generation or expense changed.

## Reproduced Failures

The arrival/control-call component had only a rendered busyId, with no
synchronous command owner. Reinvoking a retained handler could send two writes
before the disabled render. A list refresh/page reset busyId while the first
request was unresolved. Starting another row also unlocked the original row.
Old handlers captured currentView at invocation, so they could acquire a newer
view after actor/request/page/data changes instead of rejecting their old view.
The expanded composed baseline had 245 passes and 20 failures, all 20 new cases.

The independent OperatorPortal also did not pass its already existing
profileEpoch/currentUserId lifetime to OperatorRequests. Five new parent tests
failed at that missing boundary; the prior 15 profile tests passed. A batched
A -> B -> A or focus invalidation must expire a descendant before React commits,
not only after a replacement key eventually unmounts it.

## Narrow Runtime Changes

- Each arrival confirmation/control-call row gets a synchronous owned attempt
  before rendering or token lookup. A refresh/page retires reply publication,
  not the still-pending row lease. The exact settled owner alone releases it.
- Different rows remain independently actionable. All control-result choices
  for one arrival share that row's owner; settling row B cannot unlock row A.
- A handler is bound to its rendered view and actor/path lifetime. It cannot
  adopt a replacement view at invocation, including an actor/request return.
  An old completion cannot release a replacement actor's same-ID command.
- Same-scope 401/403 still hides protected data and revalidates authority, even
  after a newer page/refresh. Non-auth old outcomes cannot replace its data,
  errors or newer list read. Ordinary current success still refreshes normally.
- OperatorPortal forwards its actual profile epoch/user predicate through the
  existing requests/arrival/lead parent chain. Raw identity/logout/ABA and focus
  invalidate synchronously; same-actor TOKEN_REFRESHED remains usable.

Only two application UI files change. No API, database schema, role, rate,
price, arrival accounting rule, subscription, native helper or provider changes.
No browser storage or automatic retry is added.

## Evidence Boundaries And Harness Corrections

The composed runner executes actual nested component/hook/transport sources in
a controlled host-tree model. It covers repeated retained handlers before
render, pending row ownership across refresh/pages, independent concurrent rows,
stale handlers, queued lookup cancellation, actor replacement and existing
access-denial chains. It is not React DOM, Auth or database proof.

The new browser runner bundles the actual OperatorArrivals, operatorApi,
crmFetch and serverAuth with actual React. Only SDK sessions and replies are
synthetic. Owned Chromium runs at 375 and 1440 CSS pixels: pending refresh/page
with success/503/network failure, separate rows, canceled queued lookup, A -> B
and A -> B -> A with a new pending command. CSP/network allow only the owned
loopback document/bundle; no external HTTP is performed. It tests controls and
transport behavior at those sizes, not styled screenshots or physical devices.

The portal runner executes the actual parent with hook/JSX boundaries. Its five
new cases prove forwarding, immediate epoch retirement and permitted token
refresh; child execution is separately proven by composed/browser cases.

Adjacent stale tests required explicit corrections, not weaker production guards:

- Two queued-refresh expectations now permit only the exact settled live row
  lease's one busy-state release. They still forbid dispatch/content/errors and
  verify that the fresh row is unlocked with exactly one original request.
- The old action-denial fixture tried to start a second unresolved same-row
  write after refresh/page. It now proves that the first remains busy, then
  exercises its late refusal or suppressed non-auth outcome and a legal later
  action. Actor/scope/remount isolation and independent-row concurrency remain.
- Its existing request-specific 409 expectation predated C42/C6. A refused
  agreement retains only its non-contact summary during refresh; its protected
  panes close and fresh GET alone restores actions. Global authority is not
  falsely revoked. Unrelated-request preservation has its own actual DOM suite.
- The older AdminCenter parent fixture omitted serverAuth/Supabase imports
  already used by unchanged OperatorRequests. It now supplies the same token
  double/session that the actual parent transport uses, preserving wrong-actor,
  raw SDK ABA/logout and same-user refresh checks rather than bypassing them.

Final expanded source acceptance: 591/591 across nine test files, including 265/265
composed cases, 20/20 portal cases and 41/41 including parent in the new owned
Chromium suite. Smaller and intermediate sets overlap; do not add them together.
Full root build has terminal success: both API compiler modes, all library/app/
script types, 169 compiled cold-start/auth/denial checks and Vite. Existing
nonfatal tooltip sourcemap and mixed serverAuth import warnings remain.
Fixed no-network isolation: 931/931, terminal success. Its fixed test list,
41-reader hashes/key set and network/IPC guards are unchanged. All test/build
handles are terminal. Owned loopback servers/browser profiles are closed and
removed by their fixture cleanup; no owned test browser or test Node process
remains. Existing user demo servers on 5260/5264 are preserved. Protected raw
059/065 hashes match their original receipts and are excluded from this commit.
Earlier failing and pre-portal intermediate logs are not final acceptance.

## Remaining Gates

These are in-memory live-component command owners, not durable intent/outcome
receipts across a real unmount, reload, another device or an unknown committed
mutation. Network failure is not rollback; no automatic retry or exactly-once
claim follows from disabling a button. The durable operator command/reconciliation
decision and coordinated 094/096 current-target/session acceptance remain.

Current Preview isolation and dependency attestation, all other G1-G8 gates,
legal/commercial recruitment conditions and creator job/rights/fee workflows
remain separate. The original goal is active, not complete or redefined around
these two UI fixes. Protected 059/065 are not edited or staged.

Later G1-C8/G2-C17 [booking recovery](OPERATOR-BOOKING-RECOVERY-2026-10-26.md)
forwards that lifetime through the booking form and preserves uncertain booking
keys on access refusal. Selected original-commit/reload/revoked-reopen/account
replacement is proven through actual local HTTP and native SQL. This does not
make cooperation/proposal mutations durable or attest a cloud Preview.
