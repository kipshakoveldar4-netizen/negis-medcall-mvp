import { createOperatorBrowserFixture } from "./operator-browser-store";
import { parseCreatorCommandIdentity, parseCreatorJobAction, type CreatorJob, type CreatorSubmission } from "../../lib/crm/creator-job-contracts";
import { parseContributorApplication, type ContributorProfile } from "../../lib/crm/contributor-contracts";

export const portalDesignIds = {
  contributor: "33333333-3333-4333-8333-333333333333",
  operator: "00000000-0000-4000-8000-000000000805",
  other: "44444444-4444-4444-8444-444444444444",
  profile: "55555555-5555-4555-8555-555555555555",
  job: "77777777-7777-4777-8777-777777777777",
  jobReview: "77777777-7777-4777-8777-777777777778",
  jobChanges: "77777777-7777-4777-8777-777777777779",
} as const;
export const portalDesignViews = ["partner", "creator", "operator"] as const;
export const portalDesignStates = ["ready", "empty", "error", "denied", "signed-out", "pending", "suspended"] as const;
export type PortalDesignView = typeof portalDesignViews[number];
export type PortalDesignState = typeof portalDesignStates[number];
export function portalDesignLocation(input: string | URL) {
  const url = new URL(input, "http://fixture.invalid");
  const mode = url.searchParams.get("mode");
  const view: PortalDesignView = url.pathname === "/operator" ? "operator" : mode === "creator" ? "creator" : "partner";
  const candidate = url.searchParams.get("state");
  const state: PortalDesignState = portalDesignStates.includes(candidate as PortalDesignState) ? candidate as PortalDesignState : "ready";
  return { view, state };
}
export function portalDesignHref(view: PortalDesignView, state: PortalDesignState = "ready") {
  return `${view === "operator" ? "/operator" : "/contributors"}?mode=${view}&state=${state}`;
}
const clone = <T>(value: T): T => structuredClone(value);
const ok = (data: unknown) => Response.json({ success: true, data });
const fail = (status: number, error = "Fixture: request refused") => Response.json({ success: false, error }, { status });
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// Browser doubles only. No SDK, environment, disk, real payments or referrals.
export function createPortalDesignStore(input: string | URL = "/contributors?mode=partner") {
  const initial = portalDesignLocation(input);
  let view = initial.view, state = initial.state, epoch = 0;
  const actorForView = () => view === "operator" ? portalDesignIds.operator : portalDesignIds.contributor;
  let actor: string | null = state === "signed-out" ? null : actorForView();
  let denied = false, lose = false, failBefore = false, acceptingRequests = false;
  let operator = createOperatorBrowserFixture();
  const authListeners = new Set<(event: string, session: ReturnType<typeof session>) => void>();
  const listeners = new Set<() => void>();
  const calls: { path: string; method: string; actor: string | null; epoch: number; body: unknown }[] = [];
  const jobs = new Map<string, { job: CreatorJob; history: CreatorSubmission[]; companyName: string }>();
  const receipts = new Map<string, { intent: string; result: unknown }>();
  const fences = new Map<string, unknown>();
  let hold: { route: string; release?: () => void } | null = null;
  let failure: { route: string; status: number } | null = null;
  let profile: ContributorProfile | null = null;
  const token = () => `fixture-only:${actor}:${epoch}`;
  function session() { return actor ? { user: { id: actor }, access_token: token() } : null; }
  const emit = () => { for (const listener of listeners) listener(); };
  function switchActor(next: string | null) {
    if (next !== null && ![portalDesignIds.contributor, portalDesignIds.operator, portalDesignIds.other].includes(next as typeof portalDesignIds.contributor)) throw Error("Unknown fixture actor");
    if (next !== actor) { actor = next; epoch++; }
    for (const listener of authListeners) listener(actor ? "SIGNED_IN" : "SIGNED_OUT", session());
    emit();
  }
  function seed() {
    const status = state === "pending" ? "pending" : state === "suspended" ? "suspended" : "approved";
    profile = { id: portalDesignIds.profile, revision: crypto.randomUUID(), displayName: "Тестовая Александра", portfolioUrls: [], partnerStatus: status, creatorStatus: status };
    jobs.clear();
    if (state === "empty") return;
    const common = { creatorName: profile.displayName, currency: "KZT", approvedAt: null,
      brief: "Синтетическое задание для локального предпросмотра. Без клиентских данных и обещаний результата.",
      rightsTerms: "Тестовые условия макета. Не рабочий договор, не доказательство согласия и не выплата.", acceptedAt: "2026-10-27T05:00:00.000Z" };
    jobs.set(portalDesignIds.job, { companyName: "Тестовая студия Линия", history: [], job: {
      ...common, id: portalDesignIds.job, revision: crypto.randomUUID(), termsRevision: crypto.randomUUID(),
      title: "Reels для студии", feeMinor: "2500000", dueAt: "2026-10-30T05:00:00.000Z", state: "in_progress", submissionCount: 0, latestSubmission: null, feedback: null,
    } });
    // The reserved example.com root is a labelled placeholder, never delivery proof.
    const example = { links: ["https://example.com/"], note: "Синтетическая версия. example.com - зарезервированный пример, не результат работы; внешние ссылки заблокированы." };
    const history = [1, 2].map(sequence => ({ ...example, sequence, submittedAt: `2026-10-27T0${5 + sequence}:00:00.000Z` }));
    jobs.set(portalDesignIds.jobReview, { companyName: "Тестовая клиника Форма", history, job: {
      ...common, id: portalDesignIds.jobReview, revision: crypto.randomUUID(), termsRevision: crypto.randomUUID(),
      title: "Обзор пространства", feeMinor: "3000000", dueAt: "2026-11-02T05:00:00.000Z", state: "submitted", submissionCount: 2, latestSubmission: clone(history[1]), feedback: null,
    } });
    const latestSubmission = { ...example, sequence: 1, submittedAt: "2026-10-27T08:00:00.000Z" };
    jobs.set(portalDesignIds.jobChanges, { companyName: "Тестовая студия Сфера", history: [latestSubmission], job: {
      ...common, id: portalDesignIds.jobChanges, revision: crypto.randomUUID(), termsRevision: crypto.randomUUID(),
      title: "Фото для каталога", feeMinor: "1800000", dueAt: "2026-11-04T05:00:00.000Z", state: "changes_requested", submissionCount: 1, latestSubmission,
      feedback: "Тестовый комментарий: уточнить ракурс и свет.",
    } });
  }
  seed();
  const ownedKey = (owner: string, id: string) => `${owner}:${id}`;
  function creatorOutcome(owner: string, requestId: string) {
    return clone(receipts.get(ownedKey(owner, requestId))?.result ?? fences.get(ownedKey(owner, requestId)) ?? { state: "unconfirmed", requestId });
  }
  async function dispatch(url: URL, method: string, body: any, owner: string): Promise<Response> {
    const route = url.pathname.slice("/api/crm/".length);
    const contributor = owner === portalDesignIds.contributor;
    if (route === "contributor-account" && contributor) {
      if (method === "GET") return ok(profile);
      const application = parseContributorApplication(body);
      if (method !== "POST" || !application) return fail(400);
      profile = profile ? { ...profile, revision: crypto.randomUUID(),
        partnerStatus: profile.partnerStatus ?? (application.partner ? "pending" : null), creatorStatus: profile.creatorStatus ?? (application.creator ? "pending" : null) }
        : { id: portalDesignIds.profile, revision: crypto.randomUUID(), displayName: application.displayName, portfolioUrls: application.portfolioUrls,
          partnerStatus: application.partner ? "pending" : null, creatorStatus: application.creator ? "pending" : null };
      return ok(profile);
    }
    if (contributor && route.startsWith("partner-")) {
      if (profile?.partnerStatus !== "approved") return fail(403);
      if (route === "partner-ledger" && method === "GET") return ok(state === "empty" ? { state: "not_activated" } : {
        state: "ready", generatedAt: "2026-10-28T09:00:00.000Z", firstCommissionBps: null, renewalCommissionBps: null,
        registrations: "5", paidCompanies: "5", firstPayments: "5", renewals: "3",
        balances: [{ currency: "KZT", earnedMinor: "7200000", paidMinor: "4800000", availableMinor: "2400000" }],
      });
      if (route === "partner-terms" && method === "GET" && url.searchParams.get("profileId") === profile.id && !url.searchParams.has("requestId")) {
        return ok({ state: "not_offered", profileId: profile.id, profileRevision: profile.revision, agreement: null });
      }
      return fail(403);
    }
    if (contributor && ["creator-jobs", "creator-job-detail", "creator-job-command"].includes(route)) {
      if (profile?.creatorStatus !== "approved") return fail(403);
      const offset = Number(url.searchParams.get("offset") || 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) return fail(400);
      if (route === "creator-job-command") {
        const requestId = method === "GET" ? url.searchParams.get("requestId") : body?.requestId;
        if (!uuid(requestId)) return fail(400);
        const key = ownedKey(owner, requestId), result = creatorOutcome(owner, requestId);
        if (method === "GET") return ok(result);
        const identity = parseCreatorCommandIdentity({ requestId, action: body?.action, targetId: body?.targetId });
        if (method !== "POST" || body?.operation !== "close" || !identity || !["accept", "decline", "submit"].includes(identity.action)) return fail(400);
        if ((result as any).state !== "unconfirmed") {
          if ((result as any).action !== identity.action || (result as any).targetId !== identity.targetId) return fail(409);
          return ok(result);
        }
        const closed = { state: "abandoned", ...identity, closedAt: new Date().toISOString() };
        fences.set(key, closed); return ok(closed);
      }
      if (route === "creator-jobs" && method === "GET") return ok({ items: [...jobs.values()].slice(offset, offset + 20).map(record => record.job), hasMore: jobs.size > offset + 20 });
      const record = jobs.get(method === "GET" ? url.searchParams.get("jobId") || "" : body?.jobId);
      if (!record) return fail(404);
      if (route === "creator-job-detail" && method === "GET") return ok({ job: record.job, companyName: record.companyName, history: {
        offset, items: [...record.history].reverse().slice(offset, offset + 20), hasMore: record.history.length > offset + 20,
      } });
      if (route !== "creator-jobs" || method !== "POST" || !uuid(body?.requestId)) return fail(400);
      const key = ownedKey(owner, body.requestId), old = receipts.get(key);
      if (old) {
        if (old.intent !== JSON.stringify(body)) return fail(409);
        const replay: any = creatorOutcome(owner, body.requestId); replay.result.replayed = true; return ok(replay);
      }
      if (fences.has(key)) return ok(fences.get(key));
      const action = parseCreatorJobAction({ action: body.action, payload: body.payload });
      if (!action || record.job.revision !== body.revision) return fail(409);
      const job = record.job, now = new Date().toISOString();
      if (action.action === "accept" && job.state === "offered" && action.payload.termsRevision === job.termsRevision) {
        job.state = "in_progress"; job.acceptedAt = now;
      } else if (action.action === "decline" && job.state === "offered") job.state = "declined";
      else if (action.action === "submit" && ["in_progress", "changes_requested"].includes(job.state)) {
        job.state = "submitted"; job.feedback = null; job.submissionCount++;
        job.latestSubmission = { sequence: job.submissionCount, ...action.payload, submittedAt: now }; record.history.push(job.latestSubmission);
      } else return fail(409);
      job.revision = crypto.randomUUID();
      const result = { state: "committed", requestId: body.requestId, action: action.action, targetId: job.id,
        result: { requestId: body.requestId, appliedRevision: job.revision, replayed: false, job: clone(job) } };
      receipts.set(key, { intent: JSON.stringify(body), result }); return ok(result);
    }
    if (owner === portalDesignIds.operator && route.startsWith("operator-")) {
      if (route === "operator-account") {
        const data = (await operator.request(new URL("http://fixture.invalid/api/crm/operator-account")).json()).data;
        const status = state === "pending" ? "pending" : state === "suspended" ? "suspended" : data.status;
        if (method === "PATCH" && status === "approved" && Object.keys(body || {}).length === 1 && typeof body.acceptingRequests === "boolean") acceptingRequests = body.acceptingRequests;
        else if (method !== "GET") return fail(403);
        return ok({ ...data, status, acceptingRequests });
      }
      const operatorProfile = (await operator.request(new URL("http://fixture.invalid/api/crm/operator-account")).json()).data;
      if (["pending", "suspended"].includes(state) || operatorProfile.status !== "approved") return fail(403);
      if (route === "operator-inbox") {
        const commandId = method === "GET" ? url.searchParams.get("commandId") : body?.commandId;
        if (commandId) {
          if (!uuid(commandId)) return fail(400);
          const key = ownedKey(owner, commandId), previous = receipts.get(key);
          if (method === "GET") return ok(previous?.result ?? fences.get(key) ?? { state: "unconfirmed", commandId });
          if (method !== "PATCH") return fail(403);
          if (body?.action === "abandon" && ["accept", "decline", "end"].includes(body.commandAction) && uuid(body.targetId)) {
            const result: any = previous?.result ?? fences.get(key);
            if (result && (result.action !== body.commandAction || result.targetId !== body.targetId)) return fail(409);
            const closed = result ?? { state: "abandoned", commandId, action: body.commandAction, targetId: body.targetId, closedAt: new Date().toISOString() };
            if (!result) fences.set(key, closed); return ok(closed);
          }
          if (previous) return previous.intent === JSON.stringify(body) ? ok(previous.result) : fail(409);
          if (fences.has(key)) return ok(fences.get(key));
          const inbox = (await operator.request(new URL("http://fixture.invalid/api/crm/operator-inbox")).json()).data;
          const row = inbox.items.find((item: any) => item.id === body.id);
          if (!row || row.status !== "accepted" || body.action !== "end") return fail(409);
          operator.endCooperation();
          const result = { state: "committed", commandId, action: "end", targetId: row.id, requestId: row.id, statusAtCommit: "ended", committedAt: new Date().toISOString() };
          receipts.set(key, { intent: JSON.stringify(body), result }); return ok(result);
        }
        if (method === "GET" && state === "empty") return ok({ items: [], hasMore: false });
      }
      return operator.request(new URL(url.pathname + url.search, "http://fixture.invalid"), { method });
    }
    return fail(403);
  }
  return {
    calls, jobs, receipts, fences, session, token,
    snapshot: () => ({ actor, epoch, view, state }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onAuthStateChange(listener: (event: string, next: ReturnType<typeof session>) => void) {
      authListeners.add(listener); return { data: { subscription: { unsubscribe: () => authListeners.delete(listener) } } };
    },
    switchActor,
    navigate(next: PortalDesignView) { view = next; switchActor(state === "signed-out" ? null : actorForView()); },
    setState(next: PortalDesignState) {
      state = next; denied = false; operator = createOperatorBrowserFixture(); acceptingRequests = false;
      receipts.clear(); fences.clear(); seed(); switchActor(state === "signed-out" ? null : actorForView());
    },
    deny(value = true) { denied = value; },
    failNext(route: string, status = 503) { failure = { route, status }; },
    holdNext(route: string) { if (hold) throw Error("A fixture response is already held"); hold = { route }; },
    release() { const previous = hold; hold = null; previous?.release?.(); },
    loseNext() { lose = true; },
    failBeforeNext() { failBefore = true; },
    clearProfile() { profile = null; },
    suspendOperator() { operator.suspend(); },
    endCooperation() { operator.endCooperation(); },
    async request(url: URL, init: RequestInit = {}): Promise<Response> {
      init.signal?.throwIfAborted();
      if (url.origin !== "http://fixture.invalid" || !url.pathname.startsWith("/api/crm/")) throw Error("Only isolated fixture API routes are permitted");
      const method = (init.method || "GET").toUpperCase(), route = url.pathname.slice("/api/crm/".length);
      const owner = actor, originalEpoch = epoch;
      if (!owner || new Headers(init.headers).get("authorization") !== `Bearer ${token()}`) return fail(401);
      let body: unknown;
      try { body = init.body ? JSON.parse(String(init.body)) : undefined; } catch { return fail(400); }
      calls.push({ path: url.pathname + url.search, method, actor: owner, epoch: originalEpoch, body: clone(body ?? null) });
      if (denied || state === "denied") return fail(403);
      if (state === "error") return fail(503, "Тестовая ошибка загрузки. Реальные запросы отключены.");
      if (failure?.route === route) { const status = failure.status; failure = null; return fail(status); }
      if (failBefore && method !== "GET") { failBefore = false; throw Error("Fixture: response lost before processing"); }
      const response = await dispatch(url, method, body, owner);
      const holding = hold?.route === route && !hold.release ? hold : null;
      if (holding) await new Promise<void>(resolve => { holding.release = resolve; });
      // Delayed replies retain their original owner; production lifetimes hide them.
      if (lose && method !== "GET" && response.ok) { lose = false; throw Error("Fixture: committed response lost"); }
      return response;
    },
  };
}
