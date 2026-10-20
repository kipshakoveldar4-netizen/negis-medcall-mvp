# Mint Office Design QA

Date: 2026-10-20. Scope: selected first concept, applied to the existing CRM.
Acceptance is visual-system consistency, not copying invented mock data or features.

## Evidence

- Source visual truth: `C:/Users/Lenovo/.codex/generated_images/019ec72b-1070-7dc3-9f17-305d3ba80a93/exec-803026f4-5592-4f65-82e7-2f65fdea06cf.png`.
- Evidence directory: `C:/Users/Lenovo/Documents/Codex/medina-os/node_modules/.cache/baspana-overview-20261020/mint-office/`.
- Implementation screenshots: `dashboard-1440.png`, `leads-1440.png`, `appointments-1440.png`, `analytics-1440.png`; corresponding `360`, `390`, `768` files also cover clients, tasks and team.
- Combined comparison input: `full-comparison.png`, with the selected source and all four implemented views side by side. Focused comparison: `focused-comparison.png`.
- Source is a 1448x1086 raster board, four approximately 724x543 frames, not a CSS viewport specification. Desktop was captured at 1440x1000 CSS pixels; screenshots are 1425x990 or 1440x1000 because of the browser capture/scrollbar bounds. Each was aspect-fitted into a 724x543 comparison tile without stretching. Mobile was checked at 360x740 and 390x844; tablet at 768x1024.
- State: synthetic mortgage-profile admin, selected overview task segment; week calendar at its existing current-time scroll position; analytics at 30 days. Additional manager fixture checked own-work metrics and absence of team links.
- Local URL: `http://127.0.0.1:5198/dashboard?fixturePurpose=mortgage_leads&fixtureRole=admin`.

## Findings And Comparison History

- Initial P2: mortgage lead source column consumed 23% while the responsible-person column had 13%, splitting a long surname and making rows unnecessarily tall. Evidence: `leads-desktop-before.png` versus the source lead screen.
- Fixed: mortgage columns now use 26/12/12/21/13/16%; desktop notes clamp to two lines with full text available through title/detail. Clinical content and full mobile notes remain. Post-fix evidence: `leads-1440.png` and the rebuilt combined comparison. No remaining P2 at that location.
- Mobile review also tightened task filters into two columns and three metrics into one row, making the task list visible earlier. Evidence: final `tasks-390.png`.
- Portaled activity/contact forms use the same black primary action and neutral fields. Phone inputs are 16px/44px, action height is 44px, and shared dialog/backdrop layers are 80/79 above navigation 70. Evidence: `task-form-390.png` and browser DOM measurements.
- An early overview capture caught the entry animation at zero opacity. It was rejected and recaptured after the agenda reached opacity 1; the final comparison uses the settled view.
- Final full and focused visual comparisons found no open P0/P1/P2 issues for the agreed style scope.

## Required Fidelity Surfaces

- Typography in the initial pass: Inter/system-ui stack retained, moderate 24px page headings, compact 12-14px data labels, zero letter spacing on new surfaces, long synthetic names tested. The offline fallback was subsequently rejected by the owner and corrected in the follow-up below.
- Layout: charcoal navigation, neutral working ground, white repeated items, 8px borders/corners and restrained elevation. All seven mortgage routes passed four viewport sizes with document scroll width equal to client width. Wide data tables/calendar scroll inside labeled regions rather than widening the page.
- Colors: mint selected navigation/segments and first overview metric, black primary commands, white outlined secondary commands, semantic blue/amber/red statuses. Measured sidebar rgb(20,26,23), primary rgb(18,22,20).
- Images/icons: existing brand treatment and Lucide icons reused. The chosen design has no photographic or illustrative asset requirement; no generated bitmap was substituted for working UI. Analytics use semantic meters with actual snapshot values, including empty zero meters.
- Copy/content: Russian labels and existing status meanings retained. No fictional join/video-call action, revenue, paid advertising metric, or invented completion count was copied from the generated concept.
- Intentional adaptations: preserve the existing agenda tabs, full 24-hour calendar, richer factual analytics table and role-specific access. Horizontal workload bars replace the mock's simplified chart composition; the sidebar retains the established compact width. These are functional-product constraints, not pending fidelity defects.

## Interaction And Safety Checks

- Navigation through all seven sections, mobile More menu and contact form open/cancel.
- Unassigned-lead filter returns exactly one synthetic row; analytics 7/30-day controls update chart labels; calendar day/week modes and new-meeting form work.
- Manager fixture retains four own-work metrics and no analytics/team links. Scope invalidation, hidden stale contacts and restricted dispatch remain covered by executable regressions.
- Historical console contained transient HMR reload/createRoot errors while files were being edited. Clean final reload produced no new console errors; see `browser-console-proof.json`.
- Final checks: mortgage suite 105/105; activity/workspace 173/173; admin-session 82/82 (89/89 with mint checks); contact privacy/design tokens/route permissions/mobile overlays 36/36; fixture safety 63/63. Frontend/scripts typechecks and frontend build passed. Existing tooltip sourcemap and mixed serverAuth-import build warnings remain unchanged.
- Only loopback fixtures were used. No deployment, migration, real account, working Baspana/salon data, WhatsApp, advertising or payment changes. Foreign migration edits 059/065 were preserved.

