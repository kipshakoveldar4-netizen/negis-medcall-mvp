import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";
import { readSiteJsonBody } from "./site-intake-handler";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxReceipts = 200;
const isTimestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value)
  && Number.isFinite(Date.parse(value));
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function readConfig(env: Record<string, string | undefined>) {
  const workspace = env.MEDINA_PUBLIC_SITE_WORKSPACE_ID?.trim();
  const siteKey = env.MEDINA_SITE_INTAKE_KEY?.trim();
  return workspace && uuid.test(workspace) && siteKey && /^[a-z0-9][a-z0-9-]{2,63}$/.test(siteKey)
    ? { workspace, siteKey } : null;
}
const linkedTables = [
  "deals", "tasks", "wazzup_inbound_messages", "whatsapp_cloud_inbound_messages",
  "growth_operator_lead_assignments", "growth_operator_bookings",
] as const;

// Inspection is not authorization to delete: SQL rechecks the version, exact
// receipt set and dependencies under lock after explicit confirmation.
export function createSiteInquiryDeletionPreviewHandler(
  env: () => Record<string, string | undefined> = () => process.env,
) {
  return async (req: VercelRequest, res: VercelResponse) => {
    res.setHeader("Cache-Control", "no-store");
    const fail = (status: number, code: string) => res.status(status).json({ success: false, code });
    const context = readWorkspaceContext(req);
    if (!context) return fail(401, "authentication_required");
    if (context.role !== "owner" && context.role !== "admin") return fail(403, "workspace_access_denied");
    if (req.method !== "GET") return fail(405, "method_not_allowed");
    const rawLeadId = req.query.leadId;
    if (typeof rawLeadId !== "string" || !uuid.test(rawLeadId)
      || Object.keys(req.query).some(key => !["path", "workspaceId", "leadId"].includes(key))) {
      return fail(400, "invalid_request");
    }
    const leadId = rawLeadId.toLowerCase();
    const config = readConfig(env());
    if (!config) return fail(503, "site_deletion_not_configured");
    const { workspace, siteKey } = config;
    if (context.workspaceId.toLowerCase() !== workspace.toLowerCase()) return fail(403, "workspace_access_denied");
    const client = getSupabaseServerClient();
    if (!client) return fail(503, "site_deletion_unavailable");
    try {
      // Disabling intake must not hide previously accepted inquiries from review.
      const site = await client.from("crm_intake_sites").select("id")
        .eq("workspace_id", context.workspaceId).eq("site_key", siteKey).maybeSingle();
      if (site.error) return fail(503, "site_deletion_unavailable");
      if (!site.data) return fail(503, "site_deletion_not_configured");
      const lead = await client.from("leads")
        .select("id,source,status,stage_id,campaign,client_id,responsible_user_id,meta_campaign_launch_id,updated_at")
        .eq("workspace_id", context.workspaceId).eq("id", leadId).maybeSingle();
      if (lead.error) return fail(503, "site_deletion_unavailable");
      if (!lead.data) return fail(404, "site_inquiry_not_found");
      if (!isTimestamp(lead.data.updated_at)) return fail(503, "site_deletion_unavailable");
      const receipts = await client.from("crm_site_inquiries").select("id", { count: "exact" })
        .eq("site_id", site.data.id).eq("lead_id", leadId).order("id").limit(maxReceipts);
      if (receipts.error || !Array.isArray(receipts.data) || typeof receipts.count !== "number") {
        return fail(503, "site_deletion_unavailable");
      }
      if (receipts.count === 0) return fail(404, "site_inquiry_not_found");
      if (receipts.count > maxReceipts || receipts.count !== receipts.data.length) {
        return fail(409, "site_deletion_scope_too_large");
      }
      const reviewReasons: string[] = [];
      if (lead.data.client_id) reviewReasons.push("linked_client");
      if (lead.data.responsible_user_id) reviewReasons.push("assigned_staff");
      if (lead.data.meta_campaign_launch_id) reviewReasons.push("linked_campaign");
      if (lead.data.source !== "website") reviewReasons.push("non_site_source");
      if (typeof lead.data.campaign === "string" && lead.data.campaign.trim()) reviewReasons.push("campaign_snapshot");
      if (lead.data.stage_id) {
        const stage = await client.from("lead_stages").select("semantic_group")
          .eq("workspace_id", context.workspaceId).eq("id", lead.data.stage_id).maybeSingle();
        if (stage.error) return fail(503, "site_deletion_unavailable");
        if (stage.data?.semantic_group !== "new") reviewReasons.push("progressed_stage");
      } else if (lead.data.status !== "new") reviewReasons.push("progressed_stage");
      // Return existence only: never fetch contacts, message bodies or the
      // contents of consent receipts. Missing dependency tables fail closed.
      for (const table of linkedTables) {
        const result = await client.from(table).select("lead_id")
          .eq("workspace_id", context.workspaceId).eq("lead_id", leadId).limit(1);
        if (result.error || !Array.isArray(result.data)) return fail(503, "site_deletion_unavailable");
        if (result.data.length) reviewReasons.push(table);
      }
      const audit = await client.from("audit_logs").select("id")
        .eq("workspace_id", context.workspaceId).eq("entity_type", "lead").ilike("entity_id", leadId).limit(1);
      if (audit.error || !Array.isArray(audit.data)) return fail(503, "site_deletion_unavailable");
      if (audit.data.length) reviewReasons.push("audit_history");
      const otherReceipts = await client.from("crm_site_inquiries").select("id")
        .eq("lead_id", leadId).neq("site_id", site.data.id).limit(1);
      if (otherReceipts.error || !Array.isArray(otherReceipts.data)) return fail(503, "site_deletion_unavailable");
      if (otherReceipts.data.length) reviewReasons.push("other_site_receipts");
      // Older deployments can still inspect scope before 062. A missing column
      // only disables confirmation; other read failures must not imply readiness.
      const permission = await client.from("crm_intake_sites").select("manual_deletion_enabled")
        .eq("workspace_id", context.workspaceId).eq("id", site.data.id).eq("site_key", siteKey).maybeSingle();
      const missingSchema = permission.error?.code === "42703" || permission.error?.code === "PGRST204";
      if (permission.error && !missingSchema) return fail(503, "site_deletion_unavailable");
      if (!missingSchema && typeof permission.data?.manual_deletion_enabled !== "boolean") {
        return fail(503, "site_deletion_unavailable");
      }
      const deletionAvailability = missingSchema ? "schema_not_ready"
        : permission.data?.manual_deletion_enabled !== true ? "disabled"
        : reviewReasons.length ? "review_required" : "confirmation_required";
      return res.status(200).json({ success: true, data: {
        leadId: lead.data.id,
        // Preserve PostgreSQL microseconds; Date.toISOString() would truncate them.
        leadUpdatedAt: lead.data.updated_at,
        receiptIds: receipts.data.map((receipt: { id: string }) => receipt.id),
        receiptCount: receipts.count,
        reviewRequired: reviewReasons.length > 0,
        reviewReasons,
        confirmationRequired: true,
        // This is permission to present confirmation, not a promise of erasure.
        // The RPC rechecks all dependencies, including future FKs, under lock.
        deletionEnabled: deletionAvailability === "confirmation_required",
        deletionAvailability,
      } });
    } catch { return fail(503, "site_deletion_unavailable"); }
  };
}

