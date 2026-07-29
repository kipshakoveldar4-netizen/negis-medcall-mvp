import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Commercial-3B — staff enrollment.
//
// The invitation is the one place where a membership is created, so it is the
// one place where getting the rules wrong hands someone a clinic. Two halves
// have to hold at once: the workspace decides *who may join and as what*, and
// Supabase Auth decides *who the caller is*. Membership is written only where
// both agree, and the role can never exceed what the inviter could grant.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "crm", "staff-invitations.ts");
const migrationPath = path.join(repoRoot, "migrations", "024_staff_invitations.sql");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF_A = "22222222-2222-4222-8222-222222222222";

// The module is loaded by URL rather than imported statically: the scripts
// package compiles only scripts/src, and a static import would drag all of lib
// into its program. The surface is declared locally instead.
type InvitationTimestamps = { accepted_at: string | null; revoked_at: string | null; expires_at: string };
type Rejection = { status: number; error: string; code: string; details?: string[] };

type Mod = {
  createInvitationToken: () => { token: string; tokenHash: string };
  hashInvitationToken: (token: string) => string;
  invitationTokenMatches: (token: string, tokenHash: string) => boolean;
  invitationStatus: (row: InvitationTimestamps, now?: Date) => "pending" | "accepted" | "revoked" | "expired";
  normalizeEmail: (value: unknown) => string;
  expiryFromNow: (hours?: number, now?: Date) => string;
  validateInvitationRequest: (input: { actorRole: string; email: unknown; role: unknown }) =>
    | { email: string; role: string }
    | Rejection;
  validateAcceptance: (input: {
    invitation: (InvitationTimestamps & { email: string }) | null;
    userEmail: string;
    now?: Date;
  }) => Rejection | null;
};

async function load(): Promise<Mod> {
  return (await import(pathToFileURL(modulePath).href)) as Mod;
}

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 60 * 1000).toISOString();

/* ── Tokens ─────────────────────────────────────────────────── */

test("I1 the database never stores a redeemable token", async () => {
  const { createInvitationToken, hashInvitationToken } = await load();
  const { token, tokenHash } = createInvitationToken();

  assert.ok(token.length >= 40, "the token must carry real entropy");
  assert.notEqual(token, tokenHash);
  assert.match(tokenHash, /^[0-9a-f]{64}$/, "only the SHA-256 is persisted");
  assert.equal(hashInvitationToken(token), tokenHash, "the hash must be reproducible from the token");

  const second = createInvitationToken();
  assert.notEqual(second.token, token, "tokens must not repeat");
});

test("I2 a token is matched whole, in constant time", async () => {
  const { createInvitationToken, invitationTokenMatches } = await load();
  const { token, tokenHash } = createInvitationToken();

  assert.equal(invitationTokenMatches(token, tokenHash), true);
  assert.equal(invitationTokenMatches(token.slice(0, -1), tokenHash), false);
  assert.equal(invitationTokenMatches("", tokenHash), false);
  assert.equal(invitationTokenMatches(token, "deadbeef"), false, "a truncated hash must not compare equal");

  const source = await readFile(modulePath, "utf8");
  assert.ok(source.includes("timingSafeEqual"), "comparison must not leak position through timing");
});

/* ── Who may be invited, and as what ────────────────────────── */

test("I3 an invitation may never grant owner", async () => {
  const { validateInvitationRequest } = await load();
  for (const actorRole of ["owner", "admin"] as const) {
    const result = validateInvitationRequest({ actorRole, email: "new@clinic.test", role: "owner" });
    assert.ok("status" in result, `${actorRole} must not be able to invite an owner`);
    assert.equal(result.status, 403);
    assert.equal(result.code, "permission_denied");
  }
});

test("I4 nobody may invite at or above their own rank", async () => {
  const { validateInvitationRequest } = await load();

  const adminInvitesAdmin = validateInvitationRequest({ actorRole: "admin", email: "a@clinic.test", role: "admin" });
  assert.ok("status" in adminInvitesAdmin, "an admin must not mint another admin");
  assert.equal(adminInvitesAdmin.code, "permission_denied");

  const ownerInvitesAdmin = validateInvitationRequest({ actorRole: "owner", email: "a@clinic.test", role: "admin" });
  assert.ok(!("status" in ownerInvitesAdmin), "an owner may invite an admin");
  assert.equal(ownerInvitesAdmin.role, "admin");
});

