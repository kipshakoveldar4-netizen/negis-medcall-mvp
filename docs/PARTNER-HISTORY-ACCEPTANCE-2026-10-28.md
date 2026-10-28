# Partner History And Creator Deadline: Local Acceptance

Date: 2026-10-28. Local work only, not a release receipt or permission to apply
SQL. No cloud database, Production, Baspana, working salon, WhatsApp, provider,
real payment, advertisement or paid generation was changed.

## Implemented

- New read-only `GET /api/crm/partner-history` inside the existing CRM catch-all.
  Identity comes from verified Auth, never a selected company or supplied actor.
- Local migration 122 adds one private server function and two timeline indexes.
  It reuses the approved-profile/commercial-partner checks and lock order of
  109. Browser roles cannot call it. No financial writer is added or replaced.
- History contains only the current partner's commission postings and confirmed
  payouts. It omits company identities, payment references, banking details and
  provider metadata. Exact minor-unit strings are preserved through SQL, HTTP,
  parsing and rendering, including amounts larger than MAX_SAFE_INTEGER.
- Twenty-row pages, UTC month filtering, explicit confirmation timestamps,
  separate payout styling, table on desktop and cards on mobile. The API fails
  unavailable for malformed, inconsistent, missing-schema or lock-error results;
  it does not turn an error into zero income.
- Account/lifetime changes, denial headers, old responses and old month/page/
  refresh actions cannot adopt a replacement account or page. Focus revalidation
  hides old money before requesting a replacement response.
- Creator-only nearest deadline opens the existing guarded job detail. Its scope
  is the current page, not all assignments. Completed/cancelled/declined jobs
  are excluded; the earliest future deadline wins, otherwise the oldest overdue
  unfinished job is labelled overdue. Existing command recovery is retained.

The ledger and history are separate live reads. Offset pages are individually
coherent but are not a durable multi-page snapshot: newly posted events can shift
the next page. No export or snapshot-stable traversal is claimed.

## Evidence

- Native PostgreSQL 17.11 plus compiled CRM HTTP/Auth/router/SQL: **25/25**.
  Auth authority and SDK adapter are explicit doubles; actual SQL, row locks,
  business journals and handler parsing execute. This is not Supabase Auth/JWT,
  PostgREST, Vercel Protection, merchant-provider or cloud ACL acceptance.
- Strict history parser plus actual-component/transport isolation: **186/186**.
  The reconciled host and SDK are synthetic, not React DOM acceptance.
- Actual ContributorPortal root with synthetic private child boundaries:
  **25/25**, including history approval gates and original actor propagation.
- Actual owned browser at 375 x 900 and 1440 x 1000: **28/28**, repeated after
  compacting the ledger and moving history ahead of the programme footer.
  No horizontal overflow, clipped controls, broken image, console error or
  attempted external request. Month filtering/reset and deadline detail/close
  execute the real production components with in-memory synthetic data.
- Safe fixture source/build checks: **11/11**. Contract/Auth/API surface:
  **217/217**. Migration source review plus real Git checkout preservation:
  **66/66** (114 exact sources; no normalization or historical hash repinning).
- Final standard portal UI command: **338/338**, including parser, isolated
  transport, root boundaries, creator deadlines and existing operator/draft tests.
- Full workspace/API/Node16/frontend typechecks, compiled CRM cold start
  (**353** checks across normal and broken-site modes) and Vite build exit **0**.
  Existing nonfatal sourcemap and static/dynamic import warnings remain.

Negative controls caught three retained actions in the new history presentation:
an old Next advanced the replacement page to offset 40; an old month control
replaced October with September; an old refresh cleared confirmed replacement
money. Each caused two writes and one extra GET. Manual actions now capture the
rendered request identity and refuse stale requests without clearing newer data.

Final cumulative native acceptance: **714/714**, applying all **114 exact raw SQL
files 009-122** and verifying final function bodies/effective grants. This is a
fresh owned-cluster receipt, not an upgrade of an existing cloud dataset.

An initial cumulative native run passed 712/714 (one company-approval lock-timeout
case plus its parent failed while other heavy checks ran). The unchanged focused
121 protocol then passed **29/29**, including both concurrent decisions. The
quiet cumulative retry then passed 714/714 without SQL, deadline or assertion
relaxation. The failed attempt is preserved in its own log, not relabelled green.

Initial standalone history setup also exposed a fixture-only PostgreSQL parameter
name mismatch in a negative control; the fixture was corrected without changing
122 or repinning historical bodies. An initial full build found a readonly test
Response method assignment; the typed synthetic Response subclass fixes it. The
final full build then passed as recorded above, without suppressing that check.

## Visual Evidence And Remaining Gates

`output/design-qa/contributors-2026-10-28/history-deadline/` holds individual
desktop/mobile captures, UTC-filter/detail states, same-input comparisons and the
browser report. Existing `design-qa.md` remains **blocked** for full mock parity:
issued working referral link and complete cross-company operator totals/Today
agenda are not implemented. No fabricated link, partial-page total or contact
success metric was substituted for those missing contracts.

The canonical legal consent registry is still deliberately empty. Public partner
intake, its exact notice, anti-abuse configuration, approval/payment completion,
actual identities and an isolated Preview/schema/ACL acceptance remain release
gates. Migration 122 has not been applied to any cloud database.

Protected pre-existing 059/065 working copies retain their original raw hashes;
no historical migration hash or function-body receipt was relaxed.
