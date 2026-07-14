# Meta Insights Foundation

CRM11a добавил структуру хранения фактических метрик Meta Ads. CRM11b добавляет
ручную admin-синхронизацию через server-only helper для подтверждённого owner/admin. Автоматическая
синхронизация и аналитические коэффициенты на этом этапе не реализованы.

## Текущее состояние

`meta_campaign_launches` хранит созданные через Negis запуски, Meta campaign ID,
статус и плановые бюджеты. Поля `budget_daily_minor` и `budget_total_minor` —
плановый бюджет, а не фактический расход.

Фактический расход в будущем будет поступать только из Meta Insights и
сохраняться отдельно в `meta_campaign_insights.spend_minor`.

## `meta_campaign_insights`

Таблица хранит нормализованные метрики кампании в рамках одного workspace.
Каждая строка связана с `meta_campaign_launches` и содержит snapshot
`meta_campaign_id`, чтобы источник данных можно было проверить без поиска по
названию кампании.

Основные поля:

- `date_start` / `date_stop` — период, к которому относится строка;
- `spend_minor` — фактический расход Meta в минорных единицах;
- `currency` и `currency_exponent` — валюта рекламного аккаунта и точность суммы;
- `impressions`, `reach`, `clicks`, `inline_link_clicks` — метрики показа и переходов;
- `meta_leads` — nullable-счётчик, полученный только из согласованных Meta actions;
- `action_counts` — только будущий allowlist агрегированных типов действий;
- `api_version`, `account_timezone`, `attribution_setting` — контекст расчёта;
- `fetched_at` — когда данные были получены из Meta.

Строки рассчитаны на дневную детализацию Meta Insights с `time_increment=1`.
Уникальность по workspace, launch и датам позволяет безопасно повторять будущую
синхронизацию через upsert без дублирования расхода.

## Семантика метрик

`spend_minor` — actual Meta spend, а `budget_*_minor` — planned budget. Эти
значения нельзя подменять друг другом.

`reach` неаддитивен: дневной охват нельзя суммировать и выдавать за уникальный
охват произвольного периода. Для итогового охвата периода позже потребуется
отдельный запрос Meta за точный диапазон или явно дневное представление.

`meta_leads` не является количеством заявок CRM. Это отдельная Meta
actions-derived metric. Реальные заявки Negis продолжают храниться в `leads` и
связываться с кампанией через `meta_campaign_launch_id`.

Поле `action_counts` в будущем заполняется только утверждённым allowlist типов
действий. Полный массив `actions` и сырой ответ Meta сохранять нельзя.

## `meta_insights_sync_runs`

Журнал синхронизаций нужен, чтобы различать состояния:

- кампания проверена, фактический расход равен нулю;
- кампания ещё не синхронизировалась;
- синхронизация выполняется;
- синхронизация завершилась безопасной ошибкой.

Журнал хранит период, статус, количество upsert-строк и краткую безопасную
ошибку. Сырые ответы Meta не сохраняются. Paging URL не сохраняются. Meta access
token, app secret, payload и URL креативов не записываются ни в одну из таблиц.

## Tenant isolation

Обе таблицы имеют обязательный `workspace_id` и каскадную связь с `workspaces`.
Будущий серверный sync обязан проверять, что launch принадлежит тому же
workspace, и выполнять чтение/upsert только внутри подтверждённой рабочей области.

## Что можно будет показывать безопасно

- фактический расход по кампании и точному диапазону дат;
- оплаченную выручку, вручную связанную с кампанией;
- оплаченную выручку без рекламной атрибуции;
- исходные агрегаты показов, кликов и Meta-reported actions с понятными подписями.

Spend и связанную выручку можно показывать рядом только как независимые факты.
Это не доказывает причинность или эффективность рекламы.

## Что пока не рассчитывается

- CPL;
- ROI;
- ROMI;
- прибыль;
- эффективность или рейтинг кампаний;
- автоматические рекомендации по бюджету или оптимизации.

Коэффициенты нельзя добавлять до подтверждения полноты spend, revenue
attribution, валют и временных диапазонов.

## Следующие этапы

