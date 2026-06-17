# Negis — Операционная экосистема для клиник

Negis — единая платформа управления клиникой: запись клиентов, ресепшн, CRM для отдела продаж, дашборд руководителя и управление сменами агентов.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/negis run dev` — run the frontend (port assigned by workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Frontend env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_NEGIS_CONTROL_API_URL`, optional `VITE_API_BASE_URL`
- Backend env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `ZOHO_SMTP_PASSWORD`

## Stack

## Windows local setup

- `pnpm run build` now mirrors the Vercel production target: full typecheck plus `@workspace/negis` build. Use `pnpm run build:all` when every workspace package build script is needed.
- Use pnpm through Corepack: `corepack enable`, `corepack prepare pnpm@10.33.2 --activate`, then `pnpm install`.
- If pnpm shims are not available globally, use `corepack pnpm install`, `corepack pnpm run typecheck`, and `corepack pnpm run build`.
- Root lifecycle scripts are cross-platform Node scripts: `scripts/preinstall.cjs` and `scripts/run-pnpm.cjs`.
- Do not replace pnpm with npm; the workspace and lockfile are pnpm-based.
- For local Targeting Agent testing, run MedCall Targeting Agent on `http://localhost:3001` and Negis with `TARGETING_AGENT_URL=http://localhost:3001`.
- `@workspace/negis` dev mode includes Vite middleware for `/api/targeting/*`, so Windows local development does not require Vercel CLI for these proxy routes.

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 18 + Vite + TypeScript + Tailwind CSS (Neumorphism design)
- API: Express 5
- Auth + DB: Supabase (auth + PostgreSQL + Realtime)
- Validation: Zod, react-hook-form
- API codegen: Orval (from OpenAPI spec)
- UI: lucide-react icons, sonner toasts, react-day-picker v9

## Where things live

- Frontend: `artifacts/negis/src/`
- API routes: `artifacts/api-server/src/routes/`
- OpenAPI spec: `lib/api-spec/openapi.yaml`
- Generated hooks: `lib/api-client-react/src/generated/`
- Generated Zod schemas: `lib/api-zod/src/generated/`
- Supabase client: `artifacts/negis/src/lib/supabase.ts`
- Auth context: `artifacts/negis/src/contexts/AuthContext.tsx`

## Architecture decisions

- Auth and all CRUD data is handled directly via Supabase client (supabase-js) — not via the Express API server
- Express API server is used only for aggregated/computed endpoints (e.g. dashboard metrics)
- Neumorphism design system: background #E8EDF2, neu/neu-sm/neu-lg/neu-pressed CSS classes in index.css
- Multi-tenant: every query filtered by clinic_id from user_roles table
- Row Level Security (RLS) enforced at Supabase level
- Currency: ₸ (tenge) everywhere, never ₽ or $
- Language: Russian throughout the entire UI

## Product

- **Запись** (/booking): Операторы записывают клиентов с выбором даты, времени, услуги
- **Ресепшн** (/reception): Отмечают приход/неприход клиентов
- **Negis CRM** (/sales): Отдел продаж работает с лидами (Kanban-style leads)
- **Дашборд** (/dashboard): Руководитель видит метрики, гонку агентов, загрузку по часам
- **Экран агента** (/agent): Чекин/чекаут смены, таймер, заработок
- **Админ** (/admin): Управление агентами, ролями, услугами, статусами, сменами

## User preferences

- Interface language: Russian
- Currency: ₸ (tenge)
- Design: Neumorphism (neu CSS classes, background #E8EDF2)
- No emojis in UI text

## Gotchas

- Supabase service_role key must NEVER be used in frontend code
- When adding Google Fonts @import to index.css, it MUST be the very first line
- react-day-picker v9 API differs from v8 — use v9 patterns
- All Supabase queries must include clinic_id filter (multi-tenancy)
- Only one booking_status can have is_confirmed=true at a time

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- MedCall Targeting Agent integration is documented in `docs/TARGETING-AGENT-INTEGRATION.md`
- Supabase SQL schema is in `attached_assets/NEGIS_MASTER_PROMPT_1778832288165.md`

## MedCall Targeting Agent integration

- Negis proxies Targeting Agent through backend routes, not directly from browser code.
- Env: `TARGETING_AGENT_URL=http://localhost:3001`, optional `TARGETING_AGENT_API_KEY`.
- API routes: `GET /api/targeting/health`, `POST /api/targeting/analyze`, `POST /api/targeting/launch`, `GET /api/targeting/reports/:campaignId`.
- Frontend MVP page: `/targeting-agent`.
- Smoke test: `pnpm run test:targeting` with `NEGIS_TARGETING_PROXY_URL` when the Negis API is not on `http://localhost:3000`.
- Windows local URLs: `http://localhost:3001/health`, `http://localhost:3000/api/targeting/health`, `http://localhost:3000/targeting-agent`.
- Meta Marketing API remains a production next step.
