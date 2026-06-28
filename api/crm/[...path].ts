import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleCrmHealth, handleCrmResource, type CrmResource } from "../../lib/crm/server";

const resources: CrmResource[] = [
  "clients",
  "leads",
  "appointments",
  "calls",
  "tasks",
  "chat",
  "staff",
  "content-videos",
  "admin-settings",
  "integration-statuses",
  "ai-providers",
  "meta-accounts",
  "release-checks",
];

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

function readPathSegment(req: VercelRequest): string {
  const pathParam = req.query.path;
  const querySegment = Array.isArray(pathParam) ? pathParam[0] : pathParam;

  if (typeof querySegment === "string" && querySegment.trim()) {
    return querySegment.trim();
  }

  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const [, segment] = pathname.split("/api/crm/");
  return (segment || "").split("/").filter(Boolean)[0] || "";
}

function isCrmResource(value: string): value is CrmResource {
  return resources.includes(value as CrmResource);
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  const resource = readPathSegment(req);

  if (resource === "health") {
    return handleCrmHealth(req, res);
  }

  if (!isCrmResource(resource)) {
    return sendJson(res, 404, {
      success: false,
      error: "Not found",
      details: ["Unknown CRM resource"],
    });
  }

  return handleCrmResource(resource, req, res);
}
