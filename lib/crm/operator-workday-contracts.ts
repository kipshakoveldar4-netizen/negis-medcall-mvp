export const OPERATOR_WORKDAY_PAGE_SIZE = 20;
export const OPERATOR_WORKDAY_COMPANY_LIMIT = 1000;
export type OperatorWorkdayCompany = {
  requestId: string; displayName: string; leadScope: "assigned" | "clinic";
  timeZone: string | null; localDate: string | null; dayStart: string | null; dayEnd: string | null;
};
export type OperatorWorkdayVisit = {
  appointmentId: string; requestId: string; startsAt: string; endsAt: string | null;
  status: "scheduled" | "confirmed" | "arrived" | "no_show" | "cancelled" | "unknown";
  clientName: string; clientPhone: string; service: string; doctorName: string;
  clinicConfirmedAt: string | null; operatorCheckResult: "confirmed" | "unconfirmed" | "unreachable" | null;
};
export type OperatorWorkdayReport = {
  generatedAt: string; offset: number; companies: OperatorWorkdayCompany[];
  summary: { availableLeads: string; assignedLeads: string; clinicLeads: string;
    attributedBookings: string; clinicConfirmedArrivals: string; undatedBookings: string; contacts: "not_tracked";
    bookingStatuses: Record<OperatorWorkdayVisit["status"], string> };
  today: { state: "ready"; total: string; actionable: string; items: OperatorWorkdayVisit[]; hasMore: boolean }
    | { state: "unavailable_timezone"; total: null; actionable: null; items: []; hasMore: false };
};
type Row = Record<string, unknown>;
const object = (v: unknown): Row | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
const keys = (v: Row, expected: string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const count = (v: unknown): v is string => typeof v === "string" && /^(?:0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const offsetValid = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000000;
function instant(v: unknown): v is string {
  return typeof v === "string" && /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
}
const micros = (v: string) => v.slice(0, 19) + "." + v.slice(19, -1).replace(/^\./, "").padEnd(6, "0");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function localDate(at: string, zone: string) {
  // Match 123's supported named-zone policy, not ambiguous abbreviations.
  if (zone.length > 80 || !/^(UTC|GMT|(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Etc|Europe|Indian|Pacific)\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*)$/.test(zone)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
    const part = (kind: string) => parts.find(p => p.type === kind)?.value;
    return `${part("year")?.padStart(4, "0")}-${part("month")}-${part("day")}`;
  } catch { return null; }
}
export function parseOperatorWorkday(value: unknown, expectedOffset: number): OperatorWorkdayReport | null {
  const row = object(value);
  if (!offsetValid(expectedOffset) || !row || !keys(row, ["generatedAt", "offset", "companies", "summary", "today"])
    || row.offset !== expectedOffset || !instant(row.generatedAt) || !Array.isArray(row.companies) || row.companies.length > OPERATOR_WORKDAY_COMPANY_LIMIT) return null;
  const companies: OperatorWorkdayCompany[] = [], byRequest = new Map<string, OperatorWorkdayCompany>();
  for (const value of row.companies) {
    const c = object(value);
    if (!c || !keys(c, ["requestId", "displayName", "leadScope", "timeZone", "localDate", "dayStart", "dayEnd"])
      || !uuid(c.requestId) || !text(c.displayName, 200) || !c.displayName.trim() || !["assigned", "clinic"].includes(c.leadScope as string)) return null;
    const requestId = c.requestId.toLowerCase();
    if (byRequest.has(requestId) || companies.length && companies[companies.length - 1].requestId >= requestId) return null;
    if (c.timeZone === null) {
      if (c.localDate !== null || c.dayStart !== null || c.dayEnd !== null) return null;
    } else if (typeof c.timeZone !== "string" || typeof c.localDate !== "string" || !instant(c.dayStart) || !instant(c.dayEnd)
      || localDate(row.generatedAt, c.timeZone) !== c.localDate || localDate(c.dayStart, c.timeZone) !== c.localDate
      || /[1-9]/.test(c.dayStart.slice(19, -1)) || /[1-9]/.test(c.dayEnd.slice(19, -1))
      || localDate(new Date(Date.parse(c.dayStart) - 1).toISOString(), c.timeZone) === c.localDate
      || localDate(new Date(Date.parse(c.dayEnd) - 1).toISOString(), c.timeZone) !== c.localDate
      || localDate(c.dayEnd, c.timeZone) === c.localDate
      || micros(c.dayStart) > micros(row.generatedAt) || micros(c.dayEnd) <= micros(row.generatedAt)
      || micros(c.dayStart) >= micros(c.dayEnd)) return null;
    const parsed = { requestId, displayName: c.displayName, leadScope: c.leadScope as OperatorWorkdayCompany["leadScope"],
      timeZone: c.timeZone as string | null, localDate: c.localDate as string | null, dayStart: c.dayStart as string | null, dayEnd: c.dayEnd as string | null };
    companies.push(parsed); byRequest.set(requestId, parsed);
  }
  const s = object(row.summary), counts = ["availableLeads", "assignedLeads", "clinicLeads", "attributedBookings", "clinicConfirmedArrivals", "undatedBookings"] as const;
  if (!s || !keys(s, [...counts, "contacts", "bookingStatuses"]) || s.contacts !== "not_tracked" || counts.some(k => !count(s[k]))) return null;
  const statusKeys = ["scheduled", "confirmed", "arrived", "no_show", "cancelled", "unknown"] as const, statusCounts = object(s.bookingStatuses);
  if (!statusCounts || !keys(statusCounts, [...statusKeys]) || statusKeys.some(k => !count(statusCounts[k]))
    || statusKeys.reduce((total, k) => total + BigInt(statusCounts[k] as string), 0n) !== BigInt(s.attributedBookings as string)) return null;
  const summary = Object.fromEntries(counts.map(k => [k, s[k]])) as unknown as OperatorWorkdayReport["summary"];
  summary.contacts = "not_tracked";
  summary.bookingStatuses = Object.fromEntries(statusKeys.map(k => [k, statusCounts[k]])) as OperatorWorkdayReport["summary"]["bookingStatuses"];
  if (BigInt(summary.availableLeads) !== BigInt(summary.assignedLeads) + BigInt(summary.clinicLeads)
    || BigInt(summary.clinicConfirmedArrivals) > BigInt(summary.attributedBookings) || BigInt(summary.undatedBookings) > BigInt(summary.attributedBookings)
    || companies.length === 0 && counts.some(k => s[k] !== "0")) return null;
  const t = object(row.today), missingZone = companies.some(c => c.timeZone === null);
  if (!t || !keys(t, ["state", "total", "actionable", "items", "hasMore"]) || !Array.isArray(t.items)) return null;
  if (t.state === "unavailable_timezone") return missingZone && t.total === null && t.actionable === null && t.items.length === 0 && t.hasMore === false
    ? { generatedAt: row.generatedAt, offset: expectedOffset, companies, summary, today: { state: t.state, total: null, actionable: null, items: [], hasMore: false } } : null;
  if (missingZone || t.state !== "ready" || !count(t.total) || !count(t.actionable) || typeof t.hasMore !== "boolean"
    || BigInt(t.total) + BigInt(summary.undatedBookings) > BigInt(summary.attributedBookings) || BigInt(t.actionable) > BigInt(t.total)
    || t.items.length !== Number(BigInt(t.total) > BigInt(expectedOffset) ? [BigInt(t.total) - BigInt(expectedOffset), 20n].reduce((a, b) => a < b ? a : b) : 0n)
    || t.hasMore !== (BigInt(t.total) > BigInt(expectedOffset + t.items.length))) return null;
  const actionableAll = BigInt(summary.bookingStatuses.scheduled) + BigInt(summary.bookingStatuses.confirmed);
  if (BigInt(t.actionable) > actionableAll
    || BigInt(t.total) - BigInt(t.actionable) > BigInt(summary.attributedBookings) - actionableAll) return null;
  const items: OperatorWorkdayVisit[] = [], seen = new Set<string>();
  for (const value of t.items) {
    const a = object(value);
    if (!a || !keys(a, ["appointmentId", "requestId", "startsAt", "endsAt", "status", "clientName", "clientPhone", "service", "doctorName", "clinicConfirmedAt", "operatorCheckResult"])
      || !uuid(a.appointmentId) || !uuid(a.requestId) || !instant(a.startsAt) || a.endsAt !== null && (!instant(a.endsAt) || micros(a.endsAt) <= micros(a.startsAt))
      || typeof a.status !== "string" || !["scheduled", "confirmed", "arrived", "no_show", "cancelled", "unknown"].includes(a.status)
      || !text(a.clientName, 500) || !text(a.clientPhone, 80) || !text(a.service, 4000) || !text(a.doctorName, 200)
      || a.clinicConfirmedAt !== null && !instant(a.clinicConfirmedAt)
      || a.operatorCheckResult !== null && !["confirmed", "unconfirmed", "unreachable"].includes(a.operatorCheckResult as string)
      || a.operatorCheckResult !== null && a.clinicConfirmedAt === null) return null;
    const appointmentId = a.appointmentId.toLowerCase(), requestId = a.requestId.toLowerCase(), company = byRequest.get(requestId);
    if (!company?.dayStart || !company.dayEnd || seen.has(appointmentId)
      || micros(a.startsAt) < micros(company.dayStart) || micros(a.startsAt) >= micros(company.dayEnd)) return null;
    const parsed: OperatorWorkdayVisit = { appointmentId, requestId, startsAt: a.startsAt, endsAt: a.endsAt as string | null,
      status: a.status as OperatorWorkdayVisit["status"], clientName: a.clientName, clientPhone: a.clientPhone, service: a.service, doctorName: a.doctorName,
      clinicConfirmedAt: a.clinicConfirmedAt as string | null, operatorCheckResult: a.operatorCheckResult as OperatorWorkdayVisit["operatorCheckResult"] };
    const prev = items.at(-1);
    if (prev && (compare(micros(prev.startsAt), micros(parsed.startsAt)) || compare(prev.requestId, requestId) || compare(prev.appointmentId, appointmentId)) > 0) return null;
    seen.add(appointmentId); items.push(parsed);
  }
  const actionableHere = items.filter(a => ["scheduled", "confirmed"].includes(a.status)).length;
  if (BigInt(t.actionable) < BigInt(actionableHere) || BigInt(t.actionable) > BigInt(t.total) - BigInt(items.length - actionableHere)
    || BigInt(summary.clinicConfirmedArrivals) < BigInt(items.filter(a => a.clinicConfirmedAt !== null).length)
    || statusKeys.some(status => BigInt(summary.bookingStatuses[status]) < BigInt(items.filter(a => a.status === status).length))) return null;
  return { generatedAt: row.generatedAt, offset: expectedOffset, companies, summary,
    today: { state: "ready", total: t.total, actionable: t.actionable, items, hasMore: t.hasMore } };
}
