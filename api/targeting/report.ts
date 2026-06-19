import type { VercelRequest, VercelResponse } from "@vercel/node";
import { targetingAgentClient } from "../../lib/targeting-agent/client";
import { persistTargetingReportIfAvailable } from "../../lib/targeting-agent/persistence";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
      details: [],
    });
  }

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
