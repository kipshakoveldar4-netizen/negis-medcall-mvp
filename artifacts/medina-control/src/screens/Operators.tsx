import { useEffect, useRef, useState } from "react";
import { captureControlAccess, controlFetch } from "../lib/api";
import {
  OPERATOR_PAGE_SIZE,
  operatorStatusLabels,
  type OperatorList,
  type OperatorProfile,
} from "../../../../lib/crm/operator-contracts";

function operatorList(value: unknown): OperatorList<OperatorProfile> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.items) || data.items.length > OPERATOR_PAGE_SIZE || typeof data.hasMore !== "boolean") return null;
  const ids = new Set<string>();
  const items: OperatorProfile[] = [];
  for (const value of data.items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)
      || ids.has(item.id.toLowerCase()) || typeof item.displayName !== "string" || !item.displayName.trim()
      || typeof item.status !== "string" || !["pending", "approved", "suspended"].includes(item.status)
      || typeof item.acceptingRequests !== "boolean") return null;
    ids.add(item.id.toLowerCase());
    items.push({ id: item.id, displayName: item.displayName, status: item.status as OperatorProfile["status"], acceptingRequests: item.acceptingRequests });
  }
  return { items, hasMore: data.hasMore };
}

export function Operators() {
  const [data, setData] = useState<OperatorList<OperatorProfile> | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const deniedRef = useRef(false);
  const origin = useRef(captureControlAccess());
  const mounted = useRef(true);
  const pending = useRef<object | null>(null);
  const page = useRef({ offset, revision });
  const pageToken = page.current.offset === offset && page.current.revision === revision
    ? page.current : (page.current = { offset, revision });
  const current = () => mounted.current && !deniedRef.current && origin.current.isCurrent() && page.current === pageToken;
  const scope = { actorId: origin.current.actorId, isCurrent: current };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  function refuse() {
    deniedRef.current = true;
    setData(null); setBusy(false); setDenied(true); pending.current = null;
    setError("Доступ только у владельца платформы.");
  }
  useEffect(() => {
    let alive = true;
    setData(null);
    setError("");
    void (async () => {
      try {
        if (!current()) return;
        const readScope = { actorId: scope.actorId, isCurrent: () => alive && current() };
        const response = await controlFetch(
          `/api/crm/platform-operators?offset=${offset}`,
          {}, readScope,
        );
        if (!alive || !current()) return;
        if ([401, 403, 404].includes(response.status)) { refuse(); return; }
        const payload = await response.json().catch(() => null);
        if (!alive || !current()) return;
        const list = payload?.success === true ? operatorList(payload.data) : null;
        if (!response.ok || !list)
          throw new Error(
            response.status === 404
              ? "Доступ только у владельца платформы."
              : "Не удалось загрузить операторов.",
          );
        if (alive && current()) setData(list);
      } catch (err) {
        if (alive && current())
          setError(
            err instanceof Error ? err.message : "Нет связи с сервером.",
          );
      }
    })();
    return () => {
      alive = false;
    };
  }, [offset, revision]);
  async function decide(item: OperatorProfile, action: "approve" | "suspend") {
    if (!current() || denied || pending.current || !data?.items.includes(item)) return;
    const attempt = {};
    pending.current = attempt;
    if (
      !window.confirm(
        `${action === "approve" ? "Одобрить" : "Приостановить"} оператора ${item.displayName}?`,
      )
    ) { if (pending.current === attempt) pending.current = null; return; }
    if (!current() || pending.current !== attempt) return;
    setBusy(true);
    setError("");
    try {
      const response = await controlFetch("/api/crm/platform-operators", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, action }),
      }, { actorId: scope.actorId, isCurrent: () => current() && pending.current === attempt });
      if (!current() || pending.current !== attempt) return;
      if ([401, 403, 404].includes(response.status)) { refuse(); return; }
      const payload = await response.json().catch(() => null);
      if (!current() || pending.current !== attempt) return;
      const receipt = payload?.success === true ? operatorList({ items: [payload.data], hasMore: false })?.items[0] : null;
      if (!response.ok || !receipt || receipt.id.toLowerCase() !== item.id.toLowerCase()
        || receipt.status !== (action === "approve" ? "approved" : "suspended") || receipt.acceptingRequests)
        throw new Error(
          response.status === 404
            ? "Доступ только у владельца платформы."
            : "Не удалось изменить статус.",
        );
      pending.current = null;
      setBusy(false);
      setRevision((value) => value + 1);
    } catch (err) {
      if (current() && pending.current === attempt) setError("Не удалось подтвердить изменение статуса. Обновите список перед повтором.");
    } finally {
      if (current() && pending.current === attempt) { pending.current = null; setBusy(false); }
    }
  }
  if (denied) return <><h1 className="page-title">Страница не найдена</h1><p className="page-sub">Доступ к управлению операторами закрыт.</p></>;
  if (!origin.current.isCurrent()) return <p role="status">Проверяем доступ…</p>;
  return (
    <>
      <h1 className="page-title">Операторы колл-центра</h1>
      <p className="page-sub">
        Операторы подают заявку в кабинете /operator. Одобрение не выдаёт доступ
        к пациентам. После одобрения оператор сам включает приём предложений.
      </p>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => { if (current() && !pending.current) setRevision((value) => value + 1); }}
      >
        Обновить список
      </button>
      {error && (
        <p
          role="alert"
          style={{ color: "var(--danger)", overflowWrap: "anywhere" }}
        >
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Загружаем операторов…</p>}
      {data?.items.length === 0 && <p>Заявок пока нет.</p>}
      <div className="operator-list">
        {data?.items.map((item) => (
          <article key={item.id} className="operator-row">
            <div className="operator-description">
              <h2>{item.displayName}</h2>
              <p>
                {operatorStatusLabels[item.status]}
                {item.status === "approved"
                  ? item.acceptingRequests
                    ? " · Принимает предложения"
                    : " · Не принимает новые предложения"
                  : ""}
              </p>
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void decide(
                  item,
                  item.status === "approved" ? "suspend" : "approve",
                )
              }
            >
              {item.status === "approved" ? "Приостановить" : "Одобрить"}
            </button>
          </article>
        ))}
      </div>
      <div className="operator-pagination">
        <button
          type="button"
          className="btn"
          disabled={offset === 0 || busy}
          onClick={() => { if (current() && !pending.current) setOffset((value) => Math.max(0, value - OPERATOR_PAGE_SIZE)); }}
        >
          Назад
        </button>
        <button
          type="button"
          className="btn"
          disabled={!data?.hasMore || busy}
          onClick={() => { if (current() && !pending.current && data?.hasMore) setOffset((value) => value + OPERATOR_PAGE_SIZE); }}
        >
          Далее
        </button>
      </div>
    </>
  );
}
