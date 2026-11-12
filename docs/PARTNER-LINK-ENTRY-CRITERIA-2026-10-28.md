# Partner Link Entry: Implementation Gaps And Acceptance Criteria

Date: 2026-10-28. Repository: `medina-os`; branch:
`codex/blog-publication-runtime-fix`. Inspected HEAD:
`cda3b749102c4038773467fd7b05b8a6886b4203` plus shared working changes.

## Scope And Decision

This is a read-only implementation-gap and abuse/privacy review, with this
document as its only write. It is not a test receipt, design-QA sign-off, legal
approval, migration approval, public activation or release decision. G6 remains
open. No whole-G6 pass or closed readiness registry is claimed.

The useful incremental boundary is **server-confirmed partner link -> explicit
attribution choice -> protected cookie -> confirmed anonymous source capture**.
That boundary does not complete applicant Auth, company submission/recovery,
platform review, company creation, subscription purchase, qualifying first
payment, commission availability or payout. A copied code alone is not a working
link, and a captured visit is not a registered or paid company.

No Production, remote service, environment file, real identity, clinic, Baspana,
WhatsApp, provider, payment or spend was accessed. Main owns backend architecture,
migrations and the shared CRM catch-all. No implementation, test, shared plan or
QA file is changed here. Other agents' concurrent changes are not this task's
work or accepted evidence.

## Source-Backed Inventory

Line numbers identify the inspected source, not a frozen future working tree.
The untracked link/entry files and concurrently changing router/frontend are
candidates, not an acceptance receipt or publicly enabled feature. The follow-up
read below includes UI wiring added while this review was being written.

| Surface | Observed implementation | Evidence |
| --- | --- | --- |
| Partner terms/code | Accepted terms can display and copy `referralCode`; the inspected component copies the code, not an issued URL. | [PartnerTerms.tsx](../artifacts/negis/src/components/contributors/PartnerTerms.tsx), lines 100-105 |
| Link candidate | `GET partner-link` verifies Auth, reads own partner terms, requires managed/accepted/active terms, and returns a parsed HTTPS configured-origin `/r/CODE` with profile/agreement revisions. It also requires entry configuration and a canonical attribution notice. | [partner-link.ts](../lib/crm/partner-link.ts), lines 10-37; [partner-link-contracts.ts](../lib/crm/partner-link-contracts.ts), lines 1-24 |
| Own-link UI candidate | ContributorPortal now mounts `PartnerLink` for an approved partner in overview/terms. It requests the issued URL, fences actor/profile/read lifetimes, revalidates on focus and copies only the current parsed response. The older terms code-copy control remains separate. | [ContributorPortal.tsx](../artifacts/negis/src/pages/ContributorPortal.tsx), approved-partner branch; [PartnerLink.tsx](../artifacts/negis/src/components/contributors/PartnerLink.tsx), lines 31-169 |
| Public entry UI candidate | `/r/:code` now mounts `PartnerEntry`. It loads notice, starts with unchecked consent, then explicitly runs challenge, prepare and capture. It has unknown-result and terminal-refusal states and explicitly stops short of company registration. Its transport exposes only notice/prepare/capture, not claim or company submission. | [App.tsx](../artifacts/negis/src/App.tsx), referral route; [PartnerEntry.tsx](../artifacts/negis/src/pages/PartnerEntry.tsx), lines 42-241; [client](../artifacts/negis/src/pages/partner-entry-client.ts), lines 1-37 |
| Entry gateway | Existing POST-only `partner-entry` operations are `notice`, `prepare`, `capture`, `claim`, `read`; exact origin, bounded JSON, notice binding and cookie checks precede business RPCs. Claim/read require verified Auth. | [partner-entry.ts](../lib/crm/partner-entry.ts), lines 85-137; [authorization.ts](../lib/crm/authorization.ts), entry route declaration |
| Cookie/time anchor | Origin-bound HMAC, random capability, path-restricted Secure/HttpOnly/Lax cookie; seven days from original `startedAt`, not from a later capture or login. SQL 113 preserves that anchor. | [partner-entry-cookie.ts](../lib/crm/partner-entry-cookie.ts), lines 3-62; [113](../migrations/113_partner_entry_anchor.sql), lines 47-72 |
| Canonical notices | `resolveSiteConsent = createSiteConsentRegistry([])` is deliberately empty. Neither an environment label nor a database snapshot approves a notice. | [consent-registry.cjs](../lib/site/consent-registry.cjs), lines 3-27; [receipt resolver](../lib/crm/site-intake-handler.ts), lines 13-23 |
| First paid | SQL 120 reserves eligibility separately from paid referral creation; a qualifying first payment must occur in the original 168-hour window. | [120](../migrations/120_partner_first_paid_window.sql), lines 71-185 |
| Company approval | SQL 121 implements authenticated-applicant submission/read and explicit platform decision foundations, not public HTTP/forms or Auth creation. No caller for its three company RPCs was found under `api`, `lib` or the two frontend source trees inspected. | [121](../migrations/121_partner_company_approval.sql), lines 1-4, 107-202 |
| Review authority | The review RPC trusts a service caller to supply a platform-allowlisted subject; a company `owner` role is not platform authority. | [121](../migrations/121_partner_company_approval.sql), lines 150-160; [platform.ts](../lib/auth/platform.ts), lines 103-112 |

