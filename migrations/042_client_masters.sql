-- NEGIS Migration 042 — клиент и мастера, у которых он был.
--
-- Владелец переносит салон с чужой платформы: тринадцать выгрузок, 3 846 строк,
-- 2 532 человека по номеру телефона. И главное число здесь третье: 1 139
-- клиентов встречаются в списках БОЛЬШЕ ЧЕМ ОДНОГО мастера — ходят и к
-- найл-стилисту, и к лашмейкеру.
--
-- Отсюда форма хранения. «База по мастерам» — это не разрезание клиентов на
-- двенадцать кучек: тогда один человек превратится в три карточки, его история
-- разъедется по ним, а телефон перестанет быть ключом. Клиент остаётся один, а
-- связей с мастерами у него столько, сколько есть на самом деле.
--
-- Почему связь, а не колонка «любимый мастер»: колонка хранит ОДНО значение и
-- на первом же клиенте из тех 1 139 начинает врать. Колонку пришлось бы
-- перезаписывать при каждом визите к другому мастеру, и «у кого он был» стало
-- бы «у кого он был последний раз».
--
-- source — откуда взялась связь. «Из выгрузки zapis.kz» и «сам записался в
-- нашей CRM» — разные по надёжности факты, и через год отличить их можно будет
-- только по этой колонке.

begin;

create table if not exists public.client_masters (
  id uuid primary key default gen_random_uuid(),

  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  doctor_id uuid not null references public.clinic_doctors(id) on delete cascade,

  -- Откуда связь: import — из выгрузки, appointment — из записи в этой CRM,
  -- manual — поставили руками в кабинете.
  source text not null default 'manual',

  -- Что было известно на момент переноса: сколько визитов и когда последний.
  -- Записями это не становится — их в выгрузке нет, — но помогает понять,
  -- живой это клиент или спящий.
  visits_count integer check (visits_count is null or visits_count >= 0),
  last_visit_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint client_masters_source_known
    check (source in ('import', 'appointment', 'manual'))
);

-- Одна связь на пару. Повторная заливка обязана обновлять, а не плодить.
create unique index if not exists client_masters_pair_idx
  on public.client_masters(workspace_id, client_id, doctor_id);

-- Запрос мастера «мои клиенты» и запрос карточки «у кого этот человек был».
create index if not exists client_masters_doctor_idx
  on public.client_masters(workspace_id, doctor_id, last_visit_at desc);

create index if not exists client_masters_client_idx
  on public.client_masters(workspace_id, client_id);

-- Правило 22b: таблица, до которой дотягивается serverless-код, обязана иметь
-- явный грант service_role. Без него маршрут авторизуется и падает на запросе.
alter table public.client_masters enable row level security;

revoke all on table public.client_masters from anon, authenticated;
grant select, insert, update on table public.client_masters to service_role;

commit;

notify pgrst, 'reload schema';
