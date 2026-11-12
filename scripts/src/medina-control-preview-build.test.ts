import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type Env = Record<string, unknown>;
type PreviewTarget = { apiOrigin: string; supabaseUrl: string };
type TargetModule = { resolveControlPreviewTarget(env: Env): PreviewTarget | null };
const { resolveControlPreviewTarget } = await import(
  pathToFileURL(path.join(root, "artifacts/medina-control/preview-target.mjs")).href
) as TargetModule;

const BRANCH = "codex/site-blog-release-20260929";
const HOST = "negis-medcall-mvp-api-server-abc123def-yeldar-s-projects.vercel.app";
const DATABASE = "https://ukiobbwsdoblooynzlnx.supabase.co";
const ERROR_MESSAGE = "Invalid Medina Control preview target.";
const SECRET = "synthetic-secret-marker";

function previewEnv(overrides: Env = {}): Env {
  return {
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: BRANCH,
    VERCEL_URL: HOST,
    VITE_SUPABASE_URL: DATABASE,
    ...overrides,
  };
}

function guardedEnv(env: Env, allowed: string[]): Env {
  return new Proxy(env, {
    get(target, key) {
      assert.ok(typeof key === "string" && allowed.includes(key),
        "Resolver must not consult any other environment keys");
      return Reflect.get(target, key);
    },
    ownKeys() {
      assert.fail("Resolver must not enumerate environment keys");
    },
  });
}

function blocked(env: Env): void {
  assert.throws(() => resolveControlPreviewTarget(env), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.constructor, Error);
    assert.equal(error.message, ERROR_MESSAGE);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.deepEqual(Object.keys(error), []);
    assert.ok(!String(error).includes(SECRET));
    assert.ok(!error.stack?.includes(SECRET));
    return true;
  });
}

test("Production, local and nonselected branches skip even malicious target values", async (t) => {
  const selectors: Array<[string, Env]> = [
    ["production on selected branch", { VERCEL_ENV: "production" }],
    ["local development", { VERCEL_ENV: "development" }],
    ["local without Vercel metadata", { VERCEL_ENV: undefined, VERCEL_GIT_COMMIT_REF: undefined }],
    ["missing deployment environment", { VERCEL_ENV: undefined }],
    ["empty deployment environment", { VERCEL_ENV: "" }],
    ["case-mismatched environment", { VERCEL_ENV: "Preview" }],
    ["padded environment is not the literal selector", { VERCEL_ENV: " preview " }],
    ["main preview", { VERCEL_GIT_COMMIT_REF: "main" }],
    ["other branch preview", { VERCEL_GIT_COMMIT_REF: "codex/other-fixture" }],
    ["missing preview branch", { VERCEL_GIT_COMMIT_REF: undefined }],
    ["empty preview branch", { VERCEL_GIT_COMMIT_REF: "" }],
    ["branch suffix", { VERCEL_GIT_COMMIT_REF: `${BRANCH}-extra` }],
    ["case-mismatched branch", { VERCEL_GIT_COMMIT_REF: BRANCH.toUpperCase() }],
    ["padded branch is not the literal selector", { VERCEL_GIT_COMMIT_REF: ` ${BRANCH} ` }],
  ];
  for (const [label, selector] of selectors) {
    await t.test(label, () => {
      const env = Object.freeze(previewEnv({
        VERCEL_URL: `https://${SECRET}:password@foreign.example.test/api?${SECRET}#fragment`,
        VITE_SUPABASE_URL: `https://foreign.example.test/${SECRET}`,
        ...selector,
      }));
      const snapshot = { ...env };
      assert.equal(resolveControlPreviewTarget(guardedEnv(env,
        ["VERCEL_ENV", "VERCEL_GIT_COMMIT_REF"])), null);
      assert.deepEqual(env, snapshot);
    });
  }
  assert.equal(resolveControlPreviewTarget({}), null);
});

test("Exact selected preview returns only its immutable API origin and dedicated database", () => {
  for (const id of ["abc123def", "123456789", "abcdefghi", "z9a8b7c6d"]) {
    const hostname = HOST.replace("abc123def", id);
    assert.deepEqual(resolveControlPreviewTarget(previewEnv({ VERCEL_URL: hostname })), {
      apiOrigin: `https://${hostname}`,
      supabaseUrl: DATABASE,
    });
  }
});

