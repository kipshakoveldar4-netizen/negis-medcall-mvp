import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  handleAdCreativeMetaUpload,
  handleAdCreativeSignedUpload,
  handleAdCreativeUpload,
  handleAdsAiFill,
  handleCrmAuthContext,
  handleCrmHealth,
  handleCrmResource,
  handleMetaCityKey,
  handleMetaCampaignInsights,
  handleMetaInsightsBackgroundCycle,
  handleMetaInsightsHistory,
  handleMetaInsightsSync,
  handleMetaInsightsSyncRuns,
  handleMetaLaunch,
  handleMetaStatus,
  handleMetaValidate,
  handleStorageHealth,
  handleTikTokDryRun,
  handleTikTokSetup,
  handleTikTokValidate,
  handleVideoJobs,
  handleVideoProcessingJobs,
  attachWorkspaceContext,
  type CrmResource,
  readWorkspaceContext,
} from "../../lib/crm/server";
import { normalizeCrmSegments, resolveCrmRoute } from "../../lib/crm/authorization";
import { handleStaffInvitationAccept, handleStaffInvitations } from "../../lib/crm/staff-invitations";
import { handleStaffCredentials } from "../../lib/crm/staff-credentials";
import { handleJoinCode, handleJoinRequest, handleStaffJoinRequests } from "../../lib/crm/staff-join-requests";
import { handlePlatformWhatsappNumber } from "../../lib/crm/platform-whatsapp";
import { handleWhatsAppChannels } from "../../lib/crm/whatsapp-channels";
import { handleCrmChangeLog } from "../../lib/crm/change-log";
import { handleMyClients } from "../../lib/crm/my-clients";
import { handlePushSubscriptions } from "../../lib/crm/push-subscriptions";
import { handleSalonStats } from "../../lib/crm/salon-stats";
import {
  requireAuthenticatedUser,
  requireWorkspaceAccess,
  WorkspaceAdminAuthError,
} from "../../lib/auth/server";
import { attachPlatformOwner, PlatformAuthError, requirePlatformOwner } from "../../lib/auth/platform";
import { handlePlatformRecommendations, handleWorkspaceRecommendations } from "../../lib/crm/recommendations";
import { applyControlCors } from "../../lib/auth/cors";
import { handlePlatformClinic, handlePlatformOverview, handlePlatformSubscriptions, handleWorkspaceSubscription } from "../../lib/crm/platform";
import { handlePlatformInvitationReissue, handlePlatformOnboarding } from "../../lib/crm/platform-onboarding";
import { handlePlatformOnboardingCredentials } from "../../lib/crm/platform-onboarding-credentials";

// Security-2B — deny-by-default tenant authorization for /api/crm/*.
//
// Handlers below run on a service-role Supabase client, which bypasses RLS. The
// router therefore resolves a verified workspace context *before* dispatching,
// and the handlers read the tenant from that context instead of from the
// request. A path that is not registered in lib/crm/authorization.ts is a 404;
// there is no permissive fallback and no environment-controlled bypass.

export const config = {
  api: {
    bodyParser: false,
  },
};

