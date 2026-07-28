import type { VercelRequest } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import {
  type CrmPermission,
  type StaffRole,
  hasPermission,
  isStaffRole,
  isWorkspaceAdminRole,
  permissionsForRole,
  workspaceAdminRoles,
} from "./permissions";

// Security-2 — CRM tenant authorization gate.
//
// Every browser-reachable /api/crm/* request resolves through this module before
// a service-role Supabase client is ever created. service_role bypasses RLS, so
// tenant isolation has to be an explicit application concern:
//
//   Bearer JWT -> verified Supabase user -> active staff_users membership
//   -> authorized workspace -> role -> server-computed permissions
//
// No value supplied by the browser is authority. A workspace id in the query or
// body is only a *selector*: it must match an active membership of the verified
// user, otherwise the request is denied.

type WorkspaceAuthStatus = 401 | 403 | 503;

const AUTH_REQUEST_TIMEOUT_MS = 8000;

type SupabaseAuthFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type SupabaseAuthFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<SupabaseAuthFetchResponse>;

type VerifiedSupabaseUser = {
  id: string;
  email?: string;
};

export type WorkspaceMembership = {
  staffUserId: string;
  workspaceId: string;
  role: StaffRole;
};

export type WorkspaceAccessContext = {
  userId: string;
  staffUserId: string;
  workspaceId: string;
  role: StaffRole;
  permissions: CrmPermission[];
  email?: string;
};

/** Kept for compatibility with the Security-1B Meta Insights call sites. */
export type WorkspaceAdminContext = {
  userId: string;
  staffUserId: string;
  workspaceId: string;
  role: "owner" | "admin";
  email?: string;
};

export class WorkspaceAdminAuthError extends Error {
  readonly statusCode: WorkspaceAuthStatus;
  readonly code: string;

  constructor(statusCode: WorkspaceAuthStatus, message: string, code?: string) {
    super(message);
    this.name = "WorkspaceAdminAuthError";
    this.statusCode = statusCode;
    this.code = code ?? defaultCodeForStatus(statusCode);
  }
}

/** Alias so new call sites read naturally; same error class on purpose. */
export const WorkspaceAccessError = WorkspaceAdminAuthError;

function defaultCodeForStatus(status: WorkspaceAuthStatus): string {
  if (status === 401) return "authentication_required";
  if (status === 403) return "workspace_access_denied";
  return "authorization_unavailable";
}

function unauthenticated(): WorkspaceAdminAuthError {
  // One message for every authentication failure: a missing, malformed, expired
  // or forged token must be indistinguishable to the caller.
  return new WorkspaceAdminAuthError(401, "Authentication required", "authentication_required");
}

function accessDenied(): WorkspaceAdminAuthError {
  // Also used when the requested workspace exists but the user is not a member,
  // so foreign workspace existence never leaks.
  return new WorkspaceAdminAuthError(403, "Access denied", "workspace_access_denied");
}

function serviceUnavailable(): WorkspaceAdminAuthError {
  // Never fail open: an Auth or database outage denies access.
  return new WorkspaceAdminAuthError(503, "Authorization service unavailable", "authorization_unavailable");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidValue(value: unknown): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

/**
 * Strict Bearer parsing. The scheme is case-insensitive, everything else is not:
 * the token is never read from a query parameter and never logged.
 */
function readBearerToken(req: VercelRequest): string {
  const headerValue = req.headers.authorization;
  const authorization = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof authorization !== "string") return "";
  const match = authorization.match(/^Bearer[ \t]+(\S+)$/i);
  return match?.[1]?.trim() || "";
}

function isJwtLike(token: string): boolean {
  const segments = token.split(".");
  return segments.length === 3 && segments.every(Boolean);
}

