import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { fixture, actor, secret, providerKey } from "./medina-generated-video-workflow.fixture";

type Row = Record<string, any>;

// Only the SDK acknowledgement and provider transport are doubled here. The
// production controller/parser/workflow execute; actual SQL races live in the
// separate disposable-PostgreSQL 092 suite, not in this receipt fixture.
export async function terminalFixture(t: TestContext, options: Row = {}) {
  const baseOptions: Row = { providerStatus: "failed", ...options };
  const f = await fixture(t, baseOptions);
  const originalRpc = f.sdk.rpc.bind(f.sdk);
  let acknowledgements = 0;
  f.sdk.rpc = async (name: string, args: Row) => {
    if (name !== "ack_generated_video_provider_failure") return originalRpc(name, args);
    f.calls.push({ kind: "rpc", name, args: structuredClone(args) }); f.events.push(name);
    f.rpcCounts.set(name, (f.rpcCounts.get(name) ?? 0) + 1); acknowledgements++;
    if (options.beforeAck) await options.beforeAck(f, args);
    const deny = (code: string) => ({ data: null, error: { code } });
    if (f.member.status !== "active" || !["owner", "admin", "marketer"].includes(f.member.role)
      || args.p_workspace_id !== actor.workspaceId || args.p_staff_user_id !== actor.staffUserId || args.p_auth_user_id !== actor.userId) return deny("P9004");
    if (options.noAckCommit) throw new Error("Synthetic uncertain ACK, not a provider failure");
    const op = f.operations.get(args.p_generation_key);
    if (!op) return deny("P9003");
    if (args.p_provider_status !== "failed") return deny("P9001");
    if (op.provider_job_id !== args.p_provider_job_id || !["rendering", "cancelled"].includes(op.status)
      || op.input_size !== null || f.jobs.has(op.job_id) || f.assets.has(op.asset_id)) return deny("P9002");
    if (op.status === "rendering") {
      op.updated_at = new Date().toISOString(); op.status = "cancelled";
      op.provider_failure_receipt = { kind: "provider-terminal-failure-v1", provider: "openai", status: "failed",
        providerJobId: op.provider_job_id, generationKey: op.generation_key, requestDigest: op.request_digest, keyDigest: op.key_digest,
        acknowledgedAt: op.updated_at, staffUserId: actor.staffUserId, authUserId: actor.userId };
    }
    assert.ok(op.provider_failure_receipt);
    if (options.revokeAfterAck) f.member.status = "inactive";
    if (acknowledgements <= (options.lostAcks ?? 0)) throw new Error("Synthetic lost acknowledgement after commit");
    const data = structuredClone({ operation: op, job: null, asset: null });
    if (options.mutateAckReceipt) options.mutateAckReceipt(data);
    return { data, error: null };
  };
  const transport = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: unknown, init: Row = {}) => {
    const url = String(input);
    const providerGet = url.startsWith("https://api.openai.com/v1/videos/") && !url.includes("/content?") && init.method === "GET";
    if (providerGet && options.providerReadError) throw new Error("Synthetic provider transport uncertainty");
    const response = await transport(input as Parameters<typeof transport>[0], init);
    if (!providerGet) return response;
    if (options.afterProviderGet) await options.afterProviderGet(f);
    if (options.providerReadHttpError) return new Response(JSON.stringify({ error: { message: "Synthetic unavailable" } }), { status: options.providerReadHttpError });
    if (options.responseProviderId !== undefined || options.providerStatus === null) {
      const body = await response.json() as Row;
      return new Response(JSON.stringify({ ...body,
        ...(options.responseProviderId !== undefined ? { id: options.responseProviderId } : {}),
        ...(options.providerStatus === null ? { status: null } : {}) }));
    }
    return response;
  });
  // The controller captures fetch in its VM. Load that actual controller only
  // after installing the explicit provider transport double above.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const routeFile = path.join(root, "api/content-studio/[...path].ts"), requireRoute = createRequire(routeFile);
  const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
  const exports: Row = {};
  let currentActor = { ...actor };
  const originalChangeActor = f.changeActor;
  f.changeActor = () => { originalChangeActor(); currentActor = { ...currentActor, userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }; };
  class FixtureAuthError extends Error {
    constructor(readonly statusCode: number, message: string, readonly code: string) { super(message); }
  }
  const authorized = () => f.member.status === "active" && ["owner", "admin", "marketer"].includes(f.member.role);
  const code = ts.transpileModule(await readFile(routeFile, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Script(code, { filename: routeFile }).runInNewContext({ exports, Buffer, process, URL, fetch: globalThis.fetch,
    AbortController, setTimeout, clearTimeout, console,
    require(specifier: string) {
      if (specifier === "../../lib/auth/server") return { WorkspaceAdminAuthError: FixtureAuthError,
        requireWorkspaceAccess: async () => {
          if (!authorized()) throw new FixtureAuthError(403, "Access denied", "workspace_access_denied");
          return { ...currentActor };
        } };
      if (specifier === "../../lib/auth/route-guard") return {
        normalizeRouteSegment: (value: unknown) => Array.isArray(value) ? value.join("/") : String(value ?? ""),
        sendNotFound: (_req: unknown, res: Row) => res.status(404).json({ success: false }),
        authorizePrivateRoute: async (_req: unknown, res: Row) => {
          if (!authorized() || currentActor.userId !== f.member.auth_user_id) { res.status(403).json({ success: false }); return null; }
          return { ...currentActor };
        } };
      if (specifier === "../../lib/content-studio/usage") return {
        billableVideoSeconds: () => 4,
        reserveContentGeneration: f.reserveUsage,
        completeContentGeneration: f.completeUsage,
        getContentUsageSummary: async () => { throw new Error("Unused endpoint"); },
      };
      return requireRoute(specifier);
    },
  });
  async function request(resource: "generate-video" | "video-generation", extra: Row = {}) {
    const req = { method: resource === "generate-video" ? "POST" : "GET", query: { path: resource, ...extra.query },
      headers: { "x-idempotency-key": extra.requestKey ?? f.requestKey }, body: { prompt: "Synthetic video fixture", format: "reels", ...extra.body } };
    const res: Row = { code: 0, body: null, headers: {}, setHeader(key: string, value: unknown) { this.headers[key] = value; return this; },
      status(value: number) { this.code = value; return this; }, json(body: unknown) { this.body = body; return this; }, end() { return this; } };
    await exports.default(req, res);
    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes(secret), false); assert.equal(serialized.includes(providerKey), false);
    return res;
  }
  return { ...f, request, options: baseOptions, acknowledgements: () => acknowledgements };
}
