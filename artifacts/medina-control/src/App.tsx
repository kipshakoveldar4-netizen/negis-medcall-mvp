import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { controlConfig, supabase } from "./lib/supabase";
import { subscribeControlActor } from "./lib/api";
import { Login } from "./screens/Login";
const Overview = lazy(() => import("./screens/Overview").then(module => ({ default: module.Overview })));
const ClinicCard = lazy(() => import("./screens/ClinicCard").then(module => ({ default: module.ClinicCard })));
const Onboarding = lazy(() => import("./screens/Onboarding").then(module => ({ default: module.Onboarding })));
const Operators = lazy(() => import("./screens/Operators").then(module => ({ default: module.Operators })));
const Contributors = lazy(() => import("./screens/Contributors").then(module => ({ default: module.Contributors })));
const PartnerCompanies = lazy(() => import("./screens/PartnerCompanies").then(module => ({ default: module.PartnerCompanies })));

class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <section className="notice error" role="alert">
      <h2>Не удалось загрузить раздел</h2>
      <button type="button" className="btn" onClick={() => window.location.reload()}>Обновить страницу</button>
    </section> : this.props.children;
  }
}

// Medina Control — портал владельца платформы.
//
// В меню только то, что работает; пунктов-обещаний в этом продукте не вешают.
// Карточка клиники открывается из таблицы обзора, а не отдельным пунктом:
// список клиник уже есть на обзоре, и второй список рядом был бы его копией.

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [clinicId, setClinicId] = useState("");
  const [screen, setScreen] = useState<"overview" | "onboard" | "operators" | "contributors" | "partner-companies">("overview");
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
        <button type="button" className={`nav-item ${!clinicId && screen === "partner-companies" ? "on" : ""}`} onClick={() => { setClinicId(""); setScreen("partner-companies"); }}>Заявки компаний</button>
        <div className="spacer" />
        <div className="who">{session.user.email}</div>
        <button type="button" className="signout" onClick={() => void supabase.auth.signOut()}>Выйти</button>
      </aside>
      <main className="main" key={actorEpoch}>
        {/* A new boundary removes the previous form even while another chunk is pending. */}
        <ScreenBoundary key={clinicId ? `clinic:${clinicId}` : screen}>
        <Suspense fallback={<p role="status" aria-live="polite">Загружаем раздел...</p>}>
        {clinicId ? (
          <ClinicCard workspaceId={clinicId} onBack={() => setClinicId("")} />
        ) : screen === "partner-companies" ? (
          <PartnerCompanies />
        ) : screen === "contributors" ? (
          <Contributors />
        ) : screen === "operators" ? (
          <Operators />
        ) : screen === "onboard" ? (
          <Onboarding onDone={() => setScreen("overview")} />
        ) : (
          <Overview onOpenClinic={setClinicId} />
        )}
        </Suspense>
        </ScreenBoundary>
      </main>
    </div>
  );
}
