// Run: node scripts/fixtures/control-subscription-browser.mjs --port=5236
// Synthetic, bounded in-memory HTTP behavior, not a SQL implementation or test.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/medina-control");
const controlPath = "/__fixture/control-subscription";
const subscriptionPath = "/api/crm/platform-subscriptions";
const overviewPath = "/api/crm/platform-overview";
const operatorPath = "/api/crm/platform-operators";
const onboardingPath = "/api/crm/platform-onboarding";
const credentialsPath = "/api/crm/platform-onboarding-credentials";
const reissuePath = "/api/crm/platform-invitation-reissue";
const ownerRoutes = new Set([operatorPath, onboardingPath, credentialsPath, reissuePath]);
const pageQuery = "?subscriptions=qa";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = Object.freeze({
  A: "11111111-1111-4111-8111-111111111111",
  B: "22222222-2222-4222-8222-222222222222",
  W1: "aaaaaaaa-1111-4111-8111-111111111111",
  W2: "bbbbbbbb-2222-4222-8222-222222222222",
});
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
const copy = (value) => structuredClone(value);
const ok = (data) => ({ success: true, data });
const exact = (value, required, optional = []) => required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (status, code) => Object.assign(new Error(code), { status, code });

function localOrigin(req) {
  const host = req.headers.host || "";
  if (!/^127\.0\.0\.1:\d{1,5}$/.test(host) || req.socket.encrypted
    || !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) return null;
  const origin = `http://${host}`;
  return (req.headers.origin === undefined || req.headers.origin === origin)
    && req.headers["sec-fetch-site"] !== "cross-site" ? origin : null;
}

function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
  res.end(JSON.stringify(body));
}

async function readJson(req, assertCurrent) {
  assertCurrent();
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw fail(415, "json_required");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    assertCurrent();
    bytes += chunk.length;
    if (bytes > 8192) throw fail(413, "fixture_body_limit");
    chunks.push(chunk);
  }
  assertCurrent();
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw fail(400, "invalid_json"); }
  if (!record(body)) throw fail(400, "object_required");
  return body;
}

function seed() {
  const item = (suffix, workspace, status, plan, price, period = "monthly") => ({
    id: `cccccccc-1111-4111-8111-${String(suffix).padStart(12, "0")}`, workspace_id: workspace,
    plan, status, price_minor: price, currency: "KZT", billing_period: period,
    started_at: `2026-0${suffix + 1}-01T08:00:00.000Z`, updated_at: "2026-10-24T08:00:00.000Z",
    created_at: "2026-01-01T08:00:00.000Z", ended_at: status === "cancelled" ? "2026-10-24T08:00:00.000Z" : null,
    note: "QA subscription - fictitious local fixture",
  });
  return [item(1, ids.W1, "active", "basic", 1_990_000),
    item(2, ids.W1, "paused", "standard", 3_990_000), item(3, ids.W1, "cancelled", "pro", 79_900_000, "yearly"),
    item(4, ids.W2, "paused", "standard", 47_880_000, "yearly"), item(5, ids.W2, "cancelled", "basic", 1_990_000)];
}

