import assert from "node:assert/strict";
import test from "node:test";

type Row = Record<string, any>;
const actual = await import(new URL("../../lib/content-studio/generation.ts", import.meta.url).href);
const secret = "SYNTHETIC_VIDEO_DEADLINE_KEY";
const config = { apiKey: secret, imageModel: "", videoModel: "synthetic", videoSeconds: "4" };
const json = JSON.stringify({ id: "synthetic_job", status: "queued", progress: 0 });
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const deferred = () => { let resolve!: (value: any) => void, reject!: (error: unknown) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(kind: "create" | "poll", options: Row = {}) {
  const calls: Row[] = [], chunks: Uint8Array[] = options.chunks ?? [Buffer.from(json)];
  const metrics = { reads: 0, readerCancels: 0, bodyCancels: 0, texts: 0 };
  const response: Row = { ok: (options.status ?? 200) < 300, status: options.status ?? 200,
    url: options.url ?? "", redirected: options.redirected ?? false,
    headers: { get: (name: string) => name === "content-length" ? options.length ?? null
      : name === "content-encoding" ? options.encoding ?? null : null },
    body: { getReader() { return {
      async read() { metrics.reads++; if (options.read) return options.read(metrics.reads);
        const next = chunks.shift(); return next === undefined ? { done: true } : { done: false, value: next }; },
      cancel() { metrics.readerCancels++; return options.cancel ? options.cancel() : Promise.resolve(); },
    }; }, cancel() { metrics.bodyCancels++; return options.cancel ? options.cancel() : Promise.resolve(); } },
    text: async () => { metrics.texts++; return options.text ? options.text() : json; },
    arrayBuffer: async () => { throw new Error("No buffered fallback"); } };
  if (options.noBody) response.body = null;
  const fetchImpl = async (url: string, init: Row) => { calls.push({ url, init });
    return options.fetch ? options.fetch(response) : response; };
  const invoke = (extra: Row = {}) => kind === "create"
    ? actual.createVideoJob({ fetchImpl, config, prompt: "Synthetic private prompt", size: "1080x1920", ...extra })
    : actual.fetchVideoJob({ fetchImpl, config, jobId: "synthetic_job", ...extra });
  return { calls, metrics, response, invoke };
}

async function refused(work: Promise<unknown>, status = 502) {
  await assert.rejects(work, (error: any) => {
    assert.ok(error instanceof actual.GenerationProviderError); assert.equal(error.status, status);
    assert.equal(error.message.includes(secret), false); assert.equal(error.message.includes("private prompt"), false);
    return true;
  });
}

for (const kind of ["create", "poll"] as const) {
  test(`${kind} video metadata uses one guarded transport and bounded stream, never text fallback`, async () => {
    const f = fixture(kind, { length: String(Buffer.byteLength(json)) });
    const job = await f.invoke(); assert.equal(job.id, "synthetic_job"); assert.equal(job.status, "queued");
    assert.equal(f.calls.length, 1); const { url, init } = f.calls[0]!;
    assert.equal(url, `https://api.openai.com/v1/videos${kind === "poll" ? "/synthetic_job" : ""}`);
    assert.equal(init.method, kind === "create" ? "POST" : "GET");
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
    assert.equal(init.headers.Authorization, `Bearer ${secret}`); assert.equal(init.signal.aborted, true);
    assert.equal(f.metrics.readerCancels, 1); assert.equal(f.metrics.texts, 0);
    if (kind === "create") assert.deepEqual(JSON.parse(init.body), { model: "synthetic", prompt: "Synthetic private prompt", size: "1080x1920", seconds: "4" });
  });

  for (const phase of ["headers", "body"] as const) test(`${kind} stalled ${phase} expires at the 15-second total deadline`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const never = () => new Promise<never>(() => {});
    const f = fixture(kind, { ...(phase === "headers" ? { fetch: never } : { read: never }), cancel: never });
    let ended = false;
    const pending = f.invoke().then(() => { ended = true; return null; }, (error: unknown) => { ended = true; return error; });
    await flush(); t.mock.timers.tick(14_999); await flush(); assert.equal(ended, false);
    t.mock.timers.tick(1); await flush(); assert.equal(ended, true, "Provider metadata must not remain unbounded");
    const error = await pending; assert.ok(error instanceof actual.GenerationProviderError); assert.equal(error.status, 502);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.init.signal.aborted, true);
    if (phase === "body") assert.equal(f.metrics.readerCancels, 1);
  });

  test(`${kind} body has only the remainder of the header deadline`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const headers = deferred(), never = () => new Promise<never>(() => {});
    const f = fixture(kind, { fetch: () => headers.promise, read: never });
    let ended = false; const pending = f.invoke().catch((error: unknown) => { ended = true; return error; });
    await flush(); t.mock.timers.tick(10_000); headers.resolve(f.response); await flush();
    t.mock.timers.tick(4999); await flush(); assert.equal(ended, false);
    t.mock.timers.tick(1); await flush(); assert.equal(ended, true);
    assert.equal((await pending).status, 502); assert.equal(f.calls.length, 1);
  });

  for (const ending of ["success", "rejection"] as const) test(`${kind} late header ${ending} cannot replace an unknown outcome`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const headers = deferred(), f = fixture(kind, { fetch: () => headers.promise });
    let ended = false; const pending = f.invoke().catch((error: unknown) => { ended = true; return error; });
    await flush(); t.mock.timers.tick(15_000); await flush(); assert.equal(ended, true);
    const outcome = await pending; assert.equal(outcome.status, 502);
    if (ending === "success") headers.resolve(f.response); else headers.reject(new Error(secret));
    await flush(); assert.equal(f.metrics.reads, 0); assert.equal(f.metrics.bodyCancels, ending === "success" ? 1 : 0);
    assert.equal(outcome.status, 502); assert.equal(f.calls.length, 1);
  });

  for (const status of [400, 401, 403, 422, 429, 500, 503]) test(`${kind} confirmed HTTP ${status} ignores private and stalled error bodies`, async () => {
    const f = fixture(kind, { status, read: () => new Promise<never>(() => {}), text: () => new Promise<never>(() => {}),
      cancel: () => new Promise<never>(() => {}) });
    await refused(f.invoke(), status); assert.equal(f.metrics.reads, 0); assert.equal(f.metrics.texts, 0);
    assert.equal(f.metrics.bodyCancels, 1);
  });

  for (const options of [{ redirected: true }, { url: "https://foreign.invalid/video" },
    { url: "https://api.openai.com/v1/videos/foreign" }, { noBody: true }, { chunks: [] },
    { chunks: [Buffer.from("not json")] }, { chunks: [Buffer.from("[]")] },
    { chunks: [Buffer.from([0xc3, 0x28])] }, { chunks: [Buffer.alloc(65_537, 65)] },
    { length: "65537" }, { length: "-1" }, { length: "1.5" }, { length: " 20 " },
    { length: "0" }, { length: "NaN" }, { length: "9007199254740992" }, { length: String(Buffer.byteLength(json) + 1) },
    { length: String(Buffer.byteLength(json) - 1) }]) {
    test(`${kind} refuses unconfirmed or unbounded metadata ${JSON.stringify(options).slice(0, 125)}`, async () => {
      const f = fixture(kind, options); await refused(f.invoke()); assert.equal(f.calls.length, 1); assert.equal(f.metrics.texts, 0);
    });
  }

  test(`${kind} bounds fragment overhead and copies reused buffers`, async () => {
    const excessive = fixture(kind, { chunks: Array.from({ length: 2049 }, () => new Uint8Array([32])) });
    await refused(excessive.invoke()); assert.equal(excessive.metrics.reads, 2049);
    const bytes = Buffer.from(json), f = fixture(kind, { read: async (n: number) => {
      if (n === 1) return { done: false, value: bytes }; bytes.fill(0); return { done: true };
    } });
    assert.equal((await f.invoke()).id, "synthetic_job");
  });

  test(`${kind} bounds decoded compressed JSON without confusing encoded Content-Length`, async () => {
    assert.equal((await fixture(kind, { encoding: "gzip", length: "1" }).invoke()).id, "synthetic_job");
    await refused(fixture(kind, { encoding: "gzip", length: "1", chunks: [Buffer.alloc(65_537, 65)] }).invoke());
  });

  test(`${kind} a transport exception cannot counterfeit a confirmed provider rejection`, async () => {
    const f = fixture(kind, { fetch: () => { throw new actual.GenerationProviderError(429, secret); } });
    await refused(f.invoke()); assert.equal(f.calls.length, 1);
  });

  test(`${kind} accepts a shorter internal deadline but no invalid override can send a request`, async t => {
    for (const timeoutMs of [0, -1, 15001, NaN, Infinity, 1.5, "15"]) {
      const f = fixture(kind); await refused(f.invoke({ timeoutMs })); assert.equal(f.calls.length, 0);
    }
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(kind, { fetch: () => new Promise<never>(() => {}) });
    let ended = false; const pending = f.invoke({ timeoutMs: 25 }).catch((error: unknown) => { ended = true; return error; });
    await flush(); t.mock.timers.tick(25); await flush(); assert.equal(ended, true); assert.equal((await pending).status, 502);
  });
}
