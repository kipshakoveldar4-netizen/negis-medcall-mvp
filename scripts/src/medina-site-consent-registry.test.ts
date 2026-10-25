import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { syntheticSiteConsent } from "./site-consent-fixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const ts = requireFromRoot("typescript") as typeof import("typescript");
const actualImport = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const phone = await actualImport("lib/crm/phone.ts");
const article = await actualImport("lib/site/article.ts");
const consentRegistry = requireFromRoot(path.join(root, "lib/site/consent-registry.cjs"));
type Json = Record<string, unknown>;
type Inquiry = { name: string; phone: string; business: string; service: string;
  pagePath: string; consentVersion: string; consent: true };
type Validation = { ok: true; data: Inquiry } | { ok: false; code: string };
type Handler = (req: Json, res: unknown) => Promise<unknown>;
type Validator = { validateSiteInquiry(value: unknown): Validation };
type IntakeModule = { createSiteIntakeHandler(deps: { env(): NodeJS.ProcessEnv; verify(): Promise<boolean> }): Handler };
type PageModule = { handleSitePage: Handler };
type Renderer = { createPages(settings: { endpoint: string; siteKey: string; consentVersion: string },
  options: { preview: boolean; origin: string }): Map<string, string> };
const renderer = requireFromRoot(path.join(root, "artifacts/medina-site/render.cjs")) as Renderer;
const programs = new Map<string, Script>();
for (const file of ["lib/crm/site-intake.ts", "lib/crm/site-intake-handler.ts", "lib/crm/site-page.ts"]) {
  const result = ts.transpileModule(await readFile(path.join(root, file), "utf8"), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(result.diagnostics ?? [], [], `Cannot compile actual ${file}`);
  programs.set(file, new Script(result.outputText, { filename: file }));
}

const ORIGIN = "https://consent-registry.example.invalid";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const FOREIGN = "00000000-0000-4000-8000-000000000002";
const envTemplate = {
  MEDINA_PUBLIC_SITE_ENABLED: "true", MEDINA_PUBLIC_SITE_WORKSPACE_ID: WORKSPACE,
  MEDINA_SITE_ORIGIN: ORIGIN, MEDINA_SITE_INDEXABLE: "false", MEDINA_SITE_FORM_ENABLED: "true",
  MEDINA_SITE_INTAKE_ENABLED: "true", MEDINA_SITE_INTAKE_KEY: "consent-registry-fixture",
  MEDINA_SITE_TURNSTILE_SECRET: "synthetic-not-a-provider-credential",
  MEDINA_SITE_TURNSTILE_SITE_KEY: "synthetic-public-site-key",
};
// These are the existing version-binding reproduction's synthetic DB labels,
// NOT approved legal revisions. LEGAL-SECURITY-READINESS.md leaves L2 open and
// SITE-RELEASE-2026-09.md says not to enable the form pending text approval.
// Unknown versions must stay closed, without approving fixture labels.
const unregisteredVersions = ["g8-fixture-a", "g8-fixture-b"] as const;
const inquiry = (changes: Json = {}): Json => ({
  name: "Synthetic visitor", phone: "+77000000001", business: "Synthetic business",
  service: "call-center", pagePath: "/ru/", consentVersion: unregisteredVersions[0], consent: true, ...changes,
});
const envelope = (value: unknown) => ({
  requestKey: "00000000-0000-4000-8000-000000000100", challengeToken: "synthetic-challenge", inquiry: value,
});

function fixture(version: unknown = unregisteredVersions[0]) {
  const env: NodeJS.ProcessEnv = { ...envTemplate };
  const site = { workspace_id: WORKSPACE, enabled: true, consent_version: version, allowed_page_paths: ["/ru/"] };
  const attempts: Array<{ p_site_key: string; p_request_key: string; p_inquiry: Inquiry }> = [];
  const saved: Inquiry[] = [];
  let verifications = 0, externalCalls = 0;
  const client = {
    from(table: string) {
      assert.ok(["site_blog_posts", "crm_intake_sites"].includes(table), `Unexpected table ${table}`);
      const query = {
        select() { return query; },
        eq(key: string, value: string) {
          assert.deepEqual([key, value], table === "site_blog_posts"
            ? ["workspace_id", WORKSPACE] : ["site_key", envTemplate.MEDINA_SITE_INTAKE_KEY]);
          return query;
        },
        not() { return query; }, order() { return query; },
        async limit(count: number) {
          assert.equal(table, "site_blog_posts"); assert.equal(count, 201);
          return { data: [], error: null };
        },
        async maybeSingle() { assert.equal(table, "crm_intake_sites"); return { data: { ...site }, error: null }; },
      };
      return query;
    },
    async rpc(name: string, args: typeof attempts[number]) {
      assert.equal(name, "accept_crm_site_inquiry");
      assert.equal(args.p_site_key, envTemplate.MEDINA_SITE_INTAKE_KEY);
      attempts.push(structuredClone(args));
      // Recording SDK only: model 058's configured-label/path equality, not
      // approval of legal text and not execution of a real database migration.
      if (!site.enabled || args.p_inquiry.consentVersion !== site.consent_version
        || !site.allowed_page_paths.includes(args.p_inquiry.pagePath)) return { data: null, error: { message: "invalid_inquiry" } };
      saved.push(structuredClone(args.p_inquiry));
      return { data: { accepted: true }, error: null };
    },
  };
  function evaluate<T>(file: string, imports: Record<string, unknown>): T {
    const exports = {} as T;
    const program = programs.get(file);
    assert.ok(program);
    program.runInNewContext({
      exports, Buffer, Error, URL, AbortSignal,
      process: { env },
      fetch() { externalCalls++; throw new Error("No external HTTP in local consent regression tests"); },
      require(name: string) {
        assert.ok(Object.hasOwn(imports, name), `Unapproved module boundary ${file}: ${name}`);
        return imports[name];
      },
    }, { timeout: 1000 });
    return exports;
  }
  const validation = evaluate<Validator>("lib/crm/site-intake.ts", { "./phone": phone });
  const intake = evaluate<IntakeModule>("lib/crm/site-intake-handler.ts", {
    "../supabase/server": { getSupabaseServerClient: () => client }, "./site-intake": validation,
    "../site/consent-registry.cjs": consentRegistry,
  });
  const page = evaluate<PageModule>("lib/crm/site-page.ts", {
    "../supabase/server": { getSupabaseServerClient: () => client },
    "../../artifacts/medina-site/render.cjs": renderer, "./site-intake-handler": intake, "../site/article": article,
    "../site/consent-registry.cjs": consentRegistry,
  });
  const handler = intake.createSiteIntakeHandler({ env: () => env, verify: async () => { verifications++; return true; } });
  async function call(actualHandler: Handler, req: Json) {
    let status = 0, html = "";
    let payload: unknown;
    const headers: Record<string, string> = {};
    const res = {
      status(code: number) { status = code; return res; },
      setHeader(key: string, value: string) { headers[key.toLowerCase()] = value; },
      end(body?: string) { html = body ?? ""; }, json(body: unknown) { payload = structuredClone(body); },
    };
    try { await actualHandler(req, res); }
    finally { assert.equal(externalCalls, 0, "Never contact Supabase, challenge provider or public hosts"); }
    return { status, html, payload, headers };
  }
  return {
    env, site, attempts, saved, validation, verifications: () => verifications,
    render: () => call(page.handleSitePage, { method: "GET", query: { page: "/ru/" } }),
    submit: (value: unknown) => call(handler, { method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" }, body: envelope(value) }),
  };
}

function disabledForm(response: Awaited<ReturnType<ReturnType<typeof fixture>["render"]>>) {
  assert.equal(response.status, 200, "The content page must remain usable, not hide a broken harness behind 503");
  assert.equal(response.headers["cache-control"], "no-store");
  for (const pattern of [/data-intake-endpoint/, /data-consent-version/, /name="consent"/, /\/form\.js/]) {
    assert.equal(pattern.test(response.html), false, `Unbound consent must not activate ${pattern}`);
  }
  assert.ok(response.html.includes("<fieldset disabled>"));
  assert.equal(response.headers["content-security-policy"]?.includes("challenges.cloudflare.com"), false);
}

test("Consent default registry refuses both arbitrary DB labels in the static renderer", () => {
  for (const consentVersion of unregisteredVersions) {
    const html = renderer.createPages({ endpoint: `${ORIGIN}/api/crm/site-inquiry`,
      siteKey: envTemplate.MEDINA_SITE_TURNSTILE_SITE_KEY, consentVersion }, { preview: false, origin: ORIGIN }).get("/ru/");
    assert.ok(html);
    assert.doesNotMatch(html, /data-consent-version|name="consent"|\/form\.js/);
    assert.match(html, /<fieldset disabled>/);
  }
});

for (const consentVersion of unregisteredVersions) {
  test(`Consent registry gate: syntactic validation of ${consentVersion} does not approve a legal revision`, () => {
    const f = fixture(consentVersion);
    assert.equal(f.validation.validateSiteInquiry(inquiry({ consentVersion })).ok, true);
    assert.equal(consentRegistry.resolveSiteConsent(consentVersion), null);
  });

  test(`Consent registry gate: public page does not activate a form for unknown DB label ${consentVersion}`, async () => {
    const f = fixture(consentVersion);
    disabledForm(await f.render());
    assert.equal(f.verifications(), 0);
    assert.equal(f.attempts.length, 0);
  });

  test(`Consent registry gate: unknown submitted label ${consentVersion} stops before challenge verification or persistence`, async () => {
    const f = fixture(consentVersion);
    const response = await f.submit(inquiry({ consentVersion }));
    assert.equal(f.saved.length, 0, "No fake-persisted consent receipt may claim a legal revision selected only by a DB label");
    assert.equal(f.attempts.length, 0);
    assert.equal(f.verifications(), 0);
    assert.equal(response.status, 400);
    assert.deepEqual(response.payload, { success: false, code: "invalid_inquiry" });
  });
}

test("Consent safeguards: consent stays explicit and boolean before any provider or persistence step", async () => {
  const f = fixture();
  for (const consent of [undefined, false, "true", 1, null]) {
    const response = await f.submit(inquiry({ consent }));
    assert.equal(response.status, 400);
    assert.deepEqual(response.payload, { success: false, code: "consent_required" });
  }
  assert.equal(f.verifications(), 0); assert.equal(f.attempts.length, 0); assert.equal(f.saved.length, 0);
});

test("Consent safeguards: malformed versions are not silently rewritten or replaced", async () => {
  const f = fixture();
  for (const consentVersion of [undefined, null, "", "not a version", "x".repeat(41), {}, [unregisteredVersions[0]]]) {
    const response = await f.submit(inquiry({ consentVersion }));
    assert.equal(response.status, 400);
    assert.deepEqual(response.payload, { success: false, code: "invalid_inquiry" });
  }
  assert.equal(f.verifications(), 0); assert.equal(f.attempts.length, 0);
});

test("Consent safeguards: visitors cannot supply tenant, notice, purpose or privacy-link overrides", async () => {
  const f = fixture();
  for (const field of ["workspaceId", "consentText", "consentPurpose", "privacyUrl"]) {
    const response = await f.submit(inquiry({ [field]: "synthetic-visitor-override" }));
    assert.equal(response.status, 400);
    assert.deepEqual(response.payload, { success: false, code: "invalid_inquiry" });
  }
  assert.equal(f.verifications(), 0); assert.equal(f.attempts.length, 0);
});

test("Consent safeguards: disabled form/site, foreign tenant, unapproved path and malformed DB version stay inactive", async () => {
  const variants: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.env.MEDINA_SITE_FORM_ENABLED = "false"; }, f => { f.site.enabled = false; },
    f => { f.site.workspace_id = FOREIGN; }, f => { f.site.allowed_page_paths = ["/ru/other/"]; },
    f => { f.site.consent_version = "not a version"; },
  ];
  for (const change of variants) {
    const f = fixture(); change(f);
    disabledForm(await f.render());
    assert.equal(f.verifications(), 0); assert.equal(f.attempts.length, 0);
  }
});

test("Consent safeguards: disabling intake remains unavailable regardless of submitted label", async () => {
  const f = fixture();
  f.env.MEDINA_SITE_INTAKE_ENABLED = "false";
  const response = await f.submit(inquiry());
  assert.equal(response.status, 503);
  assert.deepEqual(response.payload, { success: false, code: "intake_unavailable" });
  assert.equal(f.verifications(), 0); assert.equal(f.attempts.length, 0);
});

test("Consent registry snapshots bind text, purpose, policy revision and URL without a mutable approval list", () => {
  const notice = syntheticSiteConsent(["synthetic-v1"])("synthetic-v1")!;
  const mutable = { ...notice };
  const notices = [mutable];
  const resolve = consentRegistry.createSiteConsentRegistry(notices);
  notices.length = 0;
  mutable.text = "SYNTHETIC changed after registration";
  assert.equal(resolve("synthetic-v1").text, notice.text);
  assert.equal(Object.isFrozen(resolve("synthetic-v1")), true);
  assert.equal(resolve(" synthetic-v1 "), null);
  assert.equal(resolve("SYNTHETIC-v1"), null);
  assert.equal(resolve({ version: "synthetic-v1" }), null);
  for (const field of ["version", "text", "purpose", "policyRevision", "policyUrl", "sha256"]) {
    assert.throws(() => consentRegistry.createSiteConsentRegistry([{ ...notice, [field]: "synthetic-changed" }]));
  }
  assert.throws(() => consentRegistry.createSiteConsentRegistry([notice, notice]));
  assert.equal(consentRegistry.resolveSiteConsent(notice.version), null, "A local factory does not approve the production registry");
});
