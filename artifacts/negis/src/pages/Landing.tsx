import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { ArrowRight } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { apiUrl } from '@/lib/api';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

const loginSchema = z.object({
  email: z.string().email('Неверный формат email'),
  password: z.string().min(6, 'Минимум 6 символов'),
});

const registerSchema = z.object({
  ownerName: z.string().min(1, 'Введите имя'),
  clinicName: z.string().min(1, 'Введите название'),
  email: z.string().email('Неверный формат email'),
  password: z.string().min(8, 'Минимум 8 символов'),
  confirmPassword: z.string().min(1, 'Подтвердите пароль'),
}).refine(d => d.password === d.confirmPassword, {
  message: 'Пароли не совпадают',
  path: ['confirmPassword'],
});

const resetSchema = z.object({
  email: z.string().email('Неверный формат email'),
});

const newPasswordSchema = z.object({
  password: z.string().min(8, 'Минимум 8 символов'),
  confirmPassword: z.string().min(1, 'Подтвердите пароль'),
}).refine(d => d.password === d.confirmPassword, {
  message: 'Пароли не совпадают',
  path: ['confirmPassword'],
});

type LoginValues      = z.infer<typeof loginSchema>;
type RegisterValues   = z.infer<typeof registerSchema>;
type ResetValues      = z.infer<typeof resetSchema>;
type NewPasswordValues = z.infer<typeof newPasswordSchema>;
type ModalState = 'idle' | 'choice' | 'login' | 'register' | 'reset' | 'newpassword';

const roleRoute = (role: string | null) => {
  if (role === 'owner' || role === 'manager') return '/dashboard';
  if (role === 'receptionist') return '/reception';
  return '/booking';
};

