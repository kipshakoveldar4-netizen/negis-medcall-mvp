export type PartnerCompany = Readonly<{ name: string; purpose: "clinic_services" | "marketing" | "mortgage_leads";
  vertical: "clinic" | "beauty" | "dental" | null; timeZone: string; ownerName: string }>;
export type PartnerCompanyState = "pending" | "approved" | "rejected";
export type PartnerCompanyNotice = Readonly<{ version: string; purpose: "partner_company_registration"; text: string;
  policyRevision: string; policyUrl: string; sha256: string }>;
export type PartnerCompanyApplication = Readonly<{ id: string; revision: string; state: PartnerCompanyState; company: PartnerCompany;
  workspaceId: string | null; sourceState: "captured" | "expired" | "pending_payment" | "bound";
  expiresAt: string; submittedAt: string; reviewedAt: string | null }>;
export type PartnerCompanyContext = Readonly<{ sourceId: string; expiresAt: string; notice: PartnerCompanyNotice; applicantEmail: string }>;
export type PartnerCompanyReceipt = Readonly<{ requestId: string; sourceId: string } & (
  { state: "unconfirmed" | "abandoned" } | { state: "committed"; application: PartnerCompanyApplication })>;
export type PartnerCompanyReviewCommand = Readonly<{ requestId: string; applicationId: string; revision: string; action: "approve" | "reject" }>;
export type PartnerCompanyReviewReceipt = PartnerCompanyReviewCommand & Readonly<
  { state: "unconfirmed" | "abandoned" } | { state: "committed"; application: PartnerCompanyApplication }>;
export type PartnerCompanyPage = Readonly<{ items: readonly PartnerCompanyApplication[]; offset: number;
  state: PartnerCompanyState | null; hasMore: boolean }>;

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const keys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value, k));
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const text = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v === v.trim()
  && v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && !v.startsWith("0000-")
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v))
  && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