const resources: CrmResource[] = [
  "clients",
  "leads",
  "lead-stages",
  "lead-sources",
  "clinic-services",
  "clinic-doctors",
  "doctor-schedule",
  "deals",
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

function sendAuthError(res: VercelResponse, error: WorkspaceAdminAuthError) {
  // The message and code are already generic; nothing about the workspace, the
  // membership or the underlying Supabase failure reaches the caller.
  return sendJson(res, error.statusCode, {
    success: false,
    error: error.message,
    code: error.code,
  });
}

function notFound(res: VercelResponse) {
  return sendJson(res, 404, {
    success: false,
    error: "Resource not found",
    code: "resource_not_found",
  });
}

function methodNotAllowed(res: VercelResponse) {
  return sendJson(res, 405, {
    success: false,
    error: "Method not allowed",
    code: "method_not_allowed",
  });
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
  // Preserve the exact bytes so signed worker requests can recompute SHA256(body).
  (req as VercelRequest & { rawBody?: Buffer }).rawBody = rawBody;
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

/** Dispatch runs only after the route has been authorized. */
async function dispatch(
  routeKey: string,
  resource: string | undefined,
  segments: string[],
  req: VercelRequest,
  res: VercelResponse,
) {
  switch (routeKey) {
    case "auth-context":
      return handleCrmAuthContext(req, res);
    case "subscription": {
      // Арендатор из проверенного контекста: тот же источник, что и у любого
      // другого браузерного маршрута.
      const context = readWorkspaceContext(req);
      return handleWorkspaceSubscription(context ? context.workspaceId : "", res);
    }
    case "platform-overview":
      return handlePlatformOverview(req, res);
    case "platform-subscriptions":
      return handlePlatformSubscriptions(req, res);
    case "platform-clinic":
      return handlePlatformClinic(req, res);
    case "platform-onboarding":
      return handlePlatformOnboarding(req, res);
    case "platform-onboarding-credentials":
      return handlePlatformOnboardingCredentials(req, res);
    case "platform-whatsapp-number":
      return handlePlatformWhatsappNumber(req, res);
    case "platform-invitation-reissue":
      return handlePlatformInvitationReissue(req, res);
    case "platform-recommendations":
      return handlePlatformRecommendations(req, res);
    case "recommendations": {
      // Арендатор — из проверенного контекста, как у subscription.
      const context = readWorkspaceContext(req);
      return handleWorkspaceRecommendations(context ? context.workspaceId : "", req, res);
    }
    case "staff-invitations":
      return handleStaffInvitations(req, res);
    case "staff-credentials":
      return handleStaffCredentials(req, res);
    case "join-request":
      return handleJoinRequest(req, res);
    case "staff-join-requests":
      return handleStaffJoinRequests(req, res);
    case "join-code":
      return handleJoinCode(req, res);
    case "staff-invitations/accept":
      return handleStaffInvitationAccept(req, res);
    case "health":
      return handleCrmHealth(req, res);
    case "storage-health":
      return handleStorageHealth(req, res);
    case "meta-launch":
      return handleMetaLaunch(req, res);
    case "meta-status":
      return handleMetaStatus(req, res);
    case "meta-validate":
      return handleMetaValidate(req, res);
    case "meta-city-key":
      return handleMetaCityKey(req, res);
    case "tiktok-validate":
      return handleTikTokValidate(req, res);
    case "tiktok-dry-run":
      return handleTikTokDryRun(req, res);
    case "tiktok-setup":
      return handleTikTokSetup(req, res);
    case "meta-insights-sync":
      return handleMetaInsightsSync(req, res);
    case "meta-insights-background-cycle":
      return handleMetaInsightsBackgroundCycle(req, res);
    case "meta-campaign-insights":
      return handleMetaCampaignInsights(req, res);
    case "meta-insights-history":
      return handleMetaInsightsHistory(req, res);
    case "meta-insights-sync-runs":
      return handleMetaInsightsSyncRuns(req, res);
    case "ad-creatives/signed-upload":
      return handleAdCreativeSignedUpload(req, res);
    case "ad-creative-upload":
      return handleAdCreativeUpload(req, res);
    case "ad-creative-meta-upload":
      return handleAdCreativeMetaUpload(req, res);
    case "ads-ai-fill":
      return handleAdsAiFill(req, res);
    case "change-log":
      return handleCrmChangeLog(req, res);
    case "my-clients":
      return handleMyClients(req, res);
    case "push-subscriptions":
      return handlePushSubscriptions(req, res);
    case "salon-stats":
      return handleSalonStats(req, res);
    case "whatsapp-channels":
      return handleWhatsAppChannels(req, res);
    case "video-jobs":
      return handleVideoJobs(req, res);
    case "video-processing-jobs":
      return handleVideoProcessingJobs(req, res, segments.slice(1));
    default:
      break;
  }

  if (resource && isCrmResource(resource)) {
    return handleCrmResource(resource, req, res);
  }

  // Unreachable for a registered route; kept as a closed default.
  return notFound(res);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Портал Medina Control живёт на другом домене; его источники перечислены в
  // переменной окружения, пустой список оставляет поведение прежним. Preflight
  // завершается до авторизации: предзапрос браузера токена не несёт.
  if (applyControlCors(req, res) === "preflight") {
    return res.status(204).end();
  }

  const rawSegments = readPathSegments(req);
  const segments = normalizeCrmSegments(rawSegments);
  if (!segments) {
    return notFound(res);
  }

  const route = resolveCrmRoute(segments);
  if (!route) {
    return notFound(res);
  }

  const method = (req.method || "GET").toUpperCase();
  const isDisabledMethod = Boolean(route.authorization.disabledMethods?.includes(method));

  // Платформенные маршруты гейтятся ДО проверки метода. Обратный порядок
  // выдавал оракул существования: POST на платформенный путь отвечал 405, на
  // несуществующий — 404, и панель со списком всех клиник была различима без
  // единого токена. По той же причине ниже любой авторизационный отказ на
  // платформенном маршруте превращается в тот же 404, что у неизвестного пути.
  if (route.authorization.kind === "platform") {
    try {
      attachPlatformOwner(req, await requirePlatformOwner(req));
      if (!route.authorization.methods.includes(method)) {
        return methodNotAllowed(res);
      }
      try {
        await ensureParsedBody(req);
      } catch {
        return sendJson(res, 400, {
          success: false,
          error: "Invalid request body",
          code: "invalid_request_body",
        });
      }
      return await dispatch(route.key, route.resource, segments, req, res);
    } catch (error) {
      if (error instanceof PlatformAuthError || error instanceof WorkspaceAdminAuthError) {
        return notFound(res);
      }
      throw error;
    }
  }

  if (!isDisabledMethod && !route.authorization.methods.includes(method)) {
    return methodNotAllowed(res);
  }

  try {
    await ensureParsedBody(req);
  } catch {
    return sendJson(res, 400, {
      success: false,
      error: "Invalid request body",
      code: "invalid_request_body",
    });
  }

  try {
    if (route.authorization.kind === "internal_hmac") {
      // The handler performs its own HMAC verification; a browser JWT can never
      // satisfy it, and this branch never builds a workspace context.
      return await dispatch(route.key, route.resource, segments, req, res);
    }

    if (route.authorization.kind === "bootstrap") {
      // Identity only: the user may not have selected a workspace yet.
      await requireAuthenticatedUser(req);
      return await dispatch(route.key, route.resource, segments, req, res);
    }

    const permission = route.authorization.permissions?.[method];
    const context = await requireWorkspaceAccess(req, undefined, {
      ...(route.authorization.roles ? { roles: route.authorization.roles } : {}),
      ...(permission ? { permission } : {}),
    });

    if (isDisabledMethod) {
      // Registered but intentionally refused, and only revealed to a caller who
      // was already authorized for it. Direct staff creation stays closed: it
      // would take an auth_user_id from the browser, which is how a caller could
      // mint privileged membership for any account. Commercial-3B added the
      // verified path — /api/crm/staff-invitations — where the workspace names
      // the address and the person proves they control it.
      return sendJson(res, 409, {
        success: false,
        error: "Staff are added by invitation",
        code: "staff_invitation_required",
        details: ["Use POST /api/crm/staff-invitations"],
      });
    }

    // From here on the verified workspace is the only tenant authority; the
    // selector in the query or body has no further effect.
    attachWorkspaceContext(req, context);
    return await dispatch(route.key, route.resource, segments, req, res);
  } catch (error) {
    if (error instanceof PlatformAuthError) {
      // 404, а не 403: существование панели — тоже сведения.
      return notFound(res);
    }
    if (error instanceof WorkspaceAdminAuthError) {
      return sendAuthError(res, error);
    }
    throw error;
  }
}
