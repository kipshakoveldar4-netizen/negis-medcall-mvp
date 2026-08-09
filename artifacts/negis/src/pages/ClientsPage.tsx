import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import {
  BadgeDollarSign,
  CalendarCheck,
  CheckCircle2,
  ClipboardList,
  Clock,
  Loader2,
  MessageCircle,
  Pencil,
  PhoneCall,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { MetricCard } from "@/components/ui/metric-card";
import { ChangeLogPanel } from "@/components/crm/change-log-panel";
import { TaskPanel } from "@/components/crm/task-panel";
import { useAuth } from "@/contexts/AuthContext";
import { useDemoCollection, readDemoStorage, isRealWorkspace, readWorkspaceId, workspaceScopedKey } from "@/lib/demoStorage";
import { apiUrl, crmFetch } from "@/lib/api";
import { formatPhone, phoneDigits, toTelHref, toWhatsappHref } from "@/lib/phone";

// CRM3 — real "Клиенты" (patient CRM) screen for Negis OS, Glass Morphic Medical AI.
// Backed by the existing /api/crm/clients generic resource (workspace_id schema,
// migration 010) via useDemoCollection: Supabase when configured, localStorage
// fallback otherwise. Related history (заявки/записи/звонки) is read through the
// existing leads/appointments/calls endpoints and matched by client_id or phone.
// Sales entry points only hand a client prefill to /sales; this screen keeps its
// existing client CRUD and related-history responsibilities.
// TODO(CRM): /ai-control-center can later count clients from /api/crm/clients.

type ClientStatusKey = "new" | "active" | "repeat" | "inactive";

type Client = {
  id: string;
  name: string;
  phone: string;
  whatsapp: string;
  source: string;
  status: string; // raw status (canonical or legacy free text) — normalized for display
  comment?: string;
  lastVisit?: string;
  createdAt?: string;
};

type RelatedLead = { id: string; name: string; phone: string; source: string; campaign: string; status: string; clientId?: string; createdAt?: string };
type RelatedAppointment = { id: string; client: string; phone: string; service: string; doctor: string; status: string; startsAt?: string; clientId?: string };
type RelatedCall = { id: string; phone: string; time?: string; type?: string; result?: string; summary?: string; clientId?: string };

type NegisTone = "primary" | "secondary" | "ai" | "success" | "warning" | "error" | "muted";

const STATUS_ORDER: ClientStatusKey[] = ["new", "active", "repeat", "inactive"];

const clientStatusLabel: Record<ClientStatusKey, string> = {
  new: "Новый",
  active: "Активный",
  repeat: "Повторный визит",
  inactive: "Неактивный",
};

const clientStatusPill: Record<ClientStatusKey, "blue" | "green" | "amber" | "slate"> = {
  new: "blue",
  active: "green",
  repeat: "amber",
  inactive: "slate",
};

// Legacy statuses (DemoClients seeds, free-text DB values) are normalized for display
// and counting only — stored values are not migrated. Order matters: "неактив"
// must be checked before "актив".
function normalizeClientStatus(raw?: string): ClientStatusKey {
  const value = (raw || "").toLowerCase();
  if (/(неактив|inactive|lost|потер|арх|arch)/.test(value)) return "inactive";
  if (/(повтор|repeat|return|вернул)/.test(value)) return "repeat";
  if (/(актив|active|vip|постоян)/.test(value)) return "active";
  return "new";
}

const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

// Seed phones overlap the LeadsPage demo seeds so the detail drawer shows related history in demo mode.
const clientsSeed: Client[] = [
  { id: "client-1", name: "Мария Ли", phone: "+7 702 617 12 11", whatsapp: "+7 702 617 12 11", source: "Сайт", status: "active", comment: "Записана на чистку лица, предпочитает утро", lastVisit: daysAgoIso(9), createdAt: daysAgoIso(40) },
  { id: "client-2", name: "Айнур Садыкова", phone: "+7 701 245 18 44", whatsapp: "", source: "Instagram", status: "repeat", comment: "Просит вечерние слоты после 18:00", lastVisit: daysAgoIso(34), createdAt: daysAgoIso(120) },
  { id: "client-3", name: "Жанна Абди", phone: "+7 747 330 19 90", whatsapp: "+7 747 330 19 90", source: "WhatsApp", status: "new", comment: "Ждёт расчёт курса ухода", lastVisit: "", createdAt: daysAgoIso(2) },
  { id: "client-4", name: "Ольга Петрова", phone: "+7 705 812 44 02", whatsapp: "", source: "Рекомендация", status: "inactive", comment: "Не отвечает с мая, предложить акцию", lastVisit: daysAgoIso(95), createdAt: daysAgoIso(200) },
];

const AI_RECOMMENDATION_PLACEHOLDER = "AI-рекомендация по клиенту появится после подключения CRM-аналитики.";
const HISTORY_EMPTY_MESSAGE = "История появится после новых заявок, записей и звонков.";
const CLIENTS_UI_MODE_KEY = "negis_clients_ui_mode";
const APPOINTMENT_PREFILL_KEY = "negis_appointment_prefill";
const DEAL_PREFILL_KEY = "negis_deal_prefill";

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 14,
  border: "1px solid var(--negis-border)",
  background: "var(--negis-surface)",
  color: "var(--negis-text)",
  fontSize: 14,
  padding: "11px 13px",
  outline: "none",
};

