import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CircleAlert, ClipboardList, LoaderCircle, LogIn, Plus, RefreshCw } from "lucide-react";
import {
  parsePartnerCompanyPage,
  type PartnerCompanyApplication, type PartnerCompanyPage, type PartnerCompanyState,
} from "../../../../../lib/crm/partner-company-contracts";
import "./partner-company-inbox.css";

export type PartnerCompanyInboxRequest = (options: {
  offset: number;
  state: PartnerCompanyState | null;
  signal: AbortSignal;
  isCurrent(): boolean;
}) => Promise<unknown>;

export type PartnerCompanyInboxProps = {
  actorId: string;
  isSessionCurrent(): boolean;
  request: PartnerCompanyInboxRequest;
  onAccessDenied(): void;
  onNewApplication(): void;
  onOpenWorkspace?: (application: PartnerCompanyApplication, scope: {
    signal: AbortSignal;
    isCurrent(): boolean;
  }) => Promise<void>;
};

type Ticket = Readonly<{ controller: AbortController; offset: number; state: PartnerCompanyState | null }>;
type OpenTicket = Readonly<{ controller: AbortController; frame: object; page: PartnerCompanyPage; selected: PartnerCompanyApplication }>;
type Lifetime = PartnerCompanyInboxProps & {
  origin: string;
  expired: boolean;
  denied: boolean;
  focused: boolean;
  frame: object;
  offset: number;
  state: PartnerCompanyState | null;
  ticket: Ticket | null;
  openTicket: OpenTicket | null;
  page: PartnerCompanyPage | null;
  selected: PartnerCompanyApplication | null;
  phase: "loading" | "ready" | "hidden" | "error";
  error: string;
  openError: string;
};

const pageSize = 20;
const maxOffset = 1_000_000;
const deniedMessage = "Доступ к заявкам изменился. Проверьте текущий аккаунт.";
const states = { pending: "На рассмотрении", approved: "Одобрена", rejected: "Отклонена" };
const purposes = { clinic_services: "Услуги клиники", marketing: "Маркетинг", mortgage_leads: "Ипотечные заявки" };
const verticals = { clinic: "Клиника", beauty: "Красота", dental: "Стоматология" };
const sourceStates = { captured: "Зафиксирован", expired: "Истёк", pending_payment: "Ожидает первой оплаты", bound: "Привязан" };
const status = (error: unknown) => error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
const displayDate = (value: string, timeZone: string) => new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium", timeStyle: "short", timeZone,
}).format(new Date(value));
const visible = (owner: Lifetime) => owner.focused && document.visibilityState !== "hidden";

function hide(owner: Lifetime) {
  const ticket = owner.ticket;
  const openTicket = owner.openTicket;
  owner.ticket = null;
  owner.openTicket = null;
  owner.page = null;
  owner.selected = null;
  owner.frame = {};
  owner.phase = "hidden";
  owner.error = "";
  owner.openError = "";
  ticket?.controller.abort();
  openTicket?.controller.abort();
}

function retire(owner: Lifetime) {
  owner.expired = true;
  hide(owner);
}

