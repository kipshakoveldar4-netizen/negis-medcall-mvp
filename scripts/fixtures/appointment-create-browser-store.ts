export const appointmentCreateFixtureIds = Object.freeze({
  workspace: "00000000-0000-4000-8000-000000001201",
  A: "00000000-0000-4000-8000-000000001202",
  B: "00000000-0000-4000-8000-000000001203",
});

type Actor = "A" | "B";
type Role = "owner" | "doctor";
type Phase = "lookup" | "response";
type FixtureSession = { user: { id: string }; access_token: string };
type AuthListener = (event: string, session: FixtureSession | null) => void;
type GuardedInit = RequestInit & { expectedUserId?: string; dispatchGuard?: () => boolean };
type ActorState = Readonly<{ actor: Actor; actorId: string; role: Role }>;

export function isAppointmentCreateFixtureLocation(location: {
  pathname?: string; hostname?: string; protocol?: string; search?: string;
}) {
  return location.pathname === "/appointments" && location.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname || "")
    && new URLSearchParams(location.search || "").get("appointmentCreate") === "deferred";
}

// Visual simulation only. No SDK token lookup, transport, or server commit occurs.
export function createAppointmentCreateBrowserFixture(search = "") {
  let actor: Actor = "A";
  let role: Role = "owner";
  let revision = 0;
  let refreshes = 0;
  let authEvents = 0;
  let phase: Phase = new URLSearchParams(search).get("phase") === "response" ? "response" : "lookup";
  let calls = 0;
  let queued = 0;
  let dispatched = 0;
  let blocked = 0;
  let replies = 0;
  let lateReplies = 0;
  let lastReply: Readonly<{ actor: Actor; role: Role; replayed: boolean; stale: boolean }> | null = null;
  let updateAuth: ((state: ActorState) => void) | undefined;
  const listeners = new Set<() => void>();
  const authListeners = new Set<AuthListener>();
  const held: Array<{ phase: Phase; resolve: () => void }> = [];
  const keyedReplies = new Map<string, { fingerprint: string; item: Record<string, unknown> }>();
  const actorState = (): ActorState => ({ actor, actorId: appointmentCreateFixtureIds[actor], role });
  const session = (): FixtureSession => ({
    user: { id: appointmentCreateFixtureIds[actor] },
    access_token: `visual-fixture-invalid-token-${refreshes}`,
  });
  const readSnapshot = () => Object.freeze({
    ...actorState(), revision, refreshes, authEvents, phase, calls, queued, dispatched, blocked, replies, lateReplies,
    held: held.length, heldQueued: held.filter((item) => item.phase === "lookup").length,
    heldResponse: held.filter((item) => item.phase === "response").length,
    keys: keyedReplies.size, lastReply,
  });
  let snapshot = readSnapshot();
  const emit = () => {
    snapshot = readSnapshot();
    for (const listener of listeners) listener();
  };
  const emitAuth = (event: string) => {
    authEvents++;
    const next = session();
    for (const listener of authListeners) listener(event, next);
  };
  const changeActor = (next: Actor) => {
    actor = next;
    revision++;
    updateAuth?.(actorState());
    emitAuth("SIGNED_IN");
  };
  const isCurrent = (init: GuardedInit) => !init.signal?.aborted
    && init.expectedUserId === appointmentCreateFixtureIds[actor]
    && typeof init.dispatchGuard === "function" && init.dispatchGuard();
  const check = (init: GuardedInit) => {
    if (isCurrent(init)) return;
    blocked++;
    emit();
    throw new DOMException("Obsolete local appointment create", "AbortError");
  };
  const wait = (at: Phase) => new Promise<void>((resolve) => {
    held.push({ phase: at, resolve });
    emit();
  });
  const deny = (status = 403) => Response.json({ success: false, error: "TEST: local write disabled" }, { status });

  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    bindAuth(callback: (state: ActorState) => void) {
      updateAuth = callback;
      callback(actorState());
    },
    session,
    onAuthStateChange(listener: AuthListener) {
      authListeners.add(listener);
      return { data: { subscription: { unsubscribe() { authListeners.delete(listener); } } } };
    },
    switchActor() { changeActor(actor === "A" ? "B" : "A"); emit(); },
    switchABA() {
      if (actor !== "A") return;
      // Both raw SDK events run synchronously, before React can commit B.
      changeActor("B");
      changeActor("A");
      emit();
    },
    toggleRole() {
      role = role === "owner" ? "doctor" : "owner";
      revision++;
      updateAuth?.(actorState());
      emitAuth("USER_UPDATED");
      emit();
    },
    refreshSameActor() { refreshes++; emitAuth("TOKEN_REFRESHED"); emit(); },
    setPhase(next: Phase) { phase = next; emit(); },
    release() { held.shift()?.resolve(); emit(); },
    async request(url: URL, init: GuardedInit = {}): Promise<Response> {
      if (url.origin !== "http://fixture.invalid" || url.pathname !== "/api/crm/appointments"
        || url.searchParams.get("workspaceId") !== appointmentCreateFixtureIds.workspace
        || (init.method || "GET").toUpperCase() !== "POST") return deny();
      calls++;
      emit();
      check(init);
      let body: Record<string, unknown>;
      try {
        if (typeof init.body !== "string" || init.body.length > 256_000) return deny(400);
        const parsed: unknown = JSON.parse(init.body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return deny(400);
        body = parsed as Record<string, unknown>;
        if (body.workspaceId !== appointmentCreateFixtureIds.workspace || "id" in body
          || typeof body.requestKey !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestKey)) return deny(400);
      } catch { return deny(400); }
      if (held.length >= 8) return deny(429);
      const startedBy = actorState();
      const requestPhase = phase;
      if (requestPhase === "lookup") {
        queued++;
        await wait("lookup");
      } else {
        await Promise.resolve();
      }
      // The caller's guard, not a parallel fixture lifetime, rejects queued ABA/role changes.
      check(init);
      if (held.length >= 8) return deny(429);
      const key = `${init.expectedUserId}:${body.requestKey}`;
      const fingerprint = JSON.stringify(body);
      const previous = keyedReplies.get(key);
      if (!previous && keyedReplies.size >= 32) return deny(429);
      dispatched++;
      emit();
      if (previous && previous.fingerprint !== fingerprint) {
        return Response.json({ success: false, code: "appointment_request_conflict", error: "TEST: key payload changed" }, { status: 409 });
      }
      const { requestKey: _requestKey, ...payload } = body;
      const item = previous?.item ?? {
        ...payload, id: `00000000-0000-4000-8000-${String(1210 + keyedReplies.size).padStart(12, "0")}`,
      };
      if (!previous) keyedReplies.set(key, { fingerprint, item });
      if (requestPhase === "response") await wait("response");
      // After simulated dispatch, return even an obsolete reply to exercise the page's guard.
      const stale = !isCurrent(init);
      replies++;
      if (stale) lateReplies++;
      lastReply = Object.freeze({ actor: startedBy.actor, role: startedBy.role, replayed: Boolean(previous), stale });
      emit();
      return Response.json({ success: true, mode: "supabase", data: {
        item, clientCreated: false, replayed: Boolean(previous), localOnly: true,
      } });
    },
  };
}
