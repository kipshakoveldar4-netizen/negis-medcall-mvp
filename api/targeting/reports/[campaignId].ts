import type { VercelRequest, VercelResponse } from "@vercel/node";
import { targetingAgentClient } from "../../../lib/targeting-agent/client";
import {
  campaignBelongsToWorkspace,
  persistTargetingReportIfAvailable,
} from "../../../lib/targeting-agent/persistence";

import {
  authorizePrivateRoute,
  sendNotFound,
  type PrivateRouteAuthorization,
} from "../../../lib/auth/route-guard";

// Security-2D: same contract as /api/targeting/report, addressed by path, and
// unauthenticated in exactly the same way.
//
// Security-2E: and tenant-unaware in exactly the same way, so it carries the
// same campaign ownership check. Two spellings of one route must not have two
// authorization stories.
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
