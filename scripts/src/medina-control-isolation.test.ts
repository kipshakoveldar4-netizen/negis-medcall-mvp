import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const controlSrc = path.join(root, "artifacts/medina-control/src");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");

type Env = Record<string, string | undefined>;
type ControlConfig =
  | { ready: false; error: string }
  | { ready: true; apiOrigin: string; supabaseUrl: string; anonKey: string };
type ConfigModule = { resolveControlConfig(env: Env, development?: boolean): ControlConfig };

// Import only the pure helper; browser modules below run with explicit VM mocks.
const { resolveControlConfig } = await import(
  pathToFileURL(path.join(controlSrc, "lib/control-config.ts")).href
) as ConfigModule;

const TEST_API = "https://negis-medcall-mvp-api-server-abc123def-yeldar-s-projects.vercel.app";
const TEST_DB = "https://ukiobbwsdoblooynzlnx.supabase.co";
const PROD_API = "https://negis-medcall-mvp-api-server.vercel.app";
const ORDINARY_DB = "https://ordinary-fixture.supabase.co";
const PUBLIC_KEY = "sb_publishable_local_fixture";
const ROUTE = "/api/crm/platform-overview";

function isolatedEnv(overrides: Env = {}): Env {
  return {
    VITE_MEDINA_CONTROL_MODE: "isolated-preview",
    VITE_MEDINA_API_URL: TEST_API,
    VITE_SUPABASE_URL: TEST_DB,
    VITE_SUPABASE_ANON_KEY: PUBLIC_KEY,
    ...overrides,
  };
}

function ordinaryEnv(overrides: Env = {}): Env {
  return isolatedEnv({
    VITE_MEDINA_CONTROL_MODE: undefined,
    VITE_MEDINA_API_URL: PROD_API,
    VITE_SUPABASE_URL: ORDINARY_DB,
    ...overrides,
  });
}

function blocked(env: Env, development = false): Extract<ControlConfig, { ready: false }> {
  const config = resolveControlConfig(env, development);
  assert.ok(!config.ready, "Invalid configuration must fail closed");
  assert.equal(typeof config.error, "string");
  assert.ok(config.error.trim(), "Blocked configuration must explain the failure");
  assert.deepEqual(Object.keys(config).sort(), ["error", "ready"]);
  return config;
}

function jwt(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload) ?? "null").toString("base64url"),
    Buffer.from("synthetic-signature").toString("base64url"),
  ].join(".");
}

test("Exact isolated preview config is ready with explicit public credentials", () => {
  assert.deepEqual(resolveControlConfig(isolatedEnv()), {
    ready: true, apiOrigin: TEST_API, supabaseUrl: TEST_DB, anonKey: PUBLIC_KEY,
  });
  assert.equal(resolveControlConfig(isolatedEnv({
    VITE_MEDINA_API_URL: TEST_API.replace("abc123def", "987654321"),
  })).ready, true);
});

test("Environment values trim and one trailing origin slash is accepted", () => {
  assert.deepEqual(resolveControlConfig(isolatedEnv({
    VITE_MEDINA_CONTROL_MODE: "  isolated-preview \t",
    VITE_MEDINA_API_URL: `  ${TEST_API}/ \n`,
    VITE_SUPABASE_URL: `\t${TEST_DB}/  `,
    VITE_SUPABASE_ANON_KEY: `  ${PUBLIC_KEY} \n`,
  })), { ready: true, apiOrigin: TEST_API, supabaseUrl: TEST_DB, anonKey: PUBLIC_KEY });
});

test("Absent, empty and whitespace mode preserve explicit ordinary production config", () => {
  for (const mode of [undefined, "", " \t\n "]) {
    assert.deepEqual(resolveControlConfig(ordinaryEnv({ VITE_MEDINA_CONTROL_MODE: mode })), {
      ready: true, apiOrigin: PROD_API, supabaseUrl: ORDINARY_DB, anonKey: PUBLIC_KEY,
    });
  }
});

