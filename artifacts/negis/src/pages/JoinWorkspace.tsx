import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, ShieldCheck } from "lucide-react";
import { crmFetch, crmJson, crmErrorMessage, CrmApiError } from "@/lib/api";
import { supabase, hasSupabaseFrontendEnv } from "@/lib/supabase";
import { WORKSPACE_SELECTOR_KEY } from "@/lib/demoStorage";

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

export default function JoinWorkspace() {
  const [, setLocation] = useLocation();
  const [phase, setPhase] = useState<Phase>("checking");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [fullName, setFullName] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoverySending, setRecoverySending] = useState(false);
  const [recoverySent, setRecoverySent] = useState(false);

  const sendRecovery = async () => {
    if (recoverySending || !recoveryEmail.trim()) return;
    setRecoverySending(true);
    try {
      await supabase.auth.resetPasswordForEmail(recoveryEmail.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      setRecoverySent(true);
    } catch {
      // Один ответ на любой исход: существование аккаунта — не для угадывания.
      setRecoverySent(true);
    } finally {
      setRecoverySending(false);
    }
  };

  // Read once — from the query или из старого фрагмента — и сразу убрать из
  // адресной строки. Query выбран основным сознательно: WhatsApp и другие
  // мессенджеры отбрасывают часть ссылки после «#» при открытии во встроенном
  // браузере, и первая же настоящая передача салона сломалась ровно на этом.
  // Токен одноразовый, привязан к почте и хранится хэшем — сам по себе он не
  // открывает ничего. Значение живёт только в памяти этого компонента.
  const token = useMemo(() => {
    if (typeof window === "undefined") return "";
    const fromQuery = new URLSearchParams(window.location.search).get("token")?.trim() || "";
    const rawHash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const fromHash = new URLSearchParams(rawHash).get("token")?.trim() || "";
    // Отложенный токен — возврат из похода за паролем: адресная строка уже
    // чистая, а приглашение ещё не принято.
    let stashed = "";
    try {
      stashed = window.sessionStorage.getItem(PENDING_INVITE_KEY)?.trim() || "";
    } catch {
      // Приватный режим без хранилища — работаем только с адресной строкой.
    }
    const captured = fromQuery || fromHash || stashed;
    if (fromQuery || fromHash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    return captured;
  }, []);

  /** Уходя за паролем, откладываем токен: вернуться по ссылке уже нельзя. */
  function stashToken() {
    try {
      if (token) window.sessionStorage.setItem(PENDING_INVITE_KEY, token);
    } catch {
      // Нет хранилища — пусть возвращается по исходной ссылке.
    }
  }

  function clearStashedToken() {
    try {
      window.sessionStorage.removeItem(PENDING_INVITE_KEY);
    } catch {
      // Нечего чистить.
    }
  }

  useEffect(() => {
    let cancelled = false;

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

      const { data } = await supabase.auth.getSession();
      if (cancelled) return;

      const sessionEmail = data.session?.user?.email || "";
      if (!sessionEmail) {
        setPhase("needs-auth");
        return;
      }

      setEmail(sessionEmail);
      setPhase("ready");
    };

    void resolve();
    // The invite email lands here after Supabase sets the session, so react to
    // that rather than only to the first render.
    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      void resolve();
    });

    return () => {
      cancelled = true;
      listener?.subscription?.unsubscribe();
    };
  }, [token]);

  async function accept() {
    setPhase("joining");
    setMessage("");
    try {
      const response = await crmFetch("/api/crm/staff-invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, fullName: fullName.trim() || undefined }),
      });
      const body = await crmJson<{ data?: { workspaceId?: string } }>(response);
      const workspaceId = body.data?.workspaceId;
      if (workspaceId) {
        // The bootstrap will confirm this against the server on the next load;
        // writing it here only saves the new member a workspace choice.
        window.localStorage.setItem(WORKSPACE_SELECTOR_KEY, workspaceId);
      }
      clearStashedToken();
      setPhase("joined");
      // Полная навигация, а не SPA-переход: членство появилось секунду назад,
      // AuthContext о нём не знает, и клиентский роутер вышвыривал новичка с
      // /dashboard на маркетинговый лендинг. Перезагрузка перечитывает
      // членства с сервера — человек попадает в свой кабинет.
      setTimeout(() => {
        window.location.assign(`${window.location.origin}${import.meta.env.BASE_URL || "/"}dashboard`.replace(/\/{2,}dashboard$/, "/dashboard"));
      }, 1400);
    } catch (error) {
      setPhase("error");
      if (error instanceof CrmApiError) {
        setMessage(invitationMessage(error));
        return;
      }
      setMessage(crmErrorMessage(error));
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
              onChange={(event) => setRecoveryEmail(event.target.value)}
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
                onClick={() => { stashToken(); void sendRecovery(); }}
              >
                {recoverySending ? "Отправляем письмо…" : "Выслать письмо для пароля"}
              </button>
            )}
            {/* Токен откладывается перед уходом: со страницы входа сюда не
                вернуться — ссылка уже стёрта из адресной строки. */}
            <button
              type="button"
              className="neu-btn-primary w-full justify-center"
              onClick={() => { stashToken(); setLocation("/login"); }}
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
              onChange={(event) => setFullName(event.target.value)}
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
              onClick={() => { stashToken(); void supabase.auth.signOut(); }}
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
              <button
                type="button"
                className="neu-btn w-full justify-center"
                onClick={() => { stashToken(); void supabase.auth.signOut(); }}
              >
                Войти под другой почтой
              </button>
            ) : null}
            <button type="button" className="neu-btn w-full justify-center" onClick={() => { stashToken(); setLocation("/login"); }}>
              Ко входу
            </button>
          </div>
        )}
      </section>
    </div>
  );
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
