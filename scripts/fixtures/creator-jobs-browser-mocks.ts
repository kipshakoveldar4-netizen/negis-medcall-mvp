import { parseCreatorJobAction, parseCreatorJobTerms, type CreatorJob } from "../../lib/crm/creator-job-contracts";
export const ids = { owner: "11111111-1111-4111-8111-111111111111", workspace: "22222222-2222-4222-8222-222222222222",
  a: "33333333-3333-4333-8333-333333333333", b: "44444444-4444-4444-8444-444444444444",
  profileA: "55555555-5555-4555-8555-555555555555", profileB: "66666666-6666-4666-8666-666666666666" };
let actor: string | null = window.location.pathname === "/company" ? ids.owner : ids.a;
const listeners = new Set<(...args: any[]) => void>();
const session = () => actor ? { user: { id: actor }, access_token: "fixture-only-not-a-credential" } : null;
export const hasSupabaseFrontendEnv = true;
export class OperatorApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export const supabase = { auth: { getSession: async () => ({ data: { session: session() }, error: null }),
  onAuthStateChange: (fn: (...args: any[]) => void) => { listeners.add(fn); return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } }; },
  signOut: async () => { switchActor(null); return { error: null }; }, signInWithPassword: async () => ({ data: { session: session() }, error: null }) } };
// Observer-only compatibility; this fixture does not test auth writes.
export const sessionAuth = { onAuthStateChange: supabase.auth.onAuthStateChange };
export function switchActor(value: string | null) { actor = value; for (const fn of listeners) fn("SIGNED_IN", session()); }
type RecordJob = { job: CreatorJob; creator: string; history: NonNullable<CreatorJob["latestSubmission"]>[] };
const jobs = new Map<string, RecordJob>();
const receipts = new Map<string, { action: string; targetId: string; jobId: string; appliedRevision: string; intent: string }>();
const fences = new Map<string, unknown>(), approved = new Set<string>([ids.a, ids.b, ids.owner]);
const calls: { path: string; method: string; actor: string | null; body: unknown }[] = [];
let hold: { path: string; release?: () => void } | null = null, lose = false, denied = false;
const companyName = "Тестовая компания Medina";
const profile = (id: string) => ({ id: id === ids.a ? ids.profileA : ids.profileB, revision: ids.workspace,
  displayName: id === ids.a ? "Тестовая Александра" : "Тестовый Борис", portfolioUrls: [], partnerStatus: null, creatorStatus: approved.has(id) ? "approved" : "suspended" });
