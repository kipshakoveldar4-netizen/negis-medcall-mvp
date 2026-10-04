import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { createSiteInquiryDeletion, type DeletionRequest } from "../../lib/siteInquiryDeletion";

const reasonLabels: Record<string, string> = {
  linked_client: "Создан клиент", assigned_staff: "Назначен сотрудник", linked_campaign: "Связана реклама",
  non_site_source: "Источник изменён", campaign_snapshot: "Указана кампания", progressed_stage: "Заявка уже в работе",
  deals: "Есть продажи", tasks: "Есть задачи", wazzup_inbound_messages: "Есть переписка",
  whatsapp_cloud_inbound_messages: "Есть переписка", growth_operator_lead_assignments: "Заявка передана оператору",
  growth_operator_bookings: "Есть запись оператора", audit_history: "Есть журнал изменений", other_site_receipts: "Есть обращения с другого сайта",
};

export function SiteInquiryDeletion({ workspaceId, leadId, request, onDeleted }: {
  workspaceId: string;
  leadId: string;
  request: DeletionRequest;
  onDeleted: () => void;
}) {
  const workflow = useMemo(() => createSiteInquiryDeletion(workspaceId, leadId, request, () => crypto.randomUUID()), [workspaceId, leadId, request]);
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot);
  const [open, setOpen] = useState(false);
  const notified = useRef(false);
  const headingId = `site-deletion-${leadId}`;
  const busy = state.phase === "submitting";
  const unresolved = busy || state.phase === "uncertain";
  useEffect(() => { void workflow.inspect(); }, [workflow]);
  useEffect(() => {
    if (state.phase === "done" && !notified.current) { notified.current = true; onDeleted(); }
  }, [state.phase, onDeleted]);
  useEffect(() => {
    if (!unresolved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unresolved]);
  // Visibility is granted by a successful workspace-scoped server preview, not by a UI admin toggle.
  if (!state.visible) return null;
  const scope = state.scope;
  return (
    <section className="mt-5 min-w-0 border-t pt-4 text-sm [overflow-wrap:anywhere]" style={{ borderColor: "var(--negis-border)" }} aria-labelledby={headingId}>
      <button type="button" id={headingId} aria-expanded={open} aria-controls={`${headingId}-body`}
        className="flex w-full items-center gap-2 text-left font-semibold disabled:opacity-60" disabled={unresolved}
        onClick={() => { setOpen(!open); workflow.confirm(false); if (!open) void workflow.inspect(); }}>
        <Trash2 size={16} className="shrink-0" /> Удаление заявки с сайта
        <ChevronDown size={16} className={`ml-auto shrink-0 ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? <div id={`${headingId}-body`} className="mt-3 space-y-3">
        {state.phase === "checking" ? <p role="status" className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Проверяем доступ и состав…</p> : null}
        {scope ? <>
          <p>Состав запроса: эта заявка (1) и копии согласия с сайта ({scope.receiptCount}).</p>
          <p style={{ color: "var(--negis-muted)" }}>Действие необратимо. Оно не очищает другие обращения, резервные копии и данные внешних сервисов.</p>
          {scope.deletionAvailability === "disabled" ? <p>Удаление для этого сайта пока отключено. Данные не изменены.</p> : null}
          {scope.deletionAvailability === "schema_not_ready" ? <p>Удаление ещё не подготовлено на сервере. Данные не изменены.</p> : null}
          {scope.reviewReasons.length > 0 ? <div role="status">
            <p className="font-semibold">Нужен отдельный разбор связей. Удаление недоступно.</p>
            <ul className="mt-1 list-disc pl-5">{[...new Set(scope.reviewReasons.map((reason) => Object.hasOwn(reasonLabels, reason) ? reasonLabels[reason] : "Есть связь с рабочими данными"))].map((label) => <li key={label}>{label}</li>)}</ul>
          </div> : null}
          {scope.deletionEnabled && state.phase === "review" ? <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={state.confirmed} onChange={(event) => workflow.confirm(event.target.checked)} />
            <span>Подтверждаю удаление этой заявки и указанных копий согласия.</span>
          </label> : null}
        </> : null}
        {state.message ? <p role="status">{state.message}</p> : null}
        {state.phase === "submitting" ? <p role="status" className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Ожидаем подтверждение сервера…</p> : null}
        {state.phase === "review" && scope?.deletionEnabled ? <button type="button" disabled={!state.confirmed}
          className="flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-3 text-left font-semibold disabled:opacity-50"
          style={{ borderColor: "var(--negis-border)", color: "var(--negis-error)" }} onClick={() => void workflow.submit()}>
          <Trash2 size={16} className="shrink-0" /><span>Удалить заявку и копии согласия</span>
        </button> : null}
        {state.phase === "uncertain" ? <button type="button" className="flex items-center gap-2 rounded-lg border p-3 text-left font-semibold" style={{ borderColor: "var(--negis-border)" }} onClick={() => void workflow.submit()}>
          <RefreshCw size={16} className="shrink-0" />Повторить запрос удаления
        </button> : null}
        {!unresolved && state.phase !== "checking" && state.phase !== "done" ? <button type="button" className="flex items-center gap-2 py-2 text-left" onClick={() => void workflow.inspect()}>
          <RefreshCw size={16} className="shrink-0" />Проверить состав заново
        </button> : null}
      </div> : null}
    </section>
  );
}