test("I5 the address and the role are validated before anything is written", async () => {
  const { validateInvitationRequest } = await load();

  const noEmail = validateInvitationRequest({ actorRole: "owner", email: "", role: "manager" });
  assert.ok("status" in noEmail && noEmail.status === 400);

  const badEmail = validateInvitationRequest({ actorRole: "owner", email: "not-an-address", role: "manager" });
  assert.ok("status" in badEmail && badEmail.code === "invalid_invitation");

  const badRole = validateInvitationRequest({ actorRole: "owner", email: "a@clinic.test", role: "superuser" });
  assert.ok("status" in badRole && badRole.code === "invalid_role");

  const ok = validateInvitationRequest({ actorRole: "owner", email: "  Mixed.Case@Clinic.TEST ", role: "MANAGER" });
  assert.ok(!("status" in ok));
  assert.equal(ok.email, "mixed.case@clinic.test", "addresses are normalised so one person cannot hold two invitations");
  assert.equal(ok.role, "manager");
});

/* ── Redemption ─────────────────────────────────────────────── */

test("I6 a token is not enough: the session's address must match", async () => {
  const { validateAcceptance } = await load();
  const invitation = { email: "invited@clinic.test", accepted_at: null, revoked_at: null, expires_at: future };

  const wrongPerson = validateAcceptance({ invitation, userEmail: "someone.else@clinic.test" });
  assert.ok(wrongPerson, "holding the link must not be enough to join");
  assert.equal(wrongPerson?.status, 403);
  assert.equal(wrongPerson?.code, "invitation_email_mismatch");

  const noEmail = validateAcceptance({ invitation, userEmail: "" });
  assert.ok(noEmail, "a session without an address cannot satisfy an invitation");

  const rightPerson = validateAcceptance({ invitation, userEmail: "INVITED@clinic.test" });
  assert.equal(rightPerson, null, "case must not decide membership");
});

test("I7 spent, revoked and expired invitations are all refused", async () => {
  const { validateAcceptance } = await load();
  const base = { email: "invited@clinic.test", accepted_at: null, revoked_at: null, expires_at: future };

  const accepted = validateAcceptance({ invitation: { ...base, accepted_at: past }, userEmail: base.email });
  assert.equal(accepted?.code, "invitation_accepted");

  const revoked = validateAcceptance({ invitation: { ...base, revoked_at: past }, userEmail: base.email });
  assert.equal(revoked?.code, "invitation_revoked");

  const expired = validateAcceptance({ invitation: { ...base, expires_at: past }, userEmail: base.email });
  assert.equal(expired?.code, "invitation_expired");
});

test("I8 an unknown token says nothing about which tokens exist", async () => {
  const { validateAcceptance } = await load();
  const missing = validateAcceptance({ invitation: null, userEmail: "anyone@clinic.test" });
  assert.equal(missing?.status, 404);
  assert.equal(missing?.code, "invitation_not_found");
});

test("I9 status is derived from the row, not stored as a field that can drift", async () => {
  const { invitationStatus } = await load();
  assert.equal(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: future }), "pending");
  assert.equal(invitationStatus({ accepted_at: past, revoked_at: null, expires_at: future }), "accepted");
  assert.equal(invitationStatus({ accepted_at: null, revoked_at: past, expires_at: future }), "revoked");
  assert.equal(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: past }), "expired");
  // Acceptance wins over a later expiry: a member who joined stays a member.
  assert.equal(invitationStatus({ accepted_at: past, revoked_at: null, expires_at: past }), "accepted");
});

/* ── The shape of the flow ──────────────────────────────────── */

test("I10 redemption is single-use by construction, not by a re-read", async () => {
  const source = await readFile(modulePath, "utf8");
  const accept = source.slice(source.indexOf("export async function handleStaffInvitationAccept"));

  // The claim is a conditional update: two requests racing on one token, only
  // the one whose update matches a still-unclaimed row writes a membership.
  const claim = accept.slice(accept.indexOf("update({ accepted_at"));
  assert.ok(/\.is\("accepted_at", null\)/.test(claim), "the claim must only match an unclaimed invitation");
  assert.ok(/\.is\("revoked_at", null\)/.test(claim), "and a revoked one must not be claimable");
  assert.ok(
    accept.indexOf("update({ accepted_at") < accept.indexOf('from("staff_users")'),
    "the invitation is claimed before the membership is written",
  );
});

test("I11 the membership is built from the invitation, never from the request", async () => {
  const source = await readFile(modulePath, "utf8");
  const accept = source.slice(source.indexOf("export async function handleStaffInvitationAccept"));
  const insert = accept.slice(accept.indexOf('from("staff_users")'), accept.indexOf("if (memberError"));

  assert.ok(/workspace_id: invitation\.workspace_id/.test(insert), "the workspace comes from the invitation");
  assert.ok(/role: invitation\.role/.test(insert), "the role comes from the invitation");
  assert.ok(/email: invitation\.email/.test(insert), "the address comes from the invitation");
  assert.ok(/auth_user_id: user\.id/.test(insert), "the identity comes from the verified session");

  // fullName is the only thing the caller may choose, and it is cosmetic.
  assert.ok(!/role: .*body\./.test(insert), "the caller must not choose a role");
  assert.ok(!/workspace_id: .*body\./.test(insert), "the caller must not choose a workspace");
  assert.ok(!/auth_user_id: .*body\./.test(insert), "the caller must not choose an identity");
});

