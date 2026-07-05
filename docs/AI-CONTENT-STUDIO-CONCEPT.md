# AI Content Studio — Concept

Status: concept (Phase 0). This document defines the product direction; full generation is not implemented yet.

## Product vision

Negis is a CRM/AI platform for clinics. AI Content Studio is the single place where a clinic creates
advertising and social content — ideas, photo/video creatives, Reels/TikTok/Stories concepts, scripts,
captions, Meta ad text, visual/video prompts, and WhatsApp CTAs — and sends it onward without leaving Negis.

The product flow:

```
AI Content Studio → Ads Automation (/ads-automation) → WhatsApp/CRM leads → chatbot / AI phone follow-up
```

The former standalone "AI Target" (ИИ таргетолог) module is retired: its useful functionality
(creative analysis, audience/budget suggestions, campaign draft) lives inside Ads Automation as
«ИИ заполнит» and campaign suggestions. `/targeting-agent` now redirects to `/ads-automation`.

## User roles

- **Clinic owner** — sets services/offers, approves content and spending, watches results.
- **Clinic admin** — prepares content packages from clinic materials, runs safe PAUSED launches.
- **Marketer** — iterates on ideas/scripts/creatives, reuses templates, manages the social calendar.

All three work in the same studio; role permissions reuse the existing `ads` permission.

## End-to-end flow

1. **Studio**: user creates a content package (from an idea, from uploaded media, or from a template).
2. **Ads Automation**: the package prefills `/ads-automation`; «ИИ заполнит» completes the Meta structure;
   the campaign launches PAUSED with the existing safety/compliance gates.
3. **WhatsApp/CRM**: leads arrive to the WhatsApp destination and CRM lead modules.
4. **Chatbot / AI phone (later)**: follow-up scripts generated in the studio drive the chatbot and AI-phone
   conversations for booking and reactivation.

Content is equally usable outside ads: copy/download for organic Instagram/TikTok/Reels posts.

## Content package structure

A generated package (one row per package) contains:

```
{
  id, workspaceId, createdBy, createdAt,
  source: "idea" | "uploaded_media" | "template",
  brief: { service, offer, city, audience, restrictions },
  media: { assetId?, publicUrl?, thumbnailUrl?, type: "photo" | "video" | null },
  outputs: {
    reelsScript, storiesScript,
    photoPrompt, videoPrompt,
    caption, metaAdText: { primaryText, headline, description, cta },
    whatsappCta,
    followUpScript?        // Phase 4
  },
  compliance: { status: "safe" | "needs_review" | "blocked", issues: [] },
  handoff: { adsAutomation?: launchId, social?: exportedAt }
}
```

## Generation modes

1. **From idea** — user enters service/offer/city/audience; AI generates the full package.
2. **From uploaded media** — user uploads a clinic photo/video (existing `ad-creatives` upload flow);
   AI packages it: caption, ad text, script around the material, CTA.
3. **From template** — curated clinic templates (акция, знакомство с врачом, до/после-safe формат,
   отзыв, услуга месяца) prefilled and adapted by AI.

## Output types

- Reels/TikTok script (hook, scenes, voiceover, CTA)
- Stories script (3–5 frames)
- Photo creative prompt (for image generation/photographer brief)
- Video creative prompt (for avatar/video generation, e.g. HeyGen/TapNow)
- Caption (organic post text with hashtags)
- Meta ad text (primaryText, headline, description, CTA — matches Ads Automation fields)
- WhatsApp CTA (first message + quick replies)
- Chatbot / AI phone follow-up script — **later (Phase 4)**

## Compliance rules (always on, reuses `lib/meta/compliance.ts` direction)

- No guaranteed results («гарантия результата», «100% результат» are blocked).
- No diagnosis by appearance and no personal-attribute targeting wording.
- No unrealistic before/after claims.
- Safe medical/cosmetology wording only; блокирующие статусы обязательны до передачи в рекламу.
- Every package passes the compliance check before handoff to Ads Automation (same statuses:
  safe / needs_review / blocked).

## Current state (Phase 0 baseline)

- `/content-studio` exists: idea form (localStorage), demo/OpenAI script generation, avatar prompt,
  TapNow prompt, Telegram review handoff (`api/content-studio/[...path].ts`: `videos`,
  `generate-script`, `generate-avatar-prompt`, `generate-tapnow-prompt`, `send-telegram`).
- Content rows persist via the `content-videos` CRM resource (`content_videos`, migration 010).
- AI providers: `OPENAI_API_KEY` (text), `ELEVENLABS_*` (voice), `HEYGEN_API_KEY` (avatar video),
  `TAPNOW_API_KEY` (video), `TELEGRAM_*` (review) — demo fallbacks when unset (`docs/AI-PROVIDERS.md`).
- «Создать рекламу из этого контента» writes `negis_ads_automation_prefill` to localStorage,
  **but Ads Automation does not read this key yet** — its working prefill paths are
  «Повторить запуск с этими параметрами» (history) and the persisted brief
  (`negis_ads_automation_brief`). Wiring the prefill read is the first Phase 1 task.
- Ads Automation already covers: «ИИ заполнит» (`/api/crm/ads-ai-fill`), compliance gate, photo/video
  PAUSED launch, auto thumbnail, history. Large-video optimization pipeline exists (worker on Railway)
  but final large-file testing is blocked by the Supabase Free global upload limit — paused for now.

## Implementation phases

- **Phase 1 — text/script/prompt generation.** Full package generation from idea/media/template;
  Ads Automation reads `negis_ads_automation_prefill`; compliance on every package; copy/download for social.
- **Phase 2 — photo creative builder.** Branded photo creatives from uploaded media + prompts
  (templates, overlays, safe wording), saved to `ad-creatives`.
- **Phase 3 — video creative generation/rendering.** Avatar/TapNow/render pipeline producing ad-ready MP4
  (reuses the video worker/optimization pipeline), thumbnails included.
- **Phase 4 — WhatsApp/chatbot/AI phone follow-up scripts.** Follow-up flows generated per package;
  handoff to the chatbot and AI phone modules.
- **Phase 5 — deeper Ads Automation + reports integration.** Package → launch → results loop:
  per-package performance, suggestions to regenerate/iterate, budget guidance.

## Non-goals right now

- No new generation backends in Phase 0 (this document + navigation cleanup only).
- No changes to Meta payload logic, ACTIVE gating, or the small-video/photo launch flow.
- Large-video optimization stays paused until the Supabase upload limit is resolved.
