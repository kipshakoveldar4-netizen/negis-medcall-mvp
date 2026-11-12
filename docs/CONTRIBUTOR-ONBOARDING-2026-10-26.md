# Operator And Blogger Recruitment: Intake Milestone

27 October local follow-up: [partner statistics](PARTNER-LEDGER-2026-10-27.md)
adds an own read-only report after separate commercial activation. It does not
close the first-source/referral, payment/payout or creator-job gates below.

26 October 2026. Local implementation only, base f3b69fd.
The owner selected BOTH blogger roles: partner acquisition and content creation.
This receipt does not claim public recruitment/commercial readiness.

## Current Local Status: 28 October

The local design baseline is saved in `b2c92d0`: operator suite 733/733 after
resolving the eight earlier fixture failures, combined UI 126/126, browser
24/24 and final capture/navigation 9/9 at 375/1440 with synthetic Auth/API.
The full build exited 0. These overlapping suites are not added together;
they do not prove real Auth, payments, cloud acceptance or overall readiness.
Full mockup parity remains blocked (`design-qa.md`: `blocked`): the confirmed partner
link is still absent. At that checkpoint shared operator analytics/agenda were
also absent; the current local 123/API/UI cycle implements them with complete
server authority, not inbox-page sums. See [current workday evidence and gates](OPERATOR-WORKDAY-ACCEPTANCE-2026-10-28.md).
The next local 124/API/Explorer slice adds complete authorized lead search,
company/group filters, exact counts and independent report lifetimes. Final
759/759 cumulative native, 1052/1052 UI, 1447/1447 operators and 31/31 local
browser results retain their separate synthetic/HTTP/native boundaries. Full
browser-to-native mutation and cloud acceptance remain gates; see
[exact search evidence](OPERATOR-LEAD-SEARCH-ACCEPTANCE-2026-10-28.md).
The later [connected local actions receipt](LOCAL-READINESS-ACTIONS-2026-10-28.md)
adds 15/15 Explorer -> actual HTTP -> native SQL cases and 14/14 creator cases,
including lost acceptance acknowledgement/reload. The selected mutation gate is
now covered locally; full Portal/real Auth, public intake and cloud remain open.
The preceding local cycle
adds protected own history (SQL 122) and the creator's current-page nearest
deadline: 25/25 native/HTTP, 186/186 parser/isolation, 25/25 root boundary and
28/28 actual browser cases at 375/1440. These overlapping suites are not summed.
See [exact evidence and limits](PARTNER-HISTORY-ACCEPTANCE-2026-10-28.md).
No cloud application of 122 or release is claimed.

Company approval 121 is a separate local backend foundation in `2e2a951`, with
cumulative native 694/694 on 113 raw SQL files 009–121, not HTTP wiring or an
accepted company-onboarding flow. Real Auth/allowlist, consent, recovery/review
and two-user acceptance remain gates. These SQL receipts do not supply browser,
payment, public legal or cloud proof for 121.

Current partner policy requires the **first actual subscription payment within
the original 168 hours** from the first confirmed capture. Application, approval,
company creation and sign-in neither satisfy nor restart that window. Historical
27 October registration-based descriptions are superseded, not current rules.
The agreed first-payment 10–50% and renewal 5–10% ranges are unchanged; no
individual rates, legal terms, real payments or payouts are activated here.
See [current partner rules and local boundaries](OPERATORS-AND-PARTNERS.md).

The dated receipts below preserve the earlier milestones, not new acceptance
of this baseline or the work in progress. This documentation pass reran no tests
and authorizes no deploy/cloud/env, real accounts, working data or paid requests.

## Working Scope: 26 October

- Existing /operator application, moderation, availability and scoped clinic
  cooperation remain the operator path. Only a cross-link was added there.
- New /contributors: personal-email sign-in/sign-up, name, up to five optional
  public HTTPS portfolio links, either or both requested roles, independent
  pending/approved/suspended application statuses. Existing users can request
  the second role without replacing their identity or resetting a review.
- Login exposes both entry points. The exact independent /contributors route
  suppresses only the irrelevant no-clinic toast; it does not grant membership.
- Actual Medina Control has a Bloggers section: paginated applications, safe
  external portfolio links, separate approval/suspension for each role. The
  verified platform-owner boundary is not a clinic's owner/admin staff role.
- POST identity comes only from verified Auth. Client-supplied identity,
  approval, workspace, commission and financial fields are rejected. DTOs omit
  auth IDs, review actors and all clinic/customer records. No server-side URL
  fetch or portfolio preview. API responses are no-store.
