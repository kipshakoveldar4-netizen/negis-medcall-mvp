import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";

// Exercise the actual worker. Only SDK persistence, HTTP, and time are doubled;
// claim eligibility and quota accounting remain the SQL suite's responsibility.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const worker = await import(pathToFileURL(path.join(root, "lib/crm/staged-creative-reclamation.ts")).href);
const workflow = await import(pathToFileURL(path.join(root, "lib/crm/staged-creative-workflow.ts")).href);
const sharp = createRequire(path.join(root, "package.json"))("sharp");
const W = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", O = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const U = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", S = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NEXT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", REQUEST = "11111111-1111-4111-8111-111111111111";
const BUCKET = "ad-creatives-staging", NOW = 1_792_900_000_000, LIFETIME = 7_200_000;
const ORIGIN = "https://reclamation.fixture.invalid", SECRET = "SYNTHETIC_RECLAMATION_SERVICE_ROLE_NEVER_REAL_123";
const PRIVATE = "SYNTHETIC_RECLAMATION_ORIGINAL_PRIVATE_BYTES";
const CLAIM = "claim_creative_upload_reclamation", COMPLETE = "complete_creative_upload_reclamation";
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Row = Record<string, any>;
type Format = "jpeg" | "png" | "webp";
type Outcome = { ok: true; value: Row } | { ok: false; error: unknown };
type Upload = { bucket: string; key: string; bytes: Buffer; options: Row };
type HttpCall = { url: string; init: RequestInit };
const originals = new Map<Format, Buffer>();
for (const format of ["jpeg", "png", "webp"] as const) {
  const encoded = await sharp({ create: { width: 7, height: 5, channels: 3, background: "#18a879" } }).toFormat(format).toBuffer();
  originals.set(format, Buffer.concat([encoded, Buffer.from(PRIVATE)]));
}
const never = <T = any>(): Promise<T> => new Promise(() => {});
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(t: TestContext, options: Row = {}) {
  const format: Format = options.format ?? "jpeg", mimeType = `image/${format}`;
  const extension = options.extension ?? (format === "jpeg" ? "jpg" : format);
  const original = originals.get(format)!;
  let clock = NOW, stored = Buffer.from(original), cancelled = 0, ackAttempts = 0, reserveAttempts = 0;
  let lateResponse: ((response: Response) => void) | undefined;
  const events: string[] = [], uploads: Upload[] = [], fetches: HttpCall[] = [], rpcCalls: Row[] = [];
  const bucketCalls: string[] = [], storageBuckets: string[] = [], forbidden: string[] = [], logs: unknown[][] = [];
  const actorCalls: Row[] = [], listings: Row[] = [];
  const member: Row = { id: S, workspace_id: W, auth_user_id: U, role: "owner", status: "active", ...options.member };
  const baseline: Row = { operationId: O, workspaceId: W, fileName: `synthetic.${extension}`, mimeType,
    fileSize: original.length, issuedAt: NOW - LIFETIME - 1_000, expiresAt: NOW - 1_000,
    claimedUntil: new Date(NOW + 120_000).toISOString() };
  const key = `${W}/staged/${O}/original.${extension}`;
  const bucket = { id: BUCKET, public: false, file_size_limit: 100 * 1024 * 1024,
    allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"],
    versioning_status: "disabled", ...options.bucket };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Date, "now", () => clock);
  const tick = (ms: number) => { clock += ms; t.mock.timers.tick(ms); };
  t.after(() => t.mock.timers.reset());
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  }

  const forbiddenCall = (name: string): never => { forbidden.push(name); throw new Error(`${name}:${SECRET}:${PRIVATE}`); };
  const sdk = {
    from(table: string): Row {
      if (!options.workflow || table !== "staff_users") return forbiddenCall("direct database access");
      const filters: Row = {}, query: Row = {};
      Object.assign(query, { select: () => query,
        eq(field: string, value: unknown) { filters[field] = value; return query; },
        async maybeSingle() {
          actorCalls.push({ ...filters }); events.push("actor");
          return { data: { ...member }, error: null };
        } });
      return query;
    },
    async rpc(name: string, args: Row) {
      rpcCalls.push({ name, args: structuredClone(args) }); events.push(`rpc:${name}`);
      if (options.workflow && name === "reserve_creative_upload") {
        reserveAttempts++;
        const errorCode = reserveAttempts === 1 ? options.initialReserveError ?? "P8805" : options.retryReserveError;
        if (errorCode) return { data: null, error: { code: errorCode, message: `${SECRET}:${PRIVATE}` } };
        return { data: { requestKey: REQUEST, status: "reserved", ticket: { v: 1, id: NEXT,
          workspaceId: W, userId: U, staffUserId: S, fileName: `synthetic.${extension}`, mimeType,
          fileSize: original.length, issuedAt: NOW, expiresAt: NOW + LIFETIME } }, error: null };
      }
      if (name === CLAIM) {
        if (options.hang === "claim") return never();
        if (options.claimError) return { data: null, error: { message: `${SECRET}:${PRIVATE}` } };
        const row = { ...baseline, claimId: args.p_claim_id, ...options.claim };
        const rows = options.claimRows ? options.claimRows(row) : [row];
        return { data: rows, error: null };
      }
      if (name !== COMPLETE) return forbiddenCall(`unexpected RPC ${name}`);
      ackAttempts++;
      if (options.hang === "ack") return never();
      if (options.ackError) return { data: null, error: { message: `${SECRET}:${PRIVATE}` } };
      if (options.lostAck || ackAttempts <= (options.lostAckCount ?? 0)) throw new Error(`${SECRET}:${PRIVATE}`);
      if (options.revokeAfterCleanup) member.status = "inactive";
      return { data: options.noAck ? null : { operationId: O, workspaceId: W,
        rawDeletedAt: new Date(clock).toISOString(), cleanupKind: "tombstone",
        size: args.p_tombstone_size, sha256: args.p_tombstone_sha256, ...options.ack }, error: null };
    },
    storage: {
      async getBucket(id: string) {
        bucketCalls.push(id); events.push("bucket");
        if (options.hang === "bucket") return never();
        if (options.bucketError) throw new Error(`${SECRET}:${PRIVATE}`);
        return { data: bucket, error: null };
      },
      from(name: string) {
        storageBuckets.push(name);
        return {
          async upload(path: string, body: Buffer | Uint8Array | ArrayBuffer | Blob, uploadOptions: Row) {
            const bytes = body instanceof Blob ? Buffer.from(await body.arrayBuffer())
              : body instanceof ArrayBuffer ? Buffer.from(body) : Buffer.from(body);
            uploads.push({ bucket: name, key: path, bytes, options: structuredClone(uploadOptions) }); events.push("upload");
            if (options.hang === "upload") return never();
            if (!options.noWrite) stored = Buffer.from(bytes);
            if (options.lostUploadAck) throw new Error(`${SECRET}:${PRIVATE}`);
            if (options.uploadError) return { data: null, error: { message: `${SECRET}:${PRIVATE}` } };
            return { data: { path: options.uploadPath ?? path }, error: null };
          },
          remove() { return forbiddenCall("remove"); },
          createSignedUrl() { return forbiddenCall("signed read URL"); },
          createSignedUploadUrl() { return forbiddenCall("signed upload URL"); },
          getPublicUrl() { return forbiddenCall("public URL"); },
          download() { return forbiddenCall("unbounded SDK download"); },
          async list(folder: string, args: Row) {
            if (!options.workflow) return forbiddenCall("bucket listing");
            listings.push({ bucket: name, folder, args: structuredClone(args) }); events.push("list");
            return { data: [{ id: OTHER, name: `original.${extension}` }], error: null };
          },
          move() { return forbiddenCall("move"); },
          copy() { return forbiddenCall("copy"); },
        };
      },
    },
  };

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    fetches.push({ url, init }); events.push("fetch");
    if (options.hang === "headers") return never<Response>();
    if (options.hang === "late-headers") return new Promise<Response>(resolve => { lateResponse = resolve; });
    let bytes = options.proof === "original" ? original : Buffer.from(stored);
    if (options.proof === "different") { bytes = Buffer.from(bytes); bytes[bytes.length - 1] ^= 1; }
    if (options.proof === "short") bytes = bytes.subarray(0, bytes.length - 1);
    if (options.proof === "extra") bytes = Buffer.concat([bytes, Buffer.from([0])]);
    if (options.proof === "oversize") bytes = Buffer.alloc(2_049, 65);
    const headers = new Headers({ "content-type": options.proof === "mime" ? "text/html" : mimeType });
    if (!["oversize", "missing-length"].includes(options.proof)) headers.set("content-length", String(bytes.length));
    if (options.proof === "length") headers.set("content-length", "1");
    if (options.proof === "malformed-length") headers.set("content-length", "1e2");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (options.hang === "body") return;
        if (options.proof === "split") {
          controller.enqueue(new Uint8Array(bytes.subarray(0, 1)));
          controller.enqueue(new Uint8Array(bytes.subarray(1)));
        } else controller.enqueue(new Uint8Array(bytes));
        if (options.proof !== "oversize") controller.close();
      },
      cancel() {
        cancelled++;
        if (options.cancel === "hang") return never<void>();
        if (options.cancel === "throw") throw new Error(`${SECRET}:${PRIVATE}`);
        if (options.cancel === "reject") return Promise.reject(new Error(`${SECRET}:${PRIVATE}`));
        return undefined;
      },
    });
    const response = new Response(stream, { status: options.proof === "absent" ? 404 : 200, headers });
    if (options.proof === "redirected") Object.defineProperty(response, "redirected", { value: true });
    return response;
  });

  const config = { supabase: sdk, origin: ORIGIN, serviceRoleKey: SECRET, ...options.config };
  async function releaseLateResponse() {
    assert.ok(lateResponse, "The actual proof must first enter its pending fetch");
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
        if (options.cancel === "hang") return never<void>();
        if (options.cancel === "throw") throw new Error(`${SECRET}:${PRIVATE}`);
        if (options.cancel === "reject") return Promise.reject(new Error(`${SECRET}:${PRIVATE}`));
        return undefined;
      },
    }), { headers: { "content-type": mimeType } });
    lateResponse(response);
    for (let turn = 0; turn < 32; turn++) await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(inspect(logs, { depth: 12 }).includes(SECRET), false);
  }
  async function run(action = () => worker.reclaimStagedCreativeUploads(config, options.workspace ?? W)): Promise<Outcome> {
    let outcome: Outcome | undefined;
    void Promise.resolve().then(action)
      .then(value => { outcome = { ok: true, value }; }, error => { outcome = { ok: false, error }; });
    // Deliberately do not await the worker: even a hung stream.cancel() must
    // become a failing assertion, not a hung test or a real 10-second wait.
    for (let elapsed = 0; elapsed <= 100_000; elapsed += 1_000) {
      for (let turn = 0; turn < 32 && !outcome; turn++) await Promise.resolve();
      if (outcome) { audit(outcome); return outcome; }
      await new Promise<void>(resolve => setImmediate(resolve));
      if (outcome) { audit(outcome); return outcome; }
      tick(1_000);
    }
    assert.fail("Actual reclamation worker did not finish within its bounded SDK/HTTP deadlines (100 seconds of fake time)");
  }
  function audit(outcome: Outcome) {
    assert.deepEqual(forbidden, [], "No remove, public/signed URL, direct DB mutation, or unbounded SDK read is permitted");
    assert.ok(bucketCalls.every(id => id === BUCKET));
    assert.ok(storageBuckets.every(id => id === BUCKET), "Only the original private bucket may be selected");
    for (const upload of uploads) {
      assert.equal(upload.bucket, BUCKET); assert.equal(upload.key, key, "Overwrite only the exact original object, never an alternate fence path");
      assert.equal(upload.options.upsert, true); assert.equal(upload.options.contentType, mimeType);
      assert.ok(upload.bytes.length > 0 && upload.bytes.length <= 2_048, "Permanent fence must cost at most 2048 bytes");
      assert.equal(upload.bytes.includes(Buffer.from(PRIVATE)), false);
    }
    for (const call of fetches) {
      assert.equal(call.url, `${ORIGIN}/storage/v1/object/${BUCKET}/${key}`, "Proof must use the same authenticated private object URL");
      assert.equal(call.init.method ?? "GET", "GET"); assert.equal(call.init.redirect, "error");
      assert.equal(call.init.credentials, "omit"); assert.equal(call.init.cache, "no-store");
      const headers = new Headers(call.init.headers);
      assert.equal(headers.get("authorization"), `Bearer ${SECRET}`); assert.equal(headers.get("apikey"), SECRET);
      assert.ok(call.init.signal instanceof AbortSignal);
    }
    for (const call of rpcCalls.filter(call => call.name === CLAIM)) {
      assert.deepEqual(Object.keys(call.args).sort(), ["p_claim_id", "p_limit", "p_workspace_id"]);
      assert.equal(call.args.p_workspace_id, W); assert.equal(call.args.p_limit, 1); assert.match(call.args.p_claim_id, UUID4);
    }
    for (const call of rpcCalls.filter(call => call.name === COMPLETE)) {
      assert.deepEqual(Object.keys(call.args).sort(), ["p_claim_id", "p_operation_id", "p_tombstone_sha256", "p_tombstone_size", "p_workspace_id"]);
      assert.equal(call.args.p_workspace_id, W); assert.equal(call.args.p_operation_id, O);
      assert.equal(call.args.p_claim_id, rpcCalls.find(call => call.name === CLAIM)?.args.p_claim_id);
      const upload = uploads.at(-1); assert.ok(upload, "An acknowledgement cannot substitute for a tombstone write");
      assert.equal(call.args.p_tombstone_sha256, hash(upload.bytes)); assert.equal(call.args.p_tombstone_size, upload.bytes.length);
      assert.ok(events.indexOf("upload") < events.indexOf("fetch"));
      assert.ok(events.indexOf("fetch") < events.indexOf(`rpc:${COMPLETE}`), "Only independently proven bytes may be acknowledged");
    }
    for (const filters of actorCalls) assert.deepEqual(filters, { id: S, workspace_id: W, auth_user_id: U });
    for (const listing of listings) {
      assert.equal(listing.bucket, BUCKET); assert.equal(listing.folder, `${W}/staged/${NEXT}`);
      assert.deepEqual(listing.args, { limit: 2, search: `original.${extension}` });
    }
    const exposed = inspect({ outcome, logs }, { depth: 12 });
    for (const sensitive of [SECRET, PRIVATE]) assert.equal(exposed.includes(sensitive), false, "No SDK/HTTP diagnostic or original bytes may escape");
  }
  return { run, tick, releaseLateResponse, uploads, fetches, rpcCalls, events, bucketCalls, storageBuckets, actorCalls, listings, config, baseline,
    completions: () => rpcCalls.filter(call => call.name === COMPLETE), cancelled: () => cancelled,
    stored: () => Buffer.from(stored), original };
}

