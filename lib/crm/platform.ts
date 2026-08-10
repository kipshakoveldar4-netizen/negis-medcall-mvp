import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";

// Панель владельца платформы: подключённые клиники и выручка.
//
// Единственный код в продукте, который читает поперёк арендаторов сознательно
// и широко. Поэтому здесь два ограничения, и оба важнее удобства.
//
// Первое: сюда нельзя попасть по роли. Гейт стоит в маршрутизаторе и опирается
// на список идентификаторов в переменной окружения (lib/auth/platform.ts) —
// роль в базе владелец клиники может назначить себе сам.
//
// Второе: отсюда не уезжает ни одной строки пациента. Ни имени, ни телефона,
// ни диагноза, ни суммы чека конкретного человека. Наружу идёт administrativa:
// название клиники, почта владельца, тариф, сумма подписки и СЧЁТЧИКИ. Разница
// принципиальная: «в клинике 340 клиентов» — сведения о клиенте платформы,
// «Айнур Садыкова, +7 701…» — сведения о пациенте чужой клиники, и второго
// владельцу платформы видеть незачем, даже если технически он может.
//
// Суммы приходят из platform_subscriptions (миграция 034) и нигде не
// вычисляются по догадке: нет строки подписки — в выручке ноль, а не
// правдоподобное число.

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(readString(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendJson(res: VercelResponse, status: number, body: JsonRecord) {
  res.status(status).json(body);
}

/**
 * Годовая подписка, приведённая к месяцу.
 *
 * Складывать месячные и годовые суммы как есть нельзя: клиника на годовом
 * тарифе выглядела бы в двенадцать раз доходнее месячной. Приведение целочисленное
 * и вниз — лишний тиын в выручке платформы никому не нужен.
 */
function monthlyMinor(priceMinor: number, period: string): number {
  if (period === "yearly") return Math.trunc(priceMinor / 12);
  return priceMinor;
}

type ClinicRow = {
  id: string;
  name: string;
  ownerEmail: string;
  createdAt: string;
  plan: string;
  subscriptionStatus: string;
  priceMinor: number;
  currency: string;
  billingPeriod: string;
  monthlyMinor: number;
  staffCount: number;
  leadCount: number;
  appointmentCount: number;
  lastActivityAt: string;
};

/**
 * Счётчик строк без выгрузки самих строк.
 *
 * `head: true` вместе с `count: "exact"` отправляет запрос, который не тащит
 * тело. Это здесь не оптимизация, а часть ограничения: панель платформы должна
 * знать, СКОЛЬКО у клиники заявок, и не должна видеть, КАКИЕ.
 */
async function countRows(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  table: string,
  workspaceId: string,
): Promise<number> {
  if (!supabase) return 0;
  try {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (error) return 0;
    return typeof count === "number" ? count : 0;
  } catch {
    // Таблицы может не быть на этом развёртывании. Ноль честнее падения:
    // панель говорит «нечего показать», а не рушится целиком из-за счётчика.
    return 0;
  }
}

async function handleOverview(res: VercelResponse) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, {
      success: false,
      error: "Хранилище не настроено",
      code: "storage_not_configured",
    });
  }

  const { data: workspaceRows, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, name, owner_email, created_at")
    .order("created_at", { ascending: true });

  if (workspaceError) {
    return sendJson(res, 502, {
      success: false,
      error: "Не удалось прочитать список клиник",
      code: "workspaces_unavailable",
    });
  }

  const workspaces = (workspaceRows || []).map(asRecord);

  // Подписки читаются одним запросом, а не по одной на клинику: клиник может
  // стать много, а вызов панели — один.
  const { data: subscriptionRows } = await supabase
    .from("platform_subscriptions")
    .select("workspace_id, plan, status, price_minor, currency, billing_period, started_at")
    .eq("status", "active");

  const subscriptions = new Map<string, JsonRecord>();
  for (const row of (subscriptionRows || []).map(asRecord)) {
    const key = readString(row.workspace_id);
    if (key) subscriptions.set(key, row);
  }

  const clinics: ClinicRow[] = [];
  for (const workspace of workspaces) {
    const id = readString(workspace.id);
    if (!UUID_PATTERN.test(id)) continue;

    const subscription = subscriptions.get(id) || {};
    const priceMinor = readInteger(subscription.price_minor);
    const billingPeriod = readString(subscription.billing_period) || "monthly";

    const [staffCount, leadCount, appointmentCount] = await Promise.all([
      countRows(supabase, "staff_users", id),
      countRows(supabase, "leads", id),
      countRows(supabase, "appointments", id),
    ]);

    clinics.push({
      id,
      name: readString(workspace.name),
      ownerEmail: readString(workspace.owner_email),
      createdAt: readString(workspace.created_at),
      plan: readString(subscription.plan),
      subscriptionStatus: readString(subscription.status),
      priceMinor,
      currency: readString(subscription.currency) || "KZT",
      billingPeriod,
      monthlyMinor: subscription.plan ? monthlyMinor(priceMinor, billingPeriod) : 0,
      staffCount,
      leadCount,
      appointmentCount,
      lastActivityAt: readString(subscription.started_at),
    });
  }

  const paying = clinics.filter((clinic) => clinic.subscriptionStatus === "active" && clinic.monthlyMinor > 0);
  const currencies = new Set(paying.map((clinic) => clinic.currency));

  return sendJson(res, 200, {
    success: true,
    data: {
      clinics,
      totals: {
        clinics: clinics.length,
        withSubscription: clinics.filter((clinic) => clinic.plan).length,
        paying: paying.length,
        // Валюта одна на всю сумму. Если завтра появится вторая, складывать их
        // нельзя, и панель обязана сказать об этом, а не показать сумму,
        // сложенную из тенге и рублей.
        currency: currencies.size === 1 ? [...currencies][0] : "",
        mixedCurrencies: currencies.size > 1,
        monthlyRevenueMinor: paying.reduce((sum, clinic) => sum + clinic.monthlyMinor, 0),
      },
    },
  });
}