function permitted(origin: string | null, company: boolean) {
  if (!origin || denied || !approved.has(origin) || (company && origin !== ids.owner)) throw new OperatorApiError("Доступ изменился", 403);
}
function visible(record: RecordJob, origin: string, company: boolean) { return company || record.creator === origin; }
function outcome(origin: string, requestId: string) {
  const name = origin + ":" + requestId, receipt = receipts.get(name);
  if (receipt) return { state: "committed", requestId, action: receipt.action, targetId: receipt.targetId,
    result: { requestId, appliedRevision: receipt.appliedRevision, replayed: true, job: jobs.get(receipt.jobId)!.job } };
  return fences.get(name) ?? { state: "unconfirmed", requestId };
}
// UI doubles only. SQL transactions, identity and native locks are tested separately.
export async function operatorApi(path: string, body?: any, _method = "POST", signal?: AbortSignal, expectedUserId?: string, guard?: () => boolean) {
  if (signal?.aborted || (expectedUserId && expectedUserId !== actor) || guard?.() === false) throw Error("Stale fixture dispatch");
  const url = new URL(path, "http://fixture.invalid"), route = url.pathname.slice(1), origin = actor;
  const method = body === undefined ? "GET" : "POST", company = route.startsWith("clinic-") || route === "creator-directory";
  calls.push({ path, method, actor: origin, body: structuredClone(body ?? null) });
  if (route === "contributor-account") return profile(origin!);
  permitted(origin, company);
  if (company && url.searchParams.get("workspaceId") !== ids.workspace) throw new OperatorApiError("Wrong company", 403);
  const offset = Number(url.searchParams.get("offset") || 0);
  let result: any;
  if (route === "creator-directory") result = { items: [ids.a, ids.b].filter(id => approved.has(id)).map(id => { const p = profile(id); return { id: p.id, displayName: p.displayName, portfolioUrls: p.portfolioUrls }; }), hasMore: false };
  else if (route.endsWith("job-command")) {
    const key = body?.requestId ?? url.searchParams.get("requestId"), name = origin + ":" + key;
    result = outcome(origin!, key);
    if (body?.operation === "close" && result.state === "unconfirmed") {
      result = { state: "abandoned", requestId: key, action: body.action, targetId: body.targetId, closedAt: new Date().toISOString() }; fences.set(name, result);
    }
  } else if (route.endsWith("job-detail")) {
    const record = jobs.get(url.searchParams.get("jobId") || "");
    if (!record || !visible(record, origin!, company)) throw new OperatorApiError("Hidden job", 403);
    result = { job: record.job, companyName, history: { offset, items: [...record.history].reverse().slice(offset, offset + 20), hasMore: record.history.length > offset + 20 } };
  } else if (route.endsWith("creator-jobs") && method === "GET") {
    const records = [...jobs.values()].filter(record => visible(record, origin!, company));
    result = { items: records.slice(offset, offset + 20).map(record => record.job), hasMore: records.length > offset + 20 };
  } else if (route.endsWith("creator-jobs") && body) {
    const name = origin + ":" + body.requestId, old = receipts.get(name);
    if (old && old.intent !== JSON.stringify(body)) throw new OperatorApiError("Changed original", 409);
    if (old || fences.has(name)) result = outcome(origin!, body.requestId);
    else {
      let record: RecordJob, targetId: string;
      if (body.action === "create") {
        const terms = parseCreatorJobTerms(body.terms); if (!terms || !company) throw Error("Bad fixture create");
        const creator = terms.creatorId === ids.profileA ? ids.a : terms.creatorId === ids.profileB ? ids.b : null;
        if (!creator || !approved.has(creator)) throw new OperatorApiError("Creator revoked", 403);
        const { creatorId: _id, ...publicTerms } = terms;
        record = { creator, history: [], job: { id: crypto.randomUUID(), revision: crypto.randomUUID(), termsRevision: crypto.randomUUID(),
          creatorName: profile(creator).displayName, ...publicTerms, state: "offered", acceptedAt: null, approvedAt: null, submissionCount: 0, latestSubmission: null, feedback: null } };
        jobs.set(record.job.id, record); targetId = terms.creatorId;
      } else {
        const found = jobs.get(body.jobId), action = parseCreatorJobAction({ action: body.action, payload: body.payload });
        if (!found || !action || !visible(found, origin!, company)) throw new OperatorApiError("Hidden job", 403);
        record = found; targetId = body.jobId;
        if (record.job.revision !== body.revision) throw new OperatorApiError("Job changed", 409);
        const state = record.job.state;
        if (action.action === "accept" && !company && state === "offered" && action.payload.termsRevision === record.job.termsRevision) { record.job.state = "in_progress"; record.job.acceptedAt = new Date().toISOString(); }
        else if (action.action === "submit" && !company && ["in_progress", "changes_requested"].includes(state)) {
          record.job.state = "submitted"; record.job.feedback = null; record.job.submissionCount++;
          record.job.latestSubmission = { sequence: record.job.submissionCount, ...action.payload, submittedAt: new Date().toISOString() }; record.history.push(record.job.latestSubmission);
        } else if (action.action === "request_changes" && company && state === "submitted") { record.job.state = "changes_requested"; record.job.feedback = action.payload.feedback; }
        else if (action.action === "approve" && company && state === "submitted") { record.job.state = "approved"; record.job.approvedAt = new Date().toISOString(); }
        else if (action.action === "decline" && !company && state === "offered") record.job.state = "declined";
        else if (action.action === "cancel" && company && state === "offered") record.job.state = "cancelled";
        else throw new OperatorApiError("State conflict", 409);
        record.job.revision = crypto.randomUUID();
      }
      receipts.set(name, { action: body.action, targetId, jobId: record.job.id, appliedRevision: record.job.revision, intent: JSON.stringify(body) });
      result = outcome(origin!, body.requestId); result.result.replayed = false;
    }
  } else throw Error("Unexpected fixture route " + route);
  const snapshot = structuredClone(result), holding = hold?.path === route && !hold.release ? hold : null;
  if (holding) await new Promise<void>(resolve => { holding.release = resolve; });
  if (lose && method === "POST") { lose = false; throw Error("Тестовый потерянный ответ"); }
  return snapshot;
}
Object.assign(window, { __creatorQA: { ids, jobs, calls, receipts, fences, approved, switchActor, profile,
  holdNext: (path: string) => { hold = { path }; }, release: () => { const previous = hold; hold = null; previous?.release?.(); },
  loseNext: () => { lose = true; }, deny: (value = true) => { denied = value; },
} });
if (new URLSearchParams(window.location.search).get("demo") === "1") {
  const job: CreatorJob = { id: crypto.randomUUID(), revision: crypto.randomUUID(), termsRevision: crypto.randomUUID(), creatorName: profile(ids.a).displayName,
    title: "Тестовое видео о сервисе", brief: "Короткое видео о записи на консультацию. Без клиентских данных и обещаний результата.",
    rightsTerms: "Вымышленные условия для проверки интерфейса, не рабочий договор.", feeMinor: "2500000", currency: "KZT", dueAt: "2030-01-07T05:00:00.000Z",
    state: "offered", acceptedAt: null, approvedAt: null, submissionCount: 0, latestSubmission: null, feedback: null };
  jobs.set(job.id, { job, creator: ids.a, history: [] });
}