function seedOperators() {
  return ["pending", "approved", "suspended"].map((status, index) => ({
    id: `dddddddd-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    displayName: `QA operator - ${status}`, status, acceptingRequests: status === "approved",
  }));
}
const ownerCounts = () => ({ reads: 0, mutations: 0, operatorChanges: 0, onboardingInvites: 0,
  credentials: 0, reissues: 0, denied: 0 });

/** Does not start a server, read configuration, persist data, or perform outbound I/O. */
export function createControlSubscriptionHttpFixture() {
  let epoch = 0, closed = false;
  let rows = seed();
  let sequence = 0;
  let failAfterCommit = false;
  let counters = { commits: 0, replays: 0, abandons: 0, lostResponses: 0, refused: 0 };
  const operations = new Map();
  let operators = seedOperators(), ownerCounters = ownerCounts(), holdOwnerReply = false;
  let heldOwnerReply = null;
  const onboardings = new Map();
  const clinics = [{ id: ids.W1, name: "QA subscription - North", ownerEmail: "qa-north@example.invalid" },
    { id: ids.W2, name: "QA subscription - South", ownerEmail: "qa-south@example.invalid" }];
  const now = () => new Date(Date.UTC(2026, 9, 25, 9) + (++sequence * 1000)).toISOString();
  const active = (workspace) => rows.find((row) => row.workspace_id === workspace && row.status === "active");
  const isCurrent = (requestEpoch) => !closed && requestEpoch === epoch;
  function assertCurrent(requestEpoch) {
    if (!isCurrent(requestEpoch)) throw fail(409, "fixture_reset");
  }

  function snapshot() {
    return { fixture: "QA subscription", storage: "synthetic in-memory; not SQL", failAfterCommit,
      counters: { ...counters }, receipts: operations.size, historyRows: rows.length,
      ownerCounters: { ...ownerCounters }, holdOwnerReply, ownerReplyPending: Boolean(heldOwnerReply),
      heldOwnerReply: heldOwnerReply ? { method: heldOwnerReply.method, path: heldOwnerReply.path } : null,
      actors: { A: ids.A, B: ids.B }, clinics: copy(clinics) };
  }
  function finishOwnerReply(release, held = heldOwnerReply) {
    if (!held || heldOwnerReply !== held) return;
    heldOwnerReply = null;
    clearTimeout(held.timer);
    if (release && isCurrent(held.epoch)) send(held.res, held.status, held.body);
    else held.res.destroy();
  }
  function ownerReply(req, res, url, requestEpoch, status, body) {
    assertCurrent(requestEpoch);
    if (!holdOwnerReply || !["POST", "PATCH"].includes(req.method) || status < 200 || status >= 300) {
      return send(res, status, body);
    }
    holdOwnerReply = false;
    const held = { res, status, body: copy(body), epoch: requestEpoch, method: req.method, path: url.pathname,
      timer: setTimeout(() => finishOwnerReply(true, held), 60_000) };
    held.timer.unref();
    heldOwnerReply = held;
    res.once("close", () => {
      if (heldOwnerReply === held) { clearTimeout(held.timer); heldOwnerReply = null; }
    });
  }
  function overview() {
    const items = clinics.map((clinic, index) => {
      const row = active(clinic.id);
      return { ...clinic, createdAt: "2026-01-01T08:00:00.000Z", plan: row?.plan || "",
        subscriptionId: row?.id || "", subscriptionStatus: row?.status || "", priceMinor: row?.price_minor || 0,
        currency: row?.currency || "KZT", billingPeriod: row?.billing_period || "monthly",
        monthlyMinor: row ? row.billing_period === "yearly" ? Math.round(row.price_minor / 12) : row.price_minor : 0,
        staffCount: 3 + index, leadCount: 12 + index, appointmentCount: 7 + index,
        ownerAccess: { state: "inside", expiresAt: "" } };
    });
    return { clinics: items, totals: { clinics: items.length, withSubscription: items.filter((item) => item.plan).length,
      paying: items.filter((item) => item.monthlyMinor > 0).length, currency: "KZT", mixedCurrencies: false,
      monthlyRevenueMinor: items.reduce((sum, item) => sum + item.monthlyMinor, 0) } };
  }
  function receipt(operation, replayed) {
    return { item: copy(operation.item), operation: { actorId: operation.actorId, workspaceId: operation.workspaceId,
      requestKey: operation.requestKey, kind: operation.kind, state: operation.state, replayed } };
  }
  function workspace(value) {
    if (!clinics.some((clinic) => clinic.id === value)) throw fail(400, "workspace_required");
    return value;
  }
  function requestKey(value) {
    if (typeof value !== "string" || !uuid.test(value)) throw fail(400, "subscription_request_required");
    return value.toLowerCase();
  }
  function capacity() {
    if (operations.size >= 256 || rows.length >= 256) throw fail(409, "fixture_capacity_reset_required");
  }
  function normalize(body, kind) {
    if (kind === "replace") {
      if (!exact(body, ["workspaceId", "requestKey", "expectedActiveId", "plan", "priceMinor", "billingPeriod", "currency"], ["note"])
        || !["basic", "standard", "pro"].includes(body.plan) || !Number.isSafeInteger(body.priceMinor) || body.priceMinor < 0
        || !["monthly", "yearly"].includes(body.billingPeriod) || !/^[A-Z]{3}$/.test(body.currency)
        || (body.expectedActiveId !== null && (typeof body.expectedActiveId !== "string" || !uuid.test(body.expectedActiveId)))
        || (body.note !== undefined && body.note !== null && (typeof body.note !== "string" || body.note.length > 2000))) {
        throw fail(400, "subscription_operation_invalid");
      }
      return { expectedActiveId: body.expectedActiveId, plan: body.plan, priceMinor: body.priceMinor,
        billingPeriod: body.billingPeriod, currency: body.currency, note: body.note || null };
    }
    if (!exact(body, ["workspaceId", "requestKey", "subscriptionId", "expectedUpdatedAt", "expectedStatus", "status"])
      || typeof body.subscriptionId !== "string" || !uuid.test(body.subscriptionId)
      || typeof body.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.expectedUpdatedAt))
      || !["active", "paused", "cancelled"].includes(body.expectedStatus) || !["active", "paused", "cancelled"].includes(body.status)) {
      throw fail(400, "subscription_operation_invalid");
    }
    return { subscriptionId: body.subscriptionId, expectedUpdatedAt: body.expectedUpdatedAt,
      expectedStatus: body.expectedStatus, status: body.status };
  }
  function apply(actorId, workspaceId, key, kind, payload) {
    const mapKey = `${actorId}/${key}`;
    const existing = operations.get(mapKey);
    if (existing) {
      if (existing.workspaceId !== workspaceId) throw fail(409, "subscription_request_conflict");
      if (existing.state === "abandoned") throw fail(409, "subscription_request_abandoned");
      if (existing.kind !== kind || JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw fail(409, "subscription_request_conflict");
      counters.replays++;
      return { data: receipt(existing, true), fresh: false };
    }
    capacity();
    const current = active(workspaceId);
    let item;
    if (kind === "replace") {
      if ((current?.id || null) !== payload.expectedActiveId) throw fail(409, "subscription_conflict");
      const timestamp = now();
      if (current) { current.status = "cancelled"; current.ended_at = timestamp; current.updated_at = timestamp; }
      item = { id: randomUUID(), workspace_id: workspaceId, plan: payload.plan, status: "active", price_minor: payload.priceMinor,
        currency: payload.currency, billing_period: payload.billingPeriod, note: payload.note,
        started_at: timestamp, updated_at: timestamp, created_at: timestamp, ended_at: null };
      rows.push(item);
    } else {
      item = rows.find((row) => row.id === payload.subscriptionId && row.workspace_id === workspaceId);
      if (!item || item.updated_at !== payload.expectedUpdatedAt || item.status !== payload.expectedStatus
        || (item.status === "cancelled" && payload.status !== "cancelled")
        || (payload.status === "active" && current && current.id !== item.id)) throw fail(409, "subscription_conflict");
      if (item.status !== payload.status) {
        item.status = payload.status; item.updated_at = now();
        item.ended_at = payload.status === "cancelled" ? item.updated_at : null;
      }
    }
    const operation = { actorId, workspaceId, requestKey: key, kind, payload: copy(payload), state: "committed", item: copy(item) };
    operations.set(mapKey, operation);
    counters.commits++;
    return { data: receipt(operation, false), fresh: true };
  }

  async function ownerRequest(req, res, url, requestEpoch) {
    const current = () => assertCurrent(requestEpoch);
    const reply = (status, body) => ownerReply(req, res, url, requestEpoch, status, body);
    current();
    const method = req.method || "GET";
    if (url.pathname === operatorPath) {
      if (method === "GET") {
        const offset = url.searchParams.get("offset") ?? "0";
        if ([...url.searchParams.keys()].some((key) => key !== "offset") || url.searchParams.getAll("offset").length > 1
          || !/^\d{1,6}$/.test(offset)) throw fail(400, "fixture_operator_page_invalid");
        ownerCounters.reads++;
        const start = Number(offset);
        return reply(200, ok({ items: copy(operators.slice(start, start + 20)), hasMore: operators.length > start + 20 }));
      }
      if (method !== "PATCH" || url.search) throw fail(403, "fixture_method_forbidden");
      const body = await readJson(req, current);
      current();
      if (!exact(body, ["id", "action"]) || !["approve", "suspend"].includes(body.action)) throw fail(400, "fixture_operator_action_invalid");
      const profile = operators.find((item) => item.id === body.id);
      if (!profile || !(body.action === "approve" ? ["pending", "suspended"] : ["approved"]).includes(profile.status)) {
        throw fail(409, "fixture_operator_status_conflict");
      }
      profile.status = body.action === "approve" ? "approved" : "suspended";
      profile.acceptingRequests = false;
      ownerCounters.operatorChanges++; ownerCounters.mutations++;
      return reply(200, ok(copy(profile)));
    }
    if (method !== "POST" || url.search) throw fail(403, "fixture_method_forbidden");
    const body = await readJson(req, current);
    current();
    const origin = localOrigin(req);
    if (url.pathname === reissuePath) {
      if (!exact(body, ["workspaceId"])) throw fail(400, "workspace_required");
      const existing = onboardings.get(body.workspaceId);
      if (!existing) return send(res, 404, { success: false, code: "not_found", error: "QA fixture: not found" });
      ownerCounters.reissues++; ownerCounters.mutations++;
      const data = { ...existing, acceptUrl: `${origin}/__fixture/invitation-not-live/${existing.workspaceId}?revision=${ownerCounters.reissues}` };
      onboardings.set(existing.workspaceId, data);
      return reply(201, ok(copy(data)));
    }
    const credentials = url.pathname === credentialsPath;
    const required = ["name", "vertical", "ownerName", "timeZone", "purpose"];
    const optional = credentials ? ["ownerEmail", "ownerLogin", "password"] : ["ownerEmail", "confirmAdditionalWorkspace"];
    if (!exact(body, required, optional) || typeof body.name !== "string" || !body.name.trim() || body.name.length > 120
      || typeof body.ownerName !== "string" || body.ownerName.length > 120
      || !["clinic_services", "mortgage_leads", "marketing"].includes(body.purpose)
      || !["", "clinic", "dental", "beauty"].includes(body.vertical) || typeof body.timeZone !== "string"
      || !/^[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(body.timeZone)
      || (credentials && (body.purpose === "marketing" || typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128))) {
      throw fail(400, "fixture_onboarding_invalid");
    }
    const loginOnly = credentials && typeof body.ownerLogin === "string" && /^[a-z0-9][a-z0-9.]{2,23}$/.test(body.ownerLogin);
    if (!loginOnly && (typeof body.ownerEmail !== "string" || !/^[a-z0-9._+-]+@example\.invalid$/i.test(body.ownerEmail))) {
      return send(res, 400, { success: false, code: "fixture_identity_required", error: "QA fixture: use a fictitious @example.invalid owner or synthetic login" });
    }
    const email = loginOnly ? `qa-${body.ownerLogin}@example.invalid` : body.ownerEmail.toLowerCase();
    const existing = [...onboardings.values()].find((item) => item.ownerEmail === email);
    if (existing && body.confirmAdditionalWorkspace !== true) {
      return reply(409, { success: false, code: "invitation_already_pending",
        error: "QA fixture: synthetic owner already has a pending workspace", data: { existingWorkspaceId: existing.workspaceId } });
    }
    if (onboardings.size >= 16) throw fail(409, "fixture_capacity_reset_required");
    // Explicit DTO only: request passwords never enter the in-memory store, receipts, or counters.
    const data = { workspaceId: randomUUID(), name: `QA onboarding - ${body.name.trim()}`, vertical: body.vertical || null,
      purpose: body.purpose, ownerEmail: email, ownerLogin: loginOnly ? body.ownerLogin : "", ownerLoginOnly: Boolean(loginOnly),
      timeZone: body.timeZone, loginUrl: `${origin}/__fixture/login-not-live`,
      invitationExpiresAt: "2026-12-31T23:59:59.000Z", emailSent: false,
      emailStatus: loginOnly ? "login_only" : "fixture_not_sent" };
    data.acceptUrl = `${origin}/__fixture/invitation-not-live/${data.workspaceId}`;
    onboardings.set(data.workspaceId, data);
    clinics.push({ id: data.workspaceId, name: data.name, ownerEmail: data.ownerEmail });
    if (credentials) ownerCounters.credentials++; else ownerCounters.onboardingInvites++;
    ownerCounters.mutations++;
    return reply(201, ok(copy(data)));
  }

  async function dispatch(req, res, url, requestEpoch) {
    const current = () => assertCurrent(requestEpoch);
    current();
    if (!localOrigin(req)) throw fail(403, "loopback_same_origin_required");
    const method = req.method || "GET";
    if (url.pathname === controlPath) {
      if (url.search) throw fail(400, "fixture_query_forbidden");
      if (method === "GET") return send(res, 200, snapshot());
      if (method !== "POST") throw fail(403, "fixture_method_forbidden");
      const body = await readJson(req, current);
      current();
      if (body.command === "reset" && exact(body, ["command"])) {
        epoch++;
        finishOwnerReply(false); holdOwnerReply = false;
        operators = seedOperators(); ownerCounters = ownerCounts(); onboardings.clear(); clinics.splice(2);
        rows = seed(); operations.clear(); sequence = 0; failAfterCommit = false;
        counters = { commits: 0, replays: 0, abandons: 0, lostResponses: 0, refused: 0 };
      } else if (body.command === "failAfterCommit" && exact(body, ["command", "enabled"]) && typeof body.enabled === "boolean") {
        failAfterCommit = body.enabled;
      } else if (body.command === "holdOwnerReply" && exact(body, ["command", "enabled"]) && typeof body.enabled === "boolean") {
        if (heldOwnerReply) throw fail(409, "fixture_reply_already_held");
        holdOwnerReply = body.enabled;
      } else if (body.command === "releaseOwnerReply" && exact(body, ["command"])) {
        finishOwnerReply(true);
      } else throw fail(400, "fixture_command_forbidden");
      return send(res, 200, snapshot());
    }
    const actor = req.headers.authorization === "Bearer fixture-control-A" ? "A"
      : req.headers.authorization === "Bearer fixture-control-B" ? "B" : null;
    if (!actor) throw fail(401, "fixture_actor_required");
    if (ownerRoutes.has(url.pathname)) {
      if (actor !== "A") {
        ownerCounters.denied++;
        return send(res, 404, { success: false, code: "not_found", error: "QA fixture: not found" });
      }
      return ownerRequest(req, res, url, requestEpoch);
    }
    if (url.pathname === overviewPath) {
      if (method !== "GET" || url.search) throw fail(403, "fixture_route_forbidden");
      return send(res, 200, ok(overview()));
    }
    if (method === "GET") {
      if ([...url.searchParams.keys()].some((key) => !["workspaceId", "requestKey"].includes(key))
        || url.searchParams.getAll("workspaceId").length !== 1 || url.searchParams.getAll("requestKey").length > 1) throw fail(400, "invalid_query");
      const workspaceId = workspace(url.searchParams.get("workspaceId"));
      if (url.searchParams.has("requestKey")) {
        const key = requestKey(url.searchParams.get("requestKey"));
        const operation = operations.get(`${ids[actor]}/${key}`);
        return send(res, 200, ok(operation?.workspaceId === workspaceId ? receipt(operation, true) : { item: null, operation: null }));
      }
      return send(res, 200, ok({ items: copy(rows.filter((row) => row.workspace_id === workspaceId)
        .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id))) }));
    }
    if (!["POST", "PATCH"].includes(method) || url.search) throw fail(403, "fixture_method_forbidden");
    const body = await readJson(req, current);
    current();
    const workspaceId = workspace(body.workspaceId), key = requestKey(body.requestKey), actorId = ids[actor];
    if (Object.hasOwn(body, "abandon")) {
      if (method !== "POST" || body.abandon !== true || !exact(body, ["workspaceId", "requestKey", "abandon"])) throw fail(400, "subscription_operation_invalid");
      const mapKey = `${actorId}/${key}`;
      let operation = operations.get(mapKey);
      const replayed = Boolean(operation);
      if (operation && operation.workspaceId !== workspaceId) throw fail(409, "subscription_request_conflict");
      if (!operation) {
        capacity();
        operation = { actorId, workspaceId, requestKey: key, kind: null, state: "abandoned", item: null };
        operations.set(mapKey, operation); counters.abandons++;
      }
      return send(res, 200, ok(receipt(operation, replayed)));
    }
    const kind = method === "POST" ? "replace" : "status";
    const result = apply(actorId, workspaceId, key, kind, normalize(body, kind));
    if (result.fresh && failAfterCommit) {
      failAfterCommit = false; counters.lostResponses++;
      return send(res, 502, { success: false, code: "fixture_response_lost_after_commit", error: "QA subscription: response failed after in-memory commit" });
    }
    return send(res, method === "POST" ? 201 : 200, ok(result.data));
  }
  return {
    snapshot,
    close() { closed = true; epoch++; finishOwnerReply(false); },
    handle(req, res) {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (![controlPath, overviewPath, subscriptionPath].includes(url.pathname) && !ownerRoutes.has(url.pathname)) return false;
      const requestEpoch = epoch;
      void dispatch(req, res, url, requestEpoch).catch((error) => {
        if (!isCurrent(requestEpoch)) { res.destroy(); return; }
        counters.refused++;
        const status = Number.isInteger(error.status) ? error.status : 500;
        send(res, status, { success: false, code: status === 500 ? "fixture_internal_error" : error.code,
          error: status === 409 ? "QA subscription: conflicting or abandoned operation" : "QA subscription: local request refused" });
      });
      return true;
    },
  };
}

export async function startControlSubscriptionBrowser(port = 5236) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid loopback fixture port");
  for (const key of Object.keys(process.env)) {
    if (!["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"].includes(key)) delete process.env[key];
  }
  globalThis.fetch = async () => { throw new Error("Outbound fetch forbidden in control subscription fixture"); };
  const require = createRequire(path.join(frontend, "package.json"));
  const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
  const { default: react } = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href);
  const entry = path.join(root, "scripts/fixtures/control-subscription-browser.tsx");
  const mocks = path.join(root, "scripts/fixtures/control-subscription-browser-mocks.ts");
  const actualSupabase = path.join(frontend, "src/lib/supabase");
  const fixture = createControlSubscriptionHttpFixture();
  const server = await createServer({
    configFile: false, envDir: false, root: frontend, appType: "custom",
    cacheDir: path.join(tmpdir(), `medina-control-subscription-${port}`),
    optimizeDeps: { entries: [entry] },
    resolve: { dedupe: ["react", "react-dom"], alias: [
      ...["react", "react-dom"].map((name) => ({ find: new RegExp(`^${name}$`), replacement: require.resolve(name) })),
      ...["react", "react-dom"].map((name) => ({ find: new RegExp(`^${name}/`), replacement: `${path.dirname(require.resolve(`${name}/package.json`))}/` })),
    ] },
    plugins: [{
      name: "isolated-control-subscription", enforce: "pre",
      resolveId(source, importer) {
        if (source === "@supabase/supabase-js") return mocks;
        if (importer && source.startsWith(".")) {
          const resolved = path.resolve(path.dirname(importer.split("?")[0]), source).replace(/\.ts$/, "");
          if (resolved === actualSupabase) return mocks;
          if (resolved === path.join(frontend, "src/lib/control-config")) throw new Error("Real Control config is forbidden in this fixture");
        }
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!localOrigin(req)) return send(res, 403, { success: false, code: "loopback_same_origin_required" });
          const url = new URL(req.url || "/", "http://127.0.0.1");
          let pathname;
          try { pathname = decodeURIComponent(url.pathname).replaceAll("\\", "/"); }
          catch { return send(res, 400, { success: false, code: "invalid_path" }); }
          if (/(?:^|\/)\.env(?:[./]|$)|\/(?:supabase|control-config)\.ts(?:$|\/)|\/vite\.config\./i.test(pathname)) {
            return send(res, 403, { success: false, code: "real_configuration_forbidden" });
          }
          if (fixture.handle(req, res)) return;
          if (pathname.startsWith("/api/") || pathname.startsWith("/__fixture/")) return send(res, 403, { success: false, code: "unused_fixture_api_forbidden" });
          if (pathname === "/") {
            if (req.method !== "GET" || url.search !== pageQuery) return send(res, 403, { success: false, code: "exact_fixture_opt_in_required" });
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
              "Content-Security-Policy": csp, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
            // HMR is disabled; no Vite client or websocket is needed for acceptance.
            res.end(`<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/src/styles.css?direct"><title>QA subscription - Medina Control</title></head><body><div id="root"></div><script type="module" src="/@fs/${entry.replaceAll("\\", "/")}"></script></body></html>`);
            return;
          }
          if (req.headers["sec-fetch-dest"] === "document" || req.headers.accept?.includes("text/html")) return send(res, 404, { success: false, code: "not_a_fixture_page" });
          next();
        });
      },
    }, react()],
    server: { host: "127.0.0.1", port, strictPort: true, cors: false, hmr: false, fs: { allow: [root] } },
  });
  await server.listen();
  const url = `http://127.0.0.1:${port}/${pageQuery}`;
  console.log(`CONTROL_SUBSCRIPTION_FIXTURE pid=${process.pid} url=${url}`);
  return { server, fixture, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => !/^--port=\d+$/.test(arg)) || process.argv.length > 3) throw new Error("Use only --port=<loopback port>");
  const port = Number(process.argv[2]?.slice("--port=".length) || 5236);
  const { server, fixture } = await startControlSubscriptionBrowser(port);
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
    if (closing) return;
    closing = true; fixture.close(); await server.close(); process.exit(0);
  });
}
