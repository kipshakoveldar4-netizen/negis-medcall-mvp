import { useState } from "react";
import { hasSupabaseEnv, supabase } from "../lib/supabase";

// Вход владельца платформы — обычный пароль Supabase.
//
// Экран нарочно ничего не обещает: право на портал решает сервер по списку в
// переменной окружения, и человек не из списка после входа увидит тот же
// отказ, что и не вошедший. Регистрации здесь нет и не будет.

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!hasSupabaseEnv) {
      setError("Портал не настроен: не заданы адрес и ключ Supabase.");
      return;
    }
    setBusy(true);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (authError) setError("Войти не удалось. Проверьте почту и пароль.");
      // Успех подхватит слушатель сессии в App — здесь делать нечего.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <aside className="login-brand">
        <div className="mark">Medina <span>Control</span></div>
        <p className="tagline">
          Портал платформы Medina OS: подключённые клиники и салоны, подписки и выручка,
          сигналы здоровья и рекомендации.
        </p>
        <div className="foot">Medina OS · внутренний инструмент платформы</div>
      </aside>
      <div className="login-form-side">
        <form className="login-card" onSubmit={(event) => void signIn(event)}>
          <h1>Вход в портал</h1>
          <p>Только для владельца платформы.</p>
          <div className="field">
            <label htmlFor="email">Почта</label>
            <input id="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Пароль</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          {error ? <div className="notice error" role="alert">{error}</div> : null}
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Проверяю…" : "Войти"}</button>
        </form>
      </div>
    </div>
  );
}
