import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { Login } from "./screens/Login";
import { Overview } from "./screens/Overview";
import { ClinicCard } from "./screens/ClinicCard";
import { Onboarding } from "./screens/Onboarding";

// Medina Control — портал владельца платформы.
//
// В меню только то, что работает; пунктов-обещаний в этом продукте не вешают.
// Карточка клиники открывается из таблицы обзора, а не отдельным пунктом:
// список клиник уже есть на обзоре, и второй список рядом был бы его копией.

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [clinicId, setClinicId] = useState("");
  const [screen, setScreen] = useState<"overview" | "onboard">("overview");

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  if (!ready) return null;
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
        <div className="spacer" />
        <div className="who">{session.user.email}</div>
        <button type="button" className="signout" onClick={() => void supabase.auth.signOut()}>Выйти</button>
      </aside>
      <main className="main">
        {clinicId ? (
          <ClinicCard workspaceId={clinicId} onBack={() => setClinicId("")} />
        ) : screen === "onboard" ? (
          <Onboarding onDone={() => setScreen("overview")} />
        ) : (
          <Overview onOpenClinic={setClinicId} />
        )}
      </main>
    </div>
  );
}
