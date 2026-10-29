# Portal Entry: Local Acceptance

Date: 2026-10-29. Parent candidate: `79ad38e`.

Historical UI-lifetime cycle, committed as `0f7b410`. The subsequent native SDK
commit-boundary candidate and its separate acceptance limits are recorded in
[AUTH-SESSION-AUTHORITY-ACCEPTANCE-2026-10-29.md](AUTH-SESSION-AUTHORITY-ACCEPTANCE-2026-10-29.md).
Counts below describe this earlier frozen source, not the subsequent candidate.

This is a local candidate, not a Preview or Production release. No cloud,
database, account, password, policy, provider, advertising, payment, Baspana,
salon or WhatsApp setting was changed. Protected 059/065 and the CRM/Meta
server files retain their original raw hashes.

## Implemented Boundaries

- Generic workspace selection now quarantines the previous read context,
  rechecks the original actor and exact target against fresh memberships,
  and applies the fresh role and purpose. A cached candidate grants nothing.
- Target revocation, malformed responses, actor/token changes, navigation,
  sign-out and obsolete callbacks cannot publish the old selection. Transient
  failures may retain candidate labels for another explicit fresh check, not
  permissions or private reads. A failed selection has a visible retry path.
- Workspace choice does not overlay the operator/contributor/company-entry,
  referral, legal or password-reset routes. A newly returned single candidate
  can still be selected explicitly after losing the original target.
- Both external-role portals subscribe before session lookup. Bootstrap
  rejection, returned errors and synchronous SDK throws settle neutrally.
- Both login/signup forms claim one attempt synchronously and clear password
  state before dispatch. Mode and credential changes cannot start an overlapping
  request. Retained callbacks are retired after completion, account change or
  unmount; late result handlers cannot refill another form.
- Portal sign-out delegates to the existing AuthProvider. Private callbacks,
  forms and operator profile transports are retired before delegation. A local
  exit tombstone prevents late refresh/login events from reviving the same
  retired portal root, including after a provider failure.

Existing signup validation and literal same-origin `/operator`/`/contributors`
email redirects were preserved. This is not a new company-signup flow or a
change to email-confirmation, CAPTCHA or consent policy.

## Test Layers

`pnpm run test:portal-auth-entry` runs actual transpiled roots/provider with
closed synthetic hooks, SDK, children and transport boundaries. It includes the
prior owned-company handoff cases plus generic selection, role/purpose changes,
revocation, actor ABA, delayed tokens, navigation and retry cases. Original
profile tests now explicitly answer the additional fresh selection request;
they no longer assume a cached choice is synchronous authority.

`pnpm run test:portal-auth-entry-browser` runs the actual App, SessionContent,
AuthProvider, routes, both portals, WorkspacePicker, transport guards and CSS.
Only SDK/session persistence and the three read-only HTTP routes are doubles.
At 375/1440 it checks forms, duplicate submission, password clearing, picker
exclusion, held reads, failed sign-out/retry and cleanup. All unknown services,
HTTP mutations and external browser requests are refused.

The design fixture and native partner-terms UI fixture now explicitly supply
a synthetic `useAuth().signOut` boundary. They do not silently load the real
provider/SDK or imply new real-Auth acceptance. The separate composed browser
suite above tests actual provider delegation.

## Important Unresolved SDK Boundary

A separate characterization uses the installed Supabase Auth SDK 2.105.4 with
only custom fake fetch and in-memory storage. It proves that a delayed password
sign-in can persist/emit its session before the caller's result guard, and a
delayed sign-out can remove a newer SDK session. No real network is used.

The UI tests above do **not** prove cancellation or atomic ownership of these
SDK persistence operations. Do not describe their green result as a complete
cross-tab authentication fix or approval for public signup. The next security
cycle must reproduce this through the composed application and fence the SDK
commit boundary, not weaken the characterization or conceal it behind a simple
promise double.

## Final Local Receipts

- `test:portal-auth-entry`: 472/472, exit 0.
- `test:portal-auth-entry-browser`: 15/15, exit 0. Its final source-pinned run
  includes the characterization above; that passing characterization proves
  an unresolved SDK behavior, not its mitigation. The composed UI cases use
  the explicitly simpler SDK double.
- `test:portal-ui`: 1071/1071, exit 0.
- `test:portal-design`: 15/15, exit 0, including a bundle-only compatibility
  check of the native partner UI fixture. Native SQL was not rerun in this
  frontend-only cycle and no new native business acceptance is implied.
- Normal `build`: exit 0, API typechecking in both configured module modes,
  all seven workspace typechecks and 449 compiled cold-start checks. Existing
  source-map/chunk warnings remain; they did not fail the build.

These sets overlap and are not a sum or readiness percentage. Logs are under
`node_modules/.cache/portal-final-test-*.log` and `portal-entry-build-main.log`.
The browser test recorded closure of its browser, HTTP listener, held replies,
React subscriptions and build service. Only the explicit synthetic preview
at `http://127.0.0.1:5262/` was retained for the user.

Initial local failures were not release evidence: the new test callback needed
a TypeScript narrowing guard, the selection callback needed an explicit return,
and old fixtures assumed synchronous cached selection/raw SDK exit. Those
fixtures now explicitly answer fresh reads and supply a synthetic provider
boundary. The repeated final commands above passed after runtime freeze.

## Approved Designs And Browser Evidence

The three approved references remain
`output/design-concepts/contributors-2026-10-28/{operator-workspace,blogger-partner,content-creator}.png`.
The existing visual baseline was reused, not rebuilt or replaced by new concepts.

Manual IAB captures are in `output/design-qa/approved-portals-2026-10-29/`.
Each page has a separate desktop and mobile image. Checked interactions include
the operator mobile drawer/group selection and opening/closing a creator job.
`iab-observation.json` records the final mobile overflow/image/console check.
The fixture uses synthetic data and no real Auth/API. Screenshot API pixels
differ from CSS viewport dimensions; record that normalization before comparing.

Overall design/product acceptance remains the explicit result in
`design-qa.md`. Neither screenshots nor unit counts mean full mock parity,
public signup, approved legal notices, real payments or a cloud release.

## Remaining Gates

1. Finish the actual SDK persistence race above and verify real isolated Auth.
2. Resolve company applicant signup, confirmed-email/callback and abuse policy.
3. Approve canonical consent texts, retention and operational financial evidence.
4. Complete the remaining honest product gaps in `design-qa.md`, including the
   undefined operator contact-success/next-contact metrics.
5. Review the exact accumulated candidate before any separate approved cloud
   migration or release. Current working businesses remain untouched.
