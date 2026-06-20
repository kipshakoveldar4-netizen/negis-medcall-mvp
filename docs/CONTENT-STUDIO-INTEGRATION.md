# AI Content Studio Integration

Negis MedCall MVP includes an embedded module named **ИИ студия контента**. It was adapted from the local SAAF AI Content Studio project without importing the separate Next.js app.

## What It Does

The module supports the clinic content workflow:

1. idea for a short video;
2. script package;
3. voiceover text;
4. CTA, caption, hashtags;
5. Avatar prompt;
6. TapNow prompt;
7. Telegram review handoff.

The MVP stores videos in browser `localStorage` with this key:

```text
negis_content_studio_videos
```

Supabase persistence for Content Studio is intentionally left for a later step.

## Routes

Main route:

```text
/content-studio
```

Aliases:

```text
/ai-content-studio
/content
/studio
```

The module is also available from the main Negis navigation as **ИИ студия контента**.

## API Endpoints

Negis exposes these Vercel API routes:

```text
GET  /api/content-studio/videos
POST /api/content-studio/videos
POST /api/content-studio/generate-script
POST /api/content-studio/generate-avatar-prompt
POST /api/content-studio/generate-tapnow-prompt
POST /api/content-studio/send-telegram
```

Local Vite dev mode serves these endpoints through the existing dev middleware, so Vercel CLI is not required for local testing.

## Environment Variables

Optional AI generation:

```env
OPENAI_API_KEY=
```

Optional Telegram delivery:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Reserved for future production media generation:

```env
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
HEYGEN_API_KEY=
TAPNOW_API_KEY=
```

Do not expose these keys through `VITE_*` variables.

## Demo Mode

If `OPENAI_API_KEY` is missing:

- `/api/content-studio/generate-script` returns a demo script package;
- `/api/content-studio/generate-avatar-prompt` returns a demo Avatar prompt;
- `/api/content-studio/generate-tapnow-prompt` returns a demo TapNow prompt.

If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is missing:

- `/api/content-studio/send-telegram` returns success in demo mode;
- the UI shows that Telegram is not connected;
- the content package can be copied manually.

Demo mode must not break:

- `/dashboard`
- `/ads`
- `/targeting-agent`
- Vercel to Railway Targeting Agent flow
- Supabase persistence for workspace/campaign/report

## Targeting Agent Handoff

The Content Studio page has a button:

```text
Передать в ИИ таргетолог
```

For the MVP it writes generated content into:

```text
negis_targeting_prefill
```

Then it opens `/targeting-agent`. The Targeting Agent page reads this value once and pre-fills:

- `creativeText`
- `niche`
- `offer`
- `targetAudience`

## Local Check

Run Negis:

```powershell
pnpm install
pnpm --filter @workspace/negis run dev
```

Open:

```text
http://localhost:5173/content-studio
```

Check API endpoints:

```bash
curl -X POST http://localhost:5173/api/content-studio/generate-script \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Почему клиника теряет заявки\",\"niche\":\"клиника\",\"goal\":\"записи\"}"
```

Expected demo response when OpenAI is not configured:

```json
{
  "success": true,
  "mode": "demo",
  "data": {
    "hook": "У вас есть заявки, но нет стабильных продаж?"
  }
}
```

## Production Left

- Supabase persistence for Content Studio videos.
- ElevenLabs MP3 generation.
- HeyGen video generation.
- TapNow production integration.
- Telegram templates and approval statuses.
- Media asset storage.
