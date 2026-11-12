import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { readPlatformOwner } from "../auth/platform";

// Рекомендации платформы клиникам (миграция 037).
//
// Единственное, что платформа ПИШЕТ в сторону клиник: совет с заголовком,
// текстом и кнопкой в раздел продукта. Клиника читает свои рекомендации и
// меняет их статус; платформа видит, прочитан ли совет и сделан ли.
//
// Окно «деплой раньше миграции» — известный капкан этого репозитория, и оба
// направления здесь его учитывают. Пока таблицы нет, чтение отвечает
// { items: [], available: false } — то есть ровно прежним поведением продукта
// без рекомендаций, — а запись отказывает честным 503 с именем миграции,
// а не загадочной ошибкой базы. Hosted PostgREST сообщает об отсутствующей
// таблице кодом PGRST205 из кэша схемы, не доходя до Postgres; 42P01 и 42703
// остаются для self-hosted пути. Тот же набор, что в whatsapp-channels.

type JsonRecord = Record<string, unknown>;

const NOT_PROVISIONED_CODES = new Set(["PGRST205", "42P01", "42703"]);
const MIGRATION_HINT = "Примените migrations/037_platform_recommendations.sql";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isNotProvisioned(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  if (NOT_PROVISIONED_CODES.has(readString(error.code))) return true;
  return readString(error.message).toLowerCase().includes("schema cache");
}

function sendJson(res: VercelResponse, status: number, body: JsonRecord) {
  res.status(status).json(body);
}

function rowToApi(row: JsonRecord): JsonRecord {
  return {
    id: readString(row.id),
    workspaceId: readString(row.workspace_id),
    title: readString(row.title),
    body: readString(row.body),
    actionPath: readString(row.action_path),
    signalKey: readString(row.signal_key),
    status: readString(row.status),
    createdAt: readString(row.created_at),
    readAt: readString(row.read_at),
    resolvedAt: readString(row.resolved_at),
  };
}

/**
 * Кнопка рекомендации ведёт только внутрь продукта.
 *
 * Путь, а не URL: внешний адрес в кнопке, по которой владелец клиники кликает
 * не глядя, — это фишинговый примитив, и его не должно существовать по
 * построению. Двойной слэш закрывает protocol-relative обход (//evil.example).
 */
export function isInternalActionPath(value: string): boolean {
  if (value === "") return true;
  // Обратный слэш запрещён отдельно: WHATWG-парсер нормализует «/\evil» в
  // «//evil» — протокол-относительную форму, которую вторая проверка ловит
  // только в прямослэшевом написании.
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("://") && !value.includes("\\");
}

/** Пределы полей. Совет — карточка на экране, а не документ. */
const LIMITS = { title: 200, body: 2000, signalKey: 100, actionPath: 200 } as const;

/** Платформенная сторона: список советов и создание нового. */
export async function handlePlatformRecommendations(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  }

  const method = (req.method || "GET").toUpperCase();

  if (method === "GET") {
    const workspaceId = readString(Array.isArray(req.query.workspaceId) ? req.query.workspaceId[0] : req.query.workspaceId);
    let query = supabase
      .from("platform_recommendations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (workspaceId) {
      if (!UUID_PATTERN.test(workspaceId)) {
        return sendJson(res, 400, { success: false, error: "Нужна клиника", code: "workspace_required" });
      }
      query = query.eq("workspace_id", workspaceId);
    }
    const { data, error } = await query;
    if (error) {
      if (isNotProvisioned(error)) {
        // Таблицы ещё нет — это не «советов нет», и портал обязан различать.
        return sendJson(res, 200, { success: true, data: { items: [], available: false } });
      }
      return sendJson(res, 502, { success: false, error: "Не удалось прочитать рекомендации", code: "unavailable" });
    }
    return sendJson(res, 200, { success: true, data: { items: (data || []).map(asRecord).map(rowToApi), available: true } });
  }

  const body = asRecord(req.body);
  const workspaceId = readString(body.workspaceId);
  const title = readString(body.title);
  const text = readString(body.body);
  const actionPath = readString(body.actionPath);
  const signalKey = readString(body.signalKey);

  if (!UUID_PATTERN.test(workspaceId)) {
    return sendJson(res, 400, { success: false, error: "Нужна клиника", code: "workspace_required" });
  }
  if (!title || !text) {
    return sendJson(res, 400, {
      success: false,
      error: "Нужны заголовок и текст",
      code: "content_required",
      details: ["Пустая рекомендация не несёт совета — заполните оба поля."],
    });
  }
  if (
    title.length > LIMITS.title ||
    text.length > LIMITS.body ||
    signalKey.length > LIMITS.signalKey ||
    actionPath.length > LIMITS.actionPath
  ) {
    return sendJson(res, 400, {
      success: false,
      error: "Слишком длинная рекомендация",
      code: "content_too_long",
      details: [`Заголовок до ${LIMITS.title} символов, текст до ${LIMITS.body}.`],
    });
  }
  if (!isInternalActionPath(actionPath)) {
    return sendJson(res, 400, {
      success: false,
      error: "Кнопка ведёт только внутрь продукта",
      code: "action_path_invalid",
      details: ["Путь раздела начинается со слэша: /staff-schedule, /services…"],
    });
  }

  const owner = readPlatformOwner(req);
  const { data, error } = await supabase
    .from("platform_recommendations")
    .insert({
      workspace_id: workspaceId,
      title,
      body: text,
      action_path: actionPath,
      signal_key: signalKey,
      status: "sent",
      created_by: owner ? owner.email : "",
    })
    .select("*")
    .maybeSingle();

  if (error) {
    if (isNotProvisioned(error)) {
      return sendJson(res, 503, {
        success: false,
        error: "Таблица рекомендаций ещё не применена",
        code: "not_provisioned",
        details: [MIGRATION_HINT],
      });
    }
    return sendJson(res, 502, { success: false, error: "Не удалось сохранить рекомендацию", code: "unavailable", details: [error.message] });
  }

  return sendJson(res, 201, { success: true, data: { item: rowToApi(asRecord(data)) } });
}

