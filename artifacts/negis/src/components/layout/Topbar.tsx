import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Bell, Check, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { agentDisplayName, loadAgentRoleMaps, type AgentDisplayInfo } from '@/lib/agentDisplay';

const PAGE_LABELS: Record<string, string> = {
  '/ai-control-center': 'Главная',
  '/content-studio': 'Контент',
  '/ai-content-studio': 'Контент',
  '/content': 'Контент',
  '/studio': 'Контент',
  '/appointments': 'Записи',
  '/calls': 'Звонки',
  '/leads': 'Заявки',
  '/clients': 'Клиенты',
  '/market': 'Маркет',
  '/advertising': 'Реклама',
  '/reports': 'Отчёты',
  '/profile': 'Профиль',
  '/dashboard': 'Аналитика',
  '/booking': 'Записи',
  '/reception': 'Ресепшн',
  '/sales': 'Продажи',
  '/tasks': 'Задачи',
  '/chat': 'Чат',
  '/marketplace': 'Маркетплейс',
  '/ads': 'Реклама',
  '/ads-automation': 'Реклама',
  '/ads-automation/history': 'История запусков',
  '/agent': 'Моя смена',
  '/admin': 'Настройки',
};

interface Notif {
  id: string;
  clientName: string;
  agentName: string;
  date: string;
  time: string;
  createdAt: string;
  read: boolean;
}

/* Autoplay policy: an AudioContext created outside a user gesture stays
   suspended and the beep never sounds. We create it once, on the first
   pointer/key interaction, and reuse it for every notification after that. */
let sharedAudioCtx: AudioContext | null = null;

function unlockAudio() {
  try {
    if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
    if (sharedAudioCtx.state === 'suspended') void sharedAudioCtx.resume();
  } catch {
    // AudioContext not available
  }
}

function playBeep() {
  const ctx = sharedAudioCtx;
  if (!ctx || ctx.state !== 'running') return; // no gesture yet — skip silently
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 520;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  } catch {
    // ignore playback errors
  }
}

const readKey = (clinicId: string | null) => `negis_notifications_read_${clinicId ?? 'default'}`;
const deletedKey = (clinicId: string | null) => `negis_notifications_deleted_${clinicId ?? 'default'}`;

function readStoredIds(key: string) {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch {
    return new Set<string>();
  }
}

function writeStoredIds(key: string, ids: Set<string>) {
  localStorage.setItem(key, JSON.stringify(Array.from(ids)));
}

/* Keep stored id sets bounded: drop ids that no longer correspond to a
   fetched booking, otherwise the lists grow forever. */
function pruneStoredIds(ids: Set<string>, currentIds: Set<string>) {
  return new Set(Array.from(ids).filter((id) => currentIds.has(id)));
}

