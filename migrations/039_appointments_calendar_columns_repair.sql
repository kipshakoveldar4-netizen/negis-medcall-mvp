-- NEGIS Migration 039 — доводит appointments до 012 на базах, куда 012 не дошла.
--
-- Что случилось. Мастер салона не мог записать клиента: каждая попытка
-- заканчивалась «Сбой на стороне сервиса». В логе — «Could not find the
-- 'duration_minutes' column of 'appointments' in the schema cache». Колонку
-- завела 012_calendar_fields, но на этой базе её не применили: 012 лежит в
-- репозитории с пометкой «safe to run multiple times», её пропустили, а более
-- поздние миграции применили. Сервер шлёт duration_minutes в каждой вставке —
-- значит запись не создавалась вообще, ни одна.
--
-- Почему 012 не переписывается и не «применяется задним числом». Применённая
-- миграция не переписывается никогда — только новая forward-миграция. И 012
-- нельзя просто запустить: у неё нет уверенности в том, что было до неё, а
-- здесь известно ровно то, чего не хватает. Поэтому 039 повторяет ЕЁ ЖЕ
-- добавления, идемпотентно, и на базе, где 012 применена, не делает ничего.
--
-- default 60 повторяет 012 дословно. Значение не выдумано: сервер и без базы
-- считает визит шестидесятиминутным (appointmentMinutes), и любое другое число
-- здесь означало бы, что проверка пересечений и хранимая длительность разошлись.
-- Существующие строки получают 60 — это ровно то, чем их уже считает код.
--
-- Кода в этой миграции нет ни одного нового: только те три колонки и те два
-- индекса, что перечислены в 012.

begin;

alter table public.appointments
  add column if not exists duration_minutes integer default 60,
  add column if not exists whatsapp text,
  add column if not exists source text;

-- Индексы из 012. Второй опирается на doctor_name из 010 — колонка есть на
-- любой базе, где вообще существует appointments в нынешнем виде, но проверка
-- дешевле отказа: миграция, упавшая на середине, оставила бы колонки без
-- индексов и потребовала бы разбираться, что именно применилось.
create index if not exists idx_appointments_starts_at
  on public.appointments(starts_at);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'appointments' and column_name = 'doctor_name'
  ) then
    create index if not exists idx_appointments_doctor_starts_at
      on public.appointments(doctor_name, starts_at);
  end if;
end
$$;

commit;

-- PostgREST держит схему в кэше и до перечитывания отвечает «Could not find the
-- column» уже добавленной колонке. На Supabase перечитывание запускает
-- встроенный триггер на DDL — эта строка нужна там, где триггера нет, и лишней
-- не бывает: повторное уведомление ничего не ломает.
notify pgrst, 'reload schema';
