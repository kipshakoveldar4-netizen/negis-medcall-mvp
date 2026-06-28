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
