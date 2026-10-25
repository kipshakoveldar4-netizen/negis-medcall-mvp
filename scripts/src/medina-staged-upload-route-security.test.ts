import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Exercise the real catch-all, including live actor resolution. All SDK and
// fetch boundaries below are synthetic; no environment file is loaded.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "https://staged-route.fixture.invalid";
const SECRET = "SYNTHETIC_STAGED_ROUTE_SECRET_NEVER_REAL_088";
const TOKEN = "synthetic.route.signature";
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const STAFF_A = "33333333-3333-4333-8333-333333333333";
const STAFF_B = "44444444-4444-4444-8444-444444444444";
const ASSET_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_KEY = "66666666-6666-4666-8666-666666666666";
const STAGING_BUCKET = "ad-creatives-staging";

type Json = Record<string, unknown>;
type Actor = { workspaceId: string; userId: string; staffUserId: string };
type Ticket = Actor & {
  v: 1; id: string; fileName: string; mimeType: string; fileSize: number;
  issuedAt: number; expiresAt: number;
};
const { issueStagedCreativeTicket, readStagedCreativeTicket } = await import(
  pathToFileURL(path.join(root, "lib/crm/staged-creative-ticket.ts")).href
) as {
  issueStagedCreativeTicket(input: Actor & { fileName: string; mimeType: string; fileSize: number }, secret: string): {
    handle: string; ticket: Ticket;
  };
  readStagedCreativeTicket(handle: unknown, actor: Actor, secret: string): Ticket;
};

const actor: Actor = { workspaceId: WORKSPACE_A, userId: USER_A, staffUserId: STAFF_A };
const image = { requestKey: REQUEST_KEY, fileName: "synthetic.jpg", fileType: "image", mimeType: "image/jpeg", fileSize: 128 };
const member = (role = "owner", overrides: Json = {}): Json => ({
  id: STAFF_A, workspace_id: WORKSPACE_A, auth_user_id: USER_A, role, status: "active", ...overrides,
});

const routes = [
  { name: "prepare", segments: ["ad-creatives", "signed-upload"] },
  { name: "finalize", segments: ["ad-creatives", "finalize-upload"] },
  { name: "generic JSON create", segments: ["ad-creatives"] },
  { name: "JSON upload", segments: ["ad-creative-upload"] },
] as const;
const jsonCreateRoutes = routes.slice(2);
const finalizeRoutes = routes.slice(1);

type Query = {
  table: string; op: "select" | "insert" | "update" | "upsert" | "delete";
  filters: Array<{ kind: "eq" | "in"; column: string; value: unknown }>;
  columns?: string; values?: unknown;
};
type SdkCall = { op: string; bucket?: string; key?: string; options?: unknown };
type RpcCall = { name: string; args: Json };
type MockResponse = {
  statusCode: number; body: Json;
  status(code: number): MockResponse;
  setHeader(name: string, value: unknown): MockResponse;
  json(body: Json): MockResponse;
  end(): MockResponse;
};
type RequestInput = {
  segments: readonly string[]; method?: string; query?: Json; body?: Json; token?: string | null;
};
type Result = {
  res: MockResponse; queries: Query[]; storage: SdkCall[]; rpcs: RpcCall[];
  authRequests: number; clientCreations: number; unexpectedFetches: string[];
};

function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

