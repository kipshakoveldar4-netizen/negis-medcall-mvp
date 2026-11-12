// Deliberately local and synthetic: no SDK, config, persistence, or outbound I/O.
const IDS = Object.freeze({
  A: "11111111-1111-4111-8111-111111111111",
  B: "22222222-2222-4222-8222-222222222222",
  W1: "aaaaaaaa-1111-4111-8111-111111111111",
  W2: "bbbbbbbb-2222-4222-8222-222222222222",
});
const CONTROL = "/__fixture/ads-reports";
const RESOURCES = new Map([
  ...["meta-launches", "auth-context", "meta-insights-history", "advertising-outcomes", "meta-summary", "workspace-settings", "health", "content-videos"]
    .map((resource) => [`/api/crm/${resource}`, resource]),
  ["/api/content-studio/status", "content-studio-status"],
  ["/api/content-studio/usage", "content-usage"],
]);
const ARMABLE = ["meta-launches", "auth-context", "meta-insights-history", "advertising-outcomes", "content-usage"];
const ROLES = ["owner", "admin", "lead_manager"];
const SHAPES = ["valid", "null-spend", "object-summaries", "foreign-auth", "contradictory-role"];
const NOW = "2026-10-23T08:00:00.000Z";
const MAX_PENDING = 32;
const MAX_ARMS = 32;
const MAX_BODY = 4096;
const copy = (value) => JSON.parse(JSON.stringify(value));
const ok = (data) => ({ success: true, mode: "supabase", data });
const error = (status) => ({ success: false, mode: "supabase", error: `QA fixture request denied (${status})` });
const counters = () => ({ received: 0, completed: 0, aborted: 0 });

function localOrigin(req) {
  const host = req.headers.host;
  if (typeof host !== "string") return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.host !== host || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) return null;
    if (req.headers.origin !== undefined && req.headers.origin !== url.origin) return null;
    return url.origin;
  } catch { return null; }
}

function payload(resource, actor, workspace, role, revision) {
  const marker = `QA ${actor} r${revision} ${workspace}`;
  const step = revision % 1000;
  const launchId = (index) => `${actor === "A" ? "a" : "b"}${workspace === "W1" ? "1" : "2"}00000${index}-1111-4111-8111-111111111111`;
  const meta = { configured: false, hasAccessToken: false, videoLaunchEnabled: false,
    videoOptimization: { enabled: false, workerSecretConfigured: false } };
  const data = { revision, fixtureMarker: marker };
  switch (resource) {
    case "auth-context": return ok({ ...data, workspaceId: IDS[workspace], userId: IDS[actor], staffUserId: IDS[actor],
      role, isAdmin: role === "owner" || role === "admin", purpose: "clinic_services" });
    case "meta-launches": return ok({ ...data, launches: [1, 2].map((index) => ({
      id: launchId(index), campaignName: `${marker} - PAUSED ${index === 1 ? "fresh" : "stale mixed"}`,
      status: "paused", metaStatus: "PAUSED", metaCampaignId: `qa-only-${actor}-${workspace}-${index}`,
      budgetDailyMinor: 0, currency: index === 1 ? "USD" : "KZT", lastError: "",
      createdAt: `2026-10-2${index}T07:00:00.000Z`,
    })) });
    case "meta-insights-history": return ok({ ...data, summaries: [1, 2].map((index) => ({
      metaCampaignLaunchId: launchId(index), availability: "available", freshness: index === 1 ? "fresh" : "stale",
      coveredDateStart: "2026-10-20", coveredDateStop: "2026-10-21",
      latestFetchedAt: index === 1 ? NOW : "2026-10-01T08:00:00.000Z", rowCount: 2,
      spendByCurrency: (index === 1 ? ["USD"] : ["USD", "KZT"])
        .map((currency) => ({ currency, currencyExponent: 2, spendMinor: "0" })),
      impressions: String(100 * index + step), clicks: String(10 * index + step),
      inlineLinkClicks: String(5 * index + step), metaLeads: String(index + step),
    })) });
    case "advertising-outcomes": return ok({ ...data, outcomes: {
      attributedLeads: 7 + step, unattributedLeads: 2, paidAttributedDeals: 4, paidUnattributedDeals: 1,
      paidAppointmentDeals: 3, paidAttributedAppointmentDeals: 2, pendingDeals: 6,
      attributedRevenueByCurrency: [{ currency: "KZT", currencyExponent: 2, amountMinor: "0" }], generatedAt: NOW,
    } });
    case "health": case "meta-summary": return ok({ ...data, meta });
    case "workspace-settings": return ok({ ...data, settings: [], items: [] });
    case "content-studio-status": return ok({ ...data, configured: false, enabled: false,
      textEnabled: false, imageEnabled: false, videoEnabled: false });
    case "content-videos": return ok({ ...data, videos: [] });
    case "content-usage": return { success: true, mode: "tracked", data: { ...data,
      trackingAvailable: true, subscriptionActive: true, plan: "pro",
      planTitle: `QA quota ${actor}/${workspace} r${revision}`, periodStart: "2026-10-01", textRequests: revision,
      images: { used: revision === 1 ? 1 : 150, limit: 150, remaining: revision === 1 ? 149 : 0, enabled: true },
      videoSeconds: { used: revision === 1 ? 8 : 180, limit: 180, remaining: revision === 1 ? 172 : 0, enabled: true },
      videoSecondsPerGeneration: 8 } };
    default: throw new Error("Unknown fixture resource");
  }
}

