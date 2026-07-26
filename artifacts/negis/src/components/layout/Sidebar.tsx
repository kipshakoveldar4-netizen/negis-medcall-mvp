import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { BadgeDollarSign, BarChart2, CalendarDays, Clapperboard, Inbox, LayoutDashboard, Rocket, Settings, Users, LogOut, X, KeyRound, User, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

// Medina OS information architecture (UI-1). Groups map only to routes that
// exist; role arrays are unchanged from the previous IA. The former disabled
// "AI-сотрудники" item was removed — future modules are documented in the audit,
// not rendered as dead navigation.
type NavItem = { href: string; icon: LucideIcon; label: string; roles: string[] };
type NavGroup = { title: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Обзор',
    items: [
      { href: '/ai-control-center', icon: LayoutDashboard, label: 'Главная', roles: ['owner', 'manager'] },
      { href: '/dashboard', icon: BarChart2, label: 'Аналитика', roles: ['owner', 'manager'] },
    ],
  },
  {
    title: 'Операции',
    items: [
      { href: '/leads', icon: Inbox, label: 'Заявки', roles: ['owner', 'manager', 'agent'] },
      { href: '/clients', icon: Users, label: 'Клиенты', roles: ['owner', 'manager', 'agent'] },
      { href: '/appointments', icon: CalendarDays, label: 'Записи', roles: ['owner', 'manager', 'agent', 'booking_agent'] },
      { href: '/sales', icon: BadgeDollarSign, label: 'Продажи', roles: ['owner', 'manager', 'agent'] },
    ],
  },
  {
    title: 'Рост',
    items: [
      { href: '/ads-automation', icon: Rocket, label: 'Реклама', roles: ['owner', 'manager'] },
      { href: '/content-studio', icon: Clapperboard, label: 'Контент', roles: ['owner', 'manager'] },
    ],
  },
  {
    title: 'Управление',
    items: [
      { href: '/admin', icon: Settings, label: 'Настройки', roles: ['owner', 'manager'] },
    ],
  },
];

