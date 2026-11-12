import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { crmTransportOffenders } from "./crm-transport-audit";
import { reviewedScopedTransports } from "./reviewed-scoped-transports";

const model = "lib/siteInquiryDeletion.ts";
const component = "components/crm/site-inquiry-deletion.tsx";
const page = "pages/LeadsPage.tsx";
const recovery = "components/crm/site-deletion-recovery.tsx";
const sources = new Map<string, string>();
for (const file of [model, component, page, recovery]) {
  sources.set(file, await readFile(new URL(`../../artifacts/negis/src/${file}`, import.meta.url), "utf8"));
}

function mutate(file: string, from: string, to: string, base: ReadonlyMap<string, string> = sources) {
  const changed = new Map(base);
  const source = changed.get(file)!;
  assert.ok(source.includes(from), "mutation must change the current source");
  changed.set(file, source.replace(from, to));
  return changed;
}

test("actual deletion composition passes only with the authenticated transport", () => {
  assert.deepEqual(crmTransportOffenders(sources), []);
});

for (const [name, file, from, to] of [
  ["bare fetch prop", page, "request={access.deletionRequest}", "request={fetch}"],
  ["missing prop", page, "request={access.deletionRequest}", ""],
  ["spread override", page, "request={access.deletionRequest}", "request={access.deletionRequest} {...unsafeProps}"],
  ["duplicate prop", page, "request={access.deletionRequest}", "request={access.deletionRequest} request={fetch}"],
  ["fake API import", page, 'from "@/lib/api"', 'from "@/lib/not-authenticated"'],
  ["shadowed helper", page, "request={access.deletionRequest}", "request={(() => { const crmFetch = fetch; return crmFetch; })()}"],
  ["unsafe forwarding", component, "createSiteInquiryDeletion(workspaceId, leadId, request,", "createSiteInquiryDeletion(workspaceId, leadId, fetch,"],
  ["default bare fetch", model, "request: DeletionRequest,", "request: DeletionRequest = fetch,"],
  ["reassigned request", model, "const response = await request(base,", "request = fetch; const response = await request(base,"],
  ["direct preview fetch", model, "await request(`/api/crm/", "await fetch(`/api/crm/"],
  ["direct mutation fetch", model, "await request(base,", "await fetch(base,"],
] as const) {
  test(`injected transport audit rejects ${name}`, () => {
    assert.notDeepEqual(crmTransportOffenders(mutate(file, from, to)), []);
  });
}

for (const [name, extra] of [
  ["second mount", 'import { SiteInquiryDeletion } from "@/components/crm/site-inquiry-deletion"; export const Unsafe = () => <SiteInquiryDeletion request={fetch} />;'],
  ["direct factory caller", 'import { createSiteInquiryDeletion } from "@/lib/siteInquiryDeletion"; createSiteInquiryDeletion(workspace, lead, fetch, key);'],
  ["aliased factory", 'import { createSiteInquiryDeletion as build } from "@/lib/siteInquiryDeletion"; build(workspace, lead, fetch, key);'],
  ["namespace factory", 'import * as flow from "@/lib/siteInquiryDeletion"; flow.createSiteInquiryDeletion(workspace, lead, fetch, key);'],
  ["reexport", 'export * from "@/lib/siteInquiryDeletion";'],
  ["unrelated injected request", 'function unrelated(request: Function) { return request("/api/crm/leads"); }'],
  ["bare fetch in nested component", 'fetch("/api/crm/leads");'],
] as const) {
  test(`transport audit rejects ${name} elsewhere in the app`, () => {
    assert.notDeepEqual(crmTransportOffenders(new Map([...sources, ["components/crm/unsafe.tsx", extra]])), []);
  });
}

test("original direct and wrapper CRM checks remain enforced", () => {
  const safe = 'import { crmFetch } from "@/lib/api"; async function read(path: string) { return crmFetch(path); } read("/api/crm/leads");';
  assert.deepEqual(crmTransportOffenders(new Map([["pages/safe.ts", safe]])), []);
  for (const source of [
    'fetch("/api/crm/leads");',
    'async function crmRequest(path: string) { return fetch(path); } crmRequest("/api/crm/leads");',
    'const request = fetch; request("/api/crm/leads");',
  ]) assert.notDeepEqual(crmTransportOffenders(new Map([["pages/unsafe.ts", source]])), []);
});

test("arrow wrappers delegate to the real helper, not a comment or neighboring function", () => {
  const authenticated = 'import { crmFetch } from "@/lib/api"; const write = async (path: string) => crmFetch(path); write("/api/crm/doctor-schedule");';
  assert.deepEqual(crmTransportOffenders(new Map([["components/admin/test.ts", authenticated]])), []);
  for (const source of [
    authenticated.replace("=> crmFetch(path)", "=> fetch(path)"),
    'import { crmFetch } from "@/lib/api"; function write(path: string) { /* crmFetch(path) */ return fetch(path); } write("/api/crm/leads");',
    'import { crmFetch } from "@/lib/api"; function write(path: string) { return fetch(path); } function safe(path: string) { return crmFetch(path); } write("/api/crm/leads");',
    'import { crmFetch } from "@/lib/api"; function write(path: string) { crmFetch(path); return fetch(path); } write("/api/crm/leads");',
  ]) assert.notDeepEqual(crmTransportOffenders(new Map([["components/admin/test.ts", source]])), []);
});

test("a comment describing the reviewed composition cannot bless a replaced prop", () => {
  const changed = mutate(page, "request={access.deletionRequest}", "request={fetch}");
  changed.set(page, changed.get(page)! + "\n// <SiteInquiryDeletion request={access.deletionRequest} />\n");
  assert.notDeepEqual(crmTransportOffenders(changed), []);
});