async function handleSubscriptions(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, {
      success: false,
      error: "Хранилище не настроено",
      code: "storage_not_configured",
    });
  }

  const method = (req.method || "GET").toUpperCase();
  const body = asRecord(req.body);

  if (method === "GET") {
    const { data, error } = await supabase
      .from("platform_subscriptions")
      .select("*")
      .order("started_at", { ascending: false });
    if (error) {
      return sendJson(res, 502, { success: false, error: "Не удалось прочитать подписки", code: "unavailable" });
    }
    return sendJson(res, 200, { success: true, data: { items: (data || []).map(asRecord) } });
  }

  const workspaceId = readString(body.workspaceId) || readString(body.workspace_id);
  if (!UUID_PATTERN.test(workspaceId)) {
    return sendJson(res, 400, {
      success: false,
      error: "Нужна клиника",
      code: "workspace_required",
      details: ["Передайте workspaceId существующей клиники."],
    });
  }

  const plan = readString(body.plan).toLowerCase();
  if (!["basic", "standard", "pro"].includes(plan)) {
    return sendJson(res, 400, {
      success: false,
      error: "Неизвестный тариф",
      code: "plan_invalid",
      details: ["Допустимые тарифы: basic, standard, pro."],
    });
  }

  // Цену задаёт владелец, а не код. Значения по умолчанию здесь нет намеренно:
  // подставленная цена на панели читается как настоящая цена продукта.
  const priceMinor = readInteger(body.priceMinor ?? body.price_minor);
  if (priceMinor < 0) {
    return sendJson(res, 400, { success: false, error: "Цена не может быть отрицательной", code: "price_invalid" });
  }

  const billingPeriod = readString(body.billingPeriod ?? body.billing_period) || "monthly";
  if (!["monthly", "yearly"].includes(billingPeriod)) {
    return sendJson(res, 400, { success: false, error: "Период может быть monthly или yearly", code: "period_invalid" });
  }

  const currency = (readString(body.currency) || "KZT").toUpperCase();
  const now = new Date().toISOString();

  if (method === "PATCH") {
    const status = readString(body.status).toLowerCase();
    if (!["active", "paused", "cancelled"].includes(status)) {
      return sendJson(res, 400, { success: false, error: "Неизвестный статус", code: "status_invalid" });
    }
    const { data, error } = await supabase
      .from("platform_subscriptions")
      .update({ status, ended_at: status === "cancelled" ? now : null, updated_at: now })
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .select("*")
      .maybeSingle();
    if (error) {
      return sendJson(res, 502, { success: false, error: "Не удалось изменить подписку", code: "unavailable" });
    }
    if (!data) {
      return sendJson(res, 404, { success: false, error: "Действующей подписки нет", code: "not_found" });
    }
    return sendJson(res, 200, { success: true, data: { item: asRecord(data) } });
  }

  // POST — новая подписка. Прежняя действующая закрывается: частичный
  // уникальный индекс миграции 034 не даст существовать двум сразу, и лучше
  // закрыть её здесь явно, чем получить отказ базы с непонятным текстом.
  await supabase
    .from("platform_subscriptions")
    .update({ status: "cancelled", ended_at: now, updated_at: now })
    .eq("workspace_id", workspaceId)
    .eq("status", "active");

  const { data, error } = await supabase
    .from("platform_subscriptions")
    .insert({
      workspace_id: workspaceId,
      plan,
      status: "active",
      price_minor: priceMinor,
      currency,
      billing_period: billingPeriod,
      started_at: now,
      note: readString(body.note) || null,
    })
    .select("*")
    .maybeSingle();

  if (error) {
    return sendJson(res, 502, { success: false, error: "Не удалось создать подписку", code: "unavailable" });
  }

  return sendJson(res, 201, { success: true, data: { item: asRecord(data) } });
}

export async function handlePlatformOverview(_req: VercelRequest, res: VercelResponse) {
  return handleOverview(res);
}

export async function handlePlatformSubscriptions(req: VercelRequest, res: VercelResponse) {
  return handleSubscriptions(req, res);
}
