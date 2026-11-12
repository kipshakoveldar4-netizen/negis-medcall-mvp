import { createPortalDesignStore } from "./portal-design-store";

export const portalDesignStore = createPortalDesignStore(window.location.href);
export const hasSupabaseFrontendEnv = true;
// Visual fixture only: a URL/hash never grants password-recovery authority.
export const getRecoverySessionProof = (): null => null;
export const consumeRecoverySessionProof = (_id: string): void => {};
// Visual fixture only; composed provider/sign-out behavior is covered separately.
export const useAuth = () => ({ signOut: async () => { portalDesignStore.switchActor(null); } });
export const supabase = { auth: {
  getSession: async () => ({ data: { session: portalDesignStore.session() }, error: null }),
  onAuthStateChange: portalDesignStore.onAuthStateChange,
  signOut: async () => { portalDesignStore.switchActor(null); return { error: null }; },
  signInWithPassword: async () => {
    const { view } = portalDesignStore.snapshot();
    portalDesignStore.setState("ready"); portalDesignStore.navigate(view);
    return { data: { session: portalDesignStore.session() }, error: null };
  },
  signUp: async () => ({ data: { session: null }, error: null }),
} };

// Visual dispatch contract only; no native SDK storage or write-authority model.
function currentScope(scope: { isCurrent(): boolean; signal?: AbortSignal }) {
  if (typeof scope?.isCurrent !== "function" || !scope.isCurrent() || scope.signal?.aborted) {
    throw Error("Synthetic sessionAuth requires a current caller scope");
  }
}
export const sessionAuth = {
  onAuthStateChange: supabase.auth.onAuthStateChange,
  updateUserPassword() { throw Error("Password recovery is forbidden in the visual fixture"); },
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

// Never retain a native fetch fallback, even for unknown same-origin routes.
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/crm/")) throw Error("Fixture blocked a non-mock request");
  const options: RequestInit = request ? {
    method: request.method, headers: request.headers, signal: request.signal,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.clone().text() }), ...init,
  } : init || {};
  return portalDesignStore.request(new URL(url.pathname + url.search, "http://fixture.invalid"), options);
};
const blocked = () => { throw Error("Fixture blocked an external transport"); };
window.XMLHttpRequest = new Proxy(window.XMLHttpRequest, { construct: blocked });
window.EventSource = new Proxy(window.EventSource, { construct: blocked });
window.WebSocket = new Proxy(window.WebSocket, { construct(target, args: ConstructorParameters<typeof WebSocket>) {
  const url = new URL(String(args[0]), location.href);
  if (url.protocol !== "ws:" || url.host !== location.host || url.username || url.password) return blocked();
  return Reflect.construct(target, args);
} });
Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => false });
window.open = () => null;
document.addEventListener("click", event => {
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (anchor && new URL(anchor.getAttribute("href")!, location.href).origin !== location.origin) event.preventDefault();
}, true);
Object.assign(window, { __portalDesignQA: portalDesignStore });
