# NEGIS — МАСТЕР-ПРОМТ ДЛЯ REPLIT
# Операционная экосистема для клиник
# Версия 1.0 | Май 2026

---

## ШАГ 0 — ПЕРЕД НАЧАЛОМ

Перед тем как писать любой код, запроси у пользователя:

1. Supabase Project URL (формат: https://xxxx.supabase.co)
2. Supabase Anon Key (Supabase → Settings → API → anon public)
3. Supabase Service Role Key (Supabase → Settings → API → service_role)
4. Telegram Bot Token
5. Telegram Chat ID

Сохрани в .env:
```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_SUPABASE_SERVICE_ROLE_KEY=
VITE_TELEGRAM_BOT_TOKEN=
VITE_TELEGRAM_CHAT_ID=
```

Не пиши ни одной строки кода пока не получишь все ключи.

---

## НАЗВАНИЕ И КОНЦЕПЦИЯ

Название продукта: **Negis**
Tagline: "Операционная экосистема для клиник"
Язык интерфейса: русский
Валюта: ₸ (тенге). Никогда не использовать ₽ или $.

Negis — это единая платформа с тремя рабочими пространствами:
- **Запись** — операторы записывают клиентов
- **Ресепшн** — отмечают приход клиентов
- **Negis CRM** — отдел продаж работает с лидами

Плюс:
- **Дашборд** — руководитель видит всё
- **Админ панель** — управление системой
- **Экран агента** — чекин/чекаут смены

---

## ТЕХНИЧЕСКИЙ СТЕК

```
React 18 + Vite + TypeScript
Supabase (auth + database + realtime)
Tailwind CSS
React Router v6
@tanstack/react-query v5
date-fns
Lucide React (иконки, outline стиль)
Sonner (toast уведомления)
Zod (валидация форм)
react-day-picker v8
```

---

## ДИЗАЙН СИСТЕМА — НЕОМОРФИЗМ

### Цвета:
```
Фон:           #E8EDF2
Текст:         #1E293B
Текст muted:   #64748B
Primary:       #1A56DB
Secondary:     #3B82F6
Success:       #10B981
Warning:       #F59E0B
Error:         #EF4444
```

### CSS (src/index.css):
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; }

body {
  background: #E8EDF2;
  font-family: 'Inter', sans-serif;
  color: #1E293B;
  -webkit-font-smoothing: antialiased;
}

/* RAISED */
.neu {
  background: #E8EDF2;
  box-shadow: 6px 6px 12px #c5cad4, -6px -6px 12px #ffffff;
  border-radius: 16px;
  transition: all 0.2s ease;
}
.neu-sm {
  background: #E8EDF2;
  box-shadow: 3px 3px 6px #c5cad4, -3px -3px 6px #ffffff;
  border-radius: 12px;
  transition: all 0.2s ease;
}
.neu-lg {
  background: #E8EDF2;
  box-shadow: 10px 10px 20px #c5cad4, -10px -10px 20px #ffffff;
  border-radius: 16px;
}

/* PRESSED */
.neu-pressed {
  background: #E8EDF2;
  box-shadow: inset 4px 4px 8px #c5cad4, inset -4px -4px 8px #ffffff;
  border-radius: 16px;
}
.neu-pressed-sm {
  background: #E8EDF2;
  box-shadow: inset 2px 2px 4px #c5cad4, inset -2px -2px 4px #ffffff;
  border-radius: 12px;
}

