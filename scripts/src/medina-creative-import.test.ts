import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

// Real downloader and actual Ads import/upload closures; synthetic HTTP, streams,
// clock and UI state only. No SDK, browser, credentials, provider or real network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const helperSource = await readFile(path.join(root, "artifacts/negis/src/lib/creative-import.ts"), "utf8");
const helperCode = ts.transpileModule(helperSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const W = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const origin = "https://storage.fixture.invalid";
const base = `${origin}/storage/v1/object/public/ad-creatives/`;
const generatedKey = "1".repeat(64);
const generatedUrl = `${base}${W}/generated/${generatedKey}`;
const imageCap = 10 * 1024 * 1024, videoCap = 500 * 1024 * 1024;
type Bag = Record<string, any>;
type Input = { url: string; fileName: string; mimeType: string; storageOrigin: string; workspaceId: string;
  signal: AbortSignal; assertCurrent(): void; request?: (url: string, init: RequestInit) => Promise<Response> };
type Helper = { downloadCreativeImport(input: Input): Promise<File>; CREATIVE_IMPORT_DEADLINE_MS: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function fixture(extension = "jpg", mimeType = "image/jpeg") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const controller = new AbortController();
  const headerGate = deferred<Response>(), readGate = deferred<{ done: boolean; value?: Uint8Array }>();
  const timers = new Map<number, { at: number; callback(): void }>();
  let now = 0, nextTimer = 0, checks = 0, reads = 0, readerCancels = 0, bodyCancels = 0, files = 0;
  let current = true, holdHeaders = false, holdRead = false, cancelHangs = false;
  let chunks: Uint8Array[] = [new Uint8Array([1, 2]), new Uint8Array([3])];
  const headers = new Headers({ "Content-Type": mimeType, "Content-Length": "3" });
  const response: Bag = {
    ok: true, redirected: false, url: "", headers,
    blob() { assert.fail("Unbounded response.blob() must never be used"); },
    arrayBuffer() { assert.fail("Unbounded response.arrayBuffer() must never be used"); },
    body: {
      cancel() { bodyCancels++; return cancelHangs ? new Promise<void>(() => {}) : Promise.resolve(); },
      getReader() { return {
        async read() {
          reads++;
          if (holdRead) return readGate.promise;
          const value = chunks.shift();
          return value ? { done: false, value } : { done: true, value: undefined };
        },
        cancel() { readerCancels++; return cancelHangs ? new Promise<void>(() => {}) : Promise.resolve(); },
        releaseLock() { if (holdRead) throw new Error("Synthetic pending read"); },
      }; },
    },
  };
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return holdHeaders ? headerGate.promise : response as Response;
  };
  class ClockDate extends Date { static now() { return now; } }
  class CountedFile extends File {
    constructor(...args: ConstructorParameters<typeof File>) { super(...args); files++; }
  }
  const exports = {} as Helper;
  new Script(helperCode, { filename: "creative-import.actual.cjs" }).runInNewContext({
    exports, Error, DOMException, Blob, File: CountedFile, URL, Headers, TextEncoder, Uint8Array, AbortController, Date: ClockDate,
    fetch: request,
    setTimeout(callback: () => void, delay: number) { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  const input: Input = {
    url: `${base}${W}/verified/file.${extension}`, fileName: `handoff.${extension}`, mimeType,
    storageOrigin: origin, workspaceId: W, signal: controller.signal, request,
    assertCurrent() { checks++; if (!current) throw new DOMException("Creative selection changed", "AbortError"); },
  };
  return { module: exports, input, calls, response, headers, controller,
    start(overrides: Partial<Input> = {}) { return exports.downloadCreativeImport({ ...input, ...overrides }); },
    holdHeaders() { holdHeaders = true; }, releaseHeaders() { headerGate.resolve(response as Response); },
    holdRead() { holdRead = true; }, releaseRead() { holdRead = false; chunks = []; readGate.resolve({ done: false, value: new Uint8Array([1, 2, 3]) }); },
    chunks(value: Uint8Array[]) { chunks = value; }, hangCancellation() { cancelHangs = true; },
    expire() { current = false; },
    advance(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
    get counters() { return { checks, reads, readerCancels, bodyCancels, files, timers: timers.size }; },
    get timerDeadlines() { return [...timers.values()].map(timer => timer.at); },
  };
}

const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected); return true;
};

const supportedTypes = [["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["png", "image/png"],
  ["webp", "image/webp"], ["mp4", "video/mp4"], ["mov", "video/quicktime"], ["webm", "video/webm"]];
for (const [extension, mimeType] of supportedTypes) {
  for (const layout of ["tenant", "optimized"]) {
    test(`bounded ${layout} ${extension} import returns bytes, never asset identity`, async () => {
      const f = fixture(extension, mimeType);
      if (layout === "optimized") f.input.url = `${base}optimized/${W}/output.${extension}`;
      const file = await f.start();
      assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
      assert.equal(file.name, `handoff.${extension}`); assert.equal(file.type, mimeType); assert.equal(file.size, 3);
      assert.equal((file as unknown as Bag).assetId, undefined); assert.equal((file as unknown as Bag).publicUrl, undefined);
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, f.input.url);
      const init = f.calls[0].init;
      assert.equal(init.credentials, "omit"); assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.equal(init.headers, undefined);
      assert.equal(init.signal?.aborted, false); assert.equal(f.counters.timers, 0); assert.equal(f.counters.files, 1);
    });
  }
}

for (const [extension, mimeType] of supportedTypes) for (const layout of ["tenant", "optimized"]) {
  test(`extensionless ${layout} ${extension} imports all bytes using the validated handoff type`, async () => {
    const f = fixture(extension, mimeType);
    f.input.url = layout === "optimized" ? `${base}optimized/${W}/${generatedKey}` : generatedUrl;
    f.response.url = f.input.url;
    const file = await f.start();
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
    assert.equal(file.name, f.input.fileName); assert.equal(file.type, mimeType); assert.equal(file.size, 3);
    for (const field of ["id", "assetId", "publicUrl", "status", "ready"]) assert.equal((file as unknown as Bag)[field], undefined);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, f.input.url);
    assert.equal(f.calls[0].init.credentials, "omit"); assert.equal(f.calls[0].init.redirect, "error");
    assert.equal(f.calls[0].init.referrerPolicy, "no-referrer"); assert.equal(f.calls[0].init.cache, "no-store");
    assert.equal(f.calls[0].init.headers, undefined); assert.equal(f.counters.timers, 0); assert.equal(f.counters.files, 1);
  });
}

test("only the final object component determines whether an extension is absent", async () => {
  for (const url of [`${base}${W}/generated.v1/${generatedKey}`, `${base}optimized/${W}/source.exe/jpg`]) {
    const f = fixture("png", "image/png");
    const file = await f.start({ url, fileName: "Generated image.PNG" });
    assert.equal(file.name, "Generated image.PNG"); assert.equal(file.type, "image/png");
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
  }
});

const badSources: Record<string, string> = {
  external: "https://arbitrary.invalid/image.jpg", lookalike: `${origin}.evil.invalid/storage/v1/object/public/ad-creatives/${W}/a.jpg`,
  http: `${base}${W}/a.jpg`.replace("https:", "http:"), otherTenant: `${base}${B}/a.jpg`,
  optimizedOtherTenant: `${base}optimized/${B}/a.mp4`, tenantPrefix: `${base}${W}-other/a.jpg`,
  privateBucket: `${origin}/storage/v1/object/public/ad-creatives-staging/${W}/a.jpg`,
  signedEndpoint: `${origin}/storage/v1/object/sign/ad-creatives/${W}/a.jpg`,
  credentials: `${base}${W}/a.jpg`.replace("https://", "https://user:secret@"),
  query: `${base}${W}/a.jpg?token=secret`, emptyQuery: `${base}${W}/a.jpg?`, hash: `${base}${W}/a.jpg#secret`,
  emptyHash: `${base}${W}/a.jpg#`, percent: `${base}${W}/%61.jpg`, encodedSlash: `${base}${W}/a%2fb.jpg`,
  encodedTraversal: `${base}${W}/%2e%2e/${B}/a.jpg`, traversal: `${base}${W}/../${B}/a.jpg`,
  dot: `${base}${W}/./a.jpg`, emptySegment: `${base}${W}//a.jpg`, backslash: `${base}${W}/a\\b.jpg`,
  whitespace: ` ${base}${W}/a.jpg`, newline: `${base}${W}/a\n.jpg`, wrongPrefix: `${origin}/public/ad-creatives/${W}/a.jpg`,
  missingObject: `${base}${W}/`, wrongExtension: `${base}${W}/a.svg`,
};
for (const [name, url] of Object.entries(badSources)) {
  test(`unsupported ${name} source never fetches`, async () => {
    const f = fixture(); await assert.rejects(f.start({ url }), code("creative_import_source_untrusted"));
    assert.equal(f.calls.length, 0); assert.equal(f.counters.files, 0); assert.equal(f.counters.timers, 0);
  });
}

test("extensionlessGenerated source without a filename extension never fetches", async () => {
  const f = fixture();
  await assert.rejects(f.start({ url: generatedUrl, fileName: "handoff" }), code("creative_import_source_untrusted"));
  assert.equal(f.calls.length, 0); assert.equal(f.counters.files, 0); assert.equal(f.counters.timers, 0);
});

for (const [name, url] of Object.entries(badSources).filter(([name]) => name !== "wrongExtension")) {
  test(`extensionless ${name} source still never fetches`, async () => {
    const f = fixture();
    await assert.rejects(f.start({ url: url.replace(/\.(?:jpg|mp4)/g, "") }), code("creative_import_source_untrusted"));
    assert.equal(f.calls.length, 0); assert.equal(f.counters.files, 0); assert.equal(f.counters.timers, 0);
  });
}

for (const suffix of [".html", ".exe", ".weird", ".jpg.html", ".", ".JPG.exe", ".toString", ".constructor"])
  for (const prefix of [`${base}${W}/generated/`, `${base}optimized/${W}/`]) {
    test(`explicit object suffix ${suffix} under ${prefix} cannot borrow the handoff type`, async () => {
      const f = fixture();
      await assert.rejects(f.start({ url: `${prefix}${generatedKey}${suffix}` }), code("creative_import_source_untrusted"));
      assert.equal(f.calls.length, 0); assert.equal(f.counters.files, 0);
    });
  }

for (const url of [`${base}${W}`, `${base}optimized/${W}`, `${base}optimized/${B}/${W}/${generatedKey}`,
  `${base}optimized-extra/${W}/${generatedKey}`, `${base}${W}/.hidden`, `${origin}:444/storage/v1/object/public/ad-creatives/${W}/${generatedKey}`]) {
  test(`extensionless scope or malformed final component ${url} fails before HTTP`, async () => {
    const f = fixture(); await assert.rejects(f.start({ url }), code("creative_import_source_untrusted"));
    assert.equal(f.calls.length, 0); assert.equal(f.counters.files, 0);
  });
}

for (const fileName of ["", "jpg", "handoff", ".jpg", " .jpg", "..jpg", "handoff..jpg", "handoff.", "handoff.html", "handoff.exe",
  "handoff.weird", "../handoff.jpg", "folder/handoff.jpg", "folder\\handoff.jpg", "handoff%2ejpg", "handoff?.jpg", "handoff#.jpg",
  "handoff\n.jpg", "handoff\u0000.jpg", "handoff\u007f.jpg", " handoff.jpg", "handoff.jpg ", `${"a".repeat(252)}.jpg`,
  `${"\u00e9".repeat(126)}.jpg`, null, 123, {}, []]) {
  test(`malformed handoff filename ${JSON.stringify(fileName)} cannot type an extensionless object`, async () => {
    for (const url of [generatedUrl, `${base}${W}/file.jpg`]) {
      const f = fixture();
      await assert.rejects(f.start({ url, fileName: fileName as string }), code("creative_import_source_untrusted"));
      assert.equal(f.calls.length, 0); assert.equal(f.counters.files, 0); assert.equal(f.counters.timers, 0);
    }
  });
}

test("extensionless handoff filename byte limit accepts exactly 255 UTF-8 bytes", async () => {
  for (const fileName of [`${"a".repeat(251)}.jpg`, `${"\u00e9".repeat(125)}a.jpg`]) {
    const f = fixture(); const file = await f.start({ url: generatedUrl, fileName });
    assert.equal(file.name, fileName); assert.equal(new TextEncoder().encode(file.name).length, 255);
  }
});

for (const overrides of [{ mimeType: "image/png" }, { mimeType: "video/mp4" }, { mimeType: "text/html" },
  { mimeType: "application/octet-stream" }, { mimeType: "image/svg+xml" }, { mimeType: "image/jpeg; charset=utf-8" },
  { mimeType: "IMAGE/JPEG" }, { mimeType: "" }, { fileName: "handoff.png" }, { fileName: "handoff.mp4" },
  { fileName: "handoff.constructor" }, { fileName: "handoff.toString" }]) {
  test(`extensionless mismatched or unsupported handoff ${JSON.stringify(overrides)} never fetches`, async () => {
    const f = fixture();
    await assert.rejects(f.start({ url: generatedUrl, ...overrides }), code("creative_import_source_untrusted"));
    assert.equal(f.calls.length, 0); assert.equal(f.counters.files, 0);
  });
}

for (const overrides of [{ storageOrigin: "http://storage.fixture.invalid" }, { storageOrigin: `${origin}/extra` },
  { storageOrigin: `${origin}?secret=x` }, { storageOrigin: `https://user:secret@storage.fixture.invalid` },
  { workspaceId: B }, { mimeType: "image/png" }, { fileName: "wrong.png" }, { fileName: "../handoff.jpg" }]) {
  test(`invalid source contract ${JSON.stringify(overrides)} refuses before HTTP`, async () => {
    const f = fixture(); await assert.rejects(f.start(overrides), code("creative_import_source_untrusted")); assert.equal(f.calls.length, 0);
  });
}

for (const type of [null, "text/html", "image/png", "video/mp4", "image/svg+xml"]) {
  test(`response MIME ${type} cannot impersonate a JPEG`, async () => {
    const f = fixture(); if (type === null) f.headers.delete("Content-Type"); else f.headers.set("Content-Type", type);
    await assert.rejects(f.start(), code("creative_import_mime_mismatch"));
    assert.equal(f.counters.reads, 0); assert.equal(f.counters.bodyCancels, 1); assert.equal(f.counters.files, 0);
  });
}

for (const length of [null, "0", "-1", "1.5", "1e3", "+3", "9007199254740992", String(imageCap + 1)]) {
  test(`invalid declared length ${length} refuses before body buffering`, async () => {
    const f = fixture(); if (length === null) f.headers.delete("Content-Length"); else f.headers.set("Content-Length", length);
    f.hangCancellation(); await assert.rejects(f.start(), code("creative_import_size_invalid"));
    assert.equal(f.counters.reads, 0); assert.equal(f.counters.bodyCancels, 1); assert.equal(f.counters.files, 0);
  });
}

test("video declared limit is exactly 500 MiB, not the image cap", async () => {
  const f = fixture("mp4", "video/mp4"); f.headers.set("Content-Length", String(videoCap)); f.holdRead();
  const pending = f.start(); await flush(); assert.equal(f.counters.reads, 1);
  f.controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  const excessive = fixture("mp4", "video/mp4"); excessive.headers.set("Content-Length", String(videoCap + 1));
  await assert.rejects(excessive.start(), code("creative_import_size_invalid")); assert.equal(excessive.counters.reads, 0);
});

for (const [extension, mimeType, cap] of [["jpg", "image/jpeg", imageCap], ["mp4", "video/mp4", videoCap]] as const) {
  test(`${extension} streamed overflow is rejected before constructing a buffer/File`, async () => {
    const f = fixture(extension, mimeType); f.headers.set("Content-Length", String(cap));
    // Model an oversized incoming chunk without allocating a 500 MiB test fixture.
    const large = new Uint8Array(1); Object.defineProperty(large, "byteLength", { value: cap + 1 });
    f.chunks([large]); f.hangCancellation();
    await assert.rejects(f.start(), code("creative_import_size_exceeded"));
    assert.equal(f.counters.reads, 1); assert.equal(f.counters.readerCancels, 1); assert.equal(f.counters.files, 0);
    assert.equal(f.calls[0].init.signal?.aborted, true); assert.equal(f.counters.timers, 0);
  });
}

test("multiple chunks cannot exceed the declared size even below the image cap", async () => {
  const f = fixture(); f.chunks([new Uint8Array(2), new Uint8Array(2)]);
  await assert.rejects(f.start(), code("creative_import_size_exceeded")); assert.equal(f.counters.files, 0);
});
test("short and empty bodies do not satisfy a declared nonempty file", async () => {
  for (const chunks of [[], [new Uint8Array([1])]]) {
    const f = fixture(); f.chunks(chunks);
    await assert.rejects(f.start(), code("creative_import_size_mismatch")); assert.equal(f.counters.files, 0);
  }
});
test("exactly 10 MiB of fragmented image bytes is accepted without per-chunk buffer growth", async () => {
  const f = fixture(); f.headers.set("Content-Length", String(imageCap));
  f.chunks([new Uint8Array(1), new Uint8Array(imageCap - 1)]);
  const file = await f.start(); assert.equal(file.size, imageCap); assert.equal(f.counters.files, 1);
});
test("empty stream chunks consume no byte budget and cannot fabricate a file", async () => {
  const f = fixture(); f.chunks([...Array.from({ length: 1000 }, () => new Uint8Array()), new Uint8Array([1, 2, 3])]);
  const file = await f.start(); assert.equal(file.size, 3); assert.equal(f.counters.files, 1);
});
test("mutating the caller's input while headers wait cannot replace the validated filename or source", async () => {
  const f = fixture(); f.holdHeaders(); const pending = f.module.downloadCreativeImport(f.input);
  f.input.fileName = "changed.png"; f.input.mimeType = "image/png"; f.input.url = "https://untrusted.invalid/a.png";
  f.releaseHeaders(); const file = await pending;
  assert.equal(file.name, "handoff.jpg"); assert.equal(file.type, "image/jpeg"); assert.equal(f.calls.length, 1);
  assert.notEqual(f.calls[0].url, f.input.url);
});
test("a rejecting stream cancels without awaiting a hung cancellation", { timeout: 1000 }, async () => {
  const f = fixture(); f.hangCancellation();
  f.response.body.getReader = () => ({ read: async () => { throw new Error("Synthetic read failure"); },
    cancel: () => { f.response.body.cancel(); return new Promise(() => {}); }, releaseLock() {} });
  await assert.rejects(f.start(), /Synthetic read failure/); assert.equal(f.counters.bodyCancels, 1); assert.equal(f.counters.files, 0);
});
for (const change of [{ ok: false }, { redirected: true }, { url: "https://redirect.invalid/a.jpg" }, { body: null }]) {
  test(`untrusted response ${JSON.stringify(change)} fails closed`, async () => {
    const f = fixture(); Object.assign(f.response, change); await assert.rejects(f.start()); assert.equal(f.counters.files, 0);
  });
}

test("an already aborted session never fetches", async () => {
  const f = fixture(); f.controller.abort(); await assert.rejects(f.start(), { name: "AbortError" }); assert.equal(f.calls.length, 0);
});
test("session abort while headers are pending settles and cancels a late body without awaiting cancellation", async () => {
  const f = fixture(); f.holdHeaders(); f.hangCancellation(); const pending = f.start();
  f.controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  f.releaseHeaders(); await flush(); assert.equal(f.counters.bodyCancels, 1); assert.equal(f.counters.files, 0);
});
test("body abort settles even when read and cancel never settle", async () => {
  const f = fixture(); f.holdRead(); f.hangCancellation(); const pending = f.start(); await flush();
  f.controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.counters.readerCancels, 1); assert.equal(f.counters.timers, 0); assert.equal(f.counters.files, 0);
});
test("one total 20-second deadline covers headers plus body, never a fresh body budget", async () => {
  const f = fixture(); f.holdHeaders(); f.holdRead(); f.hangCancellation(); const pending = f.start();
  assert.deepEqual(f.timerDeadlines, [20_000]); f.advance(12_000); f.releaseHeaders(); await flush();
  assert.equal(f.counters.reads, 1); assert.deepEqual(f.timerDeadlines, [20_000]);
  f.advance(7_999); assert.equal(f.calls[0].init.signal?.aborted, false);
  f.advance(1); await assert.rejects(pending, { name: "TimeoutError" });
  assert.equal(f.counters.readerCancels, 1); assert.equal(f.counters.files, 0); assert.equal(f.counters.timers, 0);
});
test("headers alone cannot hang beyond the same total deadline", async () => {
  const f = fixture(); f.holdHeaders(); const pending = f.start(); f.advance(20_000);
  await assert.rejects(pending, { name: "TimeoutError" }); assert.equal(f.calls[0].init.signal?.aborted, true);
});
test("stale intent after a body await prevents publishing the downloaded file", async () => {
  const f = fixture(); f.holdRead(); const pending = f.start(); await flush(); f.expire(); f.releaseRead();
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(f.counters.files, 0); assert.equal(f.counters.readerCancels, 1);
});