## Implementation Checklist

- [x] Shared authenticated-workspace theme and navigation.
- [x] Overview, leads, clients, tasks, calendar, analytics and team styling.
- [x] Responsive screenshots, interaction checks and security regression coverage.
- [x] Recompare fixed lead density and settled overview against the selected source.
- [x] Keep local preview running; do not publish this redesign.

## Follow-Up Polish

- Resolved: the original self-hosted-font follow-up is complete; see the typography/motion pass below.
- Live authentication, persistence, integrations and production deployment are outside this run and are not claimed as verified.

## Typography And Motion Follow-Up, 20 October

User requested the previous softer font and smooth animations in all sections,
with phone/desktop verification and no publication.

- Source visual truth remains the selected first concept above. For the scoped
  refinement, the layout baseline is `mint-office/dashboard-1440.png`, copied to
  `soft-type-motion/baseline-1440.png` under the same evidence parent directory.
  The previous production source explicitly named Inter; the offline fixture
  had no font source under its self-only CSP and rendered the system fallback.
- Implementation: `soft-type-motion/dashboard-1440.png`, `dashboard-390.png`,
  plus all seven route screenshots at 360/390/1440. Combined visual inputs:
  `full-comparison.png` and `focused-comparison.png`; handoff board:
  `desktop-mobile.png`. Baseline and revised desktop captures are both
  1425x990 pixels at 1440x1000 CSS, no density conversion. Mobile 390x844 CSS
  produces a 375x834 screenshot because the capture excludes the scrollbar.
- State: same synthetic admin, team overview with task agenda selected. Fixture
  clock timestamps differ between runs; counts, identities and layout match.
  An initial 1280x720 capture was excluded from comparison, rather than treated
  as a layout change at the 1440px breakpoint.
- Finding P2, resolved: the fallback made Cyrillic labels and the overall type
  rhythm differ from the intended existing Inter. Bundled unmodified variable
  WOFF2 files now cover Latin, Cyrillic and Cyrillic-ext. Browser font checks
  passed for 400/500/600 and for Kazakh letters after making them visible in a
  synthetic search field. The extended subset loads on demand. The license and
  upstream sources are bundled; no external font request or CSP relaxation.
- Typography: headings and shared buttons use weight 500, metrics retain 600,
  body text stays 400. Sizes, line heights and zero tracking remain. Side-by-side
  full/focused review found no clipping, awkward new wrapping or open P0/P1/P2.
- Layout/colors/assets/copy: all unchanged from the selected system. Existing
  Lucide icons, mint/charcoal/white tokens and Russian labels remain. No new
  illustration, chart value, product feature or API behavior was introduced.
- Motion: shared page entry is opacity 0.94 to 1 in 180ms, controls/nav/rows use
  160ms paint-only transitions. No main transform, delayed unmount, exit-retained
  private data or eager Framer import. Existing agenda motion remains in its
  lazy page chunk. New entry/transitions honor the reduced-motion media query;
  executable CSS/VM checks cover that branch, not a claimed physical-device test.
- Browser checks: seven sections at 360x740, 390x844 and 1440x1000 without
  document overflow or alert errors; mobile More > Clients navigation and
  contact form open/cancel passed. Form font is Inter, fields 16px/44px,
  dialog layer 80 and main transform none. No data was submitted.
- Verification: focused mint 11/11, overview/mobile 47/47; frontend and scripts
  typechecks and final frontend build passed. Existing build warnings remain.
  Clean final browser reload has no new console errors; proofs are in the
  `soft-type-motion` directory. Local-only, no database/deployment/WhatsApp or
  working Baspana/salon changes. Unrelated migrations 059/065 were preserved.

## Approved Production Release, 20 October

The owner subsequently approved publishing this style, font and motion only.
The narrowly extracted release is 9379bdc, based on actual production 3291e0f,
not the accumulated development branch. API, libraries, migrations and project
configuration remain unchanged. An independent source/dependency review passed.

- Candidate verification: mortgage 107/107; activity/admin/privacy/mobile/tokens/
  routes 119/119; isolated cold-start 58+57; frontend/scripts typechecks and build.
- Preview g6hrlfjn6: READY, exact source fingerprint checks; ordinary browser
  login/font/CSS check and unauthenticated auth-context refusal. No protection
  bypass, new roles, fixtures or claimed new authenticated-user acceptance.
- Production qhf5davce, dpl_HxoJj546hDpkzhgQCqNA4NGUGBJV: READY and assigned
  to medinaos.com and the prior Vercel domain. Uploaded source checks 33/33.
  Environment metadata, project settings and protection match the baseline.
- Both domains return the same built entry/CSS, correct existing production
  database URL, exact three bundled Inter files and auth-context 401 without
  private data. The 155751-byte cloud CSS includes the agreed theme/motion;
  its hash matches the stylesheet observed in the isolated Preview.
- Published public browser evidence:
  `C:/Users/Lenovo/Documents/Codex/medina-os/node_modules/.cache/mint-style-release-tools-20261020/medinaos-login.png`.
  Receipts and machine-readable smoke/source proofs are in that same directory.
  Private production screens were not opened or used for testing; visual phone/
  desktop acceptance remains the synthetic evidence above. No business data or
  Baspana/salon/WhatsApp settings were changed. Previous deployment retained.

final result: passed
