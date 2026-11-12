import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { ArrowRight, Check, CircleCheck, Clock3, ExternalLink, Link2, LoaderCircle, RotateCw, ShieldCheck, X } from "lucide-react";
import { PortalShell } from "@/components/portals/PortalShell";
import { parsePartnerEntryCaptured, parsePartnerEntryNotice, parsePartnerEntryPrepared,
  type PartnerEntryNotice } from "../../../../lib/crm/partner-link-contracts";
import { isPartnerEntryCode, PartnerEntryRequestError, requestPartnerEntry, type PartnerEntryRequest } from "./partner-entry-client";
import { challengePartnerEntry, PartnerEntryChallengeError, type PartnerEntryChallenge } from "./partner-entry-challenge";
import "./PartnerEntry.css";

export type PartnerEntryViewProps = {
  code: string;
  request?: PartnerEntryRequest;
  challenge?: PartnerEntryChallenge;
};

type Phase = "idle" | "challenge" | "preparing" | "prepare-unknown" | "ready" | "capturing" | "capture-unknown" | "captured" | "blocked";
type Captured = NonNullable<ReturnType<typeof parsePartnerEntryCaptured>>;
type Snapshot = {
  phase: Phase;
  noticeStatus: "loading" | "ready" | "error";
  notice: PartnerEntryNotice | null;
  consent: boolean;
  expiresAt: string | null;
  captured: Captured | null;
  message: string;
};
const navigation = [{ id: "entry", label: "Партнерская ссылка", icon: Link2 }];
const noNavigation = () => undefined;
const terminalMessage = (code: string) => ({
  partner_entry_expired: "Срок исходного перехода истек.",
  invalid_partner_cookie: "Исходный переход недоступен в этом браузере. Подтвердить его не удалось.",
  partner_entry_not_prepared: "Исходная подготовка не найдена в этом браузере. Фиксация не подтверждена.",
  partner_source_unavailable: "Источник перехода недоступен. Фиксация не подтверждена.",
  partner_notice_changed: "Уведомление изменилось. Прежнее согласие не действует. Исходный переход продолжить нельзя.",
}[code]);
const requestCode = (error: unknown) => error instanceof PartnerEntryRequestError ? error.code : "unconfirmed";
const deadlineFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});

