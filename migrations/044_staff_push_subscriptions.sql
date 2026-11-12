-- NEGIS Migration 044 — устройство сотрудника, на которое приходит уведомление.
--
-- Владелец салона выбрал канал: «через пуш». Речь о сотрудниках, не о клиентах:
-- мастер работает в приложении каждый день и ставит его на телефон за минуту, а
-- клиент салона приложение не поставит — ему уведомление придётся слать иначе, и
-- этот разговор отложен.
--
-- Почему таблица, а не колонка у staff_users. У человека телефон и планшет на
-- ресепшн, а у одного устройства — своя пара ключей шифрования. Одна колонка
-- заставила бы выбирать, на какое из устройств доставлять.
--
-- Почему ключ (workspace_id, endpoint). endpoint выдаёт push-сервис браузера, и
-- он уникален по построению — это и есть удостоверение устройства. Клиника в
-- ключе первой, потому что вся авторизация здесь построена на сужении по
-- арендатору: глобально уникальный индекс стал бы единственным местом схемы, где
-- запись одной клиники молча меняет строку другой.
--
-- Почему в ключе нет staff_user_id. Планшет на ресепшн переходит из рук в руки.
-- При повторной подписке строка обязана ПЕРЕЕХАТЬ к новому сотруднику, а не
-- удвоиться — иначе прежний владелец устройства продолжит получать чужие
-- уведомления о чужих клиентах. «У сотрудника несколько устройств» этот ключ не
-- ограничивает: это просто несколько строк с одним staff_user_id.
--
-- Почему on delete cascade у staff_user_id — не так, как в 043. Там set null,
-- потому что запись обязана пережить увольнение автора. Здесь строка ЕСТЬ
-- устройство человека: без человека она никого не адресует, а живая строка после
-- увольнения — открытый канал в клинику. Увольнение = отзыв устройств.
--
-- Почему нет delete. Отписка — метка времени revoked_at, как 041 выбрала метку
-- вместо флага: видно, что устройство было и когда отключено.

begin;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  staff_user_id uuid not null references public.staff_users(id) on delete cascade,
  endpoint text not null,
  -- Ключи устройства (base64url). Без них сообщение не зашифровать, а
  -- незашифрованный web push браузер не примет вовсе.
  p256dh text not null,
  auth text not null,
  -- «Android · Chrome» — чтобы человек узнал СВОЁ устройство в списке и отключил
  -- нужное. Сырой User-Agent сюда не пишется: это лишний отпечаток.
  device_label text,
  -- Единственный честный признак «уведомления доходят». Разрешение в браузере
  -- можно отозвать в настройках телефона, и приложение об этом не узнает.
  last_success_at timestamptz,
  revoked_at timestamptz,
  gone_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_endpoint_https check (endpoint like 'https://%'),
  constraint push_subscriptions_endpoint_length check (char_length(endpoint) between 20 and 1024)
);

create unique index if not exists push_subscriptions_device_idx
  on public.push_subscriptions(workspace_id, endpoint);

-- Запрос рассылки: «живые устройства этого сотрудника». Частичный — мёртвые и
-- отключённые строки в него не входят и места не занимают.
create index if not exists push_subscriptions_live_idx
  on public.push_subscriptions(workspace_id, staff_user_id)
  where gone_at is null and revoked_at is null;

alter table public.push_subscriptions enable row level security;

-- Правило 22b: новая таблица получает явный грант service_role, иначе PostgREST
-- ответит «permission denied» уже после того, как код уедет в продакшен.
revoke all on table public.push_subscriptions from anon, authenticated;
grant select, insert, update on table public.push_subscriptions to service_role;

commit;

notify pgrst, 'reload schema';