for (const [label, file, from, to] of [
  ["raw guarded request", page, "await crmFetch(path, { ...init,", "await fetch(path, { ...init,"],
  ["missing actor", page, "expectedUserId: actorId,", ""],
  ["forged actor", page, "expectedUserId: actorId,", "expectedUserId: otherActor,"],
  ["late options override", page, "dispatchGuard: isDispatchCurrent });", "dispatchGuard: isDispatchCurrent, ...init });"],
  ["weakened caller guard", page, "dispatchGuard() && !init?.signal?.aborted", "true && !init?.signal?.aborted"],
  ["missing input guard", page, "&& (init?.dispatchGuard?.() ?? true)", ""],
  ["wrong workspace fence", page, "readWorkspaceId() === workspaceId", "readWorkspaceId() !== workspaceId"],
  ["ordinary rather than deletion lifetime", page, "requestWithGuard(path, init, deletionLifetime.isCurrent)", "requestWithGuard(path, init, isCurrent)"],
  ["unguarded content", page, "<LeadsPageContent key={lifetime.epoch} access={access}", "<LeadsPageContent key={lifetime.epoch} access={unsafe}"],
  ["raw recovery request", recovery, "owner.request(path,", "fetch(path,"],
  ["missing recovery dispatch fence", recovery, "dispatchGuard: owner.isCurrent", "dispatchGuard: () => true"],
  ["missing recovery actor check", recovery, "parseSiteDeletionOperations(body, owner.workspaceId, owner.actorId)", "parseSiteDeletionOperations(body, owner.workspaceId, otherActor)"],
] as const) {
  test(`reviewed deletion receipt rejects ${label}`, () => {
    const changed = mutate(file, from, to);
    assert.ok(reviewedScopedTransports(changed).failures.has(file));
    assert.notDeepEqual(crmTransportOffenders(changed), []);
  });
}

for (const tag of ["SiteDeletionRecovery", "SiteInquiryDeletion"]) {
  test(`both deletion consumers are checked independently: ${tag}`, () => {
    const source = sources.get(page)!;
    const start = source.indexOf("<" + tag);
    assert.ok(start > 0);
    const tail = source.slice(start);
    assert.ok(tail.includes("request={access.deletionRequest}"));
    const changed = new Map(sources).set(page, source.slice(0, start)
      + tail.replace("request={access.deletionRequest}", "request={fetch}"));
    assert.ok(reviewedScopedTransports(changed).failures.has(page));
    assert.notDeepEqual(crmTransportOffenders(changed), []);
  });
}

for (const missing of sources.keys()) {
  test(`reviewed deletion receipt requires the complete source chain: ${missing}`, () => {
    const changed = new Map(sources); changed.delete(missing);
    assert.ok(reviewedScopedTransports(changed).failures.size > 0);
    assert.notDeepEqual(crmTransportOffenders(changed), []);
  });
}

for (const [label, extra] of [
  ["recovery mount", 'import { SiteDeletionRecovery } from "@/components/crm/site-deletion-recovery"; const unsafe = <SiteDeletionRecovery request={fetch} />;'],
  ["dynamic import", 'const unsafe = import("@/lib/siteInquiryDeletion");'],
  ["require import", 'const unsafe = require("@/lib/siteInquiryDeletion");'],
  ["relative import", 'import { createSiteInquiryDeletion } from "../../lib/siteInquiryDeletion";'],
  ["JavaScript extension import", 'import { createSiteInquiryDeletion } from "@/lib/siteInquiryDeletion.js";'],
  ["TypeScript extension import", 'import { createSiteInquiryDeletion } from "@/lib/siteInquiryDeletion.ts";'],
  ["type specifier plus runtime alias", 'import { type DeletionRequest, createSiteInquiryDeletion as unsafe } from "@/lib/siteInquiryDeletion";'],
  ["type specifier plus default import", 'import unsafe, { type DeletionRequest } from "@/lib/siteInquiryDeletion";'],
  ["named reexport", 'export { createSiteInquiryDeletion } from "@/lib/siteInquiryDeletion";'],
] as const) {
  test(`reviewed deletion closure rejects additional ${label}`, () => {
    assert.notDeepEqual(crmTransportOffenders(new Map(sources).set("components/crm/unsafe.tsx", extra)), []);
  });
}

test("type-only imports do not create another deletion transport consumer", () => {
  const extra = 'import type { DeletionRequest as RequestType } from "@/lib/siteInquiryDeletion"; export type { DeletionLifetime } from "@/lib/siteInquiryDeletion";';
  assert.deepEqual(crmTransportOffenders(new Map(sources).set("components/crm/types.ts", extra)), []);
});

test("reviewed receipts normalize only line endings, not comments or changed code", () => {
  const lf = new Map([...sources].map(([file, source]) => [file, source.replace(/\r\n/g, "\n")]));
  const crlf = new Map([...lf].map(([file, source]) => [file, source.replace(/\n/g, "\r\n")]));
  assert.deepEqual(crmTransportOffenders(lf), []);
  assert.deepEqual(crmTransportOffenders(crlf), []);
  lf.set(page, lf.get(page)! + "\n// Any edit needs source re-review.\n");
  assert.ok(reviewedScopedTransports(lf).failures.has(page));
});

test("reviewed deletion admission is limited to the two literal call positions", () => {
  const reviewed = reviewedScopedTransports(sources);
  assert.deepEqual([...reviewed.failures], []);
  assert.deepEqual([...reviewed.calls.keys()], [model]);
  assert.equal(reviewed.calls.get(model)?.size, 2);
  for (const file of sources.keys()) {
    const changed = new Map(sources).set(file, sources.get(file)!
      + '\nfunction unsafe(request: Function) { return request("/api/crm/leads"); }');
    assert.notDeepEqual(crmTransportOffenders(changed), []);
  }
});

const controlFile = "pages/AiControlCenter.tsx";
const controlSource = await readFile(new URL(`../../artifacts/negis/src/${controlFile}`, import.meta.url), "utf8");
const controlSources = new Map([[controlFile, controlSource]]);

test("actual AI control lifetime admits exactly its four reviewed literal CRM calls", () => {
  const reviewed = reviewedScopedTransports(controlSources);
  assert.deepEqual([...reviewed.failures], []);
  assert.equal(reviewed.calls.get(controlFile)?.size, 4);
  assert.deepEqual(crmTransportOffenders(controlSources), []);
});

for (const [label, from, to] of [
  ["raw transport", "await crmFetch(path, {", "await fetch(path, {"],
  ["fake API import", 'from "@/lib/api"', 'from "@/lib/not-authenticated"'],
  ["missing actor", "expectedUserId: actorId,", ""],
  ["late option override", "dispatchGuard: isCurrent,", "dispatchGuard: isCurrent, ...init,"],
  ["weakened dispatch fence", "dispatchGuard: isCurrent,", "dispatchGuard: () => true,"],
  ["missing source lifetime", "if (!isCurrent() || localDemo)", "if (localDemo)"],
  ["no auth retirement", "if ([401, 403].includes(response.status))", "if (false)"],
  ["no late-response check", 'if (!isCurrent()) throw new DOMException("Control view changed", "AbortError");', ""],
  ["raw nested read", "request: (path, init) => access.request(path,", "request: (path, init) => fetch(path,"],
  ["unscoped fetchJson", "const response = await access.request(path);", "const response = await fetch(path);"],
  ["remoteRead bypass", ": fetchJson(readAccess, path);", ": fetch(path);"],
  ["exported private session", "function AiControlSession(", "export function AiControlSession("],
  ["unsafe session prop", "access={access}", "access={unsafe}"],
  ["duplicate session prop", "access={access}", "access={access} access={unsafe}"],
  ["spread session override", "access={access}", "access={access} {...unsafe}"],
] as const) {
  test(`reviewed AI control receipt rejects ${label}`, () => {
    const changed = mutate(controlFile, from, to, controlSources);
    assert.ok(reviewedScopedTransports(changed).failures.has(controlFile));
    assert.notDeepEqual(crmTransportOffenders(changed), []);
  });
}

