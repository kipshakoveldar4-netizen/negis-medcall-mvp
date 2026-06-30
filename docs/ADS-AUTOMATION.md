# Negis Ads Automation

`/ads-automation` теперь работает как русский мастер запуска Meta/Facebook/Instagram Ads для сотрудников клиники.

## Рабочий сценарий

1. Загрузить фото или видео.
2. Заполнить только важные параметры: услуга, город, куда вести заявки, бюджет, даты, оффер, аудитория и ограничения.
3. Нажать `ИИ заполнить рекламу`.
4. Проверить безопасную медицинскую формулировку.
5. Прочитать финальный отчёт перед запуском.
6. Подтвердить запуск и выбрать режим:
   - `Создать в Meta выключенным`;
   - `Запустить рекламу`.

ACTIVE запуск требует ручного подтверждения `ЗАПУСТИТЬ` и включённого live launch в Admin Center.

## Креативы

Поддерживаются:

- фото: JPG, PNG, WEBP до 10 МБ;
- видео: MP4, MOV, WEBM до 100 МБ.

В production используется signed upload flow:

1. Frontend запрашивает `POST /api/crm/ad-creatives/signed-upload`.
2. Backend через `SUPABASE_SERVICE_ROLE_KEY` создаёт signed upload URL/token и возвращает только `storagePath`, `token`, `signedUrl`, `publicUrl`.
3. Frontend загружает файл напрямую в Supabase Storage через `uploadToSignedUrl`.
4. После успешной загрузки metadata сохраняются через `POST /api/crm/ad-creatives`.

Файл не отправляется через Vercel body, а service role key никогда не попадает на frontend. Public bucket даёт чтение, но не требует открывать anonymous upload policy для всех.

Если Supabase env не настроены, страница остаётся в demo preview, но реальный Meta launch потребует публичный URL.

## API

Все новые endpoints работают через существующий catch-all `api/crm/[...path].ts`, чтобы не превышать лимит Vercel Hobby:

- `GET /api/crm/ad-creatives`
- `POST /api/crm/ad-creatives/signed-upload`
- `POST /api/crm/ad-creatives`
- `POST /api/crm/ad-creative-upload` только как legacy local/dev fallback для маленьких файлов
- `POST /api/crm/ad-creative-meta-upload`
- `POST /api/crm/ads-ai-fill`
- `POST /api/crm/meta-launch`
- `POST /api/crm/meta-validate`

Секреты Meta и OpenAI не возвращаются на frontend.

## AI fill

`POST /api/crm/ads-ai-fill` использует `OPENAI_API_KEY`, если он есть. Если ключа нет или OpenAI недоступен, возвращается demo fallback с безопасными медицинскими формулировками.

## История

`/ads-automation/history` показывает историю запусков из `meta_campaign_launches` и локальный fallback для demo workspace.

## Supabase migration

Новая migration:

```text
migrations/015_ad_creative_assets.sql
```

Она создаёт таблицу `ad_creative_assets`, индексы и bucket `ad-creatives`.
