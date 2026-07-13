import type { VercelRequest } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";

const workspaceAdminRoles = new Set(["owner", "admin"]);

type WorkspaceAdminAuthStatus = 401 | 403 | 503;

export type WorkspaceAdminContext = {
  userId: string;
  staffUserId: string;
  workspaceId: string;
  role: "owner" | "admin";
  email?: string;
};

export class WorkspaceAdminAuthError extends Error {
  readonly statusCode: WorkspaceAdminAuthStatus;

  constructor(statusCode: WorkspaceAdminAuthStatus, message: string) {
    super(message);
    this.name = "WorkspaceAdminAuthError";
    this.statusCode = statusCode;
  }
}

function readBearerToken(req: VercelRequest): string {
  const headerValue = req.headers.authorization;
  const authorization = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
  return match?.[1]?.trim() || "";
}

function isJwtLike(token: string): boolean {
  const segments = token.split(".");
  return segments.length === 3 && segments.every(Boolean);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function requireWorkspaceAdmin(
  req: VercelRequest,
  workspaceId: string,
): Promise<WorkspaceAdminContext> {
  const token = readBearerToken(req);
  if (!token) {
    throw new WorkspaceAdminAuthError(401, "Authentication required");
  }
  if (!isJwtLike(token)) {
    throw new WorkspaceAdminAuthError(401, "Authentication required");
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    throw new WorkspaceAdminAuthError(503, "Authentication service unavailable");
  }

  let userId = "";
  let userEmail = "";
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      throw new WorkspaceAdminAuthError(401, "Authentication required");
    }
    userId = readString(data.user.id);
    userEmail = readString(data.user.email);
  } catch (error) {
    if (error instanceof WorkspaceAdminAuthError) throw error;
    throw new WorkspaceAdminAuthError(401, "Authentication required");
  }

  if (!userId) {
    throw new WorkspaceAdminAuthError(401, "Authentication required");
  }

  let staffValue: unknown;
  try {
    const { data, error } = await supabase
      .from("staff_users")
      .select("id, workspace_id, role, status, email")
      .eq("auth_user_id", userId)
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new WorkspaceAdminAuthError(503, "Authorization service unavailable");
    }
    staffValue = data;
  } catch (error) {
    if (error instanceof WorkspaceAdminAuthError) throw error;
    throw new WorkspaceAdminAuthError(503, "Authorization service unavailable");
  }

  const staff = readRecord(staffValue);
  if (!staff) {
    throw new WorkspaceAdminAuthError(403, "Insufficient permissions");
  }

  const staffUserId = readString(staff.id);
  const staffWorkspaceId = readString(staff.workspace_id);
  const role = readString(staff.role).toLowerCase();
  const status = readString(staff.status).toLowerCase();

  if (
    !staffUserId ||
    staffWorkspaceId !== workspaceId ||
    status !== "active" ||
    !workspaceAdminRoles.has(role)
  ) {
    throw new WorkspaceAdminAuthError(403, "Insufficient permissions");
  }

  return {
    userId,
    staffUserId,
    workspaceId: staffWorkspaceId,
    role: role as "owner" | "admin",
    ...(userEmail || readString(staff.email) ? { email: userEmail || readString(staff.email) } : {}),
  };
}