1. Провести production canary ручной синхронизации на одной PAUSED-кампании и периоде 1–3 дня.
2. Добавить read-only UI фактических метрик без коэффициентов.
3. Добавить доступность spend в AI Control Center как отдельный факт, без оценки эффективности.
4. После production-проверки добавить фоновую синхронизацию.
5. Только затем отдельно оценить коэффициенты после проверки покрытия spend и revenue.

## CRM11b: ручная синхронизация

`POST /api/crm/meta-insights-sync` запускает read-only запрос Meta Insights для
одного сохранённого запуска. Endpoint находится в существующем CRM catch-all и
не создаёт отдельную Vercel Function. Доступ разрешён только с валидным
`Authorization: Bearer <Supabase access token>` после server-side проверки
активной роли `owner` или `admin` в запрошенном workspace.

Demo/localStorage-сессия не получает fallback для Insights. Если Supabase,
server auth или Meta token недоступны, endpoint возвращает контролируемую ошибку
и не подставляет тестовые метрики.

Подходящий запуск должен:

- принадлежать подтверждённому workspace;
- иметь реальный числовой `meta_campaign_id`;
- не быть dry-run, `failed` или `video_processing`;
- относиться к настроенному Meta ad account, если оба account ID доступны.

Статус PAUSED разрешён: синхронизация только читает Insights и не изменяет
кампанию, ad set, creative или ad. ACTIVE launch остаётся закрыт существующим
gating и не связан с CRM11b.

## Запрос и пагинация

server-only helper вызывает `GET /{campaign_id}/insights` с полями:

- `date_start`, `date_stop`, `campaign_id`, `account_id`, `account_currency`;
- `spend`, `impressions`, `reach`, `clicks`, `inline_link_clicks`;
- `actions`.

Запрос использует `time_increment=1`, `action_report_time=conversion` и лимит
100 строк на страницу. По умолчанию берутся последние семь account-local дней.
Пользователь может выбрать период до 31 дня включительно; будущие даты
запрещены.

Переход между страницами строится заново по `cursors.after`. Курсор живёт только
в памяти процесса. Лимит — 10 страниц, повторяющийся cursor завершает run
безопасной ошибкой. Paging URL не сохраняются и не логируются.

## Нормализация CRM11b

`spend` преобразуется из decimal string в `spend_minor` строковой целочисленной
арифметикой и `BigInt`, без floating point. Сейчас явно поддерживаются:

- USD, exponent 2;
- KZT, exponent 2.

Неизвестная валюта или лишняя ненулевая точность приводят к
`normalization_failed`, а не к округлению. Дата начала обязана совпадать с датой
окончания для каждой дневной строки. Показы, охват и клики принимаются только как
неотрицательные целые значения.

Из `actions` разрешён только `action_type = lead`. Остальные actions
игнорируются. `action_counts` содержит только allowlist, а `meta_leads` остаётся
`null`, если Meta не вернула lead action. Это Meta-reported action, а не заявка CRM.

## Жизненный цикл run

Подтверждённая синхронизация записывает последовательность:

1. `pending` — журнал создан;
2. `running` — server-side Meta fetch начат;
3. `succeeded` — дневные строки upsert выполнен;
4. `failed` — сохранена только безопасная причина ошибки.

Повторный запуск идемпотентно обновляет строки по
`workspace_id, meta_campaign_launch_id, date_start, date_stop`. Пустой ответ Meta
завершает run как `succeeded` с `rows_upserted = 0`; искусственные нулевые строки
не создаются.

Разрешённые коды ошибок: `meta_auth`, `meta_permission`, `meta_rate_limited`,
`invalid_range`, `launch_not_eligible`, `normalization_failed`,
`persistence_failed`, `sync_timeout`. Сырые ответы Meta не сохраняются. Token,
app secret, paging URL и public URL креативов не возвращаются в API и не
записываются в журнал.

## Защищённое чтение и Admin Center

`GET /api/crm/meta-campaign-insights` возвращает только нормализованные строки
подтверждённому workspace admin. `GET /api/crm/meta-insights-sync-runs`
возвращает безопасные сводки run. Оба endpoint используют ту же server-side
проверку Bearer-сессии и не имеют demo fallback.

