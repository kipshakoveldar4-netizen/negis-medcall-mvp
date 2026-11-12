import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { KeyRound, User, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { supabase, sessionAuth, verifyCurrentPassword } from '@/lib/supabase';
import { profileSessionIdentity, updateProfileForSession } from '@/lib/profileSession';
import { PASSWORD_RULE_HINT, validatePasswordRules } from '../../../../../lib/auth/password-rules';
import { PushSettings } from './PushSettings';
import { isSyntheticEmail, loginFromEmail } from '../../../../../lib/auth/staff-logins';

// Личный кабинет сотрудника: имя и свой пароль. Живёт отдельным файлом, потому
// что открывается с двух поверхностей — из бокового меню и из мобильного ящика.
// Пока диалог был вшит в Sidebar, а Sidebar скрыт классом `hidden md:block`,
// сменить себе пароль с телефона было нельзя вообще, а именно с телефонов
// работает смена в салоне.
//
// Три правила этого экрана:
//
//   — пароль меняет ТОЛЬКО владелец аккаунта и только предъявив текущий:
//     аккаунт Supabase глобален, одна учётка бывает членом нескольких клиник,
//     и смена пароля — это операция над аккаунтом, а не над строкой staff_users;
//   — под имперсонацией диалог не пишет НИЧЕГО, включая имя. Сессия там
//     принадлежит владельцу клиники (её выдаёт магической ссылкой
//     /api/impersonation/session), а user_metadata.full_name — поле того же
//     глобального аккаунта: сотрудник платформы переименовал бы владельца во
//     всех его клиниках, и выглядело бы это как действие самого владельца.
//     Ревью поймало ровно это: запрет стоял только на ветке пароля;
//   — правила пароля берутся из общего модуля, теми же восемью символами, что
//     требует сервер при выдаче пароля админом.

// Диалог монтируется только на время показа — поэтому поля берут текущее имя
// при открытии, а не однажды при загрузке приложения, когда user ещё null.
type ProfileDialogProps = {
  onClose: () => void;
};

/**
 * Ошибки GoTrue приходят по-английски, а интерфейс русский (инвариант проекта).
 * Разбор по подстроке, а не по коду: auth-js кодов не обещает.
 */
function authErrorText(message: string): string {
  const text = message.toLowerCase();
  if (text.includes('weak') || text.includes('pwned') || text.includes('easy to guess')) {
    return 'Такой пароль слишком простой — придумайте другой.';
  }
  if (text.includes('rate limit') || text.includes('too many')) {
    return 'Слишком много попыток. Подождите пару минут и повторите.';
  }
  if (text.includes('session') || text.includes('refresh token') || text.includes('jwt')) {
    return 'Сессия истекла — войдите заново и повторите смену пароля.';
  }
  if (text.includes('same password') || text.includes('should be different')) {
    return 'Новый пароль совпадает со старым.';
  }
  if (text.includes('failed to fetch') || text.includes('network')) {
    return 'Нет связи с сервером. Проверьте интернет и повторите.';
  }
  return 'Не удалось сохранить — попробуйте ещё раз.';
}

function clearPasswordInputs(element: HTMLDivElement | null) {
  element?.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => {
    input.value = ''; input.defaultValue = ''; input.removeAttribute('value');
  });
}

