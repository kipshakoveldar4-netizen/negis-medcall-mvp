import { useState } from "react";
import { Check, X, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { operatorApi, useOperatorList } from "@/lib/operatorApi";
import { OperatorLeads } from "./OperatorLeads";
import { OperatorServiceCatalog } from "./OperatorServiceCatalog";
import {
  formatArrivalPrice,
  operatorStatusLabels,
  operatorLeadScopeLabels,
  type OperatorRequest,
} from "../../../../../lib/crm/operator-contracts";

export function OperatorRequests({ workspaceId }: { workspaceId?: string }) {
  const path = workspaceId
    ? `clinic-operator-requests?workspaceId=${encodeURIComponent(workspaceId)}`
    : "operator-inbox";
  const list = useOperatorList<OperatorRequest>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openRequest, setOpenRequest] = useState<string | null>(null);
  const [openCatalog, setOpenCatalog] = useState<string | null>(null);
  async function change(id: string, action: string) {
    if (
      action === "end" &&
      !window.confirm(
        "Завершить сотрудничество с этой клиникой или оператором?",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await operatorApi(path, { id, action }, "PATCH");
      setOpenRequest(null);
      setOpenCatalog(null);
      list.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось изменить предложение",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="min-w-0 space-y-3"
      aria-label="Предложения о сотрудничестве"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {workspaceId ? "Ваши предложения" : "Предложения клиник"}
        </h2>
        <button
          className="neu-btn"
          type="button"
          onClick={list.refresh}
          aria-label="Обновить предложения"
          title="Обновить предложения"
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {(error || list.error) && (
        <p role="alert" className="break-words text-sm text-red-700">
          {error || list.error}
        </p>
      )}
      {!list.data && !list.error && <p role="status">Загружаем предложения…</p>}
      {list.data?.items.length === 0 && (
        <p className="text-sm opacity-70">Предложений пока нет.</p>
      )}
      {list.data?.items.map((item) => (
        <article
          key={item.id}
          className="min-w-0 rounded-lg border p-4 space-y-3"
          style={{ borderColor: "var(--negis-border)" }}
        >
          <div className="flex flex-wrap justify-between gap-2">
            <h3 className="font-semibold break-words min-w-0">
              {item.displayName || "Предложение о сотрудничестве"}
            </h3>
            <span className="text-sm opacity-70">
              {operatorStatusLabels[item.status]}
            </span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">
            {item.clinicBrief}
          </p>
          <p className="font-medium">
            {formatArrivalPrice(item.pricePerArrivalMinor, item.currency)} за
            подтверждённый приход
          </p>
          <p className="text-sm">
            Доступ: {operatorLeadScopeLabels[item.leadScope || "assigned"]}
          </p>
          <div className="flex flex-wrap gap-2">
            {item.status === "requested" && (
              <>
                {!workspaceId && (
                  <button
                    type="button"
                    className="neu-btn-primary"
                    disabled={busy}
                    onClick={() => void change(item.id, "accept")}
                  >
                    <Check size={16} />
                    Принять условия
                  </button>
                )}
                <button
                  type="button"
                  className="neu-btn"
                  disabled={busy}
                  onClick={() =>
                    void change(item.id, workspaceId ? "withdraw" : "decline")
                  }
                >
                  <X size={16} />
                  {workspaceId ? "Отозвать" : "Отклонить"}
                </button>
              </>
            )}
            {item.status === "accepted" && (
              <>
                {!workspaceId && (
                  <button
                    type="button"
                    className="neu-btn"
                    aria-expanded={openCatalog === item.id}
                    onClick={() =>
                      setOpenCatalog(openCatalog === item.id ? null : item.id)
                    }
                  >
                    {openCatalog === item.id ? "Скрыть прайс" : "Услуги и цены"}
                  </button>
                )}
                <button
                  type="button"
                  className="neu-btn"
                  aria-expanded={openRequest === item.id}
                  onClick={() =>
                    setOpenRequest(openRequest === item.id ? null : item.id)
                  }
                >
                  {openRequest === item.id
                    ? "Скрыть заявки"
                    : workspaceId && item.leadScope !== "clinic"
                      ? "Назначить заявки"
                      : "Открыть заявки"}
                </button>
                <button
                  type="button"
                  className="neu-btn"
                  disabled={busy}
                  onClick={() => void change(item.id, "end")}
                >
                  Завершить сотрудничество
                </button>
              </>
            )}
          </div>
          {item.status === "accepted" && openRequest === item.id && (
            <OperatorLeads
              key={item.id}
              requestId={item.id}
              workspaceId={workspaceId}
              leadScope={item.leadScope || "assigned"}
            />
          )}
          {!workspaceId && item.status === "accepted" && openCatalog === item.id && (
            <OperatorServiceCatalog key={item.id} requestId={item.id} />
          )}
        </article>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          className="neu-btn"
          onClick={list.previous}
          disabled={list.offset === 0}
        >
          <ChevronLeft size={16} />
          Назад
        </button>
        <button
          type="button"
          className="neu-btn"
          onClick={list.next}
          disabled={!list.data?.hasMore}
        >
          Далее
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}
