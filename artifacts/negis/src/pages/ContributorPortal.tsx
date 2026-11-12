import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, ClipboardList, ExternalLink, FileText, Home, Image, RefreshCw, Send, UserRound, Users, Video } from "lucide-react";
import { PortalShell } from "@/components/portals/PortalShell";
import { useAuth } from "@/contexts/AuthContext";
import { supabase, sessionAuth, hasSupabaseFrontendEnv } from "@/lib/supabase";
import { operatorApi } from "@/lib/operatorApi";
import { validatePasswordRules } from "../../../../lib/auth/password-rules";
import { isSyntheticEmail, loginOrEmailToAuthEmail } from "../../../../lib/auth/staff-logins";
import { contributorStatusLabels, parseContributorApplication, parseContributorProfile, type ContributorProfile } from "../../../../lib/crm/contributor-contracts";
import { PartnerLedger } from "@/components/contributors/PartnerLedger";
import { PartnerHistory } from "@/components/contributors/PartnerHistory";
import { PartnerLink } from "@/components/contributors/PartnerLink";
import { PartnerTerms } from "@/components/contributors/PartnerTerms";
import { CreatorJobs } from "@/components/contributors/CreatorJobs";

export default function ContributorPortal() {
  const { signOut } = useAuth();
  const [session, setSession] = useState<{ id: string | null; epoch: number } | null>(null);
  const live = useRef<{ id: string | null; epoch: number }>({ id: null, epoch: 0 });
  const exiting = useRef(false);
  useLayoutEffect(() => {
    let alive = true, observed = false;
    const apply = (id: string | null) => {
      if (!alive || exiting.current) return;
      if (id !== live.current.id) live.current = { id, epoch: live.current.epoch + 1 };
      setSession(live.current);
    };
    const { data } = sessionAuth.onAuthStateChange((_event, next) => { observed = true; apply(next?.user.id ?? null); });
    void Promise.resolve().then(() => supabase.auth.getSession()).then(({ data, error }) => { if (!observed) apply(error ? null : data.session?.user.id ?? null); }, () => { if (!observed) apply(null); });
    return () => { alive = false; live.current = { id: null, epoch: live.current.epoch + 1 }; data.subscription.unsubscribe(); };
  }, []);
  function signOutActor() {
    if (!session?.id || exiting.current || live.current !== session) return;
    // Retire private callbacks before the provider starts its asynchronous exit.
    exiting.current = true;
    live.current = { id: null, epoch: session.epoch + 1 };
    setSession(live.current);
    void signOut().catch(() => {});
  }
  if (session?.id) return <Application key={session.epoch} userId={session.id} isActorCurrent={() => live.current === session} onSignOut={signOutActor} />;
  return <PortalShell title="Кабинет блогера" homeHref="/contributors" roleLabel="Партнёрам и авторам" activeId="entry" onNavigate={() => {}}
    items={[{ id: "entry", label: "Вход в кабинет", icon: UserRound }, { id: "operator", label: "Кабинет оператора", icon: ClipboardList, href: "/operator" }, { id: "team", label: "Вход для команды", icon: Users, href: "/login" }]}>
    <div className="portal-form-layout">{!session ? <p role="status">Проверяем вход…</p> : <ContributorLogin key={session.epoch} isCurrent={() => live.current === session} />}</div>
  </PortalShell>;
}

