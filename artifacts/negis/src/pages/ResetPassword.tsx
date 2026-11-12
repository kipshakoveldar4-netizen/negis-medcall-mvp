import { useState, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { consumeRecoverySessionProof, getRecoverySessionProof, supabase, sessionAuth } from '@/lib/supabase';
import { validatePasswordRules } from '../../../../lib/auth/password-rules';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Eye, EyeOff } from 'lucide-react';

const schema = z.object({
  // Правила — общие с сервером (lib/auth/password-rules.ts). Своя копия здесь
  // держала только минимум: пароль с хвостовым пробелом проходил, сохранялся
  // вместе с пробелом, а при передаче голосом пробел терялся — и человек
  // упирался в «Invalid login credentials», неотличимое от «пароль неверный».
  password: z.string().superRefine((value, ctx) => {
    for (const problem of validatePasswordRules(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }
  }),
  confirm: z.string().min(1, 'Подтвердите пароль'),
}).refine(d => d.password === d.confirm, {
  message: 'Пароли не совпадают',
  path: ['confirm'],
});

type Values = z.infer<typeof schema>;
type PageState = 'loading' | 'form' | 'success' | 'expired';
type RecoveryProof = NonNullable<ReturnType<typeof getRecoverySessionProof>>;
type RecoveryLifetime = {
  proofId: string;
  actorId: string;
  expiresAt: number;
  controller: AbortController;
  verified: boolean;
  receipt: RecoveryProof['stamp'] | null;
};
type RecoveryView = { state: PageState; scope: RecoveryLifetime | null };

/** Пришли сюда с /join за паролем? Тогда и возвращаться надо к приглашению. */
function hasPendingInvite(): boolean {
  try {
    return Boolean(window.sessionStorage.getItem('negis_pending_invite')?.trim());
  } catch {
    return false;
  }
}

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const [view, setView] = useState<RecoveryView>({ state: 'loading', scope: null });
  const pageState = view.state;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const mounted = useRef<object | null>(null);
  const lifetime = useRef<RecoveryLifetime | null>(null);
  const liveView = useRef<RecoveryView | null>(view);
  const pending = useRef<object | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const redirect = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);

  const form = useForm<Values>({ resolver: zodResolver(schema) });

  const owns = (scope: RecoveryLifetime | null): scope is RecoveryLifetime => Boolean(
    mounted.current && scope && lifetime.current === scope && !scope.controller.signal.aborted,
  );
  const currentView = () => mounted.current !== null && liveView.current === view;
  const futureExpiry = (value: number) => Number.isFinite(value) && value > Date.now();
  const currentStamp = (stamp: RecoveryProof['stamp']) => {
    try { return sessionAuth.isCurrent(stamp); } catch { return false; }
  };
  const publish = (state: PageState, scope: RecoveryLifetime | null) => {
    const next = { state, scope };
    liveView.current = next;
    setView(next);
    return next;
  };
  const clearTimers = () => {
    if (deadline.current !== null) clearTimeout(deadline.current);
    if (redirect.current !== null) clearTimeout(redirect.current);
    if (expiry.current !== null) clearTimeout(expiry.current);
    deadline.current = null; redirect.current = null; expiry.current = null;
  };
  const retire = () => {
    lifetime.current?.controller.abort();
    lifetime.current = null; pending.current = null;
    clearTimers();
    form.reset({ password: '', confirm: '' });
    setIsSubmitting(false); setError(''); setShowPass(false); setShowConfirm(false);
  };
  const expire = () => { retire(); publish('expired', null); };
  const navigateSuccess = (scope: RecoveryLifetime, expectedView: RecoveryView) => {
    if (!owns(scope) || liveView.current !== expectedView || expectedView.state !== 'success') return;
    if (!scope.receipt || !currentStamp(scope.receipt)) { expire(); return; }
    const destination = hasPendingInvite() ? '/join' : '/login';
    clearTimers();
    scope.controller.abort(); lifetime.current = null; liveView.current = null;
    setLocation(destination);
  };

  useLayoutEffect(() => {
    const mount = {};
    mounted.current = mount;
    retire(); publish('loading', null);
    let observed = false;
    const active = () => mounted.current === mount;
    const armDeadline = () => {
      if (deadline.current !== null) clearTimeout(deadline.current);
      const timer = setTimeout(() => {
        if (!active() || deadline.current !== timer) return;
        deadline.current = null;
        if (!lifetime.current?.verified) expire();
      }, 4000);
      deadline.current = timer;
    };
    const verify = (proof: RecoveryProof) => {
      if (!active()) return;
      if (!futureExpiry(proof.expiresAt)) { expire(); return; }
      const previous = lifetime.current;
      if (owns(previous) && previous.proofId === proof.id && previous.actorId === proof.actorId) {
        if (!futureExpiry(previous.expiresAt)) expire();
        return;
      }
      retire();
      const scope: RecoveryLifetime = { proofId: proof.id, actorId: proof.actorId, expiresAt: proof.expiresAt,
        controller: new AbortController(), verified: false, receipt: null };
      lifetime.current = scope;
      publish('loading', scope); armDeadline();
      // Return from the native auth callback before re-entering the SDK.
      void Promise.resolve().then(async () => {
        if (!active() || !owns(scope)) return;
        try {
          const { data, error } = await supabase.auth.getSession();
          if (!active() || !owns(scope)) return;
          const current = getRecoverySessionProof();
          if (error || data.session?.user.id !== scope.actorId || current?.id !== scope.proofId
            || current.actorId !== scope.actorId || !currentStamp(current.stamp)
            || !futureExpiry(current.expiresAt) || !futureExpiry(scope.expiresAt)) { expire(); return; }
          scope.expiresAt = Math.min(scope.expiresAt, current.expiresAt);
          scope.verified = true;
          if (deadline.current !== null) clearTimeout(deadline.current);
          deadline.current = null;
          const timer = setTimeout(() => {
            if (!active() || lifetime.current !== scope || expiry.current !== timer) return;
            expiry.current = null;
            expire();
          }, scope.expiresAt - Date.now());
          expiry.current = timer;
          publish('form', scope);
        } catch { if (active() && owns(scope)) expire(); }
      });
    };
    armDeadline();
    const { data: { subscription } } = sessionAuth.onAuthStateChange((event, session) => {
      if (!active()) return;
      observed = true;
      const scope = lifetime.current;
      if (event === 'SIGNED_OUT' || !session?.user.id) { expire(); return; }
      if (owns(scope) && scope.receipt) {
        if (session.user.id !== scope.actorId || !currentStamp(scope.receipt)) expire();
        return;
      }
      const proof = getRecoverySessionProof();
      if (!proof || proof.actorId !== session.user.id) { expire(); return; }
      verify(proof);
    });
    if (!observed) {
      const proof = getRecoverySessionProof();
      if (proof) verify(proof);
      else void Promise.resolve().then(async () => {
        if (!active() || observed || lifetime.current) return;
        try {
          const { data, error } = await supabase.auth.getSession();
          if (!active() || observed || lifetime.current) return;
          const current = getRecoverySessionProof();
          if (!error && current && current.actorId === data.session?.user.id) verify(current);
          else expire();
        } catch { if (active() && !observed && !lifetime.current) expire(); }
      });
    }
    return () => {
      mounted.current = null;
      lifetime.current?.controller.abort(); lifetime.current = null;
      pending.current = null; liveView.current = null;
      clearTimers(); subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (data: Values) => {
    const scope = view.scope;
    if (!currentView() || pageState !== 'form' || !owns(scope) || !scope.verified || pending.current) return;
    const proof = getRecoverySessionProof();
    if (proof?.id !== scope.proofId || proof.actorId !== scope.actorId
      || !futureExpiry(proof.expiresAt) || !futureExpiry(scope.expiresAt)) { expire(); return; }
    const attempt = {};
    pending.current = attempt;
    const current = () => currentView() && owns(scope) && pending.current === attempt
      && scope.proofId === proof.id && scope.actorId === proof.actorId && futureExpiry(scope.expiresAt);
    let receipt: RecoveryProof['stamp'] | null = null;
    const originalPassword = data.password;
    form.reset({ password: '', confirm: '' });
    setIsSubmitting(true); setError(''); setShowPass(false); setShowConfirm(false);
    try {
      const { data: result, error: updateError } = await sessionAuth.updateUserPassword(originalPassword, {
        expectedUserId: scope.actorId, expected: proof.stamp, signal: scope.controller.signal,
        isCurrent: current, onReceipt: stamp => { if (current()) receipt = stamp; },
      });
      if (!current()) return;
      if (!receipt || !currentStamp(receipt)) { expire(); return; }
      if (updateError) {
        const msg = updateError.message.toLowerCase();
        if (msg.includes('expired') || msg.includes('invalid') || msg.includes('token')) expire();
        else setError('Не удалось сменить пароль. Попробуйте запросить письмо ещё раз.');
        return;
      }
      if (result.user?.id !== scope.actorId) { expire(); return; }
      consumeRecoverySessionProof(scope.proofId);
      clearTimers();
      form.reset({ password: '', confirm: '' });
      pending.current = null; scope.receipt = receipt;
      setIsSubmitting(false);
      const success = publish('success', scope);
      redirect.current = setTimeout(() => navigateSuccess(scope, success), 3000);
    } catch {
      if (!current()) return;
      const currentProof = getRecoverySessionProof();
      if (currentProof?.id !== scope.proofId || currentProof.actorId !== scope.actorId) expire();
      else setError('Не удалось сменить пароль. Попробуйте запросить письмо ещё раз.');
    } finally {
      if (current()) { pending.current = null; setIsSubmitting(false); publish('form', scope); }
    }
  };

  /* ── Styles ── */
  const IS: React.CSSProperties = {
    background: '#F4F7FB', border: '1px solid #E7ECF3', borderRadius: 11,
    outline: 'none', padding: '11px 14px', width: '100%', fontSize: 14,
    color: '#0B1220', fontFamily: "'Inter', sans-serif",
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
    paddingRight: 42,
  };
  const focus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = '#2859C5';
    e.target.style.boxShadow = '0 0 0 3px rgba(40,89,197,0.12)';
  };
  const blur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = '#E7ECF3';
    e.target.style.boxShadow = 'none';
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-4"
      style={{ background: '#F4F7FB', fontFamily: "'Inter', sans-serif" }}
    >
      {/* Logo */}
      <div style={{ marginBottom: 32, textAlign: 'center' }}>
        <div style={{
          display: 'inline-block', background: '#DDE5EE', borderRadius: 8,
          padding: '5px 12px', fontSize: 11, fontWeight: 600,
          letterSpacing: '0.18em', color: '#0B1220', marginBottom: 8,
        }}>Medina OS</div>
        <p style={{ fontSize: 11, color: '#94A3B8', letterSpacing: '0.06em', margin: 0 }}>
          ВОССТАНОВЛЕНИЕ ПАРОЛЯ
        </p>
      </div>

      <div style={{
        background: '#FFFFFF', border: '1px solid #E7ECF3', borderRadius: 20,
        boxShadow: '0 24px 64px rgba(15,23,42,0.12), 0 4px 16px rgba(15,23,42,0.06)',
        width: '100%', maxWidth: 388, padding: '36px 32px',
      }}>

        {/* Loading */}
        {pageState === 'loading' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              border: '3px solid #E7ECF3', borderTopColor: '#1E325C',
              animation: 'spin 0.8s linear infinite', margin: '0 auto 16px',
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <p style={{ color: '#64748B', fontSize: 14, margin: 0 }}>Проверка ссылки...</p>
          </div>
        )}

        {/* Form */}
        {pageState === 'form' && (
          <form onSubmit={form.handleSubmit(handleSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            <p style={{ fontSize: 13, color: '#64748B', lineHeight: 1.5, margin: '0 0 4px' }}>
              Введите новый пароль для вашего аккаунта.
            </p>

            {/* New password */}
            <div>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPass ? 'text' : 'password'}
                  placeholder="Новый пароль (мин. 8 символов)"
                  style={IS}
                  {...form.register('password')}
                  onFocus={focus} onBlur={blur}
                />
                <button
                  type="button"
                  onClick={() => { if (currentView() && owns(view.scope) && !pending.current) setShowPass(p => !p); }}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                    color: '#94A3B8', display: 'flex',
                  }}
                >
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {form.formState.errors.password && (
                <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4, paddingLeft: 2 }}>
                  {form.formState.errors.password.message}
                </p>
              )}
            </div>

            {/* Confirm password */}
            <div>
              <div style={{ position: 'relative' }}>
                <input
                  type={showConfirm ? 'text' : 'password'}
                  placeholder="Повторите пароль"
                  style={IS}
                  {...form.register('confirm')}
                  onFocus={focus} onBlur={blur}
                />
                <button
                  type="button"
                  onClick={() => { if (currentView() && owns(view.scope) && !pending.current) setShowConfirm(p => !p); }}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                    color: '#94A3B8', display: 'flex',
                  }}
                >
                  {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {form.formState.errors.confirm && (
                <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4, paddingLeft: 2 }}>
                  {form.formState.errors.confirm.message}
                </p>
              )}
            </div>

            {error && (
              <p style={{ color: '#DC2626', fontSize: 13, textAlign: 'center', margin: 0 }}>{error}</p>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                background: '#1E325C', color: 'white', border: 'none',
                borderRadius: 12, fontWeight: 500, fontSize: 14,
                padding: '12px 20px', cursor: isSubmitting ? 'not-allowed' : 'pointer',
                width: '100%', opacity: isSubmitting ? 0.65 : 1,
                fontFamily: "'Inter', sans-serif",
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                marginTop: 4,
              }}
            >
              {isSubmitting ? 'Сохранение...' : <><Check size={15} /> Сохранить пароль</>}
            </button>
          </form>
        )}

        {/* Success */}
        {pageState === 'success' && (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{
              width: 52, height: 52, borderRadius: '50%',
              background: '#F0FDF4', border: '1px solid #BBF7D0',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto',
            }}>
              <Check size={24} color="#15803D" />
            </div>
            <div>
              <p style={{ fontWeight: 700, fontSize: 16, color: '#0B1220', margin: '0 0 6px' }}>
                Пароль обновлён
              </p>
              <p style={{ fontSize: 13, color: '#64748B', margin: 0, lineHeight: 1.5 }}>
                {hasPendingInvite() ? 'Возвращаемся к приглашению...' : 'Перенаправляем на страницу входа...'}
              </p>
            </div>
            <button
              onClick={() => { if (view.scope) navigateSuccess(view.scope, view); }}
              style={{
                background: '#1E325C', color: 'white', border: 'none',
                borderRadius: 12, fontWeight: 500, fontSize: 14,
                padding: '12px 20px', cursor: 'pointer', width: '100%',
                fontFamily: "'Inter', sans-serif",
              }}
            >
              Войти
            </button>
          </div>
        )}

        {/* Expired */}
        {pageState === 'expired' && (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{
              width: 52, height: 52, borderRadius: '50%',
              background: '#FEF2F2', border: '1px solid #FEE2E2',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto', fontSize: 22,
            }}>
              ⏱
            </div>
            <div>
              <p style={{ fontWeight: 700, fontSize: 15, color: '#0B1220', margin: '0 0 6px' }}>
                Ссылка недействительна
              </p>
              <p style={{ fontSize: 13, color: '#64748B', margin: 0, lineHeight: 1.6 }}>
                Ссылка восстановления пароля истекла или уже использована.
                Запросите письмо ещё раз.
              </p>
            </div>
            <button
              onClick={() => { if (currentView() && pageState === 'expired') { liveView.current = null; setLocation('/login'); } }}
              style={{
                background: '#1E325C', color: 'white', border: 'none',
                borderRadius: 12, fontWeight: 500, fontSize: 14,
                padding: '12px 20px', cursor: 'pointer', width: '100%',
                fontFamily: "'Inter', sans-serif",
              }}
            >
              Ко входу — там можно запросить письмо снова
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
