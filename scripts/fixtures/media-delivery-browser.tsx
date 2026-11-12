import React from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { Toaster } from "sonner";
import ContentStudio from "../../artifacts/negis/src/pages/ContentStudio";
import { reportIds, reportsAuthFixture } from "./advertising-reports-browser-mocks";
import "../../artifacts/negis/src/index.css";

const jobKey = `negis_content_studio_video_job::${reportIds.W1}`;
const libraryKey = `negis_content_studio_videos::${reportIds.W1}`;
function Fixture() {
  const auth = React.useSyncExternalStore(reportsAuthFixture.subscribe, reportsAuthFixture.snapshot);
  const [epoch, setEpoch] = React.useState(0);
  const [trace, setTrace] = React.useState("");
  const [error, setError] = React.useState("");
  const pending = React.useRef(false);
  async function command(action: string) {
    if (pending.current) return;
    pending.current = true;
    try {
      const response = await fetch("/__fixture/media-delivery", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(`Fixture ${response.status}`);
      setTrace(JSON.stringify(await response.json(), null, 2));
      if (action === "reset") {
        localStorage.removeItem(jobKey);
        localStorage.removeItem(libraryKey);
        reportsAuthFixture.reset(); setEpoch(value => value + 1);
      } else if (["completed", "missing", "broken", "held"].includes(action)) {
        localStorage.setItem(jobKey, JSON.stringify({
          handle: "synthetic-local-video-handle", status: action === "completed" || action === "broken" ? "completed" : "queued",
          progress: action === "completed" || action === "broken" ? 100 : 0, formatSubstituted: false,
          ...(action === "completed" || action === "broken" ? {
            url: action === "broken" ? "/__fixture/missing.mp4" : "/__fixture/synthetic.mp4",
            fileName: "synthetic.mp4", mimeType: "video/mp4", fileSize: 0,
          } : {}),
        }));
        setEpoch(value => value + 1);
      }
      setError("");
    } catch (e) { setError(String(e)); }
    finally { pending.current = false; }
  }
  return <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
    <header className="border-b border-amber-300 bg-amber-50 p-3 text-xs" style={{ maxHeight: "40dvh", overflow: "auto", flexShrink: 0 }}>
      <strong>ТЕСТ: вымышленное видео и Telegram, только локальный HTTP, внешние отправки запрещены</strong>
      <div className="mt-2 flex flex-wrap gap-2">
        {["completed", "missing", "broken", "held", "available", "release", "telegram-off", "telegram-partial", "reset"].map(action =>
          <button key={action} className="neu-btn p-2" onClick={() => void command(action)}>{action}</button>)}
        <button className="neu-btn p-2" onClick={reportsAuthFixture.switchActor}>Аккаунт A/B</button>
        <button className="neu-btn p-2" onClick={reportsAuthFixture.switchABA}>SDK A-B-A</button>
        <button className="neu-btn p-2" onClick={() => void fetch("/__fixture/media-delivery").then(r => r.json()).then(v => setTrace(JSON.stringify(v, null, 2)))}>Состояние HTTP</button>
      </div>
      <p>ТЕСТ actor: {auth.actor}/{auth.sdkActor}</p>
      <details><summary>Журнал стенда</summary><pre aria-label="ТЕСТ: журнал" className="whitespace-pre-wrap break-words">{trace}</pre></details>
      {error && <p role="alert">{error}</p>}
    </header>
    <div style={{ minHeight: 0, flex: 1, overflow: "auto", transform: "translateZ(0)" }}>
      <ContentStudio key={epoch} />
    </div>
    <Toaster />
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Router><Fixture /></Router></React.StrictMode>);