test("AI control's receipt cannot bless a new request or a comment decoy", () => {
  const extra = '\nfunction unsafe(request: Function) { return request("/api/crm/leads"); }';
  const changed = new Map(controlSources).set(controlFile, controlSource + extra);
  assert.notDeepEqual(crmTransportOffenders(changed), []);
  assert.notDeepEqual(crmTransportOffenders(new Map([...controlSources, ["pages/unsafe.ts", extra]])), []);
  const decoy = mutate(controlFile, "await crmFetch(path, {", "await fetch(path, {", controlSources);
  decoy.set(controlFile, decoy.get(controlFile)! + "\n// await crmFetch(path, init);\n");
  assert.notDeepEqual(crmTransportOffenders(decoy), []);
});

const adminFile = 'pages/AdminCenter.tsx';
const adminSource = await readFile(new URL(`../../artifacts/negis/src/${adminFile}`, import.meta.url), 'utf8');
test('actual session-bound admin transport is traced without a global injected-request exemption', () => {
  assert.deepEqual(crmTransportOffenders(new Map([[adminFile, adminSource]])), []);
});
for (const [name, from, to] of [
  ['raw network wrapper', 'await sendCrmFetch(path,', 'await fetch(path,'],
  ['wrong API import', 'from "@/lib/api"', 'from "@/lib/not-authenticated"'],
  ['unsafe injected field', 'assertCurrent, request, releaseResponse', 'assertCurrent, request: fetch, releaseResponse'],
  ['duplicate injected field', 'assertCurrent, request, releaseResponse', 'assertCurrent, request, request: fetch, releaseResponse'],
  ['object spread override', 'assertCurrent, request, releaseResponse', 'assertCurrent, request, releaseResponse, ...unsafe'],
  ['JSX spread override', 'key={lifetime.epoch} access=', 'key={lifetime.epoch} {...unsafe} access='],
  ['untrusted content alias', 'const crmFetch = access.request;', 'const crmFetch = fetch;'],
  ['reassigned injected request', 'const crmFetch = access.request;', 'access.request = fetch; const crmFetch = access.request;'],
] as const) {
  test(`admin transport composition rejects ${name}`, () => {
    assert.ok(adminSource.includes(from));
    assert.notDeepEqual(crmTransportOffenders(new Map([[adminFile, adminSource.replace(from, to)]])), []);
  });
}
test('another admin content caller cannot inject bare fetch', () => {
  assert.notDeepEqual(crmTransportOffenders(new Map([[adminFile, adminSource],
    ['components/unsafe.tsx', 'const Unsafe = () => <AdminCenterContent access={{ request: fetch }} />;']])), []);
});

const uploadHelper = "lib/verified-creative-upload.ts";
const adsUploadCaller = "pages/AdsAutomation.tsx";
const studioUploadCaller = "pages/ContentStudio.tsx";
const uploadSources = new Map<string, string>();
for (const file of [uploadHelper, adsUploadCaller, studioUploadCaller]) {
  uploadSources.set(file, await readFile(new URL(`../../artifacts/negis/src/${file}`, import.meta.url), "utf8"));
}
const rejectsUploadTransport = (changed: ReadonlyMap<string, string>) => {
  const offenders = crmTransportOffenders(changed);
  assert.ok(offenders.some((entry) => entry.startsWith(uploadHelper + ":")), offenders.join("\n"));
};

test("actual image helper's two request calls bind through both callers to crmFetch", () => {
  assert.deepEqual(crmTransportOffenders(uploadSources), []);
});

for (const [label, file, from, to] of [
  ["callback removal", adsUploadCaller, "request: async (url, init) =>", "unused: async (url, init) =>"],
  ["callback removal", studioUploadCaller, "request: async (url, init) =>", "unused: async (url, init) =>"],
  ["raw callback", studioUploadCaller, "const response = await crmFetch(url,", "const response = await fetch(url,"],
  ["raw session wrapper", adsUploadCaller, "await crmRequest<T>(path,", "await fetch(path,"],
  ["raw API wrapper", adsUploadCaller, "const response = await crmFetch(path, init);", "const response = await fetch(path, init);"],
  ["removed URL forwarding", adsUploadCaller, "await sessionRequest(session, url, init,", 'await sessionRequest(session, "/unrelated", init,'],
  ["removed URL forwarding", studioUploadCaller, "await crmFetch(url,", 'await crmFetch("/unrelated",'],
  ["fake API import", adsUploadCaller, 'from "@/lib/api"', 'from "@/lib/not-authenticated"'],
  ["fake API import", studioUploadCaller, 'from "@/lib/api"', 'from "@/lib/not-authenticated"'],
  ["fake helper import", adsUploadCaller, 'from "@/lib/verified-creative-upload"', 'from "@/lib/not-the-upload-helper"'],
  ["fake helper import", studioUploadCaller, 'from "@/lib/verified-creative-upload"', 'from "@/lib/not-the-upload-helper"'],
  ["shadowed callback target", studioUploadCaller, "const response = await crmFetch(url,", "const crmFetch = fetch; const response = await crmFetch(url,"],
  ["shadowed session wrapper", adsUploadCaller, "const body = await sessionRequest(session, url,", "const sessionRequest = fetch; const body = await sessionRequest(session, url,"],
  ["URL escape", adsUploadCaller, "const body = await sessionRequest(session, url,", "steal(url); const body = await sessionRequest(session, url,"],
  ["captured transport default", uploadHelper, "requestKey, request, upload", "requestKey, request = fetch, upload"],
  ["mutable capture", uploadHelper, "const { workspaceId, file, fileName, mimeType, requestKey, request, upload, assertCurrent } = attempt;",
    "let { workspaceId, file, fileName, mimeType, requestKey, request, upload, assertCurrent } = attempt;"],
  ["mutable snapshot", uploadHelper, "const attempt = { ...input };", "let attempt = { ...input };"],
  ["snapshot override", uploadHelper, "const attempt = { ...input };", "const attempt = { ...input, request: fetch };"],
  ["input replacement before capture", uploadHelper, "const attempt = { ...input };", "input.request = fetch; const attempt = { ...input };"],
  ["snapshot replacement before capture", uploadHelper, "const { workspaceId, file, fileName, mimeType, requestKey, request, upload, assertCurrent } = attempt;",
    "Object.assign(attempt, { request: fetch }); const { workspaceId, file, fileName, mimeType, requestKey, request, upload, assertCurrent } = attempt;"],
  ["transport reassignment", uploadHelper, "let signed: unknown;", "request = fetch; let signed: unknown;"],
  ["transport alias escape", uploadHelper, "let signed: unknown;", "const stolen = request; let signed: unknown;"],
  ["direct helper fetch", uploadHelper, "await request(`/api/crm/ad-creatives/signed-upload", "await fetch(`/api/crm/ad-creatives/signed-upload"],
] as const) {
  test(`object injection rejects ${label} in ${file}`, () => {
    rejectsUploadTransport(mutate(file, from, to, uploadSources));
  });
}

