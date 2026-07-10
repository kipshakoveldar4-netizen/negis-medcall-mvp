import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import {
  CalendarCheck,
  CheckCircle2,
  ClipboardList,
  Inbox,
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
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { useDemoCollection, readDemoStorage, writeDemoStorage } from "@/lib/demoStorage";
import { apiUrl } from "@/lib/api";
import { formatPhone, phoneDigits, toTelHref, toWhatsappHref } from "@/lib/phone";

// CRM2 — real "Заявки" (leads) screen for Negis OS, Glass Morphic Medical AI.
// Backed by the existing /api/crm/leads generic resource (workspace_id schema,
// migration 010) via useDemoCollection: Supabase when configured, localStorage
// fallback otherwise. No migrations, no new API files, no attribution/deals yet.

type LeadStatusKey = "new" | "in_progress" | "booked" | "lost";

type Lead = {
  id: string;
  name: string;
  phone: string;
  source: string;
  campaign: string;
  status: string; // raw status (English canonical or legacy Russian) — normalized for display
  owner?: string; // display-only responsible name (demo/local); DB has no name column
  notes?: string;
  responsibleUserId?: string;
  clientId?: string;
  createdAt?: string;
};

type NegisTone = "primary" | "secondary" | "ai" | "success" | "warning" | "error" | "muted";

const STATUS_ORDER: LeadStatusKey[] = ["new", "in_progress", "booked", "lost"];

const leadStatusLabel: Record<LeadStatusKey, string> = {
  new: "Новая",
  in_progress: "В работе",
  booked: "Записана",
  lost: "Потеряна",
};

const leadStatusPill: Record<LeadStatusKey, "blue" | "amber" | "green" | "red"> = {
  new: "blue",
  in_progress: "amber",
  booked: "green",
  lost: "red",
};

const leadStatusMetricTone: Record<LeadStatusKey, NegisTone> = {
  new: "secondary",
  in_progress: "warning",
  booked: "success",
  lost: "error",
};

// Legacy statuses in demo/prod data are free text (English or Russian). Normalize for
// display and counting without migrating the stored values.
function normalizeLeadStatus(raw?: string): LeadStatusKey {
  const value = (raw || "").toLowerCase();
  if (/(work|в работе|прогресс|progress|contact|связ|звон)/.test(value)) return "in_progress";
  if (/(book|запис|schedul|пришёл|пришел|приш|arriv|visit|came|показ)/.test(value)) return "booked";
  if (/(lost|потер|отказ|reject|declin|cancel|отмен|fail|неудач|спам)/.test(value)) return "lost";
  return "new";
}

const leadsSeed: Lead[] = [
  { id: "lead-1", name: "Лаура Ким", phone: "+7 700 801 77 21", source: "Instagram", campaign: "Бесплатная консультация", status: "new", owner: "Ресепшн", notes: "Хочет диагностику кожи на этой неделе", createdAt: new Date(Date.now() - 45 * 60 * 1000).toISOString() },
  { id: "lead-2", name: "Жанна Абди", phone: "+7 747 330 19 90", source: "WhatsApp", campaign: "Reels ботокс", status: "in_progress", owner: "Айгерим", notes: "Ждёт расчёт курса, перезвонить после 17:00", createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
  { id: "lead-3", name: "Мария Ли", phone: "+7 702 617 12 11", source: "Сайт", campaign: "Skin audit", status: "booked", owner: "Medina AI", notes: "Записана на чистку лица", createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString() },
  { id: "lead-4", name: "Ирина Ким", phone: "+7 777 422 55 01", source: "Instagram", campaign: "Laser promo", status: "lost", owner: "Маркетолог", notes: "Не устроила цена, предложить акцию позже", createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
];

const AI_RECOMMENDATION_PLACEHOLDER = "AI-рекомендация появится после подключения CRM-аналитики.";
const LEADS_UI_MODE_KEY = "negis_leads_ui_mode";
const APPOINTMENT_PREFILL_KEY = "negis_appointment_prefill";

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

function LeadMetricCard({ label, value, icon: Icon, tone }: { label: string; value: number; icon: LucideIcon; tone: NegisTone }) {
  return (
    <div className="negis-glass p-4">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: negisToneSoftBg(tone), color: negisToneColor(tone) }}>
          <Icon size={16} />
        </div>
        <p className="text-xs font-black leading-tight" style={{ color: "var(--negis-muted)" }}>{label}</p>
      </div>
      <p className="mt-2 text-2xl font-black" style={{ color: "var(--negis-text)" }}>{value}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <p className="flex items-start justify-between gap-3">
      <span className="shrink-0 font-semibold" style={{ color: "var(--negis-muted)" }}>{label}</span>
      <span className="text-right font-bold" style={{ color: "var(--negis-text)" }}>{value}</span>
    </p>
  );
}

function formatCreatedAt(value?: string): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Appointment prefill consumed by /appointments (clientName/phone/whatsapp/service/source);
// clientId and notes ride along for the future client_id-aware appointment flow.
function saveAppointmentPrefill(lead: Lead) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    APPOINTMENT_PREFILL_KEY,
    JSON.stringify({
      clientId: lead.clientId || "",
      clientName: lead.name,
      phone: lead.phone,
      whatsapp: lead.phone,
      source: lead.source,
      service: lead.campaign,
      notes: lead.campaign ? `Заявка из кампании «${lead.campaign}»` : "Заявка из CRM",
    }),
  );
}

