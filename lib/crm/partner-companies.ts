import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthenticatedUser } from "../auth/server";
import { readPlatformOwner } from "../auth/platform";
import { readApplicationOrigin } from "../auth/application-origin";
import { isSyntheticEmail } from "../auth/staff-logins";
import { getSupabaseServerClient } from "../supabase/server";
import { resolveSiteConsent } from "../site/consent-registry.cjs";
import { resolveSiteConsentReceipt } from "./site-intake-handler";
import { partnerEntryConfig, readPartnerEntryBody, PartnerEntryBodyLimitError } from "./partner-entry";
import { partnerCapabilityHash, readPartnerEntryCookie, PARTNER_POLICY_VERSION, PARTNER_WINDOW_MS } from "./partner-entry-cookie";
import { parsePartnerCompany, parsePartnerCompanyApplication, parsePartnerCompanyContext, parsePartnerCompanyPage,
  parsePartnerCompanyReceipt, parsePartnerCompanyReviewCommand, parsePartnerCompanyReviewReceipt } from "./partner-company-contracts";

type Row = Record<string, unknown>;
const object = (v: unknown): Row | null => v && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
const keys = (v: Row, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const emptyBody = (req: VercelRequest) => req.body == null || !!object(req.body) && Object.keys(req.body).length === 0;
function headers(res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", "noindex, nofollow"); res.setHeader("X-Content-Type-Options", "nosniff");
}
const fail = (res: VercelResponse, status: number, code: string) => res.status(status).json({ success: false, code });
function failedRpc(res: VercelResponse, code?: string) {
  if (code === "P1133") return fail(res, 410, "partner_entry_expired");
  if (["P1211", "P1121"].includes(code ?? "")) return fail(res, 403, "partner_company_access_denied");
  if (["P1213", "P1253"].includes(code ?? "")) return fail(res, 409, "partner_company_changed");
  return fail(res, 503, "partner_company_unconfirmed");
}
const unconfirmed = (res: VercelResponse) => fail(res, 503, "partner_company_unconfirmed");
function noticeConfig() {
  const config = partnerEntryConfig(process.env), version = process.env.MEDINA_PARTNER_COMPANY_CONSENT_VERSION ?? "";
  if (!config || process.env.MEDINA_PARTNER_COMPANY_ENABLED !== "true" || !/^[A-Za-z0-9._-]{1,40}$/.test(version)) return null;
  const attribution = resolveSiteConsentReceipt(config.consentVersion, resolveSiteConsent), notice = resolveSiteConsentReceipt(version, resolveSiteConsent);
  return attribution?.purpose === "partner_attribution" && notice?.purpose === "partner_company_registration" ? { config, attribution, notice } : null;
}

/** Same Path as the sealed entry cookie; the capability never reaches JavaScript. */
export async function handlePartnerCompanyEntry(req: VercelRequest, res: VercelResponse) {
  headers(res);
  const actor = await requireAuthenticatedUser(req);
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
  const op = req.query.op;
  if (Object.keys(req.query).some(k => !["path", "op"].includes(k)) || (op !== "context" && op !== "submit"))
    return fail(res, 400, "invalid_partner_company_query");
  const approved = noticeConfig();
  if (!approved) return fail(res, 503, "partner_company_registration_unavailable");
  const { config, attribution, notice } = approved;
  if (req.headers.origin !== config.origin) return fail(res, 403, "origin_denied");
  if (!actor.emailConfirmed || !actor.email || actor.email.length > 254 || isSyntheticEmail(actor.email)
    || /[\u0000-\u001f\u007f]/.test(actor.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor.email))
    return fail(res, 403, "partner_company_confirmed_email_required");
  let body: Row | null;
  try { body = await readPartnerEntryBody(req); } catch (error) {
    return fail(res, error instanceof PartnerEntryBodyLimitError ? 413 : 400,
      error instanceof PartnerEntryBodyLimitError ? "request_body_too_large" : "invalid_partner_company_request");
  }
  if (!body || !keys(body, op === "context" ? [] : ["requestId", "company", "consent", "consentVersion"]))
    return fail(res, 400, "invalid_partner_company_request");
  const company = op === "submit" ? parsePartnerCompany(body.company) : null;
  if (op === "submit" && (!company || !uuid(body.requestId) || body.consent !== true || body.consentVersion !== notice.version))
    return fail(res, 400, "invalid_partner_company_request");
  const cookie = readPartnerEntryCookie(req.headers.cookie, config.origin, config.key, Date.now());
  if (cookie.state === "expired") return fail(res, 410, "partner_entry_expired");
  if (cookie.state !== "valid") return fail(res, 409, "partner_entry_not_prepared");
  const frame = cookie.frame, expiresAt = new Date(Date.parse(frame.startedAt) + PARTNER_WINDOW_MS).toISOString();
  if (frame.consentVersion !== attribution.version || frame.consentHash !== attribution.sha256) return fail(res, 409, "partner_notice_changed");
  const db = getSupabaseServerClient(); if (!db) return unconfirmed(res);
  try {
    if (op === "context") {
      const { data, error } = await db.rpc("claim_growth_partner_source", { p_actor: actor.id, p_intent: frame.id, p_capability_hash: partnerCapabilityHash(frame) });
      if (error) return failedRpc(res, error.code);
      const source = object(data);
      if (!source || !keys(source, ["id", "capturedAt", "expiresAt", "policyVersion", "state", "source", "workspaceId"])
        || source.id !== frame.id || source.state !== "captured" || source.workspaceId !== null || source.source !== frame.source
        || source.policyVersion !== PARTNER_POLICY_VERSION || typeof source.capturedAt !== "string" || typeof source.expiresAt !== "string"
        || source.capturedAt.replace(/(\.\d{3})000Z$/, "$1Z") !== frame.startedAt
        || source.expiresAt.replace(/(\.\d{3})000Z$/, "$1Z") !== expiresAt) return unconfirmed(res);
      const context = parsePartnerCompanyContext({ sourceId: frame.id, expiresAt, notice, applicantEmail: actor.email });
      return context ? res.status(200).json({ success: true, data: context }) : unconfirmed(res);
    }
    const { data, error } = await db.rpc("submit_growth_partner_company", { p_actor: actor.id, p_source: frame.id,
      p_capability_hash: partnerCapabilityHash(frame), p_request: body.requestId, p_company: company, p_email: actor.email, p_consent: notice });
    if (error) return failedRpc(res, error.code);
    const application = parsePartnerCompanyApplication(data), receipt = parsePartnerCompanyReceipt({ state: "committed", requestId: body.requestId, sourceId: frame.id, application });
    if (!application || !receipt || JSON.stringify(application.company) !== JSON.stringify(company)
      || new Date(application.expiresAt).toISOString() !== expiresAt) return unconfirmed(res);
    return res.status(200).json({ success: true, data: receipt });
  } catch { return unconfirmed(res); }
}

/** Recovery intentionally survives cookie expiry, changed notices and disabled intake. */
export async function handlePartnerCompanyRecovery(req: VercelRequest, res: VercelResponse) {
  headers(res);
  const actor = await requireAuthenticatedUser(req);
  if (req.method === "GET" && req.query.view === "workspace") {
    const { applicationId, revision } = req.query;
    if (Object.keys(req.query).some(k => !["path", "view", "applicationId", "revision"].includes(k)) || !emptyBody(req)
      || !uuid(applicationId) || !uuid(revision)) return fail(res, 400, "invalid_partner_company_query");
    const db = getSupabaseServerClient(); if (!db) return unconfirmed(res);
    try {
      const { data, error } = await db.rpc("read_growth_partner_company", { p_actor: actor.id, p_application: applicationId });
      if (error) return ["P1211", "P1121"].includes(error.code ?? "")
        ? fail(res, 403, "partner_company_access_denied") : unconfirmed(res);
      const application = parsePartnerCompanyApplication(data);
      if (!application || !same(application.id, applicationId)) return unconfirmed(res);
      if (application.state !== "approved" || !same(application.revision, revision))
        return fail(res, 409, "partner_company_changed");
      return res.status(200).json({ success: true, data: application });
    } catch { return unconfirmed(res); }
  }
  if (req.method === "GET" && req.query.view !== undefined) {
    const rawOffset = req.query.offset ?? "0", state = req.query.state ?? null;
    if (req.query.view !== "list" || Object.keys(req.query).some(k => !["path", "view", "offset", "state"].includes(k)) || !emptyBody(req)
      || typeof rawOffset !== "string" || !/^(?:0|[1-9]\d{0,6})$/.test(rawOffset) || Number(rawOffset) > 1000000
      || (state !== null && state !== "pending" && state !== "approved" && state !== "rejected")) return fail(res, 400, "invalid_partner_company_query");
    const db = getSupabaseServerClient(); if (!db) return unconfirmed(res);
    try {
      const { data, error } = await db.rpc("list_own_growth_partner_companies", { p_actor: actor.id, p_offset: Number(rawOffset), p_state: state });
      if (error) return ["P1211", "P1121"].includes(error.code ?? "")
        ? fail(res, 403, "partner_company_access_denied") : unconfirmed(res);
      const page = parsePartnerCompanyPage(data, { offset: Number(rawOffset), state });
      return page ? res.status(200).json({ success: true, data: page }) : unconfirmed(res);
    } catch { return unconfirmed(res); }
  }
  let requestId: unknown, sourceId: unknown;
  const close = req.method === "POST";
  if (req.method === "GET") {
    if (Object.keys(req.query).some(k => !["path", "requestId", "sourceId"].includes(k)) || !emptyBody(req)) return fail(res, 400, "invalid_partner_company_query");
    ({ requestId, sourceId } = req.query);
  } else if (close) {
    const origin = readApplicationOrigin();
    if (!origin || req.headers.origin !== origin) return fail(res, 403, "origin_denied");
    const v = object(req.body);
    if (Object.keys(req.query).some(k => k !== "path") || !v || !keys(v, ["operation", "requestId", "sourceId"]) || v.operation !== "close")
      return fail(res, 400, "invalid_partner_company_request");
    ({ requestId, sourceId } = v);
  } else return fail(res, 405, "method_not_allowed");
  if (!uuid(requestId) || !uuid(sourceId)) return fail(res, 400, "invalid_partner_company_request");
  const db = getSupabaseServerClient(); if (!db) return unconfirmed(res);
  try {
    const { data, error } = await db.rpc("read_growth_partner_company_submission", { p_actor: actor.id, p_source: sourceId, p_request: requestId, p_close: close });
    if (error) return failedRpc(res, error.code);
    const receipt = parsePartnerCompanyReceipt(data);
    if (!receipt || !same(receipt.requestId, requestId) || !same(receipt.sourceId, sourceId) || (close && receipt.state === "unconfirmed")) return unconfirmed(res);
    return res.status(200).json({ success: true, data: receipt });
  } catch { return unconfirmed(res); }
}

export async function handlePlatformPartnerCompanies(req: VercelRequest, res: VercelResponse) {
  headers(res);
  const owner = readPlatformOwner(req);
  if (!owner) return fail(res, 404, "not_found");
  const db = getSupabaseServerClient(); if (!db) return unconfirmed(res);
  try {
    if (req.method === "GET" && req.query.requestId === undefined && req.query.applicationId === undefined && req.query.revision === undefined && req.query.action === undefined) {
      const rawOffset = req.query.offset ?? "0", state = req.query.state ?? null;
      if (Object.keys(req.query).some(k => !["path", "offset", "state"].includes(k)) || !emptyBody(req)
        || typeof rawOffset !== "string" || !/^(?:0|[1-9]\d{0,6})$/.test(rawOffset) || Number(rawOffset) > 1000000
        || (state !== null && state !== "pending" && state !== "approved" && state !== "rejected")) return fail(res, 400, "invalid_partner_company_query");
      const { data, error } = await db.rpc("list_growth_partner_companies", { p_owner: owner.userId, p_offset: Number(rawOffset), p_state: state });
      if (error) return failedRpc(res, error.code);
      const page = parsePartnerCompanyPage(data, { offset: Number(rawOffset), state });
      return page ? res.status(200).json({ success: true, data: page }) : unconfirmed(res);
    }
    let command: ReturnType<typeof parsePartnerCompanyReviewCommand> = null, close = false;
    if (req.method === "GET") {
      if (Object.keys(req.query).some(k => !["path", "requestId", "applicationId", "revision", "action"].includes(k)) || !emptyBody(req)) return fail(res, 400, "invalid_partner_company_query");
      command = parsePartnerCompanyReviewCommand({ requestId: req.query.requestId, applicationId: req.query.applicationId, revision: req.query.revision, action: req.query.action });
    } else if (req.method === "POST") {
      if (Object.keys(req.query).some(k => k !== "path")) return fail(res, 400, "invalid_partner_company_query");
      const v = object(req.body); close = v?.operation === "close";
      if (close && (!v || !keys(v, ["operation", "requestId", "applicationId", "revision", "action"]))) return fail(res, 400, "invalid_partner_company_request");
      command = close ? parsePartnerCompanyReviewCommand({ requestId: v!.requestId, applicationId: v!.applicationId, revision: v!.revision, action: v!.action }) : parsePartnerCompanyReviewCommand(v);
    } else return fail(res, 405, "method_not_allowed");
    if (!command) return fail(res, 400, "invalid_partner_company_request");
    const args = { p_owner: owner.userId, p_application: command.applicationId, p_revision: command.revision, p_request: command.requestId, p_action: command.action };
    const write = req.method === "POST" && !close;
    const { data, error } = await db.rpc(write ? "review_growth_partner_company" : "read_growth_partner_company_review", write ? args : { ...args, p_close: close });
    if (error) return failedRpc(res, error.code);
    const receipt = parsePartnerCompanyReviewReceipt(write ? { ...command, state: "committed", application: data } : data);
    if (!receipt || !same(receipt.requestId, command.requestId) || !same(receipt.applicationId, command.applicationId)
      || !same(receipt.revision, command.revision) || receipt.action !== command.action || ((write || close) && receipt.state === "unconfirmed")) return unconfirmed(res);
    return res.status(200).json({ success: true, data: receipt });
  } catch { return unconfirmed(res); }
}
