import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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
const grantMigrationPath = path.join(repoRoot, "migrations", "025_staff_invitations_service_role_grant.sql");

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

  // The serverless build compiles this file without the DOM lib, where the
  // global Response carries neither ok nor status. Reading them off the fetch
  // result directly type-checks locally and fails the Vercel build, so the
  // shape is declared here instead.
  assert.ok(/type InviteResponse = \{ ok: boolean; status: number \}/.test(send), "the response shape is declared locally");
  assert.ok(/as unknown as InviteResponse/.test(send), "and the fetch result is read through it");
});

/* ── The migration chain ────────────────────────────────────── */

test("I18 the grant lives in its own forward migration, not backdated into 024", async () => {
  // 024 has already run in production. Editing it would make the repository
  // describe a history no environment executed, and would hide the omission
  // instead of correcting it.
  const created = await readFile(migrationPath, "utf8");
  const repair = await readFile(grantMigrationPath, "utf8");

  assert.ok(!/grant[^;]*staff_invitations[^;]*service_role/.test(created), "024 keeps its applied shape");
  assert.ok(/grant[^;]*on table public\.staff_invitations[^;]*to service_role/s.test(repair));
  for (const privilege of ["select", "insert", "update", "delete"]) {
    assert.ok(repair.includes(privilege), `the repair must grant ${privilege}`);
  }
  assert.ok(!/\bto\s+anon\b|\bto\s+authenticated\b|\bto\s+public\b/.test(repair), "the repair touches no browser role");
  assert.ok(!/alter default privileges/.test(repair), "and makes no statement about future tables");
});

/* ── The router gates, end to end ───────────────────────────── */

type MockResponse = {
  statusCode: number;
  body: Record<string, unknown>;
  status: (code: number) => MockResponse;
  setHeader: () => MockResponse;
  json: (payload: unknown) => MockResponse;
};

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 0,
    body: {},
    status(code) { res.statusCode = code; return res; },
    setHeader() { return res; },
    json(payload) { res.body = (payload ?? {}) as Record<string, unknown>; return res; },
  };
  return res;
}

type StaffRow = { id: string; workspace_id: string; role: string; status: string };
type QueryLog = { table: string; op: string; filters: Record<string, unknown> };

const INVITEE_EMAIL = "invited@clinic.test";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const TOKEN = "header.payload.signature";
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

/**
 * Drives the real CRM router with a mocked Supabase Auth endpoint and a spying
 * database client, so these assertions are about what the deployed code does
 * rather than about what its source looks like.
 */
async function loadRouter(options: { memberships?: StaffRow[]; authOk?: boolean; rows?: Record<string, unknown[]> } = {}) {
  const log: QueryLog[] = [];
  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as { url?: string })?.url ?? "");
    if (url.includes("/auth/v1/user")) {
      const ok = options.authOk !== false;
      return { ok, status: ok ? 200 : 401, text: async () => (ok ? JSON.stringify({ id: USER_A, email: INVITEE_EMAIL }) : "{}") };
    }
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };

  const rows: Record<string, unknown[]> = { staff_users: options.memberships ?? [], ...(options.rows ?? {}) };
  supabaseModule.setSupabaseServerClientFactoryForTests(() => ({
    from(table: string) {
      const entry: QueryLog = { table, op: "select", filters: {} };
      log.push(entry);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: () => chain(),
        insert: (row: unknown) => { entry.op = "insert"; entry.filters.__row = row; return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.filters.__row = row; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        eq(column: string, value: unknown) { entry.filters[column] = value; return chain(); },
        ilike(column: string, value: unknown) { entry.filters[column] = value; return chain(); },
        is(column: string, value: unknown) { entry.filters["is:" + column] = value; return chain(); },
        maybeSingle: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        then(resolve: (value: { data: unknown; error: null }) => void) {
          resolve({ data: rows[table] ?? [], error: null });
        },
      });
      return builder;
    },
  }));

  const router = (await import(pathToFileURL(path.join(repoRoot, "api", "crm", "[...path].ts")).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  const call = async (input: { segments: string[]; method?: string; query?: Record<string, unknown>; body?: unknown; token?: string | null }) => {
    log.length = 0;
    const res = mockResponse();
    await router.default(
      {
        method: input.method ?? "GET",
        url: "/api/crm/" + input.segments.join("/"),
        query: { path: input.segments, ...(input.query ?? {}) },
        body: input.body ?? {},
        headers: input.token === null ? {} : { authorization: "Bearer " + (input.token ?? TOKEN) },
      },
      res,
    );
    return { status: res.statusCode, body: res.body, log: [...log] };
  };

  const restore = () => {
    globalThis.fetch = originalFetch;
    supabaseModule.setSupabaseServerClientFactoryForTests(null);
  };

  return { call, restore };
}

const owner: StaffRow = { id: STAFF_A, workspace_id: WORKSPACE_A, role: "owner", status: "active" };

test("I19 creating an invitation requires a token, a membership and the permission", async () => {
  const anonymous = await loadRouter();
  try {
    const res = await anonymous.call({ segments: ["staff-invitations"], method: "POST", token: null, body: { email: "a@b.test", role: "manager" } });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "authentication_required");
    assert.equal(res.log.length, 0, "no query runs before the token is checked");
  } finally {
    anonymous.restore();
  }

  const noMembership = await loadRouter({ memberships: [] });
  try {
    const res = await noMembership.call({ segments: ["staff-invitations"], method: "POST", body: { email: "a@b.test", role: "manager" } });
    assert.equal(res.status, 403, "a verified user with no membership is not an administrator");
  } finally {
    noMembership.restore();
  }

  const inactive = await loadRouter({ memberships: [{ ...owner, status: "inactive" }] });
  try {
    const res = await inactive.call({ segments: ["staff-invitations"], method: "POST", body: { email: "a@b.test", role: "manager" } });
    assert.equal(res.status, 403, "a suspended membership cannot invite");
  } finally {
    inactive.restore();
  }

  const receptionist = await loadRouter({ memberships: [{ ...owner, role: "receptionist" }] });
  try {
    const res = await receptionist.call({ segments: ["staff-invitations"], method: "POST", body: { email: "a@b.test", role: "manager" } });
    assert.equal(res.status, 403, "manage_staff is required");
    assert.equal(res.body.code, "workspace_access_denied");
  } finally {
    receptionist.restore();
  }
});

