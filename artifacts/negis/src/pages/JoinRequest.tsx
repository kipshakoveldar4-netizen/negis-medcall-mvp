import { useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { sessionAuth, supabase } from "@/lib/supabase";
import { crmFetch } from "@/lib/api";
import { formatJoinCode, isJoinCodeShape, normalizeJoinCode } from "../../../../lib/crm/join-codes";
import { validatePasswordRules } from "../../../../lib/auth/password-rules";
import { isSyntheticEmail } from "../../../../lib/auth/staff-logins";

// Экран сотрудника, который просится в клинику сам.
//
// Владелец описал путь так: «сотрудник регистрируется, выбирает или пишет, в
// какой салон или клинику он хочет войти, далее админ или владелец выбранного
// бизнеса одобрит или отклонит».
//
// Списка клиник здесь нет и быть не может: список клиник платформы — это её
// клиентская база. Клинику называет КОД, который человеку продиктовали свои же.
// По коду нельзя войти — по нему можно только встать в очередь, а пускает живой
// администратор.
//
// Никаких обращений к таблицам напрямую: страница ходит только в наш API. Иначе
// anon-ключ получил бы способ перечислить клиники.

type JoinRequestRow = {
  id: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  clinicName: string;
  role?: string;
};

type JoinLifetime = { actor: string | null; ready: boolean; controller: AbortController };

/** Английский код сервера в русский интерфейс не выводится ни в одной ветке. */
const REQUEST_ERROR_TEXTS: Record<string, string> = {
  join_code_unknown: "Такого кода нет. Проверьте символы — код диктуют буквами и цифрами, например MEDI-7K3N-Q82R. Если не сходится, спросите код у руководителя.",
  join_code_invalid: "Код выглядит иначе: четыре буквы и восемь знаков, например MEDI-7K3N-Q82R.",
  join_code_throttled: "Слишком много попыток с неверным кодом. Попробуйте через час.",
  join_request_pending: "Заявка уже отправлена — она на рассмотрении.",
  join_request_recently_rejected: "Клиника отклонила заявку. Подать заново можно через сутки.",
  already_member: "Вы уже работаете в этой клинике. Просто войдите.",
  validation_error: "Укажите имя и код клиники — без них заявку не отправить.",
  join_queue_full: "Очередь заявок этой клиники переполнена. Попросите администратора разобрать её и попробуйте позже.",
  storage_not_configured: "Сервис временно недоступен. Попробуйте через минуту.",
  not_provisioned: "Заявки по коду ещё не включены на платформе. Попросите руководителя завести вам логин и пароль.",
  authentication_required: "Сессия истекла — войдите ещё раз.",
};

/**
 * Ошибки Supabase приходят по-английски, а интерфейс русский. Разбор по
 * подстроке: кодов auth-js не обещает.
 */
function authErrorText(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("already registered") || text.includes("already exists")) {
    return "У этой почты уже есть вход. Переключитесь на «У меня есть вход» и войдите своим паролем.";
  }
  if (text.includes("invalid login") || text.includes("invalid credentials")) return "Почта или пароль неверные.";
  if (text.includes("rate limit") || text.includes("too many")) return "Слишком много попыток. Подождите пару минут.";
  if (text.includes("weak") || text.includes("easy to guess")) return "Такой пароль слишком простой — придумайте другой.";
  if (text.includes("email") && text.includes("confirm")) {
    return "Нужно подтвердить почту: откройте письмо от Medina OS и вернитесь сюда.";
  }
  if (text.includes("failed to fetch") || text.includes("network")) return "Нет связи с сервером. Проверьте интернет.";
  return "Не удалось выполнить вход. Попробуйте ещё раз.";
}

function errorTextFor(code: string, fallback: string): string {
  return REQUEST_ERROR_TEXTS[code] ?? fallback;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "На рассмотрении",
  approved: "Одобрена",
  rejected: "Отклонена",
};