The empty registry means the inspected production handlers cannot resolve their
required `partner_attribution` notice. The link candidate returns unavailable;
entry operations likewise fail closed even if configuration names are supplied.
This is a source conclusion, not a check of any deployment's settings.

### Candidate Boundaries Still Open

The new entry implementation is a meaningful local increment, not the previously
absent screen. Its strict parsing, explicit consent, separate prepared/captured
copy, abort/revision guards and original-deadline comparison are visible in code;
this review has not executed them or adopted concurrent agents' test results.

- Unresolved preparation retains its exact body in an in-memory closure only;
  unmount clears it. No reload recovery of that pending body or captured-state
  receipt is implemented by this component. A surviving valid cookie can still
  preserve the server's original intent on later preparation. Do not equate
  that property with a durable browser recovery journey.
- The notice view renders literal notice text and policy link, but not its
  version/policy revision as visible fields. Link copy's short seven-day note
  does not itself explain the original-entry anchor; recipient expiry appears
  after preparation. Required business-rule clarity remains an acceptance item,
  without changing the notice text or inventing approved terms.
- The challenge adapter loads its external script only after the user's start
  action and handles blocked/expired/abort outcomes. It is not suitable for a
  no-provider local run without injecting the synthetic challenge adapter.
  See [challenge adapter](../artifacts/negis/src/pages/partner-entry-challenge.ts),
  lines 17-99. No real challenge was executed here.
- Source CSS is not a viewport proof. The own-link copy/refresh icons are 40px
  square in [partner-link.css](../artifacts/negis/src/components/contributors/partner-link.css),
  line 14, below this document's proposed 44px target. Entry uses a 760px maximum
  width and 44px buttons in [PartnerEntry.css](../artifacts/negis/src/pages/PartnerEntry.css).
  Both needed actual changed-state 375/1440 evidence; no screenshot pass was
  inferred in this review. Main's subsequent acceptance raised the new icons to
  44px and records actual styled browser evidence separately in
  [the local acceptance receipt](PARTNER-LINK-ENTRY-ACCEPTANCE-2026-10-28.md).

## UX And State Map

The following is the required truthful journey, not a claim that all these
screens exist or pass. Keep attribution, company approval and payment separate.

