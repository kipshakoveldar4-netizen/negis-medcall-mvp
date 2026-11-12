// Статистика владельца — раздел «Статистика» из кабинета запись.кз, собранный
// по нашим данным: записи, продажи, график и справочник мастеров.
//
// Расчёт отделён от HTTP полностью: computeSalonStats — чистая функция над
// строками, и каждое денежное правило в ней предъявляется тесту. Числа, которые
// нельзя посчитать честно, не выдумываются: выручка «по ценам записей» и
// выручка «по оплаченным продажам» — это ДВА разных числа с разным смыслом, и
// экран показывает оба, не склеивая их в одно красивое.

import type { VercelRequest, VercelResponse } from "@vercel/node";

import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";

type CrmSupabaseClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNumberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Потолки выборок. Обрезка не молчит: в ответе стоит truncated. */
export const STATS_ROWS_LIMIT = 5000;

export interface StatsAppointmentRow {
  status: string;
  startsAt: string;
  durationMinutes: number;
  priceMinor: number | null;
  doctorId: string;
  doctorName: string;
  service: string;
  clientId: string;
}

export interface StatsDealRow {
  status: string;
  amountMinor: number;
}

export interface SalonStats {
  appointments: {
    total: number;
    byStatus: Record<string, number>;
    /** Доля отмен и неявок от всех записей периода, в процентах, целым. */
    lostSharePercent: number;
  };
  money: {
    /** Оплаченные продажи периода, в тиынах. Это ДЕНЬГИ В КАССЕ. */
    paidMinor: number;
    paidCount: number;
    /** Средний чек по оплаченным продажам, в тиынах; null — продаж не было. */
    averageTicketMinor: number | null;
    /**
     * Сумма цен записей со статусом «пришёл», в тиынах. Это ОЖИДАНИЕ по
     * договорённостям, не касса: у части записей цены нет вовсе — их число
     * рядом, чтобы никто не принял нижнюю границу за выручку.
     */
    arrivedPricedMinor: number;
    arrivedWithoutPrice: number;
  };
  masters: Array<{
    doctorId: string;
    name: string;
    appointments: number;
    /** Занято минут живыми записями (пришёл + активные). */
    busyMinutes: number;
    /** Рабочих минут по графику за период; null — график не задан. */
    scheduledMinutes: number | null;
    /** Занятость в процентах от графика; null — считать не от чего. */
    loadPercent: number | null;
    pricedMinor: number;
    /** Процент мастера; null — условия не заданы. */
    salaryPercent: number | null;
    /** Процентная часть зарплаты за период: percent × (по ценам записей). */
    salaryPercentMinor: number | null;
    /** Фикс В МЕСЯЦ — справочно: период произвольный, и делить фикс на дни
        значило бы выдумывать метрику. */
    salaryFixedMonthlyMinor: number | null;
  }>;
  services: Array<{ name: string; count: number; pricedMinor: number }>;
  clients: {
    /** Уникальные клиенты периода С КАРТОЧКОЙ. */
    withCard: number;
    newClients: number;
    returning: number;
    /** Записи без карточки клиента: их новизну определить не по чему. */
    withoutCard: number;
  };
  truncated: boolean;
}

const LOST_STATUSES = new Set(["cancelled", "no_show"]);
const BUSY_STATUSES = new Set(["scheduled", "confirmed", "arrived"]);

