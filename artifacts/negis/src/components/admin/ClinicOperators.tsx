import { useState } from "react";
import { Send, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { operatorApi, useOperatorList } from "@/lib/operatorApi";
import { OperatorRequests } from "@/components/operators/OperatorRequests";
import {
  arrivalPriceToMinor,
  operatorLeadScopeLabels,
  type OperatorLeadScope,
  type OperatorProfile,
} from "../../../../../lib/crm/operator-contracts";

export function ClinicOperators({ workspaceId }: { workspaceId: string }) {
  const list = useOperatorList<OperatorProfile>(
    `operator-directory?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  const [selected, setSelected] = useState<OperatorProfile | null>(null);
  const [brief, setBrief] = useState("");
  const [price, setPrice] = useState("");
  const [leadScope, setLeadScope] = useState<OperatorLeadScope>("assigned");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  async function send(event: React.FormEvent) {
    event.preventDefault();
    const amount = arrivalPriceToMinor(price);
    if (!selected || amount === null) {
      setMessage("Укажите цену в тенге, не более двух знаков после запятой.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await operatorApi(
        `clinic-operator-requests?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          operatorId: selected.id,
          clinicBrief: brief,
          pricePerArrivalMinor: amount,
          leadScope,
        },
      );
      setSelected(null);
      setBrief("");
      setPrice("");
      setRevision((value) => value + 1);
      setMessage("Предложение отправлено оператору.");
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : "Не удалось отправить предложение",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-w-0 space-y-6">
      <header>
        <h2 className="text-xl font-semibold">Оператор для клиники</h2>
        <p className="mt-2 text-sm opacity-70">
          Стоимость прихода согласуется с оператором. Оплата пока производится
          напрямую, вне платформы.
        </p>
        <p className="mt-1 text-sm opacity-70">
          Оператор увидит заявки в выбранном вами объёме после принятия
          предложения. Реклама автоматически не запускается.
        </p>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          Одобрены платформой и принимают запросы
        </h3>
        <button
          className="neu-btn"
          type="button"
          title="Обновить операторов"
          aria-label="Обновить операторов"
          onClick={list.refresh}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {list.error && (
        <p role="alert" className="break-words text-sm text-red-700">
          {list.error}
        </p>
      )}
      {!list.data && !list.error && <p role="status">Загружаем операторов…</p>}
      {list.data?.items.length === 0 && (
        <p className="text-sm opacity-70">Свободных операторов пока нет.</p>
      )}
      <div className="divide-y">
        {list.data?.items.map((item) => (
          <div
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <span className="font-medium break-words min-w-0">
              {item.displayName}
            </span>
            <button
              type="button"
              className="neu-btn"
              disabled={busy}
              onClick={() => {
                setSelected(item);
                setLeadScope("assigned");
                setMessage("");
              }}
            >
              Предложить сотрудничество
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="neu-btn"
          disabled={list.offset === 0}
          onClick={list.previous}
        >
          <ChevronLeft size={16} />
          Назад
        </button>
        <button
          type="button"
          className="neu-btn"
          disabled={!list.data?.hasMore}
          onClick={list.next}
        >
          Далее
          <ChevronRight size={16} />
        </button>
      </div>
      {selected && (
        <form className="space-y-3 border-t pt-4" onSubmit={send}>
          <h3 className="font-semibold break-words">
            Предложение: {selected.displayName}
          </h3>
          <label className="block text-sm">
            О клинике и условиях сотрудничества
            <textarea
              required
              maxLength={2000}
              rows={4}
              className="neu-input mt-1 w-full"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="Направление клиники, задачи, контакт для согласования. Без данных пациентов."
            />
          </label>
          <label className="block text-sm">
            Доступ к заявкам
            <select
              className="neu-input mt-1 w-full"
              value={leadScope}
              onChange={(event) =>
                setLeadScope(event.target.value as OperatorLeadScope)
              }
            >
              <option value="assigned">
                {operatorLeadScopeLabels.assigned}
              </option>
              <option value="clinic">{operatorLeadScopeLabels.clinic}</option>
            </select>
          </label>
          <p className="text-sm opacity-70">
            {leadScope === "clinic"
              ? "После принятия оператор увидит имена и телефоны всех заявок клиники, включая новые."
              : "После принятия вы назначите оператору нужные заявки. Остальные ему недоступны."}
          </p>
          <label className="block text-sm">
            Цена за подтверждённый приход, ₸
            <input
              required
              inputMode="decimal"
              className="neu-input mt-1 w-full"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="neu-btn-primary" disabled={busy}>
              <Send size={16} />
              {busy ? "Отправляем…" : "Отправить предложение"}
            </button>
            <button
              type="button"
              className="neu-btn"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
      {message && (
        <p role="status" className="break-words text-sm">
          {message}
        </p>
      )}
      <OperatorRequests key={revision} workspaceId={workspaceId} />
    </div>
  );
}