function refused(outcome: Outcome) {
  if (outcome.ok) assert.equal(outcome.value?.reclaimed, 0, "Unconfirmed cleanup must not release retained capacity");
}
function reclaimed(outcome: Outcome) {
  assert.equal(outcome.ok, true, outcome.ok ? undefined : inspect(outcome.error));
  if (outcome.ok) assert.deepEqual(outcome.value, { reclaimed: 1 });
}
function noProofOrAck(f: ReturnType<typeof fixture>) {
  assert.equal(f.fetches.length, 0); assert.equal(f.completions().length, 0);
}

for (const [format, extension] of [["jpeg", "jpg"], ["jpeg", "jpeg"], ["png", "png"], ["webp", "webp"]] as const) {
  test(`reclamation: actual ${extension} worker writes a valid static private tombstone and acknowledges its exact bytes`, async t => {
    const f = fixture(t, { format, extension }); reclaimed(await f.run());
    assert.equal(f.uploads.length, 1); assert.equal(f.fetches.length, 1); assert.equal(f.completions().length, 1);
    const bytes = f.uploads[0]!.bytes, metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, format); assert.equal(metadata.pages ?? 1, 1);
    assert.ok(metadata.width > 0 && metadata.height > 0); await sharp(bytes, { failOn: "warning" }).raw().toBuffer();
    assert.notDeepEqual(bytes, f.original); assert.deepEqual(f.stored(), bytes);
  });
}

