import { useState, useEffect, useRef } from 'react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Check, X, Trash2, ChevronLeft, ChevronRight, CalendarDays, Plus, QrCode } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { agentDisplayName, loadAgentRoleMaps } from '@/lib/agentDisplay';
import { NegisQrScanner } from '@/components/NegisQrScanner';
import {
  BONUS_STATUS_LABELS,
  QR_STATUS_LABELS,
  confirmAppAppointmentArrival,
  isNegisAppSource,
  sourceValueToLabel,
} from '@/lib/negisApp';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { ru } from 'date-fns/locale';

interface Booking {
  id: string; patient_name: string; patient_phone: string | null; age: number | null;
  time: string; date: string; visited: boolean | null;
  service_id: string | null; agent_id: string | null; lead_id: string | null; status_id: string | null;
  source?: string | null; app_appointment_id?: string | null; qr_status?: string | null; bonus_status?: string | null;
  arrived_at?: string | null; arrival_confirmed_by?: string | null;
}
interface Service { id: string; name: string }
interface Agent   { id: string; name: string; user_id: string | null; role_id?: string | null }
interface BookingStatus { id: string; name: string; color: string | null; sort_order: number | null }
interface CrmLead {
  id: string;
  full_name: string | null;
  phone: string | null;
  age: number | null;
  source: string | null;
  status_id: string | null;
  assigned_to: string | null;
  comment: string | null;
  pipeline: string | null;
}

const fmtDate = (d: Date) => d.toISOString().split('T')[0];

function normalizePhoneForDuplicate(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits;
}

const dateLabel = (d: Date) => {
  const today = fmtDate(new Date());
  const tomorrow = fmtDate(new Date(Date.now() + 86400000));
  const iso = fmtDate(d);
  const base = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  if (iso === today) return `Сегодня, ${base}`;
  if (iso === tomorrow) return `Завтра, ${base}`;
  return base;
};

