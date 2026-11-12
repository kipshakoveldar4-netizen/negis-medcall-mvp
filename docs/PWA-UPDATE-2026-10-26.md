# PWA Update And Draft Acceptance

G7-C32, 26 October 2026, base `fca357c`. Local only. No real account, database,
Baspana/salon, WhatsApp, provider, advertising, paid generation or expense was
accessed or changed. This is not installed-app, Preview or whole-platform approval.

## Boundary And Reproduction

The [owned browser test](../scripts/fixtures/pwa-update-browser.test.mjs) starts
a fresh installed Chromium profile and separate ephemeral loopback Vite
[server](../scripts/fixtures/pwa-update-browser.mjs), without app env/config.
API/nonlocal hosts are denied. Only the real worker's BUILD_ID changes in
memory: qa-pwa-1, 2 and 3. Registration, waiting, activation, clients.claim and
beforeunload are real. Calendar/editor/MobileNav/UpdatePrompt and full CSS are
actual source; CRM/Auth are synthetic. No form is submitted. The separate
beforeunload toggle is synthetic, not proof every production form guards drafts.

At 375x640 the old update button occupied y566-610 while nav began y562.
Overlap also reproduced at 390, 768 and 1023px; desktop was already accessible.
Cancelling native beforeunload kept the draft but left Updating permanently
disabled; retry could not load the new shell. Corrected baseline: **4 pass /
6 fail**, including parent (four compact widths, cancelled reload, retry timeout).
An earlier harness clicked an animating modal and assumed one development
navigation; those assumptions were corrected, not credited as product defects.
Vite's initial optimizer reload is excluded from worker-operation comparisons.

## Fix And Acceptance

The banner clears compact nav/safe-area below 1024px, uses its desktop position
above that, and stays below form/profile overlays. Russian copy warns to save.
A requested reload leaving the document alive releases busy after one second
and offers a new explicit reload. No automatic retry, saving or skip-waiting
resend. Unmount clears recovery; retired callbacks cannot write. Actual
navigation disposes the old document's timer.

- Real browser **11/11**, exit 0, no skips. First install is silent. Waiting
  and foreign activation retain the real editor title. Cancelled reload keeps
  the synthetic guarded draft; explicit retry reaches qa-pwa-2 once.
- Measured 375x640, 390x812, 768x900, 1023x768, 1024x900, 1440x900: no document
  overflow; update and every visible nav button pass native hit tests. At 375px
  update ends y530, nav begins y562. No runtime exceptions.
- Actual component VM lifecycle plus installability/source **37/37**: own/foreign
  and repeated cancellation, duplicate clicks, retry, timer cleanup, stale
  callbacks and existing install/unmount paths. Not additional browser cases.
- Fixed no-network **782/782**, unchanged 41-reader snapshot/network/IPC denials.
  Its 30 update lifecycle cases overlap the 37 above.
- Full build: both API modes, all types, 143 normal/broken-site cold starts and
  Vite pass. No API, worker source, schema or cloud change.

Only owned HTTP, its Vite websocket and embedded date-picker icons were observed.
Application fetch remains denied by CRM mocks. The second owned tab, browser,
profile and server closed. The existing user demo is separate.

## Pixels And Remaining Gates

Owned-browser PNGs were saved and visually inspected, only in ignored local cache:

- [Before: covered button](../node_modules/.cache/pwa-update-20261026/baseline-banner-375.png).
- [After: 375x640](../node_modules/.cache/pwa-update-20261026/banner-375.png), SHA-256
  `bcba893a594920c29677b89cbc5fbb080eadf7c8289cf0db4ea534e9df8bd3c7`.
- [After: 1440x900](../node_modules/.cache/pwa-update-20261026/banner-1440.png), SHA-256
  `352daa688ca2042cc57a8ff44c43dcfde08bbb8919957fe8bc78ee23380283d8`.

The C32 third-version sample contained qa-pwa-2 and qa-pwa-3 caches, but
[C33](PWA-CACHE-2026-10-26.md) established that the sample preceded completed
activation; that sample alone was not proof of failed eviction. C33 separately
reproduces and fixes late-cache creation with real-source deterministic races
and accepts the fully activated real sequence. C32's draft assertion proves
form state/new controller only. Physical touch and
safe-area, iOS/WebKit, installed launch, offline/reconnect, every route/role/form,
pending-write recovery and current isolated Preview remain separate gates.
This is not universal draft persistence or automatic saving.