export function computeSalonStats(input: {
  appointments: readonly StatsAppointmentRow[];
  deals: readonly StatsDealRow[];
  /** Ключи клиентов, у которых был визит ДО начала периода. */
  clientsSeenBefore: ReadonlySet<string>;
  /** Рабочие минуты периода по мастерам; отсутствие ключа — графика нет. */
  scheduledMinutesByDoctor: ReadonlyMap<string, number>;
  doctorNames: ReadonlyMap<string, string>;
  /** Условия оплаты по карточкам; отсутствие ключа — условия не заданы. */
  salaryByDoctor?: ReadonlyMap<string, { fixedMinor: number | null; percent: number | null }>;
  truncated: boolean;
}): SalonStats {
  const byStatus: Record<string, number> = {};
  let lost = 0;

  const masters = new Map<string, { name: string; appointments: number; busyMinutes: number; pricedMinor: number }>();
  const services = new Map<string, { count: number; pricedMinor: number }>();
  const periodClients = new Set<string>();
  let withoutCard = 0;
  let arrivedPricedMinor = 0;
  let arrivedWithoutPrice = 0;

  for (const appointment of input.appointments) {
    const status = appointment.status || "scheduled";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (LOST_STATUSES.has(status)) lost += 1;

    // Мастер опознаётся ссылкой, а без неё — именем: вся история до 033 знает
    // мастера только по имени, и выбрасывать её из статистики нельзя.
    const masterKey = appointment.doctorId || (appointment.doctorName ? `name:${appointment.doctorName.toLowerCase()}` : "");
    if (masterKey) {
      const entry = masters.get(masterKey) ?? {
        name: appointment.doctorId
          ? input.doctorNames.get(appointment.doctorId) ?? appointment.doctorName ?? "Без имени"
          : appointment.doctorName,
        appointments: 0,
        busyMinutes: 0,
        pricedMinor: 0,
      };
      entry.appointments += 1;
      if (BUSY_STATUSES.has(status)) entry.busyMinutes += appointment.durationMinutes || 60;
      if (status === "arrived" && appointment.priceMinor !== null) entry.pricedMinor += appointment.priceMinor;
      masters.set(masterKey, entry);
    }

    if (appointment.service) {
      const entry = services.get(appointment.service) ?? { count: 0, pricedMinor: 0 };
      entry.count += 1;
      if (status === "arrived" && appointment.priceMinor !== null) entry.pricedMinor += appointment.priceMinor;
      services.set(appointment.service, entry);
    }

    if (status === "arrived") {
      if (appointment.priceMinor === null) arrivedWithoutPrice += 1;
      else arrivedPricedMinor += appointment.priceMinor;
    }

    if (appointment.clientId) periodClients.add(appointment.clientId);
    else withoutCard += 1;
  }

  // Деньги в кассе — только оплаченные продажи. pending — не выручка,
  // refunded — тем более: возврат, посчитанный доходом, — это враньё владельцу.
  let paidMinor = 0;
  let paidCount = 0;
  for (const deal of input.deals) {
    if (deal.status !== "paid") continue;
    paidMinor += deal.amountMinor;
    paidCount += 1;
  }

  let newClients = 0;
  let returning = 0;
  for (const clientId of periodClients) {
    if (input.clientsSeenBefore.has(clientId)) returning += 1;
    else newClients += 1;
  }

  const mastersOut = [...masters.entries()]
    .map(([key, entry]) => {
      const doctorId = key.startsWith("name:") ? "" : key;
      const scheduled = doctorId ? input.scheduledMinutesByDoctor.get(doctorId) ?? null : null;
      const salary = doctorId ? input.salaryByDoctor?.get(doctorId) ?? null : null;
      return {
        doctorId,
        name: entry.name || "Без имени",
        appointments: entry.appointments,
        busyMinutes: entry.busyMinutes,
        scheduledMinutes: scheduled,
        // Загрузка — от графика. Нет графика — нет процента: занятые часы
        // без знаменателя честнее выдуманной сотни.
        loadPercent: scheduled && scheduled > 0 ? Math.round((entry.busyMinutes / scheduled) * 100) : null,
        pricedMinor: entry.pricedMinor,
        salaryPercent: salary?.percent ?? null,
        // Процентная часть — от цен ЕГО пришедших записей за период. Условия
        // не заданы — null, а не ноль: «не считали» отличается от «ноль».
        salaryPercentMinor: salary?.percent === null || salary?.percent === undefined
          ? null
          : Math.round((entry.pricedMinor * salary.percent) / 100),
        salaryFixedMonthlyMinor: salary?.fixedMinor ?? null,
      };
    })
    .sort((left, right) => right.appointments - left.appointments);

  const servicesOut = [...services.entries()]
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 15);

  const total = input.appointments.length;
  return {
    appointments: {
      total,
      byStatus,
      lostSharePercent: total > 0 ? Math.round((lost / total) * 100) : 0,
    },
    money: {
      paidMinor,
      paidCount,
      averageTicketMinor: paidCount > 0 ? Math.round(paidMinor / paidCount) : null,
      arrivedPricedMinor,
      arrivedWithoutPrice,
    },
    masters: mastersOut,
    services: servicesOut,
    clients: { withCard: periodClients.size, newClients, returning, withoutCard },
    truncated: input.truncated,
  };
}

