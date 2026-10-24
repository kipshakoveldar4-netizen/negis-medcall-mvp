import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { readPlatformOwner } from "../auth/platform";
import { computeClinicSignals, type ClinicFacts } from "./clinic-signals";
import { invitationStatus } from "./staff-invitations";
import { readVertical, VERTICAL_SETTINGS_KEY } from "../vertical/terms";
import { getContentUsageSummary } from "../content-studio/usage";

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
  res.setHeader("Cache-Control", "private, no-store");
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
  subscriptionId: string;
  priceMinor: number;
  currency: string;
  billingPeriod: string;
  monthlyMinor: number;
  staffCount: number | null;
  leadCount: number | null;
  appointmentCount: number | null;
  lastActivityAt: string;
  // Состояние владельца: inside | pending | accepted_no_member | expired |
  // none; null — не смог прочитать (и это не «none»). Застрявший онбординг
  // должен быть виден со списка, а не после обхода карточек по одной.
  ownerAccess: { state: "inside" | "pending" | "accepted_no_member" | "expired" | "none"; expiresAt: string } | null;
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
): Promise<number | null> {
  if (!supabase) return null;
  try {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (error) return null;
    return typeof count === "number" ? count : null;
  } catch {
    // null, а не 0. «В клинике ноль заявок» и «не смог посчитать заявки» —
    // разные новости, и панель обязана их различать: ноль от сбоя выглядит
    // как мёртвая клиника, и владелец сделает по нему вывод.
    return null;
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
  const { data: subscriptionRows, error: subscriptionError } = await supabase
    .from("platform_subscriptions")
    .select("id, workspace_id, plan, status, price_minor, currency, billing_period, started_at")
    .eq("status", "active");

  // Отказ чтения подписок молча давал «выручка 0 ₸» — число, по которому
  // владелец сделал бы вывод о своём же бизнесе. Не прочитали — так и говорим.
  if (subscriptionError) {
    return sendJson(res, 502, {
      success: false,
      error: "Не удалось прочитать подписки",
      code: "subscriptions_unavailable",
      details: ["Список клиник прочитан, но выручку по нему считать нельзя."],
    });
  }

  const subscriptions = new Map<string, JsonRecord>();
  for (const row of (subscriptionRows || []).map(asRecord)) {
    const key = readString(row.workspace_id);
    if (key) subscriptions.set(key, row);
  }

  // Счётчики всех клиник считаются одной волной, а не по клинике за раз.
  // Прежний цикл ждал три запроса на каждую клинику последовательно: при
  // пятидесяти клиниках это пятьдесят волн, и панель открывалась минутами.
  type ClinicCounts = {
    id: string;
    staffCount: number | null;
    leadCount: number | null;
    appointmentCount: number | null;
  };

  const known: JsonRecord[] = workspaces.filter((workspace: JsonRecord) => UUID_PATTERN.test(readString(workspace.id)));
  const counts: ClinicCounts[] = await Promise.all(
    known.map(async (workspace: JsonRecord): Promise<ClinicCounts> => {
      const id = readString(workspace.id);
      const [staffCount, leadCount, appointmentCount] = await Promise.all([
        countRows(supabase, "staff_users", id),
        countRows(supabase, "leads", id),
        countRows(supabase, "appointments", id),
      ]);
      return { id, staffCount, leadCount, appointmentCount };
    }),
  );
  const countsById = new Map<string, ClinicCounts>(counts.map((entry: ClinicCounts) => [entry.id, entry]));

  // Владельцы и их приглашения — двумя запросами на весь список, не по
  // клинике за раз. Сбой чтения даёт null («не смог посчитать»), не «none».
  // Отозванные приглашения отфильтрованы: только они копятся неограниченно
  // (каждый перевыпуск добавляет строку), а PostgREST молча режет выборку на
  // тысяче строк — и клиники из отброшенного хвоста получали бы ложный чип.
  const [ownerRowsResult, ownerInvitationsResult] = await Promise.all([
    supabase.from("staff_users").select("workspace_id").eq("role", "owner").order("created_at", { ascending: false }),
    supabase
      .from("staff_invitations")
      .select("workspace_id, accepted_at, revoked_at, expires_at")
      .eq("role", "owner")
      .is("revoked_at", null)
      .order("created_at", { ascending: false }),
  ]);
  const ownersReadable = !ownerRowsResult.error && Array.isArray(ownerRowsResult.data);
  const invitationsReadable = !ownerInvitationsResult.error && Array.isArray(ownerInvitationsResult.data);
  const ownersInside = new Set<string>();
  if (ownersReadable) {
    for (const row of ownerRowsResult.data || []) {
      const key = readString(asRecord(row).workspace_id);
      if (key) ownersInside.add(key);
    }
  }
  const invitationsByWorkspace = new Map<string, Array<{ status: string; expiresAt: string }>>();
  if (invitationsReadable) {
    for (const row of ownerInvitationsResult.data || []) {
      const record = asRecord(row);
      const key = readString(record.workspace_id);
      if (!key) continue;
      const list = invitationsByWorkspace.get(key) || [];
      list.push({
        status: invitationStatus({
          accepted_at: readString(record.accepted_at) || null,
          revoked_at: readString(record.revoked_at) || null,
          expires_at: readString(record.expires_at),
        }),
        expiresAt: readString(record.expires_at),
      });
      invitationsByWorkspace.set(key, list);
    }
  }
  function ownerAccessFor(id: string): ClinicRow["ownerAccess"] {
    if (!ownersReadable || !invitationsReadable) return null;
    if (ownersInside.has(id)) return { state: "inside", expiresAt: "" };
    const invitations = invitationsByWorkspace.get(id) || [];
    const pending = invitations.filter((invitation) => invitation.status === "pending");
    if (pending.length > 0) {
      return { state: "pending", expiresAt: pending.map((invitation) => invitation.expiresAt).sort().pop() || "" };
    }
    // «Принято, но владельца внутри нет» — сломанное состояние, а не «не
    // приглашён»: приглашение погашено, membership не появился/удалён.
    if (invitations.some((invitation) => invitation.status === "accepted")) {
      return { state: "accepted_no_member", expiresAt: "" };
    }
    const expired = invitations.filter((invitation) => invitation.status === "expired");
    if (expired.length > 0) {
      return { state: "expired", expiresAt: expired.map((invitation) => invitation.expiresAt).sort().pop() || "" };
    }
    return { state: "none", expiresAt: "" };
  }

  const clinics: ClinicRow[] = [];
  for (const workspace of known) {
    const id = readString(workspace.id);
    const subscription = subscriptions.get(id) || {};
    const priceMinor = readInteger(subscription.price_minor);
    const billingPeriod = readString(subscription.billing_period) || "monthly";
    const counted: ClinicCounts = countsById.get(id) || { id, staffCount: null, leadCount: null, appointmentCount: null };

    clinics.push({
      id,
      name: readString(workspace.name),
      ownerEmail: readString(workspace.owner_email),
      createdAt: readString(workspace.created_at),
      plan: readString(subscription.plan),
      subscriptionStatus: readString(subscription.status),
      subscriptionId: readString(subscription.id),
      priceMinor,
      currency: readString(subscription.currency) || "KZT",
      billingPeriod,
      monthlyMinor: subscription.plan ? monthlyMinor(priceMinor, billingPeriod) : 0,
      staffCount: counted.staffCount,
      leadCount: counted.leadCount,
      appointmentCount: counted.appointmentCount,
      lastActivityAt: readString(subscription.started_at),
      ownerAccess: ownerAccessFor(id),
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

function validSubscriptionTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts.map((part) => Number(part ?? 0));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days
    && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

type SubscriptionOperationScope = { actorId: string; requestKey: string; workspaceId: string; kind?: "replace" | "status"; payload?: JsonRecord };

function subscriptionItem(value: unknown, workspaceId?: string): JsonRecord | null {
  const row = asRecord(value);
  if (!UUID_PATTERN.test(readString(row.id)) || !UUID_PATTERN.test(readString(row.workspace_id))
    || (workspaceId && readString(row.workspace_id).toLowerCase() !== workspaceId.toLowerCase())
    || !["basic", "standard", "pro"].includes(row.plan as string) || !["active", "paused", "cancelled"].includes(row.status as string)
    || typeof row.price_minor !== "number" || !Number.isSafeInteger(row.price_minor) || row.price_minor < 0
    || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)
    || !["monthly", "yearly"].includes(row.billing_period as string)
    || !validSubscriptionTimestamp(row.started_at) || !validSubscriptionTimestamp(row.updated_at)
    || (row.ended_at !== null && !validSubscriptionTimestamp(row.ended_at))
    || (row.created_at !== null && !validSubscriptionTimestamp(row.created_at))
    || (row.note !== null && (typeof row.note !== "string" || row.note.length > 2000))) return null;
  const item: JsonRecord = {};
  for (const key of ["id", "workspace_id", "plan", "status", "price_minor", "currency", "billing_period",
    "started_at", "ended_at", "note", "created_at", "updated_at"]) item[key] = row[key];
  return item;
}

function subscriptionOperationData(value: unknown, scope: SubscriptionOperationScope, committedOnly = false): JsonRecord {
  const receipt = asRecord(value);
  if (readString(receipt.actorId).toLowerCase() !== scope.actorId.toLowerCase()
    || readString(receipt.requestKey).toLowerCase() !== scope.requestKey.toLowerCase()
    || readString(receipt.workspaceId).toLowerCase() !== scope.workspaceId.toLowerCase()
    || typeof receipt.replayed !== "boolean" || (receipt.state !== "committed" && receipt.state !== "abandoned")) {
    throw new Error("subscription_transition_unconfirmed");
  }
  const operation = { actorId: scope.actorId, requestKey: scope.requestKey, workspaceId: scope.workspaceId,
    kind: receipt.kind, state: receipt.state, replayed: receipt.replayed };
  if (receipt.state === "abandoned") {
    if (committedOnly || receipt.kind !== null || receipt.item !== null) throw new Error("subscription_transition_unconfirmed");
    return { item: null, operation };
  }
  if (typeof receipt.state !== "string" || typeof receipt.kind !== "string" || !["replace", "status"].includes(receipt.kind)
    || (scope.kind && receipt.kind !== scope.kind)) throw new Error("subscription_transition_unconfirmed");
  const row = subscriptionItem(receipt.item, scope.workspaceId);
  if (!row) throw new Error("subscription_transition_unconfirmed");
  if (scope.payload && scope.kind === "replace" && (row.plan !== scope.payload.plan || row.price_minor !== scope.payload.priceMinor
    || row.currency !== scope.payload.currency || row.billing_period !== scope.payload.billingPeriod || row.status !== "active"
    || row.ended_at !== null || row.note !== (scope.payload.note ?? null)
    || readString(row.id).toLowerCase() === scope.payload.expectedActiveId)) throw new Error("subscription_transition_unconfirmed");
  if (scope.payload && scope.kind === "status" && (readString(row.id).toLowerCase() !== scope.payload.subscriptionId
    || row.status !== scope.payload.status)) throw new Error("subscription_transition_unconfirmed");
  return { item: row, operation };
}

function subscriptionOperationFailure(res: VercelResponse, error: unknown) {
  const code = readString(asRecord(error).code);
  const known: Record<string, [number, string, string]> = {
    P8403: [400, "subscription_operation_invalid", "Некорректные параметры запроса подписки"],
    P8404: [409, "subscription_conflict", "Подписка изменилась. Обновите её перед новым действием."],
    P8407: [409, "subscription_request_conflict", "Этот запрос уже использован с другими параметрами."],
    P8409: [409, "subscription_request_abandoned", "Этот запрос закрыт. Повторное назначение по нему запрещено."],
  };
  const refusal = Object.hasOwn(known, code) ? known[code] : undefined;
  if (refusal) return sendJson(res, refusal[0], { success: false, code: refusal[1], error: refusal[2] });
  const migrationMissing = code === "PGRST202" || code === "42883";
  return sendJson(res, migrationMissing ? 503 : 502, { success: false,
    code: migrationMissing ? "subscription_transition_unavailable" : "subscription_transition_unconfirmed",
    error: migrationMissing ? "Операции подписок временно недоступны" : "Результат сохранения не подтверждён. Проверьте тот же запрос." });
}

async function handleSubscriptions(req: VercelRequest, res: VercelResponse) {
  const owner = readPlatformOwner(req);
  if (!owner || !UUID_PATTERN.test(owner.userId)) return sendJson(res, 404, { success: false, code: "not_found", error: "Не найдено" });
  const method = (req.method || "GET").toUpperCase();
  if (!["GET", "POST", "PATCH"].includes(method)) return sendJson(res, 405, { success: false, code: "method_not_allowed" });
  const body = asRecord(req.body);
  const workspaceId = readString(method === "GET" ? req.query.workspaceId : body.workspaceId ?? body.workspace_id).toLowerCase();
  const requestKey = readString(method === "GET" ? req.query.requestKey : body.requestKey).toLowerCase();
  if (method !== "GET" || req.query.workspaceId !== undefined || req.query.requestKey !== undefined) {
    if (!UUID_PATTERN.test(workspaceId)) return sendJson(res, 400, { success: false, error: "Нужна клиника", code: "workspace_required" });
  }
  if ((method !== "GET" || req.query.requestKey !== undefined) && !UUID_PATTERN.test(requestKey)) {
    return sendJson(res, 400, { success: false, error: "Нужен ключ запроса", code: "subscription_request_required" });
  }
  const supabase = getSupabaseServerClient();
  if (!supabase) return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  const scope: SubscriptionOperationScope = { actorId: owner.userId.toLowerCase(), requestKey, workspaceId };
  try {
    if (method === "GET") {
      if (requestKey) {
        const { data, error } = await supabase.rpc("read_platform_subscription_operation", {
          p_actor_auth_user_id: scope.actorId, p_request_id: requestKey, p_workspace_id: workspaceId,
        });
        if (error) return subscriptionOperationFailure(res, error);
        return sendJson(res, 200, { success: true, data: data === null ? { item: null, operation: null } : subscriptionOperationData(data, scope) });
      }
      let query = supabase.from("platform_subscriptions").select("*", { count: "exact" });
      if (workspaceId) query = query.eq("workspace_id", workspaceId);
      const { data, error, count } = await query.order("started_at", { ascending: false }).order("id", { ascending: false }).range(0, 999);
      const seen = new Set<string>();
      if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count! < 0 || count! > 1000 || data.length !== count
        || data.some((value) => {
          const row = asRecord(value), id = readString(row.id).toLowerCase();
          if (seen.has(id) || !subscriptionItem(value, workspaceId)) return true;
          seen.add(id); return false;
        })) return sendJson(res, 502, { success: false, error: "Не удалось прочитать полную историю подписок", code: "unavailable" });
      return sendJson(res, 200, { success: true, data: { items: data.map((value) => subscriptionItem(value, workspaceId)) } });
    }
    if ("abandon" in body) {
      if (method !== "POST" || body.abandon !== true) return sendJson(res, 400, { success: false, code: "subscription_operation_invalid", error: "Некорректный запрос" });
      const { data, error } = await supabase.rpc("abandon_platform_subscription_operation", {
        p_actor_auth_user_id: scope.actorId, p_request_id: requestKey, p_workspace_id: workspaceId,
      });
      if (error) return subscriptionOperationFailure(res, error);
      return sendJson(res, 200, { success: true, data: subscriptionOperationData(data, scope) });
    }

    let payload: JsonRecord;
    if (method === "PATCH") {
      const status = readString(body.status).toLowerCase(), expectedStatus = readString(body.expectedStatus).toLowerCase();
      const subscriptionId = readString(body.subscriptionId).toLowerCase(), expectedUpdatedAt = readString(body.expectedUpdatedAt);
      if (!["active", "paused", "cancelled"].includes(status) || !["active", "paused", "cancelled"].includes(expectedStatus)
        || !UUID_PATTERN.test(subscriptionId) || !validSubscriptionTimestamp(expectedUpdatedAt)) {
        return sendJson(res, 400, { success: false, code: "subscription_operation_invalid", error: "Нужны точная подписка, её версия и статус" });
      }
      scope.kind = "status";
      payload = { subscriptionId, expectedUpdatedAt, expectedStatus, status };
    } else {
      const plan = readString(body.plan).toLowerCase();
      if (!["basic", "standard", "pro"].includes(plan)) return sendJson(res, 400, { success: false, error: "Неизвестный тариф", code: "plan_invalid" });
      const rawPrice = body.priceMinor ?? body.price_minor;
      const priceNumber = typeof rawPrice === "number" ? rawPrice : Number(readString(rawPrice));
      const emptyString = typeof rawPrice === "string" && rawPrice.trim() === "";
      if (rawPrice === undefined || rawPrice === null || emptyString || !["number", "string"].includes(typeof rawPrice) || !Number.isFinite(priceNumber)) {
        return sendJson(res, 400, { success: false, error: "Нужна цена", code: "price_required" });
      }
      if (priceNumber < 0 || !Number.isSafeInteger(priceNumber)) return sendJson(res, 400, { success: false, error: "Нужна целая неотрицательная цена в тиынах", code: "price_invalid" });
      const billingPeriod = readString(body.billingPeriod ?? body.billing_period) || "monthly";
      if (!["monthly", "yearly"].includes(billingPeriod)) return sendJson(res, 400, { success: false, error: "Недопустимый период", code: "period_invalid" });
      const currency = (readString(body.currency) || "KZT").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return sendJson(res, 400, { success: false, error: "Недопустимая валюта", code: "currency_invalid" });
      const note = readString(body.note);
      if (note.length > 2000) return sendJson(res, 400, { success: false, error: "Комментарий слишком длинный", code: "note_invalid" });
      const expectedActiveId = body.expectedActiveId === null ? null : readString(body.expectedActiveId).toLowerCase();
      if (!Object.hasOwn(body, "expectedActiveId") || (expectedActiveId !== null && !UUID_PATTERN.test(expectedActiveId))) {
        return sendJson(res, 400, { success: false, error: "Подтвердите исходную подписку", code: "expected_subscription_required" });
      }
      scope.kind = "replace";
      payload = { expectedActiveId, plan, priceMinor: priceNumber, billingPeriod, currency, note: note || null };
    }
    scope.payload = payload;
    const { data, error } = await supabase.rpc("apply_platform_subscription_operation", {
      p_actor_auth_user_id: scope.actorId, p_request_id: requestKey, p_workspace_id: workspaceId, p_kind: scope.kind, p_payload: payload,
    });
    if (error) return subscriptionOperationFailure(res, error);
    const confirmed = subscriptionOperationData(data, scope, true);
    return sendJson(res, method === "POST" ? 201 : 200, { success: true, data: confirmed });
  } catch (error) {
    return subscriptionOperationFailure(res, error);
  }
}

/**
 * Подписка ЭТОЙ клиники: тариф, цена, период.
 *
 * Арендатор берётся из проверенного контекста, а не из запроса, и в выборке
 * стоит фильтром — иначе это был бы второй, никем не охраняемый способ узнать
 * условия чужой клиники.
 *
 * Нет строки — так и отвечаем: `subscription: null`. Подставить сюда цену из
 * прайса значило бы показать клинике счёт, которого ей никто не выставлял.
 */
export async function handleWorkspaceSubscription(
  workspaceId: string,
  res: VercelResponse,
) {
  const supabase = getSupabaseServerClient();
  if (!supabase || !UUID_PATTERN.test(workspaceId)) {
    return sendJson(res, 200, { success: true, data: { subscription: null } });
  }

  const { data, error } = await supabase
    .from("platform_subscriptions")
    .select("plan, status, price_minor, currency, billing_period, started_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    // Отказ чтения — не «подписки нет». Второе экран показал бы как «тариф не
    // назначен», и клиника решила бы, что ей ничего не выставлено.
    return sendJson(res, 502, {
      success: false,
      error: "Не удалось прочитать тариф",
      code: "subscription_unavailable",
    });
  }

  return sendJson(res, 200, { success: true, data: { subscription: data ? asRecord(data) : null } });
}

/**
 * Счётчик строк за интервал [fromIso, toIso) — тем же head-способом, что и
 * countRows: карточка знает, СКОЛЬКО заявок завели на этой неделе, и не видит,
 * каких.
 */
async function countRowsInRange(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  table: string,
  workspaceId: string,
  fromIso: string,
  toIso: string,
): Promise<number | null> {
  if (!supabase) return null;
  try {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("created_at", fromIso)
      .lt("created_at", toIso);
    if (error) return null;
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

/**
 * Карточка одной клиники: активность по неделям, статус модулей и сигналы.
 *
 * Те же два ограничения, что и у обзора: доступ решает список владельцев
 * платформы в маршрутизаторе, а наружу уезжают только счётчики и настройки
 * уровня «часовой пояс задан» — ни одной строки пациента, записи или заявки.
 *
 * Сами правила сигналов — в lib/crm/clinic-signals.ts, чистой функцией: здесь
 * только честный сбор фактов, где null означает «не смог посчитать», и сигнал
 * по такому факту не строится вовсе.
 */
async function handleClinicCard(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, {
      success: false,
      error: "Хранилище не настроено",
      code: "storage_not_configured",
    });
  }

  const workspaceId = readString(
    Array.isArray(req.query.workspaceId) ? req.query.workspaceId[0] : req.query.workspaceId,
  );
  if (!UUID_PATTERN.test(workspaceId)) {
    return sendJson(res, 400, {
      success: false,
      error: "Нужна клиника",
      code: "workspace_required",
      details: ["Передайте workspaceId существующей клиники."],
    });
  }

  const { data: workspaceRow, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, name, owner_email, created_at")
    .eq("id", workspaceId)
    .maybeSingle();
  if (workspaceError) {
    return sendJson(res, 502, {
      success: false,
      error: "Не удалось прочитать клинику",
      code: "workspace_unavailable",
    });
  }
  if (!workspaceRow) {
    return sendJson(res, 404, { success: false, error: "Клиники нет", code: "not_found" });
  }
  const workspace = asRecord(workspaceRow);

  // Настройки — двумя ключами одним запросом: ниша и часовой пояс. Отказ
  // чтения здесь — отказ всей карточки: на этих двух значениях стоят и слова
  // ниши, и сигнал о часовом поясе, и молча подменить их дефолтом значило бы
  // построить предупреждение на сбое чтения.
  const { data: settingRows, error: settingsError } = await supabase
    .from("workspace_settings")
    .select("key, value")
    .eq("workspace_id", workspaceId)
    .in("key", [VERTICAL_SETTINGS_KEY, "clinic_schedule"]);
  if (settingsError) {
    return sendJson(res, 502, {
      success: false,
      error: "Не удалось прочитать настройки клиники",
      code: "settings_unavailable",
    });
  }
  let vertical = readVertical(undefined);
  let timeZone = "";
  for (const row of (settingRows || []).map(asRecord)) {
    const value = asRecord(row.value);
    if (readString(row.key) === VERTICAL_SETTINGS_KEY) vertical = readVertical(value.vertical);
    if (readString(row.key) === "clinic_schedule") timeZone = readString(value.timeZone);
  }

  // Отказ чтения — не «подписки нет»: тот же принцип, что у
  // handleWorkspaceSubscription выше. Иначе транзиентный сбой рисовал бы
  // платящей клинике «тариф не назначен», и владелец шёл бы переназначать.
  const { data: subscriptionRow, error: subscriptionError } = await supabase
    .from("platform_subscriptions")
    .select("plan, status, price_minor, currency, billing_period")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .maybeSingle();
  if (subscriptionError) {
    return sendJson(res, 502, {
      success: false,
      error: "Не удалось прочитать тариф клиники",
      code: "subscription_unavailable",
    });
  }
  const subscription = asRecord(subscriptionRow);

  // Недельные корзины: четыре интервала по семь дней, самый свежий — первым.
  // Считается по created_at — «сколько завели», то есть пользуется ли клиника
  // продуктом, а не сколько визитов назначено на будущее.
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const weekRanges = [0, 1, 2, 3].map((index) => ({
    from: new Date(now - (index + 1) * 7 * DAY).toISOString(),
    to: new Date(now - index * 7 * DAY).toISOString(),
  }));

  // Исполнители считаются пересечением: сколько АКТИВНЫХ врачей и у скольких
  // ИЗ НИХ есть график. Дистинкт по всем строкам смен считал бы архивных —
  // архивирование не удаляет их графики, DELETE у платформы нет вовсе, — и
  // «график заполнен у всех» загорался бы у клиники, где единственный активный
  // врач графика не имеет. Заодно ни одной строки смен не выгружается: только
  // head-счётчики на каждого активного врача, и кап PostgREST в тысячу строк
  // сюда не дотягивается.
  const activeDoctorIds = await (async (): Promise<string[] | null> => {
    try {
      const { data, error } = await supabase
        .from("clinic_doctors")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);
      if (error || !Array.isArray(data)) return null;
      return data.map((row) => readString(asRecord(row).id)).filter(Boolean);
    } catch {
      return null;
    }
  })();

  const [
    staffCount,
    scheduledFlags,
    servicesCount,
    wazzupCount,
    cloudNumbersCount,
    clientsCount,
    weeklyLeads,
    weeklyAppointments,
    contentUsage,
  ] = await Promise.all([
    countRows(supabase, "staff_users", workspaceId),
    activeDoctorIds === null
      ? Promise.resolve(null)
      : Promise.all(
          activeDoctorIds.map(async (doctorId): Promise<boolean | null> => {
            try {
              const { count, error } = await supabase
                .from("clinic_doctor_shifts")
                .select("id", { count: "exact", head: true })
                .eq("workspace_id", workspaceId)
                .eq("doctor_id", doctorId);
              if (error || typeof count !== "number") return null;
              return count > 0;
            } catch {
              return null;
            }
          }),
        ),
    countRows(supabase, "clinic_services", workspaceId),
    countRows(supabase, "wazzup_channels", workspaceId),
    countRows(supabase, "whatsapp_cloud_numbers", workspaceId),
    countRows(supabase, "clients", workspaceId),
    Promise.all(weekRanges.map((range) => countRowsInRange(supabase, "leads", workspaceId, range.from, range.to))),
    Promise.all(weekRanges.map((range) => countRowsInRange(supabase, "appointments", workspaceId, range.from, range.to))),
    // Только агрегаты расхода: prompt, результат генерации, URL и provider
    // response таблица 051 не хранит вообще. Порталу платформы нужен этот
    // счётчик, чтобы общий AI-ключ не превращался в незаметный расход одной
    // клиники за счёт остальных.
    getContentUsageSummary(workspaceId),
  ]);

  const doctorsCount = activeDoctorIds === null ? null : activeDoctorIds.length;
  // Один непосчитанный врач делает непосчитанным весь факт: сказать «у всех
  // есть график», не сумев проверить одного, значило бы построить вывод на сбое.
  const doctorsWithSchedule =
    scheduledFlags === null || scheduledFlags.some((flag) => flag === null)
      ? null
      : scheduledFlags.filter(Boolean).length;

  // Два канала WhatsApp — одна суть: «клинике есть куда писать». Сумма честна
  // только когда она положительна («хотя бы столько подключено») или когда ОБА
  // счётчика реально нули. Ноль рядом со сбоем чтения — не ноль: канал мог
  // жить в непрочитанной таблице.
  const whatsappSum = (wazzupCount ?? 0) + (cloudNumbersCount ?? 0);
  const whatsappChannels =
    whatsappSum > 0 ? whatsappSum : wazzupCount === null || cloudNumbersCount === null ? null : 0;

  const facts: ClinicFacts = {
    subscriptionStatus: readString(subscription.status),
    timeZoneSet: Boolean(timeZone),
    doctors: doctorsCount,
    doctorsWithSchedule,
    services: servicesCount,
    whatsappChannels,
    leads7d: weeklyLeads[0],
    appointments7d: weeklyAppointments[0],
  };

  const priceMinor = readInteger(subscription.price_minor);
  const billingPeriod = readString(subscription.billing_period) || "monthly";

  // Доступ: кто уже внутри и что с приглашениями — владельца и сотрудников.
  // Раньше это жило в трёх местах — карточка собирает в одно; без приглашений
  // сотрудников поддержка не могла диагностировать «пригласила администратора,
  // она не может войти». Всё — административные данные: email, роль, статус,
  // даты; без имён и без строк пациентов; сбой чтения отдаётся null-ом и не
  // притворяется «никого нет».
  const [staffRowsRaw, invitationRows] = await Promise.all([
    (async (): Promise<Array<{ email: string; role: string; status: string; linked: boolean; authUserId: string }> | null> => {
      try {
        const { data, error } = await supabase
          .from("staff_users")
          .select("email, role, status, auth_user_id")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: true });
        if (error || !Array.isArray(data)) return null;
        return data.map((row) => {
          const record = asRecord(row);
          return {
            email: readString(record.email),
            role: readString(record.role),
            status: readString(record.status),
            linked: Boolean(readString(record.auth_user_id)),
            authUserId: readString(record.auth_user_id),
          };
        });
      } catch {
        return null;
      }
    })(),
    (async (): Promise<Array<{ email: string; role: string; status: string; createdAt: string; expiresAt: string }> | null> => {
      try {
        const { data, error } = await supabase
          .from("staff_invitations")
          .select("email, role, accepted_at, revoked_at, expires_at, created_at")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false });
        if (error || !Array.isArray(data)) return null;
        return data.map((row) => {
          const record = asRecord(row);
          // Статус — общей функцией: правила accepted → revoked → expired →
          // pending живут в одном месте, а не расползаются копиями.
          const status = invitationStatus({
            accepted_at: readString(record.accepted_at) || null,
            revoked_at: readString(record.revoked_at) || null,
            expires_at: readString(record.expires_at),
          });
          return {
            email: readString(record.email),
            role: readString(record.role),
            status,
            createdAt: readString(record.created_at),
            expiresAt: readString(record.expires_at),
          };
        });
      } catch {
        return null;
      }
    })(),
  ]);

  // «Вход привязан» не отвечает на вопрос «принял ли владелец работу»:
  // парольное подключение привязывает вход с первой секунды. Одна строка
  // administrativa из Auth Admin API — и только по владельцу. null — «не смог
  // прочитать»; lastAt: "" — прочитал, входов не было.
  let ownerSignIn: { lastAt: string; accountMissing?: boolean } | null = null;
  const ownerStaffRow = Array.isArray(staffRowsRaw)
    ? staffRowsRaw.find((person) => person.role === "owner" && person.authUserId)
    : undefined;
  if (ownerStaffRow) {
    const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (supabaseUrl && serviceRoleKey) {
      try {
        type AdminUserResponse = { ok: boolean; status: number; json(): Promise<unknown> };
        const response = (await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(ownerStaffRow.authUserId)}`, {
          redirect: "error",
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
        })) as unknown as AdminUserResponse;
        if (response.ok) {
          const body = asRecord(await response.json().catch(() => null));
          ownerSignIn = { lastAt: readString(body.last_sign_in_at) };
        } else if (response.status === 404) {
          // 404 — не сбой чтения, а определённый ответ: аккаунт удалён из
          // Auth, вход владельца невозможен, хотя «вход привязан» горит.
          ownerSignIn = { lastAt: "", accountMissing: true };
        }
      } catch {
        // Не прочитали — остаётся null: «не знаю», не «не входил».
      }
    }
  }

  // Внутренний auth_user_id наружу не уезжает — он был нужен только для
  // запроса выше.
  const staffRows = Array.isArray(staffRowsRaw)
    ? staffRowsRaw.map(({ authUserId: _authUserId, ...rest }) => rest)
    : staffRowsRaw;
  const ownerInvitations = invitationRows === null ? null : invitationRows.filter((invitation) => invitation.role === "owner");
  const staffInvitations = invitationRows === null ? null : invitationRows.filter((invitation) => invitation.role !== "owner");

  return sendJson(res, 200, {
    success: true,
    data: {
      access: { staff: staffRows, ownerInvitations, staffInvitations, ownerSignIn },
      clinic: {
        id: workspaceId,
        name: readString(workspace.name),
        ownerEmail: readString(workspace.owner_email),
        createdAt: readString(workspace.created_at),
        vertical,
        timeZone,
        plan: readString(subscription.plan),
        subscriptionStatus: readString(subscription.status),
        monthlyMinor: subscription.plan ? monthlyMinor(priceMinor, billingPeriod) : 0,
        currency: readString(subscription.currency) || "KZT",
        billingPeriod,
      },
      counts: {
        staff: staffCount,
        doctors: doctorsCount,
        doctorsWithSchedule,
        services: servicesCount,
        whatsappChannels,
        clients: clientsCount,
      },
      contentUsage,
      // Самая свежая неделя — первой; from/to отдаются, чтобы портал подписал
      // корзины настоящими датами, а не пересчитывал их вторым способом.
      weekly: weekRanges.map((range, index) => ({
        from: range.from,
        to: range.to,
        leads: weeklyLeads[index],
        appointments: weeklyAppointments[index],
      })),
      signals: computeClinicSignals(facts),
    },
  });
}

export async function handlePlatformOverview(_req: VercelRequest, res: VercelResponse) {
  return handleOverview(res);
}

export async function handlePlatformClinic(req: VercelRequest, res: VercelResponse) {
  return handleClinicCard(req, res);
}

export async function handlePlatformSubscriptions(req: VercelRequest, res: VercelResponse) {
  return handleSubscriptions(req, res);
}
