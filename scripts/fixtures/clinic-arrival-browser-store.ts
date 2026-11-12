export const clinicArrivalFixtureIds = Object.freeze({
  workspace: "00000000-0000-4000-8000-000000000901",
  request: "00000000-0000-4000-8000-000000000902",
  appointment: "00000000-0000-4000-8000-000000000903",
  arrival: "00000000-0000-4000-8000-000000000904",
});

const actors = Object.freeze({
  A: "00000000-0000-4000-8000-000000000905",
  B: "00000000-0000-4000-8000-000000000906",
});
type Actor = keyof typeof actors;
type Lifetime = Readonly<{
  actor: Actor;
  actorId: string;
  revision: number;
  isSessionCurrent: () => boolean;
}>;
export type ClinicArrivalGuardedInit = RequestInit & {
  expectedUserId?: string;
  dispatchGuard?: () => boolean;
};

export function isClinicArrivalFixtureLocation(location: {
  pathname?: string;
  hostname?: string;
  protocol?: string;
}) {
  return location.pathname === "/clinic-arrival" && location.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname || "");
}

// Visual composition only: no real session lookup, transport or persistence.
export function createClinicArrivalBrowserFixture(search = "") {
  const params = new URLSearchParams(search);
  const phase = params.get("phase") === "response" ? "response" : "lookup";
  const reply = params.get("reply") === "error" ? "error" : "success";
  let revision = 0;
  function makeLifetime(actor: Actor): Lifetime {
    const lifetime = Object.freeze({
      actor, actorId: actors[actor], revision: ++revision,
      isSessionCurrent: () => current === lifetime,
    });
    return lifetime;
  }
  let current = makeLifetime("A");
  let queued = 0;
  let dispatched = 0;
  let canceled = 0;
  let lastOutcome: Readonly<{ actor: Actor; revision: number; reply: typeof reply }> | null = null;
  const waiting = new Set<() => void>();
  const listeners = new Set<() => void>();
  const getSnapshot = () => Object.freeze({
    lifetime: current, phase, reply, queued, dispatched, canceled,
    held: waiting.size > 0, lastOutcome,
  });
  let snapshot = getSnapshot();
  const emit = () => {
    snapshot = getSnapshot();
    for (const listener of listeners) listener();
  };
  const wait = () => new Promise<void>((resolve) => { waiting.add(resolve); emit(); });
  const deny = () => Response.json({ success: false, error: "Local fixture route disabled" }, { status: 403 });
  const check = (init: ClinicArrivalGuardedInit, lifetime: Lifetime) => {
    if (init.signal?.aborted || current !== lifetime || init.expectedUserId !== current.actorId
      || typeof init.dispatchGuard !== "function" || !init.dispatchGuard()) {
      canceled++;
      emit();
      throw new DOMException("Obsolete local clinic arrival action", "AbortError");
    }
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    switchActor() {
      current = makeLifetime(current.actor === "A" ? "B" : "A");
      emit();
    },
    switchABA() {
      // Both replacements happen before React can commit the resulting A view.
      if (current.actor !== "A") return;
      current = makeLifetime("B");
      current = makeLifetime("A");
      emit();
    },
    release() {
      for (const resolve of waiting) resolve();
      waiting.clear();
      emit();
    },
    async request(url: URL, init: ClinicArrivalGuardedInit = {}): Promise<Response> {
      if (url.origin !== "http://fixture.invalid" || url.pathname !== "/api/crm/clinic-operator-arrivals"
        || url.searchParams.get("workspaceId") !== clinicArrivalFixtureIds.workspace
        || url.searchParams.get("requestId") !== clinicArrivalFixtureIds.request) return deny();
      const method = (init.method || "GET").toUpperCase();
      if (method === "GET") {
        init.signal?.throwIfAborted();
        return Response.json({ success: true, data: { items: [{
          appointmentId: clinicArrivalFixtureIds.appointment, arrivalId: null,
          clientName: `TEST ${current.actor}: synthetic patient`, status: "arrived",
          startsAt: "2026-10-18T10:00:00Z", service: "TEST service", doctorName: "TEST specialist",
          priceMinor: "0", currency: "KZT", clinicConfirmedAt: null,
          operatorCheckedAt: null, operatorCheckResult: null,
        }], hasMore: false } });
      }
      if (method !== "POST") return deny();
      let body: { appointmentId?: unknown } | null;
      try { body = JSON.parse(String(init.body)); } catch { return deny(); }
      if (!body || Object.keys(body).length !== 1 || body.appointmentId !== clinicArrivalFixtureIds.appointment) return deny();
      const lifetime = current;
      check(init, lifetime);
      if (phase === "lookup") {
        queued++;
        await wait();
      } else {
        // The response scenario still has a simulated asynchronous lookup boundary.
        await Promise.resolve();
      }
      check(init, lifetime);
      dispatched++;
      emit();
      if (phase === "response") await wait();
      // A dispatched write can finish for an old actor; it must not become a cancellation.
      lastOutcome = Object.freeze({ actor: lifetime.actor, revision: lifetime.revision, reply });
      emit();
      return reply === "error"
        ? Response.json({ success: false, error: "TEST: local arrival failure" }, { status: 500 })
        : Response.json({ success: true, data: { localOnly: true, arrivalId: clinicArrivalFixtureIds.arrival } });
    },
  };
}
