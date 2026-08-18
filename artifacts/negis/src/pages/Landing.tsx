import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { ArrowRight } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { isSyntheticEmail, loginOrEmailToAuthEmail } from '../../../../lib/auth/staff-logins';
import { useAuth } from '@/contexts/AuthContext';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

const loginSchema = z.object({
  // Логин или почта: z.string().email() отвергал бы «aigul.botanova» ещё до
  // отправки, и весь вход по логину был бы мёртв на этой странице.
  email: z.string().min(3, 'Введите логин или почту'),
  password: z.string().min(6, 'Минимум 6 символов'),
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
type ResetValues      = z.infer<typeof resetSchema>;
type NewPasswordValues = z.infer<typeof newPasswordSchema>;
type ModalState = 'idle' | 'choice' | 'login' | 'reset' | 'newpassword';


const roleRoute = (role: string | null) => {
  if (role === 'owner' || role === 'manager') return '/dashboard';
  // Регистратор начинает с заявок: экран приёма вёл на фикстуру без
  // источника данных и теперь перенаправляет сюда же.
  if (role === 'receptionist') return '/leads';
  return '/appointments';
};

export default function Landing() {
  const [modalState, setModalState] = useState<ModalState>('idle');
  const [pressed,    setPressed]    = useState(false);
  const [visible,    setVisible]    = useState(false);
  const [isLoading,  setIsLoading]  = useState(false);
  const [error,      setError]      = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [, setLocation] = useLocation();
  const { session, userRole, isLoading: authLoading, clinicId, isDemoMode } = useAuth();
  const modalRef = useRef<HTMLDivElement>(null);

  /* Auto-redirect if already authenticated (e.g. after dev login or page refresh) */
  useEffect(() => {
    if (!authLoading && clinicId && (session || isDemoMode)) {
      setLocation(roleRoute(userRole));
    }
  }, [authLoading, session, clinicId, userRole, isDemoMode]);

  const loginForm       = useForm<LoginValues>      ({ resolver: zodResolver(loginSchema) });
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
    // Условие — применённое членство, а не голая сессия: у вошедшего без
    // клиники roleRoute вёл на защищённый маршрут, тот отбрасывал обратно
    // сюда, и кнопка «Войти» становилась бесконечным пинг-понгом без выхода.
    if (session && clinicId) { setLocation(roleRoute(userRole)); return; }
    setError(''); setSuccessMsg('');
    loginForm.reset();
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
      // Тем же преобразованием, что применил сервер при заведении: две копии
      // разошлись бы, и человек получил бы «неверный логин или пароль».
      const { error } = await supabase.auth.signInWithPassword({
        email: loginOrEmailToAuthEmail(data.email), password: data.password,
      });
      if (error) throw error;
      // Security-1A: the post-login role lookup used to read `user_roles`,
      // which does not exist in production. Role and workspace are resolved by
      // AuthContext through the server API (/api/crm/staff); we simply land on
      // the default authenticated route and let that resolution drive access.
      closeModal();
      setLocation(roleRoute(null));
    } catch (e: any) {
      setError(e.message || 'Ошибка входа');
    } finally { setIsLoading(false); }
  };

  /* Reset password — send temp password via API ── */
  const handleSendReset = async (data: ResetValues) => {
    setIsLoading(true); setError(''); setSuccessMsg('');
    try {
      // Security-2D: /api/auth/reset-password does not exist and never did, so
      // this always failed. Supabase Auth already owns the recovery link that
      // handleNewPassword below consumes — ask it directly.
      // У входа по логину почты нет: письмо ушло бы в домен без MX, а плашка
      // «ссылка отправлена» стала бы ложью человеку, которому надо к
      // администратору.
      if (!data.email.includes('@') || isSyntheticEmail(data.email)) {
        setError('У логина нет почты — письмом пароль не восстановить. Попросите администратора клиники задать вам новый: «Настройки» → «Сотрудники» → «Новый пароль».');
        return;
      }
      const { error } = await supabase.auth.resetPasswordForEmail(data.email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setSuccessMsg('Ссылка для сброса пароля отправлена. Проверьте почту.');
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
    : modalState === 'reset'     ? 'ВОССТАНОВЛЕНИЕ ПАРОЛЯ'
    :                              'НОВЫЙ ПАРОЛЬ';

  return (
    <div className="min-h-screen" style={{ background: 'var(--negis-ground)' }}>

      {/* ── Шапка ─────────────────────────────────────────── */}
      <header
        className="mx-auto flex w-full max-w-[1180px] items-center gap-4 px-5 py-5 sm:px-8"
      >
        <span
          className="grid h-10 w-10 place-items-center rounded-full text-[15px] font-bold"
          style={{ background: 'var(--negis-black)', color: 'var(--negis-mint)' }}
          aria-hidden
        >
          M
        </span>
        <span className="text-[19px] font-bold tracking-tight" style={{ color: 'var(--negis-ink-strong)' }}>
          Medina&nbsp;OS
        </span>

        <nav className="ml-8 hidden items-center gap-7 lg:flex" aria-label="Разделы страницы">
          {[
            ['Как это работает', '#how'],
            ['Что внутри', '#what'],
            ['Безопасность', '#safety'],
          ].map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="text-sm font-medium transition-colors hover:opacity-70"
              style={{ color: 'var(--negis-muted-2)' }}
            >
              {label}
            </a>
          ))}
        </nav>

        <button
          type="button"
          onClick={openModal}
          data-testid="button-negis-main"
          className="ml-auto rounded-full px-6 py-2.5 text-sm font-semibold transition-transform active:scale-[0.98]"
          style={{
            background: 'var(--negis-black)',
            color: '#FFFFFF',
            boxShadow: 'var(--negis-shadow-soft)',
          }}
        >
          Войти
        </button>
      </header>

      {/* ── Первый экран ──────────────────────────────────── */}
      <section className="mx-auto grid w-full max-w-[1180px] gap-12 px-5 pb-4 pt-10 sm:px-8 lg:grid-cols-[1fr_minmax(0,520px)] lg:items-center lg:pt-16">
        <div>
          <p
            className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold"
            style={{ background: '#FFFFFF', color: 'var(--negis-ink-2)', boxShadow: 'var(--negis-shadow-soft)' }}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: 'var(--negis-success)' }} aria-hidden />
            Официальный WhatsApp Business API
          </p>

          <h1
            className="mt-7 text-[clamp(2.6rem,7vw,4.6rem)] font-bold leading-[1.03] tracking-[-0.035em]"
            style={{ color: 'var(--negis-ink-strong)' }}
          >
            Ни одна заявка<br />не теряется
          </h1>

          <p className="mt-6 max-w-[46ch] text-[17px] leading-relaxed" style={{ color: 'var(--negis-ink-2)' }}>
            Пациент пишет в WhatsApp — заявка уже в CRM: с телефоном, источником и ответственным.
            Повторное обращение с того же номера не создаёт вторую заявку.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={openModal}
              className="rounded-full px-8 py-4 text-[15px] font-semibold transition-transform active:scale-[0.98]"
              style={{
                background: 'var(--negis-black)',
                color: '#FFFFFF',
                boxShadow: 'var(--negis-shadow-lift)',
              }}
            >
              Войти в систему
            </button>
            <a
              href="#how"
              className="rounded-full px-8 py-4 text-[15px] font-semibold"
              style={{
                background: '#FFFFFF',
                color: 'var(--negis-ink-2)',
                boxShadow: 'var(--negis-shadow-soft)',
              }}
            >
              Как это работает
            </a>
          </div>

          {/* Честно про доступ: самостоятельной регистрации в продукте нет,
              и обещать её на первом экране нельзя. */}
          <p className="mt-5 text-[13.5px]" style={{ color: 'var(--negis-muted-2)' }}>
            Доступ новой клинике открывает владелец пространства — регистрация не самостоятельная.
          </p>
        </div>

        {/* Превью продукта: то, что человек увидит после входа */}
        <div
          className="overflow-hidden rounded-3xl"
          style={{ background: '#FFFFFF', boxShadow: 'var(--negis-shadow-lift)' }}
          aria-label="Пример экрана заявок"
        >
          <div
            className="flex items-center gap-2 px-5 py-3.5"
            style={{ background: 'var(--negis-ground)' }}
          >
            {[0, 1, 2].map(n => (
              <span key={n} className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--negis-border)' }} aria-hidden />
            ))}
            <span className="ml-3 text-[11px]" style={{ color: 'var(--negis-faint)' }}>
              medina.os / заявки
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2.5 px-5 pt-5">
            <div className="rounded-2xl px-4 py-3.5" style={{ background: 'var(--negis-mint)' }}>
              <p className="text-[11px] font-semibold" style={{ color: 'var(--negis-mint-deep)' }}>Новые</p>
              <p className="mt-1 text-[30px] font-bold leading-none tracking-tight" style={{ color: 'var(--negis-mint-ink)' }}>16</p>
            </div>
            {[['1', 'в работе'], ['4', 'без ответств.']].map(([n, l]) => (
              <div key={l} className="rounded-2xl px-4 py-3.5" style={{ background: 'var(--negis-ground)' }}>
                <p className="text-[11px] font-semibold" style={{ color: 'var(--negis-muted-2)' }}>{l}</p>
                <p className="mt-1 text-[30px] font-bold leading-none tracking-tight" style={{ color: 'var(--negis-ink-strong)' }}>{n}</p>
              </div>
            ))}
          </div>

          <ul className="px-5 pb-5 pt-4">
            {[
              ['Лаура Ким', 'WhatsApp', 'Новая', 'var(--negis-secondary)'],
              ['Жанна Абди', 'Instagram', 'В работе', 'var(--negis-warning)'],
              ['Мария Ли', 'Сайт', 'Записана', 'var(--negis-success)'],
            ].map(([name, src2, stage, color], idx) => (
              <li
                key={name}
                className="flex items-center gap-3 py-3"
                style={{ borderTop: idx ? '1px solid var(--negis-hair)' : 'none' }}
              >
                <span className="truncate text-[13.5px] font-medium" style={{ color: 'var(--negis-ink-strong)' }}>{name}</span>
                <span className="ml-auto hidden text-[12px] sm:inline" style={{ color: 'var(--negis-muted-2)' }}>{src2}</span>
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{ color, background: 'var(--negis-ground)' }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} aria-hidden />
                  {stage}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Три факта ─────────────────────────────────────── */}
      <section id="what" className="mx-auto grid w-full max-w-[1180px] gap-4 px-5 py-14 sm:px-8 md:grid-cols-3">
        {[
          ['Свой номер', 'Номер клиники остаётся её собственным — официальный Cloud API, без посредника между вами и пациентом.'],
          ['Без дублей', 'Повторное обращение с того же телефона попадает в существующую заявку, а не заводит вторую.'],
          ['Данные раздельно', 'Каждая клиника видит только своё. Это закреплено тестами, а не обещанием в договоре.'],
        ].map(([title, text]) => (
          <article
            key={title}
            className="rounded-3xl p-7"
            style={{ background: '#FFFFFF', boxShadow: 'var(--negis-shadow-soft)' }}
          >
            <span
              className="grid h-9 w-9 place-items-center rounded-full text-[15px] font-bold"
              style={{ background: 'var(--negis-mint-soft)', color: 'var(--negis-mint-deep)' }}
              aria-hidden
            >
              ✓
            </span>
            <h3 className="mt-4 text-[19px] font-semibold tracking-tight" style={{ color: 'var(--negis-ink-strong)' }}>{title}</h3>
            <p className="mt-2 text-[14px] leading-relaxed" style={{ color: 'var(--negis-muted-2)' }}>{text}</p>
          </article>
        ))}
      </section>

      {/* ── Как это работает ──────────────────────────────── */}
      <section id="how" className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8">
        <h2 className="text-[clamp(1.8rem,4vw,2.6rem)] font-bold tracking-[-0.03em]" style={{ color: 'var(--negis-ink-strong)' }}>
          Как это работает
        </h2>
        <p className="mt-3 text-[16px]" style={{ color: 'var(--negis-muted-2)' }}>
          Три шага, и обращения перестают теряться в переписке
        </p>

        <ol className="mt-9 grid gap-4 md:grid-cols-3">
          {[
            ['Пациент пишет', 'В WhatsApp клиники, из рекламы или с сайта — как ему удобно.'],
            ['Заявка создаётся сама', 'С телефоном, источником и стадией «Новая». Дубль не появится.'],
            ['Регистратор ведёт', 'Назначает ответственного, двигает по воронке, записывает на приём.'],
          ].map(([title, text], i2) => (
            <li
              key={title}
              className="rounded-3xl p-7"
              style={{ background: '#FFFFFF', boxShadow: 'var(--negis-shadow-soft)' }}
            >
              <span className="text-[26px] font-bold tabular-nums" style={{ color: 'var(--negis-hair)' }} aria-hidden>
                0{i2 + 1}
              </span>
              <h3 className="mt-3 text-[19px] font-semibold tracking-tight" style={{ color: 'var(--negis-ink-strong)' }}>{title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed" style={{ color: 'var(--negis-muted-2)' }}>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Безопасность ──────────────────────────────────── */}
      <section id="safety" className="mx-auto w-full max-w-[1180px] px-5 py-14 sm:px-8">
        <div className="rounded-3xl p-8 sm:p-11" style={{ background: 'var(--negis-dark)' }}>
          <h2 className="max-w-[22ch] text-[clamp(1.6rem,3.4vw,2.2rem)] font-bold leading-tight tracking-[-0.025em] text-white">
            Медицинские данные требуют другого отношения
          </h2>
          <p className="mt-4 max-w-[62ch] text-[15px]" style={{ color: 'var(--negis-dark-muted)' }}>
            Не строчка в футере, а то, что проверяется автоматически при каждой правке кода.
            Если проверка падает — изменение не выходит в продукт.
          </p>

          <dl className="mt-9 grid gap-6 sm:grid-cols-3">
            {[
              ['Клиника видит только своё', '51 проверка изоляции'],
              ['Отказ не выдаёт себя за успех', '9 проверок честности'],
              ['Ключи не попадают в браузер', '35 проверок доступа'],
            ].map(([title, count]) => (
              <div key={title}>
                <dt className="text-[15px] font-semibold" style={{ color: 'var(--negis-dark-text)' }}>{title}</dt>
                <dd className="mt-1.5 text-[13px] tabular-nums" style={{ color: 'var(--negis-dark-muted)' }}>{count}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── Финальный призыв ──────────────────────────────── */}
      <section className="mx-auto w-full max-w-[1180px] px-5 pb-14 sm:px-8">
        <div className="rounded-3xl px-8 py-11 text-center" style={{ background: 'var(--negis-mint)' }}>
          <h2 className="mx-auto max-w-[24ch] text-[clamp(1.5rem,3.2vw,2.1rem)] font-bold leading-tight tracking-[-0.025em]" style={{ color: 'var(--negis-mint-ink)' }}>
            Уже работаете с нами? Войдите и продолжайте
          </h2>
          <p className="mx-auto mt-3 max-w-[52ch] text-[15px]" style={{ color: 'var(--negis-mint-deep)' }}>
            Новой клинике доступ открывает владелец пространства: он заводит сотрудника и выдаёт роль.
          </p>
          <button
            type="button"
            onClick={openModal}
            className="mt-7 rounded-full px-9 py-4 text-[15px] font-semibold transition-transform active:scale-[0.98]"
            style={{ background: 'var(--negis-black)', color: '#FFFFFF', boxShadow: 'var(--negis-shadow-lift)' }}
          >
            Войти в систему
          </button>
        </div>
      </section>

      {/* ── Подвал ────────────────────────────────────────── */}
      <footer className="mx-auto w-full max-w-[1180px] px-5 pb-14 sm:px-8">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-7" style={{ borderColor: 'var(--negis-border)' }}>
          <span className="text-[14px] font-bold" style={{ color: 'var(--negis-ink-strong)' }}>Medina&nbsp;OS</span>
          <span className="text-[13px]" style={{ color: 'var(--negis-muted-2)' }}>CRM для медицинских клиник</span>
          <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
            <a href="/privacy" style={{ color: 'var(--negis-muted-2)' }}>Политика конфиденциальности</a>
            <a href="/terms" style={{ color: 'var(--negis-muted-2)' }}>Условия использования</a>
            <a href="/data-deletion" style={{ color: 'var(--negis-muted-2)' }}>Удаление данных</a>
          </div>
        </div>
      </footer>

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
                background: 'var(--negis-primary-soft)', borderRadius: 999, padding: '5px 10px',
                fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--negis-primary)',
                fontFamily: "'Inter', sans-serif", textTransform: 'uppercase',
              }}>MEDINA OS</div>
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
                {/* Security-2D: self-registration never worked — the endpoint wrote an
                    orphan workspace row and created no account — so the button is gone
                    rather than left as a CTA that cannot succeed. */}
                <p style={{ fontSize: 13, color: '#64748B', fontFamily: "'Inter', sans-serif", lineHeight: 1.5, margin: '2px 0 0', textAlign: 'center' }}>
                  Доступ для новой клиники открывает владелец пространства.
                </p>
              </div>
            )}

            {/* ── Login ── */}
            {modalState === 'login' && (
              <form onSubmit={loginForm.handleSubmit(handleLogin)} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                <div>
                  <input type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off"
                    spellCheck={false} placeholder="Логин или почта" style={IS} data-testid="input-email"
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
