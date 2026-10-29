# Contributor Portal Design QA

Date: 2026-10-29. Scope: local implementation only. No Production/Preview release,
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
6. Operator global-search iteration: desktop now has a genuine complete-scope
   search/company/group bar, not filters over an inbox page. Initial mobile
   wrapping group buttons pushed the first lead below the viewport (P2):
   `lead-search/iteration-1-operator-mobile.png`. Replaced only small-screen group
   buttons with a native select carrying the same seven counts and guarded action.
   Current mobile evidence and an actual-browser assertion confirm the first lead
   appears before the bottom of the initial 375x900 viewport, even with the 143px
   fixture toolbar. Desktop keeps its original button interaction.

Historical workday individual screenshots and full-view comparisons
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

Latest individual screenshots, all three combined full-view comparisons and
machine report are in `output/design-qa/contributors-2026-10-28/lead-search/`.
The approved 1487x1058 sources are still proportionally normalized to 1440 wide;
1440x1000 implementation captures exclude only the 59px fixture toolbar and are
not stretched. Comparison canvases remain 2888x1040 with an 8px gutter. Actual
matching interaction states are now captured: operator `in_progress`, partner
October 2026, creator all jobs. `*-reference-desktop.png` identifies those inputs;
`*-desktop.png` / `*-mobile.png` retain default ready views. Example identities,
counts and historical dates are synthetic and intentionally not copied as product
facts from the generated source. No separate mobile source exists.

Latest combined inputs and native-sized desktop/mobile images were opened and
inspected. Focused operator comparisons are `operator-header-focus.png`
(1808x280, two 900x280 crops) and `operator-filters-focus.png` (1476x160;
720x155 source and 734x160 implementation crops, unscaled and padded). The latter
compares the same active in-progress state. Full views, not the limited header
crop, confirm all summary labels fit. These supplement, not replace, the full
comparison. New stage/company/detail/denial screenshots are saved individually.

Final `lead-search/browser-report.json`: 49 layout checks, 53 screenshots, no
runtime exceptions, console errors, blocked external attempts or real API network
requests. The owned browser ran after all application-source edits; both final
31/31 runs completed normally. The final one adds matching-state captures only.
The former mobile P2 is resolved locally. Partner-link parity remains blocked.

Later connected action evidence is in
`output/design-qa/contributors-2026-10-28/native-actions/`: six actual operator
stage/booking/recovery screenshots, fourteen sanitized per-case HTTP/native
receipts and two creator screenshots. Native-size action captures were inspected.
Selected forms/controls fit at 375x900 and 1440x1000 with the real styles; unrelated
rows may naturally cross viewport edges while scrolling. This evidence connects
actual consumer actions to native business SQL, with a controlled parent/synthetic
Auth, not full-Portal or source-mock comparison. Application UI/CSS did not change
in that cycle; the existing same-input visual comparisons remain applicable.

## Fidelity Surfaces

Partner-link iteration: local server-confirmed issuance and explicit anonymous
entry now exist; neither is public activation. Current evidence is in
`output/design-qa/contributors-2026-10-28/partner-entry/`. The first desktop
iteration pushed history entirely below the fold. Removed redundant adjacent
lines and empty feedback space, compacted the rates, and raised the new link
icons to 44px. The frozen full-portal run is 31/31 and requires the first desktop
history row inside the initial viewport. Focused link/entry/recovery run is 11/11,
with actual 375/1440 layouts and synthetic transport/challenge only.

`partner-comparison.png` compares the same October 2026 overview state: source
normalized to 1440 wide, actual 1440x1000 minus 59px fixture toolbar, unscaled,
8px gutter and bottom padding on a 2888x1040 canvas. Both individual viewports,
native-sized focused captures, initial failure and source hashes are retained.
The full source still includes different demo history and unfinished company
onboarding; this is not a full-parity handoff. No separate mobile source exists.

