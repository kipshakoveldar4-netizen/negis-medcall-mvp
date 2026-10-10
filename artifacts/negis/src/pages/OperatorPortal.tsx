import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { LogOut, RefreshCw, Send } from "lucide-react";
import { supabase, hasSupabaseFrontendEnv } from "@/lib/supabase";
import { operatorApi } from "@/lib/operatorApi";
import { OperatorRequests } from "@/components/operators/OperatorRequests";
import {
  operatorStatusLabels,
  type OperatorProfile,
} from "../../../../lib/crm/operator-contracts";
import { validatePasswordRules } from "../../../../lib/auth/password-rules";
import {
  isSyntheticEmail,
  loginOrEmailToAuthEmail,
} from "../../../../lib/auth/staff-logins";

export default function OperatorPortal() {
  const [userId, setUserId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const currentUserId = useRef<string | null>(null);
  const profileEpoch = useRef(0);
  const refreshProfile = useCallback(() => {
    if (!userId || currentUserId.current !== userId) return;
    profileEpoch.current += 1;
    // The profile controls access to every clinic below. Hide the old account
    // state before asking the server whether approval is still active.
    setProfile(null);
    setLoaded(false);
    setBusy(false);
    setMessage("");
    setRevision((value) => value + 1);
  }, [userId]);
  useEffect(() => {
    let alive = true;
    let authEventSeen = false;
    const updateSession = (id: string | null) => {
      if (currentUserId.current !== id) {
        currentUserId.current = id;
        profileEpoch.current += 1;
        setProfile(null);
        setLoaded(false);
        setBusy(false);
        setMessage("");
      }
      setUserId(id);
      setReady(true);
    };
    void supabase.auth.getSession().then(({ data }) => {
      if (alive && !authEventSeen) {
        updateSession(data.session?.user.id ?? null);
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventSeen = true;
      if (alive) updateSession(session?.user.id ?? null);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    setProfile(null);
    setLoaded(false);
    setMessage("");
    if (!userId) return;
    const controller = new AbortController();
    const startedAtEpoch = profileEpoch.current;
    const isCurrent = () =>
      !controller.signal.aborted &&
      currentUserId.current === userId &&
      profileEpoch.current === startedAtEpoch;
    void operatorApi<OperatorProfile | null>(
      "operator-account",
      undefined,
      "GET",
      controller.signal,
    )
      .then((value) => {
        if (isCurrent()) {
          setProfile(value);
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (isCurrent())
          setMessage(
            error instanceof Error
              ? error.message
              : "Не удалось загрузить профиль",
          );
      });
    return () => controller.abort();
  }, [userId, revision]);
  useEffect(() => {
    if (!userId) return;
    let lastRevalidation = 0;
    const revalidateProfile = () => {
      const now = Date.now();
      if (now - lastRevalidation < 250) return;
      lastRevalidation = now;
      refreshProfile();
    };
    const revalidateVisibleTab = () => {
      if (document.visibilityState === "visible") revalidateProfile();
    };
    window.addEventListener("focus", revalidateProfile);
    document.addEventListener("visibilitychange", revalidateVisibleTab);
    return () => {
      window.removeEventListener("focus", revalidateProfile);
      document.removeEventListener("visibilitychange", revalidateVisibleTab);
    };
  }, [userId, refreshProfile]);
  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    if (!hasSupabaseFrontendEnv) {
      setMessage(
        "Вход операторов ещё не настроен. Обратитесь к владельцу платформы.",
      );
      return;
    }
    if (mode === "signup") {
      if (isSyntheticEmail(email) || !email.includes("@")) {
        setMessage("Для регистрации укажите личную почту.");
        return;
      }
      const errors = validatePasswordRules(password);
      if (errors.length) {
        setMessage(errors[0]);
        return;
      }
    }
    setBusy(true);
    try {
      const result =
        mode === "signup"
          ? await supabase.auth.signUp({
              email: email.trim().toLowerCase(),
              password,
              options: {
                emailRedirectTo: `${window.location.origin}/operator`,
              },
            })
          : await supabase.auth.signInWithPassword({
              email: loginOrEmailToAuthEmail(email),
              password,
            });
      setPassword("");
      if (result.error) {
        setMessage(
          "Не удалось войти. Проверьте почту, пароль и подтверждение почты.",
        );
        return;
      }
      if (!result.data.session)
        setMessage(
          "Подтвердите почту по ссылке из письма и вернитесь в кабинет оператора.",
        );
    } catch {
      setMessage("Нет связи с сервером. Попробуйте позже.");
    } finally {
      setBusy(false);
    }
  }
  async function save(body: unknown, method = "POST") {
    if (!userId || currentUserId.current !== userId) return;
    // A focus refresh or account change invalidates even a successful old PATCH.
    const startedAtEpoch = ++profileEpoch.current;
    const isCurrent = () =>
      currentUserId.current === userId &&
      profileEpoch.current === startedAtEpoch;
    setBusy(true);
    setMessage("");
    try {
      const saved = await operatorApi<OperatorProfile>("operator-account", body, method);
      if (!isCurrent()) return;
      setProfile(saved);
      setLoaded(true);
    } catch (err) {
      if (!isCurrent()) return;
      setProfile(null);
      setLoaded(false);
      setMessage(
        err instanceof Error ? err.message : "Не удалось сохранить профиль",
      );
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  return (
    <main
      className="min-h-screen px-4 py-8"
      style={{ background: "var(--negis-bg)", color: "var(--negis-text)" }}
    >
      <div className="mx-auto max-w-2xl min-w-0 space-y-6">
        <header className="flex flex-wrap justify-between gap-3">
          <div>
            <Link href="/" className="text-sm font-medium">
              Medina OS
            </Link>
            <h1 className="mt-2 text-2xl font-semibold">Кабинет оператора</h1>
          </div>
          {userId && (
            <button
              type="button"
              className="neu-btn self-start"
              onClick={() => void supabase.auth.signOut()}
            >
              <LogOut size={16} />
              Выйти
            </button>
          )}
        </header>
        {!ready && <p role="status">Проверяем вход…</p>}
        {ready && !userId && (
          <form className="space-y-4" onSubmit={authenticate}>
            <div
              className="flex gap-4"
              role="tablist"
              aria-label="Вход оператора"
            >
              {(["signin", "signup"] as const).map((value) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  key={value}
                  className={`border-b-2 py-2 ${mode === value ? "border-teal-600 font-semibold" : "border-transparent"}`}
                  onClick={() => setMode(value)}
                >
                  {value === "signin" ? "Войти" : "Регистрация"}
                </button>
              ))}
            </div>
            <label className="block text-sm">
              {mode === "signin" ? "Логин или почта" : "Почта"}
              <input
                className="neu-input mt-1 w-full"
                required
                autoComplete="username"
                type={mode === "signin" ? "text" : "email"}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Пароль
              <input
                className="neu-input mt-1 w-full"
                required
                type="password"
                autoComplete={
                  mode === "signin" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="neu-btn-primary" disabled={busy} type="submit">
              {busy
                ? "Проверяем…"
                : mode === "signin"
                  ? "Войти"
                  : "Зарегистрироваться"}
            </button>
          </form>
        )}
        {userId && !loaded && !message && (
          <p role="status">Загружаем профиль…</p>
        )}
        {message && (
          <p role="status" className="break-words text-sm">
            {message}
          </p>
        )}
        {userId && (
          <button
            type="button"
            className="neu-btn"
            disabled={busy}
            onClick={refreshProfile}
          >
            <RefreshCw size={16} />
            Обновить статус
          </button>
        )}
        {userId && loaded && !profile && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save({ displayName: name });
            }}
          >
            <p className="text-sm opacity-70">
              Перед получением предложений заявку рассматривает владелец
              платформы.
            </p>
            <label className="block text-sm">
              Ваше имя
              <input
                required
                maxLength={120}
                className="neu-input mt-1 w-full"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button type="submit" className="neu-btn-primary" disabled={busy}>
              <Send size={16} />
              Подать заявку оператором
            </button>
          </form>
        )}
        {userId && profile && (
          <section className="space-y-3 border-y py-4">
            <h2 className="font-semibold break-words">{profile.displayName}</h2>
            <p>{operatorStatusLabels[profile.status]}</p>
            {profile.status === "approved" && (
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={profile.acceptingRequests}
                  disabled={busy}
                  onChange={(event) =>
                    void save(
                      { acceptingRequests: event.target.checked },
                      "PATCH",
                    )
                  }
                />
                Принимаю предложения клиник
              </label>
            )}
            {profile.status === "suspended" && (
              <p className="text-sm">
                Для возобновления работы обратитесь к владельцу платформы.
              </p>
            )}
          </section>
        )}
        {userId && profile?.status === "approved" && (
          <>
            <p className="text-sm opacity-70">
              Оплата согласуется с клиникой напрямую. Подтверждение
              сотрудничества открывает только согласованный список заявок.
              Медицинская история и реклама недоступны.
            </p>
            <OperatorRequests
              key={`${userId}:${revision}`}
              actorId={userId}
            />
          </>
        )}
        <footer className="flex gap-4 text-sm opacity-70">
          <Link href="/privacy">Конфиденциальность</Link>
          <Link href="/terms">Условия</Link>
        </footer>
      </div>
    </main>
  );
}