function ContributorLogin({ isCurrent }: { isCurrent: () => boolean }) {
  // Identity, not just the mode string, retires callbacks across repeated modes.
  const [login, setLogin] = useState<{ mode: "signin" | "signup" }>({ mode: "signin" });
  const mode = login.mode;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const liveLogin = useRef(login);
  const mounted = useRef<object | null>(null);
  const submission = useRef<object | null>(null);
  const current = () => mounted.current !== null && liveLogin.current === login && isCurrent();
  useLayoutEffect(() => {
    const lifetime = {};
    mounted.current = lifetime;
    return () => { mounted.current = null; submission.current = null; };
  }, []);
  function changeMode(value: "signin" | "signup") {
    if (!current() || submission.current) return;
    const next = { mode: value };
    liveLogin.current = next;
    setLogin(next); setPassword(""); setMessage("");
  }
  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    const lifetime = mounted.current;
    if (!lifetime || !current() || submission.current) return;
    setMessage("");
    if (!hasSupabaseFrontendEnv) { setMessage("Вход пока не настроен."); return; }
    if (mode === "signup") {
      const errors = validatePasswordRules(password);
      if (isSyntheticEmail(email) || !email.includes("@")) { setMessage("Укажите личную почту."); return; }
      if (errors.length) { setMessage(errors[0]); return; }
    }
    const attempt = {};
    const credentials = { email: mode === "signup" ? email.trim().toLowerCase() : loginOrEmailToAuthEmail(email), password };
    submission.current = attempt;
    const valid = () => mounted.current === lifetime && liveLogin.current === login && submission.current === attempt && isCurrent();
    setBusy(true); setPassword("");
    try {
      const result = mode === "signup"
        ? await sessionAuth.signUp({ ...credentials, options: { emailRedirectTo: `${window.location.origin}/contributors` } }, { isCurrent: valid, expectedUserId: null })
        : await sessionAuth.signInWithPassword(credentials, { isCurrent: valid, expectedUserId: null });
      if (!valid()) return;
      if (result.error) setMessage("Не удалось войти. Проверьте почту, пароль и подтверждение почты.");
      else if (!result.data.session) setMessage("Подтвердите почту по ссылке из письма.");
    } catch { if (valid()) setMessage("Нет связи с сервером. Попробуйте позже."); }
    finally {
      if (valid()) {
        submission.current = null;
        // Old form callbacks must not reuse their captured credentials.
        const next = { mode };
        liveLogin.current = next;
        setLogin(next); setBusy(false);
      }
    }
  }
  return <section className="max-w-md space-y-5">
    <div className="flex gap-2" role="group" aria-label="Способ входа">{(["signin", "signup"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} disabled={busy} className={mode === value ? "neu-btn neu-btn-primary" : "neu-btn"} onClick={() => changeMode(value)}>{value === "signin" ? "Вход" : "Регистрация"}</button>)}</div>
    <form onSubmit={event => void authenticate(event)} className="space-y-4">
      <label className="block text-sm">Почта<input className="neu-input mt-2 w-full" type="email" autoComplete="username" required maxLength={254} value={email} onChange={e => { if (current() && !submission.current) setEmail(e.target.value); }} disabled={busy} /></label>
      <label className="block text-sm">Пароль<input className="neu-input mt-2 w-full" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required value={password} onChange={e => { if (current() && !submission.current) setPassword(e.target.value); }} disabled={busy} /></label>
      <button className="neu-btn neu-btn-primary" disabled={busy} type="submit"><ArrowRight size={16} />{busy ? "Подождите…" : mode === "signin" ? "Войти" : "Зарегистрироваться"}</button>
    </form>
    {message && <p role="status" className="text-sm break-words">{message}</p>}
  </section>;
}