export function ProfileDialog({ onClose }: ProfileDialogProps) {
  const { user, session, isImpersonation, isDemoMode, isSigningOut, applyConfirmedProfile,
    clinicId, userRole, workspacePurpose, vertical, rolePermissions } = useAuth();
  const [fullName, setFullName] = useState(user?.user_metadata?.full_name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [, setSessionRevision] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const connectRoot = useRef((element: HTMLDivElement | null) => {
    // A context-change render can remove the form before layout effects run.
    // Clear its owned controls at detachment, while the DOM reference exists.
    if (root.current !== element) clearPasswordInputs(root.current);
    root.current = element;
  });
  const contextKey = JSON.stringify([user?.id, user?.email, profileSessionIdentity(session), isImpersonation, isDemoMode, isSigningOut]);
  const focusContextKey = JSON.stringify([contextKey, clinicId, userRole, workspacePurpose, vertical,
    Object.entries(rolePermissions ?? {}).sort(([left], [right]) => left.localeCompare(right))]);
  const focusScope = useRef({ key: focusContextKey, valid: true, generation: 0 });
  if (focusScope.current.key !== focusContextKey) focusScope.current.valid = false;
  const lifetime = useRef({ key: contextKey, mounted: false, invalidated: false, closed: false,
    sdkIdentity: profileSessionIdentity(session), sdkToken: session?.access_token });
  const pending = useRef<{ abort: AbortController } | null>(null);
  if (lifetime.current.key !== contextKey) {
    lifetime.current.invalidated = true;
    pending.current?.abort.abort();
  }
  const isCurrent = () => lifetime.current.mounted && !lifetime.current.invalidated
    && lifetime.current.key === contextKey && !isSigningOut;
  const clearSecrets = () => {
    setCurrentPassword(''); setNewPassword(''); setRepeatPassword('');
    clearPasswordInputs(root.current);
  };
  const invalidate = () => {
    lifetime.current.invalidated = true;
    pending.current?.abort.abort();
    pending.current = null;
    clearSecrets(); setFullName(''); setSaving(false); setSessionRevision(value => value + 1);
    if (!lifetime.current.closed) { lifetime.current.closed = true; onClose(); }
  };
  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
      pending.current?.abort.abort(); pending.current = null;
      clearPasswordInputs(root.current);
    };
  }, []);
  useLayoutEffect(() => {
    let active = true;
    const subscription = sessionAuth.onAuthStateChange((event, next) => {
      if (!active || !lifetime.current.mounted) return;
      const identity = profileSessionIdentity(next);
      const replacedWithoutIdentity = event === 'SIGNED_IN' && identity === next?.user.id
        && next?.access_token !== lifetime.current.sdkToken;
      if (identity !== lifetime.current.sdkIdentity || replacedWithoutIdentity) invalidate();
      lifetime.current.sdkIdentity = identity;
      lifetime.current.sdkToken = next?.access_token;
    }).data.subscription;
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  useLayoutEffect(() => {
    if (lifetime.current.invalidated) invalidate();
  }, [contextKey]);

  const email = user?.email ?? '';
  // У входа по логину почты нет: показывать служебный адрес нельзя (человек
  // решит, что это его почта), и обещать восстановление письмом — тоже.
  const displayLogin = loginFromEmail(email);
  const withoutMailbox = isSyntheticEmail(email);
  const initials = (user?.user_metadata?.full_name ?? email ?? 'U')
    .split(' ').map((word: string) => word[0]).join('').slice(0, 2).toUpperCase();

  // Настоящая своя сессия Supabase — единственное, что даёт право писать в этот
  // аккаунт. В демо-режиме её нет, под имперсонацией она чужая.
  const canEditAccount = Boolean(session?.user?.id) && !isImpersonation && !isDemoMode
    && session?.user.id === user?.id && !isSigningOut;
  const canChangePassword = canEditAccount && Boolean(email);
  const blockedReason = isImpersonation
    ? 'Вы вошли как владелец клиники по ссылке из панели платформы. Его профиль и пароль меняет он сам в своём кабинете.'
    : 'Профиль доступен после обычного входа по почте и паролю.';

  const close = () => {
    // Во время записи закрывать нельзя: сохранение — несколько обращений к сети
    // подряд, и человек, тапнувший «Отмена» на медленной связи, уходил
    // уверенным, что отменил, а пароль тем временем менялся.
    if (!isCurrent() || pending.current) return;
    if (saving) return;
    lifetime.current.invalidated = true;
    clearSecrets();
    onClose();
  };

  const save = async () => {
    if (!isCurrent()) return;
    if (!canEditAccount) { toast.error(blockedReason); return; }
    if (pending.current || !user?.id || session?.user.id !== user.id) return;

    const name = fullName.trim();
    if (!name) { toast.error('Введите имя'); return; }

    // Намерение сменить пароль определяют ТОЛЬКО поля нового пароля. Пока в
    // счёт шло и поле «текущий», менеджер паролей подставлял его сам — и
    // человек, менявший одно лишь имя, упирался в «Пароль — не короче 8
    // символов» про поле, которого он не трогал.
    const wantsPasswordChange = newPassword.length > 0 || repeatPassword.length > 0;
    if (wantsPasswordChange) {
      if (!canChangePassword) { toast.error(blockedReason); return; }
      if (!currentPassword) { toast.error('Введите текущий пароль — без него пароль не меняем'); return; }
      const problems = validatePasswordRules(newPassword);
      if (problems.length > 0) { toast.error(problems[0]); return; }
      if (newPassword !== repeatPassword) {
        // Опечатка в новом пароле — это потерянный доступ: человек выйдет и не
        // войдёт, а вернуть сможет только администратор клиники.
        toast.error('Пароли не совпадают — повторите новый пароль без ошибок');
        return;
      }
      if (newPassword === currentPassword) { toast.error('Новый пароль совпадает со старым'); return; }
    }

    const operation = { abort: new AbortController() };
    const sourceSession = session && { access_token: session.access_token, refresh_token: session.refresh_token, user: session.user };
    if (!sourceSession) return;
    pending.current = operation;
    const operationCurrent = () => isCurrent() && pending.current === operation && !operation.abort.signal.aborted;
    setSaving(true);
    try {
      if (wantsPasswordChange) {
        const check = await verifyCurrentPassword(email, currentPassword);
        if (!operationCurrent()) return;
        if (check === 'wrong') { toast.error('Текущий пароль неверный'); return; }
        if (check === 'unavailable') {
          // Сеть, 429 или сбой сервера — это НЕ «пароль неверный». Ложный
          // диагноз здесь отправлял человека просить сброс на пустом месте.
          toast.error('Не удалось проверить текущий пароль — связь не отвечает. Попробуйте через минуту.');
          return;
        }
      }

      const updates: { data?: { full_name: string }; password?: string } = { data: { full_name: name } };
      if (wantsPasswordChange) updates.password = newPassword;
      const confirmed = await updateProfileForSession(sourceSession, updates, operationCurrent, operation.abort.signal);
      if (!operationCurrent()) return;
      // Commit the metadata-only update while this dialog still owns its guard;
      // closing/unmounting below must not turn a queued update into a late write.
      flushSync(() => applyConfirmedProfile(confirmed, operationCurrent));
      if (!operationCurrent()) return;

      toast.success(wantsPasswordChange ? 'Пароль изменён — входите с новым' : 'Имя сохранено');
      clearSecrets();
      setSaving(false);
      pending.current = null;
      lifetime.current.invalidated = true;
      onClose();
      return;
    } catch (error: unknown) {
      if (operationCurrent()) toast.error(authErrorText(error instanceof Error ? error.message : ''));
    } finally {
      const current = operationCurrent();
      if (pending.current === operation) pending.current = null;
      sourceSession.access_token = ''; sourceSession.refresh_token = '';
      if (current) { clearSecrets(); setSaving(false); }
    }
  };

  const modalClose = useRef(close);
  modalClose.current = close;
  const maintainFocus = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const panel = root.current?.querySelector<HTMLDivElement>('[role="dialog"]');
    if (!panel || !isCurrent()) return;
    const doc = panel.ownerDocument, view = doc.defaultView;
    if (!view) return;
    const trigger = doc.activeElement instanceof view.HTMLElement ? doc.activeElement : null;
    const generation = ++focusScope.current.generation;
    let active = true;
    const scroll = { x: view.scrollX, y: view.scrollY };
    const styles: Array<{ element: HTMLElement; property: string; value: string; priority: string; owned: string }> = [];
    const lockStyle = (element: HTMLElement, property: string, value: string) => {
      styles.push({ element, property, value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property), owned: value });
      element.style.setProperty(property, value, 'important');
    };
    // Screen changes revoke opener restoration, not containment of a profile
    // that still belongs to the current personal account/session.
    const live = () => active && panel.isConnected && isCurrent();
    const available = (element: HTMLElement) => element.isConnected && !element.matches(':disabled')
      && !element.closest('[inert], [hidden], [aria-hidden="true"]')
      && element.getClientRects().length > 0 && view.getComputedStyle(element).visibility === 'visible';
    const controls = () => Array.from(panel.querySelectorAll<HTMLElement>(
      'button, input:not([type="hidden"]), select, textarea, a[href], [tabindex], [contenteditable="true"]',
    )).filter(element => element.tabIndex >= 0 && available(element));
    const focusInside = () => (controls()[0] ?? panel).focus();
    const ensureFocus = () => {
      if (live() && (!panel.contains(doc.activeElement)
        || (doc.activeElement instanceof view.HTMLElement && !available(doc.activeElement)))) focusInside();
    };
    const containKeys = (event: globalThis.KeyboardEvent) => {
      if (!live()) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); modalClose.current(); return;
      }
      if (event.key !== 'Tab') return;
      const items = controls(), first = items[0], last = items[items.length - 1];
      const outside = !items.includes(doc.activeElement as HTMLElement);
      if (!first || !last) { event.preventDefault(); panel.focus({ preventScroll: true }); return; }
      if (event.shiftKey ? doc.activeElement === first || outside : doc.activeElement === last || outside) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    doc.addEventListener('focusin', ensureFocus, true);
    doc.addEventListener('keydown', containKeys, true);
    maintainFocus.current = ensureFocus;
    // Keep backdrop gestures off the page, including mobile overscroll. The
    // dialog retains its own scroll; cleanup restores only still-owned styles.
    lockStyle(doc.documentElement, 'overflow', 'hidden');
    lockStyle(doc.documentElement, 'overscroll-behavior', 'none');
    lockStyle(doc.body, 'overflow', 'hidden');
    lockStyle(doc.body, 'position', 'fixed');
    lockStyle(doc.body, 'top', `${-scroll.y}px`);
    lockStyle(doc.body, 'left', `${-scroll.x}px`);
    lockStyle(doc.body, 'width', '100%');
    focusInside();
    return () => {
      active = false;
      doc.removeEventListener('focusin', ensureFocus, true);
      doc.removeEventListener('keydown', containKeys, true);
      if (maintainFocus.current === ensureFocus) maintainFocus.current = null;
      for (const { element, property, value, priority, owned } of styles) {
        if (element.style.getPropertyValue(property) !== owned || element.style.getPropertyPriority(property) !== 'important') continue;
        if (value) element.style.setProperty(property, value, priority); else element.style.removeProperty(property);
      }
      // Access/context loss releases the lock without scrolling a replacement screen.
      if (focusScope.current.valid && !lifetime.current.closed) view.scrollTo(scroll.x, scroll.y);
      // Normal close/success invalidates without `closed`; auth invalidation
      // sets `closed`. A raw unmount must not restore an old screen's opener.
      if (!lifetime.current.invalidated || lifetime.current.closed) return;
      // The main subscription has unmounted, but an SDK A/B/A can still run
      // before the queued focus return. Observe only that short focus handoff.
      const identity = lifetime.current.sdkIdentity, token = lifetime.current.sdkToken;
      const subscription = sessionAuth.onAuthStateChange((event, next) => {
        const nextIdentity = profileSessionIdentity(next);
        if (nextIdentity !== identity || (event === 'SIGNED_IN' && nextIdentity === next?.user.id
          && next?.access_token !== token)) focusScope.current.valid = false;
      }).data.subscription;
      queueMicrotask(() => {
        subscription.unsubscribe();
        if (focusScope.current.generation !== generation || !focusScope.current.valid
          || lifetime.current.closed || !trigger || !available(trigger)) return;
        // Wait for removal and never steal focus from a replacement surface.
        const focused = doc.activeElement;
        if (focused && focused !== doc.body && focused !== doc.documentElement && !panel.contains(focused)) return;
        trigger.focus({ preventScroll: true });
      });
    };
  }, []);
  useLayoutEffect(() => { maintainFocus.current?.(); });

  if (lifetime.current.invalidated) return null;

  return (
    <div
      ref={connectRoot.current}
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'rgba(17, 24, 39, 0.4)' }}
      onClick={event => { if (event.target === event.currentTarget) close(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label="Профиль сотрудника"
        className="max-h-[90dvh] w-full max-w-[360px] overflow-y-auto rounded-xl border bg-white p-7"
        style={{ borderColor: 'var(--negis-border)', boxShadow: '0 20px 45px rgba(17, 24, 39, 0.18)' }}
      >
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-lg text-[13px] font-semibold"
              style={{ background: 'var(--negis-primary-soft)', color: 'var(--negis-primary)' }}
            >
              {initials}
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--negis-text)' }}>
                {user?.user_metadata?.full_name || 'Профиль'}
              </div>
              <div className="mt-0.5 text-xs" style={{ color: 'var(--negis-muted)' }}>{displayLogin}</div>
            </div>
          </div>
          <button type="button" onClick={close} disabled={saving} aria-label="Закрыть профиль" className="neu-icon-btn" style={{ height: 32, width: 32 }}>
            <X size={15} aria-hidden />
          </button>
        </div>

        {!canEditAccount ? (
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--negis-muted)' }}>{blockedReason}</p>
        ) : (
          <div className="space-y-4">
            <div>
              <label htmlFor="profile-full-name" className="mb-1.5 block text-[11px] font-medium" style={{ color: 'var(--negis-muted)' }}>
                <User size={11} aria-hidden style={{ display: 'inline', marginRight: 5 }} />
                ИМЯ
              </label>
              <input
                id="profile-full-name"
                className="neu-input"
                placeholder="Ваше имя"
                value={fullName}
                disabled={saving}
                onChange={event => { if (isCurrent() && !pending.current) setFullName(event.target.value); }}
              />
              {/* Честно: это имя видит только сам человек. В списке сотрудников,
                  в записях и в отчётах стоит staff_users.full_name, и правит
                  его администратор. Обещать обратное значило бы, что мастер
                  после замужества «уже поменяла», а клиника видит старую
                  фамилию. */}
              <p className="mt-1 text-[11px]" style={{ color: 'var(--negis-muted)' }}>
                Так вас видите вы. В списке сотрудников имя меняет администратор клиники.
              </p>
            </div>

            {/* Уведомления живут здесь же: диалог открывается и из бокового
                меню, и из мобильного ящика, а мастера работают с телефона. */}
            <PushSettings />

            <div className="border-t pt-4" style={{ borderColor: 'var(--negis-border)' }}>
              <div className="mb-3 flex items-center gap-2">
                <KeyRound size={13} aria-hidden style={{ color: 'var(--negis-muted)' }} />
                <span className="text-[11px] font-medium" style={{ color: 'var(--negis-muted)' }}>СМЕНА ПАРОЛЯ</span>
              </div>

              {canChangePassword ? (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="profile-current-password" className="mb-1.5 block text-[11px]" style={{ color: 'var(--negis-muted)' }}>
                      ТЕКУЩИЙ ПАРОЛЬ
                    </label>
                    <input
                      id="profile-current-password"
                      type="password"
                      autoComplete="current-password"
                      className="neu-input"
                      placeholder="Тот, которым вы вошли"
                      value={currentPassword}
                      disabled={saving}
                      onChange={event => { if (isCurrent() && !pending.current) setCurrentPassword(event.target.value); }}
                    />
                  </div>
                  <div>
                    <label htmlFor="profile-new-password" className="mb-1.5 block text-[11px]" style={{ color: 'var(--negis-muted)' }}>
                      НОВЫЙ ПАРОЛЬ
                    </label>
                    <input
                      id="profile-new-password"
                      type="password"
                      autoComplete="new-password"
                      className="neu-input"
                      placeholder="Оставьте пустым, чтобы не менять"
                      value={newPassword}
                      disabled={saving}
                      onChange={event => { if (isCurrent() && !pending.current) setNewPassword(event.target.value); }}
                    />
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--negis-muted)' }}>{PASSWORD_RULE_HINT}</p>
                    {withoutMailbox && (
                      <p className="mt-1 text-[11px]" style={{ color: '#B91C1C' }}>
                        У вашего входа нет почты: забытый пароль письмом не вернуть — новый задаст администратор клиники.
                      </p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="profile-repeat-password" className="mb-1.5 block text-[11px]" style={{ color: 'var(--negis-muted)' }}>
                      ПОВТОРИТЕ НОВЫЙ
                    </label>
                    <input
                      id="profile-repeat-password"
                      type="password"
                      autoComplete="new-password"
                      className="neu-input"
                      placeholder="Ещё раз"
                      value={repeatPassword}
                      disabled={saving}
                      onChange={event => { if (isCurrent() && !pending.current) setRepeatPassword(event.target.value); }}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-[12px] leading-relaxed" style={{ color: 'var(--negis-muted)' }}>{blockedReason}</p>
              )}
            </div>
          </div>
        )}

        <div className="mt-6 flex gap-3">
          <button type="button" className="neu-btn flex-1" onClick={close} disabled={saving}>Отмена</button>
          <button type="button" className="neu-btn-primary flex-1" disabled={saving || !canEditAccount} onClick={save}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
