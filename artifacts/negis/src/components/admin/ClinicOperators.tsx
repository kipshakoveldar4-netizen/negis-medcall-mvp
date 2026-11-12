import { useLayoutEffect, useRef, useState } from "react";
import { Send, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { operatorApi, useOperatorList } from "@/lib/operatorApi";
import { OperatorRequests } from "@/components/operators/OperatorRequests";
import { OperatorCommandRecovery } from "@/components/operators/OperatorCommandRecovery";
import { useOperatorCommand } from "@/lib/useOperatorCommand";
import type { OperatorCommandAttempt } from "@/lib/operatorCommandAttempt";
import {
  arrivalPriceToMinor,
  operatorLeadScopeLabels,
  type OperatorLeadScope,
  type OperatorProfile,
  type OperatorCommandResult,
} from "../../../../../lib/crm/operator-contracts";

export function ClinicOperators({ workspaceId, actorId, isSessionCurrent }: {
  workspaceId: string;
  actorId: string;
  isSessionCurrent: () => boolean;
}) {
  const list = useOperatorList<OperatorProfile>(
    `operator-directory?workspaceId=${encodeURIComponent(workspaceId)}`,
    true,
    undefined,
    { actorId, isSessionCurrent },
  );
  const [selected, setSelected] = useState<OperatorProfile | null>(null);
  const [brief, setBrief] = useState("");
  const [price, setPrice] = useState("");
  const [leadScope, setLeadScope] = useState<OperatorLeadScope>("assigned");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const command = useOperatorCommand(actorId, workspaceId, "proposal", isSessionCurrent);
  const mounted = useRef(false);
  // Editing or reloading the view must not unlock an unresolved submission.
  const pending = useRef<object | null>(null);
  const sentDraft = useRef<{ attempt: OperatorCommandAttempt; selectedId: string; brief: string; price: string; leadScope: OperatorLeadScope } | null>(null);
  const currentView = useRef({ workspaceId, actorId, data: list.data, offset: list.offset,
    selected, brief, price, leadScope });
  const scopeChanged = currentView.current.workspaceId !== workspaceId || currentView.current.actorId !== actorId;
  if (scopeChanged || currentView.current.data !== list.data || currentView.current.offset !== list.offset
    || currentView.current.selected !== selected || currentView.current.brief !== brief
    || currentView.current.price !== price || currentView.current.leadScope !== leadScope) {
    currentView.current = { workspaceId, actorId, data: list.data, offset: list.offset, selected, brief, price, leadScope };
    if (scopeChanged) {
      pending.current = null;
      sentDraft.current = null;
      if (busy) setBusy(false);
      setSelected(null);
      setBrief("");
      setPrice("");
      setLeadScope("assigned");
      setMessage("");
    }
  }
  const renderedView = currentView.current;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  function resolved(attempt: OperatorCommandAttempt, result: Exclude<OperatorCommandResult, { state: "unconfirmed" }>) {
    if (!command.isCurrent()) return;
    pending.current = null; setBusy(false);
    if (result.state === "committed") {
      const draft = sentDraft.current;
      if (draft?.attempt === attempt && selected?.id === draft.selectedId && brief === draft.brief && price === draft.price && leadScope === draft.leadScope) {
        setSelected(null); setBrief(""); setPrice("");
      }
      setRevision(value => value + 1);
      setMessage("Результат отправки предложения подтверждён.");
    } else setMessage("Повтор отправки закрыт.");
    sentDraft.current = null;
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    const isCurrent = () => mounted.current && isSessionCurrent() && currentView.current === renderedView;
    const isSameScope = () => mounted.current && isSessionCurrent()
      && currentView.current.workspaceId === workspaceId && currentView.current.actorId === actorId;
    if (pending.current || command.blocked || !actorId || !isCurrent()) return;
    const amount = arrivalPriceToMinor(price);
    if (!selected || amount === null) {
      setMessage("Укажите цену в тенге, не более двух знаков после запятой.");
      return;
    }
    const attempt = command.claim("propose", selected.id);
    if (!attempt) return;
    sentDraft.current = { attempt, selectedId: selected.id, brief, price, leadScope };
    pending.current = attempt;
    const ownsCommand = () => isCurrent() && command.isCurrent(attempt);
    setBusy(true);
    setMessage("");
    try {
      const result = await operatorApi<unknown>(
        `clinic-operator-requests?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          operatorId: selected.id,
          clinicBrief: brief,
          pricePerArrivalMinor: amount,
          leadScope,
          commandId: attempt.commandId,
        },
        "POST",
        undefined,
        actorId,
        ownsCommand,
      );
      if (!ownsCommand()) return;
      const confirmed = command.complete(attempt, result);
      if (confirmed) resolved(attempt, confirmed);
    } catch (err) {
      if (!ownsCommand()) return;
      setMessage(
        err instanceof Error ? err.message : "Не удалось отправить предложение",
      );
    } finally {
      if (pending.current === attempt) {
        pending.current = null;
        if (isSameScope()) setBusy(false);
      }
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
      <OperatorCommandRecovery key={`${actorId}:${workspaceId}:${command.attempt?.commandId ?? "idle"}`} command={command} onResolved={resolved} />
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
              disabled={busy || command.blocked}
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
            <button type="submit" className="neu-btn-primary" disabled={busy || command.blocked}>
              <Send size={16} />
              {busy ? "Отправляем…" : "Отправить предложение"}
            </button>
            <button
              type="button"
              className="neu-btn"
              disabled={busy || command.blocked}
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
      <OperatorRequests key={revision} workspaceId={workspaceId} actorId={actorId} isSessionCurrent={isSessionCurrent} />
    </div>
  );
}
