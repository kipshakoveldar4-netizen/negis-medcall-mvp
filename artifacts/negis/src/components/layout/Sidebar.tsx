import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { BarChart2, CalendarDays, Settings, LogOut, X, Check, KeyRound, User, Megaphone, ClipboardList, BrainCircuit, Clapperboard, Rocket, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

const NAV = [
  { href: '/dashboard', icon: BarChart2, label: 'Дашборд', roles: ['owner', 'manager'] },
  { href: '/ads-automation', icon: Rocket, label: 'Реклама', roles: ['owner', 'manager'] },
  { href: '/ads-automation/history', icon: ClipboardList, label: 'История запусков', roles: ['owner', 'manager'] },
  { href: '/clients', icon: Users, label: 'Клиенты', roles: ['owner', 'manager', 'agent'] },
  { href: '/content-studio', icon: Clapperboard, label: 'Контент-студия', roles: ['owner', 'manager'] },
  { href: '/targeting-agent', icon: BrainCircuit, label: 'AI таргетолог', roles: ['owner', 'manager'] },
  { href: '/appointments', icon: CalendarDays, label: 'Записи', roles: ['owner', 'manager', 'agent', 'booking_agent'] },
  { href: '/leads', icon: Megaphone, label: 'Лиды', roles: ['owner', 'manager', 'agent'] },
  { href: '/admin', icon: Settings, label: 'Настройки', roles: ['owner', 'manager'] },
];

export function Sidebar() {
  const [location] = useLocation();
  const { signOut, user, userRole } = useAuth();
  const [showProfile, setShowProfile] = useState(false);
  const [fullName, setFullName] = useState(user?.user_metadata?.full_name ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const filtered = NAV.filter(item => !userRole || userRole === 'owner' || userRole === 'manager' || userRole === 'admin' || item.roles.includes(userRole));
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
        style={{ width: 248, background: 'rgba(255,255,255,0.88)', borderRight: '1px solid #DDEBEA', boxShadow: '8px 0 28px rgba(15, 23, 42, 0.04)', backdropFilter: 'blur(18px)' }}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 shrink-0 px-5" style={{ height: 78 }}>
          <div
            className="flex h-11 w-11 items-center justify-center rounded-2xl"
            style={{ background: '#DDF7F2', border: '1px solid #BDEBE2', color: '#0F766E', fontWeight: 900, letterSpacing: '0.08em' }}
          >
            N
          </div>
          <div className="min-w-0">
            <p className="text-sm font-black text-[#0F172A]">Negis MedCall</p>
            <p className="mt-0.5 text-xs font-bold text-[#64748B]">Clean Medical CRM</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 flex flex-col gap-1.5 px-3 pt-2 pb-4">
          {filtered.map(({ href, icon: Icon, label }) => {
            const active = location === href || location.startsWith(href + '/');
            return (
              <Link key={href} href={href}>
                <div
                  title={label}
                  className="control-node"
                  data-active={active}
                  style={{
                    minHeight: 44,
                    borderRadius: 16,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 13px',
                    cursor: 'pointer', transition: 'all 0.15s ease',
                    background: active ? '#ECFDF8' : 'transparent',
                    border: active ? '1px solid #BDEBE2' : '1px solid transparent',
                    boxShadow: active
                      ? '0 8px 20px rgba(13,148,136,0.08), inset 0 1px 0 rgba(255,255,255,0.9)'
                      : 'none',
                    color: active ? '#0F766E' : '#64748B',
                  }}
                >
                  <Icon size={20} strokeWidth={active ? 2 : 1.75} />
                  <span className="truncate text-sm font-black">{label}</span>
                </div>
              </Link>
            );
          })}
        </nav>

        {/* User + Signout */}
        <div
          className="shrink-0 flex items-center gap-3 px-4 pb-5 pt-3"
          style={{ borderTop: '1px solid #DDEBEA' }}
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
          <button
            onClick={openProfile}
            className="min-w-0 flex-1 text-left"
            style={{ color: '#0F172A' }}
          >
            <p className="truncate text-sm font-black">{user?.user_metadata?.full_name || 'Профиль'}</p>
            <p className="truncate text-xs font-semibold text-[#64748B]">{user?.email || 'demo mode'}</p>
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
