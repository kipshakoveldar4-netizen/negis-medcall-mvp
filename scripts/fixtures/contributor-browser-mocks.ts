import { parseContributorApplication, type ContributorProfile } from "../../lib/crm/contributor-contracts";

let actor: string | null = "blogger-a", epoch = 0, sequence = 20;
const listeners = new Set<(...args: any[]) => void>();
const controlListeners = new Set<(session: any) => void>();
const profiles = new Map<string, ContributorProfile>();
const ledgers = new Map<string, unknown>();
const calls: { path: string; method: string; actor: string | null }[] = [];
let hold = false, holdPath: string | null = null, release: (() => void) | null = null;
const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const session = () => actor ? { user: { id: actor }, access_token: "fixture-not-a-token" } : null;
function switchActor(next: string | null) {
  if (next !== actor) { actor = next; epoch++; }
  for (const listener of listeners) listener("SIGNED_IN", session());
  for (const listener of controlListeners) listener(session());
}
export const hasSupabaseFrontendEnv = true;
export class OperatorApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export const controlConfig = { ready: true };
export function subscribeControlActor(fn: (session: any) => void) { controlListeners.add(fn); return () => controlListeners.delete(fn); }
export const supabase = { auth: {
  getSession: async () => ({ data: { session: session() }, error: null }),
  onAuthStateChange: (fn: (...args: any[]) => void) => { listeners.add(fn); return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } }; },
  signInWithPassword: async () => { switchActor("blogger-a"); return { data: { session: session() }, error: null }; },
  signUp: async () => ({ data: { session: null }, error: null }),
  signOut: async () => { switchActor(null); return { error: null }; },
} };
// Synthetic UI dispatch only; no native SDK storage or persistence model.
function currentScope(scope: { isCurrent(): boolean; signal?: AbortSignal }) {
  if (typeof scope?.isCurrent !== "function" || !scope.isCurrent() || scope.signal?.aborted) {
    throw Error("Synthetic sessionAuth requires a current caller scope");
  }
}
export const sessionAuth = {
  onAuthStateChange: supabase.auth.onAuthStateChange,
  signInWithPassword(_credentials: unknown, scope: Parameters<typeof currentScope>[0]) {
    currentScope(scope); return supabase.auth.signInWithPassword();
  },
  signUp(_credentials: unknown, scope: Parameters<typeof currentScope>[0]) {
    currentScope(scope); return supabase.auth.signUp();
  },
  signOut(scope: Parameters<typeof currentScope>[0]) {
    currentScope(scope); return supabase.auth.signOut();
  },
};
async function request(path: string, body: unknown, method: string, valid: () => boolean) {
  if (!valid()) throw Error("Account changed");
  calls.push({ path, method, actor });
  const origin = actor;
  let result: unknown;
  if (path === "contributor-account" && origin && origin !== "owner") {
    if (method === "GET") result = profiles.get(origin) ?? null;
    else if (method === "POST") {
      const application = parseContributorApplication(body); if (!application) throw Error("Invalid application");
      const previous = profiles.get(origin);
      result = previous ? { ...previous, partnerStatus: previous.partnerStatus ?? (application.partner ? "pending" : null), creatorStatus: previous.creatorStatus ?? (application.creator ? "pending" : null) }
        : { id: id(), revision: id(), displayName: application.displayName, portfolioUrls: application.portfolioUrls, partnerStatus: application.partner ? "pending" : null, creatorStatus: application.creator ? "pending" : null };
      profiles.set(origin, result as ContributorProfile);
    } else throw Error("Method denied");
  } else if (path.startsWith("partner-terms?") && origin && method === "GET") {
    const p = profiles.get(origin);
    if (p?.partnerStatus !== "approved") throw Object.assign(Error("Partner access changed"), { status: 403 });
    result = { state: "not_offered", profileId: p.id, profileRevision: p.revision, agreement: null };
  } else if (path === "partner-ledger" && origin && method === "GET") {
    if (profiles.get(origin)?.partnerStatus !== "approved") throw Object.assign(Error("Partner access changed"), { status: 403 });
    const value = ledgers.get(origin) ?? { state: "not_activated" };
    if (value instanceof Error) throw value;
    result = value;
  } else if (path.startsWith("platform-contributors") && actor === "owner") {
    if (method === "GET") result = { items: [...profiles.values()], hasMore: false };
    else {
      const b = body as any;
      const entry = [...profiles.entries()].find(([, row]) => row.id === b.id);
      if (!entry || entry[1].revision !== b.revision) throw Error("Conflict");
      result = { ...entry[1], revision: id(), [b.role === "partner" ? "partnerStatus" : "creatorStatus"]: b.action === "approve" ? "approved" : "suspended" };
      profiles.set(entry[0], result as ContributorProfile);
    }
  } else throw Error("Access denied");
  const captured = structuredClone(result);
  if (hold && (holdPath ? path === holdPath : method !== "GET")) { hold = false; holdPath = null; await new Promise<void>(resolve => { release = resolve; }); }
  return captured;
}
export async function operatorApi(path: string, body?: unknown, method = "POST", signal?: AbortSignal, expectedUserId?: string, guard?: () => boolean) {
  return request(path, body, body === undefined ? "GET" : method, () => !signal?.aborted && (!expectedUserId || actor === expectedUserId) && (!guard || guard()));
}
export function captureControlAccess() {
  const originalActor = actor, originalEpoch = epoch;
  return { actorId: originalActor, isCurrent: () => originalActor === "owner" && actor === originalActor && epoch === originalEpoch };
}
export async function verifyControlAccess() { return captureControlAccess(); }
export async function controlFetch(url: string, init: RequestInit = {}, scope: { isCurrent: () => boolean }) {
  const data = await request(url.replace("/api/crm/", ""), init.body ? JSON.parse(String(init.body)) : undefined, init.method || "GET", scope.isCurrent);
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
}
Object.assign(window, { __contributorQA: {
  switchActor, calls, profiles, ledgers, holdNext: (path?: string) => { hold = true; holdPath = path ?? null; }, release: () => { const run = release; release = null; run?.(); },
  seed: () => { profiles.set("blogger-a", { id: id(), revision: id(), displayName: "Тестовая Александра Константинопольская", portfolioUrls: ["https://www.instagram.com/medina_os_test/"], partnerStatus: "pending", creatorStatus: "pending" }); },
} });
if (window.location.pathname === "/review") switchActor("owner");
if (window.location.search.includes("seed=1")) (window as any).__contributorQA.seed();
if (new URLSearchParams(window.location.search).get("partner") === "1") {
  profiles.set("blogger-a", { id: id(), revision: id(), displayName: "Тестовый партнёр", portfolioUrls: [], partnerStatus: "approved", creatorStatus: "pending" });
  ledgers.set("blogger-a", { state: "ready", generatedAt: "2026-10-27T01:02:03Z", firstCommissionBps: 1000, renewalCommissionBps: 500,
    registrations: "3", paidCompanies: "2", firstPayments: "2", renewals: "1",
    balances: [{ currency: "KZT", earnedMinor: "240000", paidMinor: "100000", availableMinor: "140000" }] });
}
