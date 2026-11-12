import assert from "node:assert/strict";
import test from "node:test";
const { creatorDeliverableUrl, parseCreatorJob, parseCreatorJobAction, parseCreatorJobPage, parseCreatorJobReceipt, parseCreatorJobTerms,
  parseCreatorCommandResult, parseCreatorDirectory, parseCreatorJobDetail } = await import(new URL("../../lib/crm/creator-job-contracts.ts", import.meta.url).href);
const id = "10000000-0000-4000-8000-000000000001";
const stamp = "2026-10-27T08:00:00.000Z";
const terms = { creatorId: id, title: "QA video", brief: "QA brief\nSecond paragraph", rightsTerms: "QA explicit licence", feeMinor: "9007199254740993", currency: "KZT", dueAt: stamp };
const job = { id, revision: id, termsRevision: id, creatorName: "QA creator", title: terms.title, brief: terms.brief,
  rightsTerms: terms.rightsTerms, feeMinor: terms.feeMinor, currency: terms.currency, dueAt: stamp, state: "offered",
  acceptedAt: null, approvedAt: null, submissionCount: 0, latestSubmission: null, feedback: null };

test("creator terms require an explicit exact fee, currency, deadline and rights, without inventing defaults", () => {
  assert.deepEqual(parseCreatorJobTerms(terms), terms);
  for (const key of Object.keys(terms)) { const changed: Record<string, unknown> = { ...terms }; delete changed[key]; assert.equal(parseCreatorJobTerms(changed), null, key); }
  for (const feeMinor of [0, "0", "01", "-1", "1.0", "1e2", "9223372036854775808", null]) assert.equal(parseCreatorJobTerms({ ...terms, feeMinor }), null);
  assert.ok(parseCreatorJobTerms({ ...terms, feeMinor: "9223372036854775807" }));
  assert.equal(parseCreatorJobTerms({ ...terms, authUserId: id }), null);
});
test("creator instants and multiline text are strict and do not normalize an invalid date or terms", () => {
  for (const dueAt of ["0000-01-01T08:00:00.000Z", "2026-02-30T08:00:00.000Z", "2026-10-27T08:00:00+05:00", "2026-10-27", "2026-10-27T24:00:00.000Z", "infinity"])
    assert.equal(parseCreatorJobTerms({ ...terms, dueAt }), null);
  for (const title of [" ", " QA", "QA\nTitle", "QA\rTitle", "QA\u0000Title"]) assert.equal(parseCreatorJobTerms({ ...terms, title }), null);
});
test("delivery links are displayed references, never local paths, credentials, arbitrary schemes or duplicates", () => {
  for (const url of ["https://example.com/video.mp4", "https://EXAMPLE.com/a?version=1#part"]) assert.equal(creatorDeliverableUrl(url), true);
  for (const url of ["javascript:alert(1)", "http://example.com", "https://user:pass@example.com/a", "https://127.0.0.1/a", "https://[::1]/a",
    "https://example.local/a", "https://example.test/a", "https://example.com:443/a", "https://example.com/a\\b", "https://example.com/a\nb"])
    assert.equal(creatorDeliverableUrl(url), false, url);
  assert.equal(parseCreatorJobAction({ action: "submit", payload: { links: ["https://example.com/a", "https://example.com/a"], note: "" } }), null);
});
test("all command payloads are closed; acceptance names the exact terms revision", () => {
  for (const action of ["decline", "approve", "cancel"]) assert.deepEqual(parseCreatorJobAction({ action, payload: {} }), { action, payload: {} });
  assert.ok(parseCreatorJobAction({ action: "accept", payload: { termsRevision: id } }));
  assert.ok(parseCreatorJobAction({ action: "submit", payload: { links: ["https://example.com/a"], note: "QA\nDescription" } }));
  assert.ok(parseCreatorJobAction({ action: "request_changes", payload: { feedback: "QA feedback" } }));
  for (const value of [{ action: "accept", payload: { termsRevision: null } }, { action: "accept", payload: { termsRevision: id, paid: true } },
    { action: "approve", payload: { payment: "1" } }, { action: "request_changes", payload: { feedback: "" } },
    { action: "submit", payload: { links: [], note: "" } }, { action: "paid", payload: {} }]) assert.equal(parseCreatorJobAction(value), null);
});
test("job DTO cannot leak an actor, tenant, financial action or a partial receipt", () => {
  assert.deepEqual(parseCreatorJob(job), job);
  for (const key of Object.keys(job)) { const changed: Record<string, unknown> = { ...job }; delete changed[key]; assert.equal(parseCreatorJob(changed), null, key); }
  for (const key of ["workspaceId", "authUserId", "paid", "bankAccount", "createdBy"]) assert.equal(parseCreatorJob({ ...job, [key]: id }), null);
});
test("state, acceptance, approval, submission and feedback must agree", () => {
  const submitted = { ...job, state: "submitted", acceptedAt: stamp, submissionCount: 1,
    latestSubmission: { sequence: 1, links: ["https://example.com/a"], note: "", submittedAt: stamp } };
  assert.ok(parseCreatorJob(submitted));
  assert.ok(parseCreatorJob({ ...submitted, state: "changes_requested", feedback: "QA changes" }));
  assert.ok(parseCreatorJob({ ...submitted, state: "approved", approvedAt: stamp }));
  for (const change of [{ acceptedAt: null }, { submissionCount: 0 }, { latestSubmission: null }, { feedback: "stale" },
    { approvedAt: stamp }, { latestSubmission: { ...submitted.latestSubmission, sequence: 2 } },
    { latestSubmission: { ...submitted.latestSubmission, submittedAt: "2026-10-26T08:00:00.000Z" } }]) assert.equal(parseCreatorJob({ ...submitted, ...change }), null);
  assert.equal(parseCreatorJob({ ...job, state: "in_progress", acceptedAt: null }), null);
});
test("pages reject duplicates and partial output rather than inventing empty success", () => {
  assert.deepEqual(parseCreatorJobPage({ items: [], hasMore: false }), { items: [], hasMore: false });
  assert.equal(parseCreatorJobPage({ items: [job, job], hasMore: false }), null);
  assert.equal(parseCreatorJobPage({ items: [], hasMore: true }), null);
  assert.equal(parseCreatorJobPage({ items: [job, {}], hasMore: false }), null);
});
test("replayed command reports the current job separately from its original applied revision", () => {
  const receipt = { requestId: id, appliedRevision: id, replayed: false, job };
  assert.deepEqual(parseCreatorJobReceipt(receipt), receipt);
  const later = { ...receipt, job: { ...job, revision: "20000000-0000-4000-8000-000000000001" } };
  assert.equal(parseCreatorJobReceipt(later), null);
  assert.ok(parseCreatorJobReceipt({ ...later, replayed: true }));
  assert.equal(parseCreatorJobReceipt({ ...receipt, originalIntent: { actor: id } }), null);
});

