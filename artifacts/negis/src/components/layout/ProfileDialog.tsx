import { useState } from 'react';
import { KeyRound, User, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { supabase, verifyCurrentPassword } from '@/lib/supabase';
import { PASSWORD_RULE_HINT, validatePasswordRules } from '../../../../../lib/auth/password-rules';
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

export function ProfileDialog({ onClose }: ProfileDialogProps) {
  const { user, session, isImpersonation, isDemoMode } = useAuth();
  const [fullName, setFullName] = useState(user?.user_metadata?.full_name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const email = user?.email ?? '';
  // У входа по логину почты нет: показывать служебный адрес нельзя (человек
  // решит, что это его почта), и обещать восстановление письмом — тоже.
  const displayLogin = loginFromEmail(email);
  const withoutMailbox = isSyntheticEmail(email);
  const initials = (user?.user_metadata?.full_name ?? email ?? 'U')
    .split(' ').map((word: string) => word[0]).join('').slice(0, 2).toUpperCase();

  // Настоящая своя сессия Supabase — единственное, что даёт право писать в этот
  // аккаунт. В демо-режиме её нет, под имперсонацией она чужая.
  const canEditAccount = Boolean(session?.user?.id) && !isImpersonation && !isDemoMode;
  const canChangePassword = canEditAccount && Boolean(email);
  const blockedReason = isImpersonation
    ? 'Вы вошли как владелец клиники по ссылке из панели платформы. Его профиль и пароль меняет он сам в своём кабинете.'
    : 'Профиль доступен после обычного входа по почте и паролю.';

  const close = () => {
    // Во время записи закрывать нельзя: сохранение — три обращения к сети
    // подряд, и человек, тапнувший «Отмена» на медленной связи, уходил
    // уверенным, что отменил, а пароль тем временем менялся.
    if (saving) return;
    setCurrentPassword('');
    setNewPassword('');
    setRepeatPassword('');
    onClose();
  };

  const save = async () => {
    if (!canEditAccount) { toast.error(blockedReason); return; }

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

    setSaving(true);
    try {
      if (wantsPasswordChange) {
        const check = await verifyCurrentPassword(email, currentPassword);
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
      const { error } = await supabase.auth.updateUser(updates);
      if (error) throw error;

      toast.success(wantsPasswordChange ? 'Пароль изменён — входите с новым' : 'Имя сохранено');
      setSaving(false);
      close();
      return;
    } catch (error: unknown) {
      toast.error(authErrorText(error instanceof Error ? error.message : ''));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'rgba(17, 24, 39, 0.4)' }}
      onClick={event => { if (event.target === event.currentTarget) close(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
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
                onChange={event => setFullName(event.target.value)}
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
                      onChange={event => setCurrentPassword(event.target.value)}
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
                      onChange={event => setNewPassword(event.target.value)}
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
                      onChange={event => setRepeatPassword(event.target.value)}
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