export default function Reception() {
  const { clinicId, user } = useAuth();
  const [bookings, setBookings]     = useState<Booking[]>([]);
  const [services, setServices]     = useState<Service[]>([]);
  const [agents,   setAgents]       = useState<Agent[]>([]);
  const [customRoleMap, setCustomRoleMap] = useState<Record<string, string>>({});
  const [userRoleMap, setUserRoleMap] = useState<Record<string, string>>({});
  const [bookingStatuses, setBookingStatuses] = useState<BookingStatus[]>([]);
  const [loading, setLoading]       = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [calOpen, setCalOpen]           = useState(false);
  const [newStatusName, setNewStatusName] = useState('');
  const [creatingStatus, setCreatingStatus] = useState(false);
  const [draggingBookingId, setDraggingBookingId] = useState('');
  const [focusedBookingId, setFocusedBookingId] = useState('');
  const [viewFilter, setViewFilter] = useState<'today' | 'waiting' | 'arrived' | 'late' | 'noshow' | 'app'>('today');
  const [showQrScanner, setShowQrScanner] = useState(false);
  const calRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (calRef.current && !calRef.current.contains(e.target as Node)) setCalOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => { if (clinicId) loadMeta(); }, [clinicId]);
  useEffect(() => { if (clinicId) loadBookings(); }, [clinicId, selectedDate]);
  useEffect(() => {
    const raw = sessionStorage.getItem('negis_focus_booking');
    if (!raw) return;
    try {
      const focus = JSON.parse(raw) as { id?: string; date?: string };
      if (focus.id) setFocusedBookingId(focus.id);
      if (focus.date) setSelectedDate(new Date(focus.date + 'T00:00:00'));
    } catch {
      // ignore malformed focus
    } finally {
      sessionStorage.removeItem('negis_focus_booking');
    }
  }, []);

  const loadMeta = async () => {
    if (!clinicId) return;
    const [{ data: svc }, { data: agt }, { data: statuses }] = await Promise.all([
      supabase.from('services').select('id, name').eq('clinic_id', clinicId),
      supabase.from('agents').select('id, name, user_id, role_id').eq('clinic_id', clinicId),
      supabase.from('booking_statuses').select('id, name, color, sort_order').eq('clinic_id', clinicId).order('sort_order'),
    ]);
    setServices(svc ?? []);
    const agentRows = (agt ?? []) as Agent[];
    setAgents(agentRows);
    const maps = await loadAgentRoleMaps(supabase, clinicId, agentRows);
    setCustomRoleMap(maps.customRoleMap);
    setUserRoleMap(maps.userRoleMap);
    if (statuses?.length) {
      setBookingStatuses(statuses);
    } else {
      const { data: created, error } = await supabase
        .from('booking_statuses')
        .insert([
          { clinic_id: clinicId, name: 'Записан', color: '#2859C5', sort_order: 0 },
          { clinic_id: clinicId, name: 'Пришёл', color: '#16A34A', sort_order: 1 },
          { clinic_id: clinicId, name: 'Не пришёл', color: '#DC2626', sort_order: 2 },
        ])
        .select('id, name, color, sort_order')
        .order('sort_order');
      if (error) toast.error(error.message);
      setBookingStatuses(created ?? []);
    }
  };

  const loadBookings = async () => {
    if (!clinicId) return;
    setLoading(true);
    const primary = await supabase
      .from('bookings')
      .select('id, patient_name, patient_phone, age, time, date, visited, service_id, agent_id, lead_id, status_id, source, app_appointment_id, qr_status, bonus_status, arrived_at, arrival_confirmed_by')
      .eq('clinic_id', clinicId)
      .eq('date', fmtDate(selectedDate))
      .order('time');
    let data = primary.data as Booking[] | null;
    let error = primary.error;
    if (error?.message?.includes('column')) {
      const fallback = await supabase
        .from('bookings')
        .select('id, patient_name, patient_phone, age, time, date, visited, service_id, agent_id, lead_id, status_id')
        .eq('clinic_id', clinicId)
        .eq('date', fmtDate(selectedDate))
        .order('time');
      data = fallback.data as Booking[] | null;
      error = fallback.error;
    }
    if (error) toast.error(error.message);
    setBookings(data ?? []);
    setLoading(false);
  };

  const svcName = (id: string | null) => id ? (services.find(s => s.id === id)?.name ?? '—') : '—';
  const agtName = (id: string | null) => id ? agentDisplayName(agents.find(a => a.id === id), customRoleMap, userRoleMap) : '—';
  const currentAgentId = () => agents.find(a => a.user_id === user?.id)?.id ?? null;
  const statusLooksArrived = (status: BookingStatus) => /приш/i.test(status.name) && !/не\s*приш/i.test(status.name);
  const statusLooksMissed = (status: BookingStatus) => /не\s*приш/i.test(status.name);
  const arrivedStatus = () => bookingStatuses.find(statusLooksArrived) ?? null;
  const missedStatus = () => bookingStatuses.find(statusLooksMissed) ?? null;
  const defaultStatus = () => bookingStatuses[0] ?? null;
  const statusForBooking = (booking: Booking) => {
    if (booking.status_id) {
      const current = bookingStatuses.find(s => s.id === booking.status_id);
      if (current) return current;
    }
    if (booking.visited === true) return arrivedStatus() ?? defaultStatus();
    if (booking.visited === false) return missedStatus() ?? defaultStatus();
    return defaultStatus();
  };
  const filteredBookings = bookings.filter(booking => {
    if (viewFilter === 'waiting') return booking.visited == null;
    if (viewFilter === 'arrived') return booking.visited === true;
    if (viewFilter === 'noshow') return booking.visited === false;
    if (viewFilter === 'app') return isNegisAppSource(booking.source);
    if (viewFilter === 'late') {
      if (booking.visited !== null) return false;
      return new Date(`${booking.date}T${booking.time}`) < new Date();
    }
    return true;
  });
  const groupedBookings = bookingStatuses.map(status => ({
    status,
    items: filteredBookings.filter(booking => statusForBooking(booking)?.id === status.id),
  }));

  const appendVisitNote = (comment: string | null, booking: Booking) => {
    const note = [
      `Визит: пришёл ${booking.date} ${booking.time}`,
      `услуга: ${svcName(booking.service_id)}`,
      `агент: ${agtName(booking.agent_id)}`,
    ].join('; ');
    const current = (comment ?? '').trim();
    if (current.includes(note)) return current || null;
    return current ? `${current}\n${note}` : note;
  };

  const findSalesLeadByPhone = async (phone: string | null) => {
    if (!clinicId) return null;
    const normalizedPhone = normalizePhoneForDuplicate(phone);
    if (!normalizedPhone) return null;
    const { data, error } = await supabase
      .from('leads')
      .select('id, full_name, phone, age, source, status_id, assigned_to, comment, pipeline')
      .eq('clinic_id', clinicId)
      .eq('pipeline', 'sales')
      .not('phone', 'is', null);
    if (error) throw error;
    return ((data ?? []) as CrmLead[]).find(lead =>
      normalizePhoneForDuplicate(lead.phone) === normalizedPhone
    ) ?? null;
  };

  const ensureSalesLeadStatusId = async () => {
    if (!clinicId) throw new Error('Клиника не выбрана');
    const { data: existingStatuses, error: statusError } = await supabase
      .from('lead_statuses')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('pipeline', 'sales')
      .order('sort_order')
      .limit(1);
    if (statusError) throw statusError;
    if (existingStatuses?.[0]?.id) return existingStatuses[0].id as string;

    const { data: createdStatus, error: createStatusError } = await supabase
      .from('lead_statuses')
      .insert({
        clinic_id: clinicId,
        name: 'Новый',
        color: '#3B82F6',
        sort_order: 0,
        pipeline: 'sales',
      })
      .select('id')
      .single();
    if (createStatusError) throw createStatusError;
    return createdStatus.id as string;
  };

  const promoteBookingToCrm = async (booking: Booking) => {
    if (!clinicId) return null;
    const defaultStatusId = await ensureSalesLeadStatusId();

    let targetLead: CrmLead | null = null;
    if (booking.lead_id) {
      const { data, error } = await supabase
        .from('leads')
        .select('id, full_name, phone, age, source, status_id, assigned_to, comment, pipeline')
        .eq('id', booking.lead_id)
        .maybeSingle();
      if (error) throw error;
      targetLead = data as CrmLead | null;
    }
    if (!targetLead) targetLead = await findSalesLeadByPhone(booking.patient_phone);

    const crmPayload = {
      pipeline: 'sales',
      full_name: targetLead?.full_name || booking.patient_name,
      phone: targetLead?.phone || booking.patient_phone,
      age: targetLead?.age ?? booking.age,
      source: targetLead?.source || 'Ресепшн',
      assigned_to: targetLead?.assigned_to || currentAgentId(),
      status_id: targetLead?.pipeline === 'sales'
        ? (targetLead.status_id || defaultStatusId)
        : defaultStatusId,
      comment: appendVisitNote(targetLead?.comment ?? null, booking),
      updated_at: new Date().toISOString(),
    };

    let crmLeadId = targetLead?.id ?? null;
    if (crmLeadId) {
      const { error } = await supabase.from('leads').update(crmPayload).eq('id', crmLeadId);
      if (error) throw error;
    } else {
      const { data, error } = await supabase
        .from('leads')
        .insert({
          clinic_id: clinicId,
          ...crmPayload,
        })
        .select('id')
        .single();
      if (error) throw error;
      crmLeadId = data.id;
    }

    return crmLeadId;
  };

  const setVisited = async (id: string, visited: boolean, statusIdOverride?: string) => {
    const booking = bookings.find(b => b.id === id);
    let crmLeadId: string | null = null;
    if (visited) {
      if (!booking) {
        toast.error('Запись не найдена');
        return;
      }
      try {
        crmLeadId = await promoteBookingToCrm(booking);
      } catch (e: any) {
        toast.error(e.message || 'Не удалось добавить пациента в раздел «Клиенты»');
        return;
      }
    }
    const updatePayload: { visited: boolean; lead_id?: string; status_id?: string | null } = {
      visited,
      status_id: statusIdOverride ?? (visited ? arrivedStatus()?.id : missedStatus()?.id) ?? null,
    };
    if (crmLeadId) updatePayload.lead_id = crmLeadId;
    const { error } = await supabase.from('bookings').update(updatePayload).eq('id', id);
    if (error) { toast.error(error.message); return; }
    if (visited && clinicId && booking && isNegisAppSource(booking.source) && booking.app_appointment_id) {
      confirmAppAppointmentArrival(booking.app_appointment_id, clinicId, user?.id).catch((e: any) => {
        toast.error(e.message || 'Backend Negis App не подтвердил начисление бонусов');
      });
    }
    setBookings(b => b.map(x => x.id === id ? { ...x, visited, status_id: updatePayload.status_id ?? x.status_id, lead_id: crmLeadId ?? x.lead_id } : x));
    toast.success(visited ? 'Отмечен: Пришёл, пациент добавлен в раздел «Клиенты»' : 'Отмечен: Не пришёл');
  };

  const moveBookingToStatus = async (booking: Booking, status: BookingStatus) => {
    if (statusLooksArrived(status)) {
      await setVisited(booking.id, true, status.id);
      return;
    }
    if (statusLooksMissed(status)) {
      await setVisited(booking.id, false, status.id);
      return;
    }
    const { error } = await supabase
      .from('bookings')
      .update({ status_id: status.id, visited: null })
      .eq('id', booking.id);
    if (error) { toast.error(error.message); return; }
    setBookings(prev => prev.map(item => item.id === booking.id ? { ...item, status_id: status.id, visited: null } : item));
    toast.success('Запись перенесена');
  };

  const addStatusColumn = async () => {
    if (!newStatusName.trim()) {
      toast.error('Введите название столбца');
      return;
    }
    if (!clinicId) {
      toast.error('Клиника не выбрана');
      return;
    }
    setCreatingStatus(true);
    const nextOrder = Math.max(-1, ...bookingStatuses.map(s => s.sort_order ?? 0)) + 1;
    const { data, error } = await supabase
      .from('booking_statuses')
      .insert({
        clinic_id: clinicId,
        name: newStatusName.trim(),
        color: '#64748B',
        sort_order: nextOrder,
      })
      .select('id, name, color, sort_order')
      .single();
    setCreatingStatus(false);
    if (error) { toast.error(error.message); return; }
    setBookingStatuses(prev => [...prev, data]);
    setNewStatusName('');
    toast.success('Столбец добавлен');
  };

  const deleteBooking = async (id: string) => {
    const { error } = await supabase.from('bookings').delete().eq('id', id);
    if (error) { toast.error(error.message); return; }
    setBookings(b => b.filter(x => x.id !== id));
    toast.success('Запись удалена');
    setDeletingId(null);
  };

  const shiftDay = (n: number) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + n);
    setSelectedDate(d);
  };

  const emptyMsg = `Записей на ${dateLabel(selectedDate).toLowerCase()} нет`;
  const qrStatusLabel = (value?: string | null) => value ? (QR_STATUS_LABELS[value] ?? value) : '—';
  const bonusStatusLabel = (value?: string | null) => value ? (BONUS_STATUS_LABELS[value] ?? value) : '—';

  return (
    <PageLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Приём клиентов</h2>

          {/* Date nav */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowQrScanner(true)}
              className="neu-btn-primary flex items-center gap-2 px-4 py-2 text-sm"
            >
              <QrCode size={15} />
              Сканировать QR
            </button>
            <button
              onClick={() => shiftDay(-1)}
              className="neu-btn p-2 text-[#64748B] hover:text-[#1A56DB]"
              title="Предыдущий день"
            >
              <ChevronLeft size={16} />
            </button>

            <div className="relative" ref={calRef}>
              <button
                onClick={() => setCalOpen(v => !v)}
                className="neu-sm flex items-center gap-2 px-4 py-2 font-semibold text-sm text-[#1A56DB] hover:text-[#1340B8] transition-colors"
              >
                <CalendarDays size={15} strokeWidth={2} />
                {dateLabel(selectedDate)}
              </button>

              {calOpen && (
                <div className="absolute right-0 top-full mt-2 z-50 neu-lg p-4" style={{ minWidth: 300 }}>
                  <style>{`
                    .rdp { --rdp-cell-size: 38px; margin: 0; font-family: 'Inter', sans-serif; }
                    .rdp-caption_label { font-size: 15px; font-weight: 600; color: #0B1220; letter-spacing: 0.01em; }
                    .rdp-head_cell { font-size: 11px; font-weight: 500; color: #94A3B8; letter-spacing: 0.08em; text-transform: uppercase; }
                    .rdp-day { font-size: 13px; font-weight: 400; color: #475569; border-radius: 10px; }
                    .rdp-day:hover:not([disabled]):not(.rdp-day_selected) {
                      background: #EEF2F6 !important; color: #0B1220 !important;
                    }
                    .rdp-day_selected, .rdp-day_selected:hover {
                      background: #1A56DB !important; color: #fff !important; font-weight: 700;
                    }
                    .rdp-day_today:not(.rdp-day_selected) {
                      color: #1A56DB; font-weight: 700;
                    }
                    .rdp-nav_button { color: #94A3B8; border-radius: 8px; }
                    .rdp-nav_button:hover { background: #EEF2F6; color: #0B1220; }
                  `}</style>
                  <DayPicker
                    mode="single"
                    selected={selectedDate}
                    onSelect={(d) => { if (d) { setSelectedDate(d); setCalOpen(false); } }}
                    locale={ru}
                    weekStartsOn={1}
                  />
                </div>
              )}
            </div>

            <button
              onClick={() => shiftDay(1)}
              className="neu-btn p-2 text-[#64748B] hover:text-[#1A56DB]"
              title="Следующий день"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        <div className="neu-card p-3 flex flex-wrap gap-2">
          {([
            ['today', 'Сегодня'],
            ['waiting', 'Ожидают прихода'],
            ['arrived', 'Пришли'],
            ['late', 'Опоздали'],
            ['noshow', 'No-show'],
            ['app', 'Из Negis App'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setViewFilter(key)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${viewFilter === key ? 'bg-[#1E325C] text-white shadow-sm' : 'bg-white text-[#64748B] border border-[#E7ECF3] hover:text-[#1E325C]'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="neu-card p-4 flex flex-wrap gap-3 items-center">
          <input
            className="neu-input text-sm flex-1 min-w-60"
            placeholder="Название нового столбца"
            value={newStatusName}
            onChange={e => setNewStatusName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') addStatusColumn();
            }}
          />
          <button
            className="neu-btn-primary flex items-center gap-2"
            onClick={addStatusColumn}
            disabled={creatingStatus}
          >
            <Plus size={15} />
            {creatingStatus ? 'Добавление...' : 'Добавить столбец'}
          </button>
        </div>

        {loading ? (
          <div className="neu-card py-16 text-center text-[#94A3B8] text-sm">Загрузка...</div>
        ) : bookings.length === 0 ? (
          <div className="neu-card py-16 text-center text-[#94A3B8] text-sm">{emptyMsg}</div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-3 2xl:grid-cols-4 gap-4 min-h-0">
            {groupedBookings.map(({ status, items }) => (
              <section
                key={status.id}
                onDragOver={e => e.preventDefault()}
                onDrop={e => {
                  e.preventDefault();
                  const booking = bookings.find(item => item.id === e.dataTransfer.getData('text/plain'));
                  setDraggingBookingId('');
                  if (booking && statusForBooking(booking)?.id !== status.id) moveBookingToStatus(booking, status);
                }}
                className={`rounded-2xl border bg-white overflow-hidden h-[calc(100dvh-300px)] min-h-[520px] flex flex-col transition-colors ${draggingBookingId ? 'border-[#BFDBFE]' : 'border-[#E7ECF3]'}`}
              >
                <div className="p-4 border-b border-[#E7ECF3] bg-[#F8FAFC]">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-[#0B1220]">{status.name}</h3>
                      <p className="text-xs text-[#94A3B8] mt-0.5">{dateLabel(selectedDate)}</p>
                    </div>
                    <span className="rounded-full bg-white border border-[#E7ECF3] px-2.5 py-1 text-xs font-bold text-[#64748B]">
                      {items.length}
                    </span>
                  </div>
                </div>

                <div className="p-3 space-y-3 overflow-y-auto overscroll-contain flex-1">
                  {items.length === 0 ? (
                    <div className="py-10 text-center text-sm text-[#94A3B8]">Нет записей</div>
                  ) : items.map(b => (
                    <article
                      key={b.id}
                      draggable
                      onDragStart={e => {
                        setDraggingBookingId(b.id);
                        e.dataTransfer.setData('text/plain', b.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => setDraggingBookingId('')}
                      className={`rounded-xl border bg-white p-4 shadow-sm cursor-grab active:cursor-grabbing transition ${focusedBookingId === b.id ? 'border-[#2859C5] ring-4 ring-[#DBEAFE]' : 'border-[#E7ECF3]'} ${draggingBookingId === b.id ? 'opacity-60 ring-2 ring-[#BFDBFE]' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-bold text-[#0B1220] truncate">{b.patient_name}</div>
                          <div className="text-xs text-[#94A3B8] mt-0.5">{b.patient_phone ?? 'Телефон не указан'}</div>
                        </div>
                        <span className="rounded-full bg-[#EFF6FF] px-2.5 py-1 text-xs font-bold text-[#2859C5] shrink-0">
                          {b.time}
                        </span>
                      </div>
                      <div className="mt-3 space-y-1 text-sm text-[#64748B]">
                        <div>{svcName(b.service_id)}</div>
                        <div>{agtName(b.agent_id)}</div>
                        {b.age != null && <div>{b.age} лет</div>}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${isNegisAppSource(b.source) ? 'bg-[#EEF2FF] text-[#4F46E5]' : 'bg-[#F1F5F9] text-[#64748B]'}`}>
                          {sourceValueToLabel(b.source)}
                        </span>
                        {isNegisAppSource(b.source) && (
                          <>
                            <span className="inline-flex rounded-full bg-[#EFF6FF] px-2 py-0.5 text-[11px] font-bold text-[#2859C5]">
                              {qrStatusLabel(b.qr_status)}
                            </span>
                            <span className="inline-flex rounded-full bg-[#F0FDF4] px-2 py-0.5 text-[11px] font-bold text-[#16A34A]">
                              Бонусы: {bonusStatusLabel(b.bonus_status)}
                            </span>
                          </>
                        )}
                      </div>
                      {b.lead_id && (
                        <span className="mt-3 inline-flex px-2 py-0.5 rounded-full bg-[#EFF6FF] text-[#2859C5] text-[11px] font-bold">
                          Клиент
                        </span>
                      )}
                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setVisited(b.id, true)}
                          className={`px-3 py-2 rounded-lg font-semibold text-xs flex items-center justify-center gap-1.5 transition-all ${
                            b.visited === true
                              ? 'bg-green-100 text-green-700 border border-green-200'
                              : 'border border-[#BBF7D0] bg-[#F0FDF4] text-[#16A34A]'
                          }`}
                        >
                          <Check size={13} strokeWidth={2.5} /> Пришёл
                        </button>
                        <button
                          onClick={() => setVisited(b.id, false)}
                          className={`px-3 py-2 rounded-lg font-semibold text-xs flex items-center justify-center gap-1.5 transition-all ${
                            b.visited === false
                              ? 'bg-red-100 text-red-600 border border-red-200'
                              : 'border border-[#FEE2E2] bg-[#FEF2F2] text-[#DC2626]'
                          }`}
                        >
                          <X size={13} strokeWidth={2.5} /> Не пришёл
                        </button>
                      </div>
                      <button
                        onClick={() => setDeletingId(b.id)}
                        className="mt-2 w-full rounded-lg border border-[#E7ECF3] bg-[#F8FAFC] px-3 py-2 text-xs font-semibold text-[#64748B] hover:text-red-500 transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Trash2 size={13} />
                        Удалить
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* Confirm delete */}
        {deletingId && (
          <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="neu-lg p-8 max-w-sm w-full text-center space-y-5">
              <p className="font-semibold text-[#1E293B]">Удалить эту запись?</p>
              <p className="text-sm text-[#64748B]">Действие нельзя отменить</p>
              <div className="flex gap-3 justify-center">
                <button onClick={() => setDeletingId(null)} className="neu-btn px-6">Отмена</button>
                <button onClick={() => deleteBooking(deletingId)} className="neu-btn-danger px-6">Удалить</button>
              </div>
            </div>
          </div>
        )}
        {showQrScanner && (
          <NegisQrScanner
            clinicId={clinicId}
            userId={user?.id}
            onClose={() => setShowQrScanner(false)}
            onConfirmed={loadBookings}
          />
        )}
      </div>
    </PageLayout>
  );
}
