import { useEffect, useRef, useState } from "react";
import { captureControlAccess, controlFetch } from "../lib/api";
import { PartnerTerms } from "../../../negis/src/components/contributors/PartnerTerms";
import { CONTRIBUTOR_PAGE_SIZE, contributorStatusLabels, parseContributorProfile, type ContributorProfile, type ContributorRole } from "../../../../lib/crm/contributor-contracts";

function parseList(value: unknown): { items: ContributorProfile[]; hasMore: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.items) || row.items.length > CONTRIBUTOR_PAGE_SIZE || typeof row.hasMore !== "boolean") return null;
  const items = row.items.map(parseContributorProfile);
  if (items.some(item => !item) || new Set(items.map(item => item!.id.toLowerCase())).size !== items.length) return null;
  return { items: items as ContributorProfile[], hasMore: row.hasMore };
}
export function Contributors() {
  const [data, setData] = useState<ReturnType<typeof parseList>>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [selected, setSelected] = useState<{id:string;serial:number} | null>(null);
  const selectionEpoch = useRef(0);
  const selection = useRef(selected); selection.current = selected;
  const selectedSection = useRef<HTMLElement | null>(null);
  const focusedSelection = useRef(selected);
  const origin = useRef(captureControlAccess());
  const alive = useRef(true);
  const refusal = useRef(false);
  const pending = useRef<object | null>(null);
  const page = useRef({ offset, revision });
  const token = page.current.offset === offset && page.current.revision === revision ? page.current : (page.current = { offset, revision });
  const current = () => alive.current && !refusal.current && origin.current.isCurrent() && page.current === token;
  const reviewCurrent = () => alive.current && !refusal.current && origin.current.isCurrent();
  function refreshList() { if (!reviewCurrent() || pending.current) return; setData(null); setRevision(n => n + 1); }
  function closeTerms() { selection.current = null; setSelected(null); }
  function refuse() { refusal.current = true; setDenied(true); setData(null); closeTerms(); setBusy(false); pending.current = null; setError("Доступ только у владельца платформы."); }
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current = null; }; }, []);
  useEffect(() => { const visible = () => { if (document.visibilityState === "visible") refreshList(); };
    window.addEventListener("focus", refreshList); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refreshList); document.removeEventListener("visibilitychange", visible); }; }, []);
  useEffect(() => {
    let active = true;
    setData(null); setError("");
    void (async () => {
      try {
        if (!current()) return;
        const response = await controlFetch(`/api/crm/platform-contributors?offset=${offset}`, {}, { actorId: origin.current.actorId, isCurrent: () => active && current() });
        if (!active || !current()) return;
        if ([401, 403, 404].includes(response.status)) { refuse(); return; }
        const payload = await response.json().catch(() => null);
        if (!active || !current()) return;
        const parsed = payload?.success === true ? parseList(payload.data) : null;
        if (!response.ok || !parsed) throw Error("Не удалось загрузить заявки блогеров.");
        setData(parsed);
      } catch (err) { if (active && current()) setError(err instanceof Error ? err.message : "Нет связи с сервером."); }
    })();
    return () => { active = false; };
  }, [offset, revision]);
  async function decide(item: ContributorProfile, role: ContributorRole, action: "approve" | "suspend") {
    if (!current() || pending.current || !data?.items.includes(item)) return;
    const attempt = {}; pending.current = attempt;
    const ok = window.confirm(`${action === "approve" ? "Одобрить заявку" : "Отозвать одобрение заявки"}: ${item.displayName}, ${role === "partner" ? "партнёр" : "автор контента"}?`);
    if (!ok) { if (pending.current === attempt) pending.current = null; return; }
    if (!current() || pending.current !== attempt) return;
    setBusy(true); setError("");
    try {
      const response = await controlFetch("/api/crm/platform-contributors", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, revision: item.revision, role, action }) },
        { actorId: origin.current.actorId, isCurrent: () => current() && pending.current === attempt });
      if (!current() || pending.current !== attempt) return;
      if ([401, 403, 404].includes(response.status)) { refuse(); return; }
      const payload = await response.json().catch(() => null);
      if (!current() || pending.current !== attempt) return;
      const parsed = payload?.success === true ? parseContributorProfile(payload.data) : null;
      if (!response.ok || !parsed || parsed.id !== item.id || parsed.revision === item.revision
        || (role === "partner" ? parsed.partnerStatus : parsed.creatorStatus) !== (action === "approve" ? "approved" : "suspended"))
        throw Error("Не удалось подтвердить решение. Обновите список перед повтором.");
      setData(null); setRevision(n => n + 1);
    } catch (err) { if (current() && pending.current === attempt) { setData(null); setError(err instanceof Error ? err.message : "Нет связи с сервером."); } }
    finally { if (pending.current === attempt) { pending.current = null; if (current()) setBusy(false); } }
  }
  if (denied) return <><h1 className="page-title">Доступ закрыт</h1><p role="alert">{error}</p></>;
  if (!origin.current.isCurrent()) return <p role="status">Проверяем доступ…</p>;
  return <>
    <h1 className="page-title">Блогеры</h1>
    <p className="page-sub">Заявки партнёров и авторов контента.</p>
    <button type="button" className="btn" disabled={busy} onClick={refreshList}>Обновить список</button>
    {error && <p role="alert" style={{ color: "var(--danger)", overflowWrap: "anywhere" }}>{error}</p>}
    {!data && !error && <p role="status">Загружаем заявки…</p>}
    {data?.items.length === 0 && <p>Заявок пока нет.</p>}
    {selected && <section ref={selectedSection} aria-label="Условия выбранного партнёра" style={{ marginTop: 24, minWidth: 0 }}>
      <h2 className="section-title">{data?.items.find(p => p.id === selected.id)?.displayName ?? "Партнёр"}</h2>
      <PartnerTerms key={`${selected.id}:${selected.serial}`} actorId={origin.current.actorId} profileId={selected.id} side="platform"
        approvedProfileRevision={data?.items.find(p => p.id === selected.id && p.partnerStatus === "approved")?.revision ?? null}
        isSessionCurrent={() => reviewCurrent() && selection.current === selected} onAccessDenied={refuse} onRefreshProfile={refreshList}
        onClose={() => { if (reviewCurrent() && selection.current === selected) closeTerms(); }}
        onReady={() => { if (reviewCurrent() && data?.items.some(p => p.id === selected.id) && selection.current === selected && focusedSelection.current !== selected) {
          focusedSelection.current = selected; selectedSection.current?.scrollIntoView({ block: "start", behavior: "auto" });
        } }}
        request={async options => {
          const valid = () => reviewCurrent() && selection.current === selected && options.isCurrent();
          const query = options.method === "GET" ? "?" + new URLSearchParams({ profileId: selected.id, ...(options.requestId ? { requestId: options.requestId } : {}) }) : "";
          const response = await controlFetch("/api/crm/platform-partner-terms" + query,
            { method: options.method, signal: options.signal, ...(options.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) }) },
            { actorId: origin.current.actorId, isCurrent: valid });
          if ([401,403,404].includes(response.status)) throw Object.assign(Error("Доступ к партнёрству изменился."), { status: response.status });
          const result = await response.json().catch(() => null);
          if (!response.ok || result?.success !== true || !Object.hasOwn(result, "data")) throw Object.assign(Error("Не удалось подтвердить условия партнёрства."), { status: response.status });
          return result.data;
        }} />
    </section>}
    <div className="operator-list">{data?.items.map(item => <article className="operator-row" key={item.id}>
      <div className="operator-description"><h2>{item.displayName}</h2>
        {item.portfolioUrls.map(url => <p key={url} style={{ overflowWrap: "anywhere" }}><a href={url} target="_blank" rel="noopener noreferrer">{url}</a></p>)}
        {(["partner", "creator"] as const).map(role => {
          const status = role === "partner" ? item.partnerStatus : item.creatorStatus;
          return status && <div key={role} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 12 }}>
            <span>{role === "partner" ? "Партнёр" : "Автор контента"}: {contributorStatusLabels[status]}</span>
            <button className="btn" type="button" disabled={busy} onClick={() => void decide(item, role, status === "approved" ? "suspend" : "approve")}>{status === "approved" ? "Отозвать одобрение" : "Одобрить заявку"}</button>
          </div>;
        })}
        {item.partnerStatus && <button type="button" className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={() => {
          if (!current() || !data.items.includes(item)) return;
          // Reopening the same profile cannot revive a retired form.
          const next = { id: item.id, serial: ++selectionEpoch.current }; selection.current = next; setSelected(next);
        }}>Условия партнёрства</button>}
      </div>
    </article>)}</div>
    <div className="operator-pagination"><button className="btn" disabled={offset === 0 || busy} onClick={() => { if (current() && !pending.current) { closeTerms(); setOffset(n => Math.max(0, n - CONTRIBUTOR_PAGE_SIZE)); } }}>Назад</button><button className="btn" disabled={!data?.hasMore || busy} onClick={() => { if (current() && !pending.current && data?.hasMore) { closeTerms(); setOffset(n => n + CONTRIBUTOR_PAGE_SIZE); } }}>Далее</button></div>
  </>;
}
