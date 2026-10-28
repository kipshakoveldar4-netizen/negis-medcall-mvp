# Partner Company Commands: Requirements And Recovery Gaps

Date: 2026-10-28. Inspected repository: `medina-os`, branch
`codex/blog-publication-runtime-fix`, HEAD `f4c6cbe`.

## Scope And Status

This document specifies acceptance requirements, not implementation acceptance,
a migration proposal, a delivery plan, a design-QA report, legal approval or a
release decision. Its only authored file is this document. Main owns architecture,
125 and other migrations, the shared router, Auth, plans and design-QA reports.
The requirements below constrain observable behavior; they do not prescribe
125's schema, RPC names or endpoint layout, or assert that 125 already exists.
Do not rewrite historical 121 or 114 to satisfy these criteria.

The business journey is **captured original source -> confirmed applicant Auth
-> explicit company submission -> own status/command recovery -> platform-only
review -> new company with separate first-payment eligibility**. A foundation,
an issued link, an application or a company approval does not complete G6.
Whole G6 still includes the previously recorded onboarding/consent/Auth gates,
payment provenance and approved sandbox/security work, refunds and payouts;
none is waived or relabelled as out of G6 by this local increment. Those external
gates are not authorization to perform external work in this task.

Only local source inspection and document checks were performed here. No SQL,
application suite, browser, real Auth confirmation, provider or external service
was exercised. No Production/cloud access, environment-file access, real account,
working clinic, Baspana, WhatsApp, message, charge or spend is permitted. Future
local proof below must use synthetic identities/notices, owned loopback resources
and disposable native PostgreSQL, with unexpected outbound requests rejected.

## Inspected Baseline

| Surface | Actual behavior at the inspected base | Consequence |
| --- | --- | --- |
| [121 company SQL](../migrations/121_partner_company_approval.sql), lines 57-148 | Private application table; immutable applicant/company/email/consent submission; application ID is the submit request ID; exact submit replay; applicant-scoped status read. Approved reads additionally check current active owner membership. | Useful foundation, not a command journal or a complete applicant recovery journey. |
| 121, lines 150-202 | Review checks original revision, reviewer, request and action on exact terminal replay; approval atomically creates a new workspace, settings, original applicant owner membership and source reservation. Rejection creates none. | CAS and replay already exist. Do not describe 121 as having no idempotency or no concurrency protection. |
| [114 terms SQL](../migrations/114_partner_terms_activation.sql), lines 55-66, 156-239 | Actor/key journal with stored intent/result; read returns committed, abandoned or unconfirmed; explicit close shares execution's advisory lock and records an abandoned key when absent. | Existing model for lost-ACK recovery and durable non-execution closure, absent from 121. This is a behavioral reference, not permission to reuse terms authority for company commands. |
| [Terms handler](../lib/crm/partner-terms.ts), [attempt storage](../artifacts/negis/src/lib/partnerTermsAttempt.ts), [command hook](../artifacts/negis/src/lib/usePartnerTermsCommand.ts), [actual terms UI](../artifacts/negis/src/components/contributors/PartnerTerms.tsx) | Strict result matching; opaque actor/side/profile/request/action metadata persisted before dispatch; exact write body retained only in memory; read/explicit close after reload; retired view ownership cannot revive. | Reuse these established safety properties where appropriate, not a promise that the company path already implements them. |
| [Entry handler](../lib/crm/partner-entry.ts), [entry cookie](../lib/crm/partner-entry-cookie.ts) | Notice/prepare/capture and Auth-gated claim/read; signed Secure/HttpOnly/Lax cookie scoped to `/api/crm/partner-entry`; original timestamp/deadline binding. | A sibling company endpoint will not automatically receive that cookie. A secure server-controlled handoff is still required. |
| [Entry UI](../artifacts/negis/src/pages/PartnerEntry.tsx), [client](../artifacts/negis/src/pages/partner-entry-client.ts) | Anonymous notice/prepare/capture only; explicitly says no workspace was created. Unknown prepare body is in memory, not durable across reload. | Source capture is not company submission. A surviving cookie is not itself a complete reload/replay UI contract. |
| [Authorization registry](../lib/crm/authorization.ts), [shared router](../api/crm/%5B...path%5D.ts) | Existing identity-only bootstrap and separate platform gate; no inspected runtime caller for 121's submit/read/review RPCs under `api`, `lib` or either frontend tree. | Company handlers, protected queue/detail/read/receipt boundaries and actual connected forms remain unaccepted. |
| [Consent registry](../lib/site/consent-registry.cjs), lines 3-27 | Canonical resolver is deliberately `createSiteConsentRegistry([])`; synthetic factories do not activate it. | Both attribution and company-registration notice purposes need separate decisions. No configuration label, browser snapshot or hash-valid arbitrary text can approve a notice. |
| [Existing company cases](../scripts/fixtures/partner-company-approval-cases.mjs) | Cover pending/exact retry, invalid input, atomic approval/rejection, own-company and old-workspace isolation, rollback, late approval, cleanup/ACLs and two SQL sessions reviewing. | Source inspection of these tests is not a rerun. Their ordinary SQL replay and review-lock cases do not establish lost HTTP ACK, reload, close-before-execute or company UI acceptance. |

