import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Storage-1 — tenant isolation for Supabase Storage.
//
// Security-1A set Storage aside as "Storage API, not Data API", and Security-2
// stopped at the Data API boundary. But every storage write in api/** runs on
// the service-role client, which bypasses Storage RLS the same way it bypasses
// row RLS, so which bucket and which object key a request may touch is an
// application guarantee and nothing else.
//
// These tests drive the real router with a mocked Supabase Auth endpoint and a
// spying Supabase client, and assert the bucket and key the handler actually
// reaches for. Nothing here touches production or the network.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");
const workerPath = path.join(repoRoot, "artifacts", "video-worker", "src", "worker.ts");
const adsPagePath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx");
const contentStudioPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "ContentStudio.tsx");
const rawBucketMigration = path.join(repoRoot, "migrations", "016_video_processing_jobs.sql");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const FOREIGN_JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = "header.payload.signature";
const STAFF_A = "33333333-3333-4333-8333-333333333333";
const STAFF_B = "44444444-4444-4444-8444-444444444444";
const OWN_JOB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWN_ASSET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST_KEY = "66666666-6666-4666-8666-666666666666";
const ORIGIN = "https://project.example.test";
const SECRET = "SYNTHETIC_STORAGE_ISOLATION_SECRET_NEVER_REAL_123";
const STAGING_BUCKET = "ad-creatives-staging";
type ObservedActor = { workspaceId: string; userId: string; staffUserId: string };
type ObservedTicket = ObservedActor & { v: 1; id: string; fileName: string; mimeType: string; fileSize: number; issuedAt: number; expiresAt: number };
const { issueStagedCreativeTicket, readStagedCreativeTicket } = await import(
  pathToFileURL(path.join(repoRoot, "lib", "crm", "staged-creative-ticket.ts")).href
) as {
  issueStagedCreativeTicket(input: ObservedActor & { fileName: string; mimeType: string; fileSize: number }, secret: string): { ticket: ObservedTicket; handle: string };
  readStagedCreativeTicket(handle: unknown, actor: ObservedActor, secret: string): ObservedTicket;
};
type Row = Record<string, any>;
type RpcCall = { name: string; args: Row };

type StaffRow = { id: string; workspace_id: string; auth_user_id: string; role: string; status: string };
type QueryLog = { table: string; op: string; filters: Record<string, unknown>; columns?: string; row?: unknown };
type StorageCall = { op: string; bucket: string; key: string; options?: unknown };
type StorageReplies = {
  signedUpload?: { data: unknown; error: unknown } | ((canonical: Row) => { data: unknown; error: unknown });
  bucketPublic?: boolean;
};

/** Apply the recorded filters so removing a tenant/id predicate changes results. */
function dbSpy(rows: Record<string, unknown[]>, log: QueryLog[], errors: Record<string, { message: string }> = {}) {
  return (table: string) => {
    const entry: QueryLog = { table, op: "select", filters: {} };
    log.push(entry);
    let executed = false;
    const settle = (shape: "one" | "list") => {
      assert.equal(executed, false, "one execution per query");
      executed = true;
      if (errors[table]) return Promise.resolve({ data: null, error: errors[table] });
      const tableRows = (rows[table] ||= []) as Row[];
      const matches = (row: Row) => Object.entries(entry.filters).every(([key, value]) =>
        Array.isArray(value) ? value.includes(row[key]) : row[key] === value);
      let result = tableRows.filter(matches);
      if (entry.op === "insert" || entry.op === "upsert") {
        const row = { id: table === "video_processing_jobs" ? OWN_JOB : OWN_ASSET, ...entry.row as Row };
        tableRows.push(row); result = [row];
      } else if (entry.op === "update") {
        for (const row of result) Object.assign(row, entry.row);
      } else if (entry.op === "delete") {
        rows[table] = tableRows.filter((row) => !matches(row));
      }
      return Promise.resolve({ data: shape === "one" ? structuredClone(result[0] ?? null) : structuredClone(result),
        error: null, count: result.length });
    };
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: (columns: string) => { entry.columns = columns; return builder; },
      insert: (row: unknown) => { entry.op = "insert"; entry.row = row; return builder; },
      update: (row: unknown) => { entry.op = "update"; entry.row = row; return builder; },
      upsert: (row: unknown) => { entry.op = "upsert"; entry.row = row; return builder; },
      delete: () => { entry.op = "delete"; return builder; },
      order: () => builder, limit: () => builder,
      eq(column: string, value: unknown) { entry.filters[column] = value; return builder; },
      in(column: string, values: unknown[]) { entry.filters[column] = [...values]; return builder; },
      is(column: string, value: unknown) { entry.filters[column] = value; return builder; },
      single: () => settle("one"), maybeSingle: () => settle("one"),
      then(onFulfilled: (value: unknown) => unknown) { return settle("list").then(onFulfilled); },
    });
    return builder;
  };
}

/** Storage data is held only in memory; canonical public verification reads it back. */
function storageSpy(calls: StorageCall[], replies: StorageReplies = {}, published = new Map<string, Buffer>(), staged = new Map<string, Buffer>()) {
  return {
    async getBucket(bucket: string) {
      calls.push({ op: "getBucket", bucket, key: "" });
      return { data: { id: bucket, public: replies.bucketPublic ?? false,
        file_size_limit: (bucket === STAGING_BUCKET ? 100 : 500) * 1024 * 1024,
        allowed_mime_types: bucket === STAGING_BUCKET ? ["image/jpeg", "image/png", "image/webp"]
          : ["video/mp4", "video/quicktime", "video/webm"] }, error: null };
    },
    from(bucket: string) {
      return {
        list: async (folder: string, options: { limit: number; search: string }) => {
          assert.equal(bucket, STAGING_BUCKET); assert.equal(options.limit, 2);
          const key = `${folder}/${options.search}`;
          calls.push({ op: "list", bucket, key, options });
          return { data: staged.has(key) ? [{ id: OWN_ASSET, name: options.search }] : [], error: null };
        },
        upload: async (key: string, bytes: Buffer, options: unknown) => {
          calls.push({ op: "upload", bucket, key, options });
          published.set(`${bucket}/${key}`, Buffer.from(bytes));
          return { data: { path: key }, error: null };
        },
        createSignedUploadUrl: async (key: string, options: unknown) => {
          calls.push({ op: "createSignedUploadUrl", bucket, key, options });
          const canonical = { signedUrl: `${ORIGIN}/storage/v1/object/upload/sign/${bucket}/${key}?token=signed-token`, token: "signed-token", path: key };
          return typeof replies.signedUpload === "function" ? replies.signedUpload(canonical)
            : replies.signedUpload ?? { data: canonical, error: null };
        },
        getPublicUrl: (key: string) => {
          calls.push({ op: "getPublicUrl", bucket, key });
          return { data: { publicUrl: `${ORIGIN}/storage/v1/object/public/${bucket}/${key}` } };
        },
        remove: async (keys: string[]) => {
          calls.push({ op: "remove", bucket, key: keys.join(",") });
          return { data: null, error: null };
        },
      };
    },
  };
}

type MockRequest = {
  method: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
  body?: unknown;
  [Symbol.asyncIterator]?: () => AsyncGenerator<Buffer>;
};

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

