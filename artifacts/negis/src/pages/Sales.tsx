import { useState, useEffect, useRef } from 'react';
import { PageLayout } from '@/components/layout/PageLayout';
import { WazzupBadge } from '@/components/WazzupBadge';
import { WazzupChat } from '@/components/WazzupChat';
import { Search, Plus, X, Check, ArrowUpDown, Calendar, Trash2, User, Tag, CalendarPlus, ChevronLeft } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useWazzupInbox } from '@/hooks/useWazzupInbox';
import { agentDisplayName, loadAgentRoleMaps } from '@/lib/agentDisplay';
import {
  BONUS_STATUS_LABELS,
  CRM_SOURCES,
  QR_STATUS_LABELS,
  fetchAppClientByPhone,
  isNegisAppSource,
  sourceValueToLabel,
  spendAppBonus,
} from '@/lib/negisApp';
import { toast } from 'sonner';
import { trackEvent } from '@/lib/fbpixel';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { format, startOfDay } from 'date-fns';
import { ru } from 'date-fns/locale';

/* ── Types ─────────────────────────────────────────────── */
interface Lead {
  id: string; clinic_id: string;
  full_name: string | null;
  assigned_to: string | null;
  phone: string | null; email: string | null; company: string | null;
  age: number | null;
  source: string | null; status_id: string | null; comment: string | null;
  created_at: string;
  app_client_id?: string | null; bonus_balance_cached?: number | null;
  lead_statuses?: { name: string; color: string } | null;
}
interface LeadStatus { id: string; name: string; color: string }
interface Agent { id: string; name: string; user_id: string | null; role_id?: string | null }
interface Service { id: string; name: string; price: number }
interface BookingHistory {
  id: string;
  lead_id: string | null;
  patient_name: string | null;
  patient_phone: string | null;
  service_id: string | null;
  agent_id: string | null;
  date: string;
  time: string;
  visited: boolean | null;
  comment: string | null;
  source?: string | null;
  qr_status?: string | null;
  bonus_status?: string | null;
  app_appointment_id?: string | null;
}

const SOURCES = CRM_SOURCES;

const SORT_OPTIONS = [
  { value: 'created_at_desc', label: 'Дата (новые)' },
  { value: 'created_at_asc',  label: 'Дата (старые)' },
  { value: 'phone_asc',       label: 'Телефон (А→Я)' },
  { value: 'name_asc',        label: 'Имя (А→Я)' },
];

const PERIOD_OPTIONS = [
  { value: 'all',       label: 'Все даты' },
  { value: 'today',     label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: '7days',     label: 'Последние 7 дней' },
  { value: '30days',    label: 'Последние 30 дней' },
  { value: 'month',     label: 'Этот месяц' },
  { value: 'lastmonth', label: 'Прошлый месяц' },
  { value: 'custom',    label: 'Произвольный период' },
];

/* ── Date range helper ──────────────────────────────────── */
function getDateRange(period: string, dateFrom: string, dateTo: string): { from: Date | null; to: Date | null } {
  const now  = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = (d: Date) => new Date(d.getTime() + 86400000 - 1);

  switch (period) {
    case 'today':     return { from: today, to: endOfDay(today) };
    case 'yesterday': {
      const y = new Date(today.getTime() - 86400000);
      return { from: y, to: endOfDay(y) };
    }
    case '7days':     return { from: new Date(today.getTime() - 6 * 86400000), to: endOfDay(today) };
    case '30days':    return { from: new Date(today.getTime() - 29 * 86400000), to: endOfDay(today) };
    case 'month':     return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(today) };
    case 'lastmonth': return {
      from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      to:   new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59),
    };
    case 'custom':    return {
      from: dateFrom ? new Date(dateFrom + 'T00:00:00') : null,
      to:   dateTo   ? new Date(dateTo   + 'T23:59:59') : null,
    };
    default: return { from: null, to: null };
  }
}

function normalizePhoneForDuplicate(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits;
}

/* ── Indeterminate checkbox ─────────────────────────────── */
function IndeterminateCheckbox({ checked, indeterminate, onChange }: {
  checked: boolean; indeterminate: boolean; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <input
      ref={ref} type="checkbox" checked={checked} onChange={onChange}
      style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#1E325C' }}
      onClick={e => e.stopPropagation()}
    />
  );
}