for (const [extension, mimeType, cap] of [["jpg", "image/jpeg", imageCap], ["mp4", "video/mp4", videoCap]] as const) {
  for (const type of [null, "text/html", "application/octet-stream", "image/png", mimeType === "image/jpeg" ? "video/mp4" : "image/jpeg"]) {
    test(`extensionless ${extension} response MIME ${type} is rejected before reading bytes`, async () => {
      const f = fixture(extension, mimeType);
      if (type === null) f.headers.delete("Content-Type"); else f.headers.set("Content-Type", type);
      await assert.rejects(f.start({ url: generatedUrl }), code("creative_import_mime_mismatch"));
      assert.equal(f.counters.reads, 0); assert.equal(f.counters.bodyCancels, 1); assert.equal(f.counters.files, 0);
    });
  }
  for (const length of [null, "0", "-1", "1.5", "1e3", "+3", "03", "3, 3", "9007199254740992", String(cap + 1)]) {
    test(`extensionless ${extension} invalid Content-Length ${length} is rejected before reading bytes`, async () => {
      const f = fixture(extension, mimeType);
      if (length === null) f.headers.delete("Content-Length"); else f.headers.set("Content-Length", length);
      f.hangCancellation();
      await assert.rejects(f.start({ url: generatedUrl }), code("creative_import_size_invalid"));
      assert.equal(f.counters.reads, 0); assert.equal(f.counters.bodyCancels, 1); assert.equal(f.counters.files, 0);
    });
  }
  test(`extensionless ${extension} retains its exact cap and rejects a streamed overflow`, async () => {
    const f = fixture(extension, mimeType); f.headers.set("Content-Length", String(cap));
    const oversized = new Uint8Array(1); Object.defineProperty(oversized, "byteLength", { value: cap + 1 });
    f.chunks([oversized]);
    await assert.rejects(f.start({ url: generatedUrl }), code("creative_import_size_exceeded"));
    assert.equal(f.counters.reads, 1); assert.equal(f.counters.readerCancels, 1); assert.equal(f.counters.files, 0);
  });
  test(`extensionless ${extension} requires the full declared body, not just matching headers`, async () => {
    for (const chunks of [[], [new Uint8Array([1])], [new Uint8Array([1, 2, 3]), new Uint8Array([4])]]) {
      const f = fixture(extension, mimeType); f.chunks(chunks);
      await assert.rejects(f.start({ url: generatedUrl }), code(chunks.length === 2 ? "creative_import_size_exceeded" : "creative_import_size_mismatch"));
      assert.equal(f.counters.files, 0); assert.equal(f.counters.readerCancels, 1); assert.equal(f.counters.timers, 0);
    }
  });
}

