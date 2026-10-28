# Partner Company: Exact Workspace Entry

Date: 2026-10-29. Local increment after `817dedb`; no release or cloud change.
This is acceptance of a selected-company entry path, not all G1-G8 or a public
registration/payment launch. No new migration or dependency was added.

## Implemented Path

1. The approved selected inbox row offers an explicit `Открыть CRM` action.
   Pending/rejected rows do not. The action binds the original actor lifetime,
   frame, page, row and controller. Busy controls cannot retarget it; refresh,
   blur, unmount and actor/mode changes retire it. There is no generic dashboard
   link which silently preserves an earlier company.
2. Before the first request, the real provider quarantines the former selection,
   permissions, purpose, choices and both private read caches. The parent then
   confirms the exact original application/revision through the existing route:
   `GET /api/crm/partner-company?view=workspace&applicationId=...&revision=...`.
   Only these scalar fields and router `path` are accepted. The verified Auth
   subject is passed to existing `read_growth_partner_company`; original
   applicant/current owner, approved DTO and expected revision remain required.
3. The parent also matches the returned workspace to the selected row. The
   provider freshly reads auth-context with the immutable actor, current token,
   cancellation and caller guards. Only one matching owner membership may be
   applied. Purpose/vertical/role come from that verified membership; only then
   does navigation occur. A changed/missing owner produces a typed denial, not
   a successful or empty company. Other failures do not restore the old tenant.
4. A pending/failed target intent fences ordinary same-user Auth resolution:
   TOKEN_REFRESHED/USER_UPDATED cannot silently choose another sole membership.
   A successful explicit selection remains the target of later rechecks. A new
   explicit picker choice may select a different verified membership; that is
   independent of the failed target, not reported as target success.
5. The mounted provider binds an in-memory read scope. Shared or unavailable
   localStorage is only a best-effort bootstrap convenience, never a competing
   live tenant source. Neutral API collections show no demo seed, do not read
   or write, and old authority callbacks cannot publish or cache a late result.
   List-cache clears have a generation fence. External strict-access operator
   collections retain their separately bound authority.
6. ProtectedPage keys its real destination by actor/company/role/purpose so an
   in-place change remounts it. Company sign-out immediately retires its local
   lifetime and invokes the provider pending-exit protocol before SDK completion.
   A delayed or failed SDK exit cannot let a held entry finish.

The source cookie, intake flag, confirmed-email/notice configuration and original
submission receipt are not renewed or required to read an already-owned company.
This path does not submit, close, approve or pay an application or change a grant.

## Verification Ledger

Layers overlap and are not added into a project percentage.

| Layer | Evidence / exact boundary |
| --- | --- |
| New provider/client/parent/read binding/compiled HTTP command | 262/262; final post-build repeat also exit 0. Actual source, synthetic scheduling/SDK/transport or RPC responses. 105 provider, 34 binding, 102 parent/client, 21 HTTP. |
| Inbox component | 95/95, including all prior 45. Actual parser/component with hook/event/callback doubles; no DOM/provider claim. |
| Styled inbox Chromium | 24/24 at 375/1440, retaining prior 15; 43 captures, 14 frozen source identities, no runtime exceptions. Callback/identity are synthetic, not actual target navigation. `run-CvOuLG`. |
| Shared roles, tenant transport, account/profile/sign-out and existing selection | 753/753, zero skipped/TODO. Main final `company-workspace-regression-main.log`; includes 102 parent/client cases above. |
| Ordinary complete build | Exit 0, seven workspace typechecks, API both module modes, 449 cold-start checks and normal frontend/PWA build. No disabled gates. |
| Existing calendar/booking branches | 365/365, final post-build repeat exit 0 after updating exact source assertions to the new verified destination key. The first run had 364 pass and one old-shape assertion failure, not a calendar behavior failure. Permission/route assertions were retained and the actor/company/role/purpose key is pinned. |
| Composed Chromium | 19/19, final post-build exit 0, `run-yEQbmr`. Actual parent/inbox/client/provider/token/CRM helpers, actual ProtectedPage and actual Dashboard's four initial reads. SDK and HTTP data are synthetic; PageLayout is a fixture-only replacement using real PortalShell, without push/notification plumbing. At 375/1440, stored other company, blocked storage, shared selector overwrite, in-place destination remount, route barrier, same-user Auth refresh, actor ABA, failures, blur and held/failed sign-out were checked. No real Auth/SQL claim. All recorded source identities match; browser and server closed. |
| Compiled HTTP plus native PostgreSQL | 13/13, Main run `21629` exited 0. Fresh reviewed 118-file 009-126 schema; 28 real loopback HTTP calls, 22 actual service-role reads, two observed PostgreSQL lock waits. Original/foreign applicant, current owner, pending/rejected/stale revision, disable/demotion/deletion, concurrent revocation/approval and raw duplicate query rejection. Exact business/financial snapshots and all-public-table cleanup passed; database closed. |

