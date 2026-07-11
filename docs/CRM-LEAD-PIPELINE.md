# CRM Lead Pipeline

CRM6 добавляет структурированные этапы и источники заявок в Negis OS. Справочники принадлежат конкретному `workspace_id`, поэтому клиники могут развивать свою воронку без смешивания данных между пространствами.

## Migration

Примените `migrations/019_crm_lead_pipeline_foundation.sql` после migrations 009, 010 и 014. Migration:

- создаёт `lead_stages` и `lead_sources`;
- добавляет в `leads` nullable-поля `stage_id`, `source_id`, `meta_campaign_launch_id`;
- создаёт индексы для workspace-scoped выборок;
- добавляет дефолтные справочники существующим и новым workspace;
- безопасно связывает старые текстовые данные со справочниками.

## Этапы по умолчанию

| Ключ | Название | Semantic group |
| --- | --- | --- |
| `new` | Новая | `new` |
| `in_progress` | В работе | `in_progress` |
| `booked` | Записана | `booked` |
| `lost` | Потеряна | `lost` |

Пользовательские этапы могут иметь собственные названия и порядок, но их `semantic_group` всегда относится к одной из четырёх групп. Это сохраняет стабильные сводные метрики.

## Источники по умолчанию

`Вручную`, `Meta Ads`, `Instagram`, `WhatsApp`, `Сайт`, `Рекомендация`, `Webhook`, `Другое`.

Неизвестные исторические значения не теряются: migration создаёт workspace-scoped источник `legacy_<hash>` с исходным отображаемым названием.

## Совместимость

Поля `leads.status`, `leads.source` и `leads.campaign` остаются в схеме и не переписываются во время backfill. Они служат snapshot-полями для старых клиентов, demo/localStorage и pre-migration данных.

При записи через API используется dual-write:

- `stageId` сохраняется в `stage_id`, а `status` получает `stage_key`;
- `sourceId` сохраняется в `source_id`, а `source` получает название источника;
- `metaCampaignLaunchId` сохраняется только после workspace-проверки, а `campaign` получает точное название запуска.

Строковый create/update без структурированных IDs продолжает работать.

## API

Новые ресурсы обслуживает существующий catch-all `api/crm/[...path].ts`:

- `GET|POST|PATCH /api/crm/lead-stages`
- `GET|POST|PATCH /api/crm/lead-sources`
- `GET|POST|PATCH /api/crm/leads`

Удаление справочников не используется. Для архивации отправляется `PATCH` с `isActive: false`.

Все ссылки на stage, source и Meta campaign launch проверяются по тому же `workspace_id`, что и заявка. Ссылка на объект другой клиники возвращает validation error.

## Backfill и attribution

Статусы нормализуются в четыре semantic-группы. Пустой или неизвестный статус получает этап `new`. Источники сопоставляются с дефолтами по точным известным вариантам, остальные получают legacy-источник.

Campaign attribution намеренно консервативна. `meta_campaign_launch_id` заполняется только при одном точном совпадении в том же workspace по внутреннему ID, реальному Meta campaign ID или уникальному точному имени реального запуска. Неоднозначные значения остаются `null`.

В следующих версиях `meta_campaign_launch_id` станет основой source/campaign attribution, но CRM6 не добавляет предположительные рекламные метрики.

## UI и fallback

`/leads` загружает этапы и источники из API. Если Supabase или migration недоступны, экран использует прежние четыре статуса и свободный текст источника. Legacy/localStorage заявки продолжают отображаться через regex-normalization.

AI Control Center сначала использует `semanticGroup`, затем legacy status fallback. Метрики остаются rule-based, без AI-прогнозов и выдуманной выручки.