В Admin Center раздел «Meta Insights: ручная синхронизация» позволяет выбрать
реальный launch, период и увидеть статус последнего run и `rows_upserted`. Он не
показывает CPL, ROI, ROMI, рейтинги кампаний или рекомендации по бюджету.

## CRM11c: диагностика доступности Insights

Admin Center читает `GET /api/crm/meta-insights-sync-runs` и
`GET /api/crm/meta-campaign-insights` только после server-side подтверждения
роли `owner` или `admin`. Карточка «Meta Insights · диагностика» показывает:

- статус, дату и время последней синхронизации;
- безопасное название кампании и запрошенный период;
- `rows_upserted` последнего run и общее количество доступных дневных строк;
- последний `fetched_at`;
- сумму `spend_minor`, сгруппированную отдельно по каждой валюте.

Суммирование расхода выполняется целочисленно через `BigInt`. Значения разных
валют не складываются между собой. Raw response, paging URL, token, app secret и
скрытые Meta payloads в карточку не передаются.

`succeeded` с `rows_upserted = 0` означает, что запрос и журнал синхронизации
завершились корректно, но Meta не вернула дневные данные за выбранный период.
Это нормально для выключенных или не откручивавшихся кампаний. Искусственные
нулевые строки по-прежнему не создаются.

Фактический `spend` из Meta Insights отличается от планового бюджета кампании:
бюджет задаёт допустимый лимит, а Insights отражает только возвращённый Meta
расход. Расходы Meta также показываются отдельно от выручки CRM. Связь этих
значений ещё не является ROI или доказательством эффективности рекламы.

CRM11c не добавляет CPL, ROI, ROMI, рейтинги кампаний, performance labels или
автоматические рекомендации. Эти расчёты требуют отдельного этапа и проверки
полноты расходов, атрибуции заявок, выручки, валют и периодов.

## После CRM11c

Будущие отдельные этапы:

- background sync по ограниченному расписанию;
- read-only представление исходных spend/impressions/clicks;
- availability-флаг spend в AI Control Center;
- коэффициенты только после отдельного согласования полноты расходов, CRM lead
  attribution, revenue attribution, валют и временных диапазонов.

## CRM11d: read-only Insights в истории рекламы

`GET /api/crm/meta-insights-history` возвращает безопасную агрегированную сводку
для последних серверных запусков рабочего workspace. Endpoint находится в
существующем CRM catch-all, требует Supabase Bearer session и повторно проверяет
на сервере активную роль `owner` или `admin`. Переданный `workspaceId` сам по
себе не даёт доступа.

Связь выполняется только по внутреннему UUID:

`meta_campaign_launches.id = meta_campaign_insights.meta_campaign_launch_id`.

Название кампании, услуга, город и отображаемое имя Meta для join не
используются. `meta_campaign_id` используется только для проверки целостности
связанных строк. Local/demo-запуски исключены: они не получают серверную
Insights-сводку и не подменяются тестовыми данными.

Client mode не получает access token и вообще не вызывает Insights endpoint.
Переключатель интерфейса в admin mode не считается авторизацией: сначала
`/api/crm/auth-context` должен подтвердить `isAdmin = true` для активного
workspace. Сводки не сохраняются в localStorage и не добавляются в записи
истории запусков.

Aggregate DTO содержит статус доступности, последний sync run, покрытый период,
время получения, количество дневных строк, показы, клики, клики по ссылке и
Meta-reported leads. Фактический расход суммируется через `BigInt` отдельно по
каждой паре `currency + currency_exponent`. Разные валюты не объединяются.
Постраничное чтение имеет явный безопасный предел и завершается ошибкой вместо
тихой выдачи неполной суммы.

Фактический расход Meta отличается от планового дневного или общего бюджета.
`impressions`, `clicks` и `inline_link_clicks` складываются по непересекающимся
дневным строкам. `reach` намеренно отсутствует в агрегате: дневной охват нельзя
суммировать и называть уникальным охватом периода. «Лиды по данным Meta» — это
Meta action metric, а не заявки CRM.