test("Target inputs trim surrounding whitespace without changing the environment", () => {
  const env = Object.freeze(previewEnv({
    VERCEL_URL: ` \t${HOST}\r\n `,
    VITE_SUPABASE_URL: `\n ${DATABASE}\t `,
    UNRELATED_FIXTURE: SECRET,
  }));
  const snapshot = { ...env };
  assert.deepEqual(resolveControlPreviewTarget(env), {
    apiOrigin: `https://${HOST}`,
    supabaseUrl: DATABASE,
  });
  assert.deepEqual(env, snapshot);
});

test("Selected previews reject missing, blank and non-string targets without coercion", async (t) => {
  const poison = { toString() { throw new Error(SECRET); } };
  const invalid: Array<[string, unknown]> = [
    ["missing", undefined], ["empty", ""], ["whitespace", " \t\r\n "],
    ["null", null], ["boolean", true], ["number", 123],
    ["array", [HOST]], ["boxed string", new String(HOST)], ["coercion trap", poison],
  ];
  for (const field of ["VERCEL_URL", "VITE_SUPABASE_URL"]) {
    for (const [label, value] of invalid) {
      await t.test(`${field}: ${label}`, () => {
        const env = Object.freeze(previewEnv({ [field]: value }));
        const snapshot = { ...env };
        blocked(env);
        assert.deepEqual(env, snapshot);
      });
    }
  }
});

test("VERCEL_URL must be the literal existing-project immutable hostname", async (t) => {
  const invalid: Array<[string, string]> = [
    ["production alias", "negis-medcall-mvp-api-server.vercel.app"],
    ["project production alias", "negis-medcall-mvp-api-server-yeldar-s-projects.vercel.app"],
    ["main alias", "negis-medcall-mvp-api-server-git-main-yeldar-s-projects.vercel.app"],
    ["branch alias", "negis-medcall-mvp-api-server-git-fixture-yeldar-s-projects.vercel.app"],
    ["foreign project", HOST.replace("negis-medcall-mvp-api-server", "foreign-api")],
    ["foreign owner", HOST.replace("yeldar-s-projects", "foreign-projects")],
    ["eight-character id", HOST.replace("abc123def", "abc123de")],
    ["ten-character id", HOST.replace("abc123def", "abc123def0")],
    ["hyphenated id", HOST.replace("abc123def", "abc-23def")],
    ["uppercase id", HOST.replace("abc123def", "ABC123DEF")],
    ["non-ASCII id", HOST.replace("abc123def", "abc123de\u00e9")],
    ["uppercase hostname", HOST.toUpperCase()],
    ["foreign suffix", `${HOST}.foreign.example.test`],
    ["wrong suffix", HOST.replace("vercel.app", "vercel.example.test")],
    ["wildcard-like dots", HOST.replace(".vercel.app", "xvercelxapp")],
    ["trailing dot", `${HOST}.`],
    ["HTTPS scheme", `https://${HOST}`],
    ["HTTP scheme", `http://${HOST}`],
    ["FTP scheme", `ftp://${HOST}`],
    ["scheme-relative URL", `//${HOST}`],
    ["trailing slash", `${HOST}/`],
    ["API path", `${HOST}/api/crm`],
    ["default HTTPS port", `${HOST}:443`],
    ["custom port", `${HOST}:8443`],
    ["username", `fixture@${HOST}`],
    ["credentials", `${SECRET}:password@${HOST}`],
    ["empty credentials", `@${HOST}`],
    ["query", `${HOST}?token=${SECRET}`],
    ["empty query", `${HOST}?`],
    ["fragment", `${HOST}#${SECRET}`],
    ["empty fragment", `${HOST}#`],
    ["backslash", `${HOST}\\`],
    ["internal newline", HOST.replace(".vercel", "\n.vercel")],
    ["encoded host character", HOST.replace("abc123def", "%61bc123def")],
  ];
  for (const [label, value] of invalid) {
    await t.test(label, () => blocked(previewEnv({ VERCEL_URL: value })));
  }
});