function validCommand(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const exact = (required, optional = []) => required.every((key) => Object.hasOwn(body, key))
    && Object.keys(body).every((key) => required.includes(key) || optional.includes(key));
  switch (body.command) {
    case "reset": return exact(["command"]);
    case "actorRole": return exact(["command", "actor", "role"])
      && ["A", "B"].includes(body.actor) && ROLES.includes(body.role);
    case "actorWorkspace": return exact(["command", "actor", "workspace"])
      && ["A", "B"].includes(body.actor) && ["W1", "W2"].includes(body.workspace);
    case "revision": return exact(["command", "value"]) && Number.isSafeInteger(body.value) && body.value > 0;
    case "arm": return exact(["command", "resource", "phase"], ["status", "malformed", "shape"])
      && ARMABLE.includes(body.resource) && ["headers", "body"].includes(body.phase)
      && (!Object.hasOwn(body, "status") || [200, 401, 403, 500].includes(body.status))
      && (!Object.hasOwn(body, "malformed") || typeof body.malformed === "boolean")
      && (!Object.hasOwn(body, "shape") || (SHAPES.includes(body.shape)
        && (body.shape === "valid"
          || (["null-spend", "object-summaries"].includes(body.shape) && body.resource === "meta-insights-history")
          || (["foreign-auth", "contradictory-role"].includes(body.shape) && body.resource === "auth-context"))));
    case "release": return exact(["command"], ["id"])
      && (!Object.hasOwn(body, "id") || (typeof body.id === "string" && /^ads-report-[1-9]\d{0,15}$/.test(body.id)));
    default: return false;
  }
}

