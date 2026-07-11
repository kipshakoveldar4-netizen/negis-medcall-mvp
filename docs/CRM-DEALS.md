# CRM Deals (Продажи)

CRM9 добавляет фундамент продаж клиники: таблицу `deals` и generic CRM API
resource `deals`. UI-термин — **«Продажи»**; таблица называется `deals`, потому
что хранит весь жизненный цикл сделки (ожидает оплаты → оплачена / отменена /
возврат), а не только завершённые продажи. Это позволяет честно считать
конверсию заявка → продажа.

## Migration

`migrations/020_crm_deals_foundation.sql` — применять после migration 019.
Создаёт только новую таблицу `public.deals` с workspace-scoped индексами.
Backfill не нужен: legacy-данных о продажах пациентов в проекте нет.
Существующие leads/clients/appointments не изменяются. RLS не меняется.

## Связи (все nullable, on delete set null)

- `workspace_id` → `workspaces` (обязателен, cascade) — tenant isolation;
- `client_id` → `clients` — кто оплатил;
- `lead_id` → `leads` — конверсия заявка → продажа;
- `appointment_id` → `appointments` — запись → продажа;
- `meta_campaign_launch_id` → `meta_campaign_launches` — прямая атрибуция
  рекламы (snapshot копируется из заявки при создании, редактируется);
- `responsible_user_id` → `staff_users` — кто закрыл продажу.

## Статусы

| Ключ | UI label | Смысл |
| --- | --- | --- |
| `pending` (default) | Ожидает оплаты | создана, оплата не получена |
| `paid` | Оплачена | **единственный статус, который считается выручкой**; ставит `paid_at` |
| `cancelled` | Отменена | не состоялась; ставит `closed_at` |
| `refunded` | Возврат | была оплачена, деньги возвращены — исключается из выручки |

Правила таймстампов (просто и предсказуемо):

- статус `paid` без явного `paidAt` → `paid_at = now()`;
- любой терминальный статус (`paid`/`cancelled`/`refunded`) без явного
  `closedAt` → `closed_at = now()`;
- явные значения `paidAt`/`closedAt` всегда имеют приоритет;
- возврат в `pending` не стирает исторические `paid_at`/`closed_at`
  автоматически (очистка — только явным значением).

## Деньги

`amount_minor` — **bigint в минорных единицах KZT (тиын)**, по аналогии с
`budget_daily_minor`/`budget_total_minor`. Никаких float. `currency` по
умолчанию `KZT`. Отрицательные суммы запрещены (`check amount_minor >= 0`).

**Выручка считается только по оплаченным сделкам:**
`sum(amount_minor) where status = 'paid'`, период — по `paid_at`.

## API

Существующий catch-all `api/crm/[...path].ts`, generic CRM resource:

- `GET /api/crm/deals?workspaceId=…`
- `POST /api/crm/deals` — `title` обязателен; `amountMinor >= 0`; `status`
  из whitelist; `currency` по умолчанию KZT;
- `PATCH /api/crm/deals` (`id` + `updates`) — по общему generic-паттерну.

Принимаются camelCase и snake_case поля (`amountMinor`/`amount_minor`,
`clientId`/`client_id` и т.д.). Demo-режим (не-UUID workspace) отвечает
`mode:"demo"` без записи в базу — как и все CRM-ресурсы.

## Workspace isolation и валидация ссылок

Все ссылочные поля (`clientId`, `leadId`, `appointmentId`,
`metaCampaignLaunchId`, `responsibleUserId`) проверяются через тот же
`readWorkspaceReference`-паттерн, что и в CRM6: перед записью сервер
убеждается, что объект принадлежит тому же `workspace_id`, что и сделка.
Ссылка на объект другой клиники или мусорный id возвращают безопасную
validation error — сырые SQL-ошибки наружу не выходят. Пустое значение
отвязывает ссылку (`null`).

## Future scope (намеренно НЕ реализовано)

- счета (invoices), чеки, налоги, скидки, позиции;
- платёжные интеграции (Kaspi, Stripe и т.д.);
- CPL / ROI / ROMI и эффективность кампаний — до появления данных о расходах;
- revenue by campaign в UI (появится после /sales UI);
- мультивалютная конвертация; автоматические возвратные денежные потоки
  (refund — только статус).

CRM9a+b — только база и API. `/sales` UI и реальная «Выручка сегодня» в
AI Control Center подключаются следующими этапами (CRM9c/9d).
