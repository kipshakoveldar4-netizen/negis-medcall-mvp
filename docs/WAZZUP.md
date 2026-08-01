# Wazzup: входящие лиды из WhatsApp (фаза 1)

Входящее сообщение в WhatsApp клиники → строка в `leads` того workspace,
которому принадлежит канал → лид виден на `/leads` без правок фронтенда.
Исходящие ответы — фаза 2, здесь их нет.

Контракт взят из официальной документации Wazzup API v3
(wazzup24.com/help/api-en/webhooks/): POST на `webhooksUri` (query string
разрешён), при подписке приходит `{ "test": true }` и ожидается 200, сообщения
приходят массивом `messages[]`, всё кроме 200 ретраится.

## Как устроено

- **Маршрут**: `api/webhooks/wazzup.ts` → `lib/wazzup/webhook.ts`. Только POST.
  Аутентификация — общий секрет `WAZZUP_WEBHOOK_SECRET` из `?secret=` в URL
  вебхука **или** из `Authorization: Bearer`; сравнение в константное время.
  Проверяются оба канала, а не первый попавшийся: Wazzup подставляет
  `Authorization: Bearer <crmKey>`, если у аккаунта вообще есть crmKey, и это
  не наш секрет — обработчик, доверяющий только заголовку, ответил бы 401 на
  верную подписку, причём навсегда (ретраи несут тот же заголовок). Пиннится
  WZ16/WZ17. Провал — 401 без деталей. БД недоступна или секрет не задан —
  503, чтобы Wazzup ретраил, а не терял сообщение.
- **Арендатор**: только по строке в `wazzup_channels` (`migrations/026`).
  Payload про workspace не спрашивают. Неизвестный или выключенный канал —
  200-и-игнор, без раскрытия существующих каналов.
- **Идемпотентность**: `wazzup_inbound_messages.message_id` уникален; повторная
  доставка — no-op.
- **Дедуп (дефолт W3)**: открытый лид (status ≠ `lost`) с тем же телефоном в
  том же workspace не дублируется — фиксируется повторный контакт (строка
  журнала с `kind='repeat'` и ссылкой на лид). Телефоны сравниваются в
  канонической форме (`lib/crm/phone.ts`: `8XXX…` ↔ `+7XXX…`).
- **Новый лид**: `source='whatsapp'` (источник посеян в 019), `status='new'`,
  имя из профиля WhatsApp или телефон, первое сообщение в `notes`.
- **ПД**: телефоны, имена и тексты сообщений не попадают в логи — только
  scope и счётчики.

## Запуск (руками владельца)

1. **Применить миграцию 026** в Supabase SQL Editor: вставить содержимое
   `migrations/026_wazzup_channels.sql` целиком и выполнить.
2. **Env в Vercel** (Project → Settings → Environment Variables, Production):
   `WAZZUP_WEBHOOK_SECRET` — длинная случайная строка; `WAZZUP_API_KEY` — ключ
   из кабинета Wazzup (Настройки → Интеграция через API). В чат не присылать.
   После добавления env — Redeploy.
3. **Привязать канал к клинике.** В кабинете Wazzup взять `channelId`
   WhatsApp-канала (это UUID; виден в разделе каналов / через
   `GET https://api.wazzup24.com/v3/channels` с ключом). Затем в SQL Editor:

   ```sql
   insert into public.wazzup_channels (workspace_id, channel_id, enabled)
   values ('9eb6f100-bb6a-4f99-9719-e85c34513a03', '<channelId>', true);
   ```

4. **Подписать вебхук** (подставить свои значения; выполняется с вашего
   компьютера, ключ в чат не попадает):

   ```bash
   curl -X PATCH https://api.wazzup24.com/v3/webhooks \
     -H "Authorization: Bearer $WAZZUP_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"webhooksUri":"https://negis-medcall-mvp-api-server.vercel.app/api/webhooks/wazzup?secret=ВАШ_WAZZUP_WEBHOOK_SECRET","subscriptions":{"messagesAndStatuses":true}}'
   ```

   Wazzup сразу пошлёт `{ "test": true }`; ответ не-200 значит, что секрет в
   URL не совпал с env или деплой не подхватил переменные.

   Секрет едет в query string, поэтому в нём **не должно быть** `& # + % ? /`
   и пробелов: браузер и curl обрежут URL на первом же таком символе, и
   подписка провалится с `testPostNotPassed` при формально верном секрете.
   Буквы и цифры — безопасно. Если секрет уже содержит такой символ, замените
   env в Vercel и сделайте Redeploy до шага 4.
5. **Проверка конец-в-конец**: отправить сообщение на WhatsApp-номер клиники
   с личного телефона → лид появляется на `/leads` с источником WhatsApp.

## Диагностика

- `401` на тестовый запрос — секрет в URL ≠ `WAZZUP_WEBHOOK_SECRET` в env.
  Частая причина — спецсимвол в секрете, обрезавший URL (см. шаг 4).
- `503` — env не задан или БД недоступна; Wazzup ретраит сам.
- Сообщение пришло, лида нет — канал не привязан или `enabled=false`
  (шаг 3): вебхук отвечает 200 и молча игнорирует неизвестные каналы.
- Повторные сообщения того же человека лида не плодят — см. журнал
  `wazzup_inbound_messages` (`kind='repeat'`).