- Migration 105 is a standalone additive intake table plus two service-only
  JSONB RPCs. It needs existing anon/authenticated/service_role roles and built-in
  gen_random_uuid; it has no dependency on 052. RLS is enabled with no browser
  policies, direct browser grants or service direct-write grants. Applying does
  not create Auth users, memberships, growth_partners, referrals, rates or money.
- Repeated applications preserve review and identity. Adding a role cannot
  remove another. Review locks the row and requires the exact UUID revision;
  a stale decision returns an explicit conflict rather than overwriting it.
- Account/epoch changes unmount private forms; late application and owner-review
  responses cannot publish into another or returned account. Focus refresh
  hides the old profile before authoritative reading. SDK auth is not faked in
  production source; it is replaced only in the separate local test fixture.

## Acceptance: 26 October

- 18/18 in-memory PostgreSQL/contract/API VM tests, no external clients. Cover
  both roles, replay, additive roles, stale reviews, denial of browser table/RPC
  access, verified identity, ordinary clinic-owner denial, DTO/error sanitizing.
- 4/4 including parent on owned native PostgreSQL 17.11. Concurrent applications
  produce one identity with the union of roles; concurrent same-revision reviews
  have exactly one winner and one P1052 conflict. Pre-existing synthetic financial
  data unchanged. Owned native database/server removed after verification.
- Real React browser suite: 8/8 including parent, 375/1440 screenshots and a
  maximum-length unbroken name at 375. Actual ContributorPortal and Control App,
  full local CSS, fake auth/API,
  fresh owned Chromium profile, no app env/config and self-only CSP. This is not
  real Supabase email delivery, an HTTP catch-all integration or cloud acceptance.
  Final screenshots are in
  `node_modules/.cache/contributor-browser/run-3qok6P/`: application-375.png,
  application-1440.png, blogger-375.png, blogger-1440.png, review-375.png and
  review-1440.png (375/1440 CSS pixels,
  DPR 1; encoded PNG heights 900/1000 respectively). Inter is checked loaded.
- Full build passes both API module modes, all types, Vite and the expanded
  compiled catch-all suite: 169 normal/broken-renderer auth/denial checks. New
  cases include contributor identity scoping without membership, redacted DTOs,
  denial of platform review to clinic roles, explicit owner access and extra-path
  refusal. This uses fake Request/Response/Auth/storage, not a real HTTP server.
- Fixed no-network regression 931/931, same 41 readers/network/IPC guards. Only
  the reviewed exact-route addition changed the AuthContext reader fingerprint.
  New contributor suites are separate, not silently added to that fixed runner.

## Local Demo

Run `node scripts/fixtures/contributor-browser.mjs --port=5264` from repo root.
`http://127.0.0.1:5264/contributors` is the application; `/review?seed=1` opens
the actual Control shell with one fictional blogger (select Bloggers).
The demo uses disposable in-memory module data, not any real account or database.
Reload clears local test actions; it is not evidence of database persistence.
Database persistence/replay are separately exercised by the SQL suites.

## Gates Before Recruitment

### Creator Workflow Foundation: 27 October

Base 7a99757. New local 110 and shared creator-job contracts extend the existing
workspace/staff/contributor identities. They are not another CRM, Auth system,
public site or replacement contributor portal. At this foundation milestone no
HTTP route or UI consumed it. The local API follow-up below adds routes;
UI, cloud schema and deployment remain unaccepted.

- An active owner/admin can offer an approved creator a scoped job with explicit
  title, brief, rights terms, exact positive minor-unit fee/currency and UTC
  deadline. These terms cannot be edited after creation. Individual commercial
  or legal terms are not invented, published, signed or activated by this code.
- The creator can accept the exact terms revision or decline; after acceptance,
  submit public HTTPS references. The company can request changes or approve the
  current submission. New submissions keep previous versions. Cancellation is
  limited to unaccepted offers; post-accept disputes/termination need a separate
  agreed workflow. Result approval does not book a payment, debt or payout.
- Four private RLS tables store jobs, submissions, immutable command intents
  and events. Service has no direct table access; three narrow service-only RPCs
  perform commands, paginated reads and outcome inspection. Internal helpers
  are not callable by browsers or service. Existing 105 profile writers are
  pinned; current profile/staff authorization is locked before job mutation.
- Revision conflicts cannot overwrite another action. Same-key retries compare
  the full original intent, reauthorize and return the original applied revision
  with the current job; a lost acknowledgement cannot duplicate work. A receipt
  read waits for the same request fence. Revoked users cannot replay/read it.
