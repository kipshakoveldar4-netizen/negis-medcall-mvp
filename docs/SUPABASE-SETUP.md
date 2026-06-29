# Supabase Setup for Negis MedCall MVP

This setup adds persistence for MVP data only:

- workspaces
- targeting campaign drafts
- targeting campaign reports

Supabase Auth is not enabled for this MVP step. The current demo registration and localStorage session flow stay active.

## Required Environment Variables

Set these variables in Vercel Project Settings and in local `.env` when you want Supabase persistence:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Frontend Supabase variables can stay as they are:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

The server-side MVP persistence uses only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Where to Get the Keys

In Supabase:

1. Open your project.
2. Go to Project Settings.
3. Open API.
4. Copy Project URL into `SUPABASE_URL`.
5. Copy the `service_role` secret into `SUPABASE_SERVICE_ROLE_KEY`.

Keep `SUPABASE_SERVICE_ROLE_KEY` server-only. Do not expose it in frontend code or `VITE_*` variables.

## Apply the SQL Migration

Run this migration in Supabase SQL Editor:

```text
migrations/009_medcall_mvp_persistence.sql
```

It creates:

- `workspaces`
- `targeting_campaigns`
- `targeting_reports`

The migration is idempotent and uses `CREATE TABLE IF NOT EXISTS`.

## Runtime Behavior

When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present:

- `POST /api/auth/register` creates a row in `workspaces`.
- `POST /api/targeting/launch` stores the campaign draft in `targeting_campaigns`.
- `GET /api/targeting/report?campaignId=...` stores the report in `targeting_reports`.
- `GET /api/targeting/reports/:campaignId` also stores the report as a fallback route.

When Supabase env is missing:

- registration stays in demo mode;
- workspace data is saved in browser localStorage;
- campaign/report behavior stays on the current Targeting Agent mock/demo flow;
- no endpoint should fail because Supabase is not configured.

When Supabase returns an error:

- registration returns the current demo workspace response with a warning;
- targeting launch/report still return the Targeting Agent response;
- the API logs a warning and does not break the user flow.

## Local Verification

With Supabase enabled:

```powershell
$env:SUPABASE_URL="https://your-project.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
$env:TARGETING_AGENT_URL="https://medcall-targeting-agent-production.up.railway.app"
pnpm --filter @workspace/negis run dev
```

Check:

- create a workspace from `/`;
- open `/dashboard`;
- open `/targeting-agent`;
- run Analyze;
- run Create campaign;
- run Get report.

Then verify rows in Supabase:

```sql
select * from workspaces order by created_at desc limit 5;
select * from targeting_campaigns order by created_at desc limit 5;
select * from targeting_reports order by created_at desc limit 5;
```

## Production Verification

After Vercel redeploy:

```bash
pnpm run typecheck
pnpm run build
pnpm run test:routes
```

Then check production:

- `/dashboard`
- `/ads`
- `/targeting-agent`
- `/api/targeting/health`
- Analyze / Launch / Report

The app should keep working even if Supabase variables are removed.
## Ads creative storage

Для `/ads-automation` примените:

```sql
-- migrations/015_ad_creative_assets.sql
```

Migration создаёт таблицу `ad_creative_assets` и публичный bucket `ad-creatives`.

Frontend upload использует `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`.
Backend metadata persistence использует `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY`.

Если bucket нельзя создать через SQL в вашем Supabase проекте, создайте его вручную:

- name: `ad-creatives`
- public: enabled
- max file size: 100 MB
- MIME: JPG, PNG, WEBP, MP4, MOV, WEBM
