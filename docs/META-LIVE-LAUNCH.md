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

The API may return non-secret IDs for UI previews, but returns only booleans for token and secret presence.

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
