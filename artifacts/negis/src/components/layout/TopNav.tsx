import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation } from 'wouter';
import {
  BarChart2,
  CalendarDays,
  Building2,
  Briefcase,
  Settings,
  LogOut,
  X,
  Check,
  KeyRound,
  User,
  Megaphone,
  ClipboardList,
  MessageCircle,
  Store,
  Smile,
  Upload,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import { agentInitials, type AgentDisplayInfo } from '@/lib/agentDisplay';

const NAV = [
  { href: '/dashboard', icon: BarChart2, label: 'Дашборд', permission: 'dashboard' },
  { href: '/booking', icon: CalendarDays, label: 'Запись', permission: 'booking' },
  { href: '/reception', icon: Building2, label: 'Ресепшн', permission: 'reception' },
  { href: '/sales', icon: Briefcase, label: 'Клиенты', permission: 'crm' },
  { href: '/tasks', icon: ClipboardList, label: 'Задачи', permission: 'tasks' },
  { href: '/chat', icon: MessageCircle, label: 'Чат', permission: 'chat' },
  { href: '/marketplace', icon: Store, label: 'Маркет', permission: 'marketplace' },
  { href: '/ads', icon: Megaphone, label: 'Реклама', permission: 'ads' },
  { href: '/admin', icon: Settings, label: 'Админ', permission: 'admin' },
];

const MAX_AVATAR_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_AVATAR_DATA_URL_BYTES = 120 * 1024;

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось прочитать фото'));
    img.src = src;
  });
}

