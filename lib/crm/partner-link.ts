import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isUuidValue, requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { resolveSiteConsent } from "../site/consent-registry.cjs";
import { resolveSiteConsentReceipt } from "./site-intake-handler";
import { partnerEntryConfig } from "./partner-entry";
import { PARTNER_LINK_POLICY, parsePartnerLink } from "./partner-link-contracts";
import { parsePartnerTermsSnapshot } from "./partner-terms-contracts";

export async function handlePartnerLink(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const fail = (status: number, code: string) => res.status(status).json({ success: false, code });
  const actor = await requireAuthenticatedUser(req);
  if (req.method !== "GET") return fail(405, "method_not_allowed");
  if (Object.keys(req.query).some(k => !["path", "profileId"].includes(k)) || !isUuidValue(req.query.profileId)
    || (req.body != null && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length !== 0)))
    return fail(400, "invalid_partner_link_query");
  const config = partnerEntryConfig(process.env);
  const notice = config && resolveSiteConsentReceipt(config.consentVersion, resolveSiteConsent);
  if (!config || !notice || notice.purpose !== "partner_attribution") return fail(503, "partner_link_unavailable");
  const db = getSupabaseServerClient();
  if (!db) return fail(503, "partner_link_unconfirmed");
  try {
    const { data, error } = await db.rpc("read_growth_partner_terms", { p_actor: actor.id, p_side: "partner",
      p_profile: req.query.profileId, p_request: null, p_close: false, p_action: null });
    if (error) return fail(error.code === "P1141" ? 403 : 503, error.code === "P1141" ? "partner_link_access_denied" : "partner_link_unconfirmed");
    const snapshot = parsePartnerTermsSnapshot(data);
    if (!snapshot || snapshot.profileId.toLowerCase() !== String(req.query.profileId).toLowerCase()) return fail(503, "partner_link_unconfirmed");
    if (snapshot.state !== "managed" || snapshot.agreement.state !== "accepted" || snapshot.agreement.commercialStatus !== "active"
      || !snapshot.agreement.referralCode) return fail(409, "partner_link_not_active");
    const link = parsePartnerLink({ profileId: snapshot.profileId, profileRevision: snapshot.profileRevision,
      agreementRevision: snapshot.agreement.revision, referralCode: snapshot.agreement.referralCode,
      url: `${config.origin}/r/${snapshot.agreement.referralCode}`, policyVersion: PARTNER_LINK_POLICY });
    return link ? res.status(200).json({ success: true, data: link }) : fail(503, "partner_link_unconfirmed");
  } catch { return fail(503, "partner_link_unconfirmed"); }
}
