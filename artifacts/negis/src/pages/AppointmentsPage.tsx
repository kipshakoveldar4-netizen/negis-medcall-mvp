import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { apiUrl } from "@/lib/api";
import { useDemoCollection } from "@/lib/demoStorage";
import { formatPhone, toTelHref, toWhatsappHref } from "@/lib/phone";

type AppointmentStatus = "scheduled" | "confirmed" | "arrived" | "no_show" | "cancelled";
type CalendarView = "day" | "week" | "list";

type Appointment = {
  id: string;
  client: string;
  phone: string;
  whatsapp: string;
  service: string;
  doctor: string;
  startsAt: string;
  durationMinutes: number;
  status: AppointmentStatus;
  notes: string;
  source: string;
};

type AppointmentForm = {
  client: string;
  phone: string;
  whatsapp: string;
  service: string;
  doctor: string;
  date: string;
  time: string;
  durationMinutes: number;
  status: AppointmentStatus;
  notes: string;
  source: string;
};

type ApiResponse =
  | { success: true; mode?: string; warning?: string; data?: Record<string, unknown> }
  | { success: false; error: string; details?: string[] };

const APPOINTMENT_PREFILL_KEY = "negis_appointment_prefill";
const defaultDoctors = ["д-р Сауле", "д-р Айжан", "д-р Наргиз", "д-р Тимур"];
const defaultServices = ["Консультация", "Ботокс", "Чистка лица", "Лазерная процедура", "Диагностика кожи"];
const activeStatuses: AppointmentStatus[] = ["scheduled", "confirmed", "arrived"];
const statusOptions: AppointmentStatus[] = ["scheduled", "confirmed", "arrived", "no_show", "cancelled"];
const viewLabels: Record<CalendarView, string> = {
  day: "День",
  week: "Неделя",
  list: "Список",
};

const statusButtonLabels: Array<{ status: AppointmentStatus; label: string }> = [
  { status: "confirmed", label: "Подтвердить" },
  { status: "arrived", label: "Пришёл" },
  { status: "no_show", label: "Не пришёл" },
  { status: "cancelled", label: "Отменить" },
];

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
    client,
    phone,
    whatsapp: phone,
    service,
    doctor,
    startsAt: toStartsAt(date, time),
    durationMinutes: 60,
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

function readCurrentWorkspaceId(): string {
  if (typeof window === "undefined") return "demo-workspace";

  for (const key of ["negis_staff_user", "negis_staff_session", "negis_demo_workspace"]) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const value = JSON.parse(raw) as { id?: unknown; workspaceId?: unknown; workspace_id?: unknown };
      const workspaceId = typeof value.workspaceId === "string" && value.workspaceId.trim()
        ? value.workspaceId.trim()
        : typeof value.workspace_id === "string" && value.workspace_id.trim()
          ? value.workspace_id.trim()
          : key === "negis_demo_workspace" && typeof value.id === "string" && value.id.trim()
            ? value.id.trim()
            : "";
      if (workspaceId) return workspaceId;
    } catch {
      // Keep demo fallback.
    }
  }

  return "demo-workspace";
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
    client: readString(record.client) || readString(record.client_name) || readString(record.clientName) || "Клиент",
    phone,
    whatsapp: readString(record.whatsapp) || phone,
    service: readString(record.service) || "Консультация",
    doctor: readString(record.doctor) || readString(record.doctor_name) || readString(record.doctorName) || "д-р Сауле",
    startsAt,
    durationMinutes: readNumber(record.durationMinutes ?? record.duration_minutes, 60),
    status: normalizeStatus(readString(record.status)),
    notes: readString(record.notes),
    source: readString(record.source),
  };
}

