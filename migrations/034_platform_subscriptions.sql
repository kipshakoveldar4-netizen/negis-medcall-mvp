-- NEGIS Migration 034 — подписка клиники на платформу становится строкой.
--
-- Панель владельца платформы должна показать подключённые клиники и выручку.
-- Сегодня взять её неоткуда: в workspaces четыре колонки (id, name, owner_email,
-- created_at) из 009, и ни тарифа, ни суммы, ни срока среди них нет. Тарифы
-- существуют только на фронтенде — planFeatures.ts перечисляет ключи basic,
-- standard, pro и раздаёт по ним возможности, но ни цены, ни валюты, ни периода
-- там нет ни одного.
--
-- Отсюда решение: сумма — колонка, а не константа. Цена подписки живёт в базе и
-- задаётся владельцем, поэтому на панели никогда не окажется числа, которого
-- никто не назначал. Выручка считается сложением этих строк, и если строк нет —
-- на панели ноль, а не правдоподобная цифра.
--
-- Суммы в тиынах, целым числом, как amount_minor у продаж: на дробных деньгах
-- этот продукт уже один раз обжигался, и повторять незачем.
--
-- Валюта по умолчанию KZT — не выбор этой миграции, а то, чем сервер уже
-- заполняет пустое поле валюты в трёх местах (lib/crm/server.ts).
--
-- Почему таблица, а не колонка в workspaces: у подписки есть история. Клиника
-- переходит с тарифа на тариф, ставит на паузу и возвращается, и выручка за
-- прошлый месяц не должна меняться от того, что сегодня выбран другой тариф.
-- Одна активная строка на клинику обеспечена частичным уникальным индексом
-- ниже, остальные остаются историей.
--
-- Маркет приложений своей таблицы не получает намеренно: integration_statuses
-- из 013 уже описывает подключение провайдера к рабочему пространству
-- (workspace_id, provider, status, masked_identifier, last_checked_at,
-- last_error, metadata) с уникальностью по паре, и маршрут integration-statuses
-- в роутере уже есть. Заводить вторую таблицу того же смысла — это заводить
-- второй источник правды о том, подключён ли Wazzup.

begin;

create table if not exists public.platform_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  plan text not null,
  status text not null default 'active',
  -- Цена в тиынах. Ноль — законное значение: клиника на бесплатном доступе
  -- существует, и это не то же самое, что цена не задана.
  price_minor bigint not null default 0,
  currency text not null default 'KZT',
  billing_period text not null default 'monthly',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_subscriptions_plan_check
    check (plan in ('basic', 'standard', 'pro')),
  constraint platform_subscriptions_status_check
    check (status in ('active', 'paused', 'cancelled')),
  constraint platform_subscriptions_period_check
    check (billing_period in ('monthly', 'yearly')),
  constraint platform_subscriptions_price_check
    check (price_minor >= 0),
  -- Закончившаяся подписка не может закончиться раньше, чем началась.
  constraint platform_subscriptions_dates_check
    check (ended_at is null or ended_at >= started_at)
);

create index if not exists platform_subscriptions_workspace_idx
  on public.platform_subscriptions(workspace_id, started_at desc);

create index if not exists platform_subscriptions_status_idx
  on public.platform_subscriptions(status, plan);

-- Одна действующая подписка на клинику. История при этом сохраняется: условие
-- частичное, и строки со статусом paused или cancelled под него не подпадают.
create unique index if not exists platform_subscriptions_one_active_idx
  on public.platform_subscriptions(workspace_id)
  where status = 'active';

alter table public.platform_subscriptions enable row level security;

revoke all on table public.platform_subscriptions from anon, authenticated;

-- DELETE в грантах нет намеренно: подписка не удаляется, она отменяется —
-- иначе выручка за прошлые месяцы исчезнет вместе со строкой.
grant select, insert, update
  on table public.platform_subscriptions
  to service_role;

commit;