| User step/state | Required UX and authority boundary | What it must not imply |
| --- | --- | --- |
| Partner requests link | Reread the current server-confirmed own profile/terms; expose copy only for a current valid response. Pending, denied, suspended, unavailable and clipboard-failure states remain distinct. | An old displayed code or accepted-but-now-suspended agreement is a usable issued link. |
| Recipient opens link | Validate the literal referral route/code; show entry purpose and the server-resolved notice before consent. A manual promo-code path is a separate explicit source choice. | Opening a GET link consents, creates a source row, or registers a company. |
| Notice loading/unavailable | No checked checkbox, disabled affirmative action until a complete canonical notice is available; provide a non-submitting exit. | A policy page URL alone, fixture text or a cached notice is approval. |
| Prepare | Explicit consent plus fresh successful challenge can set the protected cookie. Display only a prepared state and the original expiry. | `prepared: true` proves a valid active partner or a durable captured source. Partner validation occurs at capture. |
| Capture pending/unknown | Capture uses the cookie-derived original intent; on uncertainty retain an unconfirmed result and allow an explicit same-intent retry. | A timeout means failure, or a new code/intent is a safe automatic retry. |
| Captured | Confirm only the anonymous source and original deadline after a strict successful response. Provide an honest handoff/status, not a fake completed onboarding step. | Auth account, company application, owner membership, review approval or money exists. |
| Auth and claim | Sign in/create an applicant identity through a separately approved flow; bind only using current verified subject plus cookie capability. | Cookie possession or an email string grants company access. |
| Company submitted | Separate registration consent, verified applicant/contact snapshot and immutable exact request produce a pending application. | Submission creates a company or a payable referral. |
| Company approved/rejected | Approval creates a new workspace and original applicant owner membership atomically; rejection creates neither. Show application outcome separately from source/payment eligibility. | The partner is the reviewer, or an existing workspace can be silently attached. |
| Payment pending/qualified/expired | `pending_payment` means reserved but unpaid; `bound` in the SQL 120 window path means qualified referral. Expiry must name attribution eligibility, not falsely cancel an approved company. | Company approval, a subscription row or a success page proves first payment. |

### Expiry, First Source And Policy

- `T0` is the first prepared cookie's server `startedAt`, retained as SQL
  `captured_at` by 113. This is the consent/challenge preparation anchor, not
  necessarily the instant the recipient first opened the URL. Capture can occur
  later but cannot restart the clock. `Tend = T0 + 168 hours`.
- A valid existing cookie makes `prepare` reuse its deadline instead of changing
  code/source or refreshing expiry. Capture retries reuse the source associated
  with that intent. Do not show a newly visited partner/code as the confirmed
  source when the old cookie still wins.
- The demonstrated design is first-source preservation for the same protected
  intent and reserved workspace. SQL 112 has an actor index, not one unique
  lifetime source per human. Cookie deletion, another browser/device or another
  intent is not a proven global first-ever visitor identity. Do not promise
  cross-device attribution or silently stitch devices by email/fingerprinting.
- SQL 120 requires no prior payment for first qualification and an actual first
  `paid_at` in `[T0, Tend)`, also not before company creation. Exactly `Tend` is
  too late. Submission, email confirmation, review, approval and renewal never
  extend this interval. Confirmation may arrive later than an eligible payment
  event; its trusted provenance is a separate financial boundary.
- Approval within the window reserves the original source as `pending_payment`,
  without creating `growth_referrals` or commission. Approval after expiry may
  still create the company, but its source is expired; a subsequent legitimate
  payment cannot qualify because company creation itself was already too late.
- A late first payment can be recorded without referral commission. A later
  renewal cannot revive it. For a qualified first payment, later renewals retain
  the referral under the existing financial ledger. Exact payment retries retain
  their original result, including ineligible results.
- The repository's current product policy permits the partner's own **new**
  company on the same rules, not a self-company exception to review, new-company
  checks, payment or the deadline. This is a product rule, not legal approval.
  See [current policy](OPERATORS-AND-PARTNERS.md), lines 40-71. Do not add a
  blanket `applicant == partner` rejection or promise eligibility for an existing
  company. SQL 121 accepts no existing-workspace selector.
- Preserve the distinction between source/link policy
  `2026-10-27-7d-self-v1` and SQL 120 payment-window policy
  `2026-10-28-first-paid-7d-self-v2`. Their different identifiers do not justify
  displaying the obsolete claim that registration alone within seven days earns
  commission. Main owns any contract/version reconciliation.

### Cookie Recovery Limits

