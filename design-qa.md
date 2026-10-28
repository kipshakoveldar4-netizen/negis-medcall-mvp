# Contributor Portal Design QA

Date: 2026-10-28. Scope: local implementation only. No Production/Preview release,
cloud migration, provider request, real payment or working workspace modification.

## Visual Truth And Evidence

Base path: `C:/Users/Lenovo/Documents/Codex/medina-os/`.

Approved source images (each 1487 x 1058):
- `output/design-concepts/contributors-2026-10-28/operator-workspace.png`
- `output/design-concepts/contributors-2026-10-28/blogger-partner.png`
- `output/design-concepts/contributors-2026-10-28/content-creator.png`

Individual final browser-rendered screenshots:
- `output/design-qa/contributors-2026-10-28/final/operator-desktop.png`
- `output/design-qa/contributors-2026-10-28/final/operator-mobile.png`
- `output/design-qa/contributors-2026-10-28/final/partner-desktop.png`
- `output/design-qa/contributors-2026-10-28/final/partner-mobile.png`
- `output/design-qa/contributors-2026-10-28/final/creator-desktop.png`
- `output/design-qa/contributors-2026-10-28/final/creator-mobile.png`

Screenshots: CSS/pixel viewport 1440 x 1000 and 375 x 900, deviceScaleFactor 1.
Synthetic ready data, actual production React portals/transport; Auth and API data
are doubles. The visible test toolbar is fixture-only, not application UI.
IAB attachment repeatedly timed out. The fallback evidence is the repository's
owned headless Edge regression, with an empty disposable profile and blocked
external requests, not the user's browser profile or a real logged-in account.

Same-input full-view comparisons are `final/{operator,partner,creator}-comparison.png`.
Sources are proportionally normalized to 1440 px wide. Implementation toolbar
59 px is excluded; the remaining 1440 x 941 viewport is not stretched and is
bottom-padded on the comparison canvas. Padding is not a layout discrepancy.
The desktop source has no separate mobile target; mobile is a responsive adaptation.
Focused native-density header/mode comparison: `final/creator-header-focus.png`.
Final mobile filter interaction: `final/creator-status-select-mobile.png`.
Machine-readable final ready/interaction evidence: `final/browser-report.json`.

## Comparison History

1. `iteration-1-creator.png`: duplicate heading and excessive pre-list height
   (P2). Hidden redundant inner heading, tightened row spacing; mobile header
   actions now share the title row, metrics have three compact columns, and the
   mobile status control is a native select. Final individual mobile evidence
   shows the first assignment above the fold after the fixture toolbar.
2. `iteration-1-operator.png`: the main work view opened cooperation offers,
   not leads (P1). Added an owned, read-only workday view: accepted company
   selection followed by the existing guarded lead workflow. Cooperation offers
   retain their own navigation section. Final operator comparison shows a real
   scoped lead, not a second implementation of booking or stage mutations.
3. Final full-view and individual mobile captures were inspected after both fixes.
   Header, status control and assignment action text are readable at native
   capture size. Full-view images are also provided without comparison scaling.
4. Partner history/deadline iteration: the first history capture fell below an
   oversized ledger and programme footer (P2). Reduced ledger spacing and moved
   history ahead of that footer. New actual 375/1440 captures, same-input
   comparisons and filter/detail states are in `history-deadline/` alongside
   `final/`. Two actual-browser runs passed 28/28; the later capture is the current
   visual evidence, not the older baseline. Rows and mobile cards were inspected
   at native capture density. History remains account-scoped and UTC-labelled.
5. Operator workday iteration: a first complete-summary implementation repeated
   the title/profile-refresh row and stacked three tall metric bands on mobile
   (P2). The current portal uses its existing header refresh, hides the redundant
   inner header, and places metrics in three compact columns. A later native-size
   comparison found Today rows too tall (P2); time/current status and clinic
   receipt now remain visible, while service/receipt details expand through a
   native disclosure. Counts use a compact line. The actual 30/30 browser pass
   includes opening/closing that disclosure, not just its static appearance.

Current individual screenshots and all three same-input full-view comparisons
are in `output/design-qa/contributors-2026-10-28/workday/`. They supersede older
operator ready captures, not the historical backend receipts. Source normalization
and fixture-toolbar crop are identical to those above; each desktop viewport is
1440x1000, mobile 375x900, density 1. Earlier operator captures are retained there
as `iteration-1-operator-{desktop,mobile}.png`. The current header/metrics focus
is `workday/operator-header-focus.png`: paired 900x280 content crops, 1808x280
canvas, no scaling. The new explicit company-scope/metric wording explains its
extra note space; no false contact-success metric substitutes for source numbers.
Current `workday/browser-report.json`: 31 layout captures, no runtime exceptions,
console errors, blocked external requests or real API network requests. The
browser imported the frozen UI after its last source edit. Two visible Today
rows fit in the desktop viewport; the first available lead appears in the mobile
viewport even with the 143px fixture toolbar. There is no separate mobile source.

