import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { supabase } from '@/lib/supabase';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Eye, EyeOff } from 'lucide-react';

const schema = z.object({
  password: z.string().min(8, 'Минимум 8 символов'),
  confirm: z.string().min(1, 'Подтвердите пароль'),
}).refine(d => d.password === d.confirm, {
  message: 'Пароли не совпадают',
  path: ['confirm'],
});

type Values = z.infer<typeof schema>;
type PageState = 'loading' | 'form' | 'success' | 'expired';

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const [pageState, setPageState] = useState<PageState>('loading');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const form = useForm<Values>({ resolver: zodResolver(schema) });

  useEffect(() => {
    /* Listen for the PASSWORD_RECOVERY auth event emitted by Supabase
       when the recovery hash in the URL is detected */
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setPageState('form');
      }
    });

    /* In case the event already fired before the listener attached,
       also check the current session */
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setPageState(prev => prev === 'loading' ? 'form' : prev);
      }
    });

    /* If no recovery event arrives within 4 seconds, assume link is expired */
    const timer = setTimeout(() => {
      setPageState(prev => prev === 'loading' ? 'expired' : prev);
    }, 4000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  const handleSubmit = async (data: Values) => {
    setIsSubmitting(true);
    setError('');
    const { error: updateError } = await supabase.auth.updateUser({ password: data.password });
    setIsSubmitting(false);

    if (updateError) {
      const msg = updateError.message.toLowerCase();
      if (msg.includes('expired') || msg.includes('invalid') || msg.includes('token')) {
        setPageState('expired');
      } else {
        setError('Не удалось сменить пароль. Попробуйте запросить письмо ещё раз.');
      }
      return;
    }

    setPageState('success');
    setTimeout(() => setLocation('/'), 3000);
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
        }}>NEGIS</div>
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
                  onClick={() => setShowPass(p => !p)}
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
                  onClick={() => setShowConfirm(p => !p)}
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
                Перенаправляем на страницу входа...
              </p>
            </div>
            <button
              onClick={() => setLocation('/')}
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
              onClick={() => setLocation('/')}
              style={{
                background: '#1E325C', color: 'white', border: 'none',
                borderRadius: 12, fontWeight: 500, fontSize: 14,
                padding: '12px 20px', cursor: 'pointer', width: '100%',
                fontFamily: "'Inter', sans-serif",
              }}
            >
              Вернуться на главную
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