test("reclamation: a SQL-authorized terminal claim may be reclaimed before its original ticket expires", async t => {
  const f = fixture(t, { claim: { issuedAt: NOW - 1_000, expiresAt: NOW - 1_000 + LIFETIME } });
  reclaimed(await f.run()); assert.equal(f.completions().length, 1);
});

test("reclamation: untrusted extra path and URL fields cannot override the server-derived private original key", async t => {
  const f = fixture(t, { claim: { storageBucket: "foreign-public-bucket", storagePath: `${OTHER}/../foreign.jpg`,
    publicUrl: "https://untrusted.fixture.invalid/original", signedUrl: "https://untrusted.fixture.invalid/token" } });
  reclaimed(await f.run()); assert.equal(f.uploads.length, 1); assert.equal(f.fetches.length, 1);
});

test("reclamation: no claims returns zero without touching any object or minting a token", async t => {
  const f = fixture(t, { claimRows: () => [] }), result = await f.run();
  assert.deepEqual(result, { ok: true, value: { reclaimed: 0 } }); assert.equal(f.uploads.length, 0); noProofOrAck(f);
});

const malformedClaims: Record<string, Row> = {
  "foreign workspace": { workspaceId: OTHER },
  "workspace traversal": { workspaceId: `${W}/../${OTHER}` },
  "missing operation ID": { operationId: undefined },
  "operation ID traversal": { operationId: `${O}/../${OTHER}` },
  "non-UUID operation ID": { operationId: "not-a-uuid" },
  "mismatched claim ID": { claimId: OTHER },
  "missing claim ID": { claimId: undefined },
  "wrong extension": { fileName: "synthetic.png" },
  "unsupported MIME": { fileName: "synthetic.svg", mimeType: "image/svg+xml" },
  "prototype MIME": { mimeType: "constructor" },
  "parent path": { fileName: "../synthetic.jpg" },
  "Windows path": { fileName: "..\\synthetic.jpg" },
  "absolute path": { fileName: "/synthetic.jpg" },
  "control byte": { fileName: "synthetic\u0000.jpg" },
  "zero size": { fileSize: 0 },
  "fractional size": { fileSize: 1.5 },
  "string size": { fileSize: "100" },
  "oversized image": { fileSize: 10 * 1024 * 1024 + 1 },
  "future issue time": { issuedAt: NOW + 1_000, expiresAt: NOW + LIFETIME + 1_000 },
  "string issue time": { issuedAt: String(NOW - LIFETIME - 1_000) },
  "invalid lifetime": { expiresAt: NOW - 2_000 },
  "expired lease": { claimedUntil: new Date(NOW - 1).toISOString() },
  "invalid lease": { claimedUntil: "not-a-date" },
  "missing lease": { claimedUntil: undefined },
};
for (const [name, claim] of Object.entries(malformedClaims)) {
  test(`reclamation: ${name} claim fails closed before any original-key write`, async t => {
    const f = fixture(t, { claim }); refused(await f.run()); assert.equal(f.uploads.length, 0); noProofOrAck(f);
  });
}

