import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  BarChart3,
  Bot,
  CalendarCheck,
  CheckCircle2,
  ClipboardList,
  Copy,
  Crown,
  KeyRound,
  MessageCircle,
  Megaphone,
  PhoneCall,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  UserPlus,
  Users,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { useDemoCollection } from "@/lib/demoStorage";
import { apiUrl } from "@/lib/api";
import { formatPhone, toTelHref, toWhatsappHref } from "@/lib/phone";
import {
  permissionLabels,
  permissionsForRole,
  roleLabels,
  staffRoles,
  type StaffRole,
} from "@/lib/permissions";

type Metric = {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: "blue" | "teal" | "green" | "amber" | "rose" | "violet";
};

type Client = {
  id: string;
  name: string;
  phone: string;
  source: string;
  lastVisit: string;
  status: string;
  comment: string;
};

type Appointment = {
  id: string;
  time: string;
  client: string;
  service: string;
  doctor: string;
  status: string;
};

type ReceptionItem = {
  id: string;
  name: string;
  phone: string;
  source: string;
  request: string;
  status: string;
};

type Lead = {
  id: string;
  name: string;
  phone: string;
  source: string;
  campaign: string;
  status: string;
  owner: string;
};

type CallItem = {
  id: string;
  time: string;
  phone: string;
  client: string;
  type: string;
  result: string;
  summary: string;
};

type TaskItem = {
  id: string;
  title: string;
  owner: string;
  deadline: string;
  priority: string;
  status: "Новые" | "В работе" | "Готово";
};

type ChatMessage = {
  id: string;
  dialog: string;
  author: string;
  text: string;
  time: string;
};

type StaffMember = {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: StaffRole;
  status: string;
  workspaceId?: string;
  authUserId?: string;
  temporaryPasswordSet?: boolean;
  invitedAt?: string;
  lastLoginAt?: string;
  passwordResetRequired?: boolean;
};

const clientsSeed: Client[] = [
  {
    id: "client-ainur",
    name: "Айнур Садыкова",
    phone: "+7 701 245 18 44",
    source: "Instagram",
    lastVisit: "20 июня, ботокс",
    status: "VIP",
    comment: "Просит вечерние слоты после 18:00",
  },
  {
    id: "client-madina",
    name: "Мадина Ержан",
    phone: "+7 777 311 09 18",
    source: "ИИ таргетолог",
    lastVisit: "19 июня, консультация",
    status: "Повторный",
    comment: "Готова на курс ухода, ждёт расчёт",
  },
  {
    id: "client-olga",
    name: "Ольга Петрова",
    phone: "+7 705 812 44 02",
    source: "WhatsApp",
    lastVisit: "18 июня, чистка лица",
    status: "Активный",
    comment: "Напомнить о повторной процедуре через 3 недели",
  },
  {
    id: "client-dana",
    name: "Дана Мухамед",
    phone: "+7 707 901 33 70",
    source: "Рекомендация",
    lastVisit: "17 июня, лазер",
    status: "Новый",
    comment: "Первичный клиент, нужен мягкий follow-up",
  },
];

const appointmentsSeed: Appointment[] = [
  { id: "apt-1", time: "10:00", client: "Айнур Садыкова", service: "Ботокс", doctor: "д-р Сауле", status: "Подтверждена" },
  { id: "apt-2", time: "11:30", client: "Мадина Ержан", service: "Консультация", doctor: "д-р Айжан", status: "Ожидает" },
  { id: "apt-3", time: "14:00", client: "Ольга Петрова", service: "Чистка лица", doctor: "д-р Сауле", status: "Пришёл" },
  { id: "apt-4", time: "16:30", client: "Дана Мухамед", service: "Лазерная процедура", doctor: "д-р Наргиз", status: "Ожидает" },
];

const receptionSeed: ReceptionItem[] = [
  {
    id: "rec-1",
    name: "Лаура",
    phone: "+7 700 801 77 21",
    source: "Meta Lead Ads",
    request: "Хочет диагностику кожи сегодня",
    status: "Новый лид",
  },
  {
    id: "rec-2",
    name: "Жанна",
    phone: "+7 747 330 19 90",
    source: "WhatsApp",
    request: "Перенести запись с 15:00",
    status: "Нужно подтвердить",
  },
  {
    id: "rec-3",
    name: "Мария",
    phone: "+7 702 617 12 11",
    source: "Сайт",
    request: "Уточнить цену курса",
    status: "В работе",
  },
];

const leadsSeed: Lead[] = [
  { id: "lead-1", name: "Лаура", phone: "+7 700 801 77 21", source: "Instagram", campaign: "Free consultation", status: "Новый", owner: "Ресепшн" },
  { id: "lead-2", name: "Жанна", phone: "+7 747 330 19 90", source: "WhatsApp", campaign: "Reels ботокс", status: "В работе", owner: "Айгерим" },
  { id: "lead-3", name: "Мария", phone: "+7 702 617 12 11", source: "TikTok", campaign: "Skin audit", status: "Записан", owner: "Medina AI" },
  { id: "lead-4", name: "Салтанат", phone: "+7 701 909 10 88", source: "Рекомендация", campaign: "Повторные клиенты", status: "Пришёл", owner: "Админ" },
  { id: "lead-5", name: "Ирина", phone: "+7 777 422 55 01", source: "Instagram", campaign: "Laser promo", status: "Потерян", owner: "Маркетолог" },
];

const callsSeed: CallItem[] = [
  {
    id: "call-1",
    time: "09:20",
    phone: "+7 700 801 77 21",
    client: "Лаура",
    type: "Входящий",
    result: "Записана",
    summary: "Medina уточнила запрос и предложила слот на 15:30.",
  },
  {
    id: "call-2",
    time: "10:05",
    phone: "+7 747 330 19 90",
    client: "Жанна",
    type: "Исходящий",
    result: "Перезвонить",
    summary: "Клиент на встрече, просит написать в WhatsApp.",
  },
  {
    id: "call-3",
    time: "11:40",
    phone: "+7 702 617 12 11",
    client: "Мария",
    type: "Пропущенный",
    result: "Ожидает",
    summary: "Нужно перезвонить до 14:00.",
  },
];

