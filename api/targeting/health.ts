import type { VercelRequest, VercelResponse } from "@vercel/node";
import { targetingAgentClient } from "../../lib/targeting-agent/client";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
      details: [],
    });
  }

  const result = await targetingAgentClient.healthCheck();
  return res.status(result.status).json(result.body);
}