История различает состояния: данные доступны, ещё не синхронизированы, Meta
вернула ноль строк, синхронизация выполняется, последняя синхронизация завершена
ошибкой или запуск не подходит для Insights. Ручной запуск синхронизации остаётся
только в Admin Center; в Ads History нет sync-кнопки.

CRM11d не рассчитывает CPL, ROI, ROMI, не сравнивает spend с выручкой, не ставит
оценки эффективности и не формирует рекомендации по бюджету. Launch flow и
создание PAUSED-кампаний Meta не изменяются; ACTIVE launch остаётся закрыт.

## CRM11e.1: scheduler state и completeness foundation

Migration 022 подготавливает состояние будущей фоновой синхронизации, но не
запускает её. В `meta_insights_sync_state` хранится одна scheduler-state строка
на один launch внутри workspace. Она содержит время следующей попытки, последнюю
успешную дату, статус полноты, безопасный код ошибки, счётчик последовательных
ошибок и ограниченную по времени lease. Meta token, worker secret, service-role
key, raw response, paging URL и payload в таблице не хранятся.

Таблица закрыта от ролей `anon` и `authenticated` и предназначена только для
server-side service role. Фоновый worker и cron endpoint в CRM11e.1 не
существуют. Никаких вызовов Meta по расписанию этот этап не делает.

### Атомарный claim и дедупликация

RPC `claim_due_meta_insights_sync_states` выбирает только наступившие,
неприостановленные строки с отсутствующей или истёкшей lease. Выборка использует
`FOR UPDATE SKIP LOCKED`, поэтому два будущих worker-процесса не получают один
launch одновременно. Claim ограничен диапазоном 1–50 строк, поддерживает явный
workspace allowlist, записывает `lease_owner`, `lease_expires_at` и переводит
состояние в `syncing`. Истёкшую lease можно безопасно получить повторно.

В `meta_insights_sync_runs` добавлены `trigger`, `request_key`, `attempt`,
`pages_fetched`, `coverage_complete` и `heartbeat_at`. Уникальный `request_key`
внутри workspace предотвращает повторное выполнение одного scheduler-запроса.
Существующие успешные ручные run получают `coverage_complete = true`: текущая
ручная синхронизация становится успешной только после полной пагинации и
сохранения строк. Её статусы, даты, `rows_upserted` и ошибки не изменяются.

### Модель полноты

Чистый модуль `lib/meta/insightsCompleteness.ts` оценивает полноту только по явно
переданным датам, account timezone, lease, run-диапазонам и freshness SLA. Он не
читает Supabase, Meta API, env или глобальный workspace.

- `never_synced`: подходящий launch ещё не имеет полного успешного run и строк.
- `syncing`: существует активная lease или актуальный run ещё выполняется.
- `zero_delivery`: весь требуемый диапазон подтверждён успешными run с
  `coverage_complete = true`, а Meta вернула ноль строк.
- `partial`: покрыта только часть диапазона, присутствует unknown gap или
  пагинация не была завершена.
- `current`: весь требуемый диапазон покрыт, неизвестных пропусков нет и данные
  укладываются в freshness SLA.
- `stale`: полное покрытие существует, но оно старше freshness SLA.
- `failed`: последняя требуемая попытка завершилась ошибкой, а достаточно свежего
  полного покрытия нет.
- `unavailable`: launch не подходит или server configuration недоступна.

Coverage определяется успешными run-диапазонами, а не только наличием дневных
metric rows. Отсутствие строки внутри успешно и полностью проверенного диапазона
не является unknown gap и не требует искусственной нулевой строки. День вне всех
полных успешных диапазонов остаётся неизвестным. Перекрывающиеся и соседние
диапазоны объединяются детерминированно; account-local границы дат всегда
передаются evaluator явно. Дневной `reach` в оценке полноты не используется и не
агрегируется.

Ручная синхронизация остаётся защищённой подтверждённой ролью `owner`/`admin`.
Будущий worker потребует отдельную server-to-server авторизацию и не будет
доверять demo/localStorage-сессии или одному `workspaceId`. Этот этап не добавляет
CPL, ROI и ROMI, оценки эффективности или рекомендации по бюджету.