const tasksSeed: TaskItem[] = [
  { id: "task-1", title: "Перезвонить Марии по лазеру", owner: "Ресепшн", deadline: "Сегодня 14:00", priority: "Высокий", status: "Новые" },
  { id: "task-2", title: "Подготовить сторис по ботоксу", owner: "Маркетолог", deadline: "Сегодня 17:00", priority: "Средний", status: "В работе" },
  { id: "task-3", title: "Проверить отчёт кампании", owner: "Админ", deadline: "Завтра", priority: "Низкий", status: "Готово" },
];

const chatSeed: ChatMessage[] = [
  { id: "msg-1", dialog: "Ресепшн", author: "Айгерим", text: "Лаура записана на 15:30, просит напоминание.", time: "10:12" },
  { id: "msg-2", dialog: "Маркетолог", author: "Маркетолог", text: "Новый креатив из Content Studio готов к тесту.", time: "10:30" },
  { id: "msg-3", dialog: "Врач косметолог", author: "д-р Сауле", text: "Для клиента Мадины лучше начать с консультации.", time: "11:05" },
  { id: "msg-4", dialog: "Medina AI", author: "Medina AI", text: "3 пропущенных звонка требуют follow-up.", time: "11:20" },
];

const staffSeed: StaffMember[] = [
  { id: "staff-owner", name: "Эльдар Кипшаков", email: "owner@negis.local", phone: "+7 700 000 00 01", role: "owner", status: "active" },
  { id: "staff-reception", name: "Айгерим Ресепшн", email: "reception@negis.local", phone: "+7 700 000 00 02", role: "receptionist", status: "active" },
  { id: "staff-marketer", name: "Маркетолог Concept", email: "marketing@negis.local", phone: "+7 700 000 00 03", role: "marketer", status: "active" },
];

const toneClasses: Record<NonNullable<Metric["tone"]>, { bg: string; text: string }> = {
  blue: { bg: "bg-blue-500/10", text: "text-[#1A56DB]" },
  teal: { bg: "bg-teal-500/10", text: "text-[#0F766E]" },
  green: { bg: "bg-green-500/10", text: "text-[#16A34A]" },
  amber: { bg: "bg-amber-500/10", text: "text-[#D97706]" },
  rose: { bg: "bg-rose-500/10", text: "text-[#E11D48]" },
  violet: { bg: "bg-violet-500/10", text: "text-[#7C3AED]" },
};

function newId(prefix: string) {
  return `${prefix}-${Date.now()}`;
}

function generateTemporaryPassword() {
  return `Negis2026!${Math.random().toString(36).slice(2, 8)}`;
}

function readCurrentWorkspaceId() {
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
      // Ignore malformed localStorage and keep fallback mode.
    }
  }

  return "demo-workspace";
}

async function readApiJson(response: globalThis.Response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as {
      success?: boolean;
      mode?: string;
      warning?: string;
      data?: Record<string, unknown>;
      error?: string;
      details?: string[];
    };
  } catch {
    return null;
  }
}

function staffFromApi(value: unknown, fallback: StaffMember): StaffMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  const role = typeof record.role === "string" && staffRoles.includes(record.role as StaffRole)
    ? record.role as StaffRole
    : fallback.role;

  return {
    id: typeof record.id === "string" ? record.id : fallback.id,
    name: typeof record.name === "string" ? record.name : fallback.name,
    email: typeof record.email === "string" ? record.email : fallback.email,
    phone: typeof record.phone === "string" ? record.phone : fallback.phone,
    role,
    status: typeof record.status === "string" ? record.status : fallback.status,
    workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : fallback.workspaceId,
    authUserId: typeof record.authUserId === "string" ? record.authUserId : fallback.authUserId,
    temporaryPasswordSet: typeof record.temporaryPasswordSet === "boolean" ? record.temporaryPasswordSet : fallback.temporaryPasswordSet,
    invitedAt: typeof record.invitedAt === "string" ? record.invitedAt : fallback.invitedAt,
    lastLoginAt: typeof record.lastLoginAt === "string" ? record.lastLoginAt : fallback.lastLoginAt,
    passwordResetRequired: typeof record.passwordResetRequired === "boolean" ? record.passwordResetRequired : fallback.passwordResetRequired,
  };
}

function PageHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#64748B]">Demo CRM</p>
        <h1 className="mt-2 break-words text-2xl font-black text-[#0F172A] sm:text-3xl">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#64748B]">{subtitle}</p>
      </div>
      {action ? <div className="w-full sm:w-auto">{action}</div> : null}
    </div>
  );
}

function MetricGrid({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map(({ label, value, icon: Icon, tone = "blue" }) => (
        <div key={label} className="neu-card relative overflow-hidden">
          <div className="mb-3 flex items-center gap-3">
            <div className={`rounded-xl p-2 ${toneClasses[tone].bg} ${toneClasses[tone].text}`}>
              <Icon size={20} />
            </div>
            <span className="text-sm font-semibold text-[#64748B]">{label}</span>
          </div>
          <p className="text-3xl font-black text-[#1E293B]">{value}</p>
        </div>
      ))}
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  const color = value.includes("Потерян") || value.includes("Не пришёл") || value.includes("Отмен")
    ? "bg-rose-50 text-rose-700"
    : value.includes("VIP") || value.includes("Высок")
      ? "bg-amber-50 text-amber-700"
      : value.includes("Готов") || value.includes("Пришёл") || value.includes("Запис")
        ? "bg-green-50 text-green-700"
        : "bg-blue-50 text-blue-700";

  return <span className={`rounded-full px-3 py-1 text-xs font-bold ${color}`}>{value}</span>;
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-[#F8FAFC] px-4 py-3 text-sm text-[#64748B]">{children}</p>;
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="relative block max-w-md">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94A3B8]" size={16} />
      <input
        className="neu-input w-full pl-10"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function PrimaryButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button className="neu-btn-primary inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 text-sm sm:w-auto" type="button" onClick={onClick}>
      {children}
    </button>
  );
}

function MobileDetail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-[0.10em] text-[#94A3B8]">{label}</p>
      <div className="mt-1 break-words text-sm font-semibold text-[#334155]">{value}</div>
    </div>
  );
}

function QuickActionLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a className="neu-btn min-h-11 flex-1 px-3 py-2 text-xs" href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
      {children}
    </a>
  );
}

function saveAppointmentPrefill(prefill: { clientName: string; phone: string; source?: string; service?: string }) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("negis_appointment_prefill", JSON.stringify(prefill));
}

