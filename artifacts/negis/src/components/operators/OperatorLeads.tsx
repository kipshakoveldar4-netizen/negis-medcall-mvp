import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { operatorApi, useOperatorList } from "@/lib/operatorApi";
import {
  type OperatorLead,
  type OperatorLeadScope,
} from "../../../../../lib/crm/operator-contracts";

export function OperatorLeads({
  requestId,
  workspaceId,
  leadScope,
}: {
  requestId: string;
  workspaceId?: string;
  leadScope: OperatorLeadScope;
}) {
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const base = workspaceId
    ? `clinic-operator-leads?workspaceId=${encodeURIComponent(workspaceId)}&requestId=${encodeURIComponent(requestId)}`
    : `operator-leads?requestId=${encodeURIComponent(requestId)}`;
  return (
    <section
      className="min-w-0 space-y-3 border-t pt-3"
      aria-label="Заявки оператора"
    >
      <h4 className="font-semibold">
        {workspaceId && leadScope === "assigned"
          ? "Назначение заявок"
          : "Доступные заявки"}
      </h4>
      {workspaceId && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmittedSearch(search.trim());
          }}
        >
          <input
            className="neu-input w-full min-w-0"
            aria-label="Имя в заявке"
            placeholder="Поиск по имени"
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="submit"
            className="neu-btn shrink-0"
            title="Найти заявки"
            aria-label="Найти заявки"
          >
            <Search size={16} />
          </button>
        </form>
      )}
      <LeadList
        key={`${requestId}:${submittedSearch}:${workspaceId || "operator"}`}
        path={`${base}&search=${encodeURIComponent(submittedSearch)}`}
        clinic={Boolean(workspaceId)}
        canAssign={Boolean(workspaceId) && leadScope === "assigned"}
      />
    </section>
  );
}

function LeadList({
  path,
  clinic,
  canAssign,
}: {
  path: string;
  clinic: boolean;
  canAssign: boolean;
}) {
  const list = useOperatorList<OperatorLead>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = list.refresh;
  useEffect(() => {
    // Revalidate access when returning to the page; never persist patient contacts.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  async function assign(item: OperatorLead, assigned: boolean) {
    setBusy(true);
    setError("");
    try {
      await operatorApi(path, { leadId: item.id, assigned }, "PATCH");
      refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось назначить заявку.",
      );
      refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm opacity-70">
          {clinic
            ? "Изменение назначения не меняет ответственного сотрудника в CRM."
            : "Только просмотр. Изменение заявок и запись пациентов пока доступны сотрудникам клиники."}
        </p>
        <button
          className="neu-btn shrink-0"
          type="button"
          title="Обновить заявки"
          aria-label="Обновить заявки"
          onClick={refresh}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {(error || list.error) && (
        <p role="alert" className="break-words text-sm text-red-700">
          {error || list.error}
        </p>
      )}
      {!list.data && !list.error && <p role="status">Загружаем заявки…</p>}
      {list.data?.items.length === 0 && (
        <p className="text-sm">
          {clinic ? "Заявки не найдены." : "Доступных заявок пока нет."}
        </p>
      )}
      <div className="divide-y">
        {list.data?.items.map((item) => (
          <div
            key={item.id}
            className="flex flex-wrap items-start justify-between gap-3 py-3"
          >
            <div className="min-w-0 flex-1 break-words">
              <p className="font-medium">{item.name || "Имя не указано"}</p>
              <p className="text-sm">{item.phone || "Телефон не указан"}</p>
              {item.source && (
                <p className="text-xs opacity-70">Источник: {item.source}</p>
              )}
            </div>
            {canAssign && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={item.assigned === true}
                  disabled={busy}
                  aria-label={`Назначить заявку: ${item.name || "без имени"}`}
                  onChange={(event) => void assign(item, event.target.checked)}
                />
                Назначена
              </label>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          className="neu-btn"
          type="button"
          disabled={busy || list.offset === 0}
          onClick={list.previous}
        >
          <ChevronLeft size={16} />
          Назад
        </button>
        <button
          className="neu-btn"
          type="button"
          disabled={busy || !list.data?.hasMore}
          onClick={list.next}
        >
          Далее
          <ChevronRight size={16} />
        </button>
      </div>
    </>
  );
}
