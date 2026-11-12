# Negis Admin Center Guide

Admin Center доступен по `/admin`.

## Разделы

- `Обзор` показывает readiness score, blockers, статусы интеграций и быстрые действия.
- `Сотрудники` создает staff-профили и временные пароли.
- `Роли и доступы` показывает права для owner, admin, receptionist, marketer, doctor и manager.
- `Клиника` хранит настройки клиники: название, город, телефоны, услуги, tone of voice и legal disclaimer.
- `Интеграции` проверяет Supabase, Telegram, AI env, Targeting Agent и Meta env.
- `Нейросети` управляет enabled/modelName для OpenAI, Anthropic, Gemini, ElevenLabs, HeyGen и TapNow.
- `Meta/Facebook Ads` хранит non-secret config для будущего ручного запуска рекламы.
- `Release checklist` фиксирует готовность к тестовому дню.
- `Диагностика` показывает server-side health без раскрытия секретов.

## Сотрудники

1. Откройте `/admin`.
2. Перейдите в `Сотрудники`.
3. Укажите имя, email, телефон, роль и временный пароль.
4. Нажмите `Создать сотрудника`.
5. Скопируйте временный пароль сразу после создания.

## Доступы

Роли управляются через `artifacts/negis/src/lib/permissions.ts`.
В UI секреты и API keys не вводятся. Все ключи добавляются только в Vercel Environment Variables.

## Storage

- Staff: `/api/crm/staff`, fallback `negis_demo_staff`.
- Clinic settings: `/api/crm/admin-settings`, fallback `negis_clinic_settings`.
- Release checklist: `/api/crm/release-checks`, fallback `negis_release_checks`.

## Meta Live Launch Controls

`/admin -> Meta/Facebook Ads` now controls real Meta launch safety.

- `Заполнить из env` fills only non-secret IDs.
- `Разрешить live launch` enables ACTIVE campaigns for owner/admin/manager.
- If the toggle is off, `/ads-automation` creates only `PAUSED` campaigns.
- The toggle is saved to `/api/crm/admin-settings` with key `meta_live_launch_enabled`.
- Demo fallback key: `negis_meta_live_launch_enabled`.
- Launch audit is stored in `meta_campaign_launches` and `meta_launch_audit_logs` when Supabase is configured.
## Admin setup for Ads Automation

Для production-запуска `/ads-automation` проверьте:

- Meta env: `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_PAGE_ID`, `META_BUSINESS_ID`.
- Supabase env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Frontend Supabase Storage env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- Migration `migrations/015_ad_creative_assets.sql` применена.
- Bucket `ad-creatives` существует и допускает JPG/PNG/WEBP/MP4/MOV/WEBM.
- В Admin Center включайте live launch только после теста `Создать в Meta выключенным`.

Secrets Meta/OpenAI не отображаются на frontend. Frontend получает только безопасный summary.
