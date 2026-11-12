import assert from "node:assert/strict";
import test from "node:test";

type Row = Record<string, any>;
const actual = await import(new URL("../../lib/content-studio/generation.ts", import.meta.url).href);
const bytes = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex");
const secret = "SYNTHETIC_PROVIDER_DOWNLOAD_KEY";
const config = { apiKey: secret, imageModel: "", videoModel: "synthetic", videoSeconds: "4" };

function fixture(options: Row = {}) {
  const metrics = { requests: 0, reads: 0, readerCancels: 0, bodyCancels: 0, arrayBuffers: 0, texts: 0 };
  const calls: Row[] = [];
  const chunks: Uint8Array[] = options.chunks ?? [bytes.subarray(0, 7), bytes.subarray(7)];
  const response: Row = { ok: (options.status ?? 200) === 200, status: options.status ?? 200,
    redirected: options.redirected ?? false, url: options.url ?? "",
    headers: new Headers(options.length === undefined ? {} : { "content-length": String(options.length) }),
    body: { getReader() { return {
      async read() { metrics.reads++; if (options.read) return options.read(metrics.reads);
        const chunk = chunks.shift(); return chunk === undefined ? { done: true } : { done: false, value: chunk }; },
      cancel() { metrics.readerCancels++; return options.readerCancel ? options.readerCancel() : Promise.resolve(); },
    }; }, cancel() { metrics.bodyCancels++; return options.bodyCancel ? options.bodyCancel() : Promise.resolve(); } },
    text: async () => { metrics.texts++; throw new Error(secret); },
    arrayBuffer: async () => { metrics.arrayBuffers++; throw new Error("No buffered fallback is permitted"); } };
  if (options.noBody) response.body = null;
  const fetchImpl = async (url: string, init: Row) => { metrics.requests++; calls.push({ url, init });
    return options.fetch ? options.fetch(response) : response; };
  const download = (overrides: Row = {}) => actual.downloadVideoContent({ fetchImpl, config, jobId: "synthetic_job/with-space ", ...overrides });
  return { metrics, calls, response, download };
}

async function refused(work: Promise<unknown>, status = 502) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof Error); assert.ok(error instanceof actual.GenerationProviderError);
    assert.ok("status" in error); assert.equal(error.status, status);
    assert.equal(error.message.includes(secret), false); return true;
  });
}

test("provider video download streams exact bytes using a guarded credential-bearing GET", async () => {
  const f = fixture({ length: bytes.length }); assert.deepEqual(await f.download(), bytes);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, "https://api.openai.com/v1/videos/synthetic_job%2Fwith-space%20/content?variant=video");
  const init = f.calls[0]!.init;
  assert.deepEqual(init.headers, { Authorization: `Bearer ${secret}` }); assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
  assert.equal(init.signal.aborted, true); assert.equal(f.metrics.reads, 3); assert.equal(f.metrics.readerCancels, 1);
  assert.equal(f.metrics.arrayBuffers, 0); assert.equal(f.metrics.texts, 0);
});

test("provider video download accepts missing Content-Length only after a bounded complete MP4 stream", async () => {
  const f = fixture(); assert.deepEqual(await f.download(), bytes); assert.equal(f.metrics.arrayBuffers, 0);
});

for (const length of ["", "NaN", "-1", "1.5", " 24 ", "Infinity", "9007199254740992", 0, 100 * 1024 * 1024 + 1]) {
  test(`provider video download refuses invalid or excessive length ${JSON.stringify(length)} before reading`, async () => {
    const f = fixture({ length });
    // A real Headers object trims whitespace; this case also checks an injected noncanonical header value.
    if (length === " 24 ") f.response.headers = { get: () => length };
    await refused(f.download()); assert.equal(f.metrics.reads, 0); assert.equal(f.metrics.bodyCancels, 1); assert.equal(f.metrics.arrayBuffers, 0);
  });
}

for (const options of [{ chunks: [] }, { chunks: [Buffer.alloc(0)] }, { length: bytes.length + 1 },
  { length: bytes.length - 1 }, { chunks: [Buffer.from("not an mp4 at all")] }, { chunks: [Buffer.from([0, 1])] }, { noBody: true }]) {
  test(`provider video download refuses empty, truncated, overdeclared or non-MP4 content ${JSON.stringify(options)}`, async () => {
    const f = fixture(options); await refused(f.download()); assert.equal(f.metrics.arrayBuffers, 0); assert.equal(f.metrics.texts, 0);
  });
}