test("I12 a failed membership write releases the invitation", async () => {
  const source = await readFile(modulePath, "utf8");
  const accept = source.slice(source.indexOf("export async function handleStaffInvitationAccept"));
  const failure = accept.slice(accept.indexOf("if (memberError"));
  assert.ok(
    /update\(\{ accepted_at: null \}\)/.test(failure),
    "a consumed token with no membership behind it would strand the invited person",
  );
});

test("I13 the token never leaves the server except in the creation response", async () => {
  const source = await readFile(modulePath, "utf8");
  const publicShape = source.slice(source.indexOf("function publicInvitation"), source.indexOf("async function sendSupabaseInviteEmail"));
  assert.ok(!/token/i.test(publicShape), "the listed shape must carry no token material");

  const list = source.slice(source.indexOf('if (method === "GET")'), source.indexOf('if (method === "POST")'));
  assert.ok(!/token_hash/.test(list), "listing must not select the hash");
});

test("I14 revoking cannot be used to probe another clinic", async () => {
  const source = await readFile(modulePath, "utf8");
  const revoke = source.slice(source.indexOf("// PATCH — revoke"));
  assert.ok(/\.eq\("workspace_id", context\.workspaceId\)/.test(revoke), "the update is scoped to the verified workspace");
  assert.ok(/invitation_not_found/.test(revoke), "foreign, missing and settled must answer identically");
});

test("I15 the route is registered as administration, and acceptance as bootstrap", async () => {
  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");

  const admin = registry.slice(registry.indexOf('"staff-invitations": {'));
  assert.ok(/kind: "browser"/.test(admin.slice(0, 300)), "administration requires a workspace");
  assert.ok(/manage_staff/.test(admin.slice(0, 300)), "and the staff permission");

  const accept = registry.slice(registry.indexOf('"staff-invitations/accept": {'));
  assert.ok(/kind: "bootstrap"/.test(accept.slice(0, 200)), "the invited person has no membership yet");
  assert.ok(/methods: \["POST"\]/.test(accept.slice(0, 200)));

  // Direct staff creation stays closed, and now says where to go instead.
  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  assert.ok(router.includes("staff_invitation_required"));
  assert.ok(router.includes("POST /api/crm/staff-invitations"), "the refusal should point at the supported path");
});

test("I16 the migration stores a hash, scopes by workspace and keeps the Data API out", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.ok(/token_hash text not null unique/.test(sql), "the token itself is never a column");
  assert.ok(!/token text/.test(sql), "a plaintext token column would defeat the hashing");
  assert.ok(/workspace_id uuid not null references workspaces\(id\) on delete cascade/.test(sql));
  assert.ok(/revoke all on table staff_invitations from anon/.test(sql));
  assert.ok(/revoke all on table staff_invitations from authenticated/.test(sql));
  // RLS with no policies is deny-all for everyone but service_role, so a future
  // grant cannot open the table by itself.
  assert.ok(/alter table staff_invitations enable row level security/.test(sql));

  // One live invitation per address per workspace, so the pending list is true.
  assert.ok(/create unique index[^;]*where accepted_at is null and revoked_at is null/s.test(sql));
  assert.equal((sql.match(/begin;/g) || []).length, 1);
  assert.equal((sql.match(/commit;/g) || []).length, 1);
});

test("I17 a mail failure does not invalidate an invitation that already exists", async () => {
  const source = await readFile(modulePath, "utf8");
  const send = source.slice(source.indexOf("async function sendSupabaseInviteEmail"), source.indexOf("function acceptUrl"));

  assert.ok(/return \{ sent: false/.test(send), "the helper reports failure instead of throwing");
  assert.ok(!/throw /.test(send), "an unreachable mail service must not abort the request");
  assert.ok(/already_registered/.test(send), "an existing account is an ordinary case, not an error");

  const post = source.slice(source.indexOf('if (method === "POST")'), source.indexOf("// PATCH — revoke"));
  assert.ok(
    post.indexOf("sendSupabaseInviteEmail") > post.indexOf('from("staff_invitations")'),
    "the row is written first, so the invitation survives a mail outage",
  );
  assert.ok(/acceptUrl: link/.test(post), "and the administrator gets the link back either way");
});
