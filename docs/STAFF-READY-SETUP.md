# Negis MedCall CRM: staff-ready setup

Этот слой переводит MVP из чистого demo режима в внутренний режим для сотрудников клиники. Demo flow не удалён: если Supabase env недоступны или workspace остаётся `demo-workspace`, интерфейс продолжает работать через localStorage.

## Что добавлено

Migration: `migrations/010_staff_ready_crm.sql`.

Staff auth foundation: `migrations/011_staff_auth_foundation.sql`.

Таблицы:

- `staff_users` — сотрудники, роли и статусы.
- `clients` — база клиентов.
- `leads` — входящие лиды и источник заявки.
- `appointments` — записи и статусы визитов.
- `calls` — журнал звонков.
- `tasks` — операционные задачи.
- `chat_messages` — внутренние сообщения.
- `content_videos` — идеи и пакеты Content Studio.
- `audit_logs` — база для будущего журнала действий.

`011_staff_auth_foundation.sql` расширяет `staff_users` полями:

- `auth_user_id`
- `temporary_password_set`
- `invited_at`
- `last_login_at`
- `password_reset_required`

Пароль сотрудника в `staff_users` не сохраняется. В базе остаются только флаги и связь с Supabase Auth user.

В migration также добавлены индексы по `workspace_id`, `status` и `created_at` для основных таблиц.

## Как применить migration

1. Откройте Supabase project.
2. Перейдите в SQL Editor.
3. Скопируйте содержимое `migrations/010_staff_ready_crm.sql`.
4. Выполните SQL после уже применённой `009_medcall_mvp_persistence.sql`.
5. Затем выполните `migrations/011_staff_auth_foundation.sql`.
6. Проверьте, что таблицы появились в Table Editor, а в `staff_users` появились новые auth-поля.

На этом этапе RLS намеренно не включён жёстко, потому что Vercel API использует `SUPABASE_SERVICE_ROLE_KEY`. Перед полноценным multi-tenant production нужно включить RLS и tenant-scoped policies.

## Env переменные

Для Vercel API:

```text
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
TARGETING_AGENT_URL=...
OPENAI_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Для frontend-индикации Supabase в админке можно оставить:

```text
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Для входа сотрудников через `/login` нужны frontend env:

```text
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Если frontend env не настроены, `/login` работает в demo fallback и не ломает CRM.

Service role key нельзя добавлять в frontend env и нельзя показывать сотрудникам.

## CRM API endpoints

Все endpoints возвращают JSON. Если Supabase недоступен, API возвращает `mode: "demo"`, а frontend сохраняет данные локально.

- `GET /api/crm/clients`
- `POST /api/crm/clients`
- `GET /api/crm/leads`
- `POST /api/crm/leads`
- `PATCH /api/crm/leads`
- `GET /api/crm/appointments`
- `POST /api/crm/appointments`
- `PATCH /api/crm/appointments`
- `GET /api/crm/calls`
- `POST /api/crm/calls`
- `GET /api/crm/tasks`
- `POST /api/crm/tasks`
- `PATCH /api/crm/tasks`
- `GET /api/crm/chat`
- `POST /api/crm/chat`
- `GET /api/crm/staff`
- `POST /api/crm/staff`
- `PATCH /api/crm/staff`
- `GET /api/crm/content-videos`
- `POST /api/crm/content-videos`
- `PATCH /api/crm/content-videos`

`workspaceId` передаётся через query или body. Для реальной Supabase persistence нужен UUID workspace из таблицы `workspaces`.

## Роли

Роли описаны в `artifacts/negis/src/lib/permissions.ts`:

- `owner`
- `admin`
- `receptionist`
- `marketer`
- `doctor`
- `manager`

Ключевые права:

- клиенты: `view_clients`, `manage_clients`
- записи: `view_appointments`, `manage_appointments`
- лиды: `view_leads`, `manage_leads`
- звонки: `view_calls`, `manage_calls`
- задачи: `view_tasks`, `manage_tasks`
- чат: `view_chat`, `send_chat`
- маркетинг и AI: `view_marketing`, `manage_marketing`, `view_ai_content`, `manage_ai_content`, `view_targeting`, `manage_targeting`
- отчёты и админка: `view_reports`, `view_admin`, `manage_staff`, `manage_integrations`

## Как добавить сотрудника

1. Откройте `/admin`.
2. В блоке “Сотрудники” заполните имя, email, телефон, роль, статус и временный пароль.
3. Можно нажать кнопку генерации пароля рядом с полем временного пароля.
4. Нажмите “Добавить сотрудника”.
5. Если Supabase подключён и workspaceId является UUID, API попробует создать Supabase Auth user через service role admin API.
6. Затем профиль сохраняется в `staff_users` с `auth_user_id`, `temporary_password_set`, `invited_at` и `password_reset_required`.
7. Если Supabase Auth user не создался, UI не ломается: профиль сотрудника сохраняется, а админ видит warning.
8. Если Supabase недоступен, запись останется в localStorage на этом устройстве.

После создания админ видит карточку “Сотрудник создан”:

- Email
- Роль
- Временный пароль
- Ссылку `/login`
- Кнопку Copy credentials

Скопируйте пароль сразу. После закрытия карточки пароль повторно не показывается.

## Как сотруднику войти

1. Откройте `/login`.
2. Введите email и временный пароль, выданный администратором.
3. Если Supabase frontend env настроены, вход идет через Supabase Auth.
4. После входа CRM ищет профиль сотрудника через `/api/crm/staff?email=...`.
5. Если профиль найден, сохраняются `negis_staff_session` и `negis_staff_user`, затем открывается `/dashboard`.
6. Logout очищает `negis_staff_session`, `negis_staff_user`, demo session и делает Supabase signOut.

Invite email пока не отправляется. Это следующий слой.

## Какие страницы используют API-first

- `/clients`
- `/leads`
- `/appointments`
- `/calls`
- `/tasks`
- `/chat`
- `/admin`
- `/content-studio`

Страницы сначала пробуют `/api/crm/*`; при demo/error продолжают работать через localStorage seed.

## Что пока demo/fallback

- Полноценный Supabase Auth invite email ещё не включён.
- Сотруднику пароль выдает администратор вручную через карточку после создания.
- RLS policies ещё нужно включить перед multi-tenant production.
- Некоторые CRM-метрики остаются demo-агрегациями.
- Calls пока журналируются как CRM данные, без реальной телефонии.

## Checklist перед передачей сотрудникам

- Применить `010_staff_ready_crm.sql` в Supabase.
- Проверить Vercel env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Создать workspace через onboarding и убедиться, что workspaceId UUID.
- Открыть `/admin` и добавить сотрудников.
- Проверить `/clients`, `/leads`, `/appointments`, `/tasks`, `/chat`.
- Проверить `/content-studio` и Telegram handoff.
- Проверить `/targeting-agent` и report flow.
- Провести инструктаж: что сохраняется в Supabase, а что ещё работает как demo/fallback.
- Перед внешним production включить RLS и полноценный auth.
