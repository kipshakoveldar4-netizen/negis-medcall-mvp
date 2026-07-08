# Negis OS — Design System

Design foundation for **Negis OS**. This is a strategy + documentation reference; it does not
mandate an immediate UI refactor. Existing working screens (Ads Automation, Content Studio,
Dashboard, Admin) keep working while new screens are built against these rules.

> Scope note: the visible product name is **Negis OS**. Legacy technical names (repo
> `negis-medcall-mvp`, package `@workspace/negis`, env vars, API routes like `/api/crm/*`,
> database tables) are **not** renamed — only user-facing brand text.

---

## 1. Product identity

- **Product name:** Negis OS
- **Positioning:** AI Business OS для клиник
- **Value proposition (one line):** Negis OS превращает рекламу в заявки, записи и повторные визиты — и подсказывает следующий шаг.
- **Product promise:** одна система, где клиника видит весь путь клиента и получает конкретные действия от AI, а не сырые данные.
- **What the product is NOT:**
  - не рекламный кабинет Meta и не замена Ads Manager;
  - не «дашборд ради дашборда» — каждый экран ведёт к действию;
  - не инструмент для técnических специалистов: технические детали скрыты от владельца клиники;
  - не автопилот, который сам тратит бюджет — реальные кампании создаются **выключенными (PAUSED)**.

---

## 2. Strategic product chain

Negis OS соединяет весь операционный цикл клиники:

```
реклама → лид → CRM → запись → продажа → повторный визит → аналитика → AI-рекомендации → действия
```

Каждый этап передаёт данные следующему, а слой AI замыкает круг: аналитика превращается в
рекомендации, а рекомендации — в конкретные действия (написать в WhatsApp, перезвонить,
запустить рекламу, вернуть клиента).

---

## 3. Design principles

- **Clean Medical OS** — светлый фон, белые карточки, мягкие мятно-бирюзовые акценты, спокойный и медицинский тон.
- **Client-first clarity** — владелец клиники видит бизнес-смысл, а не технические поля. Один экран — одна главная мысль.
- **AI as action layer** — AI не просто показывает цифры, а предлагает следующий шаг с понятной кнопкой.
- **Technical details hidden** — payload, ID, ссылки, статусы Meta по умолчанию скрыты; доступны только в admin-режиме внутри свёрнутых блоков.
- **Safe-mode for ads** — реклама создаётся выключенной (PAUSED); ACTIVE-запуск отдельно gated. Тест без создания рекламы всегда отделён от реального запуска.
- **Business outcome over raw features** — язык интерфейса про заявки, записи, доход и потери, а не про «эндпоинты» и «джобы».

---

## 4. User roles

### Clinic owner (владелец клиники)
- **Goals:** видеть бизнес целиком — сколько заявок, записей, продаж, где теряются деньги, что делать дальше.
- **Main screens:** AI Control Center, Аналитика, Реклама, Заявки/CRM (обзор), Настройки (команда/подписка).
- **Needs to see:** обзор бизнеса, заявки, реклама, продажи, записи, управление сотрудниками, AI-рекомендации, доход и потери.
- **Must NOT see:** publicUrl, video_id, raw payloads, детали Supabase, отладка Meta, логи.

### Clinic administrator / manager (администратор клиники)
- **Goals:** быстро обрабатывать входящие и вести клиента до записи.
- **Main screens:** Заявки, карточка клиента (CRM), Записи, задачи.
- **Needs to see:** новые лиды, карточка клиента, задачи, следующий шаг, статус записи, действия WhatsApp/звонок.
- **Must NOT see:** технические ID, сырые ответы API, инфраструктурные детали.

### Negis admin / developer (админ платформы)
- **Goals:** следить за платформой, клиниками, подписками и техническим здоровьем.
- **Main screens:** Обзор платформы, Клиники, Подписки, Доходы, Рекламные запуски, Видео-обработка, Usage, System Health, Логи.
- **Needs to see:** клиники, подписки, MRR, usage, статусы Meta launch, video worker jobs, storage health, system health, логи, технические диагностики.
- **Must NOT see (never, even here):** секреты, токены, service role key, app secret, сырые чувствительные логи.