function Application({ userId, isActorCurrent, onSignOut }: { userId: string; isActorCurrent: () => boolean; onSignOut: () => void }) {
  const [profile, setProfile] = useState<ContributorProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [urls, setUrls] = useState("");
  const [partner, setPartner] = useState(true);
  const [creator, setCreator] = useState(true);
  const [revision, setRevision] = useState(0);
  const [partnerLedgerRevision, setPartnerLedgerRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selectedMode, setSelectedMode] = useState<"partner" | "creator" | null>(null);
  const [section, setSection] = useState("overview");
  const generation = useRef(0);
  const mounted = useRef(true);
  const mutation = useRef<AbortController | null>(null);
  const latestProfile = useRef(profile); latestProfile.current = profile;
  const current = () => mounted.current && isActorCurrent();
  function refresh() { if (!current()) return; generation.current++; setProfile(null); setLoaded(false); setError(""); setRevision(n => n + 1); }
  function denyAccess(message: string) {
    if (!current()) return;
    generation.current++; mutation.current?.abort(); mutation.current = null;
    setBusy(false); setProfile(null); setLoaded(false); setError(message);
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; mutation.current?.abort(); mutation.current = null; };
  }, []);
  useEffect(() => {
    const controller = new AbortController(), epoch = generation.current;
    const valid = () => !controller.signal.aborted && current() && generation.current === epoch;
    void operatorApi<unknown>("contributor-account", undefined, "GET", controller.signal, userId, valid).then(value => {
      if (!valid()) return;
      const parsed = value === null ? null : parseContributorProfile(value);
      if (value !== null && !parsed) throw Error("Не удалось проверить профиль.");
      setProfile(parsed); setLoaded(true);
    }).catch(err => { if (valid()) { setProfile(null); setLoaded(false); setError(err instanceof Error ? err.message : "Не удалось загрузить профиль."); } });
    return () => controller.abort();
  }, [revision, userId]);
  useEffect(() => {
    const revalidate = () => {
      if (!current()) return;
      // Jobs revalidate/hide their own private reads. Keep their in-memory form
      // while the profile is checked; a revoked or failed profile still unmounts it.
      if (latestProfile.current?.creatorStatus === "approved") { generation.current++; setError(""); setRevision(n => n + 1); }
      else refresh();
    };
    const visible = () => { if (document.visibilityState === "visible") revalidate(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", visible); };
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!current() || !loaded || mutation.current) return;
    const body = parseContributorApplication({ displayName: profile?.displayName ?? name,
      partner: Boolean(profile?.partnerStatus) || partner, creator: Boolean(profile?.creatorStatus) || creator,
      portfolioUrls: profile?.portfolioUrls ?? urls.split(/\r?\n/).map(s => s.trim()).filter(Boolean) });
    if (!body) { setError("Укажите имя, роль и до пяти разных публичных HTTPS-ссылок."); return; }
    const controller = new AbortController(), epoch = ++generation.current;
    mutation.current = controller; setBusy(true); setError("");
    const valid = () => current() && !controller.signal.aborted && generation.current === epoch;
    try {
      const result = await operatorApi<unknown>("contributor-account", body, "POST", controller.signal, userId, valid);
      if (!valid()) return;
      const saved = parseContributorProfile(result);
      if (!saved) throw Error("Не удалось подтвердить заявку. Обновите профиль.");
      setProfile(saved); setLoaded(true); setName(""); setUrls("");
    } catch (err) { if (valid()) { setProfile(null); setLoaded(false); setError(err instanceof Error ? err.message : "Не удалось подтвердить заявку."); } }
    finally { if (mutation.current === controller) { mutation.current = null; if (current()) { setBusy(false); if (generation.current !== epoch) refresh(); } } }
  }
  const missingRole = profile && (profile.partnerStatus === null || profile.creatorStatus === null);
  const activeMode = selectedMode ?? (profile?.partnerStatus ? "partner" : "creator");
  const isProfile = section === "profile" || !profile;
  const roleStatus = activeMode === "partner" ? profile?.partnerStatus : profile?.creatorStatus;
  const title = isProfile ? "Мой профиль" : section === "portfolio" ? "Моё портфолио" : section === "terms" ? "Условия партнёрства" : activeMode === "partner" ? "Партнёрский кабинет" : "Мои задания";
  return <PortalShell title={title} homeHref="/contributors" roleLabel={activeMode === "partner" ? "Кабинет партнёра" : "Кабинет автора"} displayName={profile?.displayName}
    onSignOut={onSignOut} activeId={section} onNavigate={setSection}
    items={[
      { id: "overview", label: activeMode === "partner" ? "Обзор" : "Мои задания", icon: activeMode === "partner" ? Home : ClipboardList },
      ...(activeMode === "partner" ? [{ id: "terms", label: "Код и условия", icon: FileText }] : [{ id: "portfolio", label: "Портфолио", icon: Image }]),
      { id: "profile", label: "Профиль", icon: UserRound },
      { id: "operator", label: "Кабинет оператора", icon: ClipboardList, href: "/operator" },
    ]} actions={<button type="button" className="neu-btn" aria-label="Обновить профиль" title="Обновить профиль" disabled={busy} onClick={refresh}><RefreshCw size={16}/></button>}>
    <div className="portal-mode-tabs" role="group" aria-label="Направление работы">
      <button type="button" aria-pressed={activeMode === "partner"} onClick={() => { setSelectedMode("partner"); setSection("overview"); }}><Users size={18}/>Партнёр</button>
      <button type="button" aria-pressed={activeMode === "creator"} onClick={() => { setSelectedMode("creator"); setSection("overview"); }}><Video size={18}/>Автор контента</button>
    </div>
    <div className="portal-view min-w-0 space-y-6" key={`${activeMode}:${section}`}>
    {error && <p role="alert" className="text-sm break-words">{error}</p>}
    {!loaded && !error && <p role="status">Загружаем профиль…</p>}
    {loaded && profile && <>
      {isProfile && <><div className="portal-section-heading"><h2>{profile.displayName}</h2></div><div className="grid gap-3 sm:grid-cols-2">{(["partner", "creator"] as const).map(role => {
        const status = role === "partner" ? profile.partnerStatus : profile.creatorStatus;
        const Icon = role === "partner" ? Users : Video;
        return <article key={role} className="min-w-0 rounded-lg border p-4"><div className="flex items-center gap-2 font-medium"><Icon size={18} />{role === "partner" ? "Партнёр" : "Автор контента"}</div><p className="mt-3 text-sm">{status ? contributorStatusLabels[status] : "Заявка не подана"}</p></article>;
      })}</div></>}
      {!isProfile && activeMode === "partner" && profile.partnerStatus === "approved" && <>
        {(section === "overview" || section === "terms") && <PartnerLink key={`link:${profile.revision}:${partnerLedgerRevision}`} actorId={userId} profileId={profile.id} isSessionCurrent={current}
          onAccessDenied={() => denyAccess("Доступ партнёра изменился. Обновите профиль.")}
          request={options => operatorApi<unknown>("partner-link?profileId=" + profile.id, undefined, "GET", options.signal, userId, () => current() && options.isCurrent())} />}
        {section === "terms" && <PartnerTerms actorId={userId} profileId={profile.id} side="partner" isSessionCurrent={current}
        onResolved={() => { if (current()) setPartnerLedgerRevision(n => n + 1); }}
        onAccessDenied={() => denyAccess("Доступ партнёра изменился. Обновите профиль.")}
        request={options => {
          const query = options.method === "GET" ? "?" + new URLSearchParams({ profileId: profile.id, ...(options.requestId ? { requestId: options.requestId } : {}) }) : "";
          return operatorApi<unknown>("partner-terms" + query, options.body, options.method, options.signal, userId, () => current() && options.isCurrent());
        }} />}
        {section === "overview" && <><PartnerLedger key={partnerLedgerRevision} userId={userId} isActorCurrent={current} onAccessDenied={() => denyAccess("Доступ партнёра изменился. Обновите профиль.")} />
          <PartnerHistory key={`history:${partnerLedgerRevision}`} userId={userId} isActorCurrent={current} onAccessDenied={() => denyAccess("Доступ партнёра изменился. Обновите профиль.")} />
          <div className="portal-profile-summary"><div><h2 className="font-medium">Партнёрская программа</h2><p className="portal-note">{contributorStatusLabels[profile.partnerStatus]}</p></div><button type="button" className="neu-btn" onClick={() => setSection("terms")}><FileText size={16}/>Код и условия<ArrowRight size={16}/></button></div></>}
      </>}
      {!isProfile && activeMode === "creator" && section === "overview" && profile.creatorStatus === "approved" && <CreatorJobs actorId={userId} isSessionCurrent={current} onAccessDenied={() => denyAccess("Доступ автора изменился. Обновите профиль.")} />}
      {!isProfile && roleStatus !== "approved" && <section className="space-y-4"><h2 className="text-lg font-medium">{activeMode === "partner" ? "Партнёрство" : "Создание контента"}</h2><p role="status">{roleStatus ? contributorStatusLabels[roleStatus] : "Заявка на это направление не подана"}</p><button type="button" className="neu-btn" onClick={() => setSection("profile")}><UserRound size={16}/>Мой профиль</button></section>}
      {(isProfile || section === "portfolio") && <section className="space-y-3"><h3 className="font-medium">Портфолио</h3>{profile.portfolioUrls.length === 0 ? <p className="text-sm text-muted-foreground">Ссылки пока не добавлены.</p> : profile.portfolioUrls.map(url => <a className="flex min-w-0 items-start gap-2 text-sm" key={url} href={url} rel="noopener noreferrer" target="_blank"><ExternalLink className="shrink-0" size={16} /><span className="break-all">{url}</span></a>)}</section>}
    </>}
    {loaded && isProfile && (!profile || missingRole) && <form onSubmit={event => void submit(event)} className="portal-form-layout space-y-5 border-t pt-5">
      {!profile && <><label className="block text-sm">Имя<input className="neu-input mt-2 w-full" required maxLength={120} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label><label className="block text-sm">Ссылки на портфолио<textarea className="neu-input mt-2 w-full" rows={3} maxLength={2504} placeholder="https://…" value={urls} disabled={busy} onChange={e => setUrls(e.target.value)} /></label></>}
      <fieldset className="space-y-3" disabled={busy}><legend className="mb-3 font-medium">Направления</legend>{(!profile || profile.partnerStatus === null) && <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={partner} onChange={e => setPartner(e.target.checked)} />Привлекать компании как партнёр</label>}{(!profile || profile.creatorStatus === null) && <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={creator} onChange={e => setCreator(e.target.checked)} />Создавать контент</label>}</fieldset>
      <button type="submit" className="neu-btn neu-btn-primary" disabled={busy}><Send size={16} />{busy ? "Отправляем…" : profile ? "Добавить направление" : "Подать заявку"}</button>
    </form>}
    </div>
  </PortalShell>;
}
