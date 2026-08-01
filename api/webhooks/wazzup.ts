import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleWazzupWebhook } from "../../lib/wazzup/webhook";

// Signed inbound webhook: Wazzup message events become CRM leads. All logic
// lives in lib/wazzup/webhook.ts where the tests can drive it; this file is
// only the Vercel entry point. Routed by the filesystem handler — plain api
// files are served without a vercel.json entry (verified against production:
// api/targeting/report.ts is not in the routes list and answers).
export const config = {
  api: {
    bodyParser: {
      // A message batch is a few kilobytes; anything approaching this limit is
      // not a webhook.
      sizeLimit: "1mb",
    },
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return handleWazzupWebhook(req, res);
}
