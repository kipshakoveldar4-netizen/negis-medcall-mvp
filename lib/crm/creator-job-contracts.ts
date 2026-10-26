import { publicPortfolioUrl } from "./contributor-contracts";
export const CREATOR_JOB_PAGE_SIZE = 20;
export const creatorJobStates = ["offered", "in_progress", "submitted", "changes_requested", "approved", "declined", "cancelled"] as const;
export type CreatorJobState = typeof creatorJobStates[number];
export type CreatorSubmission = { sequence: number; links: string[]; note: string; submittedAt: string };
export type CreatorJob = {
  id: string; revision: string; termsRevision: string; creatorName: string;
  title: string; brief: string; rightsTerms: string; feeMinor: string; currency: string; dueAt: string;
  state: CreatorJobState; acceptedAt: string | null; approvedAt: string | null;
  submissionCount: number; latestSubmission: CreatorSubmission | null; feedback: string | null;
};
export type CreatorJobTerms = Pick<CreatorJob, "title" | "brief" | "rightsTerms" | "feeMinor" | "currency" | "dueAt"> & { creatorId: string };
export type CreatorJobAction = { action: "accept"; payload: { termsRevision: string } }
  | { action: "decline" | "approve" | "cancel"; payload: Record<string, never> }
  | { action: "submit"; payload: { links: string[]; note: string } }
  | { action: "request_changes"; payload: { feedback: string } };
export type CreatorCommandAction = CreatorJobAction["action"] | "create";
export type CreatorCommandIdentity = { requestId: string; action: CreatorCommandAction; targetId: string };
export type CreatorCommandResult = { state: "unconfirmed"; requestId: string }
  | (CreatorCommandIdentity & { state: "abandoned"; closedAt: string })
  | (CreatorCommandIdentity & { state: "committed"; result: NonNullable<ReturnType<typeof parseCreatorJobReceipt>> });
