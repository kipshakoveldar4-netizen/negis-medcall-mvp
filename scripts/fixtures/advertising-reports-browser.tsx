import React from "react";
import { createRoot } from "react-dom/client";
import { Link, Router, useLocation } from "wouter";
import { Toaster } from "sonner";
import { ArrowLeftRight, Repeat2, RefreshCw, Pause, Play } from "../../artifacts/negis/node_modules/lucide-react";
import AdvertisingHub from "../../artifacts/negis/src/pages/AdvertisingHub";
import AdsAutomation from "../../artifacts/negis/src/pages/AdsAutomation";
import ContentStudio from "../../artifacts/negis/src/pages/ContentStudio";
import { reportsAuthFixture } from "./advertising-reports-browser-mocks";
import "../../artifacts/negis/src/index.css";

async function control(command?: Record<string, unknown>) {
  const response = await fetch("/__fixture/ads-reports", command ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
  } : undefined);
  if (!response.ok) throw new Error(`Fixture control ${response.status}`);
  return response.json();
}
function Fixture() {
  const auth = React.useSyncExternalStore(reportsAuthFixture.subscribe, reportsAuthFixture.snapshot);
  const [location] = useLocation();
  const [server, setServer] = React.useState<Record<string, unknown> | null>(null);
  const [error, setError] = React.useState("");
  const [resource, setResource] = React.useState(location === "/content-studio" ? "content-usage" : "meta-insights-history");
  const [phase, setPhase] = React.useState("body");
  const [status, setStatus] = React.useState(200);
  const [malformed, setMalformed] = React.useState(false);
  const [shape, setShape] = React.useState("valid");
  const [nextRevision, setNextRevision] = React.useState(2);
  const [pageEpoch, setPageEpoch] = React.useState(0);
  const pendingAction = React.useRef(false);
  React.useEffect(() => {
    let alive = true;
    const refresh = () => { void control().then(value => { if (alive) setServer(value); }).catch(e => { if (alive) setError(String(e)); }); };
    refresh(); const interval = setInterval(refresh, 300);
    return () => { alive = false; clearInterval(interval); };
  }, []);
  async function act(command: Record<string, unknown>, after?: () => void) {
    if (pendingAction.current) return;
    pendingAction.current = true;
    setError("");
    try { const value = await control(command); after?.(); setServer(value); }
    catch (e) { setError(e instanceof Error ? e.message : "Fixture failed"); }
    finally { pendingAction.current = false; }
  }
  return <div className="min-w-0" style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }} data-testid="ads-reports-fixture">
    <header className="border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-slate-950" style={{ flexShrink: 0, maxHeight: "44dvh", overflow: "auto" }}>
      <strong>ТЕСТ G5: вымышленные отчёты, настоящий локальный HTTP, без внешних подключений</strong>
      <div className="mt-2 flex flex-wrap gap-2">
        <Link className="neu-btn" href="/ads?reports=concurrency">Обзор</Link>
        <Link className="neu-btn" href="/ads-automation/history?reports=concurrency">История</Link>
        <Link className="neu-btn" href="/content-studio?reports=concurrency">Лимиты</Link>
        <button className="neu-btn" onClick={() => void act({ command: "reset" }, () => { reportsAuthFixture.reset(); setPageEpoch(value => value + 1); })}>Сбросить стенд</button>
        <button className="neu-btn" onClick={reportsAuthFixture.switchActor}><ArrowLeftRight size={14} />Аккаунт A/B</button>
        <button className="neu-btn" onClick={reportsAuthFixture.switchSdkOnly}>Только SDK A/B</button>
        <button className="neu-btn" onClick={reportsAuthFixture.acceptSdk}>Принять SDK</button>
        <button className="neu-btn" onClick={reportsAuthFixture.switchABA}><Repeat2 size={14} />SDK A-B-A</button>
        <button className="neu-btn" onClick={reportsAuthFixture.refresh}><RefreshCw size={14} />TOKEN_REFRESHED</button>
        <label>Роль <select aria-label="ТЕСТ: роль" value={auth.role} onChange={event => {
          const role = event.target.value as "owner" | "admin" | "lead_manager";
          void act({ command: "actorRole", actor: auth.actor, role }, () => reportsAuthFixture.role(role));
        }}><option value="owner">owner</option><option value="admin">admin</option><option value="lead_manager">lead_manager</option></select></label>
        <button className="neu-btn" onClick={() => {
          const workspace = auth.workspace === "W1" ? "W2" : "W1";
          void act({ command: "actorWorkspace", actor: auth.actor, workspace }, () => reportsAuthFixture.workspace(workspace));
        }}>Пространство W1/W2</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label>Запрос <select aria-label="ТЕСТ: ресурс" value={resource} onChange={e => setResource(e.target.value)}>
          {['meta-insights-history','advertising-outcomes','auth-context','meta-launches','content-usage'].map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label>Фаза <select aria-label="ТЕСТ: фаза" value={phase} onChange={e => setPhase(e.target.value)}><option value="body">Тело ответа</option><option value="headers">До заголовков</option></select></label>
        <label>Ответ <select aria-label="ТЕСТ: код ответа" value={status} onChange={e => setStatus(Number(e.target.value))}>{[200,401,403,500].map(v => <option key={v}>{v}</option>)}</select></label>
        <label><input type="checkbox" checked={malformed} onChange={e => setMalformed(e.target.checked)} />Повреждённый JSON</label>
        <label>Данные <select aria-label="ТЕСТ: форма ответа" value={shape} onChange={e => setShape(e.target.value)}>
          <option value="valid">Корректные</option><option value="null-spend">Нет списка валют</option>
          <option value="object-summaries">Объект вместо списка</option><option value="foreign-auth">Чужое пространство</option><option value="contradictory-role">Противоречивая роль</option>
        </select></label>
        <button className="neu-btn" onClick={() => void act({ command: "arm", resource, phase, status, malformed, shape })}><Pause size={14} />Удержать следующий</button>
        <button className="neu-btn" onClick={() => void act({ command: "release" })}><Play size={14} />Отпустить старый</button>
        <label>Версия <input className="w-14" type="number" min="1" max="100" aria-label="ТЕСТ: версия" value={nextRevision} onChange={e => setNextRevision(Number(e.target.value))} /></label>
        <button className="neu-btn" onClick={() => void act({ command: "revision", value: nextRevision })}>Применить версию</button>
      </div>
      <details className="mt-2"><summary>ТЕСТ: состояние HTTP</summary><pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words" aria-label="ТЕСТ: состояние HTTP">{JSON.stringify({ auth, server }, null, 2)}</pre></details>
      <p data-testid="ads-report-actor" className="mt-1">ТЕСТ: {auth.actor}/{auth.sdkActor}, {auth.role}, {auth.workspace}; версия {String(server?.revision ?? "-")}; ожидают {Array.isArray(server?.pending) ? server.pending.length : "-"}</p>
      {error && <p role="alert">{error}</p>}
    </header>
    <div style={{ minHeight: 0, flex: 1, overflow: "auto", transform: "translateZ(0)" }} data-testid="ads-report-scene">
      {location === "/ads" ? <AdvertisingHub key={pageEpoch} /> : location === "/content-studio" ? <ContentStudio key={pageEpoch} /> : <AdsAutomation key={pageEpoch} />}
    </div>
    <Toaster />
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Router><Fixture /></Router></React.StrictMode>);