/** Дни периода включительно, ключами YYYY-MM-DD. Потолок — 92 дня. */
export function daysBetween(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days: string[] = [];
  for (let cursor = start; cursor <= end && days.length < 92; cursor += 24 * 60 * 60 * 1000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

export async function handleSalonStats(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  const context = readWorkspaceContext(req);
  const workspaceId = readString(context?.workspaceId);
  if (!context || !context.permissions.includes("view_reports")) {
    return sendJson(res, 403, { success: false, error: "Forbidden", code: "insufficient_permission" });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase || !UUID_PATTERN.test(workspaceId)) {
    return sendJson(res, 200, { success: true, mode: "demo", stats: null });
  }

  const from = readString(Array.isArray(req.query.from) ? req.query.from[0] : req.query.from);
  const to = readString(Array.isArray(req.query.to) ? req.query.to[0] : req.query.to);
  const days = daysBetween(from, to);
  if (days.length === 0) {
    return sendJson(res, 400, { success: false, error: "Период указывается как from=YYYY-MM-DD&to=YYYY-MM-DD, не длиннее 92 дней" });
  }

  // Границы периода — по поясу клиники было бы точнее; пока честное приближение
  // в UTC+5 (Казахстан один пояс): полночь местная = 19:00 предыдущего дня UTC.
  const fromInstant = `${days[0]}T00:00:00+05:00`;
  const toInstant = `${days[days.length - 1]}T23:59:59.999+05:00`;

  const appointmentsRead = await supabase
    .from("appointments")
    .select("status, starts_at, duration_minutes, price_minor, doctor_id, doctor_name, service, client_id", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .gte("starts_at", fromInstant)
    .lte("starts_at", toInstant)
    .limit(STATS_ROWS_LIMIT);
  if (appointmentsRead.error) {
    // Колонки price_minor может не быть до 045 — повторяем без неё, а не 502.
    const message = readString(appointmentsRead.error.message);
    if (!message.includes("price_minor")) {
      return sendJson(res, 502, { success: false, error: "Не удалось прочитать записи", code: "read_failed" });
    }
  }
  let appointmentRows: unknown[] | null = appointmentsRead.data;
  if (appointmentsRead.error) {
    const retry = await supabase
      .from("appointments")
      .select("status, starts_at, duration_minutes, doctor_id, doctor_name, service, client_id", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .gte("starts_at", fromInstant)
      .lte("starts_at", toInstant)
      .limit(STATS_ROWS_LIMIT);
    if (retry.error) {
      return sendJson(res, 502, { success: false, error: "Не удалось прочитать записи", code: "read_failed" });
    }
    appointmentRows = retry.data as unknown[] | null;
  }

  const appointments: StatsAppointmentRow[] = (Array.isArray(appointmentRows) ? appointmentRows : []).map((row: unknown) => {
    const record = row as Record<string, unknown>;
    const rawPrice = record.price_minor;
    return {
      status: readString(record.status) || "scheduled",
      startsAt: readString(record.starts_at),
      durationMinutes: readNumberOr(record.duration_minutes, 60),
      priceMinor: rawPrice === null || rawPrice === undefined ? null : readNumberOr(rawPrice, 0),
      doctorId: readString(record.doctor_id),
      doctorName: readString(record.doctor_name),
      service: readString(record.service),
      clientId: readString(record.client_id),
    };
  });

  const dealsRead = await supabase
    .from("deals")
    .select("status, amount_minor")
    .eq("workspace_id", workspaceId)
    .gte("created_at", fromInstant)
    .lte("created_at", toInstant)
    .limit(STATS_ROWS_LIMIT);
  const deals: StatsDealRow[] = (Array.isArray(dealsRead.data) ? dealsRead.data : []).map((row: unknown) => {
    const record = row as Record<string, unknown>;
    return { status: readString(record.status), amountMinor: readNumberOr(record.amount_minor, 0) };
  });

  // «Новый или постоянный»: был ли у клиента визит до периода. Пачками, чтобы
  // не упереться в длину адреса запроса.
  const clientIds = [...new Set(appointments.map((row) => row.clientId).filter(Boolean))];
  const clientsSeenBefore = new Set<string>();
  for (let index = 0; index < clientIds.length; index += 100) {
    const chunk = clientIds.slice(index, index + 100);
    const { data } = await supabase
      .from("appointments")
      .select("client_id")
      .eq("workspace_id", workspaceId)
      .lt("starts_at", fromInstant)
      .in("client_id", chunk)
      .limit(1000);
    for (const row of Array.isArray(data) ? data : []) {
      const id = readString((row as Record<string, unknown>).client_id);
      if (id) clientsSeenBefore.add(id);
    }
  }

  // График мастеров: рабочие минуты за период.
  const doctorsFull = await supabase
    .from("clinic_doctors")
    .select("id, full_name, salary_fixed_minor, salary_percent")
    .eq("workspace_id", workspaceId);
  let doctorRows: unknown[] = Array.isArray(doctorsFull.data) ? doctorsFull.data : [];
  if (doctorsFull.error) {
    // До применения 046 зарплатных колонок нет — читаем без них, статистика
    // честно не считает зарплату вместо 502.
    const bare = await supabase.from("clinic_doctors").select("id, full_name").eq("workspace_id", workspaceId);
    doctorRows = Array.isArray(bare.data) ? bare.data : [];
  }
  const doctorNames = new Map<string, string>();
  const salaryByDoctor = new Map<string, { fixedMinor: number | null; percent: number | null }>();
  for (const row of doctorRows) {
    const record = row as Record<string, unknown>;
    const id = readString(record.id);
    doctorNames.set(id, readString(record.full_name));
    const fixed = record.salary_fixed_minor;
    const percent = record.salary_percent;
    if (fixed !== undefined || percent !== undefined) {
      salaryByDoctor.set(id, {
        fixedMinor: fixed === null || fixed === undefined ? null : readNumberOr(fixed, 0),
        percent: percent === null || percent === undefined ? null : readNumberOr(percent, 0),
      });
    }
  }

  const shiftsRead = await supabase
    .from("clinic_doctor_shifts")
    .select("doctor_id, weekday, on_date, on_date_end, is_working, start_minute, end_minute")
    .eq("workspace_id", workspaceId)
    .limit(STATS_ROWS_LIMIT);
  const scheduledMinutesByDoctor = new Map<string, number>();
  if (Array.isArray(shiftsRead.data) && shiftsRead.data.length > 0) {
    const byDoctor = new Map<string, Array<Record<string, unknown>>>();
    for (const row of shiftsRead.data) {
      const record = row as Record<string, unknown>;
      const doctorId = readString(record.doctor_id);
      if (!doctorId) continue;
      const list = byDoctor.get(doctorId) ?? [];
      list.push(record);
      byDoctor.set(doctorId, list);
    }
    for (const [doctorId, rows] of byDoctor) {
      let minutes = 0;
      for (const day of days) {
        const [year, month, dayOfMonth] = day.split("-").map(Number);
        const isoWeekday = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay() || 7;
        minutes += workedMinutesForDay(rows, day, isoWeekday);
      }
      scheduledMinutesByDoctor.set(doctorId, minutes);
    }
  }

  const truncated =
    (appointmentsRead.count ?? appointments.length) > appointments.length || deals.length >= STATS_ROWS_LIMIT;

  const stats = computeSalonStats({
    appointments,
    deals,
    clientsSeenBefore,
    scheduledMinutesByDoctor,
    doctorNames,
    salaryByDoctor,
    truncated,
  });

  return sendJson(res, 200, { success: true, stats, from: days[0], to: days[days.length - 1] });
}

/**
 * Рабочие минуты мастера в конкретный день — то же правило, что у формы и у
 * проверки графика: датированная строка замещает недельную, закрытое окно
 * вырезается, выходной без часов закрывает день.
 */
function workedMinutesForDay(rows: readonly Record<string, unknown>[], day: string, isoWeekday: number): number {
  const num = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const covering = rows.filter((row) => {
    const fromDate = readString(row.on_date);
    const toDate = readString(row.on_date_end) || fromDate;
    return Boolean(fromDate) && fromDate <= day && day <= toDate;
  });
  const weekly = rows.filter((row) => num(row.weekday) === isoWeekday);
  const definesDay = (row: Record<string, unknown>) => Boolean(row.is_working) || num(row.start_minute) === null;

  const datedBase = covering.filter(definesDay);
  const baseRows = datedBase.length > 0 ? datedBase : weekly.filter(definesDay);
  const windowRows = datedBase.length > 0
    ? covering.filter((row) => !definesDay(row))
    : [...covering.filter((row) => !definesDay(row)), ...weekly.filter((row) => !definesDay(row))];

  if (baseRows.some((row) => !row.is_working && num(row.start_minute) === null)) return 0;
  let pieces = baseRows
    .filter((row) => Boolean(row.is_working) && num(row.start_minute) !== null && num(row.end_minute) !== null)
    .map((row) => [num(row.start_minute) as number, num(row.end_minute) as number] as [number, number]);
  for (const closed of windowRows) {
    const closedStart = num(closed.start_minute);
    const closedEnd = num(closed.end_minute);
    if (closedStart === null || closedEnd === null) continue;
    const next: Array<[number, number]> = [];
    for (const [start, end] of pieces) {
      if (closedEnd <= start || closedStart >= end) { next.push([start, end]); continue; }
      if (closedStart > start) next.push([start, Math.min(closedStart, end)]);
      if (closedEnd < end) next.push([Math.max(closedEnd, start), end]);
    }
    pieces = next;
  }
  return pieces.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
}