// Minimal client shape shared with ClientsPage (localStorage key negis_demo_clients).
type ExistingClient = {
  id: string;
  name: string;
  phone: string;
  whatsapp: string;
  source: string;
  status: string;
  comment?: string;
  lastVisit?: string;
  createdAt?: string;
};

function readWorkspaceId(): string {
  if (typeof window === "undefined") return "demo-workspace";
  for (const key of ["negis_staff_user", "negis_staff_session", "negis_demo_workspace"]) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const value = JSON.parse(raw) as { id?: unknown; workspaceId?: unknown; workspace_id?: unknown };
      const workspaceId =
        typeof value.workspaceId === "string" && value.workspaceId.trim()
          ? value.workspaceId.trim()
          : typeof value.workspace_id === "string" && value.workspace_id.trim()
            ? value.workspace_id.trim()
            : key === "negis_demo_workspace" && typeof value.id === "string" && value.id.trim()
              ? value.id.trim()
              : "";
      if (workspaceId) return workspaceId;
    } catch {
      // Ignore malformed localStorage; fall back to demo.
    }
  }
  return "demo-workspace";
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function clientFromRecord(raw: unknown): ExistingClient {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: toStr(record.id),
    name: toStr(record.name) || toStr(record.full_name),
    phone: toStr(record.phone),
    whatsapp: toStr(record.whatsapp),
    source: toStr(record.source),
    status: toStr(record.status) || "new",
    comment: toStr(record.comment) || toStr(record.notes) || undefined,
    lastVisit: toStr(record.lastVisit) || toStr(record.last_visit_at) || undefined,
    createdAt: toStr(record.createdAt) || toStr(record.created_at) || undefined,
  };
}

// Duplicate check source: real API clients when Supabase answers, otherwise the
// /clients demo storage (read-only here; created clients are prepended separately).
async function loadExistingClients(): Promise<ExistingClient[]> {
  try {
    const workspaceId = readWorkspaceId();
    const response = await fetch(apiUrl(`/api/crm/clients?workspaceId=${encodeURIComponent(workspaceId)}`));
    const text = await response.text();
    const body = text ? (JSON.parse(text) as { success?: boolean; mode?: string; data?: { clients?: unknown[] } }) : null;
    if (response.ok && body?.success === true && body.mode === "supabase" && Array.isArray(body.data?.clients)) {
      return body.data.clients.map(clientFromRecord);
    }
  } catch {
    // Network/API problems fall through to demo storage.
  }
  return readDemoStorage<unknown[]>("negis_demo_clients", []).map(clientFromRecord);
}

type LeadForm = { name: string; phone: string; source: string; campaign: string; status: LeadStatusKey; notes: string };

const emptyForm: LeadForm = { name: "", phone: "", source: "", campaign: "", status: "new", notes: "" };

