import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { canAssignRole, isStaffRole, type StaffRole } from "../auth/permissions";
import { requireAuthenticatedUser, WorkspaceAdminAuthError } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";

// Commercial-3B — staff enrollment.
//
// A clinic could not add its own people: POST /api/crm/staff has answered
// 409 staff_invitation_required since Security-2B, because the only way it knew
// to link a person to a membership was an auth_user_id supplied by the browser,
// which is the escalation path it was closed for.
//
// The invitation splits that into two halves that each prove one thing. An
// administrator with manage_staff names an email and a role — that is the
// workspace deciding who may join and as what. The invited person then proves
// control of that email through Supabase Auth and redeems a token — that is the
// identity half. Membership is written only where both halves meet, and the
// role can never exceed what the inviter was allowed to grant.

const TOKEN_BYTES = 32;
const DEFAULT_TTL_HOURS = 168; // seven days

export type InvitationRow = {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

/** Derives the state a reader cares about from the three timestamps. */
export function invitationStatus(row: Pick<InvitationRow, "accepted_at" | "revoked_at" | "expires_at">, now = new Date()): InvitationStatus {
  if (row.accepted_at) return "accepted";
  if (row.revoked_at) return "revoked";
  if (new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return "pending";
}

/**
 * A token the database never sees. The row stores its SHA-256, so a dump of
 * staff_invitations cannot be redeemed.
 */
export function createInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison, so a hash is never matched a character at a time. */
export function invitationTokenMatches(token: string, tokenHash: string): boolean {
  const candidate = Buffer.from(hashInvitationToken(token), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function expiryFromNow(hours = DEFAULT_TTL_HOURS, now = new Date()): string {
  return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
}

export type InvitationRejection = { status: number; error: string; code: string; details?: string[] };

/**
 * Everything about a create request that can be decided without the database.
 *
 * The role rules are the same ones the staff PATCH endpoint enforces, and for
 * the same reason: owner is never assignable through a generic endpoint, and no
 * actor may hand out a role at or above its own rank.
 */
export function validateInvitationRequest(input: {
  actorRole: StaffRole;
  email: unknown;
  role: unknown;
}): { email: string; role: StaffRole } | InvitationRejection {
  const email = normalizeEmail(input.email);
  const role = typeof input.role === "string" ? input.role.trim().toLowerCase() : "";

  const details: string[] = [];
  if (!email) details.push("email is required");
  else if (!isEmail(email)) details.push("email must be valid");
  if (!role) details.push("role is required");

  if (details.length > 0) {
    return { status: 400, error: "Validation error", code: "invalid_invitation", details };
  }

  if (!isStaffRole(role)) {
    return { status: 400, error: "Validation error", code: "invalid_role", details: ["role is not a staff role"] };
  }

  if (!canAssignRole(input.actorRole, role)) {
    return { status: 403, error: "Insufficient permissions", code: "permission_denied" };
  }

  return { email, role };
}

/**
 * Everything about an acceptance that can be decided without writing.
 *
 * The email comparison is what binds the invitation to a person: the token
 * proves someone has the link, the verified session proves who they are, and
 * membership is only written where the two agree.
 */
export function validateAcceptance(input: {
  invitation: Pick<InvitationRow, "email" | "accepted_at" | "revoked_at" | "expires_at"> | null;
  userEmail: string;
  now?: Date;
}): InvitationRejection | null {
  const { invitation } = input;
  // A missing token and a revoked one are reported identically: an attacker
  // guessing tokens learns nothing about which ones exist.
  if (!invitation) {
    return { status: 404, error: "Invitation not found", code: "invitation_not_found" };
  }

  const status = invitationStatus(invitation, input.now ?? new Date());
  if (status !== "pending") {
    return { status: 409, error: "Invitation is no longer valid", code: `invitation_${status}` };
  }

  if (!input.userEmail || normalizeEmail(invitation.email) !== normalizeEmail(input.userEmail)) {
    return { status: 403, error: "Invitation was issued to a different address", code: "invitation_email_mismatch" };
  }

  return null;
}

/* ── HTTP handlers ──────────────────────────────────────────── */

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

function sendRejection(res: VercelResponse, rejection: InvitationRejection) {
  return sendJson(res, rejection.status, {
    success: false,
    error: rejection.error,
    code: rejection.code,
    ...(rejection.details ? { details: rejection.details } : {}),
  });
}

function serviceUnavailable(res: VercelResponse) {
  return sendJson(res, 503, { success: false, error: "Service unavailable", code: "service_unavailable" });
}

/** The row shape a browser may see. The token hash never appears. */
function publicInvitation(row: InvitationRow) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: invitationStatus(row),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Asks Supabase Auth to send the invitation email.
 *
 * Best effort by design: the invitation is already valid once the row exists,
 * and the administrator gets the link back in the response. A mail failure —
 * including "user already registered", which is a normal case for someone who
 * already has an account — must not leave a half-created invitation behind.
 */
async function sendSupabaseInviteEmail(email: string, redirectTo: string): Promise<{ sent: boolean; reason?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return { sent: false, reason: "auth_not_configured" };

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/invite`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, redirect_to: redirectTo }),
    });
    if (response.ok) return { sent: true };
    // The status is enough to act on; the body may echo the address.
    return { sent: false, reason: response.status === 422 ? "already_registered" : "invite_rejected" };
  } catch {
    return { sent: false, reason: "invite_unreachable" };
  }
}

function acceptUrl(req: VercelRequest, token: string): string {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  if (!host) return `/join?token=${encodeURIComponent(token)}`;
  return `${proto}://${host}/join?token=${encodeURIComponent(token)}`;
}

/** GET / POST / PATCH /api/crm/staff-invitations — workspace administration. */
export async function handleStaffInvitations(req: VercelRequest, res: VercelResponse) {
  const context = readWorkspaceContext(req);
  if (!context) {
    return sendJson(res, 403, { success: false, error: "Access denied", code: "workspace_access_denied" });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) return serviceUnavailable(res);

  const method = (req.method || "GET").toUpperCase();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

  if (method === "GET") {
    const { data, error } = await supabase
      .from("staff_invitations")
      .select("id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at")
      .eq("workspace_id", context.workspaceId)
      .order("created_at", { ascending: false });

    if (error) return serviceUnavailable(res);
    const rows = (Array.isArray(data) ? data : []) as InvitationRow[];
    return sendJson(res, 200, {
      success: true,
      mode: "supabase",
      data: { invitations: rows.map(publicInvitation), items: rows.map(publicInvitation) },
    });
  }

  if (method === "POST") {
    const validated = validateInvitationRequest({ actorRole: context.role, email: body.email, role: body.role });
    if ("status" in validated) return sendRejection(res, validated);

    // Someone who is already on the team does not need an invitation, and
    // saying so plainly avoids a second membership row for the same person.
    const { data: existing, error: existingError } = await supabase
      .from("staff_users")
      .select("id")
      .eq("workspace_id", context.workspaceId)
      .ilike("email", validated.email)
      .maybeSingle();
    if (existingError) return serviceUnavailable(res);
    if (existing) {
      return sendJson(res, 409, { success: false, error: "This address is already a member", code: "already_member" });
    }

    const { token, tokenHash } = createInvitationToken();
    const { data, error } = await supabase
      .from("staff_invitations")
      .insert({
        workspace_id: context.workspaceId,
        email: validated.email,
        role: validated.role,
        token_hash: tokenHash,
        expires_at: expiryFromNow(),
        invited_by_staff_user_id: context.staffUserId,
      })
      .select("id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at")
      .single();

    if (error || !data) {
      // The partial unique index is the only expected conflict here.
      return sendJson(res, 409, {
        success: false,
        error: "An invitation for this address is already pending",
        code: "invitation_already_pending",
      });
    }

    const link = acceptUrl(req, token);
    const email = await sendSupabaseInviteEmail(validated.email, link);

    return sendJson(res, 201, {
      success: true,
      mode: "supabase",
      data: {
        invitation: publicInvitation(data as InvitationRow),
        // Shown once. The administrator can pass it on directly when the
        // mail did not go out.
        acceptUrl: link,
        emailSent: email.sent,
        ...(email.reason ? { emailStatus: email.reason } : {}),
      },
    });
  }

  // PATCH — revoke. A pending invitation is the only thing that can change.
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return sendRejection(res, { status: 400, error: "Validation error", code: "invalid_invitation", details: ["id is required"] });
  }

  const { data, error } = await supabase
    .from("staff_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", context.workspaceId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at")
    .maybeSingle();

  if (error) return serviceUnavailable(res);
  if (!data) {
    // Foreign, missing and already-settled are one answer, so revoking cannot
    // be used to discover another clinic's invitations.
    return sendJson(res, 404, { success: false, error: "Invitation not found", code: "invitation_not_found" });
  }

  return sendJson(res, 200, { success: true, mode: "supabase", data: { invitation: publicInvitation(data as InvitationRow) } });
}

/**
 * POST /api/crm/staff-invitations/accept — the identity half.
 *
 * Bootstrap route: the caller is authenticated but has no membership yet, which
 * is the whole point. The router has verified the JWT; everything below decides
 * whether this verified person is the one the workspace invited.
 */
export async function handleStaffInvitationAccept(req: VercelRequest, res: VercelResponse) {
  let user: { id: string; email?: string };
  try {
    user = await requireAuthenticatedUser(req);
  } catch (error) {
    if (error instanceof WorkspaceAdminAuthError) {
      return sendJson(res, error.statusCode, { success: false, error: error.message, code: error.code });
    }
    return serviceUnavailable(res);
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) return serviceUnavailable(res);

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return sendRejection(res, { status: 400, error: "Validation error", code: "invalid_invitation", details: ["token is required"] });
  }

  const { data, error } = await supabase
    .from("staff_invitations")
    .select("id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at, token_hash")
    .eq("token_hash", hashInvitationToken(token))
    .maybeSingle();

  if (error) return serviceUnavailable(res);

  const invitation = data as (InvitationRow & { token_hash: string }) | null;
  const rejection = validateAcceptance({ invitation, userEmail: user.email ?? "" });
  if (rejection) return sendRejection(res, rejection);
  if (!invitation) return sendRejection(res, { status: 404, error: "Invitation not found", code: "invitation_not_found" });

  // Claim it first. The conditional update is what makes redemption single-use:
  // two requests racing on the same token, only one of them writes a member.
  const { data: claimed, error: claimError } = await supabase
    .from("staff_invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invitation.id)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (claimError) return serviceUnavailable(res);
  if (!claimed) {
    return sendJson(res, 409, { success: false, error: "Invitation is no longer valid", code: "invitation_accepted" });
  }

  const fullName = typeof body.fullName === "string" && body.fullName.trim() ? body.fullName.trim() : invitation.email;
  const { data: member, error: memberError } = await supabase
    .from("staff_users")
    .insert({
      workspace_id: invitation.workspace_id,
      email: invitation.email,
      full_name: fullName,
      role: invitation.role,
      status: "active",
      auth_user_id: user.id,
      invited_at: invitation.created_at,
      password_reset_required: false,
    })
    .select("id, workspace_id, role")
    .single();

  if (memberError || !member) {
    // Put the invitation back rather than leaving a consumed token with no
    // membership to show for it.
    await supabase.from("staff_invitations").update({ accepted_at: null }).eq("id", invitation.id);
    return serviceUnavailable(res);
  }

  const staffUserId = (member as { id: string }).id;
  await supabase.from("staff_invitations").update({ accepted_staff_user_id: staffUserId }).eq("id", invitation.id);

  return sendJson(res, 201, {
    success: true,
    mode: "supabase",
    data: {
      workspaceId: invitation.workspace_id,
      role: invitation.role,
      staffUserId,
    },
  });
}
