import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxReceipts = 200;
const linkedTables = [
  "deals", "tasks", "wazzup_inbound_messages", "whatsapp_cloud_inbound_messages",
  "growth_operator_lead_assignments", "growth_operator_bookings",
] as const;

// This is an inspection, never an authorization to delete. A future atomic
// executor must recheck scope and dependencies after explicit confirmation.
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
    const config = env();
    const workspace = config.MEDINA_PUBLIC_SITE_WORKSPACE_ID?.trim();
    const siteKey = config.MEDINA_SITE_INTAKE_KEY?.trim();
    if (!workspace || !uuid.test(workspace) || !siteKey || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(siteKey)) {
      return fail(503, "site_deletion_not_configured");
    }
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
        .select("id,client_id,responsible_user_id,meta_campaign_launch_id")
        .eq("workspace_id", context.workspaceId).eq("id", leadId).maybeSingle();
      if (lead.error) return fail(503, "site_deletion_unavailable");
      if (!lead.data) return fail(404, "site_inquiry_not_found");
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
      // Return existence only: never fetch contacts, message bodies or the
      // contents of consent receipts. Missing dependency tables fail closed.
      for (const table of linkedTables) {
        const result = await client.from(table).select("lead_id")
          .eq("workspace_id", context.workspaceId).eq("lead_id", leadId).limit(1);
        if (result.error || !Array.isArray(result.data)) return fail(503, "site_deletion_unavailable");
        if (result.data.length) reviewReasons.push(table);
      }
      const audit = await client.from("audit_logs").select("id")
        .eq("workspace_id", context.workspaceId).eq("entity_type", "lead").eq("entity_id", leadId).limit(1);
      if (audit.error || !Array.isArray(audit.data)) return fail(503, "site_deletion_unavailable");
      if (audit.data.length) reviewReasons.push("audit_history");
      const otherReceipts = await client.from("crm_site_inquiries").select("id")
        .eq("lead_id", leadId).neq("site_id", site.data.id).limit(1);
      if (otherReceipts.error || !Array.isArray(otherReceipts.data)) return fail(503, "site_deletion_unavailable");
      if (otherReceipts.data.length) reviewReasons.push("other_site_receipts");
      return res.status(200).json({ success: true, data: {
        leadId: lead.data.id,
        receiptIds: receipts.data.map((receipt: { id: string }) => receipt.id),
        receiptCount: receipts.count,
        reviewRequired: reviewReasons.length > 0,
        reviewReasons,
        confirmationRequired: true,
        deletionEnabled: false,
      } });
    } catch { return fail(503, "site_deletion_unavailable"); }
  };
}

export const handleSiteInquiryDeletionPreview = createSiteInquiryDeletionPreviewHandler();