function PartnerEntrySession({ code, request = requestPartnerEntry, challenge = challengePartnerEntry }: PartnerEntryViewProps) {
  const validCode = isPartnerEntryCode(code);
  const [state, setState] = useState<Snapshot>(() => ({
    phase: validCode ? "idle" : "blocked", noticeStatus: validCode ? "loading" : "error",
    notice: null, consent: false, expiresAt: null, captured: null,
    message: validCode ? "" : "Ссылка недействительна. Используйте исходную партнерскую ссылку без изменений.",
  }));
  const snapshot = useRef(state);
  const adapters = useRef({ request, challenge });
  adapters.current = { request, challenge };
  const active = useRef(false);
  const operation = useRef<{ revision: number; controller: AbortController | null }>({ revision: 0, controller: null });
  // Only an unresolved prepare retains its exact body in memory, never in browser storage or React state.
  const pendingPrepare = useRef<((signal: AbortSignal) => Promise<unknown>) | null>(null);
  const challengeElement = useRef<HTMLDivElement>(null);
  const noticeId = useId();
  const consentId = useId();

  const update = useCallback((change: (previous: Snapshot) => Snapshot) => {
    if (!active.current) return;
    snapshot.current = change(snapshot.current);
    setState(snapshot.current);
  }, []);
  const begin = useCallback(() => {
    operation.current.controller?.abort();
    const controller = new AbortController();
    const revision = ++operation.current.revision;
    operation.current.controller = controller;
    return { signal: controller.signal,
      current: () => active.current && !controller.signal.aborted && operation.current.revision === revision };
  }, []);

  const loadNotice = useCallback(async () => {
    const task = begin();
    update(s => ({ ...s, noticeStatus: "loading", notice: null, consent: false }));
    try {
      const notice = parsePartnerEntryNotice(await adapters.current.request("notice", {}, task.signal));
      if (!task.current()) return;
      if (!notice) throw new Error("Unusable notice");
      update(s => ({ ...s, notice, noticeStatus: "ready" }));
    } catch {
      if (task.current()) update(s => ({ ...s, notice: null, noticeStatus: "error", consent: false }));
    }
  }, [begin, update]);

  useEffect(() => {
    active.current = true;
    if (validCode) void loadNotice();
    return () => {
      active.current = false;
      ++operation.current.revision;
      operation.current.controller?.abort();
      pendingPrepare.current = null;
    };
  }, [validCode, loadNotice]);

  const rejectMutation = (error: unknown, kind: "prepare" | "capture") => {
    const code = requestCode(error);
    const terminal = terminalMessage(code);
    if (terminal) {
      pendingPrepare.current = null;
      update(s => ({ ...s, phase: "blocked", message: terminal, consent: code === "partner_notice_changed" ? false : s.consent }));
      if (code === "partner_notice_changed") void loadNotice();
    } else if (kind === "prepare" && code === "challenge_failed") {
      pendingPrepare.current = null;
      update(s => ({ ...s, phase: "idle", message: "Проверка не принята. Подготовка не выполнена." }));
    } else {
      update(s => ({ ...s, phase: kind === "prepare" ? "prepare-unknown" : "capture-unknown",
        message: kind === "prepare"
          ? "Исходная подготовка не подтверждена. Результат неизвестен."
          : "Фиксация не подтверждена. Результат неизвестен." }));
    }
  };

  const prepare = async () => {
    const original = pendingPrepare.current;
    if (!original) return;
    const task = begin();
    update(s => ({ ...s, phase: "preparing", message: "" }));
    try {
      const result = parsePartnerEntryPrepared(await original(task.signal));
      if (!task.current()) return;
      if (!result || (snapshot.current.expiresAt !== null && result.expiresAt !== snapshot.current.expiresAt)) {
        throw new Error("Unconfirmed preparation");
      }
      pendingPrepare.current = null;
      update(s => ({ ...s, phase: Date.parse(result.expiresAt) <= Date.now() ? "blocked" : "ready", expiresAt: result.expiresAt,
        message: Date.parse(result.expiresAt) <= Date.now() ? terminalMessage("partner_entry_expired")! : "" }));
    } catch (error) { if (task.current()) rejectMutation(error, "prepare"); }
  };

  const start = async () => {
    const current = snapshot.current;
    const element = challengeElement.current;
    if (!active.current || current.phase !== "idle" || !current.consent || current.noticeStatus !== "ready" || !current.notice || !element) return;
    const notice = current.notice;
    const selected = adapters.current;
    const task = begin();
    update(s => ({ ...s, phase: "challenge", message: "" }));
    try {
      const token = await selected.challenge(notice.siteKey, element, task.signal);
      if (!task.current() || !snapshot.current.consent || snapshot.current.notice !== notice) return;
      if (typeof token !== "string" || !token || token.length > 2048) throw new PartnerEntryChallengeError("unavailable");
      const body = Object.freeze({ code, source: "link", consent: true, consentVersion: notice.notice.version, challengeToken: token });
      pendingPrepare.current = signal => selected.request("prepare", body, signal);
      await prepare();
    } catch (error) {
      if (!task.current()) return;
      const expired = error instanceof PartnerEntryChallengeError && error.reason === "expired";
      update(s => ({ ...s, phase: "idle", message: expired
        ? "Срок проверки истек. Подготовка не отправлена."
        : "Проверка недоступна или заблокирована политикой безопасности браузера. Подготовка не отправлена." }));
    }
  };

  const capture = async () => {
    const current = snapshot.current;
    if (!active.current || !["ready", "capture-unknown"].includes(current.phase) || !current.consent || !current.notice) return;
    const task = begin();
    const originalDeadline = current.expiresAt;
    update(s => ({ ...s, phase: "capturing", message: "" }));
    try {
      const result = parsePartnerEntryCaptured(await adapters.current.request("capture", {}, task.signal));
      if (!task.current()) return;
      if (!result || result.expiresAt !== originalDeadline) throw new Error("Unconfirmed capture");
      update(s => ({ ...s, phase: "captured", captured: result, expiresAt: result.expiresAt, message: "" }));
    } catch (error) { if (task.current()) rejectMutation(error, "capture"); }
  };

  const cancelChallenge = () => {
    if (snapshot.current.phase !== "challenge") return;
    begin();
    update(s => ({ ...s, phase: "idle", message: "" }));
  };
  const busy = ["challenge", "preparing", "capturing"].includes(state.phase);
  const consentEditable = ["idle", "challenge", "ready", "capture-unknown"].includes(state.phase);
  const canRefresh = state.phase === "idle";

  return <PortalShell title="Партнерская ссылка" roleLabel="Публичный переход" items={navigation} activeId="entry" onNavigate={noNavigation}>
    <div className="partner-entry" data-phase={state.phase} aria-busy={busy || state.noticeStatus === "loading"}>
      <header className="partner-entry-heading">
        <span className="partner-entry-mark"><Link2 size={22} aria-hidden="true" /></span>
        <div><p className="partner-entry-eyebrow">Medina OS</p><h2>{state.phase === "captured" ? "Источник перехода зафиксирован" : "Переход по партнерской ссылке"}</h2></div>
      </header>
      <p className="partner-entry-intro">{state.phase === "captured"
        ? "Подтвержден только источник перехода. Это не регистрация компании и не оформление платного партнерства."
        : "Учет источника перехода возможен только с вашим согласием."}</p>

      {state.phase !== "captured" && validCode && <section className="partner-entry-notice-section" aria-labelledby={`${noticeId}-title`}>
        <div className="partner-entry-section-title"><h3 id={`${noticeId}-title`}>Согласие на учет перехода</h3>
          {canRefresh && state.noticeStatus === "ready" && <button type="button" className="partner-entry-icon" title="Обновить уведомление" aria-label="Обновить уведомление" onClick={() => void loadNotice()}><RotateCw size={17} aria-hidden="true" /></button>}
        </div>
        {state.noticeStatus === "loading" && <p className="partner-entry-progress" role="status"><LoaderCircle size={18} className="partner-entry-spin" aria-hidden="true" />Загружаем уведомление</p>}
        {state.noticeStatus === "error" && <div role="alert"><p>Утвержденное уведомление недоступно. Проверка и отправка не начаты.</p>
          {canRefresh && <button type="button" className="partner-entry-secondary" onClick={() => void loadNotice()}><RotateCw size={16} aria-hidden="true" />Повторить загрузку</button>}</div>}
        {state.notice && <>
          <p id={noticeId} className="partner-entry-literal">{state.notice.notice.text}</p>
          <a className="partner-entry-policy" href={state.notice.notice.policyUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Политика конфиденциальности<ExternalLink size={15} aria-hidden="true" /></a>
          <label className="partner-entry-consent" htmlFor={consentId}>
            <input id={consentId} type="checkbox" checked={state.consent} disabled={!consentEditable} aria-describedby={noticeId}
              onChange={event => { if (!event.target.checked) cancelChallenge(); update(s => ({ ...s, consent: event.target.checked })); }} />
            <span>Я прочитал(а) уведомление и согласен(на) на учет источника перехода.</span>
          </label>
        </>}
      </section>}

      <section className="partner-entry-challenge" hidden={state.phase !== "challenge"} aria-label="Проверка безопасности">
        <div className="partner-entry-section-title"><h3><ShieldCheck size={18} aria-hidden="true" />Проверка безопасности</h3>
          <button type="button" className="partner-entry-icon" title="Закрыть проверку" aria-label="Закрыть проверку" onClick={cancelChallenge}><X size={18} aria-hidden="true" /></button></div>
        <div ref={challengeElement} className="partner-entry-widget" />
      </section>

      <div className="partner-entry-result" aria-live="polite" aria-atomic="true">
        {state.phase === "preparing" && <p className="partner-entry-progress" role="status"><LoaderCircle size={18} className="partner-entry-spin" aria-hidden="true" />Подготавливаем исходный переход</p>}
        {state.phase === "ready" && <p className="partner-entry-progress"><ShieldCheck size={19} aria-hidden="true" />Подготовка подтверждена. Фиксация еще не выполнена.</p>}
        {state.phase === "capturing" && <p className="partner-entry-progress" role="status"><LoaderCircle size={18} className="partner-entry-spin" aria-hidden="true" />Подтверждаем фиксацию источника</p>}
        {state.phase === "captured" && state.captured && <p className="partner-entry-success"><CircleCheck size={21} aria-hidden="true" />Источник зафиксирован <time dateTime={state.captured.capturedAt}>{deadlineFormat.format(new Date(state.captured.capturedAt))}</time></p>}
        {state.message && <p className="partner-entry-warning" role="alert">{state.message}</p>}
        {state.expiresAt && <div className="partner-entry-deadline"><Clock3 size={19} aria-hidden="true" /><div><span>Исходный срок учета перехода</span><time dateTime={state.expiresAt}>{deadlineFormat.format(new Date(state.expiresAt))}</time><p>Повторная отправка не продлевает этот срок.</p></div></div>}
      </div>

      <div className="partner-entry-actions">
        {state.phase === "captured" && <Link href="/partner-company?new=1" className="partner-entry-primary">Подать заявку компании<ArrowRight size={17} aria-hidden="true" /></Link>}
        {state.phase === "idle" && validCode && <button type="button" className="partner-entry-primary" disabled={!state.consent || state.noticeStatus !== "ready" || !state.notice} onClick={() => void start()}>Начать проверку<ArrowRight size={17} aria-hidden="true" /></button>}
        {state.phase === "prepare-unknown" && <button type="button" className="partner-entry-primary" onClick={() => { if (snapshot.current.phase === "prepare-unknown") void prepare(); }}><RotateCw size={17} aria-hidden="true" />Повторить исходную подготовку</button>}
        {(state.phase === "ready" || state.phase === "capture-unknown") && <button type="button" className="partner-entry-primary" disabled={!state.consent || !state.notice} onClick={() => void capture()}>
          {state.phase === "capture-unknown" ? <RotateCw size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}{state.phase === "capture-unknown" ? "Повторить фиксацию" : "Зафиксировать источник перехода"}</button>}
      </div>
      <footer className="partner-entry-boundary"><p>Компания не зарегистрирована. Рабочее пространство не создано.</p><Link href="/partner-company">Моя заявка компании</Link></footer>
    </div>
  </PortalShell>;
}

// A route-code change destroys the previous lifetime, pending intent and callbacks.
export function PartnerEntryView(props: PartnerEntryViewProps) {
  return <PartnerEntrySession key={props.code} {...props} />;
}

export default function PartnerEntry() {
  const { code } = useParams<{ code: string }>();
  return <PartnerEntryView code={code ?? ""} />;
}