- DTOs omit workspace/Auth/reviewer identifiers and raw request intents; strict
  parsing rejects incomplete/contradictory state, unsafe links, extra fields,
  invalid times and inexact money. Links are references only: no URL fetching,
  file import, Content Studio access or paid generation was added.

110 raw SHA-256: `87097453d461654253841ea057c7e0e6c3523e1a109a0f72d5ae3b75e0eb2615`.

Evidence: contract tests 8/8; outward-effect source review 46/46; root typecheck;
fixed no-network 931/931 with the same 41 readers/key set/network and IPC guards.
The exact raw 009-110, 102-file native chain passes 353/353, including previous
workflows and final bodies/RLS/ACL/defaults/all-table-empty checks. The final
focused native command passes 29/29, adding a final independent partner-versus-
creator approval probe after that cumulative run; SQL source is identical.
Eight actual lock waits cover approval and Auth rebinding, staff revocation and
workspace change, duplicate create, pending outcome read, accept/cancel and
changes/approve. All use owned fictional PostgreSQL records, not real Auth,
Supabase, API identity or an email/Storage/media/merchant service. Required
handles terminated and owned clusters/data were removed; protected 059/065
and the old user demos remain unchanged. No API/Vite build or browser acceptance
is newly claimed: application imports and screens did not change.

Next: approved-creator directory; company and author
controls in the current cabinets, exact terms confirmation, current company
display context and submission history, unknown-outcome recovery, real session
and mobile/desktop tests. Then attest the chosen isolated Preview/schema/ACL.
Public legal terms, retention/tombstones, asset verification/private delivery,
accepted-job disputes and recruitment approval remain separate gates. The
intake-only creator card is deliberately not labelled as a working job cabinet.

### Creator Job API: Local Follow-Up

Base f84afb0. Four paths were added inside the existing catch-all and deny-by-
default registry; no new Vercel function, database change or cloud release:

| Route | Methods | Boundary |
|---|---|---|
| creator-jobs | GET/POST | Verified own Auth; no membership or caller-selected tenant |
| creator-job-command | GET | Verified own Auth and original requestId |
| clinic-creator-jobs | GET/POST | Verified active workspace owner/admin context |
| clinic-creator-job-command | GET | Same workspace context and original requestId |

The handler forwards only verified actor/workspace/staff to 110. Body identity,
role/payment fields and extra selectors are rejected; each side has only its
actions. Required keys/revisions/terms are not generated or defaulted by the
server. Reads/denials are no-store. A malformed or mismatched receipt (including
request, job or immutable create terms) is unconfirmed, not success. Original
applied revision and current replay state remain distinct. Database errors are
mapped to safe Russian responses without retries or diagnostic leakage.

Actual compiled catch-all cold-start coverage includes normal/broken optional
site rendering, anonymous/invalid tokens, own approved creator without clinic
membership, pending/revoked creator, company owner/admin and doctor denial,
foreign tenant/extra path/method rejection. Auth and database are doubles here,
not real Supabase sessions or a native HTTP-to-PostgreSQL integration. The
separate 110 native workflow evidence above is not relabelled as that integration.
Root build/typecheck/Vite and 269 compiled checks pass; focused contract/API
tests 29/29, six-file regression 208/208. These overlapping counts are not added.
Current mortgage purpose policy is unchanged and still denies these company
routes; creator approval does not open marketing, Content Studio or clinic data.

Still needed: directory and scoped company/history read models; real controls
and retained unknown-outcome recovery in the current cabinets; actual HTTP/native
bridge, account-switch/browser/mobile acceptance and exact isolated Preview.
The owner's seven-day target is recorded in DELIVERY-CYCLES; it does not waive
the remaining legal/retention/payment/rollout gates or authorize working clients.

### Creator Stop Fence and Scoped Read Models: Local Follow-Up

Base b859e1d. An actual 110 PostgreSQL reproduction read a missing command
receipt, then applied the delayed original create. Missing is not stopped.
Candidate 111 reuses the existing operator closure model rather than adding
a second prepare protocol: an actor/key advisory lock coordinates execute,
read and explicit close. Close returns the real committed result or installs
a private stop fence; a delayed same-key writer then cannot create a job.
It never cancels a committed job or waives exact original-intent comparison.
Mixed receipt/fence state is unconfirmed and rerun refuses it atomically.