for (const change of [{ ok: false }, { redirected: true }, { url: `${base}${W}/elsewhere` },
  { url: `${base}${B}/generated/${generatedKey}` }, { url: `${generatedUrl}?token=x` }, { body: null }]) {
  test(`extensionless untrusted response ${JSON.stringify(change)} fails closed`, async () => {
    const f = fixture(); Object.assign(f.response, change);
    await assert.rejects(f.start({ url: generatedUrl }), code(change.body === null ? "creative_import_stream_missing" : "creative_import_response_untrusted"));
    assert.equal(f.counters.reads, 0); assert.equal(f.counters.files, 0); assert.equal(f.counters.timers, 0);
  });
}

for (const phase of ["headers", "body"]) for (const change of ["abort", "deadline", "selection"]) {
  test(`extensionless ${phase} wait retains the ${change} guard`, async () => {
    const f = fixture(); f.input.url = generatedUrl; f.hangCancellation();
    if (phase === "headers") f.holdHeaders(); else f.holdRead();
    const pending = f.start(); await flush();
    if (change === "abort") f.controller.abort();
    else if (change === "deadline") f.advance(20_000);
    else { f.expire(); f.releaseHeaders(); f.releaseRead(); }
    await assert.rejects(pending, { name: change === "deadline" ? "TimeoutError" : "AbortError" });
    f.releaseHeaders(); f.releaseRead(); await flush();
    assert.equal(f.counters.files, 0); assert.equal(f.counters.timers, 0); assert.equal(f.calls[0].init.signal?.aborted, true);
    assert.equal(f.counters.bodyCancels + f.counters.readerCancels, 1);
  });
}

