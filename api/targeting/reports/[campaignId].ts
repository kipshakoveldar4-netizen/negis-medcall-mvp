import type { VercelRequest, VercelResponse } from "@vercel/node";
import { targetingAgentClient } from "../../../lib/targeting-agent/client";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
      details: [],
    });
  }

  const campaignId = Array.isArray(req.query.campaignId)
    ? req.query.campaignId[0]
    : req.query.campaignId;

  if (!campaignId) {
    return res.status(400).json({
      success: false,
      error: "Validation error",
      details: ["campaignId is required"],
    });
  }

  const result = await targetingAgentClient.getCampaignReport(campaignId);
  return res.status(result.status).json(result.body);
}