export const handleSiteInquiryDeletionPreview = createSiteInquiryDeletionPreviewHandler();

const deletionErrors: Record<string, number> = {
  invalid_deletion_request: 400,
  workspace_access_denied: 403,
  site_deletion_disabled: 409,
  site_inquiry_not_found: 404,
  deletion_request_conflict: 409,
  deletion_scope_changed: 409,
  deletion_requires_review: 409,
  deletion_operation_not_prepared: 409,
  deletion_operation_abandoned: 409,
  deletion_operation_pending: 409,
  deletion_operation_capacity: 409,
};

type DeletionInput = { leadId: string; receiptIds: string[]; leadUpdatedAt: string; requestKey: string; confirmed: true };
function deletionInput(value: unknown): DeletionInput | null {
  const body = record(value);
  if (!body || Object.keys(body).some(key => !["leadId", "receiptIds", "leadUpdatedAt", "requestKey", "confirmed"].includes(key))) return null;
  const { leadId, receiptIds, leadUpdatedAt, requestKey, confirmed } = body;
  if (confirmed !== true || typeof leadId !== "string" || !uuid.test(leadId)
    || typeof requestKey !== "string" || !uuid.test(requestKey) || !isTimestamp(leadUpdatedAt)
    || !Array.isArray(receiptIds) || receiptIds.length < 1 || receiptIds.length > maxReceipts
    || !receiptIds.every((value): value is string => typeof value === "string" && uuid.test(value))
    || new Set(receiptIds.map(value => value.toLowerCase())).size !== receiptIds.length) return null;
  return { leadId, receiptIds, leadUpdatedAt, requestKey, confirmed };
}

