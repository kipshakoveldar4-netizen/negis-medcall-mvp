-- NEGIS Migration 038 — сотрудник просится в клинику сам, клиника подтверждает.
--
-- Третий путь зачисления. Первые два начинает клиника: приглашение по почте
-- (024) и логин с паролем из рук в руки (staff-credentials). Оба требуют, чтобы
-- администратор завёл каждого поимённо. Владелец попросил обратное направление:
-- человек регистрируется сам, называет КОД клиники, и владелец или админ этой
-- клиники решает — принять или отклонить.
--
-- Что здесь важно понимать про код:
--
--   — код НЕ является учётными данными. По нему нельзя войти; по нему можно
--     только встать в очередь, которую читает живой человек. Поэтому код
--     хранится ОТКРЫТЫМ текстом, в отличие от токена приглашения (024 хранит
--     только SHA-256): токен предъявительский — он вместе с совпавшей почтой
--     СОЗДАЁТ членство, а код не создаёт ничего. И код нужно показывать
--     владельцу обратно в кабинете, чтобы он его диктовал, — хэш этого не умеет.
--
--   — код живёт ОТДЕЛЬНОЙ таблицей, а не колонкой в workspaces, потому что он
--     обязан переживать ротацию. Утёкший код меняют, и вопрос «по какому коду
--     пришла вот эта заявка» становится важен ровно в этот момент. Колонка
--     стирает старое значение и ответа не даёт. Заодно workspaces создаётся в
--     двух местах явным списком колонок — NOT NULL без дефолта сломал бы оба.
--
--   — заявка НЕ переиспользует staff_invitations: там token_hash обязателен и
--     уникален, а частичный индекс «одно живое приглашение на почту» столкнул
--     бы заявку с настоящим приглашением той же клиники на тот же адрес.
--
-- Ни одна применённая миграция здесь не переписывается: только новые таблицы.

begin;

-- ── Коды клиник ────────────────────────────────────────────────────────────
create table if not exists public.workspace_join_codes (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references public.workspaces(id) on delete cascade,
  code                     text not null,
  created_by_staff_user_id uuid references public.staff_users(id) on delete set null,
  created_at               timestamptz not null default now(),
  revoked_at               timestamptz,
  revoked_by_staff_user_id uuid references public.staff_users(id) on delete set null,
  constraint workspace_join_codes_code_check check (char_length(code) between 8 and 32)
);

-- Уникальность кода ГЛОБАЛЬНАЯ и вечная, включая отозванные строки: если
-- отозванный код может достаться другой клинике, человек со старой бумажкой
-- попадёт со своим именем и телефоном в чужую очередь.
create unique index if not exists workspace_join_codes_code_key
  on public.workspace_join_codes(code);

-- Живой код у клиники ровно один — это и есть модель владельца «мой код».
-- Ротация = штамп revoked_at на старой строке плюс вставка новой; правки кода
-- не существует, только перевыпуск.
create unique index if not exists workspace_join_codes_live_idx
  on public.workspace_join_codes(workspace_id) where revoked_at is null;

