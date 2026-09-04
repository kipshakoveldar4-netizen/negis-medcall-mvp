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
```

Необязательны на этом этапе, но понадобятся для будущего OAuth flow:

```text
TIKTOK_APP_ID=
TIKTOK_APP_SECRET=
```

Все четыре значения серверные. У них не должно быть префикса `VITE_`, их нельзя
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
  TikTok location ID, identity, upload video с получением `video_id`, аудит и
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
фаза начинается с TikTok location resolver, identity и video upload. Реальный
запуск можно добавлять только после проверки прав приложения, audit trail и
явной disabled-first политики; включение нельзя добавлять неявно.
