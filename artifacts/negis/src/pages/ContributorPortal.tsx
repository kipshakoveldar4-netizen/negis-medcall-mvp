import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, ExternalLink, LogOut, RefreshCw, Send, Users, Video } from "lucide-react";
import { supabase, hasSupabaseFrontendEnv } from "@/lib/supabase";
import { operatorApi } from "@/lib/operatorApi";
import { validatePasswordRules } from "../../../../lib/auth/password-rules";
import { isSyntheticEmail, loginOrEmailToAuthEmail } from "../../../../lib/auth/staff-logins";
import { contributorStatusLabels, parseContributorApplication, parseContributorProfile, type ContributorProfile } from "../../../../lib/crm/contributor-contracts";
import { PartnerLedger } from "@/components/contributors/PartnerLedger";
import { PartnerTerms } from "@/components/contributors/PartnerTerms";
import { CreatorJobs } from "@/components/contributors/CreatorJobs";

export default function ContributorPortal() {
  const [session, setSession] = useState<{ id: string | null; epoch: number } | null>(null);
  const live = useRef<{ id: string | null; epoch: number }>({ id: null, epoch: 0 });
  useLayoutEffect(() => {
    let alive = true, observed = false;
    const apply = (id: string | null) => {
      if (!alive) return;
      if (id !== live.current.id) live.current = { id, epoch: live.current.epoch + 1 };
      setSession(live.current);
    };
    const { data } = supabase.auth.onAuthStateChange((_event, next) => { observed = true; apply(next?.user.id ?? null); });
    void supabase.auth.getSession().then(({ data, error }) => { if (!observed) apply(error ? null : data.session?.user.id ?? null); }, () => { if (!observed) apply(null); });
    return () => { alive = false; live.current = { id: null, epoch: live.current.epoch + 1 }; data.subscription.unsubscribe(); };
  }, []);
  return <main className="min-h-screen px-4 py-8" style={{ background: "var(--negis-bg)", color: "var(--negis-text)" }}>
    <div className="mx-auto max-w-3xl min-w-0 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-5">
        <div><Link href="/" className="text-sm font-medium">Medina OS</Link><h1 className="mt-2 text-2xl font-semibold">Кабинет блогера</h1><p className="mt-1 text-sm text-muted-foreground">Партнёрство и создание контента</p></div>
        {session?.id && <button className="neu-btn" type="button" onClick={() => void supabase.auth.signOut()}><LogOut size={16} />Выйти</button>}
      </header>
      {!session ? <p role="status">Проверяем вход…</p> : session.id
        ? <Application key={session.epoch} userId={session.id} isActorCurrent={() => live.current === session} />
        : <ContributorLogin key={session.epoch} isCurrent={() => live.current === session} />}
      <footer className="flex flex-wrap gap-5 border-t pt-5 text-sm"><Link href="/operator" className="inline-flex items-center gap-2">Кабинет оператора <ArrowRight size={14} /></Link><Link href="/login">Вход для команды компании</Link><Link href="/privacy">Конфиденциальность</Link><Link href="/terms">Условия</Link></footer>
    </div>
  </main>;
}

function ContributorLogin({ isCurrent }: { isCurrent: () => boolean }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !isCurrent()) return;
    setMessage("");
    if (!hasSupabaseFrontendEnv) { setMessage("Вход пока не настроен."); return; }
    if (mode === "signup") {
      const errors = validatePasswordRules(password);
      if (isSyntheticEmail(email) || !email.includes("@")) { setMessage("Укажите личную почту."); return; }
      if (errors.length) { setMessage(errors[0]); return; }
    }
    setBusy(true);
    try {
      const result = mode === "signup"
        ? await supabase.auth.signUp({ email: email.trim().toLowerCase(), password, options: { emailRedirectTo: `${window.location.origin}/contributors` } })
        : await supabase.auth.signInWithPassword({ email: loginOrEmailToAuthEmail(email), password });
      if (!mounted.current || !isCurrent()) return;
      setPassword("");
      if (result.error) setMessage("Не удалось войти. Проверьте почту, пароль и подтверждение почты.");
      else if (!result.data.session) setMessage("Подтвердите почту по ссылке из письма.");
    } catch { if (mounted.current && isCurrent()) setMessage("Нет связи с сервером. Попробуйте позже."); }
    finally { if (mounted.current && isCurrent()) setBusy(false); }
  }
  return <section className="max-w-md space-y-5">
    <div className="flex gap-2" role="group" aria-label="Способ входа">{(["signin", "signup"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} disabled={busy} className={mode === value ? "neu-btn neu-btn-primary" : "neu-btn"} onClick={() => { setMode(value); setPassword(""); setMessage(""); }}>{value === "signin" ? "Вход" : "Регистрация"}</button>)}</div>
    <form onSubmit={event => void authenticate(event)} className="space-y-4">
      <label className="block text-sm">Почта<input className="neu-input mt-2 w-full" type="email" autoComplete="username" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={busy} /></label>
      <label className="block text-sm">Пароль<input className="neu-input mt-2 w-full" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>
      <button className="neu-btn neu-btn-primary" disabled={busy} type="submit"><ArrowRight size={16} />{busy ? "Подождите…" : mode === "signin" ? "Войти" : "Зарегистрироваться"}</button>
    </form>
    {message && <p role="status" className="text-sm break-words">{message}</p>}
  </section>;
}

