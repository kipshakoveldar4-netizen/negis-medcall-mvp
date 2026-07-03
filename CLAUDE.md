# Negis MedCall CRM / Ads Automation

pnpm monorepo: Vite/React frontend in `artifacts/negis` (`@workspace/negis`), Vercel serverless API in `api/`, shared logic in `lib/`. Supabase for data/storage, Meta Marketing API for ads, Railway Targeting Agent for targeting. UI is in Russian.

## Commands
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run test:routes` / `pnpm run test:mobile` / `pnpm run test:targeting`
- `pnpm --filter @workspace/negis run dev` — frontend dev server

## Critical files
- `api/crm/[...path].ts` — CRM catch-all route (new CRM endpoints go HERE, not in new files)
- `lib/crm/server.ts` — CRM server logic
- `lib/meta/marketing.ts`, `lib/meta/cities.ts` — Meta Marketing API + city targeting
- `artifacts/negis/src/pages/AdsAutomation.tsx`, `artifacts/negis/src/pages/AdminCenter.tsx`
- `scripts/src/smoke-negis-routes.ts` — route smoke tests
- `docs/META-LIVE-LAUNCH.md`, `docs/META-ADS-SETUP.md`

## Orchestration & delegation policy

The main (Fable) session is the orchestrator: it owns complex architecture and final decisions. Subagents in `.claude/agents/` handle simple, repetitive, well-scoped work.

### Stays with the main session — never delegate
- Complex architecture and design decisions
- Meta Marketing API flow (`lib/meta/`) — the Meta App is published; this is production
- Video pipeline
- Workers and queues
- Database migrations (`migrations/`, `supabase/`)
- Multi-clinic architecture
- Railway Targeting Agent integration (`api/targeting/*`)

### Delegate when possible
- `code-searcher` (haiku, read-only): find files, trace code paths, read logs, summarize implementations
- `test-runner` (sonnet): run typecheck/build/tests, diagnose failures, minimal fixes only
- `docs-updater` (haiku): docs, comments, changelogs, `.env.example`, Russian docs — small edits only
- `implementation-worker` (sonnet): scoped coding tasks (UI polish, endpoint tweaks, tests) with a spec decided by the main session

## Invariants (apply to everyone, always)
- Photo Meta launch works and creates campaigns as PAUSED — do not break or change this
- ACTIVE launch must remain gated — never remove or weaken the gate
- Supabase signed upload works — do not break it
- City select works — do not break it
- Instagram-only placements must remain Instagram-only
- The WhatsApp destination link must remain
- Russian UI must remain Russian
- Do not add new files under `api/` (Vercel function limits) — prefer extending `api/crm/[...path].ts`
- Never expose secrets: no values from `.env`/`.env.local` in output, code, or `.env.example` (placeholders only)
