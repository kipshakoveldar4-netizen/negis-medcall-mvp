import React, { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ids, supabase, switchActor } from "./creator-jobs-browser-mocks";
import { CreatorJobs } from "../../artifacts/negis/src/components/contributors/CreatorJobs";
import ContributorPortal from "../../artifacts/negis/src/pages/ContributorPortal";
import "../../artifacts/negis/src/index.css";
function Company() {
  const [session, setSession] = useState<{ id: string; epoch: number } | null>(null), live = useRef(session), epoch = useRef(0);
  useLayoutEffect(() => {
    let alive = true, observed = false;
    const apply = (next: any) => { if (!alive) return; live.current = next ? { id: next.user.id, epoch: ++epoch.current } : null; setSession(live.current); };
    void supabase.auth.getSession().then(({ data }) => { if (!observed) apply(data.session); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => { observed = true; apply(next); });
    return () => { alive = false; live.current = null; data.subscription.unsubscribe(); };
  }, []);
  return <main className="mx-auto min-h-screen max-w-5xl space-y-6 px-4 py-8"><h1 className="text-2xl font-semibold">Тестовая компания Medina</h1>
    {session?.id === ids.owner ? <CreatorJobs key={session.epoch} actorId={session.id} workspaceId={ids.workspace} isSessionCurrent={() => live.current === session}/>
      : <p>Нет доступа к компании</p>}</main>;
}
function Harness() {
  const [view, setView] = useState(window.location.pathname === "/company" ? "company" : "creator"), [revision, setRevision] = useState(0);
  const choose = (mode: string, actor = mode === "company" ? ids.owner : ids.a) => { switchActor(actor); setView(mode); };
  useLayoutEffect(() => { Object.assign((window as any).__creatorQA, { view: (value: string) => { switchActor(value === "company" ? ids.owner : ids.a); setView(value); },
    remount: () => setRevision(n => n + 1) }); }, []);
  return <>{new URLSearchParams(window.location.search).get("demo") === "1" && <aside className="mx-auto max-w-5xl space-y-3 px-4 py-4"><p className="text-sm text-muted-foreground">Тестовый стенд · вымышленные данные</p><div role="group" aria-label="Тестовые роли" className="flex flex-wrap gap-2"><button className="neu-btn" type="button" onClick={() => choose("company")}>Компания</button><button className="neu-btn" type="button" onClick={() => choose("creator")}>Автор А</button><button className="neu-btn" type="button" onClick={() => choose("creator", ids.b)}>Автор Б</button></div></aside>}
    {view === "company" ? <Company key={`company:${revision}`}/> : <ContributorPortal key={`creator:${revision}`}/>}</>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness/></StrictMode>);
