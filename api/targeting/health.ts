import type { VercelRequest, VercelResponse } from "@vercel/node";
import { targetingAgentClient } from "../../lib/targeting-agent/client";

import {
  authorizePrivateRoute,
  type PrivateRouteAuthorization,
} from "../../lib/auth/route-guard";

// Security-2D: this ran without a token. Diagnostics stay at the same level
// as /api/crm/health — workspace administrators only.
const AUTHORIZATION: PrivateRouteAuthorization = {
  kind: "browser",
  methods: ["GET"],
  roles: ["owner", "admin"],
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const context = await authorizePrivateRoute(req, res, AUTHORIZATION);
  if (!context) return;

  const result = await targetingAgentClient.healthCheck();
  return res.status(result.status).json(result.body);
}