test("No API, Auth or public key defaults exist in either mode, including DEV", async (t) => {
  blocked({});
  for (const field of ["VITE_MEDINA_API_URL", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    for (const [label, value] of [["missing", undefined], ["empty", ""], ["whitespace", " \t\n"]] as const) {
      await t.test(`${field}: ${label}`, () => {
        for (const development of [false, true]) {
          blocked(isolatedEnv({ [field]: value }), development);
          blocked(ordinaryEnv({ [field]: value }), development);
        }
      });
    }
  }
});

test("Unknown and misspelled modes cannot silently select ordinary mode", () => {
  for (const mode of ["production", "ordinary", "preview", "isolated", "ISOLATED-PREVIEW", "isolated-preview-extra"]) {
    blocked(ordinaryEnv({ VITE_MEDINA_CONTROL_MODE: mode }));
  }
});

test("DEV cannot reuse ordinary remote configuration from a local env file", () => {
  blocked(ordinaryEnv(), true);
  blocked(ordinaryEnv({ VITE_MEDINA_API_URL: TEST_API, VITE_SUPABASE_URL: TEST_DB }), true);
  assert.equal(resolveControlConfig(isolatedEnv(), true).ready, true);
});

for (const field of ["VITE_MEDINA_API_URL", "VITE_SUPABASE_URL"]) {
  test(`${field} accepts only full origins without credentials, path, query or hash`, async (t) => {
    const invalid: Array<[string, string]> = [
      ["relative path", "/api"],
      ["scheme-relative URL", "//fixture.example.test"],
      ["missing scheme", "fixture.example.test"],
      ["incomplete HTTPS scheme", "https:fixture.example.test"],
      ["incomplete HTTPS slashes", "https:/fixture.example.test"],
      ["invalid URL", "https://"],
      ["FTP", "ftp://fixture.example.test"],
      ["remote HTTP", "http://fixture.example.test"],
      ["user and password", "https://fixture:password@fixture.example.test"],
      ["username only", "https://fixture@fixture.example.test"],
      ["password only", "https://:password@fixture.example.test"],
      ["empty userinfo", "https://@fixture.example.test"],
      ["path", "https://fixture.example.test/api"],
      ["path with trailing slash", "https://fixture.example.test/api/"],
      ["extra trailing slash", "https://fixture.example.test//"],
      ["query", "https://fixture.example.test/?fixture=1"],
      ["empty query", "https://fixture.example.test/?"],
      ["fragment", "https://fixture.example.test/#fixture"],
      ["empty fragment", "https://fixture.example.test/#"],
    ];
    for (const [label, url] of invalid) {
      await t.test(label, () => {
        blocked(ordinaryEnv({ [field]: url }));
        blocked(ordinaryEnv({ [field]: url }), true);
      });
    }
  });
}

test("Isolated mode rejects production, main, branch and foreign API previews", async (t) => {
  const invalid: Array<[string, string]> = [
    ["production alias", PROD_API],
    ["main alias", "https://negis-medcall-mvp-api-server-git-main-yeldar-s-projects.vercel.app"],
    ["branch alias", "https://negis-medcall-mvp-api-server-git-isolation-yeldar-s-projects.vercel.app"],
    ["foreign project preview", TEST_API.replace("negis-medcall-mvp-api-server", "foreign-api")],
    ["foreign owner preview", TEST_API.replace("yeldar-s-projects", "foreign-projects")],
    ["eight-character preview id", TEST_API.replace("abc123def", "abc123de")],
    ["ten-character preview id", TEST_API.replace("abc123def", "abc123def0")],
    ["hyphenated preview id", TEST_API.replace("abc123def", "abc-23def")],
    ["foreign suffix", `${TEST_API}.foreign.example.test`],
  ];
  for (const [label, url] of invalid) {
    await t.test(label, () => { blocked(isolatedEnv({ VITE_MEDINA_API_URL: url })); });
  }
});

test("Isolated mode accepts only the exact dedicated HTTPS Supabase origin", async (t) => {
  for (const url of [
    ORDINARY_DB, "https://foreign-fixture.supabase.co", "http://ukiobbwsdoblooynzlnx.supabase.co",
    `${TEST_DB}:8443`, `${TEST_DB}.foreign.example.test`, "http://127.0.0.1:54321",
  ]) {
    await t.test(url, () => { blocked(isolatedEnv({ VITE_SUPABASE_URL: url }), true); });
  }
});

test("Public keys accept a nonempty publishable suffix or synthetic three-part anon JWT", () => {
  for (const key of ["sb_publishable_x", PUBLIC_KEY, jwt({ role: "anon", fixture: true })]) {
    assert.deepEqual(resolveControlConfig(isolatedEnv({ VITE_SUPABASE_ANON_KEY: ` ${key} ` })), {
      ready: true, apiOrigin: TEST_API, supabaseUrl: TEST_DB, anonKey: key,
    });
  }
});

test("Private, malformed and non-anon keys fail closed", async (t) => {
  const anon = jwt({ role: "anon" });
  const invalid: Array<[string, string]> = [
    ["empty publishable suffix", "sb_publishable_"],
    ["private key", "sb_secret_synthetic_fixture"],
    ["unrecognized key", "fixture-key"],
    ["service role JWT", jwt({ role: "service_role" })],
    ["authenticated JWT", jwt({ role: "authenticated" })],
    ["missing role", jwt({ fixture: true })],
    ["wrong role type", jwt({ role: ["anon"] })],
    ["null payload", jwt(null)],
    ["string payload", jwt("anon")],
    ["malformed JSON payload", "e30.bm90LWpzb24.c2ln"],
    ["malformed base64 payload", "e30.***.c2ln"],
    ["two parts", anon.split(".").slice(0, 2).join(".")],
    ["four parts", `${anon}.extra`],
    ["empty signature", `${anon.slice(0, anon.lastIndexOf("."))}.`],
  ];
  for (const [label, key] of invalid) {
    await t.test(label, () => { blocked(isolatedEnv({ VITE_SUPABASE_ANON_KEY: key })); });
  }
});

test("Only DEV ordinary mode permits HTTP on localhost, 127.0.0.1 and [::1]", async (t) => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    await t.test(host, () => {
      const apiOrigin = `http://${host}:5174`;
      const supabaseUrl = `http://${host}:54321`;
      const env = ordinaryEnv({ VITE_MEDINA_API_URL: apiOrigin, VITE_SUPABASE_URL: supabaseUrl });
      blocked(env);
      blocked({ ...env, VITE_SUPABASE_URL: ORDINARY_DB });
      blocked({ ...env, VITE_MEDINA_API_URL: PROD_API });
      assert.deepEqual(resolveControlConfig(env, true), {
        ready: true, apiOrigin, supabaseUrl, anonKey: PUBLIC_KEY,
      });
      blocked(isolatedEnv({ VITE_MEDINA_API_URL: apiOrigin }), true);
    });
  }
  for (const host of ["localhost.foreign.example.test", "192.168.1.2", "0.0.0.0", "[::2]"]) {
    for (const field of ["VITE_MEDINA_API_URL", "VITE_SUPABASE_URL"]) {
      blocked(ordinaryEnv({ [field]: `http://${host}:5174` }), true);
    }
  }
});