function operationReceipt(value: unknown, workspaceId: string, actorId: string) {
  const row = record(value), request = deletionInput(row?.request);
  if (!row || !request || row.workspaceId !== workspaceId.toLowerCase() || row.actorId !== actorId.toLowerCase()
    || row.requestKey !== request.requestKey.toLowerCase() || row.leadId !== request.leadId.toLowerCase()
    || typeof row.replayed !== "boolean" || !isTimestamp(row.createdAt)
    || (row.completedAt !== null && !isTimestamp(row.completedAt))
    || (row.acknowledgedAt !== null && !isTimestamp(row.acknowledgedAt))) return null;
  const { state, completedAt, acknowledgedAt, receiptsDeleted } = row;
  if (!(state === "prepared" && completedAt === null && acknowledgedAt === null && receiptsDeleted === null)
    && !(state === "committed" && completedAt !== null && receiptsDeleted === request.receiptIds.length)
    && !(state === "abandoned" && completedAt !== null && receiptsDeleted === null)) return null;
  return { workspaceId: row.workspaceId, actorId: row.actorId, requestKey: row.requestKey, leadId: row.leadId,
    request, state, createdAt: row.createdAt, completedAt, acknowledgedAt, receiptsDeleted, replayed: row.replayed };
}

export function createSiteDeletionOperationsHandler(env: () => Record<string, string | undefined> = () => process.env) {
  return async (req: VercelRequest, res: VercelResponse) => {
    res.setHeader("Cache-Control", "no-store");
    const fail = (status: number, code: string) => res.status(status).json({ success: false, code });
    const context = readWorkspaceContext(req);
    if (!context) return fail(401, "authentication_required");
    if ((context.role !== "owner" && context.role !== "admin") || !uuid.test(context.userId) || !uuid.test(context.staffUserId)) return fail(403, "workspace_access_denied");
    if (req.method !== "GET" && req.method !== "POST") return fail(405, "method_not_allowed");
    if (typeof req.query.workspaceId !== "string" || req.query.workspaceId.toLowerCase() !== context.workspaceId.toLowerCase()
      || Object.keys(req.query).some(key => !["path", "workspaceId", ...(req.method === "GET" ? ["requestKey"] : [])].includes(key))
      || (req.query.requestKey !== undefined && (typeof req.query.requestKey !== "string" || !uuid.test(req.query.requestKey)))) return fail(400, "invalid_request");
    const config = readConfig(env());
    if (!config) return fail(503, "site_deletion_not_configured");
    if (config.workspace.toLowerCase() !== context.workspaceId.toLowerCase()) return fail(403, "workspace_access_denied");
    const client = getSupabaseServerClient();
    if (!client) return fail(503, "site_deletion_unavailable");
    const args = { p_workspace: context.workspaceId, p_site_key: config.siteKey, p_staff: context.staffUserId, p_actor: context.userId };
    try {
      if (req.method === "GET") {
        const { data, error } = await client.rpc("read_site_deletion_operations", { ...args, p_request_key: req.query.requestKey ?? null });
        if (error) {
          const code = typeof error.message === "string" && Object.hasOwn(deletionErrors, error.message) ? error.message : "site_deletion_unavailable";
          return fail(deletionErrors[code] ?? 503, code);
        }
        const result = record(data);
        if (result?.complete !== true || typeof result.deletionEnabled !== "boolean" || !Array.isArray(result.operations) || result.operations.length > 64) return fail(503, "site_deletion_unavailable");
        const operations = result.operations.map(value => operationReceipt(value, context.workspaceId, context.userId));
        if (operations.some(value => !value) || new Set(operations.map(value => value?.requestKey)).size !== operations.length
          || (req.query.requestKey && operations.some(value => value?.requestKey !== (req.query.requestKey as string).toLowerCase()))
          || (!req.query.requestKey && operations.some(value => value?.acknowledgedAt !== null))) return fail(503, "site_deletion_unavailable");
        return res.status(200).json({ success: true, data: { operations, complete: true, deletionEnabled: result.deletionEnabled } });
      }
      if (typeof req.headers["content-type"] !== "string" || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"])) return fail(415, "invalid_content_type");
      let body: Record<string, unknown> | null;
      try { body = record(await readSiteJsonBody(req)); } catch { return fail(400, "invalid_request"); }
      if (!body) return fail(400, "invalid_request");
      let name: string, parameters: Record<string, unknown>, expectedKey: string;
      if (body.action === "prepare") {
        const request = deletionInput(body.request);
        if (!request || Object.keys(body).some(key => !["action", "request"].includes(key))) return fail(400, "invalid_request");
        name = "prepare_site_deletion_operation"; parameters = { ...args, p_request: request }; expectedKey = request.requestKey;
      } else {
        if ((body.action !== "abandon" && body.action !== "acknowledge") || typeof body.requestKey !== "string" || !uuid.test(body.requestKey)
          || Object.keys(body).some(key => !["action", "requestKey"].includes(key))) return fail(400, "invalid_request");
        name = "close_site_deletion_operation"; parameters = { ...args, p_request_key: body.requestKey, p_action: body.action }; expectedKey = body.requestKey;
      }
      const { data, error } = await client.rpc(name, parameters);
      if (error) {
        const code = typeof error.message === "string" && Object.hasOwn(deletionErrors, error.message) ? error.message : "site_deletion_unavailable";
        return fail(deletionErrors[code] ?? 503, code);
      }
      const operation = operationReceipt(data, context.workspaceId, context.userId);
      if (!operation || operation.requestKey !== expectedKey.toLowerCase()) return fail(503, "site_deletion_unavailable");
      if (body.action === "prepare" && JSON.stringify(operation.request) !== JSON.stringify(deletionInput(body.request))) return fail(503, "site_deletion_unavailable");
      return res.status(200).json({ success: true, data: { operation } });
    } catch { return fail(503, "site_deletion_unavailable"); }
  };
}

export const handleSiteDeletionOperations = createSiteDeletionOperationsHandler();

export function createSiteInquiryDeletionHandler(
  env: () => Record<string, string | undefined> = () => process.env,
) {
  return async (req: VercelRequest, res: VercelResponse) => {
    res.setHeader("Cache-Control", "no-store");
    const fail = (status: number, code: string) => res.status(status).json({ success: false, code });
    const context = readWorkspaceContext(req);
    if (!context) return fail(401, "authentication_required");
    if (context.role !== "owner" && context.role !== "admin") return fail(403, "workspace_access_denied");
    if (req.method !== "POST") return fail(405, "method_not_allowed");
    if (Object.keys(req.query).some(key => !["path", "workspaceId"].includes(key))
      || typeof req.query.workspaceId !== "string" || !uuid.test(req.query.workspaceId)
      || req.query.workspaceId.toLowerCase() !== context.workspaceId.toLowerCase()) return fail(400, "invalid_request");
    const config = readConfig(env());
    if (!config) return fail(503, "site_deletion_not_configured");
    if (config.workspace.toLowerCase() !== context.workspaceId.toLowerCase()) return fail(403, "workspace_access_denied");
    if (!uuid.test(context.userId) || !uuid.test(context.staffUserId)) return fail(403, "workspace_access_denied");
    if (typeof req.headers["content-type"] !== "string"
      || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"])) return fail(415, "invalid_content_type");
    let body: Record<string, unknown> | null;
    try { body = record(await readSiteJsonBody(req)); } catch { return fail(400, "invalid_request"); }
    if (!body || Object.keys(body).some(key => !["leadId", "receiptIds", "leadUpdatedAt", "requestKey", "confirmed"].includes(key))) {
      return fail(400, "invalid_request");
    }
    const { leadId, receiptIds, leadUpdatedAt, requestKey, confirmed } = body;
    if (confirmed !== true || typeof leadId !== "string" || !uuid.test(leadId)
      || typeof requestKey !== "string" || !uuid.test(requestKey) || !isTimestamp(leadUpdatedAt)
      || !Array.isArray(receiptIds) || receiptIds.length < 1 || receiptIds.length > maxReceipts
      || !receiptIds.every((value): value is string => typeof value === "string" && uuid.test(value))
      || new Set(receiptIds.map(value => value.toLowerCase())).size !== receiptIds.length) {
      return fail(400, "invalid_request");
    }
    const client = getSupabaseServerClient();
    if (!client) return fail(503, "site_deletion_unavailable");
    try {
      // Never delete via separate table writes. RPC gates on the site's explicit
      // opt-in, rechecks the verified actor, and provides atomic, retry-safe erasure.
      const { data, error } = await client.rpc("execute_site_deletion_operation", {
        p_workspace: context.workspaceId, p_site_key: config.siteKey,
        p_staff: context.staffUserId, p_actor: context.userId,
        p_request: { leadId, receiptIds, leadUpdatedAt, requestKey, confirmed: true },
      });
      if (error) {
        const code = typeof error.message === "string" && Object.hasOwn(deletionErrors, error.message)
          ? error.message : "site_deletion_unavailable";
        return fail(deletionErrors[code] ?? 503, code);
      }
      const result = operationReceipt(data, context.workspaceId, context.userId);
      const expectedRequest = { leadId, receiptIds, leadUpdatedAt, requestKey, confirmed: true };
      if (result?.state !== "committed" || result.receiptsDeleted !== receiptIds.length
        || JSON.stringify(result.request) !== JSON.stringify(expectedRequest)) return fail(503, "site_deletion_unavailable");
      return res.status(200).json({ success: true, data: {
        deleted: true, receiptsDeleted: result.receiptsDeleted, replayed: result.replayed,
      } });
    } catch { return fail(503, "site_deletion_unavailable"); }
  };
}

export const handleSiteInquiryDeletion = createSiteInquiryDeletionHandler();
