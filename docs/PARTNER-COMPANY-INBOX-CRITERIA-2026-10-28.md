# Partner Company Inbox Criteria
Date: 2026-10-28. Read-only audit base: `01c2eb38a956671339ea0d379abb5c7683edac33`.
Scope: current-cycle own-application discovery; only this document is authored here.
Read `CLAUDE.md`; no environment access, application tests, cloud, production or commits.
Concurrent Main/agent edits are evidence under review, not this audit's accepted implementation.

## Top Concrete Risks For Main
1. **HEAD cannot rediscover applications.** [Application load](../artifacts/negis/src/components/contributors/PartnerCompanyApplication.tsx#L254)
   restores one tab-local actor/request/source pointer or calls context; blocked storage blocks that path.
   Fresh-browser discovery must neither mount that form nor depend on its storage/cookie.
2. **Selected application is not selected CRM workspace.** The concurrent
   [inbox component](../artifacts/negis/src/components/contributors/PartnerCompanyInbox.tsx) links approved rows to generic `/dashboard`.
   With an existing different workspace selected, this can open the wrong company.
   Do not imply targeted access until existing workspace selection independently establishes the intended workspace; omit the shortcut if needed.
3. **Platform pagination is not applicant pagination.** [125 list](../migrations/125_partner_company_command_recovery.sql#L187)
   is intentionally cross-tenant. Filtering its already-bounded results would lose eligible rows and leak hidden-row lookahead.
   Concurrent 126 correctly starts with applicant/current-owner eligibility; preserve its post-lock checks for all 21 candidates.
4. **List status cannot resolve a command.** [125 submission read/close](../migrations/125_partner_company_command_recovery.sql#L125)
   binds actor/request/source and fences absent execution; an empty inbox establishes none of these outcomes.
   A displayed application also must not clear an unknown key, synthesize a receipt, or reopen new-command admission.
5. **Integration and lifetime evidence is still needed.** HEAD entry links both actions to the same page.
   Main's announced default-inbox/`?new=1` split must preserve explicit new-form navigation, receipt recovery,
   actor/mode ABA retirement and stale sign-out/access-denial guards. Source appearance is not browser acceptance.

## Fixed HTTP And Privacy Contract
- Extend existing catch-all `GET /api/crm/partner-company?view=list`, not a new API function.
- Optional `offset` defaults to 0; accept canonical decimal integers 0..1000000.
  Optional `state` defaults to null; only `pending|approved|rejected` are valid supplied values.
- Whitelist only router `path` plus scalar `view=list,offset,state`; reject arrays, empty/unknown values,
  extra selectors, mixed receipt parameters and nonempty bodies. List selection must never fall through to write/close.
- Resolve the current verified Auth subject only, using the existing identity-bootstrap route.
  No supplied actor/email/workspace, staff role, selected workspace, platform allowlist or referrer identity grants discovery.
- Historical discovery is independent of current email/confirmation changes, entry cookie, enabled-intake flag,
  current notice registry and source expiry. Same subject with changed email remains same applicant;
  another subject with identical email remains foreign. Authentication failure still denies access.
- Call only service RPC `list_own_growth_partner_companies(p_actor,p_offset,p_state)` from new 126;
  `p_actor` is server verified. No raw-table, platform-list, per-item HTTP or legacy fallback.
- Return existing `PartnerCompanyPage`: `items,offset,state,hasMore`, using
  [strict parser](../lib/crm/partner-company-contracts.ts#L100) bound to requested offset/state.
  No extra applicant email, consent snapshot, referrer details, capabilities, source IDs, command tuples or totals.
- Send `no-store` on private success and all errors, including router denial; retain safe error codes.
  Missing RPC/schema, malformed projection, lock timeout and changed page fail closed, never successful empty/partial data.

## SQL Eligibility And Concurrency
- Original applicant only for every state. Pending/rejected require no current staff membership.
  Approved additionally requires that same applicant's current `owner,active` membership in the application's workspace.
  A replacement owner, staff member or platform reviewer does not inherit applicant visibility.
- Apply applicant, state and approved-owner predicates BEFORE ordering, offset and 20+1 lookahead.
  Order `submitted_at DESC,id DESC`; return at most 20, and derive `hasMore` only from the eligible 21st row.
- For each selected candidate, acquire the original `partner-source:<source_id>` advisory transaction lock,
  reread applicant/application and compare captured revision/state before projecting.
  Disappearance or review change fails the whole page, without silently skipping/rebasing a row.
- Approved candidates must use the existing [owner guard](../migrations/112_partner_first_source.sql#L93):
  lock workspace then current owner membership and recheck authority after waits.
  Lost access after candidate selection fails the whole page; already-ineligible rows are excluded before pagination.
- Preserve [121 reader/result](../migrations/121_partner_company_approval.sql#L91) source/applicant/workspace consistency.
  Validate owner and source projection for the lookahead candidate too, not just the 20 displayed rows.
  Pending/rejected history must not call source claiming or require current referrer approval.
- Keep read-committed, bounded lock/statement timeouts and established lock order.
  126 must fail on dependency/shape/ACL drift, apply/reapply safely, retain RLS/private tables and private 121 aliases,
  and grant this RPC only to service_role with postgres ownership and empty security-definer search_path.
- Inbox reads cause no business-row/fence writes or source capture/claim/bind/refresh, new workspace/settings/staff,
  payment/referral/commission/payout, cookie change or deadline reset. Row/advisory locking is not business mutation.

## UI And Receipt Separation
- `/partner-company` defaults to own inbox after existing applicant sign-in; no public signup.
  Explicit `/partner-company?new=1` opens the existing form, and captured entry's submission action targets that mode.
  Existing application/recovery navigation remains distinct; direct load and Back/Forward preserve the selected mode.
- Inbox uses no Web Storage, even for detection/restoration; blocked/corrupt/cleared storage cannot prevent discovery.
  Preserve the existing form's storage safeguards rather than weakening them to make the inbox work.
- Selecting a row displays that page's current application snapshot, not a new receipt/recovery operation.
  Although 121 application ID equals submission request ID, the list supplies no source tuple or command outcome.
  Never infer committed/unconfirmed/abandoned, close/retry an attempt or clear/change its stored identifiers from a list.
- Existing request/source read/close and same-key recovery remain a separate explicit flow.
  A committed receipt identifies its command while its embedded current application/source status can change.
  Denied approved-owner recovery hides data without declaring rollback or erasing unresolved metadata.
- Preserve expected-user dispatch, same-origin/redirect refusal, cancellation and post-body-parse lifetime checks.
  Retire actor A-B-A and mode inbox-form-inbox lifetimes; old callbacks, 403s and sign-out cannot affect a new lifetime.
- Hide list/detail before filter/page/refresh/focus revalidation; reset filter changes to offset 0.
  Selection must belong to the current validated page/revision; old selected-row callbacks cannot resurrect detail.
  Separate loading, unavailable, denied, truly empty and filtered/page-empty states.
- Offset pages are not a durable cross-request snapshot: review/visibility changes can move boundaries.
  Do not invent exact totals or stable pagination guarantees; provide refresh and usable previous-page recovery.
- Russian labels must distinguish application decision from source/payment eligibility.
  Approval is not payment, commission, payout or a renewed seven-day window; preserve original expiry and existing 120 rules.
  No new resubmission, retry-after-rejection, transfer, quota or commercial entitlement is decided here.

## Required Evidence, Not Executed By This Audit
Main owns receipts for the final candidate; extend the changed path without duplicating accepted unrelated suites.

| Layer | Required delta evidence |
| --- | --- |
| Identity/privacy HTTP | Actual compiled catch-all accepts verified ID without email/confirmation, cookie, notices or enabled intake; denies anonymous/foreign/forged selectors. Same email/different ID is foreign; changed email/same ID remains own. |
| Dispatch/DTO | Exact list RPC and verified actor; offset/state extremes, malformed/duplicate selectors, mixed recovery query, wrong methods/body, missing schema and malformed/extra-field pages fail safely. No other RPC, table, cookie or provider operation. |
| Eligibility/paging | Mixed actors and states; original pending/rejected without staff; approved active owner versus inactive/demoted/deleted/replacement owner. Hidden approved/foreign rows interleaved before offset and row 21 cannot starve pages or influence hasMore. Include tied timestamps and empty later pages. |
| Native locks | Independent connections establish actual source/review and workspace/staff revocation waits. Both winners, including row 21, either return the authorized consistent page or fail it wholly; new whole-page read reflects current authority. No sleep-only proof or weakened guards. |
| Native migration | Exact reviewed chain including 126 apply/reapply, ACL/shape/dependency refusal and immutable 121/125 bytes; business and financial snapshots unchanged by all read/error paths. |
| Fresh-browser discovery | Same subject in independent browser/profile with no original request/source pointer, cookie or storage finds the same eligible applications. Cleared/blocked storage works. Name any synthetic Auth boundary; this does not prove real Auth or every browser engine. |
| Actual parent/client | Default inbox GET-only, explicit new form, entry link, direct load, Back/Forward; old form recovery preserved. Slow Auth/token/body, actor and mode ABA, retired new callbacks/403/sign-out and unmount cannot dispatch or update a newer lifetime. |
| Actual inbox | Page/filter/selection/focus races, denied-owner disappearance, malformed/error/empty states and safe CRM navigation with another workspace selected. No storage, context/submit/receipt/close calls on mount, focus, selection or refresh. |
| UI/accessibility | Actual styled parent at 375x900 and 1440x1000: nonempty/empty/error/denied, filters/pages/detail and new-form return; keyboard labels/focus/status, 44px targets, long values and 200% zoom without overlap/overflow. Inspect captures; do not infer pixels from declarations. |
| Preservation | Existing request/source receipt and closure fences, platform review authority, unknown-command blocking, original source/deadline and payment isolation remain unchanged. Historical counts are not new evidence and overlapping layers are not summed. |

## Open Gates And Freeze
[Current plan](DELIVERY-CYCLES.md#L27) and [prior acceptance](PARTNER-COMPANY-COMMANDS-ACCEPTANCE-2026-10-28.md#L78)
explicitly leave complete onboarding and broader G1-G8 open. This document closes no release gate.
Approved attribution/company notices, real applicant Auth/confirmation/signup policy, abuse quotas,
retention/deletion/withdrawal and operational controls still require Main/product/legal decisions.
No quota numbers, legal conclusions, activation permission, new business rules or payment readiness are invented.
Public activation, isolated cloud schema/deployment acceptance, provider/payment/refund/payout provenance,
full G6, design parity and all other unaccepted G1-G8 work remain separate.
Concurrent 126/handler/client/inbox source was inspected only; no tests or acceptance counts are claimed here.
Audit write boundary: this criteria file only; any later authorized test work is a separate phase.
Unrelated dirty 059/065 migrations and output remain untouched.
