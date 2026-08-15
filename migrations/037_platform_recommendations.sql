-- NEGIS Migration 037 — рекомендация платформы становится строкой.
--
-- Портал Medina Control видит сигналы здоровья клиники: нулевые недели,
-- незаполненный график, неподключённый WhatsApp. Следующий шаг — превратить
-- сигнал в совет, который владелец клиники увидит у себя в CRM и по которому
-- видно, прочитан он и сделан ли. Сегодня совету негде жить: письмо и звонок
-- не оставляют следа, и платформа не знает, помог ли совет.
--
-- Это ЕДИНСТВЕННОЕ, что платформа пишет в сторону клиник. Всё остальное
-- чтение панели — счётчики; здесь появляется строка, которую клиника читает
-- и чей статус меняет. Поэтому колонок мало и все они административные:
-- заголовок, текст, ссылка на раздел продукта, статус. Никаких данных
-- пациентов в рекомендации нет и не может быть по построению.
--
-- Статусная модель — путь одной строки: отправлена → прочитана → сделана или
-- скрыта. Прочтение и решение штампуются отдельными колонками времени, чтобы
-- «прочитана, но не сделана неделю» было видно без журнала.
--
-- DELETE в грантах нет намеренно, как у подписок: скрытая рекомендация — это
-- статус, а не исчезнувшая строка, иначе история советов исчезает вместе со
-- строкой и «мы это уже советовали» становится недоказуемым.

begin;

create table if not exists public.platform_recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  body text not null,
  -- Раздел продукта, куда ведёт кнопка у клиники: /staff-schedule, /services…
  -- Пустая строка — рекомендация без кнопки. Только путь внутри CRM, не URL:
  -- внешние адреса этой кнопке запрещены по построению.
  action_path text not null default '',
  -- Ключ сигнала, из которого совет родился. Пустой — совет написан свободно.
  signal_key text not null default '',
  status text not null default 'sent',
  -- Почта автора — владельца платформы. Не секрет: клиника и так знает, кто
  -- ей пишет, а платформе нужно различать авторов, когда их станет двое.
  created_by text not null default '',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint platform_recommendations_status_check
    check (status in ('sent', 'read', 'done', 'dismissed')),
  -- Кнопка ведёт только внутрь продукта: путь начинается со слэша, не со
  -- второго слэша и без обратных слэшей — «/\evil» браузерный парсер URL
  -- нормализует в протокол-относительную ссылку наружу.
  constraint platform_recommendations_action_check
    check (
      action_path = ''
      or (
        action_path like '/%'
        and action_path not like '//%'
        and position('\' in action_path) = 0
      )
    ),
  -- Совет — карточка на экране, а не документ: пределы и в базе тоже.
  constraint platform_recommendations_length_check
    check (
      char_length(title) <= 200
      and char_length(body) <= 2000
      and char_length(signal_key) <= 100
      and char_length(action_path) <= 200
    )
);

create index if not exists platform_recommendations_workspace_idx
  on public.platform_recommendations(workspace_id, created_at desc);

create index if not exists platform_recommendations_status_idx
  on public.platform_recommendations(workspace_id, status);

alter table public.platform_recommendations enable row level security;

revoke all on table public.platform_recommendations from anon, authenticated;

-- Правило паритета: новой таблице — явный грант service_role, иначе сервер
-- получает permission denied, который экран покажет как «рекомендаций нет».
grant select, insert, update
  on table public.platform_recommendations
  to service_role;

commit;
