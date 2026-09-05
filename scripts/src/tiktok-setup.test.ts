import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type TikTokSetupFetch = (url: string, init: {
  method: "POST" | "GET"; headers: Record<string, string>; body?: string; signal: unknown; redirect: "error";
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
type SetupModule = {
  selectTikTokCity(data: unknown, city: string): { status: string; locationId?: string };
  createTikTokSetupVerifier(options: {
    env: Record<string, string>; fetchImpl: TikTokSetupFetch; now?: () => number; timeoutMs?: number;
  }): {
    verify(workspaceId: string, city: string): Promise<{
      city: { status: string; name: string; message: string };
      identity: { status: string; message: string };
      launchEnabled: false; source: string;
    }>;
    read(workspaceId: string, city: string): { locationIds: string[]; identityConfigured: boolean; identityType?: string };
  };
};
const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../lib/tiktok/setup.ts");
const imported = await import(pathToFileURL(modulePath).href);
const { createTikTokSetupVerifier, selectTikTokCity } = ((imported as { default?: unknown }).default ?? imported) as SetupModule;
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const env = {
  TIKTOK_ADVERTISER_ID: "7123456789012345678", TIKTOK_ACCESS_TOKEN: "token-must-not-leak",
  TIKTOK_IDENTITY_ID: "configured-identity", TIKTOK_IDENTITY_TYPE: "TT_USER",
};
const identity = {
  identity_id: env.TIKTOK_IDENTITY_ID, identity_type: "TT_USER", available_status: "AVAILABLE",
  can_push_video: true, is_gpppa: false, display_name: env.TIKTOK_ACCESS_TOKEN, profile_image: "https://private.test/profile",
};
const tag = (name = "Aktobe", id = "610611") => ({
  name, targeting_type: "GEO", status_info: { status: "ENABLED" },
  geo: { geo_type: "CITY", geo_id: id, region_code: "KZ" },
});
const response = (data: unknown, status = 200) => ({
  ok: status === 200, status, text: async () => JSON.stringify({ code: 0, data, request_id: "private-trace" }),
});
function makeFetch(calls: Array<{ url: URL; init: Parameters<TikTokSetupFetch>[1] }>): TikTokSetupFetch {
  return async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (url.includes("targeting/search")) return response({ targeting_tag_list: [tag()] });
    return response({ identity_list: [identity], page_info: { page: 1, total_page: 1 } });
  };
}

test("uses documented read-only requests and exposes no provider IDs, URLs or credentials", async () => {
  const calls: Array<{ url: URL; init: Parameters<TikTokSetupFetch>[1] }> = [];
  const verifier = createTikTokSetupVerifier({ env, fetchImpl: makeFetch(calls) });
  const result = await verifier.verify(WORKSPACE, "Актобе");
  assert.equal(result.city.status, "verified");
  assert.equal(result.city.name, "Актобе");
  assert.equal(result.identity.status, "verified");
  assert.equal(result.launchEnabled, false);
  assert.deepEqual(verifier.read(WORKSPACE, "aqtobe"), { locationIds: ["610611"], identityConfigured: true, identityType: "TT_USER" });
  const locationCall = calls.find((call) => call.url.pathname.includes("targeting/search"))!;
  assert.equal(locationCall.init.method, "POST");
  assert.deepEqual(JSON.parse(locationCall.init.body!), {
    advertiser_id: env.TIKTOK_ADVERTISER_ID, objective_type: "TRAFFIC", promotion_type: "WEBSITE",
    placements: ["PLACEMENT_TIKTOK"], search_type: "FUZZY_SEARCH", geo_types: ["CITY"],
    region_codes: ["KZ"], keywords: ["Aktobe"],
  });
  const identityCall = calls.find((call) => call.url.pathname.includes("identity/get"))!;
  assert.equal(identityCall.init.method, "GET");
  assert.equal(identityCall.url.searchParams.get("identity_type"), "TT_USER");
  for (const { url, init } of calls) {
    assert.equal(url.origin, "https://business-api.tiktok.com");
    assert.equal(init.headers["Access-Token"], env.TIKTOK_ACCESS_TOKEN);
    assert.equal(init.redirect, "error");
    assert.doesNotMatch(url.pathname, /create|update|upload/);
  }
  const serialized = JSON.stringify(result);
  for (const secret of [env.TIKTOK_ACCESS_TOKEN, env.TIKTOK_ADVERTISER_ID, env.TIKTOK_IDENTITY_ID, "610611", "private.test", "private-trace"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("city resolution rejects similar regions, wrong countries, disabled tags and ambiguous matches", () => {
  const valid = tag();
  const rejected = [tag("Temir, Aqtobe"), { ...valid, geo: { ...valid.geo, geo_type: "PROVINCE" } },
    { ...valid, geo: { ...valid.geo, region_code: "RU" } },
    { ...valid, status_info: { status: "DISABLED" } }];
  for (const candidate of rejected) assert.equal(selectTikTokCity({ targeting_tag_list: [candidate] }, "Актобе").status, "not_found");
  assert.equal(selectTikTokCity({ targeting_tag_list: [tag("Aktobe", "1"), tag("Актобе", "2")] }, "Aktobe").status, "ambiguous");
  assert.deepEqual(selectTikTokCity({ targeting_tag_list: [] }, "Алматы"), { status: "not_found" });
  assert.deepEqual(selectTikTokCity({ parent_tags: [valid] }, "Aktobe"), { status: "unavailable" });
});

test("verified evidence expires and is isolated by workspace, city, token and identity settings", async () => {
  let now = Date.parse("2026-09-05T10:00:00Z");
  const mutableEnv = { ...env };
  const calls: Array<{ url: URL; init: Parameters<TikTokSetupFetch>[1] }> = [];
  const verifier = createTikTokSetupVerifier({ env: mutableEnv, now: () => now, fetchImpl: makeFetch(calls) });
  await Promise.all([verifier.verify(WORKSPACE, "Aktobe"), verifier.verify(WORKSPACE, "Актобе")]);
  assert.equal(calls.length, 2, "duplicate checks share one request pair");
  assert.equal((await verifier.verify(WORKSPACE, "Актобе")).source, "cache");
  assert.equal(verifier.read(OTHER_WORKSPACE, "Aktobe").locationIds.length, 0);
  assert.equal(verifier.read(WORKSPACE, "Almaty").locationIds.length, 0);
  mutableEnv.TIKTOK_ACCESS_TOKEN = "rotated";
  assert.equal(verifier.read(WORKSPACE, "Aktobe").identityConfigured, false);
  mutableEnv.TIKTOK_ACCESS_TOKEN = env.TIKTOK_ACCESS_TOKEN;
  mutableEnv.TIKTOK_IDENTITY_ID = "different";
  assert.equal(verifier.read(WORKSPACE, "Aktobe").identityConfigured, false);
  mutableEnv.TIKTOK_IDENTITY_ID = env.TIKTOK_IDENTITY_ID;
  const copy = verifier.read(WORKSPACE, "Aktobe");
  copy.locationIds.push("forged");
  assert.deepEqual(verifier.read(WORKSPACE, "Aktobe").locationIds, ["610611"]);
  now += 300_001;
  assert.equal(verifier.read(WORKSPACE, "Aktobe").identityConfigured, false);
  await verifier.verify(WORKSPACE, "Aktobe");
  assert.equal(calls.length, 4);
});

test("identity verification paginates and refuses profiles lacking required permissions", async () => {
  const pages: string[] = [];
  const verifier = createTikTokSetupVerifier({ env, fetchImpl: async (url) => {
    if (url.includes("targeting/search")) return response({ targeting_tag_list: [] });
    const page = new URL(url).searchParams.get("page")!;
    pages.push(page);
    return response({ identity_list: page === "1" ? [{ ...identity, identity_id: "other" }] : [identity], page_info: { page: Number(page), total_page: 2 } });
  } });
  assert.equal((await verifier.verify(WORKSPACE, "Aktobe")).identity.status, "verified");
  assert.deepEqual(pages, ["1", "2"]);
  for (const patch of [{ available_status: "SCOPE_UNAVAILABLE" }, { can_push_video: false }, { is_gpppa: true }, { is_gpppa: undefined }]) {
    const blocked = createTikTokSetupVerifier({ env, fetchImpl: async (url) => response(url.includes("identity/get")
      ? { identity_list: [{ ...identity, ...patch }], page_info: { page: 1, total_page: 1 } } : { targeting_tag_list: [] }) });
    assert.equal((await blocked.verify(WORKSPACE, "Aktobe")).identity.status, "unavailable");
  }
});

test("BC identity must match configured business center and pagination is bounded", async () => {
  const bcEnv = { ...env, TIKTOK_IDENTITY_TYPE: "BC_AUTH_TT", TIKTOK_IDENTITY_AUTHORIZED_BC_ID: "12345678" };
  const verifier = createTikTokSetupVerifier({ env: bcEnv, fetchImpl: async (url) => {
    if (url.includes("targeting/search")) return response({ targeting_tag_list: [] });
    assert.equal(new URL(url).searchParams.get("identity_authorized_bc_id"), "12345678");
    return response({ identity_list: [{ ...identity, identity_type: "BC_AUTH_TT", identity_authorized_bc_id: "99999999" }], page_info: { page: 1, total_page: 1 } });
  } });
  assert.equal((await verifier.verify(WORKSPACE, "Aktobe")).identity.status, "unavailable");
  let identityCalls = 0;
  const limited = createTikTokSetupVerifier({ env, fetchImpl: async (url) => {
    if (url.includes("targeting/search")) return response({ targeting_tag_list: [] });
    identityCalls += 1;
    return response({ identity_list: [{ ...identity, identity_id: `other-${identityCalls}` }], page_info: { page: identityCalls, total_page: 10 } });
  } });
  assert.equal((await limited.verify(WORKSPACE, "Aktobe")).identity.status, "unavailable");
  assert.equal(identityCalls, 5);
});

test("missing config never calls TikTok and HTTP/provider errors remain safe", async () => {
  let calls = 0;
  const unconfigured = createTikTokSetupVerifier({ env: {}, fetchImpl: async () => { calls++; throw new Error("unexpected"); } });
  assert.equal((await unconfigured.verify(WORKSPACE, "Aktobe")).source, "configuration");
  assert.equal(calls, 0);
  for (const status of [401, 403, 429, 500, 200]) {
    const verifier = createTikTokSetupVerifier({ env, fetchImpl: async () => ({ ok: status === 200, status,
      text: async () => status === 200 ? "<html>secret</html>" : JSON.stringify({ code: 1, message: `secret ${env.TIKTOK_ACCESS_TOKEN}` }) }) });
    const result = await verifier.verify(WORKSPACE, "Aktobe");
    assert.equal(result.city.status, "unavailable");
    assert.equal(result.identity.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(result), /secret|token-must-not-leak/);
    assert.equal(verifier.read(WORKSPACE, "Aktobe").identityConfigured, false);
  }
});

test("timeout covers response body consumption as well as headers", async () => {
  const verifier = createTikTokSetupVerifier({ env, timeoutMs: 5, fetchImpl: async (_url, init) => ({
    ok: true, status: 200, text: () => new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("private timeout")), { once: true });
    }),
  }) });
  const result = await verifier.verify(WORKSPACE, "Aktobe");
  assert.match(result.city.message, /не ответил вовремя/);
  assert.equal(result.identity.status, "unavailable");
});
