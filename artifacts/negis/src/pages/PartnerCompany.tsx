import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Building2, ClipboardList, Users } from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import { PortalShell } from "@/components/portals/PortalShell";
import { PartnerCompanyApplication } from "@/components/contributors/PartnerCompanyApplication";
import { PartnerCompanyInbox } from "@/components/contributors/PartnerCompanyInbox";
import { supabase, sessionAuth, hasSupabaseFrontendEnv } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { CrmApiError } from "@/lib/api";
import { companyInboxRequestForActor, companyRequestForActor, companyWorkspaceRequestForActor } from "./partner-company-client";
import type { PartnerCompanyApplication as CompanyApplication } from "../../../../lib/crm/partner-company-contracts";

type Session = Readonly<{ id: string | null; epoch: number }>;
const navigation = [
  { id: "company", label: "Заявка компании", icon: Building2 },
  { id: "contributors", label: "Кабинет партнёра", icon: Users, href: "/contributors" },
  { id: "team", label: "Вход для команды", icon: ClipboardList, href: "/login" },
];

export default function PartnerCompany() {
  const { signOut } = useAuth();
  const [, navigate] = useLocation();
  const isNew = new URLSearchParams(useSearch()).get("new") === "1";
  const [session, setSession] = useState<Session | null>(null);
  const live = useRef<Session>({ id: null, epoch: 0 });
  const exiting = useRef(false);
  useLayoutEffect(() => {
    let alive = true, observed = false;
    const apply = (id: string | null) => {
      if (!alive || exiting.current) return;
      if (id !== live.current.id) live.current = Object.freeze({ id, epoch: live.current.epoch + 1 });
      setSession(live.current);
    };
    const { data } = sessionAuth.onAuthStateChange((_event, next) => { observed = true; apply(next?.user.id ?? null); });
    void Promise.resolve().then(() => supabase.auth.getSession()).then(({ data, error }) => { if (!observed) apply(error ? null : data.session?.user.id ?? null); }, () => { if (!observed) apply(null); });
    return () => { alive = false; live.current = { id: null, epoch: live.current.epoch + 1 }; data.subscription.unsubscribe(); };
  }, []);
  return <PortalShell title={isNew ? "Заявка компании" : "Мои заявки компаний"} homeHref="/partner-company" roleLabel="Подключение к Medina OS" activeId="company" items={navigation} onNavigate={() => navigate("/partner-company")}
    onSignOut={session?.id ? () => {
      if (exiting.current || live.current !== session) return;
      exiting.current = true;
      live.current = Object.freeze({ id: null, epoch: live.current.epoch + 1 });
      setSession(live.current);
      void signOut().catch(() => {});
    } : undefined}>
    {!session ? <p role="status">Проверяем вход…</p> : session.id
      ? <Company key={`${session.epoch}:${isNew}`} actorId={session.id} isCurrent={() => live.current === session} isNew={isNew} navigate={navigate} />
      : <CompanyLogin key={session.epoch} isCurrent={() => live.current === session} />}
  </PortalShell>;
}

