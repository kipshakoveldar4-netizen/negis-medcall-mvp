import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { Login } from "./screens/Login";
import { Overview } from "./screens/Overview";

// Medina Control — портал владельца платформы.
//
// В меню только то, что работает. Разделы «Сигналы» и «Рекомендации» появятся
// здесь, когда будут написаны, — пунктов-обещаний в этом продукте не вешают.

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

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
        <button type="button" className="nav-item on">Обзор</button>
        <div className="spacer" />
        <div className="who">{session.user.email}</div>
        <button type="button" className="signout" onClick={() => void supabase.auth.signOut()}>Выйти</button>
      </aside>
      <main className="main">
        <Overview />
      </main>
    </div>
  );
}