The existing command routes now also accept POST only for the closed
`operation: close` metadata contract. GET/POST use v2 envelopes: unconfirmed,
committed or abandoned. Null/v1/contradictory replies are not cancellation.
All seven creator routes, including router-level Auth/role/method denials,
are no-store. Identity still comes only from verified Auth/company context;
current mortgage-purpose restrictions and other staff permissions are unchanged.

New exact GET paths are `creator-directory` (company owner/admin only),
`clinic-creator-job-detail` and `creator-job-detail`. The directory returns
approved display/portfolio fields, not Auth or review data. Detail returns
current company display context and a contiguous submission history page of
20, without another company/author or a silent partial history. No URL fetch,
asset upload, paid generation, payout or legal acceptance was added.

111 revokes service execution of the legacy 110 writer/command reader and
keeps all private tables/helper closed. Adoption needs coordinated API/schema
and a stopped/drained legacy writer, not mixed old and new instances. It is
local only, not permission for a cloud migration. Raw SHA-256:
`ca00557aafe4bab78a8e7643ad45ab4bea3d292ebd0f0ad2010f13f18e425a7f`.

Evidence: 47/47 source review, 40/40 contract/API, selected six-file regression
202/202, fixed 931/931 with the unchanged 41 readers and isolation guards.
Focused native 50/50; exact raw 009-111, 103-file cumulative native 376/376.
Six real lock-wait cases, legacy receipt compatibility, same-key conflicts,
revocation/rebinding, strict directory and 22-version history pass. The first
111 attempt failed/rolled back on a PL/pgSQL alias and was corrected before
the passing runs; no partial installation is claimed. Root build/types/Vite
pass, compiled cold-start 41+130 normal and 41+129 broken optional site (341).
Auth/DB doubles at the HTTP layer are not a real Supabase or native HTTP/PG
bridge. Owned clusters were cleaned; protected 059/065 and user demos remain.

Next is the actual company/author UI with a metadata-only retained attempt,
exact same-key in-memory retry, and read/close after losing the original body.
Never persist raw briefs, fee terms or URLs in browser storage. A new key
cannot be silently substituted while the original outcome is unknown.
Cross-device metadata loss, retention and support remain explicit gates.
Screens, real sessions, mobile/desktop acceptance and an attested isolated
Preview are still unaccepted. No working client, cloud setting or expense changed.

### Creator Screens: Local Follow-Up

Base 10cc427. The ordinary AdminCenter now has a creator tab; the existing
ContributorPortal mounts own assignments only for approved creators. Mortgage
navigation/policy is unchanged, with explicit negative coverage for the new tab.
Company selection, original explicit terms/fee/deadline/rights, author acceptance,
submission links, revision feedback, immutable version pages and explicit final
acceptance are wired to the scoped APIs. Unaccepted offers can be cancelled or
declined; acceptance is not a payment or a Content Studio entitlement.

Each mutation first retains only actor/workspace/request/action/target metadata
in sessionStorage. The raw body exists only in memory; retry uses the identical
original key and body. On remount, only read/close are available. Unknown cannot
unlock a new command; a typed committed/stopped result clears only its matching
descriptor. Corrupt/unavailable storage blocks admission. No raw brief, amount,
rights terms, deliverable URLs or credentials are persisted in browser storage.
This is not cross-device or cross-tab global admission or a retention policy.

Reads/actions bind expected actor and current scope. Denial clears private forms
without an automatic retry loop. Unmount, StrictMode, A-B-A and cancelled reads
retire old handlers. Terms consent pins termsRevision, approval confirmation pins
revision; retained handlers cannot act after unchecking consent, closing a form
or cancelling confirmation. Deadline input and display explicitly use the device
zone, persisted as UTC. Exact decimal input supports KZT/USD/EUR without Number
rounding; other currencies in existing data are explicitly shown in minor units.

Evidence: 11/11 real React/StrictMode installed-browser tests with fake Auth/API,
375/1440 controls/overflow and inspected screenshots, full happy path, exact
large fee, 22 versions (20/2), lost acknowledgement/idempotent retry, remount
read, explicit unknown close, delayed A-B-A and 403. This is not real identity,
native HTTP/PG or cloud acceptance. Contract/API/journal 47/47; parent/role
regression 104/104 plus focused creator forwarding 1/1; prior contributor and
Control/partner browser 13/13. Root types/API module modes/Vite/cold-start 341
and unchanged fixed 931 isolation checks pass. SQL and previous native evidence
are unchanged, not re-labelled as a UI or integrated database result.