- Typography: existing local Inter, restrained 400/500/600 weights, no viewport
  font scaling or negative spacing. Long mobile title wraps, not clipped.
- Layout: dark 236 px sidebar, unframed workspace bands, white repeated rows,
  6 px controls, mobile drawer; no nested decorative cards or horizontal overflow.
- Colors: mint active navigation, near-black green sidebar, neutral gray ground,
  blue/amber semantic states. Existing brand favicon is preserved intentionally.
- Images: three individually generated generic content-production illustrations,
  optimized to 640 px WebP (about 25/39/35 KB), with explicit illustration alt text.
  They are not customer media, company locations or evidence of accepted work.
- Copy/content: creator counts remain explicitly current-page scoped. Operator
  lead counts use the complete authorized search/company scope across all pages,
  and group selection never changes their meaning. Partner money is exact
  minor-unit data from the original DTO. The fixture's example balances are not
  actual earnings. Missing agreements, unknown outcomes and denials remain truthful.

## Findings And Remaining Work

- [P1] Local server-issued link and explicit protected entry/source capture now
  have 222/222 contracts/HTTP, 5/5 native HTTP and 11/11 focused browser evidence.
  Company submission/recovery and protected review now have separate local
  364/364 contract/module/HTTP, 23/23 native/HTTP and 22+16 browser receipts.
  Cross-session own discovery now has separate local 147/147 module/HTTP,
  23/23 native/HTTP and 15/15 actual inbox/shell browser receipts. The later selected
  company entry adds 262/262 focused, 13/13 native HTTP and 19/19 composed browser
  evidence; the styled inbox now passes 24/24 at 375/1440. The composed fixture
  runs actual provider, client, ProtectedPage and Dashboard queries; SDK/HTTP and
  PageLayout remain explicitly synthetic/replaced. See the exact
  [2026-10-29 acceptance](docs/PARTNER-COMPANY-WORKSPACE-ACCEPTANCE-2026-10-29.md).
  Real isolated
  Auth/Turnstile and approved applicant entry acceptance still remain. The canonical consent registry is empty;
  unavailable config/consent cannot expose a usable live link. This is not public
  activation or completed company onboarding; full partner-mock parity stays open.
  Event history is now implemented through private local SQL 122 and verified
  HTTP, with UTC filtering and exact amounts; it has no cloud release receipt.
- Resolved locally: operator cross-company totals and combined Today agenda now
  use the complete authorized 123/API contract, not partial inbox/lead page sums.
  Current-scope contact, historical attribution, company-local dates, 20+1 paging,
  failure/retry, unavailable timezone and withdrawal states have separate native,
  HTTP, strict-parser, lifetime and real-browser receipts. See
  `docs/OPERATOR-WORKDAY-ACCEPTANCE-2026-10-28.md`; no cloud release is claimed.
- Resolved locally: the operator all-company lead search/group/company bar is
  implemented by 124/API/Explorer, with complete native authorization and counts,
  20-row replacement pages and small-screen native selection. Actual browser
  search/filter/card/open/close/denial and original booking-read identity pass.
  A later connected 15/15 actual browser/HTTP/native matrix now verifies selected
  stage/booking submissions and exact recovery. It remains distinct from these
  earlier read-only browser/split-layer cases and does not establish real Auth
  or cloud acceptance. See `docs/LOCAL-READINESS-ACTIONS-2026-10-28.md`.
- Open product definition: initial-contact success and next-contact events still
  have no authoritative definition. Tracking is explicitly unavailable; created
  time is labelled UTC, not passed off as a planned next-contact time. Summary
  has three backed metrics rather than a fabricated fourth. Sidebar sections
  without a distinct supported workflow were not added as fake destinations.
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