function negisToneColor(tone: NegisTone): string {
  return `var(--negis-${tone})`;
}

function negisToneSoftBg(tone: NegisTone): string {
  switch (tone) {
    case "ai":
      return "rgba(124,58,237,0.10)";
    case "secondary":
      return "rgba(37,99,235,0.10)";
    case "success":
      return "rgba(16,185,129,0.12)";
    case "warning":
      return "rgba(245,158,11,0.14)";
    case "error":
      return "rgba(239,68,68,0.10)";
    case "muted":
      return "rgba(148,163,184,0.14)";
    default:
      return "var(--negis-primary-soft)";
  }
}

function StatusPill({ tone, children }: { tone: "green" | "amber" | "red" | "blue" | "slate"; children: ReactNode }) {
  const palette = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-700",
    blue: "border-blue-200 bg-blue-50 text-blue-700",
    slate: "border-slate-200 bg-white/70 text-slate-700",
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-black ${palette[tone]}`}>{children}</span>;
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <p className="flex items-start justify-between gap-3">
      <span className="shrink-0 font-semibold" style={{ color: "var(--negis-muted)" }}>{label}</span>
      <span className="text-right font-bold" style={{ color: "var(--negis-text)" }}>{value}</span>
    </p>
  );
}

// Legacy demo data may hold free text like "20 июня, ботокс" — show it as-is.
function formatDateValue(value?: string): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTimeValue(value?: string): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}


function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

// Load a related collection: real API data when Supabase answers, otherwise the
// demo localStorage of the corresponding page (read-only — never written here).
async function loadRelatedCollection<TItem>(
  endpoint: string,
  listKey: string,
  demoKey: string,
  mapItem: (record: Record<string, unknown>) => TItem,
): Promise<TItem[]> {
  const mapAll = (rawItems: unknown): TItem[] =>
    Array.isArray(rawItems) ? rawItems.map((item) => mapItem((item && typeof item === "object" ? item : {}) as Record<string, unknown>)) : [];

  try {
    const workspaceId = readWorkspaceId();
    const response = await crmFetch(`${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`);
    const text = await response.text();
    const body = text ? (JSON.parse(text) as { success?: boolean; mode?: string; data?: Record<string, unknown> }) : null;
    if (response.ok && body?.success === true && body.mode === "supabase") {
      return mapAll(body.data?.[listKey]);
    }
  } catch {
    // Network/API problems fall through to the demo storage below (demo mode only).
  }
  // Production related history comes from Supabase only — never from demo keys.
  if (isRealWorkspace()) return [];
  return mapAll(readDemoStorage<unknown[]>(demoKey, []));
}

function matchesClient(client: Client, clientId: string | undefined, phone: string | undefined): boolean {
  if (clientId && clientId === client.id) return true;
  const clientDigits = [phoneDigits(client.phone), phoneDigits(client.whatsapp)].filter(Boolean);
  const itemDigits = phoneDigits(phone);
  return Boolean(itemDigits) && clientDigits.includes(itemDigits);
}

function saveAppointmentPrefill(client: Client) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    workspaceScopedKey(APPOINTMENT_PREFILL_KEY),
    // clientId — то, ради чего запись вообще привязывается к карточке.
    // Сосед saveDealPrefill передавал его всегда; здесь он был потерян, и
    // самый прямой поток «записать клиента» создавал визит без связи.
    JSON.stringify({ clientId: client.id, clientName: client.name, phone: client.phone, source: client.source }),
  );
}

function saveDealPrefill(client: Client) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(workspaceScopedKey(DEAL_PREFILL_KEY), JSON.stringify({ clientId: client.id, clientName: client.name }));
}

type ClientForm = { name: string; phone: string; whatsapp: string; source: string; status: ClientStatusKey; lastVisit: string; comment: string };

const emptyForm: ClientForm = { name: "", phone: "", whatsapp: "", source: "", status: "new", lastVisit: "", comment: "" };

export default function ClientsPage() {
  const { rolePermissions } = useAuth();
  const { items, loaded, addItem, updateItem } = useDemoCollection<Client>("negis_demo_clients", clientsSeed, {
    endpoint: "/api/crm/clients",
    listKey: "clients",
    itemKey: "item",
    fromApi: (raw) => {
      const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      return {
        id: str(record.id) || `client-${Date.now()}`,
        name: str(record.name) || str(record.full_name),
        phone: str(record.phone),
        whatsapp: str(record.whatsapp),
        source: str(record.source),
        status: str(record.status) || "new",
        comment: str(record.comment) || str(record.notes) || undefined,
        lastVisit: str(record.lastVisit) || str(record.last_visit_at) || undefined,
        createdAt: str(record.createdAt) || str(record.created_at) || undefined,
      };
    },
    toApi: (client) => ({
      name: client.name,
      phone: client.phone,
      whatsapp: client.whatsapp,
      source: client.source,
      status: client.status,
      comment: client.comment || "",
      ...(client.lastVisit ? { lastVisit: client.lastVisit } : {}),
    }),
  });

  const [isAdminMode, setIsAdminMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(CLIENTS_UI_MODE_KEY) === "admin";
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "new" | "active" | "repeat" | "no_visit">("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ClientForm>(emptyForm);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [related, setRelated] = useState<{ leads: RelatedLead[]; appointments: RelatedAppointment[]; calls: RelatedCall[] } | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);

  const setMode = (admin: boolean) => {
    setIsAdminMode(admin);
    if (typeof window !== "undefined") window.localStorage.setItem(CLIENTS_UI_MODE_KEY, admin ? "admin" : "client");
  };

  // Related history is loaded once per visit (leads, appointments, calls) and matched per client.
  useEffect(() => {
    let cancelled = false;
    setRelatedLoading(true);
    void (async () => {
      const [leads, appointments, calls] = await Promise.all([
        loadRelatedCollection<RelatedLead>("/api/crm/leads", "leads", "negis_demo_leads", (record) => ({
          id: str(record.id),
          name: str(record.name) || str(record.full_name),
          phone: str(record.phone),
          source: str(record.source),
          campaign: str(record.campaign),
          status: str(record.status),
          clientId: str(record.clientId) || str(record.client_id) || undefined,
          createdAt: str(record.createdAt) || str(record.created_at) || undefined,
        })),
        loadRelatedCollection<RelatedAppointment>("/api/crm/appointments", "appointments", "negis_demo_appointments", (record) => ({
          id: str(record.id),
          client: str(record.client) || str(record.clientName) || str(record.client_name),
          phone: str(record.phone) || str(record.clientPhone) || str(record.client_phone),
          service: str(record.service),
          doctor: str(record.doctor) || str(record.doctor_name),
          status: str(record.status),
          startsAt: str(record.startsAt) || str(record.starts_at) || str(record.time) || undefined,
          clientId: str(record.clientId) || str(record.client_id) || undefined,
        })),
        loadRelatedCollection<RelatedCall>("/api/crm/calls", "calls", "negis_demo_calls", (record) => ({
          id: str(record.id),
          phone: str(record.phone),
          time: str(record.time) || str(record.call_time) || undefined,
          type: str(record.type) || str(record.direction) || undefined,
          result: str(record.result) || undefined,
          summary: str(record.summary) || undefined,
          clientId: str(record.clientId) || str(record.client_id) || undefined,
        })),
      ]);
      if (!cancelled) {
        setRelated({ leads, appointments, calls });
        setRelatedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const metrics = useMemo(() => {
    const counts: Record<ClientStatusKey, number> = { new: 0, active: 0, repeat: 0, inactive: 0 };
    let withoutVisit = 0;
    for (const client of items) {
      counts[normalizeClientStatus(client.status)] += 1;
      if (!(client.lastVisit || "").trim()) withoutVisit += 1;
    }
    return { ...counts, withoutVisit };
  }, [items]);

  const summaryMetrics: Array<{ label: string; value: number; icon: LucideIcon; tone: NegisTone }> = [
    { label: "Всего клиентов", value: items.length, icon: Users, tone: "primary" },
    { label: "Новые", value: metrics.new, icon: UserPlus, tone: "secondary" },
    { label: "Активные", value: metrics.active, icon: CheckCircle2, tone: "success" },
    { label: "Нужен повторный визит", value: metrics.repeat, icon: RefreshCw, tone: "warning" },
    { label: "Без последнего визита", value: metrics.withoutVisit, icon: Clock, tone: "muted" },
  ];

  const filterOptions: Array<{ id: typeof filter; label: string }> = [
    { id: "all", label: "Все" },
    { id: "new", label: "Новые" },
    { id: "active", label: "Активные" },
    { id: "repeat", label: "Повторный визит" },
    { id: "no_visit", label: "Без визита" },
  ];

  const visibleClients = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((client) => {
      if (filter === "no_visit") {
        if ((client.lastVisit || "").trim()) return false;
      } else if (filter !== "all" && normalizeClientStatus(client.status) !== filter) {
        return false;
      }
      if (!query) return true;
      return [client.name, client.phone, client.whatsapp, client.source, client.comment].some((field) => (field || "").toLowerCase().includes(query));
    });
  }, [items, filter, search]);

  const detailClient = detailId ? items.find((client) => client.id === detailId) || null : null;
  const detailRelated = useMemo(() => {
    if (!detailClient || !related) return { leads: [], appointments: [], calls: [] };
    return {
      leads: related.leads.filter((lead) => matchesClient(detailClient, lead.clientId, lead.phone)),
      appointments: related.appointments.filter((item) => matchesClient(detailClient, item.clientId, item.phone)),
      calls: related.calls.filter((call) => matchesClient(detailClient, call.clientId, call.phone)),
    };
  }, [detailClient, related]);
  const detailHistoryEmpty = detailRelated.leads.length === 0 && detailRelated.appointments.length === 0 && detailRelated.calls.length === 0;

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm);
    setFormOpen(true);
  }

  function openEdit(client: Client) {
    setEditingId(client.id);
    const parsedVisit = Date.parse(client.lastVisit || "");
    setForm({
      name: client.name,
      phone: client.phone,
      whatsapp: client.whatsapp,
      source: client.source,
      status: normalizeClientStatus(client.status),
      lastVisit: Number.isFinite(parsedVisit) ? new Date(parsedVisit).toISOString().slice(0, 10) : "",
      comment: client.comment || "",
    });
    setDetailId(null);
    setFormOpen(true);
  }

  function submitForm() {
    const name = form.name.trim();
    if (!name) {
      toast.error("Укажите имя клиента");
      return;
    }
    const patch: Partial<Client> = {
      name,
      phone: form.phone.trim(),
      whatsapp: form.whatsapp.trim(),
      source: form.source.trim(),
      status: form.status,
      comment: form.comment.trim(),
      // lastVisit is written only when set — an empty date input never wipes a stored visit.
      ...(form.lastVisit ? { lastVisit: new Date(`${form.lastVisit}T12:00:00`).toISOString() } : {}),
    };
    if (editingId) {
      updateItem(editingId, patch);
      toast.success("Клиент обновлён");
    } else {
      addItem({
        id: `client-${Date.now()}`,
        name,
        phone: patch.phone || "",
        whatsapp: patch.whatsapp || "",
        source: patch.source || "",
        status: patch.status || "new",
        comment: patch.comment,
        lastVisit: patch.lastVisit,
        createdAt: new Date().toISOString(),
      });
      toast.success("Клиент добавлен");
    }
    setFormOpen(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  function changeStatus(client: Client, status: ClientStatusKey) {
    updateItem(client.id, { status });
  }

  return (
    <PageLayout>
      <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="negis-glass-hero p-5 sm:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em]" style={{ color: "var(--negis-primary)" }}>Negis OS · CRM</p>
              <h1 className="mt-2 text-3xl font-black sm:text-4xl" style={{ color: "var(--negis-text)" }}>Клиенты</h1>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
                База пациентов, история обращений, записей и повторных визитов.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap xl:justify-end">
              <div className="inline-flex rounded-2xl border p-1" style={{ borderColor: "var(--negis-border)", background: "var(--negis-surface)" }}>
                {([false, true] as const).map((admin) => (
                  <button
                    key={admin ? "admin" : "client"}
                    type="button"
                    className="rounded-xl px-3 py-2 text-xs font-black transition"
                    style={isAdminMode === admin ? { background: "var(--negis-primary)", color: "#FFFFFF" } : { color: "var(--negis-muted)" }}
                    onClick={() => setMode(admin)}
                  >
                    {admin ? "Админ режим" : "Клиентский режим"}
                  </button>
                ))}
              </div>
              <button type="button" className="neu-btn-primary justify-center" onClick={openAdd}>
                <Plus size={16} />
                Добавить клиента
              </button>
            </div>
          </div>
        </header>

        {/* Summary metrics */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Сводка по клиентам">
          {summaryMetrics.map((metric, index) => (
            <MetricCard
              key={metric.label}
              label={metric.label}
              value={metric.value}
              icon={metric.icon}
              tone={metric.tone}
              accent={index === 0}
            />
          ))}
        </section>

        {/* Filters + search */}
        <section className="negis-glass p-4 sm:p-5">
          <div className="flex flex-wrap gap-2" aria-label="Фильтры клиентов">
            {filterOptions.map((option) => {
              const active = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="rounded-full px-4 py-2 text-xs font-semibold transition"
                  style={
                    active
                      ? { background: "var(--negis-black)", color: "#FFFFFF" }
                      : { background: "var(--negis-surface)", borderColor: "var(--negis-border)", color: "var(--negis-muted)" }
                  }
                  aria-pressed={active}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <label className="relative mt-3 block">
            <span className="sr-only">Поиск по клиентам</span>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2" size={17} style={{ color: "var(--negis-muted)" }} />
            <input
              style={{ ...inputStyle, paddingLeft: 42 }}
              type="search"
              value={search}
              placeholder="Поиск: имя, телефон, WhatsApp, источник или заметка"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </section>

        {/* Loading (production waits for the first Supabase response) / list / empty state */}
        {!loaded ? (
          <section className="negis-glass flex min-h-40 flex-col items-center justify-center gap-3 p-8 text-center" aria-live="polite">
            <Loader2 className="animate-spin" size={22} style={{ color: "var(--negis-primary)" }} />
            <p className="text-sm font-bold" style={{ color: "var(--negis-muted)" }}>Загружаем данные…</p>
          </section>
        ) : items.length === 0 ? (
          <section className="negis-glass-hero flex flex-col items-center gap-3 p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>
              <Users size={24} />
            </div>
            <h2 className="text-xl font-black" style={{ color: "var(--negis-text)" }}>Клиентов пока нет</h2>
            <p className="max-w-md text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              Когда клиника начнёт получать заявки и создавать записи, пациенты появятся здесь.
            </p>
            <button type="button" className="neu-btn-primary justify-center" onClick={openAdd}>
              <Plus size={16} />
              Добавить клиента
            </button>
          </section>
        ) : visibleClients.length === 0 ? (
          <section className="negis-glass flex flex-col items-center gap-3 p-6 text-center">
            <p className="text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>Ничего не найдено. Измените фильтр или поисковый запрос.</p>
            <button
              type="button"
              className="neu-btn justify-center"
              onClick={() => {
                setFilter("all");
                setSearch("");
              }}
            >
              Сбросить фильтры
            </button>
          </section>
        ) : (
          <section className="space-y-3">
            {visibleClients.map((client) => {
              const statusKey = normalizeClientStatus(client.status);
              const contactPhone = client.phone || client.whatsapp;
              const hasPhone = Boolean(phoneDigits(contactPhone));
              return (
                <article key={client.id} className="negis-glass p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl" style={{ background: negisToneSoftBg("primary"), color: negisToneColor("primary") }}>
                          <Users size={15} />
                        </div>
                        <p className="truncate font-black" style={{ color: "var(--negis-text)" }}>{client.name || "Без имени"}</p>
                      </div>
                      <p className="mt-1 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
                        {formatPhone(client.phone) || "Телефон не указан"}
                        {client.source ? ` · ${client.source}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={clientStatusPill[statusKey]}>{clientStatusLabel[statusKey]}</StatusPill>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-x-5 gap-y-1.5 text-sm sm:grid-cols-2">
                    <Fact label="WhatsApp" value={formatPhone(client.whatsapp) || "—"} />
                    <Fact label="Источник" value={client.source || "—"} />
                    <Fact label="Последний визит" value={formatDateValue(client.lastVisit)} />
                    <Fact label="Добавлен" value={formatDateValue(client.createdAt)} />
                  </div>

                  {client.comment ? (
                    <p className="mt-3 rounded-2xl px-3 py-2 text-sm" style={{ background: "var(--negis-surface)", color: "var(--negis-muted)" }}>
                      {client.comment}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <a
                      className={`neu-btn justify-center ${hasPhone ? "" : "pointer-events-none opacity-50"}`}
                      href={hasPhone ? toWhatsappHref(client.whatsapp || client.phone, `Здравствуйте, ${client.name || ""}! Пишем из клиники.`) : undefined}
                      target="_blank"
                      rel="noreferrer"
                      aria-disabled={!hasPhone}
                    >
                      <MessageCircle size={16} />
                      WhatsApp
                    </a>
                    <a
                      className={`neu-btn justify-center ${hasPhone ? "" : "pointer-events-none opacity-50"}`}
                      href={hasPhone ? toTelHref(contactPhone) : undefined}
                      aria-disabled={!hasPhone}
                    >
                      <PhoneCall size={16} />
                      Позвонить
                    </a>
                    <Link href="/appointments" className="neu-btn justify-center" onClick={() => saveAppointmentPrefill(client)}>
                      <CalendarCheck size={16} />
                      Записать
                    </Link>
                    <button type="button" className="neu-btn justify-center" onClick={() => setDetailId(client.id)}>
                      <ClipboardList size={16} />
                      Подробнее
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>

      {/* Add / edit modal */}
      {formOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.35)" }} onClick={() => setFormOpen(false)}>
          <div className="negis-glass w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 sm:p-6" style={{ background: "var(--negis-surface)" }} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-black" style={{ color: "var(--negis-text)" }}>{editingId ? "Изменить клиента" : "Новый клиент"}</h2>
              <button type="button" className="neu-btn px-3 py-2" onClick={() => setFormOpen(false)} aria-label="Закрыть"><X size={16} /></button>
            </div>
            <div className="mt-4 grid gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Имя</span>
                <input style={inputStyle} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Имя клиента" />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Телефон</span>
                  <input style={inputStyle} value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} placeholder="+7 700 000 00 00" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>WhatsApp</span>
                  <input style={inputStyle} value={form.whatsapp} onChange={(event) => setForm((current) => ({ ...current, whatsapp: event.target.value }))} placeholder="Если отличается от телефона" />
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Источник</span>
                  <input style={inputStyle} value={form.source} onChange={(event) => setForm((current) => ({ ...current, source: event.target.value }))} placeholder="Instagram, WhatsApp, сайт…" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Статус</span>
                  <select style={inputStyle} value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as ClientStatusKey }))}>
                    {STATUS_ORDER.map((key) => (
                      <option key={key} value={key}>{clientStatusLabel[key]}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Последний визит</span>
                <input style={inputStyle} type="date" value={form.lastVisit} onChange={(event) => setForm((current) => ({ ...current, lastVisit: event.target.value }))} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Заметки</span>
                <textarea style={{ ...inputStyle, minHeight: 84, resize: "vertical" }} value={form.comment} onChange={(event) => setForm((current) => ({ ...current, comment: event.target.value }))} placeholder="Предпочтения, договорённости, важные детали…" />
              </label>
            </div>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="neu-btn justify-center" onClick={() => setFormOpen(false)}>Отмена</button>
              <button type="button" className="neu-btn-primary justify-center" onClick={submitForm}>
                {editingId ? "Сохранить" : "Добавить клиента"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Detail modal */}
      {detailClient ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.35)" }} onClick={() => setDetailId(null)}>
          <div className="negis-glass w-full max-w-xl max-h-[90vh] overflow-y-auto p-5 sm:p-6" style={{ background: "var(--negis-surface)" }} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-black" style={{ color: "var(--negis-text)" }}>{detailClient.name || "Без имени"}</h2>
                <p className="mt-1 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>{formatPhone(detailClient.phone) || "Телефон не указан"}</p>
              </div>
              <button type="button" className="neu-btn px-3 py-2" onClick={() => setDetailId(null)} aria-label="Закрыть"><X size={16} /></button>
            </div>

            <div className="mt-3">
              <StatusPill tone={clientStatusPill[normalizeClientStatus(detailClient.status)]}>{clientStatusLabel[normalizeClientStatus(detailClient.status)]}</StatusPill>
            </div>

            <div className="mt-4 grid gap-1.5 text-sm">
              <Fact label="WhatsApp" value={formatPhone(detailClient.whatsapp) || "—"} />
              <Fact label="Источник" value={detailClient.source || "—"} />
              <Fact label="Последний визит" value={formatDateValue(detailClient.lastVisit)} />
              <Fact label="Добавлен" value={formatDateValue(detailClient.createdAt)} />
              <Fact label="Заметки" value={detailClient.comment || "—"} />
            </div>

            {/* Quick status change */}
            <div className="mt-4">
              <p className="mb-2 text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Статус</p>
              <div className="flex flex-wrap gap-2">
                {STATUS_ORDER.map((key) => {
                  const active = normalizeClientStatus(detailClient.status) === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition"
                      style={active ? { background: "var(--negis-black)", color: "#FFFFFF" } : { background: "var(--negis-ground)", color: "var(--negis-ink-2)" }}
                      onClick={() => changeStatus(detailClient, key)}
                    >
                      {clientStatusLabel[key]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Кто и когда правил саму карточку — отдельно от того, что с
                клиентом происходило: записи, продажи, звонки. Два разных
                вопроса, и смешивать их в одну ленту значит не ответить ни на
                один. */}
            {isRealWorkspace() && rolePermissions.tasks ? (
              <div className="mt-4">
                <TaskPanel
                  entityType="client"
                  entityId={detailClient.id}
                  canManage={rolePermissions.tasks === true}
                />
              </div>
            ) : null}

            {isRealWorkspace() ? (
              <div className="mt-4">
                <ChangeLogPanel entityType="client" entityId={detailClient.id} />
              </div>
            ) : null}

            {/* Related history */}
            <div className="mt-4">
              <p className="mb-2 text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>История клиента</p>
              {relatedLoading ? (
                <div className="flex items-center gap-2 rounded-2xl p-3 text-sm font-semibold" style={{ background: "var(--negis-surface)", color: "var(--negis-muted)" }}>
                  <Loader2 className="animate-spin" size={15} />
                  Загружаем историю…
                </div>
              ) : detailHistoryEmpty ? (
                <p className="rounded-2xl p-3 text-sm font-semibold" style={{ background: "var(--negis-surface)", color: "var(--negis-muted)" }}>
                  {HISTORY_EMPTY_MESSAGE}
                </p>
              ) : (
                <div className="grid gap-3">
                  {detailRelated.leads.length > 0 ? (
                    <div className="rounded-2xl border p-3" style={{ borderColor: "var(--negis-border)" }}>
                      <p className="text-xs font-black" style={{ color: "var(--negis-text)" }}>Заявки этого клиента</p>
                      <div className="mt-2 grid gap-1.5 text-sm">
                        {detailRelated.leads.slice(0, 5).map((lead) => (
                          <p key={lead.id} className="font-semibold" style={{ color: "var(--negis-muted)" }}>
                            {formatDateTimeValue(lead.createdAt)} · {lead.source || "источник не указан"}
                            {lead.campaign ? ` · ${lead.campaign}` : ""}
                          </p>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {detailRelated.appointments.length > 0 ? (
                    <div className="rounded-2xl border p-3" style={{ borderColor: "var(--negis-border)" }}>
                      <p className="text-xs font-black" style={{ color: "var(--negis-text)" }}>Записи этого клиента</p>
                      <div className="mt-2 grid gap-1.5 text-sm">
                        {detailRelated.appointments.slice(0, 5).map((item) => (
                          <p key={item.id} className="font-semibold" style={{ color: "var(--negis-muted)" }}>
                            {formatDateTimeValue(item.startsAt)} · {item.service || "услуга не указана"}
                            {item.doctor ? ` · ${item.doctor}` : ""}
                          </p>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {detailRelated.calls.length > 0 ? (
                    <div className="rounded-2xl border p-3" style={{ borderColor: "var(--negis-border)" }}>
                      <p className="text-xs font-black" style={{ color: "var(--negis-text)" }}>Звонки этого клиента</p>
                      <div className="mt-2 grid gap-1.5 text-sm">
                        {detailRelated.calls.slice(0, 5).map((call) => (
                          <p key={call.id} className="font-semibold" style={{ color: "var(--negis-muted)" }}>
                            {formatDateTimeValue(call.time)} · {call.type || "звонок"}
                            {call.result ? ` · ${call.result}` : ""}
                          </p>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {/* AI recommendation placeholder */}
            <div className="mt-4 rounded-2xl p-3" style={{ background: negisToneSoftBg("ai") }}>
              <div className="flex items-center gap-2">
                <Sparkles size={15} style={{ color: "var(--negis-ai)" }} />
                <p className="text-sm font-bold" style={{ color: "var(--negis-text)" }}>Следующий шаг</p>
              </div>
              <p className="mt-1 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>{AI_RECOMMENDATION_PLACEHOLDER}</p>
            </div>

            {/* Admin-only technical details (collapsed) */}
            {isAdminMode ? (
              <details className="mt-4 overflow-hidden rounded-2xl border" style={{ borderColor: "var(--negis-border)" }}>
                <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-black uppercase tracking-[0.1em]" style={{ color: "var(--negis-primary)" }}>Технические данные</summary>
                <div className="grid gap-1 px-4 pb-4 pt-1 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
                  <p>client id: {detailClient.id || "-"}</p>
                  <p>related leads: {detailRelated.leads.length}</p>
                  <p>related appointments: {detailRelated.appointments.length}</p>
                  <p>related calls: {detailRelated.calls.length}</p>
                  <p>Данные ограничены текущей клиникой (workspace).</p>
                </div>
              </details>
            ) : null}

            <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
              <button type="button" className="neu-btn justify-center" onClick={() => openEdit(detailClient)}>
                <Pencil size={16} />
                Изменить
              </button>
              <Link href="/appointments" className="neu-btn justify-center" onClick={() => saveAppointmentPrefill(detailClient)}>
                <CalendarCheck size={16} />
                Записать
              </Link>
              <Link href="/sales" className="neu-btn-primary justify-center" onClick={() => saveDealPrefill(detailClient)}>
                <BadgeDollarSign size={16} />
                Оформить продажу
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </PageLayout>
  );
}
