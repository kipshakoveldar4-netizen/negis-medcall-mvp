# Partner Company Submission And Review: Local Acceptance

Date: 2026-10-28. Candidate based on `f4c6cbe`.

## Scope

This increment connects the existing 121 company foundation to an applicant
page and the protected Medina Control queue. It does not activate public intake,
approve legal notices, create live users, charge a subscription, pay commission,
or change an existing clinic. The G1-G8 plan and full G6 definition remain open.

- `/partner-company` uses the current immutable Auth subject and the verified
  Auth response's confirmed contact email, never browser-supplied identity/email.
  It is outside staff workspace selection; that does not grant staff permission.
- Submission remains under the sealed entry cookie's original Path and origin.
  The browser refuses a different configured API origin, redirects and stale
  actor completions. No public signup or password storage is added.
- The Control queue is platform-allowlist-only, bounded to 20+1 rows, filtered
  and revision-checked. Approval explicitly creates a new applicant-owned space;
  rejection creates none. Neither decision is payment or commission eligibility.
- Candidate 125 preserves original 121 writers behind private wrappers. Separate
  actor/request fences close absent commands under the same execution lock.
  Reads distinguish committed, unconfirmed and abandoned; a missing row or lost
  response is never treated as proof of rollback.
- Browser storage contains only operation identifiers. Original company bodies
  stay in memory for exact replay. A committed applicant pointer survives reload
  for later review-status reads; closed absent commands cannot execute later.
- The original seven-day first-payment deadline is not renewed by submission,
  retries, review or a changed account. Self-owned new companies retain the same
  previously agreed first-payment rules.

## Verification Record

These are local, separate verification layers, not a cloud release or complete
G6 acceptance. The criteria are in
[PARTNER-COMPANY-COMMANDS-CRITERIA-2026-10-28.md](PARTNER-COMPANY-COMMANDS-CRITERIA-2026-10-28.md).

| Layer | Result | Boundary |
| --- | --- | --- |
| Focused company commands | 364/364 | 150 actual portable contracts, 97 verified-Auth response cases, 32 actual Control-module cases, 59 actual applicant page/client cases, 26 compiled catch-all cases. React scheduling/HTTP/Auth are synthetic where named; not live acceptance. |
| Company plus previous entry HTTP | 35/35 | Actual compiled handlers; synthetic Auth, notices and RPCs; unexpected external requests refused. Overlaps the focused set. |
| Native company/HTTP | 23/23 | Exact 009-125 source on owned PostgreSQL 17.11, apply/reapply, real lock waits in both orders, expiry crossing rollback, closed-key survival, actor/tuple refusal, 20+1 paging and P1252, lost HTTP responses, unchanged finance and exact fixture cleanup. Synthetic Auth/notices only. |
| Full native application chain | 760/760 | Existing behavior through the exact 117-file 009-125 chain; final original/wrapper body identities, private aliases, browser/server ACLs, RLS, no external facilities or business residue. Does not rerun the separate 23-case matrix or establish cloud acceptance. |
| Applicant browser | 22/22 | Actual component, owned Chromium, synthetic identity/transport, 375/1440. Includes successful real reload/status refresh, lost response, close-before-delayed-write, account ABA, expired-cookie recovery, storage refusal and no overflow. |
| Control browser | 16/16 | Actual App/screen/client, 375/1440, native dialog and checkbox, review recovery/close, denial/ABA, pagination, no runtime exceptions. Preserves the actual production Vite/real-SDK empty guest proof with synthetic public config and blocked external connection. |
| Existing portal/link regression | 1071/1071 and 223/223 | Separate original UI and link/entry contracts/HTTP; these counts overlap other layers. |
| Parent/account/privacy regression | 565 pass, 1 existing skip out of 566 | Existing Control, workspace/Auth and filtered analytics checks. Skip is the absent Operators status-filter control, not a company scenario. |
| Existing shared Auth/API | 30/30 and 35/35 | Original authority foundation and API surface, rerun after the optional contact-proof change. |
| Full tenant/transport authorization | 495/495 | Includes 113 tenant cases: authenticated unlinked bootstrap versus platform allowlist; exact nested path. Public-fetch audit exception masks only one AST-proven anonymous call; private/extra calls remain rejected. |
| Migration review/checkout | 69/69 | Exact 009-125 bytes, protected files and LF rule for new 125; no source normalization or repinning of older SQL. |
| Control production chunk build | 1/1 | All six business screens remain deferred; default warning limits preserved. |
| Standard root build | exit 0 | All seven workspace typechecks, both API module modes, 425 compiled cold-start checks, normal Vite/PWA build. No disabled build gate. |

Logs are under `node_modules/.cache/`: `company-commands-focused-final.log`,
`company-http-main.log`, `company-125-native-agent.log`,
`company-portal-regression.log`, `company-parent-regression.log`,
`company-review-build-final.log`, `company-command-build-final.log`, and
`company-command-cumulative-final.log`. The later frozen company/Auth/tenant
rerun is in `company-commands-accepted-final.log`.

The raw 125 digest accepted by the native test is
`018dcdbbe7cb8f6f01b9476f723cd6fc3cc34f678066bc8979fcb03602ab874c`.
The first SQL parse attempt failed on an ambiguous CASE in a shape guard;
parentheses fixed it before accepted apply/reapply. Initial native fixture
failures used four-part synthetic tokens and an invalid test-only SQL alias;
those fixtures were corrected without weakening Auth or SQL assertions. Initial
review failures caught the new chain length and missing exact checkout rule;
only the new 125 rule and expected membership were added. Failed logs remain.

Main visually inspected applicant form and Control detail/dialog captures.
Representative images and reports are preserved in
`output/design-qa/partner-company-commands-2026-10-28/`; complete browser receipts
are in `node_modules/.cache/partner-company-application-browser/run-fRm6rG/` and
`node_modules/.cache/control-lazy-browser-GGFuSG/`. They are functional extension
captures, not a same-state image comparison proving whole approved-mock parity.

## Open Boundaries

The canonical notice registry remains empty and company intake disabled by
default. Real confirmed applicant Auth, approved separate notice purposes,
isolated cloud migration/deployment and commercial/payment provenance still
require their own acceptance. No cloud schema or configuration was changed.

Full approved-mock parity and operator contact-event definitions remain open in
`design-qa.md`. No percentage or claim of whole-project completion follows from
test counts, and overlapping test layers must not be summed.

Applicant recovery currently follows the original actor/request/source metadata
in that tab's session storage. It is not an account-wide application inbox:
opening another browser/profile without that pointer or after storage removal
does not discover old applications. Cross-session lookup and the real applicant
entry/signup policy remain part of complete onboarding before public activation.
Public abuse quotas and production retention/operational acceptance are not
established by local closure/queue tests.

Later local increment: the tab-only discovery limit is addressed by
[the applicant inbox](PARTNER-COMPANY-INBOX-ACCEPTANCE-2026-10-28.md). It does
not alter these historical results or claim public/cloud acceptance. The later
increment also removes the generic dashboard shortcut; targeted company handoff
was not proved by the original approved-receipt link.
