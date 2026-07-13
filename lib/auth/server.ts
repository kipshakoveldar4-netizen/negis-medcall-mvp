import type { VercelRequest } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";

const workspaceAdminRoles = new Set(["owner", "admin"]);

type WorkspaceAdminAuthStatus = 401 | 403 | 503;

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
  },
) => Promise<SupabaseAuthFetchResponse>;

type VerifiedSupabaseUser = {
  id: string;
  email?: string;
};

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

async function verifySupabaseAccessToken(token: string): Promise<VerifiedSupabaseUser> {
  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new WorkspaceAdminAuthError(503, "Authentication service unavailable");
  }

  const safeFetch = fetch as unknown as SupabaseAuthFetch;
  let response: SupabaseAuthFetchResponse;
  try {
    response = await safeFetch(`${supabaseUrl}/auth/v1/user`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: serviceRoleKey,
      },
    });
  } catch {
    throw new WorkspaceAdminAuthError(503, "Authentication service unavailable");
  }

  if (!response.ok) {
    throw new WorkspaceAdminAuthError(401, "Authentication required");
  }

  let payload: unknown;
  try {
    const rawText = await response.text();
    payload = rawText.trim() ? JSON.parse(rawText) as unknown : null;
  } catch {
    throw new WorkspaceAdminAuthError(401, "Authentication required");
  }

  const user = readRecord(payload);
  const id = readString(user?.id);
  if (!id) {
    throw new WorkspaceAdminAuthError(401, "Authentication required");
  }

  const email = readString(user?.email);
  return {
    id,
    ...(email ? { email } : {}),
  };
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

  const verifiedUser = await verifySupabaseAccessToken(token);
  const userId = verifiedUser.id;
  const userEmail = verifiedUser.email || "";

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    throw new WorkspaceAdminAuthError(503, "Authentication service unavailable");
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