for (const file of [adsUploadCaller, studioUploadCaller]) {
  for (const [label, from, to] of [
    ["spread before callback", "request: async (url, init) =>", "...unsafe, request: async (url, init) =>"],
    ["spread after callback", "upload: async (bucket, path, token,", "...unsafe, upload: async (bucket, path, token,"],
    ["duplicate request", "request: async (url, init) =>", "request: fetch, request: async (url, init) =>"],
    ["computed request override", "upload: async (bucket, path, token,", '["request"]: fetch, upload: async (bucket, path, token,'],
  ] as const) {
    test(`object injection rejects ${label} in ${file}`, () => rejectsUploadTransport(mutate(file, from, to, uploadSources)));
  }
}

test("a helper without its caller implementations has no transport proof", () => {
  rejectsUploadTransport(new Map([[uploadHelper, uploadSources.get(uploadHelper)!]]));
});

for (const [label, extra] of [
  ["unsafe additional caller", 'import { uploadVerifiedCreativeImage } from "@/lib/verified-creative-upload"; uploadVerifiedCreativeImage({ request: fetch });'],
  ["unsafe aliased caller", 'import { uploadVerifiedCreativeImage as write } from "@/lib/verified-creative-upload"; write({ request: fetch });'],
  ["namespace caller", 'import * as upload from "@/lib/verified-creative-upload"; upload.uploadVerifiedCreativeImage({ request: fetch });'],
  ["dynamic caller", 'const upload = import("@/lib/verified-creative-upload");'],
  ["reexport", 'export * from "@/lib/verified-creative-upload";'],
  ["helper escape", 'import { uploadVerifiedCreativeImage } from "@/lib/verified-creative-upload"; const stolen = uploadVerifiedCreativeImage;'],
] as const) {
  test(`object injection rejects ${label}`, () => rejectsUploadTransport(new Map(uploadSources).set("pages/unsafe-upload.ts", extra)));
}

test("comments cannot replace a removed authenticated upload edge", () => {
  const changed = mutate(studioUploadCaller, "await crmFetch(url,", "await fetch(url,", uploadSources);
  changed.set(studioUploadCaller, changed.get(studioUploadCaller)! + "\n// await crmFetch(url, init);\n");
  rejectsUploadTransport(changed);
});

for (const file of [uploadHelper, adsUploadCaller, studioUploadCaller, "lib/unsafe-upload.ts"]) {
  test(`object transport proof never exempts unrelated request calls in ${file}`, () => {
    const changed = new Map(uploadSources).set(file, (uploadSources.get(file) ?? "")
      + '\nfunction Unsafe(request: Function) { return request("/api/crm/leads"); }');
    assert.ok(crmTransportOffenders(changed).some((entry) => entry.startsWith(file + ":")));
  });
}

const genericInjection = new Map([
  ["lib/injected-operation.ts", `export async function perform(options: Options) {
    const captured = { ...options };
    const { dispatch: send } = captured;
    return send("/api/crm/example");
  }`],
  ["pages/injected-parent.ts", `import { perform as execute } from "@/lib/injected-operation";
    import { crmFetch as authenticated } from "@/lib/api";
    async function forward(scope: string, endpoint: string) { return authenticated(endpoint); }
    execute({ dispatch: async (target: string) => forward("scope", target) });`],
]);

test("object transport proof is structural, not tied to upload file, function or receiver names", () => {
  assert.deepEqual(crmTransportOffenders(genericInjection), []);
});
for (const [label, from, to] of [
  ["dead authenticated edge", "return authenticated(endpoint);", "if (false) return authenticated(endpoint); return unsafe;"],
  ["early synthetic return", "return authenticated(endpoint);", "if (cached) return synthetic; return authenticated(endpoint);"],
  ["wrong forwarded argument", "forward(\"scope\", target)", "forward(target, \"unrelated\")"],
  ["raw branch beside authenticated edge", "return authenticated(endpoint);", 'if (other) fetch("/unrelated"); return authenticated(endpoint);'],
  ["global fetch beside authenticated edge", "return authenticated(endpoint);", 'globalThis.fetch("/unrelated"); return authenticated(endpoint);'],
  ["replaced authenticated import", "return authenticated(endpoint);", "authenticated = unsafe; return authenticated(endpoint);"],
] as const) {
  test(`generic object transport proof rejects ${label}`, () => {
    assert.notDeepEqual(crmTransportOffenders(mutate("pages/injected-parent.ts", from, to, genericInjection)), []);
  });
}

const mortgage = "lib/mortgage-workspace.tsx";
const mortgageAnalytics = "pages/MortgageAnalytics.tsx";
const mortgageResults = "components/mortgage/MortgageResults.tsx";
const contractPanel = "components/mortgage/MortgageContractPanel.tsx";
const mortgageSources = new Map<string, string>();
for (const file of [mortgage, mortgageAnalytics, mortgageResults]) {
  mortgageSources.set(file, await readFile(new URL(`../../artifacts/negis/src/${file}`, import.meta.url), "utf8"));
}

test("actual mortgage context, hook mutations and analytics delegate to actor-bound crmFetch", () => {
  assert.deepEqual(crmTransportOffenders(mortgageSources), []);
  assert.deepEqual(crmTransportOffenders(new Map([[mortgage, mortgageSources.get(mortgage)!]])), []);
});

