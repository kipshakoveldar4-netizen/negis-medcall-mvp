import { useLayoutEffect, useRef, useState } from "react";
import { Check, CircleAlert, Clipboard, Info, Link2, LoaderCircle, RefreshCw } from "lucide-react";
import { parsePartnerLink, type PartnerLink as LinkSnapshot } from "../../../../../lib/crm/partner-link-contracts";
import "./partner-link.css";

export type PartnerLinkRequest = (options: { signal: AbortSignal; isCurrent: () => boolean }) => Promise<unknown>;
type Props = {
  actorId: string;
  profileId: string;
  isSessionCurrent: () => boolean;
  request: PartnerLinkRequest;
  onAccessDenied: () => void;
};
type Read = Readonly<{ controller: AbortController }>;
type Lifetime = Props & { expired: boolean; denied: boolean; read: Read | null; view: View | null; copy: object | null };
type View = Readonly<{ lifetime: Lifetime; read: Read; link: LinkSnapshot }>;
type Result = Readonly<{ lifetime: Lifetime; read: Read; view: View | null; error: string }>;
type CopyState = Readonly<{ view: View; state: "copying" | "copied" | "failed" }>;
const deniedMessage = "Доступ к партнёрской ссылке изменился. Обновите профиль.";
const unavailableMessage = "Партнёрская ссылка временно недоступна. Попробуйте позже.";
const status = (error: unknown) => error && typeof error === "object" && "status" in error ? Number(error.status) : 0;

function retire(lifetime: Lifetime) {
  lifetime.expired = true;
  lifetime.read?.controller.abort();
  lifetime.read = null;
  lifetime.view = null;
  lifetime.copy = null;
}

