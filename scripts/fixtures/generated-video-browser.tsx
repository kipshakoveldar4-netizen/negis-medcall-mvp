import React from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { Toaster } from "sonner";
import ContentStudio from "../../artifacts/negis/src/pages/ContentStudio";
import { generatedVideoStorageKey, serializeGeneratedVideoDraft } from "../../artifacts/negis/src/lib/generated-video-receipt";
import { reportIds, reportsAuthFixture } from "./advertising-reports-browser-mocks";
import "../../artifacts/negis/src/index.css";

const owner = { actorId: reportIds.A, workspaceId: reportIds.W1 };
const handle = `g2.synthetic-local-only.${"x".repeat(43)}`;
const jobId = "dddddddd-4444-4444-8444-444444444444";
const states = ["generation", "validation", "ready", "failed", "invalid", "held"];
const initial = new URL(location.href).searchParams.get("video") || "validation";
if (!states.includes(initial)) throw Error("Unknown local video state");
const savedFetch = window.fetch.bind(window);
let sceneEpoch = 0, settledSceneEpoch = -1;
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.origin);
  if (url.origin !== location.origin) return Promise.reject(Error("External fetch forbidden in generated video fixture"));
  return savedFetch(input, init);
};
document.addEventListener("click", event => {
  const anchor = (event.target as Element | null)?.closest("a");
  if (anchor && new URL(anchor.href, location.origin).origin !== location.origin) event.preventDefault();
}, true);
window.open = () => { throw Error("External navigation forbidden in generated video fixture"); };

function seed(state: string) {
  const draft = { handle, status: "in_progress" as const, progress: 0, formatSubstituted: false,
    phase: state === "generation" ? "generation" as const : "validation" as const,
    ...(state !== "generation" ? { validationJobId: jobId } : {}) };
  localStorage.setItem(generatedVideoStorageKey("negis_content_studio_video_job", owner), serializeGeneratedVideoDraft(draft, owner));
}
async function control(action?: string) {
  const response = await fetch("/__fixture/generated-video", action ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
  } : undefined);
  if (!response.ok) throw Error(`Fixture control refused (${response.status})`);
  return response.json();
}
function Fixture() {
  const auth = React.useSyncExternalStore(reportsAuthFixture.subscribe, reportsAuthFixture.snapshot);
  const [epoch, setEpoch] = React.useState(0), [trace, setTrace] = React.useState("");
  const [error, setError] = React.useState("");
  const pending = React.useRef(false);
  React.useEffect(() => {
    sceneEpoch = epoch;
    settledSceneEpoch = -1;
    const timer = setTimeout(() => {
      const heading = [...document.querySelectorAll("h1,h2,h3")].find(node => node.textContent === "Генерация изображения и видео");
      heading?.closest("section")?.scrollIntoView({ block: "start", behavior: "instant" });
      settledSceneEpoch = epoch;
    }, 250);
    return () => clearTimeout(timer);
  }, [epoch]);
  async function command(action?: string) {
    if (pending.current) return;
    pending.current = true;
    try {
      setTrace(JSON.stringify(await control(action), null, 2));
      if (action && states.includes(action)) { reportsAuthFixture.reset(); seed(action); setEpoch(value => value + 1); }
      if (action === "reset") { reportsAuthFixture.reset(); seed("validation"); setEpoch(value => value + 1); }
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Fixture failed"); }
    finally { pending.current = false; }
  }
  return <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
    <header className="border-b border-amber-300 bg-amber-50 p-2 text-xs" style={{ maxHeight: "32dvh", overflow: "auto", flexShrink: 0 }}>
      <strong>ТЕСТ G5-C56: вымышленное видео, внешний доступ и расходы запрещены</strong>
      <div className="mt-2 flex flex-wrap gap-2">
        {states.map(state => <button key={state} className="neu-btn px-2 py-1" onClick={() => void command(state)}>{state}</button>)}
        <button className="neu-btn px-2 py-1" onClick={() => void command("release")}>release</button>
        <button className="neu-btn px-2 py-1" onClick={reportsAuthFixture.switchActor}>Аккаунт A/B</button>
        <button className="neu-btn px-2 py-1" onClick={reportsAuthFixture.switchABA}>SDK A-B-A</button>
        <button className="neu-btn px-2 py-1" onClick={() => void command()}>Журнал</button>
      </div>
      <p className="mt-1">ТЕСТ: {auth.actor}/{auth.sdkActor}, {auth.role}; защищённые медиа перехватывает только локальный Service Worker.</p>
      <details><summary>Журнал локальных запросов</summary><pre className="whitespace-pre-wrap break-words" aria-label="ТЕСТ: журнал">{trace}</pre></details>
      {error && <p role="alert">{error}</p>}
    </header>
    <div style={{ minHeight: 0, flex: 1, overflow: "auto", transform: "translateZ(0)" }} data-testid="generated-video-scene">
      <ContentStudio key={epoch} />
    </div>
    <Toaster />
  </div>;
}

async function boot() {
  const workerPath = `${location.origin}/__fixture/generated-video-sw.js`;
  await navigator.serviceWorker.register(workerPath, { scope: "/content-studio", updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller?.scriptURL !== workerPath) await new Promise<void>(resolve => {
    const check = () => {
      if (navigator.serviceWorker.controller?.scriptURL === workerPath) { navigator.serviceWorker.removeEventListener("controllerchange", check); resolve(); }
    };
    navigator.serviceWorker.addEventListener("controllerchange", check); check();
  });
  await control(initial);
  reportsAuthFixture.reset(); seed(initial);
  createRoot(document.getElementById("root")!).render(<React.StrictMode><Router><Fixture /></Router></React.StrictMode>);
  Object.assign(window, { __appointmentRecovery: {
    view: { isCurrentMutationScope: () => Boolean(document.querySelector('[role="progressbar"]')) && settledSceneEpoch === sceneEpoch },
    layoutSettled: () => settledSceneEpoch === sceneEpoch,
    snapshot: () => ({ state: initial, ready: Boolean(document.querySelector("video")), sceneEpoch, settledSceneEpoch,
      progress: document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
      headings: [...document.querySelectorAll("h1,h2,h3")].map(n => n.textContent) }),
  } });
}
const timer = setTimeout(() => { document.getElementById("root")!.textContent = "Не удалось подготовить изолированный обработчик файлов. Внешние запросы не разрешены."; }, 15_000);
void boot().then(() => clearTimeout(timer)).catch(() => {
  clearTimeout(timer); document.getElementById("root")!.textContent = "Локальный стенд не запущен: обработчик файлов недоступен.";
});
