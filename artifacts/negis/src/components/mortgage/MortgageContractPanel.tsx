import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FileCheck, Loader2, RefreshCw, Undo2, X } from "lucide-react";
import { mortgageDateTimeToIso, mortgageLocalDateTime } from "@/lib/mortgage-workspace";
import {
  MortgageIconButton, MortgageState, mortgageButtonClass, mortgageDate, mortgageErrorMessage,
  mortgageInputClass, mortgagePrimaryClass,
} from "./MortgagePrimitives";

export type MortgageContractPanelProps = {
  leadId: string;
  workspaceId: string;
  timeZone: string;
  canEdit: boolean;
  canVoid: boolean;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  isCurrent: () => boolean;
};

type ContractRecord = {
  id: string;
  leadId: string;
  reference: string;
  signedAt: string;
  responsibleStaffId: string;
  responsibleName: string;
  recordedByName: string;
  voidedAt: string | null;
  voidReason: string;
};
type Snapshot = { records: ContractRecord[]; truncated: boolean };
type ContractReceipt = { id: string; replayed: boolean };
type ReadState = {
  path: string;
  status: "loading" | "ready" | "error" | "unavailable";
  data: Snapshot | null;
  error: string;
};
type Attempt = { fingerprint: string; requestId: string };

class ContractError extends Error {
  constructor(message: string, readonly schemaNotReady = false) { super(message); }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isContract(value: unknown, leadId: string): value is ContractRecord {
  return isObject(value) && isUuid(value.id) && value.leadId === leadId
    && typeof value.reference === "string" && value.reference.length <= 100 && isInstant(value.signedAt)
    && isUuid(value.responsibleStaffId) && typeof value.responsibleName === "string" && typeof value.recordedByName === "string"
    && typeof value.voidReason === "string" && value.voidReason.length <= 500
    && (value.voidedAt === null ? value.voidReason === "" : isInstant(value.voidedAt) && Boolean(value.voidReason.trim()));
}

export function parseMortgageContractSnapshot(value: unknown, leadId: string): Snapshot {
  if (!isObject(value) || !Array.isArray(value.records) || value.records.length > 100
    || !value.records.every((item) => isContract(item, leadId)) || typeof value.truncated !== "boolean"
    || new Set(value.records.map((item) => item.id.toLowerCase())).size !== value.records.length
    || value.records.filter((item) => item.voidedAt === null).length > 1) {
    throw new ContractError("Сервер не вернул корректную историю договоров.");
  }
  return { records: value.records, truncated: value.truncated };
}

export function parseMortgageContractReceipt(value: unknown): ContractReceipt {
  if (!isObject(value) || !isUuid(value.id) || typeof value.replayed !== "boolean") {
    throw new ContractError("Сервер не подтвердил запись договора. Повторите запрос.");
  }
  return { id: value.id, replayed: value.replayed };
}

async function readBody(response: Response, current: () => boolean): Promise<Record<string, unknown>> {
  if (!current()) throw new DOMException("Session ended", "AbortError");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!current()) throw new DOMException("Session ended", "AbortError");
    throw new ContractError(`Сервер вернул нечитаемый ответ (${response.status}).`);
  }
  if (!current()) throw new DOMException("Session ended", "AbortError");
  if (response.status === 503 && isObject(body) && body.code === "schema_not_ready") {
    throw new ContractError("Учёт договоров ещё не подключён", true);
  }
  if (!response.ok || !isObject(body) || body.success !== true || body.mode !== "supabase") {
    throw new ContractError(isObject(body) && typeof body.error === "string"
      ? body.error : `Не удалось выполнить запрос (${response.status}).`);
  }
  return body;
}

export function MortgageContractPanel(props: MortgageContractPanelProps) {
  return <MortgageContractSession key={JSON.stringify([props.workspaceId, props.leadId, props.timeZone])} {...props} />;
}