export default function Landing() {
  const [modalState, setModalState] = useState<ModalState>('idle');
  const [pressed,    setPressed]    = useState(false);
  const [visible,    setVisible]    = useState(false);
  const [isLoading,  setIsLoading]  = useState(false);
  const [error,      setError]      = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [, setLocation] = useLocation();
  const { session, userRole, isLoading: authLoading, clinicId } = useAuth();
  const modalRef = useRef<HTMLDivElement>(null);

  /* Auto-redirect if already authenticated (e.g. after dev login or page refresh) */
  useEffect(() => {
    if (!authLoading && session && clinicId) {
      setLocation(roleRoute(userRole));
    }
  }, [authLoading, session, clinicId, userRole]);

  const loginForm       = useForm<LoginValues>      ({ resolver: zodResolver(loginSchema) });
  const registerForm    = useForm<RegisterValues>   ({ resolver: zodResolver(registerSchema) });
  const resetForm       = useForm<ResetValues>      ({ resolver: zodResolver(resetSchema) });
  const newPasswordForm = useForm<NewPasswordValues>({ resolver: zodResolver(newPasswordSchema) });

  /* PASSWORD_RECOVERY is handled on the dedicated /reset-password page */

  useEffect(() => {
    if (modalState !== 'idle') {
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [modalState]);

  const openModal = () => {
    if (session) { setLocation(roleRoute(userRole)); return; }
    setError(''); setSuccessMsg('');
    loginForm.reset();
    registerForm.reset();
    setModalState('choice');
  };

  const closeModal = () => {
    setVisible(false);
    setTimeout(() => setModalState('idle'), 220);
  };

  const handleCircleClick = () => {
    setPressed(true);
    setTimeout(() => setPressed(false), 280);
    setTimeout(openModal, 80);
  };

  /* ── Login ── */
  const handleLogin = async (data: LoginValues) => {
    setIsLoading(true); setError('');
    try {
      const { data: authData, error } = await supabase.auth.signInWithPassword({
        email: data.email, password: data.password,
      });
      if (error) throw error;
      const { data: roleRow } = await supabase
        .from('user_roles').select('role')
        .eq('user_id', authData.user?.id).single();
      closeModal();
      setLocation(roleRoute(roleRow?.role ?? null));
    } catch (e: any) {
      setError(e.message || 'Ошибка входа');
    } finally { setIsLoading(false); }
  };

  /* Register */
  const handleRegister = async (data: RegisterValues) => {
    setIsLoading(true); setError('');
    try {
      const registerRes = await fetch(apiUrl('/api/auth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerName: data.ownerName,
          clinicName: data.clinicName,
          email: data.email,
          password: data.password,
        }),
      });

      const registerJson = await registerRes.json();
      if (!registerRes.ok) {
        throw new Error(registerJson.error || 'Registration failed');
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: data.email,
        password: data.password,
      });

      if (signInError) throw signInError;

      setLocation('/onboarding');
    } catch (e: any) {
      setError(e.message || 'Registration failed');
    } finally { setIsLoading(false); }
  };

  /* Reset password — send temp password via API ── */
  const handleSendReset = async (data: ResetValues) => {
    setIsLoading(true); setError(''); setSuccessMsg('');
    try {
      const res = await fetch(apiUrl('/api/auth/reset-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.email }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Ошибка сервера');
      setSuccessMsg('Письмо с паролем для входа отправлено. Проверьте почту.');
    } catch (e: any) {
      setError('Не удалось отправить письмо. Проверьте email и попробуйте снова.');
    } finally { setIsLoading(false); }
  };

  /* ── Set new password after recovery link ── */
  const handleNewPassword = async (data: NewPasswordValues) => {
    setIsLoading(true); setError(''); setSuccessMsg('');
    try {
      const { error } = await supabase.auth.updateUser({ password: data.password });
      if (error) throw error;
      setSuccessMsg('Пароль успешно изменён. Войдите с новым паролем.');
      setTimeout(() => { setModalState('login'); setSuccessMsg(''); }, 2200);
    } catch (e: any) {
      setError(e.message || 'Ошибка смены пароля');
    } finally { setIsLoading(false); }
  };

  /* ── Styles ── */
  const dropShadow = pressed
    ? '0 4px 10px rgba(15,23,42,0.18), 0 1px 3px rgba(15,23,42,0.12)'
    : '0 10px 28px rgba(15,23,42,0.18), 0 4px 10px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06)';

  const circleOuter: React.CSSProperties = {
    width: 320, height: 320, borderRadius: '50%',
    cursor: 'pointer', border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    position: 'relative',
    transition: 'box-shadow 0.18s ease', transform: 'none',
    background: 'linear-gradient(170deg, #DDE3EB 0%, #D8DEE6 40%, #CDD4DD 100%)',
    boxShadow: [
      dropShadow,
      'inset 0 1px 0 rgba(255,255,255,0.72)',
      'inset 0 -1px 3px rgba(15,23,42,0.10)',
      'inset 0 0 0 1px rgba(15,23,42,0.06)',
    ].join(', '),
  };

  const circleInner: React.CSSProperties = {
    width: 262, height: 262, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: pressed ? '#E8ECF2' : '#EEF2F6',
    boxShadow: pressed
      ? ['inset 0 3px 10px rgba(15,23,42,0.13)', 'inset 0 1px 4px rgba(15,23,42,0.08)', 'inset 0 -1px 2px rgba(255,255,255,0.50)'].join(', ')
      : ['inset 0 2px 7px rgba(15,23,42,0.08)', 'inset 0 1px 3px rgba(15,23,42,0.05)', 'inset 0 -1px 3px rgba(255,255,255,0.60)'].join(', '),
    transition: 'box-shadow 0.18s ease, background 0.18s ease',
    position: 'relative', flexShrink: 0,
  };

  const IS: React.CSSProperties = {
    background: '#F4F7FB', border: '1px solid #E7ECF3', borderRadius: 11,
    outline: 'none', padding: '11px 14px', width: '100%', fontSize: 14,
    color: '#0B1220', fontFamily: "'Inter', sans-serif",
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  };
  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = '#2859C5';
    e.target.style.boxShadow = '0 0 0 3px rgba(40,89,197,0.12)';
  };
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = '#E7ECF3';
    e.target.style.boxShadow = 'none';
  };
  const PrimaryBtn: React.CSSProperties = {
    background: '#1E325C', color: 'white', border: '1px solid #1E325C',
    borderRadius: 12, fontWeight: 500, fontSize: 14, padding: '12px 20px',
    cursor: isLoading ? 'not-allowed' : 'pointer', width: '100%',
    fontFamily: "'Inter', sans-serif", transition: 'background 0.15s ease',
    opacity: isLoading ? 0.65 : 1, letterSpacing: '0.01em',
  };
  const LinkBtn: React.CSSProperties = {
    background: 'none', border: 'none', color: '#2859C5', fontSize: 12,
    cursor: 'pointer', fontFamily: "'Inter', sans-serif",
    padding: 0, textDecoration: 'none',
    transition: 'color 0.15s ease',
  };

  const modalLabel =
    modalState === 'choice'      ? 'ВХОД В СИСТЕМУ'
    : modalState === 'login'     ? 'АВТОРИЗАЦИЯ'
    : modalState === 'register'  ? 'СОЗДАТЬ ПРОСТРАНСТВО'
    : modalState === 'reset'     ? 'ВОССТАНОВЛЕНИЕ ПАРОЛЯ'
    :                              'НОВЫЙ ПАРОЛЬ';

  return (
    <div
      className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden"
      style={{ background: '#F4F7FB' }}
    >
      {/* Crosshair */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" xmlns="http://www.w3.org/2000/svg" style={{ zIndex: 0 }}>
        <line x1="50%" y1="0" x2="50%" y2="calc(50% - 168px)" stroke="#DDE5EE" strokeWidth="1" />
        <circle cx="50%" cy="4" r="2" fill="#DDE5EE" />
        <line x1="50%" y1="100%" x2="50%" y2="calc(50% + 168px)" stroke="#DDE5EE" strokeWidth="1" />
        <circle cx="50%" cy="99.5%" r="2" fill="#DDE5EE" />
        <line x1="0" y1="50%" x2="calc(50% - 168px)" y2="50%" stroke="#DDE5EE" strokeWidth="1" />
        <circle cx="4" cy="50%" r="2" fill="#DDE5EE" />
        <line x1="100%" y1="50%" x2="calc(50% + 168px)" y2="50%" stroke="#DDE5EE" strokeWidth="1" />
        <circle cx="99.5%" cy="50%" r="2" fill="#DDE5EE" />
      </svg>

      {/* Core circle */}
      <div className="relative flex flex-col items-center gap-6" style={{ zIndex: 1 }}>
        <button
          onClick={handleCircleClick}
          data-testid="button-negis-main"
          style={circleOuter}
          onMouseEnter={e => {
            if (!pressed) (e.currentTarget as HTMLButtonElement).style.boxShadow =
              '0 14px 34px rgba(15,23,42,0.21), 0 5px 12px rgba(15,23,42,0.12), 0 1px 3px rgba(15,23,42,0.06), inset 0 1px 0 rgba(255,255,255,0.72), inset 0 -1px 3px rgba(15,23,42,0.10), inset 0 0 0 1px rgba(15,23,42,0.06)';
          }}
          onMouseLeave={e => {
            if (!pressed) (e.currentTarget as HTMLButtonElement).style.boxShadow =
              '0 10px 28px rgba(15,23,42,0.18), 0 4px 10px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06), inset 0 1px 0 rgba(255,255,255,0.72), inset 0 -1px 3px rgba(15,23,42,0.10), inset 0 0 0 1px rgba(15,23,42,0.06)';
          }}
        >
          <div style={circleInner}>
            <span style={{
              fontFamily: "'Inter', system-ui, sans-serif", fontWeight: 500,
              fontSize: 17, letterSpacing: '0.28em', color: '#475569',
              textTransform: 'uppercase', userSelect: 'none', position: 'relative',
              textShadow: '0 1px 0 rgba(255,255,255,0.70)',
            }}>
              NEGIS
            </span>
          </div>
        </button>

        <span style={{
          fontSize: 10, letterSpacing: '0.16em', color: '#B0BAC6',
          fontFamily: "'Inter', sans-serif", textTransform: 'uppercase', userSelect: 'none',
        }}>
          v1.0.0 — BUILD 2026
        </span>

        <a
          href="/privacy"
          style={{
            textAlign: 'center', fontSize: 11, color: '#B0BAC6',
            fontFamily: "'Inter', sans-serif", textDecoration: 'none',
            marginTop: 4, letterSpacing: '0.02em',
          }}
        >
          Политика конфиденциальности
        </a>
      </div>

      {/* Modal */}
      {modalState !== 'idle' && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{
            background: 'rgba(11,18,32,0.18)', backdropFilter: 'blur(8px)',
            transition: 'opacity 0.22s ease', opacity: visible ? 1 : 0,
          }}
          onClick={e => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div
            ref={modalRef}
            style={{
              background: '#FFFFFF', border: '1px solid #E7ECF3', borderRadius: 20,
              boxShadow: '0 24px 64px rgba(15,23,42,0.14), 0 4px 16px rgba(15,23,42,0.08)',
              width: '100%', maxWidth: 388, padding: '36px 32px',
              transition: 'transform 0.22s cubic-bezier(0.34,1.15,0.64,1), opacity 0.22s ease',
              transform: visible ? 'scale(1) translateY(0)' : 'scale(0.96) translateY(8px)',
              opacity: visible ? 1 : 0,
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
              <div style={{
                background: '#DDE5EE', borderRadius: 8, padding: '5px 10px',
                fontSize: 10, fontWeight: 600, letterSpacing: '0.18em', color: '#0B1220',
                fontFamily: "'Inter', sans-serif", textTransform: 'uppercase',
              }}>NEGIS</div>
              <span style={{ fontSize: 12, color: '#94A3B8', letterSpacing: '0.06em', fontFamily: "'Inter', sans-serif" }}>
                {modalLabel}
              </span>
            </div>

            {/* ── Choice ── */}
            {modalState === 'choice' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <ChoiceButton
                  label="Вход"
                  sub="Войти в существующее пространство"
                  onClick={() => { setError(''); setModalState('login'); }}
                  testId="button-choice-login"
                />
                <ChoiceButton
                  label="Создать пространство"
                  sub="Новая клиника с нуля"
                  onClick={() => { setError(''); setModalState('register'); }}
                  testId="button-choice-register"
                />
              </div>
            )}

            {/* ── Login ── */}
            {modalState === 'login' && (
              <form onSubmit={loginForm.handleSubmit(handleLogin)} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                <div>
                  <input type="email" placeholder="Email" style={IS} data-testid="input-email"
                    {...loginForm.register('email')} onFocus={onFocus} onBlur={onBlur} />
                  {loginForm.formState.errors.email && (
                    <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4, paddingLeft: 2 }}>
                      {loginForm.formState.errors.email.message}
                    </p>
                  )}
                </div>
                <div>
                  <input type="password" placeholder="Пароль" style={IS} data-testid="input-password"
                    {...loginForm.register('password')} onFocus={onFocus} onBlur={onBlur} />
                  {loginForm.formState.errors.password && (
                    <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4, paddingLeft: 2 }}>
                      {loginForm.formState.errors.password.message}
                    </p>
                  )}
                  {/* Forgot password — always visible */}
                  <div style={{ textAlign: 'right', marginTop: 6 }}>
                    <button type="button" style={LinkBtn}
                      onClick={() => { setError(''); setSuccessMsg(''); resetForm.reset(); setModalState('reset'); }}>
                      Забыли пароль?
                    </button>
                  </div>
                </div>
                {error && <p style={{ color: '#DC2626', fontSize: 13, textAlign: 'center' }}>{error}</p>}
                <button type="submit" style={{ ...PrimaryBtn, marginTop: 4 }} disabled={isLoading} data-testid="button-login">
                  {isLoading ? 'Вход...' : 'Войти'}
                </button>
                <BackLink label="Назад" onClick={() => setModalState('choice')} />
              </form>
            )}

            {/* ── Reset password (send email) ── */}
            {modalState === 'reset' && (
              <form onSubmit={resetForm.handleSubmit(handleSendReset)} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                <p style={{ fontSize: 13, color: '#64748B', fontFamily: "'Inter', sans-serif", lineHeight: 1.5, margin: 0 }}>
                  Укажите email вашего аккаунта — мы отправим ссылку для сброса пароля.
                </p>
                <div>
                  <input type="email" placeholder="Email" style={IS}
                    {...resetForm.register('email')} onFocus={onFocus} onBlur={onBlur} />
                  {resetForm.formState.errors.email && (
                    <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4, paddingLeft: 2 }}>
                      {resetForm.formState.errors.email.message}
                    </p>
                  )}
                </div>
                {error && <p style={{ color: '#DC2626', fontSize: 13, textAlign: 'center' }}>{error}</p>}
                {successMsg && (
                  <div style={{
                    background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10,
                    padding: '10px 14px', fontSize: 13, color: '#15803D',
                    fontFamily: "'Inter', sans-serif", lineHeight: 1.5,
                  }}>
                    {successMsg}
                  </div>
                )}
                {!successMsg && (
                  <button type="submit" style={{ ...PrimaryBtn, marginTop: 4 }} disabled={isLoading}>
                    {isLoading ? 'Отправка...' : 'Отправить письмо'}
                  </button>
                )}
                <BackLink label="Назад к входу" onClick={() => setModalState('login')} />
              </form>
            )}

            {/* ── New password (after recovery link) ── */}
            {modalState === 'newpassword' && (
              <form onSubmit={newPasswordForm.handleSubmit(handleNewPassword)} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                <p style={{ fontSize: 13, color: '#64748B', fontFamily: "'Inter', sans-serif", lineHeight: 1.5, margin: 0 }}>
                  Введите новый пароль для вашего аккаунта.
                </p>
                <div>
                  <input type="password" placeholder="Новый пароль (мин. 8 символов)" style={IS}
                    {...newPasswordForm.register('password')} onFocus={onFocus} onBlur={onBlur} />
                  {newPasswordForm.formState.errors.password && (
                    <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4, paddingLeft: 2 }}>
                      {newPasswordForm.formState.errors.password.message}
                    </p>
                  )}
                </div>
                <div>
                  <input type="password" placeholder="Подтвердите пароль" style={IS}
                    {...newPasswordForm.register('confirmPassword')} onFocus={onFocus} onBlur={onBlur} />
                  {newPasswordForm.formState.errors.confirmPassword && (
                    <p style={{ color: '#DC2626', fontSize: 12, marginTop: 4, paddingLeft: 2 }}>
                      {newPasswordForm.formState.errors.confirmPassword.message}
                    </p>
                  )}
                </div>
                {error && <p style={{ color: '#DC2626', fontSize: 13, textAlign: 'center' }}>{error}</p>}
                {successMsg && (
                  <div style={{
                    background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10,
                    padding: '10px 14px', fontSize: 13, color: '#15803D',
                    fontFamily: "'Inter', sans-serif", lineHeight: 1.5,
                  }}>
                    {successMsg}
                  </div>
                )}
                {!successMsg && (
                  <button type="submit" style={{ ...PrimaryBtn, marginTop: 4 }} disabled={isLoading}>
                    {isLoading ? 'Сохранение...' : 'Установить новый пароль'}
                  </button>
                )}
              </form>
            )}

            {/* ── Register ── */}
            {modalState === 'register' && (
              <form onSubmit={registerForm.handleSubmit(handleRegister)} style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {(
                  [
                    { name: 'ownerName',        placeholder: 'Ваше имя',                type: 'text'     },
                    { name: 'clinicName',        placeholder: 'Название клиники',        type: 'text'     },
                    { name: 'email',             placeholder: 'Email',                   type: 'email'    },
                    { name: 'password',          placeholder: 'Пароль (мин. 8 символов)', type: 'password' },
                    { name: 'confirmPassword',   placeholder: 'Подтвердите пароль',      type: 'password' },
                  ] as const
                ).map(({ name, placeholder, type }) => (
                  <div key={name}>
                    <input type={type} placeholder={placeholder} style={IS}
                      data-testid={`input-${name}`}
                      {...registerForm.register(name)}
                      onFocus={onFocus} onBlur={onBlur} />
                    {registerForm.formState.errors[name] && (
                      <p style={{ color: '#DC2626', fontSize: 12, marginTop: 3, paddingLeft: 2 }}>
                        {registerForm.formState.errors[name]?.message as string}
                      </p>
                    )}
                  </div>
                ))}
                {error && <p style={{ color: '#DC2626', fontSize: 13, textAlign: 'center' }}>{error}</p>}
                <button type="submit" style={{ ...PrimaryBtn, marginTop: 4 }} disabled={isLoading} data-testid="button-register">
                  {isLoading ? 'Создание...' : 'Создать пространство'}
                </button>
                <BackLink label="Назад" onClick={() => setModalState('choice')} />
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Choice Button ── */
function ChoiceButton({ label, sub, onClick, testId }: {
  label: string; sub: string; onClick: () => void; testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      style={{
        background: '#F4F7FB', border: '1px solid #E7ECF3', borderRadius: 14,
        padding: '16px 18px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        transition: 'all 0.15s ease', fontFamily: "'Inter', sans-serif",
        textAlign: 'left', width: '100%',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = '#EEF2F6'; el.style.borderColor = '#DDE5EE';
        el.style.transform = 'translateY(-1px)'; el.style.boxShadow = '0 4px 12px rgba(15,23,42,0.07)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = '#F4F7FB'; el.style.borderColor = '#E7ECF3';
        el.style.transform = 'translateY(0)'; el.style.boxShadow = 'none';
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#0B1220', marginBottom: 3 }}>{label}</div>
        <div style={{ fontSize: 12, color: '#94A3B8' }}>{sub}</div>
      </div>
      <ArrowRight size={16} color="#94A3B8" />
    </button>
  );
}

/* ── Back Link ── */
function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick}
      style={{
        background: 'none', border: 'none', color: '#94A3B8', fontSize: 12,
        cursor: 'pointer', textAlign: 'center', fontFamily: "'Inter', sans-serif",
        marginTop: 2, transition: 'color 0.15s ease',
      }}
      onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#475569')}
      onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = '#94A3B8')}
    >
      {label}
    </button>
  );
}
