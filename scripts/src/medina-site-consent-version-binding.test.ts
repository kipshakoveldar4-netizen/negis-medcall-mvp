import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { syntheticSiteConsent, type ConsentResolver } from "./site-consent-fixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
type Inquiry = {
  name: string; phone: string; business: string; service: string;
  pagePath: string; consentVersion: string; consent: true;
};
type Envelope = { requestKey: string; inquiry: Inquiry; challengeToken: string };
type RpcArgs = { p_site_key: string; p_request_key: string; p_inquiry: Inquiry;
  p_consent_receipt: NonNullable<ReturnType<ConsentResolver>> };
const page = await load("lib/crm/site-page.ts") as { createSitePageHandler(deps: { resolveConsent: ConsentResolver; renderPages: unknown }): Handler };
const intake = await load("lib/crm/site-intake-handler.ts") as {
  createSiteIntakeHandler(deps: { env(): NodeJS.ProcessEnv; verify(): Promise<boolean>; resolveConsent: ConsentResolver }): Handler;
};
const validation = await load("lib/crm/site-intake.ts") as {
  validateSiteInquiry(value: unknown): { ok: true; data: Inquiry } | { ok: false; code: string };
};
const supabase = await load("lib/supabase/server.ts") as {
  setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void;
};
type RenderPages = (settings: { endpoint: string; siteKey: string; consentVersion: string },
  options: { preview: boolean; origin: string }) => Map<string, string>;
const rendering = createRequire(import.meta.url)(path.join(root, "artifacts/medina-site/render.cjs")) as {
  createPageRenderer(resolve: ConsentResolver): RenderPages;
};
const formSource = await readFile(path.join(root, "artifacts/medina-site/form.js"), "utf8");
const env = {
  MEDINA_PUBLIC_SITE_ENABLED: "true", MEDINA_PUBLIC_SITE_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
  MEDINA_SITE_ORIGIN: "https://consent-fixture.example.invalid", MEDINA_SITE_INDEXABLE: "false",
  MEDINA_SITE_FORM_ENABLED: "true", MEDINA_SITE_INTAKE_ENABLED: "true", MEDINA_SITE_INTAKE_KEY: "consent-fixture",
  MEDINA_SITE_TURNSTILE_SECRET: "synthetic-not-a-provider-credential", MEDINA_SITE_TURNSTILE_SITE_KEY: "public-fixture-key",
};
// Labels identify synthetic DB states, not approved policy revisions. L2 in
// LEGAL-SECURITY-READINESS.md supplies no approved version-to-notice mapping.
const versions = ["g8-fixture-a", "g8-fixture-b"] as const;
const resolveConsent = syntheticSiteConsent(versions);
const renderer = { createPages: rendering.createPageRenderer(resolveConsent) };
const fields = { name: "Synthetic visitor", phone: "+77000000001", business: "Synthetic business", service: "call-center" };
const envelope = (inquiry: unknown) => ({
  requestKey: "00000000-0000-4000-8000-000000000100", challengeToken: "synthetic-challenge", inquiry,
});
const postRequest = (body: unknown) => ({
  method: "POST", headers: { origin: env.MEDINA_SITE_ORIGIN, "content-type": "application/json" }, body,
});

async function call(handler: Handler, req: unknown) {
  let status = 0, html = "";
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    setHeader(key: string, value: string) { headers[key] = value; },
    status(value: number) { status = value; return res; },
    end(value?: string) { html = value || ""; },
    json(value: unknown) { payload = value; },
  };
  await handler(req, res);
  return { status, html, payload, headers };
}

function fixture(t: TestContext) {
  const previous = Object.keys(env).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    supabase.setSupabaseServerClientFactoryForTests(null);
  });
  let externalCalls = 0, verifications = 0;
  t.mock.method(globalThis, "fetch", async () => {
    externalCalls++;
    throw new Error("External calls are forbidden in the consent fixture");
  });
  t.after(() => assert.equal(externalCalls, 0));
  const site = {
    workspace_id: env.MEDINA_PUBLIC_SITE_WORKSPACE_ID, enabled: true,
    consent_version: versions[0] as unknown, allowed_page_paths: ["/ru/"],
  };
  const attempts: RpcArgs[] = [], saved: Inquiry[] = [];
  supabase.setSupabaseServerClientFactoryForTests(() => ({
    from(table: string) {
      assert.ok(["site_blog_posts", "crm_intake_sites"].includes(table));
      const query = {
        select() { return query; },
        eq(key: string, value: string) {
          assert.deepEqual([key, value], table === "site_blog_posts"
            ? ["workspace_id", env.MEDINA_PUBLIC_SITE_WORKSPACE_ID] : ["site_key", env.MEDINA_SITE_INTAKE_KEY]);
          return query;
        },
        not() { return query; },
        order() { return query; },
        async limit() { assert.equal(table, "site_blog_posts"); return { data: [], error: null }; },
        async maybeSingle() { assert.equal(table, "crm_intake_sites"); return { data: { ...site }, error: null }; },
      };
      return query;
    },
    async rpc(name: string, args: RpcArgs) {
      assert.equal(name, "accept_crm_site_inquiry_with_consent");
      assert.equal(args.p_site_key, env.MEDINA_SITE_INTAKE_KEY);
      assert.deepEqual(args.p_consent_receipt, resolveConsent(args.p_inquiry.consentVersion));
      attempts.push(structuredClone(args));
      // Model only the configured version/path check in migration 058, not a
      // policy registry or execution of the SQL/database integration itself.
      if (args.p_inquiry.consentVersion !== site.consent_version || !site.allowed_page_paths.includes(args.p_inquiry.pagePath)) {
        return { data: null, error: { message: "invalid_inquiry" } };
      }
      saved.push(structuredClone(args.p_inquiry));
      return { data: { accepted: true }, error: null };
    },
  }));
  const handler = intake.createSiteIntakeHandler({
    resolveConsent,
    env: () => ({ ...env }), verify: async () => { verifications++; return true; },
  });
  return {
    site, attempts, saved, handler, verifications: () => verifications,
    render: () => call(page.createSitePageHandler({ resolveConsent, renderPages: renderer.createPages }), { method: "GET", query: { page: "/ru/" } }),
  };
}