async function compileBrowser(file: string): Promise<string> {
  return ts.transpileModule(await readFile(path.join(controlSrc, file), "utf8"), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env"
          && ts.isMetaProperty(node.expression)
          && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
          return ts.factory.createIdentifier("__fixtureEnv");
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  }).outputText;
}

const apiCode = await compileBrowser("lib/api.ts");
const supabaseCode = await compileBrowser("lib/supabase.ts");
const appCode = await compileBrowser("App.tsx");

function evaluate<T>(code: string, filename: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const exports = {} as T;
  new Script(code, { filename }).runInNewContext({
    exports, Error, Headers, Response, URL, ...globals,
    require(name: string) {
      assert.ok(Object.hasOwn(imports, name), `Unmocked import is forbidden: ${name}`);
      return imports[name];
    },
  }, { timeout: 1_000 });
  return exports;
}

type Api = { API_BASE_URL: string; controlFetch(path: string, init?: RequestInit): Promise<Response> };
function apiFixture(controlConfig: ControlConfig) {
  const state = { sessionCalls: 0 };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const response = new Response(JSON.stringify({ fixture: true }));
  const api = evaluate<Api>(apiCode, "control-api.fixture.cjs", {
    "./supabase": { controlConfig, supabase: { auth: { async getSession() {
      state.sessionCalls++;
      return { data: { session: { access_token: "synthetic-session-bearer" } } };
    } } } },
  }, {
    __fixtureEnv: {},
    fetch(url: string, init: RequestInit) {
      calls.push({ url, init });
      return Promise.resolve(response);
    },
  });
  return { api, state, calls, response };
}