async function compressAvatarFile(file: File) {
  if (file.size > MAX_AVATAR_SOURCE_BYTES) {
    throw new Error('Фото слишком большое. Выберите файл до 8 МБ.');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const sourceWidth = img.naturalWidth || img.width;
    const sourceHeight = img.naturalHeight || img.height;
    const ratio = Math.min(1, 256 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * ratio));
    const height = Math.max(1, Math.round(sourceHeight * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось обработать фото');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    let dataUrl = canvas.toDataURL('image/jpeg', 0.78);
    if (dataUrl.length > MAX_AVATAR_DATA_URL_BYTES) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.58);
    }
    if (dataUrl.length > MAX_AVATAR_DATA_URL_BYTES) {
      throw new Error('Фото слишком тяжёлое. Попробуйте другое изображение.');
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function TopNav() {
  const [location] = useLocation();
  const { signOut, user, userRole, rolePermissions, clinicId } = useAuth();
  const profileButtonRef = useRef<HTMLButtonElement | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [profilePanelPosition, setProfilePanelPosition] = useState({ left: 24, top: 128 });
  const [fullName, setFullName] = useState(user?.user_metadata?.full_name ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [myAgent, setMyAgent] = useState<AgentDisplayInfo | null>(null);
  const [avatarUrl, setAvatarUrl] = useState(user?.user_metadata?.avatar_url ?? '');
  const [avatarIcon, setAvatarIcon] = useState(user?.user_metadata?.avatar_icon ?? '');
  const [avatarColor, setAvatarColor] = useState(user?.user_metadata?.avatar_color ?? '#EFF6FF');
  const [saving, setSaving] = useState(false);

  const filtered = NAV.filter(item => userRole === 'owner' || userRole === 'manager' || rolePermissions[item.permission]);
  const initials = agentInitials(myAgent, user?.user_metadata?.full_name ?? user?.email ?? 'U');
  const avatarSrc = avatarUrl || myAgent?.avatar_url || user?.user_metadata?.avatar_url || '';
  const iconValue = avatarIcon || myAgent?.avatar_icon || user?.user_metadata?.avatar_icon || '';
  const avatarBg = avatarColor || myAgent?.avatar_color || user?.user_metadata?.avatar_color || '#EFF6FF';

  useEffect(() => {
    if (!clinicId || !user?.id) return;
    const loadProfile = async () => {
      const primary = await supabase
        .from('agents')
        .select('id, name, user_id, role_id, avatar_url, avatar_icon, avatar_color')
        .eq('clinic_id', clinicId)
        .eq('user_id', user.id)
        .maybeSingle();
      let data = primary.data as AgentDisplayInfo | null;
      if (primary.error) {
        const fallback = await supabase
          .from('agents')
          .select('id, name, user_id, role_id')
          .eq('clinic_id', clinicId)
          .eq('user_id', user.id)
          .maybeSingle();
        data = fallback.data as AgentDisplayInfo | null;
      }
      if (!data) return;
      const agent = data as AgentDisplayInfo;
      setMyAgent(agent);
      setAvatarUrl(agent.avatar_url || user.user_metadata?.avatar_url || '');
      setAvatarIcon(agent.avatar_icon || user.user_metadata?.avatar_icon || '');
      setAvatarColor(agent.avatar_color || user.user_metadata?.avatar_color || '#EFF6FF');
    };
    loadProfile();
  }, [clinicId, user?.id]);

  const openProfile = () => {
    const rect = profileButtonRef.current?.getBoundingClientRect();
    const panelWidth = Math.min(360, window.innerWidth - 32);
    if (rect) {
      setProfilePanelPosition({
        left: Math.max(16, Math.min(rect.left - 8, window.innerWidth - panelWidth - 16)),
        top: Math.max(118, rect.bottom + 14),
      });
    }
    setFullName(user?.user_metadata?.full_name ?? '');
    setNewPassword('');
    setAvatarUrl(myAgent?.avatar_url || user?.user_metadata?.avatar_url || '');
    setAvatarIcon(myAgent?.avatar_icon || user?.user_metadata?.avatar_icon || '');
    setAvatarColor(myAgent?.avatar_color || user?.user_metadata?.avatar_color || '#EFF6FF');
    setShowProfile(true);
  };

  const renderAvatar = (sizeClass = 'soft-avatar') => (
    <div className={`${sizeClass} shrink-0 overflow-hidden`} style={{ background: avatarBg }}>
      {avatarSrc ? (
        <img src={avatarSrc} alt="Профиль" className="h-full w-full object-cover" />
      ) : iconValue ? (
        <span className="text-lg leading-none">{iconValue}</span>
      ) : (
        initials
      )}
    </div>
  );

  const handleAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Выберите изображение');
      return;
    }
    try {
      const compressed = await compressAvatarFile(file);
      setAvatarUrl(compressed);
      setAvatarIcon('');
      toast.success('Фото подготовлено');
    } catch (e: any) {
      toast.error(e.message || 'Не удалось обработать фото');
    }
  };

  const saveProfile = async () => {
    if (!fullName.trim()) {
      toast.error('Введите имя');
      return;
    }
    if (newPassword && newPassword.length < 6) {
      toast.error('Пароль: минимум 6 символов');
      return;
    }
    setSaving(true);
    try {
      const updates: {
        data?: {
          full_name: string;
          avatar_url?: string | null;
          avatar_icon?: string | null;
          avatar_color?: string | null;
        };
        password?: string;
      } = {
        data: {
          full_name: fullName.trim(),
          avatar_url: avatarUrl || null,
          avatar_icon: avatarIcon || null,
          avatar_color: avatarColor || null,
        },
      };
      if (newPassword) updates.password = newPassword;
      const { error } = await supabase.auth.updateUser(updates);
      if (error) throw error;
      if (clinicId && user?.id) {
        const { data: agentRow } = await supabase
          .from('agents')
          .select('id')
          .eq('clinic_id', clinicId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (agentRow?.id) {
          const { error: avatarError } = await supabase
            .from('agents')
            .update({
              name: fullName.trim(),
              avatar_url: avatarUrl || null,
              avatar_icon: avatarIcon || null,
              avatar_color: avatarColor || null,
            })
            .eq('id', agentRow.id);
          if (avatarError) {
            const { error: fallbackError } = await supabase
              .from('agents')
              .update({ name: fullName.trim() })
              .eq('id', agentRow.id);
            if (fallbackError) throw fallbackError;
            toast.warning('Имя сохранено. Для фото выполните SQL-миграцию 005.');
          }
          setMyAgent(prev => prev ? {
            ...prev,
            name: fullName.trim(),
            avatar_url: avatarUrl || null,
            avatar_icon: avatarIcon || null,
            avatar_color: avatarColor || null,
          } : prev);
        }
      }
      toast.success('Профиль сохранён');
      setShowProfile(false);
      setNewPassword('');
    } catch (e: any) {
      toast.error(e.message || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: CSSProperties = {
    background: 'rgba(255,255,255,0.72)',
    border: '1px solid rgba(211,222,231,0.95)',
    borderRadius: 14,
    padding: '12px 14px',
    fontSize: 14,
    color: '#0B1220',
    fontFamily: "'Inter', sans-serif",
    outline: 'none',
    width: '100%',
    boxShadow: 'inset 2px 2px 6px rgba(133, 153, 174, 0.10), inset -2px -2px 7px rgba(255,255,255,0.95)',
  };

  return (
    <>
      <div className="topnav-shell flex min-w-0 items-center justify-center gap-3">
          <div className="topnav-scroll min-w-0 overflow-x-auto">
            <div className="dock-shell inline-flex min-w-max items-end gap-2 rounded-[34px] border border-white/70 bg-white/55 px-3 py-2 shadow-[8px_10px_28px_rgba(116,135,154,0.14),inset_1px_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl">
              <button ref={profileButtonRef} type="button" onClick={openProfile} className="topnav-item topnav-profile-item border-0" title="Профиль">
                {renderAvatar('soft-avatar topnav-profile-avatar')}
                <span>Профиль</span>
              </button>
              {filtered.map(({ href, icon: Icon, label }) => {
                const active = location === href || location.startsWith(href + '/');
                return (
                  <Link key={href} href={href}>
                    <div className={`topnav-item ${active ? 'is-active' : ''}`} title={label}>
                      <Icon size={24} strokeWidth={active ? 2.35 : 1.9} />
                      <span>{label}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
      </div>

      {showProfile && (
        <div
          className="fixed inset-0 z-50"
          style={{ background: 'transparent' }}
          onClick={e => {
            if (e.target === e.currentTarget) setShowProfile(false);
          }}
        >
          <div
            className="soft-modal absolute w-[min(360px,calc(100vw-32px))] overflow-y-auto p-5"
            style={{
              left: profilePanelPosition.left,
              top: profilePanelPosition.top,
              maxHeight: `calc(100dvh - ${profilePanelPosition.top + 16}px)`,
            }}
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {renderAvatar()}
                <div>
                  <div className="text-sm font-semibold text-[#0B1220]">
                    {user?.user_metadata?.full_name || 'Профиль'}
                  </div>
                  <div className="mt-0.5 text-xs text-[#8A99AD]">{user?.email}</div>
                </div>
              </div>
              <button type="button" onClick={() => setShowProfile(false)} className="soft-icon-btn">
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#687995]">
                  <Smile size={12} />
                  Аватар
                </label>
                <div className="flex items-center gap-3">
                  {renderAvatar('soft-avatar h-14 w-14')}
                  <label className="neu-btn cursor-pointer" style={{ padding: '9px 12px' }}>
                    <Upload size={14} />
                    Фото
                    <input type="file" accept="image/*" className="hidden" onChange={e => handleAvatarFile(e.target.files?.[0])} />
                  </label>
                </div>
                <div className="mt-3 grid grid-cols-6 gap-1.5">
                  {['🩺', '💬', '⭐', '⚡', '🌿', '💎'].map(icon => (
                    <button
                      key={icon}
                      type="button"
                      className={`rounded-xl border p-1.5 text-base transition ${avatarIcon === icon ? 'border-[#0D9488] bg-[#F0FDFA]' : 'border-[#E3EAF2] bg-white/70'}`}
                      onClick={() => { setAvatarIcon(icon); setAvatarUrl(''); }}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#687995]">
                  <User size={12} />
                  Имя
                </label>
                <input
                  style={inputStyle}
                  placeholder="Ваше имя"
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                />
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#687995]">
                  <KeyRound size={12} />
                  Новый пароль
                </label>
                <input
                  type="password"
                  style={inputStyle}
                  placeholder="Оставьте пустым, чтобы не менять"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                />
              </div>
            </div>

            <div className="mt-5 flex gap-3">
              <button type="button" onClick={() => setShowProfile(false)} className="neu-btn flex-1">
                Отмена
              </button>
              <button type="button" onClick={saveProfile} disabled={saving} className="neu-btn-primary flex-1">
                <Check size={15} />
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                setShowProfile(false);
                signOut();
              }}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-red-100 bg-white/55 px-4 py-2.5 text-sm font-semibold text-red-600 transition hover:bg-red-50"
            >
              <LogOut size={15} />
              Выйти из системы
            </button>
          </div>
        </div>
      )}
    </>
  );
}
