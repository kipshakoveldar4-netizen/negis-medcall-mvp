import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import {
  BadgeDollarSign,
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
import { PageHeader } from "@/components/ui/page-header";
import { MetricCard } from "@/components/ui/metric-card";
import { ChangeLogPanel } from "@/components/crm/change-log-panel";
import { TaskPanel } from "@/components/crm/task-panel";
import { useAuth } from "@/contexts/AuthContext";
import { EmptyState } from "@/components/ui/empty-state";
import { useDemoCollection, readDemoStorage, writeDemoStorage, isRealWorkspace, readWorkspaceId, workspaceScopedKey } from "@/lib/demoStorage";
import { apiUrl, crmFetch } from "@/lib/api";
import {
  FALLBACK_LEAD_SOURCES,
  FALLBACK_LEAD_STAGES,
  leadSourceDefinitionFromUnknown,
  leadStageDefinitionFromUnknown,
  semanticGroupForLead,
  type LeadSemanticGroup,
  type LeadSourceDefinition,
  type LeadStageDefinition,
} from "@/lib/leadPipeline";
import { formatPhone, phoneDigits, toTelHref, toWhatsappHref } from "@/lib/phone";

// CRM2 — real "Заявки" (leads) screen for Negis OS, Glass Morphic Medical AI.
// Backed by the existing /api/crm/leads generic resource (workspace_id schema,
// migrations 010 + 019) via useDemoCollection: Supabase when configured,
// localStorage fallback otherwise. Legacy status/source snapshots stay readable.

type LeadStatusKey = LeadSemanticGroup;

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
  stageId?: string;
  stageName?: string;
  stageKey?: string;
  stageColor?: string;
  semanticGroup?: LeadSemanticGroup;
  sourceId?: string;
  sourceName?: string;
  sourceKey?: string;
  sourceChannel?: string;
  sourceColor?: string;
  metaCampaignLaunchId?: string;
  createdAt?: string;
};

type NegisTone = "primary" | "secondary" | "ai" | "success" | "warning" | "error" | "muted";

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