export function Topbar() {
  const [location, setLocation] = useLocation();
  const { clinicId, isDemoMode } = useAuth();
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [open, setOpen] = useState(false);
  const agentsRef = useRef<Record<string, string>>({});
  const readIdsRef = useRef<Set<string>>(new Set());
  const deletedIdsRef = useRef<Set<string>>(new Set());

  const cleanLocation = location.split('?')[0];
  const pageLabel = PAGE_LABELS[cleanLocation] ?? 'Medina OS';
  const unread = notifs.filter(n => !n.read).length;

  const today = new Date().toLocaleDateString('ru', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const fmtDate = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

  const buildNotif = useCallback((r: any): Notif => ({
    id: r.id,
    clientName: r.patient_name ?? r.name ?? r.client_name ?? 'Клиент',
    agentName: r.agent_id ? (agentsRef.current[r.agent_id] ?? '—') : '—',
    date: r.date,
    time: r.time ?? (r.slot_hour != null ? `${String(r.slot_hour).padStart(2, '0')}:00` : '—'),
    createdAt: r.created_at,
    read: readIdsRef.current.has(r.id),
  }), []);

  // Unlock the shared AudioContext on the first real user interaction.
  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  useEffect(() => {
    if (isDemoMode) {
      setNotifs([]);
      return;
    }
    if (!clinicId) return;
    readIdsRef.current = readStoredIds(readKey(clinicId));
    deletedIdsRef.current = readStoredIds(deletedKey(clinicId));

    const load = async () => {
      const [{ data: agentsData }, { data: bookings }] = await Promise.all([
        supabase.from('agents').select('id, name, user_id, role_id').eq('clinic_id', clinicId),
        supabase
          .from('bookings')
          .select('id, patient_name, agent_id, date, time, created_at')
          .eq('clinic_id', clinicId)
          .order('created_at', { ascending: false })
          .limit(15),
      ]);

      const agentRows = (agentsData ?? []) as AgentDisplayInfo[];
      const maps = await loadAgentRoleMaps(supabase, clinicId, agentRows);
      agentsRef.current = Object.fromEntries(agentRows.map(a => [a.id, agentDisplayName(a, maps.customRoleMap, maps.userRoleMap)]));

      const rows = bookings ?? [];
      const currentIds = new Set(rows.map(row => row.id));
      readIdsRef.current = pruneStoredIds(readIdsRef.current, currentIds);
      deletedIdsRef.current = pruneStoredIds(deletedIdsRef.current, currentIds);
      writeStoredIds(readKey(clinicId), readIdsRef.current);
      writeStoredIds(deletedKey(clinicId), deletedIdsRef.current);

      setNotifs(rows
        .filter(row => !deletedIdsRef.current.has(row.id))
        .map(buildNotif));
    };

    load();

    const channel = supabase
      .channel(`bookings-notify-${clinicId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'bookings', filter: `clinic_id=eq.${clinicId}` },
        (payload) => {
          const row = payload.new as any;
          if (deletedIdsRef.current.has(row.id)) return;
          const notif = buildNotif(row);
          setNotifs(prev => [notif, ...prev.filter(n => n.id !== notif.id).slice(0, 14)]);
          playBeep();
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [clinicId, isDemoMode, buildNotif]);

  const markRead = (id: string) => {
    readIdsRef.current.add(id);
    writeStoredIds(readKey(clinicId), readIdsRef.current);
    setNotifs(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  };

  const deleteNotif = (id: string) => {
    deletedIdsRef.current.add(id);
    writeStoredIds(deletedKey(clinicId), deletedIdsRef.current);
    setNotifs(prev => prev.filter(n => n.id !== id));
  };

  const openEvent = (n: Notif) => {
    markRead(n.id);
    sessionStorage.setItem('negis_focus_booking', JSON.stringify({ id: n.id, date: n.date }));
    setOpen(false);
    setLocation('/reception');
  };

  return (
    <header
      className="negis-topbar sticky top-0 z-30 flex shrink-0 items-center gap-4 px-5 md:px-8"
      style={{
        background: 'var(--ng-surface)',
        borderBottom: '1px solid var(--ng-border)',
      }}
    >
      <div className="flex min-w-0 items-center gap-2 select-none">
        <span className="text-xs font-semibold tracking-[0.06em]" style={{ color: 'var(--ng-primary)' }}>
          Medina OS
        </span>
        <span aria-hidden style={{ color: 'var(--ng-border)', fontSize: 14 }}>/</span>
        <span className="truncate text-xs font-semibold tracking-[0.04em]" style={{ color: 'var(--ng-text-2)' }}>
          {pageLabel}
        </span>
      </div>

      <div className="negis-topbar-actions ml-auto flex min-w-0 items-center justify-end gap-4">
        <span
          className="negis-topbar-date"
          style={{
            fontSize: 12,
            color: 'var(--ng-muted)',
            letterSpacing: '0.01em',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
          }}
        >
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          {today}
        </span>

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="neu-icon-btn negis-bell relative"
              aria-label={unread > 0 ? `Уведомления, непрочитанных: ${unread}` : 'Уведомления'}
            >
              <Bell size={16} strokeWidth={1.75} aria-hidden />
              {unread > 0 && (
                <span
                  className="absolute -top-1 -right-1 flex items-center justify-center rounded-full text-white font-bold"
                  style={{
                    background: '#DC2626',
                    fontSize: 9,
                    minWidth: 16,
                    height: 16,
                    padding: '0 4px',
                  }}
                >
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="w-[min(24rem,calc(100vw-24px))] p-0"
            align="end"
            style={{
              background: '#FFFFFF',
              border: '1px solid var(--ng-border)',
              borderRadius: 10,
              boxShadow: '0 12px 32px rgba(17, 24, 39, 0.14)',
              overflow: 'hidden',
            }}
          >
            <div
              className="px-5 py-4 font-semibold text-sm flex items-center justify-between"
              style={{ borderBottom: '1px solid var(--ng-border)', color: 'var(--ng-text)', letterSpacing: '0.01em' }}
            >
              <span>Уведомления</span>
              {notifs.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--ng-muted)', fontWeight: 400 }}>
                  {unread} непрочитанных
                </span>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {notifs.length === 0 ? (
                <div className="px-5 py-8 text-center" style={{ color: 'var(--ng-muted)', fontSize: 13 }}>
                  Нет уведомлений
                </div>
              ) : notifs.map(n => (
                <div
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Открыть запись: ${n.clientName}, ${fmtDate(n.date)} в ${n.time}`}
                  className="px-5 py-4 transition-colors focus-visible:outline-2"
                  style={{
                    borderBottom: '1px solid var(--ng-plate)',
                    background: n.read ? 'transparent' : 'var(--negis-primary-soft)',
                    cursor: 'pointer',
                  }}
                  onClick={() => openEvent(n)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openEvent(n);
                    }
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold" style={{ color: 'var(--ng-text)' }}>
                        Новая запись — {n.clientName}
                      </p>
                      <p className="text-xs mt-1" style={{ color: 'var(--ng-muted)' }}>
                        {fmtDate(n.date)} в {n.time}
                        {n.agentName !== '—' && <> · {n.agentName}</>}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--ng-border)' }}>
                        {new Date(n.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    {!n.read && <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--ng-primary)' }} />}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className="neu-btn"
                      style={{ padding: '6px 10px', borderRadius: 8, fontSize: 12, minHeight: 32 }}
                      onClick={e => {
                        e.stopPropagation();
                        markRead(n.id);
                      }}
                    >
                      <Check size={13} />
                      Прочитано
                    </button>
                    <button
                      type="button"
                      className="neu-btn"
                      style={{ padding: '6px 10px', borderRadius: 8, fontSize: 12, minHeight: 32, color: 'var(--ng-error)' }}
                      onClick={e => {
                        e.stopPropagation();
                        deleteNotif(n.id);
                      }}
                    >
                      <Trash2 size={13} />
                      Удалить
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  );
}
