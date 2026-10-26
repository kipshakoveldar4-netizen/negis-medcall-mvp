# Mobile Profile Scroll And Focus Acceptance

G7-C31, 26 October 2026, base `fe87b23`. Three scoped profile/navigation defects
are fixed locally. This is combined UX/keyboard acceptance of the selected
flow, not whole-platform mobile, WCAG, installed PWA or current Preview approval.
Only the existing loopback visual fixture and disposable owned-browser tests
were used. No real account, Baspana/salon data, cloud schema, WhatsApp, provider,
advertising, paid generation or expense was accessed or changed.

## Captured Flow

The current audit uses full application CSS and actual calendar, MobileNav and
ProfileDialog on `127.0.0.1:5260`, with synthetic Auth/data. Saved Product Design
context was absent; the existing product and selected style were retained.
Screenshots were captured, saved and visually inspected in this run. CSS
viewports were measured in the page; encoded JPEG dimensions were checked
separately with Sharp. Historical images were not used as new acceptance.

| Step | Capture | CSS viewport / encoded JPEG | Health and observations |
|---|---|---|---|
| 1 | [Calendar](../node_modules/.cache/g67-01-calendar-375.jpg) | 375x812 / 360x780 | No document-level horizontal overflow. Calendar scrolling stays in its region; no creation/recovery acceptance. Proportionally scaled capture, not a 375x812 bitmap. |
| 2 | [Mobile menu](../node_modules/.cache/g67-02-menu-375.jpg) | 375x812 / 375x812 | Labels wrap inside controls, focus starts on Close, background is absent from the drawer accessibility tree. |
| 3 | [Original profile](../node_modules/.cache/g67-03-profile-375.jpg), [background scroll defect](../node_modules/.cache/g67-04-profile-scroll-before.jpg) | 375x812 / 360x780 | Backdrop wheel moved the underlying calendar scrollY 0 to 812 while the profile stayed open. Closing also left focus on BODY rather than More. |
| 4 | [Background lock fixed](../node_modules/.cache/g67-05-profile-scroll-after.jpg), [short-screen focus defect](../node_modules/.cache/g67-06-profile-375x640.jpg) | 375x812 and 375x640 / matching sizes | Background no longer scrolls. On the shorter screen, Shift-Tab still focused clipped Save with panel scrollTop=0; that state was not accepted. |
| 5 | [Short-screen fix](../node_modules/.cache/g67-07-profile-short-fixed.jpg) | 375x640 / 375x640 | Save is visibly focused after Shift-Tab; dialog scrollTop=143, page scrollY=0/top=-640px. Escape restores page scrollY=640 and More focus. No page overflow. |
| 6 | [Desktop profile](../node_modules/.cache/g67-08-profile-1440.jpg) | 1440x900 / 1440x900 | Whole panel fits. Backdrop wheel is blocked; Escape restores page scrollY=640 and the sidebar opener. No console errors in the inspected tab. |

The device-notification error is an unavailable synthetic backend, not a
successful push/device check. Password fields remained empty in these captures.
Save, password change, notifications and logout were not visually submitted.

## Narrow Fixes

- [ProfileDialog](../artifacts/negis/src/components/layout/ProfileDialog.tsx)
  holds the background using the existing MobileNav fixed-body pattern, including
  root/body overflow and overscroll. Cleanup restores only inline values and
  priorities still matching its own lock; different later-owner writes survive.
  Access/context loss unlocks without explicitly scrolling a replacement screen
  to old coordinates.
- Keyboard containment still owns Tab/Shift-Tab, but focusing a wrapped control
  permits native scrolling inside the dialog. Save and Close no longer remain
  keyboard-focused outside the visible panel. External opener restoration still
  uses preventScroll.
- [MobileNav](../artifacts/negis/src/components/layout/MobileNav.tsx) restores
  the retained More trigger while releasing the drawer, before the real profile
  captures its opener. The existing current-lifetime guard still gates this
  handoff. No route, role, session, password or profile API contract changed.

## Runtime Evidence

The [actual React/Chromium suite](../scripts/src/medina-profile-modal-accessibility.test.ts)
now composes real ProfileDialog and MobileNav for handoff controls. Auth, router,
PushSettings and transport remain synthetic. Its selected CSS geometry is not
the full-application screenshot fixture.

- Before the scroll fix: **74 pass / 5 fail**, including the failed parent.
  Native wheel moved scrollY 240 to 740 at both 390px and 1440px. Incoming-style
  controls also refused the unlocked page.
- Before the handoff fix, with scroll fixed: **78 pass / 3 fail**, including
  the parent. Real MobileNav -> ProfileDialog Escape/cancel both lost More focus.
- Before visible-focus correction, with earlier fixes present: **80 pass /
  3 fail**, including the parent. Both 480px-high panels focused Save outside
  their visible scroll area. These failures are retained, not counted as passes.
- Final profile/modal/session plus MobileNav lifetime/modality run:
  **197/197**, exit 0, no skips. Native wheel, short-viewport keyboard wrap,
  incoming style priorities, later-owner changes and original scroll restoration
  pass. Account/workspace invalidation unlocks without old-coordinate scroll
  calls. Existing pending save, unmount, original bearer, A/B/A and late-result
  controls remain accepted.
- Fixed no-network runner: **780/780**, unchanged reader snapshot and network/
  IPC denials. The browser suites intentionally use owned loopback HTTP and
  are not represented as part of that no-network gate.
- Full build: both API resolution modes, all types, normal/broken-site 143
  cold-start checks and Vite pass. No new migration or database fixture.

Accepted short-screen JPEG SHA-256:
`ddba66cdd1df2329f4e3a86b0e648a1995339541223ef23ff1d9bee58f991159`.
Accepted desktop JPEG SHA-256:
`fa1b0e0fc15621eade881a7c4d88d948a82a448995f60edffb096b2ef642dbcc`.
Images are ignored local cache artifacts, not published/committed media. The
temporary audit tab was closed, viewport override reset and the existing
user-facing synthetic demonstration retained.

## Remaining Acceptance

Only measured local profile scroll/focus residuals are closed. The visual flow
used an administrator fixture; no complete route/role matrix or real account
revocation is inferred. Physical touch, software keyboards, safe-area insets,
screen readers, iOS/WebKit and installed application behavior remain unaccepted.

PWA banner overlap with bottom navigation/unsaved work, real two-version update,
logout failure/retry pixels, other current forms/routes and exact isolated
Preview acceptance remain in the [release matrix](TEST-RELEASE-CANDIDATE-2026-10-25.md).
No whole-platform percentage or Production approval follows from this cycle.
