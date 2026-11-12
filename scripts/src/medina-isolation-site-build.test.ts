import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import type * as TypeScript from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof TypeScript;
type Env = Readonly<Record<string, string | undefined>>;
type Config = Record<string, string | boolean>;

const closedFlags = [
  ["unset", undefined], ["empty", ""], ["whitespace", " \t\r\n"],
  ["false", "false"], ["padded false", " false "], ["uppercase", "TRUE"],
  ["title case", "True"], ["mixed case", "tRuE"], ["leading space", " true"],
  ["trailing space", "true "], ["tab/newline padded", "\ttrue\n"],
  ["one", "1"], ["zero", "0"], ["yes", "yes"], ["on", "on"],
] as const;
const buildOrigin = "https://build-api.example.invalid";
const runtimeOrigin = "https://runtime-site.example.invalid";
const publicKey = "synthetic_public_key_5";
const consentVersion = "synthetic.v1";
const workspaceId = "00000000-0000-4000-8000-000000000005";
const intakeKey = "synthetic-site-5";
const syntheticSecret = "synthetic-only-not-a-provider-credential";
const buildEnv: Env = Object.freeze({
  MEDINA_SITE_FORM_ENABLED: "true", MEDINA_SITE_API_ORIGIN: buildOrigin,
  MEDINA_SITE_TURNSTILE_SITE_KEY: publicKey, MEDINA_SITE_CONSENT_VERSION: consentVersion,
});
const pageEnv: Env = Object.freeze({
  MEDINA_PUBLIC_SITE_ENABLED: "true", MEDINA_PUBLIC_SITE_WORKSPACE_ID: workspaceId,
  MEDINA_SITE_ORIGIN: runtimeOrigin,
});
const intakeEnv: Env = Object.freeze({
  MEDINA_SITE_INTAKE_ENABLED: "true", MEDINA_SITE_ORIGIN: runtimeOrigin,
  MEDINA_SITE_INTAKE_KEY: intakeKey, MEDINA_SITE_TURNSTILE_SECRET: syntheticSecret,
});
const expectedBuild = { endpoint: `${buildOrigin}/api/crm/site-inquiry`, siteKey: publicKey, consentVersion };
const expectedPage = { workspaceId, origin: runtimeOrigin, indexable: false };
const expectedIntake = { origin: runtimeOrigin, hostname: "runtime-site.example.invalid", siteKey: intakeKey, secret: syntheticSecret };

