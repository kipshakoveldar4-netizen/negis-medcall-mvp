import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { CrmPermission, StaffRole } from "./permissions";
import { requireWorkspaceAccess, WorkspaceAdminAuthError, type WorkspaceAccessContext } from "./server";

// Security-2D — the authorization boundary for private serverless routes that
// live outside /api/crm/*.
//
// Security-2B closed the CRM catch-all, but Content Studio, the targeting agent
// routes and /api/auth/register were never part of that gate: they ran a
// service-role Supabase client, called paid providers and wrote rows for a
// workspace the browser named, all without a token. Rather than move those
// routes under /api/crm/* (Vercel counts functions, and their contracts differ),
// they reuse the same auth foundation through this wrapper.
//
// The rules are identical to the CRM router by construction: the registry is
// the only source of what a route accepts, unknown is 404, wrong method is 405,
// and the verified context — never the request body — is the tenant.

export type PrivateRouteKind =
  /** Requires a verified JWT, an active membership and a workspace. */
  | "browser"
  /** Registered but intentionally refused; answers 410 after authorization. */
  | "disabled";

export type PrivateRouteAuthorization = {
  kind: PrivateRouteKind;
  methods: readonly string[];
  roles?: readonly StaffRole[];
  /** Per-method permission, resolved server-side from the verified role. */
  permissions?: Readonly<Partial<Record<string, CrmPermission>>>;
  /** Shown with the 410 so an operator knows why the route is closed. */
  disabledReason?: string;
};

export function sendRouteJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

export function sendRouteError(res: VercelResponse, status: number, code: string, error: string, details: string[] = []) {
  return sendRouteJson(res, status, { success: false, error, code, ...(details.length > 0 ? { details } : {}) });
}

export function sendNotFound(res: VercelResponse) {
  return sendRouteError(res, 404, "resource_not_found", "Not found");
}

export function sendMethodNotAllowed(res: VercelResponse, allowed: readonly string[]) {
  res.setHeader("Allow", allowed.join(", "));
  return sendRouteError(res, 405, "method_not_allowed", "Method not allowed", [`Use ${allowed.join(", ")}`]);
}

/**
 * Normalises a single path segment. Anything that could be used to reach an
 * unregistered handler — encoded separators, traversal, unexpected characters —
 * resolves to an empty string, which the caller turns into a 404.
 */
export function normalizeRouteSegment(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return "";
  const segment = raw.trim();
  if (!segment || segment === "." || segment === "..") return "";
  if (!/^[a-z0-9-]+$/i.test(segment)) return "";
  return segment.toLowerCase();
}

export type AuthorizedRoute = {
  context: WorkspaceAccessContext;
};

/**
 * Runs the registry check and the authorization for one private route.
 *
 * Returns the verified context, or null when the response has already been
 * sent. There is no third outcome: a caller that forgets to check the null
 * simply has no context to scope its query with.
 */
export async function authorizePrivateRoute(
  req: VercelRequest,
  res: VercelResponse,
  authorization: PrivateRouteAuthorization | undefined,
): Promise<WorkspaceAccessContext | null> {
  if (!authorization) {
    sendNotFound(res);
    return null;
  }

  const method = (req.method || "GET").toUpperCase();
  if (!authorization.methods.includes(method)) {
    sendMethodNotAllowed(res, authorization.methods);
    return null;
  }

  try {
    const permission = authorization.permissions?.[method];
    const context = await requireWorkspaceAccess(req, undefined, {
      ...(authorization.roles ? { roles: authorization.roles } : {}),
      ...(permission ? { permission } : {}),
    });

    if (authorization.kind === "disabled") {
      // Same ordering as the CRM staff route: the closure is only disclosed to
      // a caller who authenticated and was authorized for it.
      sendRouteError(
        res,
        410,
        "route_disabled",
        "Route disabled",
        authorization.disabledReason ? [authorization.disabledReason] : [],
      );
      return null;
    }

    return context;
  } catch (error) {
    if (error instanceof WorkspaceAdminAuthError) {
      sendRouteJson(res, error.statusCode, { success: false, error: error.message, code: error.code });
      return null;
    }
    throw error;
  }
}
