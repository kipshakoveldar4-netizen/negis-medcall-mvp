# Meta/Facebook Ads Setup

Negis MVP не запускает рекламу автоматически. Раздел `/admin -> Meta/Facebook Ads` готовит foundation: IDs, permissions checklist и draft status.

## Required env

Добавьте в Vercel Environment Variables:

- `META_APP_ID`
- `META_APP_SECRET`
- `META_ACCESS_TOKEN`
- `META_AD_ACCOUNT_ID`
- `META_PAGE_ID`
- `META_INSTAGRAM_ACTOR_ID`
- `META_VIDEO_LAUNCH_ENABLED=false` for MVP. Video upload/storage and dry-run stay available; real video launch should remain disabled until the Meta `video_id` flow is finished.
- `META_ASTANA_CITY_KEY` optional legacy override for Astana. Do not create one env per city. Negis resolves Kazakhstan cities through a static map, in-memory cache, and Meta Targeting Search.

Не вводите access token во frontend. Token должен жить только в Vercel env.

## Admin fields

В `/admin -> Meta/Facebook Ads` заполните:

- Meta Business ID
- Ad Account ID
- Page ID
- Instagram Actor ID
- Account name
- Currency
- Timezone

## Permissions checklist

Перед реальным запуском проверьте:

- Meta Business app created
- Marketing API access enabled
- `ads_read` available
- `ads_management` available
- Ad account connected
- Facebook Page connected
- Instagram account connected
- Manual approval enabled

## Verification

1. Откройте `/admin`.
2. Перейдите в `Meta/Facebook Ads`.
3. Нажмите `Проверить настройки`.
4. Убедитесь, что Meta env status не `not_configured`.
5. Нажмите `Подготовить тестовый draft`.

Реальный Meta Marketing API launch остается следующим этапом.

## Live Launch MVP

Negis now includes `/ads-automation` for server-side Meta Marketing API launch.

- Default mode creates campaigns as `PAUSED`.
- `ACTIVE` launch requires `/admin -> Meta/Facebook Ads -> Разрешить live launch`.
- `META_ACCESS_TOKEN` and `META_APP_SECRET` stay server-side only.
- Smoke tests use `dryRun: true` and do not create real ads.

Detailed guide: `docs/META-LIVE-LAUNCH.md`.

## MVP targeting behavior

`/ads-automation` creates PAUSED launches with unique timestamped names, controlled Kazakhstan city targeting, and Instagram-only placements. The employee selects a city from the built-in Kazakhstan list; free-text city entry is disabled for Meta launch. Existing disabled test campaigns are not deleted automatically; remove old duplicates manually in Ads Manager if needed.

City targeting uses:

- static map first: `astana -> 1301648`, `aktobe -> 1289458`;
- legacy env override: `META_ASTANA_CITY_KEY`;
- in-memory cache for keys found by API;
- Meta Targeting Search fallback: `/search?type=adgeolocation&location_types=["city"]&q=<canonical city>&country_code=KZ`;
- exact selected-city matching: the first comma-separated city name in a Meta result must match the selected city aliases;
- city key payload uses `geo_locations.cities: [{ key }]` without `radius` or `distance_unit`;
- dry-run country fallback: `countries: ["KZ"]` with a warning when no city key is found;
- real launch block: if the selected city has no Meta city key, `/api/crm/meta-launch` returns a validation error before any Meta API call.
- If radius targeting is needed later, implement `custom_locations` with latitude/longitude instead of adding radius to `geo_locations.cities`.

Supported aliases include Astana / Nur-Sultan, Almaty, Shymkent, Karaganda, Aktobe, Atyrau, Aktau, Pavlodar, Kostanay, Taraz, Oral / Uralsk, Oskemen / Ust-Kamenogorsk, and Kyzylorda.

In `/admin -> Meta/Facebook Ads`, use `Проверить Meta city key` to test a city before launch. The diagnostic response includes `selected`, `candidates`, and `rejectedCandidates`, so nearby false matches like `Temir, Aqtöbe, Kazakhstan` are visible and not used for `Актобе`.
