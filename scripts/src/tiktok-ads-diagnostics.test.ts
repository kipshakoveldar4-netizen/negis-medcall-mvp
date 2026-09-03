import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "tiktok", "diagnostics.ts");
const imported = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);

type Diagnostic = {
  configured: boolean;
  connected: boolean;
  readOnly: true;
  launchEnabled: false;
  advertiserIdConfigured: boolean;
  hasAccessToken: boolean;
  hasAppId: boolean;
  hasAppSecret: boolean;
  oauthReady: boolean;
  checkedAt: string;
  advertiser?: {
    maskedId: string;
    name: string;
    currency: string;
    timezone: string;
    status: string;
    accountType: string;
  };
  errorCode?: string;
  message?: string;
  hint?: string;
};

type FetchCall = {
  input: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: unknown;
  };
};

type DiagnosticsModule = {
  TIKTOK_ADS_DIAGNOSTIC_ENDPOINT: string;
  TIKTOK_ADS_DIAGNOSTIC_FIELDS: readonly string[];
  validateTikTokAdsConnection(options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: (input: string, init?: FetchCall["init"]) => Promise<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
    }>;
    now?: () => Date;
  }): Promise<Diagnostic>;
};

const diagnostics = ((imported as { default?: unknown }).default ?? imported) as DiagnosticsModule;
const NOW = new Date("2026-09-03T10:00:00.000Z");
const ACCESS_TOKEN = "test-access-token-never-returned";
const ADVERTISER_ID = "7123456789012345678";
const env = {
  TIKTOK_ACCESS_TOKEN: ACCESS_TOKEN,
  TIKTOK_ADVERTISER_ID: ADVERTISER_ID,
  TIKTOK_APP_ID: "123456789",
  TIKTOK_APP_SECRET: "test-app-secret-never-returned",
};

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  };
}

test("uses TikTok advertiser info as a read-only v1.3 connection check", async () => {
  const calls: FetchCall[] = [];
  const result = await diagnostics.validateTikTokAdsConnection({
    env,
    now: () => NOW,
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      return response({
        code: 0,
        message: "OK",
        request_id: "must-not-leave-the-server",
        data: {
          list: [
            {
              advertiser_id: ADVERTISER_ID,
              name: "Negis Clinic Ads",
              currency: "usd",
              timezone: "Etc/GMT-5",
              display_timezone: "Asia/Almaty",
              status: "STATUS_ENABLE",
              advertiser_account_type: "AUCTION",
              email: "must-not-be-returned@example.test",
              balance: 100,
            },
          ],
        },
      });
    },
  });

  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].input);
  assert.equal(requestUrl.origin, "https://business-api.tiktok.com");
  assert.equal(requestUrl.pathname, diagnostics.TIKTOK_ADS_DIAGNOSTIC_ENDPOINT);
  assert.deepEqual(JSON.parse(requestUrl.searchParams.get("advertiser_ids") || "[]"), [ADVERTISER_ID]);
  assert.deepEqual(
    JSON.parse(requestUrl.searchParams.get("fields") || "[]"),
    diagnostics.TIKTOK_ADS_DIAGNOSTIC_FIELDS,
  );
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.headers?.["Access-Token"], ACCESS_TOKEN);

  assert.equal(result.connected, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.launchEnabled, false);
  assert.equal(result.checkedAt, NOW.toISOString());
  assert.deepEqual(result.advertiser, {
    maskedId: "********5678",
    name: "Negis Clinic Ads",
    currency: "USD",
    timezone: "Asia/Almaty",
    status: "STATUS_ENABLE",
    accountType: "AUCTION",
  });

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(ACCESS_TOKEN));
  assert.doesNotMatch(serialized, new RegExp(ADVERTISER_ID));
  assert.doesNotMatch(serialized, /app-secret|request_id|balance|email/i);
});

test("missing or malformed server config never calls TikTok", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response({ code: 0, data: { list: [] } });
  };

  const missing = await diagnostics.validateTikTokAdsConnection({
    env: {},
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(missing.errorCode, "not_configured");
  assert.equal(missing.configured, false);

  const malformed = await diagnostics.validateTikTokAdsConnection({
    env: { TIKTOK_ACCESS_TOKEN: ACCESS_TOKEN, TIKTOK_ADVERTISER_ID: "act_test" },
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(malformed.errorCode, "invalid_config");
  assert.equal(malformed.configured, false);
  assert.equal(calls, 0);
});

test("provider failures are reduced to allowlisted safe diagnostics", async () => {
  const unauthorized = await diagnostics.validateTikTokAdsConnection({
    env,
    now: () => NOW,
    fetchImpl: async () => response({ code: 40100, message: `Unauthorized ${ACCESS_TOKEN}`, data: {} }, 401),
  });
  assert.equal(unauthorized.errorCode, "unauthorized");
  assert.equal(unauthorized.connected, false);
  assert.doesNotMatch(JSON.stringify(unauthorized), new RegExp(ACCESS_TOKEN));

  const denied = await diagnostics.validateTikTokAdsConnection({
    env,
    now: () => NOW,
    fetchImpl: async () => response({ code: 40001, message: "No permission for advertiser", data: {} }, 403),
  });
  assert.equal(denied.errorCode, "permission_denied");

  const limited = await diagnostics.validateTikTokAdsConnection({
    env,
    now: () => NOW,
    fetchImpl: async () => response("", 429),
  });
  assert.equal(limited.errorCode, "rate_limited");
});

test("empty, invalid and mismatched responses fail without exposing raw bodies", async () => {
  const invalid = await diagnostics.validateTikTokAdsConnection({
    env,
    now: () => NOW,
    fetchImpl: async () => response("<html>provider failure with private details</html>"),
  });
  assert.equal(invalid.errorCode, "invalid_response");
  assert.doesNotMatch(JSON.stringify(invalid), /private details/);

  const missingAccount = await diagnostics.validateTikTokAdsConnection({
    env,
    now: () => NOW,
    fetchImpl: async () => response({
      code: 0,
      message: "OK",
      data: { list: [{ advertiser_id: "7999999999999999999", name: "Other account" }] },
    }),
  });
  assert.equal(missingAccount.errorCode, "advertiser_not_found");
  assert.equal(missingAccount.advertiser, undefined);
});