for (const [name, file, from, to] of [
  ["raw session fetch", mortgage, "await crmFetch(path,", "await fetch(path,"],
  ["fake API import", mortgage, 'from "@/lib/api"', 'from "@/lib/not-authenticated"'],
  ["fake auth import", mortgage, 'from "@/contexts/AuthContext"', 'from "@/contexts/ForgedContext"'],
  ["forged auth source", mortgage, "= useAuth();", "= unsafeAuth();"],
  ["reassigned memo hook", mortgage, "const captured = useRef(scope).current;", "const captured = useRef(scope).current; useMemo = unsafeMemo;"],
  ["memo factory shadows captured actor", mortgage, "useMemo<Access | null>(() =>", "useMemo<Access | null>((captured = unsafeScope) =>"],
  ["shadowed authenticated helper", mortgage, "const captured = useRef(scope).current;", "const captured = useRef(scope).current; const crmFetch = fetch;"],
  ["missing actor binding", mortgage, "expectedUserId: captured.actorId,", ""],
  ["forged actor binding", mortgage, "expectedUserId: captured.actorId,", 'expectedUserId: "foreign-actor",'],
  ["actor overridden after binding", mortgage, "expectedUserId: captured.actorId, signal", 'expectedUserId: captured.actorId, signal, ...init'],
  ["duplicate actor option", mortgage, "expectedUserId: captured.actorId, signal", 'expectedUserId: captured.actorId, expectedUserId: "foreign-actor", signal'],
  ["weakened current-scope check", mortgage, "live.current.workspaceId === captured.workspaceId", "true"],
  ["missing dispatch guard", mortgage, "if (!isCurrent()) throw ended();", ""],
  ["missing response guard", mortgage, "if (!isCurrent()) throw ended();\n      if (response.status", "if (response.status"],
  ["missing no-store", mortgage, 'cache: "no-store",', ""],
  ["missing session cancellation", mortgage, "&& !controller.signal.aborted", ""],
  ["missing denial invalidation", mortgage, "controller.abort();\n        setRevoked", "setRevoked"],
  ["forged scope identity", mortgage, 'user?.id || ""', '"foreign-actor"'],
  ["wrong captured scope", mortgage, "useRef(scope).current", "useRef(unsafeScope).current"],
  ["mutable captured identity", mortgage, "const captured = useRef(scope).current;", 'const captured = useRef(scope).current; captured.actorId = "foreign-actor";'],
  ["mutable source identity", mortgage, "const live = useRef(scope);", 'scope.actorId = "foreign-actor"; const live = useRef(scope);'],
  ["scope prop replacement", mortgage, "scope={scope} live={live}", "scope={unsafeScope} live={live}"],
  ["session prop spread", mortgage, "scope={scope} live={live}", "scope={scope} live={live} {...unsafe}"],
  ["exported private session", mortgage, "function MortgageSession(", "export function MortgageSession("],
  ["exported private context", mortgage, "const MortgageContext =", "export const MortgageContext ="],
  ["aliased context export", mortgage, "const MortgageContext =", "export { MortgageContext as UnsafeContext }; const MortgageContext ="],
  ["untrusted context default", mortgage, "createContext<Access | null>(null)", "createContext<Access | null>(unsafeAccess)"],
  ["provider transport replacement", mortgage, "value={access}", "value={{ ...access, request: fetch }}"],
  ["duplicate provider value", mortgage, "value={access}", "value={access} value={unsafeAccess}"],
  ["provider spread override", mortgage, "value={access}", "value={access} {...unsafe}"],
  ["hook consumes wrong context", mortgage, "useContext(MortgageContext)", "useContext(OtherContext)"],
  ["hook replaces context value", mortgage, "const access = useContext(MortgageContext);", "const access = { request: fetch };"],
  ["shadowed context hook", mortgage, "const access = useContext(MortgageContext);", "const useContext = () => unsafeAccess; const access = useContext(MortgageContext);"],
  ["hook transport reassignment", mortgage, "const access = useContext(MortgageContext);", "const access = useContext(MortgageContext); access.request = fetch;"],
  ["hook transport object override", mortgage, "const access = useContext(MortgageContext);", "const access = useContext(MortgageContext); Object.assign(access, { request: fetch });"],
  ["hook transport escape", mortgage, "const access = useContext(MortgageContext);", "const access = useContext(MortgageContext); const stolen = access.request;"],
  ["response helper mutates transport", mortgage, "if (!access.isCurrent()) throw ended();", "access.request = fetch; if (!access.isCurrent()) throw ended();"],
  ["unsafe conditional hook return", mortgage, "const access = useContext(MortgageContext);", "if (unsafe) return { request: fetch }; const access = useContext(MortgageContext);"],
  ["reassigned exported hook", mortgage, "const MortgageContext =", "useMortgageWorkspace = unsafeHook; const MortgageContext ="],
  ["raw mutation fetch", mortgage, "await access.request(`${endpoint}?workspaceId=", "await fetch(`${endpoint}?workspaceId="],
  ["raw snapshot fetch", mortgage, "await access.request(path,", "await fetch(path,"],
  ["raw snapshot fetch with authenticated decoy", mortgage, "const response = await access.request(path,", "await access.request(path, { signal: controller.signal }); const response = await fetch(path,"],
  ["raw contact search", mortgage, "await access.request(`/api/crm/", "await fetch(`/api/crm/"],
  ["raw lead-stage fetch", mortgage, "await access.request(`/api/crm/lead-stages?", "await fetch(`/api/crm/lead-stages?"],
  ["foreign lead-stage workspace", mortgage, "access.request(`/api/crm/lead-stages?workspaceId=${encodeURIComponent(access.workspaceId)}`)", 'access.request(`/api/crm/lead-stages?workspaceId=${encodeURIComponent("foreign-workspace")}`)'],
  ["unsafe hook return", mortgage, "request: access.request, isCurrent:", "request: fetch, isCurrent:"],
  ["duplicate hook transport", mortgage, "request: access.request, isCurrent:", "request: access.request, request: fetch, isCurrent:"],
  ["hook return spread override", mortgage, "request: access.request, isCurrent: access.isCurrent,", "request: access.request, isCurrent: access.isCurrent, ...unsafe,"],
  ["fake consumer hook import", mortgageAnalytics, 'from "@/lib/mortgage-workspace"', 'from "@/lib/not-scoped"'],
  ["reassigned consumer hook", mortgageAnalytics, "const workspace = useMortgageWorkspace({ days });", "useMortgageWorkspace = unsafeHook; const workspace = useMortgageWorkspace({ days });"],
  ["untrusted consumer object", mortgageAnalytics, "const workspace = useMortgageWorkspace({ days });", "const workspace = unsafeWorkspace;"],
  ["default consumer request", mortgageAnalytics, "{ isCurrent, request } = workspace", "{ isCurrent, request = fetch } = workspace"],
  ["consumer transport override", mortgageAnalytics, "const { isCurrent, request } = workspace;", "workspace.request = fetch; const { isCurrent, request } = workspace;"],
  ["consumer object override", mortgageAnalytics, "const { isCurrent, request } = workspace;", "Object.assign(workspace, { request: fetch }); const { isCurrent, request } = workspace;"],
  ["consumer transport alias", mortgageAnalytics, "const { isCurrent, request } = workspace;", "const { isCurrent, request } = workspace; const alias = request;"],
  ["raw analytics fetch", mortgageAnalytics, "=> request(`/api/crm/", "=> fetch(`/api/crm/"],
  ["shadowed analytics request", mortgageAnalytics, "(period: number) => request(", "(request: any) => request("],
] as const) {
  test(`scoped mortgage transport rejects ${name}`, () => {
    const offenders = crmTransportOffenders(mutate(file, from, to, mortgageSources));
    assert.ok(offenders.some((entry) => entry.includes("unverified scoped mortgage transport chain")), offenders.join("\n"));
  });
}