test("unconfirmed is not abandonment, legacy null/receipt is not a coordinated result", () => {
  assert.deepEqual(parseCreatorCommandResult({ state: "unconfirmed", requestId: id }), { state: "unconfirmed", requestId: id });
  for (const value of [null, { requestId: id, appliedRevision: id, replayed: false, job },
    { state: "unconfirmed", requestId: id, action: "create" }, { state: "abandoned", requestId: id }]) assert.equal(parseCreatorCommandResult(value), null);
});
test("stop fences and committed results are bound to the exact original key/action/target", () => {
  const expected = { requestId: id, action: "create", targetId: id };
  const stopped = { ...expected, state: "abandoned", closedAt: stamp };
  assert.ok(parseCreatorCommandResult(stopped, expected));
  const committed = { ...expected, state: "committed", result: { requestId: id, appliedRevision: id, replayed: false, job } };
  assert.ok(parseCreatorCommandResult(committed, expected));
  for (const change of [{ action: "accept" }, { targetId: "20000000-0000-4000-8000-000000000001" }, { requestId: "20000000-0000-4000-8000-000000000001" }])
    assert.equal(parseCreatorCommandResult({ ...stopped, ...change }, expected), null);
  assert.equal(parseCreatorCommandResult({ ...stopped, result: committed.result }, expected), null);
  assert.equal(parseCreatorCommandResult(committed, { ...expected, requestId: null }), null);
});
test("fresh and replayed command states respect the real job transition graph", () => {
  const accepted = { ...job, state: "in_progress", acceptedAt: stamp };
  const current = { state: "committed", requestId: id, action: "accept", targetId: id,
    result: { requestId: id, appliedRevision: id, replayed: false, job: accepted } };
  assert.ok(parseCreatorCommandResult(current));
  assert.equal(parseCreatorCommandResult({ ...current, result: { ...current.result, job } }), null);
  assert.equal(parseCreatorCommandResult({ ...current, action: "decline", result: { ...current.result, replayed: true } }), null);
  assert.equal(parseCreatorCommandResult({ ...current, authUserId: id }), null);
});
test("creator directory is bounded, canonical, distinct and contains no hidden profile fields", () => {
  const entry = { id, displayName: "QA author", portfolioUrls: ["https://example.com/portfolio"] };
  assert.ok(parseCreatorDirectory({ items: [entry], hasMore: false }));
  for (const item of [{ ...entry, authUserId: id }, { ...entry, portfolioUrls: ["javascript:alert(1)"] }, { ...entry, displayName: "" }])
    assert.equal(parseCreatorDirectory({ items: [item], hasMore: false }), null);
  const lower = "abcdefab-cdef-4abc-8abc-abcdefabcdef";
  assert.equal(parseCreatorDirectory({ items: [{ ...entry, id: lower }, { ...entry, id: lower.toUpperCase() }], hasMore: false }), null);
  assert.equal(parseCreatorDirectory({ items: [], hasMore: true }), null);
});
test("company detail and history require the exact current count, ordering, timestamps and latest version", () => {
  const versions = Array.from({ length: 22 }, (_, n) => ({ sequence: n + 1, links: [`https://example.com/v${n + 1}`], note: `QA ${n + 1}`,
    submittedAt: `2026-10-27T08:00:${String(n).padStart(2, "0")}.000Z` })).reverse();
  const currentJob = { ...job, state: "submitted", acceptedAt: stamp, submissionCount: 22, latestSubmission: versions[0] };
  const detail = { job: currentJob, companyName: "QA company", history: { offset: 0, items: versions.slice(0, 20), hasMore: true } };
  assert.ok(parseCreatorJobDetail(detail));
  assert.ok(parseCreatorJobDetail({ ...detail, history: { offset: 20, items: versions.slice(20), hasMore: false } }));
  for (const change of [{ items: versions.slice(1, 20) }, { items: [...versions.slice(0, 19), versions[18]] }, { offset: 20 }, { hasMore: false }])
    assert.equal(parseCreatorJobDetail({ ...detail, history: { ...detail.history, ...change } }), null);
  assert.equal(parseCreatorJobDetail({ ...detail, workspaceId: id }), null);
  assert.equal(parseCreatorJobDetail({ ...detail, companyName: " " }), null);
  assert.equal(parseCreatorJobDetail({ ...detail, history: { ...detail.history, items: [{ ...versions[0], note: "different latest" }, ...versions.slice(1, 20)] } }), null);
});