const instantKey = (v: string) => { const [s, f = ""] = v.slice(0, -1).split("."); return s + "." + f.padEnd(6, "0"); };
const state = (v: unknown): v is PartnerCompanyState => typeof v === "string" && ["pending", "approved", "rejected"].includes(v);
const email = (v: unknown): v is string => typeof v === "string" && v.length <= 254
  && !/[\u0000-\u001f\u007f]/.test(v) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export function parsePartnerCompany(value: unknown): PartnerCompany | null {
  const v = object(value);
  if (!v || !keys(v, ["name", "purpose", "vertical", "timeZone", "ownerName"]) || !text(v.name, 2, 120)
    || !text(v.ownerName, 1, 120) || !text(v.timeZone, 1, 80) || /^[+\-\d]/.test(v.timeZone) || typeof v.purpose !== "string"
    || !["clinic_services", "marketing", "mortgage_leads"].includes(v.purpose)
    || (v.purpose === "clinic_services" ? typeof v.vertical !== "string" || !["clinic", "beauty", "dental"].includes(v.vertical) : v.vertical !== null)) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: v.timeZone }); } catch { return null; }
  return Object.freeze({ name: v.name, purpose: v.purpose as PartnerCompany["purpose"], vertical: v.vertical as PartnerCompany["vertical"],
    timeZone: v.timeZone, ownerName: v.ownerName });
}
export function parsePartnerCompanyApplication(value: unknown): PartnerCompanyApplication | null {
  const v = object(value), company = parsePartnerCompany(v?.company);
  if (!v || !company || !keys(v, ["id", "revision", "state", "company", "workspaceId", "sourceState", "expiresAt", "submittedAt", "reviewedAt"])
    || !uuid(v.id) || !uuid(v.revision) || !state(v.state) || !instant(v.expiresAt) || !instant(v.submittedAt)
    || instantKey(v.submittedAt) >= instantKey(v.expiresAt)
    || (v.state === "pending" ? v.reviewedAt !== null : !instant(v.reviewedAt) || instantKey(v.reviewedAt) < instantKey(v.submittedAt))) return null;
  if (typeof v.sourceState !== "string") return null;
  if (v.state === "approved" ? !uuid(v.workspaceId) || !["pending_payment", "bound", "expired"].includes(v.sourceState)
    : v.workspaceId !== null || !["captured", "expired"].includes(v.sourceState)) return null;
  return Object.freeze({ id: v.id, revision: v.revision, state: v.state, company, workspaceId: v.workspaceId as string | null,
    sourceState: v.sourceState as PartnerCompanyApplication["sourceState"], expiresAt: v.expiresAt, submittedAt: v.submittedAt, reviewedAt: v.reviewedAt as string | null });
}
function notice(value: unknown): PartnerCompanyNotice | null {
  const v = object(value);
  if (!v || !keys(v, ["version", "purpose", "text", "policyRevision", "policyUrl", "sha256"])
    || typeof v.version !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(v.version) || v.purpose !== "partner_company_registration"
    || typeof v.text !== "string" || !v.text.trim() || v.text.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.text)
    || !text(v.policyRevision, 1, 120) || typeof v.policyUrl !== "string" || v.policyUrl.length > 2048 || /[\s\\]/.test(v.policyUrl)
    || typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256)) return null;
  try { const u = new URL(v.policyUrl); if (u.protocol !== "https:" || u.username || u.password || u.hash) return null; } catch { return null; }
  return Object.freeze({ version: v.version, purpose: "partner_company_registration", text: v.text,
    policyRevision: v.policyRevision, policyUrl: v.policyUrl, sha256: v.sha256 });
}
export function parsePartnerCompanyContext(value: unknown): PartnerCompanyContext | null {
  const v = object(value), n = notice(v?.notice);
  if (!v || !n || !keys(v, ["sourceId", "expiresAt", "notice", "applicantEmail"]) || !uuid(v.sourceId)
    || !instant(v.expiresAt) || !email(v.applicantEmail)) return null;
  return Object.freeze({ sourceId: v.sourceId, expiresAt: v.expiresAt, notice: n, applicantEmail: v.applicantEmail });
}
export function parsePartnerCompanyReceipt(value: unknown): PartnerCompanyReceipt | null {
  const v = object(value);
  if (!v || !uuid(v.requestId) || !uuid(v.sourceId)) return null;
  if (keys(v, ["state", "requestId", "sourceId"]) && (v.state === "unconfirmed" || v.state === "abandoned"))
    return Object.freeze({ state: v.state as "unconfirmed" | "abandoned", requestId: v.requestId, sourceId: v.sourceId });
  const application = parsePartnerCompanyApplication(v.application);
  return keys(v, ["state", "requestId", "sourceId", "application"]) && v.state === "committed" && application
    && application.id.toLowerCase() === v.requestId.toLowerCase()
    ? Object.freeze({ state: "committed", requestId: v.requestId, sourceId: v.sourceId, application }) : null;
}
export function parsePartnerCompanyReviewCommand(value: unknown): PartnerCompanyReviewCommand | null {
  const v = object(value);
  return v && keys(v, ["requestId", "applicationId", "revision", "action"]) && uuid(v.requestId) && uuid(v.applicationId)
    && uuid(v.revision) && (v.action === "approve" || v.action === "reject")
    ? Object.freeze({ requestId: v.requestId, applicationId: v.applicationId, revision: v.revision, action: v.action }) : null;
}
export function parsePartnerCompanyReviewReceipt(value: unknown): PartnerCompanyReviewReceipt | null {
  const v = object(value);
  if (!v || !["requestId", "applicationId", "revision", "action", "state"].every(k => Object.hasOwn(v, k))) return null;
  const command = parsePartnerCompanyReviewCommand({ requestId: v.requestId, applicationId: v.applicationId, revision: v.revision, action: v.action });
  if (!command) return null;
  if (keys(v, ["state", "requestId", "applicationId", "revision", "action"]) && (v.state === "unconfirmed" || v.state === "abandoned"))
    return Object.freeze({ ...command, state: v.state });
  const application = parsePartnerCompanyApplication(v.application);
  return keys(v, ["state", "requestId", "applicationId", "revision", "action", "application"]) && v.state === "committed" && application
    && application.id.toLowerCase() === command.applicationId.toLowerCase() && application.revision.toLowerCase() !== command.revision.toLowerCase()
    && application.state === (command.action === "approve" ? "approved" : "rejected")
    ? Object.freeze({ ...command, state: "committed", application }) : null;
}
export function parsePartnerCompanyPage(value: unknown, expected?: { offset: number; state: PartnerCompanyState | null }): PartnerCompanyPage | null {
  const v = object(value);
  if (!v || !keys(v, ["items", "offset", "state", "hasMore"]) || !Array.isArray(v.items) || v.items.length > 20
    || typeof v.offset !== "number" || !Number.isInteger(v.offset) || v.offset < 0 || v.offset > 1000000 || (v.state !== null && !state(v.state))
    || typeof v.hasMore !== "boolean" || (v.hasMore && v.items.length !== 20)
    || (expected && (v.offset !== expected.offset || v.state !== expected.state))) return null;
  const items: PartnerCompanyApplication[] = [];
  for (const raw of v.items) {
    const item = parsePartnerCompanyApplication(raw), previous = items.at(-1);
    if (!item || (v.state !== null && item.state !== v.state) || items.some(p => p.id.toLowerCase() === item.id.toLowerCase())
      || (previous && (instantKey(previous.submittedAt) < instantKey(item.submittedAt)
        || (instantKey(previous.submittedAt) === instantKey(item.submittedAt) && previous.id.toLowerCase() <= item.id.toLowerCase())))) return null;
    items.push(item);
  }
  return Object.freeze({ items: Object.freeze(items), offset: v.offset, state: v.state as PartnerCompanyState | null, hasMore: v.hasMore });
}