export function PartnerCompanyInbox({ actorId, isSessionCurrent, request, onAccessDenied, onNewApplication, onOpenWorkspace }: PartnerCompanyInboxProps) {
  const [lifetime, setLifetime] = useState<Lifetime | null>(null);
  const [, render] = useState(0);
  const live = useRef<Lifetime | null>(null);
  const latest = useRef({ actorId, isSessionCurrent });
  const detailId = useId();
  latest.current = { actorId, isSessionCurrent };

  function current(owner: Lifetime): boolean {
    if (live.current !== owner || owner.expired) return false;
    try {
      if (owner.actorId && owner.actorId === latest.current.actorId && owner.origin === window.location.origin
        && owner.isSessionCurrent() && latest.current.isSessionCurrent()) return true;
    } catch { /* An unavailable session guard must fail closed. */ }
    retire(owner);
    return false;
  }

  function update(owner: Lifetime) {
    if (live.current !== owner) return;
    render(value => value + 1);
  }

  function publish(owner: Lifetime) {
    owner.frame = {};
    update(owner);
  }

  function active(owner: Lifetime): boolean {
    if (current(owner)) return true;
    if (live.current === owner) publish(owner);
    return false;
  }

  function sameFrame(owner: Lifetime, frame: object): boolean {
    return active(owner) && owner.frame === frame && visible(owner);
  }

  function refuse(owner: Lifetime) {
    if (!current(owner)) return;
    owner.denied = true;
    retire(owner);
    publish(owner);
    owner.onAccessDenied();
  }

  async function load(owner: Lifetime, offset = owner.offset, state = owner.state) {
    if (!active(owner)) return;
    hide(owner);
    owner.offset = offset;
    owner.state = state;
    if (!visible(owner)) { publish(owner); return; }
    const ticket: Ticket = Object.freeze({ controller: new AbortController(), offset, state });
    owner.ticket = ticket;
    owner.phase = "loading";
    publish(owner);
    const valid = () => {
      if (owner.ticket !== ticket || ticket.controller.signal.aborted || !active(owner)) return false;
      if (visible(owner)) return true;
      hide(owner);
      publish(owner);
      return false;
    };
    try {
      if (!valid()) return;
      const value = await owner.request({ offset: ticket.offset, state: ticket.state,
        signal: ticket.controller.signal, isCurrent: valid });
      if (!valid()) return;
      const page = parsePartnerCompanyPage(value, { offset: ticket.offset, state: ticket.state });
      if (!page) throw Error("Invalid partner company inbox page");
      if (!valid()) return;
      owner.page = page;
      owner.selected = page.items[0] ?? null;
      owner.phase = "ready";
    } catch (error) {
      if (!valid()) return;
      if ([401, 403, 404].includes(status(error))) { refuse(owner); return; }
      owner.page = null;
      owner.selected = null;
      owner.phase = "error";
      owner.error = "Не удалось загрузить заявки. Попробуйте обновить список.";
    } finally {
      if (owner.ticket === ticket) {
        owner.ticket = null;
        if (active(owner)) publish(owner);
      }
    }
  }

  useLayoutEffect(() => {
    // Snapshot callbacks for the actor lifetime; later renders cannot rebind an old read or action.
    const owner: Lifetime = { actorId, isSessionCurrent, request, onAccessDenied, onNewApplication, onOpenWorkspace,
      origin: window.location.origin, expired: false, denied: false, focused: true, frame: {},
      offset: 0, state: null, ticket: null, openTicket: null, page: null, selected: null, phase: "loading", error: "", openError: "" };
    live.current = owner;
    setLifetime(owner);
    void load(owner);
    const focus = () => {
      if (!active(owner)) return;
      owner.focused = true;
      void load(owner);
    };
    const conceal = () => { if (active(owner)) { hide(owner); publish(owner); } };
    const blur = () => { owner.focused = false; conceal(); };
    const visibility = () => {
      if (document.visibilityState === "hidden") conceal();
      else if (owner.focused) void load(owner);
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

  const owner = lifetime && current(lifetime) ? lifetime : null;
  const frame = owner?.frame;
  const page = owner && visible(owner) && owner.phase === "ready" ? owner.page : null;
  const selected = page && owner?.selected && page.items.includes(owner.selected) ? owner.selected : null;
  const loading = Boolean(owner?.ticket);
  const opening = Boolean(owner?.openTicket);
  const busy = loading || opening;
  const enabled = Boolean(owner && visible(owner));

  function samePage(): boolean {
    return Boolean(owner && frame && page && sameFrame(owner, frame) && owner.page === page && owner.phase === "ready");
  }

  function sameSelection(): boolean {
    return samePage() && Boolean(selected && owner?.selected === selected);
  }

  async function openWorkspace() {
    if (!owner || !frame || !page || !selected || !sameSelection() || owner.ticket || owner.openTicket
      || selected.state !== "approved" || !selected.workspaceId || !owner.onOpenWorkspace) return;
    const ticket: OpenTicket = Object.freeze({ controller: new AbortController(), frame, page, selected });
    owner.openTicket = ticket;
    owner.openError = "";
    // Busy-only rendering preserves the exact frame that authorized this action.
    update(owner);
    const valid = () => {
      if (owner.openTicket !== ticket || ticket.controller.signal.aborted || !active(owner)) return false;
      if (!visible(owner)) { hide(owner); publish(owner); return false; }
      return owner.frame === ticket.frame && owner.page === ticket.page && owner.selected === ticket.selected
        && owner.phase === "ready" && ticket.page.items.includes(ticket.selected)
        && ticket.selected.state === "approved" && Boolean(ticket.selected.workspaceId);
    };
    try {
      if (!valid()) return;
      await owner.onOpenWorkspace(ticket.selected, Object.freeze({ signal: ticket.controller.signal, isCurrent: valid }));
      if (!valid()) return;
    } catch (error) {
      if (!valid()) return;
      if ([401, 403, 404].includes(status(error))) { refuse(owner); return; }
      owner.openError = "Не удалось проверить доступ к CRM. Попробуйте открыть CRM ещё раз или обновите список.";
    } finally {
      if (owner.openTicket === ticket) {
        owner.openTicket = null;
        ticket.controller.abort();
        if (active(owner)) publish(owner);
      }
    }
  }

  function changePage(direction: -1 | 1) {
    if (!owner || !page || !samePage() || owner.ticket || owner.openTicket) return;
    const offset = page.offset + direction * pageSize;
    if (offset < 0 || offset > maxOffset || (direction === 1 && !page.hasMore)) return;
    void load(owner, offset, page.state);
  }

  return <section className="partner-company-inbox" aria-label="Мои заявки компаний" aria-busy={busy}>
    <header className="pci-heading">
      <div className="pci-title"><ClipboardList size={21} aria-hidden="true" /><h2>Мои заявки компаний</h2></div>
      <button type="button" className="pci-button pci-primary" disabled={!enabled || busy} onClick={() => {
        if (!owner || !frame || !sameFrame(owner, frame) || owner.ticket || owner.openTicket) return;
        publish(owner);
        owner.onNewApplication();
      }}><Plus size={17} aria-hidden="true" /><span>Новая заявка</span></button>
    </header>
    <div className="pci-toolbar">
      <label className="pci-filter"><span>Статус</span><select aria-label="Статус заявки" value={owner?.state ?? "all"} disabled={!enabled || opening}
        onChange={event => {
          if (!owner || !frame || !sameFrame(owner, frame) || owner.openTicket) return;
          const value = event.target.value;
          if (value !== "all" && value !== "pending" && value !== "approved" && value !== "rejected") return;
          const state = value === "all" ? null : value;
          if (state !== owner.state) void load(owner, 0, state);
        }}>
        <option value="all">Все статусы</option>
        <option value="pending">На рассмотрении</option>
        <option value="approved">Одобрена</option>
        <option value="rejected">Отклонена</option>
      </select></label>
      <button type="button" className="pci-button pci-icon" title="Обновить заявки" aria-label="Обновить заявки" disabled={!enabled || loading}
        onClick={() => { if (owner && frame && sameFrame(owner, frame) && !owner.ticket) void load(owner); }}>
        <RefreshCw size={18} aria-hidden="true" />
      </button>
    </div>
    {!owner ? <p className="pci-note" role={lifetime?.denied ? "alert" : "status"}>
      {lifetime?.denied ? <CircleAlert size={18} aria-hidden="true" /> : <LoaderCircle size={18} aria-hidden="true" />}
      <span>{lifetime?.denied ? deniedMessage : "Проверяем доступ к заявкам…"}</span>
    </p> : <>
      {loading && <p className="pci-note" role="status"><LoaderCircle size={18} aria-hidden="true" /><span>Загружаем заявки…</span></p>}
      {owner.phase === "hidden" && <p className="pci-note" role="status">Данные скрыты до повторной проверки доступа.</p>}
      {owner.error && <p className="pci-note pci-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><span>{owner.error}</span></p>}
      {page && (page.items.length === 0 ? <p className="pci-note" role="status">
        {page.offset > 0 ? "На этой странице заявок нет." : page.state ? "Заявок с этим статусом нет." : "Заявок пока нет."}
      </p> : <div className="pci-content">
        <section className="pci-list" aria-label="Список заявок">
          <h3>Заявки</h3>
          <ul>{page.items.map(item => <li key={item.id}>
            <button type="button" className="pci-row" aria-pressed={selected === item} aria-controls={detailId} disabled={opening} onClick={() => {
              if (!owner || !samePage() || owner.ticket || owner.openTicket || !page.items.includes(item) || owner.selected === item) return;
              owner.selected = item;
              owner.openError = "";
              publish(owner);
            }}>
              <span className="pci-row-top"><span className="pci-company">{item.company.name}</span><span className={`pci-state pci-state-${item.state}`}>{states[item.state]}</span></span>
              <span className="pci-row-meta"><span>{purposes[item.company.purpose]}</span><time dateTime={item.submittedAt}>{displayDate(item.submittedAt, item.company.timeZone)}</time></span>
            </button>
          </li>)}</ul>
        </section>
        {selected && <section id={detailId} className="pci-detail" aria-label="Данные выбранной заявки">
          <div className="pci-detail-heading"><h3>{selected.company.name}</h3><span className={`pci-state pci-state-${selected.state}`}>{states[selected.state]}</span></div>
          <dl>
            <div><dt>Направление</dt><dd>{purposes[selected.company.purpose]}</dd></div>
            {selected.company.vertical && <div><dt>Специализация</dt><dd>{verticals[selected.company.vertical]}</dd></div>}
            <div><dt>Имя владельца</dt><dd>{selected.company.ownerName}</dd></div>
            <div><dt>Часовой пояс</dt><dd>{selected.company.timeZone}</dd></div>
            <div><dt>Подана</dt><dd><time dateTime={selected.submittedAt}>{displayDate(selected.submittedAt, selected.company.timeZone)}</time></dd></div>
            <div><dt>Рассмотрена</dt><dd>{selected.reviewedAt ? <time dateTime={selected.reviewedAt}>{displayDate(selected.reviewedAt, selected.company.timeZone)}</time> : "Не рассмотрена"}</dd></div>
            <div><dt>Партнёрский переход</dt><dd>{sourceStates[selected.sourceState]}</dd></div>
            <div><dt>Срок партнёрского перехода</dt><dd><time dateTime={selected.expiresAt}>{displayDate(selected.expiresAt, selected.company.timeZone)}</time></dd></div>
            <div className="pci-wide"><dt>Номер заявки</dt><dd className="pci-identifier">{selected.id}</dd></div>
          </dl>
          {selected.state === "approved" && selected.workspaceId && owner.onOpenWorkspace && <div className="pci-dashboard">
            <button type="button" className="pci-button pci-primary pci-open-workspace" disabled={!enabled || busy}
              aria-busy={opening} onClick={() => { void openWorkspace(); }}>
              {opening ? <LoaderCircle size={18} className="pci-open-spinner" aria-hidden="true" /> : <LogIn size={18} aria-hidden="true" />}
              <span aria-live="polite">{opening ? "Проверяем доступ…" : "Открыть CRM"}</span>
            </button>
            {owner.openError && <p className="pci-workspace-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><span>{owner.openError}</span></p>}
          </div>}
        </section>}
      </div>)}
    </>}
    <footer className="pci-pagination">
      <span className="pci-range" aria-live="polite">{page ? page.items.length ? `Заявки ${page.offset + 1}-${page.offset + page.items.length}` : "Заявки: 0" : ""}</span>
      <nav aria-label="Страницы заявок">
        <button type="button" className="pci-button pci-icon" title="Предыдущая страница" aria-label="Предыдущая страница"
          disabled={!page || busy || page.offset === 0} onClick={() => changePage(-1)}><ArrowLeft size={18} aria-hidden="true" /></button>
        <button type="button" className="pci-button pci-icon" title="Следующая страница" aria-label="Следующая страница"
          disabled={!page || busy || !page.hasMore || page.offset > maxOffset - pageSize} onClick={() => changePage(1)}><ArrowRight size={18} aria-hidden="true" /></button>
      </nav>
    </footer>
  </section>;
}