const leadsSeed: Lead[] = [
  { id: "lead-1", name: "Лаура Ким", phone: "+7 700 801 77 21", source: "Instagram", campaign: "Бесплатная консультация", status: "new", owner: "Ресепшн", notes: "Хочет диагностику кожи на этой неделе", createdAt: new Date(Date.now() - 45 * 60 * 1000).toISOString() },
  { id: "lead-2", name: "Жанна Абди", phone: "+7 747 330 19 90", source: "WhatsApp", campaign: "Reels ботокс", status: "in_progress", owner: "Айгерим", notes: "Ждёт расчёт курса, перезвонить после 17:00", createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
  { id: "lead-3", name: "Мария Ли", phone: "+7 702 617 12 11", source: "Сайт", campaign: "Skin audit", status: "booked", owner: "Medina AI", notes: "Записана на чистку лица", createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString() },
  { id: "lead-4", name: "Ирина Ким", phone: "+7 777 422 55 01", source: "Instagram", campaign: "Laser promo", status: "lost", owner: "Маркетолог", notes: "Не устроила цена, предложить акцию позже", createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
];

const AI_RECOMMENDATION_PLACEHOLDER = "AI-рекомендация появится после подключения CRM-аналитики.";
const LEADS_UI_MODE_KEY = "negis_leads_ui_mode";
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

/**
 * Журнал не знает, что «new» — это «Новая», а uuid — это Айгерим, и не должен:
 * он хранит то, что было записано. Расшифровка живёт на экране, где под рукой
 * и таксономия, и список сотрудников.
 */
function makeLeadHistoryResolver(
  stages: LeadStageDefinition[],
  sources: LeadSourceDefinition[],
  staff: StaffOption[],
): (field: string, value: string | null) => string | null {
  return (field, value) => {
    if (!value) return value;
    if (field === "status") {
      const stage = stages.find((item) => item.stageKey === value || item.id === value);
      return stage?.name ?? value;
    }
    if (field === "responsible_user_id") {
      return staff.find((member) => member.id === value)?.name ?? "Сотрудник";
    }
    if (field === "source") {
      return sources.find((item) => item.sourceKey === value || item.name === value)?.name ?? value;
    }
    // Ссылки на другие записи: uuid оператору ничего не говорит, а факт связи
    // говорит всё.
    if (field.endsWith("_id")) return "привязано";
    return value;
  };
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
    workspaceScopedKey(APPOINTMENT_PREFILL_KEY),
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

function saveDealPrefill(lead: Lead) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    workspaceScopedKey(DEAL_PREFILL_KEY),
    JSON.stringify({
      title: lead.campaign || "",
      leadId: lead.id,
      clientId: lead.clientId || "",
      metaCampaignLaunchId: lead.metaCampaignLaunchId || "",
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
/**
 * Клиенты с этим номером — вопросом к базе, а не выгрузкой всей клиники.
 *
 * Прежде здесь читались ВСЕ клиенты рабочей области, и совпадение искалось в
 * браузере. Дубль карточки пациента получался двумя путями. За тем пределом
 * строк, который настроен у PostgREST — а он в репозитории не задан нигде, —
 * карточка вернувшегося пациента просто не попадала в отданное окно. И, вне
 * всякого предела, сравнение шло по одним цифрам: «8 701 000 00 01» и
 * «+7 701 000 00 01» были для дедупа разными людьми, хотя канонизатор проекта
 * знает, что это один абонент.
 *
 * Номер уходит на сервер как есть. Канонизация живёт в двух местах —
 * lib/crm/phone.ts и выражение генерируемой колонки, — и test:crm-phone-parity
 * держит их вместе; третья копия в браузере снова развела бы их.
 */
async function findClientsByPhone(phone: string): Promise<ExistingClient[]> {
  if (!phoneDigits(phone)) return [];

  try {
    const workspaceId = readWorkspaceId();
    const query = `phone=${encodeURIComponent(phone)}&workspaceId=${encodeURIComponent(workspaceId)}`;
    const response = await crmFetch(`/api/crm/clients?${query}`);
    const text = await response.text();
    const body = text ? (JSON.parse(text) as { success?: boolean; mode?: string; data?: { clients?: unknown[] } }) : null;
    if (response.ok && body?.success === true && body.mode === "supabase" && Array.isArray(body.data?.clients)) {
      return body.data.clients.map(clientFromRecord);
    }
  } catch {
    // Network/API problems fall through to demo storage (demo mode only).
  }
  // Production duplicate check must never run against demo clients.
  if (isRealWorkspace()) return [];

  // Демо-режим сервера не имеет вовсе: сравниваем как и раньше, по цифрам.
  // Данные здесь — фиксированный сид в localStorage, а не история клиники.
  const digits = phoneDigits(phone);
  return readDemoStorage<unknown[]>("negis_demo_clients", [])
    .map(clientFromRecord)
    .filter((client) => [phoneDigits(client.phone), phoneDigits(client.whatsapp)].includes(digits));
}

// CRM7 — campaign attribution: a lead can link to a real Meta launch record through
// meta_campaign_launch_id. Only safe launches are offered; no CPL/analytics yet.
type CampaignLaunchOption = {
  id: string;
  name: string;
  label: string;
  createdAt: string;
};

function isDryRunLaunchId(value: string): boolean {
  return value.trim().toLowerCase().startsWith("dryrun_");
}

// Attribution targets are real created launches only: dry-run tests, failed launches
// and records without a usable name are excluded. The shape check stays tolerant —
// either a real Meta campaign id or a safe status is enough.
function campaignLaunchOptionFromRecord(raw: unknown): CampaignLaunchOption | null {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = toStr(record.id);
  if (!id || isDryRunLaunchId(id)) return null;

  const status = toStr(record.status).toLowerCase();
  const metaStatus = (toStr(record.metaStatus) || toStr(record.meta_status)).toLowerCase();
  const metaCampaignId = toStr(record.metaCampaignId) || toStr(record.meta_campaign_id);
  const lastError = toStr(record.lastError) || toStr(record.last_error);
  if (status === "dry_run" || metaStatus === "dry_run" || isDryRunLaunchId(metaCampaignId)) return null;
  if (status === "failed" || metaStatus === "failed" || lastError) return null;

  const hasRealCampaignId = Boolean(metaCampaignId) && !isDryRunLaunchId(metaCampaignId);
  const safeStatus = ["paused", "active", "created", "success"].includes(status) || ["paused", "active"].includes(metaStatus);
  if (!hasRealCampaignId && !safeStatus) return null;

  const payload = (record.payload && typeof record.payload === "object" ? record.payload : {}) as Record<string, unknown>;
  const service = toStr(payload.service);
  const city = toStr(payload.city);
  const name = toStr(record.campaignName) || toStr(record.campaign_name) || [service, city].filter(Boolean).join(" · ");
  if (!name) return null;

  const createdAt = toStr(record.createdAt) || toStr(record.created_at);
  const details = [service, city].filter(Boolean).join(", ");
  const label = [
    name,
    details && details !== name ? details : "",
    createdAt ? formatCreatedAt(createdAt) : "",
    "создана выключенной",
  ]
    .filter(Boolean)
    .join(" · ");
  return { id, name, label, createdAt };
}

// Real API launches when Supabase answers; the local demo launch history in demo
// mode. Production never falls back to demo data (CRM6.1 rule).
async function loadCampaignLaunchOptions(): Promise<CampaignLaunchOption[]> {
  const mapAll = (rawItems: unknown[]): CampaignLaunchOption[] =>
    rawItems.map(campaignLaunchOptionFromRecord).filter((option): option is CampaignLaunchOption => option !== null);

  try {
    const workspaceId = readWorkspaceId();
    const response = await crmFetch(`/api/crm/meta-launches?workspaceId=${encodeURIComponent(workspaceId)}`);
    const text = await response.text();
    const body = text
      ? (JSON.parse(text) as { success?: boolean; mode?: string; data?: { launches?: unknown[] } })
      : null;
    if (response.ok && body?.success === true && body.mode === "supabase" && Array.isArray(body.data?.launches)) {
      return mapAll(body.data.launches);
    }
  } catch {
    // Fall through to the demo history below (demo mode only).
  }
  if (isRealWorkspace()) return [];
  return mapAll(readDemoStorage<unknown[]>(`negis_ads_launch_history_${readWorkspaceId()}`, []));
}

function linkedCampaignOption(lead: Lead, options: CampaignLaunchOption[]): CampaignLaunchOption | undefined {
  return lead.metaCampaignLaunchId ? options.find((option) => option.id === lead.metaCampaignLaunchId) : undefined;
}

// Friendly client-safe label: campaign name, never raw Meta IDs/payloads.
function linkedCampaignLabel(lead: Lead, options: CampaignLaunchOption[]): string {
  if (!lead.metaCampaignLaunchId) return "Кампания не связана";
  return linkedCampaignOption(lead, options)?.name || lead.campaign || "Связана с запуском";
}

// Detail view adds date/status when the linked launch is known.
function linkedCampaignDetail(lead: Lead, options: CampaignLaunchOption[]): string {
  if (!lead.metaCampaignLaunchId) return "Кампания не связана";
  const option = linkedCampaignOption(lead, options);
  if (!option) return lead.campaign || "Связана с запуском";
  return [option.name, option.createdAt ? formatCreatedAt(option.createdAt) : "", "создана выключенной"].filter(Boolean).join(" · ");
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value?: string): value is string {
  return Boolean(value && uuidPattern.test(value));
}

function orderedActiveStages(stages: LeadStageDefinition[]): LeadStageDefinition[] {
  return stages.filter((stage) => stage.isActive).sort((left, right) => left.sortOrder - right.sortOrder);
}

function orderedActiveSources(sources: LeadSourceDefinition[]): LeadSourceDefinition[] {
  return sources.filter((source) => source.isActive).sort((left, right) => left.sortOrder - right.sortOrder);
}

function stageForLead(lead: Lead, stages: LeadStageDefinition[]): LeadStageDefinition | undefined {
  return stages.find((stage) => stage.id === lead.stageId)
    ?? stages.find((stage) => stage.stageKey === lead.stageKey)
    ?? stages.find((stage) => stage.stageKey === lead.status)
    ?? stages.find((stage) => stage.isDefault && stage.semanticGroup === semanticGroupForLead(lead))
    ?? stages.find((stage) => stage.semanticGroup === semanticGroupForLead(lead));
}

function sourceForLead(lead: Lead, sources: LeadSourceDefinition[]): LeadSourceDefinition | undefined {
  const normalizedSource = (lead.sourceName || lead.source || "").trim().toLowerCase();
  return sources.find((source) => source.id === lead.sourceId)
    ?? sources.find((source) => source.sourceKey === lead.sourceKey)
    ?? sources.find((source) => source.name.trim().toLowerCase() === normalizedSource);
}

function leadStageName(lead: Lead, stages: LeadStageDefinition[]): string {
  return lead.stageName || stageForLead(lead, stages)?.name || leadStatusLabel[semanticGroupForLead(lead)];
}

function leadSourceName(lead: Lead, sources: LeadSourceDefinition[]): string {
  return lead.sourceName || sourceForLead(lead, sources)?.name || lead.source || "—";
}

async function loadTaxonomyList<TItem>(input: {
  endpoint: string;
  listKey: string;
  workspaceId: string;
  mapItem: (value: unknown) => TItem | null;
}): Promise<{ mode: string; items: TItem[] }> {
  const response = await crmFetch(`${input.endpoint}?workspaceId=${encodeURIComponent(input.workspaceId)}`);
  const text = await response.text();
  const body = text
    ? (JSON.parse(text) as { success?: boolean; mode?: string; data?: Record<string, unknown> })
    : null;
  if (!response.ok || body?.success !== true) return { mode: "demo", items: [] };
  const rawItems = body.data?.[input.listKey];
  const items = Array.isArray(rawItems)
    ? rawItems.map(input.mapItem).filter((item): item is TItem => item !== null)
    : [];
  return { mode: body.mode || "demo", items };
}

type LeadForm = {
  name: string;
  phone: string;
  sourceId: string;
  sourceText: string;
  campaign: string;
  metaCampaignLaunchId: string;
  stageId: string;
  responsibleUserId: string;
  notes: string;
};

/** A colleague the lead can be handed to. Only active staff are offered. */
type StaffOption = { id: string; name: string; role: string };

function staffOptionFromUnknown(raw: unknown): StaffOption | null {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "active";
  if (!isUuid(id) || status !== "active") return null;
  const name = [record.name, record.fullName, record.full_name, record.email]
    .find((value) => typeof value === "string" && value.trim().length > 0);
  return {
    id,
    name: typeof name === "string" ? name.trim() : "Сотрудник",
    role: typeof record.role === "string" ? record.role : "",
  };
}

/** The card used to say «Назначен» — true but useless with two registrars. */
function responsibleName(lead: Lead, staff: StaffOption[]): string {
  if (lead.owner) return lead.owner;
  if (!lead.responsibleUserId) return "—";
  return staff.find((member) => member.id === lead.responsibleUserId)?.name ?? "Назначен";
}

const emptyForm: LeadForm = {
  name: "",
  phone: "",
  sourceId: "",
  sourceText: "",
  campaign: "",
  metaCampaignLaunchId: "",
  stageId: "fallback:new",
  responsibleUserId: "",
  notes: "",
};

function leadFromApi(raw: unknown): Lead {
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
    stageId: str(record.stageId) || str(record.stage_id) || undefined,
    stageName: str(record.stageName) || str(record.stage_name) || undefined,
    stageKey: str(record.stageKey) || str(record.stage_key) || undefined,
    stageColor: str(record.stageColor) || str(record.stage_color) || undefined,
    semanticGroup: semanticGroupForLead(record),
    sourceId: str(record.sourceId) || str(record.source_id) || undefined,
    sourceName: str(record.sourceName) || str(record.source_name) || undefined,
    sourceKey: str(record.sourceKey) || str(record.source_key) || undefined,
    sourceChannel: str(record.sourceChannel) || str(record.source_channel) || undefined,
    sourceColor: str(record.sourceColor) || str(record.source_color) || undefined,
    metaCampaignLaunchId: str(record.metaCampaignLaunchId) || str(record.meta_campaign_launch_id) || undefined,
    createdAt: str(record.createdAt) || str(record.created_at) || undefined,
  };
}

function leadToApi(lead: Lead): Record<string, unknown> {
  return {
    name: lead.name,
    phone: lead.phone,
    source: lead.source,
    campaign: lead.campaign,
    status: lead.status,
    notes: lead.notes || "",
    // Always sent, like on the patch path: an empty string is how a lead is
    // left unassigned, and the server turns it into null. Omitting the key
    // instead is what made the «Ответственный» select a control that changed
    // nothing — the value reached this function and stopped here.
    responsibleUserId: lead.responsibleUserId ?? "",
    ...(isUuid(lead.stageId) ? { stageId: lead.stageId } : {}),
    ...(isUuid(lead.sourceId) ? { sourceId: lead.sourceId } : {}),
    ...(isUuid(lead.metaCampaignLaunchId) ? { metaCampaignLaunchId: lead.metaCampaignLaunchId } : {}),
  };
}

function leadPatchToApi(patch: Partial<Lead>): Record<string, unknown> {
  return {
    name: patch.name,
    phone: patch.phone,
    source: patch.source,
    campaign: patch.campaign,
    status: patch.status,
    notes: patch.notes,
    clientId: patch.clientId,
    // undefined is dropped by JSON.stringify, so a patch that does not touch
    // the assignee leaves it alone; "" reaches the server and clears it.
    responsibleUserId: patch.responsibleUserId,
    ...(patch.stageId !== undefined && isUuid(patch.stageId) ? { stageId: patch.stageId } : {}),
    ...(patch.sourceId !== undefined && isUuid(patch.sourceId) ? { sourceId: patch.sourceId } : {}),
    // A uuid links the launch; an explicit empty string unlinks it server-side.
    ...(patch.metaCampaignLaunchId !== undefined && (patch.metaCampaignLaunchId === "" || isUuid(patch.metaCampaignLaunchId))
      ? { metaCampaignLaunchId: patch.metaCampaignLaunchId }
      : {}),
  };
}

export default function LeadsPage() {
  const { rolePermissions } = useAuth();
  const { items, loaded, addItem, updateItem } = useDemoCollection<Lead>("negis_demo_leads", leadsSeed, {
    endpoint: "/api/crm/leads",
    listKey: "leads",
    itemKey: "item",
    fromApi: leadFromApi,
    toApi: leadToApi,
    patchToApi: leadPatchToApi,
  });

  const [stageDefinitions, setStageDefinitions] = useState<LeadStageDefinition[]>(FALLBACK_LEAD_STAGES);
  const [sourceDefinitions, setSourceDefinitions] = useState<LeadSourceDefinition[]>(FALLBACK_LEAD_SOURCES);
  const [structuredStagesAvailable, setStructuredStagesAvailable] = useState(false);
  const [structuredSourcesAvailable, setStructuredSourcesAvailable] = useState(false);
  const [isAdminMode, setIsAdminMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(LEADS_UI_MODE_KEY) === "admin";
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<LeadForm>(emptyForm);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  // Admin-only diagnostics: whether the conversion matched an existing client (per lead).
  const [conversionMatched, setConversionMatched] = useState<Record<string, boolean>>({});
  // CRM7: safe Meta launch records offered for lead attribution.
  const [campaignLaunchOptions, setCampaignLaunchOptions] = useState<CampaignLaunchOption[]>([]);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  // CRM8: secondary attribution filter — works on top of stage filter and search.
  const [attributionFilter, setAttributionFilter] = useState<"all" | "with_ads" | "without_ads">("all");

  useEffect(() => {
    let cancelled = false;
    void loadCampaignLaunchOptions().then((options) => {
      if (!cancelled) setCampaignLaunchOptions(options);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const workspaceId = readWorkspaceId();

    void Promise.all([
      loadTaxonomyList({ endpoint: "/api/crm/lead-stages", listKey: "stages", workspaceId, mapItem: leadStageDefinitionFromUnknown }),
      loadTaxonomyList({ endpoint: "/api/crm/lead-sources", listKey: "sources", workspaceId, mapItem: leadSourceDefinitionFromUnknown }),
      // Colleagues the lead can be handed to. Reference data like the two
      // above: rarely edited, and crmFetch keeps it for five minutes, so this
      // does not add a wait to every visit.
      loadTaxonomyList({ endpoint: "/api/crm/staff", listKey: "staff", workspaceId, mapItem: staffOptionFromUnknown }),
    ])
      .then(([stageResult, sourceResult, staffResult]) => {
        if (cancelled) return;
        setStaffOptions(staffResult.mode === "supabase" ? staffResult.items : []);
        const structuredStages = stageResult.mode === "supabase" && stageResult.items.length > 0;
        const structuredSources = sourceResult.mode === "supabase" && sourceResult.items.length > 0;
        setStructuredStagesAvailable(structuredStages);
        setStructuredSourcesAvailable(structuredSources);
        setStageDefinitions(structuredStages ? orderedActiveStages(stageResult.items) : FALLBACK_LEAD_STAGES);
        setSourceDefinitions(structuredSources ? orderedActiveSources(sourceResult.items) : FALLBACK_LEAD_SOURCES);
      })
      .catch(() => {
        if (cancelled) return;
        setStructuredStagesAvailable(false);
        setStructuredSourcesAvailable(false);
        setStageDefinitions(FALLBACK_LEAD_STAGES);
        setSourceDefinitions(FALLBACK_LEAD_SOURCES);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const activeStages = useMemo(() => orderedActiveStages(stageDefinitions), [stageDefinitions]);
  const activeSources = useMemo(() => orderedActiveSources(sourceDefinitions), [sourceDefinitions]);
  const resolveLeadHistoryValue = useMemo(
    // Все стадии, не только активные: заявка могла стоять в стадии, которую
    // клиника с тех пор отключила, и история обязана называть её как было.
    () => makeLeadHistoryResolver(stageDefinitions, sourceDefinitions, staffOptions),
    [stageDefinitions, sourceDefinitions, staffOptions],
  );

  const setMode = (admin: boolean) => {
    setIsAdminMode(admin);
    if (typeof window !== "undefined") window.localStorage.setItem(LEADS_UI_MODE_KEY, admin ? "admin" : "client");
  };

  const metrics = useMemo(() => {
    const counts: Record<LeadStatusKey, number> = { new: 0, in_progress: 0, booked: 0, lost: 0 };
    for (const lead of items) counts[semanticGroupForLead(lead)] += 1;
    return counts;
  }, [items]);

  const summaryMetrics: Array<{ label: string; value: number; icon: LucideIcon; tone: "primary" | "info" | "success" | "warning" | "error" | "muted" }> = [
    { label: "Всего заявок", value: items.length, icon: Inbox, tone: "primary" },
    { label: "Новые", value: metrics.new, icon: Sparkles, tone: "info" },
    { label: "В работе", value: metrics.in_progress, icon: ClipboardList, tone: "warning" },
    { label: "Записаны", value: metrics.booked, icon: CheckCircle2, tone: "success" },
    { label: "Потеряны", value: metrics.lost, icon: XCircle, tone: metrics.lost > 0 ? "error" : "muted" },
  ];

  const filterOptions = [
    { id: "all", label: "Все" },
    ...activeStages.map((stage) => ({ id: stage.id, label: stage.name })),
  ];

  // CRM8: attribution counts — pure lead/meta_campaign_launch_id counting, no CPL/ROI.
  const attributionCounts = useMemo(() => {
    const attributed = items.filter((lead) => Boolean(lead.metaCampaignLaunchId)).length;
    return { attributed, unattributed: items.length - attributed };
  }, [items]);

  const attributionFilterOptions: Array<{ id: typeof attributionFilter; label: string }> = [
    { id: "all", label: "Все" },
    { id: "with_ads", label: "С рекламой" },
    { id: "without_ads", label: "Без рекламы" },
  ];

  const visibleLeads = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((lead) => {
      const selectedStage = filter === "all" ? null : activeStages.find((stage) => stage.id === filter);
      if (selectedStage) {
        const exactStructuredMatch = Boolean(lead.stageId && lead.stageId === selectedStage.id);
        const keyMatch = Boolean(lead.stageKey && lead.stageKey === selectedStage.stageKey);
        const legacySemanticMatch = !lead.stageId && selectedStage.isDefault && semanticGroupForLead(lead) === selectedStage.semanticGroup;
        if (!exactStructuredMatch && !keyMatch && !legacySemanticMatch) return false;
      }
      // CRM8: attribution filter — "С рекламой" keeps only leads linked to a launch.
      if (attributionFilter === "with_ads" && !lead.metaCampaignLaunchId) return false;
      if (attributionFilter === "without_ads" && lead.metaCampaignLaunchId) return false;
      if (!query) return true;
      return [lead.name, lead.phone, leadSourceName(lead, activeSources), lead.campaign].some((field) => (field || "").toLowerCase().includes(query));
    });
  }, [activeSources, activeStages, attributionFilter, items, filter, search]);

  const detailLead = detailId ? items.find((lead) => lead.id === detailId) || null : null;

  function openAdd() {
    const defaultStage = activeStages.find((stage) => stage.semanticGroup === "new") ?? activeStages[0];
    const defaultSource = structuredSourcesAvailable
      ? activeSources.find((source) => source.sourceKey === "manual") ?? activeSources[0]
      : undefined;
    setEditingId(null);
    setForm({
      ...emptyForm,
      stageId: defaultStage?.id || "fallback:new",
      sourceId: defaultSource?.id || "",
      sourceText: defaultSource?.name || "",
    });
    setFormOpen(true);
  }

  function openEdit(lead: Lead) {
    const currentStage = stageForLead(lead, activeStages);
    const currentSource = sourceForLead(lead, activeSources);
    setEditingId(lead.id);
    setForm({
      name: lead.name,
      phone: lead.phone,
      sourceId: currentSource?.id || "",
      sourceText: leadSourceName(lead, activeSources) === "—" ? "" : leadSourceName(lead, activeSources),
      campaign: lead.campaign,
      metaCampaignLaunchId: lead.metaCampaignLaunchId || "",
      stageId: currentStage?.id || `fallback:${semanticGroupForLead(lead)}`,
      responsibleUserId: lead.responsibleUserId || "",
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
    const selectedStage = activeStages.find((stage) => stage.id === form.stageId)
      ?? activeStages.find((stage) => stage.stageKey === form.stageId)
      ?? activeStages.find((stage) => stage.semanticGroup === "new");
    const selectedSource = activeSources.find((source) => source.id === form.sourceId);
    const sourceSnapshot = selectedSource?.name || form.sourceText.trim();
    const selectedLaunch = campaignLaunchOptions.find((option) => option.id === form.metaCampaignLaunchId);
    // The free-text campaign stays a compatible snapshot: a linked launch fills it when empty.
    const campaignSnapshot = form.campaign.trim() || selectedLaunch?.name || "";
    const patch = {
      name,
      phone,
      source: sourceSnapshot,
      campaign: campaignSnapshot,
      metaCampaignLaunchId: form.metaCampaignLaunchId,
      status: selectedStage?.stageKey || "new",
      notes: form.notes.trim(),
      stageName: selectedStage?.name,
      stageKey: selectedStage?.stageKey,
      stageColor: selectedStage?.color,
      semanticGroup: selectedStage?.semanticGroup || "new",
      sourceName: sourceSnapshot,
      sourceKey: selectedSource?.sourceKey,
      sourceChannel: selectedSource?.channel,
      sourceColor: selectedSource?.color,
      ...(structuredStagesAvailable && isUuid(selectedStage?.id) ? { stageId: selectedStage.id } : {}),
      ...(structuredSourcesAvailable && isUuid(selectedSource?.id) ? { sourceId: selectedSource.id } : {}),
      // Always sent: an empty string is how the operator takes the lead off a
      // colleague, and the server turns it into null.
      responsibleUserId: form.responsibleUserId,
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

  function changeStatus(lead: Lead, stage: LeadStageDefinition) {
    updateItem(lead.id, {
      status: stage.stageKey,
      stageName: stage.name,
      stageKey: stage.stageKey,
      stageColor: stage.color,
      semanticGroup: stage.semanticGroup,
      ...(structuredStagesAvailable && isUuid(stage.id) ? { stageId: stage.id } : {}),
    });
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

      // Сравнение по канонической форме делает сервер по индексу; здесь берём
      // первое совпадение.
      const matched = leadDigits ? (await findClientsByPhone(lead.phone))[0] : undefined;

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
      let persistedOnServer = false;
      try {
        const workspaceId = readWorkspaceId();
        const response = await crmFetch("/api/crm/clients", {
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
          // A uuid is the only proof the row reached Supabase. Accepting any
          // truthy id let a server answer without one pass as success.
          if (isUuid(persisted.id)) {
            savedClient = { ...persisted, comment: persisted.comment ?? newClient.comment };
            persistedOnServer = true;
          }
        }
      } catch {
        // Offline/demo: the local client below still keeps the flow working.
      }

      // In a real clinic the client exists only if Supabase saved it.
      //
      // crmFetch does not throw on 4xx/5xx, so a refusal used to fall straight
      // through: the locally built object was linked to the lead and the toast
      // said «Клиент создан из заявки». It is reachable with an ordinary role,
      // not only in an outage — POST /api/crm/clients needs `manage_clients`,
      // which `marketer` does not have (lib/auth/permissions.ts), while the
      // button is not gated. The registrar saw success, the pill «Клиент
      // создан», and no error at all.
      //
      // Worse than the wrong pill: the statusPatch below persists, so the lead
      // moved into «В работе» against a client that does not exist. Refusing
      // here leaves the lead exactly as it was.
      if (isRealWorkspace() && !persistedOnServer) {
        toast.error("Не удалось создать клиента. Заявка осталась без изменений.");
        return;
      }

      // Demo mode: show the client in /clients immediately (shared demo storage,
      // newest first). Production clients live in Supabase only — never in demo keys.
      if (!isRealWorkspace()) {
        writeDemoStorage("negis_demo_clients", [savedClient, ...readDemoStorage<unknown[]>("negis_demo_clients", []).map(clientFromRecord).filter((client) => client.id !== savedClient.id)]);
      }

      // Link the lead and move a fresh lead into work (never downgrade booked/lost).
      const inProgressStage = activeStages.find((stage) => stage.isDefault && stage.semanticGroup === "in_progress")
        ?? activeStages.find((stage) => stage.semanticGroup === "in_progress");
      const statusPatch = semanticGroupForLead(lead) === "new"
        ? {
            status: inProgressStage?.stageKey || "in_progress",
            semanticGroup: "in_progress" as LeadStatusKey,
            stageName: inProgressStage?.name,
            stageKey: inProgressStage?.stageKey,
            stageColor: inProgressStage?.color,
            ...(structuredStagesAvailable && isUuid(inProgressStage?.id) ? { stageId: inProgressStage.id } : {}),
          }
        : {};
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
        <PageHeader
          kicker="Medina OS · CRM"
          title="Заявки"
          description="Новые обращения из рекламы, сайта, WhatsApp и других источников."
          actions={
            <>
              <div className="inline-flex rounded-lg border p-0.5" style={{ borderColor: "var(--negis-border)", background: "var(--negis-surface)" }} role="group" aria-label="Режим интерфейса">
                {([false, true] as const).map((admin) => (
                  <button
                    key={admin ? "admin" : "client"}
                    type="button"
                    className="rounded-md px-3 py-1.5 text-xs font-semibold transition"
                    style={isAdminMode === admin ? { background: "var(--negis-primary)", color: "#FFFFFF" } : { color: "var(--negis-muted)" }}
                    aria-pressed={isAdminMode === admin}
                    onClick={() => setMode(admin)}
                  >
                    {admin ? "Админ режим" : "Клиентский режим"}
                  </button>
                ))}
              </div>
              <button type="button" className="neu-btn-primary justify-center" onClick={openAdd}>
                <Plus size={16} aria-hidden />
                Добавить заявку
              </button>
            </>
          }
        />

        {/* Summary metrics */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Сводка по заявкам">
          {summaryMetrics.map((metric, index) => (
            <MetricCard
              key={metric.label}
              label={metric.label}
              value={metric.value}
              icon={metric.icon}
              tone={metric.tone}
              loading={!loaded}
              accent={index === 0}
            />
          ))}
        </section>

        {/* CRM8: attribution counts in a compact strip — mobile stays uncluttered. */}
        <section className="negis-glass flex flex-wrap items-center gap-x-6 gap-y-1.5 p-4 text-sm" aria-label="Атрибуция рекламы">
          <p className="font-medium" style={{ color: "var(--negis-muted)" }}>
            Связаны с рекламой: <span className="font-semibold tabular-nums" style={{ color: "var(--negis-text)" }}>{attributionCounts.attributed}</span>
          </p>
          <p className="font-medium" style={{ color: "var(--negis-muted)" }}>
            Без рекламной кампании: <span className="font-semibold tabular-nums" style={{ color: "var(--negis-text)" }}>{attributionCounts.unattributed}</span>
          </p>
        </section>

        {/* Filters + search */}
        <section className="negis-glass p-4 sm:p-5">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Фильтры заявок">
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
                      : { background: "var(--negis-ground)", color: "var(--negis-ink-2)" }
                  }
                  aria-pressed={active}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {/* CRM8: secondary attribution filter (independent of stage filter). */}
          <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Фильтр по рекламе">
            <span className="text-xs font-semibold uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Реклама:</span>
            {attributionFilterOptions.map((option) => {
              const active = attributionFilter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="rounded-full border px-3 py-1.5 text-xs font-semibold transition"
                  style={
                    active
                      ? { background: "var(--negis-primary)", borderColor: "var(--negis-primary)", color: "#FFFFFF" }
                      : { background: "var(--negis-surface)", borderColor: "var(--negis-border)", color: "var(--negis-muted)" }
                  }
                  aria-pressed={active}
                  onClick={() => setAttributionFilter(option.id)}
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

        {/* Loading (production waits for the first Supabase response) / list / empty state */}
        {!loaded ? (
          <section className="negis-glass flex min-h-40 flex-col items-center justify-center gap-3 p-8 text-center" aria-live="polite">
            <Loader2 className="animate-spin" size={22} style={{ color: "var(--negis-primary)" }} />
            <p className="text-sm font-bold" style={{ color: "var(--negis-muted)" }}>Загружаем данные…</p>
          </section>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="Заявок пока нет"
            description="Когда клиника начнёт получать обращения из рекламы, сайта или WhatsApp, они появятся здесь."
            action={
              <button type="button" className="neu-btn-primary justify-center" onClick={openAdd}>
                <Plus size={16} aria-hidden />
                Добавить заявку
              </button>
            }
          />
        ) : visibleLeads.length === 0 ? (
          <EmptyState
            title="Ничего не найдено"
            description="Ничего не найдено. Измените фильтр или поисковый запрос."
            action={
              <button
                type="button"
                className="neu-btn justify-center"
                onClick={() => {
                  setFilter("all");
                  setAttributionFilter("all");
                  setSearch("");
                }}
              >
                Сбросить фильтры
              </button>
            }
          />
        ) : (
          <section className="space-y-3">
            {visibleLeads.map((lead) => {
              const statusKey = semanticGroupForLead(lead);
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
                        {leadSourceName(lead, activeSources) !== "—" ? ` · ${leadSourceName(lead, activeSources)}` : ""}
                        {lead.campaign ? ` · ${lead.campaign}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={leadStatusPill[statusKey]}>{leadStageName(lead, activeStages)}</StatusPill>
                      {lead.clientId ? <StatusPill tone="green">Клиент создан</StatusPill> : null}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-x-5 gap-y-1.5 text-sm sm:grid-cols-2">
                    <Fact label="Источник" value={leadSourceName(lead, activeSources)} />
                    <Fact label="Кампания" value={lead.campaign || "—"} />
                    <Fact label="Рекламная кампания" value={linkedCampaignLabel(lead, campaignLaunchOptions)} />
                    <Fact label="Ответственный" value={responsibleName(lead, staffOptions)} />
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
                  {structuredSourcesAvailable ? (
                    <select
                      style={inputStyle}
                      value={form.sourceId}
                      aria-label="Источник заявки"
                      data-testid="lead-source-select"
                      onChange={(event) => {
                        const selected = activeSources.find((source) => source.id === event.target.value);
                        setForm((current) => ({
                          ...current,
                          sourceId: event.target.value,
                          sourceText: selected?.name || current.sourceText,
                        }));
                      }}
                    >
                      {!form.sourceId && form.sourceText ? <option value="">Текущий: {form.sourceText}</option> : null}
                      {activeSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
                    </select>
                  ) : (
                    <input
                      style={inputStyle}
                      value={form.sourceText}
                      aria-label="Источник заявки"
                      data-testid="lead-source-input"
                      onChange={(event) => setForm((current) => ({ ...current, sourceText: event.target.value }))}
                      placeholder="Instagram, WhatsApp, сайт…"
                    />
                  )}
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Кампания / услуга</span>
                  <input style={inputStyle} value={form.campaign} onChange={(event) => setForm((current) => ({ ...current, campaign: event.target.value }))} placeholder="Название кампании" />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Рекламная кампания</span>
                <select
                  style={inputStyle}
                  value={form.metaCampaignLaunchId}
                  aria-label="Рекламная кампания"
                  data-testid="lead-campaign-select"
                  onChange={(event) => setForm((current) => ({ ...current, metaCampaignLaunchId: event.target.value }))}
                >
                  <option value="">Не выбрана</option>
                  {campaignLaunchOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Этап</span>
                <select
                  style={inputStyle}
                  value={form.stageId}
                  aria-label="Этап заявки"
                  data-testid="lead-stage-select"
                  onChange={(event) => setForm((current) => ({ ...current, stageId: event.target.value }))}
                >
                  {activeStages.map((stage) => (
                    <option key={stage.id} value={stage.id}>{stage.name}</option>
                  ))}
                </select>
              </label>
              {staffOptions.length > 0 && (
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-[0.05em]" style={{ color: "var(--negis-muted)" }}>Ответственный</span>
                  <select
                    style={inputStyle}
                    value={form.responsibleUserId}
                    aria-label="Ответственный за заявку"
                    data-testid="lead-responsible-select"
                    onChange={(event) => setForm((current) => ({ ...current, responsibleUserId: event.target.value }))}
                  >
                    <option value="">Не назначен</option>
                    {staffOptions.map((member) => (
                      <option key={member.id} value={member.id}>{member.name}</option>
                    ))}
                  </select>
                </label>
              )}
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
              <StatusPill tone={leadStatusPill[semanticGroupForLead(detailLead)]}>{leadStageName(detailLead, activeStages)}</StatusPill>
            </div>

            <div className="mt-4 grid gap-1.5 text-sm">
              <Fact label="Источник" value={leadSourceName(detailLead, activeSources)} />
              <Fact label="Кампания" value={detailLead.campaign || "—"} />
              <Fact label="Рекламная кампания" value={linkedCampaignDetail(detailLead, campaignLaunchOptions)} />
              <Fact label="Ответственный" value={responsibleName(detailLead, staffOptions)} />
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
                {activeStages.map((stage) => {
                  const active = detailLead.stageId
                    ? detailLead.stageId === stage.id
                    : semanticGroupForLead(detailLead) === stage.semanticGroup;
                  return (
                    <button
                      key={stage.id}
                      type="button"
                      className="rounded-full border px-3 py-1.5 text-xs font-black transition"
                      style={active ? { background: "var(--negis-primary)", borderColor: "var(--negis-primary)", color: "#FFFFFF" } : { background: "var(--negis-surface)", borderColor: "var(--negis-border)", color: "var(--negis-muted)" }}
                      onClick={() => changeStatus(detailLead, stage)}
                    >
                      {stage.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {isRealWorkspace() && rolePermissions.tasks ? (
              <div className="mt-4">
                <TaskPanel
                  entityType="lead"
                  entityId={detailLead.id}
                  clientId={detailLead.clientId}
                />
              </div>
            ) : null}

            {isRealWorkspace() ? (
              <div className="mt-4">
                <ChangeLogPanel
                  entityType="lead"
                  entityId={detailLead.id}
                  resolveValue={resolveLeadHistoryValue}
                />
              </div>
            ) : null}

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
                  <p>stage_id present: {detailLead.stageId ? "yes" : "no"}</p>
                  <p>source_id present: {detailLead.sourceId ? "yes" : "no"}</p>
                  <p>meta_campaign_launch_id present: {detailLead.metaCampaignLaunchId ? "yes" : "no"}</p>
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
              <Link href="/sales" className="neu-btn-primary justify-center" onClick={() => saveDealPrefill(detailLead)}>
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
