# Partner Link And Public Source Entry: Local Acceptance

Date: 2026-10-28. This increment does not close G6 or approve a release.

## Implemented Boundary

- The partner overview/terms view requests a server-issued HTTPS link. The
  endpoint uses verified Auth and the existing SQL terms reader, never a browser
  actor, commercial status, code or origin. Only current own approved, managed,
  accepted and commercially active terms can produce a link.
- The configured application origin, full entry configuration and an approved
  canonical attribution notice are required. The real notice registry remains
  empty. Production cannot turn this into a usable public link by supplying an
  arbitrary environment version; fixture notice data is explicitly synthetic.
- `/r/:code` loads a literal notice, with unchecked consent. No challenge or
  source mutation occurs before the visitor's explicit action. A denied/blocked
  challenge is not success. Its widget, listeners and callbacks are retired on
  cancellation, expiry and unmount; the fixed provider loader is tested without
  contacting the provider.
- Prepare and capture remain separate confirmations. A lost prepare response
  retains only its original in-memory request; capture retries use the original
  protected cookie. No retry is displayed as a company registration or payment.
  Confirmed expiry must match the original seven-day receipt.
- Account/profile/read lifetimes fence the link and clipboard feedback. Focus
  revalidation hides the old URL before waiting; a revoked profile cannot retain
  an actionable response. The public entry does not require staff membership or
  get covered by the staff workspace picker. Staff routes retain that picker.
- Referral paths/codes and referral referrers remain excluded from analytics.
  The analytics collector, legal pages and real consent registry were not changed.

## Receipts And Limits

Ignored logs under `node_modules/.cache/` are reproducible from package commands.
Layers overlap and must not be summed into a project percentage.

| Command / scope | Result | Authority exercised |
| --- | --- | --- |
| `test:partner-link` | 222/222 | Actual strict parsers, anonymous client/challenge modules, workspace-picker component and compiled CRM HTTP boundary; SDK/DB/challenge doubles where stated |
| `test:partner-link-native-http` with `MEDINA_TEST_POSTGRES_NATIVE=1` | 5/5 | Actual compiled catch-all -> existing terms RPC -> owned native PostgreSQL, reviewed 009-124 chain; only Auth identity is synthetic |
| `test:partner-link-browser` | Frozen styled rerun 11/11 | Actual React components and owned browser, 375/1440; API/challenge responses and clipboard are synthetic |
| `test:portal-design-render` | 31/31 after density correction | All three actual portal pages, ready/empty/error and navigation; 375/1440; only owned local assets and in-memory API |
| `test:workspace-selection` | 138/138 | Existing AuthProvider/session/picker regressions plus public-entry membership cases |
| scripts `test:web-analytics` | 59/59 | Actual collection policy; referral route/code/referrer are excluded |
| `test:partner-entry-http` | 9/9 | Existing strict entry route, cookie binding, origin, expiry and unchanged original capture |
| `test:portal-design` | 14/14 | Fixture model, safety gate and in-memory bundle of actual portals |
| `test:portal-ui` | 1071/1071 | Standard cumulative UI regression, including actual parent own-link request/denial/ABA wiring with an explicit child boundary double |
| `test:api-surface-authorization` | 35/35 | Existing shared API/security boundary regression |
| Root `build` | Exit 0; 359 cold-start checks | Full typechecks across seven workspaces, both API module modes, compiled cold start and normal Vite/PWA client build |

Native link acceptance executes four real loopback HTTP reads: active own link,
foreign profile, revoked partner approval and commercial suspension. It verifies
three native `P1141` denials, exact fixture cleanup, unchanged financial rows and
unchanged public ACL/RLS/role-membership snapshots. It creates no subscription,
payment, referral, commission, workspace or provider operation.

The public browser proof is not connected browser-to-native cookie/Turnstile
acceptance. It cannot prove a real browser's Secure cookie handling across login,
a real approved notice, email confirmation, WAF configuration or cloud operation.
Its source mutations are in-memory data only. Durable recovery across reload is
not established by retaining an in-memory prepare request; the server's surviving
cookie and original source are the separate existing anchor.