function activeForm(html: string) {
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) || [];
  assert.equal(forms.length, 1);
  const form = forms[0]!;
  const attribute = (name: string) => {
    const match = form.match(new RegExp(`\\b${name}="([^"]+)"`));
    assert.ok(match, `Missing rendered ${name}`);
    return match[1]!;
  };
  const notice = form.match(/<label class="consent"[^>]*>[\s\S]*?<\/label>/)?.[0];
  assert.ok(notice, "Use the actual rendered checkbox/notice, not fixture policy copy");
  return {
    notice, dataset: {
      intakeEndpoint: attribute("data-intake-endpoint"), siteKey: attribute("data-site-key"),
      consentVersion: attribute("data-consent-version"), sent: undefined as string | undefined,
    },
  };
}

async function submitRenderedForm(html: string, handler: Handler, requestKey = "00000000-0000-4000-8000-000000000100") {
  const { dataset } = activeForm(html);
  let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  let challenge: ((token: string) => void) | undefined;
  const requests: Envelope[] = [], responses: Awaited<ReturnType<typeof call>>[] = [];
  const button = { disabled: true }, fieldset = { disabled: false }, status = { textContent: "" };
  const form = {
    dataset, reportValidity: () => true,
    querySelector: (selector: string) => selector === "button" ? button : selector === "fieldset" ? fieldset : {},
    addEventListener(event: string, fn: typeof submit) { assert.equal(event, "submit"); submit = fn; },
  };
  const window = {
    medinaChallengeReady: undefined as (() => void) | undefined,
    turnstile: {
      render(_element: unknown, options: { callback(token: string): void }) { challenge = options.callback; return "fixture-widget"; },
      reset() {},
    },
  };
  runInNewContext(formSource, {
    document: {
      querySelector: () => form, getElementById: () => status, createElement: () => ({}),
      head: { append() {} }, // Do not load the provider script.
    },
    window, location: { pathname: "/ru/" },
    FormData: class { get(key: string) { return key === "consent" ? "on" : fields[key as keyof typeof fields]; } },
    crypto: { randomUUID: () => requestKey },
    AbortController, setTimeout, clearTimeout,
    fetch: async (url: string, init: { body: string; method: string; credentials: string }) => {
      assert.equal(url, `${env.MEDINA_SITE_ORIGIN}/api/crm/site-inquiry`);
      assert.equal(init.method, "POST"); assert.equal(init.credentials, "omit");
      const body = JSON.parse(init.body) as Envelope;
      requests.push(body);
      const response = await call(handler, postRequest(body));
      responses.push(response);
      return { ok: response.status === 200, text: async () => JSON.stringify(response.payload) };
    },
  });
  assert.ok(window.medinaChallengeReady); window.medinaChallengeReady();
  assert.ok(challenge); challenge("synthetic-challenge");
  assert.ok(submit); await submit({ preventDefault() {} });
  assert.equal(requests.length, 1); assert.equal(responses.length, 1);
  return { body: requests[0]!, response: responses[0]!, dataset, fieldset };
}

test("G8 synthetic registry binds different versions to different escaped notices and policy revisions", () => {
  const rendered = versions.map(consentVersion => activeForm(renderer.createPages({
    endpoint: `${env.MEDINA_SITE_ORIGIN}/api/crm/site-inquiry`, siteKey: env.MEDINA_SITE_TURNSTILE_SITE_KEY, consentVersion,
  }, { preview: false, origin: env.MEDINA_SITE_ORIGIN }).get("/ru/")!));
  assert.notEqual(rendered[0]!.dataset.consentVersion, rendered[1]!.dataset.consentVersion);
  assert.notEqual(rendered[0]!.notice, rendered[1]!.notice);
  assert.match(rendered[0]!.notice, /href="https:\/\/policy.fixture.invalid\/revisions\/g8-fixture-a"/);
  assert.match(rendered[0]!.notice, /&lt;not legal copy&gt;/);
  assert.match(rendered[0]!.notice, /data-notice-sha256="[a-f0-9]{64}"/);
  assert.doesNotMatch(rendered[0]!.notice, /\bchecked\b/);
  assert.match(rendered[0]!.notice, /<input type="checkbox" name="consent" required>/);
});

