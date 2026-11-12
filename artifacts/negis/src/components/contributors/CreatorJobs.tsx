import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BadgeCheck, Ban, CalendarDays, Check, CheckCircle2, ChevronLeft, ChevronRight, Coins, ExternalLink, FileText, MessageSquare, Plus, RefreshCw, Search, Send, Timer, Upload, UserRound, X } from "lucide-react";
import { operatorApi } from "@/lib/operatorApi";
import { useCreatorCommand, type CreatorCommandController } from "@/lib/useCreatorCommand";
import { creatorDueAt, creatorFeeToMinor, type CreatorCommandAttempt, type CreatorWrite } from "@/lib/creatorCommandAttempt";
import { formatArrivalPrice } from "../../../../../lib/crm/operator-contracts";
import { CREATOR_JOB_PAGE_SIZE, parseCreatorDirectory, parseCreatorJobAction, parseCreatorJobDetail, parseCreatorJobPage, parseCreatorJobTerms,
  type CreatorDirectoryEntry, type CreatorJob, type CreatorJobAction, type CreatorJobDetail, type CreatorJobState } from "../../../../../lib/crm/creator-job-contracts";
import "./CreatorJobs.css";

const labels: Record<CreatorJobState, string> = { offered: "Предложено", in_progress: "В работе", submitted: "На проверке",
  changes_requested: "Нужна доработка", approved: "Принято", declined: "Отклонено", cancelled: "Отменено" };
const actionLabels = { create: "Предложение задания", accept: "Принятие условий", decline: "Отказ от задания", submit: "Отправка результата",
  request_changes: "Запрос доработки", approve: "Приёмка результата", cancel: "Отмена предложения" };
const money = (job: Pick<CreatorJob, "feeMinor" | "currency">) => ["KZT", "USD", "EUR"].includes(job.currency)
  ? formatArrivalPrice(job.feeMinor, job.currency) : `${BigInt(job.feeMinor).toLocaleString("ru-RU")} ${job.currency} (мин. ед.)`;
const date = (value: string) => new Date(value).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export function selectCreatorDeadline(items: readonly CreatorJob[], now: number): CreatorJob | null {
  let upcoming: CreatorJob | null = null, overdue: CreatorJob | null = null;
  const earlier = (job: CreatorJob, previous: CreatorJob | null) => previous === null
    || Date.parse(job.dueAt) < Date.parse(previous.dueAt)
    || (Date.parse(job.dueAt) === Date.parse(previous.dueAt) && job.id < previous.id);
  for (const job of items) {
    if (["approved", "declined", "cancelled"].includes(job.state) || !Number.isFinite(Date.parse(job.dueAt))) continue;
    if (Date.parse(job.dueAt) > now) { if (earlier(job, upcoming)) upcoming = job; }
    else if (earlier(job, overdue)) overdue = job;
  }
  return upcoming ?? overdue;
}
const illustrations = [
  { src: "/images/contributors/filming.webp", alt: "Иллюстрация: съёмка контента" },
  { src: "/images/contributors/interior.webp", alt: "Иллюстрация: интерьер" },
  { src: "/images/contributors/photography.webp", alt: "Иллюстрация: предметная съёмка" },
];

function useFormFrame(values: unknown[]) {
  const [, repaint] = useState(0);
  const live = useRef({ values, token: {}, mounted: false });
  const frame = live.current;
  if (values.some((value, index) => !Object.is(value, frame.values[index]))) { frame.values = values; frame.token = {}; }
  const token = frame.token;
  useLayoutEffect(() => {
    frame.mounted = true; frame.token = {}; repaint(n => n + 1);
    return () => { frame.mounted = false; frame.token = {}; };
  }, []);
  return { isCurrent: () => frame.mounted && frame.token === token, change: () => { frame.token = {}; } };
}