export function Sidebar() {
  const [location] = useLocation();
  const { signOut, user, userRole, isDemoMode } = useAuth();
  const [showProfile, setShowProfile] = useState(false);
  const [fullName, setFullName] = useState(user?.user_metadata?.full_name ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const canUse = (item: NavItem) =>
    !userRole || userRole === 'owner' || userRole === 'manager' || userRole === 'admin' || item.roles.includes(userRole);
  const visibleGroups = NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter(canUse) }))
    .filter((group) => group.items.length > 0);

  const initials = (user?.user_metadata?.full_name ?? user?.email ?? 'U')
    .split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();

  const openProfile = () => {
    setFullName(user?.user_metadata?.full_name ?? '');
    setNewPassword('');
    setShowProfile(true);
  };

  const saveProfile = async () => {
    if (!fullName.trim()) { toast.error('Введите имя'); return; }
    if (newPassword && newPassword.length < 6) { toast.error('Пароль: минимум 6 символов'); return; }
    setSaving(true);
    try {
      const updates: { data?: { full_name: string }; password?: string } = {
        data: { full_name: fullName.trim() },
      };
      if (newPassword) updates.password = newPassword;
      const { error } = await supabase.auth.updateUser(updates);
      if (error) throw error;
      toast.success('Профиль сохранён');
      setShowProfile(false);
      setNewPassword('');
    } catch (e: any) {
      toast.error(e.message || 'Ошибка сохранения');
    } finally { setSaving(false); }
  };

  return (
    <>
      <aside
        className="fixed left-0 top-0 z-20 flex h-screen w-[248px] select-none flex-col"
        style={{ background: 'var(--medina-sidebar-bg)', borderRight: '1px solid var(--medina-sidebar-border)' }}
      >
        {/* Brand */}
        <div className="flex h-[64px] shrink-0 items-center gap-3 px-5" style={{ borderBottom: '1px solid var(--medina-sidebar-border)' }}>
          <div
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold"
            style={{ background: 'var(--ng-primary)', color: '#FFFFFF' }}
          >
            M
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" style={{ color: 'var(--medina-sidebar-text)' }}>Medina OS</p>
            <p className="mt-0.5 truncate text-[11px] font-medium" style={{ color: 'var(--medina-sidebar-muted)' }}>
              {isDemoMode ? 'Демо-режим' : 'Медицинская CRM'}
            </p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 pb-4 pt-3" aria-label="Основная навигация">
          {visibleGroups.map((group) => (
            <div key={group.title} className="mb-4">
              <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--medina-sidebar-muted)' }}>
                {group.title}
              </p>
              <div className="flex flex-col gap-0.5">
                {group.items.map(({ href, icon: Icon, label }) => {
                  const active = location === href || location.startsWith(href + '/');
                  return (
                    <Link key={href} href={href}>
                      <div
                        className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors"
                        data-active={active}
                        style={{
                          background: active ? 'var(--medina-sidebar-active)' : 'transparent',
                          color: active ? '#FFFFFF' : 'var(--medina-sidebar-muted)',
                          boxShadow: active ? 'inset 2px 0 0 var(--ng-primary)' : 'none',
                        }}
                      >
                        <Icon size={18} strokeWidth={active ? 2 : 1.75} aria-hidden />
                        <span className="truncate">{label}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Profile */}
        <div className="flex shrink-0 items-center gap-3 px-4 pb-4 pt-3" style={{ borderTop: '1px solid var(--medina-sidebar-border)' }}>
          <button
            type="button"
            onClick={openProfile}
            aria-label="Открыть профиль"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold transition-colors"
            style={{ background: 'var(--medina-sidebar-border)', color: 'var(--medina-sidebar-text)' }}
          >
            {initials}
          </button>
          <button type="button" onClick={openProfile} className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-semibold" style={{ color: 'var(--medina-sidebar-text)' }}>{user?.user_metadata?.full_name || 'Профиль'}</p>
            <p className="truncate text-xs" style={{ color: 'var(--medina-sidebar-muted)' }}>{user?.email || 'demo mode'}</p>
          </button>
          <button
            type="button"
            onClick={signOut}
            aria-label="Выйти"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:text-red-400"
            style={{ color: 'var(--medina-sidebar-muted)' }}
          >
            <LogOut size={17} aria-hidden />
          </button>
        </div>
      </aside>

      {/* Profile Modal */}
      {showProfile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(17, 24, 39, 0.4)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowProfile(false); }}
        >
          <div role="dialog" aria-modal="true" aria-label="Профиль сотрудника" className="w-full max-w-[360px] rounded-xl border bg-white p-7" style={{ borderColor: 'var(--ng-border)', boxShadow: '0 20px 45px rgba(17, 24, 39, 0.18)' }}>
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div aria-hidden className="flex h-10 w-10 items-center justify-center rounded-lg text-[13px] font-semibold" style={{ background: 'var(--negis-primary-soft)', color: 'var(--ng-primary)' }}>
                  {initials}
                </div>
                <div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--ng-text)' }}>
                    {user?.user_metadata?.full_name || 'Профиль'}
                  </div>
                  <div className="mt-0.5 text-xs" style={{ color: 'var(--ng-muted)' }}>
                    {user?.email}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowProfile(false)}
                aria-label="Закрыть профиль"
                className="neu-icon-btn"
                style={{ height: 32, width: 32 }}
              >
                <X size={15} aria-hidden />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="profile-full-name" className="mb-1.5 block text-[11px] font-medium" style={{ color: 'var(--ng-muted)' }}>
                  <User size={11} aria-hidden style={{ display: 'inline', marginRight: 5 }} />
                  ИМЯ
                </label>
                <input
                  id="profile-full-name"
                  className="neu-input"
                  placeholder="Ваше имя"
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="profile-new-password" className="mb-1.5 block text-[11px] font-medium" style={{ color: 'var(--ng-muted)' }}>
                  <KeyRound size={11} aria-hidden style={{ display: 'inline', marginRight: 5 }} />
                  НОВЫЙ ПАРОЛЬ
                </label>
                <input
                  id="profile-new-password"
                  type="password"
                  className="neu-input"
                  placeholder="Оставьте пустым, чтобы не менять"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                />
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button type="button" className="neu-btn flex-1" onClick={() => setShowProfile(false)}>
                Отмена
              </button>
              <button type="button" className="neu-btn-primary flex-1" disabled={saving} onClick={saveProfile}>
                {saving ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