async function verifySupabaseAccessToken(token: string): Promise<VerifiedSupabaseUser> {
  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw serviceUnavailable();
  }

  const safeFetch = fetch as unknown as SupabaseAuthFetch;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS) : null;

  let response: SupabaseAuthFetchResponse;
  try {
    response = await safeFetch(`${supabaseUrl}/auth/v1/user`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: serviceRoleKey,
      },
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch {
    // Network failure or timeout. Deny, never fall through to an unverified path.
    throw serviceUnavailable();
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    throw unauthenticated();
  }

  let payload: unknown;
  try {
    const rawText = await response.text();
    payload = rawText.trim() ? JSON.parse(rawText) as unknown : null;
  } catch {
    throw unauthenticated();
  }

  const user = readRecord(payload);
  // The immutable Supabase user id is the only identity we accept. Email is
  // carried for display and is never used to look up authority; user_metadata
  // and app_metadata are deliberately ignored.
  const id = readString(user?.id);
  if (!id) {
    throw unauthenticated();
  }

  const email = readString(user?.email);
  return {
    id,
    ...(email ? { email } : {}),
  };
}

/** Verifies the Bearer token and returns the Supabase user. Throws 401/503. */
export async function requireAuthenticatedUser(req: VercelRequest): Promise<VerifiedSupabaseUser> {
  const token = readBearerToken(req);
  if (!token || !isJwtLike(token)) {
    throw unauthenticated();
  }
  return verifySupabaseAccessToken(token);
}

/**
 * Optional dependency seam. Production always uses the real service client; the
 * tests pass a stub so membership resolution can be exercised without a project.
 */
export type WorkspaceAuthDeps = {
  getSupabaseClient?: () => ReturnType<typeof getSupabaseServerClient>;
};

/** All active staff memberships of a verified user. Never accepts an email. */
export async function listActiveMemberships(
  userId: string,
  deps: WorkspaceAuthDeps = {},
): Promise<WorkspaceMembership[]> {
  const supabase = (deps.getSupabaseClient ?? getSupabaseServerClient)();
  if (!supabase) {
    throw serviceUnavailable();
  }

  let rows: unknown;
  try {
    const { data, error } = await supabase
      .from("staff_users")
      .select("id, workspace_id, role, status")
      .eq("auth_user_id", userId)
      .eq("status", "active");

    if (error) {
      throw serviceUnavailable();
    }
    rows = data;
  } catch (error) {
    if (error instanceof WorkspaceAdminAuthError) throw error;
    throw serviceUnavailable();
  }

  const memberships: WorkspaceMembership[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const record = readRecord(row);
    if (!record) continue;
    const staffUserId = readString(record.id);
    const workspaceId = readString(record.workspace_id);
    const role = readString(record.role).toLowerCase();
    const status = readString(record.status).toLowerCase();
    if (!staffUserId || !isUuidValue(workspaceId) || status !== "active" || !isStaffRole(role)) continue;
    memberships.push({ staffUserId, workspaceId, role });
  }
  return memberships;
}

/**
 * The one agreed selector form: `?workspaceId=`.
 *
 * The request body is deliberately not consulted. A body field is data being
 * written, and treating it as a selector would blur the line between "which
 * tenant am I acting as" and "what am I saving" — so a workspace id in a create
 * or update payload has no effect on the acting workspace at all.
 */
function readRequestedWorkspaceId(req: VercelRequest): string {
  const queryValue = req.query?.workspaceId ?? req.query?.workspace_id;
  const fromQuery = Array.isArray(queryValue) ? queryValue[0] : queryValue;
  return readString(fromQuery);
}

/**
 * Resolves which workspace this request acts on.
 *
 * The browser-supplied id is a selector, not authority. It must match an active
 * membership. With exactly one membership the server may infer the workspace;
 * with several an explicit selector is required, because silently picking the
 * first membership would make the acting tenant unpredictable.
 */
