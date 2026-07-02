# Meta Live Ads Launch

## Ads Automation wizard update

`/ads-automation` is now a Russian employee wizard. The user uploads a photo/video, fills only the key brief fields, lets AI prepare the ad package, runs a safety check, reads the final report, then confirms the Meta launch.

Video creatives require a public Supabase Storage URL and a Meta `video_id` before real launch. If Meta video upload fails, Negis returns a clear error and does not create an incomplete campaign.

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
- `META_ASTANA_CITY_KEY` optional legacy override for Astana. New city targeting does not require one env per city: the backend uses a Kazakhstan city resolver with a static map, in-memory cache, then Meta Targeting Search.

The API may return non-secret IDs for UI previews, but returns only booleans for token and secret presence.

## Naming, Geo, Placements

Every Meta launch gets one Kazakhstan timestamp in `YYYY-MM-DD_HH-mm` format. The same timestamp is used for campaign, ad set, creative, and ad names so repeated PAUSED tests are easy to identify in Ads Manager.

For the MVP, ad set targeting is forced server-side:

- geo: requested Kazakhstan city with 15 km radius when the resolver has a Meta city `key`;
- static map currently includes Astana / Nur-Sultan (`1301648`);
- aliases are normalized for Astana, Almaty, Shymkent, Karaganda, Aktobe, Atyrau, Aktau, Pavlodar, Kostanay, Taraz, Oral/Uralsk, Oskemen/Ust-Kamenogorsk, and Kyzylorda;
- Targeting Search fallback calls `/search?type=adgeolocation&location_types=["city"]&q=<city>&country_code=KZ`;
- successful Targeting Search city keys are cached in memory for the current server runtime;
- fallback: Kazakhstan only, with an explicit warning if the city key is unavailable;
- placements: Instagram only via `publisher_platforms: ["instagram"]`;
- Instagram positions: stream, story, explore, reels.

WhatsApp can still be the destination link, but WhatsApp is not used as a placement.

Admin utility:

- open `/admin -> Meta/Facebook Ads`;
- use `Проверить Meta city key`;
- the UI calls `/api/crm/meta-city-key?city=Алматы`;
- the response shows only non-secret fields: `key`, `name`, `country_code`, `source`, `geoMode`, and warning/fallback status.

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
- Meta API error: open `/admin -> Meta/Facebook Ads`, run `Проверить Meta`, then verify token permissions and ad account access.