function appointmentToApi(appointment: Appointment): Record<string, unknown> {
  return {
    id: appointment.id,
    client: appointment.client,
    clientName: appointment.client,
    phone: appointment.phone,
    clientPhone: appointment.phone,
    whatsapp: appointment.whatsapp,
    service: appointment.service,
    doctor: appointment.doctor,
    doctorName: appointment.doctor,
    starts_at: appointment.startsAt,
    startsAt: appointment.startsAt,
    duration_minutes: appointment.durationMinutes,
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

function defaultForm(date: string, time = "09:00"): AppointmentForm {
  return {
    client: "",
    phone: "",
    whatsapp: "",
    service: "Консультация",
    doctor: defaultDoctors[0],
    date,
    time,
    durationMinutes: 60,
    status: "scheduled",
    notes: "",
    source: "Ресепшн",
  };
}

function formFromAppointment(appointment: Appointment): AppointmentForm {
  return {
    client: appointment.client,
    phone: appointment.phone,
    whatsapp: appointment.whatsapp || appointment.phone,
    service: appointment.service,
    doctor: appointment.doctor,
    date: dateKeyFromStartsAt(appointment.startsAt),
    time: timeKeyFromStartsAt(appointment.startsAt),
    durationMinutes: appointment.durationMinutes,
    status: appointment.status,
    notes: appointment.notes,
    source: appointment.source || "Ресепшн",
  };
}

function appointmentFromForm(form: AppointmentForm, existingId?: string): Appointment {
  return {
    id: existingId || `appointment-${Date.now()}`,
    client: form.client.trim(),
    phone: form.phone.trim(),
    whatsapp: (form.whatsapp || form.phone).trim(),
    service: form.service.trim(),
    doctor: form.doctor.trim(),
    startsAt: toStartsAt(form.date, form.time),
    durationMinutes: form.durationMinutes,
    status: form.status,
    notes: form.notes.trim(),
    source: form.source.trim(),
  };
}

function appointmentInterval(appointment: Appointment) {
  const start = new Date(appointment.startsAt).getTime();
  return {
    start,
    end: start + appointment.durationMinutes * 60_000,
  };
}

function isSameDate(appointment: Appointment, dateKey: string): boolean {
  return dateKeyFromStartsAt(appointment.startsAt) === dateKey;
}

function isWithinWeek(appointment: Appointment, weekStart: string): boolean {
  const appointmentDate = dateKeyFromStartsAt(appointment.startsAt);
  const start = toLocalDate(weekStart).getTime();
  const end = toLocalDate(addDaysKey(weekStart, 7)).getTime();
  const current = toLocalDate(appointmentDate).getTime();
  return current >= start && current < end;
}

function statusBadge(status: AppointmentStatus) {
  return <span className={`rounded-full px-3 py-1 text-xs font-bold ${getAppointmentStatusClass(status)}`}>{getAppointmentStatusLabel(status)}</span>;
}

function MetricCard({ label, value, icon: Icon }: { label: string; value: string; icon: typeof CalendarCheck }) {
  return (
    <div className="neu-card p-4">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-teal-500/10 p-2 text-[#0F766E]">
          <Icon size={18} />
        </div>
        <p className="text-sm font-semibold text-[#64748B]">{label}</p>
      </div>
      <p className="mt-3 text-2xl font-black text-[#0F172A]">{value}</p>
    </div>
  );
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
}: {
  appointment: Appointment;
  onEdit: (appointment: Appointment) => void;
  onStatus: (appointment: Appointment, status: AppointmentStatus) => void;
}) {
  const startTime = timeKeyFromStartsAt(appointment.startsAt);
  const whatsapp = appointment.whatsapp || appointment.phone;

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
        <Detail label="Врач">{appointment.doctor}</Detail>
        <Detail label="Длительность">{appointment.durationMinutes} мин</Detail>
        <Detail label="Источник">{appointment.source || "Ресепшн"}</Detail>
      </div>

      {appointment.notes ? <p className="mt-3 rounded-xl bg-[#F8FAFC] px-3 py-2 text-sm text-[#64748B]">{appointment.notes}</p> : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" onClick={(event) => event.stopPropagation()}>
        {statusButtonLabels.map(({ status, label }) => (
          <button key={status} type="button" className="neu-btn px-3 py-2 text-xs" onClick={() => onStatus(appointment, status)}>
            {label}
          </button>
        ))}
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
  const [selectedDate, setSelectedDate] = useState(todayKeyAtLoad);
  const [view, setView] = useState<CalendarView>("day");
  const [doctorFilter, setDoctorFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [serviceFilter, setServiceFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AppointmentForm>(() => defaultForm(todayKeyAtLoad));
  const [conflictMessage, setConflictMessage] = useState("");

  const { items, addItem, setItems } = useDemoCollection<Appointment>("negis_demo_appointments", appointmentsSeed, {
    endpoint: "/api/crm/appointments",
    listKey: "appointments",
    toApi: appointmentToApi,
    fromApi: appointmentFromApi,
  });

  const doctors = useMemo(() => Array.from(new Set([...defaultDoctors, ...items.map((item) => item.doctor).filter(Boolean)])).sort(), [items]);
  const services = useMemo(() => Array.from(new Set([...defaultServices, ...items.map((item) => item.service).filter(Boolean)])).sort(), [items]);
  const slots = useMemo(() => generateSlots(), []);
  const weekStart = useMemo(() => startOfWeekKey(selectedDate), [selectedDate]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDaysKey(weekStart, index)), [weekStart]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const raw = window.localStorage.getItem(APPOINTMENT_PREFILL_KEY);
      if (!raw) return;
      const prefill = JSON.parse(raw) as Record<string, unknown>;
      const nextForm = {
        ...defaultForm(selectedDate),
        client: readString(prefill.clientName) || readString(prefill.name),
        phone: readString(prefill.phone),
        whatsapp: readString(prefill.whatsapp) || readString(prefill.phone),
        service: readString(prefill.service) || "Консультация",
        source: readString(prefill.source) || "CRM",
      };
      setForm(nextForm);
      setEditingId(null);
      setModalOpen(true);
      window.localStorage.removeItem(APPOINTMENT_PREFILL_KEY);
    } catch {
      window.localStorage.removeItem(APPOINTMENT_PREFILL_KEY);
    }
  }, [selectedDate]);

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

  const dayAppointments = useMemo(() => filteredItems.filter((appointment) => isSameDate(appointment, selectedDate)), [filteredItems, selectedDate]);
  const weekAppointments = useMemo(() => filteredItems.filter((appointment) => isWithinWeek(appointment, weekStart)), [filteredItems, weekStart]);
  const todayAppointments = useMemo(() => items.filter((appointment) => isSameDate(appointment, todayKeyAtLoad)), [items]);
  const nextAppointment = useMemo(() => {
    const now = Date.now();
    return items
      .filter((appointment) => activeStatuses.includes(appointment.status) && new Date(appointment.startsAt).getTime() >= now)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];
  }, [items]);

  const openCreate = (date = selectedDate, time = "09:00") => {
    setEditingId(null);
    setConflictMessage("");
    setForm(defaultForm(date, time));
    setModalOpen(true);
  };

  const openEdit = (appointment: Appointment) => {
    setEditingId(appointment.id);
    setConflictMessage("");
    setForm(formFromAppointment(appointment));
    setModalOpen(true);
  };

  const patchAppointment = async (appointment: Appointment) => {
    const response = await fetch(apiUrl("/api/crm/appointments"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: appointment.id,
        workspaceId: readCurrentWorkspaceId(),
        updates: appointmentToApi(appointment),
      }),
    });
    const body = await safeJson(response);

    if (!response.ok || body?.success !== true) {
      const details = body?.success === false ? body.details?.join(", ") : "";
      throw new Error(details || (body?.success === false ? body.error : "Не удалось обновить запись на сервере"));
    }

    if (body.mode !== "supabase" && body.warning) {
      toast.info("Сервер недоступен, изменение сохранено локально");
    }
  };

  const updateAppointmentStatus = async (appointment: Appointment, status: AppointmentStatus) => {
    const updated = { ...appointment, status };
    setItems((current) => current.map((item) => (item.id === appointment.id ? updated : item)));

    try {
      await patchAppointment(updated);
      toast.success(`Статус: ${getAppointmentStatusLabel(status)}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось обновить статус. Изменение сохранено локально.");
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

  const submitForm = async (allowConflict = false) => {
    if (!form.client.trim()) {
      toast.error("Укажите имя клиента");
      return;
    }

    if (!form.phone.trim()) {
      toast.error("Укажите телефон клиента");
      return;
    }

    const appointment = appointmentFromForm(form, editingId || undefined);
    const conflict = findConflict(appointment);
    if (conflict && !allowConflict) {
      setConflictMessage(`У врача уже есть запись на это время: ${conflict.client}, ${timeKeyFromStartsAt(conflict.startsAt)}. Сохранить всё равно?`);
      return;
    }

    if (editingId) {
      setItems((current) => current.map((item) => (item.id === editingId ? appointment : item)));
      try {
        await patchAppointment(appointment);
        toast.success("Запись обновлена");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Запись сохранена локально, но сервер не ответил");
      }
    } else {
      addItem(appointment);
      toast.success("Запись создана");
    }

    setModalOpen(false);
    setConflictMessage("");
    setSelectedDate(form.date);
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
        {slots.map((slot) => {
          const slotAppointments = dayAppointments.filter((appointment) => timeKeyFromStartsAt(appointment.startsAt) === slot);
          return (
            <div key={slot} className="grid gap-3 rounded-2xl bg-[#F8FAFC] p-3 md:grid-cols-[84px_minmax(0,1fr)]">
              <div className="flex items-center justify-between gap-3 md:block">
                <p className="text-base font-black text-[#0F172A]">{slot}</p>
                <button type="button" className="neu-btn px-3 py-2 text-xs md:mt-3" onClick={() => openCreate(selectedDate, slot)}>
                  <Plus size={14} />
                  Записать
                </button>
              </div>
              <div className="space-y-3">
                {slotAppointments.length > 0 ? (
                  slotAppointments.map((appointment) => (
                    <AppointmentCard key={appointment.id} appointment={appointment} onEdit={openEdit} onStatus={updateAppointmentStatus} />
                  ))
                ) : (
                  <button type="button" className="w-full rounded-2xl border border-dashed border-[#CBD5E1] bg-white/70 px-4 py-4 text-left text-sm font-semibold text-[#64748B]" onClick={() => openCreate(selectedDate, slot)}>
                    Свободно: + записать клиента на {slot}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );

  const renderWeek = () => (
    <section className="grid gap-3 xl:grid-cols-7">
      {weekDays.map((day) => {
        const dayItems = filteredItems.filter((appointment) => isSameDate(appointment, day));
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
          <AppointmentCard key={appointment.id} appointment={appointment} onEdit={openEdit} onStatus={updateAppointmentStatus} />
        ))}
        {weekAppointments.length === 0 ? <p className="rounded-2xl bg-[#F8FAFC] p-4 text-sm text-[#64748B]">Записей по выбранным фильтрам нет.</p> : null}
      </div>
    </section>
  );

  return (
    <PageLayout>
      <div className="space-y-7">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#64748B]">Demo CRM</p>
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
          <MetricCard label="Сегодня записей" value={String(todayAppointments.length)} icon={CalendarCheck} />
          <MetricCard label="Подтверждено" value={String(todayAppointments.filter((item) => item.status === "confirmed").length)} icon={CheckCircle2} />
          <MetricCard label="Ждут подтверждения" value={String(todayAppointments.filter((item) => item.status === "scheduled").length)} icon={Clock3} />
          <MetricCard label="Не пришли" value={String(todayAppointments.filter((item) => item.status === "no_show").length)} icon={UserCheck} />
        </div>

        <section className="neu-card">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
            <div className="space-y-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <button type="button" className="neu-btn px-4 py-2 text-sm" onClick={() => setSelectedDate(toDateKey(new Date()))}>Сегодня</button>
                <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 sm:max-w-md">
                  <button type="button" className="neu-icon-btn" onClick={() => setSelectedDate(addDaysKey(selectedDate, -1))} aria-label="Предыдущий день">
                    <ChevronLeft size={18} />
                  </button>
                  <div className="rounded-2xl bg-[#F8FAFC] px-4 py-3 text-center text-sm font-black capitalize text-[#0F172A]">{formatDateLabel(selectedDate)}</div>
                  <button type="button" className="neu-icon-btn" onClick={() => setSelectedDate(addDaysKey(selectedDate, 1))} aria-label="Следующий день">
                    <ChevronRight size={18} />
                  </button>
                </div>
                <input className="neu-input w-full lg:w-auto" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value || selectedDate)} />
              </div>
              <div className="grid grid-cols-3 gap-2 sm:max-w-md">
                {(["day", "week", "list"] as CalendarView[]).map((mode) => (
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
              ) : (
                <p className="mt-3 text-sm text-[#94A3B8]">Ближайших активных записей нет</p>
              )}
            </div>
          </div>
        </section>

        <section className="neu-card">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1.5fr]">
            <SelectField label="Все врачи" value={doctorFilter} onChange={setDoctorFilter}>
              <option value="all">Все врачи</option>
              {doctors.map((doctor) => <option key={doctor} value={doctor}>{doctor}</option>)}
            </SelectField>
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

        {view === "day" ? renderDay() : null}
        {view === "week" ? renderWeek() : null}
        {view === "list" ? renderList() : null}
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
              <TextField label="Клиент/имя" value={form.client} onChange={(client) => setForm((current) => ({ ...current, client }))} placeholder="Имя клиента" />
              <TextField label="Телефон" value={form.phone} onChange={(phone) => setForm((current) => ({ ...current, phone }))} placeholder="+7..." />
              <TextField label="WhatsApp" value={form.whatsapp} onChange={(whatsapp) => setForm((current) => ({ ...current, whatsapp }))} placeholder="+7..." />
              <TextField label="Услуга" value={form.service} onChange={(service) => setForm((current) => ({ ...current, service }))} />
              <SelectField label="Врач" value={form.doctor} onChange={(doctor) => setForm((current) => ({ ...current, doctor }))}>
                {doctors.map((doctor) => <option key={doctor} value={doctor}>{doctor}</option>)}
              </SelectField>
              <TextField label="Дата" type="date" value={form.date} onChange={(date) => setForm((current) => ({ ...current, date }))} />
              <TextField label="Время начала" type="time" value={form.time} onChange={(time) => setForm((current) => ({ ...current, time }))} />
              <SelectField label="Длительность" value={String(form.durationMinutes)} onChange={(durationMinutes) => setForm((current) => ({ ...current, durationMinutes: Number(durationMinutes) }))}>
                {[30, 45, 60, 90].map((duration) => <option key={duration} value={duration}>{duration} минут</option>)}
              </SelectField>
              <SelectField label="Статус" value={form.status} onChange={(status) => setForm((current) => ({ ...current, status: normalizeStatus(status) }))}>
                {statusOptions.map((status) => <option key={status} value={status}>{getAppointmentStatusLabel(status)}</option>)}
              </SelectField>
              <TextField label="Источник" value={form.source} onChange={(source) => setForm((current) => ({ ...current, source }))} />
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

            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="neu-btn px-5 py-2.5 text-sm" onClick={() => setModalOpen(false)}>Отмена</button>
              {conflictMessage ? (
                <button type="button" className="neu-btn px-5 py-2.5 text-sm text-amber-700" onClick={() => void submitForm(true)}>Сохранить всё равно</button>
              ) : null}
              <button type="submit" className="neu-btn-primary px-5 py-2.5 text-sm">{editingId ? "Сохранить изменения" : "Создать запись"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </PageLayout>
  );
}