## Fidelity Surfaces

- Typography: existing local Inter, restrained 400/500/600 weights, no viewport
  font scaling or negative spacing. Long mobile title wraps, not clipped.
- Layout: dark 236 px sidebar, unframed workspace bands, white repeated rows,
  6 px controls, mobile drawer; no nested decorative cards or horizontal overflow.
- Colors: mint active navigation, near-black green sidebar, neutral gray ground,
  blue/amber semantic states. Existing brand favicon is preserved intentionally.
- Images: three individually generated generic content-production illustrations,
  optimized to 640 px WebP (about 25/39/35 KB), with explicit illustration alt text.
  They are not customer media, company locations or evidence of accepted work.
- Copy/content: counts are page-scoped when the API is paginated; money is exact
  minor-unit data from the original DTO. The fixture's example balances are not
  actual earnings. Missing agreements, unknown outcomes and denials remain truthful.

## Findings And Remaining Work

- [P1] Partner mock includes an issued referral URL. A verified working public
  entry/link resource is still absent; the canonical consent registry is empty.
  The local UI exposes actual agreement/code operations, not a fabricated URL.
  Finish protected public entry/link issuance before claiming full mock parity.
  Event history is now implemented through private local SQL 122 and verified
  HTTP, with UTC filtering and exact amounts; it has no cloud release receipt.
- Resolved locally: operator cross-company totals and combined Today agenda now
  use the complete authorized 123/API contract, not partial inbox/lead page sums.
  Current-scope contact, historical attribution, company-local dates, 20+1 paging,
  failure/retry, unavailable timezone and withdrawal states have separate native,
  HTTP, strict-parser, lifetime and real-browser receipts. See
  `docs/OPERATOR-WORKDAY-ACCEPTANCE-2026-10-28.md`; no cloud release is claimed.
- [P2] The operator source's all-company lead search/stage-filter bar is not
  implemented by the current per-company guarded lead workflow. This is a real
  remaining product gap, not proof that the fixture's single lead is the full
  global list. Initial-contact success also has no authoritative event definition;
  the UI explicitly says tracking is unavailable rather than inventing its count.
  Preserve these distinctions in further implementation and design acceptance.
- Resolved: creator nearest-deadline shortcut now uses the existing job detail
  and explicitly labels current-page scope. Actual 375/1440 open/close checks
  passed; source has no global-total authority, so no overall nearest claim is
  made. Due/overdue selection and original-list refusal are covered separately.

No observed viewport clipping, broken image or runtime console error in the six
final ready captures. Those checks do not establish real Auth/database/provider
acceptance. Empty/error states, role changes, recovery and command privacy have
separate fixture/unit receipts; they do not remove the feature gaps above.
Historical baseline receipts: full owned-browser interactions 24/24, final captures/brand/mobile filter
9/9, operator regression 733/733, portal UI 126/126, isolated fixture models/HTTP/
bundle 11/11 with normal exit. The fixture cleanup issue was fixed by normal Vite
listen/shutdown, disabling unused HTTP-test file watchers, and separating build
plugin resources from the development-server test process; no force-exit or
dropped assertions. Full build and final frontend typecheck/client build passed.
Historical history/deadline iteration: 28/28 actual-browser interactions, 338/338
standard portal UI, 25/25 native/HTTP and 714/714 full local SQL chain. Current
full typecheck, compiled CRM cold start (353 checks) and Vite build passed. These
overlapping layers are not summed and do not establish cloud release readiness.

Current workday acceptance: 738/738 exact cumulative SQL/HTTP, 643/643 portal UI,
1038/1038 operator regression, 30/30 actual frozen-browser cases. The full shared
API/library build with 353 cold-start checks passed; final CSS/header-label edits
then received a fresh frontend typecheck/build and both UI/operator suites.
The source/fixture/bundle gate passed 79/79 before those last two visual-only
edits. These are local layers with synthetic Auth/API where explicitly stated,
not an accepted cloud deployment or a summed readiness percentage.

## Implementation Checklist

- [x] Shared scoped shell, previous font, reduced-motion behavior, actual navigation.
- [x] Operator scoped leads, separate cooperation/profile, original actor guards.
- [x] Local complete operator summary, company-local Today and compact disclosure.
- [x] Partner exact aggregate balances and actual terms/code workflow.
- [x] Own confirmation history, UTC month filter, desktop table/mobile cards.
- [x] Creator actual assignments, responsive rows, page filters and original commands.
- [x] Current-page nearest deadline and existing detail open/close at 375/1440.
- [x] Desktop/mobile ready-state screenshots and same-page comparisons.
- [ ] Complete verified partner-link entry and company onboarding.
- [ ] Resolve operator all-company search/filter and initial-contact definition gaps.
- [ ] Separately authorize and verify an isolated cloud Preview; no release here.

final result: blocked

Blocked means full approved-mock parity is not yet complete, not that the local
pages fail to render. This report must not be presented as 100% product readiness.
