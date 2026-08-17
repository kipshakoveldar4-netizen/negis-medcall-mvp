import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { computeClinicSignals, type ClinicFacts } from "./clinic-signals";
import { invitationStatus } from "./staff-invitations";
import { readVertical, VERTICAL_SETTINGS_KEY } from "../vertical/terms";

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
  staffCount: number | null;
  leadCount: number | null;
  appointmentCount: number | null;
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
    .select("workspace_id, plan, status, price_minor, currency, billing_period, started_at")
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
      priceMinor,
      currency: readString(subscription.currency) || "KZT",
      billingPeriod,
      monthlyMinor: subscription.plan ? monthlyMinor(priceMinor, billingPeriod) : 0,
      staffCount: counted.staffCount,
      leadCount: counted.leadCount,
      appointmentCount: counted.appointmentCount,
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

  // PATCH меняет только статус: поставить подписку на паузу или отменить её.
  // Прежде он требовал тариф и цену, которых у такого запроса нет по смыслу, —
  // и паузу поставить было нельзя вообще, отказ приходил раньше проверки статуса.
  if (method === "PATCH") {
    const status = readString(body.status).toLowerCase();
    if (!["active", "paused", "cancelled"].includes(status)) {
      return sendJson(res, 400, { success: false, error: "Неизвестный статус", code: "status_invalid" });
    }
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("platform_subscriptions")
      .update({ status, ended_at: status === "cancelled" ? now : null, updated_at: now })
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .select("*")
      .maybeSingle();
    if (error) {
      return sendJson(res, 502, {
        success: false,
        error: "Не удалось изменить подписку",
        code: "unavailable",
        details: [error.message],
      });
    }
    if (!data) {
      return sendJson(res, 404, { success: false, error: "Действующей подписки нет", code: "not_found" });
    }
    return sendJson(res, 200, { success: true, data: { item: asRecord(data) } });
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
  //
  // Пустое поле — это НЕ ноль. readInteger вернул бы 0 и на пустой строке, и на
  // мусоре, и подписка сохранялась бы «бесплатной» с зелёным сообщением об
  // успехе. Бесплатный доступ существует, но его назначают, а не получают по
  // недосмотру.
  const rawPrice = body.priceMinor ?? body.price_minor;
  const priceNumber = typeof rawPrice === "number" ? rawPrice : Number(readString(rawPrice));
  // Пустоту проверяем ТОЛЬКО у строки. Прежняя проверка звала readString на
  // любом значении, а он возвращает пустую строку для всего, что не строка, —
  // то есть ЧИСЛОВАЯ цена не проходила никогда, и панель отвечала «Нужна цена»
  // на запрос, в котором цена есть. Найдено на проде первым же настоящим
  // назначением тарифа; собственная проверка PB2 дефект закрепляла, потому что
  // пинила формулировку строки, а не поведение обработчика.
  const emptyString = typeof rawPrice === "string" && rawPrice.trim() === "";
  if (rawPrice === undefined || rawPrice === null || emptyString || !Number.isFinite(priceNumber)) {
    return sendJson(res, 400, {
      success: false,
      error: "Нужна цена",
      code: "price_required",
      details: ["Укажите цену в тиынах. Ноль — законное значение, но его нужно указать явно."],
    });
  }
  const priceMinor = Math.trunc(priceNumber);
  if (priceMinor < 0) {
    return sendJson(res, 400, { success: false, error: "Цена не может быть отрицательной", code: "price_invalid" });
  }

  const billingPeriod = readString(body.billingPeriod ?? body.billing_period) || "monthly";
  if (!["monthly", "yearly"].includes(billingPeriod)) {
    return sendJson(res, 400, { success: false, error: "Период может быть monthly или yearly", code: "period_invalid" });
  }

  const currency = (readString(body.currency) || "KZT").toUpperCase();
  const now = new Date().toISOString();

  // POST — новая подписка. Прежняя действующая закрывается: частичный
  // уникальный индекс миграции 034 не даст существовать двум сразу, и лучше
  // закрыть её здесь явно, чем получить отказ базы с непонятным текстом.
  const { error: cancelError } = await supabase
    .from("platform_subscriptions")
    .update({ status: "cancelled", ended_at: now, updated_at: now })
    .eq("workspace_id", workspaceId)
    .eq("status", "active");

  // Отказ отмены игнорировать нельзя: следом идёт вставка, а частичный
  // уникальный индекс не даст существовать двум действующим подпискам сразу.
  // Молча проглотив отказ, мы получили бы непонятную ошибку базы вместо
  // внятной причины.
  if (cancelError) {
    return sendJson(res, 502, {
      success: false,
      error: "Не удалось закрыть прежнюю подписку",
      code: "unavailable",
      details: ["Новая подписка не создана: у клиники осталась прежняя.", cancelError.message],
    });
  }

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
    return sendJson(res, 502, {
      success: false,
      error: "Не удалось создать подписку",
      code: "unavailable",
      details: [error.message],
    });
  }

  return sendJson(res, 201, { success: true, data: { item: asRecord(data) } });
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

  // Доступ: кто уже внутри и что с приглашением владельца. Раньше это жило
  // в трёх местах — карточка собирает в одно. Сотрудники — email, роль и
  // статус: административные данные, без имён и без строк пациентов; сбой
  // чтения отдаётся null-ом и не притворяется «никого нет».
  const [staffRows, invitationRows] = await Promise.all([
    (async (): Promise<Array<{ email: string; role: string; status: string; linked: boolean }> | null> => {
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
          };
        });
      } catch {
        return null;
      }
    })(),
    (async (): Promise<Array<{ email: string; status: string; createdAt: string; expiresAt: string }> | null> => {
      try {
        const { data, error } = await supabase
          .from("staff_invitations")
          .select("email, role, accepted_at, revoked_at, expires_at, created_at")
          .eq("workspace_id", workspaceId)
          .eq("role", "owner")
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

  return sendJson(res, 200, {
    success: true,
    data: {
      access: { staff: staffRows, ownerInvitations: invitationRows },
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