The earlier [link acceptance](PARTNER-LINK-ENTRY-ACCEPTANCE-2026-10-28.md) and
[link criteria](PARTNER-LINK-ENTRY-CRITERIA-2026-10-28.md) retain their own scope.
Their terms/link/browser counts are not new company-command evidence. The G6
definition and 121 checkpoint remain in [DELIVERY-CYCLES.md](DELIVERY-CYCLES.md),
G6-C10/G7-C63, and [OPERATORS-AND-PARTNERS.md](OPERATORS-AND-PARTNERS.md).

### Concurrent Work Is Not A New Acceptance Receipt

During this review, Main-owned uncommitted work appeared: 125 introduces
submission/review closure fences, fenced wrappers around the original 121
writers, bound command reads and a platform list; company contracts and actual
applicant/control components introduce read/close recovery. The Auth change
derives optional `emailConfirmed: true` from the verified response's
`email_confirmed_at`. These sources were read only. Their appearance is useful
progress, not proof of protected dispatch, effectiveAuth enforcement, native
race behavior or connected browser acceptance. The baseline observations above
refer to inspected 121/114 and HEAD, not a claim that concurrent work is absent.

Main's fence-based 125 design need not clone 114's full journal. A stable bound
command identity/outcome can be returned alongside a separately identified
current application snapshot; that snapshot may legitimately change with review,
expiry or payment. Tests must distinguish those two truths, not demand that a
live snapshot stay byte-identical or treat its changed state as a new command.
All remaining verification requirements below still apply to the final candidate.

## Actual 121 Recovery Gaps

These are concrete limits of the inspected implementation, not observed attacks
against a service. Preserve its existing atomicity and terminal immutability.

1. **No durable closure of an absent attempt.** 121 locks
   `partner-company-command:<request>` during submit/review but exposes no
   command read/close and stores no abandoned-key fence. A missing application,
   pending queue row, timeout or generic unavailable result cannot establish
   that a delayed original request will never commit. Clearing local storage,
   closing a dialog or changing the request key would not close that race.
2. **Status is not a command receipt.** `partner_company_result` (lines 91-105)
   returns current application revision/state/company/sourceState/expiry, not
   reviewer request ID, action, original decision revision, reviewer identity
   or an immutable command result. A queue refresh showing approved cannot prove
   that this reviewer's request won. Another review may have won instead.
   Applicant read (lines 136-148) is neither a platform command receipt nor a
   platform queue/detail API. Passing a fabricated applicant UUID is not a fix.
3. **Exact replay is not an immutable acknowledgement.** Submit calls
   `claim_growth_partner_source` before checking an existing application (lines
   119-128); that helper rechecks current referrer authority and, when bound,
   owner membership. A previously committed submission can therefore become
   unreplayable after revocation. It still requires the source capability, while
   browser cookie expiry can remove it. Its replay returns current state after
   a review, not necessarily the original pending response. Review replay also
   recomputes `partner_company_result`: sourceState can change at expiry or after
   payment. Preserve current authorization checks, but separate safe historical
   command resolution from current business-state refresh.
4. **Missing/foreign read is not proof of rollback.** Applicant read raises
   `P1211` for absent or foreign applications and has no unconfirmed/closed
   command outcome. A read before a delayed submit is admitted does not fence
   that future admission. After approval, disabled owner membership denies own
   read; denial must hide private data without erasing an unresolved key or
   labelling its command cancelled.