test("Unready API config blocks both session lookup and fetch, even with a stored token", async (t) => {
  for (const [label, env] of [
    ["missing config", {}],
    ["missing API", isolatedEnv({ VITE_MEDINA_API_URL: undefined })],
    ["wrong database", isolatedEnv({ VITE_SUPABASE_URL: ORDINARY_DB })],
    ["production API in isolated mode", isolatedEnv({ VITE_MEDINA_API_URL: PROD_API })],
    ["private key", isolatedEnv({ VITE_SUPABASE_ANON_KEY: jwt({ role: "service_role" }) })],
  ] as Array<[string, Env]>) {
    await t.test(label, async () => {
      const config = blocked(env);
      const f = apiFixture(config);
      assert.equal(f.api.API_BASE_URL, "");
      await assert.rejects(() => f.api.controlFetch(ROUTE, { redirect: "follow" }), { message: config.error });
      assert.equal(f.state.sessionCalls, 0);
      assert.equal(f.calls.length, 0);
    });
  }
});

test("Ready API uses the exact configured origin and bearer, forcing redirect:error", async (t) => {
  for (const env of [isolatedEnv(), ordinaryEnv()]) {
    const config = resolveControlConfig(env);
    assert.ok(config.ready);
    for (const redirect of [undefined, "follow", "manual", "error"] as const) {
      await t.test(`${config.apiOrigin}, redirect=${redirect ?? "default"}`, async () => {
        const f = apiFixture(config);
        const response = await f.api.controlFetch(ROUTE, {
          ...(redirect ? { redirect } : {}),
          headers: { Authorization: "Bearer caller-fixture", "X-Fixture": "preserved" },
        });
        assert.equal(response, f.response);
        assert.equal(f.api.API_BASE_URL, config.apiOrigin);
        assert.equal(f.state.sessionCalls, 1);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].url, `${config.apiOrigin}${ROUTE}`);
        assert.equal(f.calls[0].init.redirect, "error");
        const headers = new Headers(f.calls[0].init.headers);
        assert.equal(headers.get("Authorization"), "Bearer synthetic-session-bearer");
        assert.equal(headers.get("X-Fixture"), "preserved");
        assert.ok(!f.calls[0].url.includes("synthetic-session-bearer"));
      });
    }
  }
});