test("analytics cannot prove its transport without the hook implementation", () => {
  assert.notDeepEqual(crmTransportOffenders(new Map([[mortgageAnalytics, mortgageSources.get(mortgageAnalytics)!]])), []);
});

test("a comment with the original mortgage transport cannot prove a replaced wrapper", () => {
  const changed = mutate(mortgage, "await crmFetch(path,", "await fetch(path,", mortgageSources);
  changed.set(mortgage, changed.get(mortgage)! + "\n// await crmFetch(path, { expectedUserId: captured.actorId });\n");
  assert.notDeepEqual(crmTransportOffenders(changed), []);
});

for (const file of [mortgage, mortgageAnalytics, "components/mortgage/unsafe.tsx"]) {
  for (const [name, extra] of [
    ["unrelated request", 'function Unsafe(request: Function) { return request("/api/crm/leads"); }'],
    ["unrelated mutate", 'function Unsafe(mutate: Function) { return mutate("/api/crm/leads"); }'],
    ["raw fetch", 'fetch("/api/crm/leads");'],
    ["unverified object request", 'const unsafe = { request: fetch }; unsafe.request("/api/crm/leads");'],
  ] as const) {
    test(`mortgage proof does not exempt ${name} in ${file}`, () => {
      const changed = new Map(mortgageSources);
      changed.set(file, (changed.get(file) ?? "") + "\n" + extra);
      assert.ok(crmTransportOffenders(changed).some((entry) => entry.startsWith(file + ":")));
    });
  }
}

const activityDialog = "components/mortgage/ActivityDialog.tsx";
const contactForm = "components/mortgage/MortgageContactForm.tsx";
const calendar = "pages/MortgageCalendar.tsx";
const tasks = "pages/MortgageTasks.tsx";
const clients = "pages/MortgageClients.tsx";
const contactDetail = "components/mortgage/MortgageContactDetail.tsx";
const boundSources = new Map(mortgageSources);
for (const file of [activityDialog, contactForm, calendar, tasks, clients, contactDetail, contractPanel]) {
  boundSources.set(file, await readFile(new URL(`../../artifacts/negis/src/${file}`, import.meta.url), "utf8"));
}
const rejectsBoundTransport = (changed: ReadonlyMap<string, string>) => {
  const offenders = crmTransportOffenders(changed);
  assert.ok(offenders.some((entry) => entry.includes("unverified scoped mortgage transport chain")), offenders.join("\n"));
};

test("actual activity forwarding and both contact-form parents use the verified mortgage session", () => {
  assert.deepEqual(crmTransportOffenders(boundSources), []);
});

for (const [file, name, parent, initializer] of [
  [mortgageResults, "MortgageResults", mortgageAnalytics, "const workspace = useMortgageWorkspace({ days });"],
  [contractPanel, "MortgageContractPanel", contactDetail, "const workspace = useMortgageWorkspace({ leadId });"],
] as const) {
  for (const [label, from, to] of [
    ["fake parent hook", initializer, initializer.replace("useMortgageWorkspace", "unsafeHook")],
    ["parent transport escape", initializer, `${initializer} const stolen = workspace.request;`],
    ["fetch prop", "request={workspace.request}", "request={fetch}"],
    ["spread before prop", "request={workspace.request}", "{...unsafeProps} request={workspace.request}"],
    ["spread after prop", "request={workspace.request}", "request={workspace.request} {...unsafeProps}"],
    ["duplicate prop", "request={workspace.request}", "request={workspace.request} request={fetch}"],
    ["aliased import", `import { ${name} }`, `import { ${name} as Unsafe }`],
  ] as const) {
    test(`outcomes ${name} rejects ${label}`, () => {
      // ContactDetail has another request prop; target the outcomes mount itself.
      const source = boundSources.get(parent)!;
      const mount = source.indexOf(`<${name} `);
      const changed = from.startsWith("request=")
        ? new Map(boundSources).set(parent, source.slice(0, mount) + source.slice(mount).replace(from, to))
        : mutate(parent, from, to, boundSources);
      assert.notEqual(changed.get(parent), source);
      rejectsBoundTransport(changed);
    });
  }
  for (const [label, extra] of [
    ["extra parent", `import { ${name} } from "@/${file.replace(/\.tsx$/, "")}"; const Unsafe = () => <${name} request={fetch} />;`],
    ["aliased parent", `import { ${name} as Alias } from "@/${file.replace(/\.tsx$/, "")}"; const Unsafe = () => <Alias request={fetch} />;`],
    ["namespace parent", `import * as forms from "@/${file.replace(/\.tsx$/, "")}"; const Unsafe = () => <forms.${name} request={fetch} />;`],
    ["default parent", `import Alias from "@/${file.replace(/\.tsx$/, "")}"; const Unsafe = () => <Alias request={fetch} />;`],
    ["reexport", `export * from "@/${file.replace(/\.tsx$/, "")}";`],
    ["dynamic import", `const forms = import("@/${file.replace(/\.tsx$/, "")}");`],
  ] as const) {
    test(`outcomes ${name} rejects ${label}`, () => {
      rejectsBoundTransport(new Map(boundSources).set("components/unsafe-parent.tsx", extra));
    });
  }
  test(`outcomes ${name} rejects a second mount in its approved parent`, () => {
    rejectsBoundTransport(new Map(boundSources).set(parent, boundSources.get(parent)! + `\nfunction Unsafe() { return <${name} request={fetch} />; }`));
  });
  test(`outcomes ${name} requires its implementation`, () => {
    const changed = new Map(boundSources);
    changed.delete(file);
    rejectsBoundTransport(changed);
  });
}