5. **Reviewer's original intent is not recoverable from the result alone.**
   121 stores `decision_request`, `decision_revision` and `reviewed_by` internally
   and exact terminal replay checks them (lines 165-170). However, reload may
   lose the original decision revision/action, and the result omits them. Do
   not reconstruct an old decision using the now-current revision or infer its
   identity from whichever row happens to be selected in the queue.
6. **Foundations trust the service boundary.** SQL validates structure but
   cannot prove the submitted email is confirmed Auth contact, the consent is
   canonical, or `p_owner` is platform-allowlisted. Its only reviewer identity
   input check is non-null. Application RLS/revoked table access are necessary,
   not a replacement for a protected caller. Existing SQL tests supply synthetic
   UUIDs/contact/notice directly; they do not test those HTTP/Auth boundaries.

125's Main-owned design must resolve these gaps, including old-writer admission
and explicit unknown closure. Merely wrapping the three 121 RPCs in HTTP,
persisting a UUID, or disabling a submit button does not resolve them.

## Auth And Consent Boundaries

### Effective Auth Is Server Authority

Here `effectiveAuth` means the required resolved Auth identity, contact and
confirmation decision at command admission, not a trusted browser field or a
claim that a named helper already exists at `f4c6cbe`.

- [Auth verification](../lib/auth/server.ts), lines 157-225, verifies the Bearer
  against Auth and returns immutable ID plus optional email. It deliberately
  ignores metadata for authority. HEAD did **not** inspect an email-confirmation
  timestamp; the concurrent change noted above adds that parsing, not yet an
  accepted company admission gate. Main must define and enforce the applicant
  confirmed-email gate server-side; absent, ambiguous, unconfirmed or unavailable
  proof must block new submission. An SDK session alone is not proof of the
  required policy.
- Use the current verified subject for applicant/owner identity. Main must
  specify how original server-verified contact is bound to the submitted intent,
  including missing/changed Auth email and exact replay after a contact change.
  An editable contact field is data, never ownership/confirmation authority;
  reject attempts to choose `p_actor`, owner UUID or reviewer in a browser body.
  Matching email strings is not proof of company ownership or the same person.
- [Contributor signup](../artifacts/negis/src/pages/ContributorPortal.tsx), lines
  35-74, directly invokes Auth signup with a `/contributors` return and a
  no-session confirmation message. That is a contributor journey, not company
  owner onboarding or evidence of deployed confirmation policy. Preserve
  [disabled registration](../api/auth/register.ts): it returns 410 and creates
  nothing. Do not re-enable it, route company onboarding through an unmounted
  legacy register handler, or perform automatic Auth signup on a referral visit.
- Define safe same-origin return/callback behavior through confirmation, expired
  callbacks, reload, account changes and another device. Passwords, bearer
  tokens, capabilities and contact details must not enter return URLs, logs or
  the recovery journal. Confirmation never restarts attribution time. If the
  original capability did not survive a device change, do not claim it was
  restored; already committed own application recovery is a separate problem.
- New applicants may have no staff membership. Submit/own recovery need an
  authenticated applicant boundary, not a requirement to pick an existing
  workspace. Existing memberships do not become target company choices.
  [Workspace selection](../artifacts/negis/src/components/WorkspacePicker.tsx)
  and [membership resolution](../lib/auth/server.ts) must continue protecting
  ordinary staff CRM without obscuring the separate applicant journey.
- Platform authority remains [the verified allowlist gate](../lib/auth/platform.ts),
  not a staff `owner` role, email, metadata, selected workspace or UI tab. Empty
  allowlist denies. The shared router gates platform routes before method/body
  dispatch and makes authorization refusal indistinguishable from not found.
  Queue, detail, decision, receipt read and close must all preserve that boundary.
  Main must explicitly define in-flight revocation semantics; a non-null SQL
  `p_owner` must not be described as an independent SQL allowlist recheck.

### Notices Stay Disabled Unless Approved Separately

Attribution (`partner_attribution`) and registration
(`partner_company_registration`) are separate explicit choices. Registration
needs its own complete canonical text, version, purpose, policy revision/link
and binding, presented before an unchecked consent control. The server resolves
the canonical snapshot; browser-supplied text/hash/purpose is not authoritative.
121's structural/hash validation alone is not registry approval.

