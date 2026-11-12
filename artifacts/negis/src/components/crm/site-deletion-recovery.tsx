import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, RotateCcw, X } from "lucide-react";
import type { DeletionLifetime, DeletionRequest } from "../../lib/siteInquiryDeletion";
import { parseSiteDeletionOperationResponse, parseSiteDeletionOperations, siteDeletionIntentBody, type SiteDeletionOperation } from "../../lib/siteDeletionOperations";

type Props = { workspaceId: string; actorId: string; request: DeletionRequest; lifetime: DeletionLifetime; onDeleted: (leadId: string) => void; onAvailability?: (ready: boolean) => void; refreshKey?: number };
type Owner = Props & { active: boolean; abort: AbortController; busy: boolean; reading: boolean; readRevision: number; isCurrent(): boolean };
type View = { owner: Owner; operations: SiteDeletionOperation[]; enabled: boolean; error: string; loading: boolean; busyKey: string | null };
const statusNames = { prepared: "Результат не подтверждён", committed: "Удалено", abandoned: "Выполнение отменено" };
const actionClass = "neu-btn inline-flex items-center gap-2 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";

export function SiteDeletionRecovery(props: Props) {
  const live = useRef(props); live.current = props;
  const current = useRef<Owner | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [confirmation, setConfirmation] = useState<{ owner: Owner; keys: Set<string> } | null>(null);
  const lastRefresh = useRef(props.refreshKey);
  const endpoint = (owner: Owner) => `/api/crm/site-inquiry-deletion-operations?workspaceId=${encodeURIComponent(owner.workspaceId)}`;
  const call = (owner: Owner, path: string, init?: RequestInit) => owner.request(path, { ...init, cache: "no-store", signal: owner.abort.signal, dispatchGuard: owner.isCurrent });
  const publish = (owner: Owner, value: Omit<View, "owner">) => { if (owner.isCurrent()) setView({ owner, ...value }); };
  async function load(owner: Owner) {
    if (!owner.isCurrent()) return;
    const revision = ++owner.readRevision;
    owner.reading = true;
    setConfirmation({ owner, keys: new Set() });
    const isReadCurrent = () => owner.isCurrent() && owner.readRevision === revision;
    setView(value => value?.owner === owner ? { ...value, loading: true, error: "" } : { owner, operations: [], enabled: false, loading: true, busyKey: null, error: "" });
    try {
      const response = await call(owner, endpoint(owner));
      if (!isReadCurrent()) return;
      if (response.status === 401 || response.status === 403) { owner.onAvailability?.(false); owner.active = false; owner.abort.abort(); setView(null); return; }
      const body: unknown = await response.json();
      if (!isReadCurrent()) return;
      if (!response.ok && body && typeof body === "object" && "code" in body && body.code === "site_deletion_not_configured") { owner.onAvailability?.(false); setView(null); return; }
      const data = response.ok ? parseSiteDeletionOperations(body, owner.workspaceId, owner.actorId) : null;
      if (!data) throw new Error("unconfirmed_recovery");
      owner.onAvailability?.(true);
      publish(owner, { operations: data.operations, enabled: data.deletionEnabled, loading: false, busyKey: null, error: "" });
    } catch {
      if (isReadCurrent()) { owner.onAvailability?.(false); publish(owner, { operations: [], enabled: false, loading: false, busyKey: null, error: "Не удалось проверить операции удаления." }); }
    } finally {
      if (owner.readRevision === revision) owner.reading = false;
    }
  }
  useLayoutEffect(() => {
    const owner: Owner = { ...props, active: true, abort: new AbortController(), busy: false, reading: false, readRevision: 0,
      isCurrent() { const next = live.current; return owner.active && current.current === owner && !owner.abort.signal.aborted
        && owner.workspaceId === next.workspaceId && owner.actorId === next.actorId && owner.request === next.request
        && owner.lifetime === next.lifetime && owner.lifetime.isCurrent(); } };
    current.current = owner;
    const unsubscribe = owner.lifetime.subscribe?.(() => { if (!owner.lifetime.isCurrent()) { owner.active = false; owner.abort.abort(); setView(value => value?.owner === owner ? null : value); } });
    void load(owner);
    return () => { owner.active = false; owner.abort.abort(); unsubscribe?.(); if (current.current === owner) current.current = null; };
  }, [props.workspaceId, props.actorId, props.request, props.lifetime]);
  useEffect(() => {
    if (lastRefresh.current === props.refreshKey) return;
    lastRefresh.current = props.refreshKey;
    const owner = current.current;
    if (owner?.isCurrent() && !owner.busy) void load(owner);
  }, [props.refreshKey]);

  async function act(owner: Owner, item: SiteDeletionOperation, action: "execute" | "abandon" | "acknowledge") {
    if (!owner.isCurrent() || owner.busy || owner.reading || view?.owner !== owner || !view.operations.includes(item)) return;
    if (action === "execute" && (!view.enabled || confirmation?.owner !== owner || !confirmation.keys.has(item.requestKey))) return;
    if ((action === "execute" || action === "abandon") ? item.state !== "prepared" : item.state === "prepared") return;
    owner.busy = true;
    setView(value => value?.owner === owner ? { ...value, busyKey: item.requestKey, error: "" } : value);
    try {
      const response = await call(owner, action === "execute" ? `/api/crm/site-inquiry-deletion?workspaceId=${encodeURIComponent(owner.workspaceId)}` : endpoint(owner), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: action === "execute" ? siteDeletionIntentBody(item.request) : JSON.stringify({ action, requestKey: item.requestKey }),
      });
      if (!owner.isCurrent()) return;
      if (response.status === 401 || response.status === 403) { owner.onAvailability?.(false); owner.active = false; owner.abort.abort(); setView(null); return; }
      const body = await response.json();
      if (!owner.isCurrent()) return;
      if (action === "execute") {
        if (!response.ok || body?.success !== true || body?.data?.deleted !== true || body?.data?.receiptsDeleted !== item.request.receiptIds.length || typeof body?.data?.replayed !== "boolean") throw new Error("unconfirmed_execution");
        owner.onDeleted(item.leadId);
      } else {
        const operation = response.ok ? parseSiteDeletionOperationResponse(body, owner.workspaceId, owner.actorId) : null;
        if (!operation || operation.requestKey !== item.requestKey || siteDeletionIntentBody(operation.request) !== siteDeletionIntentBody(item.request)
          || (action === "acknowledge" && (operation.state === "prepared" || operation.acknowledgedAt === null))) throw new Error("unconfirmed_close");
        if (operation.state === "committed") owner.onDeleted(item.leadId);
      }
      if (!owner.isCurrent()) return;
      setConfirmation(value => value?.owner === owner ? { owner, keys: new Set([...value.keys].filter(key => key !== item.requestKey)) } : value);
      await load(owner);
    } catch {
      if (owner.isCurrent()) setView(value => value?.owner === owner ? { ...value, error: "Результат не подтверждён. Проверьте состояние операции перед повтором." } : value);
    } finally {
      owner.busy = false;
      if (owner.isCurrent()) setView(value => value?.owner === owner ? { ...value, busyKey: null } : value);
    }
  }

  const owner = current.current;
  if (!owner?.isCurrent() || view?.owner !== owner || (!view.operations.length && (view.loading || !view.error))) return null;
  return <section className="mt-4 min-w-0 border-t py-4 text-sm" style={{ borderColor: "var(--negis-border)" }} aria-label="Операции удаления">
    <div className="flex items-center gap-3"><h2 className="font-semibold">Операции удаления</h2>
      <button type="button" className="neu-btn ml-auto p-2" title="Проверить операции" aria-label="Проверить операции" disabled={view.loading || !!view.busyKey}
        onClick={() => { if (owner.isCurrent() && !owner.busy && !owner.reading) void load(owner); }}><RefreshCw size={16}/></button></div>
    {view.loading ? <p role="status" className="mt-3 flex items-center gap-2"><Loader2 size={16} className="animate-spin"/>Проверяем подтверждения…</p> : null}
    {view.error ? <p role="status" className="mt-3">{view.error}</p> : null}
    <ul className="divide-y" style={{ borderColor: "var(--negis-border)" }}>{view.operations.map(item => <li key={item.requestKey} className="min-w-0 py-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><span>Заявка {item.leadId.slice(0, 8)} · согласий: {item.request.receiptIds.length}</span><span>{statusNames[item.state]}</span></div>
      <p className="mt-1" style={{ color: "var(--negis-muted)" }}>{new Date(item.createdAt).toLocaleString("ru-RU", { timeZone: "UTC" })} UTC</p>
      {item.state === "prepared" ? <label className="mt-3 flex items-start gap-2"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0" disabled={!!view.busyKey || view.loading}
        checked={confirmation?.owner === owner && confirmation.keys.has(item.requestKey)} onChange={event => {
          if (!owner.isCurrent() || owner.busy || owner.reading) return; const checked = event.target.checked;
          setConfirmation(value => { if (!owner.isCurrent()) return value; const keys = new Set(value?.owner === owner ? value.keys : []); if (checked) keys.add(item.requestKey); else keys.delete(item.requestKey); return { owner, keys }; });
        }}/><span>Подтверждаю повтор исходного запроса удаления.</span></label> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {item.state === "prepared" ? <>
          <button type="button" className={actionClass} disabled={!!view.busyKey || view.loading || !view.enabled || confirmation?.owner !== owner || !confirmation.keys.has(item.requestKey)} onClick={() => void act(owner, item, "execute")}><RotateCcw size={15}/>Повторить</button>
          <button type="button" className={actionClass} disabled={!!view.busyKey || view.loading} onClick={() => void act(owner, item, "abandon")}><X size={15}/>Отказаться от выполнения</button>
        </> : <button type="button" className={actionClass} disabled={!!view.busyKey || view.loading} onClick={() => void act(owner, item, "acknowledge")}><Check size={15}/>Убрать из списка</button>}
      </div>
    </li>)}</ul>
  </section>;
}