function Application({ userId, isActorCurrent }: { userId: string; isActorCurrent: () => boolean }) {
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
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="min-w-0 max-w-full break-words text-lg font-semibold">{profile ? profile.displayName : "Заявка на участие"}</h2><button type="button" className="neu-btn" aria-label="Обновить профиль" title="Обновить профиль" disabled={busy} onClick={refresh}><RefreshCw size={16} /></button></div>
    {error && <p role="alert" className="text-sm break-words">{error}</p>}
    {!loaded && !error && <p role="status">Загружаем профиль…</p>}
    {loaded && profile && <>
      <div className="grid gap-3 sm:grid-cols-2">{(["partner", "creator"] as const).map(role => {
        const status = role === "partner" ? profile.partnerStatus : profile.creatorStatus;
        const Icon = role === "partner" ? Users : Video;
        return <article key={role} className="min-w-0 rounded-lg border p-4"><div className="flex items-center gap-2 font-medium"><Icon size={18} />{role === "partner" ? "Партнёр" : "Автор контента"}</div><p className="mt-3 text-sm">{status ? contributorStatusLabels[status] : "Заявка не подана"}</p></article>;
      })}</div>
      {profile.partnerStatus === "approved" && <><PartnerTerms actorId={userId} profileId={profile.id} side="partner" isSessionCurrent={current}
        onResolved={() => { if (current()) setPartnerLedgerRevision(n => n + 1); }}
        onAccessDenied={() => denyAccess("Доступ партнёра изменился. Обновите профиль.")}
        request={options => {
          const query = options.method === "GET" ? "?" + new URLSearchParams({ profileId: profile.id, ...(options.requestId ? { requestId: options.requestId } : {}) }) : "";
          return operatorApi<unknown>("partner-terms" + query, options.body, options.method, options.signal, userId, () => current() && options.isCurrent());
        }} />
        <PartnerLedger key={partnerLedgerRevision} userId={userId} isActorCurrent={current} onAccessDenied={() => denyAccess("Доступ партнёра изменился. Обновите профиль.")} /></>}
      {profile.creatorStatus === "approved" && <CreatorJobs actorId={userId} isSessionCurrent={current} onAccessDenied={() => denyAccess("Доступ автора изменился. Обновите профиль.")} />}
      {profile.portfolioUrls.length > 0 && <section className="space-y-3"><h3 className="font-medium">Портфолио</h3>{profile.portfolioUrls.map(url => <a className="flex min-w-0 items-start gap-2 text-sm" key={url} href={url} rel="noopener noreferrer" target="_blank"><ExternalLink className="shrink-0" size={16} /><span className="break-all">{url}</span></a>)}</section>}
    </>}
    {loaded && (!profile || missingRole) && <form onSubmit={event => void submit(event)} className="space-y-5 border-t pt-5">
      {!profile && <><label className="block text-sm">Имя<input className="neu-input mt-2 w-full" required maxLength={120} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label><label className="block text-sm">Ссылки на портфолио<textarea className="neu-input mt-2 w-full" rows={3} maxLength={2504} placeholder="https://…" value={urls} disabled={busy} onChange={e => setUrls(e.target.value)} /></label></>}
      <fieldset className="space-y-3" disabled={busy}><legend className="mb-3 font-medium">Направления</legend>{(!profile || profile.partnerStatus === null) && <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={partner} onChange={e => setPartner(e.target.checked)} />Привлекать компании как партнёр</label>}{(!profile || profile.creatorStatus === null) && <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={creator} onChange={e => setCreator(e.target.checked)} />Создавать контент</label>}</fieldset>
      <button type="submit" className="neu-btn neu-btn-primary" disabled={busy}><Send size={16} />{busy ? "Отправляем…" : profile ? "Добавить направление" : "Подать заявку"}</button>
    </form>}
  </>;
}