The cookie is `__Secure-medina_partner_entry`, with
`Path=/api/crm/partner-entry`, no Domain attribute, `Secure`, `HttpOnly`,
`SameSite=Lax`, and Max-Age/Expires based on the original deadline. It is signed,
not encrypted: its base64url payload contains intent, capability, code, source,
timestamp and notice binding. Do not describe it as anonymous non-sensitive data.
The browser UI must not read it or replace it with localStorage/query tokens.

The handler rejects duplicate/tampered cookies (400), a presented expired cookie
(410), a missing cookie for capture/claim/read (409), and changed notice
version/hash (409). Notice loading occurs before those cookie checks. The
handler currently has no clear/reset operation and does not clear an invalid or
expired cookie itself. A browser may simply discard it at expiry: then the
server sees missing, not a readable historical expiry. UI copy must distinguish
an observed expiry from an absent/unconfirmed source; it cannot reconstruct one
from a URL or restart an unresolved intent automatically.

This path restriction also means a future company endpoint on another path will
not automatically receive the cookie. SQL 121 submission requires a source and
capability hash, but there is no inspected HTTP bridge supplying those securely.
Main must choose a same-path command or another server-controlled handoff; do not
broaden the cookie or return its capability to browser JavaScript as a shortcut.

The current entry `read` is Auth- and cookie-gated, so it is not an anonymous
capture receipt lookup and cannot recover a browser-expired cookie. SQL 121's
applicant `read_growth_partner_company` can support later application recovery
without that cookie, but still needs its protected HTTP/UI integration and a
safe way for the original actor to recover the application identifier. Preserve
pending/rejected/approved application truth after attribution expiry.

## Actual Auth Paths, Not A Register-Route Assumption

- `ContributorPortal` calls `supabase.auth.signUp` directly with normalized
  personal email/password and `emailRedirectTo` set to `/contributors`; sign-in
  uses `signInWithPassword`. It displays a confirmation message when no session
  returns, then uses `contributor-account` for the separate contributor profile
  application. This is not SQL 121 company registration. Evidence:
  [ContributorPortal.tsx](../artifacts/negis/src/pages/ContributorPortal.tsx),
  lines 35-74 and 130-143.
- `OperatorPortal` also directly signs up through Auth with `/operator` as
  redirect; `JoinRequest` directly signs up/signs in for a staff join request.
  These are distinct role/join journeys, not a partner-company owner signup.
  Evidence: [OperatorPortal.tsx](../artifacts/negis/src/pages/OperatorPortal.tsx),
  lines 133-188; [JoinRequest.tsx](../artifacts/negis/src/pages/JoinRequest.tsx),
  lines 116-162.
- [api/auth/register.ts](../api/auth/register.ts) returns 410
  `self_registration_disabled` and creates nothing. The old Express
  [auth-register implementation](../artifacts/api-server/src/routes/auth-register.ts)
  remains on disk but is deliberately not mounted by its
  [route index](../artifacts/api-server/src/routes/index.ts), lines 11-35.
  Do not re-enable or use it to connect partner onboarding. Conversely, its
  disabled status does not mean all direct Auth signup is disabled.
- [server.ts](../lib/auth/server.ts), lines 183-213, verifies the Bearer against
  Auth and returns immutable `id` plus optional email. It does not check an
  email-confirmation timestamp. A missing-session message and redirect option
  in a client do not establish deployed confirmed-email policy. SQL 121 accepts
  UUID/contact inputs from its trusted service caller; it cannot itself prove
  verified email, company ownership or a permitted public enrollment policy.

Activation therefore needs an explicit applicant Auth/confirmed-email decision,
safe callback/return routing, server-side enforcement and recovery. The current
`/contributors` redirect must not be mistaken for a company-onboarding callback.
Frontend personal-email/password checks are UX checks, not an Auth anti-abuse
boundary against a caller using the public Auth API directly. No real Auth
account or email was created to assess these source paths.

## Abuse And Privacy Gaps

These are implementation boundaries and unresolved decisions, not findings of
exploitation against a running service or assertions of legal compliance.