const pagePath = "artifacts/negis/src/pages/AdsAutomation.tsx";
const pageSource = await readFile(path.join(root, pagePath), "utf8");
const pageAst = ts.createSourceFile(pagePath, pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const session = pageAst.statements.find((node): node is import("typescript").FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "AdsAutomationSession")!;
function declaration(name: string) {
  const matches = [...pageAst.statements, ...session.body!.statements].filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `Execute exactly the actual ${name}`); return matches[0].getText(pageAst);
}
const componentCode = ts.transpileModule([
  ...["isSessionAlive", "assertSessionAlive", "beginCreativeIntent", "isCreativeIntentCurrent", "assertCreativeIntent",
    "inferCreativeFileType", "validateFile", "uploadCreative", "importCreativeFromUrl"].map(declaration),
  "exports.api = { importCreativeFromUrl, beginCreativeIntent };",
].join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  transformers: { before: [(context) => {
    const visit: import("typescript").Visitor = node => ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)
      ? ts.factory.createIdentifier("fixtureEnv") : ts.visitEachChild(node, visit, context);
    return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
  }] },
}).outputText;

function component(f: ReturnType<typeof fixture>, enabled: boolean | null = false) {
  const state: Bag = { creative: null, uploadStatus: "idle", loading: null };
  const writes: string[] = [], verified: File[] = [], worker: File[] = [];
  const verificationGate = deferred<void>();
  let holdVerification = false, failVerification = false;
  const controller = new AbortController(), sessionRef = { current: controller };
  const intentRef = { current: { revision: 0, file: null, videoJobId: "", requestKeys: new WeakMap() } };
  const metaSummaryRef = { current: { videoOptimization: enabled === null ? undefined : { enabled, maxInputMb: 500 } } };
  const setters = Object.fromEntries(["Creative", "CreativeFile", "VideoJob", "Loading", "UploadStatus", "UploadStage", "LastUploadError",
    "UploadDebug", "VideoConfigBlocked", "Notice"].map(name => [`set${name}`, (value: unknown) => {
      writes.push(name); state[name[0].toLowerCase() + name.slice(1)] = value;
    }]));
  const exports = {} as { api: { importCreativeFromUrl(url: string, name: string, mime: string): Promise<void>; beginCreativeIntent(file: null): number } };
  class PreviewURL extends URL { static createObjectURL() { return "blob:synthetic-preview"; } }
  new Script(componentCode, { filename: "AdsAutomation.import.actual.cjs" }).runInNewContext({
    exports, Error, DOMException, File, Blob, URL: PreviewURL, WeakMap, sessionRef, actorId: "A", workspaceId: W,
    signOutRevisionRef: { current: 0 }, getSignOutRevision: () => 0, isSignOutPending: () => false,
    creativeIntentRef: intentRef, fixtureEnv: { VITE_SUPABASE_URL: origin }, hasSupabaseFrontendEnv: true,
    metaSummaryRef, storageHealth: null,
    ...setters, uploadStatusLabel: (value: string) => value, friendlyCreativeError: () => "Synthetic safe failure",
    buildUploadDebug: () => ({}), uploadLinkMissingMessage: () => "Synthetic missing link",
    VIDEO_OPTIMIZATION_CONFIG_LOADING_MESSAGE: "Worker configuration pending", VIDEO_OPTIMIZATION_DISABLED_TOO_LARGE_MESSAGE: "Worker required",
    toast: { success() {}, error() {}, warning() {} }, checkHealth() {}, goToStep() {},
    async uploadVerifiedImage(_session: unknown, _intent: unknown, file: File) {
      verified.push(file);
      if (holdVerification) await verificationGate.promise;
      if (failVerification) throw new Error("Synthetic native media validation refused the bytes");
      return { id: "canonical-verified-id", fileName: file.name, fileType: "image", mimeType: file.type,
        fileSize: file.size, storageBucket: "ad-creatives", storagePath: `${W}/verified/server.jpg`, publicUrl: `${base}${W}/verified/server.jpg` };
    },
    async uploadLargeVideo(file: File) { worker.push(file); },
    require(name: string) { assert.equal(name, "@/lib/creative-import"); return f.module; },
  });
  return { state, writes, verified, worker, api: exports.api,
    start() { return exports.api.importCreativeFromUrl(f.input.url, f.input.fileName, f.input.mimeType); },
    holdVerification() { holdVerification = true; }, releaseVerification() { verificationGate.resolve(); },
    failVerification() { failVerification = true; },
    replace() { exports.api.beginCreativeIntent(null); },
    abortABA() { controller.abort(); sessionRef.current = new AbortController(); },
    disableWorker() { metaSummaryRef.current.videoOptimization = { enabled: false, maxInputMb: 500 }; },
  };
}

