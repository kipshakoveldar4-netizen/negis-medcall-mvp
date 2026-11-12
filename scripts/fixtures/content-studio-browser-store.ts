import * as importedCore from "../../lib/content-studio/core";

const { demoContentPackage } = ((importedCore as { default?: unknown }).default ?? importedCore) as typeof import("../../lib/content-studio/core");

export const contentStudioFixtureIds = Object.freeze({
  workspace: "00000000-0000-4000-8000-000000001501",
  A: "00000000-0000-4000-8000-000000001502",
  B: "00000000-0000-4000-8000-000000001503",
  ideaA: "00000000-0000-4000-8000-000000001504",
  ideaB: "00000000-0000-4000-8000-000000001505",
});

type Actor = "A" | "B";
type ActorState = Readonly<{ actor: Actor; actorId: string; workspaceId: string }>;
type FixtureSession = { user: { id: string }; access_token: string };
type AuthListener = (event: string, session: FixtureSession | null) => void;
type GuardedInit = RequestInit & { expectedUserId?: string; dispatchGuard?: () => boolean };
const briefKeys = ["mode", "format", "service", "city", "offer", "audience", "goal", "tone", "materialNotes"] as const;
type PackageBrief = Record<typeof briefKeys[number], string>;

export function isContentStudioFixtureLocation(location: {
  pathname?: string; hostname?: string; protocol?: string; search?: string;
}) {
  const query = new URLSearchParams(location.search || "");
  return location.pathname === "/content-studio" && location.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname || "")
    && [...query].length === 1 && query.get("contentStudio") === "handoff";
}

function packageBrief(body: GuardedInit["body"]): PackageBrief | null {
  if (typeof body !== "string" || body.length > 20_000) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== briefKeys.length
      || !briefKeys.every((key) => typeof record[key] === "string" && record[key].length <= 2_000)) return null;
    return record as PackageBrief;
  } catch { return null; }
}

