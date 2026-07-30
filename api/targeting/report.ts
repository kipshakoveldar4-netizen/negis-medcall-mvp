import type { VercelRequest, VercelResponse } from "@vercel/node";
import { targetingAgentClient } from "../../lib/targeting-agent/client";
import {
  campaignBelongsToWorkspace,
  persistTargetingReportIfAvailable,
} from "../../lib/targeting-agent/persistence";

import {
  authorizePrivateRoute,
  sendNotFound,
  type PrivateRouteAuthorization,
} from "../../lib/auth/route-guard";

// Security-2D: this ran without a token, read a campaign row and wrote a
// targeting_reports row on the service-role client.
//
// Security-2E: a token was not enough. The campaign id is caller-supplied, so
// it is checked against the verified workspace before the agent is asked for
// the report — an id from another clinic is a 404, indistinguishable from one
// that does not exist.
const AUTHORIZATION: PrivateRouteAuthorization = {
  kind: "browser",
  methods: ["GET"],
  permissions: { GET: "view_marketing" },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const context = await authorizePrivateRoute(req, res, AUTHORIZATION);
  if (!context) return;

  const campaignIdParam = req.query.campaignId;
  const campaignId = (
    Array.isArray(campaignIdParam) ? campaignIdParam[0] : campaignIdParam
  )?.trim();

  if (!campaignId) {
    return res.status(400).json({
      success: false,
      error: "Validation error",
      details: ["campaignId is required"],
    });
  }

  if (!(await campaignBelongsToWorkspace(campaignId, context.workspaceId))) {
    return sendNotFound(res);
  }

  const result = await targetingAgentClient.getCampaignReport(campaignId);
  await persistTargetingReportIfAvailable(campaignId, result.body);

  return res.status(result.status).json(result.body);
}
