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

function mutate(file: string, from: string, to: string) {
  const changed = new Map(sources);
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