type SdkOptions = {
  auth: { persistSession: boolean; autoRefreshToken: boolean; detectSessionInUrl: boolean };
  global?: { fetch?: typeof fetch };
};
function supabaseFixture(env: Env, development = false) {
  const calls: Array<{ url: string; key: string; options: SdkOptions }> = [];
  const state = { networkCalls: 0 };
  const client = { fixture: true };
  const exports = evaluate<{ controlConfig: ControlConfig; supabase: typeof client }>(
    supabaseCode, "control-supabase.fixture.cjs", {
      "./control-config": { resolveControlConfig },
      "@supabase/supabase-js": { createClient(url: string, key: string, options: SdkOptions) {
        calls.push({ url, key, options });
        return client;
      } },
    }, {
      __fixtureEnv: { ...env, DEV: development },
      fetch() {
        state.networkCalls++;
        return Promise.resolve(new Response("synthetic-network-response"));
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(exports.supabase, client);
  return { ...exports, state, creation: calls[0] };
}

test("Unready actual Supabase wrapper disables SDK session features and blocks SDK fetch", async () => {
  for (const env of [{}, isolatedEnv({ VITE_SUPABASE_URL: ORDINARY_DB })]) {
    const f = supabaseFixture(env);
    assert.ok(!f.controlConfig.ready);
    assert.deepEqual({ ...f.creation.options.auth }, {
      persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
    });
    assert.notEqual(f.creation.url, TEST_DB);
    assert.notEqual(f.creation.key, PUBLIC_KEY);
    const sdkFetch = f.creation.options.global?.fetch;
    assert.equal(typeof sdkFetch, "function");
    await assert.rejects(() => sdkFetch!(`${TEST_DB}/auth/v1/token`), { message: f.controlConfig.error });
    assert.equal(f.state.networkCalls, 0);
  }
});

test("Ready actual Supabase wrapper preserves explicit credentials and session features", () => {
  for (const [env, development] of [
    [isolatedEnv(), false],
    [ordinaryEnv(), false],
    [ordinaryEnv({ VITE_MEDINA_API_URL: "http://localhost:5174", VITE_SUPABASE_URL: "http://127.0.0.1:54321" }), true],
  ] as Array<[Env, boolean]>) {
    const f = supabaseFixture(env, development);
    assert.ok(f.controlConfig.ready);
    assert.equal(f.creation.url, f.controlConfig.supabaseUrl);
    assert.equal(f.creation.key, PUBLIC_KEY);
    assert.deepEqual({ ...f.creation.options.auth }, {
      persistSession: true, autoRefreshToken: true, detectSessionInUrl: true,
    });
    assert.equal(f.creation.options.global?.fetch, undefined);
    assert.equal(f.state.networkCalls, 0);
  }
});

type UiNode = { type: unknown; props: Record<string, any> };
type FixtureSession = { user: { email: string }; access_token: string };
const storedSession: FixtureSession = { user: { email: "owner@example.test" }, access_token: "synthetic-stored-session" };
function jsx(type: unknown, props: UiNode["props"]): UiNode { return { type, props }; }
function nodes(value: any): UiNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  return [value, ...nodes(value.props.children)];
}

function appFixture(controlConfig: ControlConfig, session: FixtureSession | null, restoredState = false) {
  const Login = () => null;
  const Overview = () => null;
  const state = { sessionCalls: 0, subscriptionCalls: 0, unsubscribeCalls: 0 };
  const slots: unknown[] = restoredState ? [session, true] : [];
  const effects: Array<() => void | (() => void)> = [];
  const cleanups: Array<() => void> = [];
  let cursor = 0;
  let effectRegistered = false;
  let listener: ((event: string, next: FixtureSession | null) => void) | undefined;
  const { default: App } = evaluate<{ default(): UiNode }>(appCode, "control-app.fixture.cjs", {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (next: unknown) => { slots[index] = next; }];
      },
      useEffect(effect: () => void | (() => void)) {
        if (!effectRegistered) { effects.push(effect); effectRegistered = true; }
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "./lib/supabase": { controlConfig, supabase: { auth: {
      async getSession() { state.sessionCalls++; return { data: { session } }; },
      onAuthStateChange(callback: typeof listener) {
        state.subscriptionCalls++;
        listener = callback;
        return { data: { subscription: { unsubscribe() { state.unsubscribeCalls++; } } } };
      },
    } } },
    "./screens/Login": { Login },
    "./screens/Overview": { Overview },
    "./screens/ClinicCard": { ClinicCard: () => null },
    "./screens/Onboarding": { Onboarding: () => null },
    "./screens/Operators": { Operators: () => null },
  });
  function render() { cursor = 0; return App(); }
  return {
    state, Login, Overview, render,
    async mount() {
      for (const effect of effects.splice(0)) {
        const cleanup = effect();
        if (cleanup) cleanups.push(cleanup);
      }
      for (let pass = 0; pass < 4; pass++) await Promise.resolve();
      return render();
    },
    changeSession(next: FixtureSession | null) {
      assert.ok(listener);
      listener("SIGNED_OUT", next);
      return render();
    },
    unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); },
  };
}

test("Unready actual App returns Login without session lookup or auth subscription", async () => {
  for (const restoredState of [false, true]) {
    const f = appFixture(blocked({}), storedSession, restoredState);
    assert.equal(f.render().type, f.Login);
    assert.equal((await f.mount()).type, f.Login);
    f.unmount();
    assert.equal(f.state.sessionCalls, 0);
    assert.equal(f.state.subscriptionCalls, 0);
    assert.equal(f.state.unsubscribeCalls, 0);
  }
});

test("Ready actual App restores its session, subscribes, responds to sign-out and cleans up", async () => {
  const f = appFixture(resolveControlConfig(isolatedEnv()), storedSession);
  assert.equal(f.render().props.role, "status");
  const tree = await f.mount();
  assert.ok(nodes(tree).some((node) => node.type === f.Overview));
  assert.equal(f.state.sessionCalls, 1);
  assert.equal(f.state.subscriptionCalls, 1);
  assert.equal(f.changeSession(null).type, f.Login);
  f.unmount();
  assert.equal(f.state.unsubscribeCalls, 1);
});

test("Ready actual App without a stored session still returns Login after lookup", async () => {
  const f = appFixture(resolveControlConfig(ordinaryEnv()), null);
  assert.equal(f.render().props.role, "status");
  assert.equal((await f.mount()).type, f.Login);
  assert.equal(f.state.sessionCalls, 1);
  assert.equal(f.state.subscriptionCalls, 1);
  f.unmount();
  assert.equal(f.state.unsubscribeCalls, 1);
});
