# Meta Live Ads Launch

## Current working status

Confirmed working in production (release checklist: `docs/ADS-AUTOMATION-RELEASE.md`):

- Photo `PAUSED` launch works end to end (campaign, ad set, creative, ad).
- Video MP4/MOV `PAUSED` launch works with `META_VIDEO_LAUNCH_ENABLED=true`.
- Video thumbnail is auto-generated from the video frame and used as `video_data.image_url` — the employee does not upload a cover image manually.
- Meta `video_id` flow works: upload to `/advideos`, processing polling, `video_id` reuse on repeated launches.
- City select works (controlled Kazakhstan list, no free-text input for launch).
- Placements stay Instagram-only.
- WhatsApp destination link works.
- ACTIVE launch remains gated (Admin Center switch + role + typed `ЗАПУСТИТЬ`).

## Ads Automation wizard update

`/ads-automation` is now a Russian employee wizard. The user uploads a photo/video, fills only the key brief fields, lets AI prepare the ad package, runs a safety check, reads the final report, then confirms the Meta launch.

Photo creatives can be created in Meta in `PAUSED` mode. Video creatives require `META_VIDEO_LAUNCH_ENABLED=true`; with the flag on, the Meta `video_id` flow for MP4 and MOV works, including automatic thumbnail generation.

ACTIVE launch still requires Admin Center live launch enabled and the typed confirmation `ЗАПУСТИТЬ`.

Negis MedCall MVP can create Meta/Facebook/Instagram Ads from CRM through a server-side Marketing API flow.

## What Is Created

`/ads-automation` sends a confirmed launch package to `/api/crm/meta-launch`.

The backend creates, in order:

- Campaign: `/{adAccountId}/campaigns`
- Ad Set: `/{adAccountId}/adsets`
- Ad Creative: `/{adAccountId}/adcreatives`
- Ad: `/{adAccountId}/ads`

All calls are server-side. `META_ACCESS_TOKEN` and `META_APP_SECRET` are never returned to the frontend.

