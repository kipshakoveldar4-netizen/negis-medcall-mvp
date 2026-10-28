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

- [P1] Partner mock includes an issued referral URL and event history. Existing
  approved-account/ledger APIs do not provide either as a verified live resource.
  The local UI exposes the actual agreement/code workflow and aggregate ledger,
  not a fabricated share link or transaction table. Finish protected link issuance
  and paginated event-history reads before claiming full mock parity.
- [P2] Operator mock includes cross-company totals and a combined Today agenda.
  Existing per-cooperation scopes are preserved instead. A complete authorized
  aggregate/agenda contract is still needed; do not sum partial pages or expose
  the staff calendar to external operators.
- [P2] Creator mock includes a nearest-deadline shortcut. The current UI provides
  actual deadlines, page-scoped filters and the full assignment workflow, but not
  that separate shortcut. Add it with an explicit page/overall scope and recheck.

No observed viewport clipping, broken image or runtime console error in the six
final ready captures. Those checks do not establish real Auth/database/provider
acceptance. Empty/error states, role changes, recovery and command privacy have
separate fixture/unit receipts; they do not remove the feature gaps above.
Receipts: full owned-browser interactions 24/24, final captures/brand/mobile filter
9/9, operator regression 733/733, portal UI 126/126, isolated fixture models/HTTP/
bundle 11/11 with normal exit. The fixture cleanup issue was fixed by normal Vite
listen/shutdown, disabling unused HTTP-test file watchers, and separating build
plugin resources from the development-server test process; no force-exit or
dropped assertions. Full build and final frontend typecheck/client build passed.

## Implementation Checklist

- [x] Shared scoped shell, previous font, reduced-motion behavior, actual navigation.
- [x] Operator scoped leads, separate cooperation/profile, original actor guards.
- [x] Partner exact aggregate balances and actual terms/code workflow.
- [x] Creator actual assignments, responsive rows, page filters and original commands.
- [x] Desktop/mobile ready-state screenshots and same-page comparisons.
- [ ] Complete the three remaining mock regions and repeat final visual acceptance.
- [ ] Separately authorize and verify an isolated cloud Preview; no release here.

final result: blocked

Blocked means full approved-mock parity is not yet complete, not that the local
pages fail to render. This report must not be presented as 100% product readiness.