## CRM11e.2: фоновый оркестратор синхронизации

CRM11e.2 добавляет защищённый server-to-server фоновый цикл Meta Insights и
отдельный короткоживущий Railway Cron worker. Развёртывание и расписание в этом
этапе не включаются: это canary-инфраструктура с консервативными лимитами.

### HMAC-авторизация worker

Фоновый endpoint `POST /api/crm/meta-insights-background-cycle` живёт в том же CRM
catch-all и **не** создаёт отдельную Vercel Function. Он не принимает user Bearer
и вообще не использует пользовательскую сессию. Единственное доказательство —
подпись HMAC-SHA256, которую проверяет server-only helper `lib/auth/worker.ts`.

Канонический payload: `METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(body)`.
Подпись = `HMAC-SHA256(worker secret, canonical payload)` и сверяется через
`timingSafeEqual`. Заголовки запроса: `x-negis-worker-timestamp`,
`x-negis-worker-nonce`, `x-negis-worker-signature`, `x-negis-worker-request-id`.
Отсутствующие или искажённые заголовки, timestamp вне допустимого окна
(`META_INSIGHTS_WORKER_MAX_CLOCK_SKEW_SECONDS`, по умолчанию 300 секунд) и
неверная подпись отклоняются безопасной ошибкой. Один `workspaceId` никогда не
считается авторизацией. Секрет и подпись никогда не возвращаются и не логируются.

Серверные секреты (`META_INSIGHTS_WORKER_SECRET`,
`META_INSIGHTS_WORKSPACE_ALLOWLIST`) хранятся только на Vercel. Endpoint
пересекает запрошенные `workspaceIds` с серверным allowlist; workspace вне
allowlist просто не обрабатывается.

### Защита от повторов (replay)

`x-negis-worker-request-id` используется как основа `request_key` каждого launch
в цикле (`bg:<requestId>:<launchId>`). Уникальный индекс
`(workspace_id, request_key)` в `meta_insights_sync_runs` гарантирует, что
повторно доставленный цикл не запускает дублирующую синхронизацию: существующий
run возвращается как безопасный `already_processed`, а гонка на вставке
завершается тем же безопасным путём.

### Manual vs background

Один общий внутренний core `syncMetaInsightsForLaunch` обслуживает оба пути, чтобы
не дублировать нормализацию и пагинацию Meta. Ручной путь (`trigger=manual`,
`authMode=user_admin`) сохраняет проверку `requireWorkspaceAdmin` и прежнее
поведение. Фоновый путь (`trigger=background`, `authMode=worker_hmac`) не требует
user Bearer, использует `request_key` цикла и получает лимиты из HMAC-контекста.

### Canary-политика дат

Фоновый цикл читает только завершённые account-local дни: сегодняшний день всегда
исключён, по умолчанию берутся предыдущие 3 завершённых дня. Будущие даты
запрещены, максимум диапазона — 31 день. Таймзона берётся из Meta account context;
при недоступной таймзоне используется резервная `Asia/Almaty`, а полнота помечается
как `partial` (безопасно), потому что границы суток не подтверждены. Полная матрица
жизненного цикла в этом этапе не реализуется.

### Lease и жизненный цикл scheduler-state

Задачи выбираются атомарно через `claim_due_meta_insights_sync_states`
(`FOR UPDATE SKIP LOCKED`), который ставит lease на 120 секунд и переводит
состояние в `syncing`. Concurrency canary — 1: захваченные launch обрабатываются
последовательно, максимум 2 launch за цикл (абсолютный максимум 10, prod default
2).

Перед синхронизацией run фиксирует `heartbeat_at` и обновляет его до и после
Meta fetch. При успехе: дневной upsert, run `succeeded` с `pages_fetched`,
`rows_upserted` и `coverage_complete=true` только после полной пагинации и
сохранения; scheduler-state получает `last_success_at`, `last_complete_date`,
`consecutive_failure_count=0`, очищенный lease, статус полноты из
`insightsCompleteness`, а `next_sync_at` для PAUSED-canary = сейчас + 24 часа.
Пустой ответ Meta — это успешный run с `coverage_complete=true` без искусственных
строк (полнота может быть `zero_delivery`).

