# WhatsApp Cloud API — входящие лиды без посредника (§14, фаза 2)

Официальный Cloud API от Meta вместо Wazzup: пациент пишет на номер клиники →
Meta присылает вебхук → лид в CRM той клиники, которой принадлежит номер.
Экономика: входящие сообщения и ответы в 24-часовом окне у Meta бесплатны,
абонплаты нет; платны только исходящие по шаблонам вне окна.

Контракт вебхука — из документации Meta (developers.facebook.com:
`/docs/graph-api/webhooks/getting-started`,
`/docs/whatsapp/cloud-api/webhooks/payload-examples`), не из памяти.

## Как устроено

- **Маршрут**: `api/webhooks/whatsapp.ts` → `lib/whatsapp-cloud/webhook.ts`.
  GET — рукопожатие подписки: `hub.challenge` отдаётся только при совпадении
  `hub.verify_token` с `WHATSAPP_VERIFY_TOKEN` (сравнение в константное
  время); иначе 403 без деталей, а без env — 503 fail-closed.
- **Подпись**: каждый POST проверяется по `X-Hub-Signature-256` —
  HMAC-SHA256 от **сырого тела** запроса ключом `WHATSAPP_APP_SECRET`,
  до какого-либо парсинга (`bodyParser` у маршрута выключен ради сырых
  байт). Нет заголовка / не совпал — 401 без деталей. БД недоступна — 503,
  Meta ретраит сама.
- **Ядро общее с Wazzup**: `lib/crm/inbound-whatsapp.ts` — леджер
  идемпотентности → арендатор → дедуп по телефону → воронка → лид. Оба
  адаптера зовут один и тот же код; Wazzup-путь работает как прежде и
  остаётся фолбэком, пока вы сами его не отключите.
- **Арендатор**: только по строке в `whatsapp_cloud_numbers`
  (`migrations/027`): `phone_number_id` из `metadata` вебхука → workspace.
  Payload про клиники не спрашивают. Неизвестный или выключенный номер —
  200-и-игнор, без раскрытия.
- **Идемпотентность**: `whatsapp_cloud_inbound_messages.message_id` (wamid)
  уникален; повторная доставка — no-op.
- **Статусы** (delivered/read) приходят тем же вебхуком — подтверждаются
  без записи.
- **ПД**: телефоны, имена и тексты в логи не попадают — только scope и
  счётчики.

## Запуск (руками владельца — сессия не может ни один из этих шагов)

1. **Применить миграцию 027** в Supabase SQL Editor: вставить содержимое
   `migrations/027_whatsapp_cloud_numbers.sql` целиком и выполнить.
2. **Meta App**: developers.facebook.com → Create App → тип **Business**,
   привязать к вашему Business-портфолио (тому же, где рекламная линия).
   В приложение добавить продукт **WhatsApp**.
3. **Номер**: в WhatsApp → API Setup привязать номер клиники к WABA.
   ⚠️ Перевод номера в WABA **необратим для обычного приложения WhatsApp** на
   этом номере — решение ваше. Для пробы Meta выдаёт тестовый номер, с ним
   можно пройти весь путь до лида, не трогая боевой номер.
4. **Env в Vercel** (Project → Settings → Environment Variables, Production):
   - `WHATSAPP_APP_SECRET` — App Dashboard → App Settings → Basic → App Secret;
   - `WHATSAPP_VERIFY_TOKEN` — придуманная вами длинная случайная строка
     (латиница и цифры, без спецсимволов).
   После добавления — Redeploy. В чат значения не присылать.
5. **Вебхук в панели Meta App**: WhatsApp → Configuration → Webhook:
   - Callback URL: `https://negis-medcall-mvp-api-server.vercel.app/api/webhooks/whatsapp`
   - Verify token: та же строка, что в env.
   - Нажать Verify and save — Meta пошлёт GET, наш сервер ответит challenge.
   - В Webhook fields подписаться на **messages**.
6. **Привязать номер к клинике.** `phone_number_id` виден в WhatsApp →
   API Setup (это длинное число, НЕ сам телефон). В SQL Editor:

   ```sql
   insert into public.whatsapp_cloud_numbers (workspace_id, phone_number_id, enabled)
   values ('9eb6f100-bb6a-4f99-9719-e85c34513a03', '<phone_number_id>', true)
   on conflict (phone_number_id) do nothing;
   ```

7. **Проверка конец-в-конец**: отправить сообщение на номер (для тестового
   номера — с телефона, добавленного в recipients в API Setup) → лид
   появляется на `/leads` с источником WhatsApp → написать сессии
   «отправил» — она подтвердит чтением и закроет гейт фазы 2.

## Диагностика

- Verify and save падает → verify token в панели ≠ `WHATSAPP_VERIFY_TOKEN`
  в Vercel, либо env не в Production, либо не было Redeploy (при пустом env
  сервер отвечает 503 — Meta покажет ошибку).
- Сообщение отправлено, лида нет → читать `whatsapp_cloud_inbound_messages`:
  строка есть, лида нет — падение конвейера после леджера (дефект, чинит
  сессия); строки нет — вебхук не дошёл: проверить подписку на поле
  `messages` и привязку номера (шаг 6) — неизвестный `phone_number_id`
  игнорируется молча, это специально.
- Повторные сообщения того же человека лида не плодят — `kind='repeat'` в
  леджере, как у Wazzup.

## Что дальше (отдельные решения, не делаются молча)

- Исходящие (ответы из CRM, «три касания» §12 вариант B) — тот же App,
  но отдельное слово владельца; согласие пациента закладывается в схему.
- Судьба Wazzup-канала и его триала после PASS фазы 2 — ваше решение;
  код Wazzup-пути остаётся рабочим фолбэком.
