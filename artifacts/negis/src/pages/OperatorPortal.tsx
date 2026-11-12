import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ClipboardList, FileText, RefreshCw, Send, UserRound, Users } from "lucide-react";
import { PortalShell } from "@/components/portals/PortalShell";
import { useAuth } from "@/contexts/AuthContext";
import { supabase, sessionAuth, hasSupabaseFrontendEnv } from "@/lib/supabase";
import { operatorApi } from "@/lib/operatorApi";
import { OperatorRequests } from "@/components/operators/OperatorRequests";
import { OperatorWorkday } from "@/components/operators/OperatorWorkday";
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
  const { signOut } = useAuth();
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
  const [section, setSection] = useState("work");
  const mounted = useRef(false);
  const mountEpoch = useRef(0);
  const authEpoch = useRef(0);
  const formEpoch = useRef(0);
  const currentMode = useRef(mode);
  const submitting = useRef(false);
  const exiting = useRef(false);
  const currentUserId = useRef<string | null>(null);
  const profileEpoch = useRef(0);
  const profileRead = useRef<AbortController | null>(null);
  const profileMutation = useRef<AbortController | null>(null);
  const renderedMountEpoch = mountEpoch.current;
  const renderedAuthEpoch = authEpoch.current;
  const renderedFormEpoch = formEpoch.current;
  const isAuthSessionCurrent = useCallback(() =>
    mounted.current && !exiting.current &&
    mountEpoch.current === renderedMountEpoch &&
    authEpoch.current === renderedAuthEpoch &&
    currentUserId.current === userId,
  [userId, renderedMountEpoch, renderedAuthEpoch]);
  const retirePrivateState = useCallback(() => {
    profileRead.current?.abort();
    profileRead.current = null;
    profileMutation.current?.abort();
    profileMutation.current = null;
    profileEpoch.current += 1;
    formEpoch.current += 1;
    submitting.current = false;
    currentMode.current = "signin";
    setMode("signin");
    setEmail("");
    setPassword("");
    setName("");
    // Batched A -> B -> A events still require a new authoritative read.
    setRevision((value) => value + 1);
    setProfile(null);
    setLoaded(false);
    setBusy(false);
    setMessage("");
    setSection("work");
  }, []);
  const refreshProfile = useCallback(() => {
    if (!userId || !isAuthSessionCurrent()) return;
    profileEpoch.current += 1;
    // The profile controls access to every clinic below. Hide the old account
    // state before asking the server whether approval is still active.
    setProfile(null);
    setLoaded(false);
    setBusy(Boolean(profileMutation.current));
    setMessage("");
    setRevision((value) => value + 1);
  }, [userId, isAuthSessionCurrent]);
  useLayoutEffect(() => {
    mounted.current = true;
    // Effect replay can retain userId/ready. Publish fresh lifetime guards
    // even when the next session snapshot has the same subject.
    if (mountEpoch.current > 0) retirePrivateState();
    const startedAtMount = mountEpoch.current;
    const startedAtAuthEpoch = authEpoch.current;
    const isMounted = () => mounted.current && !exiting.current &&
      mountEpoch.current === startedAtMount;
    let authEventSeen = false;
    const updateSession = (id: string | null, newAuthEpoch = false) => {
      if (!isMounted()) return;
      if (currentUserId.current !== id || newAuthEpoch) {
        authEpoch.current += 1;
        currentUserId.current = id;
        retirePrivateState();
      }
      setUserId(id);
      setReady(true);
    };
    const { data } = sessionAuth.onAuthStateChange((event, session) => {
      if (!isMounted()) return;
      authEventSeen = true;
      updateSession(session?.user.id ?? null, event === "SIGNED_IN" || event === "SIGNED_OUT");
    });
    const canApplySnapshot = () => isMounted() && !authEventSeen &&
      authEpoch.current === startedAtAuthEpoch;
    void Promise.resolve().then(() => supabase.auth.getSession()).then(({ data, error }) => {
      if (canApplySnapshot()) updateSession(error ? null : data.session?.user.id ?? null);
    }).catch(() => {
      if (canApplySnapshot()) updateSession(null);
    });
    return () => {
      mounted.current = false;
      mountEpoch.current += 1;
      authEpoch.current += 1;
      formEpoch.current += 1;
      profileEpoch.current += 1;
      submitting.current = false;
      profileRead.current?.abort();
      profileRead.current = null;
      profileMutation.current?.abort();
      profileMutation.current = null;
      data.subscription.unsubscribe();
    };
  }, [retirePrivateState]);
  useEffect(() => {
    if (!isAuthSessionCurrent()) return;
    setProfile(null);
    setLoaded(false);
    setMessage("");
    if (!userId) return;
    const controller = new AbortController();
    profileRead.current = controller;
    const startedAtEpoch = profileEpoch.current;
    const isCurrent = () =>
      !controller.signal.aborted &&
      isAuthSessionCurrent() &&
      profileEpoch.current === startedAtEpoch;
    void operatorApi<OperatorProfile | null>(
      "operator-account",
      undefined,
      "GET",
      controller.signal,
      userId,
      isCurrent,
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
    return () => {
      controller.abort();
      if (profileRead.current === controller) profileRead.current = null;
    };
  }, [userId, revision, isAuthSessionCurrent]);
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
  function isAuthFormCurrent() {
    return ready && userId === null && isAuthSessionCurrent() &&
      formEpoch.current === renderedFormEpoch && currentMode.current === mode;
  }
  function changeAuthMode(value: typeof mode) {
    if (submitting.current || !isAuthFormCurrent() || currentMode.current === value) return;
    formEpoch.current += 1;
    currentMode.current = value;
    setMode(value);
    setPassword("");
    setBusy(false);
    setMessage("");
  }
  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    if (!isAuthFormCurrent() || submitting.current) return;
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
    submitting.current = true;
    const submittedPassword = password;
    const isCurrent = isAuthFormCurrent;
    setPassword("");
    setBusy(true);
    try {
      const result =
        mode === "signup"
          ? await sessionAuth.signUp({
              email: email.trim().toLowerCase(),
              password: submittedPassword,
              options: {
                emailRedirectTo: `${window.location.origin}/operator`,
              },
            }, { isCurrent, expectedUserId: null })
          : await sessionAuth.signInWithPassword({
              email: loginOrEmailToAuthEmail(email),
              password: submittedPassword,
            }, { isCurrent, expectedUserId: null });
      if (!isCurrent()) return;
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
      if (isCurrent()) setMessage("Нет связи с сервером. Попробуйте позже.");
    } finally {
      if (isCurrent()) {
        formEpoch.current += 1;
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  async function save(body: unknown, method = "POST") {
    if (!userId || !isAuthSessionCurrent() || profileMutation.current) return;
    const controller = new AbortController();
    profileMutation.current = controller;
    // A focus refresh or account change invalidates even a successful old PATCH.
    const startedAtEpoch = ++profileEpoch.current;
    const isCurrent = () =>
      !controller.signal.aborted &&
      isAuthSessionCurrent() &&
      profileEpoch.current === startedAtEpoch;
    setBusy(true);
    setMessage("");
    try {
      const saved = await operatorApi<OperatorProfile>(
        "operator-account", body, method, controller.signal, userId, isCurrent,
      );
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
      if (profileMutation.current === controller) {
        profileMutation.current = null;
        if (!controller.signal.aborted && isAuthSessionCurrent()) {
          if (isCurrent()) setBusy(false);
          // A focus GET may have read the pre-write profile. Reconcile after
          // the write settles without publishing its obsolete approval state.
          else refreshProfile();
        }
      }
    }
  }
  function handleSignOut() {
    if (!userId || !isAuthSessionCurrent()) return;
    exiting.current = true;
    authEpoch.current += 1;
    currentUserId.current = null;
    retirePrivateState();
    setUserId(null);
    setReady(false);
    void signOut().catch(() => {});
  }
  const renderedProfileEpoch = profileEpoch.current;
  const isProfileSessionCurrent = () => isAuthSessionCurrent()
    && profileEpoch.current === renderedProfileEpoch;
  return (
    <PortalShell homeHref="/operator" title={section === "profile" ? "Мой профиль" : section === "terms" ? "Условия работы" : "Мой рабочий день"}
      roleLabel="Кабинет оператора" displayName={profile?.displayName}
      activeId={section} onNavigate={setSection} onSignOut={userId ? handleSignOut : undefined}
      actions={userId ? <button type="button" className="neu-btn" disabled={busy}
        title={section === "work" ? "Обновить рабочий день" : "Обновить статус профиля"}
        aria-label={section === "work" ? "Обновить рабочий день" : "Обновить статус профиля"} onClick={refreshProfile}>
        <RefreshCw size={18} aria-hidden="true" />
      </button> : undefined}
      items={[
        { id: "work", label: "Мои заявки", icon: ClipboardList },
        { id: "cooperations", label: "Сотрудничество", icon: Users },
        { id: "profile", label: "Профиль", icon: UserRound },
        { id: "terms", label: "Условия", icon: FileText },
        { id: "contributors", label: "Блогерам и партнёрам", icon: Users, href: "/contributors" },
      ]}>
      <div className={`portal-view min-w-0 space-y-6 ${!userId || !profile ? "portal-form-layout" : ""}`} key={section}>
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
                  disabled={busy}
                  aria-selected={mode === value}
                  key={value}
                  className={`border-b-2 py-2 ${mode === value ? "border-teal-600 font-semibold" : "border-transparent"}`}
                  onClick={() => changeAuthMode(value)}
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
                disabled={busy}
                autoComplete="username"
                type={mode === "signin" ? "text" : "email"}
                value={email}
                onChange={(event) => {
                  if (!submitting.current && isAuthFormCurrent()) setEmail(event.target.value);
                }}
              />
            </label>
            <label className="block text-sm">
              Пароль
              <input
                className="neu-input mt-1 w-full"
                required
                disabled={busy}
                type="password"
                autoComplete={
                  mode === "signin" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(event) => {
                  if (!submitting.current && isAuthFormCurrent()) setPassword(event.target.value);
                }}
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
                onChange={(event) => {
                  if (isAuthSessionCurrent()) setName(event.target.value);
                }}
              />
            </label>
            <button type="submit" className="neu-btn-primary" disabled={busy}>
              <Send size={16} />
              Подать заявку оператором
            </button>
          </form>
        )}
        {userId && profile && (section === "profile" || profile.status !== "approved") && section !== "terms" && (
          <section className="portal-profile-summary">
            <div><h2 className="font-medium break-words">{profile.displayName}</h2>
            <p className="portal-status mt-2">{operatorStatusLabels[profile.status]}</p></div>
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
        {userId && profile?.status === "approved" && (section === "work" || section === "cooperations") && (
          <>
            {section === "cooperations" && <p className="portal-note">
              Оплата согласуется с клиникой напрямую. Подтверждение
              сотрудничества открывает только согласованный список заявок.
              Медицинская история и реклама недоступны.
            </p>}
            {section === "work" ? <OperatorWorkday key={`${userId}:${revision}`} actorId={userId} isSessionCurrent={isProfileSessionCurrent}
              onAccessDenied={refreshProfile} onCooperations={() => setSection("cooperations")}/> : <OperatorRequests
              key={`${userId}:${revision}`}
              actorId={userId}
              isSessionCurrent={isProfileSessionCurrent}
              onAccessDenied={refreshProfile}
            />}
          </>
        )}
        {section === "terms" && <section className="space-y-5 max-w-2xl">
          <h2 className="text-xl font-medium">Сотрудничество с компаниями</h2>
          <p>Стоимость работы и условия подтверждаются отдельно с каждой компанией. Доступ открывается только к согласованным заявкам и может быть отозван.</p>
          <p className="text-sm text-muted-foreground">Медицинская история, управление рекламой и данные других компаний недоступны.</p>
          <div className="flex flex-wrap gap-3"><Link className="neu-btn" href="/terms"><FileText size={16}/>Условия платформы</Link><Link className="neu-btn" href="/privacy">Конфиденциальность</Link></div>
        </section>}
      </div>
    </PortalShell>
  );
}
