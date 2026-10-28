# Partner Statistics: Local Read-Only Milestone

Current-rule addendum, 28 October: the owner's qualifying event is the first
actual subscription payment within 168 hours of the original entry, not an
application or workspace creation. Local candidate 120 stages the source,
creates the referral only with a qualifying first receipt, and preserves paid
historical bindings without rewriting receipts. The unchanged 109 reader thus
counts only confirmed referrals, not new pending reservations. The original
milestone and counts below are historical. See OPERATORS-AND-PARTNERS.md for
the current protocol, its limits and still-open financial/Preview gates.

G6-C3/G7-C40, base 1d33cb1, 27 October 2026. This advances the existing
operator/partner and G1-G8 plan; it does not replace its remaining requirements
or claim public recruitment, financial activation or complete platform readiness.

## Implemented

- The existing /contributors portal now shows a partner's all-time registered
  companies, paid companies, first payment receipts and renewals; historical
  earned, externally paid and available balances are separated by currency.
- A verified approved partner application AND its own existing commercial
  partner account are required. Application approval creates neither account,
  individual rates, referral source, subscription payment nor payout. A missing
  commercial account and a suspended one have explicit non-financial states.
- Current individual rates remain nullable and are not invented. Historic
  commissions use their original immutable rate/amount snapshot, not today's
  rate or a clinic's tariff price, deal revenue or advertising budget.
- /api/crm/partner-ledger is GET-only in the existing catch-all registry. It
  requires verified Auth without a clinic membership, accepts no partner or
  workspace selector and forwards only the verified subject to one SQL reader.
  It returns a narrow no-store DTO, no clinic identifiers/names, customers,
  payment IDs, referral code/link, bank details or private diagnostics.
- New local 109 adds only that service-only SQL reader. It changes no tables,
  existing grants, rates, receipts, bindings, users or activation state. It
  requires current approved contributor identity, then locks its commercial
  partner row. Exact pinned 052 referral/payment/payout writer bodies preserve
  the same partner-row serialization protocol. Data reads happen after waits.
- The SQL reader checks receipt/referral ownership, corresponding commission,
  original rate arithmetic and currency, and refuses inconsistent/overpaid data.
  It aggregates every matching row in one report, not a truncated page. A maximum
  of 256 currency buckets is a bounded-response refusal, not a partial report.
  Inherited repeatable-read/serializable snapshots are refused instead of being
  labelled current after a concurrent financial writer. This report neither
  changes nor weakens the old financial write RPCs or their separate rollout gate.
- Amounts/counts cross JSON as canonical integer strings, with explicit BigInt
  arithmetic and no Number conversion of money. KZT renders exact tiyn; other
  currencies display literal minor units rather than inventing an exponent or
  exchange rate. SQL and API reject inconsistent balances, partial DTOs, duplicate
  currencies, invalid rates/timestamps, oversized integers and contradictory
  empty history. Unknown/error is never rendered as a known zero balance.
- Refresh/focus hides old financial data before reading. Account/epoch changes
  unmount the private view and late A responses cannot restore it in B or returned
  A. A 401/403 clears the parent application view and waits for manual profile
  refresh, avoiding an automatic application/report retry loop. No payout,
  financial-write or dead referral-link control is displayed.

109 raw SHA-256:
`71c5c8183f444061492550468ac0e62417f3402bb54e8961860be7fb353db3ba`.

## Acceptance And Limits

- New contract/handler suite: 23/23, including exact amounts above safe integer,
  strict DTOs, verified subject, forged selectors, unsupported methods, no-store,
  missing schema/client, revoked rights and safe errors. API Auth is synthetic.
- Native PostgreSQL 17.11 focused lane: 24/24 including parent. Minimal exact
  source dependencies, missing/changed writer/RLS/inherited-executor refusal,
  inactive/application-only states, exact multi-currency money and historical
  rates, corrupted financial joins, ACL/rerun and read-no-write snapshots. Six
  real waits cover approval, status/Auth rebinding, payment, payout and referral.
  These are owned fictional records only, not external money or real customers.
- Final full raw 009-109 chain: 325/325 including parent, 101 exact SQL files.
  Current function bodies, RLS/table/column/function/default privileges, earlier
  workflows, current partner cases and all-table empty cleanup pass. No SQL was
  edited or stripped for execution. Source outward-effect review: 45/45.