// Local simulation only: no SDK, providers, persistence, or native clipboard.
export function createContentStudioBrowserFixture() {
  let actor: Actor = "A", revision = 0, refreshes = 0, authEvents = 0;
  let sdkReads = 0, armed = false, held: (() => void) | undefined;
  let calls = 0, blocked = 0;
  let clipboardWrites = 0, clipboardFailures = 0, clipboardArmed = false, clipboardFailureArmed = false;
  let clipboardHeld: (() => void) | undefined;
  let lastClipboard: Readonly<{ actor: Actor; text: string }> | null = null;
  let updateAuth: ((state: ActorState) => void) | undefined;
  const listeners = new Set<() => void>(), authListeners = new Set<AuthListener>();
  const actorState = (): ActorState => ({ actor, actorId: contentStudioFixtureIds[actor], workspaceId: contentStudioFixtureIds.workspace });
  const session = (): FixtureSession => ({
    user: { id: contentStudioFixtureIds[actor] }, access_token: `content-studio-fixture-invalid-token-${actor}-${refreshes}`,
  });
  const readSnapshot = () => Object.freeze({
    ...actorState(), revision, refreshes, authEvents, sdkReads, held: Number(Boolean(held)), sdkHeld: Number(Boolean(held)), armed, calls, blocked,
    clipboardWrites, clipboardFailures, clipboardArmed, clipboardHeld: Number(Boolean(clipboardHeld)), clipboardFailureArmed, lastClipboard,
  });
  let snapshot = readSnapshot();
  const emit = () => { snapshot = readSnapshot(); for (const listener of listeners) listener(); };
  const emitAuth = (event: string) => {
    authEvents++;
    const next = session();
    for (const listener of authListeners) listener(event, next);
  };
  const changeActor = (next: Actor) => {
    actor = next; revision++; updateAuth?.(actorState()); emitAuth("SIGNED_IN");
  };
  const deny = (status = 403) => {
    blocked++; emit();
    return Response.json({ success: false, error: "TEST: local Content Studio operation disabled" }, { status });
  };
  const current = (init: GuardedInit) => {
    try {
      return init.signal instanceof AbortSignal && !init.signal.aborted && typeof init.dispatchGuard === "function"
        && init.dispatchGuard() === true && !init.signal.aborted && init.expectedUserId === contentStudioFixtureIds[actor];
    } catch { return false; }
  };

  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    bindAuth(callback: (state: ActorState) => void) { updateAuth = callback; callback(actorState()); },
    session,
    async getSession() {
      sdkReads++;
      const captured = session();
      if (armed) {
        armed = false;
        await new Promise<void>((resolve) => { held = resolve; emit(); });
      } else emit();
      return { data: { session: captured }, error: null };
    },
    onAuthStateChange(listener: AuthListener) {
      authListeners.add(listener);
      return { data: { subscription: { unsubscribe() { authListeners.delete(listener); } } } };
    },
    switchActor() { changeActor(actor === "A" ? "B" : "A"); emit(); },
    switchABA() {
      if (actor !== "A") return;
      // Raw SDK events precede the single parent-render notification.
      changeActor("B"); changeActor("A"); emit();
    },
    refreshSameActor() { refreshes++; emitAuth("TOKEN_REFRESHED"); emit(); },
    armNextSdk() { if (armed || held) return false; armed = true; emit(); return true; },
    release() { const resolve = held; held = undefined; if (!resolve) return false; emit(); resolve(); return true; },
    armNextClipboard() {
      if (clipboardArmed || clipboardHeld) return false;
      clipboardArmed = true; emit(); return true;
    },
    failNextClipboard() { if (clipboardFailureArmed) return false; clipboardFailureArmed = true; emit(); return true; },
    releaseClipboard() {
      const resolve = clipboardHeld; clipboardHeld = undefined;
      if (!resolve) return false;
      emit(); resolve(); return true;
    },
    async writeClipboard(text: string) {
      if (typeof text !== "string" || text.length > 20_000) {
        clipboardFailures++; emit(); throw new Error("TEST: invalid simulated clipboard text");
      }
      clipboardWrites++;
      lastClipboard = Object.freeze({ actor, text });
      const fail = clipboardFailureArmed; clipboardFailureArmed = false;
      if (clipboardArmed) {
        clipboardArmed = false;
        await new Promise<void>((resolve) => { clipboardHeld = resolve; emit(); });
      } else emit();
      if (fail) { clipboardFailures++; emit(); throw new Error("TEST: simulated clipboard failure"); }
    },
    async request(url: URL, init: GuardedInit = {}): Promise<Response> {
      calls++; emit();
      if (!(url instanceof URL) || url.origin !== "http://fixture.invalid" || url.username || url.password || url.hash
        || [...url.searchParams].length !== 1 || url.searchParams.getAll("workspaceId").length !== 1
        || url.searchParams.get("workspaceId") !== contentStudioFixtureIds.workspace || !current(init)) return deny();
      const method = (init.method || "GET").toUpperCase();
      if (url.pathname === "/api/crm/content-videos" && (method === "POST" || method === "PATCH")) return deny(501);
      if (url.pathname === "/api/crm/content-videos" && method === "GET") {
        return Response.json({ success: true, mode: "supabase", data: { videos: [{
          id: actor === "A" ? contentStudioFixtureIds.ideaA : contentStudioFixtureIds.ideaB,
          title: `TEST local ${actor}`, niche: "TEST fabricated service", goal: "TEST fabricated goal", duration: "30 seconds",
          style: "TEST fabricated style", audience: "TEST fabricated audience", status: "script_ready", createdAt: "2026-10-20T00:00:00.000Z",
          hook: `TEST local ${actor} hook`, script: `TEST local ${actor} script`, voiceover: `TEST local ${actor} voiceover`,
          cta: `TEST local ${actor} CTA`, caption: `TEST local ${actor} caption`, hashtags: ["#TEST"],
          avatarPrompt: `TEST local ${actor} avatar prompt`, tapnowPrompt: `TEST local ${actor} TapNow prompt`,
        }] } });
      }
      if (url.pathname === "/api/content-studio/usage" && method === "GET") {
        return Response.json({ success: true, mode: "tracked", data: {
          trackingAvailable: true, subscriptionActive: false, plan: null, planTitle: "TEST local fixture: paid generation disabled",
          periodStart: "2026-10-01", textRequests: 0, images: { used: 0, enabled: false, limit: 0, remaining: 0 },
          videoSeconds: { used: 0, enabled: false, limit: 0, remaining: 0 }, videoSecondsPerGeneration: 8,
        } });
      }
      if (url.pathname === "/api/content-studio/generate-package" && method === "POST") {
        const brief = packageBrief(init.body);
        if (!brief) return deny(400);
        return Response.json({ success: true, mode: "demo", data: demoContentPackage(brief) });
      }
      return deny();
    },
  };
}
