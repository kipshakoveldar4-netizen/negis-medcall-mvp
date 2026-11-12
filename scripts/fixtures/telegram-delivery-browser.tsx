import React from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { Toaster } from "sonner";
import { ArrowLeftRight, Pencil, Play, Repeat2, RotateCcw } from "../../artifacts/negis/node_modules/lucide-react";
import ContentStudio from "../../artifacts/negis/src/pages/ContentStudio";
import { reportIds, reportsAuthFixture } from "./advertising-reports-browser-mocks";
import "../../artifacts/negis/src/index.css";

type Action = "success" | "hold-headers" | "hold-body" | "partial" | "release" | "reset" | "edit-A";
type Snapshot = { mode: string; pending: unknown[]; received: unknown[]; completed: number; aborted: number;
  statusWrites: number; externalCalls: number; closed: boolean };
const modes = ["success", "hold-headers", "hold-body", "partial"] as const;

async function control(action?: Action, signal?: AbortSignal): Promise<Snapshot> {
  const response = await fetch("/__fixture/telegram-delivery", {
    signal, cache: "no-store", ...(action ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
    } : {}),
  });
  if (!response.ok) throw new Error(`TEST fixture control: HTTP ${response.status}`);
  return response.json();
}

function clearFixtureStorage() {
  for (const name of ["negis_content_studio_videos", "negis_content_studio_video_job"]) {
    window.localStorage.removeItem(`${name}::${reportIds.W1}`);
  }
  const prefix = "negis_telegram_delivery_v1::";
  const videoIds: Record<string, string> = {
    [reportIds.A]: "a7000000-1111-4111-8111-111111111111",
    [reportIds.B]: "b7000000-2222-4222-8222-222222222222",
  };
  const keys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index));
  for (const key of keys) {
    if (!key?.startsWith(prefix)) continue;
    try {
      const scope: unknown = JSON.parse(key.slice(prefix.length));
      if (Array.isArray(scope) && scope.length === 4 && scope.every((part) => typeof part === "string")
        && Object.hasOwn(videoIds, scope[0]) && scope[1] === reportIds.W1 && scope[2] === videoIds[scope[0]]
        && /^[a-f0-9]{64}$/.test(scope[3])) window.localStorage.removeItem(key);
    } catch { /* Malformed or foreign receipts are not owned by this fixture. */ }
  }
}

function Fixture() {
  const auth = React.useSyncExternalStore(reportsAuthFixture.subscribe, reportsAuthFixture.snapshot);
  const [server, setServer] = React.useState<Snapshot | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [pageEpoch, setPageEpoch] = React.useState(0);
  const actionPending = React.useRef(false);
  React.useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const value = await control(undefined, controller.signal); if (!controller.signal.aborted) setServer(value); }
      catch (cause) { if (!controller.signal.aborted) setError(String(cause)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 300);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  async function act(action: Action) {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true); setError("");
    if (action === "reset") setResetting(true);
    try {
      const value = await control(action);
      if (action === "reset") {
        clearFixtureStorage(); reportsAuthFixture.reset(); setPageEpoch((value) => value + 1);
      }
      setServer(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "TEST fixture failed"); }
    finally { actionPending.current = false; setBusy(false); setResetting(false); }
  }

  return <div data-testid="telegram-delivery-fixture" style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
    <header className="border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-slate-950" style={{ flexShrink: 0, maxHeight: "40dvh", overflow: "auto" }}>
      <strong>{"\u0422\u041e\u041b\u042c\u041a\u041e \u0422\u0415\u0421\u0422: Telegram HTTP, \u0432\u044b\u043c\u044b\u0448\u043b\u0435\u043d\u043d\u044b\u0435 A/B, W1"}</strong>
      <p>{"\u0411\u0435\u0437 \u0432\u043d\u0435\u0448\u043d\u0438\u0445 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0439, \u043f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440\u043e\u0432 \u0438 \u0440\u0435\u0430\u043b\u044c\u043d\u044b\u0445 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0439. sent=true \u2014 \u0441\u0438\u043d\u0442\u0435\u0442\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u043e\u0442\u0432\u0435\u0442."}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">TEST mode
          <select aria-label="TEST delivery mode" value={server?.mode ?? "success"} disabled={busy}
            onChange={(event) => void act(event.target.value as Action)}>
            {modes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </label>
        <button type="button" className="neu-btn" disabled={busy} onClick={() => void act("release")}><Play size={14} />Release</button>
        <button type="button" className="neu-btn" disabled={busy} onClick={() => void act("reset")}><RotateCcw size={14} />Reset</button>
        <button type="button" className="neu-btn" disabled={busy} onClick={() => void act("edit-A")}><Pencil size={14} />Edit A</button>
        <button type="button" className="neu-btn" disabled={busy} onClick={reportsAuthFixture.switchActor}><ArrowLeftRight size={14} />Actor A/B</button>
        <button type="button" className="neu-btn" disabled={busy} onClick={reportsAuthFixture.switchABA}><Repeat2 size={14} />SDK A-B-A</button>
      </div>
      <p className="mt-1" data-testid="telegram-delivery-actor">TEST: {auth.actor}/{auth.sdkActor}, W1; mode {server?.mode ?? "-"}; pending {server?.pending.length ?? "-"}; externalCalls {server?.externalCalls ?? "-"}</p>
      <details className="mt-1"><summary>TEST HTTP snapshot</summary>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words" aria-label="TEST Telegram HTTP snapshot">{JSON.stringify({ auth, server }, null, 2)}</pre>
      </details>
      {error && <p role="alert">{error}</p>}
    </header>
    <div data-testid="telegram-delivery-scene" style={{ minHeight: 0, flex: 1, overflow: "auto", transform: "translateZ(0)" }}>
      {!resetting && <ContentStudio key={pageEpoch} />}
    </div>
    <Toaster />
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><Router><Fixture /></Router></React.StrictMode>);