function useCreatorRead<T>(path: string | null, parse: (value: unknown) => T | null, actorId: string,
  command: CreatorCommandController, revision: number, onDenied: () => void) {
  const request = useMemo(() => ({ path, revision, owner: command.lifetime }), [path, revision, command.lifetime]);
  const live = useRef(request); live.current = request;
  const [response, setResponse] = useState<{ request: typeof request; controller: AbortController; data: T | null; error: string } | null>(null);
  useEffect(() => {
    if (request.path === null || !command.isCurrent()) return;
    const controller = new AbortController();
    const valid = () => !controller.signal.aborted && live.current === request && command.isCurrent();
    void operatorApi<unknown>(request.path, undefined, "GET", controller.signal, actorId, valid).then(value => {
      if (!valid()) return;
      const parsed = parse(value);
      if (!parsed) throw Error("Не удалось подтвердить данные заданий.");
      setResponse({ request, controller, data: parsed, error: "" });
    }).catch(error => {
      if (!valid()) return;
      setResponse({ request, controller, data: null, error: error instanceof Error ? error.message : "Не удалось загрузить задания." });
      if (error && typeof error === "object" && "status" in error && [401, 403].includes(Number(error.status))) onDenied();
    });
    return () => controller.abort();
  }, [request]);
  const isCurrent = () => live.current === request && response?.request === request && !response.controller.signal.aborted && command.isCurrent();
  return response?.request === request && isCurrent() ? { ...response, isCurrent } : null;
}

function Pages({ offset, hasMore, disabled, onChange, label }: { offset: number; hasMore: boolean; disabled: boolean;
  onChange: (offset: number) => void; label: string }) {
  return <nav aria-label={label} className="creator-pagination flex items-center gap-3">
    <button className="neu-btn" type="button" title="Предыдущая страница" aria-label={`${label}: назад`} disabled={disabled || offset === 0} onClick={() => onChange(Math.max(0, offset - CREATOR_JOB_PAGE_SIZE))}><ChevronLeft size={16}/></button>
    <span className="text-xs tabular-nums">{Math.floor(offset / CREATOR_JOB_PAGE_SIZE) + 1}</span>
    <button className="neu-btn" type="button" title="Следующая страница" aria-label={`${label}: далее`} disabled={disabled || !hasMore || offset >= 1000000} onClick={() => onChange(offset + CREATOR_JOB_PAGE_SIZE)}><ChevronRight size={16}/></button>
  </nav>;
}

export function CreatorJobs(props: { actorId: string; workspaceId?: string; isSessionCurrent: () => boolean; onAccessDenied?: () => void }) {
  return <CreatorJobsSession key={`${props.actorId}:${props.workspaceId ?? "creator"}`} {...props}/>;
}