test("G8 synthetic registry: actual page, form script and intake handler retain the exact displayed revision at fake persistence", async t => {
  const f = fixture(t), notices: string[] = [];
  for (const [index, version] of versions.entries()) {
    f.site.consent_version = version;
    const rendered = await f.render();
    assert.equal(rendered.status, 200);
    assert.equal(rendered.headers["Cache-Control"], "no-store");
    notices.push(activeForm(rendered.html).notice);
    const requestKey = `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`;
    const sent = await submitRenderedForm(rendered.html, f.handler, requestKey);
    assert.deepEqual(validation.validateSiteInquiry(sent.body.inquiry), { ok: true, data: sent.body.inquiry });
    assert.deepEqual(sent.body.inquiry, { ...fields, pagePath: "/ru/", consentVersion: version, consent: true });
    assert.equal(sent.response.status, 200); assert.deepEqual(sent.response.payload, { success: true });
    assert.equal(sent.dataset.sent, "true");
    assert.doesNotMatch(rendered.html, /synthetic-not-a-provider-credential|workspace_id/);
  }
  assert.notEqual(notices[0], notices[1]);
  assert.deepEqual(f.saved.map(row => row.consentVersion), [...versions]);
  assert.equal(f.verifications(), 2); assert.equal(f.attempts.length, 2);
  assert.equal(new Set(f.attempts.map(args => args.p_request_key)).size, 2);
  assert.deepEqual(f.saved, f.attempts.map(args => args.p_inquiry));
});

test("safe control: a disabled form or malformed DB version never activates the public form", async t => {
  const f = fixture(t);
  for (const version of ["", "not a version", "x".repeat(41), null]) {
    f.site.consent_version = version;
    const rendered = await f.render();
    assert.equal(rendered.status, 200);
    assert.doesNotMatch(rendered.html, /data-intake-endpoint|data-consent-version|name="consent"|\/form\.js/);
    assert.match(rendered.html, /<fieldset disabled>/);
  }
  f.site.consent_version = versions[0];
  process.env.MEDINA_SITE_FORM_ENABLED = "false";
  assert.doesNotMatch((await f.render()).html, /data-intake-endpoint|data-consent-version|name="consent"/);
  assert.equal(f.verifications(), 0); assert.equal(f.attempts.length, 0);
});

test("safe control: absent or non-boolean consent is rejected before verification and persistence", async t => {
  const f = fixture(t);
  for (const consent of [undefined, false, "true", 1]) {
    const inquiry = { ...fields, pagePath: "/ru/", consentVersion: versions[0], consent };
    assert.deepEqual(validation.validateSiteInquiry(inquiry), { ok: false, code: "consent_required" });
    const response = await call(f.handler, postRequest(envelope(inquiry)));
    assert.equal(response.status, 400);
    assert.deepEqual(response.payload, { success: false, code: "consent_required" });
  }
  assert.equal(f.verifications(), 0); assert.equal(f.attempts.length, 0);
});

test("safe control: malformed submitted versions are rejected rather than replaced with the configured label", async t => {
  const f = fixture(t);
  for (const consentVersion of [undefined, "", "not a version", "x".repeat(41), null]) {
    const inquiry = { ...fields, pagePath: "/ru/", consentVersion, consent: true };
    assert.deepEqual(validation.validateSiteInquiry(inquiry), { ok: false, code: "invalid_inquiry" });
    const response = await call(f.handler, postRequest(envelope(inquiry)));
    assert.equal(response.status, 400);
    assert.deepEqual(response.payload, { success: false, code: "invalid_inquiry" });
  }
  assert.equal(f.verifications(), 0); assert.equal(f.attempts.length, 0);
});

test("safe control: storage refusal after a version change never relabels the old submission or reports success", async t => {
  const f = fixture(t);
  const rendered = await f.render();
  assert.equal(rendered.status, 200);
  f.site.consent_version = versions[1];
  const sent = await submitRenderedForm(rendered.html, f.handler);
  assert.equal(sent.body.inquiry.consentVersion, versions[0]);
  assert.equal(f.attempts.length, 1); assert.deepEqual(f.attempts[0]!.p_inquiry, sent.body.inquiry);
  assert.equal(f.saved.length, 0); assert.equal(f.verifications(), 1);
  assert.equal(sent.response.status, 503);
  assert.deepEqual(sent.response.payload, { success: false, code: "intake_unavailable" });
  assert.equal(sent.dataset.sent, undefined); assert.equal(sent.fieldset.disabled, false);
});
