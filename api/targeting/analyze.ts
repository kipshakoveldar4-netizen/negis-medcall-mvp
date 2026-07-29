import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  targetingAgentClient,
  validateRequiredFields,
  type AnalyzeCreativePayload,
} from "../../lib/targeting-agent/client";

import {
  authorizePrivateRoute,
  type PrivateRouteAuthorization,
} from "../../lib/auth/route-guard";

// Security-2D: this ran without a token, spending the targeting agent's budget
// for whoever called it.
const AUTHORIZATION: PrivateRouteAuthorization = {
  kind: "browser",
  methods: ["POST"],
  permissions: { POST: "manage_marketing" },
};

const requiredFields = ["clinicName", "niche", "city", "offer", "creativeText"];

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

  const result = await targetingAgentClient.analyzeCreative(req.body as AnalyzeCreativePayload);
  return res.status(result.status).json(result.body);
}
