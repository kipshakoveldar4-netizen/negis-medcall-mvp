import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Perf-1 — a page transition must not pay for the same answer twice.
//
// Measured on production before the change: the auth bootstrap fired
// /api/crm/auth-context three times inside a 15ms window (1.4s, 2.4s and 4.3s
// server-side each), the clients page issued /api/crm/clients three times, no
// list read survived a navigation, and a route's chunk request could not even
// start until auth resolved. The owner's words for the sum of that were
// «при переходе страницы подвисает».
//
// The fixes are browser-side, and the browser half of this repository is
// testable at the source level only (the modules import import.meta.env and
// react); these tests pin the properties the way workspace-selection and
// failure-honesty already pin theirs. Each assertion names the regression it
// exists to catch, and each was verified to fail against the pre-change file.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

async function readSource(...segments: string[]): Promise<string> {
  return readFile(path.join(negisSrc, ...segments), "utf8");
}

// ===========================================================================
// A. Concurrent identical GETs collapse into one request
// ===========================================================================

test("P1 crmFetch deduplicates in-flight GETs", async () => {
  const source = await readSource("lib", "api.ts");

  assert.ok(source.includes("inflightGets"), "the in-flight map must exist");
  assert.ok(
    source.includes("inflightGets.get(dedupeKey)") && source.includes("inflightGets.set(dedupeKey"),
    "a second identical GET must join the pending request instead of firing its own",
  );
  assert.ok(
    source.includes("response.clone()"),
    "followers must receive clones — a shared body can only be read once",
  );
});

test("P2 only GET is deduplicated — a write must never be swallowed by another write", async () => {
  const source = await readSource("lib", "api.ts");

  const guard = source.indexOf('if (method !== "GET")');
  const dedupe = source.indexOf("inflightGets.get(");
  assert.ok(guard > 0, "the method guard must exist");
  assert.ok(guard < dedupe, "and it must reject non-GET before any dedupe logic runs");
  // The non-GET branch goes straight to fetch.
  const branch = source.slice(guard, source.indexOf("}", guard));
  assert.ok(branch.includes("return fetch("), "non-GET requests must bypass the map entirely");
});

test("P3 the dedupe key carries the token so two sessions never share a response", async () => {
  const source = await readSource("lib", "api.ts");
  assert.ok(
    source.includes("`${path}::${token}`"),
    "a key of the path alone would hand one user's response to another",
  );
});

test("P4 the in-flight entry is removed when the request settles", async () => {
  const source = await readSource("lib", "api.ts");
  assert.ok(
    source.includes("inflightGets.delete(dedupeKey)"),
    "an entry that never leaves the map would turn dedupe into a forever-cache and break polling",
  );
});

// ===========================================================================
// B. A navigation paints the last confirmed read, then refreshes
// ===========================================================================

test("P5 the list cache is keyed by endpoint and workspace — tenant isolation by construction", async () => {
  const source = await readSource("lib", "demoStorage.ts");

  assert.ok(source.includes("listReadCache"), "the cache must exist");
  assert.ok(
    source.includes("`${endpoint}::${workspaceId}`"),
    "a key without the workspace would paint one clinic's rows on another clinic's page",
  );
});

test("P6 only a confirmed supabase answer is cached, and never into localStorage", async () => {
  const source = await readSource("lib", "demoStorage.ts");

  const write = source.indexOf("listReadCache.set(");
  assert.ok(write > 0, "the cache write must exist");
  const guarded = source.slice(source.lastIndexOf("if", write), write);
  assert.ok(
    guarded.includes("productionMode"),
    "demo mode owns its localStorage copy; caching it here would let stale demo rows shadow it",
  );
  // The write sits inside the success path, after the mode check the hook
  // already performs on the response.
  const successCheck = source.indexOf('body.mode !== "supabase"');
  assert.ok(successCheck > 0 && successCheck < write, "a refused or demo answer must never enter the cache");
  assert.ok(
    !source.includes("writeDemoStorage(key, rawItems)"),
    "raw supabase rows must not leak into the demo storage keys",
  );
});

test("P7 a cached paint still refreshes — the effect runs regardless of the cache", async () => {
  const source = await readSource("lib", "demoStorage.ts");

  // The refresh effect's early return remains exactly one: no endpoint. If a
  // cache hit ever short-circuits the load, a stale list would stay until TTL.
  const effect = source.slice(source.indexOf("const loadFromApi"), source.indexOf("void loadFromApi()"));
  assert.ok(!effect.includes("listReadCache.get"), "the load path must not consult the cache to decide whether to run");
});

test("P8 the cache expires and a write invalidates it", async () => {
  const source = await readSource("lib", "demoStorage.ts");

  assert.ok(source.includes("LIST_READ_TTL_MS"), "an unbounded cache would show hours-old records as current");
  assert.ok(
    source.includes("listReadCache.delete(listCacheKey(endpoint, workspaceId))"),
    "a local write makes the cached read stale; the next mount must fetch, not resurrect the pre-write list",
  );
});

test("P9 the honesty contract survives the cache: a refused read still reports", async () => {
  const source = await readSource("lib", "demoStorage.ts");

  // F9's pins, re-asserted from this suite's angle: the cache must not have
  // moved reportLoadFailure out of the refresh path.
  assert.ok(source.includes("reportLoadFailure();"), "the failure report must still exist");
  assert.ok(source.includes('id: "crm-load-failed"'), "and still deduplicate through the shared toast id");
});

// ===========================================================================
// C. Route chunks are warmed after auth instead of inside the transition
// ===========================================================================

test("P10 operational route chunks are prefetched once the user is authenticated", async () => {
  const source = await readSource("App.tsx");

  assert.ok(source.includes("RoutePrefetcher"), "the prefetcher must exist");
  assert.ok(source.includes("<RoutePrefetcher />"), "and be mounted");
  const prefetcher = source.slice(source.indexOf("function RoutePrefetcher"), source.indexOf("function RouteFallback"));
  assert.ok(
    prefetcher.includes("isLoading || !userRole"),
    "prefetching before auth resolves would fetch nine chunks for a visitor who only sees the landing",
  );
  for (const page of ["LeadsPage", "ClientsPage", "AdsAutomation"]) {
    assert.ok(
      source.includes(`import("@/pages/${page}")`),
      `${page} must be in the warm set — it is one of the routes the owner actually navigates between`,
    );
  }
});
