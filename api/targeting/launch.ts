import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  targetingAgentClient,
  validateRequiredFields,
  type LaunchCampaignPayload,
} from "../../lib/targeting-agent/client";
import { persistTargetingCampaignIfAvailable } from "../../lib/targeting-agent/persistence";

import {
  authorizePrivateRoute,
  type PrivateRouteAuthorization,
} from "../../lib/auth/route-guard";

// Security-2D: this ran without a token and wrote a targeting_campaigns row on
// the service-role client, with the workspace taken from the request body.
const AUTHORIZATION: PrivateRouteAuthorization = {
  kind: "browser",
  methods: ["POST"],
  permissions: { POST: "manage_marketing" },
};

const requiredFields = ["clinicName", "campaignName", "city", "budget", "objective"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const context = await authorizePrivateRoute(req, res, AUTHORIZATION);
  if (!context) return;

  const details = validateRequiredFields(req.body, requiredFields);
  if (details.length > 0) {
    return res.status(400).json({
      success: false,
      error: "Validation error",
      details,
    });
  }

  const payload = req.body as LaunchCampaignPayload;
  const result = await targetingAgentClient.launchCampaign(payload);
  await persistTargetingCampaignIfAvailable(payload, result.body, context.workspaceId);

  return res.status(result.status).json(result.body);
}
