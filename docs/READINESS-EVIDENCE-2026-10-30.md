# G1-G8 Readiness Evidence: 30 October 2026

## Audit Boundary

Main follow-up: the local startup/recovery candidate is separately
described in [AUTH-STARTUP-RECOVERY-ACCEPTANCE](AUTH-STARTUP-RECOVERY-ACCEPTANCE-2026-10-30.md).
It supersedes the startup/password backlog below only for its named local paths
and receipts, not Control-app, legacy exit-marker recovery, real-Auth or cloud
acceptance. The read-only audit below still describes committed `1f58ba1`.

- Candidate: `codex/blog-publication-runtime-fix`, HEAD `1f58ba1`
  (`Guard frontend auth session commits and stale account events`).
- Read-only audit of `CLAUDE.md`, the current top of
  [DELIVERY-CYCLES](DELIVERY-CYCLES.md), [PRODUCT-PLAN](PRODUCT-PLAN.md), the
  referenced acceptance records below and selected local source contracts.
  This is not a review of the complete DELIVERY history or a new acceptance run.
- Evidence order: source pinned to this HEAD plus its scoped acceptance record; then older
  family records for requirements not superseded. An older Preview receipt
  proves only its named source/target/cases, not this accumulated branch.
- The abbreviated top-plan table lists G1-G7. G8 remains required by the
  [G1-G8 release matrix](TEST-RELEASE-CANDIDATE-2026-10-25.md#g1-g8-matrix) and
  [legal/security plan](LEGAL-SECURITY-READINESS.md); its omission is not closure.
- No whole-plan completion, readiness percentage, release approval or permission
  to contact cloud services follows from this audit. The 3 November target is
  conditional, not an exception to acceptance gates.

## Eight Actionable Gaps

Every unchecked row is an open requirement, not a claim that its accepted local
subsystems are missing. "Next safe action" means local analysis/specification or
separately assigned synthetic work, not authorization to start another task.

| Requirement | Current authoritative proof | Remaining gap and next safe action | Substantial owner input / authority |
| --- | --- | --- | --- |
| [ ] **1. G1: original account across every Auth entry and lifetime.** | [Current Auth acceptance](AUTH-SESSION-AUTHORITY-ACCEPTANCE-2026-10-29.md) records actual frontend SDK `2.118.0`, public storage/lock adapters, ABA/write guards, observer teardown and actual App/AuthProvider on closed synthetic HTTP. One parent/iframe case has independent App/SDK instances and native storage events. | This is not independent-tab/process or real-Auth acceptance. Startup impersonation/dev `setSession` and `verifyOtp`, password recovery/update, Control auth and callbacks are outside this migration. Current `AuthContext` still has native startup calls. **Next:** Main-owned startup/metadata-flow acceptance map and missing local counterexamples; distinguish each writer from its observer. Do not silently substitute factory coverage for application startup. | Main owns startup architecture/factory/facade; do not duplicate or rewrite it. Later isolated real-Auth identity/method/target and account operations require separate explicit approval. Scoped global sign-out cannot undo remote revocation. |
| [ ] **2. G1/G2/G3: connected CRM outcome and report truth under role/account changes.** | [Connected actions](LOCAL-READINESS-ACTIONS-2026-10-28.md) accept selected actual browser/HTTP/native operator stage/booking and creator recovery. [Journaled PATCH](APPOINTMENT-OPEN-VERSION-2026-10-27.md#c24-transactional-patch-journal) accepts 119 transaction/rollback and original-author/version checks; [report zones](ANALYTICS-TIMEZONE-2026-10-26.md) accept local clock/zone/metadata locks. | These do not accept the entire lead -> client -> appointment -> arrival/sale -> report matrix. Durable PATCH/task recovery and shared schedule/catalogue races remain open; reports have independent snapshots. Real unfinished-form B -> A and current isolated role/zone/refusal behavior remain unaccepted. **Next:** reconcile missing cases against these newer receipts, preserving lost-ACK keys, exact prices/services/capacity and refusal privacy; implement/test only genuinely uncovered cases. | Existing original-actor/privacy rules need no weakening or new metric. Owner must decide reconciliation policy for legacy uncertain outcomes and later approve an isolated role/workspace test matrix. No working tenant is a fixture. |
| [ ] **3. G4: truthful, complete operator/partner/creator workflows and visual acceptance.** | [Current design QA](../design-qa.md) records approved reference designs and scoped desktop/mobile action captures; later partner screens have functional extension receipts, not whole-reference parity. | Initial-contact success and next-contact still lack authoritative events; the creator deadline shortcut is current-page-only, not a global nearest-deadline guarantee. Full partner parity and physical/WebKit/device acceptance remain open. **Next:** resolve event semantics before adding metrics, then compare only missing same-state screens/flows, including keyboard/focus and mobile overflow, against the current source. | Owner defines what qualifies as successful contact/next contact and approves actual workflow scope. Do not manufacture metrics or placeholder destinations to imitate a mock. Physical-device acceptance needs a separately agreed matrix. |
| [ ] **4. G5: bounded private-media/delivery/usage path, not just local admission.** | [Quota recovery acceptance](VIDEO-QUOTA-RECOVERY-2026-10-26.md) proves actual SQL original-receipt/lock checks and fail-closed coordinated 106 consumers. [ACTIVE gate receipt](LOCAL-READINESS-ACTIONS-2026-10-28.md) proves strict saved boolean permission with blocked external transport; PAUSED history is synthetic, not provider acceptance. | Historical public-file/text Preview receipts do not accept the newer private Storage/worker/API combination, Linux host/package or cross-device upload/delivery. Unknown dispatch without an external ID and ambiguous quota still require reconciliation. **Next:** map exact worker/schema/API dependencies and unresolved outcomes locally; preserve keys and bounded recovery, never infer refund, redispatch permission or an external result. | Owner must select any later isolated storage/host/channel acceptance and the handling policy for unknown outcomes. No provider call, delivery, generation, ACTIVE action or cost is authorized here. |
| [ ] **5. G6: one complete public applicant-to-owned-company journey.** | [Company commands](PARTNER-COMPANY-COMMANDS-ACCEPTANCE-2026-10-28.md), [cross-session inbox](PARTNER-COMPANY-INBOX-ACCEPTANCE-2026-10-28.md) and [selected-company entry](PARTNER-COMPANY-WORKSPACE-ACCEPTANCE-2026-10-29.md) accept distinct local submission/review/recovery/discovery and fresh owner-membership handoff layers, following [verified link entry](PARTNER-LINK-ENTRY-ACCEPTANCE-2026-10-28.md). | Public signup/confirmed-email delivery, abuse policy, approved notices/retention and a composed isolated real-Auth journey remain open. The canonical notice registry is empty and intake stays off. Handoff checks are current snapshots, not a continuous two-RPC authorization lease. **Next:** stitch a case/evidence map for the full journey, marking synthetic identity/transport and uncovered expiry/reload/denial transitions; do not enable intake or invent grants. | Owner approves who may apply, verified-contact/abuse rules and retention; legal owner approves exact notice purposes/texts. Real applicant accounts, email and future isolated activation need separate permission. |
| [ ] **6. G6: proven payment provenance and commercial settlement.** | [Agreed partner rules](OPERATORS-AND-PARTNERS.md) define first actual subscription payment within the original 168-hour referral window; 120 reserves source and binds a verified payment event. The [release matrix](TEST-RELEASE-CANDIDATE-2026-10-25.md#g1-g8-matrix) distinguishes manual 084 subscription receipts from money movement. | Application approval, subscription status and supplied `paid_at` are not bank evidence. Merchant/sandbox, signatures, amount/currency/recipient, replay/unknown outcomes, refunds and commercial terms remain unaccepted. **Next:** prepare an offline financial-event acceptance contract tied to the existing source window, without performing payment or treating manual state as settlement. | Provider/merchant and legal recipient/settlement responsibility must be chosen; refund/dispute, commission and operator remuneration terms require owner decisions. A future sandbox request needs explicit permission; no account, payout or expense is implied. |
| [ ] **7. G7: frozen candidate, selected SQL delta and verified isolated bindings.** | [Current raw review manifest](../scripts/fixtures/migration-chain-review.mjs) pins 118 files, 009-126. [Company native acceptance](PARTNER-COMPANY-WORKSPACE-ACCEPTANCE-2026-10-29.md) uses that local chain. Auth `1f58ba1` changes neither migrations nor this review manifest relative to `0f7b410`. The current Auth receipt includes a normal local build, not hosted acceptance. | No current-candidate isolated Preview/schema receipt is established here. Raw 009-126 is a disposable baseline, **not** a target apply list. **Next:** Main assembles selected committed source/build/API/worker identities and a dependency/ACL/cutover matrix. A selected target delta can only be finalized against its actual catalog after separate read-only approval; never apply the cumulative chain or reopen legacy writers to pass old checks. | Main owns DELIVERY/release selection. Owner must choose the candidate and explicitly approve an isolated target/binding inspection before any cloud action. SQL application and deployment need their own approval. The read-only source check below resolves 059/065 as line-ending-only differences, not a new SQL-content decision. |
| [ ] **8. G8: approved consent, data lifecycle and operational/legal evidence.** | [Legal/security plan](LEGAL-SECURITY-READINESS.md), L2-L5, remains authoritative for unresolved obligations. The [G8 matrix](TEST-RELEASE-CANDIDATE-2026-10-25.md#g1-g8-matrix) records immutable 093 notice snapshots and synthetic two-tenant dump/restore, explicitly not real backup/site/legal acceptance. | Empty canonical notices cannot authorize public consent. Deployment/data/backup geography, final operator/processing contracts, category/MFA decision, retention/deletion and actual restore/incident ownership lack complete acceptance. **Next:** make a decision/evidence ledger for these named gates; keep synthetic notice injection separate from approval and synthetic restore separate from operational backup proof. Historical dependency findings are not a fresh audit of this HEAD. | Legal owner supplies approved identity/contracts and purpose-specific texts, infrastructure geography and applicable category/MFA decision; operational owner sets retention, deletion/backup handling, restore objectives and incident responsibility. No legal compliance claim is made. |

## Conflicting Historical Claims

- **SDK boundary:** the previous portal-entry section in DELIVERY and
  [its acceptance](PORTAL-ENTRY-ACCEPTANCE-2026-10-29.md) still describe late SDK
  persistence as unclosed. `1f58ba1` and the current Auth receipt supersede that
  claim for the wired local paths, not startup/Control or real cloud Auth.
- **Partner implementation:** older PRODUCT/OPERATORS/local-action paragraphs
  say verified link/company flow is still to be built. Later link, commands,
  inbox and workspace receipts supersede that local backlog. Public signup,
  consent and commercial gates are not thereby closed.
- **Schema:** the observed cloud `69/112` is an older catalog receipt, **not the
  current candidate**, not a readiness percentage and not current 130-check
  appointment acceptance. 119 changes that contract and closes effective legacy
  118 entry; its metadata query has not been rerun on that target. Even all 130
  would not attest the later partner 120-126 or the whole schema.
- **Release inventory:** historical `f18f411` Preview bindings and the old
  009-100 inventory in TEST-RELEASE do not cover HEAD `1f58ba1` / raw 009-126.
  [MIGRATIONS](MIGRATIONS.md)' older blanket optional-migration wording cannot
  override newer fail-closed, coordinated API/SQL requirements. First payment,
  not registration, is the current referral-window event.

## Protected Sources And Work Performed

The existing dirty files remain separate from committed HEAD:

| Protected file | SHA-256 at audit; matches the existing raw review pin |
| --- | --- |
| `migrations/059_site_blog_drafts.sql` | `c56c820f9b29b28f96de34b51cb63af44f29be207b7c76740c491c9811aaae47` |
| `migrations/065_operator_arrival_attribution.sql` | `ccc908b1a91126540b78dedcbfb75ae86e191d057fbeeeb4742241e8a0c61984` |

The manifest explicitly reviews checkout bytes, not raw `git show` bytes and
not released/applied SQL. Do not stage, normalize, revert or silently substitute
these protected files.

Main's subsequent read-only check resolves their source status: `git diff --raw`
is empty for both; `git ls-files --eol` reports `i/lf w/crlf attr/text eol=crlf`.
Their decoded SQL is exactly identical to HEAD after CRLF/LF normalization.
059 is 1414 bytes in the Git blob / 1439 in the checkout; 065 is 3128 / 3201.
The checkout hashes above are unchanged and match the reviewed CRLF format.
No SQL text change, restore, staging or index refresh was performed. A separate
owner decision to restore their content is therefore unnecessary. This does not
prove any target schema state or authorize applying either migration.

Parallel uncommitted Auth factory/facade changes and new startup/password/focus
fixtures appeared during the audit. They are not accepted evidence for
`1f58ba1` and were not edited or tested here; startup ownership remains with
Main. The startup calls cited above were also checked in committed HEAD.

This audit only reads local documents/source/git metadata and hashes protected
files. No tests, build or manifest verifier were rerun for unchanged counts: that
would not resolve target selection, current external catalog or owner decisions.
Existing failed runs remain evidence, not passes. Only this new document is
written; runtime/tests/migrations, Main's DELIVERY docs and existing `output/`
are untouched. No environment/credential stores, accounts/passwords, cloud,
providers, customer resources, Production/Baspana/salons/WhatsApp or costs are
accessed. Any later external step requires a separate explicit authorization.
