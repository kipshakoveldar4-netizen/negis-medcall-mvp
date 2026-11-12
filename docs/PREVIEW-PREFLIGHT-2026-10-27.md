# Preview Preflight: 27 October 2026

Read-only recheck from local base `4b2028e`, branch
`codex/blog-publication-runtime-fix`. No deployment or configuration change.
This supplements the [26 October receipt](PREVIEW-PREFLIGHT-2026-10-26.md),
not a claim that the accumulated branch is approved or isolated in the cloud.

## Selected Deployment

The authenticated Vercel deployment view still reports:

- Project `yeldar-s-projects/negis-medcall-mvp-api-server`.
- Ready **Preview** `dpl_8CXaiuXmMfBY1EfrjqtMT2GNVjWv`.
- Domain `negis-medcall-mvp-api-server-6c11l89kr-yeldar-s-projects.vercel.app`.
- Source `codex/site-blog-release-20260929`, commit
  `f18f4113369f6f786312bb435e74953ea63637a4`.
- Created display: 25 October 2026, 02:14:48 GMT+5, duration 44 seconds.

This is not the current local API/UI/115 candidate. A Ready badge and an
isolation description do not prove its effective database or external senders.
The CRM itself, its sessions, APIs and tenant records were not opened.

## Preview Metadata