| Boundary | Existing protection | Gap / required disposition before public activation |
| --- | --- | --- |
| Bots and resource exhaustion | Preparation checks a server-verified challenge with exact hostname/action, timeout and response cap. Entry bodies are capped at 8192 bytes; a local counter limits 60 requests/minute per handler instance. | Exact Origin is not bot identity. An in-process counter is not distributed per-actor/IP/global protection and can also be exhausted by other visitors. Decide edge limits, quotas, monitoring and fail-closed behavior before exposure; a local fixture must never call the challenge provider. |
| Replay and first-source overwrite | Random capability, origin-bound HMAC, SQL intent locks, immutable original source, current partner approval/activity checks, and exact decision/request checks. | Possession of a cookie is only a visit capability. Never accept browser actor, capability hash, company owner, reviewer, expiry or payment time as authority. Clearing cookies/new identities remain outside a universal first-human guarantee. |
| Competing initial tabs | Subsequent valid-cookie preparation preserves the existing source. | Simultaneous no-cookie preparations can issue different frames before either response is stored. No global first-tab winner is proven; require explicit race handling/evidence before stronger first-source copy. Do not hide the race with last-link-wins UX. |
| Platform review | SQL 121 decision CAS/idempotency; only service-role RPC execution; private application table and no direct browser table access. | `p_owner` is only checked for a non-null subject by SQL, not against the platform allowlist there. A protected caller must enforce the actual platform owner gate before every read/decision. No general staff/company-owner review queue is authorized. The queue/list API is not supplied by 121. |
| Consent integrity | Entry binds canonical notice version/hash; 121 stores an immutable registration-consent snapshot and SQL validates its structure/binding. | Attribution and company registration are separate purposes. Canonical content is empty; no actual wording, withdrawal path or policy revision is approved by this review. Entry capture RPC arguments do not persist a full attribution-consent receipt; cookie notice binding alone is not proof of a durable receipt/withdrawal workflow. Main/owner must decide that record and lifecycle requirement. |
| Applicant data and recovery storage | 121 separates applicant identity, company JSON, email and consent; terminal decisions are immutable. | Restrict owner name/email, application IDs, consent and company details to applicant/platform review; do not add them to partner statistics or public errors. Recovery storage should retain only necessary actor-bound identifiers, not passwords, bearer/cookie tokens or full sensitive payloads. Exact retry payload retention needs an explicit bounded design. |
| Retention/deletion | 121-adjusted purge removes only expired unbound sources without applications, in batches of 1-100. | Submitted applications preserve their source, including expired pending/rejected rows; linked workspace sources are not purged here. No complete application deletion/withdrawal/retention workflow or scheduled executor was found in inspected runtime callers. Cookie expiry is not database erasure. Decide retention and access-safe deletion; do not invent a statutory period. |
| URL/referrer/log leakage | API responses are no-store; link/entry handlers set noindex/nofollow and nosniff. The HTML shell already has a no-referrer meta tag; new entry fetch/script/policy-link operations explicitly suppress referrers. The analytics sanitizer excludes arbitrary referral pageviews. | The inspected HTML still says `index, follow`; the hosting routes have no dedicated referral no-store/noindex headers, and the entry component does not scrub its referral URL from history. `WebAnalytics` is mounted globally on the eligible origin, with no route-level opt-out; dropping a pageview is not proof the analytics script never initializes. Require page-level no-store/noindex, no-referrer preservation, route-level analytics/pixel exclusion and safe in-memory URL cleanup. Review ingress log retention/redaction separately; client cleanup cannot undo the initial request. No tokens/PII in URLs, telemetry or console. |
| Revocation and stale UI | Source RPCs recheck current approved profile/active commercial partner; existing terms UI fences old views. | A copied link is not perpetual authority. Issued link, capture, claim and approval can later be refused. Hide stale own-link/private applicant/review data on denial, focus revalidation or actor A-B-A; delayed replies and clipboard completions must not publish into a replacement view. |
| Financial claims | 120 delegates to the existing immutable payment/commission ledger; company approval itself has no financial write. | No merchant signatures, trusted transaction provenance, refund protocol, payout execution or commercial release is supplied by a link/capture increment. Browser success pages, manual subscription assignment and fabricated `paid_at` must not stand in for evidence of payment. |