function MortgageContractSession({ leadId, workspaceId, timeZone, canEdit, canVoid, request, isCurrent }: MortgageContractPanelProps) {
  const headingId = useId();
  const path = `/api/crm/mortgage-contracts?${new URLSearchParams({ leadId, workspaceId })}`;
  const live = useRef({ path, isCurrent, canEdit, canVoid });
  live.current = { path, isCurrent, canEdit, canVoid };
  const mounted = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const readRevision = useRef(0);
  const writing = useRef(false);
  const createAttempt = useRef<Attempt | null>(null);
  const voidAttempt = useRef<Attempt | null>(null);
  const [state, setState] = useState<ReadState>({ path, status: "loading", data: null, error: "" });
  const [signedAt, setSignedAt] = useState(() => mortgageLocalDateTime(new Date().toISOString(), timeZone));
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState("");
  const [notice, setNotice] = useState<(ContractReceipt & { method: "POST" | "PATCH" }) | null>(null);
  const current = useCallback(() => mounted.current && live.current.path === path
    && isCurrent() && live.current.isCurrent(), [path, isCurrent]);

  const load = useCallback(async () => {
    if (!current()) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const revision = ++readRevision.current;
    const latest = () => current() && !controller.signal.aborted && revision === readRevision.current;
    setState({ path, status: "loading", data: null, error: "" });
    try {
      if (!latest()) return;
      const response = await request(path, { signal: controller.signal });
      if (!latest()) return;
      const body = await readBody(response, latest);
      if (!latest()) return;
      const snapshot = parseMortgageContractSnapshot(body.data, leadId);
      setState({ path, status: "ready", data: snapshot, error: "" });
    } catch (error) {
      if (!latest()) return;
      setState({ path, status: error instanceof ContractError && error.schemaNotReady ? "unavailable" : "error",
        data: null, error: mortgageErrorMessage(error) });
    }
  }, [current, leadId, path, request]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readController.current?.abort(); readRevision.current += 1; };
  }, []);

  useEffect(() => {
    void load();
    return () => { readController.current?.abort(); readRevision.current += 1; };
  }, [load]);

  const data = state.path === path && state.status === "ready" && isCurrent() ? state.data : null;
  const hasActive = Boolean(data?.records.some((record) => record.voidedAt === null));

  async function mutate(method: "POST" | "PATCH", payload: Record<string, string>) {
    if (!current() || writing.current || !data || (method === "POST"
      ? !live.current.canEdit || hasActive || data.truncated || !confirmed
      : !live.current.canVoid || !data.records.some((record) => record.id === payload.id && record.voidedAt === null))) return;
    writing.current = true;
    setBusy(true);
    setWriteError("");
    setNotice(null);
    try {
      const attempt = method === "POST" ? createAttempt : voidAttempt;
      const fingerprint = JSON.stringify([path, method, payload]);
      if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: crypto.randomUUID() };
      if (!current()) return;
      const response = await request(path, { method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, requestId: attempt.current.requestId }) });
      if (!current()) return;
      const body = await readBody(response, current);
      if (!current()) return;
      const receipt = parseMortgageContractReceipt(body.data);
      if (method === "PATCH" && receipt.id.toLowerCase() !== payload.id.toLowerCase()) {
        throw new ContractError("Сервер не подтвердил исправление выбранной записи. Повторите запрос.");
      }
      attempt.current = null;
      setConfirmed(false);
      setCorrectingId(null);
      setReason("");
      if (method === "POST") setReference("");
      setNotice({ ...receipt, method });
      await load();
      if (!current()) return;
    } catch (error) {
      if (!current()) return;
      if (error instanceof ContractError && error.schemaNotReady) {
        readController.current?.abort();
        readRevision.current += 1;
        setState({ path, status: "unavailable", data: null, error: error.message });
      } else setWriteError(mortgageErrorMessage(error));
    } finally {
      writing.current = false;
      if (current()) setBusy(false);
    }
  }

  function submitContract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || writing.current || !canEdit || !confirmed || !data || hasActive || data.truncated) return;
    try {
      if (reference.length > 100) throw new Error("Номер договора: не более 100 символов.");
      const iso = mortgageDateTimeToIso(signedAt, timeZone);
      void mutate("POST", { leadId, signedAt: iso, reference: reference.trim() });
    } catch (error) {
      if (current()) setWriteError(mortgageErrorMessage(error));
    }
  }

  function submitCorrection(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    if (!current() || writing.current || !canVoid) return;
    if (!reason.trim() || reason.length > 500) {
      setWriteError("Укажите причину: от 1 до 500 символов.");
      return;
    }
    void mutate("PATCH", { leadId, id, reason: reason.trim() });
  }

  if (!isCurrent()) return null;
  const loading = state.path !== path || state.status === "loading";
  return <section className="min-w-0 border-t border-[var(--negis-border)] pt-4" aria-labelledby={headingId} aria-busy={loading || busy}>
    <header className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h3 id={headingId} className="text-sm font-semibold">Договоры</h3>
      <MortgageIconButton icon={RefreshCw} label="Обновить историю договоров" disabled={loading || busy}
        onClick={() => { if (current() && !writing.current) void load(); }} />
    </header>
    {loading ? <MortgageState kind="loading">Загрузка договоров...</MortgageState>
      : state.status === "unavailable" ? <p role="status" className="py-3 text-sm text-[var(--negis-muted)]">Учёт договоров ещё не подключён</p>
      : state.status === "error" ? <MortgageState kind="error" onRetry={() => void load()}>{state.error}</MortgageState>
      : data && <>
        {data.truncated && <p role="status" className="mb-2 text-xs text-[var(--negis-warning)]">Показана часть истории договоров.</p>}
        {data.records.length ? <ol className="max-h-96 min-w-0 overflow-y-auto">
          {data.records.map((record) => <li key={record.id} className="min-w-0 space-y-2 border-b border-[var(--negis-border)] py-3 last:border-b-0">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{record.reference ? `Договор № ${record.reference}` : "Договор"}</p>
              <span className={`inline-flex max-w-full rounded px-2 py-1 text-[11px] font-medium [overflow-wrap:anywhere] ${record.voidedAt ? "badge-muted" : "badge-success"}`}>
                {record.voidedAt ? "Ошибочная запись" : "Договор заключён"}
              </span>
            </div>
            <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] [&>dd]:[overflow-wrap:anywhere] [&>dt]:text-[var(--negis-muted)]">
              <dt>Дата заключения</dt><dd><time dateTime={record.signedAt}>{mortgageDate(record.signedAt, timeZone)}</time></dd>
              <dt>Ответственный</dt><dd>{record.responsibleName || "Имя не указано"}</dd>
              <dt>Учёл</dt><dd>{record.recordedByName || "Имя не указано"}</dd>
              {record.voidedAt && <>
                <dt>Исправлена</dt><dd><time dateTime={record.voidedAt}>{mortgageDate(record.voidedAt, timeZone)}</time></dd>
                <dt>Причина</dt><dd className="whitespace-pre-wrap">{record.voidReason}</dd>
              </>}
            </dl>
            {canVoid && record.voidedAt === null && (correctingId === record.id
              ? <form className="min-w-0 space-y-2 pt-1" onSubmit={(event) => submitCorrection(event, record.id)}>
                <label className="block min-w-0 text-xs text-[var(--negis-muted)]">
                  Причина исправления
                  <textarea required maxLength={500} rows={2} value={reason} disabled={busy} className={`${mortgageInputClass} mt-1 resize-y`}
                    onChange={(event) => { voidAttempt.current = null; setReason(event.target.value); }} />
                </label>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <button type="submit" className={mortgageButtonClass} disabled={busy || !reason.trim()}>
                    {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Undo2 size={15} aria-hidden="true" />}
                    <span className="min-w-0 break-words">Исправить ошибочную запись</span>
                  </button>
                  <MortgageIconButton icon={X} label="Отменить исправление" disabled={busy} onClick={() => setCorrectingId(null)} />
                </div>
              </form>
              : <button type="button" className={mortgageButtonClass} disabled={busy}
                onClick={() => { if (current() && !writing.current) { setCorrectingId(record.id); setReason(""); setWriteError(""); } }}>
                <Undo2 size={15} aria-hidden="true" /><span className="min-w-0 break-words">Исправить ошибочную запись</span>
              </button>)}
          </li>)}
        </ol> : <p className="py-3 text-sm text-[var(--negis-muted)]">{data.truncated ? "В выборке нет договоров." : "Учтённых договоров нет."}</p>}
        {canEdit && !hasActive && !data.truncated && <form className="mt-3 min-w-0 space-y-3" onSubmit={submitContract}>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="block min-w-0 text-xs text-[var(--negis-muted)]">
              Дата заключения ({timeZone})
              <input type="datetime-local" required step={60} value={signedAt} disabled={busy} className={`${mortgageInputClass} mt-1`}
                onChange={(event) => { createAttempt.current = null; setSignedAt(event.target.value); }} />
            </label>
            <label className="block min-w-0 text-xs text-[var(--negis-muted)]">
              Номер договора (необязательно)
              <input type="text" maxLength={100} value={reference} disabled={busy} className={`${mortgageInputClass} mt-1`}
                onChange={(event) => { createAttempt.current = null; setReference(event.target.value); }} />
            </label>
          </div>
          <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" required checked={confirmed} disabled={busy} className="h-4 w-4 shrink-0 accent-[var(--negis-primary)]"
              onChange={(event) => setConfirmed(event.target.checked)} />
            <span className="min-w-0 break-words">Договор заключён</span>
          </label>
          <button type="submit" className={mortgagePrimaryClass} disabled={busy || !confirmed || !signedAt}>
            {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <FileCheck size={15} aria-hidden="true" />}
            Учесть договор
          </button>
        </form>}
      </>}
    {writeError && <p role="alert" className="mt-2 text-sm text-[var(--negis-error)] [overflow-wrap:anywhere]">{writeError}</p>}
    {notice && <div role="status" className="mt-2 min-w-0 space-y-1 text-xs text-[var(--negis-muted)]">
      <p>{notice.method === "POST" ? "Договор учтён." : "Ошибочная запись исправлена."}{notice.replayed ? " Повторный запрос подтверждён." : ""}</p>
    </div>}
  </section>;
}
