import assert from "node:assert/strict";
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
const rawBucketMigration = path.join(repoRoot, "migrations", "016_video_processing_jobs.sql");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const FOREIGN_JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = "header.payload.signature";

type StaffRow = { id: string; workspace_id: string; role: string; status: string };
type QueryLog = { table: string; op: string; filters: Record<string, unknown>; row?: unknown };
type StorageCall = { op: string; bucket: string; key: string };

/** Records every table, filter and row; resolves from a fixed row map. */
function dbSpy(rows: Record<string, unknown[]>, log: QueryLog[]) {
  return (table: string) => {
    const entry: QueryLog = { table, op: "select", filters: {} };
    log.push(entry);
    const settle = (shape: "one" | "list") => {
      const tableRows = rows[table] ?? [];
      if (shape === "list") return Promise.resolve({ data: tableRows, error: null, count: tableRows.length });
      // `insert(...).select().single()` returns the row that was written, and a
      // handler that maps the response back to the caller depends on it.
      if (entry.op === "insert" && tableRows.length === 0) {
        return Promise.resolve({ data: entry.row ?? null, error: null });
      }
      return Promise.resolve({ data: tableRows[0] ?? null, error: null });
    };
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder,
      insert: (row: unknown) => { entry.op = "insert"; entry.row = row; return builder; },
      update: (row: unknown) => { entry.op = "update"; entry.row = row; return builder; },
      upsert: (row: unknown) => { entry.op = "upsert"; entry.row = row; return builder; },
      delete: () => { entry.op = "delete"; return builder; },
      order: () => builder,
      limit: () => builder,
      eq(column: string, value: unknown) { entry.filters[column] = value; return builder; },
      is(column: string, value: unknown) { entry.filters[column] = value; return builder; },
      single: () => settle("one"),
      maybeSingle: () => settle("one"),
      then(onFulfilled: (value: unknown) => unknown) { return settle("list").then(onFulfilled); },
    });
    return builder;
  };
}

