import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

// Local-only: transpile actual modules in memory, with no host process or loader.
// Run alone with node --test in a cleared subprocess; Windows needs only literal
// SystemRoot/WINDIR=C:\Windows. The module VMs receive neither OS entry.
type TextModule = {
  resolveTextProvider(env: Env): Provider | null;
  modelFor(provider: Provider, env: Env, purpose?: "ads" | "content"): string;
  generateText(request: { system: string; user: unknown; purpose: "ads" | "content"; json?: boolean; maxTokens?: number },
    options?: { env?: Env; fetchImpl?: FetchLike }): Promise<
      { ok: true; provider: Provider; text: string }
      | { ok: false; provider: Provider | null; reason: string; status?: number; retryable?: boolean }>;
};
type StudioConfig = { apiKey: string; imageModel: string; videoModel: string; videoSeconds: string };
type StudioRefusal = { status: number; error: string; details: string[]; hint?: string };
type StudioModule = {
  readGenerationConfig(env?: Env): StudioConfig;
  imageGenerationRefusal(config: StudioConfig): StudioRefusal | null;
  videoGenerationRefusal(config: StudioConfig): StudioRefusal | null;
};
type Env = Readonly<Record<string, string | undefined>>;
type Provider = "openai" | "anthropic";
type Outcome = "ok" | "http-429" | "http-401" | "empty" | "throw";
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>;
}>;

const bounded = { timeout: 10_000, concurrency: false };
const request = { system: "Synthetic isolation probe", user: "Synthetic input", purpose: "content" as const };
const keys = { OPENAI_API_KEY: "synthetic-openai-not-a-secret", ANTHROPIC_API_KEY: "synthetic-anthropic-not-a-secret" };
const allowedEnv = new Set([
  "AI_TEXT_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_MODEL",
  "OPENAI_ADS_MODEL", "ANTHROPIC_MODEL", "CONTENT_STUDIO_IMAGE_MODEL",
  "CONTENT_STUDIO_VIDEO_MODEL", "CONTENT_STUDIO_VIDEO_SECONDS",
]);

function syntheticEnv(values: Env = {}): Env {
  const env: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    assert.ok(allowedEnv.has(key), `Unexpected harness variable: ${key}`);
    if (value !== undefined) env[key] = value;
  }
  return Object.freeze(env);
}

function compile(relative: string): Script {
  const file = new URL(relative, import.meta.url);
  const result = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file.pathname,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(result.diagnostics, [], `Transpile diagnostics for ${relative}`);
  return new Script(result.outputText, { filename: relative });
}

const textScript = compile("../../lib/ai/text-provider.ts");
const studioScript = compile("../../lib/content-studio/generation.ts");

function load<T>(script: Script, values: Env = {}) {
  const env = syntheticEnv(values);
  const blocked: string[] = [];
  const imports: string[] = [];
  const deny = (name: string) => function () {
    blocked.push(name);
    throw new Error(`Isolation boundary blocked ${name}`);
  };
  const module = { exports: {} };
  const context = createContext({
    exports: module.exports,
    module,
    process: Object.freeze({ env }),
    fetch: deny("ambient fetch"),
    WebSocket: deny("WebSocket"),
    XMLHttpRequest: deny("XMLHttpRequest"),
    require: (name: string) => {
      imports.push(name);
      if (name === "node:crypto" && script === studioScript) {
        return Object.freeze({ createHmac: deny("createHmac"), timingSafeEqual: deny("timingSafeEqual") });
      }
      return deny(`require ${name}`)();
    },
  }, { codeGeneration: { strings: false, wasm: false } });
  script.runInContext(context, { timeout: 1_000 });
  const assertClean = () => {
    // Count even swallowed failures; an error response alone is not isolation proof.
    assert.deepEqual(blocked, [], "No unexpected ambient capability may be attempted");
    assert.deepEqual(imports, script === studioScript ? ["node:crypto"] : []);
    assert.equal(Object.getPrototypeOf(env), null);
    assert.ok(Object.isFrozen(env));
  };
  assertClean();
  return { api: module.exports as T, context, env, blocked, assertClean };
}

