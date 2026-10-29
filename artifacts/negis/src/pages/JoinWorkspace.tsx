import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, ShieldCheck } from "lucide-react";
import { crmFetch, crmJson, crmErrorMessage, CrmApiError } from "@/lib/api";
import { supabase, hasSupabaseFrontendEnv, sessionAuth } from "@/lib/supabase";
import { toast } from "sonner";
import { isSyntheticEmail } from "../../../../lib/auth/staff-logins";
import { WORKSPACE_SELECTOR_KEY } from "@/lib/demoStorage";
import { useAuth } from "@/contexts/AuthContext";
import { getSignOutRevision, isSignOutPending } from "@/lib/authSignOut";

// Commercial-3B — the invited person's half of enrollment.
//
// The link carries a token; it is not proof of anything on its own. The server
// only writes a membership when the signed-in session's address matches the one
// the clinic invited, so this page's job is to make sure the person is signed in
// as that address and then hand the token over.

type Phase = "checking" | "needs-auth" | "ready" | "joining" | "joined" | "error";

/**
 * Токен приглашения, отложенный на время похода за паролем.
 *
 * Уходя на /login или /reset-password, приглашённый терял токен: он живёт
 * только в памяти этого компонента и стёрт из адресной строки. Вернуться можно
 * было лишь через исходное сообщение в мессенджере — а страница входа вдобавок
 * разлогинивала его с «Аккаунт не связан с клиникой», потому что членство
 * появляется ТОЛЬКО после принятия. sessionStorage (не localStorage) — ключ
 * умирает вместе с вкладкой, как и должен одноразовый токен.
 */
export const PENDING_INVITE_KEY = "negis_pending_invite";

type InviteLifetime = {
  active: boolean;
  actorId: string;
  email: string;
  sdkToken?: string;
  signOutRevision: number;
  actionRevision: number;
  pending: AbortController | null;
  recoveryPending: boolean;
  accepted: boolean;
  redirect?: ReturnType<typeof setTimeout>;
};

function newLifetime(): InviteLifetime {
  return { active: true, actorId: "", email: "", signOutRevision: getSignOutRevision(),
    actionRevision: 0, pending: null, recoveryPending: false, accepted: false };
}

function retire(lifetime: InviteLifetime) {
  lifetime.active = false;
  lifetime.pending?.abort();
  if (lifetime.redirect !== undefined) clearTimeout(lifetime.redirect);
}

export default function JoinWorkspace() {
  const auth = useAuth();
  const token = useInvitationToken();
  const contextKey = JSON.stringify([auth.user?.id, auth.session?.user.id, auth.clinicId, auth.userRole,
    auth.workspacePurpose, auth.vertical, auth.isSigningOut, auth.isDemoMode, auth.isImpersonation,
    Object.entries(auth.rolePermissions ?? {}).sort(([left], [right]) => left.localeCompare(right))]);
  return <JoinWorkspaceSession key={contextKey} token={token}
    contextActor={auth.session?.user.id || auth.user?.id}
    blocked={auth.isSigningOut || auth.isDemoMode || auth.isImpersonation
      || Boolean(auth.user && auth.session && auth.user.id !== auth.session.user.id)} />;
}