test("actual importer refuses arbitrary URL before fetch, verification or worker", async () => {
  const f = fixture(); f.input.url = "https://arbitrary.invalid/untrusted.jpg"; const c = component(f);
  await c.start(); assert.equal(f.calls.length, 0); assert.equal(c.verified.length, 0); assert.equal(c.worker.length, 0);
  assert.equal(c.state.creative, null); assert.equal(c.state.uploadStatus, "failed");
});
for (const phase of ["module", "headers", "body"]) for (const change of ["selection", "account ABA"]) {
  test(`actual importer ${phase} await cannot outlive ${change}`, async () => {
    const f = fixture(); if (phase === "headers") f.holdHeaders(); if (phase === "body") f.holdRead();
    const c = component(f), pending = c.start(); if (phase !== "module") await flush();
    if (change === "selection") c.replace(); else c.abortABA();
    const writes = c.writes.length; f.releaseHeaders(); f.releaseRead(); await pending;
    assert.equal(c.verified.length, 0); assert.equal(c.worker.length, 0); assert.equal(c.state.creative, null);
    assert.equal(c.writes.length, writes); if (phase === "module") assert.equal(f.calls.length, 0);
  });
}
test("actual importer passes bounded bytes through upload instead of trusting the source URL", async () => {
  const f = fixture(); const c = component(f); await c.start();
  assert.equal(c.verified.length, 1); assert.equal(c.state.creative.id, "canonical-verified-id");
  assert.notEqual(c.state.creative.publicUrl, f.input.url); assert.equal(c.state.uploadStatus, "ready");
});
for (const enabled of [false, true, null]) {
  test(`actual video importer with worker ${enabled === null ? "configuration missing" : enabled ? "enabled" : "disabled"} never takes image/public bypass`, async () => {
    const f = fixture("mp4", "video/mp4"), c = component(f, enabled); await c.start();
    assert.equal(c.verified.length, 0); assert.equal(c.worker.length, enabled ? 1 : 0);
    assert.equal(c.state.creative.publicUrl, undefined); assert.notEqual(c.state.uploadStatus, "ready");
    if (enabled === false) assert.equal(c.state.creative.status, "needs_optimization");
  });
}
test("worker disabled while the imported video body is pending cannot be bypassed", async () => {
  const f = fixture("mp4", "video/mp4"); f.holdRead(); const c = component(f, true), pending = c.start();
  await flush(); assert.equal(f.counters.reads, 1); c.disableWorker(); f.releaseRead(); await pending;
  assert.equal(c.worker.length, 0); assert.equal(c.verified.length, 0); assert.equal(c.state.creative.publicUrl, undefined);
  assert.equal(c.state.creative.status, "needs_optimization"); assert.notEqual(c.state.uploadStatus, "ready");
});

