import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Building2, Check, CircleAlert, ExternalLink, LoaderCircle, RefreshCw, Send, ShieldCheck, X } from "lucide-react";
import {
  parsePartnerCompany, parsePartnerCompanyContext, parsePartnerCompanyReceipt,
  type PartnerCompany, type PartnerCompanyContext, type PartnerCompanyReceipt,
} from "../../../../../lib/crm/partner-company-contracts";
import "./partner-company-application.css";

export type PartnerCompanyApplicationRequest = (options: {
  operation: "context" | "submit" | "read" | "close";
  body?: unknown;
  requestId?: string;
  sourceId?: string;
  signal: AbortSignal;
  isCurrent(): boolean;
}) => Promise<unknown>;

export type PartnerCompanyApplicationProps = {
  actorId: string;
  isSessionCurrent(): boolean;
  request: PartnerCompanyApplicationRequest;
  onAccessDenied(): void;
};

type Metadata = Readonly<{ actorId: string; requestId: string; sourceId: string }>;
type SubmitBody = Readonly<{ requestId: string; company: PartnerCompany; consent: true; consentVersion: string }>;
type Attempt = { metadata: Metadata; body: SubmitBody | null; closing: boolean; resolved: boolean };
type Draft = Readonly<PartnerCompany & { accepted: boolean }>;
type Ticket = Readonly<{ controller: AbortController }>;
type Lifetime = PartnerCompanyApplicationProps & {
  expired: boolean;
  denied: boolean;
  focused: boolean;
  frame: object;
  storage: Storage | null;
  storageError: string;
  context: PartnerCompanyContext | null;
  draft: Draft;
  attempt: Attempt | null;
  receipt: PartnerCompanyReceipt | null;
  ticket: Ticket | null;
  timer: ReturnType<typeof setTimeout> | null;
  closeAccepted: boolean;
  phase: "loading" | "ready" | "unconfirmed" | "terminal" | "hidden" | "error";
  error: string;
};

const storageFailure = "Ключ исходной отправки недоступен. Новая заявка заблокирована.";
const deniedMessage = "Доступ к регистрации компании изменился.";
const uuid = (v: unknown): v is string => typeof v === "string" && v.length === 36
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const storageKey = (actorId: string) => `medina_partner_company_v1:${actorId}`;
const status = (e: unknown) => e && typeof e === "object" && "status" in e ? Number(e.status) : 0;
const emptyDraft = (): Draft => Object.freeze({ name: "", purpose: "clinic_services", vertical: "clinic", timeZone: "Asia/Almaty", ownerName: "", accepted: false });
const applicationStates = { pending: "На рассмотрении", approved: "Одобрена", rejected: "Отклонена" };
const purposes = { clinic_services: "Услуги клиники", marketing: "Маркетинг", mortgage_leads: "Ипотечные заявки" };
const verticals = { clinic: "Клиника", beauty: "Красота", dental: "Стоматология" };

function sessionStorageOrNull(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

function restore(storage: Storage | null, actorId: string): { attempt: Attempt | null; error: string } {
  const failed = { attempt: null, error: storageFailure };
  if (!storage || !uuid(actorId)) return failed;
  try {
    const raw = storage.getItem(storageKey(actorId));
    if (raw === null) return { attempt: null, error: "" };
    if (raw.length > 512) return failed;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return failed;
    const m = v as Record<string, unknown>;
    if (Object.keys(m).length !== 3 || m.actorId !== actorId || !uuid(m.requestId) || !uuid(m.sourceId)) return failed;
    return { attempt: { metadata: Object.freeze({ actorId, requestId: m.requestId, sourceId: m.sourceId }), body: null, closing: false, resolved: false }, error: "" };
  } catch { return failed; }
}

function persist(storage: Storage | null, metadata: Metadata): boolean {
  if (!storage) return false;
  try {
    const key = storageKey(metadata.actorId), raw = JSON.stringify(metadata);
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, raw);
    return storage.getItem(key) === raw;
  } catch { return false; }
}

function resolveRecoveryMetadata(owner: Lifetime, attempt: Attempt, state: "committed" | "abandoned"): boolean {
  if (!owner.storage) return false;
  try {
    const key = storageKey(attempt.metadata.actorId), raw = owner.storage.getItem(key);
    if (raw === null) return state === "abandoned" && attempt.resolved;
    const saved = restore(owner.storage, owner.actorId).attempt?.metadata;
    if (!saved || saved.requestId !== attempt.metadata.requestId || saved.sourceId !== attempt.metadata.sourceId) return false;
    // Keep the application pointer for status reads after a successful reload.
    if (state === "committed") return true;
    owner.storage.removeItem(key);
    return owner.storage.getItem(key) === null;
  } catch { return false; }
}