export async function resolveWorkspaceMembership(
  req: VercelRequest,
  requestedWorkspaceId?: string,
  deps: WorkspaceAuthDeps = {},
): Promise<{ user: VerifiedSupabaseUser; membership: WorkspaceMembership }> {
  const user = await requireAuthenticatedUser(req);
  const memberships = await listActiveMemberships(user.id, deps);

  if (memberships.length === 0) {
    throw accessDenied();
  }

  const requested = readString(requestedWorkspaceId) || readRequestedWorkspaceId(req);

  if (requested) {
    const match = memberships.find((entry) => entry.workspaceId === requested);
    if (!match) {
      // Covers both "workspace does not exist" and "not a member of it".
      throw accessDenied();
    }
    return { user, membership: match };
  }

  if (memberships.length === 1) {
    return { user, membership: memberships[0] };
  }

  throw new WorkspaceAdminAuthError(
    403,
    "Workspace selection required",
    "workspace_selection_required",
  );
}

export type WorkspaceAccessOptions = WorkspaceAuthDeps & {
  /** Restrict to specific staff roles, e.g. workspace administration. */
  roles?: readonly StaffRole[];
  /** Require a server-computed permission for the acting role. */
  permission?: CrmPermission;
};

/**
 * The single entry point for browser CRM authorization. Returns only verified
 * data; callers must use context.workspaceId as the tenant, never the request.
 */
export async function requireWorkspaceAccess(
  req: VercelRequest,
  requestedWorkspaceId?: string,
  options: WorkspaceAccessOptions = {},
): Promise<WorkspaceAccessContext> {
  const { user, membership } = await resolveWorkspaceMembership(req, requestedWorkspaceId, options);

  if (options.roles && !options.roles.includes(membership.role)) {
    throw accessDenied();
  }

  if (options.permission && !hasPermission(membership.role, options.permission)) {
    throw accessDenied();
  }

  return {
    userId: user.id,
    staffUserId: membership.staffUserId,
    workspaceId: membership.workspaceId,
    role: membership.role,
    permissions: permissionsForRole(membership.role),
    ...(user.email ? { email: user.email } : {}),
  };
}

/** Throws unless the already-verified context holds the permission. */
export function requireWorkspacePermission(
  context: WorkspaceAccessContext,
  permission: CrmPermission,
): void {
  if (!hasPermission(context.role, permission)) {
    throw accessDenied();
  }
}

/** Throws unless the already-verified context has one of the roles. */
export function requireWorkspaceRole(
  context: WorkspaceAccessContext,
  allowedRoles: readonly StaffRole[],
): void {
  if (!allowedRoles.includes(context.role)) {
    throw accessDenied();
  }
}

/**
 * Security-1B compatibility wrapper. Identical guarantees to the previous
 * implementation (verified JWT + active membership + owner/admin), now sharing
 * the hardened resolution path. Kept so Meta Insights call sites are unchanged.
 */
export async function requireWorkspaceAdmin(
  req: VercelRequest,
  workspaceId: string,
  deps: WorkspaceAuthDeps = {},
): Promise<WorkspaceAdminContext> {
  // The explicit id stays mandatory here: these routes always name their
  // workspace, and accepting an inferred one would widen their surface.
  if (!isUuidValue(workspaceId)) {
    throw accessDenied();
  }

  const context = await requireWorkspaceAccess(req, workspaceId, { ...deps, roles: workspaceAdminRoles });
  if (!isWorkspaceAdminRole(context.role)) {
    throw accessDenied();
  }

  return {
    userId: context.userId,
    staffUserId: context.staffUserId,
    workspaceId: context.workspaceId,
    role: context.role as "owner" | "admin",
    ...(context.email ? { email: context.email } : {}),
  };
}

/** Bootstrap payload for /api/crm/auth-context: only the caller's memberships. */
export async function listAuthContextMemberships(
  req: VercelRequest,
  deps: WorkspaceAuthDeps = {},
): Promise<{
  user: VerifiedSupabaseUser;
  memberships: Array<WorkspaceMembership & { permissions: CrmPermission[] }>;
}> {
  const user = await requireAuthenticatedUser(req);
  const memberships = await listActiveMemberships(user.id, deps);
  return {
    user,
    memberships: memberships.map((entry) => ({
      ...entry,
      permissions: permissionsForRole(entry.role),
    })),
  };
}
