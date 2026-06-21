import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleCrmResource } from "../../lib/crm/server";

export default function handler(req: VercelRequest, res: VercelResponse) {
  return handleCrmResource("leads", req, res);
}