/** Records the bucket and key of every storage call the handler makes. */
function storageSpy(calls: StorageCall[]) {
  return {
    from(bucket: string) {
      return {
        upload: async (key: string) => {
          calls.push({ op: "upload", bucket, key });
          return { data: { path: key }, error: null };
        },
        createSignedUploadUrl: async (key: string) => {
          calls.push({ op: "createSignedUploadUrl", bucket, key });
          return {
            data: { signedUrl: `https://project.example.test/upload/${bucket}/${key}`, token: "signed-token", path: key },
            error: null,
          };
        },
        getPublicUrl: (key: string) => {
          calls.push({ op: "getPublicUrl", bucket, key });
          return { data: { publicUrl: `https://project.example.test/storage/v1/object/public/${bucket}/${key}` } };
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

const memberA: StaffRow = { id: "staff-a", workspace_id: WORKSPACE_A, role: "owner", status: "active" };

async function loadRouter(rows: Record<string, unknown[]> = {}) {
  const queries: QueryLog[] = [];
  const storage: StorageCall[] = [];

  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.VIDEO_OPTIMIZATION_ENABLED = "true";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: USER_A, email: "a@example.test" }),
  })) as unknown as typeof globalThis.fetch;

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };

  const clientRows: Record<string, unknown[]> = { staff_users: [memberA], ...rows };
  supabaseModule.setSupabaseServerClientFactoryForTests(() => ({
    from: dbSpy(clientRows, queries),
    storage: storageSpy(storage),
  }));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  const call = async (input: {
    segments: string[];
    method?: string;
    body?: unknown;
    rawBody?: Buffer;
    contentType?: string;
    query?: Record<string, unknown>;
  }) => {
    queries.length = 0;
    storage.length = 0;
    const res = mockResponse();
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
    if (input.contentType) headers["content-type"] = input.contentType;

    const req: MockRequest = {
      method: input.method ?? "GET",
      headers,
      query: { path: input.segments, ...(input.query ?? {}) },
      body: input.body,
    };
    // The multipart branch reads the raw stream itself, so the request has to
    // be async-iterable exactly like a real Vercel request.
    if (input.rawBody) {
      const chunk = input.rawBody;
      req[Symbol.asyncIterator] = async function* () { yield chunk; };
    }

    await routerModule.default(req, res);
    return { res, queries: [...queries], storage: [...storage] };
  };

  return {
    call,
    restore: () => {
      globalThis.fetch = originalFetch;
      supabaseModule.setSupabaseServerClientFactoryForTests(null);
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
function multipartBody(fields: Record<string, string>): { buffer: Buffer; contentType: string } {
  const boundary = "----negisStorageTestBoundary";
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="creative.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\nnot-a-real-jpeg\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  return {
    buffer: Buffer.from(parts.join(""), "utf8"),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function uploads(calls: StorageCall[]): StorageCall[] {
  return calls.filter((entry) => entry.op === "upload" || entry.op === "createSignedUploadUrl");
}

// ===========================================================================
// A. The browser never chooses the bucket
// ===========================================================================

test("ST1 a multipart upload naming another bucket still writes to ad-creatives", async () => {
  await withRouter({}, async (ctx) => {
    const form = multipartBody({
      storageBucket: "ad-creatives-raw",
      fileName: "creative.jpg",
      mimeType: "image/jpeg",
    });
    const { res, storage } = await ctx.call({
      segments: ["ad-creative-upload"],
      method: "POST",
      rawBody: form.buffer,
      contentType: form.contentType,
    });

    assert.equal(res.statusCode >= 400, false, `unexpected failure: ${JSON.stringify(res.body)}`);
    const written = uploads(storage);
    assert.equal(written.length, 1);
    assert.equal(written[0].bucket, "ad-creatives");
    for (const call of storage) {
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
    const { res, storage } = await ctx.call({
      segments: ["ad-creative-upload"],
      method: "POST",
      rawBody: form.buffer,
      contentType: form.contentType,
    });

    assert.equal(res.statusCode >= 400, false, `unexpected failure: ${JSON.stringify(res.body)}`);
    const written = uploads(storage);
    assert.equal(written.length, 1);
    assert.ok(written[0].key.startsWith(`${WORKSPACE_A}/`), `key escaped the workspace prefix: ${written[0].key}`);
    for (const call of storage) {
      assert.equal(call.key.includes(WORKSPACE_B), false, "no storage call may reference another workspace");
    }
  });
});

test("ST3 the signed upload route derives the key from the authorized workspace", async () => {
  await withRouter({}, async (ctx) => {
    const { res, storage } = await ctx.call({
      segments: ["ad-creatives", "signed-upload"],
      method: "POST",
      body: { fileName: "creative.jpg", mimeType: "image/jpeg", fileSize: 2048, workspaceId: WORKSPACE_B },
    });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const signed = storage.filter((entry) => entry.op === "createSignedUploadUrl");
    assert.equal(signed.length, 1);
    assert.equal(signed[0].bucket, "ad-creatives");
    assert.ok(signed[0].key.startsWith(`${WORKSPACE_A}/`), `key escaped the workspace prefix: ${signed[0].key}`);
  });
});

// ===========================================================================
// B. The browser never chooses which object the worker reads
// ===========================================================================

test("ST4 a job pointing at another workspace's raw object is refused before any insert", async () => {
  await withRouter({}, async (ctx) => {
    const { res, queries } = await ctx.call({
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
  });
});

test("ST5 a job pointing at the caller's own raw object is accepted unchanged", async () => {
  const ownPath = `${WORKSPACE_A}/2026/07/1751-large.mov`;
  await withRouter({ video_processing_jobs: [{ id: "job-1", status: "queued", workspace_id: WORKSPACE_A }] }, async (ctx) => {
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
  });
});

test("ST6 retry scopes both lookups, so a foreign job id is a 404 and not a 409", async () => {
  await withRouter({}, async (ctx) => {
    const { res, queries } = await ctx.call({
      segments: ["video-processing-jobs", FOREIGN_JOB, "retry"],
      method: "POST",
      body: {},
    });

    assert.equal(res.statusCode, 404, JSON.stringify(res.body));
    const jobQueries = queries.filter((entry) => entry.table === "video_processing_jobs");
    assert.ok(jobQueries.length >= 2, "retry performs the scoped update and the existence lookup");
    for (const entry of jobQueries) {
      assert.equal(
        entry.filters.workspace_id,
        WORKSPACE_A,
        "every retry query must carry the caller's workspace filter",
      );
    }
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
  assert.ok(branch.includes("buildAdCreativeStoragePath"), "the key must come from the server-side builder");
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

  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

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

    assert.equal(res.statusCode, 404, `a job was served without a workspace: ${JSON.stringify(res.body)}`);
    assert.equal(
      JSON.stringify(res.body).includes(WORKSPACE_B),
      false,
      "and nothing of the owning workspace may appear in the answer",
    );
  } finally {
    supabaseModule.setSupabaseServerClientFactoryForTests(null);
  }
});

// ===========================================================================
// E. The creative registration contract, moved somewhere it actually runs
// ===========================================================================

// test:routes checked these five shapes against a deployment. Since
// Security-2B the route answers 401 first, so each check bails out through
// isCrmGuarded and none of them has run since. The comment left at those call
// sites says the invariants "moved to test:meta-launch-payload and
// test:tenant-isolation"; grep for publicUrl in either suite returns nothing,
// so they did not move — they stopped. Here they run against the real handler
// with a verified workspace and no network.

const CREATIVE_BASE = {
  fileName: "creative.jpg",
  fileType: "image",
  mimeType: "image/jpeg",
  fileSize: 2048,
  status: "uploaded",
};

function assetPublicUrl(body: Record<string, unknown>): string {
  const data = (body.data ?? {}) as Record<string, unknown>;
  const asset = (data.asset ?? {}) as Record<string, unknown>;
  return String(data.publicUrl ?? asset.publicUrl ?? "");
}

test("ST11 a creative URL is accepted under every spelling the clients send", async () => {
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
    await withRouter({}, async (ctx) => {
      const { res } = await ctx.call({
        segments: ["ad-creative-upload"],
        method: "POST",
        body: { ...CREATIVE_BASE, [field]: url },
      });

      assert.equal(res.statusCode < 400, true, `${field} was refused: ${JSON.stringify(res.body)}`);
      assert.equal(assetPublicUrl(res.body), url, `${field} did not reach the saved asset`);
    });
  }
});

test("ST12 with no URL the public link is derived from the stored object", async () => {
  await withRouter({}, async (ctx) => {
    const { res } = await ctx.call({
      segments: ["ad-creative-upload"],
      method: "POST",
      body: {
        ...CREATIVE_BASE,
        storageBucket: "ad-creatives",
        storagePath: `${WORKSPACE_A}/2026/07/creative.jpg`,
      },
    });

    assert.equal(res.statusCode < 400, true, JSON.stringify(res.body));
    const publicUrl = assetPublicUrl(res.body);
    assert.ok(publicUrl.includes("/storage/v1/object/public/ad-creatives/"), `unexpected link: ${publicUrl}`);
    assert.ok(publicUrl.includes(WORKSPACE_A), "the derived link must point at the caller's own object");
  });
});

test("ST13 a creative with neither a URL nor a stored object is refused, not saved blind", async () => {
  await withRouter({}, async (ctx) => {
    const { res, queries } = await ctx.call({
      segments: ["ad-creative-upload"],
      method: "POST",
      body: CREATIVE_BASE,
    });

    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(
      queries.some((entry) => entry.table === "ad_creative_assets"),
      false,
      "a creative with no reachable link must not reach the table",
    );
  });
});