/** Разрешённые клинике переходы статуса. «sent» ставит только платформа. */
const CLINIC_STATUSES = new Set(["read", "done", "dismissed"]);

/** Сторона клиники: свои рекомендации и отметки о прочтении и решении. */
export async function handleWorkspaceRecommendations(
  workspaceId: string,
  req: VercelRequest,
  res: VercelResponse,
) {
  const supabase = getSupabaseServerClient();
  if (!supabase || !UUID_PATTERN.test(workspaceId)) {
    // Без базы или без арендатора рекомендаций просто нет — как и раньше.
    return sendJson(res, 200, { success: true, data: { items: [], available: false } });
  }

  const method = (req.method || "GET").toUpperCase();

  if (method === "GET") {
    const { data, error } = await supabase
      .from("platform_recommendations")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      if (isNotProvisioned(error)) {
        return sendJson(res, 200, { success: true, data: { items: [], available: false } });
      }
      return sendJson(res, 502, { success: false, error: "Не удалось прочитать рекомендации", code: "unavailable" });
    }
    return sendJson(res, 200, { success: true, data: { items: (data || []).map(asRecord).map(rowToApi), available: true } });
  }

  const body = asRecord(req.body);
  const id = readString(body.id);
  const status = readString(body.status).toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    return sendJson(res, 400, { success: false, error: "Нужна рекомендация", code: "id_required" });
  }
  if (!CLINIC_STATUSES.has(status)) {
    return sendJson(res, 400, {
      success: false,
      error: "Неизвестный статус",
      code: "status_invalid",
      details: ["Клиника отмечает: read, done или dismissed."],
    });
  }

  const now = new Date().toISOString();
  const patch: JsonRecord = { status, updated_at: now };
  if (status === "read") patch.read_at = now;
  if (status === "done" || status === "dismissed") patch.resolved_at = now;

  let query = supabase
    .from("platform_recommendations")
    .update(patch)
    // Арендатор — обязательный фильтр: id из чужой клиники не должен меняться
    // отсюда даже случайно.
    .eq("workspace_id", workspaceId)
    .eq("id", id);
  // «Прочитана» не затирает «сделана»: прочтение отмечается только у sent.
  // Решение принимается тоже один раз: done и dismissed ставятся только из
  // sent/read — второй клик или гонка не перепишут «сделана» на «скрыта».
  if (status === "read") query = query.eq("status", "sent");
  else query = query.in("status", ["sent", "read"]);

  const { data, error } = await query.select("*").maybeSingle();
  if (error) {
    if (isNotProvisioned(error)) {
      return sendJson(res, 503, {
        success: false,
        error: "Таблица рекомендаций ещё не применена",
        code: "not_provisioned",
        details: [MIGRATION_HINT],
      });
    }
    return sendJson(res, 502, { success: false, error: "Не удалось отметить рекомендацию", code: "unavailable" });
  }
  if (!data) {
    // Идемпотентный повтор и чужой id отвечают одинаково: разница между «уже
    // отмечена» и «такой строки нет» была бы оракулом чужих идентификаторов.
    return sendJson(res, 200, { success: true, data: { item: null } });
  }
  return sendJson(res, 200, { success: true, data: { item: rowToApi(asRecord(data)) } });
}
