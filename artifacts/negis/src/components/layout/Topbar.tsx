import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Bell, Check, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { agentDisplayName, loadAgentRoleMaps, type AgentDisplayInfo } from '@/lib/agentDisplay';
import { TopNav } from './TopNav';

const PAGE_LABELS: Record<string, string> = {
  '/dashboard': 'Дашборд',
  '/booking': 'Запись',
  '/reception': 'Ресепшн',
  '/sales': 'Клиенты',
  '/tasks': 'Задачи',
  '/chat': 'Чат',
  '/marketplace': 'Маркетплейс',
  '/ads': 'Реклама',
  '/agent': 'Агент',
  '/admin': 'Админ',
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

function playBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 520;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => ctx.close();
  } catch {
    // AudioContext not available
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

export function Topbar() {
  const [location, setLocation] = useLocation();
  const { clinicId } = useAuth();
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [open, setOpen] = useState(false);
  const agentsRef = useRef<Record<string, string>>({});
  const readIdsRef = useRef<Set<string>>(new Set());
  const deletedIdsRef = useRef<Set<string>>(new Set());

  const cleanLocation = location.split('?')[0];
  const pageLabel = PAGE_LABELS[cleanLocation] ?? 'NEGIS';
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

  useEffect(() => {
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
      setNotifs((bookings ?? [])
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
  }, [clinicId, buildNotif]);

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
      className="grid shrink-0 sticky top-0 z-30 items-center gap-4 px-8"
      style={{
        gridTemplateColumns: 'minmax(150px, 1fr) minmax(0, auto) minmax(190px, 1fr)',
        height: 98,
        background: 'rgba(238, 244, 248, 0.86)',
        backdropFilter: 'blur(18px)',
        borderBottom: '1px solid rgba(224, 231, 239, 0.9)',
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: '0.16em',
            color: '#8EA0B7',
            fontFamily: "'Inter', sans-serif",
            userSelect: 'none',
          }}
        >
          NEGIS
        </span>
        <span style={{ color: '#CAD8E5', fontSize: 14 }}>/</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.08em',
            color: '#4F6078',
            fontFamily: "'Inter', sans-serif",
            userSelect: 'none',
          }}
        >
          {pageLabel}
        </span>
      </div>

      <div className="min-w-0 justify-self-center">
        <TopNav />
      </div>

      <div className="flex items-center justify-end gap-4">
        <span
          style={{
            fontSize: 12,
            color: '#94A3B8',
            fontFamily: "'Inter', sans-serif",
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
              className="neu-icon-btn relative"
              style={{ width: 36, height: 36, borderRadius: 12 }}
            >
              <Bell size={16} strokeWidth={1.75} />
              {unread > 0 && (
                <span
                  className="absolute -top-1 -right-1 flex items-center justify-center rounded-full text-white font-bold"
                  style={{
                    background: '#DC2626',
                    fontSize: 9,
                    minWidth: 16,
                    height: 16,
                    padding: '0 4px',
                    fontFamily: "'Inter', sans-serif",
                  }}
                >
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="w-96 p-0"
            align="end"
            style={{
              background: 'rgba(255,255,255,0.94)',
              border: '1px solid #E3EAF2',
              borderRadius: 18,
              boxShadow: '0 16px 40px rgba(15,23,42,0.12)',
              overflow: 'hidden',
            }}
          >
            <div
              className="px-5 py-4 font-semibold text-sm flex items-center justify-between"
              style={{ borderBottom: '1px solid #E7ECF3', color: '#0B1220', letterSpacing: '0.01em' }}
            >
              <span>Уведомления</span>
              {notifs.length > 0 && (
                <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 400 }}>
                  {unread} непрочитанных
                </span>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {notifs.length === 0 ? (
                <div className="px-5 py-8 text-center" style={{ color: '#94A3B8', fontSize: 13 }}>
                  Нет уведомлений
                </div>
              ) : notifs.map(n => (
                <div
                  key={n.id}
                  className="px-5 py-4 transition-colors"
                  style={{
                    borderBottom: '1px solid #F1F5F9',
                    background: n.read ? 'transparent' : '#F0F6FF',
                    cursor: 'pointer',
                  }}
                  onClick={() => openEvent(n)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold" style={{ color: '#0B1220' }}>
                        Новая запись — {n.clientName}
                      </p>
                      <p className="text-xs mt-1" style={{ color: '#64748B' }}>
                        {fmtDate(n.date)} в {n.time}
                        {n.agentName !== '—' && <> · {n.agentName}</>}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: '#CBD5E1' }}>
                        {new Date(n.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    {!n.read && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[#0D9488]" />}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className="neu-btn"
                      style={{ padding: '6px 10px', borderRadius: 12, fontSize: 12 }}
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
                      style={{ padding: '6px 10px', borderRadius: 12, fontSize: 12, color: '#DC2626' }}
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