Latest search evidence: 759/759 exact cumulative native SQL/HTTP, 24/24 focused
native/HTTP, 1052/1052 portal UI, 1447/1447 operator regression, 82/82 review/
checkout/fixture/bundle and 35+30 shared Auth/API tests. Full standard build with
353 compiled cold-start checks and final browser 31/31 pass. These overlapping
local layers do not establish real Auth, cloud or commercial acceptance.

## Current IAB Follow-Up, 29 October

The user reconfirmed the three source mocks. This pass reused the existing
portals and styles; its runtime changes concern portal entry/sign-out and fresh
workspace selection, not a new visual direction or public activation.

Current IAB evidence is in `output/design-qa/approved-portals-2026-10-29/`:
separate `operator`, `partner` and `creator` desktop/mobile images, operator
mobile menu/filter captures, `*-comparison.png` and `*-header-focus.png`.
The final operator comparison uses in-progress selection, partner October 2026,
and creator all jobs. Synthetic identities/counts/history differ intentionally
from generated illustrations. No real funds, contacts or accounts are shown.

CSS viewports were 1440x1000 and 375x900, DPR 1. The IAB screenshot API returned
1425x990 and 360x864 pixel files respectively; do not label these as native
1:1 viewport captures. Full-view comparisons resize only the 1487x1058 source
proportionally to 1425x1014, crop 59 screenshot pixels of fixture toolbar, and
place the unscaled implementation beside it with an 8px gutter and bottom
padding (2858x1014). Header focus pairs are unscaled 900x280 crops on an
1808x280 canvas. Final matching operator/partner captures were taken after
observing scrollY 0; the earlier desktop observation file records an interim
scroll offset, not the final comparison position. An initial partner comparison
was scrolled and invalid; it was recaptured, regenerated and reopened.

Both source and implementation comparisons were opened. Typography retains
local Inter and the existing softer UI weights; mint/neutral colors and real
Lucide icons remain. Mobile navigation, in-progress filtering, opening/closing
a job and month selection were exercised in IAB. Final mobile observation
records no horizontal overflow, loaded image and no captured console warnings
or errors. Browser source uses synthetic Auth/API, not a real session.

This does not resolve the prior full-parity blockers: operator contact-success
and planned next-contact data still have no authoritative definition, and the
implemented information density/navigation is not an exact copy of invented
mock workflows. The creator metadata and longer truthful job descriptions still
push fewer desktop rows above the fold than the reference. Public applicant
Auth/consent remains unaccepted. No visual handoff as fully complete is claimed.
The SDK persistence gap and exact local test layers are recorded in
`docs/PORTAL-ENTRY-ACCEPTANCE-2026-10-29.md`.

## Implementation Checklist

- [x] Shared scoped shell, previous font, reduced-motion behavior, actual navigation.
- [x] Operator scoped leads, separate cooperation/profile, original actor guards.
- [x] Local complete operator summary, company-local Today and compact disclosure.
- [x] Local complete authorized lead search/company/groups and compact mobile select.
- [x] Partner exact aggregate balances and actual terms/code workflow.
- [x] Own confirmation history, UTC month filter, desktop table/mobile cards.
- [x] Creator actual assignments, responsive rows, page filters and original commands.
- [x] Current-page nearest deadline and existing detail open/close at 375/1440.
- [x] Desktop/mobile ready-state screenshots and same-page comparisons.
- [x] Local server-issued own link and explicit public source-capture UI.
- [x] Local applicant submission/recovery and platform-only company review.
- [x] Local cross-session own application discovery, without tab metadata/cookie.
- [x] Local exact selected-company handoff, cancellation and destination read binding.
- [ ] Complete approved real applicant entry/Auth acceptance in an isolated deployment.
- [ ] Define authoritative initial-contact/next-contact events without invented metrics.
- [x] Selected browser-to-native stage/booking submission and recovery from Explorer.
- [ ] Separately authorize and verify an isolated cloud Preview; no release here.

final result: blocked

Blocked means full approved-mock parity is not yet complete, not that the local
pages fail to render. This report must not be presented as 100% product readiness.