export type CreatorDirectoryEntry = { id: string; displayName: string; portfolioUrls: string[] };
export type CreatorJobDetail = { job: CreatorJob; companyName: string; history: { offset: number; items: CreatorSubmission[]; hasMore: boolean } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function keys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
const id = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
function text(value: unknown, maximum: number, multiline = true): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value) && (multiline || !value.includes("\n"));
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || value.startsWith("0000-")) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function money(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
export function creatorDeliverableUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500
    || !/^https:\/\/([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}([/?#][^\s\u0000-\u001f\u007f\\]*)?$/.test(value)) return false;
  const host = value.slice(8).split(/[/?#]/)[0].toLowerCase();
  return !/(^|\.)(localhost|local|internal|invalid|test)$/.test(host);
}
function links(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 5
    && value.every(creatorDeliverableUrl) && new Set(value).size === value.length;
}
function terms(row: Record<string, unknown>) {
  return text(row.title, 120, false) && text(row.brief, 4000) && text(row.rightsTerms, 3000)
    && money(row.feeMinor) && typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) && instant(row.dueAt);
}
export function parseCreatorJobTerms(value: unknown): CreatorJobTerms | null {
  const row = object(value);
  if (!row || !keys(row, ["creatorId", "title", "brief", "rightsTerms", "feeMinor", "currency", "dueAt"])
    || !id(row.creatorId) || !terms(row)) return null;
  return { ...row } as CreatorJobTerms;
}
export function parseCreatorJobAction(value: unknown): CreatorJobAction | null {
  const row = object(value), payload = object(row?.payload);
  if (!row || !payload || !keys(row, ["action", "payload"])) return null;
  if (row.action === "accept" && keys(payload, ["termsRevision"]) && id(payload.termsRevision))
    return { action: "accept", payload: { termsRevision: payload.termsRevision } };
  if (["decline", "approve", "cancel"].includes(String(row.action)) && keys(payload, []))
    return { action: row.action as "decline" | "approve" | "cancel", payload: {} };
  if (row.action === "submit" && keys(payload, ["links", "note"]) && links(payload.links) && typeof payload.note === "string"
    && payload.note.length <= 2000 && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(payload.note))
    return { action: "submit", payload: { links: [...payload.links], note: payload.note } };
  if (row.action === "request_changes" && keys(payload, ["feedback"]) && text(payload.feedback, 2000))
    return { action: "request_changes", payload: { feedback: payload.feedback } };
  return null;
}
export function parseCreatorJob(value: unknown): CreatorJob | null {
  const row = object(value);
  if (!row || !keys(row, ["id", "revision", "termsRevision", "creatorName", "title", "brief", "rightsTerms", "feeMinor", "currency", "dueAt",
    "state", "acceptedAt", "approvedAt", "submissionCount", "latestSubmission", "feedback"])
    || !id(row.id) || !id(row.revision) || !id(row.termsRevision) || !text(row.creatorName, 120, false) || !terms(row)
    || !creatorJobStates.includes(row.state as CreatorJobState)
    || !Number.isInteger(row.submissionCount) || (row.submissionCount as number) < 0 || (row.submissionCount as number) > 2147483647) return null;
  const accepted = ["in_progress", "submitted", "changes_requested", "approved"].includes(String(row.state));
  if ((accepted ? !instant(row.acceptedAt) : row.acceptedAt !== null)
    || (row.state === "approved" ? !instant(row.approvedAt) : row.approvedAt !== null)
    || (row.state === "changes_requested" ? !text(row.feedback, 2000) : row.feedback !== null)) return null;
  const submitted = ["submitted", "changes_requested", "approved"].includes(String(row.state));
  if ((row.submissionCount as number) > 0 !== submitted) return null;
  let latestSubmission: CreatorSubmission | null = null;
  if (submitted) {
    const submission = object(row.latestSubmission);
    if (!submission || !keys(submission, ["sequence", "links", "note", "submittedAt"])
      || submission.sequence !== row.submissionCount || !links(submission.links) || !instant(submission.submittedAt)
      || typeof submission.note !== "string" || submission.note.length > 2000 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(submission.note)) return null;
    latestSubmission = { sequence: row.submissionCount as number, links: [...submission.links], note: submission.note, submittedAt: submission.submittedAt };
    if (Date.parse(submission.submittedAt) < Date.parse(row.acceptedAt as string)
      || (row.approvedAt !== null && Date.parse(row.approvedAt as string) < Date.parse(submission.submittedAt))) return null;
  } else if (row.latestSubmission !== null) return null;
  return { ...row, latestSubmission } as CreatorJob;
}
export function parseCreatorJobPage(value: unknown): { items: CreatorJob[]; hasMore: boolean } | null {
  const row = object(value);
  if (!row || !keys(row, ["items", "hasMore"]) || !Array.isArray(row.items) || row.items.length > CREATOR_JOB_PAGE_SIZE
    || typeof row.hasMore !== "boolean" || (row.hasMore && row.items.length !== CREATOR_JOB_PAGE_SIZE)) return null;
  const items = row.items.map(parseCreatorJob);
  if (items.some(item => item === null) || new Set(items.map(item => item!.id)).size !== items.length) return null;
  return { items: items as CreatorJob[], hasMore: row.hasMore };
}
export function parseCreatorJobReceipt(value: unknown): { requestId: string; appliedRevision: string; replayed: boolean; job: CreatorJob } | null {
  const row = object(value);
  if (!row || !keys(row, ["requestId", "appliedRevision", "replayed", "job"]) || !id(row.requestId) || !id(row.appliedRevision)
    || typeof row.replayed !== "boolean") return null;
  const job = parseCreatorJob(row.job);
  if (!job || (!row.replayed && row.appliedRevision !== job.revision)) return null;
  return { requestId: row.requestId, appliedRevision: row.appliedRevision, replayed: row.replayed, job };
}

const actions: readonly string[] = ["create", "accept", "decline", "submit", "request_changes", "approve", "cancel"];
export function parseCreatorCommandIdentity(value: unknown): CreatorCommandIdentity | null {
  const row = object(value);
  return row && keys(row, ["requestId", "action", "targetId"]) && id(row.requestId) && id(row.targetId)
    && typeof row.action === "string" && actions.includes(row.action) ? { requestId: row.requestId, action: row.action as CreatorCommandAction, targetId: row.targetId } : null;
}
export function parseCreatorCommandResult(value: unknown, expected?: CreatorCommandIdentity): CreatorCommandResult | null {
  if (expected && !parseCreatorCommandIdentity(expected)) return null;
  const row = object(value);
  if (!row || !id(row.requestId) || (expected && row.requestId.toLowerCase() !== expected.requestId.toLowerCase())) return null;
  if (row.state === "unconfirmed") return keys(row, ["state", "requestId"]) ? { state: "unconfirmed", requestId: row.requestId } : null;
  const identity = parseCreatorCommandIdentity({ requestId: row.requestId, action: row.action, targetId: row.targetId });
  if (!identity || (expected && (identity.action !== expected.action || identity.targetId.toLowerCase() !== expected.targetId.toLowerCase()))) return null;
  if (row.state === "abandoned" && keys(row, ["state", "requestId", "action", "targetId", "closedAt"]) && instant(row.closedAt))
    return { state: "abandoned", ...identity, closedAt: row.closedAt };
  if (row.state !== "committed" || !keys(row, ["state", "requestId", "action", "targetId", "result"])) return null;
  const result = parseCreatorJobReceipt(row.result);
  if (!result || result.requestId.toLowerCase() !== row.requestId.toLowerCase()
    || (identity.action !== "create" && result.job.id.toLowerCase() !== identity.targetId.toLowerCase())) return null;
  const states: Record<CreatorCommandAction, readonly CreatorJobState[]> = {
    create: creatorJobStates, accept: ["in_progress", "submitted", "changes_requested", "approved"], decline: ["declined"],
    submit: ["submitted", "changes_requested", "approved"], request_changes: ["changes_requested", "submitted", "approved"], approve: ["approved"], cancel: ["cancelled"],
  };
  const initial: Record<CreatorCommandAction, CreatorJobState> = { create: "offered", accept: "in_progress", decline: "declined", submit: "submitted",
    request_changes: "changes_requested", approve: "approved", cancel: "cancelled" };
  if (result.replayed ? !states[identity.action].includes(result.job.state) : result.job.state !== initial[identity.action]) return null;
  return { state: "committed", ...identity, result };
}
export function parseCreatorDirectory(value: unknown): { items: CreatorDirectoryEntry[]; hasMore: boolean } | null {
  const row = object(value);
  if (!row || !keys(row, ["items", "hasMore"]) || !Array.isArray(row.items) || row.items.length > CREATOR_JOB_PAGE_SIZE
    || typeof row.hasMore !== "boolean" || (row.hasMore && row.items.length !== CREATOR_JOB_PAGE_SIZE)) return null;
  const items: CreatorDirectoryEntry[] = [];
  for (const value of row.items) {
    const item = object(value);
    if (!item || !keys(item, ["id", "displayName", "portfolioUrls"]) || !id(item.id) || !text(item.displayName, 120, false)
      || !Array.isArray(item.portfolioUrls) || item.portfolioUrls.length > 5 || new Set(item.portfolioUrls).size !== item.portfolioUrls.length
      || !item.portfolioUrls.every(url => publicPortfolioUrl(url) === url)) return null;
    items.push({ id: item.id, displayName: item.displayName, portfolioUrls: [...item.portfolioUrls] });
  }
  return new Set(items.map(item => item.id.toLowerCase())).size === items.length ? { items, hasMore: row.hasMore } : null;
}
export function parseCreatorJobDetail(value: unknown): CreatorJobDetail | null {
  const row = object(value), history = object(row?.history);
  if (!row || !keys(row, ["job", "companyName", "history"]) || !text(row.companyName, 200, false) || !history
    || !keys(history, ["offset", "items", "hasMore"]) || !Number.isInteger(history.offset) || (history.offset as number) < 0
    || (history.offset as number) > 1000000 || !Array.isArray(history.items) || typeof history.hasMore !== "boolean") return null;
  const job = parseCreatorJob(row.job);
  if (!job) return null;
  const remaining = Math.max(0, job.submissionCount - (history.offset as number));
  if (history.items.length !== Math.min(CREATOR_JOB_PAGE_SIZE, remaining) || history.hasMore !== (remaining > CREATOR_JOB_PAGE_SIZE)) return null;
  const items: CreatorSubmission[] = [];
  for (const [index, value] of history.items.entries()) {
    const item = object(value);
    if (!item || !keys(item, ["sequence", "links", "note", "submittedAt"]) || item.sequence !== remaining - index
      || !links(item.links) || typeof item.note !== "string" || item.note.length > 2000 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(item.note)
      || !instant(item.submittedAt) || Date.parse(item.submittedAt) < Date.parse(job.acceptedAt!)) return null;
    items.push({ sequence: item.sequence as number, links: [...item.links], note: item.note, submittedAt: item.submittedAt });
    if ((index > 0 && Date.parse(items[index - 1].submittedAt) < Date.parse(item.submittedAt))
      || (job.approvedAt !== null && Date.parse(job.approvedAt) < Date.parse(item.submittedAt))) return null;
  }
  if (history.offset === 0 && job.latestSubmission && JSON.stringify(items[0]) !== JSON.stringify(job.latestSubmission)) return null;
  return { job, companyName: row.companyName, history: { offset: history.offset as number, items, hasMore: history.hasMore } };
}
