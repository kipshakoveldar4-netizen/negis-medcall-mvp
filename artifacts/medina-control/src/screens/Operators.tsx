import { useEffect, useState } from "react";
import { controlFetch } from "../lib/api";
import {
  OPERATOR_PAGE_SIZE,
  operatorStatusLabels,
  type OperatorList,
  type OperatorProfile,
} from "../../../../lib/crm/operator-contracts";

export function Operators() {
  const [data, setData] = useState<OperatorList<OperatorProfile> | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError("");
    void (async () => {
      try {
        const response = await controlFetch(
          `/api/crm/platform-operators?offset=${offset}`,
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.success)
          throw new Error(
            response.status === 404
              ? "Доступ только у владельца платформы."
              : payload?.error || "Не удалось загрузить операторов.",
          );
        if (alive) setData(payload.data);
      } catch (err) {
        if (alive)
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
    if (
      !window.confirm(
        `${action === "approve" ? "Одобрить" : "Приостановить"} оператора ${item.displayName}?`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const response = await controlFetch("/api/crm/platform-operators", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, action }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success)
        throw new Error(
          response.status === 404
            ? "Доступ только у владельца платформы."
            : payload?.error || "Не удалось изменить статус.",
        );
      setRevision((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Нет связи с сервером.");
    } finally {
      setBusy(false);
    }
  }
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
        onClick={() => setRevision((value) => value + 1)}
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
          onClick={() =>
            setOffset((value) => Math.max(0, value - OPERATOR_PAGE_SIZE))
          }
        >
          Назад
        </button>
        <button
          type="button"
          className="btn"
          disabled={!data?.hasMore || busy}
          onClick={() => setOffset((value) => value + OPERATOR_PAGE_SIZE)}
        >
          Далее
        </button>
      </div>
    </>
  );
}
