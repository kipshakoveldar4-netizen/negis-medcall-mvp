# Ads Automation — Working Release Checklist

Current working release of `/ads-automation` (Meta Marketing API, server-side).

Confirmed working:

- Photo `PAUSED` launch.
- Video MP4/MOV `PAUSED` launch (`META_VIDEO_LAUNCH_ENABLED=true`).
- Automatic video thumbnail (`video_data.image_url`) — no manual cover upload.
- Meta `video_id` flow with processing polling and reuse.
- City select (controlled Kazakhstan list).
- Instagram-only placements.
- WhatsApp destination link.
- `ACTIVE` launch remains gated (Admin Center + owner/admin + `ЗАПУСТИТЬ`).

## Release verification checklist

Run through this list after each deploy that touches the ads flow:

1. **Upload photo** — open `/ads-automation`, upload a JPG/PNG; the card shows «Фото загружено» and «Публичная ссылка получена».
2. **Launch photo paused** — fill the brief, run «ИИ заполнить рекламу», pass the safety check, confirm checkboxes, press «Создать в Meta выключенным»; the result block is green with real (non-`dryrun_`) Meta IDs and status PAUSED.
3. **Upload video** — upload an MP4 (or MOV); the card shows «Видео загружено» and the public link.
4. **Auto thumbnail** — the card shows «Обложка видео создана автоматически» with a preview image; «Создать обложку заново» regenerates it. Without a thumbnail a real video launch is blocked with a controlled message.
5. **Launch video paused** — press «Создать в Meta выключенным»; Negis uploads the video, receives `video_id`, waits for processing (yellow «Видео обрабатывается» state is normal — retry in a few minutes), then creates the PAUSED campaign with the thumbnail as `video_data.image_url`.
6. **Verify Ads Manager** — open Ads Manager from the result block: the campaign, ad set, creative, and ad exist with the shared timestamped name, status is off/PAUSED, placements are Instagram-only, the destination link points to WhatsApp, and the video ad shows the auto-generated cover.

History check: `/ads-automation/history` shows real PAUSED launches with Meta IDs and an Ads Manager link, dry-run entries as «DRY-RUN / Проверка» («Meta API не вызывался»), and pending videos as «Видео обрабатывается» with «Проверить готовность видео».

## Guardrails that must stay

- `ACTIVE` launch stays gated: Admin Center «Разрешить live launch» + owner/admin role + typed `ЗАПУСТИТЬ`.
- No secrets in the frontend: `META_ACCESS_TOKEN` / `META_APP_SECRET` are server-side only.
- New CRM endpoints go into `api/crm/[...path].ts`, not new files under `api/`.
- Russian UI stays Russian.

Details: `docs/META-LIVE-LAUNCH.md`, `docs/META-ADS-SETUP.md`.