test("provider video download rejects a chunk exceeding 100 MiB before concatenation or reading further", async t => {
  const huge = new Uint8Array(100 * 1024 * 1024 + 1), f = fixture({ chunks: [huge] });
  let concats = 0; const concat = Buffer.concat;
  t.mock.method(Buffer, "concat", (...args: Parameters<typeof Buffer.concat>) => { concats++; return concat(...args); });
  await refused(f.download()); assert.equal(f.metrics.reads, 1); assert.equal(concats, 0); assert.equal(f.metrics.readerCancels, 1);
});

test("provider video download bounds retained fragment overhead even when payload bytes are small", async () => {
  const f = fixture({ chunks: [bytes, ...Array.from({ length: 8192 }, () => new Uint8Array([1]))] });
  await refused(f.download()); assert.equal(f.metrics.reads, 8193); assert.equal(f.metrics.readerCancels, 1); assert.equal(f.metrics.arrayBuffers, 0);
});

for (const options of [{ redirected: true }, { url: "https://foreign.invalid/content" }, { url: "https://api.openai.com/v1/videos/other/content" }]) {
  test(`provider video download rejects redirect evidence ${JSON.stringify(options)} before touching bytes`, async () => {
    const f = fixture(options); await refused(f.download()); assert.equal(f.metrics.reads, 0); assert.equal(f.metrics.bodyCancels, 1);
  });
}

for (const status of [400, 401, 403, 404, 422, 429, 500, 503]) {
  test(`provider video download preserves HTTP ${status} without reading a private or unbounded error body`, async () => {
    const f = fixture({ status, bodyCancel: () => new Promise<never>(() => {}) });
    await refused(f.download(), status); assert.equal(f.metrics.texts, 0); assert.equal(f.metrics.reads, 0); assert.equal(f.metrics.bodyCancels, 1);
  });
}

for (const phase of ["headers", "body"] as const) {
  test(`provider video download bounds stalled ${phase} without awaiting hung cleanup`, { timeout: 2000 }, async () => {
    const f = fixture({ ...(phase === "headers" ? { fetch: () => new Promise<never>(() => {}) }
      : { read: () => new Promise<never>(() => {}) }), readerCancel: () => new Promise<never>(() => {}) });
    await refused(f.download({ timeoutMs: 15 })); assert.equal(f.calls[0]!.init.signal.aborted, true);
    if (phase === "body") assert.equal(f.metrics.readerCancels, 1);
    assert.equal(f.metrics.arrayBuffers, 0);
  });
}

test("provider video download has one deadline for headers and body, not a fresh timeout for every chunk", { timeout: 2000 }, async t => {
  const nativeTimer = globalThis.setTimeout, delays: number[] = [];
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    delays.push(delay!); return nativeTimer(callback, delay, ...args);
  });
  const f = fixture({ read: () => new Promise<never>(() => {}) });
  await refused(f.download({ timeoutMs: 15 })); assert.deepEqual(delays, [15]);
});

test("provider video download cancels a body arriving after a timed-out header request", { timeout: 2000 }, async () => {
  let accept!: (value: unknown) => void;
  const f = fixture({ fetch: () => new Promise(resolve => { accept = resolve; }), bodyCancel: () => new Promise<never>(() => {}) });
  await refused(f.download({ timeoutMs: 10 })); assert.equal(f.metrics.bodyCancels, 0);
  accept(f.response); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.metrics.bodyCancels, 1); assert.equal(f.metrics.reads, 0); assert.equal(f.calls[0]!.init.signal.aborted, true);
});

test("provider video download copies retained chunks before the next asynchronous read can mutate them", async () => {
  const chunk = Buffer.from(bytes), f = fixture({ read: async (n: number) => {
    if (n === 1) return { done: false, value: chunk };
    chunk[4] = 0; return { done: true };
  } });
  assert.deepEqual(await f.download(), bytes); assert.equal(chunk[4], 0);
});

for (const phase of ["fetch", "read"] as const) test(`provider video download redacts a thrown ${phase} diagnostic`, async () => {
  const fail = () => { throw new Error(secret); }, f = fixture(phase === "fetch" ? { fetch: fail } : { read: fail });
  await refused(f.download()); assert.equal(f.metrics.arrayBuffers, 0);
});

test("provider video download preserves a typed failure status but never its private diagnostic", async () => {
  const f = fixture({ fetch: () => { throw new actual.GenerationProviderError(429, secret); } });
  await refused(f.download(), 429);
});

test("provider video download uses a 15-second default and rejects unsafe test overrides before any request", async t => {
  const nativeTimer = globalThis.setTimeout, delays: number[] = [];
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    delays.push(delay!); return nativeTimer(callback, delay, ...args);
  });
  const f = fixture(); await f.download(); assert.deepEqual(delays, [15000]);
  for (const timeoutMs of [0, -1, 15001, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "15"]) await refused(f.download({ timeoutMs }));
  assert.equal(f.metrics.requests, 1);
});