// Evaluate the complete settings module, but only the named pure declarations
// from runtime files. No handlers, application imports, builds or SDKs execute.
async function isolatedReader(file: string, name: string, declarationOnly = false) {
  const source = await readFile(path.join(root, file), "utf8");
  let selected = source;
  if (declarationOnly) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
    assert.equal(declarations.length, 1, `Expected one actual ${name} declaration`);
    assert.ok(declarations[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
    selected = declarations[0].getText(ast);
  }
  const compiled = ts.transpileModule(selected, {
    // A virtual .cts suffix lowers .mjs exports for this CommonJS-only VM.
    fileName: `${file}.cts`,
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error), []);
  const attempts = { ambientEnvironment: 0, imports: 0, fetch: 0, sockets: 0 };
  function refuse(kind: keyof typeof attempts): never {
    attempts[kind]++;
    throw new Error(`Unexpected ${kind} access in ${name}`);
  }
  const context = createContext({
    exports: Object.create(null), URL,
    process: Object.freeze({ get env(): never { return refuse("ambientEnvironment"); } }),
    require: () => refuse("imports"), fetch: () => refuse("fetch"),
    WebSocket: class { constructor() { refuse("sockets"); } },
    XMLHttpRequest: class { constructor() { refuse("sockets"); } },
  }, { codeGeneration: { strings: false, wasm: false } });
  const noEffects = () => assert.deepEqual(attempts, { ambientEnvironment: 0, imports: 0, fetch: 0, sockets: 0 });
  new Script(compiled.outputText, { filename: file }).runInContext(context, { timeout: 250 });
  noEffects();
  assert.equal(typeof context.exports[name], "function");
  const invoke = new Script(`exports.${name}(syntheticInput)`, { filename: `${file}:synthetic-reader-call` });
  return (env: Env): Config | null => {
    context.syntheticInput = env;
    try {
      const value = invoke.runInContext(context, { timeout: 250 }) as Config | null;
      return value === null ? null : { ...value };
    } finally {
      delete context.syntheticInput;
      // Also fail when a reader catches an attempted forbidden operation.
      noEffects();
    }
  };
}

const readFormSettings = await isolatedReader("artifacts/medina-site/settings.mjs", "readFormSettings");
const publicSiteConfig = await isolatedReader("lib/crm/site-page.ts", "publicSiteConfig", true);
const readSiteIntakeConfig = await isolatedReader("lib/crm/site-intake-handler.ts", "readSiteIntakeConfig", true);

function gateOnlyEnv(gate: string, value: string | undefined) {
  const reads: string[] = [];
  const values: Record<string, string | undefined> = Object.create(null);
  if (value !== undefined) values[gate] = value;
  return {
    reads,
    env: new Proxy(Object.freeze(values), {
      get(target, key) {
        assert.equal(typeof key, "string");
        reads.push(String(key));
        assert.equal(key, gate, "Closed gates must not read endpoint, binding or credential settings");
        return Reflect.get(target, key);
      },
    }),
  };
}

const invalidOrigins = (origin: string) => [
  ["unset", undefined], ["empty", ""], ["whitespace", " \t\n"], ["malformed", "not-a-url"],
  ["http", origin.replace("https:", "http:")], ["relative", "/synthetic-api"],
  ["trailing slash", `${origin}/`], ["path", `${origin}/synthetic`],
  ["query", `${origin}?synthetic=1`], ["fragment", `${origin}#synthetic`],
  ["userinfo", origin.replace("https://", "https://synthetic:fixture@")],
] as const;

test("build-only: exact true selects the explicit synthetic public form endpoint", () => {
  assert.deepEqual(readFormSettings(buildEnv), expectedBuild);
  assert.deepEqual(readFormSettings({ ...buildEnv, MEDINA_SITE_API_ORIGIN: `${buildOrigin}:8443` }), {
    ...expectedBuild, endpoint: `${buildOrigin}:8443/api/crm/site-inquiry`,
  });
});

test("build-only: disabled forms neither require nor select API settings", async (t) => {
  for (const [label, value] of closedFlags) {
    await t.test(label, () => {
      const gate = gateOnlyEnv("MEDINA_SITE_FORM_ENABLED", value);
      assert.equal(readFormSettings(gate.env), null);
      assert.deepEqual(gate.reads, ["MEDINA_SITE_FORM_ENABLED"]);
      assert.equal(readFormSettings({ ...buildEnv, MEDINA_SITE_FORM_ENABLED: value }), null);
      assert.equal(readFormSettings({
        MEDINA_SITE_FORM_ENABLED: value, MEDINA_SITE_API_ORIGIN: "not-a-url",
        MEDINA_SITE_TURNSTILE_SITE_KEY: "bad", MEDINA_SITE_CONSENT_VERSION: "bad/version",
      }), null);
    });
  }
});

test("build-only: enabled forms reject missing or non-origin HTTPS settings without a fallback", async (t) => {
  for (const [label, value] of invalidOrigins(buildOrigin)) {
    await t.test(label, () => {
      assert.throws(() => readFormSettings({ ...buildEnv, MEDINA_SITE_API_ORIGIN: value }), /Invalid URL|Incomplete public form configuration/);
    });
  }
});

test("build-only: public key and consent version are required and bounded", async (t) => {
  const invalidFields = [
    ["MEDINA_SITE_TURNSTILE_SITE_KEY", [undefined, "", " \t\n", "a".repeat(9), "a".repeat(101), "synthetic key", "synthetic/key", "synthetic$key"]],
    ["MEDINA_SITE_CONSENT_VERSION", [undefined, "", " \t\n", "v".repeat(41), "bad version", "bad/version"]],
  ] as const;
  for (const [field, values] of invalidFields) {
    for (const [index, value] of values.entries()) {
      await t.test(`${field} invalid row ${index}`, () => {
        assert.throws(() => readFormSettings({ ...buildEnv, [field]: value }), /Incomplete public form configuration/);
      });
    }
  }
  for (const key of ["a".repeat(10), "A".repeat(100), "synthetic_Key-5"]) {
    assert.deepEqual(readFormSettings({ ...buildEnv, MEDINA_SITE_TURNSTILE_SITE_KEY: key }), { ...expectedBuild, siteKey: key });
  }
  for (const version of ["v", "v".repeat(40), "synthetic_V1.0-5"]) {
    assert.deepEqual(readFormSettings({ ...buildEnv, MEDINA_SITE_CONSENT_VERSION: version }), { ...expectedBuild, consentVersion: version });
  }
});

test("build-only: enabled public fields trim, but the activation flag does not", () => {
  for (const field of ["MEDINA_SITE_API_ORIGIN", "MEDINA_SITE_TURNSTILE_SITE_KEY", "MEDINA_SITE_CONSENT_VERSION"]) {
    assert.deepEqual(readFormSettings({ ...buildEnv, [field]: ` \t${buildEnv[field]}\n` }), expectedBuild);
  }
});

test("build-only: runtime settings cannot enable the build form or replace its origin", () => {
  assert.equal(readFormSettings({ ...pageEnv, ...intakeEnv }), null);
  assert.throws(() => readFormSettings({ ...pageEnv, ...intakeEnv, ...buildEnv, MEDINA_SITE_API_ORIGIN: undefined }), /Invalid URL/);
});

// Runtime evidence below is limited to pure config readers, not handler, DB,
// challenge-provider, rendered-site, built-artifact or deployed isolation proof.
test("runtime reader: public site requires exact true before reading its binding", async (t) => {
  assert.deepEqual(publicSiteConfig(pageEnv), expectedPage);
  for (const [label, value] of closedFlags) {
    await t.test(label, () => {
      const gate = gateOnlyEnv("MEDINA_PUBLIC_SITE_ENABLED", value);
      assert.equal(publicSiteConfig(gate.env), null);
      assert.deepEqual(gate.reads, ["MEDINA_PUBLIC_SITE_ENABLED"]);
      assert.equal(publicSiteConfig({ ...pageEnv, MEDINA_PUBLIC_SITE_ENABLED: value, MEDINA_SITE_INDEXABLE: "true" }), null);
    });
  }
});

test("runtime reader: public indexing also requires exact true", async (t) => {
  assert.deepEqual(publicSiteConfig({ ...pageEnv, MEDINA_SITE_INDEXABLE: "true" }), { ...expectedPage, indexable: true });
  for (const [label, value] of closedFlags) {
    await t.test(label, () => {
      assert.deepEqual(publicSiteConfig({ ...pageEnv, MEDINA_SITE_INDEXABLE: value }), expectedPage);
    });
  }
});

test("runtime reader: public origin rejects invalid or padded settings rather than trimming", async (t) => {
  for (const [label, value] of [...invalidOrigins(runtimeOrigin), ["padded valid origin", ` \t${runtimeOrigin}\n`]] as const) {
    await t.test(label, () => assert.equal(publicSiteConfig({ ...pageEnv, MEDINA_SITE_ORIGIN: value }), null));
  }
});

test("runtime reader: public workspace binding must be an unpadded UUID", async (t) => {
  for (const [label, value] of [
    ["unset", undefined], ["empty", ""], ["whitespace", " \t\n"], ["malformed", "synthetic-workspace"],
    ["padded UUID", ` ${workspaceId} `], ["wrong length", workspaceId.slice(1)],
  ] as const) {
    await t.test(label, () => assert.equal(publicSiteConfig({ ...pageEnv, MEDINA_PUBLIC_SITE_WORKSPACE_ID: value }), null));
  }
});

test("runtime reader: intake requires exact true before reading endpoint or credentials", async (t) => {
  assert.deepEqual(readSiteIntakeConfig(intakeEnv), expectedIntake);
  for (const [label, value] of closedFlags) {
    await t.test(label, () => {
      const gate = gateOnlyEnv("MEDINA_SITE_INTAKE_ENABLED", value);
      assert.equal(readSiteIntakeConfig(gate.env), null);
      assert.deepEqual(gate.reads, ["MEDINA_SITE_INTAKE_ENABLED"]);
      assert.equal(readSiteIntakeConfig({ ...intakeEnv, MEDINA_SITE_INTAKE_ENABLED: value }), null);
    });
  }
});

test("runtime reader: enabled intake rejects missing or invalid HTTPS origins", async (t) => {
  for (const [label, value] of invalidOrigins(runtimeOrigin)) {
    await t.test(label, () => assert.equal(readSiteIntakeConfig({ ...intakeEnv, MEDINA_SITE_ORIGIN: value }), null));
  }
});

test("runtime reader: intake key and synthetic secret are required", async (t) => {
  const invalidFields = [
    ["MEDINA_SITE_INTAKE_KEY", [undefined, "", " \t\n", "ab", "a".repeat(65), "Synthetic-site", "synthetic_key", "-synthetic-site", "bad/site"]],
    ["MEDINA_SITE_TURNSTILE_SECRET", [undefined, "", " \t\n"]],
  ] as const;
  for (const [field, values] of invalidFields) {
    for (const [index, value] of values.entries()) {
      await t.test(`${field} invalid row ${index}`, () => assert.equal(readSiteIntakeConfig({ ...intakeEnv, [field]: value }), null));
    }
  }
  for (const key of ["abc", "a".repeat(64), "synthetic-site-5"]) {
    assert.deepEqual(readSiteIntakeConfig({ ...intakeEnv, MEDINA_SITE_INTAKE_KEY: key }), { ...expectedIntake, siteKey: key });
  }
});

test("runtime reader: enabled intake trims settings, unlike the public page origin", () => {
  for (const field of ["MEDINA_SITE_ORIGIN", "MEDINA_SITE_INTAKE_KEY", "MEDINA_SITE_TURNSTILE_SECRET"]) {
    assert.deepEqual(readSiteIntakeConfig({ ...intakeEnv, [field]: ` \t${intakeEnv[field]}\n` }), expectedIntake);
  }
});

test("runtime reader: build form settings do not activate or configure runtime gates", () => {
  assert.equal(publicSiteConfig(buildEnv), null);
  assert.equal(readSiteIntakeConfig(buildEnv), null);
  assert.equal(publicSiteConfig({ ...buildEnv, MEDINA_PUBLIC_SITE_ENABLED: "true", MEDINA_PUBLIC_SITE_WORKSPACE_ID: workspaceId }), null);
  assert.equal(readSiteIntakeConfig({ ...buildEnv, MEDINA_SITE_INTAKE_ENABLED: "true" }), null);
  assert.equal(readFormSettings({ ...buildEnv, MEDINA_SITE_FORM_ENABLED: "false", ...pageEnv, ...intakeEnv }), null);
  assert.deepEqual(publicSiteConfig({ ...pageEnv, MEDINA_SITE_FORM_ENABLED: "false", MEDINA_SITE_INTAKE_ENABLED: "false" }), expectedPage);
  assert.deepEqual(readSiteIntakeConfig({ ...intakeEnv, MEDINA_SITE_FORM_ENABLED: "false", MEDINA_PUBLIC_SITE_ENABLED: "false" }), expectedIntake);
});