for (const [name, claimRows] of Object.entries({
  "more than one claim": (row: Row) => [row, { ...row, operationId: OTHER }],
  "duplicate claim batch": (row: Row) => [row, row],
  "non-array claims": (row: Row) => row,
  "null claims": () => null,
  "null claim member": () => [null],
})) {
  test(`reclamation: ${name} cannot partially process a supposedly bounded claim result`, async t => {
    const f = fixture(t, { claimRows }); refused(await f.run()); assert.equal(f.uploads.length, 0); noProofOrAck(f);
  });
}

for (const [name, bucket] of Object.entries({
  "public bucket": { public: true }, "foreign bucket": { id: "ad-creatives" },
  "missing privacy flag": { public: undefined }, "enabled versioning": { versioning_status: "enabled" },
  "suspended versioning": { versioning_status: "suspended" },
  "unbounded size limit": { file_size_limit: null }, "unbounded MIME policy": { allowed_mime_types: null },
})) {
  test(`reclamation: ${name} prevents a tombstone write and capacity acknowledgement`, async t => {
    const f = fixture(t, { bucket }); refused(await f.run()); assert.equal(f.uploads.length, 0); noProofOrAck(f);
  });
}

for (const proof of ["original", "different", "short", "extra", "oversize", "mime", "length", "malformed-length", "absent", "redirected"]) {
  test(`reclamation: ${proof} private proof is not accepted as reclaimed capacity`, async t => {
    const f = fixture(t, { proof }); refused(await f.run());
    assert.equal(f.uploads.length, 1); assert.equal(f.fetches.length, 1); assert.equal(f.completions().length, 0);
  });
}

