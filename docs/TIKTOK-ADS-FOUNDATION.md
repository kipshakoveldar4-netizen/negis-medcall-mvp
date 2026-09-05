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
- `providerReady` — всегда `false` на этом этапе, пока не реализованы resolver
  upload video с получением `video_id`, аудит и
  live adapter.

Результат не содержит advertiser ID, identity ID, destination URL, creative URL
или credentials. Вместо них в техническом шаблоне используются серверные
placeholders и безопасные boolean-признаки. Mapper чистый: он не использует
`fetch`, не вызывает `/campaign/create/`, `/adgroup/create/` или `/ad/create/`
и ничего не сохраняет.

## Что намеренно не реализовано

- OAuth callback и хранение токена по workspace;
- upload фото или видео в TikTok;
- создание выключенной кампании;
- включение кампании и расход бюджета;
- TikTok Insights и автоматическая оптимизация.

Рабочий Meta flow не использует этот helper и остаётся без изменений. Следующая
фаза начинается с video upload. Реальный
запуск можно добавлять только после проверки прав приложения, audit trail и
явной disabled-first политики; включение нельзя добавлять неявно.

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
может отсутствовать: план снова укажет необходимость проверки. До live adapter
эту проверку нужно будет выполнять заново в том же запросе, что готовит запуск.
Нельзя считать этот кэш разрешением на создание или включение рекламы.
Выключенный статус всех шаблонов и блокировка реального TikTok-запуска сохраняются.

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

Следующие этапы: хранение нескольких OAuth-подключений, video upload с `video_id`,
audit trail и disabled-first live adapter. Ни Meta launch, ни ACTIVE gating,
ни реальные TikTok create/upload endpoints этот шаг не меняет.