/* INPUT */
.neu-input {
  background: #E8EDF2;
  box-shadow: inset 2px 2px 4px #c5cad4, inset -2px -2px 4px #ffffff;
  border-radius: 10px;
  border: none;
  outline: none;
  padding: 10px 14px;
  width: 100%;
  font-size: 14px;
  color: #1E293B;
  font-family: 'Inter', sans-serif;
  transition: all 0.2s ease;
}
.neu-input:focus {
  box-shadow: inset 2px 2px 4px #c5cad4, inset -2px -2px 4px #ffffff,
              0 0 0 2px rgba(26,86,219,0.25);
}
.neu-input::placeholder { color: #94a3b8; }

/* BUTTONS */
.neu-btn {
  background: #E8EDF2;
  box-shadow: 6px 6px 12px #c5cad4, -6px -6px 12px #ffffff;
  border-radius: 50px;
  border: none;
  font-weight: 600;
  font-size: 14px;
  padding: 10px 22px;
  cursor: pointer;
  color: #1E293B;
  font-family: 'Inter', sans-serif;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.neu-btn:hover { box-shadow: 8px 8px 16px #c5cad4, -8px -8px 16px #ffffff; }
.neu-btn:active { box-shadow: inset 4px 4px 8px #c5cad4, inset -4px -4px 8px #ffffff; }

.neu-btn-primary {
  background: #1A56DB;
  color: white;
  box-shadow: 4px 4px 10px #c5cad4, -4px -4px 10px #ffffff;
  border-radius: 50px;
  border: none;
  font-weight: 600;
  font-size: 14px;
  padding: 10px 22px;
  cursor: pointer;
  font-family: 'Inter', sans-serif;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.neu-btn-primary:hover { background: #1648c0; }
.neu-btn-primary:active { box-shadow: inset 3px 3px 6px rgba(0,0,0,0.2); }

.neu-btn-success {
  background: #10B981;
  color: white;
  box-shadow: 4px 4px 10px #c5cad4, -4px -4px 10px #ffffff;
  border-radius: 50px;
  border: none;
  font-weight: 600;
  font-size: 13px;
  padding: 8px 16px;
  cursor: pointer;
  font-family: 'Inter', sans-serif;
  transition: all 0.2s ease;
}
.neu-btn-success:active { box-shadow: inset 3px 3px 6px rgba(0,0,0,0.2); }

.neu-btn-danger {
  background: #EF4444;
  color: white;
  box-shadow: 4px 4px 10px #c5cad4, -4px -4px 10px #ffffff;
  border-radius: 50px;
  border: none;
  font-weight: 600;
  font-size: 13px;
  padding: 8px 16px;
  cursor: pointer;
  font-family: 'Inter', sans-serif;
  transition: all 0.2s ease;
}
.neu-btn-danger:active { box-shadow: inset 3px 3px 6px rgba(0,0,0,0.2); }

/* ICON BUTTON */
.neu-icon-btn {
  background: #E8EDF2;
  box-shadow: 3px 3px 6px #c5cad4, -3px -3px 6px #ffffff;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  color: #64748B;
}
.neu-icon-btn:hover { color: #1A56DB; }
.neu-icon-btn:active { box-shadow: inset 2px 2px 4px #c5cad4, inset -2px -2px 4px #ffffff; }

/* CARD */
.neu-card {
  background: #E8EDF2;
  box-shadow: 6px 6px 12px #c5cad4, -6px -6px 12px #ffffff;
  border-radius: 16px;
  padding: 20px;
}

/* BADGE */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
}
```

### Правила:
- Никаких жёстких border
- Никаких градиентов
- Никаких плоских карточек
- Все интерактивные элементы — pressed state при клике
- Все инпуты — neu-input стиль (вдавленный)
- Все кнопки — скруглённые (border-radius: 50px)

---

## СТРУКТУРА РОУТОВ

```
/                → Landing (выбор отдела)
/register        → Регистрация клиники
/onboarding      → Онбординг (4 шага)
/dashboard       → Дашборд руководителя
/booking         → Запись (операторы)
/reception       → Ресепшн
/sales           → Negis CRM (отдел продаж)
/agent           → Экран агента (смены)
/admin           → Админ панель
*                → 404
```

---

## БАЗА ДАННЫХ SUPABASE

Выполни весь SQL ниже в Supabase SQL Editor за один раз:

```sql
-- =============================================
-- NEGIS — ПОЛНАЯ СХЕМА БАЗЫ ДАННЫХ
-- =============================================

-- CLINICS
CREATE TABLE IF NOT EXISTS clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  onboarding_completed boolean DEFAULT false,
  plan text DEFAULT 'basic',
  work_start time DEFAULT '10:00',
  work_end time DEFAULT '18:00',
  slot_limit integer DEFAULT 3,
  whatsapp_number text,
  telegram_chat_id text,
  whatsapp_template text DEFAULT 'Здравствуйте, {имя}! Вы записаны на {дата} в {время}. Услуга: {услуга}. Специалист: {агент}.',
  created_at timestamptz DEFAULT now()
);

-- PROFILES
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  created_at timestamptz DEFAULT now()
);

-- USER ROLES
CREATE TABLE IF NOT EXISTS user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  role text DEFAULT 'agent' CHECK (role IN ('owner', 'manager', 'agent', 'receptionist')),
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, clinic_id)
);

-- CUSTOM ROLES
CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  permissions jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- AGENTS
CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  email text,
  role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
  avatar_url text,
  hourly_rate numeric DEFAULT 0,
  weekly_target integer DEFAULT 20,
  created_at timestamptz DEFAULT now()
);

-- SERVICES
CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  price numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- PROJECTS (CRM)
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now()
);

-- LEAD STATUSES
CREATE TABLE IF NOT EXISTS lead_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text DEFAULT '#3B82F6',
  position integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- LEADS
CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  first_name text,
  last_name text,
  phone text,
  age integer,
  source text CHECK (source IN ('Instagram', 'Google', 'WhatsApp', '2GIS', 'Вручную', 'Webhook')),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  status_id uuid REFERENCES lead_statuses(id) ON DELETE SET NULL,
  comment text,
  created_at timestamptz DEFAULT now()
);