/* ═══════════════════════════════════════════════════════ */
export default function Sales() {
  const { clinicId, user, userRole } = useAuth();
  const { unreadCount, resetUnreadCount } = useWazzupInbox({ clinicId, enabled: Boolean(user) });
  const [leads, setLeads]       = useState<Lead[]>([]);
  const [statuses, setStatuses] = useState<LeadStatus[]>([]);
  const [agents, setAgents]     = useState<Agent[]>([]);
  const [customRoleMap, setCustomRoleMap] = useState<Record<string, string>>({});
  const [userRoleMap, setUserRoleMap] = useState<Record<string, string>>({});
  const [myAgentId, setMyAgentId] = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);

  /* ── Filters ── */
  const [search, setSearch]           = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterAgent, setFilterAgent]   = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [sortBy, setSortBy]             = useState('created_at_desc');
  const [periodFilter, setPeriodFilter] = useState('all');
  const [dateFrom, setDateFrom]         = useState('');
  const [dateTo, setDateTo]             = useState('');

  /* ── Pagination ── */
  const [perPage, setPerPage] = useState<number>(20);
  const [page, setPage]       = useState(0);

  /* ── Selection ── */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  /* ── Bulk action panel state ── */
  const [bulkPanel, setBulkPanel]     = useState<'status' | 'agent' | 'source' | 'delete' | null>(null);
  const [bulkStatusId, setBulkStatusId] = useState('');
  const [bulkAgentId, setBulkAgentId]   = useState('');
  const [bulkSource, setBulkSource]     = useState('');
  const [bulkLoading, setBulkLoading]   = useState(false);

  /* ── Lead forms ── */
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [leadDetailTab, setLeadDetailTab] = useState<'overview' | 'timeline' | 'bookings' | 'need' | 'procedures' | 'finance' | 'whatsapp' | 'tasks'>('overview');
  const [leadBookings, setLeadBookings] = useState<BookingHistory[]>([]);
  const [leadBookingsLoading, setLeadBookingsLoading] = useState(false);
  const [quickNote, setQuickNote] = useState('');
  const [taskForm, setTaskForm] = useState({ text: '', dueDate: '' });
  const [appClient, setAppClient] = useState<{ id?: string; bonus_balance?: number; bonusBalance?: number; linked?: boolean } | null>(null);
  const [appClientLoading, setAppClientLoading] = useState(false);
  const [bonusSpendAmount, setBonusSpendAmount] = useState('');
  const [bonusSpendServicePrice, setBonusSpendServicePrice] = useState('');
  const [bonusSpendLoading, setBonusSpendLoading] = useState(false);
  const [procedureForm, setProcedureForm] = useState({
    received: '',
    planned: '',
    paid: '',
    purchaseAmount: '',
    purchaseType: 'Единоразовая процедура',
    bought: '',
    comment: '',
  });
  const [showNew, setShowNew]           = useState(false);
  const emptyForm = { full_name: '', phone: '', email: '', company: '', age: '', source: 'Вручную', status_id: '', assigned_to: '', comment: '' };
  const [form, setForm]   = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  /* ── Services (for booking form) ── */
  const [services, setServices] = useState<Service[]>([]);

  /* ── Booking sub-modal ── */
  const [showBooking, setShowBooking] = useState(false);
  const [bkDate, setBkDate]           = useState<Date>(new Date());
  const [bkForm, setBkForm]           = useState({ service_id: '', agent_id: '', time: '', comment: '' });
  const [bkSaving, setBkSaving]       = useState(false);

  useEffect(() => { if (clinicId) init(); }, [clinicId]);

  const init = async () => {
    if (!clinicId) return;
    setLoading(true);
    const [{ data: sl }, { data: ag }, { data: sv }] = await Promise.all([
      supabase.from('lead_statuses').select('id, name, color').eq('clinic_id', clinicId).eq('pipeline', 'sales').order('sort_order'),
      supabase.from('agents').select('id, name, user_id, role_id').eq('clinic_id', clinicId).order('name'),
      supabase.from('services').select('id, name, price').eq('clinic_id', clinicId).order('name'),
    ]);
    setStatuses(sl ?? []);
    const agentRows = (ag ?? []) as Agent[];
    setAgents(agentRows);
    const maps = await loadAgentRoleMaps(supabase, clinicId, agentRows);
    setCustomRoleMap(maps.customRoleMap);
    setUserRoleMap(maps.userRoleMap);
    setServices(sv ?? []);
    const mine = user ? agentRows.find(a => a.user_id === user.id) : null;
    const mineId = mine?.id ?? null;
    setMyAgentId(mineId);
    await loadLeads(sl ?? [], mineId);
    setLoading(false);
  };

  const loadLeads = async (_sl?: LeadStatus[], agentId = myAgentId) => {
    if (!clinicId) return;
    let q = supabase.from('leads').select('*, lead_statuses(name, color)').eq('clinic_id', clinicId).eq('pipeline', 'sales');
    if (userRole === 'agent') {
      const responsibleIds = [agentId, user?.id].filter(Boolean) as string[];
      if (responsibleIds.length === 0) {
        setLeads([]);
        setSelectedIds(new Set());
        return;
      }
      q = q.in('assigned_to', responsibleIds);
    }
    const [field, asc] = sortBy === 'created_at_desc' ? ['created_at', false]
      : sortBy === 'created_at_asc'  ? ['created_at', true]
      : sortBy === 'phone_asc'       ? ['phone', true]
      : ['full_name', true];
    q = q.order(field, { ascending: asc });
    const { data, error } = await q;
    if (error) { toast.error(error.message); return; }
    setLeads(data ?? []);
    setSelectedIds(new Set());
  };

  useEffect(() => { if (clinicId && !loading) loadLeads(); }, [sortBy, myAgentId, userRole, user?.id]);

  useEffect(() => {
    if (selectedLead) {
      setLeadDetailTab('overview');
      setQuickNote('');
      setTaskForm({ text: '', dueDate: '' });
      setAppClient(null);
      setBonusSpendAmount('');
      setBonusSpendServicePrice('');
      setProcedureForm({
        received: '',
        planned: '',
        paid: '',
        purchaseAmount: '',
        purchaseType: 'Единоразовая процедура',
        bought: '',
        comment: '',
      });
      loadLeadBookings(selectedLead);
      loadAppClient(selectedLead);
    } else {
      setLeadBookings([]);
      setAppClient(null);
    }
  }, [selectedLead?.id]);

  /* ── Client-side filtering ── */
  const displayed = leads.filter(l => {
    if (search && !(l.full_name ?? '').toLowerCase().includes(search.toLowerCase()) && !(l.phone ?? '').includes(search)) return false;
    if (filterStatus && l.status_id !== filterStatus) return false;
    if (filterAgent) {
      const rowAgent = agents.find(a => a.id === l.assigned_to) ?? agents.find(a => a.user_id === l.assigned_to);
      if ((rowAgent?.id ?? l.assigned_to) !== filterAgent) return false;
    }
    if (filterSource && sourceValueToLabel(l.source) !== filterSource) return false;
    if (periodFilter !== 'all') {
      const { from, to } = getDateRange(periodFilter, dateFrom, dateTo);
      const created = new Date(l.created_at);
      if (from && created < from) return false;
      if (to   && created > to)   return false;
    }
    return true;
  });

  /* ── Pagination computed ── */
  const totalFiltered = displayed.length;
  const pageCount  = perPage === 0 ? 1 : Math.max(1, Math.ceil(totalFiltered / perPage));
  const safePage   = Math.min(page, pageCount - 1);
  const pageItems  = perPage === 0 ? displayed : displayed.slice(safePage * perPage, safePage * perPage + perPage);
  const rangeFrom  = totalFiltered === 0 ? 0 : safePage * (perPage || totalFiltered) + 1;
  const rangeTo    = perPage === 0 ? totalFiltered : Math.min(safePage * perPage + perPage, totalFiltered);

  /* Reset page when filters change */
  useEffect(() => { setPage(0); }, [search, filterStatus, filterAgent, filterSource, periodFilter, dateFrom, dateTo, perPage]);

  /* ── Selection helpers (operate on current page only) ── */
  const allSelected = pageItems.length > 0 && pageItems.every(l => selectedIds.has(l.id));
  const someSelected = pageItems.some(l => selectedIds.has(l.id));
  const indeterminate = someSelected && !allSelected;

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pageItems.map(l => l.id)));
    }
  };
  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const clearSelection = () => { setSelectedIds(new Set()); setBulkPanel(null); };

  const loadLeadBookings = async (lead: Lead) => {
    if (!clinicId) return;
    setLeadBookingsLoading(true);
    const primary = await supabase
      .from('bookings')
      .select('id, lead_id, patient_name, patient_phone, service_id, agent_id, date, time, visited, comment, source, qr_status, bonus_status, app_appointment_id')
      .eq('clinic_id', clinicId)
      .order('date', { ascending: false })
      .order('time', { ascending: false })
      .limit(500);
    let data = primary.data as BookingHistory[] | null;
    let error = primary.error;
    if (error?.message?.includes('column')) {
      const fallback = await supabase
        .from('bookings')
        .select('id, lead_id, patient_name, patient_phone, service_id, agent_id, date, time, visited, comment')
        .eq('clinic_id', clinicId)
        .order('date', { ascending: false })
        .order('time', { ascending: false })
        .limit(500);
      data = fallback.data as BookingHistory[] | null;
      error = fallback.error;
    }
    setLeadBookingsLoading(false);
    if (error) { toast.error(error.message); return; }
    const normalizedPhone = normalizePhoneForDuplicate(lead.phone);
    const rows = ((data ?? []) as BookingHistory[]).filter(b =>
      b.lead_id === lead.id ||
      (!!normalizedPhone && normalizePhoneForDuplicate(b.patient_phone) === normalizedPhone)
    );
    setLeadBookings(rows);
  };

  const loadAppClient = async (lead: Lead) => {
    if (!lead.phone) return;
    setAppClientLoading(true);
    try {
      const data = await fetchAppClientByPhone(lead.phone);
      setAppClient(data);
      const nextBalance = data.bonus_balance ?? data.bonusBalance ?? lead.bonus_balance_cached ?? 0;
      if (data.id || nextBalance !== (lead.bonus_balance_cached ?? 0)) {
        await supabase
          .from('leads')
          .update({ app_client_id: data.id ?? lead.app_client_id ?? null, bonus_balance_cached: nextBalance })
          .eq('id', lead.id);
      }
    } catch {
      setAppClient(null);
    } finally {
      setAppClientLoading(false);
    }
  };

  const findDuplicateLeadByPhone = async (phone: string | null | undefined, ignoreId?: string) => {
    if (!clinicId) return null;
    const normalizedPhone = normalizePhoneForDuplicate(phone);
    if (!normalizedPhone) return null;
    const { data, error } = await supabase
      .from('leads')
      .select('id, full_name, phone')
      .eq('clinic_id', clinicId)
      .eq('pipeline', 'sales')
      .not('phone', 'is', null);
    if (error) {
      toast.error(error.message);
      return null;
    }
    return (data ?? []).find(lead =>
      lead.id !== ignoreId && normalizePhoneForDuplicate(lead.phone) === normalizedPhone
    ) ?? null;
  };

  /* ── Bulk actions ── */
  const bulkUpdate = async (patch: Record<string, unknown>) => {
    if (!clinicId || selectedIds.size === 0) return;
    setBulkLoading(true);
    const ids = Array.from(selectedIds);
    const { error } = await supabase.from('leads').update(patch).eq('clinic_id', clinicId).eq('pipeline', 'sales').in('id', ids);
    setBulkLoading(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Обновлено ${ids.length} лидов`);
    clearSelection();
    loadLeads();
  };

  const bulkDelete = async () => {
    if (!clinicId || selectedIds.size === 0) return;
    setBulkLoading(true);
    const ids = Array.from(selectedIds);
    const { error } = await supabase.from('leads').delete().eq('clinic_id', clinicId).eq('pipeline', 'sales').in('id', ids);
    setBulkLoading(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Удалено ${ids.length} лидов`);
    clearSelection();
    loadLeads();
  };

  /* ── Lead CRUD ── */
  const createLead = async () => {
    if (!form.full_name.trim()) { toast.error('Введите полное имя'); return; }
    if (!form.phone.trim()) { toast.error('Введите телефон'); return; }
    setSaving(true);
    const duplicate = await findDuplicateLeadByPhone(form.phone);
    if (duplicate) {
      setSaving(false);
      toast.error(`Дубликат телефона: ${duplicate.full_name || duplicate.phone}`);
      return;
    }
    // safeAgentId ensures we only send agents.id that exists in current list,
    // or null — never an empty string, user_id, or stale/deleted agent UUID.
    const assignedTo = safeAgentId(form.assigned_to || myAgentId);
    const { error } = await supabase.from('leads').insert({
      clinic_id: clinicId,
      pipeline: 'sales',
      full_name: form.full_name.trim(), phone: form.phone,
      email: form.email || null, company: form.company || null,
      age: form.age ? parseInt(form.age) : null, source: form.source,
      status_id: form.status_id || statuses[0]?.id || null,
      assigned_to: assignedTo,
      comment: form.comment || null,
    });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Лид создан');
    trackEvent('Lead');
    setShowNew(false); setForm(emptyForm); init();
  };

  const updateLead = async () => {
    if (!selectedLead) return;
    setSaving(true);
    const duplicate = await findDuplicateLeadByPhone(selectedLead.phone, selectedLead.id);
    if (duplicate) {
      setSaving(false);
      toast.error(`Дубликат телефона: ${duplicate.full_name || duplicate.phone}`);
      return;
    }
    // safeAgentId: ensure we only pass agents.id that exists in the loaded list,
    // or null — converts stale user_id refs to agents.id, falls back to null.
    const assignedTo = safeAgentId(selectedLead.assigned_to);
    const payload = {
      full_name: selectedLead.full_name,
      phone: selectedLead.phone,
      email: selectedLead.email || null,
      company: selectedLead.company || null,
      age: selectedLead.age ? Number(selectedLead.age) : null,
      source: selectedLead.source,
      status_id: selectedLead.status_id || null,
      assigned_to: assignedTo,
      comment: selectedLead.comment || null,
      app_client_id: selectedLead.app_client_id || appClient?.id || null,
      bonus_balance_cached: Number(appClient?.bonus_balance ?? appClient?.bonusBalance ?? selectedLead.bonus_balance_cached ?? 0),
    };
    const { error } = await supabase.from('leads').update(payload).eq('id', selectedLead.id);
    if (error) {
      if (error.message.includes('column')) {
        const legacyPayload = { ...payload } as Record<string, unknown>;
        delete legacyPayload.app_client_id;
        delete legacyPayload.bonus_balance_cached;
        const { error: legacyError } = await supabase.from('leads').update(legacyPayload).eq('id', selectedLead.id);
        setSaving(false);
        if (legacyError) { toast.error(legacyError.message); return; }
        toast.success('Лид обновлён. Для связки Negis App выполните миграцию 006.');
        setSelectedLead(null); init(); return;
      }
      // FK violation on assigned_to: stale DB data — clear it and retry
      if (error.message.includes('leads_assigned_to_fkey') || error.code === '23503') {
        const { error: e2 } = await supabase.from('leads')
          .update({ ...payload, assigned_to: null })
          .eq('id', selectedLead.id);
        setSaving(false);
        if (e2) { toast.error(e2.message); return; }
        toast.success('Лид обновлён (ответственный сброшен — запустите миграцию 002)');
        setSelectedLead(null); init(); return;
      }
      setSaving(false);
      toast.error(error.message); return;
    }
    setSaving(false);
    toast.success('Лид обновлён'); setSelectedLead(null); init();
  };

  const deleteLead = async (id: string) => {
    const { error } = await supabase.from('leads').delete().eq('id', id);
    if (error) { toast.error(error.message); return; }
    toast.success('Лид удалён'); setSelectedLead(null); init();
  };

  /* ── Booking from lead ── */
  const openBookingForLead = () => {
    setBkDate(new Date());
    setBkForm({ service_id: services[0]?.id ?? '', agent_id: myAgentId ?? '', time: '', comment: '' });
    setShowBooking(true);
  };

  const saveLeadBooking = async () => {
    if (!selectedLead) return;
    const name = (selectedLead.full_name ?? '').trim();
    if (!name) { toast.error('У лида нет имени — добавьте имя и сохраните'); return; }
    if (!bkForm.time) { toast.error('Укажите время записи'); return; }
    setBkSaving(true);
    const { error } = await supabase.from('bookings').insert({
      clinic_id:      clinicId,
      lead_id:        selectedLead.id,
      patient_name:   name,
      patient_phone:  selectedLead.phone ?? null,
      service_id:     bkForm.service_id || null,
      agent_id:       safeAgentId(bkForm.agent_id),
      time:           bkForm.time,
      date:           format(bkDate, 'yyyy-MM-dd'),
      duration_minutes: 0,
      comment:        bkForm.comment ? `Клиент · ${bkForm.comment}` : 'Клиент',
    });
    setBkSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Записано на ${format(bkDate, 'd MMM', { locale: ru })} в ${bkForm.time}`);
    setShowBooking(false);
    loadLeadBookings(selectedLead);
  };

  /* ── Helpers ── */
  const statusColor = (lead: Lead) => lead.lead_statuses?.color ?? '#94A3B8';
  const statusName  = (lead: Lead) => lead.lead_statuses?.name  ?? '—';
  const displayName = (lead: Lead) => lead.full_name || '—';

  /**
   * Returns agents.id if it exists in the current agents list, otherwise null.
   * Prevents FK violations when an agent was deleted or when old data stores
   * auth.users UUID instead of agents.id.
   */
  const safeAgentId = (id: string | null | undefined): string | null => {
    if (!id) return null;
    if (agents.some(a => a.id === id)) return id;
    // Fallback: if old data stored user_id, look up the correct agents.id
    const byUserId = agents.find(a => a.user_id === id);
    return byUserId?.id ?? null;
  };

  const agentForLead = (lead: Lead) =>
    agents.find(a => a.id === lead.assigned_to) ??
    agents.find(a => a.user_id === lead.assigned_to) ?? null;
  const agentLabel = (agent: Agent | null | undefined) => agentDisplayName(agent, customRoleMap, userRoleMap);
  const agentName = (lead: Lead) => agentLabel(agentForLead(lead));
  const serviceName = (id: string | null) => id ? (services.find(s => s.id === id)?.name ?? '—') : '—';
  const servicePrice = (id: string | null) => id ? (services.find(s => s.id === id)?.price ?? 0) : 0;
  const bookingAgentName = (id: string | null) => id ? agentLabel(agents.find(a => a.id === id)) : '—';
  const money = (value: number) => value.toLocaleString('ru-RU') + ' ₸';
  const appBalance = Number(appClient?.bonus_balance ?? appClient?.bonusBalance ?? selectedLead?.bonus_balance_cached ?? 0);
  const parseMoneyValue = (value: string | null | undefined) => {
    if (!value) return 0;
    const raw = value.toLowerCase().replace(/\u00a0/g, ' ');
    const match = raw.match(/(\d+(?:[\s.,]\d+)*)\s*(к|k|тыс|тысяч|м|m|млн)?/i);
    if (!match) return 0;
    const suffix = match[2]?.toLowerCase();
    const token = match[1].trim();
    const normalized = suffix
      ? token.replace(/\s/g, '').replace(',', '.')
      : token.replace(/[\s.,]/g, '');
    const base = Number(normalized);
    if (!Number.isFinite(base)) return 0;
    if (suffix === 'м' || suffix === 'm' || suffix === 'млн') return Math.round(base * 1000000);
    if (suffix === 'к' || suffix === 'k' || suffix === 'тыс' || suffix === 'тысяч') return Math.round(base * 1000);
    return Math.round(base);
  };
  const extractField = (line: string, labels: string[]) => {
    const escaped = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const body = line.replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '');
    const match = body.match(new RegExp(`(?:^|;)\\s*(?:${escaped}):\\s*([^;]+)`, 'i'));
    return match?.[1]?.trim() ?? '';
  };
  const bookingStatusLabel = (booking: BookingHistory) =>
    booking.visited === true ? 'Пришёл'
      : booking.visited === false ? 'Не пришёл'
      : 'Записан';
  const bookingStatusColor = (booking: BookingHistory) =>
    booking.visited === true ? '#16A34A'
      : booking.visited === false ? '#DC2626'
      : '#2859C5';
  const qrStatusLabel = (value?: string | null) => value ? (QR_STATUS_LABELS[value] ?? value) : '—';
  const bonusStatusLabel = (value?: string | null) => value ? (BONUS_STATUS_LABELS[value] ?? value) : '—';
  const sortedLeadBookings = [...leadBookings].sort((a, b) =>
    `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`)
  );
  const visitedBookings = sortedLeadBookings.filter(b => b.visited === true);
  const plannedBookings = sortedLeadBookings.filter(b => b.visited === null);
  const nextBooking = [...plannedBookings].reverse().find(b => new Date(`${b.date}T${b.time}`) >= new Date()) ?? plannedBookings[0] ?? null;
  const lastTouchDate = sortedLeadBookings[0]?.date ?? selectedLead?.created_at ?? null;
  const totalServiceValue = visitedBookings.reduce((sum, b) => sum + servicePrice(b.service_id), 0);
  const potentialServiceValue = sortedLeadBookings.reduce((sum, b) => sum + servicePrice(b.service_id), 0);
  const commentLines = (selectedLead?.comment ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const financeEntries = commentLines.map(line => {
    const bought = extractField(line, ['купил']);
    const purchaseAmountText = extractField(line, ['сумма покупки', 'стоимость', 'потенциал']);
    const paidText = extractField(line, ['оплатил', 'оплата', 'платёж', 'платеж']);
    const purchaseAmount = parseMoneyValue(purchaseAmountText) || parseMoneyValue(bought);
    const paidAmount = parseMoneyValue(paidText);
    return { line, bought, purchaseAmount, paidAmount };
  }).filter(entry => entry.bought || entry.purchaseAmount > 0 || entry.paidAmount > 0);
  const manualPotentialValue = financeEntries.reduce((sum, entry) => sum + entry.purchaseAmount, 0);
  const manualPaidValue = financeEntries.reduce((sum, entry) => sum + entry.paidAmount, 0);
  const crmPotentialValue = manualPotentialValue || potentialServiceValue;
  const crmPaidValue = manualPaidValue;
  const crmRemainingValue = Math.max(crmPotentialValue - crmPaidValue, 0);
  const leadTaskLines = commentLines.filter(line => /^\[[^\]]+\]\s*Задача:/i.test(line));
  const timelineItems = selectedLead ? [
    { id: 'created', date: selectedLead.created_at, title: 'Лид создан', body: selectedLead.source ? `Источник: ${selectedLead.source}` : 'Первое обращение' },
    ...commentLines.map((line, index) => ({ id: `note-${index}`, date: selectedLead.created_at, title: 'Заметка', body: line })),
    ...sortedLeadBookings.map(b => ({
      id: `booking-${b.id}`,
      date: `${b.date}T${b.time}`,
      title: `${bookingStatusLabel(b)}: ${serviceName(b.service_id)}`,
      body: `${b.date} ${b.time}${b.comment ? ` · ${b.comment}` : ''}`,
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()) : [];
  const appendLeadHistory = async (title: string, body: string) => {
    if (!selectedLead || !body.trim()) return false;
    const stamp = new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
    const line = `[${stamp}] ${title}: ${body.trim()}`;
    const nextComment = selectedLead.comment ? `${selectedLead.comment}\n${line}` : line;
    const { error } = await supabase
      .from('leads')
      .update({ comment: nextComment, updated_at: new Date().toISOString() })
      .eq('id', selectedLead.id);
    if (error) { toast.error(error.message); return false; }
    setSelectedLead({ ...selectedLead, comment: nextComment });
    setLeads(prev => prev.map(lead => lead.id === selectedLead.id ? { ...lead, comment: nextComment } : lead));
    toast.success('Добавлено в историю');
    return true;
  };
  const appendQuickNote = async () => {
    const saved = await appendLeadHistory('Комментарий', quickNote);
    if (saved) setQuickNote('');
  };
  const appendClientTask = async () => {
    if (!taskForm.text.trim()) { toast.error('Напишите задачу'); return; }
    if (!taskForm.dueDate) { toast.error('Выберите дату задачи'); return; }
    const saved = await appendLeadHistory('Задача', `${taskForm.text.trim()}; срок: ${taskForm.dueDate}; статус: todo`);
    if (saved) setTaskForm({ text: '', dueDate: '' });
  };
  const appendProcedureHistory = async () => {
    if (!procedureForm.received.trim() && !procedureForm.planned.trim() && !procedureForm.paid.trim() && !procedureForm.purchaseAmount.trim() && !procedureForm.bought.trim()) {
      toast.error('Заполните хотя бы одно поле по процедурам или оплате');
      return;
    }
    const parts = [
      procedureForm.bought.trim() ? `купил: ${procedureForm.bought.trim()}` : '',
      `формат: ${procedureForm.purchaseType}`,
      procedureForm.purchaseAmount.trim() ? `сумма покупки: ${procedureForm.purchaseAmount.trim()}` : '',
      procedureForm.received.trim() ? `получил: ${procedureForm.received.trim()}` : '',
      procedureForm.planned.trim() ? `ещё получит: ${procedureForm.planned.trim()}` : '',
      procedureForm.paid.trim() ? `оплатил: ${procedureForm.paid.trim()}` : '',
      procedureForm.comment.trim() ? `комментарий: ${procedureForm.comment.trim()}` : '',
    ].filter(Boolean).join('; ');
    const saved = await appendLeadHistory('Процедуры и оплата', parts);
    if (saved) {
      setProcedureForm({
        received: '',
        planned: '',
        paid: '',
        purchaseAmount: '',
        purchaseType: 'Единоразовая процедура',
        bought: '',
        comment: '',
      });
    }
  };

  const applyBonusSpend = async () => {
    if (!clinicId || !selectedLead) return;
    const servicePriceValue = parseMoneyValue(bonusSpendServicePrice);
    const requested = parseMoneyValue(bonusSpendAmount);
    const maxAllowed = Math.floor(servicePriceValue * 0.5);
    if (!servicePriceValue) { toast.error('Укажите стоимость услуги'); return; }
    if (!requested) { toast.error('Укажите сумму бонусов'); return; }
    if (requested > maxAllowed) {
      toast.error(`Можно списать максимум ${money(maxAllowed)} — 50% стоимости услуги`);
      return;
    }
    if (requested > appBalance) {
      toast.error('У клиента недостаточно бонусов');
      return;
    }
    setBonusSpendLoading(true);
    try {
      await spendAppBonus({
        clinic_id: clinicId,
        client_phone: selectedLead.phone,
        client_id: selectedLead.app_client_id || appClient?.id || null,
        lead_id: selectedLead.id,
        amount: requested,
        service_price: servicePriceValue,
      });
      await appendLeadHistory('Бонусы Negis App', `списано: ${money(requested)}; стоимость услуги: ${money(servicePriceValue)}; к оплате деньгами: ${money(servicePriceValue - requested)}`);
      toast.success('Списание отправлено в backend');
      setBonusSpendAmount('');
      setBonusSpendServicePrice('');
      loadAppClient(selectedLead);
    } catch (e: any) {
      toast.error(e.message || 'Backend не списал бонусы');
    } finally {
      setBonusSpendLoading(false);
    }
  };

  const IS: React.CSSProperties = {
    background: '#F4F7FB', border: '1px solid #E7ECF3', borderRadius: 10,
    padding: '9px 13px', fontSize: 13, color: '#0B1220',
    fontFamily: "'Inter', sans-serif", outline: 'none', width: '100%',
  };
  const BSEL: React.CSSProperties = { ...IS, padding: '7px 10px', width: 'auto', minWidth: 160 };
  const BkIS: React.CSSProperties = {
    background: '#FFFFFF', border: '1px solid #E7ECF3', borderRadius: 8,
    padding: '8px 11px', fontSize: 13, color: '#0B1220',
    fontFamily: "'Inter', sans-serif", outline: 'none', width: '100%',
  };

  const colSpan = 8; // checkbox + 6 cols + actions

  return (
    <PageLayout>
      <div className="space-y-5 h-full flex flex-col">

        {/* ── Header ── */}
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-bold">Negis Клиенты</h2>
          <button className="neu-btn-primary flex items-center gap-2" onClick={() => setShowNew(true)}>
            <Plus size={16} /> Новый лид
          </button>
        </div>

        {/* ── Filters ── */}
        <div className="neu-card p-4 flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-40">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94A3B8]" />
            <input type="text" placeholder="Имя или телефон"
              className="neu-input pl-9 text-sm" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="neu-input text-sm w-36" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">Все статусы</option>
            {statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {(userRole === 'owner' || userRole === 'manager') && (
            <select className="neu-input text-sm w-40" value={filterAgent} onChange={e => setFilterAgent(e.target.value)}>
              <option value="">Все агенты</option>
              {agents.map(a => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
            </select>
          )}
          <select className="neu-input text-sm w-36" value={filterSource} onChange={e => setFilterSource(e.target.value)}>
            <option value="">Все источники</option>
            {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="flex items-center gap-1.5">
            <ArrowUpDown size={13} className="text-[#94A3B8]" />
            <select className="neu-input text-sm w-40" value={sortBy} onChange={e => setSortBy(e.target.value)}>
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {/* ── Period filter ── */}
          <div className="flex items-center gap-1.5">
            <Calendar size={13} className="text-[#94A3B8]" />
            <select className="neu-input text-sm w-44" value={periodFilter} onChange={e => { setPeriodFilter(e.target.value); setDateFrom(''); setDateTo(''); }}>
              {PERIOD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {periodFilter === 'custom' && (
            <>
              <input type="date" className="neu-input text-sm w-36" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              <span className="text-[#94A3B8] text-sm">—</span>
              <input type="date" className="neu-input text-sm w-36" value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </>
          )}
          {/* ── Per-page selector ── */}
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-xs text-[#94A3B8] whitespace-nowrap">На странице:</span>
            <select className="neu-input text-sm w-20" value={perPage} onChange={e => setPerPage(Number(e.target.value))}>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={0}>Все</option>
            </select>
          </div>
        </div>

        {/* ── Bulk action bar ── */}
        {selectedIds.size > 0 && (
          <div style={{
            background: '#1E325C', borderRadius: 12, padding: '10px 16px',
            display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
          }}>
            <span style={{ color: '#93C5FD', fontSize: 13, fontWeight: 600, marginRight: 4 }}>
              Выбрано: {selectedIds.size}
            </span>

            {/* Status */}
            {bulkPanel === 'status' ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select style={BSEL} value={bulkStatusId} onChange={e => setBulkStatusId(e.target.value)}>
                  <option value="">— статус —</option>
                  {statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <BulkConfirmBtn disabled={!bulkStatusId || bulkLoading} onClick={() => bulkUpdate({ status_id: bulkStatusId })}>
                  {bulkLoading ? '...' : 'Применить'}
                </BulkConfirmBtn>
                <BulkCancelBtn onClick={() => setBulkPanel(null)} />
              </div>
            ) : bulkPanel === 'agent' ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select style={BSEL} value={bulkAgentId} onChange={e => setBulkAgentId(e.target.value)}>
                  <option value="">— снять —</option>
                  {agents.map(a => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
                </select>
                <BulkConfirmBtn disabled={bulkLoading} onClick={() => bulkUpdate({ assigned_to: safeAgentId(bulkAgentId) })}>
                  {bulkLoading ? '...' : 'Применить'}
                </BulkConfirmBtn>
                <BulkCancelBtn onClick={() => setBulkPanel(null)} />
              </div>
            ) : bulkPanel === 'source' ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select style={BSEL} value={bulkSource} onChange={e => setBulkSource(e.target.value)}>
                  <option value="">— источник —</option>
                  {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <BulkConfirmBtn disabled={!bulkSource || bulkLoading} onClick={() => bulkUpdate({ source: bulkSource })}>
                  {bulkLoading ? '...' : 'Применить'}
                </BulkConfirmBtn>
                <BulkCancelBtn onClick={() => setBulkPanel(null)} />
              </div>
            ) : bulkPanel === 'delete' ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: '#FCA5A5', fontSize: 13 }}>
                  Удалить {selectedIds.size} лидов? Это нельзя отменить.
                </span>
                <BulkConfirmBtn disabled={bulkLoading} onClick={bulkDelete} danger>
                  {bulkLoading ? '...' : 'Удалить'}
                </BulkConfirmBtn>
                <BulkCancelBtn onClick={() => setBulkPanel(null)} />
              </div>
            ) : (
              /* Default: show action buttons */
              <>
                <BulkActionBtn icon={<Tag size={12} />} onClick={() => { setBulkStatusId(''); setBulkPanel('status'); }}>
                  Изменить статус
                </BulkActionBtn>
                <BulkActionBtn icon={<User size={12} />} onClick={() => { setBulkAgentId(''); setBulkPanel('agent'); }}>
                  Назначить ответственного
                </BulkActionBtn>
                <BulkActionBtn icon={<Tag size={12} />} onClick={() => { setBulkSource(''); setBulkPanel('source'); }}>
                  Изменить источник
                </BulkActionBtn>
                <BulkActionBtn icon={<Trash2 size={12} />} danger onClick={() => setBulkPanel('delete')}>
                  Удалить
                </BulkActionBtn>
              </>
            )}

            <button onClick={clearSelection} style={{
              marginLeft: 'auto', background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8,
              color: '#CBD5E1', fontSize: 12, padding: '5px 10px', cursor: 'pointer',
            }}>
              Снять выбор
            </button>
          </div>
        )}

        {/* ── Table ── */}
        <div className="neu-card flex-1 overflow-hidden p-0">
          <div className="overflow-x-auto h-full">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#E7ECF3] text-[#64748B] text-sm sticky top-0 bg-white z-10">
                  <th className="p-4 w-10">
                    <IndeterminateCheckbox
                      checked={allSelected}
                      indeterminate={indeterminate}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="p-4 font-semibold">Имя</th>
                  <th className="p-4 font-semibold">Телефон</th>
                  <th className="p-4 font-semibold">Источник</th>
                  <th className="p-4 font-semibold">Статус</th>
                  <th className="p-4 font-semibold">Ответственный</th>
                  <th className="p-4 font-semibold">Дата</th>
                  <th className="p-4 font-semibold text-right">Действия</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={colSpan} className="py-16 text-center text-[#94A3B8] text-sm">Загрузка...</td></tr>
                ) : pageItems.length === 0 ? (
                  <tr><td colSpan={colSpan} className="py-16 text-center text-[#94A3B8] text-sm">
                    Нет лидов. Добавьте первый или импортируйте из CSV.
                  </td></tr>
                ) : pageItems.map(lead => {
                  const isSelected = selectedIds.has(lead.id);
                  return (
                    <tr key={lead.id}
                      className="border-b border-[#F1F5F9] cursor-pointer transition-colors text-sm"
                      style={{ background: isSelected ? '#EFF6FF' : undefined }}
                      onClick={() => setSelectedLead({ ...lead, assigned_to: safeAgentId(lead.assigned_to) })}
                    >
                      <td className="p-4 w-10" onClick={e => { e.stopPropagation(); toggleOne(lead.id); }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOne(lead.id)}
                          style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#1E325C' }}
                          onClick={e => e.stopPropagation()}
                        />
                      </td>
                      <td className="p-4 font-medium text-[#0B1220]">{displayName(lead)}</td>
                      <td className="p-4 text-[#64748B]">{lead.phone ?? '—'}</td>
                      <td className="p-4 text-[#64748B]">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${sourceValueToLabel(lead.source) === 'Negis App' ? 'bg-[#EEF2FF] text-[#4F46E5]' : 'bg-[#F1F5F9] text-[#64748B]'}`}>
                          {sourceValueToLabel(lead.source)}
                        </span>
                      </td>
                      <td className="p-4">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                          style={{ background: statusColor(lead) + '18', color: statusColor(lead) }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(lead) }} />
                          {statusName(lead)}
                        </span>
                      </td>
                      <td className="p-4 text-[#64748B]">{agentName(lead)}</td>
                      <td className="p-4 text-[#94A3B8]">
                        {new Date(lead.created_at).toLocaleDateString('ru-RU')}
                      </td>
                      <td className="p-4 text-right">
                        <button className="neu-btn px-2 py-1 text-xs text-[#64748B]"
                          onClick={e => { e.stopPropagation(); setSelectedLead({ ...lead, assigned_to: safeAgentId(lead.assigned_to) }); }}>
                          Открыть
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Pagination footer ── */}
        {!loading && totalFiltered > 0 && (
          <div className="neu-card p-3 flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs text-[#94A3B8]">
              {totalFiltered === 0 ? 'Нет результатов' : `Показано ${rangeFrom}–${rangeTo} из ${totalFiltered}`}
            </span>
            {perPage > 0 && pageCount > 1 && (
              <div className="flex items-center gap-1">
                <PagBtn disabled={safePage === 0} onClick={() => setPage(0)}>«</PagBtn>
                <PagBtn disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹</PagBtn>
                {Array.from({ length: pageCount }, (_, i) => i)
                  .filter(i => Math.abs(i - safePage) <= 2)
                  .map(i => (
                    <PagBtn key={i} active={i === safePage} onClick={() => setPage(i)}>
                      {i + 1}
                    </PagBtn>
                  ))}
                <PagBtn disabled={safePage >= pageCount - 1} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}>›</PagBtn>
                <PagBtn disabled={safePage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>»</PagBtn>
              </div>
            )}
          </div>
        )}

        {/* ── New Lead Modal ── */}
        {showNew && (
          <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={e => { if (e.target === e.currentTarget) setShowNew(false); }}>
            <div style={{
              background: '#FFFFFF', border: '1px solid #E7ECF3', borderRadius: 20,
              boxShadow: '0 24px 64px rgba(15,23,42,0.14)', width: '100%', maxWidth: 440, padding: '32px 28px',
            }}>
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-base font-bold text-[#0B1220]">Новый лид</h3>
                <button onClick={() => setShowNew(false)} style={{ background: '#F4F7FB', border: '1px solid #E7ECF3', borderRadius: 8, padding: 6, cursor: 'pointer' }}>
                  <X size={15} color="#64748B" />
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-[#64748B] font-medium block mb-1.5">Полное имя</label>
                  <input type="text" style={IS} placeholder="Иванов Иван" value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#64748B] font-medium block mb-1.5">Телефон *</label>
                    <input style={IS} placeholder="+7 700 000 0000" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                  </div>
                  <div>
                    <label className="text-xs text-[#64748B] font-medium block mb-1.5">Email</label>
                    <input style={IS} type="email" placeholder="email@example.com" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[#64748B] font-medium block mb-1.5">Компания</label>
                  <input style={IS} placeholder="Название компании" value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#64748B] font-medium block mb-1.5">Источник</label>
                    <select style={IS} value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))}>
                      {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-[#64748B] font-medium block mb-1.5">Статус</label>
                    <select style={IS} value={form.status_id} onChange={e => setForm(f => ({ ...f, status_id: e.target.value }))}>
                      <option value="">— выбрать —</option>
                      {statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                </div>
                {(userRole === 'owner' || userRole === 'manager') && (
                  <div>
                    <label className="text-xs text-[#64748B] font-medium block mb-1.5">Ответственный</label>
                    <select style={IS} value={form.assigned_to} onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))}>
                      <option value="">— выбрать —</option>
                      {agents.map(a => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="text-xs text-[#64748B] font-medium block mb-1.5">Комментарий</label>
                  <textarea style={{ ...IS, minHeight: 70, resize: 'vertical' } as React.CSSProperties}
                    placeholder="Заметки..." value={form.comment} onChange={e => setForm(f => ({ ...f, comment: e.target.value }))} />
                </div>
              </div>
              <div className="flex gap-3 mt-5">
                <button onClick={() => setShowNew(false)} style={{ flex: 1, padding: '11px', borderRadius: 12, background: '#F4F7FB', border: '1px solid #E7ECF3', fontSize: 14, color: '#475569', cursor: 'pointer' }}>
                  Отмена
                </button>
                <button onClick={createLead} disabled={saving}
                  style={{ flex: 1, padding: '11px', borderRadius: 12, background: '#1E325C', border: 'none', fontSize: 14, color: '#FFF', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <Check size={15} />{saving ? 'Создание...' : 'Создать'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Lead Detail Modal ── */}
        {selectedLead && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-3">
            <div className="bg-white w-full max-w-7xl max-h-[94vh] rounded-[20px] shadow-2xl flex flex-col overflow-hidden border border-[#E7ECF3]">
              <div className="px-6 py-5 border-b border-[#E7ECF3] flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h3 className="text-xl font-black text-[#0B1220]">{displayName(selectedLead)}</h3>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                      style={{ background: statusColor(selectedLead) + '18', color: statusColor(selectedLead) }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(selectedLead) }} />
                      {statusName(selectedLead)}
                    </span>
                  </div>
                  <div className="mt-2 flex gap-3 flex-wrap text-xs text-[#64748B]">
                    <span>{selectedLead.phone || 'Телефон не указан'}</span>
                    <span>Источник: {selectedLead.source || '—'}</span>
                    <span>Ответственный: {agentName(selectedLead)}</span>
                    <span>Первое обращение: {new Date(selectedLead.created_at).toLocaleDateString('ru-RU')}</span>
                  </div>
                </div>
                <button onClick={() => setSelectedLead(null)} style={{ background: '#F4F7FB', border: '1px solid #E7ECF3', borderRadius: 8, padding: 6, cursor: 'pointer' }}>
                  <X size={15} color="#64748B" />
                </button>
              </div>
              <div className="border-b border-[#E7ECF3] px-6 py-4 flex gap-2 overflow-x-auto bg-white">
                {([
                  ['overview', 'Обзор'],
                  ['timeline', 'Лента'],
                  ['bookings', 'Записи'],
                  ['need', 'Потребность'],
                  ['procedures', 'Процедуры'],
                  ['finance', 'Финансы'],
                  ['whatsapp', 'WhatsApp'],
                  ['tasks', 'Задачи'],
                ] as const).map(([id, label]) => (
                  <button key={id} type="button"
                    onClick={() => {
                      setLeadDetailTab(id);
                      if (id === 'whatsapp') resetUnreadCount();
                    }}
                    className={`h-9 px-5 rounded-full border text-sm font-semibold whitespace-nowrap shrink-0 transition-colors shadow-sm ${leadDetailTab === id ? 'border-[#1E325C] bg-[#1E325C] text-white' : 'border-[#E7ECF3] bg-white text-[#64748B] hover:border-[#CBD5E1] hover:text-[#1E325C]'}`}>
                    {label}
                    {id === 'whatsapp' && <WazzupBadge count={unreadCount} />}
                  </button>
                ))}
              </div>
              <div className="overflow-y-auto flex-1">
                <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] min-h-full">
                  <div className="p-6 space-y-5">
                    {leadDetailTab === 'overview' && (
                      <>
                        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                          <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4">
                            <div className="text-xs text-[#64748B]">Визитов</div>
                            <div className="text-xl font-black text-[#0B1220] mt-1">{visitedBookings.length}</div>
                          </div>
                          <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4">
                            <div className="text-xs text-[#64748B]">Записей всего</div>
                            <div className="text-xl font-black text-[#0B1220] mt-1">{leadBookings.length}</div>
                          </div>
                          <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4">
                            <div className="text-xs text-[#64748B]">Имеем / оплачено</div>
                            <div className="text-xl font-black text-[#0B1220] mt-1">{money(crmPaidValue)}</div>
                          </div>
                          <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4">
                            <div className="text-xs text-[#64748B]">Потенциал</div>
                            <div className="text-xl font-black text-[#0B1220] mt-1">{money(crmPotentialValue)}</div>
                          </div>
                        </div>

                        <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="text-sm font-bold text-[#0B1220]">Negis App</div>
                              <div className="mt-1 text-xs text-[#64748B]">
                                {appClientLoading
                                  ? 'Проверяем связь с приложением...'
                                  : (appClient?.id || selectedLead.app_client_id)
                                    ? `App client ID: ${appClient?.id || selectedLead.app_client_id}`
                                    : 'Клиент пока не найден в приложении по телефону'}
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <span className={`rounded-full px-3 py-1 text-xs font-bold ${(appClient?.id || selectedLead.app_client_id) ? 'bg-[#DCFCE7] text-[#16A34A]' : 'bg-[#F1F5F9] text-[#64748B]'}`}>
                                {(appClient?.id || selectedLead.app_client_id) ? 'Связан' : 'Не связан'}
                              </span>
                              <span className="rounded-full bg-[#EFF6FF] px-3 py-1 text-xs font-bold text-[#2859C5]">
                                Бонусы: {money(appBalance)}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="col-span-2">
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Полное имя</label>
                            <input type="text" style={IS} value={selectedLead.full_name ?? ''}
                              onChange={e => setSelectedLead(l => l ? { ...l, full_name: e.target.value || null } : l)} />
                          </div>
                          {([
                            { label: 'Телефон', key: 'phone', type: 'text' },
                            { label: 'Email', key: 'email', type: 'email' },
                            { label: 'Компания', key: 'company', type: 'text' },
                            { label: 'Возраст', key: 'age', type: 'number' },
                          ] as const).map(({ label, key, type }) => (
                            <div key={key}>
                              <label className="text-xs text-[#64748B] font-medium block mb-1.5">{label}</label>
                              <input type={type} style={IS} value={(selectedLead as any)[key] ?? ''}
                                onChange={e => setSelectedLead(l => l ? { ...l, [key]: e.target.value || null } : l)} />
                            </div>
                          ))}
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Источник</label>
                            <select style={IS} value={selectedLead.source ?? ''} onChange={e => setSelectedLead(l => l ? { ...l, source: e.target.value } : l)}>
                              {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Статус</label>
                            <select style={IS} value={selectedLead.status_id ?? ''} onChange={e => setSelectedLead(l => l ? { ...l, status_id: e.target.value } : l)}>
                              <option value="">— выбрать —</option>
                              {statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          </div>
                          {(userRole === 'owner' || userRole === 'manager') && (
                            <div className="col-span-2">
                              <label className="text-xs text-[#64748B] font-medium block mb-1.5">Ответственный</label>
                              <select style={IS} value={selectedLead.assigned_to ?? ''} onChange={e => setSelectedLead(l => l ? { ...l, assigned_to: e.target.value || null } : l)}>
                                <option value="">— выбрать —</option>
                                {agents.map(a => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
                              </select>
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    {leadDetailTab === 'timeline' && (
                      <div className="space-y-3">
                        {timelineItems.length === 0 ? (
                          <div className="text-sm text-[#94A3B8] py-10 text-center">Истории пока нет</div>
                        ) : timelineItems.map(item => (
                          <div key={item.id} className="rounded-xl border border-[#E7ECF3] p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div className="font-semibold text-[#0B1220]">{item.title}</div>
                              <div className="text-xs text-[#94A3B8]">{new Date(item.date).toLocaleString('ru-RU')}</div>
                            </div>
                            <div className="text-sm text-[#64748B] mt-1 whitespace-pre-wrap">{item.body}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {leadDetailTab === 'bookings' && (
                      <div className="rounded-xl border border-[#E7ECF3] overflow-hidden">
                        {leadBookingsLoading ? (
                          <div className="py-12 text-center text-sm text-[#94A3B8]">Загрузка...</div>
                        ) : sortedLeadBookings.length === 0 ? (
                          <div className="py-12 text-center text-sm text-[#94A3B8]">Записей и визитов пока нет</div>
                        ) : (
                          <table className="w-full text-sm">
                            <thead className="bg-[#F8FAFC] text-[#64748B]">
                              <tr>
                                <th className="text-left p-3">Дата</th>
                                <th className="text-left p-3">Услуга</th>
                                <th className="text-left p-3">Агент</th>
                                <th className="text-left p-3">Источник</th>
                                <th className="text-left p-3">Статус</th>
                                <th className="text-left p-3">Комментарий</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sortedLeadBookings.map(b => (
                                <tr key={b.id} className="border-t border-[#EEF2F6]">
                                  <td className="p-3 font-semibold text-[#0B1220]">{b.date} {b.time}</td>
                                   <td className="p-3 text-[#64748B]">{serviceName(b.service_id)}</td>
                                   <td className="p-3 text-[#64748B]">{bookingAgentName(b.agent_id)}</td>
                                   <td className="p-3">
                                     <div className="flex flex-wrap gap-1">
                                       <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${isNegisAppSource(b.source) ? 'bg-[#EEF2FF] text-[#4F46E5]' : 'bg-[#F1F5F9] text-[#64748B]'}`}>
                                         {sourceValueToLabel(b.source)}
                                       </span>
                                       {isNegisAppSource(b.source) && (
                                         <>
                                           <span className="rounded-full bg-[#EFF6FF] px-2 py-0.5 text-[11px] font-bold text-[#2859C5]">{qrStatusLabel(b.qr_status)}</span>
                                           <span className="rounded-full bg-[#F0FDF4] px-2 py-0.5 text-[11px] font-bold text-[#16A34A]">{bonusStatusLabel(b.bonus_status)}</span>
                                         </>
                                       )}
                                     </div>
                                   </td>
                                  <td className="p-3">
                                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold" style={{ background: bookingStatusColor(b) + '18', color: bookingStatusColor(b) }}>
                                      {bookingStatusLabel(b)}
                                    </span>
                                  </td>
                                  <td className="p-3 text-[#64748B]">{b.comment || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}

                    {leadDetailTab === 'need' && (
                      <div className="space-y-4">
                        <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4 text-sm text-[#64748B]">
                          Здесь фиксируйте причину обращения, интересующую услугу, возражения, бюджет, срочность и что нужно предложить дальше.
                        </div>
                        <textarea style={{ ...IS, minHeight: 280, resize: 'vertical' } as React.CSSProperties}
                          value={selectedLead.comment ?? ''}
                          onChange={e => setSelectedLead(l => l ? { ...l, comment: e.target.value } : l)} />
                      </div>
                    )}

                    {leadDetailTab === 'procedures' && (
                      <div className="space-y-4">
                        <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4 text-sm text-[#64748B]">
                          Отмечайте, что клиент уже получил, что ещё должен получить, сколько оплатил и что именно он купил: единоразовую процедуру или курс.
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Что купил</label>
                            <input style={IS} placeholder="Например: курс массажа, консультация, чистка"
                              value={procedureForm.bought}
                              onChange={e => setProcedureForm(f => ({ ...f, bought: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Формат покупки</label>
                            <select style={IS} value={procedureForm.purchaseType}
                              onChange={e => setProcedureForm(f => ({ ...f, purchaseType: e.target.value }))}>
                              <option value="Единоразовая процедура">Единоразовая процедура</option>
                              <option value="Курс">Курс</option>
                              <option value="План лечения">План лечения</option>
                              <option value="Абонемент">Абонемент</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Сумма покупки / потенциал</label>
                            <input style={IS} placeholder="Например: 500 000 ₸ или 500К"
                              value={procedureForm.purchaseAmount}
                              onChange={e => setProcedureForm(f => ({ ...f, purchaseAmount: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Сколько оплатил</label>
                            <input style={IS} placeholder="Например: 150 000 ₸ или 150К"
                              value={procedureForm.paid}
                              onChange={e => setProcedureForm(f => ({ ...f, paid: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Какие процедуры получил</label>
                            <textarea style={{ ...IS, minHeight: 110, resize: 'vertical' } as React.CSSProperties}
                              placeholder="Например: 1/5 массаж, консультация, снимок"
                              value={procedureForm.received}
                              onChange={e => setProcedureForm(f => ({ ...f, received: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Какие процедуры ещё получит</label>
                            <textarea style={{ ...IS, minHeight: 110, resize: 'vertical' } as React.CSSProperties}
                              placeholder="Например: ещё 4 процедуры курса, контрольный приём"
                              value={procedureForm.planned}
                              onChange={e => setProcedureForm(f => ({ ...f, planned: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Комментарий</label>
                            <input style={IS} placeholder="Например: оплатит остаток после 2 процедуры"
                              value={procedureForm.comment}
                              onChange={e => setProcedureForm(f => ({ ...f, comment: e.target.value }))} />
                          </div>
                        </div>
                        <button onClick={appendProcedureHistory}
                          className="px-4 py-3 rounded-xl bg-[#1E325C] text-white text-sm font-semibold">
                          Сохранить в историю
                        </button>
                      </div>
                    )}

                    {leadDetailTab === 'finance' && (
                      <div className="space-y-4">
                        <div className="grid grid-cols-3 gap-3">
                          <div className="rounded-xl border border-[#E7ECF3] p-4">
                            <div className="text-xs text-[#64748B]">Имеем / оплачено</div>
                            <div className="text-xl font-black text-[#0B1220] mt-1">{money(crmPaidValue)}</div>
                          </div>
                          <div className="rounded-xl border border-[#E7ECF3] p-4">
                            <div className="text-xs text-[#64748B]">План / потенциал</div>
                            <div className="text-xl font-black text-[#0B1220] mt-1">{money(crmPotentialValue)}</div>
                          </div>
                          <div className="rounded-xl border border-[#E7ECF3] p-4">
                            <div className="text-xs text-[#64748B]">Осталось получить</div>
                            <div className="text-xl font-black text-[#0B1220] mt-1">{money(crmRemainingValue)}</div>
                          </div>
                        </div>
                        <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="font-semibold text-[#0B1220]">Списать бонусы Negis App</div>
                              <div className="mt-1 text-sm text-[#64748B]">
                                Доступно: {money(appBalance)}. Максимум к списанию — 50% стоимости услуги.
                              </div>
                            </div>
                            <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-[#2859C5]">
                              Backend API
                            </span>
                          </div>
                          <div className="mt-4 grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3">
                            <input
                              style={IS}
                              placeholder="Стоимость услуги, например 20 000"
                              value={bonusSpendServicePrice}
                              onChange={e => setBonusSpendServicePrice(e.target.value)}
                            />
                            <input
                              style={IS}
                              placeholder="Списать бонусов"
                              value={bonusSpendAmount}
                              onChange={e => setBonusSpendAmount(e.target.value)}
                            />
                            <button
                              type="button"
                              onClick={applyBonusSpend}
                              disabled={bonusSpendLoading || appBalance <= 0}
                              className="rounded-xl bg-[#1E325C] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                            >
                              Применить бонусы
                            </button>
                          </div>
                          {bonusSpendServicePrice && (
                            <div className="mt-3 text-xs text-[#64748B]">
                              Максимум: {money(Math.floor(parseMoneyValue(bonusSpendServicePrice) * 0.5))};
                              к оплате деньгами после списания: {money(Math.max(parseMoneyValue(bonusSpendServicePrice) - parseMoneyValue(bonusSpendAmount), 0))}
                            </div>
                          )}
                        </div>
                        <div className="rounded-xl border border-[#E7ECF3] overflow-hidden">
                          <div className="px-4 py-3 bg-[#F8FAFC] text-sm font-semibold text-[#0B1220]">Покупки и оплаты из истории</div>
                          {financeEntries.length === 0 ? (
                            <div className="p-4 text-sm text-[#94A3B8]">Пока нет сохранённых покупок или оплат.</div>
                          ) : (
                            <div className="divide-y divide-[#EEF2F6]">
                              {financeEntries.map((entry, index) => (
                                <div key={`${entry.line}-${index}`} className="p-4 grid grid-cols-1 md:grid-cols-[1fr_120px_120px] gap-3 text-sm">
                                  <div>
                                    <div className="font-semibold text-[#0B1220]">{entry.bought || 'Покупка / оплата'}</div>
                                    <div className="text-xs text-[#64748B] mt-1 line-clamp-2">{entry.line}</div>
                                  </div>
                                  <div>
                                    <div className="text-xs text-[#94A3B8]">Потенциал</div>
                                    <div className="font-bold text-[#0B1220]">{entry.purchaseAmount ? money(entry.purchaseAmount) : '—'}</div>
                                  </div>
                                  <div>
                                    <div className="text-xs text-[#94A3B8]">Оплачено</div>
                                    <div className="font-bold text-[#16A34A]">{entry.paidAmount ? money(entry.paidAmount) : '—'}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <textarea style={{ ...IS, minHeight: 220, resize: 'vertical' } as React.CSSProperties}
                          placeholder="Оплаты, долг, рассрочка, скидка..."
                          value={selectedLead.comment ?? ''}
                          onChange={e => setSelectedLead(l => l ? { ...l, comment: e.target.value } : l)} />
                      </div>
                    )}

                    {leadDetailTab === 'whatsapp' && (
                      <div className="space-y-4">
                        <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4 text-sm text-[#64748B]">
                          Чат открывается через Wazzup iFrame. API-ключ Wazzup остаётся на сервере в Supabase Edge Functions.
                        </div>
                        {clinicId && user ? (
                          <WazzupChat
                            clinicId={clinicId}
                            userId={user.id}
                            userName={user.email ?? undefined}
                            contactPhone={selectedLead.phone}
                            contactName={displayName(selectedLead)}
                            leadId={selectedLead.id}
                            onDealCreate={() => toast.message('Wazzup запросил создание сделки')}
                            onDealOpen={() => toast.message('Wazzup запросил открытие сделки')}
                          />
                        ) : (
                          <div className="rounded-xl border border-[#E7ECF3] p-6 text-sm text-[#64748B]">
                            Нужно войти в раздел «Клиенты», чтобы открыть WhatsApp.
                          </div>
                        )}
                      </div>
                    )}

                    {leadDetailTab === 'tasks' && (
                      <div className="space-y-4">
                        <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4">
                          <div className="font-semibold text-[#0B1220]">Новая задача</div>
                          <div className="text-sm text-[#64748B] mt-1">
                            Напишите, что нужно сделать по клиенту, и выберите дату. Задача появится в общем разделе «Задачи».
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-4">
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Что сделать</label>
                            <textarea style={{ ...IS, minHeight: 140, resize: 'vertical' } as React.CSSProperties}
                              placeholder="Например: связаться, отправить план лечения, уточнить оплату курса"
                              value={taskForm.text}
                              onChange={e => setTaskForm(f => ({ ...f, text: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-xs text-[#64748B] font-medium block mb-1.5">Дата задачи</label>
                            <input type="date" style={IS} value={taskForm.dueDate}
                              onChange={e => setTaskForm(f => ({ ...f, dueDate: e.target.value }))} />
                            <button onClick={appendClientTask}
                              disabled={!taskForm.text.trim() || !taskForm.dueDate}
                              className="mt-3 w-full px-4 py-3 rounded-xl bg-[#1E325C] text-white text-sm font-semibold disabled:opacity-50">
                              Добавить задачу
                            </button>
                          </div>
                        </div>
                        <div className="rounded-xl border border-[#E7ECF3] overflow-hidden">
                          <div className="px-4 py-3 bg-[#F8FAFC] text-sm font-semibold text-[#0B1220]">Задачи клиента</div>
                          {leadTaskLines.length === 0 ? (
                            <div className="p-4 text-sm text-[#94A3B8]">По клиенту пока нет задач.</div>
                          ) : (
                            <div className="divide-y divide-[#EEF2F6]">
                              {leadTaskLines.map((line, index) => (
                                <div key={`${line}-${index}`} className="p-4 text-sm text-[#64748B]">
                                  {line}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <aside className="border-t lg:border-t-0 lg:border-l border-[#E7ECF3] bg-[#F8FAFC] p-5 space-y-4">
                    <button onClick={openBookingForLead}
                      className="w-full px-4 py-3 rounded-xl bg-[#1E325C] text-white text-sm font-semibold flex items-center justify-center gap-2">
                      <CalendarPlus size={15} /> Записать
                    </button>
                    <div className="rounded-xl border border-[#E7ECF3] bg-white p-4 space-y-3 text-sm">
                      <div className="flex justify-between gap-3"><span className="text-[#64748B]">Статус</span><span className="font-semibold text-[#0B1220]">{statusName(selectedLead)}</span></div>
                      <div className="flex justify-between gap-3"><span className="text-[#64748B]">Ответственный</span><span className="font-semibold text-[#0B1220] text-right">{agentName(selectedLead)}</span></div>
                      <div className="flex justify-between gap-3"><span className="text-[#64748B]">Последнее касание</span><span className="font-semibold text-[#0B1220]">{lastTouchDate ? new Date(lastTouchDate).toLocaleDateString('ru-RU') : '—'}</span></div>
                      <div className="flex justify-between gap-3"><span className="text-[#64748B]">Ближайшая запись</span><span className="font-semibold text-[#0B1220] text-right">{nextBooking ? `${nextBooking.date} ${nextBooking.time}` : '—'}</span></div>
                    </div>
                    <div className="rounded-xl border border-[#E7ECF3] bg-white p-4">
                      <label className="text-xs text-[#64748B] font-medium block mb-2">Быстрая заметка</label>
                      <textarea style={{ ...IS, background: '#FFFFFF', minHeight: 86, resize: 'vertical' } as React.CSSProperties}
                        value={quickNote}
                        onChange={e => setQuickNote(e.target.value)}
                        placeholder="Например: отправить план лечения завтра" />
                      <button onClick={appendQuickNote} disabled={!quickNote.trim()}
                        className="mt-3 w-full px-3 py-2 rounded-lg bg-[#EFF6FF] text-[#2859C5] text-sm font-semibold disabled:opacity-50">
                        Добавить в ленту
                      </button>
                    </div>
                    <div className="rounded-xl border border-[#E7ECF3] bg-white p-4">
                      <div className="text-xs text-[#64748B] mb-2">Комментарий / история</div>
                      <textarea style={{ ...IS, background: '#FFFFFF', minHeight: 160, resize: 'vertical' } as React.CSSProperties}
                        value={selectedLead.comment ?? ''}
                        onChange={e => setSelectedLead(l => l ? { ...l, comment: e.target.value } : l)} />
                    </div>
                  </aside>
                </div>
              </div>
              <div className="px-7 py-4 border-t border-[#E7ECF3] flex gap-3 flex-wrap">
                <button onClick={() => deleteLead(selectedLead.id)}
                  style={{ padding: '10px 16px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FEE2E2', fontSize: 13, color: '#DC2626', cursor: 'pointer' }}>
                  Удалить
                </button>
                <button onClick={openBookingForLead}
                  style={{ padding: '10px 16px', borderRadius: 10, background: '#EFF6FF', border: '1px solid #BFDBFE', fontSize: 13, color: '#2859C5', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CalendarPlus size={14} /> Записать
                </button>
                <div style={{ flex: 1 }} />
                <button onClick={() => setSelectedLead(null)}
                  style={{ padding: '10px 16px', borderRadius: 10, background: '#F4F7FB', border: '1px solid #E7ECF3', fontSize: 14, color: '#475569', cursor: 'pointer' }}>
                  Отмена
                </button>
                <button onClick={updateLead} disabled={saving}
                  style={{ padding: '10px 20px', borderRadius: 10, background: '#1E325C', border: 'none', fontSize: 14, color: '#FFF', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Check size={15} />{saving ? 'Сохранение...' : 'Сохранить'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Booking sub-modal ── */}
        {showBooking && selectedLead && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
            <div style={{
              background: '#FFFFFF', borderRadius: 20, boxShadow: '0 24px 64px rgba(15,23,42,0.18)',
              width: '100%', maxWidth: 780, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
              border: '1px solid #E7ECF3', overflow: 'hidden',
            }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 24px', borderBottom: '1px solid #E7ECF3' }}>
                <button onClick={() => setShowBooking(false)} style={{ background: '#F4F7FB', border: '1px solid #E7ECF3', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'flex' }}>
                  <ChevronLeft size={15} color="#64748B" />
                </button>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#0B1220' }}>
                    Записать: {selectedLead.full_name || '—'}
                  </div>
                  <div style={{ fontSize: 12, color: '#94A3B8' }}>{selectedLead.phone}</div>
                </div>
                <button onClick={() => setShowBooking(false)} style={{ marginLeft: 'auto', background: '#F4F7FB', border: '1px solid #E7ECF3', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'flex' }}>
                  <X size={15} color="#64748B" />
                </button>
              </div>

              {/* Body */}
              <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', flex: 1, overflow: 'hidden', minHeight: 0 }}>

                {/* Calendar column */}
                <div style={{ padding: '20px 16px', borderRight: '1px solid #E7ECF3', flexShrink: 0 }}>
                  <style>{`
                    .bk-rdp { --rdp-cell-size: 36px; margin: 0; font-family: 'Inter', sans-serif; }
                    .bk-rdp .rdp-caption_label { font-size: 14px; font-weight: 600; color: #0B1220; }
                    .bk-rdp .rdp-head_cell { font-size: 10px; font-weight: 500; color: #94A3B8; text-transform: uppercase; letter-spacing: 0.06em; }
                    .bk-rdp .rdp-day { font-size: 12px; color: #475569; border-radius: 8px; }
                    .bk-rdp .rdp-day:hover:not([disabled]):not(.rdp-day_selected) { background: #EEF2F6 !important; color: #0B1220; }
                    .bk-rdp .rdp-day_selected, .bk-rdp .rdp-day_selected:hover { background: #1E325C !important; color: white !important; border-radius: 8px; font-weight: 600; }
                    .bk-rdp .rdp-day_today:not(.rdp-day_selected) { color: #2859C5; font-weight: 600; }
                    .bk-rdp .rdp-nav_button { color: #94A3B8; border-radius: 7px; }
                    .bk-rdp .rdp-nav_button:hover { background: #EEF2F6; }
                  `}</style>
                  <DayPicker
                    className="bk-rdp"
                    mode="single"
                    selected={bkDate}
                    onSelect={d => { if (d) setBkDate(d); }}
                    locale={ru}
                    showOutsideDays
                    disabled={{ before: startOfDay(new Date()) }}
                  />
                </div>

                {/* Booking form column */}
                <div style={{ flex: 1, padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

                  {/* Date label */}
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0B1220', textTransform: 'capitalize' }}>
                    {format(bkDate, 'EEEE, d MMMM yyyy', { locale: ru })}
                  </div>

                  <div style={{ background: '#F8FAFC', borderRadius: 12, padding: 16, border: '1px solid #E7ECF3', display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0B1220' }}>
                        Запись клиента
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <div>
                          <label style={{ fontSize: 11, color: '#64748B', fontWeight: 500, display: 'block', marginBottom: 5 }}>Услуга</label>
                          <select style={{ ...BkIS }} value={bkForm.service_id} onChange={e => setBkForm(f => ({ ...f, service_id: e.target.value }))}>
                            <option value="">— выбрать —</option>
                            {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: '#64748B', fontWeight: 500, display: 'block', marginBottom: 5 }}>Время</label>
                          <input type="time" style={{ ...BkIS }} value={bkForm.time}
                            onChange={e => setBkForm(f => ({ ...f, time: e.target.value }))} />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: '#64748B', fontWeight: 500, display: 'block', marginBottom: 5 }}>Агент</label>
                          <select style={{ ...BkIS }} value={bkForm.agent_id} onChange={e => setBkForm(f => ({ ...f, agent_id: e.target.value }))}>
                            <option value="">— выбрать —</option>
                            {agents.map(a => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
                          </select>
                        </div>
                        <div style={{ gridColumn: '1 / -1' }}>
                          <label style={{ fontSize: 11, color: '#64748B', fontWeight: 500, display: 'block', marginBottom: 5 }}>Комментарий</label>
                          <input type="text" style={{ ...BkIS }} placeholder="Необязательно"
                            value={bkForm.comment} onChange={e => setBkForm(f => ({ ...f, comment: e.target.value }))} />
                        </div>
                      </div>
                      <button
                        onClick={saveLeadBooking}
                        disabled={bkSaving}
                        style={{
                          padding: '11px 20px', borderRadius: 10, background: '#1E325C', border: 'none',
                          fontSize: 13, fontWeight: 600, color: '#FFF', cursor: bkSaving ? 'default' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          opacity: bkSaving ? 0.7 : 1,
                        }}
                      >
                        <Check size={14} />{bkSaving ? 'Запись...' : 'Подтвердить запись'}
                      </button>
                    </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}

/* ── Bulk action UI helpers ─────────────────────────────── */
function BulkActionBtn({ children, icon, danger, onClick }: {
  children: React.ReactNode; icon?: React.ReactNode; danger?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 5,
      background: danger ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.10)',
      border: `1px solid ${danger ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.18)'}`,
      borderRadius: 8, color: danger ? '#FCA5A5' : '#CBD5E1',
      fontSize: 12, fontWeight: 500, padding: '5px 11px', cursor: 'pointer',
    }}>
      {icon}{children}
    </button>
  );
}
function BulkConfirmBtn({ children, onClick, disabled, danger }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: danger ? '#DC2626' : '#3B82F6', border: 'none', borderRadius: 8,
      color: '#FFF', fontSize: 12, fontWeight: 600, padding: '6px 12px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    }}>{children}</button>
  );
}
function BulkCancelBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: 8, color: '#94A3B8', fontSize: 12, padding: '5px 10px', cursor: 'pointer',
    }}>
      <X size={12} />
    </button>
  );
}

/* ── Pagination button ──────────────────────────────────── */
function PagBtn({ children, onClick, disabled, active }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: 30, height: 30, borderRadius: 7, border: '1px solid',
        borderColor: active ? '#1E325C' : '#E7ECF3',
        background: active ? '#1E325C' : disabled ? 'transparent' : '#F4F7FB',
        color: active ? '#FFF' : disabled ? '#CBD5E1' : '#475569',
        fontSize: 12, fontWeight: active ? 600 : 400,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 6px',
      }}
    >
      {children}
    </button>
  );
}
