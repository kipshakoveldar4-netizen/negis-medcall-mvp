import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import {
  BadgeDollarSign,
  CheckCircle2,
  Clock3,
  Loader2,
  Pencil,
  Plus,
  ReceiptText,
  RotateCcw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { MetricCard } from "@/components/ui/metric-card";
import { apiUrl, crmFetch } from "@/lib/api";
import { isRealWorkspace, readDemoStorage, readWorkspaceId, useDemoCollection, workspaceScopedKey } from "@/lib/demoStorage";

type DealStatus = "pending" | "paid" | "cancelled" | "refunded";
type PaymentMethod = "" | "cash" | "card" | "kaspi" | "transfer" | "other";
type NegisTone = "primary" | "secondary" | "success" | "warning" | "error" | "muted";

type Deal = {
  id: string;
  title: string;
  amountMinor: number;
  currency: string;
  status: DealStatus;
  paidAt?: string;
  closedAt?: string;
  paymentMethod?: string;
  clientId?: string;
  leadId?: string;
  appointmentId?: string;
  /** Услуга справочника, ради которой выручка по услуге вообще вычислима. */
  serviceId?: string;
  metaCampaignLaunchId?: string;
  responsibleUserId?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
};

type ClientOption = { id: string; name: string };
type LeadOption = {
  id: string;
  name: string;
  campaign: string;
  clientId?: string;
  metaCampaignLaunchId?: string;
};
type AppointmentOption = { id: string; client: string; service: string; startsAt?: string; clientId?: string };
type CampaignOption = { id: string; name: string; label: string };

/** Строка справочника услуг, в объёме, который нужен карточке продажи. */
type ServiceOption = { id: string; name: string; basePriceMinor: number | null; sortOrder: number };

type SalesReferences = {
  clients: ClientOption[];
  leads: LeadOption[];
  appointments: AppointmentOption[];
  campaigns: CampaignOption[];
  services: ServiceOption[];
};

type DealForm = {
  title: string;
  serviceId: string;
  amountTenge: string;
  status: DealStatus;
  paymentMethod: PaymentMethod;
  clientId: string;
  leadId: string;
  appointmentId: string;
  metaCampaignLaunchId: string;
  notes: string;
};

const DEAL_PREFILL_KEY = "negis_deal_prefill";
const CLIENT_OPEN_KEY = "negis_client_open";
const SALES_UI_MODE_KEY = "negis_sales_ui_mode";
const dealsSeed: Deal[] = [];

const statusOrder: DealStatus[] = ["pending", "paid", "cancelled", "refunded"];
const statusLabels: Record<DealStatus, string> = {
  pending: "Ожидает оплаты",
  paid: "Оплачена",
  cancelled: "Отменена",
  refunded: "Возврат",
};
const statusTones: Record<DealStatus, "amber" | "green" | "red" | "slate"> = {
  pending: "amber",
  paid: "green",
  cancelled: "slate",
  refunded: "red",
};

const paymentMethodLabels: Record<PaymentMethod, string> = {
  "": "Не указан",
  cash: "Наличные",
  card: "Карта",
  kaspi: "Kaspi",
  transfer: "Перевод",
  other: "Другое",
};

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function numberValue(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : 0;
}

function normalizeStatus(value: unknown): DealStatus {
  const status = str(value).toLowerCase();
  return status === "paid" || status === "cancelled" || status === "refunded" ? status : "pending";
}

function normalizePaymentMethod(value: unknown): PaymentMethod {
  const method = str(value).toLowerCase();
  return method === "cash" || method === "card" || method === "kaspi" || method === "transfer" || method === "other" ? method : "";
}

function dealFromApi(value: unknown): Deal {
  const record = asRecord(value);
  return {
    id: str(record.id) || `deal-${Date.now()}`,
    title: str(record.title),
    amountMinor: Math.max(0, Math.round(numberValue(record.amountMinor ?? record.amount_minor))),
    currency: str(record.currency).toUpperCase() || "KZT",
    status: normalizeStatus(record.status),
    paidAt: str(record.paidAt) || str(record.paid_at) || undefined,
    closedAt: str(record.closedAt) || str(record.closed_at) || undefined,
    paymentMethod: str(record.paymentMethod) || str(record.payment_method) || undefined,
    clientId: str(record.clientId) || str(record.client_id) || undefined,
    leadId: str(record.leadId) || str(record.lead_id) || undefined,
    appointmentId: str(record.appointmentId) || str(record.appointment_id) || undefined,
    serviceId: str(record.serviceId) || str(record.service_id) || undefined,
    metaCampaignLaunchId: str(record.metaCampaignLaunchId) || str(record.meta_campaign_launch_id) || undefined,
    responsibleUserId: str(record.responsibleUserId) || str(record.responsible_user_id) || undefined,
    notes: str(record.notes) || undefined,
    createdAt: str(record.createdAt) || str(record.created_at) || undefined,
    updatedAt: str(record.updatedAt) || str(record.updated_at) || undefined,
  };
}

function dealToApi(deal: Deal): Record<string, unknown> {
  return {
    title: deal.title,
    amountMinor: deal.amountMinor,
    currency: "KZT",
    status: deal.status,
    paymentMethod: deal.paymentMethod || "",
    clientId: deal.clientId || "",
    leadId: deal.leadId || "",
    appointmentId: deal.appointmentId || "",
    // Всегда, а не по условию: пустая строка — осознанная отвязка.
    serviceId: deal.serviceId || "",
    metaCampaignLaunchId: deal.metaCampaignLaunchId || "",
    responsibleUserId: deal.responsibleUserId || "",
    notes: deal.notes || "",
    ...(deal.paidAt ? { paidAt: deal.paidAt } : {}),
    ...(deal.closedAt ? { closedAt: deal.closedAt } : {}),
  };
}

function dealPatchToApi(patch: Partial<Deal>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (patch.title !== undefined) payload.title = patch.title;
  if (patch.amountMinor !== undefined) payload.amountMinor = patch.amountMinor;
  if (patch.currency !== undefined) payload.currency = patch.currency;
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.paymentMethod !== undefined) payload.paymentMethod = patch.paymentMethod || "";
  if (patch.clientId !== undefined) payload.clientId = patch.clientId || "";
  if (patch.leadId !== undefined) payload.leadId = patch.leadId || "";
  if (patch.appointmentId !== undefined) payload.appointmentId = patch.appointmentId || "";
  if (patch.serviceId !== undefined) payload.serviceId = patch.serviceId || "";
  if (patch.metaCampaignLaunchId !== undefined) payload.metaCampaignLaunchId = patch.metaCampaignLaunchId || "";
  if (patch.responsibleUserId !== undefined) payload.responsibleUserId = patch.responsibleUserId || "";
  if (patch.notes !== undefined) payload.notes = patch.notes || "";
  if (patch.paidAt !== undefined) payload.paidAt = patch.paidAt || "";
  if (patch.closedAt !== undefined) payload.closedAt = patch.closedAt || "";
  return payload;
}

