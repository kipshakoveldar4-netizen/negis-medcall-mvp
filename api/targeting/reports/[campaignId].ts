import type { VercelRequest, VercelResponse } from "@vercel/node";
import { targetingAgentClient } from "../../../lib/targeting-agent/client";
import { persistTargetingReportIfAvailable } from "../../../lib/targeting-agent/persistence";

import {
  authorizePrivateRoute,
  type PrivateRouteAuthorization,
} from "../../../lib/auth/route-guard";

// Security-2D: same contract as /api/targeting/report, addressed by path, and
// unauthenticated in exactly the same way.
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

  const result = await targetingAgentClient.getCampaignReport(campaignId);
  await persistTargetingReportIfAvailable(campaignId, result.body);

  return res.status(result.status).json(result.body);
}