function JoinWorkspaceSession({ token, blocked, contextActor }: { token: string; blocked: boolean; contextActor?: string }) {
  const [, setLocation] = useLocation();
  const [phase, setPhase] = useState<Phase>("checking");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [fullName, setFullName] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoverySending, setRecoverySending] = useState(false);
  const [recoverySent, setRecoverySent] = useState(false);
  const [lookupRevision, setLookupRevision] = useState(0);
  const mounted = useRef(false);
  const lifetime = useRef<InviteLifetime>({ ...newLifetime(), active: false });
  const scope = lifetime.current;
  const actionRevision = scope.actionRevision;
  const isCurrent = () => scope.active && lifetime.current === scope && !blocked
    && !isSignOutPending() && scope.signOutRevision === getSignOutRevision();
  const canAct = () => isCurrent() && scope.actionRevision === actionRevision
    && !scope.pending && !scope.recoveryPending && !scope.accepted;

  const sendRecovery = async () => {
    if (!canAct() || phase !== "needs-auth" || !recoveryEmail.trim()) return;
    // У входа по логину почты нет: письмо ушло бы в домен без MX, а человек
    // ждал бы его вместо того, чтобы попросить пароль у администратора.
    if (isSyntheticEmail(recoveryEmail.trim())) {
      toast.error("У логина нет почты — новый пароль задаёт администратор клиники.");
      return;
    }
    scope.recoveryPending = true;
    scope.actionRevision += 1;
    setRecoverySending(true);
    try {
      await supabase.auth.resetPasswordForEmail(recoveryEmail.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (isCurrent()) setRecoverySent(true);
    } catch {
      // Один ответ на любой исход: существование аккаунта — не для угадывания.
      if (isCurrent()) setRecoverySent(true);
    } finally {
      if (isCurrent()) { scope.recoveryPending = false; setRecoverySending(false); }
    }
  };

  /** Уходя за паролем, откладываем токен: вернуться по ссылке уже нельзя. */
  function stashToken() {
    if (!canAct()) return false;
    try {
      if (token) window.sessionStorage.setItem(PENDING_INVITE_KEY, token);
    } catch {
      // Нет хранилища — пусть возвращается по исходной ссылке.
    }
    return true;
  }

  function clearStashedToken() {
    try {
      window.sessionStorage.removeItem(PENDING_INVITE_KEY);
    } catch {
      // Нечего чистить.
    }
  }

  useLayoutEffect(() => {
    mounted.current = true;
    let active = true;
    let resolved = false;
    let live = newLifetime();
    lifetime.current = live;
    const reset = () => {
      setPhase("checking"); setEmail(""); setMessage(""); setFullName("");
      setRecoveryEmail(""); setRecoverySending(false); setRecoverySent(false);
    };
    reset();
    // SDK events invalidate immediately, even before React commits an account switch.
    const publish = (session: { user: { id: string; email?: string }; access_token?: string } | null, event = "") => {
      if (!active || (event === "INITIAL_SESSION" && resolved)) return;
      const actorId = session?.user.id || "";
      const sessionEmail = session?.user.email || "";
      if (resolved && live.actorId === actorId && live.email === sessionEmail
        && !(event === "SIGNED_IN" && live.sdkToken !== session?.access_token)) {
        live.sdkToken = session?.access_token;
        return;
      }
      resolved = true;
      retire(live);
      live = newLifetime();
      live.actorId = actorId; live.email = sessionEmail; live.sdkToken = session?.access_token;
      lifetime.current = live;
      reset();
      if (actorId && contextActor && actorId !== contextActor) return;
      setEmail(sessionEmail);
      setPhase(actorId && sessionEmail ? "ready" : "needs-auth");
    };
    const lookupCurrent = () => active && !resolved && live.active && !isSignOutPending()
      && live.signOutRevision === getSignOutRevision();
    const resolve = async () => {
      if (!token) {
        setPhase("error");
        setMessage("Ссылка неполная: в ней нет кода приглашения.");
        return;
      }
      if (!hasSupabaseFrontendEnv) {
        setPhase("error");
        setMessage("Вход недоступен: не настроен Supabase.");
        return;
      }
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!lookupCurrent()) return;
        if (error) throw error;
        publish(data.session);
      } catch (error) {
        if (!lookupCurrent()) return;
        setPhase("error"); setMessage(crmErrorMessage(error));
      }
    };
    const listener = token && hasSupabaseFrontendEnv && !blocked
      ? sessionAuth.onAuthStateChange((event, session) => {
        if (isSignOutPending() || live.signOutRevision !== getSignOutRevision()) {
          retire(live); if (active) reset(); return;
        }
        publish(session, event);
      }).data.subscription : undefined;
    if (!blocked) void resolve();
    return () => {
      mounted.current = false;
      active = false;
      retire(live);
      listener?.unsubscribe();
    };
  }, [token, blocked, contextActor, lookupRevision]);

  function goToLogin() {
    if (!canAct()) return;
    stashToken(); setLocation("/login");
    retire(scope);
  }

  function switchAccount() {
    if (!stashToken()) return;
    const original = sessionAuth.capture();
    retire(scope);
    setPhase("checking");
    void sessionAuth.signOut({ expected: original, isCurrent: () => mounted.current && lifetime.current === scope }).then(({ error }) => {
      if (!mounted.current || lifetime.current !== scope) return;
      if (error && scope.active === false) setLookupRevision(value => value + 1);
    }).catch(() => {
      if (mounted.current && lifetime.current === scope) setLookupRevision(value => value + 1);
    });
  }

  async function accept() {
    if (!canAct() || !scope.actorId || (phase !== "ready" && phase !== "error")) return;
    const abort = new AbortController();
    scope.pending = abort;
    scope.actionRevision += 1;
    const current = () => isCurrent() && scope.pending === abort;
    setPhase("joining");
    setMessage("");
    try {
      const response = await crmFetch("/api/crm/staff-invitations/accept", {
        method: "POST",
        expectedUserId: scope.actorId,
        dispatchGuard: current,
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, fullName: fullName.trim() || undefined }),
      });
      const body = await crmJson<{ success?: boolean; data?: { workspaceId?: string } }>(response);
      if (!current()) return;
      const workspaceId = body?.data?.workspaceId;
      if (body?.success !== true || typeof workspaceId !== "string" || !workspaceId.trim()) {
        throw new Error("Invalid invitation response");
      }
      if (workspaceId) {
        // The bootstrap will confirm this against the server on the next load;
        // writing it here only saves the new member a workspace choice.
        window.localStorage.setItem(WORKSPACE_SELECTOR_KEY, workspaceId);
      }
      clearStashedToken();
      scope.accepted = true;
      setPhase("joined");
      // Полная навигация, а не SPA-переход: членство появилось секунду назад,
      // AuthContext о нём не знает, и клиентский роутер вышвыривал новичка с
      // /dashboard на маркетинговый лендинг. Перезагрузка перечитывает
      // членства с сервера — человек попадает в свой кабинет.
      scope.redirect = setTimeout(() => {
        if (!isCurrent() || !scope.accepted) return;
        window.location.assign(`${window.location.origin}${import.meta.env.BASE_URL || "/"}dashboard`.replace(/\/{2,}dashboard$/, "/dashboard"));
      }, 1400);
    } catch (error) {
      if (!current()) return;
      setPhase("error");
      if (error instanceof CrmApiError) {
        setMessage(invitationMessage(error));
        return;
      }
      setMessage(crmErrorMessage(error));
    } finally {
      if (current()) scope.pending = null;
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-5 py-10">
      <section className="neu-card">
        <div className="flex items-center gap-3">
          <ShieldCheck className="text-[#0D9488]" size={24} />
          <h1 className="text-xl font-black text-[#0F172A]">Присоединиться к клинике</h1>
        </div>

        {phase === "checking" && (
          <p className="mt-4 flex items-center gap-2 text-sm text-[#64748B]">
            <Loader2 className="animate-spin" size={16} />
            Проверяем приглашение…
          </p>
        )}

        {phase === "needs-auth" && (
          <div className="mt-4 grid gap-3">
            <p className="text-sm text-[#64748B]">
              Войдите под тем адресом, на который выписано приглашение, и откройте эту ссылку ещё раз.
            </p>
            {/* Приглашённый владелец нового салона часто ещё БЕЗ пароля: его
                аккаунт мог существовать до приглашения, и письма с паролем не
                было. Восстановление — прямо здесь, а не квест по лендингу. */}
            <p className="text-sm text-[#64748B]">
              Нет пароля или забыли его? Введите почту — придёт письмо, по которому вы зададите пароль.
            </p>
            <input
              className="neu-input"
              type="email"
              placeholder="Почта из приглашения"
              value={recoveryEmail}
              onChange={(event) => { if (canAct()) setRecoveryEmail(event.target.value); }}
            />
            {recoverySent ? (
              <p className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                Если у этой почты есть аккаунт — письмо уже в пути. Задайте пароль и откройте ссылку приглашения снова.
              </p>
            ) : (
              <button
                type="button"
                className="neu-btn w-full justify-center"
                disabled={recoverySending}
                onClick={() => { if (stashToken()) void sendRecovery(); }}
              >
                {recoverySending ? "Отправляем письмо…" : "Выслать письмо для пароля"}
              </button>
            )}
            {/* Токен откладывается перед уходом: со страницы входа сюда не
                вернуться — ссылка уже стёрта из адресной строки. */}
            <button
              type="button"
              className="neu-btn-primary w-full justify-center"
              onClick={goToLogin}
            >
              У меня есть пароль — войти
            </button>
          </div>
        )}

        {(phase === "ready" || phase === "joining") && (
          <div className="mt-4 grid gap-3">
            <p className="text-sm text-[#64748B]">
              Вы вошли как <span className="font-semibold text-[#0F172A]">{email}</span>. Приглашение примется только если оно
              выписано на этот адрес.
            </p>
            <input
              className="neu-input"
              placeholder="Как вас показывать коллегам"
              value={fullName}
              disabled={phase === "joining"}
              onChange={(event) => { if (canAct()) setFullName(event.target.value); }}
            />
            <button
              type="button"
              className="neu-btn-primary w-full justify-center"
              disabled={phase === "joining"}
              onClick={accept}
            >
              {phase === "joining" ? <Loader2 className="animate-spin" size={16} /> : null}
              Принять приглашение
            </button>
            {/* Вошли не с той почтой — выход прямо здесь: подписка на
                onAuthStateChange вернёт страницу в needs-auth, токен уцелеет,
                и открывать ссылку заново не нужно. */}
            <button
              type="button"
              className="neu-btn w-full justify-center"
              disabled={phase === "joining"}
              onClick={switchAccount}
            >
              Это не я — войти под другой почтой
            </button>
          </div>
        )}

        {phase === "joined" && (
          <p className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            Готово. Открываем рабочее пространство…
          </p>
        )}

        {phase === "error" && (
          <div className="mt-4 grid gap-3">
            <p className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{message}</p>
            {email ? (
              <button type="button" className="neu-btn-primary w-full justify-center" onClick={accept}>
                Повторить
              </button>
            ) : token && hasSupabaseFrontendEnv && !blocked ? (
              <button type="button" className="neu-btn w-full justify-center"
                onClick={() => { if (canAct()) setLookupRevision(value => value + 1); }}>
                Проверить снова
              </button>
            ) : null}
            {email ? (
              <button
                type="button"
                className="neu-btn w-full justify-center"
                onClick={switchAccount}
              >
                Войти под другой почтой
              </button>
            ) : null}
            <button type="button" className="neu-btn w-full justify-center" onClick={goToLogin}>
              Ко входу
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function useInvitationToken() {
  // Capture before stripping the URL; keep the token across account/workspace remounts.
  return useMemo(() => {
    if (typeof window === "undefined") return "";
    const fromQuery = new URLSearchParams(window.location.search).get("token")?.trim() || "";
    const rawHash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const fromHash = new URLSearchParams(rawHash).get("token")?.trim() || "";
    let stashed = "";
    try { stashed = window.sessionStorage.getItem(PENDING_INVITE_KEY)?.trim() || ""; } catch { /* Storage is optional. */ }
    const captured = fromQuery || fromHash || stashed;
    if (fromQuery || fromHash) window.history.replaceState(null, "", window.location.pathname);
    return captured;
  }, []);
}

/** Russian copy for the states an invited person can actually reach. */
function invitationMessage(error: CrmApiError): string {
  switch (error.code) {
    case "invitation_not_found":
      return "Приглашение не найдено. Возможно, ссылка неполная или уже отозвана.";
    case "invitation_expired":
      return "Срок приглашения истёк. Попросите администратора выслать новое.";
    case "invitation_revoked":
      return "Приглашение отозвано.";
    case "invitation_accepted":
      return "Это приглашение уже использовано.";
    case "invitation_email_mismatch":
      return "Приглашение выписано на другой адрес. Войдите под тем email, на который оно пришло.";
    default:
      return crmErrorMessage(error);
  }
}
