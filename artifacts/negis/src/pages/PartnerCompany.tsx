import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Building2, ClipboardList, Users } from "lucide-react";
import { Link } from "wouter";
import { PortalShell } from "@/components/portals/PortalShell";
import { PartnerCompanyApplication } from "@/components/contributors/PartnerCompanyApplication";
import { supabase, hasSupabaseFrontendEnv } from "@/lib/supabase";
import { companyRequestForActor } from "./partner-company-client";

type Session = Readonly<{ id: string | null; epoch: number }>;
const navigation = [
  { id: "company", label: "Заявка компании", icon: Building2 },
  { id: "contributors", label: "Кабинет партнёра", icon: Users, href: "/contributors" },
  { id: "team", label: "Вход для команды", icon: ClipboardList, href: "/login" },
];

export default function PartnerCompany() {
  const [session, setSession] = useState<Session | null>(null);
  const live = useRef<Session>({ id: null, epoch: 0 });
  useLayoutEffect(() => {
    let alive = true, observed = false;
    const apply = (id: string | null) => {
      if (!alive) return;
      if (id !== live.current.id) live.current = Object.freeze({ id, epoch: live.current.epoch + 1 });
      setSession(live.current);
    };
    const { data } = supabase.auth.onAuthStateChange((_event, next) => { observed = true; apply(next?.user.id ?? null); });
    void supabase.auth.getSession().then(({ data, error }) => { if (!observed) apply(error ? null : data.session?.user.id ?? null); }, () => { if (!observed) apply(null); });
    return () => { alive = false; live.current = { id: null, epoch: live.current.epoch + 1 }; data.subscription.unsubscribe(); };
  }, []);
  return <PortalShell title="Заявка компании" homeHref="/partner-company" roleLabel="Подключение к Medina OS" activeId="company" items={navigation} onNavigate={() => {}}
    onSignOut={session?.id ? () => void supabase.auth.signOut() : undefined}>
    {!session ? <p role="status">Проверяем вход…</p> : session.id
      ? <Company key={session.epoch} actorId={session.id} isCurrent={() => live.current === session} />
      : <CompanyLogin key={session.epoch} isCurrent={() => live.current === session} />}
  </PortalShell>;
}

function Company({ actorId, isCurrent }: { actorId: string; isCurrent(): boolean }) {
  const [denied, setDenied] = useState(false);
  const request = useRef(companyRequestForActor(actorId, isCurrent)).current;
  return denied ? <section className="portal-form-layout space-y-4" role="alert"><h2 className="font-medium">Доступ к заявке изменился</h2>
    <p>Проверьте подтверждение личной почты и текущий аккаунт. Старая форма скрыта.</p>
    <Link href="/login" className="neu-btn"><ArrowRight size={16} />Вход для команды</Link></section>
    : <PartnerCompanyApplication actorId={actorId} request={request} isSessionCurrent={isCurrent} onAccessDenied={() => { if (isCurrent()) setDenied(true); }} />;
}

function CompanyLogin({ isCurrent }: { isCurrent(): boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef(true), submitting = useRef(false);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!active.current || !isCurrent() || submitting.current) return;
    if (!hasSupabaseFrontendEnv) { setMessage("Вход пока не настроен."); return; }
    submitting.current = true; setBusy(true); setMessage("");
    const original = password; setPassword("");
    try {
      const result = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password: original });
      if (!active.current || !isCurrent()) return;
      if (result.error || !result.data.session) setMessage("Не удалось войти. Проверьте почту, пароль и подтверждение почты.");
    } catch { if (active.current && isCurrent()) setMessage("Нет связи с сервером. Попробуйте позже."); }
    finally { submitting.current = false; if (active.current && isCurrent()) setBusy(false); }
  }
  return <section className="portal-form-layout max-w-md space-y-5"><h2 className="text-lg font-medium">Вход заявителя</h2>
    <p className="text-sm text-muted-foreground">Войдите с личной подтверждённой почтой. Для просмотра ранее отправленной заявки повторный переход по ссылке не нужен.</p>
    <form onSubmit={event => void signIn(event)} className="space-y-4">
      <label className="block text-sm">Почта<input className="neu-input mt-2 w-full" type="email" autoComplete="username" required maxLength={254} value={email} disabled={busy} onChange={e => setEmail(e.target.value)} /></label>
      <label className="block text-sm">Пароль<input className="neu-input mt-2 w-full" type="password" autoComplete="current-password" required value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
      <button className="neu-btn neu-btn-primary" type="submit" disabled={busy}><ArrowRight size={16} />{busy ? "Входим…" : "Войти"}</button>
    </form>{message && <p className="text-sm" role="status">{message}</p>}
  </section>;
}