function CreatorJobsSession({ actorId, workspaceId, isSessionCurrent, onAccessDenied }: {
  actorId: string; workspaceId?: string; isSessionCurrent: () => boolean; onAccessDenied?: () => void;
}) {
  const command = useCreatorCommand(actorId, workspaceId, isSessionCurrent);
  const [denied, setDenied] = useState(false), [revision, setRevision] = useState(0);
  const [offset, setOffset] = useState(0), [directoryOffset, setDirectoryOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null), [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(""), [status, setStatus] = useState<CreatorJobState | "all">("all");
  const [deadlineTick, setDeadlineTick] = useState(0);
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const pending = useRef<{ controller: AbortController } | null>(null);
  const company = workspaceId !== undefined;
  const suffix = workspaceId ? `workspaceId=${encodeURIComponent(workspaceId)}&` : "";
  const jobsPath = company ? "clinic-creator-jobs" : "creator-jobs";
  const commandPath = company ? "clinic-creator-job-command" : "creator-job-command";
  const refresh = () => { if (command.isCurrent() && !denied) setRevision(value => value + 1); };
  const deny = () => {
    if (!command.isCurrent()) return;
    command.expire(); pending.current?.controller.abort(); pending.current = null;
    setDenied(true); setBusy(false); setCreating(false); setSelected(null); setMessage(""); onAccessDenied?.();
  };
  const list = useCreatorRead(denied ? null : `${jobsPath}?${suffix}offset=${offset}`, parseCreatorJobPage, actorId, command, revision, deny);
  const directory = useCreatorRead(!denied && company && creating ? `creator-directory?${suffix}offset=${directoryOffset}` : null,
    parseCreatorDirectory, actorId, command, revision, deny);
  useLayoutEffect(() => () => { pending.current?.controller.abort(); pending.current = null; }, [command.lifetime]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [command.lifetime, denied]);

  async function dispatch(attempt: CreatorCommandAttempt, operation: "send" | "read" | "close") {
    if (denied || pending.current || !command.isCurrent(attempt)) return;
    const body = operation === "send" ? command.payload(attempt) : operation === "close"
      ? { operation: "close", requestId: attempt.requestId, action: attempt.action, targetId: attempt.targetId } : undefined;
    if (operation === "send" && body === null) { setMessage("Исходная форма не сохранена. Проверьте состояние отправки."); return; }
    const token = { controller: new AbortController() }; pending.current = token; setBusy(true); setMessage("");
    const valid = () => pending.current === token && !token.controller.signal.aborted && command.isCurrent(attempt);
    try {
      const path = operation === "send" ? `${jobsPath}?${suffix.slice(0, -1)}` : operation === "read"
        ? `${commandPath}?${suffix}requestId=${encodeURIComponent(attempt.requestId)}` : `${commandPath}?${suffix.slice(0, -1)}`;
      const value = await operatorApi<unknown>(path, body, "POST", token.controller.signal, actorId, valid);
      if (!valid()) return;
      const result = command.complete(attempt, value);
      if (!result) { setMessage("Исход отправки ещё не подтверждён."); return; }
      if (result.state === "committed") {
        setSelected(result.result.job.id); setCreating(false); setRevision(n => n + 1);
        setMessage("Действие сохранено. Текущее состояние задания обновлено.");
      } else setMessage("Исходная отправка закрыта. Поздний повтор не будет выполнен.");
    } catch (error) {
      if (!valid()) return;
      if (error && typeof error === "object" && "status" in error && [401, 403].includes(Number(error.status))) { deny(); return; }
      setMessage(error instanceof Error ? error.message : "Результат отправки не подтверждён.");
    } finally {
      if (pending.current === token) { pending.current = null; if (command.isCurrent()) setBusy(false); }
    }
  }
  function send(write: CreatorWrite) {
    if (denied || pending.current || command.blocked) return;
    try { const attempt = command.claim(write); if (attempt) void dispatch(attempt, "send"); }
    catch (error) { if (command.isCurrent()) setMessage(error instanceof Error ? error.message : "Проверьте действие."); }
  }
  const query = search.trim().toLocaleLowerCase("ru-RU");
  const visibleJobs = list?.data?.items.filter(job => (status === "all" || job.state === status)
    && [job.title, job.brief, ...(company ? [job.creatorName] : [])].some(value => value.toLocaleLowerCase("ru-RU").includes(query))) ?? [];
  const deadlineNow = Date.now();
  const nearest = !company && list?.data ? selectCreatorDeadline(list.data.items, deadlineNow) : null;
  const deadlineExpired = nearest !== null && Date.parse(nearest.dueAt) <= deadlineNow;
  useEffect(() => {
    if (!nearest || deadlineExpired) return;
    const timer = window.setTimeout(() => setDeadlineTick(value => value + 1),
      Math.min(Math.max(0, Date.parse(nearest.dueAt) - Date.now()) + 1, 2147483647));
    return () => window.clearTimeout(timer);
  }, [nearest?.dueAt, deadlineExpired, deadlineTick, list?.data]);
  function openJob(job: CreatorJob) {
    if (list?.isCurrent()) { setSelected(job.id); setCreating(false); }
  }
  if (denied || command.lifetime.expired) return <section aria-label="Задания авторов" className="creator-workspace"><p role="alert">Доступ к заданиям изменился. Обновите страницу после проверки прав.</p></section>;
  if (!command.isCurrent()) return <p role="status" className="creator-workspace">Проверяем доступ к заданиям…</p>;
  return <section aria-label="Задания авторов" className={`creator-workspace${company ? " creator-workspace--company" : ""}`}>
    <header className="creator-workspace__header"><div><h2>{company ? "Задания на контент" : "Мои задания"}</h2><p className="creator-workspace__context">Страница {Math.floor(offset / CREATOR_JOB_PAGE_SIZE) + 1}<span aria-hidden="true"> · </span>Время: {zone()}</p></div><div className="creator-workspace__actions">
      {company && <button type="button" className="neu-btn neu-btn-primary" disabled={busy || command.blocked} onClick={() => { setCreating(value => !value); setMessage(""); }}><Plus size={16}/>{creating ? "Свернуть форму" : "Новое задание"}</button>}
      <button type="button" className="neu-btn" title="Обновить задания" aria-label="Обновить задания" onClick={refresh}><RefreshCw size={16}/></button>
    </div></header>
    {command.error && <p role="alert" className="break-words text-sm">{command.error}</p>}
    {command.attempt && <Recovery key={command.attempt.requestId} attempt={command.attempt} busy={busy} canRetry={command.canRetry}
      onAction={mode => void dispatch(command.attempt!, mode)}/>}
    {message && <p role="status" className="break-words text-sm">{message}</p>}
    {company && creating && <CreateForm entries={directory?.data?.items ?? []} ready={Boolean(directory?.data)} error={directory?.error ?? ""}
      offset={directoryOffset} hasMore={directory?.data?.hasMore ?? false} onPage={setDirectoryOffset} disabled={busy || command.blocked}
      isCurrent={() => directory?.isCurrent() === true} onSend={send}/>}
    {list?.error && <p role="alert" className="break-words text-sm">{list.error}</p>}
    {!list && <p role="status" className="text-sm text-muted-foreground">Загружаем задания…</p>}
    {list?.data && <>
      <section aria-label="Статусы заданий на текущей странице" className="creator-workspace__summary">
        <h3 className="creator-workspace__section-label">На текущей странице</h3>
        <dl className="creator-workspace__metrics">
          <div><FileText size={24} aria-hidden="true"/><dt>Предложено</dt><dd>{list.data.items.filter(job => job.state === "offered").length}</dd></div>
          <div><Timer size={24} aria-hidden="true"/><dt>В работе</dt><dd>{list.data.items.filter(job => job.state === "in_progress").length}</dd></div>
          <div><BadgeCheck size={24} aria-hidden="true"/><dt>На проверке</dt><dd>{list.data.items.filter(job => job.state === "submitted").length}</dd></div>
        </dl>
      </section>
      <div className="creator-workspace__filters">
        <label className="creator-workspace__search"><Search size={20} aria-hidden="true"/>
          <span className="creator-workspace__sr-only">{company ? "Поиск по названию, брифу и автору на текущей странице" : "Поиск по названию и брифу на текущей странице"}</span>
          <input type="search" value={search} maxLength={200} placeholder={company ? "Название, бриф или автор" : "Название или бриф"} onChange={event => setSearch(event.target.value)}/>
        </label>
        <fieldset className="creator-workspace__status-filter">
          <legend className="creator-workspace__section-label">Статус на текущей странице</legend>
          <select className="creator-workspace__status-select neu-input" aria-label="Статус заданий на текущей странице" value={status}
            onChange={event => setStatus(event.target.value as CreatorJobState | "all")}>
            {(["all", ...Object.keys(labels)] as (CreatorJobState | "all")[]).map(value => <option key={value} value={value}>{value === "all" ? "Все задания" : labels[value]}</option>)}
          </select>
          <div className="creator-workspace__status-options">{(["all", ...Object.keys(labels)] as (CreatorJobState | "all")[]).map(value => <button key={value} type="button"
            aria-pressed={status === value} onClick={() => setStatus(value)}>{value === "all" ? "Все задания" : labels[value]}</button>)}</div>
        </fieldset>
      </div>
      <p role="status" className="creator-workspace__result-count">Показано {visibleJobs.length} из {list.data.items.length} на текущей странице</p>
      {list.data.items.length === 0 ? <p role="status" className="creator-workspace__empty">На этой странице заданий пока нет.</p>
        : visibleJobs.length === 0 ? <div className="creator-workspace__empty"><p role="status">На текущей странице нет заданий по выбранным условиям.</p>
          <button type="button" className="neu-btn" onClick={() => { setSearch(""); setStatus("all"); }}><X size={16} aria-hidden="true"/>Сбросить фильтры</button></div>
        : <ul className="creator-workspace__jobs">{visibleJobs.map(job => {
          const illustration = illustrations[Number.parseInt(job.id.replaceAll("-", "").slice(-8), 16) % illustrations.length];
          return <li key={job.id} className={`creator-job${company ? "" : " creator-job--illustrated"}`} data-selected={selected === job.id}>
          {!company && <figure className="creator-job__illustration"><img src={illustration.src} alt={illustration.alt} width={220} height={124} loading="lazy" decoding="async"/></figure>}
          <div className="creator-job__content">
            <div className="creator-job__heading"><h3>{job.title}</h3><span className="creator-job__status" data-state={job.state}>{labels[job.state]}</span></div>
            {company && <p className="creator-job__creator"><UserRound size={16} aria-hidden="true"/><span><span className="creator-workspace__sr-only">Автор: </span>{job.creatorName}</span></p>}
            <p className="creator-job__brief">{job.brief}</p>
            <dl className="creator-job__terms">
              <div><dt><CalendarDays size={17} aria-hidden="true"/>Срок</dt><dd><time dateTime={job.dueAt}>{date(job.dueAt)}</time></dd></div>
              <div><dt><Coins size={17} aria-hidden="true"/>Вознаграждение</dt><dd className="creator-job__fee">{money(job)}</dd></div>
            </dl>
            {job.state === "changes_requested" && job.feedback ? <p className="creator-job__note"><MessageSquare size={16} aria-hidden="true"/>Есть запрос доработки</p>
              : job.approvedAt ? <p className="creator-job__note"><CheckCircle2 size={16} aria-hidden="true"/>Результат принят</p>
              : job.latestSubmission ? <p className="creator-job__note"><Upload size={16} aria-hidden="true"/>Версия {job.latestSubmission.sequence} отправлена</p>
              : job.acceptedAt ? <p className="creator-job__note"><CheckCircle2 size={16} aria-hidden="true"/>Условия приняты</p> : null}
          </div>
          <button type="button" className="creator-job__open" aria-pressed={selected === job.id} aria-label={`Открыть задание: ${job.title}`}
            onClick={() => openJob(job)}>Открыть задание<ArrowRight size={18} aria-hidden="true"/></button>
        </li>; })}</ul>}
      <Pages label="Страницы заданий" offset={offset} hasMore={list.data.hasMore} disabled={false} onChange={setOffset}/>
      {nearest && <button type="button" className="creator-deadline" data-expired={deadlineExpired} aria-pressed={selected === nearest.id}
        aria-label={`${deadlineExpired ? "Срок истёк" : "Ближайший срок"} на текущей странице. Открыть задание: ${nearest.title}`}
        onClick={() => openJob(nearest)}>
        <CalendarDays size={24} aria-hidden="true"/>
        <span className="creator-deadline__content"><span className="creator-deadline__label">{deadlineExpired ? "Срок истёк" : "Ближайший срок"}<span aria-hidden="true"> · </span>На текущей странице</span>
          <span className="creator-deadline__details"><time dateTime={nearest.dueAt}>{date(nearest.dueAt)}</time><span aria-hidden="true"> · </span>{nearest.title}</span></span>
        <ChevronRight size={20} aria-hidden="true"/>
      </button>}
    </>}
    {selected && <JobPanel key={selected} jobId={selected} actorId={actorId} workspaceId={workspaceId} command={command} revision={revision}
      busy={busy} onDenied={deny} onSend={send} onClose={() => setSelected(null)}/>}
  </section>;
}

function Recovery({ attempt, busy, canRetry, onAction }: { attempt: CreatorCommandAttempt; busy: boolean; canRetry: boolean;
  onAction: (operation: "send" | "read" | "close") => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const frame = useFormFrame([attempt, busy, confirmed, canRetry]);
  return <section aria-label="Состояние отправки" className="min-w-0 space-y-3 border-y py-4">
    <h3 className="text-sm font-medium">{actionLabels[attempt.action]}: результат не подтверждён</h3>
    <div className="flex flex-wrap gap-2"><button type="button" className="neu-btn" disabled={busy} onClick={() => { if (frame.isCurrent()) onAction("read"); }}><RefreshCw size={16}/>Проверить состояние</button>
      {canRetry && <button type="button" className="neu-btn" disabled={busy} onClick={() => { if (frame.isCurrent()) onAction("send"); }}><Send size={16}/>Повторить исходную отправку</button>}</div>
    <label className="flex items-start gap-3 text-sm"><input className="mt-1 shrink-0" type="checkbox" checked={confirmed} disabled={busy} onChange={e => { frame.change(); setConfirmed(e.target.checked); }}/><span>Закрыть неподтверждённую отправку. Уже сохранённое действие не отменяется.</span></label>
    <button type="button" className="neu-btn" disabled={busy || !confirmed} onClick={() => { if (confirmed && frame.isCurrent()) onAction("close"); }}><Ban size={16}/>Закрыть отправку</button>
  </section>;
}

function CreateForm({ entries, ready, error, offset, hasMore, onPage, disabled, isCurrent, onSend }: { entries: CreatorDirectoryEntry[]; ready: boolean;
  error: string; offset: number; hasMore: boolean; onPage: (value: number) => void; disabled: boolean; isCurrent: () => boolean; onSend: (write: CreatorWrite) => void }) {
  const [creator, setCreator] = useState(""), [title, setTitle] = useState(""), [brief, setBrief] = useState("");
  const [price, setPrice] = useState(""), [currency, setCurrency] = useState("KZT"), [due, setDue] = useState(""), [rights, setRights] = useState("");
  const [errorText, setError] = useState("");
  const frame = useFormFrame([entries, ready, disabled, creator, title, brief, price, currency, due, rights]);
  function submit(event: React.FormEvent) {
    event.preventDefault(); if (disabled || !ready || !isCurrent() || !frame.isCurrent()) return;
    const feeMinor = creatorFeeToMinor(price), dueAt = creatorDueAt(due);
    const terms = parseCreatorJobTerms({ creatorId: creator, title: title.trim(), brief: brief.trim(), rightsTerms: rights.trim(), feeMinor, currency, dueAt });
    if (!entries.some(item => item.id === creator) || !terms || Date.parse(terms.dueAt) <= Date.now()) {
      setError("Выберите автора, укажите будущий срок, сумму больше нуля и все условия задания."); return;
    }
    setError(""); frame.change(); onSend({ action: "create", terms });
  }
  return <form aria-label="Новое задание автору" className="min-w-0 space-y-4 border-y py-5" onSubmit={submit}>
    <h3 className="font-medium">Новое задание</h3>
    {error && <p role="alert" className="break-words text-sm">{error}</p>}
    {!ready && !error && <p role="status" className="text-sm">Загружаем одобренных авторов…</p>}
    {ready && entries.length === 0 && <p role="status" className="text-sm text-muted-foreground">На этой странице одобренных авторов нет.</p>}
    <fieldset disabled={disabled || !ready} className="min-w-0 space-y-4">
      <label className="block min-w-0 text-sm">Автор<select className="neu-input mt-2 w-full min-w-0" required value={creator} onChange={e => { frame.change(); setCreator(e.target.value); }}><option value="">Выберите автора</option>{entries.map(item => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>
      {entries.find(item => item.id === creator)?.portfolioUrls.map(url => <a key={url} href={url} rel="noopener noreferrer" target="_blank" className="flex min-w-0 items-start gap-2 text-xs"><ExternalLink size={14} className="shrink-0"/><span className="break-all">{url}</span></a>)}
      <Pages label="Страницы авторов" offset={offset} hasMore={hasMore} disabled={disabled || !ready} onChange={onPage}/>
      <label className="block text-sm">Название<input className="neu-input mt-2 w-full" maxLength={120} required value={title} onChange={e => { frame.change(); setTitle(e.target.value); }}/></label>
      <label className="block text-sm">Бриф<textarea className="neu-input mt-2 w-full" rows={5} maxLength={4000} required value={brief} onChange={e => { frame.change(); setBrief(e.target.value); }}/></label>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2"><label className="block min-w-0 text-sm">Вознаграждение<input className="neu-input mt-2 w-full" inputMode="decimal" maxLength={20} required value={price} onChange={e => { frame.change(); setPrice(e.target.value); }}/></label>
        <label className="block min-w-0 text-sm">Валюта<select className="neu-input mt-2 w-full" value={currency} onChange={e => { frame.change(); setCurrency(e.target.value); }}>{["KZT", "USD", "EUR"].map(value => <option key={value}>{value}</option>)}</select></label></div>
      <label className="block min-w-0 text-sm">Срок ({zone()})<input className="neu-input mt-2 w-full min-w-0 max-w-full" type="datetime-local" step={60} required value={due} onChange={e => { frame.change(); setDue(e.target.value); }}/></label>
      <label className="block text-sm">Условия использования контента<textarea className="neu-input mt-2 w-full" rows={4} maxLength={3000} required value={rights} onChange={e => { frame.change(); setRights(e.target.value); }}/></label>
      {errorText && <p role="alert" className="break-words text-sm">{errorText}</p>}
      <button className="neu-btn neu-btn-primary" type="submit"><Send size={16}/>Предложить задание</button>
    </fieldset>
  </form>;
}

function JobPanel({ jobId, actorId, workspaceId, command, revision, busy, onDenied, onSend, onClose }: { jobId: string; actorId: string;
  workspaceId?: string; command: CreatorCommandController; revision: number; busy: boolean; onDenied: () => void;
  onSend: (write: CreatorWrite) => void; onClose: () => void }) {
  const [offset, setOffset] = useState(0), [consent, setConsent] = useState<string | null>(null);
  const [links, setLinks] = useState(""), [note, setNote] = useState(""), [feedback, setFeedback] = useState("");
  const [error, setError] = useState(""), [confirm, setConfirm] = useState<{ action: "approve" | "decline" | "cancel"; revision: string } | null>(null);
  const company = workspaceId !== undefined;
  const detail = useCreatorRead(`${company ? "clinic-creator-job-detail" : "creator-job-detail"}?${workspaceId ? `workspaceId=${encodeURIComponent(workspaceId)}&` : ""}jobId=${encodeURIComponent(jobId)}&offset=${offset}`, value => {
    const parsed = parseCreatorJobDetail(value);
    return parsed?.job.id.toLowerCase() === jobId.toLowerCase() && parsed.history.offset === offset ? parsed : null;
  }, actorId, command, revision, onDenied);
  const job = detail?.data?.job;
  const enabled = Boolean(job) && !busy && !command.blocked;
  const frame = useFormFrame([job, enabled, offset, consent, links, note, feedback, confirm]);
  function act(action: CreatorJobAction) {
    if (!enabled || !job || !command.isCurrent() || !detail?.isCurrent() || !frame.isCurrent()) return;
    const parsed = parseCreatorJobAction(action);
    if (!parsed) { setError("Укажите до пяти разных публичных HTTPS-ссылок и проверьте текст."); return; }
    setError(""); frame.change(); setConfirm(null); onSend({ jobId: job.id, revision: job.revision, ...parsed });
  }
  return <section aria-label="Карточка задания" className="min-w-0 space-y-4 border-t pt-5">
    <div className="flex items-start justify-between gap-3"><h3 className="min-w-0 break-words text-base font-semibold [overflow-wrap:anywhere]">{job?.title ?? "Карточка задания"}</h3><button type="button" className="neu-btn shrink-0" title="Закрыть карточку" aria-label="Закрыть карточку" onClick={() => { frame.change(); onClose(); }}><X size={16}/></button></div>
    {!detail && <p role="status" className="text-sm">Загружаем карточку…</p>}
    {detail?.error && <p role="alert" className="break-words text-sm">{detail.error}</p>}
    {job && detail?.data && <>
      <p className="break-words text-sm text-muted-foreground">{company ? job.creatorName : detail.data.companyName}</p>
      <dl className="grid min-w-0 gap-4 sm:grid-cols-3">{[["Статус", labels[job.state]], ["Вознаграждение", money(job)], ["Срок", date(job.dueAt)]].map(([title, value]) => <div key={title} className="min-w-0"><dt className="text-xs text-muted-foreground">{title}</dt><dd className="mt-1 break-words text-sm font-medium [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
      <section className="space-y-2"><h4 className="text-sm font-medium">Бриф</h4><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{job.brief}</p></section>
      <section className="space-y-2"><h4 className="text-sm font-medium">Условия использования контента</h4><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{job.rightsTerms}</p></section>
      {job.acceptedAt && <p className="text-xs text-muted-foreground">Условия приняты: {date(job.acceptedAt)}</p>}
      {job.approvedAt && <p className="text-xs text-muted-foreground">Результат принят: {date(job.approvedAt)}</p>}
      {job.feedback && <section className="space-y-2 border-l-2 pl-3"><h4 className="text-sm font-medium">Запрос доработки</h4><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{job.feedback}</p></section>}
      {!company && job.state === "offered" && <div className="space-y-3 border-t pt-4"><label className="flex items-start gap-3 text-sm"><input className="mt-1 shrink-0" type="checkbox" checked={consent === job.termsRevision} disabled={!enabled} onChange={e => { frame.change(); setConsent(e.target.checked ? job.termsRevision : null); }}/><span>Подтверждаю бриф, вознаграждение, срок и условия использования контента</span></label><div className="flex flex-wrap gap-2"><button type="button" className="neu-btn neu-btn-primary" disabled={!enabled || consent !== job.termsRevision} onClick={() => act({ action: "accept", payload: { termsRevision: job.termsRevision } })}><Check size={16}/>Принять задание</button><button type="button" className="neu-btn" disabled={!enabled} onClick={() => { frame.change(); setConfirm({ action: "decline", revision: job.revision }); }}><X size={16}/>Отклонить задание</button></div></div>}
      {!company && ["in_progress", "changes_requested"].includes(job.state) && <form className="space-y-4 border-t pt-4" aria-label="Результат задания" onSubmit={e => { e.preventDefault(); act({ action: "submit", payload: { links: links.split(/\r?\n/).map(value => value.trim()).filter(Boolean), note } }); }}>
        <fieldset className="min-w-0 space-y-4" disabled={!enabled}><label className="block text-sm">Ссылки на результат<textarea className="neu-input mt-2 w-full" rows={3} required maxLength={2504} value={links} onChange={e => { frame.change(); setLinks(e.target.value); }}/></label><label className="block text-sm">Комментарий<textarea className="neu-input mt-2 w-full" rows={3} maxLength={2000} value={note} onChange={e => { frame.change(); setNote(e.target.value); }}/></label><button type="submit" className="neu-btn neu-btn-primary"><Send size={16}/>Отправить результат</button></fieldset>
      </form>}
      {company && job.state === "offered" && <button type="button" className="neu-btn" disabled={!enabled} onClick={() => { frame.change(); setConfirm({ action: "cancel", revision: job.revision }); }}><Ban size={16}/>Отменить предложение</button>}
      {company && job.state === "submitted" && <div className="space-y-4 border-t pt-4"><button type="button" className="neu-btn neu-btn-primary" disabled={!enabled} onClick={() => { frame.change(); setConfirm({ action: "approve", revision: job.revision }); }}><Check size={16}/>Принять результат</button>
        <form aria-label="Доработка задания" onSubmit={e => { e.preventDefault(); act({ action: "request_changes", payload: { feedback: feedback.trim() } }); }}><fieldset disabled={!enabled} className="space-y-3"><label className="block text-sm">Что доработать<textarea className="neu-input mt-2 w-full" required rows={3} maxLength={2000} value={feedback} onChange={e => { frame.change(); setFeedback(e.target.value); }}/></label><button className="neu-btn" type="submit"><Send size={16}/>Запросить доработку</button></fieldset></form></div>}
      {confirm && confirm.revision === job.revision && <div role="group" aria-label="Подтверждение действия" className="space-y-3 border-y py-4"><p className="text-sm">{confirm.action === "approve" ? "Принять текущую версию результата?" : confirm.action === "decline" ? "Отклонить это предложение?" : "Отменить ещё не принятое предложение?"}</p><div className="flex flex-wrap gap-2"><button type="button" className="neu-btn neu-btn-primary" disabled={!enabled} onClick={() => act({ action: confirm.action, payload: {} })}><Check size={16}/>Подтвердить</button><button type="button" className="neu-btn" onClick={() => { frame.change(); setConfirm(null); }}><X size={16}/>Назад</button></div></div>}
      {error && <p role="alert" className="break-words text-sm">{error}</p>}
      <History detail={detail.data} offset={offset} onPage={setOffset}/>
    </>}
  </section>;
}

function History({ detail, offset, onPage }: { detail: CreatorJobDetail; offset: number; onPage: (value: number) => void }) {
  return <section className="min-w-0 space-y-4 border-t pt-4" aria-label="Версии результата"><h4 className="text-sm font-medium">Версии результата · {detail.job.submissionCount}</h4>
    {detail.history.items.length === 0 ? <p className="text-sm text-muted-foreground">Результат ещё не отправлен.</p> : <div className="divide-y">{detail.history.items.map(item => <article className="min-w-0 space-y-3 py-4" key={item.sequence}><div className="flex flex-wrap justify-between gap-2 text-xs"><h5 className="font-medium">Версия {item.sequence}</h5><time dateTime={item.submittedAt} className="text-muted-foreground">{date(item.submittedAt)}</time></div>{item.links.map(link => <a key={link} href={link} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-start gap-2 text-sm"><ExternalLink size={16} className="shrink-0"/><span className="break-all">{link}</span></a>)}{item.note && <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{item.note}</p>}</article>)}</div>}
    {detail.job.submissionCount > 0 && <Pages label="Страницы версий" offset={offset} hasMore={detail.history.hasMore} disabled={false} onChange={onPage}/>}
  </section>;
}
