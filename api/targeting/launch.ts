import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  targetingAgentClient,
  validateRequiredFields,
  type LaunchCampaignPayload,
} from "../../lib/targeting-agent/client";
import { persistTargetingCampaignIfAvailable } from "../../lib/targeting-agent/persistence";

const requiredFields = ["clinicName", "campaignName", "city", "budget", "objective"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
      details: [],
    });
  }

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
  await persistTargetingCampaignIfAvailable(payload, result.body);

  return res.status(result.status).json(result.body);
}