for (const proof of ["split", "missing-length"]) {
  test(`reclamation: ${proof} proof still requires complete bounded byte equality`, async t => {
    const f = fixture(t, { proof }); reclaimed(await f.run()); assert.equal(f.completions().length, 1);
  });
}

test("reclamation: SDK success without a persisted tombstone cannot release capacity", async t => {
  const f = fixture(t, { noWrite: true }); refused(await f.run());
  assert.equal(f.uploads.length, 1); assert.equal(f.completions().length, 0); assert.deepEqual(f.stored(), f.original);
});

test("reclamation: an absent original after an unconfirmed write is never proof of a permanent fence", async t => {
  const f = fixture(t, { noWrite: true, lostUploadAck: true, proof: "absent" }); refused(await f.run());
  assert.equal(f.completions().length, 0);
});

for (const option of ["lostUploadAck", "uploadError"]) {
  test(`reclamation: ${option} is reconciled only by proving the same successfully overwritten private key`, async t => {
    const f = fixture(t, { [option]: true }); reclaimed(await f.run());
    assert.equal(f.uploads.length, 1); assert.equal(f.fetches.length, 1); assert.equal(f.completions().length, 1);
  });
}

test("reclamation: a failed upload with original bytes still present never acknowledges cleanup", async t => {
  const f = fixture(t, { noWrite: true, uploadError: true }); refused(await f.run()); assert.equal(f.completions().length, 0);
});

