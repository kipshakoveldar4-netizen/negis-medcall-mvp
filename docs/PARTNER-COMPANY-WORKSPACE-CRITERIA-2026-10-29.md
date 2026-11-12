# Partner Company Workspace Handoff: Threat Review And Criteria

Date: 2026-10-29. Inspected local HEAD: `817dedbe3fbf06df44bcb34e1a5be3eb6c3730ce`.
Scope: independent review and acceptance criteria, not runtime implementation or release acceptance.
Main owns architecture, Auth/provider, handlers, client and parent. This reviewer owns only this new document.
Concurrent runtime/test edits were reread after Main reported implementation; HEAD alone does not identify those edits.

## Status And Evidence Boundary

- Read `CLAUDE.md` and current company page/inbox/client, Auth provider, selector consumers, App barriers, API handler, private readers and relevant fixtures.
- This review ran no application, browser, HTTP, SQL, build or typecheck tests. Source reasoning below is not an executed reproduction.
- Main reports fresh parent/client **102/102**, preserving the earlier 77 plus 25 new cases. This is reported evidence, not independently rerun here.
- The current [parent fixture](../scripts/src/medina-partner-company-page.test.ts#L197) executes actual transpiled page/client/parser code with a custom hook scheduler, synthetic SDK/CRM transport, child boundaries and a stub `useAuth`/`enterWorkspace` (lines 206-208, 249-253). Its cases cover actor/mode ABA, wrong workspace and DTO parsing, not real provider/route/storage integration.
- The [inbox browser fixture](../scripts/fixtures/partner-company-inbox-browser.mjs#L108) supplies a synthetic workspace callback; its success record explicitly performs no Auth selection, navigation, API or SQL. Actual styled inbox behavior is useful evidence but cannot establish full handoff safety.
- All requirements below remain acceptance obligations until Main records evidence against the final candidate. This document closes no G1-G8/G6, production, legal, payment or deployment gate.
- Local only: no deployment, cloud DB, provider/WhatsApp send, spend, credentials or environment-value reads. No migration/schema change, commit, staging, runtime edit, or write/cleanup under protected `output/` or migrations 059/065.

## Reviewed Handoff

Main's contract is explicit selected-row entry, not a generic dashboard link:

1. The default `/partner-company` inbox supplies an approved application's `id`, `revision` and target workspace from its current frame/selection. The old `?new=1` form is not wired for entry in this increment.
2. Same-origin `GET /api/crm/partner-company?view=workspace&applicationId=...&revision=...` verifies the actor and calls existing `read_growth_partner_company(p_actor,p_application)`; approved state, matching revision and current owner are required.
3. The client strictly parses the existing application DTO. The parent also compares its workspace with the selected application's workspace, then calls `enterWorkspace(target,{expectedUserId,signal,isCurrent})`.
4. The provider freshly reads existing auth-context, permits exactly one matching target owner membership, applies that membership and only then navigates to `/dashboard` using existing purpose routing. No migration or new grant is involved.

The first read proves applicant/application/current-owner authority at its database check. The second read proves current active target membership at its separate read. Neither response is a bearer capability or a permanent grant. Every subsequent CRM request still needs server authorization.

## Current Source Findings

### F1: P1 - UI And Request Tenant Can Disagree

[Auth `rememberSelector`](../artifacts/negis/src/contexts/AuthContext.tsx#L569) swallows storage failures. `applyMembership` then publishes `clinicId`, owner role and purpose regardless of whether the target selector was persisted (lines 578-596). However, [readWorkspaceId](../artifacts/negis/src/lib/demoStorage.ts#L63) independently reads storage, falling back to legacy staff/demo selectors, and [Dashboard](../artifacts/negis/src/pages/Dashboard.tsx#L53) captures that value for all four initial data requests.

Concrete schedule: actor owns old W and target T; storage still contains W; remove/set fails but reads still return W; target fresh read succeeds; provider renders T and navigates; Dashboard requests W. Server membership checks can correctly authorize W, so server authorization does not prevent this wrong-company operation. With fully unavailable storage, fallback can instead select a legacy/demo identifier. A second tab changing the shared selector causes the same context/request disagreement even when writes initially succeed.

**Blocker:** prove the actual destination and all initial requests agree on T, or refuse entry. Best-effort storage persistence plus a successful React state update is insufficient. Do not treat clearing storage or caches as tenant authority. A scoped solution belongs to Main; this review proposes no runtime refactor.

### F2: P1 - A Newer Auth Event Can Restore Generic Selection

Current [enterWorkspace](../artifacts/negis/src/contexts/AuthContext.tsx#L699) advances both auth and selector revisions and clears memberships, selection and both read caches before the fresh read (lines 714-725). This correctly invalidates already-running older auth reads and quarantines even an already-selected target. These two earlier concerns are addressed in source, not yet accepted by integration evidence.

The remaining schedule is a **newer** same-user `TOKEN_REFRESHED`/`USER_UPDATED` event during that read. The [subscription](../artifacts/negis/src/contexts/AuthContext.tsx#L828) calls `beginAuthResolution`, invalidates entry, and starts ordinary `tryApplySupabaseStaffUser`. That [generic resolver](../artifacts/negis/src/contexts/AuthContext.tsx#L643) still restores a stored selector or auto-selects a sole membership. It does not consult a pending target intent. If target T is revoked and old W is the only remaining membership, that resolver can reapply W while the target action fails. The selector revision only fences the entry's response; it does not fence this newer resolver's fallback.

**Blocker:** cancellation may yield a neutral/no-workspace state or an explicitly newer user choice, not silently restore W as the result of attempting T. Test both newer Auth events and token/body-read boundaries with the real provider. A same-user Auth event is not itself an intentional workspace choice.

### F3: P1 - Company Sign-Out Does Not Establish Provider Pending State

[PartnerCompany](../artifacts/negis/src/pages/PartnerCompany.tsx#L37) still invokes `supabase.auth.signOut()` directly. The provider's [signOut](../artifacts/negis/src/contexts/AuthContext.tsx#L1050) separately establishes a pending marker/revision, clears local access and retires reads before awaiting SDK completion. The direct page path does not perform those steps synchronously.

Concrete schedule: hold SDK sign-out before it clears/emits the session event; click page sign-out while target confirmation/auth-context is pending; release the handoff reads first. The page's actor epoch, provider pending marker and SDK token can all still look current, allowing selection/navigation after the user has requested exit. A late `SIGNED_OUT` event eventually clearing the screen does not close that interval. A failed SDK exit must not silently leave stale sensitive data visible either.

**Blocker:** actual page sign-out must retire its handoff immediately, with a held/failed SDK response and no emitted event. Existing tests for an old actor's sign-out callback and the provider's sign-out-pending path do not prove this direct path.

### F4: P1 - First-Read Failure Is Outside The Provider Quarantine

The [parent](../artifacts/negis/src/pages/PartnerCompany.tsx#L55) awaits workspace confirmation before invoking the provider, where quarantine begins. A 403, 409, malformed reply or network failure from that first read never reaches `enterWorkspace`; an old workspace/role can therefore remain in the provider. The inbox may hide denied applicant data without removing previous CRM selection.

[ProtectedPage](../artifacts/negis/src/App.tsx#L214) gates by loading/role/purpose, not the requested application/target. [Landing](../artifacts/negis/src/pages/Landing.tsx#L58) can redirect using any retained clinic; [Login](../artifacts/negis/src/pages/Login.tsx#L263) has its own stored/sole-membership route selection. Generic team entry is a separate action, not confirmation that T opened.

**Blocker/decision:** define whether target intent must quarantine access from the initial click or only on second-phase entry. Under a strict end-to-end no-fallback promise, a first-read denial must not leave a route path that appears to open T but displays W. At minimum, test pending/failed first reads plus Back/Forward, `/`, `/login`, `/dashboard`, picker and team navigation; any independent later choice must be clearly intentional, never attributed to target success. Provider-only tests cannot settle this route contract.

### F5: Revocation Is Snapshot Authorization, Not Continuous Ownership

The existing [121 reader](../migrations/121_partner_company_approval.sql#L136) binds original applicant, waits on the source lock, rereads, and for approved applications calls [partner_source_owner](../migrations/112_partner_first_source.sql#L93). The latter locks workspace then the matching active owner row. Those locks end with the RPC transaction, not with later browser navigation.

[Auth-context membership](../lib/auth/server.ts#L230) is a separate active-staff read, without a grant generation in its returned contract. Application approval changes `revision`, but [terminal application immutability](../migrations/121_partner_company_approval.sql#L79) does not version subsequent owner removal/restoration. Owner-active -> removed/demoted -> owner-active between the two reads can therefore return the same application revision and appear valid again. Browser actor/selector epochs solve local lifetime ABA, not this database-grant ABA.

**Required explicit limit:** recheck current authority at each existing boundary and deny subsequent requests when their membership check sees revocation. Do not claim detection of every intervening revocation, atomic two-read authorization, instantaneous remote screen erasure, or continuous owner authority. If uninterrupted-grant continuity is required, the stated no-new-schema design does not establish it; Main must resolve that product/security requirement, not label a UUID revision sufficient. Restoration before a fresh check may legitimately authorize a new current attempt under snapshot semantics.

### F6: Cache Clearing And Route Change Are Not Automatically A Render Barrier

Entry now clears both CRM and list caches. [clearCrmCache](../artifacts/negis/src/lib/api.ts#L174) detaches pending responses and fences cache population but intentionally does not cancel original callers. [list cache](../artifacts/negis/src/lib/demoStorage.ts#L153) is keyed by endpoint/workspace, not actor, and currently has no clear-generation fence. Consumers can retain rendered state or complete an old read unless unmounted/retired.

The current Dashboard loads only on mount (`useEffect(...,[])`, lines 53-96), so updating context/storage in place cannot establish fresh destination data. Require observable unmount/reset or an equally strong current-scope guard. Do not rely on React batching to guarantee a visible intermediate null: clearing and reapplying state might be committed together under some scheduling.

**Blocker:** actual App/destination tests must seed old-actor/old-tenant rendered state and both caches, hold old requests, then release after entry. No old private value may flash, repopulate an unscoped cache, drive a write, or survive a denied target. This is a rendering/cache requirement, not a claim that the server trusts client roles.

## Requirements Matrix

`Source` means observed code support only. `Open` means a gap, decision or missing end-to-end evidence. No row is a pass receipt.

| ID | Required behavior | Current assessment / evidence needed |
| --- | --- | --- |
| W01 | Only the current visible approved row enables entry; pending/rejected never enter. No generic dashboard link or silent first-application/first-membership choice. | Source: current inbox ticket/frame/page/selected object checks. Actual styled parent+provider proof open. |
| W02 | Bind the request to verified actor plus exact application/revision; never accept actor/email/workspace/owner from the request as authority. | Source: current handler uses verified actor and existing private reader. Actual compiled native HTTP proof open. |
| W03 | Whitelist scalar `view=workspace,applicationId,revision` plus router `path`; reject arrays, duplicate/mixed/extra selectors, body and wrong methods without any write/close fallback. | Source: handler/client strict query/UUID checks; test raw duplicate parsing at the real HTTP adapter, not just a query object. |
| W04 | Return only strict existing approved application DTO with matching id/revision and nonnull workspace; parent must also match the selected row's workspace. | Source: handler/client parser and parent comparison. Main reports DTO/wrong-workspace cases in 102/102; provider is stubbed there. |
| W05 | Reuse current-owner private read, preserving source/application consistency, lock order and bounded failure; no public/direct-table/platform fallback. | Source: existing 112/121 read chain. Native lock-winner and ACL regression evidence needed; no migration required. |
| W06 | Historical entry needs no intake flag, fresh notice, source cookie, new confirmation or renewed source window. Authentication and current owner authority remain mandatory. | Source: workspace branch precedes intake logic. Test disabled/expired intake with native existing reader and changed-email/same-subject. |
| W07 | Same-origin GET, no redirect/credential/referrer leakage, `no-store` on success and all denials; tokens stay out of query/body/logs. | Source: client transport and private handler headers. Check actual catch-all early-auth denial and transport dispatch. |
| W08 | Fresh auth-context must contain exactly one matching target owner; absent, duplicate, inactive/nonowner or malformed target refuses, even with a valid other owner workspace. | Source: provider exact-one owner match; no generic branch in entry itself. Real-provider matrix and F2 remain open. |
| W09 | Actor/session/token, auth revision, selector epoch, caller lifetime and signal stay current across each await and immediately before apply/navigation. | Source: scoped fetch and entry guards. Real SDK-double/provider timing tests, not stub entry, required. |
| W10 | Retire older bootstrap/entry reads; preserve a genuinely newer explicit user selection. Stale completion/finally must not clear a newer request's loading, selector or error. | Source: entry advances auth revision; `ownsRead()` gates final loading cleanup. Newer generic Auth resolver is not an explicit choice (F2). |
| W11 | Quarantine old and already-selected-target roles, membership lists, purpose and private caches before fresh entry; failure/cancel never restores them as fallback. | Source: unconditional second-phase clearing fixes same-target issue. First-phase/renewed Auth event semantics and F1/F2/F4 remain open. |
| W12 | UI tenant, persisted selector, page data requests and writes all agree on T; storage failure/corruption or another tab cannot redirect operations to W/legacy/demo. | Open F1. Verify actual default destination, not just `clinicId` or a recorded `enterWorkspace(T)` call. |
| W13 | Loading blocks protected destinations and automatic redirect/picker paths until target context is committed; failure routes remain neutral or explicitly independent. | Open F4/F6. App and public route redirects must be exercised together. |
| W14 | Blur/hidden, focus refresh, selection/filter/page change, mode/actor ABA and unmount cancel/retire the old action permanently; late success/denial cannot affect the new lifetime. | Source: inbox ticket identity, hide abort, frame/page/selected object identity. Busy-only render deliberately preserves its authorizing frame. Actual composed path still needed. |
| W15 | Sign-out intent immediately blocks entry even before SDK completion/event; failed exit remains safely blocked until explicit recovery. | Open F3 for current company page; provider-only marker tests are insufficient. |
| W16 | Purpose is taken from freshly verified target membership before destination renders; clinic, beauty/dental, marketing and mortgage must not inherit W's page/module/vertical. | Source: applyMembership sets role/purpose/vertical before `/dashboard`; App purpose routing exists. Actual first-render/request assertions open. |
| W17 | Revocation before/while either authority check denies; after a completed check, subsequent CRM requests authorize current membership independently. Local ABA retirement and database grant ABA are described separately. | Source: existing locks/server auth. F5 sets the non-continuity limit; native schedules and post-revocation requests required. |
| W18 | Handoff is read-only in business terms: no workspace/staff/settings/source/receipt/closure/notice/payment/referral/commission/payout mutation or expiry renewal. Browser selector/cache changes are allowed only as required for safe entry. | Source: handler calls read only. Compare native business/financial snapshots; no stored command metadata may be consumed by this flow. |
| W19 | Default inbox gets the new callback; `?new=1` submission/recovery behavior and unknown-command fences remain unchanged. No automatically opened workspace on mount/focus/reload. | Source: parent wires inbox only. Main reports retained 77 cases; integrate real children and explicit navigation. |
| W20 | Russian loading/error/denied states, keyboard action/focus and layout remain usable at 375 and 1440 CSS pixels; long values/200% zoom do not hide the entry action or error. | Open actual composed visual/interaction evidence. Synthetic callback browser results cover component UX only. |

## Required Integration Evidence

Keep this work disjoint from Main's existing parent/client fixture and other agents' unit/UI tasks. Extend an owned test layer only after an explicit assignment. The requirements here do not authorize additional runtime edits, browser downloads or external services.

1. **Actual composed page and routes.** Mount actual `PartnerCompany`, inbox, AuthProvider, App/ProtectedPage/WorkspacePicker and destination with actual clients/parsers. Name the synthetic Auth/session/network boundary. Assert first destination render, every initial workspace query and any test mutation target, not only the URL or entry argument. Include a fresh context with no memberships cached and a previous W owner selection.
2. **Storage split-brain.** W remains readable while remove/set throws; all storage methods throw; corrupt/legacy staff/demo values; another same-origin tab writes W while T enters and after it enters. Either target-safe behavior or explicit refusal is required. Separate blocked-storage discovery (still supported) from handoff safety; do not invent successful entry using demo fallback.
3. **Resolver competition.** Hold initial bootstrap then start entry (old read must lose); hold entry then emit newer same-user Auth events; revoke T so W is sole membership; include transient auth-context failure and changed token before an event. Test explicit picker T-W-T and overlapping entries separately. A stale finalizer must not finish a newer request.
4. **Every interruption point.** Hold first confirmation response, its JSON body, token lookup, second auth-context response/body and final token check. At each point test cancellation, blur/hidden, focus refresh, row/filter/page and actor/mode A-B-A, unmount and a stale callback retained from before refresh. Let transport resolve despite abort so lifetime checks, not only cancellation, are exercised. Assert no dispatch/apply/navigation/denial/busy release against a newer scope.
5. **Sign-out interval.** Invoke the actual company shell action; hold SDK sign-out without emitting an event, then resolve entry. Repeat SDK failure, provider sign-out and late `SIGNED_OUT`. After the intent, no target commit or private destination is permitted. Existing stub tests currently check SDK invocation, not this composed condition.
6. **Route barriers and return.** While each read is held, attempt Back/Forward, `/`, `/login`, `/dashboard`, purpose route and team/picker navigation. Repeat denial of each phase, including T already selected. Canceling an old handoff must not steal a later intentional navigation. Returning from CRM must freshly load inbox, not replay entry; test browser history restore/pageshow behavior where the owned harness supports it.
7. **Cache/privacy and remount.** Seed old actor/tenant data in both caches and a mounted destination; hold original reads across clearing. Check destination mount/reset, body and accessibility tree throughout transition, then release old reads. Exercise same-target owner downgrade; never render previous privileged cached rows while fresh authority is unavailable. Do not equate cache clearing with cancellation of original consumers.
8. **Actual compiled HTTP plus owned native PostgreSQL.** Use the existing exact reader/migration chain and loopback adapter; do not add/modify migrations. Cover original applicant/current owner, foreign actor, replacement owner, same email/different subject, changed email/same subject, pending/rejected, stale revision, malformed projection, missing reader and private ACL denials. Synthetic Auth is not real Supabase Auth proof. Prove workspace/staff/source lock waits with independent connections and observed locks, both winners, not sleep-only timing. Revoke/demote/delete target before the first read, between reads and while blocked; separately demonstrate removal/restoration ABA's stated snapshot semantics. A mocked `db.rpc` reply cannot pass this native row.
9. **No business mutation or hidden side effect.** Compare target/unrelated workspace/staff/settings/application/source/command/financial state before and after success/error/cancel; preserve original source dates and expired eligibility. Permit SQL locks, not business writes. Record allowed loopback traffic and refuse other outbound HTTP, beacon, socket, provider and analytics requests from the composed fixture, including existing App effects. Do not boot production SDKs or read real configuration to make a fixture work.
10. **Candidate and lifecycle accounting.** Record source identity, exact tests/exits, named doubles, native versus mocked layers, inspected captures and remaining limitations separately. Existing 102/102 does not sum with overlapping suites into readiness. Use installed local dependencies only, clean child environment allowlist, explicit workspace and `login:false`. Any authorized Node/PNPM run uses the pinned paths supplied by the user. On observation timeout retain and poll the same live handle; do not restart solely for timeout. Owned resources must finish/close, without touching protected or unrelated output.

## Acceptance Decision And Next Boundary

Source now supports the intended two-read exact-target design, strict DTO/target matching, prior-read invalidation, unconditional second-phase quarantine, owner-only fresh entry and scoped final cleanup. This is a meaningful implementation observation, not an acceptance claim.

Local handoff acceptance remains blocked by F1-F4 and unexecuted composed-provider/route/native evidence above, unless Main explicitly resolves a narrower first-phase contract for F4. F5 is a documented security limit requiring an explicit snapshot-versus-continuity decision, not a reason to add a migration in this task. F6 requires render/cache proof even after the scalar checks pass.

The review/document assignment ends here. A distinct subsequent task can own native HTTP integration against the **existing** private reader, with no new migration and no duplication of Main's 102-case parent/client work. No such test execution is claimed by this document.

Broader real applicant Auth/confirmation policy, approved notices, abuse controls, retention/deletion, isolated deployment acceptance and commercial/payment/refund/payout readiness remain open under the [prior acceptance](PARTNER-COMPANY-INBOX-ACCEPTANCE-2026-10-28.md#L65) and [delivery plan](DELIVERY-CYCLES.md). This review does not change those boundaries or constitute current legal advice.