-- ── Заявки на вступление ───────────────────────────────────────────────────
create table if not exists public.staff_join_requests (
  id                        uuid primary key default gen_random_uuid(),
  workspace_id              uuid not null references public.workspaces(id) on delete cascade,
  join_code_id              uuid references public.workspace_join_codes(id) on delete set null,
  -- auth_user_id БЕЗ внешнего ключа на auth.users намеренно: миграция 008
  -- (drop_public_auth_users_fks) сняла такие связи, и 011 добавила
  -- staff_users.auth_user_id голым uuid. Новая таблица повторяет это решение,
  -- иначе она первой свяжет схему public со схемой auth обратно.
  auth_user_id              uuid not null,
  -- Снимок адреса из ПРОВЕРЕННОГО JWT, а не поле формы: он нужен, чтобы
  -- очередь была читаема и чтобы гасить приглашения на тот же адрес.
  email                     text not null,
  full_name                 text not null,
  phone                     text not null default '',
  position_note             text not null default '',
  status                    text not null default 'pending',
  created_at                timestamptz not null default now(),
  decided_at                timestamptz,
  decided_by_staff_user_id  uuid references public.staff_users(id) on delete set null,
  decision_note             text not null default '',
  granted_role              text,
  created_staff_user_id     uuid references public.staff_users(id) on delete set null,
  constraint staff_join_requests_status_check
    check (status in ('pending', 'approved', 'rejected')),
  -- 'owner' отсутствует НАМЕРЕННО: база отказывает в том же, в чём отказывает
  -- canAssignRole, и ошибка в обработчике не сможет выдать владельца.
  constraint staff_join_requests_role_check
    check (granted_role is null or granted_role in ('admin', 'manager', 'receptionist', 'marketer', 'doctor', 'agent', 'booking_agent')),
  -- «Одобрено без роли» и «решено без времени» становятся непредставимыми.
  constraint staff_join_requests_decision_check check (
    (status = 'pending'  and decided_at is null     and granted_role is null) or
    (status = 'approved' and decided_at is not null and granted_role is not null) or
    (status = 'rejected' and decided_at is not null and granted_role is null)
  ),
  constraint staff_join_requests_length_check check (
    char_length(email) <= 320 and char_length(full_name) <= 120 and
    char_length(phone) <= 32 and char_length(position_note) <= 120 and
    char_length(decision_note) <= 500
  )
);

-- Одна живая заявка на пару (клиника, аккаунт). Предикат по status, а не по
-- времени: 024 уже показала, чем кончается предикат, не знающий про истечение.
-- Отклонённая заявка индекс освобождает — иначе промах мышью по «Отклонить»
-- закрывал бы человеку дорогу в клинику навсегда.
create unique index if not exists staff_join_requests_pending_unique
  on public.staff_join_requests(workspace_id, auth_user_id) where status = 'pending';

create index if not exists staff_join_requests_workspace_idx
  on public.staff_join_requests(workspace_id, status, created_at desc);

create index if not exists staff_join_requests_applicant_idx
  on public.staff_join_requests(auth_user_id, created_at desc);

-- ── Промахи по коду ────────────────────────────────────────────────────────
-- Первый в проекте путь ЗАПИСИ, открытый любому аутентифицированному: членства
-- он не требует по определению. Ограничителя частоты в проекте нет ни одного, а
-- in-memory счётчик на Vercel бесполезен — каждая инвокация может попасть в
-- новый инстанс. Значит счётчик живёт здесь. Пишутся ТОЛЬКО промахи: удачная
-- подача ограничена частичным уникальным индексом выше.
create table if not exists public.staff_join_code_attempts (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  created_at   timestamptz not null default now()
);

create index if not exists staff_join_code_attempts_idx
  on public.staff_join_code_attempts(auth_user_id, created_at desc);

-- ── RLS и права ────────────────────────────────────────────────────────────
-- Правило паритета (035): новая таблица получает явный грант служебной роли в
-- той же миграции, что создаётся. Иначе повторится 024→025: таблица есть, RLS
-- включена, а сервер получает permission denied уже ПОСЛЕ того, как маршрут
-- авторизовал вызывающего. DELETE не выдаётся никому: решённая заявка обязана
-- оставаться строкой, иначе «мы это уже отклоняли» недоказуемо.
alter table public.workspace_join_codes     enable row level security;
alter table public.staff_join_requests      enable row level security;
alter table public.staff_join_code_attempts enable row level security;

revoke all on table public.workspace_join_codes     from anon, authenticated;
revoke all on table public.staff_join_requests      from anon, authenticated;
revoke all on table public.staff_join_code_attempts from anon, authenticated;

grant select, insert, update on table public.workspace_join_codes     to service_role;
grant select, insert, update on table public.staff_join_requests      to service_role;
grant select, insert         on table public.staff_join_code_attempts to service_role;

commit;