for (const [name, options] of Object.entries({ "lost acknowledgement": { lostAck: true }, "missing acknowledgement": { noAck: true },
  "SDK acknowledgement error": { ackError: true } })) {
  test(`reclamation: ${name} cannot turn a proven write into acknowledged capacity`, async t => {
    const f = fixture(t, options); refused(await f.run());
    assert.equal(f.uploads.length, 1); assert.ok(f.completions().length >= 1);
    assert.deepEqual(f.stored(), f.uploads[0]!.bytes, "Uncertain completion leaves the same permanent fence intact");
  });
}

test("reclamation: any retry after one lost completion response repeats the exact claim and byte receipt", async t => {
  const f = fixture(t, { lostAckCount: 1 }), outcome = await f.run();
  const calls = f.completions(); assert.ok(calls.length >= 1); assert.ok(calls.length <= 2);
  if (calls.length === 1) refused(outcome);
  else { reclaimed(outcome); assert.deepEqual(calls[0]!.args, calls[1]!.args); }
  assert.equal(f.uploads.length, 1, "Completion retries must not perform a second overwrite");
});

for (const [name, ack] of Object.entries({
  "foreign operation": { operationId: OTHER }, "foreign workspace": { workspaceId: OTHER },
  "wrong cleanup kind": { cleanupKind: "delete" }, "wrong digest": { sha256: "0".repeat(64) },
  "wrong size": { size: 2_049 }, "string size": { size: "100" },
  "missing deletion time": { rawDeletedAt: null }, "invalid deletion time": { rawDeletedAt: "not-a-date" },
  "extra receipt key": { extra: "not-part-of-the-six-key-contract" }, "missing cleanup kind": { cleanupKind: undefined },
})) {
  test(`reclamation: ${name} completion receipt cannot acknowledge a different cleanup`, async t => {
    const f = fixture(t, { ack }); refused(await f.run()); assert.ok(f.completions().length >= 1);
  });
}