export default function LeadsPage() {
  const { items, addItem, updateItem } = useDemoCollection<Lead>("negis_demo_leads", leadsSeed, {
    endpoint: "/api/crm/leads",
    listKey: "leads",
    itemKey: "item",
    fromApi: (raw) => {
      const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
      return {
        id: str(record.id) || `lead-${Date.now()}`,
        name: str(record.name) || str(record.full_name),
        phone: str(record.phone),
        source: str(record.source),
        campaign: str(record.campaign),
        status: str(record.status) || "new",
        owner: str(record.owner) || undefined,
        notes: str(record.notes) || undefined,
        responsibleUserId: str(record.responsibleUserId) || str(record.responsible_user_id) || undefined,
        clientId: str(record.clientId) || str(record.client_id) || undefined,
        createdAt: str(record.createdAt) || str(record.created_at) || undefined,
      };
    },
    toApi: (lead) => ({
      name: lead.name,
      phone: lead.phone,
      source: lead.source,
      campaign: lead.campaign,
      status: lead.status,
      notes: lead.notes || "",
    }),
  });

  const [isAdminMode, setIsAdminMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(LEADS_UI_MODE_KEY) === "admin";
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | LeadStatusKey>("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<LeadForm>(emptyForm);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  // Admin-only diagnostics: whether the conversion matched an existing client (per lead).
  const [conversionMatched, setConversionMatched] = useState<Record<string, boolean>>({});

  const setMode = (admin: boolean) => {
    setIsAdminMode(admin);
    if (typeof window !== "undefined") window.localStorage.setItem(LEADS_UI_MODE_KEY, admin ? "admin" : "client");
  };

  const metrics = useMemo(() => {
    const counts: Record<LeadStatusKey, number> = { new: 0, in_progress: 0, booked: 0, lost: 0 };
    for (const lead of items) counts[normalizeLeadStatus(lead.status)] += 1;
    return counts;
  }, [items]);

  const summaryMetrics: Array<{ label: string; value: number; icon: LucideIcon; tone: NegisTone }> = [
    { label: "Всего заявок", value: items.length, icon: Inbox, tone: "primary" },
    { label: "Новые", value: metrics.new, icon: Sparkles, tone: "secondary" },
    { label: "В работе", value: metrics.in_progress, icon: ClipboardList, tone: "warning" },
    { label: "Записаны", value: metrics.booked, icon: CheckCircle2, tone: "success" },
    { label: "Потеряны", value: metrics.lost, icon: XCircle, tone: metrics.lost > 0 ? "error" : "muted" },
  ];

  const filterOptions: Array<{ id: "all" | LeadStatusKey; label: string }> = [
    { id: "all", label: "Все" },
    { id: "new", label: "Новые" },
    { id: "in_progress", label: "В работе" },
    { id: "booked", label: "Записаны" },
    { id: "lost", label: "Потеряны" },
  ];

  const visibleLeads = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((lead) => {
      if (filter !== "all" && normalizeLeadStatus(lead.status) !== filter) return false;
      if (!query) return true;
      return [lead.name, lead.phone, lead.source, lead.campaign].some((field) => (field || "").toLowerCase().includes(query));
    });
  }, [items, filter, search]);

  const detailLead = detailId ? items.find((lead) => lead.id === detailId) || null : null;

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm);
    setFormOpen(true);
  }

  function openEdit(lead: Lead) {
    setEditingId(lead.id);
    setForm({
      name: lead.name,
      phone: lead.phone,
      source: lead.source,
      campaign: lead.campaign,
      status: normalizeLeadStatus(lead.status),
      notes: lead.notes || "",
    });
    setDetailId(null);
    setFormOpen(true);
  }

  function submitForm() {
    const name = form.name.trim();
    const phone = form.phone.trim();
    if (!name && !phone) {
      toast.error("Укажите имя или телефон заявки");
      return;
    }
    const patch = {
      name,
      phone,
      source: form.source.trim(),
      campaign: form.campaign.trim(),
      status: form.status,
      notes: form.notes.trim(),
    };
    if (editingId) {
      updateItem(editingId, patch);
      toast.success("Заявка обновлена");
    } else {
      addItem({ id: `lead-${Date.now()}`, createdAt: new Date().toISOString(), ...patch });
      toast.success("Заявка добавлена");
    }
    setFormOpen(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  function changeStatus(lead: Lead, status: LeadStatusKey) {
    updateItem(lead.id, { status });
  }

  // «Записать»: store the appointment prefill and confirm; navigation is the Link itself.
  function handleBookFromLead(lead: Lead) {
    try {
      saveAppointmentPrefill(lead);
      toast.success("Данные переданы в запись.");
    } catch {
      toast.error("Не удалось подготовить запись.");
    }
  }

  // Lead → client conversion: reuse an existing client matched by normalized phone,
  // otherwise create a new client from the lead fields, then link the lead via client_id.
  async function convertLeadToClient(lead: Lead) {
    if (convertingId || lead.clientId) return;
    setConvertingId(lead.id);
    try {
      const leadDigits = phoneDigits(lead.phone);
      if (!leadDigits) {
        toast.warning("У заявки нет телефона. Проверьте данные клиента.");
      }

      const existingClients = await loadExistingClients();
      const matched = leadDigits
        ? existingClients.find((client) => [phoneDigits(client.phone), phoneDigits(client.whatsapp)].includes(leadDigits))
        : undefined;

      if (matched && matched.id) {
        try {
          updateItem(lead.id, { clientId: matched.id });
          setConversionMatched((current) => ({ ...current, [lead.id]: true }));
          toast.success("Заявка связана с существующим клиентом.");
        } catch {
          toast.error("Не удалось связать заявку с клиентом.");
        }
        return;
      }

      // No duplicate — create a new client from the lead fields.
      const contextParts = [lead.source, lead.campaign].filter(Boolean).join(", ");
      const newClient: ExistingClient = {
        id: `client-${Date.now()}`,
        name: lead.name || formatPhone(lead.phone) || "Клиент из заявки",
        phone: lead.phone,
        whatsapp: lead.phone,
        source: lead.source,
        status: "new",
        comment: contextParts ? `Создан из заявки (${contextParts})` : "Создан из заявки",
        createdAt: new Date().toISOString(),
      };

      let savedClient = newClient;
      try {
        const workspaceId = readWorkspaceId();
        const response = await fetch(apiUrl("/api/crm/clients"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            name: newClient.name,
            phone: newClient.phone,
            whatsapp: newClient.whatsapp,
            source: newClient.source,
            status: newClient.status,
            comment: newClient.comment,
          }),
        });
        const text = await response.text();
        const body = text ? (JSON.parse(text) as { success?: boolean; mode?: string; data?: { item?: unknown } }) : null;
        if (response.ok && body?.success === true && body.mode === "supabase" && body.data?.item) {
          const persisted = clientFromRecord(body.data.item);
          if (persisted.id) savedClient = { ...persisted, comment: persisted.comment ?? newClient.comment };
        }
      } catch {
        // Offline/demo: the local client below still keeps the flow working.
      }

      // Show the client in /clients immediately (shared demo storage, newest first).
      writeDemoStorage("negis_demo_clients", [savedClient, ...readDemoStorage<unknown[]>("negis_demo_clients", []).map(clientFromRecord).filter((client) => client.id !== savedClient.id)]);

      // Link the lead and move a fresh lead into work (never downgrade booked/lost).
      const statusPatch = normalizeLeadStatus(lead.status) === "new" ? { status: "in_progress" as LeadStatusKey } : {};
      updateItem(lead.id, { clientId: savedClient.id, ...statusPatch });
      setConversionMatched((current) => ({ ...current, [lead.id]: false }));
      toast.success("Клиент создан из заявки.");
    } catch {
      toast.error("Не удалось создать клиента.");
    } finally {
      setConvertingId(null);
    }
  }

  return (
    <PageLayout>
      <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="negis-glass-hero p-5 sm:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em]" style={{ color: "var(--negis-primary)" }}>Negis OS · CRM</p>
              <h1 className="mt-2 text-3xl font-black sm:text-4xl" style={{ color: "var(--negis-text)" }}>Заявки</h1>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
                Новые обращения из рекламы, сайта, WhatsApp и других источников.
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
                Добавить заявку
              </button>
            </div>
          </div>
        </header>

        {/* Summary metrics */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Сводка по заявкам">
          {summaryMetrics.map((metric) => (
            <LeadMetricCard key={metric.label} label={metric.label} value={metric.value} icon={metric.icon} tone={metric.tone} />
          ))}
        </section>

        {/* Filters + search */}
        <section className="negis-glass p-4 sm:p-5">
          <div className="flex flex-wrap gap-2" aria-label="Фильтры заявок">
            {filterOptions.map((option) => {
              const active = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="rounded-full border px-4 py-2 text-xs font-black transition"
                  style={
                    active
                      ? { background: "var(--negis-primary)", borderColor: "var(--negis-primary)", color: "#FFFFFF" }
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
            <span className="sr-only">Поиск по заявкам</span>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2" size={17} style={{ color: "var(--negis-muted)" }} />
            <input
              style={{ ...inputStyle, paddingLeft: 42 }}
              type="search"
              value={search}
              placeholder="Поиск: имя, телефон, источник или кампания"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </section>

        {/* List / empty state */}
        {items.length === 0 ? (
          <section className="negis-glass-hero flex flex-col items-center gap-3 p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>
              <Inbox size={24} />
            </div>
            <h2 className="text-xl font-black" style={{ color: "var(--negis-text)" }}>Заявок пока нет</h2>
            <p className="max-w-md text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              Когда клиника начнёт получать обращения из рекламы, сайта или WhatsApp, они появятся здесь.
            </p>
            <button type="button" className="neu-btn-primary justify-center" onClick={openAdd}>
              <Plus size={16} />
              Добавить заявку
            </button>
          </section>
        ) : visibleLeads.length === 0 ? (
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
            {visibleLeads.map((lead) => {
              const statusKey = normalizeLeadStatus(lead.status);
              const hasPhone = Boolean((lead.phone || "").replace(/\D/g, ""));
              return (
                <article key={lead.id} className="negis-glass p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl" style={{ background: negisToneSoftBg("primary"), color: negisToneColor("primary") }}>
                          <Users size={15} />
                        </div>
                        <p className="truncate font-black" style={{ color: "var(--negis-text)" }}>{lead.name || "Без имени"}</p>
                      </div>
                      <p className="mt-1 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
                        {formatPhone(lead.phone) || "Телефон не указан"}
                        {lead.source ? ` · ${lead.source}` : ""}
                        {lead.campaign ? ` · ${lead.campaign}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={leadStatusPill[statusKey]}>{leadStatusLabel[statusKey]}</StatusPill>
                      {lead.clientId ? <StatusPill tone="green">Клиент создан</StatusPill> : null}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-x-5 gap-y-1.5 text-sm sm:grid-cols-2">
                    <Fact label="Источник" value={lead.source || "—"} />
                    <Fact label="Кампания" value={lead.campaign || "—"} />
                    <Fact label="Ответственный" value={lead.owner || (lead.responsibleUserId ? "Назначен" : "—")} />
                    <Fact label="Создана" value={formatCreatedAt(lead.createdAt)} />
                  </div>

                  {lead.notes ? (
                    <p className="mt-3 rounded-2xl px-3 py-2 text-sm" style={{ background: "var(--negis-surface)", color: "var(--negis-muted)" }}>
                      {lead.notes}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <a
                      className={`neu-btn justify-center ${hasPhone ? "" : "pointer-events-none opacity-50"}`}
                      href={hasPhone ? toWhatsappHref(lead.phone, `Здравствуйте, ${lead.name || ""}! Пишем из клиники.`) : undefined}
                      target="_blank"
                      rel="noreferrer"
                      aria-disabled={!hasPhone}
                    >
                      <MessageCircle size={16} />
                      WhatsApp
                    </a>
                    <a
                      className={`neu-btn justify-center ${hasPhone ? "" : "pointer-events-none opacity-50"}`}
                      href={hasPhone ? toTelHref(lead.phone) : undefined}
                      aria-disabled={!hasPhone}
                    >
                      <PhoneCall size={16} />
                      Позвонить
                    </a>
                    <Link href="/appointments" className="neu-btn justify-center" onClick={() => handleBookFromLead(lead)}>
                      <CalendarCheck size={16} />
                      Записать
                    </Link>
                    {lead.clientId ? (
                      <Link href="/clients" className="neu-btn justify-center">
                        <Users size={16} />
                        Открыть клиентов
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="neu-btn justify-center"
                        disabled={convertingId === lead.id}
                        onClick={() => void convertLeadToClient(lead)}
                      >
                        {convertingId === lead.id ? <Loader2 className="animate-spin" size={16} /> : <UserPlus size={16} />}
                        Создать клиента
                      </button>
                    )}
                    <button type="button" className="neu-btn justify-center" onClick={() => setDetailId(lead.id)}>
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
              <h2 className="text-lg font-black" style={{ color: "var(--negis-text)" }}>{editingId ? "Изменить заявку" : "Новая заявка"}</h2>
              <button type="button" className="neu-btn px-3 py-2" onClick={() => setFormOpen(false)} aria-label="Закрыть"><X size={16} /></button>
            </div>
            <div className="mt-4 grid gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Имя</span>
                <input style={inputStyle} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Имя клиента" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Телефон</span>
                <input style={inputStyle} value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} placeholder="+7 700 000 00 00" />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Источник</span>
                  <input style={inputStyle} value={form.source} onChange={(event) => setForm((current) => ({ ...current, source: event.target.value }))} placeholder="Instagram, WhatsApp, сайт…" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Кампания</span>
                  <input style={inputStyle} value={form.campaign} onChange={(event) => setForm((current) => ({ ...current, campaign: event.target.value }))} placeholder="Название кампании" />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Статус</span>
                <select style={inputStyle} value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as LeadStatusKey }))}>
                  {STATUS_ORDER.map((key) => (
                    <option key={key} value={key}>{leadStatusLabel[key]}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Заметки</span>
                <textarea style={{ ...inputStyle, minHeight: 84, resize: "vertical" }} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Что просит клиент, договорённости…" />
              </label>
            </div>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="neu-btn justify-center" onClick={() => setFormOpen(false)}>Отмена</button>
              <button type="button" className="neu-btn-primary justify-center" onClick={submitForm}>
                {editingId ? "Сохранить" : "Добавить заявку"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Detail modal */}
      {detailLead ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.35)" }} onClick={() => setDetailId(null)}>
          <div className="negis-glass w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 sm:p-6" style={{ background: "var(--negis-surface)" }} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-black" style={{ color: "var(--negis-text)" }}>{detailLead.name || "Без имени"}</h2>
                <p className="mt-1 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>{formatPhone(detailLead.phone) || "Телефон не указан"}</p>
              </div>
              <button type="button" className="neu-btn px-3 py-2" onClick={() => setDetailId(null)} aria-label="Закрыть"><X size={16} /></button>
            </div>

            <div className="mt-3">
              <StatusPill tone={leadStatusPill[normalizeLeadStatus(detailLead.status)]}>{leadStatusLabel[normalizeLeadStatus(detailLead.status)]}</StatusPill>
            </div>

            <div className="mt-4 grid gap-1.5 text-sm">
              <Fact label="Источник" value={detailLead.source || "—"} />
              <Fact label="Кампания" value={detailLead.campaign || "—"} />
              <Fact label="Ответственный" value={detailLead.owner || (detailLead.responsibleUserId ? "Назначен" : "—")} />
              <Fact label="Клиент" value={detailLead.clientId ? "Создан" : "Не создан"} />
              <Fact label="Создана" value={formatCreatedAt(detailLead.createdAt)} />
              <Fact label="Заметки" value={detailLead.notes || "—"} />
            </div>

            {/* Lead → client conversion */}
            <div className="mt-4 rounded-2xl border p-3" style={{ borderColor: "var(--negis-border)" }}>
              {detailLead.clientId ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-bold" style={{ color: "var(--negis-text)" }}>Клиент уже создан</p>
                  <Link href="/clients" className="neu-btn justify-center px-4 py-2 text-xs">
                    <Users size={15} />
                    Открыть клиентов
                  </Link>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>
                    Сначала создайте клиента, чтобы связать запись с карточкой пациента.
                  </p>
                  <button
                    type="button"
                    className="neu-btn-primary justify-center"
                    disabled={convertingId === detailLead.id}
                    onClick={() => void convertLeadToClient(detailLead)}
                  >
                    {convertingId === detailLead.id ? <Loader2 className="animate-spin" size={16} /> : <UserPlus size={16} />}
                    Создать клиента
                  </button>
                </div>
              )}
            </div>

            {/* Quick status change */}
            <div className="mt-4">
              <p className="mb-2 text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Статус</p>
              <div className="flex flex-wrap gap-2">
                {STATUS_ORDER.map((key) => {
                  const active = normalizeLeadStatus(detailLead.status) === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      className="rounded-full border px-3 py-1.5 text-xs font-black transition"
                      style={active ? { background: "var(--negis-primary)", borderColor: "var(--negis-primary)", color: "#FFFFFF" } : { background: "var(--negis-surface)", borderColor: "var(--negis-border)", color: "var(--negis-muted)" }}
                      onClick={() => changeStatus(detailLead, key)}
                    >
                      {leadStatusLabel[key]}
                    </button>
                  );
                })}
              </div>
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
                  <p>lead id: {detailLead.id || "-"}</p>
                  <p>client_id present: {detailLead.clientId ? "yes" : "no"}</p>
                  <p>responsible_user_id present: {detailLead.responsibleUserId ? "yes" : "no"}</p>
                  <p>matched existing client: {detailLead.id in conversionMatched ? (conversionMatched[detailLead.id] ? "yes" : "no") : "-"}</p>
                  <p>Данные ограничены текущей клиникой (workspace).</p>
                </div>
              </details>
            ) : null}

            <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
              <button type="button" className="neu-btn justify-center" onClick={() => openEdit(detailLead)}>
                <Pencil size={16} />
                Изменить
              </button>
              <Link href="/appointments" className="neu-btn justify-center" onClick={() => handleBookFromLead(detailLead)}>
                <CalendarCheck size={16} />
                Записать
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </PageLayout>
  );
}
