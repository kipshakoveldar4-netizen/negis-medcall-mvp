type GuardedInit = RequestInit & { dispatchGuard?: () => boolean };

// Local browser gate only. The delegate still rejects all synthetic writes.
export function createOperatorDispatchFixture(delegate: (url: URL, init?: RequestInit) => Response) {
  let held = true;
  let queued = 0;
  let canceled = 0;
  let dispatched = 0;
  const waiting = new Set<() => void>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const check = (init?: GuardedInit) => {
    init?.signal?.throwIfAborted();
    if (init?.dispatchGuard && !init.dispatchGuard()) {
      canceled++;
      emit();
      throw new DOMException("Obsolete local action", "AbortError");
    }
  };
  return {
    snapshot: () => ({ held, queued, canceled, dispatched }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    release() {
      held = false;
      for (const resolve of waiting) resolve();
      waiting.clear();
      emit();
    },
    async request(url: URL, init?: GuardedInit): Promise<Response> {
      if (!init?.method || init.method === "GET") return delegate(url, init);
      check(init);
      if (held) {
        queued++;
        emit();
        await new Promise<void>(resolve => { waiting.add(resolve); });
      }
      check(init);
      dispatched++;
      emit();
      return delegate(url, init);
    },
  };
}