- Real React/owned Chromium application and Control fixture: 13/13 including
  parent. Intake/review still support both roles; partner display at 375/1440,
  exact amounts, pending refresh, A-B-A, access denial without a request loop,
  malformed and actual empty data pass. Full CSS/local Inter, no document
  overflow, no external requests/runtime exceptions. Screenshots were visually
  inspected in `node_modules/.cache/contributor-browser/run-ChXzcs/`; the
  final `run-mijyXq/` preserves current 375/1440 and fictional example captures.
  SDK/transport/data are
  doubles here, not Supabase/Vercel or an actual bank/receipt integration.
- Full final root build passes both API module modes, all workspace types,
  Vite and 195 compiled catch-all normal/broken-renderer checks. New cases prove
  anonymous/invalid token denial, verified own Auth subject without membership,
  pending application denial, GET-only behavior and forged/extra-path refusal.
  Initial build failed when this new component moved directories during its
  scan; final build was started only after the source was stable.
  The subsequently added fixture-only example also passed scripts typecheck.
- Fixed no-network isolation remains 931/931 with its same 41 readers, key set
  and network/IPC guards. New native/browser/partner suites are separate; counts
  overlap and are not cumulative platform coverage.

The initial wider five-file regression was **224/227, not green**. Its three
failures are preserved in the initial log: L5d's old static transport verifier cannot trace current
AiControlCenter and site-deletion wrappers; P3e owner/admin fixtures provide
only `{members:[]}` while the current results API requires a valid timeZone.
An actual full-source-map comparison against base HEAD reproduces the same
four L5d findings before and after this increment; the results implementation
and the old P3e fixture are unchanged. These are not treated as proof of a
new partner defect or dismissed as permission to weaken authentication.
The G7-C41 follow-up repaired the verifier/fixtures, rather than excluding
these tests: the same five files now pass **229/229**, including two new
invalid/missing-time-zone refusal cases. Transport audit plus tenant isolation
passes **491/491** with current negative controls. The complex deletion and
AI-control wrappers use explicit reviewed-source receipts and exact literal
call-position admission, not a blanket request-name exemption or a claim of
general JavaScript dataflow proof. Any source edit needs re-review; additional
runtime deletion consumers fail closed. The current real React/owned Chromium
five-file runtime suite separately passes **286/286** with synthetic Auth/HTTP.
An initial run needed assistance closing its owned test browser after a cleanup
socket stall; it is not the clean acceptance run. The three deletion harnesses
now close only their own HTTP connections during teardown, and the full final
runtime run terminates unassisted in about 75 seconds. App/runtime/SQL source
is unchanged. Fixed isolation remains **931/931** with unchanged guards;
root typecheck and final scripts typecheck pass. No new build, native SQL run
or cloud acceptance is claimed by this verification-only follow-up.

Required handles reached terminal states. Current owned native/browser/server
fixtures were cleaned. Five older native run directories predating this cycle
are outside its cleanup scope; no recursive cleanup of unrelated runs occurs.
Existing user demos on loopback 5260 and 5264 remain available.
`http://127.0.0.1:5264/contributors?partner=1` shows an explicitly labelled
fictional partner example. It seeds only that browser document's in-memory
mock module, makes GET-only calls to doubles and cannot activate a real partner
or move money. Reload starts the same owned example anew.

## Still Open

1. Partner first-source capture before company registration, immutable onboarding
   linkage, real referral URL and commercial activation/terms management. Source
   retention, cross-device and self-referral rules still need explicit decisions.
   This reader does not activate the known legacy database referral function.
2. Payment/payout confirmation in Control, own receipt history and merchant
   sandbox/signatures, refunds/reversals and approved accounting/legal terms.
   No real payment or transfer is performed by a report or by a plan assignment.
3. Creator briefs/jobs, selection, deliverables/revisions, content rights and
   explicit fees. Approving the creator application remains intake only.
4. Exact coordinated candidate + isolated Preview effective configuration,
   required 052/105/109 schema/ACL and real two-user session acceptance. No
   inherited shared Production configuration or historical Preview proves it.
5. All remaining G1-G8 release, CRM, analytics, mobile/PWA, media/worker,
   infrastructure and legal/consent gates stay in the existing delivery plan.

No cloud read/SQL/config/deployment, real account, Production, Baspana, working
salon, WhatsApp, provider, paid generation, ad, real message, payment or expense
changed. Protected raw 059/065 retain their saved hashes and are not staged.