// UI uses tenge; the API stores KZT minor units (tiyn) as an integer.
function tengeToAmountMinor(value: string): number | null {
  const normalized = value.replace(/\s+/g, "").replace(",", ".");
  if (!normalized) return null;
  const tenge = Number(normalized);
  if (!Number.isFinite(tenge) || tenge < 0) return null;
  return Math.round(tenge * 100);
}

function amountMinorToTengeInput(amountMinor: number): string {
  const tenge = Math.max(0, amountMinor) / 100;
  return Number.isInteger(tenge) ? String(tenge) : tenge.toFixed(2);
}

function formatAmount(amountMinor: number): string {
  const tenge = Math.max(0, amountMinor) / 100;
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(tenge)} ₸`;
}

function formatDateTime(value?: string): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleString("ru-RU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function shortNotes(value?: string): string {
  const notes = (value || "").trim();
  return notes.length > 180 ? `${notes.slice(0, 177)}...` : notes;
}

function paymentMethodLabel(value?: string): string {
  const normalized = normalizePaymentMethod(value);
  if (normalized) return paymentMethodLabels[normalized];
  return value?.trim() || paymentMethodLabels[""];
}

async function loadReferenceCollection(endpoint: string, listKey: string, demoKey: string): Promise<unknown[]> {
  try {
    const workspaceId = readWorkspaceId();
    const response = await crmFetch(`${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`);
    const text = await response.text();
    const body = text ? JSON.parse(text) as { success?: boolean; mode?: string; data?: Record<string, unknown> } : null;
    if (response.ok && body?.success === true && body.mode === "supabase") {
      const items = body.data?.[listKey];
      return Array.isArray(items) ? items : [];
    }
  } catch {
    // Demo mode falls back to the page-owned local collection below.
  }
  if (isRealWorkspace()) return [];
  return readDemoStorage<unknown[]>(demoKey, []);
}

function clientOption(value: unknown): ClientOption | null {
  const record = asRecord(value);
  const id = str(record.id);
  const name = str(record.name) || str(record.full_name);
  return id && name ? { id, name } : null;
}

function leadOption(value: unknown): LeadOption | null {
  const record = asRecord(value);
  const id = str(record.id);
  const name = str(record.name) || str(record.full_name);
  if (!id || !name) return null;
  return {
    id,
    name,
    campaign: str(record.campaign),
    clientId: str(record.clientId) || str(record.client_id) || undefined,
    metaCampaignLaunchId: str(record.metaCampaignLaunchId) || str(record.meta_campaign_launch_id) || undefined,
  };
}

function appointmentOption(value: unknown): AppointmentOption | null {
  const record = asRecord(value);
  const id = str(record.id);
  if (!id) return null;
  return {
    id,
    client: str(record.client) || str(record.clientName) || str(record.client_name) || "Клиент",
    service: str(record.service) || "Услуга не указана",
    startsAt: str(record.startsAt) || str(record.starts_at) || str(record.time) || undefined,
    clientId: str(record.clientId) || str(record.client_id) || undefined,
  };
}

function serviceOption(value: unknown): ServiceOption | null {
  const record = asRecord(value);
  const id = str(record.id);
  const name = str(record.name);
  if (!id || !name) return null;
  // Скрытые услуги в выбор не попадают: иначе «Скрыть» ничего бы не значило.
  const active = record.isActive === undefined && record.is_active === undefined
    ? true
    : Boolean(record.isActive ?? record.is_active);
  if (!active) return null;
  const price = record.basePriceMinor ?? record.base_price_minor;
  return {
    id,
    name,
    // Цена может быть не задана, и это не то же самое, что ноль.
    basePriceMinor: price === null || price === undefined || price === "" ? null : Math.round(numberValue(price)),
    sortOrder: Math.round(numberValue(record.sortOrder ?? record.sort_order)),
  };
}

function campaignOption(value: unknown): CampaignOption | null {
  const record = asRecord(value);
  const id = str(record.id);
  if (!id || id.toLowerCase().startsWith("dryrun_")) return null;

  const status = str(record.status).toLowerCase();
  const metaStatus = (str(record.metaStatus) || str(record.meta_status)).toLowerCase();
  const metaCampaignId = str(record.metaCampaignId) || str(record.meta_campaign_id);
  const lastError = str(record.lastError) || str(record.last_error);
  if (status === "dry_run" || metaStatus === "dry_run" || status === "failed" || metaStatus === "failed" || lastError) return null;
  const safeStatus = ["paused", "active", "created", "success"].includes(status) || ["paused", "active"].includes(metaStatus);
  if (!safeStatus && !metaCampaignId) return null;

  const payload = asRecord(record.payload);
  const service = str(payload.service);
  const city = str(payload.city);
  const name = str(record.campaignName) || str(record.campaign_name) || [service, city].filter(Boolean).join(" · ");
  if (!name) return null;
  const details = [service, city].filter(Boolean).join(", ");
  return { id, name, label: [name, details && details !== name ? details : "", "создана выключенной"].filter(Boolean).join(" · ") };
}

function emptyForm(): DealForm {
  return {
    title: "",
    serviceId: "",
    amountTenge: "",
    status: "pending",
    paymentMethod: "",
    clientId: "",
    leadId: "",
    appointmentId: "",
    metaCampaignLaunchId: "",
    notes: "",
  };
}

function toneColor(tone: NegisTone): string {
  return `var(--negis-${tone})`;
}

function toneBackground(tone: NegisTone): string {
  if (tone === "success") return "rgba(16,185,129,0.12)";
  if (tone === "warning") return "rgba(245,158,11,0.14)";
  if (tone === "error") return "rgba(239,68,68,0.10)";
  if (tone === "secondary") return "rgba(37,99,235,0.10)";
  if (tone === "muted") return "rgba(148,163,184,0.14)";
  return "var(--negis-primary-soft)";
}

function StatusPill({ status }: { status: DealStatus }) {
  const palette = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-rose-200 bg-rose-50 text-rose-700",
    slate: "border-slate-200 bg-white/70 text-slate-700",
  };
  return <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-black ${palette[statusTones[status]]}`}>{statusLabels[status]}</span>;
}

function DealFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-black uppercase tracking-[0.08em]" style={{ color: "var(--negis-muted)" }}>{label}</p>
      <div className="mt-1 break-words text-sm font-bold" style={{ color: "var(--negis-text)" }}>{children}</div>
    </div>
  );
}

export default function SalesPage() {
  const { items, loaded, addItem, updateItem } = useDemoCollection<Deal>("negis_demo_deals", dealsSeed, {
    endpoint: "/api/crm/deals",
    listKey: "deals",
    itemKey: "item",
    fromApi: dealFromApi,
    toApi: dealToApi,
    patchToApi: dealPatchToApi,
  });

  const [references, setReferences] = useState<SalesReferences>({ clients: [], leads: [], appointments: [], campaigns: [], services: [] });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | DealStatus>("all");
  // CRM10: secondary attribution filter — works on top of status filter and search.
  const [attributionFilter, setAttributionFilter] = useState<"all" | "with_ads" | "without_ads">("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DealForm>(() => emptyForm());
  // Двойной клик по «Добавить продажу» заводил вторую оплату на ту же сумму.
  const [saving, setSaving] = useState(false);
  const [isAdminMode, setIsAdminMode] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(SALES_UI_MODE_KEY) === "admin");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const workspaceId = readWorkspaceId();
      const [clientsRaw, leadsRaw, appointmentsRaw, campaignsRaw, servicesRaw] = await Promise.all([
        loadReferenceCollection("/api/crm/clients", "clients", "negis_demo_clients"),
        loadReferenceCollection("/api/crm/leads", "leads", "negis_demo_leads"),
        loadReferenceCollection("/api/crm/appointments", "appointments", "negis_demo_appointments"),
        loadReferenceCollection("/api/crm/meta-launches", "launches", `negis_ads_launch_history_${workspaceId}`),
        // Маркетолог доходит до этого экрана, но права на чтение каталога у
        // него нет: загрузчик вернёт пустой список, выбор услуги просто не
        // появится, и поле останется свободным текстом. Это честная деградация,
        // а не ошибка, поэтому и обрабатывается тем же общим загрузчиком.
        // Ключ обязан совпадать с тем, под которым пишет экран «Услуги»:
        // без области рабочего пространства демо-справочник не доезжает сюда
        // вовсе, и обещание «услуги подставляются в продажу» не выполняется.
        loadReferenceCollection("/api/crm/clinic-services", "services", workspaceScopedKey("negis_demo_clinic_services")),
      ]);
      if (cancelled) return;
      setReferences({
        clients: clientsRaw.map(clientOption).filter((item): item is ClientOption => item !== null),
        leads: leadsRaw.map(leadOption).filter((item): item is LeadOption => item !== null),
        appointments: appointmentsRaw.map(appointmentOption).filter((item): item is AppointmentOption => item !== null),
        campaigns: campaignsRaw.map(campaignOption).filter((item): item is CampaignOption => item !== null),
        services: servicesRaw.map(serviceOption).filter((item): item is ServiceOption => item !== null),
      });
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Selection-2: a handoff belongs to the clinic it was made in.
    const prefillKey = workspaceScopedKey(DEAL_PREFILL_KEY);
    const raw = window.localStorage.getItem(prefillKey);
    if (!raw) return;
    try {
      const prefill = asRecord(JSON.parse(raw));
      setEditingId(null);
      setForm({
        ...emptyForm(),
        title: str(prefill.title),
        clientId: str(prefill.clientId) || str(prefill.client_id),
        leadId: str(prefill.leadId) || str(prefill.lead_id),
        appointmentId: str(prefill.appointmentId) || str(prefill.appointment_id),
        // Запись передаёт услугу справочника: цена подставится, когда прайс
        // догрузится — тем же правилом, что и ручной выбор услуги.
        serviceId: str(prefill.serviceId) || str(prefill.service_id),
        metaCampaignLaunchId: str(prefill.metaCampaignLaunchId) || str(prefill.meta_campaign_launch_id),
      });
      setFormOpen(true);
    } catch {
      toast.error("Не удалось подготовить продажу. Откройте форму вручную.");
    } finally {
      window.localStorage.removeItem(prefillKey);
    }
  }, []);

  // Цена из прайса для услуги, пришедшей префиллом: справочник загружается
  // позже префилла, поэтому подстановка ждёт его отдельным эффектом и не
  // трогает сумму, если оператор уже что-то ввёл.
  useEffect(() => {
    if (!formOpen || editingId || !form.serviceId || form.amountTenge.trim()) return;
    const service = references.services.find((item) => item.id === form.serviceId);
    if (service && service.basePriceMinor !== null) {
      setForm((current) =>
        current.amountTenge.trim() ? current : { ...current, amountTenge: amountMinorToTengeInput(service.basePriceMinor as number) },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [references.services, form.serviceId, formOpen]);

  // Видимый список записей считается один раз и им же кормится fallback:
  // если посчитать их от разных списков, выбранная запись чужого клиента
  // отфильтруется молча — селект покажет «Не выбрана», а стейт сохранит
  // невидимую связь в сделку.
  const visibleAppointments = useMemo(
    () =>
      references.appointments.filter(
        (appointment) => !form.clientId || !appointment.clientId || appointment.clientId === form.clientId,
      ),
    [references.appointments, form.clientId],
  );

  const clientNames = useMemo(() => new Map(references.clients.map((item) => [item.id, item.name])), [references.clients]);
  const leadNames = useMemo(() => new Map(references.leads.map((item) => [item.id, item.name])), [references.leads]);
  const appointmentLabels = useMemo(() => new Map(references.appointments.map((item) => [item.id, `${item.service} · ${item.client}`])), [references.appointments]);
  const campaignNames = useMemo(() => new Map(references.campaigns.map((item) => [item.id, item.name])), [references.campaigns]);

  const metrics = useMemo(() => {
    const paid = items.filter((deal) => deal.status === "paid");
    return {
      total: items.length,
      paid: paid.length,
      pending: items.filter((deal) => deal.status === "pending").length,
      cancelledOrRefunded: items.filter((deal) => deal.status === "cancelled" || deal.status === "refunded").length,
      paidAmountMinor: paid.reduce((sum, deal) => sum + deal.amountMinor, 0),
    };
  }, [items]);

  // CRM10 — honest revenue attribution: paid deals only, split by the manual
  // meta_campaign_launch_id link. Pure counting — no spend, no ad-efficiency math.
  const attribution = useMemo(() => {
    const paid = items.filter((deal) => deal.status === "paid");
    const attributed = paid.filter((deal) => Boolean(deal.metaCampaignLaunchId));
    const unattributed = paid.filter((deal) => !deal.metaCampaignLaunchId);
    return {
      attributedCount: attributed.length,
      attributedAmountMinor: attributed.reduce((sum, deal) => sum + deal.amountMinor, 0),
      unattributedCount: unattributed.length,
      unattributedAmountMinor: unattributed.reduce((sum, deal) => sum + deal.amountMinor, 0),
    };
  }, [items]);

  // Paid revenue grouped by campaign — friendly labels only, sorted by amount for
  // readability (not a performance ranking; spend is not part of this data).
  const campaignRevenueRows = useMemo(() => {
    const groups = new Map<string, { amountMinor: number; count: number }>();
    for (const deal of items) {
      if (deal.status !== "paid" || !deal.metaCampaignLaunchId) continue;
      const group = groups.get(deal.metaCampaignLaunchId) || { amountMinor: 0, count: 0 };
      group.amountMinor += deal.amountMinor;
      group.count += 1;
      groups.set(deal.metaCampaignLaunchId, group);
    }
    return [...groups.entries()]
      .map(([campaignId, group]) => ({
        campaignId,
        name: campaignNames.get(campaignId) || "Связанная рекламная кампания",
        amountMinor: group.amountMinor,
        count: group.count,
      }))
      .sort((left, right) => right.amountMinor - left.amountMinor);
  }, [campaignNames, items]);

  const visibleDeals = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((deal) => {
      if (filter !== "all" && deal.status !== filter) return false;
      // CRM10: attribution filter — "С рекламой" keeps only deals linked to a launch.
      if (attributionFilter === "with_ads" && !deal.metaCampaignLaunchId) return false;
      if (attributionFilter === "without_ads" && deal.metaCampaignLaunchId) return false;
      if (!query) return true;
      return [
        deal.title,
        deal.notes,
        deal.clientId ? clientNames.get(deal.clientId) : "",
        deal.leadId ? leadNames.get(deal.leadId) : "",
      ].some((value) => (value || "").toLowerCase().includes(query));
    });
  }, [attributionFilter, clientNames, filter, items, leadNames, search]);

  const summaryMetrics: Array<{ label: string; value: string | number; icon: LucideIcon; tone: NegisTone }> = [
    { label: "Всего продаж", value: metrics.total, icon: ReceiptText, tone: "primary" },
    { label: "Оплачено", value: metrics.paid, icon: CheckCircle2, tone: "success" },
    { label: "Ожидает оплаты", value: metrics.pending, icon: Clock3, tone: "warning" },
    { label: "Отменено / Возвраты", value: metrics.cancelledOrRefunded, icon: RotateCcw, tone: "error" },
    { label: "Сумма оплаченных", value: formatAmount(metrics.paidAmountMinor), icon: BadgeDollarSign, tone: "secondary" },
  ];

  const filterOptions: Array<{ id: "all" | DealStatus; label: string }> = [
    { id: "all", label: "Все" },
    ...statusOrder.map((status) => ({ id: status, label: statusLabels[status] })),
  ];

  const attributionFilterOptions: Array<{ id: typeof attributionFilter; label: string }> = [
    { id: "all", label: "Все" },
    { id: "with_ads", label: "С рекламой" },
    { id: "without_ads", label: "Без рекламы" },
  ];

  function setMode(admin: boolean) {
    setIsAdminMode(admin);
    if (typeof window !== "undefined") window.localStorage.setItem(SALES_UI_MODE_KEY, admin ? "admin" : "client");
  }

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(true);
  }

  function openEdit(deal: Deal) {
    setEditingId(deal.id);
    setForm({
      title: deal.title,
      serviceId: deal.serviceId || "",
      amountTenge: amountMinorToTengeInput(deal.amountMinor),
      status: deal.status,
      paymentMethod: normalizePaymentMethod(deal.paymentMethod),
      clientId: deal.clientId || "",
      leadId: deal.leadId || "",
      appointmentId: deal.appointmentId || "",
      metaCampaignLaunchId: deal.metaCampaignLaunchId || "",
      notes: deal.notes || "",
    });
    setFormOpen(true);
  }

  function handleLeadSelection(leadId: string) {
    const lead = references.leads.find((item) => item.id === leadId);
    setForm((current) => ({
      ...current,
      leadId,
      title: current.title.trim() || lead?.campaign || "",
      // Existing manual choices always win; lead data fills only blank links.
      clientId: current.clientId || lead?.clientId || "",
      metaCampaignLaunchId: current.metaCampaignLaunchId || lead?.metaCampaignLaunchId || "",
    }));
  }

  function submitForm() {
    const title = form.title.trim();
    if (!title) {
      toast.error("Укажите название услуги или продажи");
      return;
    }
    const amountMinor = tengeToAmountMinor(form.amountTenge);
    if (amountMinor === null) {
      toast.error("Укажите корректную сумму в тенге");
      return;
    }

    const existing = editingId ? items.find((deal) => deal.id === editingId) : undefined;
    const now = new Date().toISOString();
    const paidAt = form.status === "paid" ? existing?.paidAt || now : existing?.paidAt;
    const closedAt = form.status !== "pending" ? existing?.closedAt || now : existing?.closedAt;
    const nextDeal: Deal = {
      id: existing?.id || `deal-${Date.now()}`,
      title,
      amountMinor,
      currency: "KZT",
      status: form.status,
      paymentMethod: form.paymentMethod || undefined,
      clientId: form.clientId || undefined,
      leadId: form.leadId || undefined,
      appointmentId: form.appointmentId || undefined,
      serviceId: form.serviceId || undefined,
      metaCampaignLaunchId: form.metaCampaignLaunchId || undefined,
      responsibleUserId: existing?.responsibleUserId,
      notes: form.notes.trim() || undefined,
      paidAt,
      closedAt,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    // Деньги — то место, где «сохранилось или нет» должно быть известно точно:
    // форма ждёт ответ сервера и при отказе остаётся с набранной суммой.
    setSaving(true);
    void (async () => {
      try {
        const saved = editingId ? await updateItem(editingId, nextDeal) : await addItem(nextDeal);
        if (!saved) return;
        toast.success(
          editingId
            ? "Продажа обновлена"
            : form.status === "paid"
              ? "Оплаченная продажа добавлена"
              : "Продажа добавлена",
        );
        setFormOpen(false);
        setEditingId(null);
        setForm(emptyForm());
      } finally {
        setSaving(false);
      }
    })();
  }

  const fallbackOption = (value: string, options: Array<{ id: string }>, label: string) =>
    value && !options.some((option) => option.id === value) ? <option value={value}>{label}</option> : null;

  return (
    <PageLayout>
      <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="negis-glass-hero p-5 sm:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em]" style={{ color: "var(--negis-primary)" }}>Negis OS · CRM</p>
              <h1 className="mt-2 text-3xl font-black sm:text-4xl" style={{ color: "var(--negis-text)" }}>Продажи</h1>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>Оплаты, услуги и выручка клиники.</p>
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
                Добавить продажу
              </button>
            </div>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Сводка по продажам">
          {/* Акцент — на сумме: ради неё этот экран и открывают, а не ради
              количества строк. */}
          {summaryMetrics.map((metric) => (
            <MetricCard key={metric.label} {...metric} accent={metric.label === "Сумма оплаченных"} />
          ))}
        </section>

        {/* CRM10: honest attribution split — paid deals only, manual campaign link. */}
        <section className="negis-glass flex flex-wrap items-center gap-x-6 gap-y-1.5 p-4 text-sm" aria-label="Атрибуция выручки">
          <p className="font-semibold" style={{ color: "var(--negis-muted)" }}>
            Оплачено с рекламой:{" "}
            <span className="font-black" style={{ color: "var(--negis-text)" }}>{formatAmount(attribution.attributedAmountMinor)}</span>
            <span className="font-semibold"> ({attribution.attributedCount})</span>
          </p>
          <p className="font-semibold" style={{ color: "var(--negis-muted)" }}>
            Оплачено без рекламы:{" "}
            <span className="font-black" style={{ color: "var(--negis-text)" }}>{formatAmount(attribution.unattributedAmountMinor)}</span>
            <span className="font-semibold"> ({attribution.unattributedCount})</span>
          </p>
        </section>

        {/* CRM10: paid revenue by manually linked campaign — friendly labels only,
            no spend, no efficiency claims. Rendered only when linked revenue exists. */}
        {campaignRevenueRows.length > 0 ? (
          <section className="negis-glass p-4 sm:p-5" aria-label="Выручка по связанным кампаниям">
            <h2 className="text-sm font-black" style={{ color: "var(--negis-text)" }}>Выручка по связанным кампаниям</h2>
            <p className="mt-1 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
              По оплаченным продажам, связанным вручную. Без учёта расходов на рекламу.
            </p>
            <div className="mt-3 grid gap-1.5">
              {campaignRevenueRows.map((row) => (
                <p key={row.campaignId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
                  <span className="min-w-0 break-words font-semibold" style={{ color: "var(--negis-muted)" }}>{row.name}</span>
                  <span className="shrink-0 font-black" style={{ color: "var(--negis-text)" }}>
                    {formatAmount(row.amountMinor)}
                    <span className="font-semibold" style={{ color: "var(--negis-muted)" }}> · {row.count} прод.</span>
                  </span>
                </p>
              ))}
            </div>
          </section>
        ) : null}

        <section className="negis-glass p-4 sm:p-5">
          <div className="flex flex-wrap gap-2" aria-label="Фильтры продаж">
            {filterOptions.map((option) => {
              const active = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="rounded-full px-4 py-2 text-xs font-semibold transition"
                  style={active ? { background: "var(--negis-black)", color: "#FFFFFF" } : { background: "var(--negis-ground)", color: "var(--negis-ink-2)" }}
                  aria-pressed={active}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {/* CRM10: secondary attribution filter (independent of status filter). */}
          <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Фильтр по рекламе">
            <span className="text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Реклама:</span>
            {attributionFilterOptions.map((option) => {
              const active = attributionFilter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition"
                  style={active ? { background: "var(--negis-black)", color: "#FFFFFF" } : { background: "var(--negis-ground)", color: "var(--negis-ink-2)" }}
                  aria-pressed={active}
                  onClick={() => setAttributionFilter(option.id)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <label className="relative mt-3 block">
            <span className="sr-only">Поиск по продажам</span>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2" size={17} style={{ color: "var(--negis-muted)" }} />
            <input
              style={{ ...inputStyle, paddingLeft: 42 }}
              type="search"
              value={search}
              aria-label="Поиск по продажам"
              placeholder="Поиск: услуга, заметка, клиент или заявка"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </section>

        {!loaded ? (
          <section className="negis-glass flex min-h-40 flex-col items-center justify-center gap-3 p-8 text-center" aria-live="polite">
            <Loader2 className="animate-spin" size={22} style={{ color: "var(--negis-primary)" }} />
            <p className="text-sm font-bold" style={{ color: "var(--negis-muted)" }}>Загружаем данные…</p>
          </section>
        ) : items.length === 0 ? (
          <section className="negis-glass-hero flex flex-col items-center gap-3 p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>
              <ReceiptText size={24} />
            </div>
            <h2 className="text-xl font-black" style={{ color: "var(--negis-text)" }}>Продаж пока нет</h2>
            <p className="max-w-md text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>Добавьте первую услугу или оплату, чтобы начать вести честную выручку клиники.</p>
            <button type="button" className="neu-btn-primary justify-center" onClick={openAdd}><Plus size={16} />Добавить продажу</button>
          </section>
        ) : visibleDeals.length === 0 ? (
          <section className="negis-glass flex flex-col items-center gap-3 p-6 text-center">
            <p className="text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>Ничего не найдено. Измените фильтр или поисковый запрос.</p>
            <button type="button" className="neu-btn justify-center" onClick={() => { setFilter("all"); setAttributionFilter("all"); setSearch(""); }}>Сбросить фильтры</button>
          </section>
        ) : (
          <section className="grid gap-3 xl:grid-cols-2">
            {visibleDeals.map((deal) => (
              <article key={deal.id} className="negis-glass min-w-0 p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: toneBackground("primary"), color: toneColor("primary") }}>
                        <BadgeDollarSign size={17} />
                      </div>
                      <div className="min-w-0">
                        <h2 className="break-words font-black" style={{ color: "var(--negis-text)" }}>{deal.title}</h2>
                        <p className="mt-0.5 text-xl font-black" style={{ color: "var(--negis-primary)" }}>{formatAmount(deal.amountMinor)}</p>
                      </div>
                    </div>
                  </div>
                  <StatusPill status={deal.status} />
                </div>

                <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
                  <DealFact label={deal.status === "paid" ? "Оплачена" : "Создана"}>{formatDateTime(deal.status === "paid" ? deal.paidAt || deal.createdAt : deal.createdAt)}</DealFact>
                  <DealFact label="Способ оплаты">{paymentMethodLabel(deal.paymentMethod)}</DealFact>
                  <DealFact label="Клиент">
                    {deal.clientId ? (
                      /* Имя ведёт на карточку клиента — тем же ключом, что и
                         «Открыть клиента» из заявок. */
                      <Link
                        href="/clients"
                        className="font-bold"
                        style={{ color: "var(--negis-primary)" }}
                        onClick={() => {
                          try {
                            if (typeof window !== "undefined" && deal.clientId) {
                              window.localStorage.setItem(workspaceScopedKey(CLIENT_OPEN_KEY), deal.clientId);
                            }
                          } catch {
                            // Хранилище закрыто — переход остаётся, откроется список.
                          }
                        }}
                      >
                        {clientNames.get(deal.clientId) || "Клиент связан"}
                      </Link>
                    ) : (
                      "Не выбран"
                    )}
                  </DealFact>
                  <DealFact label="Заявка">{deal.leadId ? leadNames.get(deal.leadId) || "Заявка связана" : "Не выбрана"}</DealFact>
                  <DealFact label="Запись">{deal.appointmentId ? appointmentLabels.get(deal.appointmentId) || "Запись связана" : "Не выбрана"}</DealFact>
                  <DealFact label="Рекламная кампания">{deal.metaCampaignLaunchId ? campaignNames.get(deal.metaCampaignLaunchId) || "Рекламная кампания связана" : "Не связана"}</DealFact>
                </div>

                {deal.notes ? <p className="mt-4 rounded-2xl px-3 py-2 text-sm font-semibold leading-relaxed" style={{ background: "var(--negis-surface)", color: "var(--negis-muted)" }}>{shortNotes(deal.notes)}</p> : null}

                {isAdminMode ? (
                  <details className="mt-4 overflow-hidden rounded-2xl border" style={{ borderColor: "var(--negis-border)" }}>
                    <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-black uppercase tracking-[0.1em]" style={{ color: "var(--negis-primary)" }}>Технические данные продажи</summary>
                    <div className="grid gap-1 px-4 pb-4 pt-1 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
                      <p>deal id present: {deal.id ? "yes" : "no"}</p>
                      <p>client_id present: {deal.clientId ? "yes" : "no"}</p>
                      <p>lead_id present: {deal.leadId ? "yes" : "no"}</p>
                      <p>appointment_id present: {deal.appointmentId ? "yes" : "no"}</p>
                      <p>meta_campaign_launch_id present: {deal.metaCampaignLaunchId ? "yes" : "no"}</p>
                      <p>responsible_user_id present: {deal.responsibleUserId ? "yes" : "no"}</p>
                      <p>Данные ограничены текущей клиникой (workspace).</p>
                    </div>
                  </details>
                ) : null}

                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <button type="button" className="neu-btn justify-center" onClick={() => openEdit(deal)}><Pencil size={16} />Изменить</button>
                </div>
              </article>
            ))}
          </section>
        )}
      </div>

      {formOpen ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.35)" }} onClick={() => setFormOpen(false)}>
          <div className="negis-glass max-h-[90vh] w-full max-w-2xl overflow-y-auto p-5 sm:p-6" style={{ background: "var(--negis-surface)" }} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.12em]" style={{ color: "var(--negis-primary)" }}>Продажи</p>
                <h2 className="mt-1 text-lg font-black" style={{ color: "var(--negis-text)" }}>{editingId ? "Изменить продажу" : "Новая продажа"}</h2>
              </div>
              <button type="button" className="neu-btn px-3 py-2" onClick={() => setFormOpen(false)} aria-label="Закрыть"><X size={16} /></button>
            </div>

            <div className="mt-5 grid gap-4">
              {/*
                Выбор услуги появляется только когда справочник есть и доступен.
                Он заполняет название и цену, но оставляет оба поля
                редактируемыми: скидки существуют, и продажа записывает то,
                сколько реально заплатили, а не то, что стоит в прайсе.
              */}
              {references.services.length > 0 ? (
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Услуга из справочника</span>
                  <select
                    style={inputStyle}
                    value={form.serviceId}
                    onChange={(event) => {
                      const serviceId = event.target.value;
                      const service = references.services.find((item) => item.id === serviceId);
                      setForm((current) => ({
                        ...current,
                        serviceId,
                        title: service ? service.name : current.title,
                        amountTenge:
                          service && service.basePriceMinor !== null && !current.amountTenge.trim()
                            ? amountMinorToTengeInput(service.basePriceMinor)
                            : current.amountTenge,
                      }));
                    }}
                  >
                    <option value="">Не выбрана</option>
                    {[...references.services]
                      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ru"))
                      .map((service) => (
                        <option key={service.id} value={service.id}>{service.name}</option>
                      ))}
                    {fallbackOption(form.serviceId, references.services, "Услуга недоступна")}
                  </select>
                </label>
              ) : null}

              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Название услуги / продажи</span>
                <input style={inputStyle} value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="Например, консультация косметолога" />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Сумма, ₸</span>
                  <input style={inputStyle} type="number" min="0" step="0.01" inputMode="decimal" value={form.amountTenge} onChange={(event) => setForm((current) => ({ ...current, amountTenge: event.target.value }))} placeholder="25000" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Статус</span>
                  <select style={inputStyle} value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as DealStatus }))}>
                    {statusOrder.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Способ оплаты</span>
                <select style={inputStyle} value={form.paymentMethod} onChange={(event) => setForm((current) => ({ ...current, paymentMethod: event.target.value as PaymentMethod }))}>
                  {(Object.keys(paymentMethodLabels) as PaymentMethod[]).map((method) => <option key={method || "none"} value={method}>{paymentMethodLabels[method]}</option>)}
                </select>
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Клиент</span>
                  <select data-testid="deal-client-select" style={inputStyle} value={form.clientId} onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))}>
                    <option value="">Не выбран</option>
                    {fallbackOption(form.clientId, references.clients, "Связанный клиент")}
                    {references.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Заявка</span>
                  <select data-testid="deal-lead-select" style={inputStyle} value={form.leadId} onChange={(event) => handleLeadSelection(event.target.value)}>
                    <option value="">Не выбрана</option>
                    {fallbackOption(form.leadId, references.leads, "Связанная заявка")}
                    {references.leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.name}{lead.campaign ? ` · ${lead.campaign}` : ""}</option>)}
                  </select>
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Запись</span>
                  <select data-testid="deal-appointment-select" style={inputStyle} value={form.appointmentId} onChange={(event) => setForm((current) => ({ ...current, appointmentId: event.target.value }))}>
                    <option value="">Не выбрана</option>
                    {/* Выбран клиент — список сужается до его записей: селект со
                        всеми записями клиники заставлял искать нужную глазами.
                        Записи без связи с карточкой остаются видны всегда, а
                        выбранная, но отфильтрованная — остаётся честной опцией
                        через fallback от ТОГО ЖЕ видимого списка. */}
                    {fallbackOption(form.appointmentId, visibleAppointments, "Связанная запись")}
                    {visibleAppointments.map((appointment) => <option key={appointment.id} value={appointment.id}>{appointment.service} · {appointment.client}{appointment.startsAt ? ` · ${formatDateTime(appointment.startsAt)}` : ""}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Рекламная кампания</span>
                  <select data-testid="deal-campaign-select" style={inputStyle} value={form.metaCampaignLaunchId} onChange={(event) => setForm((current) => ({ ...current, metaCampaignLaunchId: event.target.value }))}>
                    <option value="">Не выбрана</option>
                    {fallbackOption(form.metaCampaignLaunchId, references.campaigns, "Связанная рекламная кампания")}
                    {references.campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.label}</option>)}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Примечание</span>
                <textarea style={{ ...inputStyle, minHeight: 92, resize: "vertical" }} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Детали оплаты или договорённости с клиентом" />
              </label>
            </div>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="neu-btn justify-center" onClick={() => setFormOpen(false)}>Отмена</button>
              <button type="button" className="neu-btn-primary justify-center" disabled={saving} onClick={submitForm}>
                {saving ? "Сохраняю…" : editingId ? "Сохранить" : "Добавить продажу"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </PageLayout>
  );
}