Local log root: `node_modules/.cache/`. Styled inbox artifacts:
`partner-company-inbox-browser/run-CvOuLG/`. Composed earlier captures/report:
`partner-company-workspace-browser/run-4M7o6D/` are historical. Current final
source-bound report/captures are `partner-company-workspace-browser/run-yEQbmr/`.
Final calendar/focused/browser logs are `company-workspace-final-*-main.log`.
Curated individual mobile/desktop images and both browser reports are retained
in `output/design-qa/partner-company-workspace-2026-10-29/`, not staged with code.

The first ordinary build found a type/component name collision; the type import
was aliased and the entire normal build passed afterward. Its failure log remains
`company-workspace-build-attempt1-main.log`. The initial native agent run `79196`
exited 1 at a 1500 ms connection handshake, before schema/cases. Process/run-dir
cleanup was verified. Resource contention was plausible, not proven. Main started
one new run only after that terminal failure and the normal build completed,
without changing connection, SQL, lock or statement timeouts. That controlled
repeat passed 13/13; its full receipt is `company-workspace-native-main.log`.

## Review Resolution And Limits

The independent [criteria review](PARTNER-COMPANY-WORKSPACE-CRITERIA-2026-10-29.md)
records earlier candidate findings, not this final source acceptance. F1 is
addressed by the provider-owned read scope; F2 by explicit target intent; F3 by
provider sign-out plus immediate page retirement; F4 by quarantine before first
confirmation. F6 is addressed by keyed destinations, authority-bound collections
and cache generations. Final composed and native evidence is recorded above;
source support alone was not counted as a passed execution.

F5 remains an explicit authorization limit: each server check is a current
authority snapshot, not an atomic two-RPC lease or proof of uninterrupted grant
continuity. Subsequent CRM requests still authorize current membership. Local
actor ABA retirement is not detection of every remote remove/restore interval.
No instantaneous remote erasure, legal guarantee or permanent access capability
is claimed.

The default inbox is wired; the submission/recovery `?new=1` form is deliberately
unchanged. Public signup/email delivery, canonical notices and consent approval,
abuse/retention policy, actual isolated Auth/Preview and complete purpose/device
coverage remain open. The consent registry stays empty and intake off by default.
Payments, refunds, commission/payout execution and commercial gates remain under
the full plan. No real provider, Meta, Telegram, WhatsApp, spend or paid generation
was exercised. Production, Baspana, salons and protected 059/065 edits are excluded.

## Local Demonstration

The separately managed `partner-company-workspace-preview.mjs` helper serves
only loopback synthetic identity/data and read-only fixture HTTP. It is not a
Preview deployment or a working CRM login. The fixture layout limit above also
applies to it. Current launch: PID 17432, `http://127.0.0.1:58156/`; startup receipt
`node_modules/.cache/company-workspace-preview.log`. The port is ephemeral.

Protected raw 059/065 and `lib/crm/server.ts`, `lib/meta/marketing.ts`,
`lib/meta/cities.ts` hashes remain identical to the start of this cycle. No SQL
file, working environment, account, password, grant or provider binding changed.
Six delegated workers had disjoint UI, unit, HTTP/native, provider, browser and
review/read-binding scopes; all are closed. The demo server is intentionally
retained for local viewing; test-owned browsers/databases/servers are closed.