for (const [label, file, from, to] of [
  ["default wrapper", contractPanel, "props: MortgageContractPanelProps)", "props: MortgageContractPanelProps = unsafeProps)"],
  ["wrong spread", contractPanel, "{...props}", "{...unsafeProps}"],
  ["extra spread", contractPanel, "{...props}", "{...props} {...unsafeProps}"],
  ["override after spread", contractPanel, "{...props}", "{...props} request={fetch}"],
  ["override before spread", contractPanel, "{...props}", "request={fetch} {...props}"],
  ["props escape", contractPanel, "return <MortgageContractSession", "const stolen = props; return <MortgageContractSession"],
  ["props request escape", contractPanel, "return <MortgageContractSession", "const stolen = props.request; return <MortgageContractSession"],
  ["default session request", contractPanel, "canVoid, request, isCurrent }", "canVoid, request = fetch, isCurrent }"],
  ["default session props", contractPanel, "isCurrent }: MortgageContractPanelProps)", "isCurrent }: MortgageContractPanelProps = unsafeProps)"],
  ["session request escape", contractPanel, "const headingId = useId();", "const stolen = request; const headingId = useId();"],
  ["session request replacement", contractPanel, "const headingId = useId();", "request = fetch; const headingId = useId();"],
  ["session dependency escape", contractPanel, "const headingId = useId();", "steal(null, [request]); const headingId = useId();"],
  ["session forged callback hook", contractPanel, 'from "react"', 'from "unsafe-react"'],
  ["raw session read", contractPanel, "await request(path, { signal:", "await fetch(path, { signal:"],
  ["raw session write", contractPanel, "await request(path, { method,", "await fetch(path, { method,"],
  ["shadowed session request", contractPanel, 'async function mutate(method: "POST"', 'async function mutate(request: any, method: "POST"'],
  ["exported session", contractPanel, "function MortgageContractSession(", "export function MortgageContractSession("],
  ["default results request", mortgageResults, "workspaceId, request, isCurrent }: MortgageResultsProps", "workspaceId, request = fetch, isCurrent }: MortgageResultsProps"],
  ["results request escape", mortgageResults, "const headingId = useId();", "const stolen = request; const headingId = useId();"],
  ["results request replacement", mortgageResults, "const headingId = useId();", "request = fetch; const headingId = useId();"],
  ["query fetch replacement", mortgageResults, "() => ({ workspaceId, request, isCurrent, days, refresh })", "() => ({ workspaceId, request: fetch, isCurrent, days, refresh })"],
  ["query duplicate request", mortgageResults, "() => ({ workspaceId, request, isCurrent, days, refresh })", "() => ({ workspaceId, request, request: fetch, isCurrent, days, refresh })"],
  ["query spread", mortgageResults, "() => ({ workspaceId, request, isCurrent, days, refresh })", "() => ({ workspaceId, request, isCurrent, days, refresh, ...unsafe })"],
  ["query memo alias", mortgageResults, "const query = useMemo(", "const query = unsafeMemo("],
  ["query fake memo import", mortgageResults, 'from "react"', 'from "unsafe-react"'],
  ["query mutable capture", mortgageResults, "const query = useMemo(", "let query = useMemo("],
  ["query reassignment", mortgageResults, "const latest = useRef(query);", "query.request = fetch; const latest = useRef(query);"],
  ["query object override", mortgageResults, "const latest = useRef(query);", "Object.assign(query, { request: fetch }); const latest = useRef(query);"],
  ["query request escape", mortgageResults, "const latest = useRef(query);", "const stolen = query.request; const latest = useRef(query);"],
  ["query object escape", mortgageResults, "const latest = useRef(query);", "steal(query); const latest = useRef(query);"],
  ["latest request escape", mortgageResults, "latest.current = query;", "latest.current = query; const stolen = latest.current.request;"],
  ["stored query escape", mortgageResults, "const headingId = useId();", "const stolen = state.query; const headingId = useId();"],
  ["stored request escape", mortgageResults, "const headingId = useId();", "const stolen = state.query?.request; const headingId = useId();"],
  ["visible snapshot escape", mortgageResults, 'const reload = () => {', 'const stolen = visible; const reload = () => {'],
  ["shadowed state setter", mortgageResults, "setState({ query, kind:", "((setState = steal) => setState({ query, kind: \"loading\" }))(); setState({ query, kind:"],
  ["raw results fetch", mortgageResults, "await query.request(`/api/crm/", "await fetch(`/api/crm/"],
  ["shadowed query", mortgageResults, "void (async () => {", "void (async (query = unsafeQuery) => {"],
] as const) {
  test(`outcomes consumers reject ${label}`, () => rejectsBoundTransport(mutate(file, from, to, boundSources)));
}

test("private contract session cannot acquire another caller", () => {
  rejectsBoundTransport(new Map(boundSources).set(contractPanel, boundSources.get(contractPanel)! +
    '\nfunction Unsafe() { return <MortgageContractSession request={fetch} />; }'));
});

