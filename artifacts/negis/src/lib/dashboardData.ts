import { semanticGroupForLead } from "./leadPipeline";

// Medina OS UI-2 — pure dashboard aggregation over records the AI Control
// Center already fetches from existing CRM endpoints. No fetching, no globals,
// no fabricated defaults: empty input yields empty output, invalid values are
// skipped or rendered as "—". Currencies are never mixed.

export type DashboardRecord = Record<string, unknown>;

export type QueueTone = "info" | "warning" | "success" | "error" | "neutral";

export type QueueItem = {
  id: string;
  title: string;
  subtitle: string;
  meta: string;
  statusLabel: string;
  statusTone: QueueTone;
};

export type RecentRecord = {
  id: string;
  kind: "lead" | "client" | "appointment" | "deal";
  kindLabel: string;
  title: string;
  createdAt: string;
  href: string;
};

export type SourceSlice = {
  label: string;
  count: number;
  share: number; // 0..100, rounded
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstStr(...values: unknown[]): string {
  for (const value of values) {
    const text = str(value);
    if (text) return text;
  }
  return "";
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = str(value);
  // Number("") is 0 — an empty/missing value must stay NaN, never a fake zero.
  if (!text) return NaN;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function validTimestamp(value: unknown): string {
  const text = str(value);
  if (!text) return "";
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? text : "";
}

// Money: minor units + explicit currency from the backend record. KZT renders
// with the tenge sign; any other currency keeps its code; unknown data → "—".
export function formatAmountMinor(minorValue: unknown, currency: unknown): string {
  const minor = num(minorValue);
  if (!Number.isFinite(minor) || minor < 0) return "—";
  const code = (str(currency) || "KZT").toUpperCase();
  const major = Math.floor(minor / 100);
  const grouped = major.toLocaleString("ru-RU");
  return code === "KZT" ? `${grouped} ₸` : `${grouped} ${code}`;
}

export function formatQueueDate(value: unknown): string {
  const text = validTimestamp(value);
  if (!text) return "—";
  return new Date(Date.parse(text)).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

const leadStatusLabel: Record<string, { label: string; tone: QueueTone }> = {
  new: { label: "Новая", tone: "info" },
  in_progress: { label: "В работе", tone: "warning" },
  booked: { label: "Записана", tone: "success" },
  lost: { label: "Потеряна", tone: "error" },
};

export function buildNewLeadsQueue(leads: DashboardRecord[], limit = 5): QueueItem[] {
  return leads
    .filter((lead) => semanticGroupForLead(lead) === "new")
    .sort((a, b) => str(b.createdAt ?? b.created_at).localeCompare(str(a.createdAt ?? a.created_at)))
    .slice(0, Math.max(0, limit))
    .map((lead, index) => {
      const status = leadStatusLabel[semanticGroupForLead(lead)] ?? leadStatusLabel.new;
      return {
        id: firstStr(lead.id) || `lead-${index}`,
        title: firstStr(lead.name, lead.phone) || "Заявка",
        subtitle: [firstStr(lead.sourceName, lead.source_name, lead.source), firstStr(lead.campaign)].filter(Boolean).join(" · ") || "Источник не указан",
        meta: formatQueueDate(lead.createdAt ?? lead.created_at),
        statusLabel: status.label,
        statusTone: status.tone,
      };
    });
}

// Upcoming = appointment date is today or later (account-local browser date).
// Records without a parseable date are excluded rather than guessed.
export function buildUpcomingAppointmentsQueue(appointments: DashboardRecord[], todayIso: string, limit = 5): QueueItem[] {
  const today = todayIso.slice(0, 10);
  return appointments
    .map((item) => {
      const startsAt = firstStr(item.startsAt, item.starts_at);
      const date = firstStr(item.date) || startsAt.slice(0, 10);
      const time = firstStr(item.time) || (startsAt.includes("T") ? startsAt.slice(11, 16) : "");
      return { item, date, time };
    })
    .filter(({ date }) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today)
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
    .slice(0, Math.max(0, limit))
    .map(({ item, date, time }, index) => ({
      id: firstStr(item.id) || `appointment-${index}`,
      title: firstStr(item.patientName, item.patient_name, item.clientName, item.client_name, item.name) || "Запись",
      subtitle: firstStr(item.service, item.serviceName, item.service_name) || "Услуга не указана",
      meta: `${new Date(`${date}T00:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" })}${time ? ` · ${time}` : ""}`,
      statusLabel: date === today ? "Сегодня" : "Запланирована",
      statusTone: date === today ? "warning" : "info",
    }));
}

export function buildPendingDealsQueue(deals: DashboardRecord[], limit = 5): QueueItem[] {
  return deals
    .filter((deal) => str(deal.status).toLowerCase() === "pending")
    .sort((a, b) => str(b.createdAt ?? b.created_at).localeCompare(str(a.createdAt ?? a.created_at)))
    .slice(0, Math.max(0, limit))
    .map((deal, index) => ({
      id: firstStr(deal.id) || `deal-${index}`,
      title: firstStr(deal.title, deal.service) || "Продажа",
      subtitle: formatAmountMinor(deal.amountMinor ?? deal.amount_minor, deal.currency),
      meta: formatQueueDate(deal.createdAt ?? deal.created_at),
      statusLabel: "Ожидает оплаты",
      statusTone: "warning",
    }));
}

const recentKindMeta: Record<RecentRecord["kind"], { label: string; href: string }> = {
  lead: { label: "Заявка", href: "/leads" },
  client: { label: "Клиент", href: "/clients" },
  appointment: { label: "Запись", href: "/appointments" },
  deal: { label: "Продажа", href: "/sales" },
};

// Honest recency list: only records with a real created timestamp qualify.
// This is "недавно созданные записи", not an audit log.
export function buildRecentRecords(
  sources: Partial<Record<RecentRecord["kind"], DashboardRecord[]>>,
  limit = 6,
): RecentRecord[] {
  const merged: RecentRecord[] = [];
  (Object.keys(recentKindMeta) as RecentRecord["kind"][]).forEach((kind) => {
    for (const [index, record] of (sources[kind] ?? []).entries()) {
      const createdAt = validTimestamp(record.createdAt ?? record.created_at);
      if (!createdAt) continue;
      merged.push({
        id: firstStr(record.id) || `${kind}-${index}`,
        kind,
        kindLabel: recentKindMeta[kind].label,
        title:
          firstStr(record.name, record.title, record.patientName, record.patient_name, record.clientName, record.client_name, record.phone) ||
          recentKindMeta[kind].label,
        createdAt,
        href: recentKindMeta[kind].href,
      });
    }
  });
  return merged
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, Math.max(0, limit));
}

export function buildLeadSourceDistribution(leads: DashboardRecord[], limit = 6): SourceSlice[] {
  if (leads.length === 0) return [];
  const counts = new Map<string, number>();
  for (const lead of leads) {
    const label = firstStr(lead.sourceName, lead.source_name, lead.source) || "Без источника";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const total = leads.length;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
    .slice(0, Math.max(0, limit))
    .map(([label, count]) => ({ label, count, share: Math.round((count / total) * 100) }));
}
