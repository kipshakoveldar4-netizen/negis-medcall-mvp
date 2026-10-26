import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { controlConfig, supabase } from "./lib/supabase";
import { subscribeControlActor } from "./lib/api";
import { Login } from "./screens/Login";
import { Overview } from "./screens/Overview";
import { ClinicCard } from "./screens/ClinicCard";
import { Onboarding } from "./screens/Onboarding";
import { Operators } from "./screens/Operators";
import { Contributors } from "./screens/Contributors";

// Medina Control — портал владельца платформы.
//
// В меню только то, что работает; пунктов-обещаний в этом продукте не вешают.
// Карточка клиники открывается из таблицы обзора, а не отдельным пунктом:
// список клиник уже есть на обзоре, и второй список рядом был бы его копией.

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [clinicId, setClinicId] = useState("");
  const [screen, setScreen] = useState<"overview" | "onboard" | "operators" | "contributors">("overview");
  const [actorEpoch, setActorEpoch] = useState(0);
  const actor = useRef("");
  const epoch = useRef(0);

  useEffect(() => {
    if (!controlConfig.ready) return;
    let disposed = false, observed = 0;
    const apply = (next: Session | null) => {
      if (disposed) return;
      const id = next?.user.id || "";
      if (id !== actor.current) {
        actor.current = id;
        epoch.current++;
        setActorEpoch(epoch.current);
        setClinicId("");
        setScreen("overview");
      }
      setSession(next);
      setReady(true);
    };
    const onSession = (next: Session | null) => {
      observed++;
      apply(next);
    };
    const unsubscribeActor = subscribeControlActor(onSession);
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => onSession(next));
    const initialObservation = observed;
    void supabase.auth.getSession().then(({ data, error }) => {
      if (observed === initialObservation) apply(error ? null : data.session);
    }, () => { if (observed === initialObservation) apply(null); });
    return () => { disposed = true; unsubscribeActor(); listener.subscription.unsubscribe(); };
  }, []);

  if (!controlConfig.ready) return <Login />;
  if (!ready) return <div className="login-form-side" role="status">Проверяем вход...</div>;
  if (!session) return <Login />;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Medina <span>Control</span></div>
        <div className="brand-sub">портал платформы</div>
        <button
          type="button"
          className={`nav-item ${!clinicId && screen === "overview" ? "on" : ""}`}
          onClick={() => {
            setClinicId("");
            setScreen("overview");
          }}
        >
          Обзор
        </button>
        <button
          type="button"
          className={`nav-item ${!clinicId && screen === "onboard" ? "on" : ""}`}
          onClick={() => {
            setClinicId("");
            setScreen("onboard");
          }}
        >
          Подключить клинику
        </button>
        <button type="button" className={`nav-item ${!clinicId && screen === "operators" ? "on" : ""}`} onClick={() => { setClinicId(""); setScreen("operators"); }}>Операторы</button>
        <button type="button" className={`nav-item ${!clinicId && screen === "contributors" ? "on" : ""}`} onClick={() => { setClinicId(""); setScreen("contributors"); }}>Блогеры</button>
        <div className="spacer" />
        <div className="who">{session.user.email}</div>
        <button type="button" className="signout" onClick={() => void supabase.auth.signOut()}>Выйти</button>
      </aside>
      <main className="main" key={actorEpoch}>
        {clinicId ? (
          <ClinicCard workspaceId={clinicId} onBack={() => setClinicId("")} />
        ) : screen === "contributors" ? (
          <Contributors />
        ) : screen === "operators" ? (
          <Operators />
        ) : screen === "onboard" ? (
          <Onboarding onDone={() => setScreen("overview")} />
        ) : (
          <Overview onOpenClinic={setClinicId} />
        )}
      </main>
    </div>
  );
}