For video creatives with `META_VIDEO_LAUNCH_ENABLED=true`, the backend first uploads the public Supabase video URL to `/{adAccountId}/advideos`, reads the returned `video_id`, polls `/{videoId}?fields=status` (progress, when available, comes from the nested `status.processing_progress`; requesting it as a top-level field causes Meta error #100), then creates the ad creative with `object_story_spec.video_data.video_id` and `object_story_spec.video_data.image_url` set to the auto-generated thumbnail (Meta requires image_hash or image_url in video_data — error 100 / subcode 1443226 otherwise; the video URL itself is never used as image_url). If Meta cannot fetch the public URL, Negis can try a server-to-Meta binary multipart fallback for smaller files.

## Required Env

Set these variables in Vercel:

- `META_GRAPH_VERSION` optional, default `v25.0`
- `META_APP_ID`
- `META_APP_SECRET`
- `META_ACCESS_TOKEN`
- `META_BUSINESS_ID`
- `META_AD_ACCOUNT_ID`
- `META_PAGE_ID`
- `META_INSTAGRAM_ACTOR_ID`
- `META_VIDEO_LAUNCH_ENABLED=false` by default. Set to `true` only when you want the experimental MP4/MOV `video_id` upload flow. Dry-run and Supabase storage work without enabling it.
- `META_ASTANA_CITY_KEY` optional legacy override for Astana. New city targeting does not require one env per city: the backend uses a Kazakhstan city resolver with a static map, in-memory cache, then Meta Targeting Search.

The API may return non-secret IDs for UI previews, but returns only booleans for token and secret presence.

## Naming, Geo, Placements

Every Meta launch gets one Kazakhstan timestamp in `YYYY-MM-DD_HH-mm` format. The same timestamp is used for campaign, ad set, creative, and ad names so repeated PAUSED tests are easy to identify in Ads Manager.

For the MVP, ad set targeting is forced server-side:

- geo: selected Kazakhstan city from the controlled `/ads-automation` city list, using `geo_locations.cities: [{ key }]` without `radius` or `distance_unit`;
- static map currently includes Astana / Nur-Sultan (`1301648`) and Aktobe (`1289458`);
- aliases are normalized for Astana, Almaty, Shymkent, Karaganda, Aktobe, Atyrau, Aktau, Pavlodar, Kostanay, Taraz, Oral/Uralsk, Oskemen/Ust-Kamenogorsk, and Kyzylorda;
- Targeting Search fallback calls `/search?type=adgeolocation&location_types=["city"]&q=<canonical city>&country_code=KZ`;
- Targeting Search candidates must match the selected city exactly by primary city name. Nearby region results such as `Temir, Aqtöbe, Kazakhstan` are rejected for selected `Актобе` and returned in `rejectedCandidates`;
- successful Targeting Search city keys are cached in memory for the current server runtime;
- dry-run fallback: Kazakhstan only, with an explicit warning if the city key is unavailable;
- real launch fallback: blocked before Meta API call if the selected city has no key, so an employee cannot accidentally launch on all Kazakhstan;
- future radius targeting should use `custom_locations` with latitude/longitude, not `geo_locations.cities`;
- placements: Instagram only via `publisher_platforms: ["instagram"]`;
- Instagram positions: stream, story, explore, reels.

WhatsApp can still be the destination link, but WhatsApp is not used as a placement.

Admin utility:

- open `/admin -> Meta/Facebook Ads`;
- use `Проверить Meta city key`;
- choose a city from the same controlled list used by `/ads-automation`;
- the UI calls `/api/crm/meta-city-key?city=almaty` or `/api/crm/meta-city-key?city=Алматы`;
- the response shows only non-secret fields: `selected`, `candidates`, `rejectedCandidates`, `key`, `name`, `country_code`, `source`, `geoMode`, and warning/fallback status.

## Default PAUSED Mode

The default launch mode is `PAUSED`.

Negis creates the campaign, ad set, creative, and ad in Meta, but it does not spend until an admin reviews and activates it in Ads Manager.

Use this mode for the first production release.

## ACTIVE Mode

ACTIVE launch is intentionally gated.

To enable it:

1. Open `/admin`.
2. Go to `Meta/Facebook Ads`.
3. Enable `Разрешить live launch`.
4. Save/confirm the Meta config.

In `/ads-automation`, ACTIVE additionally requires:

- owner/admin role;
- all manual approval checkboxes;
- typed confirmation: `ЗАПУСТИТЬ`;
- budget within safety limits or admin override.

## Budget Safety

Defaults:

- max daily budget: `50 USD`;
- max total budget: `300 USD`.

If the launch package exceeds these limits, an admin override is required.

## Compliance Gate

Before launch the backend runs `lib/meta/compliance.ts`.

Blocked examples include:

- direct personal-attribute questions;
- medical condition claims;
- guaranteed results;
- before/after claims;
- aggressive medical promises.

If status is `blocked`, no Meta API call is made. The API returns safer rewritten text.

Statuses:

- `safe`: launch allowed;
- `needs_review`: allowed only with manual approval;
- `blocked`: launch blocked.

## Dry Run

Smoke tests and UI checks use:

```json
{
  "dryRun": true
}
```

Dry-run returns simulated Meta IDs and does not call Meta API.

## Video Launch

Supported real video formats:

- `video/mp4` / `.mp4`
- `video/quicktime` / `.mov`

MOV is allowed, but processing can take longer. The UI shows a warning and still proceeds when the feature flag is enabled.

Flow:

1. On upload, the frontend auto-generates a thumbnail from the video (~1 second frame, canvas → JPEG), uploads it to Supabase through the signed upload flow, and stores `thumbnailUrl`, `thumbnailGeneratedAt`, `thumbnailSource: "auto_frame"`, `thumbnailMimeType` in the asset metadata. The UI shows «Обложка видео создана автоматически» with a preview and a «Создать обложку заново» button.
2. Supabase public video URL is sent server-side to `/{adAccountId}/advideos` as `file_url`.
3. Meta returns `id` / `video_id`. The `video_id` is stored immediately and reused on repeated launches — the video is not uploaded twice.
4. Negis polls `/{videoId}?fields=status` for a short window, reading progress only from the nested `status.processing_progress` if present.
5. If ready, the creative uses `object_story_spec.video_data.video_id` with the auto thumbnail as `object_story_spec.video_data.image_url`. A real launch without a thumbnail is blocked before any Meta call with a controlled message; dry-run only warns.
6. If processing is still pending, the API returns a controlled message telling the employee to retry after a few minutes; history shows the entry as «Видео обрабатывается» with a re-check action.

If the URL upload fails because Meta cannot fetch the file, Negis downloads the public video server-side and retries `/{adAccountId}/advideos` as multipart `source`. This fallback is capped for Vercel safety; large videos should be converted to smaller MP4/H.264 or moved to a background worker later.

## API Endpoints

All endpoints are served by the existing catch-all `api/crm/[...path].ts`.

- `POST /api/crm/meta-validate`
- `GET /api/crm/meta-launches`
- `POST /api/crm/meta-launches`
- `PATCH /api/crm/meta-launches`
- `POST /api/crm/meta-launch`
- `GET /api/crm/meta-status?campaignId=...`

## Persistence

Apply migration:

```text
migrations/014_meta_ad_launches.sql
```

Tables:

- `meta_campaign_launches`
- `meta_launch_audit_logs`

If Supabase is unavailable, demo/local mode still returns JSON and uses local fallback behavior.

## How To Stop A Campaign

Open Ads Manager from the result block in `/ads-automation`, find the campaign, and switch it to paused/off.

For emergency stop, use Meta Ads Manager directly.

## Troubleshooting

- `Meta env is not configured`: check Vercel env and redeploy.
- `Compliance blocked`: apply the safe rewritten text and run dry-run again.
- `Live launch is disabled`: enable `Разрешить live launch` in `/admin`.
- `activeConfirmation must be ЗАПУСТИТЬ`: enter the exact confirmation word.
- Video creative error 100 / subcode 1443226 (`specify one of image_hash or image_url in video_data`): the video has no thumbnail. Negis generates it automatically on upload; re-upload the video or press «Создать обложку заново». Videos uploaded before the auto-thumbnail release need to be re-uploaded once.
- «Не удалось автоматически создать обложку видео»: the browser could not decode a frame; try MP4/H.264 or another video file.
- Meta API error: open `/admin -> Meta/Facebook Ads`, run `Проверить Meta`, then verify token permissions and ad account access.
