# Negis MedCall CRM Release Checklist

Перед тестовым днем сотрудников откройте `/admin` и пройдите вкладку `Release checklist`.

## Critical checks

- Supabase migrations `009`, `010`, `011`, `012`, `013` применены.
- Vercel Environment Variables заполнены.
- Staff login через `/login` проверен.
- Сотрудники созданы во вкладке `Сотрудники`.
- Роли и доступы проверены во вкладке `Роли и доступы`.
- Telegram test passed через вкладку `Интеграции`.
- Targeting Agent health passed.
- Content Studio generate script passed.
- Appointments create/edit tested.
- Mobile test passed.
- Backup/export strategy ready.
- Admin owner account ready.
- Test employee day completed.

## How to verify

1. Запустите production или локальный dev.
2. Откройте `/admin`.
3. Нажмите `Проверить всё` во вкладке `Интеграции`.
4. Закройте все critical items во вкладке `Release checklist`.
5. Убедитесь, что readiness score стал 100% и blockers равны 0.

## Storage

Release checklist сохраняется в Supabase table `release_checks`.
Если Supabase недоступен, UI использует localStorage fallback `negis_release_checks`.

## Meta Live Launch Release Checks

Before real Meta launch:

- Apply `migrations/014_meta_ad_launches.sql`.
- Open `/admin -> Meta/Facebook Ads`.
- Click `Заполнить из env` and save the config.
- Keep `Разрешить live launch` off for the first production test.
- Open `/ads-automation` and run dry-run/compliance check.
- Create the first real campaign as `PAUSED`.
- Review the campaign in Ads Manager before switching it to ACTIVE.
