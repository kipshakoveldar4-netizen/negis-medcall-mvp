import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { crmTransportOffenders } from "./crm-transport-audit";

const model = "lib/siteInquiryDeletion.ts";
const component = "components/crm/site-inquiry-deletion.tsx";
const page = "pages/LeadsPage.tsx";
const sources = new Map<string, string>();
for (const file of [model, component, page]) {
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
  ["bare fetch prop", page, "request={crmFetch}", "request={fetch}"],
  ["missing prop", page, "request={crmFetch}", ""],
  ["spread override", page, "request={crmFetch}", "request={crmFetch} {...unsafeProps}"],
  ["duplicate prop", page, "request={crmFetch}", "request={crmFetch} request={fetch}"],
  ["fake API import", page, 'from "@/lib/api"', 'from "@/lib/not-authenticated"'],
  ["shadowed helper", page, "request={crmFetch}", "request={(() => { const crmFetch = fetch; return crmFetch; })()}"],
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

test("a comment describing the old composition cannot bless a replaced prop", () => {
  const changed = mutate(page, "request={crmFetch}", "request={fetch}");
  changed.set(page, changed.get(page)! + "\n// <SiteInquiryDeletion request={crmFetch} />\n");
  assert.notDeepEqual(crmTransportOffenders(changed), []);
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

const mortgage = "lib/mortgage-workspace.tsx";
const mortgageAnalytics = "pages/MortgageAnalytics.tsx";
const mortgageSources = new Map<string, string>();
for (const file of [mortgage, mortgageAnalytics]) {
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
  ["raw contact search", mortgage, "await access.request(`/api/crm/", "await fetch(`/api/crm/"],
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