for (const [file, initializer] of [
  [calendar, "const workspace = useMortgageWorkspace(query);"],
  [tasks, "const workspace = useMortgageWorkspace({ leadId, days: 90 });"],
  [clients, "const workspace = useMortgageWorkspace(query);"],
  [contactDetail, "const workspace = useMortgageWorkspace({ leadId });"],
] as const) {
  for (const [name, from, to] of [
    ["fake hook import", 'from "@/lib/mortgage-workspace"', 'from "@/lib/not-scoped"'],
    ["fake hook call", initializer, initializer.replace("useMortgageWorkspace(", "unsafeWorkspace(")],
    ["reassigned hook", initializer, `useMortgageWorkspace = unsafeHook; ${initializer}`],
    ["shadowed hook", initializer, `const useMortgageWorkspace = unsafeHook; ${initializer}`],
    ["mutable workspace", initializer, initializer.replace("const workspace", "let workspace")],
    ["reassigned transport", initializer, `${initializer} workspace.request = fetch;`],
    ["object transport override", initializer, `${initializer} Object.assign(workspace, { request: fetch });`],
    ["escaped transport", initializer, `${initializer} const stolen = workspace.request;`],
  ] as const) {
    test(`bound mortgage parent ${file} rejects ${name}`, () => {
      rejectsBoundTransport(mutate(file, from, to, boundSources));
    });
  }
  const prop = file === calendar || file === tasks ? "workspace={workspace}" : "request={workspace.request}";
  for (const [name, value] of [
    ["wrong transport", prop.startsWith("workspace") ? "workspace={unsafeWorkspace}" : "request={fetch}"],
    ["spread before prop", `{...unsafeProps} ${prop}`],
    ["spread after prop", `${prop} {...unsafeProps}`],
    ["duplicate prop", `${prop} ${prop}`],
    ["shadowed prop receiver", prop.startsWith("workspace")
      ? "workspace={(() => { const workspace = unsafeWorkspace; return workspace; })()}"
      : "request={(() => { const workspace = unsafeWorkspace; return workspace.request; })()}"],
  ] as const) {
    test(`bound mortgage parent ${file} rejects ${name}`, () => {
      rejectsBoundTransport(mutate(file, prop, value, boundSources));
    });
  }
  test(`bound mortgage proof requires the actual parent ${file}`, () => {
    const changed = new Map(boundSources);
    changed.delete(file);
    rejectsBoundTransport(changed);
  });
}

for (const [name, file, from, to] of [
  ["default dialog props", activityDialog, "props: ActivityDialogProps)", "props: ActivityDialogProps = unsafeProps)"],
  ["default form workspace", activityDialog, "function ActivityForm({ workspace,", "function ActivityForm({ workspace = unsafeWorkspace,"],
  ["default form props", activityDialog, "ActivityDialogProps & { timeZone: string })", "ActivityDialogProps & { timeZone: string } = unsafeProps)"],
  ["reassigned dialog workspace", activityDialog, "if (!props.open", "props.workspace = unsafeWorkspace; if (!props.open"],
  ["escaped dialog workspace", activityDialog, "if (!props.open", "Object.assign(props.workspace, { request: fetch }); if (!props.open"],
  ["wrong form forwarding", activityDialog, "{...props} timeZone=", "{...unsafeProps} timeZone="],
  ["form spread override", activityDialog, "{...props} timeZone=", "{...props} {...unsafeProps} timeZone="],
  ["form explicit override", activityDialog, "{...props} timeZone=", "{...props} workspace={unsafeWorkspace} timeZone="],
  ["form override before spread", activityDialog, "{...props} timeZone=", "workspace={unsafeWorkspace} {...props} timeZone="],
  ["form request reassignment", activityDialog, "const initialLead =", "workspace.request = fetch; const initialLead ="],
  ["form object override", activityDialog, "const initialLead =", "Object.assign(workspace, { request: fetch }); const initialLead ="],
  ["form transport alias", activityDialog, "const initialLead =", "const stolen = workspace.request; const initialLead ="],
  ["shadowed form workspace", activityDialog, "void (async () => {", "void (async (workspace = unsafeWorkspace) => {"],
  ["raw activity fetch", activityDialog, "await workspace.request(`/api/crm/", "await fetch(`/api/crm/"],
  ["default contact request", contactForm, "{ contact, request,", "{ contact, request = fetch,"],
  ["reassigned contact request", contactForm, "const id = useId();", "request = fetch; const id = useId();"],
  ["escaped contact request", contactForm, "const id = useId();", "const stolen = request; const id = useId();"],
  ["shadowed contact request", contactForm, "void (async () => {", "void (async (request = fetch) => {"],
  ["raw contact fetch", contactForm, "await request(`/api/crm/", "await fetch(`/api/crm/"],
] as const) {
  test(`bound mortgage consumers reject ${name}`, () => {
    rejectsBoundTransport(mutate(file, from, to, boundSources));
  });
}

for (const [name, extra] of [
  ["additional activity parent", `import { ActivityDialog } from "@/components/mortgage/ActivityDialog";
    const Unsafe = () => <ActivityDialog workspace={unsafeWorkspace} />;`],
  ["additional contact parent", `import { MortgageContactForm } from "@/components/mortgage/MortgageContactForm";
    const Unsafe = () => <MortgageContactForm request={fetch} />;`],
  ["aliased activity import", `import { ActivityDialog as Form } from "@/components/mortgage/ActivityDialog";
    const Unsafe = () => <Form workspace={unsafeWorkspace} />;`],
  ["default activity import", `import Form from "@/components/mortgage/ActivityDialog";
    const Unsafe = () => <Form workspace={unsafeWorkspace} />;`],
  ["namespace contact import", `import * as forms from "@/components/mortgage/MortgageContactForm";
    const Unsafe = () => <forms.MortgageContactForm request={fetch} />;`],
  ["contact reexport", 'export * from "@/components/mortgage/MortgageContactForm";'],
] as const) {
  test(`bound mortgage proof rejects ${name}`, () => {
    rejectsBoundTransport(new Map([...boundSources, ["components/unsafe-parent.tsx", extra]]));
  });
}

for (const [file, extra] of [
  [calendar, 'function Unsafe() { return <ActivityDialog workspace={unsafeWorkspace} />; }'],
  [clients, 'function Unsafe() { return <MortgageContactForm request={fetch} />; }'],
  [activityDialog, 'function Unsafe() { return <ActivityForm workspace={unsafeWorkspace} />; }'],
] as const) {
  test(`a second caller in the same file is not blessed: ${file}`, () => {
    rejectsBoundTransport(new Map(boundSources).set(file, boundSources.get(file)! + "\n" + extra));
  });
}

for (const file of [activityDialog, contactForm, calendar, tasks, clients, contactDetail, contractPanel, mortgageResults, "components/unrelated.tsx"]) {
  for (const extra of [
    'function Unsafe(request: Function) { return request("/api/crm/leads"); }',
    'fetch("/api/crm/leads");',
    'function Unsafe(workspace: any) { return workspace.request("/api/crm/leads"); }',
  ]) {
    test(`bound proof approves only its own call positions in ${file}: ${extra}`, () => {
      const changed = new Map(boundSources).set(file, (boundSources.get(file) ?? "") + "\n" + extra);
      assert.ok(crmTransportOffenders(changed).some((entry) => entry.startsWith(file + ":")));
    });
  }
}
