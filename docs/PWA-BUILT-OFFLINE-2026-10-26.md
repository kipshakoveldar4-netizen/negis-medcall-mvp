# Built PWA Shell, Offline Launch And Legacy Upgrade

G7-C34, 26 October 2026, base `ea889ac`. Local only. No Production, real
account/database, Baspana/salon, WhatsApp, provider, ad, paid generation or expense.
**Offline shell acceptance is not offline customer-data/CRM acceptance.**

## Reproduced Gap

Actual Vite output uses dash-hashed JS/CSS names; the worker accepted only dot
hashes. Initial resources also load before the worker controls the document,
so a later cache-first branch alone cannot guarantee first offline launch.
The [in-memory built fixture](../scripts/fixtures/pwa-built-browser.mjs) compiles
real calendar/menu/update components and full CSS in production mode with fake
Auth/API, no app env/config, and an exact loopback HTTP origin. Its original
run was **1 pass / 4 fail**, including parent: built graph absent at first
activation, absent after controlled reload, and offline cold reload failed.
Private API exclusion already passed; it was not misreported as a new leak.

## Coordinated Build And Worker Fix

- [Public-file stamping](../artifacts/negis/pwa-build.mjs), used by the actual
  [Vite closeBundle hook](../artifacts/negis/vite.config.ts), accepts only named
  public shell files. HTML, manifest, generated static assets, local Inter fonts
  and PNG icons are hashed together with worker source bytes. Reordering inputs
  does not change the ID; changing any included bytes does. Missing graph,
  malformed markers, path traversal, API/remote/env inputs fail closed.
- The worker receives that exact precache list. It recognizes dash and dot
  hash spellings and explicit public-list entries. Initial install fetches the
  graph; API/auth/no-sw/non-GET/foreign paths remain excluded. No CRM response,
  token, role or session is added to the list or technical ownership marker.
- Failed precaching now rejects installation instead of activating an empty
  shell. The tested missing candidate JS leaves the previous controller,
  ownership and complete shell usable. A failed candidate can leave its empty
  inactive cache until later activation cleanup; universal quota cleanup is
  not inferred from the rejection test.

Raw worker SHA-256:
`37e174877c806774d29d48a453c617901383a4df317e6a291683136c1cb80fd9`.
Stamp helper SHA-256:
`a36135c66749a319d0b748d27cd3847dd3f6e01cb39a5c1d8aedaa2f83bf1870`.
These are a coordinated build/worker change, not an independent raw-sw release.

## Actual Acceptance And Its Limits

The final joined run is **20/20**, no skips: **8 built-browser tests** including
one parent and one known-bad legacy characterization, **11 dev-browser tests**,
and **1 post-build byte attestation**, which is NOT a browser case.

- First activation already caches the built JS/CSS graph. The FIRST subsequent
  reload is offline, before any controlled online reload, with browser HTTP
  cache disabled and the owned server refusing connections. Built JS/CSS run
  and Inter is available. Only later is a warm online visit tested.
- A synthetic private API returns online, is absent from CacheStorage, and is
  unavailable offline. App fetch remains denied by existing CRM mocks; only
  this disposable origin receives fixture XHR. Displayed business data are
  synthetic module fixtures, not cached customer data or offline CRUD.
- Real local upgrade from frozen **f18f411 worker + UpdatePrompt** to the
  current built fixture loads the new graph exactly once. Other current UI
  components are current synthetic source, not a full historical application.
  No deployed old version was opened or inspected.
- **Known-bad characterization, NOT readiness:** an already loaded legacy tab
  unconditionally reloads on controllerchange and loses its unsaved test
  meeting form when another legacy tab explicitly updates. New code cannot
  retroactively fix that old page handler. First release needs a save-all-work,
  close-old-tabs/maintenance procedure and its own owner approval; do not call
  the green characterization a safe cross-tab first-upgrade pass.
- An unavailable next-version asset makes its worker redundant without
  replacing the current controller/cache. No real file/provider was modified.
- [Actual root output check](../scripts/fixtures/pwa-built-output.test.mjs)
  freshly recomputes the full public-byte fingerprint: **7f5bfc998664**, **69**
  precache paths, exact built worker equality, no unresolved markers. Production
  application JS is read as public bytes only, never executed in the test browser.
- Fixed no-network runner **814/814**: the 12 pure stamping controls and 20
  cache VM controls are included, with unchanged 41-reader/network/IPC guards.
  They overlap existing unit totals; do not sum. Full build passes both API
  modes, all types, 143 normal/broken-site cold starts and Vite.

One intermediate harness clicked the second legacy tab before its data-enabled
button was ready. Readiness now waits for that button; the timeout is not
credited as a product defect. Fresh test browsers/profiles/servers are closed.
No new migration or cloud deployment.

## Pixels And Remaining Gates

[Fresh offline built shell](../node_modules/.cache/pwa-built-20261026/run-ztr7RD/offline-built.png)
was visually inspected: PNG **756x488**, SHA-256
`a088487a303df78bb33db226eeda7dd19ac145338ff0439a07dbf90db1cbe8ec`.
That is the encoded default-browser frame; CSS viewport was not recorded for
this capture, so it is not called phone/desktop responsive acceptance.

The separate six-width dev regression saved [fresh mobile](../node_modules/.cache/pwa-update-20261026/run-HSwyUF/banner-375.png)
and [desktop](../node_modules/.cache/pwa-update-20261026/run-HSwyUF/banner-1440.png)
frames. Their bytes match C32/C33 exactly; only those verified identical files
restore the historical base image paths after an intermediate fixture label
changed them. Future captures use unique run directories, not those base paths.

First legacy rollout coordination, installed standalone/manifest start routing,
physical devices/iOS/WebKit, full route/role/CRUD, real auth/offline recovery,
and current isolated Preview remain separate gates. The fixture serves a
calendar shell at its allowed paths; it does not accept the real Router's
ai-control-center behavior. Other G1-G8 gates and deployment isolation remain.