/** Bounded Node IncomingMessage/ServerResponse fixture; never starts a server. */
export function createAdvertisingReportsHttpFixture() {
  let roles = { A: "owner", B: "owner" };
  let workspaces = { A: "W1", B: "W1" };
  let revision = 1, sequence = 0, forbiddenWrites = 0, closed = false;
  let totals = counters();
  let byResource = Object.fromEntries([...RESOURCES.values()].map((key) => [key, counters()]));
  const active = new Map(), pending = new Map(), controls = new Set();
  const arms = [];

  function snapshot() {
    return copy({ roles, workspaces, revision, actorIds: { A: IDS.A, B: IDS.B }, workspaceIds: { W1: IDS.W1, W2: IDS.W2 },
      pending: [...pending.values()].map(({ id, resource, actor, status, phase }) => ({ id, resource, actor, status, phase })),
      armed: arms, requestCounters: { ...totals, inFlight: active.size, byResource }, forbiddenWrites, externalCalls: 0, closed });
  }

  function send(res, status, body) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(body));
  }

  function track(req, res, resource, actor) {
    const id = `ads-report-${++sequence}`;
    const count = byResource[resource], total = totals;
    total.received++; count.received++;
    const record = { id, resource, actor, req, res, finished: false };
    active.set(id, record);
    const finish = (aborted) => {
      if (record.finished) return;
      record.finished = true;
      const key = aborted ? "aborted" : "completed";
      total[key]++; count[key]++;
      active.delete(id); pending.delete(id);
      req.off("aborted", onAbort); res.off("finish", onFinish); res.off("close", onClose); res.off("error", onAbort);
    };
    const onAbort = () => finish(true);
    const onFinish = () => finish(false);
    const onClose = () => finish(!res.writableFinished);
    Object.assign(record, { finish });
    req.once("aborted", onAbort); res.once("finish", onFinish); res.once("close", onClose); res.once("error", onAbort);
    return record;
  }

  function abortAll() {
    for (const record of active.values()) { record.finish(true); record.res.destroy(); }
    pending.clear(); arms.length = 0;
  }

  function apply(command) {
    if (command.command === "arm" && arms.length >= MAX_ARMS) return false;
    if (command.command === "release") {
      const record = command.id ? pending.get(command.id) : pending.values().next().value;
      if (!record || record.finished || record.res.destroyed) return false;
      pending.delete(record.id);
      record.release();
    } else if (command.command === "reset") {
      abortAll(); roles = { A: "owner", B: "owner" }; workspaces = { A: "W1", B: "W1" }; revision = 1;
      totals = counters(); byResource = Object.fromEntries([...RESOURCES.values()].map((key) => [key, counters()]));
      forbiddenWrites = 0;
    } else if (command.command === "arm") {
      arms.push({ resource: command.resource, phase: command.phase, status: command.status ?? 200,
        malformed: command.malformed ?? false, shape: command.shape ?? "valid" });
    } else if (command.command === "revision") revision = command.value;
    else if (command.command === "actorRole") roles[command.actor] = command.role;
    else if (command.command === "actorWorkspace") workspaces[command.actor] = command.workspace;
    return true;
  }

  function control(req, res, url, origin) {
    if (!origin || url.search) { req.resume(); send(res, 400, error(400)); return; }
    if (req.method === "GET") { send(res, 200, snapshot()); return; }
    if (req.method !== "POST") { req.resume(); send(res, 403, error(403)); return; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")
      || req.headers["content-encoding"] !== undefined
      || (req.headers["content-length"] !== undefined && Number(req.headers["content-length"]) > MAX_BODY)
      || controls.size >= MAX_PENDING) { req.resume(); send(res, 400, error(400)); return; }
    const entry = { req, res };
    controls.add(entry);
    let size = 0, invalid = false;
    const chunks = [];
    const done = () => { controls.delete(entry); };
    req.once("aborted", done); req.once("error", done); res.once("close", done);
    req.on("data", (chunk) => {
      if (invalid) return;
      size += chunk.length;
      if (size > MAX_BODY) { invalid = true; chunks.length = 0; done(); send(res, 400, error(400)); }
      else chunks.push(chunk);
    });
    req.once("end", () => {
      done();
      if (invalid || closed || req.aborted || res.destroyed) return;
      try {
        const command = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!validCommand(command) || !apply(command)) { send(res, 400, error(400)); return; }
        send(res, 200, snapshot());
      } catch { send(res, 400, error(400)); }
    });
  }

  function handle(req, res) {
    if (typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//") || req.url.includes("#")) return false;
    const rawPath = req.url.split("?", 1)[0];
    const resource = RESOURCES.get(rawPath);
    if (rawPath !== CONTROL && !resource) return false;
    if (closed) { req.resume(); send(res, 503, error(503)); return true; }
    const origin = localOrigin(req);
    let url;
    try { url = new URL(req.url, origin ?? "http://127.0.0.1"); }
    catch { req.resume(); send(res, 400, error(400)); return true; }
    if (rawPath === CONTROL) { control(req, res, url, origin); return true; }

    const actor = req.headers.authorization === "Bearer fixture-ads-A" ? "A"
      : req.headers.authorization === "Bearer fixture-ads-B" ? "B" : null;
    const record = track(req, res, resource, actor);
    if (req.method !== "GET") { forbiddenWrites++; req.resume(); send(res, 403, error(403)); return true; }
    let status = 200;
    const requestedWorkspace = url.searchParams.getAll("workspaceId");
    if (!origin) status = 400;
    else if (!actor) status = 401;
    else if (!(resource === "health" && requestedWorkspace.length === 0)
      && (requestedWorkspace.length !== 1 || requestedWorkspace[0] !== IDS[workspaces[actor]])) status = 403;
    else if (roles[actor] === "lead_manager" && !["auth-context", "meta-launches"].includes(resource)) status = 403;
    const index = arms.findIndex((arm) => arm.resource === resource);
    const arm = index < 0 ? null : arms.splice(index, 1)[0];
    if (status === 200 && arm) status = arm.status;
    const body = status === 200 ? payload(resource, actor, workspaces[actor], roles[actor], revision) : error(status);
    if (status === 200 && arm) {
      if (arm.shape === "null-spend") body.data.summaries[0].spendByCurrency = null;
      else if (arm.shape === "object-summaries") body.data.summaries = { broken: true };
      else if (arm.shape === "foreign-auth") {
        body.data.isAdmin = true;
        body.data.workspaceId = IDS[workspaces[actor] === "W1" ? "W2" : "W1"];
      } else if (arm.shape === "contradictory-role") { body.data.isAdmin = true; body.data.role = "lead_manager"; }
    }
    const text = arm?.malformed ? "{QA malformed JSON" : JSON.stringify(body);
    if (!arm) { send(res, status, body); return true; }
    if (pending.size >= MAX_PENDING) { send(res, 503, error(503)); return true; }
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Content-Length": Buffer.byteLength(text) };
    Object.assign(record, { status, phase: arm.phase, release() {
      if (res.destroyed || record.finished) return;
      if (arm.phase === "headers") { res.writeHead(status, headers); res.end(text); }
      else res.end(text.slice(1));
    } });
    pending.set(record.id, record);
    if (arm.phase === "body") { res.writeHead(status, headers); res.write(text[0]); res.flushHeaders(); }
    return true;
  }

  function close() {
    if (closed) return;
    closed = true; abortAll();
    for (const { req, res } of controls) { res.destroy(); req.destroy(); }
    controls.clear();
  }
  return { handle, snapshot, close };
}
