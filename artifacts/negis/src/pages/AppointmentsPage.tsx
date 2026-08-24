import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import {
  CalendarCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ListChecks,
  MessageCircle,
  PhoneCall,
  Plus,
  Search,
  Stethoscope,
  UserCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { MetricCard } from "@/components/ui/metric-card";
import { apiUrl, crmFetch } from "@/lib/api";
import { isRealWorkspace, readWorkspaceId as readCurrentWorkspaceId, useDemoCollection, workspaceScopedKey } from "@/lib/demoStorage";
import { formatPhone, toTelHref, toWhatsappHref } from "@/lib/phone";
import { clinicToday, dayKeyInZone, isOnClinicDay } from "@/lib/clinicDay";
import { useAuth } from "@/contexts/AuthContext";
import { MasterDayGrid } from "@/components/crm/master-day-grid";
import { formatSlot, freeSlots, groupSlots, minuteOfClinicDay, workingIntervals } from "@/lib/dayGrid";
import { capitalize, termsFor, type Terms } from "../../../../lib/vertical/terms";
import { leadStageDefinitionFromUnknown } from "@/lib/leadPipeline";

type AppointmentStatus = "scheduled" | "confirmed" | "arrived" | "no_show" | "cancelled";
type CalendarView = "grid" | "day" | "week" | "month" | "list";

type Appointment = {
  id: string;
  /** Ссылка на карточку клиента. Пустая строка — визит без привязки. */
  clientId: string;
  client: string;
  phone: string;
  whatsapp: string;
  service: string;
  /** Ссылка на строку справочника услуг. Пустая — услуга набрана текстом. */
  serviceId: string;
  doctor: string;
  /** Ссылка на строку справочника врачей. Пустая — врач набран текстом. */
  doctorId: string;
  startsAt: string;
  durationMinutes: number;
  /** Цена записи в тиынах; null — «цена не называлась», не ноль. */
  priceMinor: number | null;
  status: AppointmentStatus;
  notes: string;
  source: string;
};

type AppointmentForm = {
  clientId: string;
  client: string;
  phone: string;
  whatsapp: string;
  service: string;
  serviceId: string;
  doctor: string;
  doctorId: string;
  date: string;
  time: string;
  durationMinutes: number;
  /** Цена в ТЕНГЕ, строкой из поля ввода; пустая — «цена не называлась». */
  priceTenge: string;
  status: AppointmentStatus;
  notes: string;
  source: string;
};

type ApiResponse =
  | { success: true; mode?: string; warning?: string; data?: Record<string, unknown> }
  | { success: false; error: string; details?: string[] };

const APPOINTMENT_PREFILL_KEY = "negis_appointment_prefill";
const DEAL_PREFILL_KEY = "negis_deal_prefill";

/** Строка справочника услуг — ровно те поля, которые нужны форме записи. */
type CatalogService = {
  id: string;
  name: string;
  durationMinutes: number | null;
  /** Цена из прайса в тиынах — чтобы список услуг читался как у запись.кз. */
  basePriceMinor: number | null;
  sortOrder: number;
  isActive: boolean;
};

/**
 * Справочник услуг для формы записи.
 *
 * doctorId сужает прайс до услуг ЭТОГО мастера плюс общих услуг клиники.
 * Кто хозяин услуги, знает сервер, поэтому сужает он, а не клиентский фильтр:
 * иначе экран решал бы за прайс, чего в нём нет.
 *
 * Отказ здесь — не ошибка экрана: у роли может не быть права на чтение
 * каталога, а до применения миграции 032 его вовсе нет. В обоих случаях
 * правильный ответ один — пустой список, и поле «Услуга» остаётся тем же
 * текстовым вводом, что и раньше.
 *
 * Но наружу уходит ещё и признак «ответ получен»: пустой прайс мастера и
 * несостоявшийся запрос выглядят одинаково, а значат противоположное. Во
 * втором случае сужать список нельзя — экран соврал бы, что у мастера нет
 * услуг, и увёл бы у оператора уже сделанный выбор.
 */
async function loadCatalogServices(doctorId = ""): Promise<{ services: CatalogService[]; ok: boolean }> {
  if (!isRealWorkspace()) return { services: [], ok: false };
  try {
    const workspaceId = readCurrentWorkspaceId();
    const scope = doctorId ? `&doctorId=${encodeURIComponent(doctorId)}` : "";
    const response = await crmFetch(`/api/crm/clinic-services?workspaceId=${encodeURIComponent(workspaceId)}${scope}`);
    const text = await response.text();
    const body = text ? (JSON.parse(text) as { success?: boolean; mode?: string; data?: Record<string, unknown> }) : null;
    if (!response.ok || body?.success !== true || body.mode !== "supabase") return { services: [], ok: false };
    const raw = body.data?.services ?? body.data?.items;
    const list = Array.isArray(raw) ? raw : [];
    const services = list
      .map((item) => {
        const record = asRecord(item);
        const duration = record.durationMinutes ?? record.duration_minutes;
        const price = record.basePriceMinor ?? record.base_price_minor;
        return {
          id: readString(record.id),
          name: readString(record.name),
          durationMinutes: duration === null || duration === undefined || duration === "" ? null : readNumber(duration, 0) || null,
          // 0 — осознанное «бесплатно» из прайса, его нельзя ронять в null.
          basePriceMinor: price === null || price === undefined || price === "" ? null : readNumber(price, 0),
          sortOrder: readNumber(record.sortOrder ?? record.sort_order, 0),
          isActive:
            record.isActive === undefined && record.is_active === undefined
              ? true
              : Boolean(record.isActive ?? record.is_active),
        };
      })
      .filter((service) => service.id && service.name);
    return { services, ok: true };
  } catch {
    return { services: [], ok: false };
  }
}

/** Значение поля «Услуга», когда в каталоге нужной строки нет. */
const OTHER_SERVICE_OPTION = "__other__";

/** Строка справочника врачей — то, что нужно форме записи. */
type DirectoryDoctor = { id: string; fullName: string; specialty: string; sortOrder: number; isActive: boolean };

/** Строка графика врача. Минуты — от полуночи по времени клиники. */
type DoctorShift = {
  doctorId: string;
  weekday: number | null;
  onDate: string;
  onDateEnd: string;
  isWorking: boolean;
  startMinute: number | null;
  endMinute: number | null;
};

/**
 * Справочник врачей и график для формы записи.
 *
 * Флаг «включено» здесь сохраняется, в отличие от загрузчика услуг: форма по
 * нему выбирает между списком и текстовым полем, и «справочник выключен» не
 * имеет права выглядеть как «врачей нет».
 */
async function loadDirectory<T>(path: string, listKey: string, availableKey: string, map: (record: Record<string, unknown>) => T): Promise<{ items: T[]; available: boolean; timeZone: string }> {
  if (!isRealWorkspace()) return { items: [], available: false, timeZone: "" };
  try {
    const workspaceId = readCurrentWorkspaceId();
    const response = await crmFetch(`${path}?workspaceId=${encodeURIComponent(workspaceId)}`);
    const text = await response.text();
    const body = text ? (JSON.parse(text) as { success?: boolean; mode?: string; data?: Record<string, unknown> }) : null;
    if (!response.ok || body?.success !== true || body.mode !== "supabase") return { items: [], available: false, timeZone: "" };
    const raw = body.data?.[listKey] ?? body.data?.items;
    const list = Array.isArray(raw) ? raw : [];
    return {
      items: list.map((item) => map(asRecord(item))),
      available: body.data?.[availableKey] !== false,
      timeZone: readString(body.data?.timeZone),
    };
  } catch {
    return { items: [], available: false, timeZone: "" };
  }
}

function directoryDoctorFromApi(record: Record<string, unknown>): DirectoryDoctor {
  return {
    id: readString(record.id),
    fullName: readString(record.fullName) || readString(record.full_name),
    specialty: readString(record.specialty),
    sortOrder: readNumber(record.sortOrder ?? record.sort_order, 0),
    isActive:
      record.isActive === undefined && record.is_active === undefined
        ? true
        : Boolean(record.isActive ?? record.is_active),
  };
}

function doctorShiftFromApi(record: Record<string, unknown>): DoctorShift {
  const minute = (value: unknown) =>
    value === null || value === undefined || value === "" ? null : readNumber(value, 0);
  return {
    doctorId: readString(record.doctorId) || readString(record.doctor_id),
    weekday: minute(record.weekday),
    onDate: readString(record.onDate) || readString(record.on_date),
    onDateEnd: readString(record.onDateEnd) || readString(record.on_date_end),
    isWorking:
      record.isWorking === undefined && record.is_working === undefined
        ? true
        : Boolean(record.isWorking ?? record.is_working),
    startMinute: minute(record.startMinute ?? record.start_minute),
    endMinute: minute(record.endMinute ?? record.end_minute),
  };
}

/** Пояс ноутбука оператора. Ровно для того, чтобы сказать о расхождении. */
function readDeviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

const WEEKDAY_SHORT = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function formatShiftMinute(minute: number): string {
  const normalized = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

/**
 * Что сказать оператору про график выбранного врача на выбранный день.
 *
 * Третья строка обязательна: это единственное место, где продукт признаёт,
 * что для этого врача правило не работает вовсе.
 */
function shiftsForDate(shifts: DoctorShift[], dateKey: string, isoWeekday: number): DoctorShift[] {
  const covering = shifts.filter(
    (shift) => shift.onDate && shift.onDate <= dateKey && dateKey <= (shift.onDateEnd || shift.onDate),
  );
  // Исключение на дату замещает недельный образец целиком — как на сервере.
  return covering.length > 0 ? covering : shifts.filter((shift) => shift.weekday === isoWeekday);
}

function previousDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${previous.getUTCFullYear()}-${pad(previous.getUTCMonth() + 1)}-${pad(previous.getUTCDate())}`;
}

/**
 * Что сказать оператору про график выбранного врача на выбранный день.
 *
 * Повторяет решение сервера, включая ночной хвост предыдущего дня: подсказка,
 * расходящаяся с правилом, хуже отсутствующей — она обещает отказ там, где его
 * не будет, и наоборот.
 *
 * Строка «График не задан» обязательна: это единственное место, где продукт
 * признаёт, что для этого врача правило не работает вовсе.
 */
function describeDoctorDay(shifts: DoctorShift[], doctorId: string, dateKey: string, terms: Terms): string {
  if (!doctorId || !dateKey) return "";
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return "";
  const isoWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
  const mine = shifts.filter((shift) => shift.doctorId === doctorId);
  if (mine.length === 0) return "График не задан — запись не ограничивается.";

  const today = shiftsForDate(mine, dateKey, isoWeekday);
  const yesterdayWeekday = isoWeekday === 1 ? 7 : isoWeekday - 1;
  const yesterday = shiftsForDate(mine, previousDateKey(dateKey), yesterdayWeekday);

  const toInterval = (shift: DoctorShift) =>
    `${formatShiftMinute(shift.startMinute as number)}–${formatShiftMinute(shift.endMinute as number)}`;
  const working = (rows: DoctorShift[]) =>
    rows.filter((shift) => shift.isWorking && shift.startMinute !== null && shift.endMinute !== null);

  const intervals = working(today).map(toInterval);
  // Смена, начавшаяся вчера вечером, доживает до утра — правило её учитывает,
  // и подсказка обязана тоже.
  const overnight = working(yesterday)
    .filter((shift) => (shift.endMinute as number) > 1440)
    .map((shift) => `с вечера до ${formatShiftMinute(shift.endMinute as number)}`);

  const parts = [...intervals, ...overnight];
  if (parts.length === 0) return `${WEEKDAY_SHORT[isoWeekday]}: выходной (время ${terms.orgGenitive})`;
  return `${WEEKDAY_SHORT[isoWeekday]}: ${parts.join(", ")} (время ${terms.orgGenitive})`;
}
const activeStatuses: AppointmentStatus[] = ["scheduled", "confirmed", "arrived"];
const statusOptions: AppointmentStatus[] = ["scheduled", "confirmed", "arrived", "no_show", "cancelled"];
const viewLabels: Record<CalendarView, string> = {
  day: "День",
  grid: "Календарь",
  week: "Неделя",
  month: "Месяц",
  list: "Список",
};

const statusButtonLabels: Array<{ status: AppointmentStatus; label: string }> = [
  { status: "confirmed", label: "Подтвердить" },
  { status: "arrived", label: "Пришёл" },
  { status: "no_show", label: "Не пришёл" },
  { status: "cancelled", label: "Отменить" },
];

/**
 * Какие переходы осмысленны из каждого статуса.
 *
 * Прежде каждая карточка носила все четыре кнопки: день с восемью записями —
 * сорок восемь кнопок, и «Подтвердить» на уже пришедшем визите. «Не пришёл»
 * остаётся обратимым в «Пришёл» — клиент, опоздавший на полчаса, случается.
 */
const allowedStatusMoves: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ["confirmed", "arrived", "no_show", "cancelled"],
  confirmed: ["arrived", "no_show", "cancelled"],
  arrived: [],
  no_show: ["arrived"],
  cancelled: [],
};

const todayKeyAtLoad = toDateKey(new Date());

const appointmentsSeed: Appointment[] = [
  makeSeedAppointment("apt-1", todayKeyAtLoad, "10:00", "Айнур Садыкова", "+7 701 245 18 44", "Ботокс", "д-р Сауле", "confirmed", "Просит напомнить за час", "Instagram"),
  makeSeedAppointment("apt-2", todayKeyAtLoad, "11:30", "Мадина Ержан", "+7 777 311 09 18", "Консультация", "д-р Айжан", "scheduled", "Первичный визит", "ИИ таргетолог"),
  makeSeedAppointment("apt-3", todayKeyAtLoad, "14:00", "Ольга Петрова", "+7 705 812 44 02", "Чистка лица", "д-р Сауле", "arrived", "Повторная процедура", "WhatsApp"),
  makeSeedAppointment("apt-4", addDaysKey(todayKeyAtLoad, 1), "16:30", "Дана Мухамед", "+7 707 901 33 70", "Лазерная процедура", "д-р Наргиз", "scheduled", "Уточнить противопоказания", "Рекомендация"),
];

export function getAppointmentStatusLabel(status: string): string {
  const labels: Record<AppointmentStatus, string> = {
    scheduled: "Запланировано",
    confirmed: "Подтверждено",
    arrived: "Пришёл",
    no_show: "Не пришёл",
    cancelled: "Отменено",
  };
  return labels[normalizeStatus(status)] ?? "Запланировано";
}

export function getAppointmentStatusClass(status: string): string {
  const classes: Record<AppointmentStatus, string> = {
    scheduled: "bg-blue-50 text-blue-700",
    confirmed: "bg-emerald-50 text-emerald-700",
    arrived: "bg-teal-50 text-teal-700",
    no_show: "bg-amber-50 text-amber-700",
    cancelled: "bg-rose-50 text-rose-700",
  };
  return classes[normalizeStatus(status)] ?? classes.scheduled;
}

function makeSeedAppointment(
  id: string,
  date: string,
  time: string,
  client: string,
  phone: string,
  service: string,
  doctor: string,
  status: AppointmentStatus,
  notes: string,
  source: string,
): Appointment {
  return {
    id,
    clientId: "",
    client,
    phone,
    whatsapp: phone,
    service,
    // Демо-записи не ссылаются ни на каталог, ни на справочник врачей.
    serviceId: "",
    doctor,
    doctorId: "",
    startsAt: toStartsAt(date, time),
    durationMinutes: 60,
    priceMinor: null,
    status,
    notes,
    source,
  };
}

function normalizeStatus(status: string | undefined): AppointmentStatus {
  if (status === "confirmed" || status === "arrived" || status === "no_show" || status === "cancelled") return status;
  return "scheduled";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeKey(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toLocalDate(dateKey: string, timeKey = "09:00"): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = timeKey.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function toStartsAt(dateKey: string, timeKey: string): string {
  return toLocalDate(dateKey, timeKey).toISOString();
}

function dateKeyFromStartsAt(startsAt: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return todayKeyAtLoad;
  return toDateKey(date);
}

/**
 * Номер дня недели по ISO: 1 — понедельник, 7 — воскресенье.
 *
 * Дата берётся как календарный день, а не как мгновение: «2026-08-20» —
 * это день, и переводить его между поясами нельзя, иначе колонка графика
 * съедет на соседние сутки у оператора в другом поясе.
 */
function isoWeekdayOf(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return 1;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function timeKeyFromStartsAt(startsAt: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return "09:00";
  return toTimeKey(date);
}

function addDaysKey(dateKey: string, days: number): string {
  const date = toLocalDate(dateKey);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

function startOfWeekKey(dateKey: string): string {
  const date = toLocalDate(dateKey);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return toDateKey(date);
}

function formatDateLabel(dateKey: string): string {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(toLocalDate(dateKey));
}

function formatShortDate(dateKey: string): string {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" }).format(toLocalDate(dateKey));
}

function generateSlots(): string[] {
  const slots: string[] = [];
  for (let minutes = 9 * 60; minutes <= 21 * 60; minutes += 30) {
    slots.push(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
  }
  return slots;
}


function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function appointmentFromApi(value: unknown): Appointment {
  const record = asRecord(value);
  const startsAt = readString(record.startsAt) || readString(record.starts_at) || readString(record.time) || new Date().toISOString();
  const phone = readString(record.phone) || readString(record.client_phone) || readString(record.clientPhone);

  return {
    id: readString(record.id) || `appointment-${Date.now()}`,
    clientId: readString(record.clientId) || readString(record.client_id),
    client: readString(record.client) || readString(record.client_name) || readString(record.clientName) || "Клиент",
    phone,
    whatsapp: readString(record.whatsapp) || phone,
    service: readString(record.service) || "Консультация",
    serviceId: readString(record.serviceId) || readString(record.service_id),
    // Никакого имени по умолчанию. Запись без врача рисовалась как «д-р Сауле» —
    // именем, которого в базе нет, и оператор не мог отличить её от настоящей.
    doctor: readString(record.doctor) || readString(record.doctor_name) || readString(record.doctorName),
    doctorId: readString(record.doctorId) || readString(record.doctor_id),
    startsAt,
    durationMinutes: readNumber(record.durationMinutes ?? record.duration_minutes, 60),
    priceMinor: (() => { const raw = record.priceMinor ?? record.price_minor; return raw === null || raw === undefined || raw === "" ? null : readNumber(raw, 0); })(),
    status: normalizeStatus(readString(record.status)),
    notes: readString(record.notes),
    source: readString(record.source),
  };
}

function appointmentToApi(appointment: Appointment): Record<string, unknown> {
  return {
    id: appointment.id,
    clientId: appointment.clientId ?? "",
    client: appointment.client,
    clientName: appointment.client,
    phone: appointment.phone,
    clientPhone: appointment.phone,
    whatsapp: appointment.whatsapp,
    service: appointment.service,
    // Всегда, а не по условию: пустая строка — это осознанная отвязка, и
    // старая запись, которая её пришлёт, запишет null поверх null.
    serviceId: appointment.serviceId || "",
    doctor: appointment.doctor,
    doctorName: appointment.doctor,
    // Всегда, как и serviceId: пустая строка — осознанная отвязка.
    doctorId: appointment.doctorId || "",
    starts_at: appointment.startsAt,
    startsAt: appointment.startsAt,
    duration_minutes: appointment.durationMinutes,
    priceMinor: appointment.priceMinor,
    price_minor: appointment.priceMinor,
    durationMinutes: appointment.durationMinutes,
    status: appointment.status,
    notes: appointment.notes,
    source: appointment.source,
  };
}

async function safeJson(response: globalThis.Response): Promise<ApiResponse | null> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as ApiResponse;
  } catch {
    return null;
  }
}

/** «24.08» — коротко: год в архиве почти всегда текущий, а место в строке дорого. */
function formatVisitDay(startsAt: string): string {
  const parsed = new Date(startsAt);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function defaultForm(date: string, time = "09:00"): AppointmentForm {
  return {
    clientId: "",
    client: "",
    phone: "",
    whatsapp: "",
    service: "Консультация",
    serviceId: "",
    // Пусто, а не первый из выдуманных: регистратор, не тронувший поле,
    // заводил настоящий визит на несуществующего врача.
    doctor: "",
    doctorId: "",
    date,
    time,
    durationMinutes: 60,
    priceTenge: "",
    status: "scheduled",
    notes: "",
    source: "Ресепшн",
  };
}

function formFromAppointment(appointment: Appointment): AppointmentForm {
  return {
    clientId: appointment.clientId || "",
    client: appointment.client,
    phone: appointment.phone,
    whatsapp: appointment.whatsapp || appointment.phone,
    service: appointment.service,
    serviceId: appointment.serviceId || "",
    doctor: appointment.doctor,
    doctorId: appointment.doctorId || "",
    date: dateKeyFromStartsAt(appointment.startsAt),
    time: timeKeyFromStartsAt(appointment.startsAt),
    durationMinutes: appointment.durationMinutes,
    priceTenge: appointment.priceMinor === null || appointment.priceMinor === undefined ? "" : String(Math.round(appointment.priceMinor / 100)),
    status: appointment.status,
    notes: appointment.notes,
    source: appointment.source || "Ресепшн",
  };
}

function appointmentFromForm(form: AppointmentForm, existingId?: string): Appointment {
  return {
    id: existingId || `appointment-${Date.now()}`,
    clientId: form.clientId || "",
    client: form.client.trim(),
    phone: form.phone.trim(),
    whatsapp: (form.whatsapp || form.phone).trim(),
    service: form.service.trim(),
    serviceId: form.serviceId || "",
    doctor: form.doctor.trim(),
    doctorId: form.doctorId || "",
    startsAt: toStartsAt(form.date, form.time),
    // Цена уходит в тиынах; пустое поле, нечисло и минус — null, «цена не
    // называлась». Тот же вердикт даёт сервер: два слоя не должны кодировать
    // один ввод по-разному.
    priceMinor: (() => {
      const raw = Number(form.priceTenge);
      if (form.priceTenge.trim() === "" || !Number.isFinite(raw) || raw < 0) return null;
      return Math.round(raw) * 100;
    })(),
    durationMinutes: Math.max(1, Math.min(600, form.durationMinutes || 60)),
    status: form.status,
    notes: form.notes.trim(),
    source: form.source.trim(),
  };
}

/**
 * Отказ «слот занят» — не то же, что отказ базы: его показывают в модалке
 * рядом с кнопкой «Сохранить всё равно», а не тостом поверх закрытой формы.
 */
class SlotTakenError extends Error {
  readonly conflict: { startsAt: string; clientName: string; doctorName: string };

  constructor(conflict: { startsAt: string; clientName: string; doctorName: string }) {
    super("appointment_conflict");
    this.name = "SlotTakenError";
    this.conflict = conflict;
  }
}

/**
 * Отказ сервера с ПРИЧИНОЙ.
 *
 * Мастер салона прислал скриншот: «Не удалось создать запись. Проверьте
 * расписание перед повтором» — наш общий текст на любой отказ, кроме занятого
 * слота и нерабочего времени. Настоящая причина при этом приходила в ответе, а
 * экран выбрасывал её в console.warn, которого на телефоне не видно. Человек
 * оставался с советом, не имеющим отношения к делу.
 */
class ServerRefusalError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[]) {
    super(message);
    this.name = "ServerRefusalError";
    this.code = code;
    this.details = details;
  }
}

/** Коды сервера, у которых есть человеческий русский текст. */
const APPOINTMENT_ERROR_TEXTS: Record<string, string> = {
  workspace_access_denied: "Нет доступа к этой клинике. Выйдите и войдите заново.",
  authentication_required: "Сессия истекла — войдите заново.",
  storage_not_configured: "Сервис временно недоступен. Попробуйте через минуту.",
  unavailable: "База не ответила. Попробуйте ещё раз через минуту.",
  validation_error: "Проверьте поля формы: что-то заполнено не так.",
  permission_denied: "Вашей роли это действие недоступно.",
};

function refusalText(error: unknown): string {
  if (error instanceof ServerRefusalError) {
    const known = APPOINTMENT_ERROR_TEXTS[error.code];
    if (known) return known;
    // Детали сервера бывают техническими, но они КОНКРЕТНЫ — лучше показать их,
    // чем совет невпопад.
    const detail = error.details.filter(Boolean).join(", ") || error.message;
    return detail ? `Не удалось создать запись: ${detail}` : "Не удалось создать запись.";
  }
  // Сюда попадает и обрыв связи, брошенный до ответа, когда вставка уже могла
  // пройти, — поэтому не утверждаем, что на сервере ничего не осталось.
  return "Не удалось создать запись — связь оборвалась. Обновите список перед повтором: запись могла сохраниться.";
}

function conflictFromBody(body: unknown): SlotTakenError | null {
  const record = asRecord(body);
  if (readString(record.code) !== "appointment_conflict") return null;
  const conflict = asRecord(record.conflict);
  return new SlotTakenError({
    startsAt: readString(conflict.startsAt),
    clientName: readString(conflict.clientName),
    doctorName: readString(conflict.doctorName),
  });
}

/**
 * Отказ «врач не работает в это время» — свой класс, свой разбор и свой текст.
 *
 * Интервалы печатаются РОВНО так, как их прислал сервер: он уже перевёл их во
 * время клиники. Пересчитать их здесь значило бы показать время в поясе
 * ноутбука оператора — и два регистратора прочитали бы разное время в одном
 * и том же отказе про одну и ту же запись.
 */
class OutsideScheduleError extends Error {
  readonly schedule: { doctorName: string; localTime: string; weekdayLabel: string; intervals: string[] };

  constructor(schedule: OutsideScheduleError["schedule"]) {
    super("outside_doctor_schedule");
    this.name = "OutsideScheduleError";
    this.schedule = schedule;
  }
}

function scheduleRefusalFromBody(body: unknown): OutsideScheduleError | null {
  const record = asRecord(body);
  if (readString(record.code) !== "outside_doctor_schedule") return null;
  const schedule = asRecord(record.schedule);
  const intervals = Array.isArray(schedule.intervals) ? schedule.intervals.map((item) => readString(item)) : [];
  return new OutsideScheduleError({
    doctorName: readString(schedule.doctorName),
    localTime: readString(schedule.localTime),
    weekdayLabel: readString(schedule.weekdayLabel),
    intervals: intervals.filter(Boolean),
  });
}

function describeSchedule(error: OutsideScheduleError, terms: Terms): string {
  const who = error.schedule.doctorName || capitalize(terms.specialist);
  const when = [error.schedule.weekdayLabel, error.schedule.localTime].filter(Boolean).join(", ");
  const hours = error.schedule.intervals.length > 0
    ? `Часы ${terms.dutyGenitive}: ${error.schedule.intervals.join(", ")}.`
    : `В этот день ${terms.dutyGenitive} нет.`;
  return `${who} не работает в это время${when ? ` (${when}, время ${terms.orgGenitive})` : ""}. ${hours} Записать всё равно?`;
}

function describeConflict(error: SlotTakenError, terms: Terms): string {
  const at = error.conflict.startsAt ? timeKeyFromStartsAt(error.conflict.startsAt) : "";
  const who = error.conflict.clientName || `другой ${terms.customer}`;
  return `У ${terms.specialistGenitive} уже есть запись на это время: ${who}${at ? `, ${at}` : ""}. Выберите другое время или другого ${terms.specialistGenitive}.`;
}

function appointmentInterval(appointment: Appointment) {
  const start = new Date(appointment.startsAt).getTime();
  return {
    start,
    end: start + appointment.durationMinutes * 60_000,
  };
}

/**
 * Попадает ли запись в календарный день клиники.
 *
 * Не то же самое, что dateKeyFromStartsAt: тот считает день по поясу
 * устройства и живёт в паре с timeKeyFromStartsAt, обслуживая форму
 * редактирования. Здесь же сравниваются списки, а вторая сторона сравнения —
 * todayKey — посчитана в поясе клиники. Пока эти две половины считались в
 * разных поясах, «Сегодня записей» было верно ровно в том случае, когда пояса
 * совпадают, то есть именно тогда, когда исправлять было нечего: в UTC+5 на
 * ноутбуке по Гринвичу карточка называла число записей за чужие сутки.
 */
function isOnDay(appointment: Appointment, dateKey: string, timeZone: string): boolean {
  return isOnClinicDay(appointment.startsAt, dateKey, timeZone);
}

function isWithinWeek(appointment: Appointment, weekStart: string, timeZone: string): boolean {
  const instant = Date.parse(appointment.startsAt);
  // Прежняя версия на нечитаемой дате подставляла todayKeyAtLoad и молча
  // относила такую запись к сегодняшней неделе. Нечитаемая дата — это «не
  // знаю», а не «сегодня».
  if (!Number.isFinite(instant)) return false;

  const appointmentDate = dayKeyInZone(instant, timeZone);
  const start = toLocalDate(weekStart).getTime();
  const end = toLocalDate(addDaysKey(weekStart, 7)).getTime();
  const current = toLocalDate(appointmentDate).getTime();
  return current >= start && current < end;
}

function statusBadge(status: AppointmentStatus) {
  return <span className={`rounded-full px-3 py-1 text-xs font-bold ${getAppointmentStatusClass(status)}`}>{getAppointmentStatusLabel(status)}</span>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-[#94A3B8]">{label}</p>
      <div className="mt-1 break-words text-sm font-semibold text-[#334155]">{children}</div>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">{label}</span>
      <select className="neu-input w-full" value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">{label}</span>
      <input className="neu-input w-full" type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function AppointmentCard({
  appointment,
  onEdit,
  onStatus,
  onSale,
}: {
  appointment: Appointment;
  onEdit: (appointment: Appointment) => void;
  onStatus: (appointment: Appointment, status: AppointmentStatus) => void;
  onSale: (appointment: Appointment) => void;
}) {
  const { vertical } = useAuth();
  const terms = termsFor(vertical);
  const startTime = timeKeyFromStartsAt(appointment.startsAt);
  const whatsapp = appointment.whatsapp || appointment.phone;
  const moves = allowedStatusMoves[appointment.status] || [];

  return (
    <article
      className="neu-sm cursor-pointer p-4"
      role="button"
      tabIndex={0}
      onClick={() => onEdit(appointment)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onEdit(appointment);
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-lg font-black text-[#1A56DB]">{startTime}</p>
          <h3 className="mt-1 break-words text-base font-black text-[#0F172A]">{appointment.client}</h3>
          <p className="mt-1 text-sm text-[#64748B]">{formatPhone(appointment.phone)}</p>
        </div>
        {statusBadge(appointment.status)}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Detail label="Услуга">{appointment.service}</Detail>
        <Detail label={capitalize(terms.specialist)}>{appointment.doctor}</Detail>
        <Detail label="Длительность">{appointment.durationMinutes} мин</Detail>
        <Detail label="Источник">{appointment.source || "Ресепшн"}</Detail>
      </div>

      {appointment.notes ? <p className="mt-3 rounded-xl bg-[#F8FAFC] px-3 py-2 text-sm text-[#64748B]">{appointment.notes}</p> : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" onClick={(event) => event.stopPropagation()}>
        {statusButtonLabels
          .filter(({ status }) => moves.includes(status))
          .map(({ status, label }) => (
            <button key={status} type="button" className="neu-btn px-3 py-2 text-xs" onClick={() => onStatus(appointment, status)}>
              {label}
            </button>
          ))}
        {/* Пришёл — значит платит: продажа стартует с записи, а не с чистой
            формы, где клиента и запись пришлось бы выбирать заново. */}
        {appointment.status === "arrived" ? (
          <button type="button" className="neu-btn-primary px-3 py-2 text-xs" onClick={() => onSale(appointment)}>
            Оформить продажу
          </button>
        ) : null}
        <a className="neu-btn px-3 py-2 text-xs" href={toWhatsappHref(whatsapp, `Здравствуйте, ${appointment.client}! Напоминаем о записи ${startTime}.`)} target="_blank" rel="noreferrer">
          <MessageCircle size={14} />
          WhatsApp
        </a>
        <a className="neu-btn px-3 py-2 text-xs" href={toTelHref(appointment.phone)}>
          <PhoneCall size={14} />
          Позвонить
        </a>
      </div>
    </article>
  );
}

export function AppointmentsPage() {
  const { vertical, userRole } = useAuth();
  const terms = termsFor(vertical);
  const [, setLocation] = useLocation();
  // Заявка, из которой пришла эта запись: после успешного создания она сама
  // переводится в «Записана», и регистратор не ищет её руками.
  const prefillLeadRef = useRef("");
  const [selectedDate, setSelectedDate] = useState(todayKeyAtLoad);
  // Общая картина дня — владельцу и администратору. Ресепшн работает в
  // прежних видах: ему ничего не отнимаем, но и новый экран не навязываем.
  // Ресепшн и управляющий читают все записи клиники тем же правом, что и
  // владелец, — сервер не сужает их до «своих». Закрывать им сетку значило
  // бы прятать то, что список и так показывает, только в неудобном виде.
  const seesWholeClinic =
    userRole === "owner" || userRole === "admin" || userRole === "manager" || userRole === "receptionist";
  // Роли с полным чтением клиники попадают сразу в сетку по мастерам:
  // «нажал кнопку — и в календаре». Мастеру сетка недоступна, ему день.
  const [view, setView] = useState<CalendarView>(() =>
    userRole === "owner" || userRole === "admin" || userRole === "manager" || userRole === "receptionist"
      ? "grid"
      : "day",
  );
  const [doctorFilter, setDoctorFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [serviceFilter, setServiceFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AppointmentForm>(() => defaultForm(todayKeyAtLoad));


  // Ref заявки живёт только в той сессии модалки, которую открыл префилл:
  // модалка, закрытая без сохранения, обязана разрядить его — иначе следующая
  // созданная запись, про совсем другого клиента, перевела бы ЧУЖУЮ заявку в
  // «Записана». На монтировании модалка закрыта и ref пуст — стирать нечего;
  // префилл заряжает ref и открывает модалку строго после этого эффекта.
  useEffect(() => {
    if (!modalOpen) prefillLeadRef.current = "";
  }, [modalOpen]);
  const [conflictMessage, setConflictMessage] = useState("");
  // Создание теперь ждёт сервер, а модалка остаётся открытой всё это время.
  // Без этого второй клик по «Создать запись» или «Сохранить всё равно»
  // отправлял второй POST: при allowConflict сервер не проверяет ничего, а
  // toRow не переносит клиентский id — получались две одинаковые записи.
  const [saving, setSaving] = useState(false);

  const [catalog, setCatalog] = useState<CatalogService[]>([]);
  // Прайс, суженный под выбранного в форме мастера. Отдельное состояние, а не
  // замена catalog: тот питает фильтр списка записей, и сужать его под форму
  // значило бы прятать из фильтра услуги, которые в записях уже стоят.
  const [doctorCatalog, setDoctorCatalog] = useState<{ doctorId: string; services: CatalogService[]; canPrune: boolean } | null>(null);
  // Подпись под полем «Услуга»: почему выбор сбросился или почему прайс не сузился.
  const [serviceScopeNotice, setServiceScopeNotice] = useState("");
  // Мастер, под которого прайс уже сужен в ЭТОЙ сессии модалки. Отличает смену
  // мастера оператором от первого открытия карточки: на открытии снимать связь
  // с услугой нельзя — это молча переписало бы уже сохранённую запись.
  const scopedDoctorRef = useRef<string | null>(null);
  const [directory, setDirectory] = useState<{ items: DirectoryDoctor[]; available: boolean }>({ items: [], available: false });

  // Сетка без единой карточки мастера — заглушка «Справочник пуст», хотя
  // записи дня существуют (свободным вводом имён). Пока справочник пуст,
  // честнее открыть день. Эффект не спорит с человеком: выбранный руками
  // вид не трогается, переключение происходит один раз на загрузке.
  const emptyDirectoryHandled = useRef(false);
  useEffect(() => {
    if (emptyDirectoryHandled.current) return;
    if (!directory.available) return;
    emptyDirectoryHandled.current = true;
    if (directory.items.filter((doctor) => doctor.isActive).length === 0) {
      setView((current) => (current === "grid" ? "day" : current));
    }
  }, [directory]);
  const [shifts, setShifts] = useState<DoctorShift[]>([]);
  const [clinicTimeZone, setClinicTimeZone] = useState("");
  // Прочитать график не удалось — это НЕ то же самое, что «пояс не задан».
  // Утверждать второе, когда верно первое, — ровно та подмена, которую этот
  // продукт ловит у себя везде остальное.
  const [scheduleReadable, setScheduleReadable] = useState(true);
  const [scheduleMessage, setScheduleMessage] = useState("");
  const deviceTimeZone = useMemo(() => readDeviceTimeZone(), []);

  /**
   * Сегодняшний день клиники — состояние, а не константа модуля.
   *
   * Прежде «сегодня» вычислялось один раз при загрузке страницы, поэтому
   * вкладка, оставленная на ночь, бесконечно показывала вчерашнее «Сегодня
   * записей». Минутный тик стоит ничего и переводит счётчик ровно в полночь
   * клиники, а не в полночь ноутбука.
   */
  const [todayKey, setTodayKey] = useState(() => clinicToday(""));

  useEffect(() => {
    const tick = () => setTodayKey(clinicToday(clinicTimeZone));
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [clinicTimeZone]);

  // Пояс приезжает вместе со списком, то есть уже после первого рендера, а
  // выбранный день до этого момента — день устройства. Как только пояс известен,
  // открытый день переводится на сутки клиники — но только если оператор ещё
  // ничего не выбрал сам. Иначе экран отнимал бы у него выбор на каждой
  // загрузке.
  useEffect(() => {
    if (!clinicTimeZone) return;
    setSelectedDate((current) => (current === todayKeyAtLoad ? clinicToday(clinicTimeZone) : current));
  }, [clinicTimeZone]);

  useEffect(() => {
    let cancelled = false;
    // Весь прайс клиники: он питает фильтр списка записей, поэтому под
    // выбранного в форме мастера не сужается — иначе из фильтра пропали бы
    // услуги, которые в записях уже есть.
    void loadCatalogServices().then((result) => {
      if (!cancelled) setCatalog(result.services);
    });
    void loadDirectory("/api/crm/clinic-doctors", "doctors", "directoryAvailable", directoryDoctorFromApi).then((result) => {
      if (!cancelled) setDirectory(result);
    });
    void loadDirectory("/api/crm/doctor-schedule", "shifts", "scheduleAvailable", doctorShiftFromApi).then((result) => {
      if (cancelled) return;
      setShifts(result.items);
      // Пояс приходит вместе с графиком: маршрут настроек доступен только
      // владельцу и администратору, и регистратор получил бы оттуда отказ.
      setClinicTimeZone(result.timeZone);
      setScheduleReadable(result.available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Прайс сужается под выбранного мастера.
   *
   * Список перезапрашивается с doctorId, а не фильтруется здесь: у услуги есть
   * хозяин, и какая из них общая, а какая чужая, знает только сервер. Мастер не
   * выбран — поведение прежнее, весь прайс клиники.
   */
  useEffect(() => {
    if (!modalOpen) {
      // Закрытая модалка стирает память о мастере: следующее открытие снова
      // считается первым, и выбор услуги на нём не трогается.
      scopedDoctorRef.current = null;
      setServiceScopeNotice("");
      return;
    }

    const doctorId = form.doctorId;
    // null — прайс в этой сессии модалки ещё не сужали, значит это открытие
    // карточки, а не смена мастера оператором.
    const previous = scopedDoctorRef.current;
    const changedByOperator = previous !== null && previous !== doctorId;

    if (!doctorId) {
      scopedDoctorRef.current = "";
      setDoctorCatalog(null);
      setServiceScopeNotice("");
      return;
    }

    let cancelled = false;
    void loadCatalogServices(doctorId).then((result) => {
      // Ответ про прошлого мастера, пришедший вторым, переписал бы список уже
      // выбранного: эффект гасит собственные догоняющие ответы.
      if (cancelled) return;
      if (!result.ok) {
        // Отказ и «услуг нет» на экране неразличимы, поэтому сужения не будет:
        // остаётся весь прайс, а причина говорится вслух.
        setDoctorCatalog(null);
        setServiceScopeNotice("Не удалось загрузить прайс мастера — показан весь прайс клиники");
        return;
      }
      // Отметка ставится только на применённом списке: пока сужение не
      // доехало, следующий запуск обязан считать мастера всё ещё прежним.
      scopedDoctorRef.current = doctorId;
      setDoctorCatalog({ doctorId, services: result.services, canPrune: changedByOperator });
      setServiceScopeNotice("");
    });
    return () => {
      cancelled = true;
    };
  }, [modalOpen, form.doctorId]);

  // Закрыли модалку — забыли всё, что знали про прайс мастера.
  //
  // Иначе следующее открытие начинается с чужим сужением и с уже взведённым
  // canPrune: карточка сохранённой записи, открытая на правку, молча теряла
  // связь с услугой — «сброс вслух» срабатывал там, где оператор ничего не
  // менял. Ссылка scopedDoctorRef обнуляется вместе с состоянием, иначе она
  // соврёт следующему запуску, что мастера уже применяли.
  useEffect(() => {
    if (modalOpen) return;
    setDoctorCatalog(null);
    setServiceScopeNotice("");
    scopedDoctorRef.current = "";
  }, [modalOpen]);

  /**
   * Услуга, выбранная под прошлого мастера, могла не пережить сужение прайса.
   *
   * Пустое поле без объяснения оператор прочитал бы как сбой экрана, поэтому
   * связь снимается вслух — подписью под полем. Сверка идёт с ПОЛНЫМ ответом
   * сервера, а не с активными строками: услуга этого же мастера, уехавшая в
   * архив, связи не теряет — её показывает отдельный вариант списка.
   */
  useEffect(() => {
    if (!doctorCatalog || !doctorCatalog.canPrune) return;
    if (doctorCatalog.doctorId !== form.doctorId) return;
    if (!form.serviceId) return;
    if (doctorCatalog.services.some((service) => service.id === form.serviceId)) {
      setServiceScopeNotice("");
      return;
    }
    setServiceScopeNotice(
      form.service
        ? `Услуга «${form.service}» не входит в прайс выбранного ${terms.specialistGenitive} — выберите услугу заново`
        : `Прежняя услуга не входит в прайс выбранного ${terms.specialistGenitive} — выберите услугу заново`,
    );
    // Снимается ровно связь со справочником. Снимок названия остаётся: его
    // правят руками, и стереть правку из-за смены мастера — потерять данные,
    // а название названо в подписи, так что оператор видит, что было.
    setForm((current) => ({ ...current, serviceId: "", priceTenge: "" }));
  }, [doctorCatalog, form.doctorId, form.service, form.serviceId, terms.specialistGenitive]);

  /** Активные врачи в порядке справочника — то, из чего выбирают в форме. */
  const activeDoctors = useMemo(
    () => directory.items
      .filter((doctor) => doctor.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.fullName.localeCompare(b.fullName, "ru")),
    [directory.items],
  );

  const { items, loaded, loadError, addItem, setItems } = useDemoCollection<Appointment>("negis_demo_appointments", appointmentsSeed, {
    endpoint: "/api/crm/appointments",
    listKey: "appointments",
    toApi: appointmentToApi,
    fromApi: appointmentFromApi,
  });

  // Справочник плюс то, что уже записано. Объединение обязательно: фильтр
  // сравнивает СНИМОК имени на равенство строк, поэтому без исторических
  // написаний старые записи перестали бы находиться.
  const doctors = useMemo(
    () => Array.from(new Set([
      ...activeDoctors.map((doctor) => doctor.fullName),
      ...items.map((item) => item.doctor).filter(Boolean),
    ])).sort((a, b) => a.localeCompare(b, "ru")),
    [activeDoctors, items],
  );

  // Фильтр сравнивает СНИМОК названия на равенство строк, поэтому список
  // значений обязан быть объединением каталога и того, что уже записано.
  // Без объединения любое историческое написание перестало бы находиться —
  // а до применения 032 каталог пуст и весь список состоит из истории.
  const services = useMemo(
    () => Array.from(new Set([...catalog.map((service) => service.name), ...items.map((item) => item.service).filter(Boolean)])).sort(),
    [catalog, items],
  );

  /**
   * Прайс, из которого выбирает форма: у выбранного мастера — его услуги плюс
   * общие услуги клиники, пока мастер не выбран — весь прайс, как и раньше.
   * Пока сужение едет с сервера, показывается прежний полный список: пустой
   * на эти доли секунды читался бы как «услуг нет».
   */
  const formCatalog = useMemo(
    () => (doctorCatalog && doctorCatalog.doctorId === form.doctorId ? doctorCatalog.services : catalog),
    [catalog, doctorCatalog, form.doctorId],
  );

  /** Активные услуги в порядке справочника — то, из чего выбирают в форме. */
  const activeCatalog = useMemo(
    () => formCatalog.filter((service) => service.isActive).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ru")),
    [formCatalog],
  );

  // Сужение до нуля тоже надо сказать словами: поле «Услуга» само собой
  // превратилось бы в текстовый ввод, и оператор решил бы, что справочник
  // сломался.
  const serviceScopeText = serviceScopeNotice
    || (doctorCatalog && doctorCatalog.doctorId === form.doctorId && activeCatalog.length === 0
      ? `В прайсе выбранного ${terms.specialistGenitive} нет услуг — впишите название вручную`
      : "");
  const serviceScopeHint = serviceScopeText ? (
    <p className="mt-1 text-[11px] font-semibold text-amber-700" data-testid="appointment-service-scope">
      {serviceScopeText}
    </p>
  ) : null;
  const slots = useMemo(() => generateSlots(), []);

  const weekStart = useMemo(() => startOfWeekKey(selectedDate), [selectedDate]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDaysKey(weekStart, index)), [weekStart]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Selection-2: a handoff belongs to the clinic it was made in.
    const prefillKey = workspaceScopedKey(APPOINTMENT_PREFILL_KEY);

    try {
      const raw = window.localStorage.getItem(prefillKey);
      if (!raw) return;
      const prefill = JSON.parse(raw) as Record<string, unknown>;
      const nextForm = {
        ...defaultForm(selectedDate),
        // Заявка передаёт карточку клиента с самого начала — терялась она здесь.
        clientId: readString(prefill.clientId),
        client: readString(prefill.clientName) || readString(prefill.name),
        phone: readString(prefill.phone),
        whatsapp: readString(prefill.whatsapp) || readString(prefill.phone),
        service: readString(prefill.service) || "Консультация",
        source: readString(prefill.source) || "CRM",
      };
      setForm(nextForm);
      prefillLeadRef.current = readString(prefill.leadId);
      setEditingId(null);
      setModalOpen(true);
      window.localStorage.removeItem(prefillKey);
    } catch {
      window.localStorage.removeItem(prefillKey);
    }
  }, [selectedDate]);

  /**
   * Заявка → «Записана» после успешно созданной записи.
   *
   * Стадия берётся из настроенного пайплайна клиники (semanticGroup booked);
   * если структурных стадий нет — канонический статус booked, тот же, что
   * ставит рука регистратора. Отказ не трогает созданную запись: заявка
   * остаётся как была, и об этом говорится вслух.
   */
  const markLeadBooked = async (leadId: string) => {
    // Демо-пространство живёт в localStorage чужой страницы: PATCH к серверу
    // ответил бы 200 mode:"demo", ничего не изменив, и тост солгал бы. Фича
    // работает там, где работают настоящие заявки — в реальной клинике.
    if (!isRealWorkspace()) return;
    try {
      let status = "booked";
      let stageId = "";
      try {
        const response = await crmFetch(`/api/crm/lead-stages?workspaceId=${encodeURIComponent(readCurrentWorkspaceId())}`);
        const body = (await response.json()) as { success?: boolean; data?: Record<string, unknown> };
        const rawStages = body?.data?.stages;
        const stages = (Array.isArray(rawStages) ? rawStages : [])
          .map((item) => leadStageDefinitionFromUnknown(item))
          .filter((item): item is NonNullable<typeof item> => item !== null);
        const booked = stages
          .filter((stage) => stage.semanticGroup === "booked" && stage.isActive)
          .sort((a, b) => a.sortOrder - b.sortOrder)[0];
        if (booked) {
          status = booked.stageKey;
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(booked.id)) stageId = booked.id;
        }
      } catch {
        // Пайплайн не прочитался — канонический booked всё равно честен.
      }
      const response = await crmFetch(`/api/crm/leads?workspaceId=${encodeURIComponent(readCurrentWorkspaceId())}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: leadId,
          workspaceId: readCurrentWorkspaceId(),
          status,
          ...(stageId ? { stageId } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as { success?: boolean; mode?: string } | null;
      // 200 с mode:"demo" — это «сервер ничего не записал»: тот же порог, что
      // у создания записи строкой выше.
      if (!response.ok || body?.success !== true || body.mode !== "supabase") throw new Error(String(response.status));
      toast.success("Заявка переведена в «Записана»");
    } catch (error) {
      console.warn("appointments: lead stage update refused", error instanceof Error ? error.message : error);
      toast.error("Запись создана, но заявка не переведена в «Записана» — переключите стадию вручную.");
    }
  };

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items
      .filter((appointment) => {
        if (doctorFilter !== "all" && appointment.doctor !== doctorFilter) return false;
        if (statusFilter !== "all" && appointment.status !== statusFilter) return false;
        if (serviceFilter !== "all" && appointment.service !== serviceFilter) return false;
        if (!query) return true;
        return `${appointment.client} ${appointment.phone} ${appointment.whatsapp}`.toLowerCase().includes(query);
      })
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [doctorFilter, items, search, serviceFilter, statusFilter]);

  const dayAppointments = useMemo(
    () => filteredItems.filter((appointment) => isOnDay(appointment, selectedDate, clinicTimeZone)),
    [filteredItems, selectedDate, clinicTimeZone],
  );

  /**
   * Записи, разложенные по строкам дневной сетки.
   *
   * Раньше строка искала записи точным совпадением времени: `timeKeyFromStartsAt
   * (...) === slot`. Сетка идёт получасовыми шагами с 09:00 до 21:00, поэтому
   * визит в 10:15 не попадал ни в 10:00, ни в 10:30 и ИСЧЕЗАЛ с экрана дня —
   * при том что счётчик над сеткой его считал. Оператор видел «7 записей» и
   * шесть карточек.
   *
   * Теперь запись попадает в ту строку, в которую она попадает по времени: в
   * последнюю, чьё начало не позже её собственного. А всё, что вне сетки —
   * раньше открытия, позже закрытия или с нечитаемой датой, — собирается
   * отдельно и показывается над ней. Спрятать такую запись нельзя: именно она
   * чаще всего и есть ошибка, которую оператор ищет.
   */
  const dayBuckets = useMemo(() => {
    const buckets = new Map<string, Appointment[]>(slots.map((slot) => [slot, [] as Appointment[]]));
    const outside: Appointment[] = [];

    const minutesOf = (value: string) => {
      const [hours, minutes] = value.split(":").map(Number);
      return hours * 60 + minutes;
    };
    const slotMinutes = slots.map(minutesOf);

    for (const appointment of dayAppointments) {
      const instant = Date.parse(appointment.startsAt);
      if (!Number.isFinite(instant)) {
        outside.push(appointment);
        continue;
      }
      const minutes = minutesOf(timeKeyFromStartsAt(appointment.startsAt));
      let index = -1;
      for (let i = 0; i < slotMinutes.length; i += 1) {
        if (slotMinutes[i] <= minutes) index = i;
      }
      if (index < 0) {
        outside.push(appointment);
        continue;
      }
      buckets.get(slots[index])!.push(appointment);
    }

    return { buckets, outside };
  }, [dayAppointments, slots]);
  const weekAppointments = useMemo(
    () => filteredItems.filter((appointment) => isWithinWeek(appointment, weekStart, clinicTimeZone)),
    [filteredItems, weekStart, clinicTimeZone],
  );
  const todayAppointments = useMemo(
    () => items.filter((appointment) => isOnDay(appointment, todayKey, clinicTimeZone)),
    [items, todayKey, clinicTimeZone],
  );
  const nextAppointment = useMemo(() => {
    const now = Date.now();
    return items
      .filter((appointment) => activeStatuses.includes(appointment.status) && new Date(appointment.startsAt).getTime() >= now)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];
  }, [items]);

  /**
   * Свободное время под форму — как шаг «выберите время» в запись.кз.
   *
   * Всё считается по часам САЛОНА: и день записи (isOnDay), и минуты
   * (minuteOfClinicDay). Ревью поймало смешение «день по устройству, минута по
   * салону» — тот же класс бага, который в этом файле уже чинили для карточки
   * «Сегодня записей» (см. комментарий к isOnDay).
   *
   * Клик по слоту пишет время в form.time, а сохранение читает его по часам
   * устройства — поэтому при несовпадении поясов секция прячется с объяснением:
   * показывать «свободно 16:00», записывая на 18:00, хуже, чем не показывать.
   *
   * Правит по-прежнему сервер: он ответит 409 на пересечение, даже если сетка
   * устарела за время раздумий.
   */
  const formSlots = useMemo(() => {
    if (!form.date) return null;
    const [year, month, day] = form.date.split("-").map(Number);
    if (!year || !month || !day) return null;

    // Мастеру селект специалиста не показывается — сервер и так запишет
    // клиента к нему. Его карточку узнаём по его же записям: чужих в items у
    // него не бывает, сервер сузил список до его работы.
    const ownDoctorId = userRole === "doctor" && !form.doctorId
      ? items.find((appointment) => appointment.doctorId)?.doctorId ?? ""
      : "";
    const doctorId = form.doctorId || ownDoctorId;
    if (!doctorId && userRole !== "doctor") return null;

    if (clinicTimeZone && deviceTimeZone && clinicTimeZone !== deviceTimeZone) {
      return { groups: [] as ReturnType<typeof groupSlots>, reason: "другой пояс" as const };
    }

    const isoWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
    const gridShifts = shifts.map((shift) => ({
      doctorId: shift.doctorId,
      weekday: shift.weekday,
      onDate: shift.onDate,
      onDateEnd: shift.onDateEnd,
      isWorking: shift.isWorking,
      startMinute: shift.startMinute,
      endMinute: shift.endMinute,
    }));

    // «График описывает ЭТОТ день», а не «у мастера есть хоть одна строка»:
    // единственная строка-отпуск на сентябрь не должна закрывать весь август.
    const mine = gridShifts.filter((shift) => shift.doctorId === doctorId);
    const definesThisDay = mine.some((shift) => {
      const from = shift.onDate;
      const to = shift.onDateEnd || from;
      if (from && from <= form.date && form.date <= to) return true;
      return shift.weekday === isoWeekday;
    });
    const intervals = definesThisDay
      ? workingIntervals(gridShifts, doctorId, form.date, isoWeekday)
      : ([[9 * 60, 21 * 60]] as Array<[number, number]>);

    const busy = items
      .filter((appointment) => {
        if (appointment.id === editingId) return false;
        if (!activeStatuses.includes(appointment.status)) return false;
        if (!isOnDay(appointment, form.date, clinicTimeZone)) return false;
        if (doctorId && appointment.doctorId) return appointment.doctorId === doctorId;
        if (!doctorId) return true;
        const name = (appointment.doctor || "").trim().toLowerCase();
        const card = activeDoctors.find((entry) => entry.id === doctorId);
        return Boolean(name) && name === (card?.fullName || "").trim().toLowerCase();
      })
      .map((appointment) => {
        const startMinute = minuteOfClinicDay(appointment.startsAt, clinicTimeZone);
        if (startMinute === null) return null;
        return [startMinute, startMinute + (appointment.durationMinutes || 60)] as [number, number];
      })
      .filter((interval): interval is [number, number] => interval !== null);

    const nowMinute = form.date === todayKey ? minuteOfClinicDay(new Date().toISOString(), clinicTimeZone) : null;
    const slots = freeSlots({ intervals, busy, durationMinutes: form.durationMinutes, nowMinute });

    // Пустота пустоте рознь: «всё занято» — только когда виновата занятость.
    let reason: "закрыт" | "занято" | "день кончился" | "не помещается" | null = null;
    if (slots.length === 0) {
      if (definesThisDay && intervals.length === 0) reason = "закрыт";
      else if (
        nowMinute !== null &&
        freeSlots({ intervals, busy, durationMinutes: form.durationMinutes, nowMinute: null }).length > 0
      ) reason = "день кончился";
      else if (busy.length === 0) reason = "не помещается";
      else reason = "занято";
    }
    return { groups: groupSlots(slots), reason };
  }, [form.date, form.doctorId, form.durationMinutes, shifts, items, editingId, activeDoctors, clinicTimeZone, deviceTimeZone, todayKey, userRole]);

  /**
   * Архив клиента — просьба владельца дословно: «сбоку, когда записываешь,
   * должен быть архив: видно, кого числа какая услуга была, во сколько и к
   * какому мастеру». То же самое — «история посещений» в запись.кз.
   *
   * Ищется по связанной карточке, затем по телефону (последние десять цифр),
   * затем по точному имени. Источник — уже загруженный список записей: у
   * администратора это весь салон, у мастера сервер его сузил до собственной
   * работы — значит и архив мастера честно показывает только его визиты.
   */
  const visitHistory = useMemo(() => {
    const digitsOf = (value: string) => (value || "").replace(/\D/g, "").slice(-10);
    const phoneKey = digitsOf(form.phone) || digitsOf(form.whatsapp);
    const nameKey = form.client.trim().toLowerCase();
    if (!form.clientId && phoneKey.length < 10 && nameKey.length < 2) return [];
    return items
      .filter((appointment) => {
        if (editingId && appointment.id === editingId) return false;
        if (form.clientId && appointment.clientId) return appointment.clientId === form.clientId;
        const appointmentPhone = digitsOf(appointment.phone) || digitsOf(appointment.whatsapp);
        if (phoneKey.length >= 10 && appointmentPhone) return appointmentPhone === phoneKey;
        return nameKey.length >= 2 && appointment.client.trim().toLowerCase() === nameKey;
      })
      .sort((left, right) => (right.startsAt || "").localeCompare(left.startsAt || ""))
      .slice(0, 8);
  }, [items, form.clientId, form.phone, form.whatsapp, form.client, editingId]);

  const openCreate = (date = selectedDate, time = "09:00") => {
    setEditingId(null);
    setConflictMessage("");
    setScheduleMessage("");
    // Врач из активного фильтра — то, что регистратор и так выбрал глазами.
    const preselected = doctorFilter !== "all"
      ? activeDoctors.find((doctor) => doctor.fullName === doctorFilter)
      : undefined;
    setForm({
      ...defaultForm(date, time),
      ...(doctorFilter !== "all" ? { doctor: doctorFilter, doctorId: preselected?.id ?? "" } : {}),
    });
    setModalOpen(true);
  };

  const openEdit = (appointment: Appointment) => {
    // Обе панели закрываются: отказ, оставшийся от прошлой записи, предлагал бы
    // «Записать вне графика» для совсем другого визита.
    setConflictMessage("");
    setScheduleMessage("");
    setEditingId(appointment.id);
    setConflictMessage("");
    setForm(formFromAppointment(appointment));
    setModalOpen(true);
  };

  /**
   * fields — какие поля записи отправлять.
   *
   * По умолчанию уходит вся карточка: так работает форма, где оператор видел
   * и правил всё сразу. Но клик по статусу («Пришёл», «Подтверждена») правит
   * ОДНО поле, а слал тоже всю карточку — значениями из вкладки, открытой,
   * может быть, полчаса назад. Если за это время коллега переставил время или
   * сменил услугу, его правка молча возвращалась к старой. Точечные действия
   * теперь называют свои поля.
   */
  /**
   * Поля, которые сервер сохранить не смог. Пустой список — обычный день.
   *
   * Читается из ответа, а не выводится на клиенте: единственный, кто знает,
   * что именно приняла база, — это сервер, который туда писал.
   */
  const unsavedFromBody = (body: unknown): string[] => {
    const data = asRecord(asRecord(body).data);
    return Array.isArray(data.unsaved) ? data.unsaved.map((item) => readString(item)).filter(Boolean) : [];
  };

  /** Один и тот же текст на создании и на правке — потеря выглядит одинаково. */
  const warnAboutUnsaved = (unsaved: string[]) => {
    if (unsaved.length === 0) return;
    toast.error(`Сохранено не полностью: ${unsaved.join(", ")} — база клиники ещё не обновлена`);
  };

  const patchAppointment = async (
    appointment: Appointment,
    allowConflict = false,
    allowOutsideSchedule = false,
    fields?: Array<keyof ReturnType<typeof appointmentToApi>>,
  ) => {
    const full = appointmentToApi(appointment);
    const updates = fields
      ? Object.fromEntries(fields.filter((key) => key in full).map((key) => [key, full[key]]))
      : full;
    const response = await crmFetch(`/api/crm/appointments?workspaceId=${encodeURIComponent(readCurrentWorkspaceId())}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: appointment.id,
        workspaceId: readCurrentWorkspaceId(),
        updates: {
          ...updates,
          ...(allowConflict ? { allowConflict: true } : {}),
          // Отдельный флаг: «Сохранить всё равно» снимает проверку пересечений
          // целиком, и один клик не имеет права снимать заодно график врача.
          ...(allowOutsideSchedule ? { allowOutsideSchedule: true } : {}),
        },
      }),
    });
    const body = await safeJson(response);

    const conflict = conflictFromBody(body);
    if (conflict) throw conflict;
    const outside = scheduleRefusalFromBody(body);
    if (outside) throw outside;

    // Порог тот же, что у создания: ответ «demo» означает, что записи в базе
    // нет. Прежний код принимал его за успех и обещал «сохранено локально» —
    // локально при этом тоже ничего не сохранялось.
    if (!response.ok || body?.success !== true || body.mode !== "supabase") {
      const details = body?.success === false ? body.details?.join(", ") : "";
      throw new Error(details || (body?.success === false ? body.error : "Не удалось обновить запись на сервере"));
    }

    // Сервер называет поля, которые до базы не доехали (база клиники отстала
    // от кода на миграцию). Раньше об этом знал только лог Vercel, а на экране
    // оставалось оптимистичное значение — то есть сотрудник видел свои 90
    // минут, которых в базе нет. Возвращаем и список, и сохранённую строку.
    return {
      unsaved: unsavedFromBody(body),
      saved: body?.data?.item ? appointmentFromApi(body.data.item) : null,
    };
  };

  /**
   * Создание записи ждёт ответ сервера.
   *
   * Прежде оно шло оптимистично через addItem и отказ приходил уже после
   * закрытия модалки — generic-тостом, без причины и без введённых данных.
   * Для отказа «слот занят» это неприемлемо: оператору нужно решить, занимать
   * ли время всё равно, а решать он может только пока форма открыта.
   * Демо-режим не трогаем: там коллекция и есть запись, сервера нет.
   */
  const createAppointment = async (appointment: Appointment, allowConflict: boolean, allowOutsideSchedule = false) => {
    if (!isRealWorkspace()) {
      addItem(appointment);
      return;
    }

    const response = await crmFetch(`/api/crm/appointments?workspaceId=${encodeURIComponent(readCurrentWorkspaceId())}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...appointmentToApi(appointment),
        workspaceId: readCurrentWorkspaceId(),
        ...(allowConflict ? { allowConflict: true } : {}),
        ...(allowOutsideSchedule ? { allowOutsideSchedule: true } : {}),
      }),
    });
    const body = await safeJson(response);

    const conflict = conflictFromBody(body);
    if (conflict) throw conflict;
    const outside = scheduleRefusalFromBody(body);
    if (outside) throw outside;

    if (!response.ok || body?.success !== true || body.mode !== "supabase") {
      const record = asRecord(body);
      throw new ServerRefusalError(
        readString(record.code),
        readString(record.error) || "Не удалось создать запись на сервере",
        Array.isArray(record.details) ? record.details.map((item) => readString(item)) : [],
      );
    }

    const saved = body.data?.item;
    setItems((current) => [saved ? appointmentFromApi(saved) : appointment, ...current]);
    warnAboutUnsaved(unsavedFromBody(body));
  };

  /**
   * «Оформить продажу» с карточки записи.
   *
   * На записи уже есть клиент, услуга и связь со справочником — продажа
   * стартует с ними, а не с чистой формы, где всё это выбиралось заново из
   * селектов со всей базой. serviceId позволит форме продаж подставить цену
   * из прайса тем же путём, что и ручной выбор услуги.
   */
  const startSaleFromAppointment = (appointment: Appointment) => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      workspaceScopedKey(DEAL_PREFILL_KEY),
      JSON.stringify({
        title: appointment.service,
        clientId: appointment.clientId || "",
        appointmentId: appointment.id,
        serviceId: appointment.serviceId || "",
        // Согласованная цена записи главнее прайса: скидку обещали клиенту,
        // и продажа обязана её увидеть, а не выставить полный ценник.
        priceMinor: appointment.priceMinor,
      }),
    );
    setLocation("/sales");
  };

  const updateAppointmentStatus = async (appointment: Appointment, status: AppointmentStatus) => {
    const updated = { ...appointment, status };
    setItems((current) => current.map((item) => (item.id === appointment.id ? updated : item)));

    try {
      // Только статус: остальные поля этой карточки мог изменить коллега.
      const { unsaved } = await patchAppointment(updated, false, false, ["status"]);
      if (unsaved.length > 0) warnAboutUnsaved(unsaved);
      else toast.success(`Статус: ${getAppointmentStatusLabel(status)}`);
    } catch (error) {
      // Отказ сервера — откат, а не фантомный статус до перезагрузки. Прежний
      // текст обещал сохранение на этом устройстве, которого в рабочей клинике
      // не происходит. Причина отказа — оператору в консоль, тост остаётся
      // по-русски и без внутренних имён полей.
      setItems((current) => current.map((item) => (item.id === appointment.id ? appointment : item)));
      console.warn("appointments: status patch refused", error instanceof Error ? error.message : error);
      toast.error("Не удалось обновить статус. Изменение отменено.");
    }
  };

  const findConflict = (candidate: Appointment): Appointment | null => {
    const candidateInterval = appointmentInterval(candidate);
    return items.find((appointment) => {
      if (appointment.id === candidate.id) return false;
      if (appointment.doctor !== candidate.doctor) return false;
      if (!activeStatuses.includes(appointment.status)) return false;
      const currentInterval = appointmentInterval(appointment);
      return candidateInterval.start < currentInterval.end && currentInterval.start < candidateInterval.end;
    }) ?? null;
  };

  const submitForm = async (allowConflict = false, allowOutsideSchedule = false) => {
    if (saving) return;
    if (!form.client.trim()) {
      toast.error("Укажите имя клиента");
      return;
    }

    // Мастеру телефон не показывают вовсе (сервер срезает контакты), поэтому
    // требовать его от него — тупик: поле пустое не по невнимательности, а по
    // замыслу, и «Сохранить» не срабатывало бы никогда. Регистратор и владелец
    // телефон видят, и для них требование остаётся.
    const contactsHidden = userRole === "doctor";
    if (!contactsHidden && !form.phone.trim()) {
      toast.error("Укажите телефон клиента");
      return;
    }

    // Услуга, набранная точным названием из каталога, всё равно связывается:
    // одно место, детерминированно, и оператору не приходится помнить, что
    // выбирать надо из списка.
    const resolvedServiceId = form.serviceId
      || activeCatalog.find((service) => service.name.trim().toLowerCase() === form.service.trim().toLowerCase())?.id
      || "";
    // То же для врача: набранное точное имя связывается, иначе правило графика
    // молча не применилось бы к записи, которую оператор считает связанной.
    const resolvedDoctorId = form.doctorId
      || activeDoctors.find((doctor) => doctor.fullName.trim().toLowerCase() === form.doctor.trim().toLowerCase())?.id
      || "";
    const appointment = appointmentFromForm(
      { ...form, serviceId: resolvedServiceId, doctorId: resolvedDoctorId },
      editingId || undefined,
    );

    // Быстрый локальный префильтр: если конфликт виден в уже загруженном
    // расписании, спрашиваем без обращения к серверу. Авторитет — не здесь:
    // этот массив может быть усечён, и он не знает, что записал коллега
    // секунду назад с другого устройства.
    const localConflict = findConflict(appointment);
    if (localConflict && !allowConflict) {
      setConflictMessage(`У ${terms.specialistGenitive} уже есть запись на это время: ${localConflict.client}, ${timeKeyFromStartsAt(localConflict.startsAt)}. Выберите другое время.`);
      return;
    }

    setSaving(true);
    setScheduleMessage("");
    try {
    if (editingId) {
      const previous = items.find((item) => item.id === editingId);
      setItems((current) => current.map((item) => (item.id === editingId ? appointment : item)));
      try {
        const { unsaved, saved } = await patchAppointment(appointment, allowConflict, allowOutsideSchedule);
        // Строка на экране — серверная, а не введённая: иначе несохранённые
        // поля продолжали бы показываться сохранёнными до перезагрузки, и
        // коллега на своём устройстве видел бы другую длительность визита.
        if (saved) setItems((current) => current.map((item) => (item.id === editingId ? saved : item)));
        if (unsaved.length > 0) warnAboutUnsaved(unsaved);
        else toast.success("Запись обновлена");
      } catch (error) {
        if (previous) {
          setItems((current) => current.map((item) => (item.id === editingId ? previous : item)));
        }
        if (error instanceof SlotTakenError) {
          setConflictMessage(describeConflict(error, terms));
          return;
        }
        if (error instanceof OutsideScheduleError) {
          setScheduleMessage(describeSchedule(error, terms));
          return;
        }
        // Та же честность, что и у статуса: отказ виден отказом, строка
        // возвращается к серверной правде, детали — в консоль оператора.
        console.warn("appointments: patch refused", error instanceof Error ? error.message : error);
        toast.error(refusalText(error).replace("создать запись", "сохранить запись"));
        return;
      }
    } else {
      try {
        await createAppointment(appointment, allowConflict, allowOutsideSchedule);
        toast.success("Запись создана");
        if (prefillLeadRef.current) {
          const bookedLeadId = prefillLeadRef.current;
          prefillLeadRef.current = "";
          void markLeadBooked(bookedLeadId);
        }
      } catch (error) {
        if (error instanceof SlotTakenError) {
          setConflictMessage(describeConflict(error, terms));
          return;
        }
        if (error instanceof OutsideScheduleError) {
          setScheduleMessage(describeSchedule(error, terms));
          return;
        }
        console.warn("appointments: create refused", error instanceof Error ? error.message : error);
        toast.error(refusalText(error));
        return;
      }
    }

    setModalOpen(false);
    setConflictMessage("");
    setSelectedDate(form.date);
    } finally {
      setSaving(false);
    }
  };

  const renderDay = () => (
    <section className="neu-card">
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-black text-[#0F172A]">Дневной таймлайн</h2>
          <p className="text-sm text-[#64748B]">Рабочие слоты 09:00-21:00 с шагом 30 минут</p>
        </div>
        <span className="rounded-full bg-[#F8FAFC] px-3 py-1 text-xs font-bold text-[#64748B]">{dayAppointments.length} записей</span>
      </div>
      <div className="space-y-3">
        {dayBuckets.outside.length ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-black text-amber-900">
              Вне сетки дня: {dayBuckets.outside.length}
            </p>
            <p className="mt-1 text-xs font-semibold text-amber-800">
              Эти записи начинаются раньше 09:00, позже 21:00 или их время не удалось прочитать. Сетка их не
              показывает, а счётчик считает — поэтому они здесь.
            </p>
            <ul className="mt-2 space-y-1 text-sm font-semibold text-amber-900">
              {dayBuckets.outside.map((appointment) => (
                <li key={appointment.id}>
                  {timeKeyFromStartsAt(appointment.startsAt)} · {appointment.client} · {appointment.doctor || `без ${terms.specialistGenitive}`}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {/*
          Подряд идущие пустые получасовки складываются в одну строку: день
          салона с четырьмя записями был простынёй из двадцати одного блока
          «Свободно», и запись на вечер жила за целым экраном скролла.
        */}
        {slots
          .reduce<Array<{ kind: "busy"; slot: string; appointments: Appointment[] } | { kind: "free"; first: string; last: string }>>(
            (segments, slot) => {
              const busy = dayBuckets.buckets.get(slot) || [];
              if (busy.length > 0) {
                segments.push({ kind: "busy", slot, appointments: busy });
                return segments;
              }
              const previous = segments[segments.length - 1];
              if (previous && previous.kind === "free") previous.last = slot;
              else segments.push({ kind: "free", first: slot, last: slot });
              return segments;
            },
            [],
          )
          .map((segment) =>
            segment.kind === "busy" ? (
              <div key={segment.slot} className="grid gap-3 rounded-2xl bg-[#F8FAFC] p-3 md:grid-cols-[84px_minmax(0,1fr)]">
                <div className="flex items-center justify-between gap-3 md:block">
                  <p className="text-base font-black text-[#0F172A]">{segment.slot}</p>
                  <button type="button" className="neu-btn px-3 py-2 text-xs md:mt-3" onClick={() => openCreate(selectedDate, segment.slot)}>
                    <Plus size={14} />
                    Записать
                  </button>
                </div>
                <div className="space-y-3">
                  {segment.appointments.map((appointment) => (
                    <AppointmentCard key={appointment.id} appointment={appointment} onEdit={openEdit} onStatus={updateAppointmentStatus} onSale={startSaleFromAppointment} />
                  ))}
                </div>
              </div>
            ) : (
              <button
                key={`free-${segment.first}`}
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-2xl border border-dashed border-[#CBD5E1] bg-white/70 px-4 py-3 text-left text-sm font-semibold text-[#64748B]"
                onClick={() => openCreate(selectedDate, segment.first)}
              >
                <span>Свободно {segment.first === segment.last ? segment.first : `${segment.first} – ${segment.last}`}</span>
                {/* Время в кнопке: диапазон схлопнут, и без него было бы
                    непонятно, на какую получасовку откроется форма. */}
                <span className="inline-flex items-center gap-1 whitespace-nowrap font-bold text-[#0D9488]">
                  <Plus size={14} />
                  Записать на {segment.first}
                </span>
              </button>
            ),
          )}
      </div>
    </section>
  );

  const renderWeek = () => (
    <section className="grid gap-3 xl:grid-cols-7">
      {weekDays.map((day) => {
        const dayItems = filteredItems.filter((appointment) => isOnDay(appointment, day, clinicTimeZone));
        return (
          <article key={day} className="neu-card p-4">
            <div className="flex items-start justify-between gap-3 xl:block">
              <div>
                <h3 className="text-base font-black capitalize text-[#0F172A]">{formatShortDate(day)}</h3>
                <p className="mt-1 text-sm text-[#64748B]">{dayItems.length} записей</p>
              </div>
              <button
                type="button"
                className="neu-btn px-3 py-2 text-xs xl:mt-4 xl:w-full"
                onClick={() => {
                  setSelectedDate(day);
                  setView("day");
                }}
              >
                Открыть день
              </button>
            </div>
            <div className="mt-4 space-y-2">
              {dayItems.slice(0, 3).map((appointment) => (
                <button key={appointment.id} type="button" className="w-full rounded-xl bg-[#F8FAFC] px-3 py-2 text-left" onClick={() => openEdit(appointment)}>
                  <p className="text-sm font-black text-[#1A56DB]">{timeKeyFromStartsAt(appointment.startsAt)}</p>
                  <p className="truncate text-sm font-bold text-[#0F172A]">{appointment.client}</p>
                  <p className="truncate text-xs text-[#64748B]">{appointment.service}</p>
                </button>
              ))}
              {dayItems.length === 0 ? <p className="rounded-xl bg-[#F8FAFC] px-3 py-3 text-sm text-[#94A3B8]">Свободный день</p> : null}
            </div>
          </article>
        );
      })}
    </section>
  );

  const renderList = () => (
    <section className="neu-card">
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-black text-[#0F172A]">Список недели</h2>
          <p className="text-sm text-[#64748B]">Сортировка по времени, фильтры и поиск применяются автоматически</p>
        </div>
        <span className="rounded-full bg-[#F8FAFC] px-3 py-1 text-xs font-bold text-[#64748B]">{weekAppointments.length} записей</span>
      </div>
      <div className="space-y-3">
        {weekAppointments.map((appointment) => (
          <AppointmentCard key={appointment.id} appointment={appointment} onEdit={openEdit} onStatus={updateAppointmentStatus} onSale={startSaleFromAppointment} />
        ))}
        {weekAppointments.length === 0 ? <p className="rounded-2xl bg-[#F8FAFC] p-4 text-sm text-[#64748B]">Записей по выбранным фильтрам нет.</p> : null}
      </div>
    </section>
  );

  return (
    <PageLayout>
      {/*
        Честность про время. Правило графика считается в поясе клиники, но
        часы, которые набирает регистратор, всё ещё читаются в поясе его
        ноутбука — и продукт этого не исправляет в этой ветке. Молчать об
        этом нельзя: расхождение видно только тому, кто о нём знает.
      */}
      {clinicTimeZone && deviceTimeZone && clinicTimeZone !== deviceTimeZone ? (
        <div className="mb-4 rounded-2xl bg-amber-50 p-4 text-sm font-semibold text-amber-800">
          Часовой пояс устройства ({deviceTimeZone}) отличается от часового пояса {terms.orgGenitive} ({clinicTimeZone}).
          Время на экране может отличаться от времени {terms.orgGenitive}.
        </div>
      ) : null}
      {!clinicTimeZone && scheduleReadable ? (
        <div className="mb-4 rounded-2xl bg-slate-100 p-4 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>
          Часовой пояс {terms.orgGenitive} не задан — график {terms.specialistGenitivePlural} при записи не применяется.
        </div>
      ) : null}
      {!scheduleReadable ? (
        <div className="mb-4 rounded-2xl bg-amber-50 p-4 text-sm font-semibold text-amber-800">
          Не удалось прочитать график {terms.specialistGenitivePlural}. Это не значит, что его нет: подсказки под временем могут быть неполными,
          а сервер всё равно проверит запись по своему графику.
        </div>
      ) : null}
      <div className="space-y-7">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#64748B]">Medina CRM</p>
            <h1 className="mt-2 break-words text-2xl font-black text-[#0F172A] sm:text-3xl">Запись</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#64748B]">
              Календарь приёмов, статусы визитов и быстрые действия ресепшена
            </p>
          </div>
          <button type="button" className="neu-btn-primary inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 text-sm sm:w-auto" onClick={() => openCreate(selectedDate, "09:00")}>
            <Plus size={16} />
            Создать запись
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Сегодня записей" value={todayAppointments.length} icon={CalendarCheck} tone="primary" accent />
          <MetricCard label="Подтверждено" value={todayAppointments.filter((item) => item.status === "confirmed").length} icon={CheckCircle2} tone="success" />
          <MetricCard label="Ждут подтверждения" value={todayAppointments.filter((item) => item.status === "scheduled").length} icon={Clock3} tone="warning" />
          <MetricCard label="Не пришли" value={todayAppointments.filter((item) => item.status === "no_show").length} icon={UserCheck} tone="error" />
        </div>

        <section className="neu-card">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
            <div className="space-y-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <button type="button" className="neu-btn px-4 py-2 text-sm" onClick={() => setSelectedDate(todayKey)}>Сегодня</button>
                <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 sm:max-w-md">
                  <button type="button" className="neu-icon-btn" onClick={() => setSelectedDate(addDaysKey(selectedDate, -1))} aria-label="Предыдущий день">
                    <ChevronLeft size={18} />
                  </button>
                  <div className="rounded-2xl bg-[#F8FAFC] px-4 py-3 text-center text-sm font-black capitalize text-[#0F172A]">{formatDateLabel(selectedDate)}</div>
                  <button type="button" className="neu-icon-btn" onClick={() => setSelectedDate(addDaysKey(selectedDate, 1))} aria-label="Следующий день">
                    <ChevronRight size={18} />
                  </button>
                </div>
                {/* Стрелки по дням: листать календарь — движение чаще, чем
                    прыжок на произвольную дату через поле. */}
                <button type="button" className="neu-btn px-3 py-2 text-sm" aria-label="Предыдущий день" onClick={() => setSelectedDate(addDaysKey(selectedDate, -1))}>
                  ‹
                </button>
                <input className="neu-input w-full lg:w-auto" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value || selectedDate)} />
                <button type="button" className="neu-btn px-3 py-2 text-sm" aria-label="Следующий день" onClick={() => setSelectedDate(addDaysKey(selectedDate, 1))}>
                  ›
                </button>
                {/* «Сегодня» — не украшение: уйдя на неделю вперёд, вернуться
                    к текущему дню иначе можно только вспомнив число. День
                    берётся в поясе КЛИНИКИ, а не телефона. */}
                <button
                  type="button"
                  className={`neu-btn px-3 py-2 text-sm ${selectedDate === todayKey ? "text-[#0D9488]" : ""}`}
                  onClick={() => setSelectedDate(todayKey)}
                  disabled={selectedDate === todayKey}
                >
                  Сегодня
                </button>
              </div>
              <div className={`grid ${seesWholeClinic ? "grid-cols-5" : "grid-cols-4"} gap-2 sm:max-w-md`}>
                {((seesWholeClinic ? ["grid", "day", "week", "month", "list"] : ["day", "week", "month", "list"]) as CalendarView[]).map((mode) => (
                  <button key={mode} type="button" className={`neu-btn px-3 py-2 text-sm ${view === mode ? "text-[#0D9488]" : ""}`} onClick={() => setView(mode)}>
                    {viewLabels[mode]}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-[#F8FAFC] p-4">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Следующая запись</p>
              {nextAppointment ? (
                <div className="mt-3">
                  <p className="text-lg font-black text-[#0F172A]">{timeKeyFromStartsAt(nextAppointment.startsAt)} · {nextAppointment.client}</p>
                  <p className="mt-1 text-sm text-[#64748B]">{nextAppointment.service}</p>
                  <a className="neu-btn mt-3 w-full px-3 py-2 text-xs" href={toWhatsappHref(nextAppointment.whatsapp || nextAppointment.phone, `Здравствуйте, ${nextAppointment.client}! Напоминаем о записи.`)} target="_blank" rel="noreferrer">
                    <MessageCircle size={14} />
                    WhatsApp
                  </a>
                </div>
              ) : !loaded || loadError ? (
                // «Ближайших записей нет» на отказе чтения — та же ложь, что и
                // пустая сетка, только в самом читаемом месте экрана.
                <p className="mt-3 text-sm font-semibold text-[#94A3B8]">{loadError ? "Не загрузилось — не значит «нет»" : "Загружаем…"}</p>
              ) : (
                <p className="mt-3 text-sm text-[#94A3B8]">Ближайших активных записей нет</p>
              )}
            </div>
          </div>
        </section>

        <section className="neu-card">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1.5fr]">
            {/* Мастеру фильтр по специалисту не показывается: сервер отдаёт
                ему только его собственные записи, и список из одного имени
                выглядел бы поломкой, а не фильтром. */}
            {userRole !== "doctor" ? (
              <SelectField label={`Все ${terms.specialistPlural}`} value={doctorFilter} onChange={setDoctorFilter}>
                <option value="all">Все {terms.specialistPlural}</option>
                {doctors.map((doctor) => <option key={doctor} value={doctor}>{doctor}</option>)}
              </SelectField>
            ) : null}
            <SelectField label="Статус" value={statusFilter} onChange={setStatusFilter}>
              <option value="all">Все статусы</option>
              {statusOptions.map((status) => <option key={status} value={status}>{getAppointmentStatusLabel(status)}</option>)}
            </SelectField>
            <SelectField label="Услуга" value={serviceFilter} onChange={setServiceFilter}>
              <option value="all">Все услуги</option>
              {services.map((service) => <option key={service} value={service}>{service}</option>)}
            </SelectField>
            <label className="relative block">
              <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Поиск клиента/телефона</span>
              <Search className="absolute bottom-3 left-3 text-[#94A3B8]" size={16} />
              <input className="neu-input w-full pl-10" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Имя, телефон или WhatsApp" />
            </label>
          </div>
        </section>

        {/*
          Сбой чтения — не пустой день, и путать их здесь дороже всего в
          продукте: по этому экрану отпускают мастера домой и говорят
          пришедшему «свободно, заходите». Пустая сетка и «0 записей»
          выглядят как свободный день, а тост про ошибку живёт четыре
          секунды и исчезает, пока телефон в кармане.
        */}
        {loadError ? (
          <section className="negis-glass p-4" style={{ borderLeft: "4px solid #dc2626" }} aria-live="assertive">
            <p className="text-sm font-black" style={{ color: "#b91c1c" }}>
              Не удалось загрузить записи
            </p>
            <p className="mt-1 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>
              Это сбой связи, а не свободный день: записи на месте. Не записывайте клиентов поверх —
              обновите страницу.
            </p>
            <button type="button" className="neu-btn-primary mt-3 justify-center" onClick={() => window.location.reload()}>
              Обновить страницу
            </button>
          </section>
        ) : null}

        {!loaded ? (
          <section className="negis-glass flex min-h-40 items-center justify-center p-8" aria-live="polite">
            <p className="text-sm font-bold" style={{ color: "var(--negis-muted)" }}>Загружаем записи…</p>
          </section>
        ) : null}

        {loaded && !loadError && view === "grid" && seesWholeClinic ? (
          <MasterDayGrid
            dateKey={selectedDate}
            isoWeekday={isoWeekdayOf(selectedDate)}
            timeZone={clinicTimeZone}
            // Фильтр «Все мастера» сужает и колонки: одна колонка крупно —
            // это и есть режим «посмотреть день одного мастера». Записи он
            // уже сужает через filteredItems, колонки должны совпадать.
            doctors={(doctorFilter === "all"
              ? activeDoctors
              : activeDoctors.filter((doctor) => doctor.fullName === doctorFilter)
            ).map((doctor) => ({ id: doctor.id, fullName: doctor.fullName, specialty: doctor.specialty }))}
            shifts={shifts.map((shift) => ({
              doctorId: shift.doctorId,
              weekday: shift.weekday,
              onDate: shift.onDate,
              onDateEnd: shift.onDateEnd,
              isWorking: shift.isWorking,
              startMinute: shift.startMinute,
              endMinute: shift.endMinute,
            }))}
            appointments={dayAppointments}
            nowMinute={selectedDate === todayKey ? minuteOfClinicDay(new Date().toISOString(), clinicTimeZone) : null}
            onOpen={(id) => {
              const appointment = items.find((entry) => entry.id === id);
              if (appointment) openEdit(appointment);
            }}
            onQuickStatus={(id, status) => {
              // Та же операция, что кнопки статуса в списке: оптимистичная
              // смена, откат и честный тост при отказе сервера — всё уже
              // внутри updateAppointmentStatus.
              const appointment = items.find((entry) => entry.id === id);
              if (appointment) void updateAppointmentStatus(appointment, status);
            }}
            onCreate={({ doctorId, doctorName, time }) => {
              openCreate(selectedDate, time);
              // Мастер известен точнее, чем через фильтр: ткнули в его колонку.
              // Подставляется ПОСЛЕ openCreate — тот собирает форму заново.
              if (doctorId || doctorName) {
                setForm((current) => ({ ...current, doctorId, doctor: doctorName }));
              }
            }}
            specialistPlural={terms.specialistPlural}
          />
        ) : null}
        {loaded && !loadError && view === "month" ? (
          <section className="neu-card">
            {(() => {
              const [year, month] = selectedDate.split("-").map(Number);
              if (!year || !month) return null;
              const first = new Date(Date.UTC(year, month - 1, 1));
              const firstWeekday = first.getUTCDay() || 7;
              const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
              const monthLabel = first.toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });

              // Счётчик обязан совпадать с тем, что покажет клик по клетке:
              // тот же список (filteredItems — фильтры статуса и мастера уже
              // применены; отдельного среза по «живым» статусам нет, иначе
              // фильтр «Отменено» рисовал бы пустой месяц) и тот же календарь
              // — день по часам САЛОНА, не устройства. Нечитаемая дата — это
              // «не знаю», а не «сегодня».
              const countByDay = new Map<string, number>();
              for (const appointment of filteredItems) {
                const instant = Date.parse(appointment.startsAt);
                if (!Number.isFinite(instant)) continue;
                const key = dayKeyInZone(instant, clinicTimeZone);
                if (key.startsWith(`${year}-${String(month).padStart(2, "0")}`)) {
                  countByDay.set(key, (countByDay.get(key) ?? 0) + 1);
                }
              }

              const cells: Array<{ key: string; day: number } | null> = [];
              for (let blank = 1; blank < firstWeekday; blank += 1) cells.push(null);
              for (let day = 1; day <= daysInMonth; day += 1) {
                cells.push({ key: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, day });
              }

              const shiftMonth = (delta: number) => {
                const target = new Date(Date.UTC(year, month - 1 + delta, 1));
                setSelectedDate(`${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-01`);
              };

              return (
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <button type="button" className="neu-btn px-3 py-2 text-sm" aria-label="Предыдущий месяц" onClick={() => shiftMonth(-1)}>‹</button>
                    <p className="text-base font-black capitalize text-[#0F172A]">{monthLabel}</p>
                    <button type="button" className="neu-btn px-3 py-2 text-sm" aria-label="Следующий месяц" onClick={() => shiftMonth(1)}>›</button>
                  </div>
                  <div className="grid grid-cols-7 gap-1 text-center">
                    {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((weekday) => (
                      <span key={weekday} className="py-1 text-[11px] font-black uppercase tracking-[0.1em] text-[#94A3B8]">{weekday}</span>
                    ))}
                    {cells.map((cell, index) =>
                      cell === null ? (
                        <span key={`blank-${index}`} />
                      ) : (
                        <button
                          key={cell.key}
                          type="button"
                          className="flex min-h-16 flex-col items-center justify-start rounded-xl p-1.5"
                          style={{
                            background: cell.key === todayKey ? "rgba(13,148,136,0.10)" : "var(--negis-surface, #F8FAFC)",
                            outline: cell.key === selectedDate ? "2px solid var(--negis-primary)" : "none",
                          }}
                          onClick={() => {
                            setSelectedDate(cell.key);
                            // День открывается тем видом, который у роли главный.
                            setView(seesWholeClinic ? "grid" : "day");
                          }}
                        >
                          <span className="text-sm font-black tabular-nums text-[#0F172A]">{cell.day}</span>
                          {countByDay.get(cell.key) ? (
                            <span className="mt-1 rounded-full px-1.5 py-0.5 text-[10px] font-black text-white" style={{ background: "var(--negis-primary)" }}>
                              {countByDay.get(cell.key)}
                            </span>
                          ) : null}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              );
            })()}
          </section>
        ) : null}

        {loaded && !loadError && view === "day" ? renderDay() : null}
        {loaded && !loadError && view === "week" ? renderWeek() : null}
        {loaded && !loadError && view === "list" ? renderList() : null}
      </div>

      {modalOpen ? (
        <div className="fixed inset-0 z-[80] flex items-end bg-slate-950/35 p-3 sm:items-center sm:justify-center" onClick={() => setModalOpen(false)}>
          <form
            className="max-h-[calc(100dvh-32px)] w-full overflow-y-auto rounded-[28px] border border-[#DBE8E0] bg-white p-5 shadow-2xl sm:max-w-3xl sm:p-6"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void submitForm(false);
            }}
          >
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#64748B]">{editingId ? "Редактирование" : "Новая запись"}</p>
                <h2 className="mt-1 text-xl font-black text-[#0F172A]">{editingId ? "Карточка записи" : "Создать запись"}</h2>
              </div>
              <button type="button" className="neu-icon-btn" onClick={() => setModalOpen(false)} aria-label="Закрыть">
                <X size={18} />
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                {/* Смена имени или телефона снимает унаследованную связь: форма,
                    открытая из заявки Лауры, в которую вписали другого человека,
                    иначе сохранила бы визит в карточку Лауры. Ложная связь в
                    медицинской истории хуже потерянной; сигнал оператору —
                    исчезающая строка «Будет привязана…». */}
                <TextField label="Клиент/имя" value={form.client} onChange={(client) => setForm((current) => ({ ...current, client, clientId: "" }))} placeholder="Имя клиента" />
                {form.clientId ? (
                  <p className="mt-1 text-[11px] font-semibold" style={{ color: "var(--negis-primary)" }} data-testid="appointment-client-linked">
                    Будет привязана к карточке клиента
                  </p>
                ) : null}
              </div>
              {/* Мастеру поле не показывается: сервер контакты срезает, и
                  пустое поле «Телефон» выглядело бы как потерянные данные, а
                  введённый в него номер всё равно не сохранился бы. */}
              {userRole !== "doctor" && (
              <TextField label="Телефон" value={form.phone} onChange={(phone) => setForm((current) => ({ ...current, phone, clientId: "" }))} placeholder="+7..." />
              )}
              <TextField label="WhatsApp" value={form.whatsapp} onChange={(whatsapp) => setForm((current) => ({ ...current, whatsapp }))} placeholder="+7..." />
              {/*
                Мастер стоит ПЕРВЫМ — как в запись.кз: сначала «к кому», потом
                «на что». Выбор мастера сужает прайс до его услуг плюс общих,
                и перебирать все сто двадцать девять строк больше не нужно.
              */}
              {/*
                Раньше это был закрытый список из четырёх выдуманных имён:
                нового врача через форму записи ввести было нельзя вообще.
                Теперь — справочник со свободным вводом как откатом, ровно как
                у услуги. Пока справочник пуст или не включён, поле выглядит и
                работает как обычный текстовый ввод.
              */}
              {/* Мастер записывает только к себе, и решает это сервер: он
                  подставляет запись на того, кто её создаёт, а просьбу
                  записать к коллеге отклоняет вслух. Показывать здесь выбор
                  значило бы предлагать действие, которое кончится отказом. */}
              {userRole === "doctor" ? null : activeDoctors.length > 0 ? (
                <div>
                  <SelectField
                    label={capitalize(terms.specialist)}
                    value={form.doctorId || OTHER_SERVICE_OPTION}
                    onChange={(value) => {
                      if (value === OTHER_SERVICE_OPTION) {
                        setForm((current) => ({ ...current, doctorId: "" }));
                        return;
                      }
                      const doctor = activeDoctors.find((item) => item.id === value);
                      if (!doctor) return;
                      // Снимок имени ставит форма, а не сервер: оба пишущих
                      // пути шлют объект целиком, и серверная перезапись
                      // затирала бы поправленное вручную имя на каждом
                      // сохранении.
                      setForm((current) => ({ ...current, doctorId: doctor.id, doctor: doctor.fullName }));
                    }}
                  >
                    {activeDoctors.map((doctor) => (
                      <option key={doctor.id} value={doctor.id}>
                        {doctor.specialty ? `${doctor.fullName} — ${doctor.specialty}` : doctor.fullName}
                      </option>
                    ))}
                    {/* Врач записи мог уехать в архив после того, как её
                        завели. Без этого варианта поле рисовалось бы пустым, а
                        один случайный клик переписал бы и связь, и имя. */}
                    {form.doctorId && !activeDoctors.some((doctor) => doctor.id === form.doctorId) ? (
                      <option value={form.doctorId}>{form.doctor || `${capitalize(terms.specialist)} скрыт`}</option>
                    ) : null}
                    <option value={OTHER_SERVICE_OPTION}>Другой {terms.specialist}…</option>
                  </SelectField>
                  {/* Имя видно всегда: в записи хранится снимок на момент
                      визита, и переименование врача не меняет того, что
                      записано в карточке. */}
                  <div className="mt-2">
                    <TextField
                      label={`Имя ${terms.specialistGenitive} в записи`}
                      value={form.doctor}
                      onChange={(doctor) => setForm((current) => ({ ...current, doctor }))}
                    />
                  </div>
                </div>
              ) : (
                <TextField
                  label={capitalize(terms.specialist)}
                  value={form.doctor}
                  onChange={(doctor) => setForm((current) => ({ ...current, doctor, doctorId: "" }))}
                />
              )}
              {/*
                Услуга выбирается из справочника, но свободный ввод остаётся:
                регистратор за стойкой не должен упираться в отсутствующую
                строку каталога. Пока каталог пуст — а до применения миграции
                032 он пуст всегда — поле выглядит ровно как раньше.
              */}
              {activeCatalog.length > 0 ? (
                <div>
                  <SelectField
                    label="Услуга"
                    value={form.serviceId || OTHER_SERVICE_OPTION}
                    onChange={(value) => {
                      // Оператор выбрал услугу сам — подпись про снятую связь
                      // больше ничего не объясняет.
                      setServiceScopeNotice("");
                      if (value === OTHER_SERVICE_OPTION) {
                        // Цена принадлежала снятой услуге: оставить её значило
                        // бы продать «другую услугу» по чужому прайсу.
                        setForm((current) => ({ ...current, serviceId: "", priceTenge: "" }));
                        return;
                      }
                      const service = activeCatalog.find((item) => item.id === value);
                      if (!service) return;
                      // Снимок названия ставит форма, а не сервер: оба пишущих
                      // пути шлют объект целиком, и серверная перезапись
                      // затирала бы поправленный вручную текст на каждом
                      // сохранении, а не только при смене услуги.
                      setForm((current) => ({
                        ...current,
                        serviceId: service.id,
                        service: service.name,
                        durationMinutes: service.durationMinutes ?? current.durationMinutes,
                        // Цена из прайса — подсказка, не приговор: поле ниже
                        // остаётся редактируемым, скидку вписывают поверх.
                        priceTenge: service.basePriceMinor === null ? current.priceTenge : String(Math.round(service.basePriceMinor / 100)),
                      }));
                    }}
                  >
                    {activeCatalog.map((service) => {
                      const price = service.basePriceMinor === null ? "" : ` — ${Math.round(service.basePriceMinor / 100).toLocaleString("ru-RU")} ₸`;
                      const length = service.durationMinutes ? ` · ${service.durationMinutes} мин` : "";
                      return (
                        <option key={service.id} value={service.id}>{`${service.name}${price}${length}`}</option>
                      );
                    })}
                    {/* Услуга записи могла уехать в архив после того, как её
                        записали. Без этого варианта список не содержал бы
                        выбранного значения: поле рисовалось бы пустым, а один
                        случайный клик по нему переписал бы и связь, и снимок
                        названия на другую услугу. */}
                    {form.serviceId && !activeCatalog.some((service) => service.id === form.serviceId) ? (
                      <option value={form.serviceId}>{form.service || "Услуга скрыта"}</option>
                    ) : null}
                    <option value={OTHER_SERVICE_OPTION}>Другая услуга…</option>
                  </SelectField>
                  {serviceScopeHint}
                  {/* Название видно всегда: связь ссылается на строку каталога,
                      а в записи хранится снимок на момент визита, и переименование
                      услуги не должно менять того, что записано в карточке. */}
                  <div className="mt-2">
                    <TextField
                      label="Название услуги в записи"
                      value={form.service}
                      onChange={(service) => setForm((current) => ({ ...current, service }))}
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <TextField label="Услуга" value={form.service} onChange={(service) => setForm((current) => ({ ...current, service, serviceId: "" }))} />
                  {serviceScopeHint}
                </div>
              )}
              <TextField label="Дата" type="date" value={form.date} onChange={(date) => setForm((current) => ({ ...current, date }))} />
              <div>
                <TextField label="Время начала" type="time" value={form.time} onChange={(time) => setForm((current) => ({ ...current, time }))} />
                {/* Единственное место, где продукт признаёт, что для этого
                    врача правило не работает вовсе. */}
                {form.doctorId ? (
                  <p className="mt-1 text-[11px] font-semibold" style={{ color: "var(--negis-muted)" }}>
                    {describeDoctorDay(shifts, form.doctorId, form.date, terms)}
                  </p>
                ) : null}
              </div>

              {/* Свободное время — как в запись.кз: нажал и время встало. */}
              {formSlots ? (
                <div className="md:col-span-2">
                  <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Свободное время</span>
                  {formSlots.reason ? (
                    <p className="text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>
                      {formSlots.reason === "закрыт"
                        ? "День закрыт: выходной или закрытое окно. Время можно вписать вручную — сервер предупредит."
                        : formSlots.reason === "день кончился"
                          ? "Рабочий день уже закончился — на сегодня времени не осталось. Выберите другую дату."
                          : formSlots.reason === "не помещается"
                            ? "Услуга такой длительности не помещается в рабочее окно этого дня."
                            : formSlots.reason === "другой пояс"
                              ? "Подсказка времени скрыта: часы устройства не совпадают с часами салона, и подставленное время встало бы неверно."
                              : "Свободного времени не осталось — всё занято записями."}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {formSlots.groups.map((group) => (
                        <div key={group.label} className="flex flex-wrap items-center gap-1.5">
                          <span className="w-14 flex-none text-[11px] font-black uppercase tracking-[0.1em]" style={{ color: "var(--negis-muted)" }}>
                            {group.label}
                          </span>
                          {group.slots.map((slot) => {
                            const value = formatSlot(slot);
                            const selected = form.time === value;
                            return (
                              <button
                                key={slot}
                                type="button"
                                className="rounded-lg px-2.5 py-1.5 text-sm font-black tabular-nums"
                                style={selected
                                  ? { background: "var(--negis-primary)", color: "#fff" }
                                  : { background: "var(--negis-border)", color: "var(--negis-text)" }}
                                onClick={() => setForm((current) => ({ ...current, time: value }))}
                              >
                                {value}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
              <div>
                <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Длительность, минут</span>
                {/* Свободное число, а не четыре варианта: воск идёт 5 минут,
                    VIP-комплекс — 2 часа, и оба должны выражаться честно.
                    От длительности зависят свободные слоты и проверка
                    пересечений — врать ей нельзя. */}
                {/* Кламп — на потере фокуса и при отправке, НЕ на каждом
                    нажатии: покстрочный кламп превращал «45» в 55 («4» → 5,
                    затем дописанная «5»). Пределы 1..600 — как у каталога
                    услуг: услуга на 47 минут легальна и не должна блокировать
                    отправку формы. */}
                <input
                  className="neu-input w-full"
                  type="number"
                  min={1}
                  max={600}
                  step={1}
                  value={form.durationMinutes || ""}
                  onChange={(event) => {
                    const minutes = Math.round(Number(event.target.value) || 0);
                    setForm((current) => ({ ...current, durationMinutes: minutes }));
                  }}
                  onBlur={() => {
                    setForm((current) => ({
                      ...current,
                      durationMinutes: Math.max(1, Math.min(600, current.durationMinutes || 60)),
                    }));
                  }}
                />
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {[15, 30, 60, 90, 120].map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      className="rounded-lg px-2 py-1 text-xs font-black tabular-nums"
                      style={form.durationMinutes === minutes
                        ? { background: "var(--negis-primary)", color: "#fff" }
                        : { background: "var(--negis-border)", color: "var(--negis-text)" }}
                      onClick={() => setForm((current) => ({ ...current, durationMinutes: minutes }))}
                    >
                      {minutes}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Цена, ₸</span>
                {/* Снимок договорённости: прайс подставляет, рука правит.
                    Пусто — «цена не называлась», и это отличается от нуля. */}
                <input
                  className="neu-input w-full"
                  type="number"
                  min={0}
                  max={100000000}
                  step={1}
                  placeholder="Из прайса или своя"
                  value={form.priceTenge}
                  onChange={(event) => setForm((current) => ({ ...current, priceTenge: event.target.value }))}
                />
              </div>
              <SelectField label="Статус" value={form.status} onChange={(status) => setForm((current) => ({ ...current, status: normalizeStatus(status) }))}>
                {statusOptions.map((status) => <option key={status} value={status}>{getAppointmentStatusLabel(status)}</option>)}
              </SelectField>
              <TextField label="Источник" value={form.source} onChange={(source) => setForm((current) => ({ ...current, source }))} />
              {visitHistory.length > 0 ? (
                <div className="md:col-span-2 rounded-2xl p-3" style={{ background: "var(--negis-border)" }}>
                  <p className="text-xs font-black uppercase tracking-[0.12em]" style={{ color: "var(--negis-muted)" }}>
                    Архив клиента · {visitHistory.length === 8 ? "последние 8 визитов" : `${visitHistory.length} ${visitHistory.length === 1 ? "визит" : visitHistory.length < 5 ? "визита" : "визитов"}`}
                  </p>
                  <div className="mt-2 space-y-1">
                    {visitHistory.map((visit) => (
                      <p key={visit.id} className="text-sm font-semibold" style={{ color: "var(--negis-text)" }}>
                        <span className="tabular-nums">{formatVisitDay(visit.startsAt)} · {timeKeyFromStartsAt(visit.startsAt)}</span>
                        {visit.service ? ` · ${visit.service}` : ""}
                        {visit.doctor ? ` · ${visit.doctor}` : ""}
                        <span style={{ color: "var(--negis-muted)" }}> · {getAppointmentStatusLabel(visit.status)}</span>
                        {visit.priceMinor !== null ? (
                          <span className="tabular-nums"> · {Math.round(visit.priceMinor / 100).toLocaleString("ru-RU")} ₸</span>
                        ) : null}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}

              <label className="block md:col-span-2">
                <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Комментарий</span>
                <textarea className="neu-input min-h-28 w-full resize-y" value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
              </label>
            </div>

            {conflictMessage ? (
              <div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm font-semibold text-amber-800">
                {conflictMessage}
              </div>
            ) : null}

            {scheduleMessage ? (
              <div className="mt-3 rounded-2xl bg-sky-50 p-4 text-sm font-semibold text-sky-900">
                {scheduleMessage}
              </div>
            ) : null}

            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="neu-btn px-5 py-2.5 text-sm" onClick={() => setModalOpen(false)} disabled={saving}>Отмена</button>
              {/* Кнопки «Сохранить всё равно» при занятом времени больше нет:
                  владелец закрыл двойную запись, и сервер флаг обхода тоже не
                  читает. Баннер выше объясняет, что делать. */}
              {/* Только обход графика. Прежняя версия передавала сюда
                  Boolean(conflictMessage), и один клик снимал заодно проверку
                  пересечений — ровно то, ради чего флаги и разделены. */}
              {scheduleMessage ? (
                <button
                  type="button"
                  className="neu-btn px-5 py-2.5 text-sm text-sky-700"
                  onClick={() => void submitForm(false, true)}
                  disabled={saving}
                >
                  Записать вне графика
                </button>
              ) : null}
              <button type="submit" className="neu-btn-primary px-5 py-2.5 text-sm" disabled={saving}>
                {saving ? "Сохраняем…" : editingId ? "Сохранить изменения" : "Создать запись"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </PageLayout>
  );
}