---

## 5. Information architecture

### Client app
- `/ai-control-center` — главный экран после входа (цель будущей задачи; сейчас не строим полностью)
- `/dashboard` — совместимость (остаётся рабочим, не удаляем)
- `/leads` — Заявки
- `/crm` — CRM / карточки клиентов
- `/appointments` — Записи
- `/ads-automation` — Реклама (автозапуск)
- `/ads-automation/history` — История запусков
- `/content-studio` — Контент (AI Контент-студия)
- `/targeting-agent` — редирект на `/ads-automation` (legacy, скрыт из навигации)
- `/analytics` — Аналитика
- `/settings` — Настройки

### Admin app (внутри текущего приложения, без отдельного проекта/поддомена)
- `/admin` — Обзор платформы
- `/admin/clinics` — Клиники
- `/admin/subscriptions` — Подписки
- `/admin/revenue` — Доходы
- `/admin/ads` — Рекламные запуски
- `/admin/video-processing` — Видео-обработка
- `/admin/usage` — Usage
- `/admin/system-health` — System Health
- `/admin/logs` — Логи
- `/admin/settings` — Настройки платформы

> Current state: `/dashboard`, `/ads-automation`, `/ads-automation/history`, `/content-studio`,
> `/admin` exist and work. The `/admin/*` sub-routes and `/ai-control-center`, `/analytics`,
> `/crm`, `/settings` are the target IA — to be built in later design tasks, not now.

---

## 6. Layout rules

- **Desktop sidebar** — левая навигация с брендом Negis OS, разделами клиента, активным состоянием на мятном фоне.
- **Mobile nav** — компактная нижняя/выдвижная навигация; текущее действие всегда видно, без горизонтального скролла.
- **Topbar** — заголовок текущего раздела, переключатель клиники, профиль/выход.
- **Clinic switcher** — выбор активной клиники (для мультиклиник и админа); влияет на весь контекст.
- **Role/mode switcher** — переключение клиент ↔ админ режим; админ-детали доступны только в admin-режиме.
- **Client layout** — чистый, бизнес-ориентированный, минимум технического.
- **Admin layout separation** — админ-разделы отделены (`/admin/*`), технические блоки допустимы, но свёрнуты.
- **Responsive rules** — desktop: sidebar + контент; tablet: сворачиваемый sidebar; mobile: компактная навигация, карточки в один столбец, шаговые формы.

---

## 7. Visual system

- **Background:** светлый (`#F4F7FB` / near-white), без тёмных зон в клиентском режиме.
- **Cards:** белые, скруглённые (radius ~20-28px), мягкая тень, чёткие отступы.
- **Status colors:** мятно-бирюзовый/синий — акцент и primary; **green** — успех; **amber** — предупреждение; **red** — только блокирующие ошибки (минимально); slate/серый — нейтральное.
- **Buttons:** primary — бирюзовый (`#0D9488`); secondary — светлая neu-кнопка; destructive — красный только для необратимых действий.
- **Badges (StatusBadge):** цвет по смыслу — «выключена» (slate/green), «Видео обрабатывается» (amber), «Ошибка» (red), «Готово» (green).
- **Tables:** только в admin (AdminTable) — компактные строки, статус-бейджи, без сырых JSON в клиентском режиме.
- **Forms:** крупные поля, понятные подписи на русском, шаговые формы для сложных действий.
- **Upload areas (UploadCard):** явная зона загрузки, состояние загрузки/готовности, превью, безопасные подсказки.
- **Preview cards (AdPreviewCard):** как будет выглядеть объявление; before/after для фото-креатива.
- **AI recommendation cards (AIRecommendationCard):** заголовок-инсайт + одна понятная кнопка действия.
- **Metric cards (MetricCard):** одна цифра, подпись, динамика; без перегруза.
- **Empty states (EmptyState):** дружелюбный текст + первое действие.
- **Error states (ErrorState):** спокойный тон, что случилось и что делать; red только если действие заблокировано.