function Company({ actorId, isCurrent, isNew, navigate }: { actorId: string; isCurrent(): boolean; isNew: boolean; navigate(path: string): void }) {
  const auth = useAuth();
  const latestAuth = useRef(auth);
  latestAuth.current = auth;
  const [denied, setDenied] = useState(false);
  const active = useRef(true);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const current = () => active.current && isCurrent();
  const request = useRef(companyRequestForActor(actorId, current)).current;
  const inboxRequest = useRef(companyInboxRequestForActor(actorId, current)).current;
  const workspaceRequest = useRef(companyWorkspaceRequestForActor(actorId, current)).current;
  async function openWorkspace(application: CompanyApplication, scope: { signal: AbortSignal; isCurrent(): boolean }) {
    const valid = () => current() && !scope.signal.aborted && scope.isCurrent();
    if (!valid()) throw new DOMException("Account changed", "AbortError");
    if (application.state !== "approved" || !application.workspaceId)
      throw new CrmApiError(409, "partner_company_changed", "Компания ещё не доступна для входа.");
    const context = latestAuth.current;
    if (context.isLoading) throw new CrmApiError(503, "partner_company_unconfirmed", "Дождитесь проверки текущего аккаунта и повторите.");
    if (context.isDemoMode || context.isImpersonation || context.isSigningOut
      || context.user?.id !== actorId || context.session?.user.id !== actorId)
      throw new CrmApiError(403, "partner_company_access_denied", "Текущий аккаунт не подтверждён.");
    if (!await context.enterWorkspace(application.workspaceId, { expectedUserId: actorId, signal: scope.signal, isCurrent: valid,
      confirm: async () => {
        if (!valid()) throw new DOMException("Account changed", "AbortError");
        const confirmed = await workspaceRequest({ applicationId: application.id, revision: application.revision,
          signal: scope.signal, isCurrent: valid });
        if (!valid()) throw new DOMException("Account changed", "AbortError");
        if (confirmed.workspaceId?.toLowerCase() !== application.workspaceId?.toLowerCase())
          throw new CrmApiError(503, "partner_company_unconfirmed", "Не удалось подтвердить выбранную компанию.");
      } })) {
      if (!valid()) throw new DOMException("Account changed", "AbortError");
      throw new CrmApiError(503, "partner_company_unconfirmed", "Не удалось открыть выбранную компанию. Обновите доступ и повторите.");
    }
  }
  const refuse = () => { if (current()) setDenied(true); };
  return denied ? <section className="portal-form-layout space-y-4" role="alert"><h2 className="font-medium">Доступ к заявке изменился</h2>
    <p>Проверьте текущий аккаунт и права доступа. Для новой заявки нужна подтверждённая личная почта. Прежние данные скрыты.</p>
    <Link href="/login" className="neu-btn"><ArrowRight size={16} />Вход для команды</Link></section>
    : isNew ? <><button type="button" className="neu-btn mb-4" onClick={() => { if (current()) navigate("/partner-company"); }}><ClipboardList size={16} />Мои заявки</button>
      <PartnerCompanyApplication actorId={actorId} request={request} isSessionCurrent={current} onAccessDenied={refuse} /></>
    : <PartnerCompanyInbox actorId={actorId} request={inboxRequest} isSessionCurrent={current} onAccessDenied={refuse}
      onOpenWorkspace={openWorkspace}
      onNewApplication={() => { if (current()) navigate("/partner-company?new=1"); }} />;
}

function CompanyLogin({ isCurrent }: { isCurrent(): boolean }) {
  const [form, setForm] = useState<object>({});
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const liveForm = useRef(form);
  const mounted = useRef<object | null>(null), submission = useRef<object | null>(null);
  const current = () => mounted.current !== null && liveForm.current === form && isCurrent();
  useLayoutEffect(() => {
    const lifetime = {};
    mounted.current = lifetime;
    return () => { mounted.current = null; submission.current = null; };
  }, []);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    const lifetime = mounted.current;
    if (!lifetime || !current() || submission.current) return;
    if (!hasSupabaseFrontendEnv) { setMessage("Вход пока не настроен."); return; }
    const attempt = {};
    const credentials = { email: email.trim().toLowerCase(), password };
    submission.current = attempt;
    const valid = () => mounted.current === lifetime && liveForm.current === form && submission.current === attempt && isCurrent();
    setBusy(true); setMessage(""); setPassword("");
    try {
      const result = await sessionAuth.signInWithPassword(credentials, { expectedUserId: null, isCurrent: valid });
      if (!valid()) return;
      if (result.error || !result.data.session) setMessage("Не удалось войти. Проверьте почту, пароль и подтверждение почты.");
    } catch { if (valid()) setMessage("Нет связи с сервером. Попробуйте позже."); }
    finally {
      const stillCurrent = valid();
      if (submission.current === attempt) submission.current = null;
      if (stillCurrent) {
        // Settled form callbacks must not reuse captured credentials.
        const next = {};
        liveForm.current = next;
        setForm(next); setBusy(false);
      }
    }
  }
  return <section className="portal-form-layout max-w-md space-y-5"><h2 className="text-lg font-medium">Вход заявителя</h2>
    <p className="text-sm text-muted-foreground">Войдите с личной подтверждённой почтой. Для просмотра ранее отправленной заявки повторный переход по ссылке не нужен.</p>
    <form onSubmit={event => void signIn(event)} className="space-y-4">
      <label className="block text-sm">Почта<input className="neu-input mt-2 w-full" type="email" autoComplete="username" required maxLength={254} value={email} disabled={busy} onChange={e => { if (current() && !submission.current) setEmail(e.target.value); }} /></label>
      <label className="block text-sm">Пароль<input className="neu-input mt-2 w-full" type="password" autoComplete="current-password" required value={password} disabled={busy} onChange={e => { if (current() && !submission.current) setPassword(e.target.value); }} /></label>
      <button className="neu-btn neu-btn-primary" type="submit" disabled={busy}><ArrowRight size={16} />{busy ? "Входим…" : "Войти"}</button>
    </form>{message && <p className="text-sm" role="status">{message}</p>}
  </section>;
}
