import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type DeletionRequest = (path: string, init?: RequestInit) => Promise<Response>;
type Workflow = {
  inspect(): Promise<void>; confirm(value: boolean): void; submit(): Promise<void>;
  getSnapshot(): { phase: string; visible: boolean; confirmed: boolean; message: string; scope: Record<string, unknown> | null };
};
const moduleUrl = new URL("../../artifacts/negis/src/lib/siteInquiryDeletion.ts", import.meta.url);
const { createSiteInquiryDeletion, parseDeletionScope } = await import(moduleUrl.href) as {
  createSiteInquiryDeletion(workspace: string, lead: string, request: DeletionRequest, key: () => string): Workflow;
  parseDeletionScope(value: unknown, leadId: string): Record<string, unknown> | null;
};

const workspace = "00000000-0000-4000-8000-000000000001";
const lead = "00000000-0000-4000-8000-000000000002";
const receipt = "00000000-0000-4000-8000-000000000003";
const key = "00000000-0000-4000-8000-000000000004";
const version = "2026-09-28T11:00:00.123456+00:00";
const preview = (patch: Record<string, unknown> = {}) => ({ success: true, data: {
  leadId: lead, leadUpdatedAt: version, receiptIds: [receipt], receiptCount: 1, reviewReasons: [], reviewRequired: false,
  confirmationRequired: true, deletionEnabled: true, deletionAvailability: "confirmation_required", ...patch,
} });
const json = (body: unknown, status = 200) => Response.json(body, { status });
const success = () => json({ success: true, data: { deleted: true, receiptsDeleted: 1, replayed: false } });
function setup(responses: Array<() => Response | Promise<Response>>) {
  const calls: { path: string; init?: RequestInit }[] = [];
  let keys = 0;
  const request: DeletionRequest = async (path, init) => {
    calls.push({ path, init });
    const response = responses.shift();
    assert.ok(response, "unexpected request");
    return response();
  };
  return { flow: createSiteInquiryDeletion(workspace, lead, request, () => { keys++; return key; }), calls, keys: () => keys };
}

test("valid preview preserves exact microsecond version and strips unknown data", () => {
  const scope = parseDeletionScope(preview({ phone: "hidden", raw: "hidden" }), lead);
  assert.equal(scope?.leadUpdatedAt, version);
  assert.equal("phone" in scope!, false);
  assert.equal("raw" in scope!, false);
});

test("malformed or contradictory previews cannot enable deletion", () => {
  for (const patch of [
    { leadId: key }, { receiptIds: [] }, { receiptIds: [receipt, receipt] }, { receiptCount: 2 },
    { leadUpdatedAt: "invalid" }, { deletionEnabled: "true" }, { deletionAvailability: "anything" },
    { reviewRequired: true }, { reviewReasons: ["tasks"], reviewRequired: true }, { confirmationRequired: false },
    { deletionAvailability: "disabled" }, { deletionAvailability: "review_required", deletionEnabled: false },
  ]) assert.equal(parseDeletionScope(preview(patch), lead), null, JSON.stringify(patch));
});

for (const status of [401, 403, 404, 503]) test(`initial ${status} hides entry and never submits`, async () => {
  const { flow, calls } = setup([() => json({ error: "raw sensitive response" }, status)]);
  await flow.inspect(); flow.confirm(true); await flow.submit();
  assert.equal(flow.getSnapshot().visible, false);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(flow.getSnapshot()), /sensitive/);
});

for (const availability of ["disabled", "schema_not_ready", "review_required"]) test(`${availability} blocks confirmation and POST`, async () => {
  const { flow, calls } = setup([() => json(preview({
    deletionEnabled: false, deletionAvailability: availability,
    reviewReasons: availability === "review_required" ? ["tasks"] : [], reviewRequired: availability === "review_required",
  }))]);
  await flow.inspect(); flow.confirm(true); await flow.submit();
  assert.equal(flow.getSnapshot().visible, true);
  assert.equal(flow.getSnapshot().confirmed, false);
  assert.equal(calls.length, 1);
});

test("confirmation is required; exact reviewed scope only is submitted; no optimistic success", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => { resolve = done; });
  const { flow, calls } = setup([() => json(preview()), () => pending]);
  await flow.inspect(); await flow.submit(); assert.equal(calls.length, 1);
  flow.confirm(true);
  const submitted = flow.submit();
  assert.equal(flow.getSnapshot().phase, "submitting");
  await flow.submit(); await flow.inspect();
  assert.equal(calls.length, 2, "double click and refresh cannot change inflight request");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { leadId: lead, leadUpdatedAt: version, receiptIds: [receipt], requestKey: key, confirmed: true });
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(calls[1].init?.cache, "no-store");
  assert.match(calls[1].path, new RegExp(`workspaceId=${workspace}$`));
  resolve(success()); await submitted;
  assert.equal(flow.getSnapshot().phase, "done");
  assert.equal(flow.getSnapshot().scope, null);
  await flow.submit(); assert.equal(calls.length, 2);
});