Keep the actual empty registry unchanged. Missing, changed, wrong-purpose or
unavailable notice blocks new business admission with truthful unavailable copy
and no application/workspace creation. Fixture-only synthetic notices must be
explicit injections and never become a runtime fallback. Reads of an existing
authorized application/receipt must not require silently agreeing to a different
notice or resending a submission. Main must specify safe receipt/closure behavior
when new business admission is disabled; closure is not fresh consent or a new
company action. No legal-law claim, approved wording, statutory period or
compliance certification is supplied by this document.

## End-To-End User Requirements

| Step | Required result and safe controls |
| --- | --- |
| Captured source -> applicant | Continue using the original server-controlled source/capability and unchanged deadline. Main must bridge the cookie's path restriction without exposing its capability/hash to JavaScript, copying it into query/localStorage, widening cookie scope casually or accepting an arbitrary browser source UUID. Missing/invalid/expired capability is not permission to capture a replacement source. |
| Company draft | Collect only 121's supported company shape: name, ownerName, purpose, purpose-consistent vertical and valid timeZone, with current server/contact/consent decisions. Explain the actual original deadline and zone, not a fresh seven-day promise. No workspace selector, status, payment date, commission or reviewer input. |
| Explicit submit | Persist a bounded original attempt identifier before one guarded business dispatch. Pending creates exactly one immutable application and zero workspace/settings/staff/payment/referral/commission/payout rows. Submission confirmation says received/pending review, not approved or paid. |
| Own status | Applicant can recover only their application using an opaque original identifier or a separately authenticated own-only discovery contract selected by Main. Pending, rejected, approved, unavailable and expired attribution are distinguishable without revealing other applicants. Cookie expiry must not erase a committed application's own recovery path. |
| Unknown submission | Preserve original key; provide check-result and, where still possible, exact original retry. Reload restores metadata, not an automatic write or a reconstructed private draft. If exact payload is gone, offer read/explicit closure under the agreed protocol, not a new-key resend. |
| Platform queue/detail | Use a separate protected, bounded, paginated review read. Opening/selecting a row reads its current revision; stale queue data cannot authorize a decision. Pending/empty/loading/error/denied and already-reviewed detail states are real, not fabricated metrics. |
| Review confirmation | Explicit approve/reject confirmation binds application, original revision, action and reviewer lifetime. Cancel dismisses only the confirmation. One guarded request cannot be retargeted by row selection, queue sorting, pagination, focus refresh, logout or A-B-A. |
| Review recovery | Lost ACK/reload recovers the original review command independent of current queue selection. A competitor's approval is current application truth, not this command's success. Closure does not reject an application, undo approval or withdraw a submission. |
| Approved/rejected outcome | Approval yields exactly one new workspace, two required settings, one active owner membership for the original applicant, and the original-source reservation/payment-window record. Rejection yields none of these. Replays add none. Existing workspaces/memberships remain unchanged. Own workspace access is refreshed from server memberships, not granted from a stored response or browser-selected workspace. |

Use the existing portals/transports and their lifetime conventions, not a
standalone happy-path mock. [ContributorPortal](../artifacts/negis/src/pages/ContributorPortal.tsx)
uses actor epochs; [CRM transport](../artifacts/negis/src/lib/api.ts) checks
`expectedUserId`/dispatch guard around token lookup; [Control transport](../artifacts/medina-control/src/lib/api.ts)
guards actor revision and response-body reads. A company path must compose
these protections with its own command and selected-application lifetimes.
Abort means stop observing, not proof that a dispatched transaction rolled back.

## Required Command Recovery Contract

Main selects exact types and transport, but all three command origins (submit,
approve, reject) must satisfy the same observable rules:

1. Bind each admitted operation to original verified actor, operation kind/side,
   target/source or application, expected revision where applicable, and exact
   server-resolved intent. Reuse of a key with another actor, target, action,
   revision, email, company payload or consent binding cannot retarget it or
   inherit another result. Equivalent normalization must be defined once, not
   recomputed differently for an uncertain replay.
2. Distinguish **current application status** from **original command outcome**.
   Command reads must identify the original request and its bound scope/action,
   and return a validated committed receipt, durable closed/non-execution
   outcome, or explicitly unconfirmed result. Wrong/extra/missing fields,
   partial 200, malformed JSON, wrong key/target/revision/action, transport
   failure or a denial do not clear an unresolved attempt or imply non-commit.
   A historical receipt must not be presented as current eligibility/access.