const memberA: StaffRow = { id: STAFF_A, workspace_id: WORKSPACE_A, auth_user_id: USER_A, role: "owner", status: "active" };
const memberB: StaffRow = { id: STAFF_B, workspace_id: WORKSPACE_B, auth_user_id: USER_A, role: "owner", status: "active" };

async function loadRouter(rows: Record<string, unknown[]> = {}) {
  const queries: QueryLog[] = [], storage: StorageCall[] = [], rpcs: RpcCall[] = [];
  const storageReplies: StorageReplies = {}, errors: Record<string, { message: string }> = {};
  const published = new Map<string, Buffer>(), staged = new Map<string, Buffer>();
  const violations: string[] = [];
  const originalEnv = process.env, originalFetch = globalThis.fetch;
  // Replace the environment before importing the router; never read project secrets.
  process.env = { NODE_ENV: "test", SUPABASE_URL: ORIGIN, SUPABASE_SERVICE_ROLE_KEY: SECRET,
    VIDEO_OPTIMIZATION_ENABLED: "true" };
  function check(condition: unknown, message: string): asserts condition {
    if (!condition) { violations.push(message); throw new Error(message); }
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ORIGIN}/auth/v1/user`) {
      check(new Headers(init?.headers).get("authorization") === `Bearer ${TOKEN}`, "only the synthetic auth token is accepted");
      return new Response(JSON.stringify({ id: USER_A, email: "a@example.test" }), { status: 200 });
    }
    const publicPrefix = `${ORIGIN}/storage/v1/object/public/`;
    if (url.startsWith(publicPrefix)) {
      check(new Headers(init?.headers).get("authorization") === null, "public verification must not carry credentials");
      const bytes = published.get(url.slice(publicPrefix.length));
      return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404,
        headers: { "content-type": "image/jpeg" } });
    }
    const privatePrefix = `${ORIGIN}/storage/v1/object/${STAGING_BUCKET}/`;
    if (url.startsWith(privatePrefix)) {
      check(new Headers(init?.headers).get("authorization") === `Bearer ${SECRET}`, "private read requires only the synthetic service credential");
      const bytes = staged.get(url.slice(privatePrefix.length));
      return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404,
        headers: { "content-type": "image/jpeg", ...(bytes ? { "content-length": String(bytes.length) } : {}) } });
    }
    check(false, `unexpected network boundary: ${url}`);
  }) as typeof globalThis.fetch;

  const supabaseModule = await import(pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href) as {
    setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void;
  };
  const clientRows: Record<string, unknown[]> = { staff_users: [structuredClone(memberA)], workspace_settings: [], ...structuredClone(rows) };
  const live = (args: Row) => (clientRows.staff_users as Row[]).some((row) =>
    row.id === args.p_staff_user_id && row.workspace_id === args.p_workspace_id
    && row.auth_user_id === args.p_auth_user_id && row.status === "active" && ["owner", "admin", "marketer"].includes(row.role));
  supabaseModule.setSupabaseServerClientFactoryForTests(() => ({
    from: dbSpy(clientRows, queries, errors), storage: storageSpy(storage, storageReplies, published, staged),
    async rpc(name: string, args: Row) {
      rpcs.push({ name, args: structuredClone(args) });
      check(live(args), "admission/commit must bind the active workspace, staff and auth user");
      const operations = (clientRows.creative_upload_operations ||= []) as Row[];
      if (name === "reserve_creative_upload") {
        let op = operations.find((row) => row.request_key === args.p_request_key && row.workspace_id === args.p_workspace_id
          && row.auth_user_id === args.p_auth_user_id && row.staff_user_id === args.p_staff_user_id);
        if (op && (op.file_name !== args.p_file_name || op.mime_type !== args.p_mime_type || op.file_size !== args.p_file_size || op.source !== args.p_source)) {
          return { data: null, error: { code: "P8802" } };
        }
        if (!op) {
          const { ticket } = issueStagedCreativeTicket({ workspaceId: args.p_workspace_id, userId: args.p_auth_user_id,
            staffUserId: args.p_staff_user_id, fileName: args.p_file_name, mimeType: args.p_mime_type, fileSize: args.p_file_size }, SECRET);
          op = { id: ticket.id, workspace_id: ticket.workspaceId, auth_user_id: ticket.userId, staff_user_id: ticket.staffUserId,
            file_name: ticket.fileName, mime_type: ticket.mimeType, file_size: ticket.fileSize, issued_at: ticket.issuedAt,
            expires_at: ticket.expiresAt, source: args.p_source, request_key: args.p_request_key.toLowerCase(), status: "reserved" };
          operations.push(op);
        }
        return { data: { ticket: { v: 1, id: op.id, workspaceId: op.workspace_id, userId: op.auth_user_id,
          staffUserId: op.staff_user_id, fileName: op.file_name, mimeType: op.mime_type, fileSize: op.file_size,
          issuedAt: op.issued_at, expiresAt: op.expires_at }, requestKey: op.request_key, status: op.status }, error: null };
      }
      const op = operations.find((row) => row.id === args.p_operation_id && row.workspace_id === args.p_workspace_id
        && row.auth_user_id === args.p_auth_user_id && row.staff_user_id === args.p_staff_user_id);
      check(op, "finalization/rejection must target the exact reserved operation");
      if (name === "reject_creative_upload") { op.status = "rejected"; return { data: null, error: null }; }
      check(name === "finalize_creative_image_upload", `unexpected RPC: ${name}`);
      const result: Row = args.p_result;
      check(result.storage_path.startsWith(`${op.workspace_id}/verified/${op.id}/`), "promotion must use the reserved workspace and identity");
      const assets = (clientRows.ad_creative_assets ||= []) as Row[];
      const replayed = op.status === "finalized";
      let asset = assets.find((row) => row.id === op.id && row.workspace_id === op.workspace_id);
      if (!replayed) {
        asset = { ...result, id: op.id, workspace_id: op.workspace_id, status: "uploaded",
          verified_upload_key: op.id, verified_upload_actor_id: op.auth_user_id, verified_upload_sha256: result.sha256 };
        assets.push(asset); op.status = "finalized"; op.result = structuredClone(result);
      } else check(JSON.stringify(op.result) === JSON.stringify(result), "a replay cannot change verified bytes");
      check(asset, "a finalization receipt must identify the actual persisted asset");
      return { data: { operationId: op.id, status: "finalized", asset, replayed }, error: null };
    },
  }));
  const routerModule = await import(pathToFileURL(routerPath).href) as { default(req: unknown, res: MockResponse): Promise<unknown> };
  const call = async (input: {
    segments: string[]; method?: string; body?: unknown; rawBody?: Buffer; contentType?: string; query?: Record<string, unknown>;
  }) => {
    queries.length = 0; storage.length = 0; rpcs.length = 0;
    const res = mockResponse();
    const req: MockRequest = { method: input.method ?? "GET",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": input.contentType || "application/json" },
      query: { path: input.segments, ...(input.query ?? {}) }, body: input.body };
    if (input.rawBody) { const chunk = input.rawBody; req[Symbol.asyncIterator] = async function* () { yield chunk; }; }
    await routerModule.default(req, res);
    assert.deepEqual(violations, [], "caught test-double failures must never look like legitimate refusals");
    return { res, queries: structuredClone(queries), storage: structuredClone(storage), rpcs: structuredClone(rpcs) };
  };
  return {
    call, errors, storageReplies, rows: clientRows, staged, published,
    restore: () => {
      globalThis.fetch = originalFetch; process.env = originalEnv;
      supabaseModule.setSupabaseServerClientFactoryForTests(null);
      assert.deepEqual(violations, []);
    },
  };
}

async function withRouter<T>(
  rows: Record<string, unknown[]>,
  fn: (ctx: Awaited<ReturnType<typeof loadRouter>>) => Promise<T>,
): Promise<T> {
  const ctx = await loadRouter(rows);
  try {
    return await fn(ctx);
  } finally {
    ctx.restore();
  }
}

/** Builds a multipart body with the given fields plus one file part. */
function multipartBody(fields: Record<string, string>): { buffer: Buffer; contentType: string; file: Buffer } {
  const boundary = "----negisStorageTestBoundary";
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="creative.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`,
  );
  const file = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABAEBAQAAAAAAAAAAAAAAAAAABAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCMABEP/9k=", "base64");
  return {
    file,
    buffer: Buffer.concat([
      Buffer.from(parts.join(""), "utf8"),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function uploads(calls: StorageCall[]): StorageCall[] {
  return calls.filter((entry) => entry.op === "upload" || entry.op === "createSignedUploadUrl");
}

function profileQueries(queries: QueryLog[]): QueryLog[] {
  return queries.filter((entry) => entry.table === "workspace_settings" && entry.filters.key === "workspace_purpose");
}

function assertVerifiedPromotion(result: Awaited<ReturnType<Awaited<ReturnType<typeof loadRouter>>["call"]>>, ctx: Awaited<ReturnType<typeof loadRouter>>) {
  assert.equal(result.res.statusCode, 201, JSON.stringify(result.res.body));
  assert.equal(result.res.body.success, true);
  assert.equal(result.res.body.mode, "supabase");
  const asset = (result.res.body.data as Row).asset;
  const commit = result.rpcs.find((call) => call.name === "finalize_creative_image_upload");
  assert.ok(commit, "success must be backed by the canonical promotion RPC");
  assert.equal(asset.id, commit.args.p_operation_id);
  assert.equal(asset.workspaceId, WORKSPACE_A);
  assert.equal(asset.storageBucket, "ad-creatives");
  const bytes = ctx.published.get(`ad-creatives/${asset.storagePath}`);
  assert.ok(bytes, "the receipt must identify the actual normalized bytes");
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.equal(asset.storagePath, `${WORKSPACE_A}/verified/${asset.id}/${sha}.jpg`);
  assert.equal(asset.publicUrl, `${ORIGIN}/storage/v1/object/public/ad-creatives/${asset.storagePath}`);
  assert.equal(asset.fileSize, bytes.length);
  assert.equal(asset.fileType, "image");
  assert.equal(asset.mimeType, "image/jpeg");
  assert.equal(asset.status, "uploaded");
  assert.equal(commit.args.p_result.sha256, sha);
  const publications = result.storage.filter((call) => call.op === "upload");
  assert.equal(publications.length, 1);
  assert.deepEqual(publications[0].options, { contentType: "image/jpeg", upsert: false });
  assert.equal(result.rpcs.filter((call) => call.name === "finalize_creative_image_upload").length, 1);
  for (const call of result.rpcs) {
    assert.equal(call.args.p_workspace_id, WORKSPACE_A);
    assert.equal(call.args.p_staff_user_id, STAFF_A);
    assert.equal(call.args.p_auth_user_id, USER_A);
  }
  assert.deepEqual(result.queries.filter((q) => q.table === "ad_creative_assets" && q.op !== "select"), [],
    "there is no metadata-only INSERT fallback");
  return asset as Row;
}

// ===========================================================================
// A. The browser never chooses the bucket
// ===========================================================================

test("ST1 a multipart upload naming another bucket uses canonical verified promotion", async () => {
  await withRouter({}, async (ctx) => {
    const form = multipartBody({
      storageBucket: "ad-creatives-raw",
      fileName: "creative.jpg",
      mimeType: "image/jpeg",
    });
    const result = await ctx.call({
      segments: ["ad-creative-upload"],
      method: "POST",
      rawBody: form.buffer,
      contentType: form.contentType,
    });

    assertVerifiedPromotion(result, ctx);
    assert.equal(result.rpcs[0].args.p_source, "inline");
    const written = uploads(result.storage);
    assert.equal(written.length, 1);
    assert.equal(written[0].bucket, "ad-creatives");
    for (const call of result.storage) {
      assert.notEqual(call.bucket, "ad-creatives-raw", "the private raw bucket must be unreachable from a browser upload");
    }
  });
});

test("ST2 a multipart upload naming a foreign key still writes under the caller's workspace", async () => {
  await withRouter({}, async (ctx) => {
    const form = multipartBody({
      storagePath: `${WORKSPACE_B}/ads/stolen.jpg`,
      fileName: "creative.jpg",
      mimeType: "image/jpeg",
    });
    const result = await ctx.call({
      segments: ["ad-creative-upload"],
      method: "POST",
      rawBody: form.buffer,
      contentType: form.contentType,
    });

    const asset = assertVerifiedPromotion(result, ctx);
    const written = uploads(result.storage);
    assert.equal(written.length, 1);
    assert.ok(written[0].key.startsWith(`${WORKSPACE_A}/`), `key escaped the workspace prefix: ${written[0].key}`);
    assert.equal(written[0].key, asset.storagePath);
    for (const call of result.storage) {
      assert.equal(call.key.includes(WORKSPACE_B), false, "no storage call may reference another workspace");
    }
  });
});

test("ST3 the signed upload route derives the key from the authorized workspace", async () => {
  await withRouter({}, async (ctx) => {
    const { res, queries, storage, rpcs } = await ctx.call({
      segments: ["ad-creatives", "signed-upload"],
      method: "POST",
      body: { fileName: "creative.jpg", fileType: "image", mimeType: "image/jpeg", fileSize: 2048,
        requestKey: REQUEST_KEY, workspaceId: WORKSPACE_B, storageBucket: "ad-creatives", storagePath: `${WORKSPACE_B}/stolen.jpg` },
    });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(profileQueries(queries), [{ table: "workspace_settings", op: "select",
      columns: "workspace_id, value", filters: { workspace_id: [WORKSPACE_A], key: "workspace_purpose" } }]);
    const signed = storage.filter((entry) => entry.op === "createSignedUploadUrl");
    assert.equal(signed.length, 1);
    assert.equal(signed[0].bucket, STAGING_BUCKET);
    assert.ok(signed[0].key.startsWith(`${WORKSPACE_A}/`), `key escaped the workspace prefix: ${signed[0].key}`);
    assert.equal(res.body.success, true);
    const receipt = res.body.data as Record<string, unknown>;
    assert.equal(receipt.bucket, STAGING_BUCKET);
    assert.equal(receipt.storageBucket, STAGING_BUCKET);
    assert.equal(receipt.storagePath, signed[0].key);
    assert.equal(receipt.token, "signed-token");
    assert.equal(receipt.signedUrl, `${ORIGIN}/storage/v1/object/upload/sign/${STAGING_BUCKET}/${signed[0].key}?token=signed-token`);
    const ticket = readStagedCreativeTicket(receipt.uploadHandle, { workspaceId: WORKSPACE_A, userId: USER_A, staffUserId: STAFF_A }, SECRET);
    assert.equal(signed[0].key, `${WORKSPACE_A}/staged/${ticket.id}/original.jpg`);
    assert.deepEqual(signed[0].options, { upsert: false });
    for (const key of ["publicUrl", "asset", "item"]) assert.equal(key in receipt, false, `${key} is not part of a private ticket`);
    assert.equal(rpcs.length, 1);
    assert.equal(rpcs[0].name, "reserve_creative_upload");
    assert.equal(rpcs[0].args.p_request_key, REQUEST_KEY);
    assert.equal(rpcs[0].args.p_workspace_id, WORKSPACE_A);
  });
});

const privateSigningToken = "private-fixture-signing-token";
const signingMutations: Array<{ name: string; mutate(canonical: Row): unknown }> = [
  { name: "null data", mutate: () => null },
  { name: "missing token", mutate: ({ token: _token, ...rest }) => rest },
  { name: "missing URL", mutate: ({ signedUrl: _url, ...rest }) => rest },
  { name: "numeric token", mutate: (data) => ({ ...data, token: 42 }) },
  { name: "object token", mutate: (data) => ({ ...data, token: { privateDetail: privateSigningToken } }) },
  { name: "numeric URL", mutate: (data) => ({ ...data, signedUrl: 42 }) },
  { name: "object URL", mutate: (data) => ({ ...data, signedUrl: { privateDetail: privateSigningToken } }) },
  { name: "empty token", mutate: (data) => ({ ...data, token: "" }) },
  { name: "empty URL", mutate: (data) => ({ ...data, signedUrl: "" }) },
  { name: "foreign workspace path", mutate: (data) => ({ ...data, path: data.path.replace(WORKSPACE_A, WORKSPACE_B) }) },
  { name: "foreign workspace URL", mutate: (data) => ({ ...data, signedUrl: data.signedUrl.replace(WORKSPACE_A, WORKSPACE_B) }) },
  { name: "public bucket URL", mutate: (data) => ({ ...data, signedUrl: data.signedUrl.replace(STAGING_BUCKET, "ad-creatives") }) },
  { name: "foreign origin", mutate: (data) => ({ ...data, signedUrl: data.signedUrl.replace(ORIGIN, "https://foreign.example.test") }) },
];
for (const { name, mutate } of signingMutations) {
  test(`ST3 malformed signing reply with ${name} fails closed without metadata writes`, async () => {
    await withRouter({}, async (ctx) => {
      ctx.storageReplies.signedUpload = (canonical) => ({ data: mutate(canonical), error: null });
      const { res, queries, storage, rpcs } = await ctx.call({
        segments: ["ad-creatives", "signed-upload"], method: "POST",
        query: { workspaceId: WORKSPACE_A },
        body: { fileName: "photo-creative.jpg", fileType: "image", mimeType: "image/jpeg", fileSize: 2048, requestKey: REQUEST_KEY },
      });

      assert.equal(res.statusCode, 503, JSON.stringify(res.body));
      assert.deepEqual(res.body, {
        success: false,
        error: "Сохранение файла не подтверждено. Повторите проверку, не создавая новую загрузку.",
        details: [], code: "creative_staging_ticket_unconfirmed",
      }, "the failure must contain no signing receipt or raw Storage data");
      assert.deepEqual(queries.filter((entry) => entry.op !== "select"), [], "no metadata may be written");
      const profiles = profileQueries(queries);
      assert.deepEqual(queries.filter((entry) => entry.table !== "staff_users" && !profiles.includes(entry)), [],
        "only authorization and workspace profile reads may occur");
      assert.equal(storage.length, 3, "only private-bucket verification, exact-key lookup and one signing attempt may occur");
      assert.deepEqual(storage.map((call) => call.op), ["getBucket", "list", "createSignedUploadUrl"]);
      for (const call of storage) assert.equal(call.bucket, STAGING_BUCKET);
      assert.ok(storage[1].key.startsWith(`${WORKSPACE_A}/staged/`));
      assert.deepEqual(rpcs.map((call) => call.name), ["reserve_creative_upload"]);
      assert.equal(JSON.stringify(res.body).includes(privateSigningToken), false);
    });
  });
}

test("ST3 a public staging bucket refuses signing instead of falling back", async () => {
  await withRouter({}, async (ctx) => {
    ctx.storageReplies.bucketPublic = true;
    const result = await ctx.call({ segments: ["ad-creatives", "signed-upload"], method: "POST",
      body: { fileName: "creative.jpg", fileType: "image", mimeType: "image/jpeg", fileSize: 2048, requestKey: REQUEST_KEY } });
    assert.equal(result.res.statusCode, 503, JSON.stringify(result.res.body));
    assert.equal(result.res.body.code, "creative_staging_bucket_unconfirmed");
    assert.equal(result.res.body.success, false);
    assert.equal(result.res.body.data, undefined);
    assert.deepEqual(result.storage, [{ op: "getBucket", bucket: STAGING_BUCKET, key: "" }]);
    assert.deepEqual(result.rpcs.map((call) => call.name), ["reserve_creative_upload"]);
    assert.equal(ctx.rows.ad_creative_assets?.length ?? 0, 0);
  });
});

for (const requestKey of [undefined, "not-a-uuid", "11111111-1111-1111-8111-111111111111"]) {
  test(`ST3 signed upload rejects a missing or non-v4 requestKey: ${String(requestKey)}`, async () => {
    await withRouter({}, async (ctx) => {
      const result = await ctx.call({ segments: ["ad-creatives", "signed-upload"], method: "POST",
        body: { fileName: "creative.jpg", fileType: "image", mimeType: "image/jpeg", fileSize: 2048,
          requestKey } });
      assert.equal(result.res.statusCode, 400, JSON.stringify(result.res.body));
      assert.equal(result.res.body.code, "creative_upload_request_key_required");
      assert.equal(result.res.body.success, false); assert.equal(result.res.body.data, undefined);
      assert.deepEqual(result.storage, []); assert.deepEqual(result.rpcs, []);
      assert.deepEqual(result.queries.filter((q) => !["staff_users", "workspace_settings"].includes(q.table)), []);
    });
  });
}

for (const failure of ["malformed", "query error"]) {
  test(`signed upload ${failure} profile fails closed before business queries or storage`, async () => {
    const rows: Record<string, unknown[]> = failure === "malformed" ? { workspace_settings: [
      { workspace_id: WORKSPACE_A, key: "workspace_purpose", value: { purpose: "unrecognized" } },
    ] } : {};
    await withRouter(rows, async (ctx) => {
      if (failure === "query error") ctx.errors.workspace_settings = { message: "private fixture profile detail" };
      const { res, queries, storage } = await ctx.call({
        segments: ["ad-creatives", "signed-upload"], method: "POST",
        body: { fileName: "creative.jpg", mimeType: "image/jpeg", fileSize: 2048, workspaceId: WORKSPACE_B, requestKey: REQUEST_KEY },
      });
      assert.equal(res.statusCode, 503, JSON.stringify(res.body));
      assert.equal(res.body.code, "workspace_profile_unavailable");
      assert.equal(res.body.data, undefined);
      assert.equal(JSON.stringify(res.body).includes("private fixture profile detail"), false);
      const profiles = profileQueries(queries);
      assert.equal(profiles.length, 1);
      assert.deepEqual(queries.filter((entry) => entry.table !== "staff_users" && !profiles.includes(entry)), []);
      assert.deepEqual(storage, []);
    });
  });
}

// ===========================================================================
// B. The browser never chooses which object the worker reads
// ===========================================================================

test("ST4 a job pointing at another workspace's raw object is refused before any insert", async () => {
  await withRouter({}, async (ctx) => {
    const { res, queries, storage, rpcs } = await ctx.call({
      segments: ["video-processing-jobs"],
      method: "POST",
      body: {
        rawPath: `${WORKSPACE_B}/2026/07/1751-secret.mp4`,
        fileName: "large.mov",
        inputMimeType: "video/quicktime",
        inputSizeBytes: 5_000_000,
      },
    });

    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(
      queries.some((entry) => entry.table === "video_processing_jobs"),
      false,
      "a rejected job must never reach the jobs table",
    );
    assert.deepEqual(storage, []);
    assert.deepEqual(rpcs, []);
  });
});

test("ST5 an own raw-video job returns its canonical queued row and complete ready receipt", async () => {
  const ownPath = `${WORKSPACE_A}/2026/07/1751-large.mov`;
  await withRouter({ video_processing_jobs: [{ id: FOREIGN_JOB, status: "failed", workspace_id: WORKSPACE_B }] }, async (ctx) => {
    const { res, queries } = await ctx.call({
      segments: ["video-processing-jobs"],
      method: "POST",
      body: {
        rawPath: ownPath,
        fileName: "large.mov",
        inputMimeType: "video/quicktime",
        inputSizeBytes: 5_000_000,
      },
    });

    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const insert = queries.find((entry) => entry.table === "video_processing_jobs" && entry.op === "insert");
    assert.ok(insert, "the job must be inserted");
    const row = insert.row as Record<string, unknown>;
    assert.equal(row.raw_path, ownPath);
    assert.equal(row.workspace_id, WORKSPACE_A);
    assert.equal(row.raw_bucket, "ad-creatives-raw");
    assert.equal(row.source_file_name, "large.mov");
    assert.equal(row.source_mime_type, "video/quicktime");
    assert.equal(row.raw_size, 5_000_000);
    const queued = (res.body.data as Row).job;
    assert.equal(res.body.mode, "supabase");
    assert.equal(queued.id, OWN_JOB);
    assert.equal(queued.workspaceId, WORKSPACE_A);
    assert.equal(queued.status, "queued");
    assert.equal(queued.inputSizeBytes, 5_000_000);
    const stored = (ctx.rows.video_processing_jobs as Row[]).find((job) => job.id === OWN_JOB)!;
    assert.equal(stored.raw_path, ownPath, "the canonical row retains the own raw object");
    const outputPath = `optimized/${WORKSPACE_A}/${OWN_JOB}/video.mp4`;
    const thumbnailPath = `optimized/${WORKSPACE_A}/${OWN_JOB}/cover.jpg`;
    const outputUrl = `${ORIGIN}/storage/v1/object/public/ad-creatives/${outputPath}`;
    Object.assign(stored, { status: "ready", asset_id: OWN_ASSET, optimized_bucket: "ad-creatives", optimized_path: outputPath,
      optimized_public_url: outputUrl, output_mime_type: "video/mp4", output_size_bytes: 1024,
      thumbnail_path: thumbnailPath, thumbnail_url: `${ORIGIN}/storage/v1/object/public/ad-creatives/${thumbnailPath}` });
    ctx.rows.ad_creative_assets = [{ id: OWN_ASSET, workspace_id: WORKSPACE_A, file_name: "worker-output.mp4",
      file_type: "video", mime_type: "video/mp4", file_size: 1024, storage_bucket: "ad-creatives",
      storage_path: outputPath, public_url: outputUrl, status: "uploaded" }];
    const ready = await ctx.call({ segments: ["video-jobs"], query: { id: OWN_JOB, workspaceId: WORKSPACE_A } });
    assert.equal(ready.res.statusCode, 200, JSON.stringify(ready.res.body));
    assert.equal(ready.res.body.success, true);
    assert.equal(ready.res.body.mode, "supabase");
    const receipt = (ready.res.body.data as Row).job;
    assert.equal(receipt.id, OWN_JOB);
    assert.equal(receipt.status, "ready");
    assert.equal(receipt.workspaceId, WORKSPACE_A);
    assert.equal(receipt.assetId, OWN_ASSET);
    assert.equal(receipt.outputAssetId, OWN_ASSET);
    assert.equal(receipt.outputStorageBucket, "ad-creatives");
    assert.equal(receipt.outputStoragePath, outputPath);
    assert.equal(receipt.outputPublicUrl, outputUrl);
    assert.equal(receipt.outputFileName, "worker-output.mp4");
    assert.equal(receipt.outputMimeType, "video/mp4");
    assert.equal(receipt.outputSizeBytes, 1024);
    assert.equal(receipt.thumbnailPublicUrl, `${ORIGIN}/storage/v1/object/public/ad-creatives/${thumbnailPath}`);
    const receiptReads = ready.queries.filter((q) => ["video_processing_jobs", "ad_creative_assets"].includes(q.table));
    assert.equal(receiptReads.length, 2, "GET must verify both the exact job and its persisted output asset");
    for (const q of receiptReads) {
      assert.equal(q.filters.workspace_id, WORKSPACE_A);
      assert.equal(q.filters.id, q.table === "video_processing_jobs" ? OWN_JOB : OWN_ASSET);
    }
    for (const field of ["rawPath", "raw_path", "rawBucket", "raw_bucket"]) assert.equal(field in receipt, false);
    assert.deepEqual(ready.storage, []);
  });
});

test("ST6 retry scopes both lookups, so a foreign job id is a 404 and not a 409", async () => {
  const foreign = { id: FOREIGN_JOB, workspace_id: WORKSPACE_B, status: "failed", raw_path: `${WORKSPACE_B}/private.mov` };
  await withRouter({ video_processing_jobs: [foreign] }, async (ctx) => {
    const { res, queries } = await ctx.call({
      segments: ["video-processing-jobs", FOREIGN_JOB, "retry"],
      method: "POST",
      body: {},
    });

    assert.equal(res.statusCode, 404, JSON.stringify(res.body));
    const jobQueries = queries.filter((entry) => entry.table === "video_processing_jobs");
    assert.ok(jobQueries.length >= 2, "retry performs the scoped update and the existence lookup");
    for (const entry of jobQueries) {
      assert.equal(entry.filters.id, FOREIGN_JOB, "the exact requested job id must be retained");
      assert.equal(
        entry.filters.workspace_id,
        WORKSPACE_A,
        "every retry query must carry the caller's workspace filter",
      );
    }
    assert.deepEqual(ctx.rows.video_processing_jobs, [foreign], "a foreign failed job must never be retried");
    assert.equal(res.body.data, undefined);
    assert.equal(JSON.stringify(res.body).includes(WORKSPACE_B), false);
  });
});

// ===========================================================================
// C. Source pins
// ===========================================================================

test("ST7 the multipart branch reads no bucket or key from the form", async () => {
  const source = await readFile(serverPath, "utf8");
  const start = source.indexOf("async function handleMultipartAdCreativeUpload");
  assert.ok(start > 0, "handleMultipartAdCreativeUpload must exist");
  const end = source.indexOf("\nexport async function handleAdCreativeUpload", start);
  assert.ok(end > start, "the multipart branch must be delimited");
  const branch = source.slice(start, end);

  for (const field of ["form.fields.storageBucket", "form.fields.storage_bucket", "form.fields.storagePath", "form.fields.storage_path"]) {
    assert.equal(branch.includes(field), false, `the multipart branch must not read ${field}`);
  }
  assert.ok(branch.includes("finalizeInlineCreativeImage"), "multipart bytes must enter canonical verified promotion");
  assert.equal(branch.includes("persistAdCreativeAsset("), false, "there is no metadata-only persistence fallback");
});

test("ST8 the raw bucket stays private and the worker still reads its key off the job row", async () => {
  const migration = await readFile(rawBucketMigration, "utf8");
  const rawBucketInsert = migration.slice(migration.indexOf("'ad-creatives-raw'"));
  assert.ok(rawBucketInsert.includes("false"), "ad-creatives-raw must remain a private bucket");

  // The worker is trusted and holds the service role, so the only thing
  // standing between a browser and a foreign raw object is the check on the
  // key at the API boundary. If this read ever stops coming from the job row,
  // ST4 stops being sufficient.
  const worker = await readFile(workerPath, "utf8");
  assert.ok(worker.includes("job.raw_path"), "the worker reads raw_path from the job row");
  assert.ok(worker.includes("storage.from(rawBucket).remove"), "the worker deletes the raw original it processed");
});

// ===========================================================================
// D. The tenant filter is not optional
// ===========================================================================

// Everywhere else in lib/crm/server.ts the workspace is applied
// unconditionally. The video job handlers applied it only when it happened to
// be a UUID — `if (isUuid(workspaceId)) query = query.eq(...)` — so a request
// that somehow arrived without a verified workspace would have run the query
// with no tenant filter at all, and a job row could be written with
// workspace_id null for the worker to process on nobody's behalf.

test("ST9 no query in the CRM server makes the workspace filter conditional", async () => {
  const source = await readFile(serverPath, "utf8");

  assert.equal(
    source.includes("if (isUuid(workspaceId))"),
    false,
    "a tenant filter that disappears when the workspace is missing fails open",
  );
  assert.equal(
    source.includes("workspace_id: isUuid(workspaceId) ? workspaceId : null"),
    false,
    "a row with workspace_id null belongs to no clinic and the worker processes it anyway",
  );
  assert.ok(
    source.includes('if (!isUuid(workspaceId)) throw new Error("workspace is not verified");'),
    "an unverified workspace must end the request instead of widening the query",
  );
});

test("ST10 a handler reached without a verified workspace refuses instead of querying", async () => {
  // The router never lets this happen: a browser route always carries a
  // verified workspace, so with the filter conditional or unconditional the
  // observable behaviour through the router is identical. That is precisely why
  // the old shape was dangerous — nothing would have noticed it fail open. This
  // calls the handler the way a future caller might: directly, with no context.
  const queries: QueryLog[] = [];
  const storage: StorageCall[] = [];

  const originalEnv = process.env;
  process.env = { NODE_ENV: "test", SUPABASE_URL: ORIGIN, SUPABASE_SERVICE_ROLE_KEY: SECRET };

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };

  const jobId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  supabaseModule.setSupabaseServerClientFactoryForTests(() => ({
    from: dbSpy({ video_processing_jobs: [{ id: jobId, workspace_id: WORKSPACE_B, status: "ready" }] }, queries),
    storage: storageSpy(storage),
  }));

  try {
    const serverModule = (await import(
      pathToFileURL(path.join(repoRoot, "lib", "crm", "server.ts")).href
    )) as { handleVideoJobs: (req: unknown, res: MockResponse) => Promise<unknown> };

    const res = mockResponse();
    await serverModule.handleVideoJobs({ method: "GET", headers: {}, query: { id: jobId } }, res);

    assert.equal(res.statusCode, 502, `an unverified workspace must fail closed: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "video_job_unconfirmed");
    assert.equal(res.body.success, false);
    assert.equal(res.body.data, undefined);
    assert.deepEqual(queries, [], "unverified workspace must be rejected before the SDK sees a query");
    assert.deepEqual(storage, []);
    assert.equal(
      JSON.stringify(res.body).includes(WORKSPACE_B),
      false,
      "and nothing of the owning workspace may appear in the answer",
    );
  } finally {
    process.env = originalEnv;
    supabaseModule.setSupabaseServerClientFactoryForTests(null);
  }
});

// ===========================================================================
// E. The creative registration contract, moved somewhere it actually runs
// ===========================================================================

// A route smoke stops at authentication. Here an authorized actor exercises
// every historical URL alias: none may substitute for a verified upload handle.
// Multipart and staged-upload success receipts are covered by ST1/ST2/ST15.

const CREATIVE_BASE = {
  fileName: "creative.jpg",
  fileType: "image",
  mimeType: "image/jpeg",
  fileSize: 2048,
  status: "uploaded",
};

function assertHandleRequired(result: Awaited<ReturnType<Awaited<ReturnType<typeof loadRouter>>["call"]>>) {
  assert.equal(result.res.statusCode, 400, JSON.stringify(result.res.body));
  assert.equal(result.res.body.success, false);
  assert.equal(result.res.body.code, "creative_upload_verification_required");
  assert.equal(result.res.body.mode, undefined);
  assert.equal(result.res.body.data, undefined);
  assert.deepEqual(result.storage, [], "metadata cannot reach any storage boundary");
  assert.deepEqual(result.rpcs, [], "metadata cannot reserve or promote an upload");
  assert.deepEqual(result.queries.filter((q) => !["staff_users", "workspace_settings"].includes(q.table)), []);
}

test("ST11 every public URL alias is refused without a verified upload handle", async () => {
  const url = "https://cdn.example.test/creative.jpg";
  for (const field of [
    "publicUrl",
    "public_url",
    "publicURL",
    "url",
    "imageUrl",
    "image_url",
    "videoUrl",
    "creativeUrl",
  ]) {
    for (const segments of [["ad-creative-upload"], ["ad-creatives"], ["ad-creatives", "finalize-upload"]]) {
      await withRouter({}, async (ctx) => {
        const result = await ctx.call({ segments, method: "POST",
          body: { ...CREATIVE_BASE, [field]: url, id: OWN_ASSET, workspaceId: WORKSPACE_B } });
        assertHandleRequired(result);
        assert.equal(ctx.rows.ad_creative_assets?.length ?? 0, 0, `${field} must never become a saved asset`);
      });
    }
  }
});

test("ST12 stored bucket/path metadata cannot derive a public receipt without a handle", async () => {
  await withRouter({}, async (ctx) => {
    const result = await ctx.call({
      segments: ["ad-creative-upload"],
      method: "POST",
      body: {
        ...CREATIVE_BASE,
        storageBucket: "ad-creatives",
        storagePath: `${WORKSPACE_A}/2026/07/creative.jpg`,
      },
    });

    assertHandleRequired(result);
  });
});

test("ST13 a creative with neither a URL nor a stored object is refused, not saved blind", async () => {
  await withRouter({}, async (ctx) => {
    const result = await ctx.call({
      segments: ["ad-creative-upload"],
      method: "POST",
      body: CREATIVE_BASE,
    });

    assertHandleRequired(result);
    assert.equal(
      result.queries.some((entry) => entry.table === "ad_creative_assets"),
      false,
      "a creative with no reachable link must not reach the table",
    );
  });
});

// ===========================================================================
// F. A multi-workspace browser signs and confirms the selected tenant
// ===========================================================================

test("ST14 signed upload requires and obeys the explicit workspace selector", async () => {
  await withRouter({ staff_users: [memberA, memberB] }, async (ctx) => {
    const body = {
      fileName: "creative.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 2048,
      workspaceId: WORKSPACE_B,
      requestKey: REQUEST_KEY,
    };
    const missing = await ctx.call({
      segments: ["ad-creatives", "signed-upload"],
      method: "POST",
      body,
    });
    assert.equal(missing.res.statusCode, 403, JSON.stringify(missing.res.body));
    assert.deepEqual(profileQueries(missing.queries), [], "an ambiguous membership must not read any tenant profile");
    assert.equal(missing.storage.length, 0, "an ambiguous tenant must not receive an upload token");
    assert.deepEqual(missing.rpcs, []);

    const selected = await ctx.call({
      segments: ["ad-creatives", "signed-upload"],
      method: "POST",
      query: { workspaceId: WORKSPACE_A },
      body,
    });
    assert.equal(selected.res.statusCode, 200, JSON.stringify(selected.res.body));
    assert.deepEqual(profileQueries(selected.queries), [{ table: "workspace_settings", op: "select",
      columns: "workspace_id, value", filters: { workspace_id: [WORKSPACE_A], key: "workspace_purpose" } }]);
    const signed = selected.storage.filter((entry) => entry.op === "createSignedUploadUrl");
    assert.equal(signed.length, 1);
    assert.equal(signed[0].bucket, STAGING_BUCKET);
    assert.ok(signed[0].key.startsWith(`${WORKSPACE_A}/`), `selector was ignored: ${signed[0].key}`);
    assert.equal(signed[0].key.includes(WORKSPACE_B), false, "a body workspace must not select the upload tenant");
    const receipt = selected.res.body.data as Row;
    const ticket = readStagedCreativeTicket(receipt.uploadHandle, { workspaceId: WORKSPACE_A, userId: USER_A, staffUserId: STAFF_A }, SECRET);
    assert.equal(signed[0].key, `${WORKSPACE_A}/staged/${ticket.id}/original.jpg`);
    assert.equal(receipt.publicUrl, undefined);
    assert.equal(selected.rpcs[0].args.p_workspace_id, WORKSPACE_A);
    assert.equal(selected.rpcs[0].args.p_staff_user_id, STAFF_A);
  });
});

test("ST15 browser flows share a workspace-bound private upload helper", async () => {
  const [adsPage, contentStudio] = await Promise.all([readFile(adsPagePath, "utf8"), readFile(contentStudioPath, "utf8")]);
  for (const source of [adsPage, contentStudio]) {
    assert.ok(source.includes('from "@/lib/verified-creative-upload"'), "both clients import the shared verified workflow");
    assert.ok(source.includes("await uploadVerifiedCreativeImage({"), "both clients dispatch through the shared helper");
    assert.equal(source.includes("/api/crm/ad-creatives/signed-upload"), false, "no page-owned public signing bypass");
  }
  assert.equal((adsPage.match(/\/api\/crm\/video-jobs\?workspaceId=\$\{encodeURIComponent\(workspaceId\)\}/g) || []).length, 2,
    "video signing and confirmation retain their active workspace selector");
  assert.match(contentStudio, /expectedUserId: actorId, dispatchGuard: photoCurrent, signal: session\.signal/);
  assert.ok(contentStudio.includes("assertCurrent: assertPhotoCurrent"));
  assert.ok(adsPage.includes("assertCurrent: async () => { assertCreativeIntent(session, intent); }"));

  await withRouter({ staff_users: [memberA, memberB] }, async (ctx) => {
    const { uploadVerifiedCreativeImage } = await import(pathToFileURL(
      path.join(repoRoot, "artifacts", "negis", "src", "lib", "verified-creative-upload.ts")).href
    ) as {
      uploadVerifiedCreativeImage(input: {
        workspaceId: string; file: Blob; fileName: string; mimeType: string; requestKey: string; storageOrigin: string;
        assertCurrent(): Promise<void>;
        request(url: string, init: RequestInit): Promise<{ success: boolean; mode: string; data: unknown }>;
        upload(bucket: string, key: string, token: string, file: Blob, options: { contentType: string; upsert: false }): Promise<{ data?: unknown; error?: unknown }>;
      }): Promise<{ id: string; workspaceId: string; fileName: string; fileType: "image"; mimeType: string; fileSize: number;
        storageBucket: "ad-creatives"; storagePath: string; publicUrl: string; status: "uploaded" | "ready" }>;
    };
    const blob = new Blob([new Uint8Array(multipartBody({}).file)], { type: "image/jpeg" });
    const requests: Array<{ path: string; body: Row }> = [];
    let finalResult: Awaited<ReturnType<typeof ctx.call>> | undefined;
    let fences = 0, uploads = 0;
    const asset = await uploadVerifiedCreativeImage({
      workspaceId: WORKSPACE_A, file: blob, fileName: "creative.jpg", mimeType: "image/jpeg",
      requestKey: REQUEST_KEY, storageOrigin: ORIGIN, assertCurrent: async () => { fences++; },
      request: async (url, init) => {
        const parsed = new URL(url, ORIGIN);
        assert.equal(parsed.searchParams.get("workspaceId"), WORKSPACE_A);
        const body = JSON.parse(String(init.body));
        requests.push({ path: parsed.pathname, body });
        const result = await ctx.call({ segments: parsed.pathname.slice("/api/crm/".length).split("/"),
          method: init.method, body, query: { workspaceId: parsed.searchParams.get("workspaceId") } });
        assert.equal(result.res.statusCode, parsed.pathname.endsWith("finalize-upload") ? 201 : 200, JSON.stringify(result.res.body));
        if (parsed.pathname.endsWith("finalize-upload")) finalResult = result;
        return { success: result.res.body.success === true, mode: String(result.res.body.mode || ""), data: result.res.body.data };
      },
      upload: async (bucket, key, token, file, options) => {
        uploads++;
        assert.equal(bucket, STAGING_BUCKET);
        assert.equal(token, "signed-token");
        assert.equal(file, blob);
        assert.ok(key.startsWith(`${WORKSPACE_A}/staged/`));
        assert.deepEqual(options, { contentType: "image/jpeg", upsert: false });
        assert.equal(ctx.published.size, 0, "a private upload is not a ready public asset");
        ctx.staged.set(key, Buffer.from(await file.arrayBuffer()));
        return { data: { path: key }, error: null };
      },
    });
    assert.equal(uploads, 1);
    assert.ok(fences >= 6, "the actual shared helper fences every awaited boundary");
    assert.deepEqual(requests.map((r) => r.path), ["/api/crm/ad-creatives/signed-upload", "/api/crm/ad-creatives/finalize-upload"]);
    assert.equal(requests[0].body.requestKey, REQUEST_KEY);
    assert.deepEqual(Object.keys(requests[1].body), ["uploadHandle"]);
    assert.ok(finalResult);
    assert.deepEqual(asset, assertVerifiedPromotion(finalResult, ctx));
    const operationRead = finalResult.queries.find((q) => q.table === "creative_upload_operations");
    assert.ok(operationRead);
    assert.deepEqual(operationRead.filters, { id: asset.id, workspace_id: WORKSPACE_A, auth_user_id: USER_A, staff_user_id: STAFF_A });
  });
});

for (const sourceWorkspace of [WORKSPACE_A, WORKSPACE_B]) {
  test(`ST16 a handle reserved for ${sourceWorkspace} cannot finalize in the other active workspace`, async () => {
    await withRouter({ staff_users: [memberA, memberB] }, async (ctx) => {
      const prepared = await ctx.call({ segments: ["ad-creatives", "signed-upload"], method: "POST",
        query: { workspaceId: sourceWorkspace }, body: { ...CREATIVE_BASE, requestKey: REQUEST_KEY } });
      assert.equal(prepared.res.statusCode, 200, JSON.stringify(prepared.res.body));
      const before = structuredClone(ctx.rows.creative_upload_operations);
      const targetWorkspace = sourceWorkspace === WORKSPACE_A ? WORKSPACE_B : WORKSPACE_A;
      const result = await ctx.call({ segments: ["ad-creatives", "finalize-upload"], method: "POST",
        query: { workspaceId: targetWorkspace }, body: { uploadHandle: (prepared.res.body.data as Row).uploadHandle, workspaceId: sourceWorkspace } });
      assert.equal(result.res.statusCode, 400, JSON.stringify(result.res.body));
      assert.equal(result.res.body.code, "creative_upload_ticket_unconfirmed");
      assert.equal(result.res.body.success, false);
      assert.equal(result.res.body.data, undefined);
      assert.deepEqual(result.rpcs, []);
      assert.deepEqual(result.storage, []);
      assert.deepEqual(result.queries.filter((q) => !["staff_users", "workspace_settings"].includes(q.table)), []);
      assert.deepEqual(ctx.rows.creative_upload_operations, before);
      assert.equal(ctx.rows.ad_creative_assets?.length ?? 0, 0);
    });
  });
}

test("ST17 an explicit foreign workspace cannot mint a ticket through body spoofing", async () => {
  await withRouter({}, async (ctx) => {
    const result = await ctx.call({ segments: ["ad-creatives", "signed-upload"], method: "POST",
      query: { workspaceId: WORKSPACE_B }, body: { ...CREATIVE_BASE, workspaceId: WORKSPACE_A, requestKey: REQUEST_KEY } });
    assert.equal(result.res.statusCode, 403, JSON.stringify(result.res.body));
    assert.equal(result.res.body.success, false);
    assert.equal(result.res.body.data, undefined);
    assert.deepEqual(profileQueries(result.queries), []);
    assert.deepEqual(result.storage, []); assert.deepEqual(result.rpcs, []);
  });
});

for (const endpoint of ["video-jobs", "video-processing-jobs"]) {
  test(`ST18 ${endpoint} cannot reveal an actual foreign job by its exact id`, async () => {
    const foreign = { id: FOREIGN_JOB, workspace_id: WORKSPACE_B, status: "failed", raw_path: `${WORKSPACE_B}/private.mov` };
    await withRouter({ video_processing_jobs: [foreign] }, async (ctx) => {
      const result = await ctx.call({ segments: [endpoint], query: { id: FOREIGN_JOB, workspaceId: WORKSPACE_A } });
      assert.equal(result.res.statusCode, 404, JSON.stringify(result.res.body));
      assert.equal(result.res.body.data, undefined);
      assert.equal(JSON.stringify(result.res.body).includes(WORKSPACE_B), false);
      const read = result.queries.filter((q) => q.table === "video_processing_jobs");
      assert.equal(read.length, 1);
      assert.deepEqual(read[0].filters, { id: FOREIGN_JOB, workspace_id: WORKSPACE_A });
      assert.deepEqual(ctx.rows.video_processing_jobs, [foreign]);
      assert.deepEqual(result.storage, []); assert.deepEqual(result.rpcs, []);
    });
  });
}

test("ST19 an own ready job cannot adopt another workspace's asset receipt", async () => {
  const path = `optimized/${WORKSPACE_A}/${OWN_JOB}/video.mp4`;
  const thumbnail = `optimized/${WORKSPACE_A}/${OWN_JOB}/cover.jpg`;
  const url = `${ORIGIN}/storage/v1/object/public/ad-creatives/${path}`;
  await withRouter({ video_processing_jobs: [{ id: OWN_JOB, workspace_id: WORKSPACE_A, status: "ready", asset_id: OWN_ASSET,
    raw_path: `${WORKSPACE_A}/original.mov`, optimized_bucket: "ad-creatives", optimized_path: path, optimized_public_url: url,
    output_mime_type: "video/mp4", output_size_bytes: 1024, thumbnail_path: thumbnail,
    thumbnail_url: `${ORIGIN}/storage/v1/object/public/ad-creatives/${thumbnail}` }],
    ad_creative_assets: [{ id: OWN_ASSET, workspace_id: WORKSPACE_B, file_type: "video", mime_type: "video/mp4",
      file_size: 1024, file_name: "foreign.mp4", storage_bucket: "ad-creatives", storage_path: path, public_url: url, status: "uploaded" }],
  }, async (ctx) => {
    const result = await ctx.call({ segments: ["video-jobs"], query: { id: OWN_JOB, workspaceId: WORKSPACE_A } });
    assert.equal(result.res.statusCode, 502, JSON.stringify(result.res.body));
    assert.equal(result.res.body.code, "video_job_unconfirmed");
    assert.equal(result.res.body.success, false); assert.equal(result.res.body.data, undefined);
    const assetRead = result.queries.find((q) => q.table === "ad_creative_assets");
    assert.ok(assetRead);
    assert.deepEqual(assetRead.filters, { id: OWN_ASSET, workspace_id: WORKSPACE_A });
    assert.equal((ctx.rows.ad_creative_assets[0] as Row).workspace_id, WORKSPACE_B);
    assert.deepEqual(result.storage, []); assert.deepEqual(result.rpcs, []);
  });
});