---

## 8. Tone of voice

Русский, простой, деловой, не технический. Пишем про результат для клиники, а не про механику.

Замены видимых технических подписей (клиентский режим):

| Технический термин | Видимая подпись |
|---|---|
| Dry run | Тест без создания рекламы |
| PAUSED | выключена |
| publicUrl | публичная ссылка (только в admin-деталях) |
| video_id | Meta video ID (только в admin-деталях) |
| upload failed | Не удалось загрузить файл |
| video_processing | Видео обрабатывается |
| Meta launch failed | Не удалось создать рекламу в Meta |

---

## 9. Client / admin visibility rules

**Client mode:**
- скрывать сырые технические значения;
- скрывать payloads;
- скрывать ID, если они не нужны для действия;
- показывать простые статусы;
- показывать понятный следующий шаг.

**Admin mode:**
- технические детали — только внутри свёрнутых блоков (TechnicalDetails);
- **никогда** не показывать: секреты, токены, service role key, app secret, сырые чувствительные логи.

---

## 10. Component inventory (planned core components)

| Component | Роль |
|---|---|
| AppShell | Каркас приложения (sidebar + topbar + контент) |
| Sidebar | Навигация клиента/админа |
| Topbar | Заголовок раздела, clinic switcher, профиль |
| PageHeader | Заголовок страницы + действия |
| ClinicSwitcher | Переключение активной клиники |
| ModeSwitcher | Клиент ↔ админ режим |
| MetricCard | Одна метрика с подписью и динамикой |
| ActionCard | Карточка с одним действием |
| AIRecommendationCard | AI-инсайт + кнопка действия |
| StatusBadge | Статус по смыслу и цвету |
| Stepper | Шаги сложной формы (запуск рекламы) |
| UploadCard | Загрузка фото/видео с состояниями |
| AdPreviewCard | Превью объявления / креатива |
| ReadinessCard | Готовность креатива к запуску |
| TechnicalDetails | Свёрнутые технические детали (admin) |
| EmptyState | Пустое состояние + первое действие |
| ErrorState | Ошибка спокойным тоном |
| AdminTable | Таблицы админки |
| HealthStatusCard | Статус здоровья сервиса/интеграции |

---

## 11. Mobile rules

- никакого горизонтального переполнения (no horizontal overflow);
- текущее действие всегда видно;
- сводки свёрнуты по умолчанию;
- технические детали свёрнуты;
- крупные зоны нажатия (large tap targets);
- понятный поток загрузки файла;
- шаговые формы для сложных действий (запуск рекламы).

---

## 12. Ads Automation invariants (must not break)

- фото PAUSED launch работает;
- видео MP4/MOV PAUSED launch работает;
- авто-обложка (thumbnail) работает;
- переиспользование video_id работает;
- выбор города работает;
- плейсменты только Instagram работают;
- WhatsApp как назначение работает;
- ACTIVE gated (не включаем);
- тест без создания рекламы отделён от реального запуска;
- технические детали скрыты в клиентском режиме;
- реальные кампании создаются **выключенными**.

---

## 13. Future design roadmap

| Этап | Название | Содержание |
|---|---|---|
| D1 | Design Foundation | Этот документ: идентичность, принципы, роли, визуальная система (текущий этап) |
| D2 | Layout Foundation | AppShell, Sidebar, Topbar, ClinicSwitcher, ModeSwitcher, адаптив |
| D3 | AI Control Center | Главный экран `/ai-control-center`: метрики, AI-рекомендации, действия |
| D4 | Ads Automation alignment | Приведение Ads Automation к дизайн-системе (без изменения логики Meta) |
| D5 | History redesign | Переработка `/ads-automation/history` под дизайн-систему |
| D6 | CRM / Leads | Экраны заявок и карточек клиента |
| D7 | Admin Dashboard | `/admin/*`: обзор платформы, клиники, подписки, доходы, health, логи |
| D8 | Partner / Marketplace | Партнёрский слой и маркетплейс (позже) |