test("lost response retains byte-identical request/key for explicit retry only", async () => {
  const { flow, calls, keys } = setup([() => json(preview()), () => { throw new Error("secret token"); }, () => success()]);
  await flow.inspect(); flow.confirm(true); await flow.submit();
  assert.equal(flow.getSnapshot().phase, "uncertain");
  await flow.inspect(); flow.confirm(false);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(flow.getSnapshot().message, /secret token/);
  await flow.submit();
  assert.equal(calls[1].init?.body, calls[2].init?.body);
  assert.equal(keys(), 1);
  assert.equal(flow.getSnapshot().phase, "done");
});

for (const response of [
  () => json({ success: false, code: "site_deletion_unavailable", raw: "private" }, 503),
  () => json({ success: false }, 401),
  () => json({ success: false, code: "__proto__" }, 409),
  () => json({ success: true, data: { deleted: true, receiptsDeleted: 2, replayed: false } }),
  () => new Response("not json", { status: 200 }),
]) test("unconfirmed mutation does not remove local item or lose retry identity", async () => {
  const { flow, calls } = setup([() => json(preview()), response, () => success()]);
  await flow.inspect(); flow.confirm(true); await flow.submit();
  assert.equal(flow.getSnapshot().phase, "uncertain");
  await flow.submit(); assert.equal(calls[1].init?.body, calls[2].init?.body);
});

test("scope changed requires a new read and explicit confirmation", async () => {
  const { flow, calls } = setup([() => json(preview()), () => json({ code: "deletion_scope_changed" }, 409), () => json(preview()), () => success()]);
  await flow.inspect(); flow.confirm(true); await flow.submit();
  assert.equal(flow.getSnapshot().phase, "error");
  assert.equal(flow.getSnapshot().scope, null);
  await flow.submit(); assert.equal(calls.length, 2);
  await flow.inspect(); await flow.submit(); assert.equal(calls.length, 3);
  assert.equal(flow.getSnapshot().confirmed, false);
  flow.confirm(true); await flow.submit(); assert.equal(flow.getSnapshot().phase, "done");
});

test("refresh clears confirmation immediately; late preview cannot resurrect old scope", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => { resolve = done; });
  const { flow } = setup([() => json(preview()), () => pending, () => json(preview({ deletionEnabled: false, deletionAvailability: "disabled" }))]);
  await flow.inspect(); flow.confirm(true);
  const stale = flow.inspect();
  assert.equal(flow.getSnapshot().confirmed, false);
  assert.equal(flow.getSnapshot().scope, null);
  await flow.inspect(); resolve(json(preview())); await stale;
  assert.equal(flow.getSnapshot().scope?.deletionAvailability, "disabled");
});

test("demo identifiers never make an API request", async () => {
  let requests = 0;
  const flow = createSiteInquiryDeletion("demo", "lead-1", async () => { requests++; return success(); }, () => key);
  await flow.inspect(); flow.confirm(true); await flow.submit();
  assert.equal(requests, 0);
});

test("integration is session/role scoped, server-gated and does not persist deletion state", async () => {
  const read = (file: string) => readFile(fileURLToPath(new URL(`../../${file}`, import.meta.url)), "utf8");
  const page = await read("artifacts/negis/src/pages/LeadsPage.tsx");
  const component = await read("artifacts/negis/src/components/crm/site-inquiry-deletion.tsx");
  const model = await read("artifacts/negis/src/lib/siteInquiryDeletion.ts");
  assert.match(page, /!isDemoMode && !isImpersonation && session && user && clinicId === readWorkspaceId\(\)/);
  assert.match(page, /userRole === "owner" \|\| userRole === "admin"/);
  assert.match(page, /request=\{crmFetch\}/);
  assert.match(page, /onDeleted=\{\(\) => \{\s*clearCrmCache\(\);\s*setItems/);
  assert.match(component, /if \(!state.visible\) return null/);
  assert.doesNotMatch(component + model, /localStorage|sessionStorage|\.from\(|service_role|setInterval/);
  assert.match(component, /state.phase === "done" && !notified.current/);
});