for (const hang of ["claim", "bucket", "upload", "headers", "body", "ack"]) {
  test(`reclamation: a hung ${hang} is deadline-bounded even when the SDK/fetch ignores abort`, { timeout: 5_000 }, async t => {
    const f = fixture(t, { hang, cancel: "hang" }); refused(await f.run());
    if (hang !== "ack") assert.equal(f.completions().length, 0);
    if (["claim", "bucket"].includes(hang)) assert.equal(f.uploads.length, 0);
    if (["headers", "body"].includes(hang)) {
      assert.equal(f.fetches.length, 1); assert.equal(f.fetches[0]!.init.signal?.aborted, true);
    }
    if (hang === "body") assert.equal(f.cancelled(), 1, "A timed-out read must initiate cancellation without awaiting its hung promise");
  });
}

for (const cancel of ["hang", "throw", "reject"]) {
  test(`reclamation: oversized body cleanup with ${cancel} cancellation still finishes without an acknowledgement`, { timeout: 5_000 }, async t => {
    const f = fixture(t, { proof: "oversize", cancel }); refused(await f.run());
    assert.equal(f.cancelled(), 1); assert.equal(f.completions().length, 0);
    assert.equal(f.fetches[0]!.init.signal?.aborted, true);
  });
}

for (const cancel of ["hang", "throw", "reject"]) {
  test(`reclamation: a response arriving after the fetch deadline is cancelled despite ${cancel} cleanup`, { timeout: 5_000 }, async t => {
    const f = fixture(t, { hang: "late-headers", cancel }); refused(await f.run());
    assert.equal(f.fetches.length, 1); assert.equal(f.fetches[0]!.init.signal?.aborted, true);
    assert.equal(f.cancelled(), 0); assert.equal(f.completions().length, 0);
    await f.releaseLateResponse();
    assert.equal(f.cancelled(), 1, "A late fetch response still owns a body; abandon neither its stream nor its cancellation rejection");
    assert.equal(f.completions().length, 0); assert.equal(f.uploads.length, 1);
  });
}

for (const option of ["claimError", "bucketError"]) {
  test(`reclamation: ${option} redacts the actual SDK exception and never mutates an object`, async t => {
    const f = fixture(t, { [option]: true }); refused(await f.run()); assert.equal(f.uploads.length, 0); noProofOrAck(f);
  });
}

for (const [name, config] of Object.entries({
  "HTTP origin": { origin: "http://reclamation.fixture.invalid" },
  "origin credentials": { origin: "https://synthetic:credential@reclamation.fixture.invalid" },
  "origin path": { origin: `${ORIGIN}/untrusted` }, "short service role key": { serviceRoleKey: "synthetic" },
})) {
  test(`reclamation: ${name} is rejected before any privileged SDK or HTTP action`, async t => {
    const f = fixture(t, { config }); refused(await f.run()); assert.equal(f.rpcCalls.length, 0);
    assert.equal(f.bucketCalls.length, 0); assert.equal(f.uploads.length, 0); noProofOrAck(f);
  });
}

test("reclamation: a lease that expires before work starts cannot authorize a stale overwrite", async t => {
  const f = fixture(t); f.tick(120_001); refused(await f.run()); assert.equal(f.uploads.length, 0); noProofOrAck(f);
});

function capacityFixture(t: TestContext, options: Row = {}) {
  const f = fixture(t, { ...options, workflow: true });
  const input = { workspaceId: W, userId: U, staffUserId: S, requestKey: REQUEST,
    fileName: "synthetic.jpg", mimeType: "image/jpeg", fileSize: f.original.length };
  return { ...f, prepare: () => f.run(() => workflow.prepareCreativeImageUpload(f.config, input)),
    admissions: () => f.rpcCalls.filter(call => call.name === "reserve_creative_upload") };
}