export function DemoClients() {
  const { items, addItem } = useDemoCollection("negis_demo_clients", clientsSeed, {
    endpoint: "/api/crm/clients",
    listKey: "clients",
  });
  const [search, setSearch] = useState("");
  const filtered = items.filter((client) => `${client.name} ${client.phone}`.toLowerCase().includes(search.toLowerCase()));

  const addClient = () => {
    addItem({
      id: newId("client"),
      name: `Новый клиент ${items.length + 1}`,
      phone: "+7 700 000 00 00",
      source: "Ресепшн",
      lastVisit: "Новая заявка",
      status: "Новый",
      comment: "Добавлен в demo CRM",
    });
    toast.success("Клиент добавлен локально");
  };

  return (
    <PageLayout>
      <div className="space-y-7">
        <PageHeader title="Клиенты" subtitle="Единая база пациентов Concept Clinic с источниками, статусами и последними визитами." action={<PrimaryButton onClick={addClient}><UserPlus size={16} />Добавить клиента</PrimaryButton>} />
        <MetricGrid
          metrics={[
            { label: "Всего клиентов", value: "128", icon: Users, tone: "blue" },
            { label: "Новые за неделю", value: "24", icon: UserPlus, tone: "teal" },
            { label: "Повторные", value: "46", icon: CheckCircle2, tone: "green" },
            { label: "VIP", value: "8", icon: Crown, tone: "amber" },
          ]}
        />
        <section className="neu-card">
          <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h2 className="text-lg font-bold text-[#0F172A]">Таблица клиентов</h2>
            <SearchBox value={search} onChange={setSearch} placeholder="Поиск по имени или телефону" />
          </div>
          <div className="space-y-3 md:hidden">
            {filtered.map((client) => (
              <article key={client.id} className="neu-sm p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-base font-black text-[#0F172A]">{client.name}</h3>
                    <p className="mt-1 text-sm text-[#64748B]">{formatPhone(client.phone)}</p>
                  </div>
                  <StatusPill value={client.status} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <MobileDetail label="Источник" value={client.source} />
                  <MobileDetail label="Последняя запись" value={client.lastVisit} />
                </div>
                <p className="mt-3 break-words rounded-xl bg-[#F8FAFC] px-3 py-2 text-sm text-[#64748B]">{client.comment}</p>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <QuickActionLink href={toWhatsappHref(client.phone, `Здравствуйте, ${client.name}! Пишем из Concept Clinic.`)}>
                    <MessageCircle size={14} />
                    WhatsApp
                  </QuickActionLink>
                  <QuickActionLink href={toTelHref(client.phone)}>
                    <PhoneCall size={14} />
                    Позвонить
                  </QuickActionLink>
                  <Link
                    href="/appointments"
                    className="neu-btn min-h-11 flex-1 px-3 py-2 text-xs"
                    onClick={() => saveAppointmentPrefill({ clientName: client.name, phone: client.phone, source: client.source })}
                  >
                    <CalendarCheck size={14} />
                    Записать
                  </Link>
                </div>
              </article>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="text-xs uppercase text-[#94A3B8]">
                <tr>
                  {["Имя", "Телефон", "Источник", "Последняя запись", "Статус", "Комментарий"].map((header) => (
                    <th key={header} className="border-b border-[#E7ECF3] px-3 py-3 font-bold">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((client) => (
                  <tr key={client.id} className="border-b border-[#EEF2F7] last:border-0">
                    <td className="px-3 py-4 font-bold text-[#0F172A]">{client.name}</td>
                    <td className="px-3 py-4 text-[#334155]">{client.phone}</td>
                    <td className="px-3 py-4 text-[#334155]">{client.source}</td>
                    <td className="px-3 py-4 text-[#334155]">{client.lastVisit}</td>
                    <td className="px-3 py-4"><StatusPill value={client.status} /></td>
                    <td className="px-3 py-4 text-[#64748B]">{client.comment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 ? <EmptyHint>Клиенты не найдены. Измените поиск или добавьте нового клиента.</EmptyHint> : null}
        </section>
      </div>
    </PageLayout>
  );
}

export function DemoAppointments() {
  const { items, addItem, updateItem } = useDemoCollection("negis_demo_appointments", appointmentsSeed, {
    endpoint: "/api/crm/appointments",
    listKey: "appointments",
  });
  const statuses = ["Подтвердить", "Пришёл", "Не пришёл", "Отменить"];

  const createAppointment = () => {
    addItem({
      id: newId("apt"),
      time: "17:30",
      client: "Новый клиент",
      service: "Консультация",
      doctor: "д-р Айжан",
      status: "Ожидает",
    });
    toast.success("Запись создана локально");
  };

  const slots = ["09:00", "10:00", "11:30", "13:00", "14:00", "15:30", "16:30", "17:30"];

  return (
    <PageLayout>
      <div className="space-y-7">
        <PageHeader title="Запись" subtitle="Дневной календарь, список визитов и быстрые статусы для ресепшна." action={<PrimaryButton onClick={createAppointment}><Plus size={16} />Создать запись</PrimaryButton>} />
        <section className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
          <div className="neu-card">
            <h2 className="mb-4 text-lg font-bold text-[#0F172A]">Календарь на день</h2>
            <div className="space-y-2">
              {slots.map((slot) => {
                const booked = items.find((item) => item.time === slot);
                return (
                  <div key={slot} className="flex items-center justify-between rounded-xl bg-[#F8FAFC] px-4 py-3">
                    <span className="font-bold text-[#0F172A]">{slot}</span>
                    <span className="text-sm text-[#64748B]">{booked ? booked.client : "свободно"}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="neu-card">
            <h2 className="mb-4 text-lg font-bold text-[#0F172A]">Список записей</h2>
            <div className="space-y-3">
              {items.map((appointment) => (
                <div key={appointment.id} className="neu-sm p-4">
                  <div className="grid gap-3 lg:grid-cols-[80px_1fr_1fr_1fr_auto] lg:items-center">
                    <p className="text-lg font-black text-[#1A56DB]">{appointment.time}</p>
                    <div>
                      <p className="font-bold text-[#0F172A]">{appointment.client}</p>
                      <p className="text-xs text-[#64748B]">{appointment.service}</p>
                    </div>
                    <p className="text-sm text-[#334155]">{appointment.doctor}</p>
                    <StatusPill value={appointment.status} />
                    <div className="flex flex-wrap gap-2">
                      {statuses.map((status) => (
                        <button key={`${appointment.id}-${status}`} type="button" className="neu-btn px-3 py-1.5 text-xs" onClick={() => updateItem(appointment.id, { status: status === "Подтвердить" ? "Подтверждена" : status })}>
                          {status}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </PageLayout>
  );
}

export function DemoReception() {
  const { items, updateItem } = useDemoCollection("negis_demo_reception", receptionSeed);

  const action = (id: string, label: string) => {
    updateItem(id, { status: label });
    toast.success(`${label}: действие сохранено`);
  };

  return (
    <PageLayout>
      <div className="space-y-7">
        <PageHeader title="Ресепшн" subtitle="Операционный пульт: входящие лиды, звонки на сегодня и неподтверждённые записи." />
        <MetricGrid
          metrics={[
            { label: "Входящие лиды", value: "12", icon: Users, tone: "blue" },
            { label: "Звонки сегодня", value: "18", icon: PhoneCall, tone: "teal" },
            { label: "Неподтверждённые", value: "4", icon: CalendarCheck, tone: "amber" },
            { label: "Закрыто", value: "9", icon: CheckCircle2, tone: "green" },
          ]}
        />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="neu-card">
            <h2 className="mb-4 text-lg font-bold text-[#0F172A]">Очередь входящих лидов</h2>
            <div className="space-y-3">
              {items.map((lead) => (
                <div key={lead.id} className="neu-sm p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="font-bold text-[#0F172A]">{lead.name}</p>
                      <p className="text-sm text-[#64748B]">{lead.phone} · {lead.source}</p>
                      <p className="mt-1 text-sm text-[#334155]">{lead.request}</p>
                    </div>
                    <StatusPill value={lead.status} />
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {["Позвонить", "Написать WhatsApp", "Записать", "Закрыть"].map((label) => (
                      <button key={`${lead.id}-${label}`} type="button" className="neu-btn px-3 py-1.5 text-xs" onClick={() => action(lead.id, label)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <aside className="neu-card">
            <h2 className="mb-4 text-lg font-bold text-[#0F172A]">Фокус дня</h2>
            <div className="space-y-3">
              {["Перезвонить пропущенные до 14:00", "Подтвердить 4 записи", "Отправить WhatsApp по новым лидам"].map((item) => (
                <div key={item} className="rounded-xl bg-[#F8FAFC] p-4 text-sm font-semibold text-[#334155]">{item}</div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </PageLayout>
  );
}

export function DemoLeads() {
  const { items, addItem } = useDemoCollection("negis_demo_leads", leadsSeed, {
    endpoint: "/api/crm/leads",
    listKey: "leads",
  });
  const stages = ["Новый", "В работе", "Записан", "Пришёл", "Потерян"];

  const addLead = () => {
    addItem({
      id: newId("lead"),
      name: `Новый лид ${items.length + 1}`,
      phone: "+7 700 111 22 33",
      source: "Instagram",
      campaign: "Demo campaign",
      status: "Новый",
      owner: "Ресепшн",
    });
    toast.success("Лид добавлен локально");
  };

  return (
    <PageLayout>
      <div className="space-y-7">
        <PageHeader title="Лиды" subtitle="Воронка входящих заявок из рекламы, WhatsApp и рекомендаций." action={<PrimaryButton onClick={addLead}><Plus size={16} />Добавить лид</PrimaryButton>} />
        <div className="grid gap-4 md:grid-cols-5">
          {stages.map((stage) => (
            <div key={stage} className="neu-card">
              <p className="text-sm font-bold text-[#64748B]">{stage}</p>
              <p className="mt-2 text-3xl font-black text-[#0F172A]">{items.filter((lead) => lead.status === stage).length}</p>
            </div>
          ))}
        </div>
        <section className="neu-card">
          <div className="space-y-3 md:hidden">
            {items.map((lead) => (
              <article key={lead.id} className="neu-sm p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-base font-black text-[#0F172A]">{lead.name}</h3>
                    <p className="mt-1 text-sm text-[#64748B]">{formatPhone(lead.phone)}</p>
                  </div>
                  <StatusPill value={lead.status} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <MobileDetail label="Источник" value={lead.source} />
                  <MobileDetail label="Кампания" value={lead.campaign} />
                  <MobileDetail label="Ответственный" value={lead.owner} />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <QuickActionLink href={toTelHref(lead.phone)}>
                    <PhoneCall size={14} />
                    Позвонить
                  </QuickActionLink>
                  <QuickActionLink href={toWhatsappHref(lead.phone, `Здравствуйте, ${lead.name}! Это Concept Clinic.`)}>
                    <MessageCircle size={14} />
                    WhatsApp
                  </QuickActionLink>
                  <Link
                    href="/appointments"
                    className="neu-btn min-h-11 flex-1 px-3 py-2 text-xs"
                    onClick={() => saveAppointmentPrefill({ clientName: lead.name, phone: lead.phone, source: lead.source, service: lead.campaign })}
                  >
                    <CalendarCheck size={14} />
                    Записать
                  </Link>
                </div>
              </article>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="text-xs uppercase text-[#94A3B8]">
              <tr>
                {["Имя", "Телефон", "Источник", "Кампания", "Статус", "Ответственный"].map((header) => (
                  <th key={header} className="border-b border-[#E7ECF3] px-3 py-3 font-bold">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((lead) => (
                <tr key={lead.id} className="border-b border-[#EEF2F7] last:border-0">
                  <td className="px-3 py-4 font-bold text-[#0F172A]">{lead.name}</td>
                  <td className="px-3 py-4 text-[#334155]">{lead.phone}</td>
                  <td className="px-3 py-4 text-[#334155]">{lead.source}</td>
                  <td className="px-3 py-4 text-[#334155]">{lead.campaign}</td>
                  <td className="px-3 py-4"><StatusPill value={lead.status} /></td>
                  <td className="px-3 py-4 text-[#64748B]">{lead.owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      </div>
    </PageLayout>
  );
}

export function DemoCalls() {
  const { items } = useDemoCollection("negis_demo_calls", callsSeed, {
    endpoint: "/api/crm/calls",
    listKey: "calls",
  });

  return (
    <PageLayout>
      <div className="space-y-7">
        <PageHeader title="Звонки" subtitle="Журнал разговоров, пропущенные вызовы и блок Medina AI телефониста." />
        <MetricGrid
          metrics={[
            { label: "Всего звонков", value: "18", icon: PhoneCall, tone: "blue" },
            { label: "Принято Medina", value: "11", icon: Bot, tone: "teal" },
            { label: "Пропущено", value: "3", icon: PhoneCall, tone: "rose" },
            { label: "Записей после звонка", value: "7", icon: CalendarCheck, tone: "green" },
          ]}
        />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="neu-card">
            <h2 className="mb-4 text-lg font-bold text-[#0F172A]">Журнал звонков</h2>
            <div className="space-y-3 md:hidden">
              {items.map((call) => (
                <article key={call.id} className="neu-sm p-4">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-lg font-black text-[#1A56DB]">{call.time}</p>
                      <h3 className="mt-1 break-words text-base font-black text-[#0F172A]">{call.client}</h3>
                      <p className="mt-1 text-sm text-[#64748B]">{formatPhone(call.phone)}</p>
                    </div>
                    <StatusPill value={call.result} />
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <MobileDetail label="Тип" value={call.type} />
                    <MobileDetail label="Резюме" value={call.summary} />
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <QuickActionLink href={toTelHref(call.phone)}>
                      <PhoneCall size={14} />
                      Позвонить
                    </QuickActionLink>
                    <QuickActionLink href={toWhatsappHref(call.phone, "Здравствуйте! Это Concept Clinic по вашему обращению.")}>
                      <MessageCircle size={14} />
                      WhatsApp
                    </QuickActionLink>
                  </div>
                </article>
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="text-xs uppercase text-[#94A3B8]">
                <tr>
                  {["Время", "Номер", "Клиент", "Тип", "Результат", "Краткое резюме"].map((header) => (
                    <th key={header} className="border-b border-[#E7ECF3] px-3 py-3 font-bold">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((call) => (
                  <tr key={call.id} className="border-b border-[#EEF2F7] last:border-0">
                    <td className="px-3 py-4 font-black text-[#1A56DB]">{call.time}</td>
                    <td className="px-3 py-4">{call.phone}</td>
                    <td className="px-3 py-4 font-bold text-[#0F172A]">{call.client}</td>
                    <td className="px-3 py-4">{call.type}</td>
                    <td className="px-3 py-4"><StatusPill value={call.result} /></td>
                    <td className="px-3 py-4 text-[#64748B]">{call.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
          <aside className="neu-card">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-xl bg-teal-500/10 p-2 text-[#0F766E]"><Bot size={20} /></div>
              <h2 className="text-lg font-bold text-[#0F172A]">Medina AI телефонист</h2>
            </div>
            <p className="text-sm leading-relaxed text-[#64748B]">Medina принимает звонки, фиксирует намерение клиента и передаёт задачи ресепшну.</p>
            <div className="mt-5 space-y-3">
              {["11 разговоров обработано", "7 клиентов записаны", "3 follow-up задачи созданы"].map((item) => (
                <div key={item} className="rounded-xl bg-[#F8FAFC] p-4 text-sm font-semibold text-[#334155]">{item}</div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </PageLayout>
  );
}

export function DemoTasks() {
  const { items, addItem, updateItem } = useDemoCollection("negis_demo_tasks", tasksSeed, {
    endpoint: "/api/crm/tasks",
    listKey: "tasks",
  });
  const columns: TaskItem["status"][] = ["Новые", "В работе", "Готово"];

  const addTask = () => {
    addItem({
      id: newId("task"),
      title: "Новая demo задача",
      owner: "Ресепшн",
      deadline: "Сегодня",
      priority: "Средний",
      status: "Новые",
    });
    toast.success("Задача создана локально");
  };

  return (
    <PageLayout>
      <div className="space-y-7">
        <PageHeader title="Задачи" subtitle="Kanban для ресепшна, маркетинга и врачей: кто делает, когда дедлайн и что важно." action={<PrimaryButton onClick={addTask}><Plus size={16} />Создать задачу</PrimaryButton>} />
        <div className="grid gap-5 lg:grid-cols-3">
          {columns.map((column) => (
            <section key={column} className="neu-card">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-bold text-[#0F172A]">{column}</h2>
                <span className="rounded-full bg-[#F8FAFC] px-3 py-1 text-xs font-bold text-[#64748B]">{items.filter((task) => task.status === column).length}</span>
              </div>
              <div className="space-y-3">
                {items.filter((task) => task.status === column).map((task) => (
                  <article key={task.id} className="neu-sm p-4">
                    <h3 className="font-bold text-[#0F172A]">{task.title}</h3>
                    <p className="mt-2 text-sm text-[#64748B]">{task.owner} · {task.deadline}</p>
                    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <StatusPill value={task.priority} />
                      <div className="grid grid-cols-2 gap-2 sm:flex">
                        {columns.filter((next) => next !== task.status).map((next) => (
                          <button key={`${task.id}-${next}`} type="button" className="neu-btn min-h-11 px-3 py-2 text-xs" onClick={() => updateItem(task.id, { status: next })}>
                            {next}
                          </button>
                        ))}
                      </div>
                    </div>
                  </article>
                ))}
                {items.filter((task) => task.status === column).length === 0 ? <EmptyHint>Нет задач в этой колонке.</EmptyHint> : null}
              </div>
            </section>
          ))}
        </div>
      </div>
    </PageLayout>
  );
}

export function DemoChat() {
  const { items, addItem } = useDemoCollection("negis_demo_chat", chatSeed, {
    endpoint: "/api/crm/chat",
    listKey: "messages",
  });
  const dialogs = ["Ресепшн", "Маркетолог", "Врач косметолог", "Medina AI"];
  const [active, setActive] = useState(dialogs[0]);
  const [message, setMessage] = useState("");
  const activeMessages = items.filter((item) => item.dialog === active);

  const send = () => {
    const text = message.trim();
    if (!text) return;
    addItem({
      id: newId("msg"),
      dialog: active,
      author: "Вы",
      text,
      time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
    });
    setMessage("");
  };

  return (
    <PageLayout>
      <div className="space-y-7">
        <PageHeader title="Чат" subtitle="Внутренняя коммуникация клиники и demo-диалоги по операционным задачам." />
        <section className="grid min-h-[620px] gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="neu-card">
            <h2 className="mb-4 text-lg font-bold text-[#0F172A]">Диалоги</h2>
            <div className="space-y-2">
              {dialogs.map((dialog) => (
                <button key={dialog} type="button" className={`w-full rounded-xl px-4 py-3 text-left text-sm font-bold transition ${active === dialog ? "bg-[#E0F2FE] text-[#0369A1]" : "bg-[#F8FAFC] text-[#334155]"}`} onClick={() => setActive(dialog)}>
                  {dialog}
                </button>
              ))}
            </div>
          </aside>
          <section className="neu-card flex min-h-0 flex-col">
            <h2 className="mb-4 text-lg font-bold text-[#0F172A]">{active}</h2>
            <div className="flex-1 space-y-3 overflow-y-auto rounded-2xl bg-[#F8FAFC] p-4">
              {activeMessages.map((msg) => (
                <div key={msg.id} className={`max-w-[82%] rounded-2xl px-4 py-3 ${msg.author === "Вы" ? "ml-auto bg-[#1A56DB] text-white" : "bg-white text-[#334155]"}`}>
                  <p className="text-xs font-bold opacity-70">{msg.author} · {msg.time}</p>
                  <p className="mt-1 text-sm leading-relaxed">{msg.text}</p>
                </div>
              ))}
              {activeMessages.length === 0 ? <EmptyHint>Сообщений пока нет.</EmptyHint> : null}
            </div>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <input className="neu-input flex-1" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") send(); }} placeholder="Сообщение..." />
              <PrimaryButton onClick={send}><MessageCircle size={16} />Отправить</PrimaryButton>
            </div>
          </section>
        </section>
      </div>
    </PageLayout>
  );
}

export function DemoMarket() {
  const modules = [
    { title: "ИИ студия контента", text: "Сценарии, avatar prompt, TapNow prompt и Telegram handoff.", href: "/content-studio", icon: Sparkles },
    { title: "ИИ таргетолог", text: "Анализ креативов, запуск pending кампаний и demo reports.", href: "/targeting-agent", icon: Target },
    { title: "Реклама", text: "Meta Ads MVP и настройки рекламного кабинета.", href: "/ads", icon: Megaphone },
    { title: "Отчёты", text: "Недельная аналитика, CPL, записи и рекомендации AI.", href: "/reports", icon: BarChart3 },
  ];

  return (
    <PageLayout>
      <div className="space-y-7">
        <PageHeader title="Маркет" subtitle="Маркетинговый центр: контент, таргетинг, рекламные кампании и отчёты." />
        <MetricGrid
          metrics={[
            { label: "Расход", value: "300 USD", icon: WalletCards, tone: "amber" },
            { label: "Лиды", value: "24", icon: Users, tone: "blue" },
            { label: "CPL", value: "12.5 USD", icon: Target, tone: "teal" },
            { label: "Записи", value: "7", icon: CalendarCheck, tone: "green" },
          ]}
        />
        <div className="neu-card">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-[#0F172A]">ROMI demo</h2>
            <span className="rounded-full bg-green-50 px-3 py-1 text-xs font-bold text-green-700">+218%</span>
          </div>
          <p className="text-sm text-[#64748B]">Demo расчёт показывает, как маркетинг связан с лидами, записями и доходом клиники.</p>
        </div>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {modules.map(({ title, text, href, icon: Icon }) => (
            <Link key={href} href={href}>
              <article className="neu-card h-full cursor-pointer transition-transform hover:-translate-y-0.5">
                <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-[#E0F2FE] text-[#0369A1]">
                  <Icon size={21} />
                </div>
                <h2 className="text-lg font-black text-[#0F172A]">{title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-[#64748B]">{text}</p>
                <p className="mt-5 text-sm font-bold text-[#1A56DB]">Открыть</p>
              </article>
            </Link>
          ))}
        </div>
      </div>
    </PageLayout>
  );
}

export function DemoReports() {
  const weekly = [
    ["Понедельник", "31", "6", "19%", "420 000 ₸"],
    ["Вторник", "28", "5", "18%", "360 000 ₸"],
    ["Среда", "42", "9", "21%", "610 000 ₸"],
    ["Четверг", "37", "8", "22%", "540 000 ₸"],
    ["Пятница", "44", "11", "25%", "740 000 ₸"],
  ];

  return (
    <PageLayout>
      <div className="space-y-7">
        <PageHeader title="Отчёты" subtitle="Demo аналитика по лидам, записям, конверсии и доходу Concept Clinic." action={<Link href="/targeting-agent"><div className="neu-btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm"><Target size={16} />Открыть ИИ таргетолога</div></Link>} />
        <MetricGrid
          metrics={[
            { label: "Лиды", value: "182", icon: Users, tone: "blue" },
            { label: "Записи", value: "39", icon: CalendarCheck, tone: "green" },
            { label: "Конверсия", value: "21%", icon: BarChart3, tone: "teal" },
            { label: "Доход demo", value: "2.67M ₸", icon: WalletCards, tone: "amber" },
          ]}
        />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="neu-card">
            <h2 className="mb-4 text-lg font-bold text-[#0F172A]">Недельный отчёт</h2>
            <div className="space-y-3 md:hidden">
              {weekly.map(([day, leads, appointments, conversion, revenue]) => (
                <article key={day} className="neu-sm p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-black text-[#0F172A]">{day}</h3>
                    <span className="rounded-full bg-green-50 px-3 py-1 text-xs font-bold text-green-700">{conversion}</span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <MobileDetail label="Лиды" value={leads} />
                    <MobileDetail label="Записи" value={appointments} />
                    <MobileDetail label="Доход" value={revenue} />
                  </div>
                </article>
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="text-xs uppercase text-[#94A3B8]">
                <tr>
                  {["День", "Лиды", "Записи", "Конверсия", "Доход"].map((header) => (
                    <th key={header} className="border-b border-[#E7ECF3] px-3 py-3 font-bold">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weekly.map(([day, leads, appointments, conversion, revenue]) => (
                  <tr key={day} className="border-b border-[#EEF2F7] last:border-0">
                    <td className="px-3 py-4 font-bold text-[#0F172A]">{day}</td>
                    <td className="px-3 py-4">{leads}</td>
                    <td className="px-3 py-4">{appointments}</td>
                    <td className="px-3 py-4">{conversion}</td>
                    <td className="px-3 py-4 font-bold text-[#0F172A]">{revenue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
          <aside className="neu-card">
            <h2 className="mb-4 text-lg font-bold text-[#0F172A]">Рекомендации AI</h2>
            <div className="space-y-3">
              {[
                "Усилить follow-up по пропущенным звонкам до 15 минут.",
                "Продолжить тест Reels-креативов для консультаций.",
                "Разделить лиды Instagram и WhatsApp по разным скриптам ресепшна.",
              ].map((item) => (
                <div key={item} className="rounded-xl bg-[#F8FAFC] p-4 text-sm leading-relaxed text-[#334155]">{item}</div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </PageLayout>
  );
}

export function DemoAdmin() {
  const { items: staff, setItems: setStaff, updateItem } = useDemoCollection("negis_demo_staff", staffSeed, {
    endpoint: "/api/crm/staff",
    listKey: "staff",
  });
  const [targetingStatus, setTargetingStatus] = useState("не проверен");
  const [temporaryPassword, setTemporaryPassword] = useState(generateTemporaryPassword);
  const [createdCredentials, setCreatedCredentials] = useState<{
    email: string;
    role: StaffRole;
    temporaryPassword: string;
    loginUrl: string;
    warning?: string;
    authUserCreated?: boolean;
  } | null>(null);
  const [staffForm, setStaffForm] = useState<Omit<StaffMember, "id">>({
    name: "",
    email: "",
    phone: "",
    role: "receptionist",
    status: "active",
  });

  const checkTargeting = async () => {
    setTargetingStatus("проверяем...");
    try {
      const response = await fetch("/api/targeting/health");
      const text = await response.text();
      const body = text ? (JSON.parse(text) as { success?: boolean }) : {};
      setTargetingStatus(response.ok && body.success ? "подключён" : "ошибка health");
    } catch {
      setTargetingStatus("недоступен");
    }
  };

  const updateStaffForm = (field: keyof Omit<StaffMember, "id">, value: string) => {
    setStaffForm((current) => ({
      ...current,
      [field]: field === "role" ? (value as StaffRole) : value,
    }));
  };

  const addStaffMember = async () => {
    if (!staffForm.name.trim() || !staffForm.email.trim()) {
      toast.error("Укажите имя и email сотрудника");
      return;
    }

    const password = temporaryPassword.trim() || generateTemporaryPassword();
    const workspaceId = readCurrentWorkspaceId();
    const localStaff: StaffMember = {
      id: newId("staff"),
      name: staffForm.name.trim(),
      email: staffForm.email.trim().toLowerCase(),
      phone: staffForm.phone.trim(),
      role: staffForm.role,
      status: staffForm.status,
      workspaceId,
      temporaryPasswordSet: true,
      passwordResetRequired: true,
      invitedAt: new Date().toISOString(),
    };

    setStaff((current) => [localStaff, ...current]);

    try {
      const response = await fetch(apiUrl("/api/crm/staff"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: localStaff.name,
          email: localStaff.email,
          phone: localStaff.phone,
          role: localStaff.role,
          status: localStaff.status,
          workspaceId,
          temporaryPassword: password,
        }),
      });
      const body = await readApiJson(response);

      if (!response.ok || body?.success !== true) {
        throw new Error(body?.details?.join(", ") || body?.error || "Не удалось создать сотрудника");
      }

      const savedStaff = staffFromApi(body.data?.staff ?? body.data?.item, localStaff);
      setStaff((current) => current.map((member) => (member.id === localStaff.id ? savedStaff : member)));
      const returnedPassword = typeof body.data?.temporaryPassword === "string" ? body.data.temporaryPassword : password;

      setCreatedCredentials({
        email: savedStaff.email,
        role: savedStaff.role,
        temporaryPassword: returnedPassword,
        loginUrl: typeof body.data?.loginUrl === "string" ? body.data.loginUrl : "/login",
        warning: body.warning,
        authUserCreated: Boolean(body.data?.authUserCreated),
      });

      if (body.warning) {
        toast.warning(body.warning);
      } else {
        toast.success("Сотрудник создан");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Сотрудник сохранён локально";
      setCreatedCredentials({
        email: localStaff.email,
        role: localStaff.role,
        temporaryPassword: password,
        loginUrl: "/login",
        warning: message,
        authUserCreated: false,
      });
      toast.warning(message);
    }

    setStaffForm({
      name: "",
      email: "",
      phone: "",
      role: "receptionist",
      status: "active",
    });
    setTemporaryPassword(generateTemporaryPassword());
  };

  const copyCreatedCredentials = async () => {
    if (!createdCredentials) return;

    const text = [
      "Negis CRM",
      `Login: ${createdCredentials.loginUrl}`,
      `Email: ${createdCredentials.email}`,
      `Role: ${roleLabels[createdCredentials.role]}`,
      `Temporary password: ${createdCredentials.temporaryPassword}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      toast.success("Данные для входа скопированы");
    } catch {
      toast.error("Не удалось скопировать автоматически");
    }
  };

  const integrations = useMemo(
    () => [
      { name: "Supabase", status: import.meta.env.VITE_SUPABASE_URL ? "подключён" : "не подключён", icon: ShieldCheck },
      { name: "Telegram", status: "проверяется через Content Studio", icon: MessageCircle },
      { name: "OpenAI", status: "server env, секреты не показываются", icon: Sparkles },
      { name: "Railway Targeting Agent", status: targetingStatus, icon: Target },
    ],
    [targetingStatus],
  );

  return (
    <PageLayout>
      <div className="space-y-7">
        <PageHeader title="Админ" subtitle="Demo-safe панель настроек: пользователи, роли и статусы интеграций без показа секретов." action={<PrimaryButton onClick={checkTargeting}><Target size={16} />Проверить health</PrimaryButton>} />
        <div className="grid gap-5 lg:grid-cols-3">
          <section className="neu-card">
            <h2 className="text-lg font-bold text-[#0F172A]">Сотрудники</h2>
            <p className="mt-3 text-sm leading-relaxed text-[#64748B]">
              Таблица сохраняется через Supabase при наличии env, иначе работает localStorage fallback.
            </p>
          </section>
          <section className="neu-card">
            <h2 className="text-lg font-bold text-[#0F172A]">Роли</h2>
            <p className="mt-3 text-sm leading-relaxed text-[#64748B]">
              Owner, admin, receptionist, marketer, doctor и manager уже описаны в permissions foundation.
            </p>
          </section>
          <section className="neu-card">
            <h2 className="text-lg font-bold text-[#0F172A]">Интеграции</h2>
            <p className="mt-3 text-sm leading-relaxed text-[#64748B]">
              Проверка подключений без раскрытия токенов, service role keys и Telegram секретов.
            </p>
          </section>
        </div>

        <section className="neu-card">
          <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-lg font-bold text-[#0F172A]">Сотрудники</h2>
              <p className="mt-1 text-sm text-[#64748B]">Создайте профиль сотрудника, роль и временный пароль. Пароль показывается только один раз после создания.</p>
            </div>
            <PrimaryButton onClick={addStaffMember}><UserPlus size={16} />Добавить сотрудника</PrimaryButton>
          </div>
          <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <input className="neu-input" value={staffForm.name} onChange={(event) => updateStaffForm("name", event.target.value)} placeholder="Имя" />
            <input className="neu-input" value={staffForm.email} onChange={(event) => updateStaffForm("email", event.target.value)} placeholder="Email" />
            <input className="neu-input" value={staffForm.phone} onChange={(event) => updateStaffForm("phone", event.target.value)} placeholder="Телефон" />
            <select className="neu-input" value={staffForm.role} onChange={(event) => updateStaffForm("role", event.target.value)}>
              {staffRoles.map((role) => (
                <option key={role} value={role}>{roleLabels[role]}</option>
              ))}
            </select>
            <select className="neu-input" value={staffForm.status} onChange={(event) => updateStaffForm("status", event.target.value)}>
              <option value="active">Активен</option>
              <option value="paused">Пауза</option>
              <option value="disabled">Отключён</option>
            </select>
            <div className="flex min-w-0 gap-2">
              <input
                className="neu-input min-w-0 flex-1"
                value={temporaryPassword}
                onChange={(event) => setTemporaryPassword(event.target.value)}
                placeholder="Временный пароль"
              />
              <button
                type="button"
                className="neu-btn shrink-0 px-3"
                onClick={() => setTemporaryPassword(generateTemporaryPassword())}
                title="Сгенерировать временный пароль"
              >
                <KeyRound size={15} />
              </button>
            </div>
          </div>
          {createdCredentials && (
            <div className="mb-5 rounded-2xl border border-[#BBF7D0] bg-[#F0FDF4] p-4 text-sm text-[#166534]">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h3 className="font-black text-[#14532D]">Сотрудник создан</h3>
                  <p className="mt-1">
                    Email: <b>{createdCredentials.email}</b> · Роль: <b>{roleLabels[createdCredentials.role]}</b> · Вход: <b>{createdCredentials.loginUrl}</b>
                  </p>
                  <p className="mt-1">
                    Временный пароль: <b>{createdCredentials.temporaryPassword}</b>
                  </p>
                  <p className="mt-2 text-[#15803D]">
                    Скопируйте пароль сейчас. После закрытия карточки он не будет показан снова. Сотрудник входит через `/login`.
                  </p>
                  {createdCredentials.warning && (
                    <p className="mt-2 rounded-xl bg-white/70 px-3 py-2 text-[#92400E]">
                      {createdCredentials.warning}
                    </p>
                  )}
                </div>
                <button type="button" className="neu-btn shrink-0" onClick={copyCreatedCredentials}>
                  <Copy size={15} />
                  Copy credentials
                </button>
              </div>
            </div>
          )}
          <div className="space-y-3 md:hidden">
            {staff.map((member) => (
              <article key={member.id} className="neu-sm p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-base font-black text-[#0F172A]">{member.name}</h3>
                    <p className="mt-1 break-words text-sm text-[#64748B]">{member.email}</p>
                  </div>
                  <StatusPill value={member.status} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <MobileDetail label="Телефон" value={formatPhone(member.phone) || "—"} />
                  <MobileDetail label="Роль" value={roleLabels[member.role] ?? member.role} />
                  <MobileDetail label="Пароль" value={member.temporaryPasswordSet ? "выдан" : "не выдан"} />
                </div>
                <button
                  type="button"
                  className="neu-btn mt-4 min-h-11 w-full px-3 py-2 text-xs"
                  onClick={() => updateItem(member.id, { status: member.status === "active" ? "paused" : "active" })}
                >
                  {member.status === "active" ? "Поставить на паузу" : "Активировать"}
                </button>
              </article>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="text-xs uppercase text-[#94A3B8]">
                <tr>
                  {["Имя", "Email", "Телефон", "Роль", "Статус", "Действие"].map((header) => (
                    <th key={header} className="border-b border-[#E7ECF3] px-3 py-3 font-bold">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {staff.map((member) => (
                  <tr key={member.id} className="border-b border-[#EEF2F7] last:border-0">
                    <td className="px-3 py-4 font-bold text-[#0F172A]">{member.name}</td>
                    <td className="px-3 py-4 text-[#334155]">{member.email}</td>
                    <td className="px-3 py-4 text-[#334155]">{member.phone}</td>
                    <td className="px-3 py-4 text-[#334155]">{roleLabels[member.role] ?? member.role}</td>
                    <td className="px-3 py-4"><StatusPill value={member.status} /></td>
                    <td className="px-3 py-4">
                      <button
                        type="button"
                        className="neu-btn px-3 py-1.5 text-xs"
                        onClick={() => updateItem(member.id, { status: member.status === "active" ? "paused" : "active" })}
                      >
                        {member.status === "active" ? "Поставить на паузу" : "Активировать"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="neu-card">
          <h2 className="mb-4 text-lg font-bold text-[#0F172A]">Права роли: {roleLabels[staffForm.role]}</h2>
          <div className="flex flex-wrap gap-2">
            {permissionsForRole(staffForm.role).map((permission) => (
              <span key={permission} className="rounded-full bg-[#F8FAFC] px-3 py-1 text-xs font-bold text-[#334155]">
                {permissionLabels[permission]}
              </span>
            ))}
          </div>
        </section>
        <section className="neu-card">
          <h2 className="mb-4 text-lg font-bold text-[#0F172A]">Статус интеграций</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {integrations.map(({ name, status, icon: Icon }) => (
              <div key={name} className="neu-sm flex items-center justify-between gap-4 p-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-[#E0F2FE] p-2 text-[#0369A1]"><Icon size={18} /></div>
                  <div>
                    <p className="font-bold text-[#0F172A]">{name}</p>
                    <p className="text-sm text-[#64748B]">Секреты не отображаются</p>
                  </div>
                </div>
                <StatusPill value={status} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </PageLayout>
  );
}
