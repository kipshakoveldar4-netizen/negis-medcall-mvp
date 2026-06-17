import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  targetingAgentClient,
  validateRequiredFields,
  type AnalyzeCreativePayload,
} from "../../lib/targeting-agent/client";

const requiredFields = ["clinicName", "niche", "city", "offer", "creativeText"];

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

  const result = await targetingAgentClient.analyzeCreative(req.body as AnalyzeCreativePayload);
  return res.status(result.status).json(result.body);
}