test("VITE_SUPABASE_URL must be the exact dedicated origin with no trailing slash", async (t) => {
  const invalid: Array<[string, string]> = [
    ["foreign database", "https://foreign-fixture.supabase.co"],
    ["ordinary database", "https://ordinary-fixture.supabase.co"],
    ["local database", "http://127.0.0.1:54321"],
    ["HTTP", DATABASE.replace("https:", "http:")],
    ["FTP", DATABASE.replace("https:", "ftp:")],
    ["missing scheme", DATABASE.slice("https://".length)],
    ["scheme-relative URL", DATABASE.replace("https:", "")],
    ["incomplete scheme", DATABASE.replace("https://", "https:")],
    ["uppercase URL", DATABASE.toUpperCase()],
    ["trailing slash", `${DATABASE}/`],
    ["padded trailing slash", ` ${DATABASE}/ `],
    ["path", `${DATABASE}/auth/v1`],
    ["default HTTPS port", `${DATABASE}:443`],
    ["custom port", `${DATABASE}:8443`],
    ["username", DATABASE.replace("https://", "https://fixture@")],
    ["credentials", DATABASE.replace("https://", `https://${SECRET}:password@`)],
    ["empty credentials", DATABASE.replace("https://", "https://@")],
    ["query", `${DATABASE}?token=${SECRET}`],
    ["empty query", `${DATABASE}?`],
    ["fragment", `${DATABASE}#${SECRET}`],
    ["empty fragment", `${DATABASE}#`],
    ["foreign suffix", `${DATABASE}.foreign.example.test`],
    ["trailing dot", `${DATABASE}.`],
    ["backslash", `${DATABASE}\\`],
    ["internal newline", DATABASE.replace(".supabase", "\n.supabase")],
    ["encoded host character", DATABASE.replace("ukiobbws", "%75kiobbws")],
  ];
  for (const [label, value] of invalid) {
    await t.test(label, () => blocked(previewEnv({ VITE_SUPABASE_URL: value })));
  }
});

test("Only the four explicit keys are read; fallbacks and public API overrides are ignored", () => {
  const env = Object.freeze(previewEnv({
    VERCEL_PROJECT_PRODUCTION_URL: HOST,
    SUPABASE_URL: DATABASE,
    MEDINA_APP_ORIGIN: `https://${HOST}`,
    VITE_MEDINA_API_URL: `https://${SECRET}.example.test`,
    VITE_API_URL: `https://${SECRET}.example.test`,
    VITE_API_BASE_URL: `https://${SECRET}.example.test`,
    VITE_MEDINA_CONTROL_MODE: SECRET,
    UNRELATED_FIXTURE: SECRET,
  }));
  const snapshot = { ...env };
  const allowed = ["VERCEL_ENV", "VERCEL_GIT_COMMIT_REF", "VERCEL_URL", "VITE_SUPABASE_URL"];
  assert.deepEqual(resolveControlPreviewTarget(guardedEnv(env, allowed)), {
    apiOrigin: `https://${HOST}`,
    supabaseUrl: DATABASE,
  });
  assert.deepEqual(env, snapshot);
  for (const field of ["VERCEL_URL", "VITE_SUPABASE_URL"]) {
    for (const value of [undefined, "", SECRET]) {
      const missing = Object.freeze({ ...env, [field]: value });
      const missingSnapshot = { ...missing };
      blocked(guardedEnv(missing, allowed));
      assert.deepEqual(missing, missingSnapshot);
    }
  }
});

test("All selected-target errors stay generic and never expose synthetic secret markers", () => {
  for (const overrides of [
    { VERCEL_URL: SECRET },
    { VITE_SUPABASE_URL: SECRET },
    { VERCEL_URL: SECRET, VITE_SUPABASE_URL: SECRET },
    { VERCEL_URL: `https://${SECRET}:password@${HOST}/?${SECRET}#${SECRET}` },
    { VITE_SUPABASE_URL: `${DATABASE}/${SECRET}?${SECRET}#${SECRET}` },
  ]) {
    blocked(previewEnv(overrides));
  }
});
