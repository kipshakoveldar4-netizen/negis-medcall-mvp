import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { SiteInquiryDeletion } from "../../artifacts/negis/src/components/crm/site-inquiry-deletion";
import type { DeletionRequest } from "../../artifacts/negis/src/lib/siteInquiryDeletion";
import "../../artifacts/negis/src/index.css";

const workspace = "00000000-0000-4000-8000-000000000001";
const lead = "00000000-0000-4000-8000-000000000002";
const receipt = "00000000-0000-4000-8000-000000000003";
function Example({ mode }: { mode: string }) {
  const [deleted, setDeleted] = useState(false);
  const [requests, setRequests] = useState(0);
  const [sameRetry, setSameRetry] = useState(false);
  const request = useMemo<DeletionRequest>(() => {
    let previous = "";
    return async (_path, init) => {
      if (init?.method !== "POST") {
        if (mode === "unauthorized") return Response.json({ success: false }, { status: 403 });
        const deletionAvailability = ["disabled", "schema_not_ready", "review_required"].includes(mode) ? mode : "confirmation_required";
        return Response.json({ success: true, data: {
          leadId: lead, leadUpdatedAt: "2026-09-28T11:00:00.123456+00:00", receiptIds: [receipt], receiptCount: 1,
          confirmationRequired: true, reviewRequired: mode === "review_required", reviewReasons: mode === "review_required" ? ["tasks", "linked_client"] : [],
          deletionEnabled: deletionAvailability === "confirmation_required", deletionAvailability,
        } });
      }
      setRequests((count) => count + 1);
      if (mode === "conflict") return Response.json({ code: "deletion_scope_changed" }, { status: 409 });
      if (mode === "lost") {
        if (!previous) { previous = String(init.body); throw new Error("Simulated lost response"); }
        setSameRetry(previous === init.body);
      }
      return Response.json({ success: true, data: { deleted: true, receiptsDeleted: 1, replayed: mode === "lost" } });
    };
  }, [mode]);
  return <>
    <div className="negis-glass mx-auto mt-6 w-full max-w-lg p-5" style={{ background: "var(--negis-surface)" }}>
      <h2 className="text-lg font-bold">Тестовая заявка с сайта</h2>
      <p className="mt-1 text-sm">Одноразовые данные, без клиента и без телефона.</p>
      {deleted ? <p role="status" className="mt-5">Тестовая заявка удалена из списка.</p> : <SiteInquiryDeletion key={mode} workspaceId={workspace} leadId={lead} request={request} onDeleted={() => setDeleted(true)} />}
    </div>
    <output className="mt-4 block text-sm">Запросов удаления: {requests}. Повтор совпадает: {sameRetry ? "да" : "нет"}.</output>
  </>;
}
function Fixture() {
  const [mode, setMode] = useState("enabled");
  return <main className="mx-auto max-w-2xl p-4" style={{ color: "var(--negis-text)", letterSpacing: 0 }}>
    <h1 className="text-xl font-bold">Локальная проверка удаления</h1>
    <label className="mt-4 block">Сценарий<select className="mt-2 block w-full rounded-lg border p-3" value={mode} onChange={(event) => setMode(event.target.value)}>
      <option value="enabled">Разрешено</option><option value="disabled">Отключено</option><option value="schema_not_ready">Без миграции</option>
      <option value="review_required">Связанные данные</option><option value="unauthorized">Без доступа</option><option value="lost">Ответ потерян</option><option value="conflict">Состав изменился</option>
    </select></label>
    <Example key={mode} mode={mode} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