async function withRouter(options: { memberships?: Json[]; authOk?: boolean; videoWorkerEnabled?: boolean }, run: (ctx: {
  call(input: RequestInput): Promise<Result>;
}) => Promise<void>): Promise<void> {
  const previousEnv = process.env;
  const previousFetch = globalThis.fetch;
  const queries: Query[] = [], storage: SdkCall[] = [], rpcs: RpcCall[] = [];
  const unexpectedFetches: string[] = [];
  let authRequests = 0, clientCreations = 0;
  let resetFactory: (() => void) | undefined;

  // Replace, do not merge: inherited project/provider secrets cannot influence
  // these requests. Restore the original object even when import or assertions fail.
  process.env = { NODE_ENV: "test", SUPABASE_URL: ORIGIN, SUPABASE_SERVICE_ROLE_KEY: SECRET,
    VIDEO_OPTIMIZATION_ENABLED: options.videoWorkerEnabled ? "true" : "false" };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(record(input).url ?? "");
    if (url === `${ORIGIN}/auth/v1/user`) {
      authRequests++;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(headers.get("apikey"), SECRET);
      return new Response(JSON.stringify(options.authOk === false ? {} : { id: USER_A, email: "actor@fixture.invalid" }), {
        status: options.authOk === false ? 401 : 200, headers: { "content-type": "application/json" },
      });
    }
    unexpectedFetches.push(url);
    return new Response("Synthetic fixture forbids non-auth fetch", { status: 503 });
  }) as typeof globalThis.fetch;

  try {
    const { setSupabaseServerClientFactoryForTests } = await import(
      pathToFileURL(path.join(root, "lib/supabase/server.ts")).href
    ) as { setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void };
    resetFactory = () => setSupabaseServerClientFactoryForTests(null);
    setSupabaseServerClientFactoryForTests(() => {
      clientCreations++;
      return {
        from(table: string) {
          const entry: Query = { table, op: "select", filters: [] };
          queries.push(entry);
          const builder: Record<string, unknown> = {};
          const result = (single = false) => {
            let rows: Json[] = table === "staff_users" ? options.memberships ?? [member()] : [];
            if (entry.op !== "select") {
              const values = Array.isArray(entry.values) ? entry.values : [entry.values];
              rows = values.map(value => ({ id: ASSET_ID, ...record(value) }));
            }
            rows = rows.filter(row => entry.filters.every(filter => filter.kind === "in"
              ? Array.isArray(filter.value) && filter.value.includes(row[filter.column])
              : row[filter.column] === filter.value));
            return { data: single ? rows[0] ?? null : rows, error: null, count: rows.length };
          };
          Object.assign(builder, {
            select(columns?: string) { entry.columns = columns; return builder; },
            insert(values: unknown) { entry.op = "insert"; entry.values = values; return builder; },
            update(values: unknown) { entry.op = "update"; entry.values = values; return builder; },
            upsert(values: unknown) { entry.op = "upsert"; entry.values = values; return builder; },
            delete() { entry.op = "delete"; return builder; },
            eq(column: string, value: unknown) { entry.filters.push({ kind: "eq", column, value }); return builder; },
            in(column: string, value: unknown) { entry.filters.push({ kind: "in", column, value }); return builder; },
            order() { return builder; },
            limit() { return builder; },
            single() { return Promise.resolve(result(true)); },
            maybeSingle() { return Promise.resolve(result(true)); },
            then(resolve: (value: ReturnType<typeof result>) => unknown, reject?: (error: unknown) => unknown) {
              return Promise.resolve(result()).then(resolve, reject);
            },
          });
          return builder;
        },
        async rpc(name: string, args: Json) {
          rpcs.push({ name, args });
          if (name === "reserve_creative_upload") {
            const { ticket } = issueStagedCreativeTicket({
              workspaceId: String(args.p_workspace_id), userId: String(args.p_auth_user_id),
              staffUserId: String(args.p_staff_user_id), fileName: String(args.p_file_name),
              mimeType: String(args.p_mime_type), fileSize: Number(args.p_file_size),
            }, SECRET);
            return { data: { ticket, requestKey: args.p_request_key, status: "reserved" }, error: null };
          }
          return { data: null, error: { code: "P8803", message: "SYNTHETIC_UNAVAILABLE_OPERATION" } };
        },
        storage: {
          async getBucket(bucket: string) {
            storage.push({ op: "getBucket", bucket });
            if (options.videoWorkerEnabled && bucket === "ad-creatives-raw") {
              return { data: { id: "ad-creatives-raw", name: "ad-creatives-raw", public: false,
                file_size_limit: 500 * 1024 * 1024,
                allowed_mime_types: ["video/mp4", "video/quicktime", "video/webm"] }, error: null };
            }
            return { data: { id: bucket, name: bucket, public: false, file_size_limit: 100 * 1024 * 1024,
              allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"] }, error: null };
          },
          from(bucket: string) {
            return {
              async list(_folder: string, options: Json) {
                assert.equal(bucket, "ad-creatives-staging"); assert.equal(options.limit, 2);
                return { data: [], error: null };
              },
              async createSignedUploadUrl(key: string, uploadOptions?: unknown) {
                storage.push({ op: "createSignedUploadUrl", bucket, key, options: uploadOptions });
                return { data: { path: key, token: "SYNTHETIC_UPLOAD_TOKEN",
                  signedUrl: `${ORIGIN}/storage/v1/object/upload/sign/${bucket}/${key}?token=SYNTHETIC_UPLOAD_TOKEN` }, error: null };
              },
              getPublicUrl(key: string) {
                storage.push({ op: "getPublicUrl", bucket, key });
                return { data: { publicUrl: `${ORIGIN}/storage/v1/object/public/${bucket}/${key}` } };
              },
              async upload(key: string, _bytes: unknown, uploadOptions?: unknown) {
                storage.push({ op: "upload", bucket, key, options: uploadOptions });
                return { data: null, error: { message: "SYNTHETIC_UPLOAD_FORBIDDEN" } };
              },
              async download(key: string) {
                storage.push({ op: "download", bucket, key });
                return { data: null, error: { message: "SYNTHETIC_DOWNLOAD_FORBIDDEN" } };
              },
              async remove(keys: string[]) {
                storage.push({ op: "remove", bucket, options: keys });
                return { data: null, error: { message: "SYNTHETIC_REMOVE_FORBIDDEN" } };
              },
            };
          },
        },
      };
    });
    const { default: handler } = await import(pathToFileURL(path.join(root, "api/crm/[...path].ts")).href) as {
      default(req: unknown, res: MockResponse): Promise<unknown>;
    };
    await run({
      async call(input) {
        queries.length = storage.length = rpcs.length = unexpectedFetches.length = 0;
        authRequests = clientCreations = 0;
        const res: MockResponse = {
          statusCode: 0, body: {},
          status(code) { this.statusCode = code; return this; },
          setHeader() { return this; },
          json(body) { this.body = body; return this; },
          end() { return this; },
        };
        await handler({
          method: input.method ?? "POST", url: `/api/crm/${input.segments.join("/")}`,
          headers: { "content-type": "application/json", ...(input.token === null ? {} : { authorization: `Bearer ${input.token ?? TOKEN}` }) },
          query: { ...(input.query ?? {}), path: [...input.segments] }, body: input.body ?? { ...image },
        }, res);
        assert.deepEqual(unexpectedFetches, [], "no object URL, provider or real fetch may be reached by these cases");
        return { res, queries: structuredClone(queries), storage: structuredClone(storage), rpcs: structuredClone(rpcs),
          authRequests, clientCreations, unexpectedFetches: [...unexpectedFetches] };
      },
    });
  } finally {
    resetFactory?.();
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
}

function assertRefused(result: Result): void {
  assert.ok(result.res.statusCode >= 400 && result.res.statusCode < 500,
    `controlled client refusal required, received ${result.res.statusCode}: ${JSON.stringify(result.res.body)}`);
  assert.equal(result.res.body.success, false);
}

function assertNoUploadEffects(result: Result): void {
  assert.deepEqual(result.storage, [], "a denied request must not sign, read, publish or delete an object");
  assert.deepEqual(result.rpcs, [], "a denied request must not reserve or finalize an operation");
  assert.ok(result.queries.every(query => query.op === "select"
    && (query.table === "staff_users" || query.table === "workspace_settings")),
  `only membership/purpose reads are allowed: ${JSON.stringify(result.queries.map(({ table, op }) => ({ table, op })))}`);
}

function assertPreparedForActor(result: Result, expected: Actor): void {
  assert.ok(result.res.statusCode >= 200 && result.res.statusCode < 300, JSON.stringify(result.res.body));
  assert.equal(result.res.body.success, true);
  const data = record(result.res.body.data);
  assert.equal(typeof data.uploadHandle, "string");
  const ticket = readStagedCreativeTicket(data.uploadHandle, expected, SECRET);
  assert.equal(ticket.fileName, image.fileName);
  assert.equal(ticket.mimeType, image.mimeType);
  assert.equal(ticket.fileSize, image.fileSize);
  assert.equal(data.storageBucket, STAGING_BUCKET);
  assert.equal(data.storagePath, `${expected.workspaceId}/staged/${ticket.id}/original.jpg`);
  assert.equal(data.token, "SYNTHETIC_UPLOAD_TOKEN");
  assert.equal(data.signedUrl,
    `${ORIGIN}/storage/v1/object/upload/sign/${STAGING_BUCKET}/${String(data.storagePath)}?token=SYNTHETIC_UPLOAD_TOKEN`);
  assert.ok(!JSON.stringify(result.res.body).includes("/object/public/"), "prepare must not expose a public URL");
  assert.ok(!JSON.stringify(result.res.body).includes('"publicUrl"'), "prepare is not a ready creative receipt");
  assert.ok(!JSON.stringify(result.res.body).includes(SECRET));
  assert.deepEqual(result.storage.filter(call => call.op === "createSignedUploadUrl"), [{
    op: "createSignedUploadUrl", bucket: STAGING_BUCKET, key: data.storagePath, options: { upsert: false },
  }], "exactly one non-overwriting private upload grant may be minted");
  assert.ok(result.storage.every(call => call.bucket === STAGING_BUCKET), "not even a public-bucket token may be minted");
  assert.ok(result.queries.every(query => query.op === "select"), "prepare must not directly insert a creative");
  assert.deepEqual(result.rpcs, [{ name: "reserve_creative_upload", args: {
    p_workspace_id: expected.workspaceId, p_staff_user_id: expected.staffUserId, p_auth_user_id: expected.userId,
    p_request_key: REQUEST_KEY, p_file_name: image.fileName, p_mime_type: image.mimeType, p_file_size: image.fileSize,
    p_source: "signed",
  } }], "reservation identity must come only from the router's verified actor");
}

function forgedMetadata(extra: Json = {}): Json {
  const storagePath = `${WORKSPACE_B}/verified/${ASSET_ID}/${"1".repeat(64)}.jpg`;
  return {
    ...image, id: ASSET_ID, assetId: ASSET_ID, workspaceId: WORKSPACE_B, workspace_id: WORKSPACE_B,
    userId: USER_B, staffUserId: STAFF_B, uploadedBy: USER_B, uploaded_by: USER_B,
    role: "owner", permissions: ["manage_marketing"], status: "ready",
    storageBucket: "ad-creatives", storage_bucket: "ad-creatives", storagePath, storage_path: storagePath,
    publicUrl: `${ORIGIN}/storage/v1/object/public/ad-creatives/${storagePath}`,
    url: "https://untrusted.fixture.invalid/already-verified.jpg", verified_upload_key: ASSET_ID,
    verified_upload_sha256: "1".repeat(64), verified_upload_actor_id: USER_B,
    metadata: { verified: true, uploadMode: "verified-staged", contentSha256: "1".repeat(64) }, ...extra,
  };
}

for (const route of routes) {
  test(`${route.name}: anonymous body/query credentials cannot authorize an upload`, async () => {
    await withRouter({}, async ctx => {
      const result = await ctx.call({ segments: route.segments, token: null,
        query: { workspaceId: WORKSPACE_A, access_token: TOKEN, role: "owner" },
        body: forgedMetadata({ access_token: TOKEN, uploadHandle: "forged" }) });
      assertRefused(result);
      assertNoUploadEffects(result);
      assert.equal(result.authRequests, 0);
      assert.equal(result.clientCreations, 0);
      assert.deepEqual(result.queries, []);
    });
  });

  test(`${route.name}: an Auth-rejected JWT cannot use a body upload handle`, async () => {
    await withRouter({ authOk: false }, async ctx => {
      const result = await ctx.call({ segments: route.segments, body: forgedMetadata({ uploadHandle: "forged" }) });
      assertRefused(result);
      assertNoUploadEffects(result);
      assert.equal(result.authRequests, 1);
      assert.deepEqual(result.queries, []);
    });
  });

  test(`${route.name}: verified but unlinked users cannot borrow another user's membership`, async () => {
    for (const memberships of [[], [member("owner", { auth_user_id: USER_B })]]) {
      await withRouter({ memberships }, async ctx => {
        const result = await ctx.call({ segments: route.segments, query: { workspaceId: WORKSPACE_A }, body: forgedMetadata() });
        assertRefused(result);
        assertNoUploadEffects(result);
        assert.equal(result.authRequests, 1);
        assert.ok(result.queries.length > 0);
        assert.ok(result.queries.every(query => query.table === "staff_users"));
        assert.ok(result.queries.every(query => query.filters.some(filter => filter.column === "auth_user_id" && filter.value === USER_A)));
      });
    }
  });

  for (const role of ["doctor", "receptionist", "manager", "lead_manager"]) {
    test(`${route.name}: ${role} cannot claim manage_marketing in body or query`, async () => {
      await withRouter({ memberships: [member(role)] }, async ctx => {
        const result = await ctx.call({ segments: route.segments,
          query: { workspaceId: WORKSPACE_A, role: "owner", permissions: ["manage_marketing"] },
          body: forgedMetadata({ uploadHandle: "forged" }) });
        assertRefused(result);
        assertNoUploadEffects(result);
        assert.equal(result.authRequests, 1);
        assert.ok(result.queries.length > 0);
        assert.ok(result.queries.every(query => query.table === "staff_users"), "role refusal must precede business/profile reads");
      });
    });
  }

  test(`${route.name}: a foreign query workspace is not rescued by an own-workspace body`, async () => {
    await withRouter({}, async ctx => {
      for (const selector of ["workspaceId", "workspace_id"]) {
        const result = await ctx.call({ segments: route.segments, query: { [selector]: WORKSPACE_B },
          body: forgedMetadata({ workspaceId: WORKSPACE_A, workspace_id: WORKSPACE_A }) });
        assertRefused(result);
        assertNoUploadEffects(result);
        assert.ok(result.queries.every(query => query.table === "staff_users"));
      }
    });
  });

  test(`${route.name}: selecting a linked doctor workspace cannot borrow another workspace's owner role`, async () => {
    await withRouter({ memberships: [member(), member("doctor", { id: STAFF_B, workspace_id: WORKSPACE_B })] }, async ctx => {
      const result = await ctx.call({ segments: route.segments, query: { workspaceId: WORKSPACE_B },
        body: forgedMetadata({ workspaceId: WORKSPACE_A, staffUserId: STAFF_A, uploadHandle: "forged" }) });
      assertRefused(result);
      assertNoUploadEffects(result);
      assert.ok(result.queries.every(query => query.table === "staff_users"));
    });
  });

  test(`${route.name}: body workspace cannot select between multiple active memberships`, async () => {
    await withRouter({ memberships: [member(), member("marketer", { id: STAFF_B, workspace_id: WORKSPACE_B })] }, async ctx => {
      const result = await ctx.call({ segments: route.segments, body: forgedMetadata({ workspaceId: WORKSPACE_A }) });
      assertRefused(result);
      assertNoUploadEffects(result);
      assert.ok(result.queries.length > 0);
      assert.ok(result.queries.every(query => query.table === "staff_users"));
    });
  });
}

for (const role of ["owner", "marketer"]) {
  for (const route of jsonCreateRoutes) {
    test(`${route.name}: ${role} metadata, IDs and URLs cannot substitute for a missing uploadHandle`, async () => {
      await withRouter({ memberships: [member(role)] }, async ctx => {
        const result = await ctx.call({ segments: route.segments, body: forgedMetadata() });
        assertNoUploadEffects(result);
        assert.equal(result.res.statusCode, 400);
        assert.equal(result.res.body.success, false);
        assert.equal(result.res.body.code, "creative_upload_verification_required");
      });
    });
  }

  for (const route of finalizeRoutes) {
    test(`${route.name}: ${role}'s correctly signed but unreserved handle is not an upload receipt`, async () => {
      const issued = issueStagedCreativeTicket({ ...actor, ...image }, SECRET);
      await withRouter({ memberships: [member(role)] }, async ctx => {
        const result = await ctx.call({ segments: route.segments, query: { workspaceId: WORKSPACE_A },
          body: forgedMetadata({ uploadHandle: issued.handle }) });
        assertRefused(result);
        assert.deepEqual(result.storage, [], "an absent reservation must not trigger reads or promotion of body URLs");
        assert.deepEqual(result.rpcs, [], "an absent reservation must not be inserted or committed from the body");
        assert.ok(result.queries.every(query => query.op === "select"), "a signed manifest alone cannot insert an asset");
        assert.ok(result.queries.every(query => ["staff_users", "workspace_settings", "creative_upload_operations"].includes(query.table)));
        const operations = result.queries.filter(query => query.table === "creative_upload_operations");
        assert.equal(operations.length, 1, "the router must consult the server reservation rather than accept body IDs/URLs");
        assert.ok(operations[0]?.filters.every(filter => filter.kind === "eq"));
        assert.deepEqual(Object.fromEntries(operations[0]!.filters.map(filter => [filter.column, filter.value])), {
          id: issued.ticket.id, workspace_id: WORKSPACE_A, auth_user_id: USER_A, staff_user_id: STAFF_A,
        }, "even the reservation read must use the verified actor and signed identity, never the request body");
      });
    });

    test(`${route.name}: ${role} cannot move a handle into query, metadata, aliases or a non-string wrapper`, async () => {
      const { handle } = issueStagedCreativeTicket({ ...actor, ...image }, SECRET);
      const bodies = [
        forgedMetadata(), forgedMetadata({ uploadHandle: null }), forgedMetadata({ uploadHandle: "" }),
        forgedMetadata({ uploadHandle: { handle } }), forgedMetadata({ uploadHandle: [handle] }),
        forgedMetadata({ upload_handle: handle, handle, metadata: { uploadHandle: handle, verified: true } }),
      ];
      await withRouter({ memberships: [member(role)] }, async ctx => {
        for (const body of bodies) {
          const result = await ctx.call({ segments: route.segments,
            query: { workspaceId: WORKSPACE_A, uploadHandle: handle, assetId: ASSET_ID }, body });
          assertNoUploadEffects(result);
          assertRefused(result);
          if (route.name !== "finalize") {
            assert.equal(result.res.statusCode, 400);
            assert.equal(result.res.body.code, "creative_upload_verification_required");
          }
        }
      });
    });

    test(`${route.name}: ${role}'s real signed handle does not outlive an active membership`, async () => {
      const { handle } = issueStagedCreativeTicket({ ...actor, ...image }, SECRET);
      await withRouter({ memberships: [member(role, { status: "inactive" })] }, async ctx => {
        const result = await ctx.call({ segments: route.segments, body: forgedMetadata({ uploadHandle: handle }) });
        assertRefused(result);
        assertNoUploadEffects(result);
        assert.ok(result.queries.length > 0);
        assert.ok(result.queries.every(query => query.table === "staff_users"));
      });
    });

    for (const scenario of ["tampered", "foreign workspace", "foreign auth user", "foreign staff user"]) {
      test(`${route.name}: ${role} refuses a ${scenario} handle before any upload effects`, async () => {
        const ticketActor = { ...actor, ...(scenario === "foreign workspace" ? { workspaceId: WORKSPACE_B }
          : scenario === "foreign auth user" ? { userId: USER_B }
          : scenario === "foreign staff user" ? { staffUserId: STAFF_B } : {}) };
        const issued = issueStagedCreativeTicket({ ...ticketActor, ...image }, SECRET);
        const parts = issued.handle.split(".");
        const uploadHandle = scenario === "tampered"
          ? `${parts[0]}.${Buffer.from(JSON.stringify({ ...issued.ticket, workspaceId: WORKSPACE_B })).toString("base64url")}.${parts[2]}`
          : issued.handle;
        await withRouter({ memberships: [member(role)] }, async ctx => {
          const result = await ctx.call({ segments: route.segments, query: { workspaceId: WORKSPACE_A },
            body: forgedMetadata({ uploadHandle, ...ticketActor }) });
          assertNoUploadEffects(result);
          assertRefused(result);
          assert.equal(typeof result.res.body.code, "string", "the handle refusal must be structured, not a generic CRUD fallback");
          assert.ok(String(result.res.body.code).length > 0);
        });
      });
    }
  }
}

for (const role of ["owner", "admin", "marketer"]) {
  test(`prepare: ${role} receives only a private upload grant bound to the resolved actor`, async () => {
    await withRouter({ memberships: [member(role)] }, async ctx => {
      assertPreparedForActor(await ctx.call({ segments: routes[0].segments, body: { ...image } }), actor);
    });
  });
}

for (const role of ["owner", "marketer"]) {
  test(`prepare: ${role}'s body workspace, actor, bucket and path cannot override verified scope`, async () => {
    await withRouter({ memberships: [member(role)] }, async ctx => {
      for (const query of [{}, { workspaceId: WORKSPACE_A }]) {
        const result = await ctx.call({ segments: routes[0].segments, query, body: forgedMetadata() });
        assertPreparedForActor(result, actor);
      }
    });
  });

  test(`prepare: ${role} cannot omit or forge a UUID-v4 requestKey`, async () => {
    await withRouter({ memberships: [member(role)] }, async ctx => {
      for (const requestKey of [undefined, null, "", "not-a-uuid", REQUEST_KEY.replace("-4666-", "-1666-"),
        REQUEST_KEY.replace("-4666-", "-5666-"), REQUEST_KEY.replace("-8666-", "-7666-"), { requestKey: REQUEST_KEY }, [REQUEST_KEY]]) {
        const result = await ctx.call({ segments: routes[0].segments, body: { ...image, requestKey } });
        assertNoUploadEffects(result);
        assertRefused(result);
      }
    });
  });

  test(`prepare: ${role} cannot mint a grant for invalid image metadata`, async () => {
    const invalid: Json[] = [
      { fileName: "" }, { fileName: "../synthetic.jpg" }, { fileName: { name: "synthetic.jpg" } },
      { fileName: "synthetic.png", mimeType: "image/jpeg" }, { fileName: "synthetic.svg", mimeType: "image/svg+xml" },
      { mimeType: { type: "image/jpeg" } }, { fileSize: 0 }, { fileSize: -1 }, { fileSize: 1.5 },
      { fileSize: 10 * 1024 * 1024 + 1 }, { fileSize: { bytes: 128 } }, { fileType: "video" },
    ];
    await withRouter({ memberships: [member(role)] }, async ctx => {
      for (const patch of invalid) {
        const result = await ctx.call({ segments: routes[0].segments, body: { ...image, ...patch } });
        assertNoUploadEffects(result);
        assertRefused(result);
      }
    });
  });

  for (const video of [
    { fileName: "synthetic.mp4", mimeType: "video/mp4" },
    { fileName: "synthetic.mov", mimeType: "video/quicktime" },
    { fileName: "synthetic.webm", mimeType: "video/webm" },
  ]) {
    test(`prepare: ${role}'s ${video.mimeType} requires the private video worker instead of a public token`, async () => {
      await withRouter({ memberships: [member(role)] }, async ctx => {
        const result = await ctx.call({ segments: routes[0].segments, body: { ...image, ...video, fileType: "video" } });
        assertNoUploadEffects(result);
        assert.equal(result.res.statusCode, 409);
        assert.equal(result.res.body.success, false);
        assert.equal(result.res.body.code, "creative_video_worker_required");
      });
    });
  }

  test(`video-jobs: ${role} can still prepare an isolated private worker upload`, async () => {
    await withRouter({ memberships: [member(role)], videoWorkerEnabled: true }, async ctx => {
      const result = await ctx.call({ segments: ["video-jobs"], body: {
        fileName: "synthetic.mp4", mimeType: "video/mp4", fileSize: 128, workspaceId: WORKSPACE_B,
      } });
      assert.ok(result.res.statusCode >= 200 && result.res.statusCode < 300, JSON.stringify(result.res.body));
      assert.equal(result.res.body.success, true);
      const signed = record(record(result.res.body.data).signedUpload);
      assert.equal(signed.storageBucket, "ad-creatives-raw");
      const grants = result.storage.filter(call => call.op === "createSignedUploadUrl");
      assert.equal(grants.length, 1);
      assert.equal(grants[0]?.bucket, "ad-creatives-raw");
      assert.ok(grants[0]?.key?.startsWith(`${WORKSPACE_A}/`));
      assert.ok(!JSON.stringify(result.res.body).includes("/object/public/"));
      assert.ok(result.queries.filter(query => query.op === "insert").every(query => record(query.values).workspace_id === WORKSPACE_A));
    });
  });
}

for (const route of routes.slice(0, 2)) {
  for (const method of ["GET", "PATCH", "PUT", "DELETE", "HEAD"]) {
    test(`${route.name}: ${method} cannot fall through to generic creative CRUD`, async () => {
      await withRouter({}, async ctx => {
        const result = await ctx.call({ segments: route.segments, method, body: forgedMetadata() });
        assertRefused(result);
        assertNoUploadEffects(result);
        assert.deepEqual(result.queries, [], "unsupported subroute methods must not dispatch generic CRUD");
        assert.equal(result.authRequests, 0);
      });
    });
  }
}
