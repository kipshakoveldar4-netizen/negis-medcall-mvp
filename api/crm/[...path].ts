import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  handleAdCreativeMetaUpload,
  handleAdCreativeSignedUpload,
  handleAdCreativeUpload,
  handleAdsAiFill,
  handleCrmHealth,
  handleCrmResource,
  handleMetaLaunch,
  handleMetaStatus,
  handleMetaValidate,
  handleStorageHealth,
  type CrmResource,
} from "../../lib/crm/server";

export const config = {
  api: {
    bodyParser: false,
  },
};

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
  "meta-launches",
  "ad-creatives",
  "release-checks",
];

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function ensureParsedBody(req: VercelRequest) {
  if (req.body !== undefined || req.method === "GET" || req.method === "HEAD") return;

  const contentType = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) return;

  const rawBody = await readRawBody(req);
  if (rawBody.length === 0) return;

  if (contentType.includes("application/json")) {
    req.body = JSON.parse(rawBody.toString("utf8"));
    return;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(rawBody.toString("utf8"));
    const body: Record<string, string> = {};
    params.forEach((value, key) => {
      body[key] = value;
    });
    req.body = body;
  }
}

function readPathSegment(req: VercelRequest): string {
  return readPathSegments(req)[0] || "";
}

function readPathSegments(req: VercelRequest): string[] {
  const pathParam = req.query.path;
  if (Array.isArray(pathParam)) {
    return pathParam.map((segment) => segment.trim()).filter(Boolean);
  }

  const querySegment = pathParam;

  if (typeof querySegment === "string" && querySegment.trim()) {
    return querySegment.split("/").map((segment) => segment.trim()).filter(Boolean);
  }

  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const [, segment] = pathname.split("/api/crm/");
  return (segment || "").split("/").filter(Boolean);
}

function isCrmResource(value: string): value is CrmResource {
  return resources.includes(value as CrmResource);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureParsedBody(req);
  } catch {
    return sendJson(res, 400, {
      success: false,
      error: "Invalid request body",
      details: ["JSON body could not be parsed"],
    });
  }

  const pathSegments = readPathSegments(req);
  const resource = pathSegments[0] || "";

  if (resource === "health") {
    return handleCrmHealth(req, res);
  }

  if (resource === "meta-launch") {
    return handleMetaLaunch(req, res);
  }

  if (resource === "meta-status") {
    return handleMetaStatus(req, res);
  }

  if (resource === "meta-validate") {
    return handleMetaValidate(req, res);
  }

  if (resource === "storage-health") {
    return handleStorageHealth(req, res);
  }

  if (resource === "ad-creatives" && pathSegments[1] === "signed-upload") {
    return handleAdCreativeSignedUpload(req, res);
  }

  if (resource === "ad-creative-upload") {
    return handleAdCreativeUpload(req, res);
  }

  if (resource === "ad-creative-meta-upload") {
    return handleAdCreativeMetaUpload(req, res);
  }

  if (resource === "ads-ai-fill") {
    return handleAdsAiFill(req, res);
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
