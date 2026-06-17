# MedCall Targeting Agent Integration

This document describes how Negis connects to the external MedCall Targeting Agent microservice.

## What It Is

MedCall Targeting Agent is a separate HTTP service for the marketing MVP:

- creative analysis;
- pending campaign draft creation;
- campaign demo reports.

Negis does not copy the Targeting Agent service code. Negis calls it through backend API proxy routes.

## Services

Targeting Agent local URL:

```bash
http://localhost:3001
```

Negis local URL depends on the dev server. For Vercel dev it is commonly:

```bash
http://localhost:3000
```

## Environment

Add these variables to the Negis project:

```env
TARGETING_AGENT_URL=http://localhost:3001
TARGETING_AGENT_API_KEY=
```

`TARGETING_AGENT_API_KEY` is optional in local demo mode. If it is set, Negis sends it to the Targeting Agent as:

```http
x-api-key: TARGETING_AGENT_API_KEY
```

Do not expose this key in frontend code.

## Windows Local Setup

Negis uses pnpm workspaces. The root `preinstall` script is intentionally cross-platform and runs through Node.js, not Unix `sh`.

Recommended Windows setup:

```powershell
corepack enable
corepack prepare pnpm@10.33.2 --activate
pnpm install
```

If your shell cannot create Corepack shims globally, run pnpm through Corepack:

```powershell
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm run build
```

The root scripts call `scripts/run-pnpm.cjs`, so nested workspace commands reuse the same package manager that started the script. This avoids `pnpm is not recognized` errors in Windows shells that have Corepack but no global pnpm executable.

`pnpm run build` mirrors the production Vercel target: it typechecks the workspace and builds `@workspace/negis`. Use `pnpm run build:all` only when you intentionally need every workspace package build script.

For local development, `@workspace/negis` has a dev-only Vite middleware for `/api/targeting/*`. That means Windows local mode can test the Targeting Agent proxy without running Vercel CLI.

Run both services in separate terminals:

```powershell
# Terminal 1: MedCall Targeting Agent
cd path-to-targeting-agent
npm run dev
```

```powershell
# Terminal 2: Negis
cd path-to-negis
$env:TARGETING_AGENT_URL="http://localhost:3001"
$env:PORT="3000"
pnpm install
pnpm --filter @workspace/negis run dev
```

Check:

- `http://localhost:3001/health`
- `http://localhost:3000/api/targeting/health`
- `http://localhost:3000/targeting-agent`

## New Negis API Endpoints

Negis exposes these backend proxy endpoints:

- `GET /api/targeting/health`
- `POST /api/targeting/analyze`
- `POST /api/targeting/launch`
- `GET /api/targeting/reports/:campaignId`

These routes proxy to:

- `GET TARGETING_AGENT_URL/health`
- `POST TARGETING_AGENT_URL/analyze`
- `POST TARGETING_AGENT_URL/launch`
- `GET TARGETING_AGENT_URL/reports/:campaignId`

If the external service is unavailable, Negis returns:

```json
{
  "success": false,
  "error": "Targeting Agent unavailable",
  "details": []
}
```

## Validation

`POST /api/targeting/analyze` requires:

- `clinicName`
- `niche`
- `city`
- `offer`
- `creativeText`

`POST /api/targeting/launch` requires:

- `clinicName`
- `campaignName`
- `city`
- `budget`
- `objective`

Validation errors use:

```json
{
  "success": false,
  "error": "Validation error",
  "details": ["creativeText is required"]
}
```

## Curl Examples

Health:

```bash
curl http://localhost:3000/api/targeting/health
```

Analyze:

```bash
curl -X POST http://localhost:3000/api/targeting/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "clinicName": "Concept Clinic",
    "niche": "cosmetology",
    "city": "Astana",
    "offer": "Free consultation and diagnostics",
    "creativeText": "Free cosmetology consultation in Astana. Book your appointment on WhatsApp today.",
    "targetAudience": "Women 25-45"
  }'
```

Launch:

```bash
curl -X POST http://localhost:3000/api/targeting/launch \
  -H "Content-Type: application/json" \
  -d '{
    "clinicName": "Concept Clinic",
    "campaignName": "Astana Cosmetology Free Consultation",
    "city": "Astana",
    "budget": 300,
    "objective": "leads",
    "offer": "Free consultation and diagnostics"
  }'
```

Report:

```bash
curl http://localhost:3000/api/targeting/reports/YOUR_CAMPAIGN_ID
```

## Frontend

The MVP UI page is:

```text
/targeting-agent
```

It calls the Negis proxy routes only. It does not call the Targeting Agent directly and does not expose server-side keys.

## Smoke Test

Run the external Targeting Agent first:

```bash
cd path-to-targeting-agent
npm run dev
```

Run Negis:

```bash
pnpm install
pnpm --filter @workspace/negis run dev
```

In Vite dev mode, the local middleware serves `/api/targeting/health`, `/api/targeting/analyze`, `/api/targeting/launch`, and `/api/targeting/reports/:campaignId` through the same Vercel handlers used in production.

If your Negis API proxy is served on a different port, set:

```bash
set NEGIS_TARGETING_PROXY_URL=http://localhost:3000
```

Then run:

```bash
pnpm run test:targeting
```

The script checks:

- Targeting Agent health through Negis backend;
- analyze proxy;
- launch proxy;
- reports proxy.

## Production Next Steps

- Deploy Targeting Agent to Railway, Render, or another backend host.
- Replace `TARGETING_AGENT_URL` with the production service URL.
- Set a strong `TARGETING_AGENT_API_KEY` in both services.
- Add real Anthropic and Supabase keys to the Targeting Agent service.
- Add Meta Marketing API later; it is intentionally not connected in this MVP.
- Add real ad metrics ingestion and a full production dashboard.
