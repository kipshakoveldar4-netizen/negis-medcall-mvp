import type { VercelRequest, VercelResponse } from "@vercel/node";

// Security-2A — legacy lead intake webhook, permanently disabled.
//
// The previous implementation created a service-role Supabase client at module
// load and inserted straight into `leads` with a caller-supplied path segment as
// the tenant, without any signature. It could not have worked: it wrote columns
// that the applied schema does not have, so every call failed after the write
// was attempted. Audited before disabling: no caller anywhere in the repository,
// the frontend never references it, and artifacts/api-server (which carries the
// same dead shape) is not referenced by vercel.json, railway.json or the root
// package.json.
//
// The route mapping in vercel.json is deliberately left untouched, so this file
// stays the terminating handler for the path instead of falling through to a
// framework default.
//
// Nothing here reads SUPABASE_SERVICE_ROLE_KEY, constructs a database client, or
// parses the request body: bodyParser is off so submitted fields are never even
// materialised. Every method and every clinic id gets one identical response, so
// the endpoint discloses no schema, no failure reason, and no clinic existence.

export const config = {
  api: {
    bodyParser: false,
  },
};

const DISABLED_RESPONSE = {
  success: false,
  error: "This integration endpoint is no longer available",
  code: "legacy_webhook_disabled",
} as const;

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(410).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(DISABLED_RESPONSE);
}
