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
- `META_ASTANA_CITY_KEY` optional city geo key for Astana. If it is empty, Negis tries Meta Targeting Search with the server token.

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

`/ads-automation` creates PAUSED launches with unique timestamped names, Astana city targeting when a valid city key is available, and Instagram-only placements. Existing disabled test campaigns are not deleted automatically; remove old duplicates manually in Ads Manager if needed.