3. Persist only bounded opaque recovery metadata before dispatch and verify that
   persistence succeeded. Storage unavailable, corrupt, oversized, wrong actor
   or conflicting existing metadata blocks new admission. Do not persist full
   company/contact/consent text, passwords, tokens or capabilities as a shortcut.
   Identifier/digest storage is linkable, not anonymous. Exact payload may remain
   only in the original in-memory attempt unless Main explicitly approves a
   separate bounded private design. Reload must not reconstruct and replay it.
4. A plain read that finds nothing remains unconfirmed. Explicit close must
   serialize with admission/execution on the same logical command identity. If
   commit wins, close returns the matching committed receipt without undoing it.
   If close wins, durable closure prevents the delayed original business action
   from ever executing under that key. Repeated close/read/replay preserve that
   outcome. Loss of the close ACK is itself recoverable under the original key.
5. Close confirmation names its meaning: stop an unconfirmed attempt, not cancel
   a saved company or decision. It must not require restoring sensitive payload
   after reload merely to fence that attempt. A new intentional command can be
   considered only after validated terminal resolution and fresh business state;
   it still obeys source uniqueness, terminal decision and revision constraints.
6. Original attempt ownership survives network errors and focus/list refresh.
   Only a validated matching terminal result may consume its exact stored marker;
   failed clearing leaves new admission blocked. Actor change, sign-out pending,
   unmount or denial hides private data and retires callbacks without dropping
   the unresolved original marker. Returning to actor A creates a new lifetime;
   callbacks from the earlier A must never dispatch, clear a key, clear a newer
   draft, publish success/denial or release another attempt's busy state.
7. Revalidate current authority for receipt reads/replay/close. Historical result
   possession is not renewed data/workspace access. Main must define safe denied
   recovery, lost/corrupt metadata, cross-tab collisions and independent-device
   discovery; do not promise automatic cross-device recovery from sessionStorage.
8. Close cannot be bypassed by an old 121 writer, an alternate RPC/route, direct
   table/column grants or key expiry/cleanup. Main must reconcile legacy admission
   and migration compatibility, retaining RLS/private helpers and fail-closed
   behavior when coordinated schema is missing. Do not delete fences to make
   a late key writable. The established [operator recovery contract](OPERATOR-COMMAND-WORKFLOW-2026-10-27.md)
   supplies useful precedent, not automatic company acceptance.

## Queue Versus Own-Read Privacy

Applicant reads are scoped to the verified applicant, not a body email or an
applicant UUID chosen by a reviewer. Pending/rejected applications remain own
data after attribution expires. Preserve or explicitly reconcile 121's approved
active-owner check; do not weaken it to make recovery green. An owner-access
denial hides data while retaining unknown-command metadata. Any additional
minimal receipt visibility needs an explicit authorized contract.

The platform queue is a separate cross-tenant privilege. Its list/detail fields,
counts, filters, page bounds and retention must be explicit and minimal. A
regular company owner, another applicant, referrer or creator cannot list it,
probe its totals, recover someone else's decision or use the applicant reader
as a queue. Opaque application IDs are identifiers, not authorization tokens.
Referrers do not gain applicant email/name, registration consent or company
review details through partner ledger/history; retain the own financial-event
projection in [122](../migrations/122_partner_history_read.sql).

Authorized review may need stored contact and consent evidence, but return it
only through the explicit platform detail contract, not list rows by default.
Never return capabilities, Auth secrets or allowlist contents. Apply no-store
to success/error/receipt/private list responses and do not share them through
generic caches, exports, analytics or error logs. Denial, focus revalidation,
filter/page/selection changes and actor A-B-A must retire private snapshots
before delayed results can render. Define retention/deletion/withdrawal and
closure-fence lifetime separately; cookie expiry is not database erasure, and
121's purge deliberately preserves submitted pending/rejected applications.

## Approval Is Not Payment

[120](../migrations/120_partner_first_paid_window.sql), lines 71-183, separates
reservation from a qualified paid referral. Keep these concepts separate in
the data, UI and acceptance assertions:

- Original capture is anchored by 113's server-bound start; `Tend = T0 + 168
  hours`. Login, email confirmation, submit/retry, review, workspace creation,
  reload and close must not reset `T0`, `Tend` or the first source.
- Timely approval can be `approved` plus `pending_payment`. Approval creates
  neither a subscription payment nor paid referral, commission or payout. A
  success page, manual subscription status or reviewer action is not payment
  evidence. This document authorizes no provider, payment or payout integration.
- 121 permits approval after expiry: create the company, retain the original
  capture/expiry, and report `approved` plus `expired` eligibility, not a renewed
  seven-day offer. The new workspace was created after the deadline; 120's
  `paid_at >= workspace.created_at` and `paid_at < Tend` cannot both qualify a
  subsequent legitimate first payment for that late-created workspace.
- For a timely-created workspace, only a trusted synthetic first-payment event
  satisfying `paid_at >= T0`, `paid_at >= workspace.created_at` and `paid_at <
  Tend` can qualify. Exactly at `Tend` is ineligible. Processing after `Tend`
  may still confirm a genuinely in-window event for that timely-created
  workspace; it is not permission to backdate an event for a late-created one.
- First payment outside the window cannot be rescued by renewal, a new key or
  changed browser time/source. Exact payment replay retains its prior outcome.
  The partner's own new company is allowed under the same existing rules, not
  a special bypass. Only an actual qualifying ledger result changes paid metrics.

## Verification Required Before Local Completion

Every row below is an unexecuted acceptance requirement for the implemented
company slice. Main records executable receipts and design QA separately.

| Layer / scenario | Required evidence |
| --- | --- |
| Auth/disabled boundaries | Actual compiled router denies anonymous, unconfirmed/missing confirmation, foreign applicant, forged actor/email/source/workspace/reviewer, ordinary owner and empty/nonmatching platform allowlist. Confirmed synthetic applicant and authorized synthetic platform reviewer succeed only on their respective paths. Auth/notice/schema unavailable fails closed without fallback or orphan rows. |
| Canonical consent | Real empty resolver stays disabled; explicit synthetic notice injection covers complete presentation, unchecked default, refusal, wrong purpose/version/hash and change before dispatch. No visit, login, reload or checkbox default creates an application. Historical own recovery is not transformed into fresh consent. |
| Submit atomicity | Actual protected submit/read with native SQL: one pending application and immutable original identity/consent; zero new workspace/settings/staff or financial rows. Exact retry adds none; changed payload/key/source/actor and existing-workspace attachment fail safely. |
| Committed lost ACK | For submit and both review actions, establish native commit, then drop the actual loopback HTTP response. Reload actual components, restore the same opaque key, read original receipt and prove exact cardinality/unchanged timestamps. A normal success followed by another SQL call is not lost-ACK evidence. |
| Unknown read then delayed original | Hold admission before commit, obtain an unconfirmed read, then release the original. Show why read alone is not cancellation and that new-key admission stays blocked. Include the original request arriving only after the read. |
| Both close lock winners | Native independent connections establish commit-first/close-second and close-first/execute-second for submit/approve/reject. Assert committed matching receipt or durable non-execution respectively; delayed/replayed originals cannot mutate after close. Include close ACK loss/reload and repeated close. Do not infer the winner from sleep timing. |
| Review contention/CAS | Two reviewers compete, including approve versus reject, same-key exact retry, changed action/revision/target and key collision. One terminal application winner; losing command is not reported as its own success. Queue refresh cannot rebase or resend the old decision. |
| Native rollback/security | Force settings/staff/reservation failure and verify complete rollback, no orphan workspace, unchanged pending revision and safe same-key recovery. Check exact migration rerun/dependency drift, RLS, table/column/function and inherited grants, denied legacy writers and coordinated missing-schema failure without weakening tests. |
| Revocation/denial | Revoke referrer approval/commercial activity, applicant owner membership after approval, or platform access as defined by Main's in-flight contract. Check queued/waiting requests and receipt/close recovery. No private payload on denial, no erased unknown key, no claimed SQL allowlist recheck that does not exist. |
| Browser lifetimes | Actual application/control parents and real transports cover slow token/session lookup, delayed response and body parsing, unmount/remount, sign-out pending, A-B-A, selected application A-B-A, queue pagination/filter/focus changes and refreshed revisions. Old callbacks cannot write, display private data or consume/release another attempt. |
| Persistence/fault contracts | Blocked/corrupt/oversized storage, pre-existing marker, failed marker clear, absent in-memory payload after reload, two initial tabs, malformed/partial/wrong receipt, timeout and denied recovery all retain safe blocking. No automatic business resend on mount, focus, reload or Auth callback. |
| Privacy/read separation | A different applicant, referrer, staff owner and nonallowlisted reviewer cannot discover applications, counts, contact/consent or command outcomes. Own read survives submitted-source cookie expiry where authorized; platform uses its own queue/detail contract. Private GETs/receipts are no-store and do not inherit another actor's cache. |
| Business/financial separation | Approval/rejection/replay/close create zero payment/referral/commission/payout rows. Isolated synthetic 120 cases cover just-before/exact expiry, late processing of an in-window event, late-created workspace, ineligible first payment then renewal, duplicate key and own-company case. Preserve exact original source/time and unrelated workspace snapshots. |
| Native end-to-end | Actual styled React -> actual transports -> compiled shared router/handler -> service boundary adapter -> owned native PostgreSQL with the reviewed raw migration chain including Main's candidate. Only explicitly named Auth/notice/challenge dependencies are synthetic. A SQL-only run, mocked RPC success or screenshots alone cannot pass this row. |
| 375 and 1440 | At **375 x 900** and **1440 x 1000** CSS pixels, capture actual applicant draft/consent, pending, unknown/read/close, rejected, approved+pending-payment, approved+expired, and platform queue/detail/confirmation/recovery, plus empty/error/denied states. Use actual application CSS/assets, not a picture or boundary-double child. Verify the connected native recovery path at both widths. |
| Interaction/layout | Keyboard navigation, labels, visible focus, announced status/error, explicit confirmation, non-overlapping controls, at least 44px interactive targets, long company/email/notice/error wrapping, reachable submit/close and 200% zoom reflow. Assert no horizontal overflow or clipped controls at both widths; visually inspect screenshots, not just CSS declarations. |
| Fixture lifecycle/regressions | Record precise current revision, chain and synthetic dependencies; fail on unexpected outbound traffic; check existing terms/link/history/Auth/workspace-selection regressions and relevant builds. Preserve failed runs and explain fixes. Owned servers/browsers/databases finish cleanly; no unrelated output or process is cleaned up. |

No completion credit is earned by adding test names, reusing historical counts,
passing only a foundation suite, or leaving a required native/browser case as
an undocumented mock. Local command completion requires all applicable rows
with explicit limitations. Real confirmed-email/callback policy, approved
canonical notices, abuse controls, data lifecycle, deployment/schema acceptance
and payment/refund/payout readiness remain individually open where unverified.
They are not silently closed by synthetic success. Main retains the broader G6
plan, readiness decision and design-QA reports.

## Decisions Still Owned By Main

Before this slice can be called complete, Main must settle the secure
cookie-to-company handoff; effectiveAuth confirmation/contact/replay semantics;
125's bound command receipt and explicit closure protocol; legacy admission
compatibility; denied/in-flight revocation handling; applicant identifier
rediscovery versus platform queue/detail projection; cross-tab/device limits;
notice-change recovery; and retention/withdrawal/fence lifecycle. These are
explicit unresolved decisions, not fixture defaults or legal conclusions.

For any later package verification use only pinned
`C:/Users/Lenovo/AppData/Local/node/corepack/v1/pnpm/10.33.2/bin/pnpm.cjs`
with `login:false`. No package command is needed for this documentation pass.

Preservation baseline: dirty `migrations/059_site_blog_drafts.sql` SHA256
`c56c820f9b29b28f96de34b51cb63af44f29be207b7c76740c491c9811aaae47`;
dirty `migrations/065_operator_arrival_attribution.sql` SHA256
`ccc908b1a91126540b78dedcbfb75ae86e191d057fbeeeb4742241e8a0c61984`.
Inspected 121 SHA256 is
`c07f599caca533412618f4a7875fccc4891582356396e9b549b487a19e06749d`.
All three were read/hashed only; `output/` was not written or cleaned.
No implementation, SQL, shared plan, design-QA report, staging or commit was
performed. Document checks cover source links, ASCII, whitespace/final newline
and the one-file write boundary; they are not application acceptance.