for (const [extension, mimeType] of [["jpg", "image/jpeg"], ["mp4", "video/mp4"]]) {
  test(`actual extensionless ${extension} importer hands the complete file to native validation before readiness`, async () => {
    const f = fixture(extension, mimeType); f.input.url = generatedUrl;
    const bytes = Uint8Array.from({ length: 64 * 1024 + 7 }, (_, i) => i % 251);
    f.headers.set("Content-Length", String(bytes.length));
    f.chunks([bytes.subarray(0, 1), new Uint8Array(), bytes.subarray(1, 65_537), bytes.subarray(65_537)]);
    const c = component(f, true); c.holdVerification();
    const pending = c.start(); await flush();
    const received = extension === "jpg" ? c.verified : c.worker;
    assert.equal(received.length, 1); assert.equal(received[0].size, bytes.length);
    assert.equal(received[0].name, f.input.fileName); assert.equal(received[0].type, mimeType);
    assert.deepEqual(new Uint8Array(await received[0].arrayBuffer()), bytes);
    assert.equal(c.state.creative.id, undefined); assert.equal(c.state.creative.publicUrl, undefined);
    assert.notEqual(c.state.uploadStatus, "ready");
    c.releaseVerification(); await pending;
    if (extension === "jpg") {
      assert.equal(c.worker.length, 0); assert.equal(c.state.creative.id, "canonical-verified-id");
      assert.notEqual(c.state.creative.publicUrl, f.input.url); assert.equal(c.state.uploadStatus, "ready");
    } else {
      assert.equal(c.verified.length, 0); assert.equal(c.state.creative.id, undefined);
      assert.equal(c.state.creative.publicUrl, undefined); assert.notEqual(c.state.uploadStatus, "ready");
    }
  });
}

