import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// VM observation types stay inside the scripts project; runtime comes from actual sources below.
type AdFields = { headline: string; text: string; description: string };
type ImproveIssue = { code: string; severity: "review" | "block"; message: string; match?: string };
type ImproveResult = {
  mode: "model" | "rules"; fields: AdFields; status: "safe" | "review" | "blocked";
  issues: ImproveIssue[]; changed: boolean;
  candidates: Array<{ source: "original" | "model" | "rules"; fields: AdFields; invented: string[] }>;
  before: { status: "safe" | "review" | "blocked"; issues: ImproveIssue[] }; refusal: string;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
// Opt-in red proof; ordinary runs always execute the working-tree chain.
const baselineRef = process.env.MEDINA_CONTENT_IMPROVE_PRIVACY_BASELINE_REF;
const files = {
  provider: "lib/ai/text-provider.ts",
  core: "lib/content-studio/core.ts",
  terms: "lib/vertical/terms.ts",
  compliance: "lib/meta/compliance.ts",
  improve: "lib/meta/improve.ts",
  api: "api/content-studio/[...path].ts",
} as const;
const markers = {
  diagnostic: "SYNTHETIC_PRIVATE_DIAGNOSTIC_C47",
  url: "https://synthetic-provider.invalid/SYNTHETIC_PRIVATE_URL_C47",
  request: "SYNTHETIC_PRIVATE_REQUEST_ECHO_C47",
  openaiKey: "SYNTHETIC_NOT_A_REAL_OPENAI_KEY_C47",
  anthropicKey: "SYNTHETIC_NOT_A_REAL_ANTHROPIC_KEY_C47",
};
const privateEcho = Object.values(markers).join("; ");
const BAD: AdFields = {
  headline: "\u0423 \u0432\u0430\u0441 \u0430\u043a\u043d\u0435?",
  text: `\u0413\u0430\u0440\u0430\u043d\u0442\u0438\u0440\u0443\u0435\u043c 100% \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442 \u043d\u0430\u0432\u0441\u0435\u0433\u0434\u0430. \u0414\u043e \u0438 \u043f\u043e\u0441\u043b\u0435. ${markers.request}`,
  description: "\u041a\u043e\u043d\u0441\u0443\u043b\u044c\u0442\u0430\u0446\u0438\u044f \u0441\u043f\u0435\u0446\u0438\u0430\u043b\u0438\u0441\u0442\u0430.",
};
const CLEAN: AdFields = {
  headline: "Synthetic clinic service",
  text: "Synthetic appointment copy.",
  description: BAD.description,
};
const BETTER: AdFields = { ...CLEAN, description: "\u041d\u0430\u0432\u0441\u0435\u0433\u0434\u0430." };
const context = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
};
const requestKey = "33333333-3333-4333-8333-333333333333";
const receipt = {
  allowed: true, tracked: true, duplicate: false, usageId: "synthetic-c47-receipt",
  kind: "text_request", used: 1, limit: 10, remaining: 9, periodStart: "2026-10-01",
};
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function compile(source: string) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

function selectDeclarations(file: string, source: string, names: string[]) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, import("typescript").Statement>();
  for (const statement of ast.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declarations.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
      }
    }
  }
  const selected = new Set<import("typescript").Statement>();
  const include = (name: string) => {
    const declaration = declarations.get(name);
    assert.ok(declaration, `actual ${file}:${name} exists`);
    if (selected.has(declaration)) return;
    selected.add(declaration);
    const visit = (node: import("typescript").Node) => {
      if (ts.isIdentifier(node) && declarations.has(node.text)) include(node.text);
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  };
  names.forEach(include);
  return compile([
    ...ast.statements.filter((statement) => selected.has(statement)).map((statement) => statement.getText(ast)),
    `exports.selected = { ${names.join(", ")} };`,
  ].join("\n"));
}

