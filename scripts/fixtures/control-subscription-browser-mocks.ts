// Only Auth/config are replaced. App, its screens, api.ts and receipt helpers are real.
type Actor = "A" | "B";
const ids = { A: "11111111-1111-4111-8111-111111111111", B: "22222222-2222-4222-8222-222222222222" } as const;
const actorKey = "qa-control-subscription-actor";
const controlPath = "/__fixture/control-subscription";
const allowed = new Set([controlPath, "/api/crm/platform-overview", "/api/crm/platform-subscriptions",
  "/api/crm/platform-operators", "/api/crm/platform-onboarding", "/api/crm/platform-onboarding-credentials",
  "/api/crm/platform-invitation-reissue"]);
if (location.protocol !== "http:" || location.hostname !== "127.0.0.1" || location.pathname !== "/"
  || location.search !== "?subscriptions=qa") throw new Error("Exact loopback subscription fixture required");

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
  if (url.origin !== location.origin || !allowed.has(url.pathname) || url.username || url.password
    || [...url.searchParams.keys()].some((key) => /token|authorization/i.test(key))) throw new Error("Unused or external fixture API forbidden");
  try { return await nativeFetch(input, init); }
  finally { if (url.pathname.startsWith("/api/")) dispatchEvent(new Event("qa-control-subscription-http")); }
};

let actor: Actor | null = "A";
try { actor = sessionStorage.getItem(actorKey) === "B" ? "B" : "A"; } catch { /* In-memory Auth still works without storage. */ }
let revision = 0;
const listeners = new Set<() => void>();
const authListeners = new Set<(event: string, value: ReturnType<typeof session>) => void>();
let snapshot: { actor: Actor | null; revision: number } = { actor, revision };
function session() {
  return actor ? { user: { id: ids[actor], email: `qa-subscription-${actor.toLowerCase()}@example.invalid` },
    access_token: `fixture-control-${actor}` } : null;
}
function change(next: Actor | null, event = next ? "SIGNED_IN" : "SIGNED_OUT", notifyAuth = true) {
  actor = next; revision++;
  try { if (next) sessionStorage.setItem(actorKey, next); else sessionStorage.removeItem(actorKey); } catch { /* Synthetic Auth only. */ }
  if (notifyAuth) for (const listener of [...authListeners]) listener(event, session());
  snapshot = { actor, revision };
  for (const listener of listeners) listener();
}
export const controlConfig = Object.freeze({ ready: true, apiOrigin: location.origin,
  supabaseUrl: location.origin, anonKey: "fixture-public-not-a-real-key" });
export const supabase = {
  auth: {
    async getSession() { return { data: { session: session() }, error: null }; },
    onAuthStateChange(listener: (event: string, value: ReturnType<typeof session>) => void) {
      authListeners.add(listener);
      queueMicrotask(() => { if (authListeners.has(listener)) listener("INITIAL_SESSION", session()); });
      return { data: { subscription: { unsubscribe() { authListeners.delete(listener); } } } };
    },
    async signOut() { change(null); return { error: null }; },
    async signInWithPassword() { return { data: { session: null, user: null }, error: { message: "Use the synthetic actor controls" } }; },
  },
};
export const subscriptionAuthFixture = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => snapshot,
  select(next: Actor) { change(next); },
  silentB() { change("B", "SIGNED_IN", false); },
  aba() { change("A"); change("B"); change("A"); },
  refresh() { change(actor, "TOKEN_REFRESHED"); },
  reset() {
    for (const id of Object.values(ids)) {
      try { sessionStorage.removeItem(`medina-control:subscription-operation:${encodeURIComponent(id)}`); }
      catch { /* Storage cleanup cannot block the synthetic Auth reset. */ }
    }
    change(null); change("A");
  },
};

export async function subscriptionFixtureControl(command?: Record<string, unknown>) {
  const response = await fetch(controlPath, command ? { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command) } : undefined);
  if (!response.ok) throw new Error("Local fixture control refused");
  return response.json() as Promise<{ failAfterCommit: boolean; counters: { commits: number; replays: number; abandons: number; lostResponses: number };
    holdOwnerReply: boolean; ownerReplyPending: boolean; heldOwnerReply: { method: "POST" | "PATCH"; path: string } | null;
    ownerCounters: { reads: number; mutations: number; operatorChanges: number;
      onboardingInvites: number; credentials: number; reissues: number; denied: number } }>;
}
