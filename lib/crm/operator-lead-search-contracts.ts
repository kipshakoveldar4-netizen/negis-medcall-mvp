export const OPERATOR_LEAD_SEARCH_PAGE_SIZE = 20;
export const OPERATOR_LEAD_SEARCH_PATH = "operator-lead-search";
export const operatorLeadGroups = ["new", "in_progress", "booked", "postponed", "lost", "other"] as const;
export type OperatorLeadGroup = typeof operatorLeadGroups[number];
export type OperatorLeadSearchQuery = { search: string; group: "all" | OperatorLeadGroup; requestId: string | null; offset: number };
export type OperatorSearchCompany = { requestId: string; displayName: string; leadScope: "assigned" | "clinic" };
export type OperatorSearchLead = { id: string; requestId: string; name: string; phone: string; status: string;
  stageId: string | null; stageName: string; group: OperatorLeadGroup; source: string; createdAt: string | null };
export type OperatorSearchStages = { requestId: string; items: { id: string; name: string }[] };
export type OperatorLeadSearchReport = { generatedAt: string; offset: number;
  filters: Pick<OperatorLeadSearchQuery, "group" | "requestId">; companies: OperatorSearchCompany[];
  totals: Record<"all" | OperatorLeadGroup, string>; matched: string;
  items: OperatorSearchLead[]; stageOptions: OperatorSearchStages[]; hasMore: boolean };
export const operatorLeadGroupLabels: Record<"all" | OperatorLeadGroup, string> = {
  all: "Все", new: "Новые", in_progress: "В работе", booked: "Записанные", postponed: "Отложенные", lost: "Потерянные", other: "Другие",
};