test("matching own-URL image headers cannot overrule native validation of malformed media bytes", async () => {
  const f = fixture(); f.input.url = generatedUrl;
  const bytes = new TextEncoder().encode("<html>not an image</html>");
  f.headers.set("Content-Length", String(bytes.length)); f.chunks([bytes]);
  const c = component(f); c.failVerification(); await c.start();
  assert.equal(c.verified.length, 1); assert.deepEqual(new Uint8Array(await c.verified[0].arrayBuffer()), bytes);
  assert.equal(c.worker.length, 0); assert.equal(c.state.creative.id, undefined); assert.equal(c.state.creative.publicUrl, undefined);
  assert.equal(c.state.creative.status, "failed"); assert.equal(c.state.uploadStatus, "failed");
});

test("complete extensionless downloads remain subject to the real native full-image decoder", async () => {
  const { validateCreativeImageBytes } = await import(pathToFileURL(path.join(root, "lib/crm/creative-image.ts")).href) as {
    validateCreativeImageBytes(input: { buffer: Buffer; fileName: string; mimeType: string }): Promise<string[]>;
  };
  // Local 2x2 JPEG; the truncated scan retains readable metadata, not pixels.
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABAEBAQAAAAAAAAAAAAAAAAAABAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCMABEP/9k=", "base64");
  for (const bytes of [jpeg, jpeg.subarray(0, jpeg.length - 4), Buffer.from("<html>not an image</html>")]) {
    const f = fixture(); f.headers.set("Content-Length", String(bytes.length));
    f.chunks([bytes.subarray(0, 1), bytes.subarray(1)]);
    const file = await f.start({ url: generatedUrl });
    const buffer = Buffer.from(await file.arrayBuffer());
    assert.deepEqual(buffer, bytes);
    const details = await validateCreativeImageBytes({ buffer, fileName: file.name, mimeType: file.type });
    assert.equal(details.length === 0, bytes === jpeg, "only complete decodable pixels satisfy native validation");
    assert.equal((file as unknown as Bag).id, undefined); assert.equal((file as unknown as Bag).publicUrl, undefined);
  }
});

for (const enabled of [false, true, null]) {
  test(`actual extensionless video importer with worker ${enabled} cannot trust the source URL or generated key as readiness`, async () => {
    const f = fixture("mp4", "video/mp4"); f.input.url = `${base}optimized/${W}/${generatedKey}`;
    const c = component(f, enabled); await c.start();
    assert.equal(c.verified.length, 0); assert.equal(c.worker.length, enabled ? 1 : 0);
    assert.equal(c.state.creative.id, undefined); assert.equal(c.state.creative.publicUrl, undefined);
    assert.notEqual(c.state.uploadStatus, "ready");
    if (enabled === false) assert.equal(c.state.creative.status, "needs_optimization");
  });
}