A local fictional demo is at http://127.0.0.1:5266/company?demo=1. Its explicit
role switch keeps the UI double in one document; reloading resets that model's
jobs, not a real database. No working account, provider or private client file
is used. Actual HTTP/native integration, exact isolated Preview/schema/ACL and
real sessions, recruitment/legal/retention gates remain open. No Production,
Baspana, salon, WhatsApp, cloud setting, paid generation or expense changed.

### Creator Compiled HTTP / Native Acceptance

Base 5baf5a3. `test:creator-jobs-native-http`, explicit
`MEDINA_TEST_POSTGRES_NATIVE=1`, now runs the real CreatorJobs/client transports
through owned HTTP and the entire compiled CRM catch-all into real service-role
PostgreSQL. Actual server Auth/membership/role/purpose code stays in the bundle;
it resolves staff/workspace from native SQL, not an attached test context.
Only the Auth authority and browser SDK session are synthetic. This is not JWT
cryptography, Supabase/PostgREST, email, cloud ACL or Vercel Protection evidence.

The raw reviewed 009-111 chain (103 files) is applied without SQL rewriting to
the owned attested PostgreSQL 17.11 cluster, with only the established minimal
Storage catalogues. The SDK adapter allows two narrow read-only identity/purpose
tables and six current creator RPCs, no direct creator collection or legacy
writer. The compiled server's fetch allows only its fixed fake Auth authority;
browser traffic stays at the owned loopback origin. No provider/real token or
environment-selected database may be used.
The owned HTTP fixture caps raw input at 32 KiB before dispatch; it does not
attest the published API's body budget or early input termination. That remains
a separate G8 pre-release check rather than an implied result of this matrix.

13/13 integrated cases prove closed raw JSON/selectors, real company owner/admin
and doctor denial, independent approved creators, purpose narrowing and safe
Auth/read failures. Administrator creates, replays exactly, cannot change the
original intent, cancels, and loses receipt access after revocation. Another
allowed company actor cannot adopt that command. Full 375/1440 workflow creates
exactly one job, six commands/events and two immutable submissions, preserves
900719925474099301 minor units, and denies the other creator/workspace.

Real dropped create/submit HTTP replies survive actual document reload and
strict receipt inspection without another business row. Reload before the
original executes, followed by explicit close, fences its late delivery with
zero jobs/commands/submissions/events. Held A-B-A replies cannot publish stale
success. Revocation after router permission but before SQL saves nothing and
removes private forms; malformed committed replies remain unconfirmed until
read. A raw SDK identity change before parent notification is blocked by the
real client transport before HTTP. Metadata, cache and private diagnostic
checks remain intact; no payment, commission or payout was made.

All owned public business rows, browsers, HTTP servers and cluster are cleaned.
Current build/type modes/Vite/cold-start 341 and unchanged fixed 931 pass.
Prior full SQL 376-case evidence is unchanged, not relabelled as this matrix.
The first integration attempt caught incorrect fixture setting/column names,
which were corrected without relaxing the purpose refusal. Application code,
SQL, protected 059/065 and user demos did not change in this test-only cycle.

This closes the selected local HTTP/native gap, not the whole rollout. Exact
isolated Preview, actual runtime/schema/ACL/legacy-writer drain, real identities,
public legal/retention/support and recruitment release acceptance remain.
Partner first-source/company intake and merchant sandbox are still open. No
Production, Baspana, salon, WhatsApp, cloud setting or expense changed.

1. Isolate and attest a new Preview's build/runtime test database before applying
   105 there. Inherited/shared Production settings remain forbidden. Then test
   real sign-up email redirects, application/review and two-user session changes.
2. Approve the actual public legal/personal-data terms, retention and applicant
   support/contact process. No new contract is published or accepted in this cycle.
3. Partner commercial activation remains separate from application approval:
   individual rates, trustworthy first-source capture and new-company intake,
   immutable binding, actual payment receipts, own scoped ledger and manual
   payout receipt. Do not advertise a dead referral URL or registration as income.
4. Creator operations remain separate: scoped briefs, application/selection,
   deliverables, review/revisions, content rights and explicit fees. An approved
   creator application in the current cloud release grants neither the new job
   cabinet nor paid Content Studio; the local candidate still needs isolated
   integrated and cloud acceptance.
5. Recruitment rollout needs its own release approval. No Production, Baspana,
   working salon, WhatsApp/Wazzup, cloud schema, real applicant, ad or expense
   changed. Operators' existing safeguards were not relaxed to accelerate intake.