-- LEAD HISTORY
CREATE TABLE IF NOT EXISTS lead_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  action text NOT NULL,
  old_value text,
  new_value text,
  created_at timestamptz DEFAULT now()
);

-- BOOKING STATUSES
CREATE TABLE IF NOT EXISTS booking_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text DEFAULT '#3B82F6',
  position integer DEFAULT 0,
  is_confirmed boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- BOOKINGS
CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  responsible_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  service_id uuid REFERENCES services(id) ON DELETE SET NULL,
  status_id uuid REFERENCES booking_statuses(id) ON DELETE SET NULL,
  name text NOT NULL,
  phone text,
  age integer,
  date date NOT NULL,
  time text NOT NULL,
  comment text,
  visited boolean,
  created_at timestamptz DEFAULT now()
);

-- SHIFTS
CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  start_time timestamptz NOT NULL,
  end_time timestamptz,
  duration_minutes integer DEFAULT 0,
  bookings_count integer DEFAULT 0,
  earnings numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- SETTINGS
CREATE TABLE IF NOT EXISTS settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE UNIQUE,
  whatsapp_template text,
  telegram_template text,
  created_at timestamptz DEFAULT now()
);

-- SUBSCRIPTIONS
CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  plan text NOT NULL,
  price numeric DEFAULT 0,
  started_at timestamptz DEFAULT now(),
  ends_at timestamptz,
  status text DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  created_at timestamptz DEFAULT now()
);