export default function JoinRequest() {
  const [, setLocation] = useLocation();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [positionNote, setPositionNote] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionError, setSessionError] = useState(false);
  const mounted = useRef(false);
  const lifetime = useRef<JoinLifetime | null>(null);
  const authAttempt = useRef<object | null>(null);
  const mutation = useRef<object | null>(null);
  const readRevision = useRef(0);
  const formRevision = useRef(0);
  // null — «прочитать не удалось», и это не то же самое, что «заявок нет».
  const [requests, setRequests] = useState<JoinRequestRow[] | null>(null);

  const view = lifetime.current;
  const form = formRevision.current;
  const owns = (scope: JoinLifetime | null): scope is JoinLifetime => Boolean(
    mounted.current && scope?.ready && lifetime.current === scope && !scope.controller.signal.aborted,
  );
  const editable = () => owns(view) && formRevision.current === form && !authAttempt.current && !mutation.current;

  async function loadRequests(scope: JoinLifetime | null) {
    if (!owns(scope) || !scope.actor) return;
    const ticket = ++readRevision.current;
    const current = () => owns(scope) && ticket === readRevision.current;
    try {
      const response = await crmFetch("/api/crm/join-request", {
        expectedUserId: scope.actor, dispatchGuard: current, signal: scope.controller.signal,
      });
      // crmFetch не бросает на 4xx/5xx: без этой проверки протухший токен
      // рисовал бы пустую форму вместо честного «прочитать не удалось», и
      // человек с висящей заявкой набирал бы код заново.
      if (!current()) return;
      if (!response.ok) { setRequests(null); return; }
      const body = (await response.json()) as { data?: { requests?: JoinRequestRow[] } };
      if (!current()) return;
      setRequests(Array.isArray(body.data?.requests) ? body.data!.requests! : []);
    } catch {
      if (current()) setRequests(null);
    }
  }

  useLayoutEffect(() => {
    mounted.current = true;
    let active = true;
    const initial: JoinLifetime = { actor: null, ready: false, controller: new AbortController() };
    lifetime.current?.controller.abort();
    lifetime.current = initial;
    authAttempt.current = null; mutation.current = null;
    readRevision.current++; formRevision.current++;
    setHasSession(null); setRequests(null); setBusy(false); setSessionError(false);
    setEmail(""); setPassword(""); setFullName(""); setPhone(""); setPositionNote(""); setCode("");
    const apply = (actor: string | null, event: string) => {
      if (!active) return;
      const previous = lifetime.current;
      if (previous?.ready && previous.actor === actor && event !== "SIGNED_IN" && event !== "SIGNED_OUT") return;
      previous?.controller.abort();
      const scope: JoinLifetime = { actor, ready: true, controller: new AbortController() };
      lifetime.current = scope;
      authAttempt.current = null; mutation.current = null;
      readRevision.current++; formRevision.current++;
      setRequests(null); setPassword(""); setEmail(""); setFullName("");
      setPhone(""); setPositionNote(""); setCode(""); setBusy(false); setSessionError(false);
      setHasSession(actor ? null : false);
      if (actor) void loadRequests(scope).then(() => { if (owns(scope)) setHasSession(true); });
    };
    // Subscribe before bootstrap: an observed account change wins over a late lookup.
    const { data: { subscription } } = sessionAuth.onAuthStateChange((event, session) => apply(session?.user?.id ?? null, event));
    void (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!active || lifetime.current !== initial) return;
        if (error) throw error;
        apply(data.session?.user?.id ?? null, "INITIAL_SESSION");
      } catch { if (active && lifetime.current === initial) setSessionError(true); }
    })();
    return () => {
      active = false; mounted.current = false; subscription.unsubscribe();
      lifetime.current?.controller.abort(); lifetime.current = null;
      authAttempt.current = null; mutation.current = null;
      readRevision.current++; formRevision.current++;
    };
  }, []);

  /** Аккаунт заводится прямо в Supabase Auth: своего /api/auth/register нет. */
  async function authenticate() {
    if (!editable() || view?.actor) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) { toast.error("Укажите почту"); return; }
    // Служебный домен выдаёт система. Без этой отсечки посторонний
    // регистрировал бы «aigul@staff.negis.online» раньше клиники и занимал
    // чужой логин: заявку у него отобьют, а аккаунт останется навсегда.
    //
    // Честно про границу: это НЕ настоящая защита — anon-ключ лежит в бандле, и
    // запрос можно послать в GoTrue напрямую. Настоящая граница — правило на
    // стороне Supabase (hook before-user-created или запрет самозаписи), и её
    // ставит владелец платформы. Здесь закрыт обычный путь и назван служебный
    // домен, чтобы человек не занял логин по незнанию.
    if (isSyntheticEmail(normalizedEmail)) {
      toast.error("Адреса на служебном домене выдаёт клиника. Войдите выданным логином — заявка по коду для него не нужна.");
      return;
    }
    if (mode === "signup") {
      // Те же правила, что у сервера: свой минимум пропускал пароль с краевым
      // пробелом, и назавтра человек упирался в «Invalid login credentials».
      const problems = validatePasswordRules(password);
      if (problems.length > 0) { toast.error(problems[0]); return; }
    } else if (!password) {
      toast.error("Введите пароль");
      return;
    }
    const attempt = {};
    authAttempt.current = attempt;
    const current = () => owns(view) && !view.actor && authAttempt.current === attempt && formRevision.current === form;
    const originalPassword = password;
    setPassword(""); setBusy(true);
    try {
      const scope = { isCurrent: current, expectedUserId: null, signal: view!.controller.signal };
      const { data, error } = mode === "signup"
        ? await sessionAuth.signUp({ email: normalizedEmail, password: originalPassword }, scope)
        : await sessionAuth.signInWithPassword({ email: normalizedEmail, password: originalPassword }, scope);
      if (!current()) return;
      if (error) { toast.error(authErrorText(error.message)); return; }
      if (!data.session?.user?.id) {
        // Подтверждение почты письмом — единственный случай, когда сессии нет.
        // Письма Supabase до клиник Казахстана доходят плохо, поэтому говорим
        // прямо, а не оставляем пустой экран.
        toast.error("Аккаунт создан, но вход не выполнен. Если пришло письмо-подтверждение — откройте его и вернитесь сюда.");
        return;
      }
      // The verified auth observer owns the new account and its request list.
    } catch (error) {
      if (current()) toast.error(authErrorText(error instanceof Error ? error.message : ""));
    } finally {
      if (current()) { authAttempt.current = null; formRevision.current++; setBusy(false); }
    }
  }

  async function submit() {
    if (!editable() || !view?.actor) return;
    const normalizedCode = normalizeJoinCode(code);
    if (!fullName.trim() || !normalizedCode) {
      toast.error("Укажите имя и код клиники — без них заявку не отправить.");
      return;
    }
    // Код диктуют голосом, и «о» слышится как O, а не 0. В кодах таких знаков
    // не бывает вовсе — сказать об этом надо прямо, иначе человек считает
    // символы и не понимает, что не сходится.
    if (!isJoinCodeShape(normalizedCode)) {
      toast.error(/[ILO01]/.test(normalizedCode)
        ? "В кодах не бывает букв I, L, O и цифр 0, 1 — их путают на слух. Проверьте эти знаки."
        : "Код выглядит иначе: четыре буквы и восемь знаков, например MEDI-7K3N-Q82R.");
      return;
    }
    const attempt = {};
    mutation.current = attempt;
    const current = () => owns(view) && mutation.current === attempt;
    setBusy(true);
    try {
      const response = await crmFetch("/api/crm/join-request", {
        expectedUserId: view.actor, dispatchGuard: current, signal: view.controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: normalizedCode,
          fullName: fullName.trim(),
          phone: phone.trim(),
          positionNote: positionNote.trim(),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { success?: boolean; code?: string; data?: { request?: JoinRequestRow } };
      if (!current()) return;
      if (!response.ok || body.success !== true) {
        toast.error(errorTextFor(String(body.code ?? ""), "Не удалось отправить заявку"));
        return;
      }
      const clinic = body.data?.request?.clinicName;
      toast.success(clinic ? `Заявка отправлена в «${clinic}»` : "Заявка отправлена");
      setCode("");
      await loadRequests(view);
    } catch (error) {
      if (!current()) return;
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      toast.error(errorTextFor(code, "Не удалось отправить заявку"));
    } finally {
      if (current()) { mutation.current = null; formRevision.current++; setBusy(false); }
    }
  }

  const pending = (requests ?? []).find((request) => request.status === "pending");
  // Одобренную заявку показываем, но форму подачи она НЕ прячет: работа в двух
  // клиниках законна, и мастер, принятый в «Салон А», должен уметь подать код
  // «Салона Б». Прятал только ждущий ответ — он и правда один за раз.
  const approved = (requests ?? []).find((request) => request.status === "approved");

  return (
    <main className="min-h-[100dvh] px-5 py-10" style={{ background: "#EEF4F8" }}>
      <div className="mx-auto w-full max-w-[520px]">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--negis-text)" }}>Заявка на доступ</h1>
        <p className="mt-2 text-sm" style={{ color: "var(--negis-muted)" }}>
          Спросите код клиники у руководителя, подайте заявку — администратор подтвердит доступ.
        </p>

        {hasSession === null && (
          <p className="mt-8 text-xs" style={{ color: "var(--negis-muted)" }}>{sessionError ? "Не удалось проверить вход. Обновите страницу." : "ЗАГРУЗКА…"}</p>
        )}

        {hasSession === false && (
          <section className="mt-6 rounded-xl border bg-white p-6" style={{ borderColor: "var(--negis-border)" }}>
            <div className="mb-4 flex gap-2">
              <button
                type="button"
                className={mode === "signup" ? "neu-btn-primary flex-1 justify-center" : "neu-btn flex-1 justify-center"}
                aria-pressed={mode === "signup"}
                disabled={busy}
                onClick={() => { if (editable() && mode !== "signup") { formRevision.current++; setPassword(""); setMode("signup"); } }}
              >
                Я здесь впервые
              </button>
              <button
                type="button"
                className={mode === "signin" ? "neu-btn-primary flex-1 justify-center" : "neu-btn flex-1 justify-center"}
                aria-pressed={mode === "signin"}
                disabled={busy}
                onClick={() => { if (editable() && mode !== "signin") { formRevision.current++; setPassword(""); setMode("signin"); } }}
              >
                У меня есть вход
              </button>
            </div>
            <div className="space-y-3">
              <input className="neu-input" type="email" autoComplete="email" placeholder="Почта" disabled={busy} value={email} onChange={(event) => { if (editable()) setEmail(event.target.value); }} />
              <input
                className="neu-input"
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                placeholder="Пароль — не короче 8 символов"
                value={password}
                disabled={busy}
                onChange={(event) => { if (editable()) setPassword(event.target.value); }}
              />
              <button type="button" className="neu-btn-primary w-full justify-center" disabled={busy} onClick={() => void authenticate()}>
                {busy ? "Подождите…" : mode === "signup" ? "Создать аккаунт" : "Войти"}
              </button>
            </div>
            <p className="mt-3 text-[12px]" style={{ color: "var(--negis-muted)" }}>
              Этот пароль — ваш собственный: клиника его не видит и не задаёт.
            </p>
          </section>
        )}

        {hasSession === true && (
          <>
            {requests === null && (
              <p className="mt-6 rounded-xl border bg-white p-4 text-sm" style={{ borderColor: "var(--negis-border)", color: "var(--negis-muted)" }}>
                Не удалось прочитать статус заявки. Это не значит, что её нет — обновите страницу.
              </p>
            )}

            {approved && (
              <section className="mt-6 rounded-xl border p-6" style={{ borderColor: "#A7F3D0", background: "#ECFDF5" }}>
                <p className="text-sm font-semibold" style={{ color: "#065F46" }}>
                  Доступ в «{approved.clinicName}» открыт.
                </p>
                <p className="mt-1 text-[13px]" style={{ color: "#047857" }}>Войдите этой же почтой и паролем.</p>
                <button type="button" className="neu-btn-primary mt-4 w-full justify-center" onClick={() => { if (owns(view)) setLocation("/login"); }}>
                  Войти
                </button>
              </section>
            )}

            {pending && (
              <section className="mt-6 rounded-xl border bg-white p-6" style={{ borderColor: "var(--negis-border)" }}>
                <p className="text-sm font-semibold" style={{ color: "var(--negis-text)" }}>
                  Заявка отправлена в «{pending.clinicName}».
                </p>
                <p className="mt-2 text-[13px]" style={{ color: "var(--negis-muted)" }}>
                  Администратор подтвердит доступ — обычно в тот же день. Когда подтвердит, просто войдите этой же почтой и паролем: ничего делать не нужно.
                </p>
                <button type="button" className="neu-btn mt-4 w-full justify-center" onClick={() => void loadRequests(view)}>
                  Проверить статус
                </button>
              </section>
            )}

            {!pending && (
              <section className="mt-6 rounded-xl border bg-white p-6" style={{ borderColor: "var(--negis-border)" }}>
                <div className="space-y-3">
                  <div>
                    <label htmlFor="join-code" className="mb-1.5 block text-[11px] font-medium" style={{ color: "var(--negis-muted)" }}>КОД КЛИНИКИ</label>
                    <input
                      id="join-code"
                      className="neu-input font-mono"
                      placeholder="MEDI-7K3N-Q82R"
                      value={code}
                      disabled={busy}
                      onChange={(event) => { if (editable()) setCode(formatJoinCode(event.target.value)); }}
                    />
                  </div>
                  <div>
                    <label htmlFor="join-name" className="mb-1.5 block text-[11px] font-medium" style={{ color: "var(--negis-muted)" }}>ФАМИЛИЯ И ИМЯ</label>
                    <input id="join-name" className="neu-input" placeholder="Айгуль Ботанова" disabled={busy} value={fullName} onChange={(event) => { if (editable()) setFullName(event.target.value); }} />
                  </div>
                  <div>
                    <label htmlFor="join-phone" className="mb-1.5 block text-[11px] font-medium" style={{ color: "var(--negis-muted)" }}>ТЕЛЕФОН (НЕОБЯЗАТЕЛЬНО)</label>
                    <input id="join-phone" className="neu-input" placeholder="+7 700 000 00 00" disabled={busy} value={phone} onChange={(event) => { if (editable()) setPhone(event.target.value); }} />
                  </div>
                  <div>
                    <label htmlFor="join-position" className="mb-1.5 block text-[11px] font-medium" style={{ color: "var(--negis-muted)" }}>КЕМ ВЫ РАБОТАЕТЕ (НЕОБЯЗАТЕЛЬНО)</label>
                    <input id="join-position" className="neu-input" placeholder="мастер маникюра" disabled={busy} value={positionNote} onChange={(event) => { if (editable()) setPositionNote(event.target.value); }} />
                  </div>
                </div>
                {/* Роль здесь не выбирают: её назначает клиника при одобрении. */}
                <button type="button" className="neu-btn-primary mt-5 w-full justify-center" disabled={busy} onClick={() => void submit()}>
                  {busy ? "Отправляем…" : "Отправить заявку"}
                </button>
              </section>
            )}

            {(requests ?? []).length > 0 && (
              <section className="mt-4 rounded-xl border bg-white p-4" style={{ borderColor: "var(--negis-border)" }}>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--negis-muted)" }}>Ваши заявки</p>
                {(requests ?? []).map((request) => (
                  <div key={request.id} className="flex items-center justify-between gap-3 border-t py-2 text-[13px]" style={{ borderColor: "var(--negis-border)" }}>
                    <span style={{ color: "var(--negis-text)" }}>{request.clinicName || "Клиника"}</span>
                    <span style={{ color: "var(--negis-muted)" }}>{STATUS_LABELS[request.status] ?? "Обрабатывается"}</span>
                  </div>
                ))}
                {(requests ?? []).some((request) => request.status === "rejected") && !pending && (
                  <p className="mt-3 text-[12px]" style={{ color: "var(--negis-muted)" }}>
                    Клиника отклонила заявку. Если это ошибка — свяжитесь с руководителем и подайте заявку заново через сутки.
                  </p>
                )}
              </section>
            )}
          </>
        )}

        <button type="button" className="mt-6 text-[13px] underline" style={{ color: "var(--negis-muted)" }} onClick={() => setLocation("/login")}>
          Вернуться ко входу
        </button>
      </div>
    </main>
  );
}
