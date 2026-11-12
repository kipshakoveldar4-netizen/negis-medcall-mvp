export type PartnerEntryChallenge = (siteKey: string, element: HTMLElement, signal: AbortSignal) => Promise<string>;

type Turnstile = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};

export const PARTNER_ENTRY_TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let trustedApi: Turnstile | null = null;

export class PartnerEntryChallengeError extends Error {
  constructor(readonly reason: "blocked" | "unavailable" | "expired") {
    super("Partner entry verification unavailable");
    this.name = "PartnerEntryChallengeError";
  }
}

// Called only after a usable notice, explicit consent, and a user start action.
export const challengePartnerEntry: PartnerEntryChallenge = (siteKey, element, signal) => new Promise((resolve, reject) => {
  let settled = false;
  let widget: string | undefined;
  let api: Turnstile | null = null;
  let script: HTMLScriptElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const removeWidget = (id: string) => { try { api?.remove(id); } catch { /* The container is cleared below as well. */ } };
  const cleanup = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    document.removeEventListener("securitypolicyviolation", blocked);
    script?.removeEventListener("load", loaded);
    script?.removeEventListener("error", failed);
    script?.remove();
    if (widget !== undefined) removeWidget(widget);
    element.replaceChildren();
  };
  const finish = (error: Error | null, token?: string) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error);
    else resolve(token!);
  };
  const abort = () => finish(new DOMException("Verification cancelled", "AbortError"));
  const failed = () => finish(new PartnerEntryChallengeError("blocked"));
  const blocked = (event: SecurityPolicyViolationEvent) => {
    if (event.disposition === "report") return;
    if (event.blockedURI === "https://challenges.cloudflare.com" || event.blockedURI.startsWith("https://challenges.cloudflare.com/")) failed();
  };
  const render = () => {
    if (signal.aborted) { abort(); return; }
    clearTimeout(timer);
    timer = setTimeout(() => finish(new PartnerEntryChallengeError("expired")), 120000);
    try {
      widget = api!.render(element, {
        sitekey: siteKey,
        action: "partner_entry",
        theme: "light",
        size: "flexible",
        language: "ru",
        "response-field": false,
        "refresh-expired": "never",
        callback: (token: unknown) => {
          if (typeof token !== "string" || !token || token.length > 2048) finish(new PartnerEntryChallengeError("unavailable"));
          else finish(null, token);
        },
        "error-callback": () => finish(new PartnerEntryChallengeError("unavailable")),
        "expired-callback": () => finish(new PartnerEntryChallengeError("expired")),
        "timeout-callback": () => finish(new PartnerEntryChallengeError("expired")),
      });
      // A test adapter or provider may invoke a callback synchronously in render.
      if (settled && widget !== undefined) removeWidget(widget);
    } catch { finish(new PartnerEntryChallengeError("unavailable")); }
  };
  const loaded = () => {
    if (settled) return;
    const candidate = (window as Window & { turnstile?: Turnstile }).turnstile;
    if (!candidate || typeof candidate.render !== "function" || typeof candidate.remove !== "function") {
      finish(new PartnerEntryChallengeError("unavailable")); return;
    }
    trustedApi = api = candidate;
    render();
  };

  if (signal.aborted) { abort(); return; }
  signal.addEventListener("abort", abort, { once: true });
  document.addEventListener("securitypolicyviolation", blocked);
  if (trustedApi) { api = trustedApi; render(); return; }
  try {
    script = document.createElement("script");
    script.src = PARTNER_ENTRY_TURNSTILE_URL;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.addEventListener("load", loaded);
    script.addEventListener("error", failed);
    timer = setTimeout(failed, 20000);
    document.head.appendChild(script);
  } catch { failed(); }
});