-- =============================================
-- TRIGGER: AUTO CREATE PROFILE ON SIGNUP
-- =============================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (new.id, new.raw_user_meta_data->>'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- CLINICS
CREATE POLICY "clinics_select" ON clinics FOR SELECT USING (owner_id = auth.uid());
CREATE POLICY "clinics_insert" ON clinics FOR INSERT WITH CHECK (owner_id = auth.uid());
CREATE POLICY "clinics_update" ON clinics FOR UPDATE USING (owner_id = auth.uid());
CREATE POLICY "clinics_delete" ON clinics FOR DELETE USING (owner_id = auth.uid());

-- PROFILES
CREATE POLICY "profiles_all" ON profiles FOR ALL USING (id = auth.uid());

-- USER ROLES
CREATE POLICY "user_roles_select" ON user_roles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "user_roles_insert" ON user_roles FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "user_roles_update" ON user_roles FOR UPDATE USING (user_id = auth.uid());

-- HELPER FUNCTION
CREATE OR REPLACE FUNCTION get_user_clinic_id()
RETURNS uuid AS $$
  SELECT clinic_id FROM user_roles WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ALL CLINIC DATA
CREATE POLICY "clinic_roles" ON roles FOR ALL USING (clinic_id = get_user_clinic_id());
CREATE POLICY "clinic_agents" ON agents FOR ALL USING (clinic_id = get_user_clinic_id());
CREATE POLICY "clinic_services" ON services FOR ALL USING (clinic_id = get_user_clinic_id());
CREATE POLICY "clinic_projects" ON projects FOR ALL USING (clinic_id = get_user_clinic_id());
CREATE POLICY "clinic_lead_statuses" ON lead_statuses FOR ALL USING (clinic_id = get_user_clinic_id());
CREATE POLICY "clinic_leads" ON leads FOR ALL USING (clinic_id = get_user_clinic_id());
CREATE POLICY "clinic_lead_history" ON lead_history FOR ALL USING (lead_id IN (SELECT id FROM leads WHERE clinic_id = get_user_clinic_id()));
CREATE POLICY "clinic_booking_statuses" ON booking_statuses FOR ALL USING (clinic_id = get_user_clinic_id());
CREATE POLICY "clinic_bookings" ON bookings FOR ALL USING (clinic_id = get_user_clinic_id());
CREATE POLICY "clinic_shifts" ON shifts FOR ALL USING (clinic_id = get_user_clinic_id());
CREATE POLICY "clinic_settings" ON settings FOR ALL USING (clinic_id = get_user_clinic_id());
CREATE POLICY "clinic_subscriptions" ON subscriptions FOR ALL USING (clinic_id = get_user_clinic_id());
```

---

## СТРАНИЦА 1 — LANDING /

Полноэкранный неоморфный лэйаут. По центру:

**Шапка:**
- Логотип: h1 "Negis" жирный синий #1A56DB
- Подзаголовок: "Операционная экосистема для клиник" серый

**Три большие кнопки отделов (grid 3 колонки):**
```
📋 Запись        🏥 Ресепшн        💼 Negis CRM
```
- Каждая кнопка: класс neu, большая иконка в neu-icon-btn, текст под ней
- При клике → модальное окно входа (email + пароль)
- После входа → определить роль пользователя → редирект на нужный маршрут
- Если нет клиники → /onboarding

**Нижняя часть:**
- Ссылка "Нет аккаунта? Зарегистрировать клинику" → /register
- Маленькая ссылка снизу справа: "Войти как администратор" → /admin

**Модальное окно входа:**
- Класс neu-lg, backdrop blur
- Поля: Email (neu-input), Пароль (neu-input)
- Кнопка "Войти" (neu-btn-primary, full width)
- Ссылка "Зарегистрироваться"
- Крестик закрыть (neu-icon-btn)
- При ошибке → toast.error()
- Таймаут 5 секунд — если не загрузилось показать ошибку с кнопкой "Повторить"

---

## СТРАНИЦА 2 — РЕГИСТРАЦИЯ /register

Форма по центру (neu-lg карточка):

Поля (все neu-input):
- Имя владельца
- Название клиники
- Email
- Пароль (мин. 8 символов)
- Подтверждение пароля

Валидация через Zod. Показывать ошибки под полями.

При отправке:
1. supabase.auth.signUp()
2. INSERT в clinics (name, owner_id)
3. INSERT в user_roles (role='owner')
4. Отправить письмо подтверждения
5. Редирект на /onboarding

Ссылка "← На главную"

---

## СТРАНИЦА 3 — ОНБОРДИНГ /onboarding

4-шаговый визард. Прогресс бар сверху (neu-sm).

**Шаг 1 — Настройки клиники:**
- Название клиники (neu-input, предзаполнено)
- Часы работы: от (time input) до (time input), по умолчанию 10:00–18:00
- Максимум записей на слот (number input, default 3)

**Шаг 2 — Первый агент:**
- Имя агента
- Email
- Пароль
- Роль (dropdown: Оператор, Ресепшн, Менеджер)
- Часовая ставка ₸
- Недельный таргет (кол-во записей)

**Шаг 3 — Услуги:**
- Поля: название + цена ₸
- Кнопка "+ Добавить услугу"
- Список добавленных услуг с возможностью удалить

**Шаг 4 — Уведомления:**
- Telegram Chat ID
- Номер WhatsApp (с кодом страны)
- Шаблон WhatsApp сообщения (textarea)
- Переменные: {имя} {дата} {время} {услуга} {агент}
- Live превью под textarea с тестовыми данными

По завершении:
- onboarding_completed = true
- Редирект на /dashboard

---

## ОБЩИЙ САЙДБАР (на всех страницах кроме Landing/Register/Onboarding)

Левая панель 240px, сворачивается.

**Верх:**
- Логотип "Negis" синий

**Навигация (neu-sm кнопки):**
- 📊 Дашборд → /dashboard
- 📋 Запись → /booking
- 🏥 Ресепшн → /reception
- 💼 Negis CRM → /sales
- ⚙️ Админ → /admin

Активный пункт — neu-pressed + синий текст.

**Кнопка сворачивания:**
- neu-icon-btn со стрелкой
- Анимация slide (CSS transition 0.3s)
- Когда свёрнут — только иконки без текста

**Низ сайдбара:**
- Круглый аватар с инициалами (neu-icon-btn)
- Имя пользователя
- Название клиники
- Кнопка "Выйти"

**Верхняя полоса (topbar):**
- Название текущего раздела
- Колокольчик с badge (кол-во новых записей)
- При клике на колокольчик → dropdown с последними 5 записями

---

## СТРАНИЦА 4 — ДАШБОРД /dashboard

Только для owner/manager.

**4 метрики сверху (neu карточки):**
- Записей сегодня (COUNT bookings WHERE date=today)
- Загрузка % (занятые слоты / общие слоты * 100)
- Выручка сегодня ₸ (SUM price WHERE date=today AND visited=true)
- Пришло клиентов (COUNT WHERE visited=true AND date=today)

**Гонка агентов (центр):**
- Заголовок "Гонка агентов 🏆"
- Каждый агент: neu-sm карточка
  - Аватар/инициалы
  - Имя
  - Кол-во записей за неделю / weekly_target
  - Прогресс бар синий
  - % выполнения
- Лидер — карточка с синей тенью: box-shadow: 0 0 20px rgba(26,86,219,0.3)
- Сортировка по % выполнения

**Загрузка по часам:**
- Список слотов 10:00–18:00
- Каждый слот: время + X/3 + цвет (зелёный/жёлтый/красный)
- Данные из bookings WHERE date=today

**Блок проблем:**
- Непотверждённые записи (status = null или 'new')
- Неприходы (visited=false AND время прошло)

**Realtime:**
- Supabase Realtime подписка на INSERT в bookings
- Колокольчик загорается с цифрой
- Toast уведомление: имя клиента, время, агент, услуга
- Звук через Web Audio API:
```javascript
const ctx = new AudioContext();
const osc = ctx.createOscillator();
osc.frequency.value = 520;
osc.connect(ctx.destination);
osc.start();
osc.stop(ctx.currentTime + 0.15);
```

---

## СТРАНИЦА 5 — NEGIS CRM /sales

**Топбар:**
- Поиск (neu-input) "Поиск по имени или телефону"
- Фильтры (neu-sm dropdown): Статус, Ответственный, Источник, Проект, Дата
- Кнопка "+ Новый лид" (neu-btn-primary)

**Таблица лидов:**
Колонки: Имя, Телефон, Источник, Статус (цветной badge), Ответственный, Дата, Действия

- Данные из leads JOIN lead_statuses, agents, projects
- Все данные по clinic_id текущего пользователя
- При клике на строку → карточка лида
- Empty state: neu карточка "Нет лидов. Добавьте первого клиента."

**Карточка лида (модальное окно full screen):**

Левая часть (60%):
- Круглый аватар с инициалами
- Редактируемые поля (neu-input):
  - Имя
  - Фамилия
  - Телефон
  - Возраст
- Dropdown (neu-sm): Источник (Instagram / Google / WhatsApp / 2GIS / Вручную)
- Dropdown: Проект (из таблицы projects)
- Dropdown: Статус (из lead_statuses, цветной кружок рядом)
- Dropdown: Ответственный (из agents) — только manager/owner могут менять
- Textarea: Комментарий
- Кнопка "Сохранить" (neu-btn-primary)

Правая часть (40%):
- Заголовок "История действий"
- Timeline из lead_history: иконка, текст действия, кто сделал, когда
- Кнопка "📅 Записать клиента" (neu-btn-primary, full width)

**Под-модальное окно "Записать клиента":**
- Календарь (react-day-picker, neumorphic стиль)
- Клик по дате → сетка слотов 10:00–18:00 по часу
- Каждый слот: время + X/3
  - Зелёный: 0–1 записи
  - Жёлтый: 2 записи
  - Красный/disabled: 3 записи (максимум)
- Выбор слота → форма:
  - Имя (предзаполнено из лида, редактируемо)
  - Телефон (предзаполнено, редактируемо)
  - Возраст (предзаполнено если есть)
  - Услуга (dropdown из services)
  - Комментарий
- Кнопка "Подтвердить запись"
- При отправке:
  - INSERT в bookings
  - UPDATE leads SET status = "Записан"
  - INSERT в lead_history (действие: "Записан на {дата} {время}")
  - Отправить Telegram уведомление

**Модальное окно "Новый лид":**
Поля: Имя, Фамилия, Телефон, Возраст, Источник, Проект, Статус, Комментарий
Кнопка "Создать лид" → INSERT в leads

**Realtime подписка на leads** — обновление таблицы без перезагрузки.

---

## СТРАНИЦА 6 — ЗАПИСЬ /booking

**Вид менеджера/owner:**

Лево: Neumorphic календарь (react-day-picker)
- Клик по дате → показать записи справа
- Даты с записями — синяя точка под числом

Право: Список записей на выбранную дату
- Каждая строка: Имя, Телефон, Возраст, Услуга, Время, Агент
- Статус dropdown (из booking_statuses, до 10 кастомных)
- Когда статус = "Подтверждено" (is_confirmed=true) → запись появляется у Ресепшн
- Менеджер может менять responsible_id (агент → ресепшн)
- Агент НЕ может менять responsible_id

**Вид агента:**
- То же, но только свои записи (WHERE agent_id = current_agent_id)
- Видит поле visited (true/false) выставленное ресепшном
- Не может менять ответственного

---

## СТРАНИЦА 7 — РЕСЕПШН /reception

Показывает ТОЛЬКО записи где:
- status IS_CONFIRMED = true
- date = сегодня
- clinic_id совпадает

**Таблица:**
Колонки: Время, Имя, Телефон, Возраст, Услуга

Каждая строка: две кнопки
- ✅ **Пришёл** (neu-btn-success) → visited=true
- ❌ **Не пришёл** (neu-btn-danger) → visited=false

При нажатии:
- Кнопка становится neu-pressed
- UPDATE bookings SET visited=...
- Realtime обновление у агента который создал запись

Больше никаких действий для ресепшниста.

---

## СТРАНИЦА 8 — ЭКРАН АГЕНТА /agent

Страница входа:
- Email + пароль (neu-input)
- Кнопка "Войти" (neu-btn-primary)

После входа — панель смены:

**Если смена не начата:**
- Большая кнопка "▶ Начать смену" (neu-btn-primary)
- Информация: имя агента, роль, таргет недели

**Если смена активна:**
- Таймер HH:MM:SS (обновляется каждую секунду)
- Счётчик заработка в реальном времени: elapsed_minutes / 60 * hourly_rate ₸
- Прогресс до недельного таргета (полоска)
- Мои записи сегодня (список из bookings)
- Большая кнопка "⏹ Завершить смену" (neu-btn-danger)

При завершении:
- UPDATE shifts SET end_time, duration_minutes, earnings
- Показать итог: время смены, записей, заработано

---

## СТРАНИЦА 9 — АДМИН ПАНЕЛЬ /admin

Только для owner/manager. Табы (neu-sm):

**Таб 1 — Агенты:**
- Таблица: аватар, имя, email, роль, ставка ₸/час, таргет/нед, действия
- Кнопка "+ Добавить агента"
- Модальное создание/редактирование:
  - Имя, Email, Пароль (при создании)
  - Роль (dropdown из roles)
  - Часовая ставка ₸
  - Недельный таргет
  - Аватар URL (поле ввода)
- Удаление с подтверждением

**Таб 2 — Роли:**
- До 10 кастомных ролей
- Создание роли: название + матрица прав (чекбоксы):
  - Просмотр лидов: только свои / все
  - Создание записей: да/нет
  - Смена ответственного: да/нет
  - Доступ в админку: да/нет
  - Просмотр финансов: да/нет
  - Экспорт данных: да/нет
- Сохранение в roles.permissions (jsonb)

**Таб 3 — Услуги:**
- Список: название + цена ₸
- Добавить/редактировать/удалить

**Таб 4 — Статусы:**
Два блока:

Статусы записей (из booking_statuses):
- До 10 статусов
- Поля: название + цвет (color picker) + переключатель "Подтверждено"
- Только один статус может быть is_confirmed=true

Статусы лидов (из lead_statuses):
- До 10 статусов
- Поля: название + цвет
- По умолчанию создать: Новый (синий), Перезвонить (жёлтый), Отказ (красный), Другой город (серый), Противопоказания (оранжевый), Возраст (фиолетовый)

**Таб 5 — Смены:**
- Таблица: агент, дата, чекин, чекаут, длительность, записей, заработок ₸
- Фильтр по агенту и дате

**Таб 6 — WhatsApp шаблон:**
- Textarea с переменными: {имя} {дата} {время} {услуга} {агент}
- Живое превью с тестовыми данными под textarea
- Кнопка "Сохранить" → UPDATE clinics SET whatsapp_template

**Таб 7 — Настройки:**
- Название клиники
- Часы работы: от / до
- Максимум на слот
- Номер WhatsApp
- Telegram Chat ID
- Кнопка "Сохранить"

**Предупреждение в сайдбаре:**
- Полоса "⚠️ НЕ ВХОДИТЬ" — диагональные чёрно-жёлтые полосы
- Поверх полосы — лёгкое стекло (rgba белый + blur)
- Не кнопка — просто декоративный элемент

---

## УВЕДОМЛЕНИЯ

**Telegram (при новой записи):**
```
POST https://api.telegram.org/bot{TOKEN}/sendMessage
{
  chat_id: TELEGRAM_CHAT_ID,
  text: "📅 Новая запись!\n\nКлиент: {name}\nТелефон: {phone}\nДата: {date} в {time}\nУслуга: {service}\nАгент: {agent}"
}
```

**WhatsApp (генерировать ссылку после записи):**
```
https://wa.me/{whatsapp_number}?text={encodeURIComponent(template)}
```
Кнопка "Открыть WhatsApp" которая открывает эту ссылку.

**Realtime браузер:**
- Supabase Realtime на таблице bookings (INSERT)
- Toast (sonner) снизу справа
- Звук 520hz 150ms через Web Audio API
- Счётчик на колокольчике в topbar

---

## МУЛЬТИТЕНАНТНОСТЬ

- Каждый запрос фильтруется по clinic_id
- clinic_id берётся из user_roles WHERE user_id = auth.uid()
- Один пользователь — одна клиника
- Данные разных клиник полностью изолированы через RLS

---

## ЗАЩИТА И БЕЗОПАСНОСТЬ

**HTTP заголовки (добавить в vite.config.ts):**
```typescript
server: {
  headers: {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000'
  }
}
```

**Правила:**
- Пароли только через Supabase Auth (bcrypt автоматически)
- service_role key никогда не в клиентском коде
- Все запросы через RLS политики
- Агент не может менять ответственного — проверка на уровне UI и RLS

---

## UX ПРАВИЛА

- Все формы валидируются через Zod перед отправкой
- Все асинхронные операции имеют loading состояние
- Все таблицы имеют empty state с подсказкой
- Все удаления требуют подтверждения
- Мобильная адаптация (операторы работают с телефона)
- Все ошибки показываются через toast.error()
- Все успехи через toast.success()
- Язык: русский везде
- Валюта: ₸ везде

---

## СТРУКТУРА ФАЙЛОВ

```
src/
  components/
    layout/
      Sidebar.tsx        (общий сайдбар)
      Topbar.tsx         (верхняя панель с колокольчиком)
      PageLayout.tsx     (обёртка страниц)
    neu/
      NeuButton.tsx      (кнопки)
      NeuInput.tsx       (инпуты)
      NeuCard.tsx        (карточки)
      NeuModal.tsx       (модальные окна)
    booking/
      Calendar.tsx       (neumorphic календарь)
      SlotGrid.tsx       (сетка слотов)
    crm/
      LeadCard.tsx       (карточка лида)
      LeadTable.tsx      (таблица лидов)
  pages/
    Landing.tsx
    Register.tsx
    Onboarding.tsx
    Dashboard.tsx
    Sales.tsx            (Negis CRM)
    Booking.tsx
    Reception.tsx
    Agent.tsx
    Admin.tsx
    NotFound.tsx
  hooks/
    useAuth.tsx
    useClinic.tsx
    useRealtime.tsx
  integrations/
    supabase/
      client.ts
  lib/
    utils.ts
    telegram.ts          (отправка уведомлений)
    whatsapp.ts          (генерация ссылок)
```

---

## ВАЖНЫЕ ДЕТАЛИ

1. После логина всегда проверять user_roles — если записи нет, отправить на /onboarding
2. После регистрации — email подтверждение через Supabase Auth
3. Если onboarding_completed = false — всегда редирект на /onboarding
4. Все dropdown-ы для статусов загружаются из базы (не хардкод)
5. При создании клиники автоматически создавать дефолтные статусы лидов:
   - Новый (#3B82F6)
   - Перезвонить (#F59E0B)
   - Отказ (#EF4444)
   - Другой город (#94A3B8)
   - Противопоказания (#F97316)
   - Возраст (#A855F7)
6. При создании клиники создавать дефолтный статус записи:
   - Новая (#94A3B8)
   - Подтверждено (#10B981, is_confirmed=true)
   - Отменено (#EF4444)

---

*NEGIS — Операционная экосистема для клиник*
*Версия 1.0 | Казахстан | Валюта ₸*