Public-shell observations above come from [index.html](../artifacts/negis/index.html),
[hosting routes](../vercel.json), [WebAnalytics.tsx](../artifacts/negis/src/components/WebAnalytics.tsx),
the [analytics sanitizer](../artifacts/negis/src/lib/web-analytics.ts), and the
entry component/transport already linked. Existing no-referrer protection is
credited; page cache/indexing, script initialization and ingress logs are not
treated as solved by the API's headers or sanitizer alone.

## Concrete Acceptance Criteria

These are **future pass/fail requirements**, not completed tests. Both viewport
sizes use CSS pixels at device scale 1: **375 x 900** and **1440 x 1000**. Exercise
actual changed components/routes; a static mock or parser suite alone cannot
prove the connected UX. Existing unrelated screenshot/test receipts do not pass
this new journey.

### Entry Increment At Both Sizes

1. In the approved partner's actual terms view, a valid current issued URL is
   selectable and can be copied. Clipboard success is announced only after the
   clipboard resolves; denial/failure gives a truthful message. A current code
   can remain available as a code, never relabelled as a confirmed URL. Pending,
   stale revision, suspended, unauthorized and unavailable states offer no
   usable stale link. A retained action from actor A must not copy after A-B-A.
2. Direct navigation and reload of a synthetic `/r/CODE` resolve the actual entry
   screen without opening a company workspace or private portal. Reject malformed
   paths and unknown/inactive partner capture without revealing partner identity,
   application existence or other-company data. No Auth signup is automatic.
3. With a fixture-only canonical notice, show its complete text, purpose, version
   and usable policy link; consent starts unchecked. Visiting, scrolling, closing,
   pressing Back or refusing performs no prepare/capture write. Only explicit
   consent plus successful synthetic challenge permits preparation. The real
   empty registry instead shows unavailable, with no synthesized notice, cookie
   or business write. Challenge blocked/expired/error states never show success.
4. Preparation success displays a prepared state only; capture success requires
   the real response contract. Delay/drop a capture acknowledgement after local
   commit, then retry the original cookie/intent: keep the same source and original
   expiry, with no new company/payment/referral/commission/payout. No automatic
   new-intent resend on reload, network failure or malformed JSON.
5. Follow partner A, then link/promo code B with the existing valid cookie. The
   confirmed source/deadline stay A's, including across preparation/capture retry.
   Present duplicate/tampered/expired cookies and changed notice hashes: show
   safe refusal, never a new countdown or success. Missing-cookie/cookies-blocked
   and cross-device states say unconfirmed/unavailable, not falsely restored.
   Separately exercise simultaneous first tabs without claiming a proven winner.
6. Expiry shows an absolute date/time with explicit zone and any countdown derives
   from that same server deadline. A fixture at the boundary treats `Tend` as
   expired. Later sign-in/confirmation never resets it. Completion copy says the
   source is captured, not that a company is approved or a payment was received.
7. All changed controls work by keyboard with visible focus, real labels and
   announced pending/error/status changes. Copy icon buttons have accessible names
   and hover/focus help. Interactive targets are at least 44 x 44 CSS pixels;
   disabled pending actions cannot double-submit. No checkbox is a consent default.
8. At 375, page content stays within the viewport with at least 16px side insets;
   long code/URL, full notice, longest error and expiry text wrap without horizontal
   scrolling or overlapping controls. Natural vertical scrolling is allowed, but
   consent and submit remain reachable and no fixed footer covers them. At 1440,
   the form is a readable unframed column, maximum 760px wide, with no giant hero
   or stretched inputs. At both sizes inspect all control/text bounds, 200% zoom
   reflow, focus rings, loading and longest-content states; do not infer fit from
   a screenshot of only the happy path.

### Separate Company/Payment Acceptance, Not Credited By Entry

9. Applicant submission must use a current verified Auth subject/contact and a
   separately resolved `partner_company_registration` snapshot. The fixture-only
   authenticated flow reaches real 121 submit/read through the protected caller.
   Pending submission creates exactly one application and no workspace. Exact
   same-key retry after lost acknowledgement/reload recovers that result; changed
   payload/key/actor cannot become a second or retargeted submission. An expired
   cookie must not erase access to an already submitted own application.