function transport(outcomes: readonly Outcome[]) {
  const calls: Array<{ provider: Provider; method: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const unexpected: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const provider = url === "https://api.openai.com/v1/chat/completions" ? "openai"
      : url === "https://api.anthropic.com/v1/messages" ? "anthropic" : null;
    if (!provider || calls.length >= outcomes.length) {
      unexpected.push(url);
      throw new Error("Unexpected synthetic dispatch");
    }
    const outcome = outcomes[calls.length];
    calls.push({ provider, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    if (outcome === "throw") throw new Error("Synthetic transport failure");
    const status = outcome === "http-429" ? 429 : outcome === "http-401" ? 401 : 200;
    const body = status !== 200 ? { error: { message: `${provider}-synthetic-${status}` } }
      : outcome === "empty" ? {}
        : provider === "openai" ? { choices: [{ message: { content: "openai-synthetic-text" } }] }
          : { content: [{ type: "text", text: "anthropic-synthetic-text" }] };
    return { ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return {
    calls, fetchImpl,
    assertClean: () => assert.deepEqual(unexpected, [], "Every mocked dispatch must be expected"),
  };
}

const selectors: ReadonlyArray<{
  name: string; value?: string; both: Provider; openaiOnly: Provider | null;
  anthropicOnly: Provider | null; fallback: boolean;
}> = [
  { name: "unset", both: "openai", openaiOnly: "openai", anthropicOnly: "anthropic", fallback: true },
  { name: "empty", value: "", both: "openai", openaiOnly: "openai", anthropicOnly: "anthropic", fallback: true },
  { name: "whitespace", value: " \t\n ", both: "openai", openaiOnly: "openai", anthropicOnly: "anthropic", fallback: true },
  { name: "false", value: "false", both: "openai", openaiOnly: "openai", anthropicOnly: "anthropic", fallback: false },
  { name: "auto", value: "auto", both: "openai", openaiOnly: "openai", anthropicOnly: "anthropic", fallback: false },
  { name: "openai", value: "openai", both: "openai", openaiOnly: "openai", anthropicOnly: null, fallback: false },
  { name: "anthropic", value: "anthropic", both: "anthropic", openaiOnly: null, anthropicOnly: "anthropic", fallback: false },
  { name: "padded mixed-case auto", value: " \tAuTo ", both: "openai", openaiOnly: "openai", anthropicOnly: "anthropic", fallback: false },
  { name: "padded mixed-case openai", value: " OPENAI ", both: "openai", openaiOnly: "openai", anthropicOnly: null, fallback: false },
  { name: "padded mixed-case anthropic", value: " AnThRoPiC\n", both: "anthropic", openaiOnly: null, anthropicOnly: "anthropic", fallback: false },
  { name: "unknown", value: "synthetic-unknown", both: "openai", openaiOnly: "openai", anthropicOnly: "anthropic", fallback: false },
];
const disabled = [
  { name: "unset", value: undefined },
  { name: "empty", value: "" },
  { name: "whitespace", value: " \t\n " },
] as const;

test("AI isolation: VM defaults see only a fresh synthetic environment", bounded, async () => {
  const text = load<TextModule>(textScript);
  const studio = load<StudioModule>(studioScript);
  for (const vm of [text, studio]) {
    assert.deepEqual(Object.keys(vm.env), []);
    assert.equal(new Script("Object.keys(process).join(',')").runInContext(vm.context), "env");
    assert.equal(new Script("typeof Buffer + ':' + typeof process.cwd").runInContext(vm.context), "undefined:undefined");
    assert.throws(() => new Script("Function('return process')()").runInContext(vm.context), /Code generation/);
  }
  const result = await text.api.generateText(request);
  assert.equal(result.ok, false);
  assert.equal(result.provider, null);
  const config = studio.api.readGenerationConfig();
  assert.equal(config.apiKey, "");
  assert.equal(config.imageModel, "gpt-image-2");
  assert.equal(config.videoModel, "");
  assert.equal(config.videoSeconds, "");
  assert.equal(studio.api.imageGenerationRefusal(config)?.status, 503);
  assert.equal(studio.api.videoGenerationRefusal(config)?.status, 503);
  text.assertClean();
  studio.assertClean();
});

test("AI isolation: boundary guards reject ambient fetch, sockets, native modules and crypto", bounded, () => {
  const vm = load<StudioModule>(studioScript);
  for (const expression of ["fetch('synthetic:probe')", "new WebSocket('synthetic:probe')",
    "new XMLHttpRequest()", "require('node:https')", "require('node:http')",
    "require('node:net')", "require('node:child_process')", "require('node:crypto').createHmac()"]) {
    assert.throws(() => new Script(expression).runInContext(vm.context, { timeout: 1_000 }), /Isolation boundary blocked/);
  }
  assert.deepEqual(vm.blocked, ["ambient fetch", "WebSocket", "XMLHttpRequest", "require node:https",
    "require node:http", "require node:net", "require node:child_process", "createHmac"]);
});

test("AI isolation: every disabled-key pair refuses without even a mocked dispatch", bounded, async t => {
  for (const openai of disabled) for (const anthropic of disabled) for (const selector of selectors) {
    await t.test(`${openai.name}/${anthropic.name}; selector ${selector.name}`, async () => {
      const vm = load<TextModule>(textScript, {
        OPENAI_API_KEY: openai.value, ANTHROPIC_API_KEY: anthropic.value, AI_TEXT_PROVIDER: selector.value,
        OPENAI_MODEL: "synthetic-content", OPENAI_ADS_MODEL: "false", ANTHROPIC_MODEL: "synthetic-claude",
      });
      const mock = transport([]);
      assert.equal(vm.api.resolveTextProvider(vm.env), null);
      for (const result of [
        await vm.api.generateText(request, { env: vm.env, fetchImpl: mock.fetchImpl }),
        await vm.api.generateText(request),
      ]) {
        assert.equal(result.ok, false);
        assert.equal(result.provider, null);
        assert.ok("reason" in result && result.reason.length > 0);
      }
      assert.equal(mock.calls.length, 0);
      mock.assertClean();
      vm.assertClean();
    });
  }
});

test("AI isolation: selectors and literal false credentials are not an off switch", bounded, async t => {
  const credentials: ReadonlyArray<{ name: string; values: Env; column: "both" | "openaiOnly" | "anthropicOnly" }> = [
    { name: "OpenAI only", values: { OPENAI_API_KEY: keys.OPENAI_API_KEY }, column: "openaiOnly" },
    { name: "Anthropic only", values: { ANTHROPIC_API_KEY: keys.ANTHROPIC_API_KEY }, column: "anthropicOnly" },
    { name: "both", values: keys, column: "both" },
    { name: "OpenAI false", values: { OPENAI_API_KEY: "false" }, column: "openaiOnly" },
    { name: "Anthropic false", values: { ANTHROPIC_API_KEY: "false" }, column: "anthropicOnly" },
    { name: "both false", values: { OPENAI_API_KEY: "false", ANTHROPIC_API_KEY: "false" }, column: "both" },
    { name: "both padded", values: { OPENAI_API_KEY: ` ${keys.OPENAI_API_KEY}\n`, ANTHROPIC_API_KEY: `\t${keys.ANTHROPIC_API_KEY} ` }, column: "both" },
  ];
  for (const credential of credentials) for (const selector of selectors) {
    await t.test(`${credential.name}; selector ${selector.name}`, async () => {
      const vm = load<TextModule>(textScript, { ...credential.values, AI_TEXT_PROVIDER: selector.value });
      const expected = selector[credential.column];
      const mock = transport(expected ? ["ok"] : []);
      assert.equal(vm.api.resolveTextProvider(vm.env), expected);
      const result = await vm.api.generateText(request, { fetchImpl: mock.fetchImpl });
      assert.equal(result.provider, expected);
      assert.equal(result.ok, expected !== null);
      assert.deepEqual(mock.calls.map(call => call.provider), expected ? [expected] : []);
      if (expected) {
        assert.ok(result.ok);
        assert.equal(result.text, `${expected}-synthetic-text`);
        assert.equal(mock.calls[0].method, "POST");
        const call = mock.calls[0];
        if (expected === "openai") {
          assert.equal(call.headers.Authorization, `Bearer ${vm.env.OPENAI_API_KEY!.trim()}`);
          assert.equal(call.headers["x-api-key"], undefined);
        } else {
          assert.equal(call.headers["x-api-key"], vm.env.ANTHROPIC_API_KEY!.trim());
          assert.equal(call.headers.Authorization, undefined);
        }
      }
      mock.assertClean();
      vm.assertClean();
    });
  }
});

test("AI isolation: failed-primary fallback requires an empty trimmed selector, not literal auto", bounded, async t => {
  for (const selector of selectors) for (const failure of ["http-429", "http-401", "empty", "throw"] as const) {
    await t.test(`${selector.name}; ${failure}`, async () => {
      const vm = load<TextModule>(textScript, { ...keys, AI_TEXT_PROVIDER: selector.value });
      const mock = transport(selector.fallback ? [failure, "ok"] : [failure]);
      const result = await vm.api.generateText(request, { env: vm.env, fetchImpl: mock.fetchImpl });
      assert.deepEqual(mock.calls.map(call => call.provider), selector.fallback ? ["openai", "anthropic"] : [selector.both]);
      assert.equal(result.ok, selector.fallback);
      assert.equal(result.provider, selector.fallback ? "anthropic" : selector.both);
      if (selector.fallback) {
        assert.ok(result.ok);
        assert.equal(result.text, "anthropic-synthetic-text");
      } else {
        assert.ok(!result.ok);
        assert.ok(result.reason.length > 0);
        if (failure === "http-429" || failure === "http-401") {
          assert.equal(result.status, failure === "http-429" ? 429 : 401);
          assert.equal(result.retryable, failure === "http-429");
        }
      }
      mock.assertClean();
      vm.assertClean();
    });
  }
});

test("AI isolation: no fallback to a disabled spare; both failures are reported in order", bounded, async t => {
  for (const selector of selectors.filter(row => row.fallback)) {
    for (const spare of disabled) for (const provider of ["openai", "anthropic"] as const) {
      await t.test(`${selector.name}; ${provider} only; spare ${spare.name}`, async () => {
        const vm = load<TextModule>(textScript, {
          AI_TEXT_PROVIDER: selector.value,
          OPENAI_API_KEY: provider === "openai" ? keys.OPENAI_API_KEY : spare.value,
          ANTHROPIC_API_KEY: provider === "anthropic" ? keys.ANTHROPIC_API_KEY : spare.value,
        });
        const mock = transport(["http-429"]);
        const result = await vm.api.generateText(request, { fetchImpl: mock.fetchImpl });
        assert.equal(result.ok, false);
        assert.equal(result.provider, provider);
        assert.deepEqual(mock.calls.map(call => call.provider), [provider]);
        mock.assertClean();
        vm.assertClean();
      });
    }
    await t.test(`${selector.name}; both fail once`, async () => {
      const vm = load<TextModule>(textScript, { ...keys, AI_TEXT_PROVIDER: selector.value });
      const mock = transport(["http-429", "http-401"]);
      const result = await vm.api.generateText(request, { fetchImpl: mock.fetchImpl });
      assert.ok(!result.ok);
      assert.equal(result.provider, "anthropic");
      assert.equal(result.status, 401);
      assert.equal(result.retryable, false);
      assert.match(result.reason, /openai-synthetic-429.*anthropic-synthetic-401/);
      assert.deepEqual(mock.calls.map(call => call.provider), ["openai", "anthropic"]);
      mock.assertClean();
      vm.assertClean();
    });
  }
});

test("AI isolation: text model defaults, purpose precedence and false models still dispatch only to mocks", bounded, async t => {
  const models: ReadonlyArray<{ name: string; env: Env; ads: string; content: string; anthropic: string }> = [
    { name: "unset", env: {}, ads: "gpt-4o-mini", content: "gpt-4.1-mini", anthropic: "claude-sonnet-5" },
    { name: "empty", env: { OPENAI_MODEL: "", OPENAI_ADS_MODEL: "", ANTHROPIC_MODEL: "" }, ads: "gpt-4o-mini", content: "gpt-4.1-mini", anthropic: "claude-sonnet-5" },
    { name: "whitespace", env: { OPENAI_MODEL: " \n", OPENAI_ADS_MODEL: "\t ", ANTHROPIC_MODEL: " \n" }, ads: "gpt-4o-mini", content: "gpt-4.1-mini", anthropic: "claude-sonnet-5" },
    { name: "false", env: { OPENAI_MODEL: "false", OPENAI_ADS_MODEL: "false", ANTHROPIC_MODEL: "false" }, ads: "false", content: "false", anthropic: "false" },
    { name: "padded synthetic", env: { OPENAI_MODEL: " synthetic-content ", OPENAI_ADS_MODEL: "\tsynthetic-ads\n", ANTHROPIC_MODEL: " synthetic-claude\n" }, ads: "synthetic-ads", content: "synthetic-content", anthropic: "synthetic-claude" },
    { name: "common only", env: { OPENAI_MODEL: "synthetic-common" }, ads: "synthetic-common", content: "synthetic-common", anthropic: "claude-sonnet-5" },
    { name: "ads only", env: { OPENAI_ADS_MODEL: "synthetic-ads" }, ads: "synthetic-ads", content: "gpt-4.1-mini", anthropic: "claude-sonnet-5" },
    { name: "empty ads uses common", env: { OPENAI_ADS_MODEL: "", OPENAI_MODEL: "synthetic-common" }, ads: "synthetic-common", content: "synthetic-common", anthropic: "claude-sonnet-5" },
    { name: "whitespace ads uses common", env: { OPENAI_ADS_MODEL: " \n", OPENAI_MODEL: "synthetic-common" }, ads: "synthetic-common", content: "synthetic-common", anthropic: "claude-sonnet-5" },
    { name: "false ads overrides common", env: { OPENAI_ADS_MODEL: "false", OPENAI_MODEL: "synthetic-common" }, ads: "false", content: "synthetic-common", anthropic: "claude-sonnet-5" },
    { name: "false common survives blank ads", env: { OPENAI_ADS_MODEL: "", OPENAI_MODEL: "false" }, ads: "false", content: "false", anthropic: "claude-sonnet-5" },
  ];
  for (const row of models) await t.test(row.name, async () => {
    const vm = load<TextModule>(textScript, { ...keys, ...row.env });
    assert.equal(vm.api.modelFor("openai", vm.env), row.ads);
    for (const provider of ["openai", "anthropic"] as const) for (const purpose of ["ads", "content"] as const) {
      const expected = provider === "anthropic" ? row.anthropic : row[purpose];
      assert.equal(vm.api.modelFor(provider, vm.env, purpose), expected);
      const mock = transport(["ok"]);
      const result = await vm.api.generateText({ ...request, purpose }, {
        env: syntheticEnv({ ...vm.env, AI_TEXT_PROVIDER: provider }), fetchImpl: mock.fetchImpl,
      });
      assert.ok(result.ok);
      assert.equal(result.provider, provider);
      assert.equal(mock.calls.length, 1);
      assert.equal(mock.calls[0].body.model, expected);
      mock.assertClean();
    }
    vm.assertClean();
  });
});

test("AI isolation: actual Content Studio config/refusal readers are pure; models are not credential gates", bounded, async t => {
  const credentials = [...disabled, { name: "false", value: "false" }, { name: "synthetic padded", value: ` ${keys.OPENAI_API_KEY}\n` }];
  const modelCases = [
    { name: "unset", env: {}, image: "gpt-image-2", video: "", seconds: "" },
    { name: "empty", env: { CONTENT_STUDIO_IMAGE_MODEL: "", CONTENT_STUDIO_VIDEO_MODEL: "", CONTENT_STUDIO_VIDEO_SECONDS: "" }, image: "gpt-image-2", video: "", seconds: "" },
    { name: "whitespace", env: { CONTENT_STUDIO_IMAGE_MODEL: " \n", CONTENT_STUDIO_VIDEO_MODEL: "\t ", CONTENT_STUDIO_VIDEO_SECONDS: " \n" }, image: "gpt-image-2", video: "", seconds: "" },
    { name: "false", env: { CONTENT_STUDIO_IMAGE_MODEL: "false", CONTENT_STUDIO_VIDEO_MODEL: "false", CONTENT_STUDIO_VIDEO_SECONDS: "false" }, image: "false", video: "false", seconds: "false" },
    { name: "synthetic padded", env: { CONTENT_STUDIO_IMAGE_MODEL: " synthetic-image\n", CONTENT_STUDIO_VIDEO_MODEL: "\tsynthetic-video ", CONTENT_STUDIO_VIDEO_SECONDS: " 7 " }, image: "synthetic-image", video: "synthetic-video", seconds: "7" },
  ];
  for (const key of credentials) for (const row of modelCases) {
    await t.test(`OpenAI ${key.name}; models ${row.name}`, () => {
      const vm = load<StudioModule>(studioScript, { ...row.env, OPENAI_API_KEY: key.value,
        ANTHROPIC_API_KEY: keys.ANTHROPIC_API_KEY, AI_TEXT_PROVIDER: "anthropic" });
      const expectedKey = key.name === "false" ? "false" : key.name === "synthetic padded" ? keys.OPENAI_API_KEY : "";
      for (const config of [vm.api.readGenerationConfig(), vm.api.readGenerationConfig(vm.env)]) {
        assert.equal(config.apiKey, expectedKey, "Studio uses only the OpenAI credential, not text-provider selection");
        assert.equal(config.imageModel, row.image);
        assert.equal(config.videoModel, row.video);
        assert.equal(config.videoSeconds, row.seconds);
        const image = vm.api.imageGenerationRefusal(config);
        const video = vm.api.videoGenerationRefusal(config);
        if (!expectedKey) {
          assert.equal(image?.status, 503);
          assert.equal(video?.status, 503);
          assert.match(image!.details.join(" "), /OPENAI_API_KEY/);
          assert.match(video!.details.join(" "), /OPENAI_API_KEY/);
        } else {
          assert.equal(image, null, "Blank image model restores a default; false is a model string");
          if (row.video) assert.equal(video, null, "A nonempty video model, even false, passes this reader gate");
          else {
            assert.equal(video?.status, 503);
            assert.match(video!.details.join(" "), /CONTENT_STUDIO_VIDEO_MODEL/);
          }
        }
      }
      // Do not invoke image/video generation, signing, polling or downloads.
      vm.assertClean();
    });
  }
});

test("AI isolation: text selector/model settings do not turn off configured Studio readers", bounded, async t => {
  for (const selector of selectors) await t.test(selector.name, () => {
    const vm = load<StudioModule>(studioScript, {
      ...keys, AI_TEXT_PROVIDER: selector.value, OPENAI_MODEL: "false", OPENAI_ADS_MODEL: "false",
      ANTHROPIC_MODEL: "false", CONTENT_STUDIO_VIDEO_MODEL: "synthetic-video",
    });
    const config = vm.api.readGenerationConfig();
    assert.equal(config.apiKey, keys.OPENAI_API_KEY);
    assert.equal(config.imageModel, "gpt-image-2");
    assert.equal(config.videoSeconds, "", "Omission is configuration, not a generation-disable flag");
    assert.equal(vm.api.imageGenerationRefusal(config), null);
    assert.equal(vm.api.videoGenerationRefusal(config), null);
    vm.assertClean();
  });
});