const compiled = {} as Record<keyof typeof files, string>;
for (const [name, file] of Object.entries(files) as Array<[keyof typeof files, string]>) {
  const source = baselineRef
    ? execFileSync("git", ["show", `${baselineRef}:${file}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, file), "utf8");
  compiled[name] = name === "api" ? selectDeclarations(file, source, ["handleImproveAdText"])
    : name === "core" ? selectDeclarations(file, source, ["generateOpenAIJson"])
    : compile(source);
}

type Step = { provider: "openai" | "anthropic" } & (
  | { fields: AdFields }
  | { failure: "http" | "transport"; status?: number }
);
type Options = {
  steps?: Step[];
  fields?: AdFields;
  env?: Record<string, string>;
  denied?: boolean;
};
type PublicJson = {
  success: boolean; error?: string; details?: string[]; mode?: string; code?: string;
  data?: {
    before: ImproveResult["before"]; fields?: AdFields; status?: ImproveResult["status"];
    issues?: ImproveResult["issues"]; changed?: boolean; attempts?: number; refusal?: string;
    mode?: string; invented?: string[];
  };
};
type Response = {
  status(value: number): Response;
  setHeader(name: string, value: string): Response;
  json(value: PublicJson): PublicJson;
};

function fixture(options: Options = {}) {
  const events: string[] = [], calls: Array<{ provider: string; body: Record<string, any> }> = [];
  const reserves: Record<string, unknown>[] = [], completions: Record<string, unknown>[] = [];
  const helperResults: ImproveResult[] = [], coreInputs: Record<string, any>[] = [], providerErrors: string[] = [];
  const fields = options.fields ?? BAD;
  const reservation = { ...receipt, ...(options.denied ? { allowed: false, reason: "quota_exceeded", remaining: 0 } : {}) };
  const env = Object.freeze(options.env ?? {
    AI_TEXT_PROVIDER: "openai", OPENAI_API_KEY: markers.openaiKey, ANTHROPIC_API_KEY: markers.anthropicKey,
  });
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    const provider = url === "https://api.openai.com/v1/chat/completions" ? "openai"
      : url === "https://api.anthropic.com/v1/messages" ? "anthropic" : "unexpected";
    const body = JSON.parse(init.body);
    calls.push({ provider, body });
    events.push(`fetch:${provider}`);
    const step = options.steps?.[calls.length - 1];
    assert.ok(step, "unexpected provider call; fixture never delegates to real fetch");
    assert.equal(provider, step.provider);
    assert.equal(init.method, "POST");
    assert.equal(provider === "openai" ? init.headers.Authorization : init.headers["x-api-key"],
      provider === "openai" ? `Bearer ${markers.openaiKey}` : markers.anthropicKey);
    if ("failure" in step) {
      const echo = `${privateEcho}; request=${body.messages[provider === "openai" ? 1 : 0].content}`;
      providerErrors.push(echo);
      if (step.failure === "transport") throw new Error(echo);
      return { ok: false, status: step.status ?? 503, json: async () => ({ error: { message: echo } }), text: async () => echo };
    }
    const text = JSON.stringify(step.fields);
    return {
      ok: true, status: 200, text: async () => text,
      json: async () => provider === "openai"
        ? { choices: [{ message: { content: text }, finish_reason: "stop" }] }
        : { content: [{ type: "text", text }], stop_reason: "end_turn" },
    };
  };
  // No host process, general require, DB imports or real fetch enter these VMs.
  const run = (name: keyof typeof compiled, dependencies: Record<string, unknown> = {}, imports: Record<string, unknown> = {}) => {
    const exported: Record<string, any> = {};
    new Script(compiled[name], { filename: `content-improve-privacy.${name}.cjs` }).runInNewContext({
      ...dependencies, exports: exported, Error, process: Object.freeze({ env }), fetch,
      require(id: string) {
        assert.ok(Object.hasOwn(imports, id), `unexpected application import ${id}`);
        return imports[id];
      },
    }, { timeout: 1000 });
    return exported;
  };
  const provider = run("provider");
  const terms = run("terms");
  const compliance = run("compliance", {}, { "../vertical/terms": terms });
  const improve = run("improve", {}, {
    "./compliance": compliance, "../vertical/terms": terms, "../ai/text-provider": provider,
  });
  const core = run("core", provider).selected;
  const api = run("api", {
    resolveTextProvider: provider.resolveTextProvider,
    randomUUID: () => requestKey,
    async reserveContentGeneration(input: Record<string, unknown>) {
      events.push("reserve");
      reserves.push(plain(input));
      return reservation;
    },
    async completeContentGeneration(input: Record<string, unknown>) {
      events.push(`complete:${input.status}`);
      completions.push(plain(input));
    },
    // Observation-only wrappers always delegate to the actual core and helper.
    async generateOpenAIJson(input: Record<string, unknown>) {
      coreInputs.push(input);
      return core.generateOpenAIJson(input);
    },
    async improveAdText(input: unknown) {
      const result = await improve.improveAdText(input);
      helperResults.push(plain(result));
      return result;
    },
  }).selected;
  const checked = compliance.checkMetaCompliance(fields);
  const before: ImproveResult["before"] = plain({ status: checked.status, issues: checked.issues });
  return {
    events, calls, reserves, completions, helperResults, coreInputs, providerErrors, fields, before,
    async invoke() {
      let status = 0;
      const headers: Record<string, string> = {}, replies: PublicJson[] = [];
      const res: Response = {
        status(value) { status = value; return this; },
        setHeader(name, value) { headers[name] = value; return this; },
        json(value) { const wire = plain(value); replies.push(wire); return wire; },
      };
      const returned = await api.handleImproveAdText({ body: fields, headers: {}, query: {} }, res, context);
      assert.equal(replies.length, 1, "exactly one public JSON response");
      assert.strictEqual(returned, replies[0]);
      assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
      return { status, reply: replies[0] };
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
type Result = Awaited<ReturnType<Fixture["invoke"]>>;

function assertPrivate(result: Result) {
  const wire = JSON.stringify(result);
  for (const [name, marker] of Object.entries(markers)) {
    assert.equal(wire.includes(marker), false, `public JSON must not echo synthetic ${name}`);
  }
}

function assertAccounting(f: Fixture, providerCalls: number, mode = "model", reserved = true, reservedProvider = "openai") {
  assert.equal(f.calls.length, providerCalls, "exact bounded provider-call count");
  assert.equal(f.reserves.length, reserved ? 1 : 0);
  if (reserved) assert.deepEqual(f.reserves[0], {
    ...context, requestKey, operation: "ad_text_improvement", kind: "text_request", units: 1, provider: reservedProvider,
  });
  assert.deepEqual(f.completions, [{
    workspaceId: context.workspaceId, reservation: reserved ? receipt : null, status: "succeeded", provider: mode,
  }], "preserve current single-receipt accounting even when the helper returns refusal");
  assert.equal(f.helperResults.length, 1, "the actual helper returned, rather than throwing to the route catch");
  assert.deepEqual(f.events, [
    ...(reserved ? ["reserve"] : []), ...f.calls.map((call) => `fetch:${call.provider}`), "complete:succeeded",
  ]);
}

function assertRefusal(f: Fixture, result: Result, attempts: number) {
  const internal = f.helperResults[0];
  assert.equal(result.status, 502, "helper refusal must not become the route's HTTP 500 catch");
  assert.equal(result.reply.success, false);
  assert.equal(result.reply.error, "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u0435\u0440\u0435\u043f\u0438\u0441\u0430\u0442\u044c \u0442\u0435\u043a\u0441\u0442");
  assert.deepEqual(result.reply.data, { before: f.before }, "only the original compliance verdict is public on refusal");
  assert.equal(result.reply.data.before.status, "blocked");
  assert.deepEqual(internal.before, f.before);
  assert.equal(internal.candidates.filter((candidate) => candidate.source === "model").length, attempts);
  for (const marker of [markers.diagnostic, markers.url, markers.request]) {
    assert.ok(internal.refusal.includes(marker), "raw diagnostic really travelled through provider/core/helper catch");
    assert.ok(f.providerErrors.some((error) => error.includes(marker)));
  }
  assert.equal(internal.refusal.includes(markers.openaiKey), false, "existing provider key redaction still applies internally");
  assert.equal(internal.refusal.includes(markers.anthropicKey), false);
  assert.equal(result.reply.details?.length, 1);
  assert.ok(result.reply.details[0].trim(), "a nonempty safe diagnostic survives");
  assertPrivate(result);
  assert.deepEqual(result.reply.details, [
    "\u0421\u0435\u0440\u0432\u0438\u0441 \u0433\u0435\u043d\u0435\u0440\u0430\u0446\u0438\u0438 \u043d\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u043b \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u0438\u0435 \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u043a\u0438 \u0442\u0435\u043a\u0441\u0442\u0430. \u041f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435 \u043f\u043e\u0437\u0436\u0435.",
  ], "refusal details are the fixed safe message, not filtered provider prose");
}

function assertSuccess(f: Fixture, result: Result, fields: AdFields, attempts: number, changed = true, mode = "model") {
  const internal = f.helperResults[0];
  assert.equal(result.status, 200);
  assert.equal(result.reply.success, true);
  assert.equal(result.reply.mode, mode);
  assert.deepEqual(result.reply.data, {
    mode, fields, status: internal.status, issues: internal.issues, changed, before: f.before,
    invented: internal.candidates.flatMap((candidate) => candidate.invented), attempts, refusal: "",
  }, "public success preserves copy, verdict, attempts and an explicitly empty refusal");
  assert.equal(internal.refusal, "");
}

for (const scenario of [
  { name: "OpenAI HTTP rejection", provider: "openai", failure: "http", status: 429 },
  { name: "Anthropic HTTP rejection", provider: "anthropic", failure: "http", status: 401 },
  { name: "OpenAI transport Error", provider: "openai", failure: "transport" },
] as const) {
  test(`C47 first-attempt ${scenario.name} stays private through the real helper catch`, async () => {
    const f = fixture({
      steps: [scenario],
      env: { AI_TEXT_PROVIDER: scenario.provider, OPENAI_API_KEY: markers.openaiKey, ANTHROPIC_API_KEY: markers.anthropicKey },
    });
    const result = await f.invoke();
    assertAccounting(f, 1, "model", true, scenario.provider);
    assert.equal(f.coreInputs.length, 1);
    assert.deepEqual(plain(f.coreInputs[0].user.original), BAD);
    assert.equal(f.coreInputs[0].user.attempt, 1);
    assert.equal(f.helperResults.length, 1);
    assert.equal(f.helperResults[0].changed, false);
    assert.deepEqual(f.helperResults[0].fields, BAD);
    assertRefusal(f, result, 0);
  });
}

test("C47 second-attempt rejection retains the first candidate privately but never publishes its refusal", async () => {
  const f = fixture({ steps: [{ provider: "openai", fields: BETTER }, { provider: "openai", failure: "http", status: 503 }] });
  const result = await f.invoke();
  assertAccounting(f, 2);
  assert.equal(f.coreInputs.length, 2);
  assert.deepEqual(plain(f.coreInputs[1].user.previousAttempt), BETTER);
  assert.equal(f.coreInputs[1].user.attempt, 2);
  assert.ok(f.coreInputs[1].user.mustFix.some((issue: { rule: string }) => issue.rule === "guarantee"));
  assert.equal(f.helperResults[0].changed, true);
  assert.deepEqual(f.helperResults[0].fields, BETTER, "the actual helper still ranks its first candidate after the second call fails");
  assertRefusal(f, result, 1);
});

test("C47 second-attempt recovery still publishes the real successful rewrite", async () => {
  const f = fixture({ steps: [{ provider: "openai", fields: BETTER }, { provider: "openai", fields: CLEAN }] });
  const result = await f.invoke();
  assertAccounting(f, 2);
  assertSuccess(f, result, CLEAN, 2);
  assert.equal(result.reply.data?.status, "safe");
  assertPrivate(result);
});

test("C47 diagnostic-looking generated copy is intentional success, not an error to redact", async () => {
  const generated: AdFields = { ...CLEAN, text: `Synthetic published copy: ${privateEcho}` };
  const f = fixture({ steps: [{ provider: "openai", fields: generated }] });
  const result = await f.invoke();
  assertAccounting(f, 1);
  assertSuccess(f, result, generated, 1);
  assert.equal(result.reply.data?.status, "safe");
  for (const marker of Object.values(markers)) assert.ok(result.reply.data?.fields?.text.includes(marker));
});

test("C47 unchanged clean model copy remains success with changed false", async () => {
  const f = fixture({ fields: CLEAN, steps: [{ provider: "openai", fields: CLEAN }] });
  const result = await f.invoke();
  assertAccounting(f, 1);
  assertSuccess(f, result, CLEAN, 1, false);
  assert.equal(result.reply.data?.before.status, "safe");
  assertPrivate(result);
});

test("C47 two worse model candidates stop at the existing limit and preserve the clean original", async () => {
  const f = fixture({ fields: CLEAN, steps: [{ provider: "openai", fields: BETTER }, { provider: "openai", fields: BETTER }] });
  const result = await f.invoke();
  assertAccounting(f, 2);
  assertSuccess(f, result, CLEAN, 2, false);
  assert.equal(result.reply.data?.status, "safe");
  assertPrivate(result);
});

test("C47 no configured provider still uses actual demo-to-rules fallback without network or quota reservation", async () => {
  const f = fixture({ env: {}, fields: CLEAN });
  const result = await f.invoke();
  assertAccounting(f, 0, "rules", false);
  assert.equal(f.coreInputs.length, 1, "the actual core supplies demo, which the actual helper converts to rules");
  assertSuccess(f, result, CLEAN, 1, false, "rules");
  assert.deepEqual(f.events, ["complete:succeeded"]);
  assertPrivate(result);
});

test("C47 auto-provider fallback succeeds without leaking the rejected provider diagnostic", async () => {
  const f = fixture({
    env: { OPENAI_API_KEY: markers.openaiKey, ANTHROPIC_API_KEY: markers.anthropicKey },
    steps: [{ provider: "openai", failure: "http", status: 503 }, { provider: "anthropic", fields: CLEAN }],
  });
  const result = await f.invoke();
  assertAccounting(f, 2);
  assert.equal(f.coreInputs.length, 1, "two provider calls remain one improvement attempt");
  assert.deepEqual(f.events, ["reserve", "fetch:openai", "fetch:anthropic", "complete:succeeded"]);
  assert.ok(f.providerErrors[0].includes(markers.diagnostic));
  assertSuccess(f, result, CLEAN, 1);
  assertPrivate(result);
});

test("C47 quota refusal still short-circuits before core, helper, provider and completion", async () => {
  const f = fixture({ denied: true });
  const result = await f.invoke();
  assert.equal(result.status, 429);
  assert.equal(result.reply.success, false);
  assert.equal(result.reply.code, "generation_quota_exceeded");
  assert.equal(Object.hasOwn(result.reply, "data"), false);
  assert.equal(f.reserves.length, 1);
  assert.deepEqual(f.events, ["reserve"]);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.coreInputs, []);
  assert.deepEqual(f.helperResults, []);
  assert.deepEqual(f.completions, []);
  assertPrivate(result);
});