10. At both sizes, the platform-only review view shows current application revision
    and explicit approve/reject confirmation. Two decisions on one revision have
    one terminal winner; original exact replay recovers it. Forged reviewer/body
    roles, ordinary company owners and another applicant reveal nothing. Denial,
    reload, lost reply and A-B-A do not apply a retained decision to another row.
    Approval creates exactly one new workspace/owner membership/reservation;
    rejection creates none. No existing workspace is accepted as an attachment.
11. Show approved-company status separately from `pending_payment`/expired source
    status at both sizes, including approval after `Tend`. A local synthetic
    trusted payment fixture covers first payment just before and exactly at
    expiry, late confirmation of an in-window event, repeat key, renewal after
    ineligible first payment, and the partner's own new company. Only the genuine
    qualifying SQL result can change paid-referral/commission display. This is
    not permission to integrate a real provider or manufacture a live payment.

For any future executable proof, isolate owned loopback/disposable resources,
synthetic identities, notices and challenges; reject all unexpected outbound
requests. Preserve the canonical empty registry. Record actual screenshots,
request/state transitions, exact source/deadline and unchanged financial-table
snapshots for the entry increment, without putting secrets or personal data in
evidence. Report each layer independently, not a combined readiness percentage.

## Activation Blockers And Safe Next Slice

Public activation remains blocked by real canonical notice approval for both
purposes; an explicit applicant Auth/confirmed-email policy and safe callbacks;
distributed abuse protection; a secure cookie-to-company command handoff;
authenticated submit/read/recovery; protected platform review/list/decision UX;
retention/withdrawal/data-access decisions; and isolated deployment/schema/ACL
acceptance. Payment provenance, provider/security review, commercial terms and
payout readiness remain separate gates. This task neither verifies nor changes
deployment configuration and does not grant legal approval.

The smallest safe next local slice is to finish the in-flight issued-link and
actual recipient notice/prepare/capture UI end to end, stopping at a truthful
captured-source state. Keep the real registry empty and disabled behavior intact;
use synthetic injected notices only inside owned fixtures. Avoid automatic Auth
signup, arbitrary redirects, workspace selectors and all financial writes. Main
integrates backend/catch-all changes; disjoint UI work follows that contract.

The next business-complete slice after that is verified-applicant **submit ->
own status/recovery -> platform review -> new company with pending/expired
eligibility**, using 121 and 120 without replacing historical SQL. Main must
first specify the protected handoff, reviewer queue/read contract and Auth gate.
Neither a working link nor a green capture test closes this slice. No payment
provider, payout, live enrollment or broader G6 completion belongs in that local
increment. Unsettled policy/data-lifecycle decisions stay explicit, not encoded
as fixture assumptions or legal-looking copy.

## This Task's Proof And Preservation

- Evidence here is local source inspection and document validation, not a rerun
  or adoption of earlier test-suite counts. No browser acceptance, native SQL
  migration, provider check, real Auth flow or whole G6 test pass is claimed.
- Local document checks verify ASCII, final newline, no trailing whitespace,
  existing in-repository source links and the required review topic markers.
  Protected migration hashes match the before/after values below.
- Only authored file:
  `docs/PARTNER-LINK-ENTRY-CRITERIA-2026-10-28.md`. No shared plan/QA edits,
  reset, stash, staging or commit. Pre-existing `output/` remains untracked and
  untouched by this task; concurrent backend/test changes belong to their owners.
- Protected working-copy SHA256 values, recorded for before/after comparison:
  `migrations/059_site_blog_drafts.sql`:
  `c56c820f9b29b28f96de34b51cb63af44f29be207b7c76740c491c9811aaae47`;
  `migrations/065_operator_arrival_attribution.sql`:
  `ccc908b1a91126540b78dedcbfb75ae86e191d057fbeeeb4742241e8a0c61984`.
- No package command is needed for this documentation-only review. Future package
  commands must use the pinned
  `C:/Users/Lenovo/AppData/Local/node/corepack/v1/pnpm/10.33.2/bin/pnpm.cjs`,
  not another pnpm installation or a remote runner.