function exactAdmissionRetry(f: ReturnType<typeof capacityFixture>) {
  const calls = f.admissions(); assert.equal(calls.length, 2, "Only one capacity fallback admission retry is permitted");
  assert.deepEqual(calls[0]!.args, calls[1]!.args, "Retry must preserve request key, actor, workspace, source, and exact metadata");
  assert.equal(calls[0]!.args.p_workspace_id, W); assert.equal(calls[0]!.args.p_request_key, REQUEST);
  const names = f.events;
  assert.ok(names.indexOf("rpc:reserve_creative_upload") < names.indexOf("actor"));
  assert.ok(names.indexOf("actor") < names.indexOf(`rpc:${CLAIM}`), "Reclamation requires a fresh actor check after capacity refusal");
  assert.ok(names.indexOf(`rpc:${CLAIM}`) < names.lastIndexOf("rpc:reserve_creative_upload"));
  assert.equal(f.rpcCalls.filter(call => call.name === CLAIM).length, 1);
}

for (const options of [{}, { lostAck: true }]) {
  test(`capacity integration: actual prepare retries exact admission once after ${options.lostAck ? "uncertain cleanup ACK" : "proven cleanup"} and resumes the existing original`, async t => {
    const f = capacityFixture(t, options), outcome = await f.prepare();
    assert.equal(outcome.ok, true, outcome.ok ? undefined : inspect(outcome.error));
    if (outcome.ok) {
      assert.equal(outcome.value.uploadRequired, false);
      assert.equal(outcome.value.storageBucket, BUCKET); assert.equal(outcome.value.storagePath, `${W}/staged/${NEXT}/original.jpg`);
      assert.equal(outcome.value.token, undefined); assert.equal(outcome.value.signedUrl, undefined);
      assert.equal(outcome.value.publicUrl, undefined); assert.equal(outcome.value.asset, undefined);
    }
    exactAdmissionRetry(f); assert.equal(f.uploads.length, 1); assert.equal(f.listings.length, 1);
    assert.equal(f.actorCalls.length, 2, "Prepare must recheck membership after the admission retry as well");
    assert.equal(f.completions().length, options.lostAck ? 2 : 1);
    assert.ok(f.events.lastIndexOf("actor") < f.events.indexOf("list"));
  });
}

for (const options of [{}, { lostAck: true }, { claimRows: () => [] }, { proof: "original" }]) {
  test(`capacity integration: persistent capacity refusal stays bounded after ${options.lostAck ? "lost ACK" : options.claimRows ? "empty claim" : options.proof ? "failed byte proof" : "cleanup"}`, async t => {
    const f = capacityFixture(t, { ...options, retryReserveError: "P8805" }), outcome = await f.prepare();
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal((outcome.error as Row).code, "creative_upload_capacity_exhausted");
      assert.equal((outcome.error as Row).status, 429);
    }
    exactAdmissionRetry(f); assert.equal(f.listings.length, 0);
    assert.equal(f.actorCalls.length, 1); assert.ok(f.uploads.length <= 1);
  });
}

test("capacity integration: revoked membership blocks cleanup, admission retry, listing, and token minting", async t => {
  const f = capacityFixture(t, { member: { status: "inactive" } }), outcome = await f.prepare();
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal((outcome.error as Row).code, "creative_upload_access_denied");
  assert.equal(f.admissions().length, 1); assert.equal(f.actorCalls.length, 1);
  assert.equal(f.rpcCalls.filter(call => call.name === CLAIM).length, 0);
  assert.equal(f.uploads.length, 0); assert.equal(f.listings.length, 0); noProofOrAck(f);
});

test("capacity integration: revocation after cleanup cannot expose a prepared private upload", async t => {
  const f = capacityFixture(t, { revokeAfterCleanup: true }), outcome = await f.prepare();
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal((outcome.error as Row).code, "creative_upload_access_denied");
  exactAdmissionRetry(f); assert.equal(f.actorCalls.length, 2); assert.equal(f.listings.length, 0);
});

for (const code of ["P8801", "P8802", "P8803", "P8804"]) {
  test(`capacity integration: non-capacity ${code} admission refusal never invokes reclamation`, async t => {
    const f = capacityFixture(t, { initialReserveError: code }), outcome = await f.prepare();
    assert.equal(outcome.ok, false); assert.equal(f.admissions().length, 1);
    assert.equal(f.rpcCalls.filter(call => call.name === CLAIM).length, 0);
    assert.equal(f.actorCalls.length, 0); assert.equal(f.uploads.length, 0); assert.equal(f.listings.length, 0); noProofOrAck(f);
  });
}