type Row = Record<string, unknown>;
const object = (v: unknown): Row | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
const exact = (v: Row, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const count = (v: unknown): v is string => typeof v === "string" && /^(?:0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const offsetValid = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000000;
const isGroup = (v: unknown): v is OperatorLeadSearchQuery["group"] => v === "all" || operatorLeadGroups.includes(v as OperatorLeadGroup);
function instant(v: unknown): v is string {
  return typeof v === "string" && /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
}
const micros = (v: string) => v.slice(0, 19) + "." + v.slice(19, -1).replace(/^\./, "").padEnd(6, "0");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function parseOperatorLeadSearchBody(value: unknown): OperatorLeadSearchQuery | null {
  const body = object(value);
  if (!body || Object.prototype.toString.call(body) !== "[object Object]"
    || Object.keys(body).some(k => !["search", "group", "requestId", "offset"].includes(k))) return null;
  const { search = "", group = "all", requestId = null, offset = 0 } = body;
  if (!text(search, 120) || !isGroup(group) || requestId !== null && !uuid(requestId)
    || !offsetValid(offset)) return null;
  return { search: search.trim(), group, requestId: requestId === null ? null : requestId.toLowerCase(), offset };
}

export function parseOperatorLeadSearchRpcReport(value: unknown, expected: OperatorLeadSearchQuery): OperatorLeadSearchReport | null {
  return parseReport(value, expected, true);
}

export function parseOperatorLeadSearchReport(value: unknown, expected: OperatorLeadSearchQuery): OperatorLeadSearchReport | null {
  return parseReport(value, expected, false);
}

function parseReport(value: unknown, expected: OperatorLeadSearchQuery, fromRpc: boolean): OperatorLeadSearchReport | null {
  if (!expected || !text(expected.search, 120) || expected.search.trim() !== expected.search || !isGroup(expected.group)
    || !offsetValid(expected.offset) || expected.requestId !== null && (!uuid(expected.requestId) || expected.requestId !== expected.requestId.toLowerCase())) return null;
  const r = object(value), f = r && object(r.filters);
  if (!r || !exact(r, ["generatedAt", "offset", "filters", "companies", "totals", "matched", "items", "stageOptions", "hasMore"])
    || !instant(r.generatedAt) || r.offset !== expected.offset || !f
    || !exact(f, fromRpc ? ["search", "group", "requestId"] : ["group", "requestId"])
    || (fromRpc && f.search !== expected.search) || f.group !== expected.group || f.requestId !== expected.requestId
    || !Array.isArray(r.companies) || r.companies.length > 1000) return null;
  const companies: OperatorSearchCompany[] = [], byRequest = new Map<string, OperatorSearchCompany>();
  for (const value of r.companies) {
    const c = object(value);
    if (!c || !exact(c, ["requestId", "displayName", "leadScope"]) || !uuid(c.requestId)
      || !text(c.displayName, 200) || !c.displayName.trim() || !["assigned", "clinic"].includes(c.leadScope as string)) return null;
    const id = c.requestId.toLowerCase();
    if (byRequest.has(id) || companies.length && companies.at(-1)!.requestId >= id) return null;
    const company = { requestId: id, displayName: c.displayName, leadScope: c.leadScope as OperatorSearchCompany["leadScope"] };
    companies.push(company); byRequest.set(id, company);
  }
  if (expected.requestId !== null && !byRequest.has(expected.requestId)) return null;
  const t = object(r.totals), allGroups = ["all", ...operatorLeadGroups] as const;
  if (!t || !exact(t, [...allGroups]) || allGroups.some(k => !count(t[k])) || !count(r.matched)
    || operatorLeadGroups.reduce((n, k) => n + BigInt(t[k] as string), 0n) !== BigInt(t.all as string)
    || r.matched !== t[expected.group] || companies.length === 0 && t.all !== "0"
    || !Array.isArray(r.items) || typeof r.hasMore !== "boolean") return null;
  const matched = BigInt(r.matched), remaining = matched > BigInt(expected.offset) ? matched - BigInt(expected.offset) : 0n;
  if (r.items.length !== Number(remaining < 20n ? remaining : 20n) || r.hasMore !== (matched > BigInt(expected.offset + r.items.length))) return null;
  const items: OperatorSearchLead[] = [], seen = new Set<string>(), itemRequests = new Set<string>();
  for (const value of r.items) {
    const l = object(value);
    if (!l || !exact(l, ["id", "requestId", "name", "phone", "status", "stageId", "stageName", "group", "source", "createdAt"])
      || !uuid(l.id) || !uuid(l.requestId) || !text(l.name, 500) || !text(l.phone, 80) || !text(l.status, 300)
      || l.stageId !== null && !uuid(l.stageId) || !text(l.stageName, 200) || !operatorLeadGroups.includes(l.group as OperatorLeadGroup)
      || !text(l.source, 300) || l.createdAt !== null && !instant(l.createdAt)) return null;
    const id = l.id.toLowerCase(), requestId = l.requestId.toLowerCase();
    if (seen.has(id) || !byRequest.has(requestId) || expected.requestId !== null && requestId !== expected.requestId
      || expected.group !== "all" && l.group !== expected.group) return null;
    const lead = { id, requestId, name: l.name, phone: l.phone, status: l.status, stageId: l.stageId === null ? null : l.stageId.toLowerCase(),
      stageName: l.stageName, group: l.group as OperatorLeadGroup, source: l.source, createdAt: l.createdAt as string | null };
    const previous = items.at(-1);
    if (previous && (previous.createdAt === null && lead.createdAt !== null
      || previous.createdAt !== null && lead.createdAt !== null && micros(previous.createdAt) < micros(lead.createdAt)
      || previous.createdAt === lead.createdAt && (compare(previous.requestId, lead.requestId) || compare(previous.id, lead.id)) > 0
      || previous.createdAt !== null && lead.createdAt !== null && micros(previous.createdAt) === micros(lead.createdAt)
        && (compare(previous.requestId, lead.requestId) || compare(previous.id, lead.id)) > 0)) return null;
    seen.add(id); itemRequests.add(requestId); items.push(lead);
  }
  if (operatorLeadGroups.some(k => BigInt(t[k] as string) < BigInt(items.filter(l => l.group === k).length))
    || !Array.isArray(r.stageOptions) || r.stageOptions.length !== itemRequests.size) return null;
  const stageOptions: OperatorSearchStages[] = [];
  for (const value of r.stageOptions) {
    const s = object(value);
    if (!s || !exact(s, ["requestId", "items"]) || !uuid(s.requestId) || !itemRequests.has(s.requestId.toLowerCase())
      || stageOptions.length && stageOptions.at(-1)!.requestId >= s.requestId.toLowerCase()
      || !Array.isArray(s.items) || s.items.length > 1000) return null;
    const stageIds = new Set<string>(), stages: OperatorSearchStages["items"] = [];
    for (const value of s.items) {
      const stage = object(value);
      if (!stage || !exact(stage, ["id", "name"]) || !uuid(stage.id) || stageIds.has(stage.id.toLowerCase())
        || !text(stage.name, 200) || !stage.name.trim()) return null;
      stageIds.add(stage.id.toLowerCase()); stages.push({ id: stage.id.toLowerCase(), name: stage.name });
    }
    stageOptions.push({ requestId: s.requestId.toLowerCase(), items: stages });
  }
  // Bind the RPC echo to this request without carrying the search term into the HTTP report.
  return { generatedAt: r.generatedAt, offset: expected.offset, filters: { group: expected.group, requestId: expected.requestId },
    companies, totals: Object.fromEntries(allGroups.map(k => [k, t[k]])) as OperatorLeadSearchReport["totals"], matched: r.matched,
    items, stageOptions, hasMore: r.hasMore };
}