## Visual Evidence

Current full-portal captures/report are from owned disposable browser output
`medina-portal-design-render-b4Rrxc`; frozen focused captures/report are from
`node_modules/.cache/partner-link-entry-browser/run-NHBhhH/`. Sanitized durable
evidence is in `output/design-qa/contributors-2026-10-28/partner-entry/`, including
the first density iteration, six focused captures and both full-portal viewports.
No real account, customer, agreement or financial row appears in it.

`partner-comparison.png` compares the approved source and actual October 2026
partner state. The source is proportionally normalized to 1440px; implementation
is unscaled after removing only the 59px fixture toolbar (1440x941). The 2888x1040
canvas has an 8px gutter and bottom padding. `source-manifest.json` records inputs,
dimensions and hashes. This is a comparison, not a claim that different synthetic
history rows, exact code URLs or unimplemented onboarding already match the source.

The first link iteration introduced duplicate section lines and pushed all
history rows below the desktop viewport. Removed only those adjacent redundant
lines/empty feedback spacing, compacted the adjacent rates and retained every
figure. The final actual-browser assertion requires the first history row to fit
inside the initial 1440x1000 viewport, even with the 59px fixture toolbar.

## Failed Runs Kept

- The prepared-response parser originally accepted an inherited `prepared`
  property with a padding own key. The 119/120 counter-run is retained; the parser
  now requires the exact own property and the combined final suite passes.
- A newly added empty-permission assertion expected literal `false` where the
  provider intentionally removes the permission key. Corrected that assertion
  to check the actual absence of permission; existing denial assertions remain.
- The analytics suite had two stale expectations: the already-existing excluded
  contributor route and the already-existing October 24 privacy revision. Aligned
  test expectations, preserved content/disclosure checks and added referral-path
  exclusions. No analytics allowlist or legal page was edited.
- The first standard portal-UI run rejected the new child import because its
  bounded parent-navigation fixture did not yet declare a link boundary. Added
  that boundary like the existing ledger/history children, retained their tests,
  and added request/denial/ABA parent assertions. Actual child implementation is
  exercised by the separate real-browser proof, not this boundary double. The
  full repeat passed 1071/1071; no failed tests were dropped.
- One early root build failed at the PWA stamping hook. A separate in-memory
  diagnostic build, disabling only that output-writing hook in the diagnostic
  process, passed; it is not accepted as the normal build. The original log is
  retained. A subsequent typecheck caught Node-only listener types in a new test
  shim; fixed that test type and kept the failing log. Final normal build receipt
  passed above; no build/PWA guard is bypassed in source or final command. The
  accepted log is `partner-link-entry-build-accepted.log`; final suites use
  `partner-link-final-combined.log`, `partner-link-native-http-verified.log`,
  `partner-link-entry-browser-frozen.log` and `partner-link-portal-render-density.log`.

## Remaining G6 Work

Next is authenticated applicant company submission and outcome recovery, then a
protected platform review queue over the existing 120/121 foundations. The
Path-scoped entry capability must not be exposed to JavaScript or silently moved
to a sibling endpoint. Original actor/source/request identity and original
first-paid deadline remain authoritative; approval is not a payment.

Canonical notices, approved applicant signup/confirmed-email policy, cloud
Auth/Turnstile/WAF acceptance, payment sandbox/provider evidence, refunds and
payouts remain separate unfinished gates. A company can be approved after the
referral deadline without becoming eligible for a new seven-day commission window.
The partner's own new company remains allowed on the same existing rules.

No new migration, real consent, account, remote setting, deployment, send,
advertisement or charge occurred. Production, Baspana, salons and WhatsApp were
untouched. Protected pre-existing 059/065 raw hashes remain respectively
`c56c820f9b29b28f96de34b51cb63af44f29be207b7c76740c491c9811aaae47` and
`ccc908b1a91126540b78dedcbfb75ae86e191d057fbeeeb4742241e8a0c61984`.