test("I20 the workspace comes from the verified context, never from the caller", async () => {
  const { call, restore } = await loadRouter({ memberships: [owner] });
  try {
    const foreign = await call({ segments: ["staff-invitations"], method: "GET", query: { workspaceId: WORKSPACE_B } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, "workspace_access_denied");

    // A workspace in the body is not a selector and must not become one.
    const bodyOverride = await call({
      segments: ["staff-invitations"],
      method: "GET",
      query: { workspaceId: WORKSPACE_A },
      body: { workspaceId: WORKSPACE_B, workspace_id: WORKSPACE_B },
    });
    assert.equal(bodyOverride.status, 200);
    const reads = bodyOverride.log.filter((entry) => entry.table === "staff_invitations");
    assert.ok(reads.length > 0, "the list actually queried the table");
    for (const read of reads) {
      assert.equal(read.filters.workspace_id, WORKSPACE_A, "every query is scoped to the verified workspace");
    }
  } finally {
    restore();
  }
});

test("I21 redemption needs a verified session and never trusts the body", async () => {
  const anonymous = await loadRouter();
  try {
    const res = await anonymous.call({ segments: ["staff-invitations", "accept"], method: "POST", token: null, body: { token: "x" } });
    assert.equal(res.status, 401);
    assert.equal(res.log.length, 0, "an unauthenticated redemption touches no table");
  } finally {
    anonymous.restore();
  }

  const rejected = await loadRouter({ authOk: false });
  try {
    const res = await rejected.call({ segments: ["staff-invitations", "accept"], method: "POST", body: { token: "x" } });
    assert.equal(res.status, 401, "a token Supabase refuses is not a session");
  } finally {
    rejected.restore();
  }

  // A session whose address does not match the invitation is refused, and the
  // body cannot supply either the address or the identity.
  const mismatched = await loadRouter({
    rows: {
      staff_invitations: [{
        id: "11111111-1111-4111-8111-11111111aaaa",
        workspace_id: WORKSPACE_A,
        email: "someone.else@clinic.test",
        role: "manager",
        expires_at: future,
        accepted_at: null,
        revoked_at: null,
        created_at: past,
        token_hash: "deadbeef",
      }],
    },
  });
  try {
    const res = await mismatched.call({
      segments: ["staff-invitations", "accept"],
      method: "POST",
      body: { token: "anything", email: "someone.else@clinic.test", authUserId: "99999999-9999-4999-8999-999999999999" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "invitation_email_mismatch");
    assert.ok(
      !res.log.some((entry) => entry.table === "staff_users" && entry.op === "insert"),
      "no membership is written for the wrong person",
    );
  } finally {
    mismatched.restore();
  }
});

test("I22 the invitation routes are reachable only as registered", async () => {
  const { call, restore } = await loadRouter({ memberships: [owner] });
  try {
    const wrongMethod = await call({ segments: ["staff-invitations"], method: "DELETE", token: null });
    assert.equal(wrongMethod.status, 405);

    const acceptGet = await call({ segments: ["staff-invitations", "accept"], method: "GET", token: null });
    assert.equal(acceptGet.status, 405);

    // A first segment that is not registered is a 404.
    const unknown = await call({ segments: ["staff-invitations-nope"], method: "POST", token: null });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "resource_not_found");

    // An unregistered *sub*-path resolves to its parent — video-processing-jobs
    // relies on trailing segments, so the router does not reject them wholesale.
    // What matters is that it gains nothing: same gate, same refusal.
    const subPath = await call({ segments: ["staff-invitations", "nope"], method: "POST", token: null });
    assert.equal(subPath.status, 401, "a sub-path is never less protected than its parent");
  } finally {
    restore();
  }
});

/* ── Link hygiene and the browser half ──────────────────────── */

test("I23 the token travels in the query, survives messengers, and leaves the address bar", async () => {
  // Первая версия прятала токен во фрагмент ради чистоты логов — и первая же
  // настоящая передача салона сломалась: WhatsApp отбрасывает часть ссылки
  // после «#» при открытии во встроенном браузере. Query выбран сознательно:
  // токен одноразовый, привязан к почте и хранится хэшем — выуженный из лога,
  // он не открывает ничего. Старые фрагментные ссылки продолжают работать.
  const server = await readFile(modulePath, "utf8");
  const link = server.slice(server.indexOf("function acceptUrl"), server.indexOf("function auditInvitation"));
  assert.ok(link.includes("/join?token="), "ссылка обязана переживать мессенджеры");
  assert.ok(!link.includes("/join#token="), "фрагментная форма больше не выписывается");

  const page = await readFile(path.join(negisSrc, "pages", "JoinWorkspace.tsx"), "utf8");
  assert.ok(page.includes('window.location.search).get("token")'), "страница читает query");
  assert.ok(page.includes("location.hash"), "и старый фрагмент — уже отправленные ссылки живы");
  assert.ok(page.includes("history.replaceState"), "and removes it from the address bar once captured");
  assert.ok(
    page.indexOf("history.replaceState") < page.indexOf("return captured"),
    "the URL is cleaned before the token is handed on",
  );
  assert.ok(!/console\.(log|warn|error)\([^)]*token/i.test(page), "the token is never logged");
});

test("I24 the audit trail is useful and carries nothing sensitive", async () => {
  const server = await readFile(modulePath, "utf8");
  const audit = server.slice(server.indexOf("function auditInvitation"), server.indexOf("/** GET / POST / PATCH"));

  for (const event of ["created", "revoked", "redeemed", "redemption_refused"]) {
    assert.ok(server.includes('auditInvitation("' + event + '"'), event + " must be observable");
  }
  assert.ok(!/token/i.test(audit), "the audit helper cannot carry token material");

  for (const match of server.matchAll(/auditInvitation\([^)]*\)/gs)) {
    assert.ok(!/token/i.test(match[0]), "audit call must not include a token");
    assert.ok(!/\bemail\b(?!Sent|Status)/.test(match[0]), "audit call must not include an address");
  }
});

test("I25 the Admin Center no longer invents passwords or fakes a local save", async () => {
  const admin = await readFile(path.join(negisSrc, "pages", "AdminCenter.tsx"), "utf8");

  assert.ok(!admin.includes("temporaryPassword"), "no temporary password is generated for a colleague");
  assert.ok(!admin.includes("defaultTemporaryPassword("));
  assert.ok(!/Сотрудник сохранен локально|Сотрудник добавлен/.test(admin), "no claim of success the server did not make");
  assert.ok(!admin.includes('writeStored("negis_demo_staff"'), "a staff member is never persisted to localStorage");

  assert.ok(admin.includes("sendInvitation") && admin.includes("revokeInvitation"), "invite and revoke are wired");
  assert.ok(admin.includes("acceptUrl"), "the link is shown once so it can be passed on by hand");

  // The team shown is the team the server has. It used to be seeded from a demo
  // blob and written back to it, so the table listed people who were not
  // members and "suspending" someone changed nothing but this browser.
  assert.ok(admin.includes("async function loadStaff"), "the staff list is read from the server");
  assert.ok(/crmRequest\([^)]*\/api\/crm\/staff\?/.test(admin), "and through the authorized helper");
  assert.ok(!admin.includes("staffDefaults"), "no demo roster remains");
  const statusChange = admin.slice(admin.indexOf("async function updateStaffStatus"));
  assert.ok(/method: "PATCH"/.test(statusChange.slice(0, 700)), "a status change reaches the server");
  assert.ok(!/writeStored\(/.test(statusChange.slice(0, 700)), "and is not faked locally when it fails");
});

test("I26 the invited person gets a controlled message for every refusal", async () => {
  const page = await readFile(path.join(negisSrc, "pages", "JoinWorkspace.tsx"), "utf8");
  for (const code of [
    "invitation_not_found",
    "invitation_expired",
    "invitation_revoked",
    "invitation_accepted",
    "invitation_email_mismatch",
  ]) {
    assert.ok(page.includes(code), code + " needs its own Russian copy");
  }
  assert.ok(page.includes("crmErrorMessage"), "and anything else falls back to the shared copy");
  assert.ok(!page.includes("supabase.from("), "the page reads no table directly");
  assert.ok(!page.includes(".channel(") && !page.includes("/rest/v1"), "and opens no Data API or Realtime path");
});

test("I27 an existing account does not leak through the invitation response", async () => {
  const server = await readFile(modulePath, "utf8");
  const invite = server.slice(server.indexOf("async function sendSupabaseInviteEmail"), server.indexOf("function acceptUrl"));
  const post = server.slice(server.indexOf('if (method === "POST")'), server.indexOf("// PATCH — revoke"));

  // Supabase answers 422 when the address already has an account. That is a
  // fact about a person, so it is reduced to a status and the provider's body,
  // which may echo the address, is never read.
  assert.ok(invite.includes("already_registered"));
  assert.ok(!invite.includes("response.text()"), "the provider's body is not read");
  assert.ok(!invite.includes("response.json()"));
  assert.ok(post.includes("emailSent"), "the caller is told plainly whether mail went out");
});

test("I28 nothing creates a workspace without a verified owner", async () => {
  // /api/auth/register is disabled, and the insert it used to call is gone. A
  // dead function that creates tenants is the next caller's mistake waiting to
  // happen; real provisioning has to write the workspace and its owner
  // membership together, against a verified identity.
  const register = await readFile(path.join(repoRoot, "api", "auth", "register.ts"), "utf8");
  assert.ok(register.includes("self_registration_disabled"));
  assert.ok(register.includes("bodyParser: false"), "the body is not even parsed");
  assert.ok(!register.includes("getSupabaseServerClient"), "and no client is built");

  const roots = [path.join(repoRoot, "lib"), path.join(repoRoot, "api")];
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const source = await readFile(full, "utf8");
      if (/from\("workspaces"\)[\s\S]{0,120}\.insert\(/.test(source)) {
        offenders.push(path.relative(repoRoot, full));
      }
    }
  };
  for (const root of roots) await walk(root);
  // Разрешены ровно два места — оба пути подключения клиники с портала, оба
  // за requirePlatformOwner, и правило «пространство пишется вместе с
  // проверенным владельцем» держат по-разному: инвайт-путь выписывает
  // owner-приглашение (членство создаст погашение токена, привязанного к
  // почте), парольный путь создаёт auth-аккаунт ДО пространства и вписывает
  // членство с auth_user_id этого аккаунта в том же проходе (2026-08-17,
  // явное решение владельца платформы: подключение без письма). Ниже пины
  // держат условия допуска — исчезнет любое, и допуск теряет силу.
  const allowed = [
    path.join("lib", "crm", "platform-onboarding-credentials.ts"),
    path.join("lib", "crm", "platform-onboarding.ts"),
  ];
  assert.deepEqual(offenders.sort(), allowed, "these files can create a tenant outside an enrollment flow");

  const onboarding = await readFile(path.join(repoRoot, "lib", "crm", "platform-onboarding.ts"), "utf8");
  assert.ok(/createInvitationToken\(\)/.test(onboarding) && /role: "owner"/.test(onboarding),
    "владелец входит через приглашение, а не вписывается строкой");
  const creds = await readFile(path.join(repoRoot, "lib", "crm", "platform-onboarding-credentials.ts"), "utf8");
  assert.ok(
    creds.indexOf("/auth/v1/admin/users") < creds.indexOf('from("workspaces")') &&
      /auth_user_id: authUserId/.test(creds),
    "парольный путь: сначала проверенная личность, потом пространство, членство — с её auth_user_id",
  );
  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");
  assert.ok(
    /"platform-onboarding": \{ kind: "platform"/.test(registry) &&
      /"platform-onboarding-credentials": \{ kind: "platform"/.test(registry),
    "и создать пространство может только владелец платформы",
  );
});

test("I29 the landing page offers only flows that exist", async () => {
  const raw = await readFile(path.join(negisSrc, "pages", "Landing.tsx"), "utf8");
  // Read the code, not the comments explaining what was removed. The page route
  // /reset-password is real and stays; the API path is the one that never was.
  const landing = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  assert.ok(!landing.includes("/api/auth/register"), "the dead registration call is gone");
  assert.ok(!landing.includes("/api/auth/reset-password"), "so is the endpoint that never existed");
  assert.ok(!landing.includes("registerSchema"), "and the form that fed them");
  assert.ok(landing.includes("resetPasswordForEmail"), "reset goes through Supabase Auth, which owns the recovery link");
  assert.ok(
    landing.includes("Доступ для новой клиники открывает владелец"),
    "and the page says plainly how access is obtained instead of showing a CTA that cannot succeed",
  );
});