function stop(owner: Lifetime) {
  const ticket = owner.ticket;
  owner.ticket = null;
  ticket?.controller.abort();
  if (owner.timer !== null) clearTimeout(owner.timer);
  owner.timer = null;
}

function hide(owner: Lifetime) {
  stop(owner);
  owner.context = null;
  owner.receipt = null;
  owner.draft = emptyDraft();
  owner.closeAccepted = false;
  owner.phase = "hidden";
}

function retire(owner: Lifetime) {
  owner.expired = true;
  hide(owner);
  if (owner.attempt) owner.attempt.body = null;
  owner.attempt = null;
}

function timeZones(): readonly string[] {
  let values: string[];
  try { values = Intl.supportedValuesOf("timeZone"); }
  catch { values = ["Asia/Almaty", "Asia/Aqtau", "Asia/Aqtobe", "Asia/Atyrau", "Asia/Oral", "Asia/Qostanay", "Asia/Qyzylorda", "Asia/Bishkek", "Asia/Tashkent", "Europe/Moscow"]; }
  return Object.freeze(["Asia/Almaty", "UTC", ...values.filter(v => v !== "Asia/Almaty" && /^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\//.test(v)).sort()]);
}
const zones = timeZones();
const displayDate = (v: string) => new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Almaty",
}).format(new Date(v));
const visible = (owner: Lifetime) => owner.focused && document.visibilityState !== "hidden";

export function PartnerCompanyApplication({ actorId, isSessionCurrent, request, onAccessDenied }: PartnerCompanyApplicationProps) {
  const [lifetime, setLifetime] = useState<Lifetime | null>(null);
  const [, render] = useState(0);
  const live = useRef<Lifetime | null>(null);
  const latest = useRef({ actorId, isSessionCurrent });
  latest.current = { actorId, isSessionCurrent };

  function current(owner: Lifetime): boolean {
    if (live.current !== owner || owner.expired) return false;
    if (owner.actorId !== latest.current.actorId || !owner.isSessionCurrent() || !latest.current.isSessionCurrent()) {
      retire(owner);
      return false;
    }
    return true;
  }

  function publish(owner: Lifetime) {
    if (live.current !== owner) return;
    owner.frame = {};
    render(n => n + 1);
  }

  function active(owner: Lifetime): boolean {
    if (current(owner)) return true;
    publish(owner);
    return false;
  }

  function refuse(owner: Lifetime) {
    if (!current(owner)) return;
    owner.denied = true;
    retire(owner);
    publish(owner);
    owner.onAccessDenied();
  }

  function sameFrame(owner: Lifetime, frame: object): boolean {
    return active(owner) && owner.frame === frame && visible(owner);
  }

  async function operate(owner: Lifetime, operation: "context" | "submit" | "read" | "close", attempt: Attempt | null = null) {
    if (!active(owner) || owner.ticket || !visible(owner)) return;
    if (operation !== "context" && (!attempt || owner.attempt !== attempt)) return;
    if (operation === "submit" && (!attempt?.body || attempt.closing || attempt.resolved)) return;
    if (operation === "close" && attempt) {
      // Closing fences the original command; even a lost close reply must not revive a write retry.
      attempt.closing = true;
      attempt.body = null;
    }
    hide(owner);
    const ticket: Ticket = Object.freeze({ controller: new AbortController() });
    owner.ticket = ticket;
    owner.phase = "loading";
    owner.error = "";
    publish(owner);
    const valid = () => {
      const valid = current(owner) && owner.ticket === ticket && !ticket.controller.signal.aborted && visible(owner);
      if (!valid && owner.expired) publish(owner);
      return valid;
    };
    try {
      if (!valid()) return;
      const value = await owner.request({ operation, ...(operation === "submit" ? { body: attempt!.body! } : {}),
        ...(operation === "read" || operation === "close" ? { requestId: attempt!.metadata.requestId, sourceId: attempt!.metadata.sourceId } : {}),
        signal: ticket.controller.signal, isCurrent: valid });
      if (!valid()) return;
      if (operation === "context") {
        const context = parsePartnerCompanyContext(value);
        if (!context) throw Error("Invalid company context");
        const remaining = Date.parse(context.expiresAt) - Date.now();
        if (remaining <= 0) {
          owner.phase = "error";
          owner.error = "Срок регистрации по этой ссылке истёк.";
        } else {
          owner.context = context;
          owner.phase = "ready";
          owner.timer = setTimeout(() => {
            if (!active(owner) || owner.context !== context) return;
            hide(owner);
            owner.phase = "error";
            owner.error = "Срок регистрации по этой ссылке истёк.";
            publish(owner);
          }, Math.min(remaining, 2_147_483_647));
        }
      } else {
        const receipt = parsePartnerCompanyReceipt(value);
        if (!attempt || !receipt || receipt.requestId.toLowerCase() !== attempt.metadata.requestId.toLowerCase()
          || receipt.sourceId.toLowerCase() !== attempt.metadata.sourceId.toLowerCase()
          || (operation === "submit" && receipt.state !== "committed")) throw Error("Invalid original company receipt");
        if (receipt.state === "unconfirmed") {
          if (attempt.resolved) throw Error("Contradictory company receipt");
          owner.phase = "unconfirmed";
        } else {
          if (receipt.state === "committed" && attempt.body
            && (Object.keys(attempt.body.company) as (keyof PartnerCompany)[]).some(k => receipt.application.company[k] !== attempt.body!.company[k])) {
            throw Error("Company receipt does not match original payload");
          }
          attempt.body = null;
          attempt.closing = true;
          if (resolveRecoveryMetadata(owner, attempt, receipt.state)) { attempt.resolved = true; owner.storageError = ""; }
          else owner.storageError = "Результат подтверждён, но ключ восстановления недоступен. Новая заявка заблокирована.";
          owner.receipt = receipt;
          owner.phase = "terminal";
        }
      }
    } catch (error) {
      if (!valid()) return;
      if ([401, 403, 404].includes(status(error))) { refuse(owner); return; }
      owner.phase = attempt ? "unconfirmed" : "error";
      owner.error = attempt ? "Результат отправки не подтверждён. Проверьте исходную заявку." : "Не удалось загрузить данные регистрации.";
    } finally {
      if (owner.ticket === ticket) {
        owner.ticket = null;
        if (current(owner)) publish(owner);
      }
    }
  }

  function load(owner: Lifetime) {
    if (!active(owner)) return;
    hide(owner);
    owner.error = "";
    if (!owner.attempt) {
      owner.storage = sessionStorageOrNull();
      const saved = restore(owner.storage, owner.actorId);
      owner.attempt = saved.attempt;
      owner.storageError = saved.error;
    }
    if (owner.storageError && !owner.attempt) { owner.phase = "error"; publish(owner); return; }
    if (!visible(owner)) { publish(owner); return; }
    void operate(owner, owner.attempt ? "read" : "context", owner.attempt);
  }

  useLayoutEffect(() => {
    // Snapshot all callbacks per lifetime, not per render. Auth ABA never revives an old operation.
    const owner: Lifetime = { actorId, isSessionCurrent, request, onAccessDenied, expired: false, denied: false, focused: true,
      frame: {}, storage: sessionStorageOrNull(), storageError: "", context: null, draft: emptyDraft(), attempt: null,
      receipt: null, ticket: null, timer: null, closeAccepted: false, phase: "loading", error: "" };
    live.current = owner;
    setLifetime(owner);
    load(owner);
    const focus = () => {
      if (!active(owner)) return;
      owner.focused = true;
      load(owner);
    };
    const conceal = () => { if (active(owner)) { hide(owner); publish(owner); } };
    const blur = () => { owner.focused = false; conceal(); };
    const visibility = () => {
      if (document.visibilityState !== "visible") conceal();
      else if (owner.focused) load(owner);
    };
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      retire(owner);
      if (live.current === owner) live.current = null;
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [actorId]);

  function submit(owner: Lifetime, frame: object, context: PartnerCompanyContext, draft: Draft, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sameFrame(owner, frame) || owner.context !== context || owner.draft !== draft || owner.ticket || owner.attempt || owner.storageError) return;
    if (Date.parse(context.expiresAt) <= Date.now()) { load(owner); return; }
    const company = parsePartnerCompany({ name: draft.name.trim(), purpose: draft.purpose, vertical: draft.vertical,
      timeZone: draft.timeZone, ownerName: draft.ownerName.trim() });
    if (!company || !draft.accepted || !zones.includes(draft.timeZone)) {
      owner.error = "Проверьте данные компании и подтвердите согласие.";
      publish(owner);
      return;
    }
    const saved = restore(owner.storage, owner.actorId);
    if (saved.attempt || saved.error) {
      owner.attempt = saved.attempt;
      owner.storageError = saved.error;
      load(owner);
      return;
    }
    try {
      const requestId = crypto.randomUUID();
      if (!uuid(requestId)) throw Error("UUID unavailable");
      const metadata = Object.freeze({ actorId: owner.actorId, requestId, sourceId: context.sourceId });
      const body: SubmitBody = Object.freeze({ requestId, company, consent: true, consentVersion: context.notice.version });
      if (!persist(owner.storage, metadata)) throw Error("Recovery storage unavailable");
      const attempt: Attempt = { metadata, body, closing: false, resolved: false };
      owner.attempt = attempt;
      void operate(owner, "submit", attempt);
    } catch {
      hide(owner);
      owner.phase = "error";
      owner.storageError = "Не удалось сохранить ключ отправки. Запрос не отправлен.";
      publish(owner);
    }
  }

  const owner = lifetime && current(lifetime) ? lifetime : null;
  const frame = owner?.frame;
  const context = owner?.context;
  const draft = owner?.draft;
  const attempt = owner?.attempt;
  const receipt = owner?.receipt;
  const busy = Boolean(owner?.ticket);
  const update = (patch: Partial<Draft>) => {
    if (!owner || !frame || !context || !draft || !sameFrame(owner, frame) || owner.context !== context || owner.draft !== draft || busy) return;
    owner.draft = Object.freeze({ ...draft, ...patch });
    owner.error = "";
    publish(owner);
  };
  const recover = (operation: "read" | "submit" | "close") => {
    if (!owner || !frame || !attempt || !sameFrame(owner, frame) || owner.attempt !== attempt || busy) return;
    if (operation === "close" && !owner.closeAccepted) return;
    void operate(owner, operation, attempt);
  };

  return <section className="partner-company-application" aria-label="Заявка компании" aria-busy={busy}>
    <header className="pca-heading">
      <div><Building2 size={21} aria-hidden="true" /><h2>Заявка компании</h2></div>
      <button type="button" className="pca-button pca-icon" title="Обновить данные заявки" aria-label="Обновить данные заявки" disabled={!owner || busy}
        onClick={() => { if (owner && frame && sameFrame(owner, frame)) load(owner); }}><RefreshCw size={18} aria-hidden="true" /></button>
    </header>
    {!owner ? <p role={lifetime?.denied ? "alert" : "status"} className="pca-note">{lifetime?.denied ? deniedMessage : "Проверяем доступ…"}</p> : <>
      {(owner.error || owner.storageError) && <p role="alert" className="pca-error"><CircleAlert size={17} aria-hidden="true" /><span>{owner.storageError || owner.error}</span></p>}
      {busy && <p role="status" className="pca-note"><LoaderCircle size={17} aria-hidden="true" /><span>{attempt ? "Проверяем исходную отправку…" : "Загружаем данные регистрации…"}</span></p>}
      {owner.phase === "hidden" && <p role="status" className="pca-note">Данные скрыты до повторной проверки доступа.</p>}
      {context && draft && frame && !attempt && !owner.storageError && <form aria-label="Регистрация компании" onSubmit={event => submit(owner, frame, context, draft, event)}>
        <fieldset className="pca-fields" disabled={busy}>
          <legend>Компания</legend>
          <label className="pca-wide"><span>Название компании</span><input name="companyName" type="text" autoComplete="off" required minLength={2} maxLength={120} value={draft.name} onChange={e => update({ name: e.target.value })} /></label>
          <label><span>Направление</span><select name="purpose" required value={draft.purpose} onChange={e => {
            const purpose = e.target.value as PartnerCompany["purpose"];
            if (Object.hasOwn(purposes, purpose)) update({ purpose, vertical: purpose === "clinic_services" ? "clinic" : null, accepted: false });
          }}>{Object.entries(purposes).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          {draft.purpose === "clinic_services" && <label><span>Специализация</span><select name="vertical" required value={draft.vertical ?? "clinic"} onChange={e => {
            const vertical = e.target.value as NonNullable<PartnerCompany["vertical"]>;
            if (Object.hasOwn(verticals, vertical)) update({ vertical });
          }}>{Object.entries(verticals).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}
          <label><span>Имя владельца</span><input name="ownerName" type="text" autoComplete="off" required maxLength={120} value={draft.ownerName} onChange={e => update({ ownerName: e.target.value })} /></label>
          <label><span>Часовой пояс</span><select name="timeZone" required value={draft.timeZone} onChange={e => update({ timeZone: e.target.value })}>
            {zones.map(zone => <option value={zone} key={zone}>{zone}</option>)}
          </select></label>
          <label className="pca-wide"><span>Подтверждённая почта заявителя</span><input type="email" readOnly aria-readonly="true" autoComplete="off" value={context.applicantEmail} /></label>
        </fieldset>
        <section className="pca-notice" aria-label="Уведомление о регистрации компании">
          <h3><ShieldCheck size={18} aria-hidden="true" />Согласие на регистрацию</h3>
          <p className="pca-notice-copy">{context.notice.text}</p>
          <a href={context.notice.policyUrl} target="_blank" rel="noopener noreferrer">Политика обработки данных<ExternalLink size={14} aria-hidden="true" /></a>
          <label className="pca-check"><input type="checkbox" required checked={draft.accepted} disabled={busy} onChange={e => update({ accepted: e.target.checked })} /><span>Согласен(на) с указанным уведомлением.</span></label>
        </section>
        <div className="pca-actions"><button type="submit" className="pca-button pca-primary" disabled={busy || !draft.accepted}><Send size={17} aria-hidden="true" />Подать заявку</button></div>
        <p className="pca-caption">Исходный срок партнёрского перехода: до {displayDate(context.expiresAt)} (Asia/Almaty). Подача и одобрение заявки не продлевают срок первой оплаты подписки.</p>
      </form>}
      {attempt && !receipt && !busy && owner.phase === "unconfirmed" && <section className="pca-recovery" aria-label="Восстановление исходной отправки">
        <h3>Отправка не подтверждена</h3>
        <p role="status">Новая заявка недоступна до подтверждения результата или закрытия исходной отправки.</p>
        {!attempt.body && !attempt.closing && <p>Исходные данные формы не сохранены. Доступны проверка результата и закрытие отправки.</p>}
        <div className="pca-actions">
          <button type="button" className="pca-button" onClick={() => recover("read")}><RefreshCw size={17} aria-hidden="true" />Проверить результат</button>
          {attempt.body && !attempt.closing && !attempt.resolved && <button type="button" className="pca-button" onClick={() => recover("submit")}><Send size={17} aria-hidden="true" />Повторить исходную отправку</button>}
        </div>
        {!attempt.resolved && <>
          <label className="pca-check"><input type="checkbox" checked={owner.closeAccepted} onChange={e => {
            if (!frame || !sameFrame(owner, frame) || owner.attempt !== attempt || owner.ticket) return;
            owner.closeAccepted = e.target.checked;
            publish(owner);
          }} /><span>Закрыть исходную отправку. Уже сохранённая заявка не удаляется и не отменяется.</span></label>
          <button type="button" className="pca-button" disabled={!owner.closeAccepted} onClick={() => recover("close")}><X size={17} aria-hidden="true" />Закрыть отправку</button>
        </>}
      </section>}
      {receipt?.state === "committed" && <section className="pca-result" aria-label="Результат регистрации компании">
        <h3><Check size={19} aria-hidden="true" />Заявка сохранена</h3>
        <dl><div><dt>Компания</dt><dd>{receipt.application.company.name}</dd></div>
          <div><dt>Статус</dt><dd>{applicationStates[receipt.application.state]}</dd></div>
          <div><dt>Направление</dt><dd>{purposes[receipt.application.company.purpose]}</dd></div>
          <div><dt>Подана</dt><dd>{displayDate(receipt.application.submittedAt)} (Asia/Almaty)</dd></div></dl>
      </section>}
      {receipt?.state === "abandoned" && <section className="pca-result" aria-label="Исходная отправка закрыта"><h3>Исходная отправка закрыта</h3>
        <p role="status">Неподтверждённая отправка закрыта. Уже сохранённые заявки не удаляются.</p>
        <button type="button" className="pca-button" disabled={!attempt?.resolved || Boolean(owner.storageError)} onClick={() => {
          if (!frame || !sameFrame(owner, frame) || owner.receipt !== receipt || owner.attempt !== attempt || !attempt?.resolved) return;
          owner.attempt = null;
          load(owner);
        }}><Building2 size={17} aria-hidden="true" />Новая заявка</button>
      </section>}
    </>}
  </section>;
}
