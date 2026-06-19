import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { BarChart2, CalendarDays, Building2, Briefcase, Settings, LogOut, X, Check, KeyRound, User, Megaphone, ClipboardList, BrainCircuit } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

const NAV = [
  { href: '/targeting-agent', icon: BrainCircuit, label: 'ИИ таргетолог', roles: ['owner', 'manager'] },
  { href: '/dashboard', icon: BarChart2,    label: 'Дашборд',  roles: ['owner', 'manager'] },
  { href: '/booking',   icon: CalendarDays, label: 'Запись',   roles: ['owner', 'manager', 'agent', 'booking_agent'] },
  { href: '/reception', icon: Building2,    label: 'Ресепшн',  roles: ['owner', 'manager', 'receptionist', 'booking_agent'] },
  { href: '/sales',     icon: Briefcase,    label: 'Клиенты',  roles: ['owner', 'manager', 'agent'] },
  { href: '/tasks',     icon: ClipboardList, label: 'Задачи',   roles: ['owner', 'manager', 'agent'] },
  { href: '/ads',       icon: Megaphone,    label: 'Реклама',  roles: ['owner', 'manager'] },
  { href: '/admin',     icon: Settings,     label: 'Админ',    roles: ['owner', 'manager'] },
];

export function Sidebar() {
  const [location] = useLocation();
  const { signOut, user, userRole } = useAuth();
  const [showProfile, setShowProfile] = useState(false);
  const [fullName, setFullName] = useState(user?.user_metadata?.full_name ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const filtered = NAV.filter(item => !userRole || item.roles.includes(userRole));
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

  const IS: React.CSSProperties = {
    background: '#F4F7FB', border: '1px solid #E7ECF3', borderRadius: 10,
    padding: '10px 13px', fontSize: 14, color: '#0B1220',
    fontFamily: "'Inter', sans-serif", outline: 'none', width: '100%',
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  };

  return (
    <>
      <aside
        className="fixed left-0 top-0 h-screen flex flex-col z-20 select-none"
        style={{ width: 78, background: '#EEF2F6', borderRight: '1px solid #E7ECF3' }}
      >
        {/* Logo */}
        <div className="flex items-center justify-center shrink-0" style={{ height: 72 }}>
          <div style={{
            background: '#DDE5EE', borderRadius: 12, padding: '7px 10px',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6), 0 1px 3px rgba(15,23,42,0.06)',
            letterSpacing: '0.16em', fontSize: 11, fontWeight: 600, color: '#0B1220',
            textTransform: 'uppercase' as const, fontFamily: "'Inter', sans-serif",
          }}>
            N
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 flex flex-col items-center gap-2 pt-2 pb-4">
          {filtered.map(({ href, icon: Icon, label }) => {
            const active = location === href || location.startsWith(href + '/');
            return (
              <Link key={href} href={href}>
                <div
                  title={label}
                  className="control-node"
                  data-active={active}
                  style={{
                    width: 48, height: 48, borderRadius: 14,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', transition: 'all 0.15s ease',
                    background: active ? '#FFFFFF' : 'transparent',
                    border: active ? '1px solid #E7ECF3' : '1px solid transparent',
                    boxShadow: active
                      ? '0 2px 8px rgba(15,23,42,0.07), inset 0 1px 0 rgba(255,255,255,0.9)'
                      : '0 1px 2px rgba(15,23,42,0.04), inset 0 1px 0 rgba(255,255,255,0.7)',
                    color: active ? '#1E325C' : '#64748B',
                  }}
                >
                  <Icon size={20} strokeWidth={active ? 2 : 1.75} />
                </div>
              </Link>
            );
          })}
        </nav>

        {/* User + Signout */}
        <div
          className="shrink-0 flex flex-col items-center gap-3 pb-5 pt-3"
          style={{ borderTop: '1px solid #E7ECF3' }}
        >
          {/* Avatar — clickable */}
          <button
            onClick={openProfile}
            title="Профиль"
            style={{
              width: 36, height: 36, borderRadius: 10,
              background: '#DDE5EE', border: '1px solid #E0E7EF',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 600, color: '#1E325C',
              letterSpacing: '0.04em', fontFamily: "'Inter', sans-serif",
              cursor: 'pointer', transition: 'all 0.15s ease',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background = '#FFFFFF';
              (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 2px 8px rgba(15,23,42,0.10)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = '#DDE5EE';
              (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none';
            }}
          >
            {initials}
          </button>

          {/* Logout */}
          <button
            onClick={signOut}
            title="Выйти"
            style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'transparent', border: '1px solid transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: '#94A3B8', transition: 'all 0.15s ease',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = '#FFFFFF'; el.style.borderColor = '#E7ECF3';
              el.style.color = '#DC2626';
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = 'transparent'; el.style.borderColor = 'transparent';
              el.style.color = '#94A3B8';
            }}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      {/* Profile Modal */}
      {showProfile && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ background: 'rgba(11,18,32,0.18)', backdropFilter: 'blur(8px)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowProfile(false); }}
        >
          <div style={{
            background: '#FFFFFF', border: '1px solid #E7ECF3', borderRadius: 20,
            boxShadow: '0 24px 64px rgba(15,23,42,0.14)',
            width: '100%', maxWidth: 360, padding: '32px 28px',
          }}>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  background: '#DDE5EE', border: '1px solid #E0E7EF',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 700, color: '#1E325C',
                  fontFamily: "'Inter', sans-serif",
                }}>
                  {initials}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0B1220' }}>
                    {user?.user_metadata?.full_name || 'Профиль'}
                  </div>
                  <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 1 }}>
                    {user?.email}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setShowProfile(false)}
                style={{
                  width: 32, height: 32, borderRadius: 8, border: '1px solid #E7ECF3',
                  background: '#F4F7FB', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#64748B',
                }}
              >
                <X size={15} />
              </button>
            </div>

            {/* Fields */}
            <div className="space-y-4">
              <div>
                <label style={{ fontSize: 11, fontWeight: 500, color: '#64748B', display: 'block', marginBottom: 6 }}>
                  <User size={11} style={{ display: 'inline', marginRight: 5 }} />
                  ИМЯ
                </label>
                <input
                  style={IS}
                  placeholder="Ваше имя"
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  onFocus={e => {
                    e.target.style.borderColor = '#2859C5';
                    e.target.style.boxShadow = '0 0 0 3px rgba(40,89,197,0.10)';
                  }}
                  onBlur={e => {
                    e.target.style.borderColor = '#E7ECF3';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: 11, fontWeight: 500, color: '#64748B', display: 'block', marginBottom: 6 }}>
                  <KeyRound size={11} style={{ display: 'inline', marginRight: 5 }} />
                  НОВЫЙ ПАРОЛЬ
                </label>
                <input
                  type="password"
                  style={IS}
                  placeholder="Оставьте пустым, чтобы не менять"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  onFocus={e => {
                    e.target.style.borderColor = '#2859C5';
                    e.target.style.boxShadow = '0 0 0 3px rgba(40,89,197,0.10)';
                  }}
                  onBlur={e => {
                    e.target.style.borderColor = '#E7ECF3';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowProfile(false)}
                style={{
                  flex: 1, padding: '11px 16px', borderRadius: 12,
                  background: '#F4F7FB', border: '1px solid #E7ECF3',
                  fontSize: 14, fontWeight: 500, color: '#475569',
                  cursor: 'pointer', fontFamily: "'Inter', sans-serif",
                }}
              >
                Отмена
              </button>
              <button
                onClick={saveProfile}
                disabled={saving}
                style={{
                  flex: 1, padding: '11px 16px', borderRadius: 12,
                  background: '#1E325C', border: '1px solid #1E325C',
                  fontSize: 14, fontWeight: 500, color: '#FFFFFF',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontFamily: "'Inter', sans-serif", opacity: saving ? 0.65 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                <Check size={15} />
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>

            {/* Logout row */}
            <button
              onClick={() => { setShowProfile(false); signOut(); }}
              style={{
                width: '100%', marginTop: 12, padding: '10px',
                borderRadius: 12, background: 'none', border: '1px solid #FEE2E2',
                fontSize: 13, fontWeight: 500, color: '#DC2626',
                cursor: 'pointer', fontFamily: "'Inter', sans-serif",
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#FEF2F2')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <LogOut size={14} />
              Выйти из системы
            </button>
          </div>
        </div>
      )}
    </>
  );
}