export function PartnerLink({ actorId, profileId, isSessionCurrent, request, onAccessDenied }: Props) {
  const [lifetime, setLifetime] = useState<Lifetime | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [copyState, setCopyState] = useState<CopyState | null>(null);
  const live = useRef<Lifetime | null>(null);
  const latest = useRef({ actorId, profileId, isSessionCurrent });
  latest.current = { actorId, profileId, isSessionCurrent };

  function current(owner: Lifetime) {
    if (live.current !== owner || owner.expired) return false;
    if (!owner.actorId || !owner.profileId || owner.actorId !== latest.current.actorId || owner.profileId !== latest.current.profileId
      || !owner.isSessionCurrent() || !latest.current.isSessionCurrent()) {
      retire(owner);
      return false;
    }
    return true;
  }

  function hide(owner: Lifetime) {
    if (live.current !== owner) return;
    owner.view = null;
    owner.copy = null;
    setResult(null);
    setCopyState(null);
  }

  function load(owner: Lifetime) {
    if (live.current !== owner) return;
    if (!current(owner)) { hide(owner); return; }
    owner.read?.controller.abort();
    hide(owner);
    const read: Read = Object.freeze({ controller: new AbortController() });
    owner.read = read;
    setResult(Object.freeze({ lifetime: owner, read, view: null, error: "" }));
    const valid = () => {
      const valid = !read.controller.signal.aborted && owner.read === read && current(owner);
      if (!valid && live.current === owner && owner.expired) hide(owner);
      return valid;
    };
    void (async () => {
      try {
        if (!valid()) return;
        const value = await owner.request({ signal: read.controller.signal, isCurrent: valid });
        if (!valid()) return;
        const link = parsePartnerLink(value);
        if (!link || link.profileId !== owner.profileId) throw Error("Invalid partner link snapshot");
        const view: View = Object.freeze({ lifetime: owner, read, link });
        owner.view = view;
        setResult(Object.freeze({ lifetime: owner, read, view, error: "" }));
      } catch (error) {
        if (!valid()) return;
        owner.view = null;
        if ([401, 403, 404].includes(status(error))) {
          owner.denied = true;
          retire(owner);
          setCopyState(null);
          setResult(Object.freeze({ lifetime: owner, read, view: null, error: deniedMessage }));
          owner.onAccessDenied();
          return;
        }
        setResult(Object.freeze({ lifetime: owner, read, view: null, error: unavailableMessage }));
      }
    })();
  }

  useLayoutEffect(() => {
    // Keep the original callbacks for this lifetime, including effect replay.
    const owner: Lifetime = { actorId, profileId, isSessionCurrent, request, onAccessDenied,
      expired: false, denied: false, read: null, view: null, copy: null };
    live.current = owner;
    setLifetime(owner);
    load(owner);
    const focus = () => load(owner);
    const visible = () => {
      if (document.visibilityState === "visible") load(owner);
      else if (live.current === owner) {
        owner.read?.controller.abort();
        owner.read = null;
        hide(owner);
      }
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      retire(owner);
      if (live.current === owner) live.current = null;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [actorId, profileId]);

  function sameView(view: View) {
    return current(view.lifetime) && view.lifetime.view === view && view.lifetime.read === view.read && !view.read.controller.signal.aborted;
  }

  async function copy(view: View) {
    if (!sameView(view)) { if (view.lifetime.expired) hide(view.lifetime); return; }
    if (view.lifetime.copy) return;
    const attempt = Object.freeze({ view });
    view.lifetime.copy = attempt;
    setCopyState(Object.freeze({ view, state: "copying" }));
    const valid = () => sameView(view) && view.lifetime.copy === attempt;
    try {
      await navigator.clipboard.writeText(view.link.url);
      if (valid()) setCopyState(Object.freeze({ view, state: "copied" }));
    } catch {
      if (valid()) setCopyState(Object.freeze({ view, state: "failed" }));
    } finally {
      if (view.lifetime.copy === attempt) view.lifetime.copy = null;
      if (view.lifetime.expired) hide(view.lifetime);
    }
  }

  const available = lifetime !== null && current(lifetime);
  const response = available && result?.lifetime === lifetime && result.read === lifetime.read ? result : null;
  const view = response?.view && sameView(response.view) ? response.view : null;
  const feedback = view && copyState?.view === view ? copyState.state : null;
  const error = lifetime?.denied ? deniedMessage : response?.error ?? "";
  const pending = available && !view && !error;
  return <section className="partner-link" aria-label="Моя партнёрская ссылка" aria-busy={pending}>
    <h2>Моя партнёрская ссылка</h2>
    <div className="partner-link-row">
      <div className="partner-link-value">
        <Link2 size={20} aria-hidden="true" />
        {view ? <output aria-label="Партнёрская ссылка">{view.link.url}</output>
          : <span>{error ? "Ссылка недоступна" : "Проверяем ссылку…"}</span>}
      </div>
      <button type="button" className="partner-link-icon" title="Скопировать партнёрскую ссылку" aria-label="Скопировать партнёрскую ссылку"
        disabled={!view || feedback === "copying"} onClick={() => { if (view) void copy(view); }}>
        {feedback === "copied" ? <Check size={18} aria-hidden="true" /> : <Clipboard size={18} aria-hidden="true" />}
      </button>
      <button type="button" className="partner-link-icon" title="Обновить партнёрскую ссылку" aria-label="Обновить партнёрскую ссылку"
        disabled={!available || pending} onClick={() => {
          if (response && live.current === response.lifetime && response.lifetime.read === response.read) load(response.lifetime);
        }}><RefreshCw size={18} aria-hidden="true" /></button>
    </div>
    {error ? <p role="alert" className="partner-link-note partner-link-error"><CircleAlert size={16} aria-hidden="true" /><span>{error}</span></p>
      : !view ? <p role="status" className="partner-link-note"><LoaderCircle size={16} aria-hidden="true" /><span>{available ? "Загружаем ссылку…" : "Проверяем доступ к ссылке…"}</span></p>
      : <p className="partner-link-note"><Info size={16} aria-hidden="true" /><span>Первая оплата: в течение 7 дней.</span></p>}
    {view && <p role="status" aria-live="polite" className={`partner-link-feedback${feedback === "failed" ? " partner-link-error" : ""}`}>
      {feedback === "copying" ? "Копируем ссылку…" : feedback === "copied" ? "Ссылка скопирована." : feedback === "failed" ? "Не удалось скопировать ссылку." : ""}
    </p>}
  </section>;
}