При ошибке сохраняется только безопасный код: run `failed`, lease очищается,
`consecutive_failure_count` увеличивается, backoff `next_sync_at` (1-я ошибка
+15 мин, 2-я +1 час, 3+ +6 часов). Повтор `meta_auth`/`meta_permission` дважды
переводит state в паузу `paused_until = сейчас + 6 часов` с безопасным
`pause_reason`. Активный lease никогда не остаётся после обработанного завершения
или ошибки.

### Безопасность и логи

Ответ содержит только безопасную сводку: `success`, `requestId`, `claimed`,
`succeeded`, `failed`, `skipped` и `results` с
`{ metaCampaignLaunchId, runId, status, rowsUpserted, safeErrorCode }`. Логи могут
содержать `requestId`, `workerId`, `workspaceId`, внутренние UUID launch и run,
безопасный статус/код и счётчики. Логи и ответ никогда не содержат worker secret,
HMAC-подпись, Authorization Bearer, service-role key, Meta access token, Meta App
Secret, сырой ответ или тело Meta, `paging.next` и технические URL с токеном.

### Отдельный Railway Cron worker

Пакет `artifacts/meta-insights-worker` (`@workspace/meta-insights-worker`) —
отдельный короткоживущий worker и не связан с `artifacts/video-worker`. Он
подписывает один цикл, делает POST к production catch-all, печатает безопасную
сводку и выходит (код 0 при успехе, ненулевой при ошибке). Polling-цикла нет.
Worker хранит только shared worker secret и **не** содержит `META_ACCESS_TOKEN`,
`META_APP_SECRET` или `SUPABASE_SERVICE_ROLE_KEY`. Переменные окружения и
инструкции по запуску описаны в `artifacts/meta-insights-worker/README.md`.

CRM11e.2 не меняет логику Ads Automation, создание кампаний Meta и gating ACTIVE.
Он не рассчитывает CPL, ROI, ROMI, эффективность или рекомендации по бюджету.
Развёртывание worker и расписание в рамках этого этапа не выполняются.

### Хотфикс: проверка тела HMAC независимо от runtime Vercel

Первый production-прогон вернул `401 worker_unauthorized` на корректно подписанные
запросы. Причина: Vercel-runtime `@vercel/node` может отдать уже разобранный
`req.body` без `req.rawBody`, а прежний код при отсутствии `rawBody` молча
хешировал пустое тело. Сервер хешировал пустую строку, worker — реальный JSON,
подписи не совпадали, и запрос отклонялся общей 401. Канонизация подписи при этом
была верной — проблема только в том, какие байты тела доходили до верификатора.

Исправление делает разрешение сырого тела независимым от runtime:

- Верификатор всегда предпочитает точные сырые байты (`req.rawBody` как Buffer,
  Uint8Array или строка).
- Если сырых байтов нет, но есть разобранный `req.body`, используется
  `JSON.stringify(req.body)`. Это безопасно, потому что worker подписывает ровно
  `JSON.stringify` фиксированного контракта `{ workerId, maxLaunches, workspaceIds? }`
  в этом порядке ключей, и повторная сериализация разобранного объекта даёт те же
  байты. Fallback не обрезает пробелы, не сортирует ключи и не меняет значения —
  любое реальное отличие от подписанных байтов по-прежнему даёт несовпадение хеша
  и корректно отклоняется.
- Worker создаёт JSON-строку тела один раз и использует эту же строку и для HMAC,
  и для `fetch` (без повторного `JSON.stringify`). Порядок ключей — часть
  подписанного контракта.
- Публичный ответ auth остаётся общим (`401 worker_unauthorized`), без причины
  ошибки. Диагностика ведётся только в серверном логе: имя endpoint, безопасный
  код причины (`WorkerAuthError.reason`) и очищенный request id — без секрета,
  подписи, канонического payload, тела, хеша тела, nonce, токенов и Authorization.

Хотфикс не выполнял production canary, не вызывал Meta API, не менял
scheduler-state и не включал расписание Railway Cron. Кампании остаются PAUSED.
