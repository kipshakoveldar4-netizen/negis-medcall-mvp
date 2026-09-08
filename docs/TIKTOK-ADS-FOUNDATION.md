# TikTok Ads foundation

## Текущий объём

Negis OS умеет безопасно проверить, что серверный TikTok access token видит
указанный рекламный аккаунт. Проверка находится в Admin Center на вкладке
«Интеграции» и ничего не запускает.

Сервер использует официальный read-only endpoint TikTok API for Business:

```text
GET https://business-api.tiktok.com/open_api/v1.3/advertiser/info/
```

Документация TikTok:

- [Get ad account details](https://business-api.tiktok.com/gateway/docs/index?doc_id=1739593083610113&identify_key=c0138ffadd90a955c1f0670a56fe348d1d40680b3c89461e09f78ed26785164b&language=ENGLISH)
- [API endpoint catalog](https://business-api.tiktok.com/gateway/docs/index?doc_id=1735713875563521&identify_key=c0138ffadd90a955c1f0670a56fe348d1d40680b3c89461e09f78ed26785164b&language=ENGLISH)

Запрашиваются только безопасные поля: имя аккаунта, валюта, часовой пояс,
статус, тип аккаунта и advertiser ID для проверки совпадения. В браузер полный
advertiser ID не возвращается: видны только последние четыре цифры.

## Переменные окружения

Обязательны для проверки:

```text
TIKTOK_ACCESS_TOKEN=
TIKTOK_ADVERTISER_ID=
TIKTOK_WORKSPACE_ID=
```

Необязательны на этом этапе, но понадобятся для будущего OAuth flow:

```text
TIKTOK_APP_ID=
TIKTOK_APP_SECRET=
```

Все значения серверные. У них не должно быть префикса `VITE_`, их нельзя
сохранять в localStorage, выводить в интерфейс или писать в логи.

## API Negis OS

```text
POST /api/crm/tiktok-validate?workspaceId=<uuid>
Authorization: Bearer <Supabase access token>
```

Маршрут находится в существующем `api/crm/[...path].ts`, поэтому не создаёт
дополнительную Vercel Function. Доступ разрешён только подтверждённым на сервере
ролям `owner` и `admin` текущего workspace:

- без токена — `401`;
- с неверным токеном — `401`;
- с чужим workspace или без административной роли — `403`;
- demo/localStorage session не даёт доступ к проверке.

Результат содержит только безопасную сводку: `configured`, `connected`,
замаскированный ID, имя, валюту, часовой пояс и статус аккаунта. Ошибки TikTok
сводятся к allowlisted кодам и понятным подсказкам. Сырой response, request ID,
token и app secret не возвращаются.

## Campaign dry-run

Admin Center также умеет собрать план TikTok-кампании без вызова provider API:

```text
POST /api/crm/tiktok-dry-run?workspaceId=<uuid>
Authorization: Bearer <Supabase access token>
```

Маршрут использует общий versioned campaign brief и отдельный pure mapper из
`lib/tiktok/campaign.ts`. Он формирует три независимых шаблона по официальному
TikTok API v1.3:

- campaign с целью `TRAFFIC`;
- ad group с дневным бюджетом и placement `PLACEMENT_TIKTOK`;
- video ad с переходом на настроенную ссылку.

У campaign, ad group и creative явно стоит `operation_status: DISABLE`.
TikTok по умолчанию может включать создаваемые объекты, поэтому этот статус не
оставляется неявным даже в шаблоне.

Dry-run разделяет два вида готовности:

- `briefReady` — клиника указала название, услугу, город, текст, бюджет, ссылку,
  время старта и вертикальный video creative;
- `providerReady` — серверная привязка advertiser, точный город, профиль типа
  `CUSTOMIZED_USER`, загруженный и displayable `video_id`, а также операторский
  feature flag подтверждены. По умолчанию флаг выключен, поэтому готовый бриф
  сам по себе ничего не создаёт.

Результат не содержит advertiser ID, identity ID, destination URL, creative URL
или credentials. Вместо них в техническом шаблоне используются серверные
placeholders и безопасные boolean-признаки. Mapper dry-run чистый: он не
использует `fetch`, не вызывает provider create endpoints и ничего не сохраняет.
Отдельный server-only builder формирует точные payload только после повторной
проверки всех зависимостей в live-запросе.

## Что намеренно не реализовано

- OAuth callback и хранение токена по workspace;
- upload фото в TikTok;
- автоматическое включение созданной рекламы;
- включение кампании и расход бюджета;
- TikTok Insights и автоматическая оптимизация.

Рабочий Meta flow не использует этот helper и остаётся без изменений. Первый
TikTok write-flow описан ниже: он поддерживает только заранее загруженное видео
и создаёт объекты исключительно в состоянии `DISABLE`. Включение нельзя добавлять
неявно.

## Проверка города и рекламного профиля

В Admin Center рядом с брифом появилась кнопка «Проверить город и профиль».
Она обращается к `POST /api/crm/tiktok-setup?workspaceId=<uuid>` с `{city}`.
Доступ требует Supabase Bearer и активную роль owner/admin в указанной клинике.
Параметры advertiser/identity и флаги готовности из браузера не принимаются.

Сервер читает официальный TikTok API:

- [Поиск географии](https://business-api.tiktok.com/portal/docs?id=1761236883355649):
  POST `/open_api/v1.3/tool/targeting/search/`, `TRAFFIC`, `WEBSITE`,
  `PLACEMENT_TIKTOK`, `FUZZY_SEARCH`, `geo_types: ["CITY"]`,
  `region_codes: ["KZ"]`.
- [Список профилей](https://business-api.tiktok.com/portal/docs?id=1740218420781057):
  GET `/open_api/v1.3/identity/get/`, фильтр по типу профиля, страницы по 100,
  максимум пять страниц.

Русские и английские названия городов Казахстана сопоставляются через алиасы.
В справочнике нет TikTok ID: принимается только единственный точный результат
с `targeting_type=GEO`, `geo_type=CITY`, `region_code=KZ` и
`status_info.status=ENABLED`. Область, похожее название, неизвестный город,
отключённый тег или неоднозначный ответ оставляют географию неподтверждённой.
Автоматической подстановки страны нет. Идентификаторы Meta не используются.

Дополнительные серверные настройки:

```text
TIKTOK_IDENTITY_ID=
TIKTOK_IDENTITY_TYPE=
TIKTOK_IDENTITY_AUTHORIZED_BC_ID=
```

Тип профиля: `CUSTOMIZED_USER` (прежнее значение по умолчанию), `TT_USER`
или `BC_AUTH_TT`. Для последнего нужен ID Business Center.
Присутствия env недостаточно: настроенный ID должен найтись в списке аккаунта.
Для TT_USER/BC_AUTH_TT также проверяются `AVAILABLE`, `can_push_video=true`,
`is_gpppa=false` и совпадение Business Center, если он используется.
`AUTH_CODE` и создание профиля этим шагом не поддерживаются.

В браузер уходят название города, тип профиля, статусы и время проверки.
Сырые ответы, изображения профиля, advertiser/identity/location ID и credentials
не возвращаются. Ошибки заменяются заранее заданным текстом. Redirect запрещён;
общий таймаут чтения, включая тело ответа, не более 12 секунд.

Подтверждение хранится в памяти серверного процесса до пяти минут (неполное
подтверждение и ошибки: 30 секунд). Ключ включает workspace, город и отпечаток
настроек аккаунта/токена/профиля. Совпадающие одновременные запросы объединяются,
кэш ограничен 100 записями. localStorage и база не используются.
Это не постоянное подтверждение города/identity. Credentials пока серверные,
а advertiser закрепляется за одной клиникой через отдельную привязку ниже.
Для нескольких рекламодателей понадобится отдельное OAuth-хранилище credentials.

Сухой прогон сам не обращается к TikTok. Он использует только неистёкшее
серверное подтверждение; смена города/клиники/токена/профиля его аннулирует.
При холодном старте или обработке другим экземпляром Vercel подтверждение
может отсутствовать: план снова укажет необходимость проверки. Live adapter
принудительно повторяет provider-проверку города и identity в самом запросе запуска.
Кэш не считается разрешением на создание или включение рекламы.

Проверки: `pnpm run test:tiktok-setup`, существующий dry-run test, tenant
isolation, route smoke и mobile. Запросы провайдера в тестах подменены;
успех тестов не подтверждает доступность конкретного production advertiser.

## Привязка рекламного аккаунта к клинике

Следующий завершённый шаг — постоянная связь workspace с advertiser, не upload
и не запуск. Таблица `tiktok_ad_account_connections` добавляется миграцией
`047_tiktok_ad_account_connections.sql`. Миграция подготовлена в репозитории;
её наличие не означает, что она уже применена к production.

### Подключение оператором и администратором

1. Оператор применяет миграцию 047 в том же Supabase-проекте, что используется
   CRM, и задаёт серверные `TIKTOK_WORKSPACE_ID`, `TIKTOK_ADVERTISER_ID` и
   `TIKTOK_ACCESS_TOKEN`. Workspace берётся из подтверждённого auth-context,
   а не из demo/localStorage. Значения ключей в документацию и скриншоты не копируются.
2. Подтверждённый owner/admin этой клиники открывает Admin Center → Интеграции →
   TikTok → «Рекламный аккаунт клиники».
3. «Подключить аккаунт к клинике» вызывает
   `POST /api/crm/tiktok-connection?workspaceId=<uuid>` с `{confirm:true}`.
   Сервер проверяет точный advertiser через прежний read-only TikTok endpoint
   и сохраняет только связь, валюту, часовой пояс и время проверки.
4. `GET /api/crm/tiktok-connection?workspaceId=<uuid>` читает сохранённую сводку
   без обращения к TikTok. Повторный POST обновляет проверку того же аккаунта.

GET и POST требуют Supabase Bearer и роль owner/admin. Дополнительно каждый
TikTok handler проверяет серверное назначение workspace. Владение другой клиникой
не даёт право использовать общий аккаунт, даже если передать его ID в body.
Нет назначения → безопасный 503; чужое назначение → 403; demo fallback отсутствует.
Это намеренно более строгий контракт, чем у первоначальной диагностики:
до настройки `TIKTOK_WORKSPACE_ID` TikTok-проверки заблокированы.

### Сохранение и отзыв

Один workspace имеет одну привязку; один advertiser может принадлежать только
одному workspace. Upsert использует пару `workspace_id,advertiser_id`, а отдельные
уникальные ограничения не позволяют переназначить любую из сторон, в том числе
при одновременных запросах. Перенос или смена аккаунта требуют оператора, API
автоматически этого не делает. Ошибка сохранения не выдаётся за успех.

Оператор может выставить `enabled=false` в строке своей клиники. POST не включает
отключённую строку обратно. В интерфейсе нет кнопки удаления или переноса.
Таблица закрыта для `anon` и `authenticated`: RLS включён, публичных политик нет,
доступ явно предоставлен только `service_role`. Фильтр workspace обязателен
даже для серверного клиента, обходящего RLS.

В БД нет access token, app secret, raw response или media URL. Browser DTO
содержит только статус, валюту, часовой пояс, дату и последние четыре цифры ID.
Сводка не кэшируется в localStorage; ответ API имеет `Cache-Control: no-store`.
Смена клиники/выход отменяют ожидающие ответы в компоненте.

Подтверждение аккаунта считается свежим 24 часа. После этого связь остаётся
сохранённой, но нужно повторить проверку. Несовпадение env advertiser с записью,
отключённая запись, недоступная БД или отсутствующая миграция не разрешают setup.
Dry-run остаётся без provider calls: проверяет привязку в БД и использует короткое
подтверждение города/identity только при действующей связи. Чистый mapper по-прежнему
можно тестировать без базы. Сохранённая привязка НЕ является разрешением на расход:
будущий upload/live adapter обязан заново проверить provider access в своём запросе.

### Проверки и ограничения

`pnpm run test:tiktok-connections`: исполняемые тесты provisioning, сохранения,
истечения проверки, отзыва, конфликтов конфигурации и безопасных ошибок;
структурные проверки SQL ограничений и grants. Tenant-isolation suite вызывает
реальный catch-all с подменённой авторизацией: 401/403 и безопасный 200 проверены.
SQL-ограничения необходимо дополнительно проверить после применения миграции;
локальные source checks не являются production DB gate.

Этап привязки не менял Meta launch или ACTIVE gating. Передача видео и первый
строго выключенный запуск описаны ниже.

## Передача видео в рекламную библиотеку TikTok

Реализован отдельный opt-in upload, а не запуск рекламы. Требуются миграции
047, `048_tiktok_video_uploads.sql` и `049_tiktok_video_readiness.sql`, серверная привязка workspace, действующий
owner/admin Bearer и `TIKTOK_VIDEO_UPLOAD_ENABLED=true`. По умолчанию флаг false.
Наличие миграций в git не означает их применение в production.

В Admin Center → Интеграции → TikTok выбирается один из последних 40 роликов
своей клиники. GET `/api/crm/tiktok-videos?workspaceId=<uuid>` возвращает только
названия/внутренние asset UUID и причины недоступности. GET с `assetId` читает
журнал без provider call. POST с `{assetId,confirm:true}` передаёт выбранный ролик
в TikTok после явного подтверждения. Для известного отказа возможен отдельный
POST с `retry:true`, максимум три попытки на версию файла. Ни один ответ не
содержит `video_id`, public URL, advertiser ID, токен или сырой provider response.

### Проверка и передача файла

- Поддерживаются готовые публичные MP4/MOV до 10 MiB. Больший файл нужно уменьшить;
  существующий worker не перенастраивается и не гарантирует выход меньше 10 MiB.
  Это ограниченный URL-upload этап, не multipart/resumable pipeline для больших видео.
- Сервер читает `ad_creative_assets` с обязательным workspace-фильтром. URL из body
  или редактируемого `public_url` не используется. Адрес собирается из серверного
  `SUPABASE_URL` и собственного workspace storage path; только `ad-creatives`,
  включая `optimized/<workspace>/...`. Private raw bucket, traversal, внешние
  домены и redirects запрещены. Этот этап поддерживает стандартный `*.supabase.co`.
- HEAD без credentials проверяет реальный Content-Type, Content-Length и сильный
  ETag. Размер из таблицы сам по себе не разрешает передачу. Отпечаток path/ETag/
  размера/типа хранится вместо URL. Таймаут HEAD 5 секунд.
- Каждая подтверждённая передача заново читает доступ к advertiser у TikTok;
  сохранённое 24-часовое подтверждение не заменяет эту проверку.
- POST `/open_api/v1.3/file/video/ad/upload/` использует JSON `UPLOAD_BY_URL`,
  `video_url` и уникальное имя из UUID записи передачи. Access-Token отправляется
  только на фиксированный TikTok host. SmartFix/pre-review отключены явно.
  Таймаут 12 секунд включает чтение body. В существующей CRM функции Vercel
  выставлен предел 60 секунд; новая serverless function не добавляется.

Основание: [TikTok Business API: Upload a video](https://business-api.tiktok.com/portal/docs?id=1737587322856449).
Документация рекомендует URL-upload для файлов до 10 МБ. Ответ может содержать
только video_id: метаданные появляются позже. Поэтому «Видео передано в TikTok»
не означает прохождение модерации или готовность рекламы к показу.

### Проверка обработки и готовности

После передачи администратор вручную нажимает «Проверить готовность в TikTok».
Существующий POST `/api/crm/tiktok-videos` с действием `check_readiness` заново
проверяет доступ к advertiser и выполняет только read-only GET
`/open_api/v1.3/file/video/ad/info/`. Обычный GET журнала внешнего вызова не делает,
а проверка никогда не повторяет upload.

Сервер принимает только запись с точным внутренним `video_id`. `displayable=true`
вместе с `PLACEMENT_TIKTOK` означает `ready`; отсутствие свежего ролика или неполные
метаданные означает `processing`; явный запрет показа или отсутствие TikTok placement
означает `not_displayable`. Сетевой/неопределённый ответ сохраняется как `unknown`,
но не превращается в автоматический повтор загрузки.

Миграция 049 добавляет только безопасные поля результата и время проверки. Временные
`preview_url`/`video_cover_url`, provider response, токен и advertiser ID не выдаются
в браузер и не добавляются в эту часть журнала. UI показывает человеку понятный
статус; `readyForAd` не включает запуск: `launchEnabled=false` остаётся неизменным.

Основание: [TikTok Business API: Get video information](https://ads.tiktok.com/gateway/docs/index?doc_id=1740050161973250&identify_key=c0138ffadd90a955c1f0670a56fe348d1d40680b3c89461e09f78ed26785164b&language=ENGLISH).

### Журнал и защита от повторов

Таблица `tiktok_video_uploads` закрыта для anon/authenticated, RLS включён.
Только сервер хранит workspace, advertiser, asset, отпечаток, версию, время,
число попыток, безопасный error_code и полученный video_id. Meta video_id и
изменяемая metadata файла не используются для этих данных.

Перед provider POST вставляется уникальная запись по workspace/advertiser/asset/
fingerprint. Одновременные клики не получают два разрешения на upload. Повтор
известного отказа использует compare-and-swap по status и attempt. При таймауте,
потере связи, невалидном success body или ошибке сохранения статус `unknown`
блокирует автоматический повтор. Зависший `uploading` через две минуты показывается
как unknown, а не переисполняется. Проверка библиотеки и согласование неопределённого
результата пока выполняются оператором; кнопки «повторить всё равно» нет.

Dry-run может принять `videoAssetId`, но подтверждает его только по серверной
записи этой клиники, advertiser и текущей версии файла. При изменении metadata
повторный HEAD может подтвердить прежний fingerprint без повторного provider upload.
Сам dry-run не вызывает TikTok и показывает placeholder вместо `video_id`.
Он может подтвердить `providerReady` только по серверным данным, а
`launchEnabled` зависит от отдельного server-only feature flag. Все шаблоны
по-прежнему используют только `DISABLE`.

### Проверки и production gate

`pnpm run test:tiktok-video-upload` исполняет provider/service тесты: MP4/MOV,
проверку actual size, чужие пути, запрет redirects, таймаут body, безопасные ответы,
одновременные клики, ограниченные retry, потерю persistence и устаревшую версию.
Tenant-isolation тестирует реальный router с подменённой авторизацией. SQL/RLS
проверки локально структурные: они не доказывают применение миграции или работу
Postgres CAS в production. Необходимо применить 048, проверить права и duplicate
claim в БД, затем вручную передать один согласованный небольшой ролик.
`pnpm run test:tiktok-video-readiness` проверяет fixed-host GET, точный ID,
displayability/placement, безопасные ошибки, отсутствие повторного upload и границу
disabled-first. Во время разработки реальные файлы в TikTok не передавались,
production флаг не включался и рекламные кампании не создавались.

## Первый disabled-only запуск кампании

Миграция `050_tiktok_disabled_campaign_launches.sql` добавляет серверный журнал
первого write-flow. Наличие миграции в репозитории не означает, что она применена
к production. До отдельного canary значение должно оставаться таким:

```text
TIKTOK_DISABLED_LAUNCH_ENABLED=false
```

После применения миграции подтверждённый owner/admin может использовать уже
существующий catch-all маршрут:

```text
POST /api/crm/tiktok-launch?workspaceId=<uuid>
Authorization: Bearer <Supabase access token>
```

Запрос требует точного `TIKTOK_WORKSPACE_ID`, явного подтверждения словом
`СОЗДАТЬ`, UUID idempotency key и выбранного видео этой клиники. Сервер заново:

1. проверяет advertiser и сохранённую привязку workspace;
2. проверяет валюту рекламного аккаунта и бюджета;
3. читает город и профиль непосредственно у TikTok, не полагаясь на старый кэш;
4. подтверждает текущую версию видео, `displayable=true` и TikTok placement;
5. разрешает первый поток только для `CUSTOMIZED_USER` и server-only `video_id`.

До первого provider POST журнал атомарно фиксирует idempotency key. Затем адаптер
последовательно вызывает `/campaign/create/`, `/adgroup/create/` и `/ad/create/`.
Campaign, ad group и creative каждый явно содержат `operation_status: DISABLE`.
Цель — `TRAFFIC`, campaign budget optimization выключена, дневной бюджет находится
на уровне ad group, placement ограничен TikTok. Маршрута или payload для `ENABLE`
и `ACTIVE` нет.

После каждого шага сервер сохраняет прогресс. Известный отказ получает безопасный
allowlisted error code. Таймаут, ответ без подтверждённого ID или потеря результата
становятся `unknown`: повтор с тем же ключом не вызывает TikTok снова, чтобы не
создать дубликат. Автоматического retry и кнопки «повторить всё равно» нет.

В таблице нет destination URL, access token, app secret, provider payload или raw
response. Сохраняется SHA-256 отпечаток назначения; TikTok IDs остаются только в
закрытом server-side журнале. Browser DTO сообщает человеку итог и boolean-статусы
создания, но не возвращает advertiser/campaign/ad group/ad/video/identity IDs.
Demo fallback отсутствует.

Admin Center сначала строит безопасный dry-run. Блок «Безопасный запуск» становится
доступен только при включённом feature flag и полной provider readiness. Основной
текст говорит «Создать выключенной»; техническое `DISABLE` не выдаётся за начало
показа. Production canary в рамках разработки намеренно не выполнялся.

Проверки: `pnpm run test:tiktok-disabled-launch` покрывает чистый payload builder,
трёхшаговый переход состояний, отсутствие campaign-level бюджета, идемпотентность,
блокировку неопределённого результата, feature flag, подтверждение, валюту,
готовность видео и SQL/RLS границы. Тест использует только mocks и не обращается к
TikTok.