From the deployment's Preview environment link, Project tab, SUPABASE search:
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` each have an override scoped
to Preview + `codex/site-blog-release-20260929`. The same five names also
have common **Production and Preview** rows. No row for the current local
branch was visible in that filtered result.

The **Shared** tab, with the same Preview and SUPABASE filters, now reports
`No Results Found`. This closes the earlier uninspected Shared/SUPABASE view
only; it is not an exhaustive inventory of other names or environments.
Branch tracking remains enabled for unassigned branches, and the Preview
environment reports no attached domains.

All values remained masked/Secret. No Reveal, copy, export, secret read or
variable edit occurred. Names and scopes cannot identify the actual Supabase
project or prove that frontend and server keys belong to the test database.
Do not infer an isolated target from them or fall back to common bindings.

## Remaining Gate

Before creating a new candidate, independently establish its exact test-only
build and runtime database bindings and disabled/unprovisioned external
senders/workers. Then inventory the approved test schema/ACLs, select only the
necessary coordinated SQL/API/UI delta and drain incompatible writers. The
current [93-check appointment gate](APPOINTMENT-ACTOR-READINESS-2026-10-27.md)
is generated locally, not executed in this project or any cloud database.

Only navigation and read-only view/search interactions took place. No push,
redeploy, domain/protection/credential/account/role change, SQL, installation,
provider request or expense occurred. The temporary audit tab was closed;
user-owned tabs were left alone. Production, Baspana, salons and WhatsApp
were not changed.

## Later Read-Only Recheck

Local base a0c71eb, same day, G7-C59. This supplements the earlier receipt;
it is not a new deployment, target-schema write or approval to ship the branch.

The authenticated Vercel Overview still shows Production at de97fb6 on
codex/postponed-production-20261023 and the same two public CRM domains. Only
project metadata was viewed; neither customer domain nor its CRM was opened.
The active Preview listing still points to 6c11l89kr / site-blog-release, not
the current local candidate. The local branch is listed with an older
September deployment. No push/redeploy/rollback/domain change took place.

Preview + SUPABASE still shows the five old-branch overrides and the same
common Production and Preview rows. Shared + Preview + SUPABASE returns no
results. Before filtering, old-branch Config rows also included sender/worker
names for Meta/TikTok, WhatsApp/Wazzup, Telegram, VAPID and Insights. Several
token/secret-named Config rows display Needs Attention. Values remained
masked; no Reveal, copy, export, rotation, edit or permission change occurred.
Their presence/type does not establish whether they are empty, valid, live
or test-only. Neither the current database binding nor disabled senders is
proved by this view. Do not push the local branch into inherited common values.

The separate Supabase project was independently identified in its dashboard:
medina-os-site-test, ref ukiobbwsdoblooynzlnx, Healthy, FREE/NANO. Its
main/PRODUCTION label denotes the main branch of this test project, not a
visit to medcall-negis-crm or a working salon. Only this project was queried.

The exact generated 112-check metadata query was transferred with matching
SHA-256 8f16cfe53e02a51450623a2d2d10dbe48b0efeb784053b25e27317aadc20e5bd,
including BEGIN READ ONLY and the ten-second statement limit. It returned
112 distinct boolean rows: **69 true / 43 false**. This is a schema gate,
not a project-completion percentage or 43 demonstrated vulnerabilities.
The full JSON result was exported from the visible Results menu; no domain
row, contact, auth user, business setting, secret or payment was read.

A second READ ONLY catalog query explains the refusals. Its SHA-256 is
f8ef0799cae557593e66502068cd6ff7cbb157acff0abf3f7b2dbe61a9b4e03e.
Seven newer routines, the Auth-origin relation and the edit-version column
are absent. An execute check for a missing routine is false by design; it
does not mean the browser has been granted that routine. The three exact
legacy 063/064 bodies still have service EXECUTE. Capacity uses the reviewed
073 body 37ff4acb..., private to browser/service roles; the sole BEFORE UPDATE
trigger is its enabled type-31 guard. This distinguishes missing coordinated
updates from an unexplained function-body replacement.

The scoped source candidate is therefore **102, then 115/116/117/118**, not
raw 009-118 replay. A disposable native source baseline reproduces all 112
observed booleans and the exact 11-routine/trigger inventory. Applying only
those five original files makes its gate 112/112 while preserving an owned
legacy appointment tuple, contact, staff role and receipt. Legacy provenance
is not backfilled: v2 recovery returns the explicit unavailable outcome;
new create/replay/PATCH works. This is not a target DDL/data dump, proof about
unknown target objects/data/pending outcomes, real Auth or a Preview release.
It does not cover the rest of the accumulated G1-G8 schema or API/UI delta.

Local audit artifacts, only under node_modules/.cache:

- preview-112-gate-8588fc18.json and matching .png screenshot.
- preview-dependency-reasons-60968558.json.
- appointment-preview-cutover-first.log (12/12 native source cases).
- preview-source-ready-cutover.log (12/12 after pinning both source-query
  hashes and the test-project identity in the offline fixture).

The sanitized catalog observation used by that offline test is tracked in
scripts/fixtures/appointment-preview-catalog-20261027.json. It contains
metadata only, no customer/auth rows or keys. Two private SQL-editor query
snippets were created for this audit; no migration, table data, role, grant,
account, provider or commercial setting was changed. Both transactions
completed. Save was not clicked; the editor/history may retain these private
metadata-only queries. The temporary audit browser tabs were closed; existing local
demo tabs were not changed or closed.

Remaining: exact selected API/UI/SQL delta, verified test-only build/runtime
credentials and sender/worker isolation, legacy-outcome reconciliation and
coordinated writer drain. That cycle used the then-current 112-check gate; the
later journaled PATCH candidate below requires a new current check after any
approved cutover. No cloud migration or candidate deployment is approved by
these local tests or metadata observations alone.

## Later Local Journaled PATCH Candidate

G2-C24/G7-C60, base eed7092: the current API additionally requires 119 and its
service-only journaled writer. The old version-bound entry is now owner-private
in that source candidate. The current generated metadata gate has 130 conditions.
The saved 69/112 result and exact two remote query hashes above remain historical
observations; no new cloud query, DDL, fixture or deployment was performed here.

The existing disposable source-baseline proof now has a sixth-source phase:
original 119 follows original 102 + 115-118. Its 130 checks pass; one owned edit
and journal commit together, a stale retry creates no extra event, and legacy
service PATCH refuses. Its owned historical and current rows are then removed.
This remains a catalog-slice compatibility proof, not a clone, reconciliation
of unknown target outcomes, true Auth/Preview acceptance or a G1-G8 release.
Test-only credentials/bindings, sender/worker isolation and a coordinated
approved cutover are still required. Whole-branch cloud release is not implied.
