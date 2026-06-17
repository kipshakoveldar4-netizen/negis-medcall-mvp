import { useState, useEffect, useRef } from 'react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Plus, Trash2, Edit2, Settings, Check, Download, Upload, ExternalLink } from 'lucide-react';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { apiUrl } from '@/lib/api';
import { toast } from 'sonner';

/* ─── Types ──────────────────────────────────────────────── */
interface Role { id: string; name: string; permissions: Record<string, boolean> }
interface Service {
  id: string; name: string; price: number;
  visible_in_app?: boolean | null;
  app_booking_enabled?: boolean | null;
  duration_minutes?: number | null;
  app_description?: string | null;
  app_image_url?: string | null;
  bonus_payment_enabled?: boolean | null;
  max_bonus_percent?: number | null;
}
interface BookingStatus { id: string; name: string; color: string; sort_order: number }
interface LeadStatus { id: string; name: string; color: string; sort_order: number; pipeline: string }
interface Shift {
  id: string; agent_id: string; start_time: string; end_time: string | null;
  duration_minutes: number; bookings_count: number; earnings: number;
  agents?: { name: string }
}
interface Agent { id: string; name: string }

const PERMISSIONS = [
  { key: 'dashboard',  label: 'Дашборд' },
  { key: 'booking',    label: 'Запись' },
  { key: 'reception',  label: 'Ресепшн' },
  { key: 'crm',        label: 'Клиенты' },
  { key: 'tasks',      label: 'Задачи' },
  { key: 'chat',       label: 'Чат' },
  { key: 'marketplace', label: 'Маркет' },
  { key: 'admin',      label: 'Админ' },
  { key: 'reports',    label: 'Отчёты' },
  { key: 'ads',        label: 'Реклама' },
  { key: 'settings',   label: 'Настройки' },
];

const DEFAULT_LEAD_STATUSES_SALES = [
  { name: 'Новый', color: '#3B82F6' },
  { name: 'Перезвонить', color: '#F59E0B' },
  { name: 'Отказ', color: '#EF4444' },
  { name: 'Другой город', color: '#94a3b8' },
  { name: 'Противопоказания', color: '#F97316' },
  { name: 'Возраст', color: '#8B5CF6' },
];
const DEFAULT_LEAD_STATUSES_BOOKING = [
  { name: 'Новый', color: '#3B82F6' },
  { name: 'Нужно записать', color: '#F59E0B' },
  { name: 'Записан', color: '#22C55E' },
  { name: 'Недозвон', color: '#F97316' },
  { name: 'Отмена', color: '#EF4444' },
];

/* ─── Confirm Dialog ─────────────────────────────────────── */
function ConfirmDialog({ msg, onConfirm, onCancel }: { msg: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="neu-lg p-8 max-w-sm w-full text-center space-y-5">
        <p className="font-semibold text-[#1E293B]">{msg}</p>
        <div className="flex gap-3 justify-center">
          <button onClick={onCancel} className="neu-btn px-6">Отмена</button>
          <button onClick={onConfirm} className="neu-btn-danger px-6">Удалить</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Main Component ─────────────────────────────────────── */
export default function Admin() {
  const [activeTab, setActiveTab] = useState('agents');
  const { clinicId } = useAuth();

  const tabs = [
    { id: 'agents', label: 'Агенты' },
    { id: 'roles', label: 'Роли' },
    { id: 'services', label: 'Услуги' },
    { id: 'statuses', label: 'Статусы' },
    { id: 'branches', label: 'Филиалы' },
    { id: 'shifts', label: 'Смены' },
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'negis-app', label: 'Negis App / Лояльность' },
    { id: 'export', label: 'Импорт / Экспорт' },
    { id: 'settings', label: 'Настройки' },
  ];

  return (
    <PageLayout>
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Настройки Админа</h2>

        <div className="flex gap-3 overflow-x-auto pb-2">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              data-testid={`tab-${tab.id}`}
              className={`px-5 py-2.5 rounded-full font-bold text-sm whitespace-nowrap transition-all ${
                activeTab === tab.id
                  ? 'neu-pressed-sm text-[#1A56DB]'
                  : 'neu-sm text-[#64748B] hover:text-[#1E293B]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="neu-card min-h-[500px]">
          {activeTab === 'agents' && <AgentsTab clinicId={clinicId} />}
          {activeTab === 'roles' && <RolesTab clinicId={clinicId} />}
          {activeTab === 'services' && <ServicesTab clinicId={clinicId} />}
          {activeTab === 'statuses' && <StatusesTab clinicId={clinicId} />}
          {activeTab === 'branches' && <BranchesTab clinicId={clinicId} />}
          {activeTab === 'shifts' && <ShiftsTab clinicId={clinicId} />}
          {activeTab === 'whatsapp' && <WhatsAppTab clinicId={clinicId} />}
          {activeTab === 'negis-app' && <NegisAppSettingsTab clinicId={clinicId} />}
          {activeTab === 'export' && <ExportTab clinicId={clinicId} />}
          {activeTab === 'settings' && <SettingsTabContent clinicId={clinicId} />}
        </div>
      </div>
    </PageLayout>
  );
}

/* ─── Employee type ──────────────────────────────────────── */
interface Employee {
  id: string;
  name: string;
  email: string;
  hourly_rate: number;
  weekly_target: number;
  user_id: string | null;
  role_id: string | null;
  user_roles?: { role: string }[] | null;
}

const SYSTEM_ROLES = [
  { value: 'agent',        label: 'Агент' },
  { value: 'receptionist', label: 'Ресепшионист' },
  { value: 'manager',      label: 'Менеджер' },
  { value: 'owner',        label: 'Руководитель' },
];

/* ─── Agents Tab ─────────────────────────────────────────── */
function AgentsTab({ clinicId }: { clinicId: string | null }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [customRoles, setCustomRoles] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('agent');
  const [roleId, setRoleId] = useState('');
  const [hourlyRate, setHourlyRate] = useState('0');
  const [weeklyTarget, setWeeklyTarget] = useState('20');

  useEffect(() => { if (clinicId) { loadEmployees(); loadCustomRoles(); } }, [clinicId]);

  const loadCustomRoles = async () => {
    if (!clinicId) return;
    const { data } = await supabase.from('roles').select('id, name').eq('clinic_id', clinicId).order('created_at');
    setCustomRoles(data ?? []);
  };

  const loadEmployees = async () => {
    if (!clinicId) return;
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/admin/employees?clinic_id=${clinicId}`));
      const data = await res.json();
      if (res.ok) setEmployees(data);
      else toast.error(data.error || 'Ошибка загрузки');
    } finally { setLoading(false); }
  };

  const openCreate = () => {
    setEditing(null);
    setName(''); setEmail(''); setPassword('');
    setRole('agent'); setRoleId(''); setHourlyRate('0'); setWeeklyTarget('20');
    setShowModal(true);
  };

  const openEdit = (emp: Employee) => {
    setEditing(emp);
    setName(emp.name);
    setEmail(emp.email);
    setPassword('');
    setRole(emp.user_roles?.[0]?.role ?? 'agent');
    setRoleId(emp.role_id ?? '');
    setHourlyRate(String(emp.hourly_rate ?? 0));
    setWeeklyTarget(String(emp.weekly_target ?? 20));
    setShowModal(true);
  };

  const save = async () => {
    if (!clinicId) { toast.error('ID клиники не определён. Перезайдите в систему.'); return; }
    if (!name.trim()) { toast.error('Введите имя'); return; }
    if (!editing && !email.trim()) { toast.error('Введите email'); return; }
    if (!editing && password.length < 6) { toast.error('Пароль: минимум 6 символов'); return; }
    setSaving(true);
    try {
      if (editing) {
        const res = await fetch(apiUrl(`/api/admin/employees/${editing.id}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clinic_id: clinicId, name, role,
            role_id: roleId || null,
            hourly_rate: parseFloat(hourlyRate) || 0,
            weekly_target: parseInt(weeklyTarget) || 20,
          }),
        });
        const data = await res.json();
        if (!res.ok) { toast.error(data.error || 'Ошибка'); return; }
        toast.success('Сотрудник обновлён');
      } else {
        const res = await fetch(apiUrl('/api/admin/employees'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clinic_id: clinicId, name, email, password, role,
            role_id: roleId || null,
            hourly_rate: parseFloat(hourlyRate) || 0,
            weekly_target: parseInt(weeklyTarget) || 20,
          }),
        });
        const data = await res.json();
        if (!res.ok) { toast.error(data.error || 'Ошибка'); return; }
        toast.success('Сотрудник создан');
      }
      setShowModal(false);
      loadEmployees();
    } finally { setSaving(false); }
  };

  const confirmDelete = async () => {
    if (!deletingId) return;
    const res = await fetch(apiUrl(`/api/admin/employees/${deletingId}`), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { toast.error(data.error || 'Ошибка удаления'); }
    else { toast.success('Сотрудник удалён'); loadEmployees(); }
    setDeletingId(null);
  };

  /* Show custom role name if set, otherwise fall back to system role */
  const roleLabel = (emp: Employee) => {
    if (emp.role_id) {
      const cr = customRoles.find(r => r.id === emp.role_id);
      if (cr) return cr.name;
    }
    return SYSTEM_ROLES.find(r => r.value === (emp.user_roles?.[0]?.role ?? ''))?.label ?? '—';
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-bold">Сотрудники клиники</h3>
        <button className="neu-btn-primary flex items-center gap-2" onClick={openCreate}>
          <Plus size={16} /> Добавить сотрудника
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-[#E7ECF3] text-sm text-[#64748B]">
              <th className="pb-3 font-semibold">Имя</th>
              <th className="pb-3 font-semibold">Email</th>
              <th className="pb-3 font-semibold">Роль</th>
              <th className="pb-3 font-semibold">Ставка / ч</th>
              <th className="pb-3 font-semibold">Таргет / нед.</th>
              <th className="pb-3 font-semibold text-right">Действия</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="py-16 text-center text-[#94A3B8] text-sm">Загрузка...</td></tr>
            ) : employees.length === 0 ? (
              <tr><td colSpan={6} className="py-16 text-center text-[#94A3B8] text-sm">
                Нет сотрудников. Добавьте первого.
              </td></tr>
            ) : employees.map(emp => (
              <tr key={emp.id} className="border-b border-[#F1F5F9] text-sm hover:bg-[#F8FAFC] transition-colors">
                <td className="py-3 font-medium text-[#0B1220]">{emp.name}</td>
                <td className="py-3 text-[#64748B]">{emp.email || '—'}</td>
                <td className="py-3">
                  <span className="inline-block px-2 py-0.5 rounded-md bg-[#EEF2F6] text-[#1E325C] text-xs font-medium">
                    {roleLabel(emp)}
                  </span>
                </td>
                <td className="py-3 text-[#64748B]">{emp.hourly_rate?.toLocaleString('ru-RU')} ₸</td>
                <td className="py-3 text-[#64748B]">{emp.weekly_target}</td>
                <td className="py-3 text-right">
                  <div className="flex gap-2 justify-end">
                    <button
                      className="neu-btn p-1.5"
                      onClick={() => openEdit(emp)}
                      title="Редактировать"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      className="neu-btn p-1.5 text-red-500"
                      onClick={() => setDeletingId(emp.id)}
                      title="Удалить"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Employee Modal ── */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowModal(false); }}
        >
          <div className="neu-lg p-8 max-w-md w-full space-y-5">
            <h4 className="text-base font-bold text-[#0B1220]">
              {editing ? 'Редактировать сотрудника' : 'Новый сотрудник'}
            </h4>

            <div className="space-y-3">
              <FieldRow label="Имя">
                <input
                  className="neu-input w-full"
                  placeholder="Полное имя"
                  value={name}
                  onChange={e => setName(e.target.value)}
                />
              </FieldRow>

              {!editing && (
                <>
                  <FieldRow label="Email (логин)">
                    <input
                      type="email"
                      className="neu-input w-full"
                      placeholder="email@clinic.kz"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                    />
                  </FieldRow>
                  <FieldRow label="Пароль">
                    <input
                      type="password"
                      className="neu-input w-full"
                      placeholder="Минимум 6 символов"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                    />
                  </FieldRow>
                </>
              )}

              <FieldRow label="Системная роль">
                <select
                  className="neu-input w-full"
                  value={role}
                  onChange={e => setRole(e.target.value)}
                >
                  {SYSTEM_ROLES.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </FieldRow>

              {customRoles.length > 0 && (
                <FieldRow label="Должность (кастомная роль)">
                  <select
                    className="neu-input w-full"
                    value={roleId}
                    onChange={e => setRoleId(e.target.value)}
                  >
                    <option value="">— не выбрано —</option>
                    {customRoles.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </FieldRow>
              )}

              <FieldRow label="Ставка (₸/ч)">
                <input
                  type="number"
                  className="neu-input w-full"
                  placeholder="0"
                  min={0}
                  value={hourlyRate}
                  onChange={e => setHourlyRate(e.target.value)}
                />
              </FieldRow>

              <FieldRow label="Таргет (зап./нед.)">
                <input
                  type="number"
                  className="neu-input w-full"
                  placeholder="20"
                  min={0}
                  value={weeklyTarget}
                  onChange={e => setWeeklyTarget(e.target.value)}
                />
              </FieldRow>
            </div>

            <div className="flex gap-3 pt-1">
              <button className="neu-btn flex-1" onClick={() => setShowModal(false)}>Отмена</button>
              <button className="neu-btn-primary flex-1 flex items-center justify-center gap-2" onClick={save} disabled={saving}>
                <Check size={15} />
                {saving ? 'Сохранение...' : editing ? 'Сохранить' : 'Создать'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm Delete ── */}
      {deletingId && (
        <ConfirmDialog
          msg="Удалить сотрудника? Его аккаунт и данные будут удалены безвозвратно."
          onConfirm={confirmDelete}
          onCancel={() => setDeletingId(null)}
        />
      )}
    </div>
  );
}

/* ── Field Row helper ── */
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-[#64748B] mb-1.5">{label}</label>
      {children}
    </div>
  );
}

/* ─── Roles Tab ──────────────────────────────────────────── */
function RolesTab({ clinicId }: { clinicId: string | null }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [perms, setPerms] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (clinicId) load(); }, [clinicId]);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from('roles').select('*').eq('clinic_id', clinicId).order('created_at');
    setRoles(data || []);
    setLoading(false);
  };

  const openCreate = () => {
    setEditing(null);
    setName('');
    setPerms({});
    setShowModal(true);
  };

  const openEdit = (r: Role) => {
    setEditing(r);
    setName(r.name);
    setPerms(r.permissions || {});
    setShowModal(true);
  };

  const save = async () => {
    if (!name.trim()) { toast.error('Введите название роли'); return; }
    setSaving(true);
    if (editing) {
      const { error } = await supabase.from('roles').update({ name, permissions: perms }).eq('id', editing.id);
      if (error) { toast.error(error.message); } else { toast.success('Роль обновлена'); }
    } else {
      if (roles.length >= 10) { toast.error('Максимум 10 ролей'); setSaving(false); return; }
      const { error } = await supabase.from('roles').insert({ clinic_id: clinicId, name, permissions: perms });
      if (error) { toast.error(error.message); } else { toast.success('Роль создана'); }
    }
    setSaving(false);
    setShowModal(false);
    load();
  };

  const remove = async () => {
    const { error } = await supabase.from('roles').delete().eq('id', deletingId);
    if (error) toast.error(error.message); else toast.success('Роль удалена');
    setDeletingId(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-bold">Роли сотрудников</h3>
        <button className="neu-btn-primary flex items-center gap-2" onClick={openCreate} data-testid="button-add-role">
          <Plus size={16} /> Добавить роль
        </button>
      </div>
      <p className="text-sm text-[#64748B]">Создайте роли с набором прав доступа. Каждому сотруднику назначается одна роль.</p>

      {loading ? (
        <p className="text-center text-[#64748B] py-12">Загрузка...</p>
      ) : roles.length === 0 ? (
        <div className="py-16 text-center text-[#64748B]">Нет ролей. Создайте первую.</div>
      ) : (
        <div className="space-y-3">
          {roles.map(r => (
            <div key={r.id} className="neu-sm p-4 flex items-center justify-between" data-testid={`role-${r.id}`}>
              <div>
                <p className="font-bold text-[#1E293B]">{r.name}</p>
                <p className="text-xs text-[#64748B] mt-1">
                  {PERMISSIONS.filter(p => r.permissions?.[p.key]).map(p => p.label).join(' · ') || 'Нет прав'}
                </p>
              </div>
              <div className="flex gap-2">
                <button className="neu-icon-btn h-8 w-8" onClick={() => openEdit(r)} data-testid={`edit-role-${r.id}`}><Edit2 size={14} /></button>
                <button className="neu-icon-btn h-8 w-8 text-destructive" onClick={() => setDeletingId(r.id)} data-testid={`delete-role-${r.id}`}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="neu-lg p-8 max-w-md w-full space-y-5">
            <h3 className="text-lg font-bold">{editing ? 'Редактировать роль' : 'Новая роль'}</h3>
            <input
              className="neu-input"
              placeholder="Название роли"
              value={name}
              onChange={e => setName(e.target.value)}
              data-testid="input-role-name"
            />
            <div className="space-y-3">
              <p className="text-sm font-semibold text-[#64748B] uppercase tracking-wide">Права доступа</p>
              {PERMISSIONS.map(p => (
                <label key={p.key} className="flex items-center gap-3 cursor-pointer group">
                  <div
                    className={`h-5 w-5 rounded flex items-center justify-center transition-all cursor-pointer ${perms[p.key] ? 'bg-[#1A56DB]' : 'neu-pressed-sm'}`}
                    onClick={() => setPerms(prev => ({ ...prev, [p.key]: !prev[p.key] }))}
                    data-testid={`perm-${p.key}`}
                  >
                    {perms[p.key] && <Check size={12} color="white" />}
                  </div>
                  <span className="text-sm text-[#1E293B]">{p.label}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowModal(false)} className="neu-btn flex-1">Отмена</button>
              <button onClick={save} disabled={saving} className="neu-btn-primary flex-1 justify-center" data-testid="button-save-role">
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingId && (
        <ConfirmDialog msg="Удалить эту роль?" onConfirm={remove} onCancel={() => setDeletingId(null)} />
      )}
    </div>
  );
}

/* ─── Services Tab ───────────────────────────────────────── */
function ServicesTab({ clinicId }: { clinicId: string | null }) {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [durationMinutes, setDurationMinutes] = useState('0');
  const [visibleInApp, setVisibleInApp] = useState(false);
  const [appBookingEnabled, setAppBookingEnabled] = useState(false);
  const [bonusPaymentEnabled, setBonusPaymentEnabled] = useState(true);
  const [maxBonusPercent, setMaxBonusPercent] = useState('50');
  const [appDescription, setAppDescription] = useState('');
  const [appImageUrl, setAppImageUrl] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (clinicId) load(); }, [clinicId]);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from('services').select('*').eq('clinic_id', clinicId).order('created_at');
    setServices(data || []);
    setLoading(false);
  };

  const openCreate = () => {
    setEditing(null); setName(''); setPrice(''); setDurationMinutes('0');
    setVisibleInApp(false); setAppBookingEnabled(false); setBonusPaymentEnabled(true);
    setMaxBonusPercent('50'); setAppDescription(''); setAppImageUrl(''); setShowModal(true);
  };
  const openEdit = (s: Service) => {
    setEditing(s); setName(s.name); setPrice(String(s.price)); setDurationMinutes(String(s.duration_minutes ?? 0));
    setVisibleInApp(Boolean(s.visible_in_app)); setAppBookingEnabled(Boolean(s.app_booking_enabled));
    setBonusPaymentEnabled(s.bonus_payment_enabled !== false); setMaxBonusPercent(String(s.max_bonus_percent ?? 50));
    setAppDescription(s.app_description ?? ''); setAppImageUrl(s.app_image_url ?? ''); setShowModal(true);
  };

  const save = async () => {
    if (!name.trim()) { toast.error('Введите название услуги'); return; }
    const priceNum = Number(price) || 0;
    const patch = {
      name,
      price: priceNum,
      duration_minutes: Number(durationMinutes) || 0,
      visible_in_app: visibleInApp,
      app_booking_enabled: appBookingEnabled,
      bonus_payment_enabled: bonusPaymentEnabled,
      max_bonus_percent: Math.min(Math.max(Number(maxBonusPercent) || 50, 0), 50),
      app_description: appDescription || null,
      app_image_url: appImageUrl || null,
    };
    setSaving(true);
    if (editing) {
      const { error } = await supabase.from('services').update(patch).eq('id', editing.id);
      if (error) {
        if (error.message.includes('column')) {
          const { error: fallbackError } = await supabase.from('services').update({ name, price: priceNum }).eq('id', editing.id);
          if (fallbackError) toast.error(fallbackError.message); else toast.success('Услуга обновлена. Для Negis App полей выполните миграцию 006.');
        } else toast.error(error.message);
      } else { toast.success('Услуга обновлена'); }
    } else {
      const { error } = await supabase.from('services').insert({ clinic_id: clinicId, ...patch });
      if (error) {
        if (error.message.includes('column')) {
          const { error: fallbackError } = await supabase.from('services').insert({ clinic_id: clinicId, name, price: priceNum });
          if (fallbackError) toast.error(fallbackError.message); else toast.success('Услуга добавлена. Для Negis App полей выполните миграцию 006.');
        } else toast.error(error.message);
      } else { toast.success('Услуга добавлена'); }
    }
    setSaving(false); setShowModal(false); load();
  };

  const remove = async () => {
    // Detach from bookings first to avoid FK violation
    await supabase.from('bookings').update({ service_id: null }).eq('service_id', deletingId);
    const { error } = await supabase.from('services').delete().eq('id', deletingId);
    if (error) toast.error(error.message); else toast.success('Услуга удалена');
    setDeletingId(null); load();
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-bold">Услуги клиники</h3>
        <button className="neu-btn-primary flex items-center gap-2" onClick={openCreate} data-testid="button-add-service">
          <Plus size={16} /> Добавить услугу
        </button>
      </div>

      {loading ? (
        <p className="text-center text-[#64748B] py-12">Загрузка...</p>
      ) : services.length === 0 ? (
        <div className="py-16 text-center text-[#64748B]">Нет услуг. Добавьте первую.</div>
      ) : (
        <div className="space-y-3">
          {services.map(s => (
            <div key={s.id} className="neu-sm p-4 flex items-center justify-between" data-testid={`service-${s.id}`}>
              <div>
                <p className="font-bold text-[#1E293B]">{s.name}</p>
                <p className="text-sm text-[#64748B]">{s.price.toLocaleString('ru')} ₸</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.visible_in_app && <span className="rounded-full bg-[#EEF2FF] px-2 py-0.5 text-[11px] font-bold text-[#4F46E5]">В приложении</span>}
                  {s.app_booking_enabled && <span className="rounded-full bg-[#EFF6FF] px-2 py-0.5 text-[11px] font-bold text-[#2859C5]">Онлайн-запись</span>}
                  {s.bonus_payment_enabled && <span className="rounded-full bg-[#F0FDF4] px-2 py-0.5 text-[11px] font-bold text-[#16A34A]">Бонусы до {s.max_bonus_percent ?? 50}%</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <button className="neu-icon-btn h-8 w-8" onClick={() => openEdit(s)}><Edit2 size={14} /></button>
                <button className="neu-icon-btn h-8 w-8 text-destructive" onClick={() => setDeletingId(s.id)}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="neu-lg p-8 max-w-xl w-full space-y-4">
            <h3 className="text-lg font-bold">{editing ? 'Редактировать услугу' : 'Новая услуга'}</h3>
            <input className="neu-input" placeholder="Название услуги" value={name} onChange={e => setName(e.target.value)} data-testid="input-service-name" />
            <div className="relative">
              <input className="neu-input pr-6" placeholder="Цена" type="number" value={price} onChange={e => setPrice(e.target.value)} data-testid="input-service-price" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[#64748B]">₸</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="neu-sm p-3 flex items-center gap-2 text-sm font-semibold text-[#475569]">
                <input type="checkbox" checked={visibleInApp} onChange={e => setVisibleInApp(e.target.checked)} />
                Показывать в Negis App
              </label>
              <label className="neu-sm p-3 flex items-center gap-2 text-sm font-semibold text-[#475569]">
                <input type="checkbox" checked={appBookingEnabled} onChange={e => setAppBookingEnabled(e.target.checked)} />
                Онлайн-запись
              </label>
              <label className="neu-sm p-3 flex items-center gap-2 text-sm font-semibold text-[#475569]">
                <input type="checkbox" checked={bonusPaymentEnabled} onChange={e => setBonusPaymentEnabled(e.target.checked)} />
                Оплата бонусами
              </label>
              <input className="neu-input" type="number" min={0} max={50} placeholder="Макс. % бонусами" value={maxBonusPercent} onChange={e => setMaxBonusPercent(e.target.value)} />
            </div>
            <input className="neu-input" type="number" placeholder="Длительность, мин" value={durationMinutes} onChange={e => setDurationMinutes(e.target.value)} />
            <textarea className="neu-input min-h-24" placeholder="Описание для приложения" value={appDescription} onChange={e => setAppDescription(e.target.value)} />
            <input className="neu-input" placeholder="Фото/иконка услуги URL" value={appImageUrl} onChange={e => setAppImageUrl(e.target.value)} />
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowModal(false)} className="neu-btn flex-1">Отмена</button>
              <button onClick={save} disabled={saving} className="neu-btn-primary flex-1 justify-center" data-testid="button-save-service">
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingId && <ConfirmDialog msg="Удалить эту услугу?" onConfirm={remove} onCancel={() => setDeletingId(null)} />}
    </div>
  );
}

/* ─── Negis App / Loyalty Tab ───────────────────────────── */
interface ClinicAppSettings {
  app_enabled: boolean;
  app_booking_enabled: boolean;
  loyalty_enabled: boolean;
  bonus_spend_enabled: boolean;
  max_bonus_percent: number;
  bonus_per_visit: number;
  bonus_first_visit: number;
}

const DEFAULT_APP_SETTINGS: ClinicAppSettings = {
  app_enabled: false,
  app_booking_enabled: false,
  loyalty_enabled: false,
  bonus_spend_enabled: false,
  max_bonus_percent: 50,
  bonus_per_visit: 0,
  bonus_first_visit: 0,
};

function NegisAppSettingsTab({ clinicId }: { clinicId: string | null }) {
  const [settings, setSettings] = useState<ClinicAppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dbReady, setDbReady] = useState(true);

  useEffect(() => { if (clinicId) load(); }, [clinicId]);

  const load = async () => {
    if (!clinicId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('clinic_app_settings')
      .select('*')
      .eq('clinic_id', clinicId)
      .maybeSingle();
    if (error) {
      setDbReady(false);
      setSettings(DEFAULT_APP_SETTINGS);
    } else {
      setDbReady(true);
      setSettings({ ...DEFAULT_APP_SETTINGS, ...(data ?? {}) });
    }
    setLoading(false);
  };

  const update = (patch: Partial<ClinicAppSettings>) => {
    setSettings(prev => ({ ...prev, ...patch }));
  };

  const save = async () => {
    if (!clinicId) return;
    setSaving(true);
    const payload = {
      clinic_id: clinicId,
      ...settings,
      max_bonus_percent: Math.min(Math.max(Number(settings.max_bonus_percent) || 50, 0), 50),
      bonus_per_visit: Number(settings.bonus_per_visit) || 0,
      bonus_first_visit: Number(settings.bonus_first_visit) || 0,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('clinic_app_settings')
      .upsert(payload, { onConflict: 'clinic_id' });
    setSaving(false);
    if (error) {
      setDbReady(false);
      toast.error('Выполните SQL migration 006 для настроек Negis App');
      return;
    }
    setDbReady(true);
    toast.success('Настройки Negis App сохранены');
  };

  if (loading) return <p className="text-center text-[#64748B] py-12">Загрузка...</p>;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold">Negis App / Лояльность</h3>
        <p className="mt-1 text-sm text-[#64748B]">
          Эти настройки управляют видимостью клиники в клиентском приложении, онлайн-записью и бонусной программой.
        </p>
      </div>

      {!dbReady && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          Таблица настроек ещё не создана. Выполните SQL из <code>migrations/006_negis_app_mvp.sql</code>.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ToggleCard title="Показывать клинику в приложении" checked={settings.app_enabled} onChange={v => update({ app_enabled: v })} />
        <ToggleCard title="Принимать онлайн-записи" checked={settings.app_booking_enabled} onChange={v => update({ app_booking_enabled: v })} />
        <ToggleCard title="Участвовать в бонусной программе" checked={settings.loyalty_enabled} onChange={v => update({ loyalty_enabled: v })} />
        <ToggleCard title="Принимать оплату бонусами" checked={settings.bonus_spend_enabled} onChange={v => update({ bonus_spend_enabled: v })} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <NumberField label="Макс. процент оплаты бонусами" value={settings.max_bonus_percent} onChange={v => update({ max_bonus_percent: v })} suffix="%" />
        <NumberField label="Бонусы за визит" value={settings.bonus_per_visit} onChange={v => update({ bonus_per_visit: v })} suffix="бонусов" />
        <NumberField label="Бонусы за первый визит" value={settings.bonus_first_visit} onChange={v => update({ bonus_first_visit: v })} suffix="бонусов" />
      </div>

      <div className="rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] p-4 text-sm text-[#64748B]">
        Если онлайн-запись выключена, клиника может оставаться в каталоге приложения, но кнопка записи будет недоступна.
        Списание бонусов CRM выполняет только через backend API, баланс напрямую не меняется.
      </div>

      <button className="neu-btn-primary px-5 py-3" disabled={saving} onClick={save}>
        {saving ? 'Сохранение...' : 'Сохранить настройки'}
      </button>
    </div>
  );
}

function ToggleCard({ title, checked, onChange }: { title: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="neu-sm flex items-center justify-between gap-4 p-4">
      <span className="font-semibold text-[#1E293B]">{title}</span>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="h-5 w-5 accent-[#1E325C]" />
    </label>
  );
}

function NumberField({ label, value, suffix, onChange }: { label: string; value: number; suffix: string; onChange: (value: number) => void }) {
  return (
    <div>
      <label className="text-xs text-[#64748B] font-medium block mb-1.5">{label}</label>
      <div className="relative">
        <input className="neu-input pr-20" type="number" value={value} onChange={e => onChange(Number(e.target.value))} />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#94A3B8]">{suffix}</span>
      </div>
    </div>
  );
}

/* ─── Statuses Tab ───────────────────────────────────────── */
function StatusesTab({ clinicId }: { clinicId: string | null }) {
  const [bookingStatuses, setBookingStatuses]   = useState<BookingStatus[]>([]);
  const [salesLeadStatuses, setSalesLeadStatuses]     = useState<LeadStatus[]>([]);
  const [bookingLeadStatuses, setBookingLeadStatuses] = useState<LeadStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState<'booking' | 'lead_sales' | 'lead_booking' | null>(null);
  const [editing, setEditing] = useState<any>(null);
  const [deletingId, setDeletingId] = useState<{ id: string; type: 'booking' | 'lead' } | null>(null);
  const [sName, setSName] = useState('');
  const [sColor, setSColor] = useState('#3B82F6');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (clinicId) load(); }, [clinicId]);

  const load = async () => {
    setLoading(true);
    const [bs, ls] = await Promise.all([
      supabase.from('booking_statuses').select('*').eq('clinic_id', clinicId).order('sort_order'),
      supabase.from('lead_statuses').select('*').eq('clinic_id', clinicId).order('sort_order'),
    ]);
    setBookingStatuses(bs.data || []);
    const all: LeadStatus[] = ls.data || [];
    setSalesLeadStatuses(all.filter(s => s.pipeline === 'sales' || !s.pipeline));
    setBookingLeadStatuses(all.filter(s => s.pipeline === 'booking'));
    setLoading(false);
  };

  const seedLeadStatuses = async (pipeline: 'sales' | 'booking') => {
    const defaults = pipeline === 'sales' ? DEFAULT_LEAD_STATUSES_SALES : DEFAULT_LEAD_STATUSES_BOOKING;
    const inserts = defaults.map((s, i) => ({ clinic_id: clinicId, ...s, sort_order: i, pipeline }));
    const { error } = await supabase.from('lead_statuses').insert(inserts);
    if (error) toast.error(error.message); else { toast.success('Статусы созданы'); load(); }
  };

  const openCreate = (type: 'booking' | 'lead_sales' | 'lead_booking') => {
    setEditing(null); setSName(''); setSColor('#3B82F6'); setShowModal(type);
  };
  const openEdit = (s: any, type: 'booking' | 'lead_sales' | 'lead_booking') => {
    setEditing(s); setSName(s.name); setSColor(s.color); setShowModal(type);
  };

  const save = async () => {
    if (!sName.trim()) { toast.error('Введите название'); return; }
    setSaving(true);
    const isBookingStatus = showModal === 'booking';
    const table = isBookingStatus ? 'booking_statuses' : 'lead_statuses';
    const pipeline = showModal === 'lead_sales' ? 'sales' : showModal === 'lead_booking' ? 'booking' : undefined;

    if (editing) {
      const patch: Record<string, unknown> = { name: sName, color: sColor };
      const { error } = await supabase.from(table).update(patch).eq('id', editing.id);
      if (error) toast.error(error.message); else toast.success('Статус обновлён');
    } else {
      const currentCount = showModal === 'booking' ? bookingStatuses.length
        : showModal === 'lead_sales' ? salesLeadStatuses.length : bookingLeadStatuses.length;
      if (currentCount >= 10) { toast.error('Максимум 10 статусов'); setSaving(false); return; }
      const insert: Record<string, unknown> = { clinic_id: clinicId, name: sName, color: sColor, sort_order: currentCount };
      if (pipeline) insert.pipeline = pipeline;
      const { error } = await supabase.from(table).insert(insert);
      if (error) toast.error(error.message); else toast.success('Статус добавлен');
    }
    setSaving(false); setShowModal(null); load();
  };

  const remove = async () => {
    if (!deletingId) return;
    if (deletingId.type === 'booking') {
      await supabase.from('bookings').update({ status_id: null }).eq('status_id', deletingId.id);
    } else {
      await supabase.from('leads').update({ status_id: null }).eq('status_id', deletingId.id);
    }
    const table = deletingId.type === 'booking' ? 'booking_statuses' : 'lead_statuses';
    const { error } = await supabase.from(table).delete().eq('id', deletingId.id);
    if (error) toast.error(error.message); else toast.success('Статус удалён');
    setDeletingId(null); load();
  };

  const StatusList = ({ items, type }: { items: (BookingStatus | LeadStatus)[], type: 'booking' | 'lead_sales' | 'lead_booking' }) => (
    <div className="space-y-2">
      {items.map((s: any) => (
        <div key={s.id} className="neu-sm p-3 flex items-center gap-3" data-testid={`status-${s.id}`}>
          <div className="h-4 w-4 rounded-full shrink-0" style={{ background: s.color }} />
          <span className="flex-1 font-medium text-[#1E293B]">{s.name}</span>
          <button className="neu-icon-btn h-7 w-7" onClick={() => openEdit(s, type)}><Edit2 size={12} /></button>
          <button className="neu-icon-btn h-7 w-7 text-destructive" onClick={() => setDeletingId({ id: s.id, type: type === 'booking' ? 'booking' : 'lead' })}><Trash2 size={12} /></button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-8">
      {loading ? <p className="text-center text-[#64748B] py-12">Загрузка...</p> : (
        <>
          {/* Booking statuses */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-lg font-bold">Статусы записей</h3>
                <p className="text-xs text-[#64748B] mt-0.5">Один статус может быть "Подтверждено" — запись появится у ресепшна</p>
              </div>
              <button className="neu-btn-primary flex items-center gap-2" onClick={() => openCreate('booking')} data-testid="button-add-booking-status">
                <Plus size={14} /> Добавить
              </button>
            </div>
            {bookingStatuses.length === 0
              ? <p className="text-[#64748B] text-sm py-6 text-center">Нет статусов записей</p>
              : <StatusList items={bookingStatuses} type="booking" />}
          </div>

          <div className="border-t border-border/40" />

          {/* Sales lead statuses */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-lg font-bold">Статусы лидов — Negis Клиенты</h3>
                <p className="text-xs text-[#64748B] mt-0.5">Используются в разделе «Клиенты» (отдел продаж)</p>
              </div>
              <div className="flex gap-2">
                {salesLeadStatuses.length === 0 && (
                  <button className="neu-btn text-sm" onClick={() => seedLeadStatuses('sales')} data-testid="button-seed-lead-statuses">
                    Создать стандартные
                  </button>
                )}
                <button className="neu-btn-primary flex items-center gap-2" onClick={() => openCreate('lead_sales')} data-testid="button-add-lead-status">
                  <Plus size={14} /> Добавить
                </button>
              </div>
            </div>
            {salesLeadStatuses.length === 0
              ? <p className="text-[#64748B] text-sm py-6 text-center">Нет статусов</p>
              : <StatusList items={salesLeadStatuses} type="lead_sales" />}
          </div>

          <div className="border-t border-border/40" />

          {/* Booking lead statuses */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-lg font-bold">Статусы лидов — Записи</h3>
                <p className="text-xs text-[#64748B] mt-0.5">Используются в разделе Записи (лиды на запись)</p>
              </div>
              <div className="flex gap-2">
                {bookingLeadStatuses.length === 0 && (
                  <button className="neu-btn text-sm" onClick={() => seedLeadStatuses('booking')}>
                    Создать стандартные
                  </button>
                )}
                <button className="neu-btn-primary flex items-center gap-2" onClick={() => openCreate('lead_booking')}>
                  <Plus size={14} /> Добавить
                </button>
              </div>
            </div>
            {bookingLeadStatuses.length === 0
              ? <p className="text-[#64748B] text-sm py-6 text-center">Нет статусов</p>
              : <StatusList items={bookingLeadStatuses} type="lead_booking" />}
          </div>
        </>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="neu-lg p-8 max-w-sm w-full space-y-4">
            <h3 className="text-lg font-bold">{editing ? 'Редактировать статус' : 'Новый статус'}</h3>
            <input className="neu-input" placeholder="Название" value={sName} onChange={e => setSName(e.target.value)} data-testid="input-status-name" />
            <div className="flex items-center gap-4">
              <label className="text-sm text-[#64748B]">Цвет:</label>
              <input type="color" value={sColor} onChange={e => setSColor(e.target.value)}
                className="h-9 w-16 cursor-pointer rounded-lg border-0 p-0.5"
                style={{ background: 'none' }} data-testid="input-status-color" />
              <div className="h-6 w-6 rounded-full border border-border/30" style={{ background: sColor }} />
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowModal(null)} className="neu-btn flex-1">Отмена</button>
              <button onClick={save} disabled={saving} className="neu-btn-primary flex-1 justify-center" data-testid="button-save-status">
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingId && <ConfirmDialog msg="Удалить этот статус?" onConfirm={remove} onCancel={() => setDeletingId(null)} />}
    </div>
  );
}

/* ─── Shifts Tab ─────────────────────────────────────────── */
function ShiftsTab({ clinicId }: { clinicId: string | null }) {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterAgent, setFilterAgent] = useState('');
  const [filterDate, setFilterDate] = useState('');

  useEffect(() => { if (clinicId) { loadAgents(); loadShifts(); } }, [clinicId]);
  useEffect(() => { if (clinicId) loadShifts(); }, [filterAgent, filterDate, clinicId]);

  const loadAgents = async () => {
    const { data } = await supabase.from('agents').select('id, name').eq('clinic_id', clinicId);
    setAgents(data || []);
  };

  const loadShifts = async () => {
    setLoading(true);
    let q = supabase.from('shifts').select('*').eq('clinic_id', clinicId).order('start_time', { ascending: false }).limit(100);
    if (filterAgent) q = q.eq('agent_id', filterAgent);
    if (filterDate) q = q.gte('start_time', filterDate).lt('start_time', filterDate + 'T23:59:59');
    const { data } = await q;
    setShifts(data || []);
    setLoading(false);
  };

  const fmtTime = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const fmtDur = (mins: number) => {
    if (!mins) return '—';
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h}ч ${m}м` : `${m}м`;
  };

  return (
    <div className="space-y-5">
      <h3 className="text-lg font-bold">Смены сотрудников</h3>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <select
          className="neu-input w-auto"
          value={filterAgent}
          onChange={e => setFilterAgent(e.target.value)}
          data-testid="filter-agent"
          style={{ width: 'auto', minWidth: 160 }}
        >
          <option value="">Все агенты</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input
          type="date"
          className="neu-input"
          value={filterDate}
          onChange={e => setFilterDate(e.target.value)}
          data-testid="filter-date"
          style={{ width: 'auto', minWidth: 160 }}
        />
        {(filterAgent || filterDate) && (
          <button className="neu-btn text-sm" onClick={() => { setFilterAgent(''); setFilterDate(''); }}>Сбросить</button>
        )}
      </div>

      {loading ? (
        <p className="text-center text-[#64748B] py-12">Загрузка...</p>
      ) : shifts.length === 0 ? (
        <div className="py-16 text-center text-[#64748B]">Нет смен за выбранный период.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-[#64748B]">
                <th className="pb-3 font-semibold">Агент</th>
                <th className="pb-3 font-semibold">Дата</th>
                <th className="pb-3 font-semibold">Приход</th>
                <th className="pb-3 font-semibold">Уход</th>
                <th className="pb-3 font-semibold">Длит.</th>
                <th className="pb-3 font-semibold">Записей</th>
                <th className="pb-3 font-semibold text-right">Заработок</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map(s => (
                <tr key={s.id} className="border-b border-border/40" data-testid={`shift-${s.id}`}>
                  <td className="py-3 font-medium text-[#1E293B]">{agents.find(a => a.id === s.agent_id)?.name || '—'}</td>
                  <td className="py-3 text-[#64748B]">{fmtDate(s.start_time)}</td>
                  <td className="py-3">{fmtTime(s.start_time)}</td>
                  <td className="py-3">{fmtTime(s.end_time)}</td>
                  <td className="py-3">{fmtDur(s.duration_minutes)}</td>
                  <td className="py-3 text-center">{s.bookings_count}</td>
                  <td className="py-3 text-right font-bold text-[#1A56DB]">{s.earnings.toLocaleString('ru')} ₸</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─── WhatsApp Tab ───────────────────────────────────────── */
function WhatsAppTab({ clinicId }: { clinicId: string | null }) {
  const [template, setTemplate] = useState('Здравствуйте, {имя}! Вы записаны на услугу {услуга} {дата} в {время}. Ваш специалист: {агент}.');
  const [saving, setSaving] = useState(false);

  const preview = template
    .replace('{имя}', 'Дмитрий')
    .replace('{услуга}', 'Консультация')
    .replace('{дата}', '24.05.2026')
    .replace('{время}', '14:00')
    .replace('{агент}', 'Анна С.');

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from('clinics').update({ whatsapp_template: template }).eq('id', clinicId);
    if (error) toast.error(error.message); else toast.success('Шаблон сохранён');
    setSaving(false);
  };

  return (
    <div className="max-w-2xl space-y-6">
      <h3 className="text-lg font-bold">Шаблон WhatsApp</h3>
      <p className="text-sm text-[#64748B]">Доступные переменные: <code className="bg-[#E8EDF2] px-1 rounded">{'{имя} {дата} {время} {услуга} {агент}'}</code></p>
      <textarea
        className="neu-input min-h-[120px] resize-y"
        value={template}
        onChange={e => setTemplate(e.target.value)}
        data-testid="input-whatsapp-template"
      />
      <div className="neu-sm p-4 border-l-4 border-[#10B981]">
        <p className="text-xs font-bold uppercase text-[#10B981] mb-2">Предпросмотр</p>
        <p className="text-[#1E293B] text-sm">{preview}</p>
      </div>
      <button onClick={save} disabled={saving} className="neu-btn-primary" data-testid="button-save-whatsapp">
        {saving ? 'Сохранение...' : 'Сохранить шаблон'}
      </button>
    </div>
  );
}

/* ─── Settings Tab ───────────────────────────────────────── */
interface AdAccountRow {
  id: string; platform: string; account_name: string | null; account_id: string; is_active: boolean;
}

function SettingsTabContent({ clinicId }: { clinicId: string | null }) {
  const [form, setForm] = useState({ name: '', work_start: '10:00', work_end: '18:00', slot_limit: 3, whatsapp_number: '', telegram_chat_id: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!clinicId) return;
    supabase.from('clinics')
      .select('name, work_start, work_end, slot_limit, whatsapp_number, telegram_chat_id')
      .eq('id', clinicId).single()
      .then(({ data }) => {
        if (data) {
          setForm({ name: data.name || '', work_start: data.work_start || '10:00', work_end: data.work_end || '18:00', slot_limit: data.slot_limit || 3, whatsapp_number: data.whatsapp_number || '', telegram_chat_id: data.telegram_chat_id || '' });
        }
        setLoading(false);
      });
  }, [clinicId]);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from('clinics').update(form).eq('id', clinicId);
    if (error) toast.error(error.message); else toast.success('Настройки сохранены');
    setSaving(false);
  };

  if (loading) return <p className="text-center text-[#64748B] py-12">Загрузка...</p>;

  return (
    <div className="space-y-10">
      {/* ── Clinic settings ── */}
      <div className="max-w-lg space-y-5">
        <h3 className="text-lg font-bold">Настройки клиники</h3>
        <div>
          <label className="block text-sm font-medium text-[#64748B] mb-1">Название клиники</label>
          <input className="neu-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} data-testid="input-clinic-name" />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-[#64748B] mb-1">Работа с</label>
            <input type="time" className="neu-input" value={form.work_start} onChange={e => setForm(f => ({ ...f, work_start: e.target.value }))} data-testid="input-work-start" />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-[#64748B] mb-1">до</label>
            <input type="time" className="neu-input" value={form.work_end} onChange={e => setForm(f => ({ ...f, work_end: e.target.value }))} data-testid="input-work-end" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-[#64748B] mb-1">Максимум записей на слот</label>
          <input type="number" min={1} max={20} className="neu-input" value={form.slot_limit} onChange={e => setForm(f => ({ ...f, slot_limit: Number(e.target.value) }))} data-testid="input-slot-limit" />
        </div>
        <div>
          <label className="block text-sm font-medium text-[#64748B] mb-1">Номер WhatsApp</label>
          <input className="neu-input" placeholder="+7XXXXXXXXXX" value={form.whatsapp_number} onChange={e => setForm(f => ({ ...f, whatsapp_number: e.target.value }))} data-testid="input-whatsapp-number" />
        </div>
        <div>
          <label className="block text-sm font-medium text-[#64748B] mb-1">Telegram Chat ID</label>
          <input className="neu-input" value={form.telegram_chat_id} onChange={e => setForm(f => ({ ...f, telegram_chat_id: e.target.value }))} data-testid="input-telegram-chat-id" />
        </div>
        <button onClick={save} disabled={saving} className="neu-btn-primary mt-2" data-testid="button-save-settings">
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
      </div>

    </div>
  );
}

/* ─── Export Tab ─────────────────────────────────────────── */

/** Normalize phone: strip spaces/dashes/parens, keep leading + */
function normalizePhone(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return (hasPlus ? '+' : '') + digits;
}

function normalizePhoneForDuplicate(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits;
}

/** Pick the first non-empty value from an object by trying a list of keys (case-insensitive) */
function pickField(row: Record<string, string>, keys: string[]): string {
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v]));
  for (const key of keys) {
    const val = lower[key.toLowerCase()];
    if (val && String(val).trim()) return String(val).trim();
  }
  return '';
}

interface ImportPreview {
  ready: ImportRow[];
  errors: string[];
}
interface ImportRow {
  clinic_id: string;
  pipeline: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  age: number | null;
  source: string;
  comment: string | null;
  assigned_to: string | null;
  status_id: string | null;
}

function ExportTab({ clinicId }: { clinicId: string | null }) {
  const [loading, setLoading] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleImportLeads = async (file: File) => {
    if (!clinicId) return;
    setImportLoading(true);
    setPreview(null);
    try {
      let rows: Record<string, string>[] = [];
      if (file.name.toLowerCase().endsWith('.csv')) {
        const text = await file.text();
        const result = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
        rows = result.data;
      } else {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf);
        rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      }

      const [{ data: statuses }, { data: agentsList }, { data: existingLeads, error: existingLeadsError }] = await Promise.all([
        supabase.from('lead_statuses').select('id').eq('clinic_id', clinicId).eq('pipeline', 'sales').order('sort_order').limit(1),
        supabase.from('agents').select('id, name').eq('clinic_id', clinicId),
        supabase.from('leads').select('phone').eq('clinic_id', clinicId).eq('pipeline', 'sales').not('phone', 'is', null),
      ]);
      if (existingLeadsError) { toast.error(existingLeadsError.message); return; }
      const defaultStatusId = statuses?.[0]?.id ?? null;
      const seenPhones = new Set(
        (existingLeads ?? [])
          .map(row => normalizePhoneForDuplicate(row.phone))
          .filter(Boolean),
      );

      const agentByName = (name: string) => {
        if (!name || !agentsList) return null;
        const n = name.toLowerCase();
        return agentsList.find(a => a.name.toLowerCase() === n)?.id ?? null;
      };

      const NAME_KEYS   = ['full_name','fullname','фио','клиент','пациент','полное имя','name','имя'];
      const FNAME_KEYS  = ['first_name','firstname','имя'];
      const LNAME_KEYS  = ['last_name','lastname','фамилия'];
      const PHONE_KEYS  = ['phone','телефон','номер','whatsapp','contact','contact_phone','mobile','phone number'];
      const EMAIL_KEYS  = ['email','e-mail','почта'];
      const COMPANY_KEYS= ['company','компания','организация','company name'];
      const AGE_KEYS    = ['age','возраст'];
      const SOURCE_KEYS = ['source','источник','lead source'];
      const COMMENT_KEYS= ['comment','комментарий','примечание','notes'];
      const AGENT_KEYS  = ['assigned_to','ответственный','owner','агент'];

      const ready: ImportRow[] = [];
      const errors: string[] = [];

      rows.forEach((r, idx) => {
        const rowNum = idx + 2; // 1-based, +1 for header

        // ── Resolve full_name ──
        let fullName = pickField(r, NAME_KEYS);
        if (!fullName) {
          const fn = pickField(r, FNAME_KEYS);
          const ln = pickField(r, LNAME_KEYS);
          fullName = [fn, ln].filter(Boolean).join(' ');
        }

        // ── Resolve phone ──
        const rawPhone = pickField(r, PHONE_KEYS);
        const phone = rawPhone ? normalizePhone(rawPhone) || null : null;
        const duplicatePhone = normalizePhoneForDuplicate(phone);
        if (duplicatePhone && seenPhones.has(duplicatePhone)) {
          errors.push(`Строка ${rowNum}: дубль телефона ${phone}`);
          return;
        }
        if (duplicatePhone) seenPhones.add(duplicatePhone);

        // ── Fallback: no name but has phone ──
        if (!fullName && phone) fullName = `Клиент ${phone}`;

        // ── Fallback: no name but has email ──
        const email = pickField(r, EMAIL_KEYS) || null;
        if (!fullName && email) fullName = `Клиент ${email}`;

        // ── Skip row if still no name ──
        if (!fullName.trim()) {
          errors.push(`Строка ${rowNum}: нет имени и телефона`);
          return;
        }

        const rawAge = pickField(r, AGE_KEYS);
        ready.push({
          clinic_id:   clinicId,
          pipeline:    'sales',
          full_name:   fullName.trim(),
          phone,
          email,
          company:     pickField(r, COMPANY_KEYS) || null,
          age:         rawAge ? (parseInt(rawAge) || null) : null,
          source:      pickField(r, SOURCE_KEYS)  || 'Import',
          comment:     pickField(r, COMMENT_KEYS) || null,
          assigned_to: agentByName(pickField(r, AGENT_KEYS)),
          status_id:   defaultStatusId,
        });
      });

      if (ready.length === 0 && errors.length === 0) {
        toast.error('Файл пустой или не содержит данных');
        return;
      }

      setPreview({ ready, errors });
    } catch (e: any) {
      toast.error(e.message || 'Ошибка при чтении файла');
    } finally {
      setImportLoading(false);
    }
  };

  const confirmImport = async () => {
    if (!preview || !preview.ready.length) return;
    setImporting(true);
    const CHUNK = 100;
    let imported = 0;
    try {
      for (let i = 0; i < preview.ready.length; i += CHUNK) {
        const chunk = preview.ready.slice(i, i + CHUNK);
        const { error } = await supabase.from('leads').insert(chunk);
        if (error) { toast.error(`Ошибка на строке ~${i + 1}: ${error.message}`); setImporting(false); return; }
        imported += chunk.length;
      }
      toast.success(`Импортировано ${imported} лидов`);
      setPreview(null);
    } catch (e: any) {
      toast.error(e.message || 'Ошибка импорта');
    } finally {
      setImporting(false);
    }
  };

  const exportSheet = (rows: Record<string, unknown>[], filename: string) => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Данные');
    XLSX.writeFile(wb, filename);
  };

  const exportBookings = async (fmt: 'csv' | 'xlsx') => {
    if (!clinicId) return;
    setLoading('bookings');
    const [{ data, error }, { data: agentsData }, { data: servicesData }] = await Promise.all([
      supabase.from('bookings').select('id, date, time, patient_name, patient_phone, age, visited, service_id, agent_id').eq('clinic_id', clinicId).order('date', { ascending: false }),
      supabase.from('agents').select('id, name').eq('clinic_id', clinicId),
      supabase.from('services').select('id, name').eq('clinic_id', clinicId),
    ]);
    setLoading(null);
    if (error) { toast.error(error.message); return; }
    const agentMap   = Object.fromEntries((agentsData   ?? []).map(a => [a.id, a.name]));
    const serviceMap = Object.fromEntries((servicesData ?? []).map(s => [s.id, s.name]));
    const rows = (data ?? []).map((r: any) => ({
      'Дата': r.date, 'Время': r.time, 'Клиент': r.patient_name,
      'Телефон': r.patient_phone ?? '', 'Возраст': r.age ?? '',
      'Услуга': r.service_id ? (serviceMap[r.service_id] ?? '—') : '—',
      'Агент':  r.agent_id  ? (agentMap[r.agent_id]   ?? '—') : '—',
      'Статус': r.visited === true ? 'Пришёл' : r.visited === false ? 'Не пришёл' : 'Ожидается',
    }));
    if (fmt === 'csv') {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Записи');
      XLSX.writeFile(wb, `записи_${new Date().toISOString().split('T')[0]}.csv`, { bookType: 'csv' });
    } else {
      exportSheet(rows, `записи_${new Date().toISOString().split('T')[0]}.xlsx`);
    }
    toast.success('Файл скачан');
  };

  const exportLeads = async (fmt: 'csv' | 'xlsx') => {
    if (!clinicId) return;
    setLoading('leads');
    const [{ data, error }, { data: agentsData }] = await Promise.all([
      supabase
        .from('leads')
        .select('full_name, phone, email, company, age, source, comment, created_at, assigned_to, status_id, lead_statuses(name)')
        .eq('clinic_id', clinicId)
        .eq('pipeline', 'sales')
        .order('created_at', { ascending: false }),
      supabase.from('agents').select('id, name').eq('clinic_id', clinicId),
    ]);
    setLoading(null);
    if (error) { toast.error(error.message); return; }
    const agentMap = Object.fromEntries((agentsData ?? []).map(a => [a.id, a.name]));
    const rows = (data ?? []).map((r: any) => ({
      'Имя': r.full_name ?? '',
      'Телефон': r.phone ?? '', 'Email': r.email ?? '',
      'Компания': r.company ?? '', 'Возраст': r.age ?? '',
      'Источник': r.source ?? '', 'Статус': r.lead_statuses?.name ?? '',
      'Ответственный': r.assigned_to ? (agentMap[r.assigned_to] ?? '—') : '—',
      'Комментарий': r.comment ?? '',
      'Дата создания': new Date(r.created_at).toLocaleDateString('ru-RU'),
    }));
    if (fmt === 'csv') {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Лиды');
      XLSX.writeFile(wb, `лиды_${new Date().toISOString().split('T')[0]}.csv`, { bookType: 'csv' });
    } else {
      exportSheet(rows, `лиды_${new Date().toISOString().split('T')[0]}.xlsx`);
    }
    toast.success('Файл скачан');
  };

  const exportAgents = async (fmt: 'csv' | 'xlsx') => {
    if (!clinicId) return;
    setLoading('agents');
    const { data, error } = await supabase
      .from('agents')
      .select('name, rate, daily_target, is_active')
      .eq('clinic_id', clinicId)
      .order('name');
    setLoading(null);
    if (error) { toast.error(error.message); return; }
    const rows = (data ?? []).map((r: any) => ({
      'Имя': r.name, 'Ставка (₸/час)': r.rate ?? '',
      'Цель (₸/день)': r.daily_target ?? '',
      'Активен': r.is_active ? 'Да' : 'Нет',
    }));
    if (fmt === 'csv') {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Агенты');
      XLSX.writeFile(wb, `агенты_${new Date().toISOString().split('T')[0]}.csv`, { bookType: 'csv' });
    } else {
      exportSheet(rows, `агенты_${new Date().toISOString().split('T')[0]}.xlsx`);
    }
    toast.success('Файл скачан');
  };

  const exportShifts = async (fmt: 'csv' | 'xlsx') => {
    if (!clinicId) return;
    setLoading('shifts');
    const [{ data, error }, { data: agentsData }] = await Promise.all([
      supabase.from('shifts').select('start_time, end_time, duration_minutes, bookings_count, earnings, agent_id').eq('clinic_id', clinicId).order('start_time', { ascending: false }),
      supabase.from('agents').select('id, name').eq('clinic_id', clinicId),
    ]);
    setLoading(null);
    if (error) { toast.error(error.message); return; }
    const agentMap = Object.fromEntries((agentsData ?? []).map(a => [a.id, a.name]));
    const rows = (data ?? []).map((r: any) => ({
      'Агент': r.agent_id ? (agentMap[r.agent_id] ?? '—') : '—',
      'Начало': new Date(r.start_time).toLocaleString('ru-RU'),
      'Конец': r.end_time ? new Date(r.end_time).toLocaleString('ru-RU') : '',
      'Длительность (мин)': r.duration_minutes ?? '',
      'Записей': r.bookings_count ?? 0,
      'Заработок (₸)': r.earnings ?? 0,
    }));
    if (fmt === 'csv') {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Смены');
      XLSX.writeFile(wb, `смены_${new Date().toISOString().split('T')[0]}.csv`, { bookType: 'csv' });
    } else {
      exportSheet(rows, `смены_${new Date().toISOString().split('T')[0]}.xlsx`);
    }
    toast.success('Файл скачан');
  };

  const sections = [
    {
      id: 'bookings', title: 'Записи клиентов', description: 'Все записи: дата, время, клиент, услуга, агент, статус визита',
      onExport: exportBookings,
    },
    {
      id: 'leads', title: 'Лиды (Клиенты)', description: 'Все лиды: имя, телефон, источник, статус, ответственный',
      onExport: exportLeads,
    },
    {
      id: 'agents', title: 'Агенты', description: 'Список сотрудников: имя, ставка, цель',
      onExport: exportAgents,
    },
    {
      id: 'shifts', title: 'Смены', description: 'История смен: агент, время, длительность, заработок',
      onExport: exportShifts,
    },
  ];

  return (
    <div className="space-y-6">
      {/* ── Import section ── */}
      <div>
        <h4 className="font-bold text-[#1E293B] mb-1">Импорт лидов</h4>
        <p className="text-sm text-[#64748B] mb-1">
          Загрузите CSV или Excel. Поддерживаемые колонки имени:
        </p>
        <p className="text-xs text-[#94A3B8] font-mono mb-3">
          full_name / ФИО / Имя / Клиент / Пациент / name · Телефон / phone / whatsapp / mobile
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleImportLeads(f); e.target.value = ''; }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={importLoading}
          className="neu-btn flex items-center gap-2 text-sm px-5 py-2.5"
        >
          <Upload size={15} />
          {importLoading ? 'Анализ файла...' : 'Выбрать файл'}
        </button>

        {/* ── Preview panel ── */}
        {preview && (
          <div className="mt-4 space-y-3">
            <div className="neu-sm p-4 flex flex-wrap gap-4">
              <div className="text-center">
                <p className="text-2xl font-bold text-[#0B1220]">{preview.ready.length + preview.errors.length}</p>
                <p className="text-xs text-[#94A3B8]">строк найдено</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-[#16A34A]">{preview.ready.length}</p>
                <p className="text-xs text-[#94A3B8]">готово к импорту</p>
              </div>
              {preview.errors.length > 0 && (
                <div className="text-center">
                  <p className="text-2xl font-bold text-[#DC2626]">{preview.errors.length}</p>
                  <p className="text-xs text-[#94A3B8]">строк с ошибками</p>
                </div>
              )}
            </div>

            {preview.errors.length > 0 && (
              <div className="neu-sm p-4 border-l-4 border-[#DC2626]">
                <p className="text-xs font-semibold text-[#DC2626] mb-2">Строки пропущены (нет имени и телефона):</p>
                <ul className="space-y-0.5">
                  {preview.errors.slice(0, 5).map((e, i) => (
                    <li key={i} className="text-xs text-[#475569]">{e}</li>
                  ))}
                  {preview.errors.length > 5 && (
                    <li className="text-xs text-[#94A3B8]">...и ещё {preview.errors.length - 5}</li>
                  )}
                </ul>
              </div>
            )}

            {preview.ready.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[#94A3B8] border-b border-[#E7ECF3]">
                      <th className="text-left pb-1 pr-3 font-medium">Имя</th>
                      <th className="text-left pb-1 pr-3 font-medium">Телефон</th>
                      <th className="text-left pb-1 pr-3 font-medium">Email</th>
                      <th className="text-left pb-1 font-medium">Источник</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.ready.slice(0, 5).map((r, i) => (
                      <tr key={i} className="border-b border-[#F1F5F9]">
                        <td className="py-1 pr-3 text-[#0B1220]">{r.full_name}</td>
                        <td className="py-1 pr-3 text-[#475569]">{r.phone ?? '—'}</td>
                        <td className="py-1 pr-3 text-[#475569]">{r.email ?? '—'}</td>
                        <td className="py-1 text-[#475569]">{r.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.ready.length > 5 && (
                  <p className="text-xs text-[#94A3B8] mt-1">...и ещё {preview.ready.length - 5} строк</p>
                )}
              </div>
            )}

            <div className="flex gap-2">
              {preview.ready.length > 0 && (
                <button
                  onClick={confirmImport}
                  disabled={importing}
                  className="neu-btn-primary flex items-center gap-2 text-sm px-5"
                >
                  <Upload size={14} />
                  {importing ? 'Импорт...' : `Импортировать ${preview.ready.length} лидов`}
                </button>
              )}
              <button
                onClick={() => { setPreview(null); if (fileRef.current) fileRef.current.value = ''; }}
                className="neu-btn text-sm px-4"
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-[#E7ECF3] pt-5">
        <h4 className="font-bold text-[#1E293B] mb-1">Экспорт данных</h4>
        <p className="text-sm text-[#64748B] mb-4">Выгрузите данные в CSV или Excel-формат</p>
      </div>

      {sections.map(s => (
        <div key={s.id} className="neu-sm p-5 flex items-center justify-between gap-4">
          <div>
            <p className="font-bold text-[#1E293B]">{s.title}</p>
            <p className="text-sm text-[#64748B] mt-0.5">{s.description}</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              disabled={loading === s.id}
              onClick={() => s.onExport('csv')}
              className="neu-btn flex items-center gap-2 text-sm px-4 py-2"
            >
              <Download size={14} />
              CSV
            </button>
            <button
              disabled={loading === s.id}
              onClick={() => s.onExport('xlsx')}
              className="neu-btn-primary flex items-center gap-2 text-sm px-4 py-2"
            >
              <Download size={14} />
              {loading === s.id ? '...' : 'Excel'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Branches Tab ───────────────────────────────────────── */
interface Branch {
  id: string; name: string; address: string | null; city: string | null;
  phone: string | null; is_main: boolean; is_active: boolean;
}

function BranchesTab({ clinicId }: { clinicId: string | null }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const emptyForm = { name: '', address: '', city: '', phone: '' };
  const [form, setForm] = useState(emptyForm);

  useEffect(() => { if (clinicId) load(); }, [clinicId]);

  const load = async () => {
    if (!clinicId) return;
    setLoading(true);
    const { data } = await supabase.from('branches').select('*').eq('clinic_id', clinicId).order('is_main', { ascending: false });
    setBranches(data ?? []);
    setLoading(false);
  };

  const save = async () => {
    if (!form.name.trim()) { toast.error('Введите название'); return; }
    setSaving(true);
    if (editing) {
      const { error } = await supabase.from('branches').update({
        name: form.name, address: form.address || null, city: form.city || null, phone: form.phone || null,
      }).eq('id', editing.id);
      if (error) { toast.error(error.message); setSaving(false); return; }
      toast.success('Филиал обновлён');
    } else {
      const { error } = await supabase.from('branches').insert({
        clinic_id: clinicId, name: form.name,
        address: form.address || null, city: form.city || null, phone: form.phone || null,
      });
      if (error) { toast.error(error.message); setSaving(false); return; }
      toast.success('Филиал добавлен');
    }
    setSaving(false);
    setEditing(null); setShowNew(false); setForm(emptyForm);
    load();
  };

  const del = async (id: string) => {
    const { error } = await supabase.from('branches').delete().eq('id', id);
    if (error) { toast.error(error.message); return; }
    toast.success('Филиал удалён');
    setDeletingId(null);
    load();
  };

  const openEdit = (b: Branch) => {
    setEditing(b);
    setForm({ name: b.name, address: b.address ?? '', city: b.city ?? '', phone: b.phone ?? '' });
    setShowNew(true);
  };

  const IS: React.CSSProperties = {
    background: '#F4F7FB', border: '1px solid #E7ECF3', borderRadius: 10,
    padding: '9px 13px', fontSize: 13, color: '#0B1220', outline: 'none', width: '100%',
    fontFamily: "'Inter', sans-serif",
  };

  return (
    <div className="p-6 space-y-5">
      {deletingId && (
        <ConfirmDialog msg="Удалить филиал?" onConfirm={() => del(deletingId)} onCancel={() => setDeletingId(null)} />
      )}

      <div className="flex justify-between items-center">
        <h3 className="font-bold text-lg text-[#0B1220]">Филиалы</h3>
        <button className="neu-btn-primary flex items-center gap-2 text-sm" onClick={() => { setEditing(null); setForm(emptyForm); setShowNew(true); }}>
          <Plus size={14} /> Добавить филиал
        </button>
      </div>

      {showNew && (
        <div className="neu-sm p-5 space-y-3">
          <h4 className="font-semibold text-sm text-[#0B1220]">{editing ? 'Редактировать' : 'Новый'} филиал</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[#64748B] mb-1 block">Название *</label>
              <input style={IS} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Основной филиал" />
            </div>
            <div>
              <label className="text-xs text-[#64748B] mb-1 block">Город</label>
              <input style={IS} value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder="Астана" />
            </div>
            <div>
              <label className="text-xs text-[#64748B] mb-1 block">Адрес</label>
              <input style={IS} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="ул. Республика, 15" />
            </div>
            <div>
              <label className="text-xs text-[#64748B] mb-1 block">Телефон</label>
              <input style={IS} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+7 700 000 0000" />
            </div>
          </div>
          <div className="flex gap-2">
            <button className="neu-btn-primary text-sm px-5" onClick={save} disabled={saving}>{saving ? '...' : 'Сохранить'}</button>
            <button className="neu-btn text-sm px-4" onClick={() => { setShowNew(false); setEditing(null); }}>Отмена</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[#94A3B8]">Загрузка...</p>
      ) : branches.length === 0 ? (
        <div className="neu-sm p-6 text-center">
          <p className="text-[#94A3B8] text-sm">Филиалы не добавлены</p>
          <p className="text-xs text-[#B0BAC6] mt-1">Добавьте первый филиал, чтобы начать работу</p>
        </div>
      ) : (
        <div className="space-y-3">
          {branches.map(b => (
            <div key={b.id} className="neu-sm p-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                {b.is_main && (
                  <span style={{ background: '#DBEAFE', color: '#1D4ED8', borderRadius: 99, padding: '2px 9px', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                    Основной
                  </span>
                )}
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-[#0B1220] truncate">{b.name}</p>
                  <p className="text-xs text-[#64748B] truncate">
                    {[b.city, b.address, b.phone].filter(Boolean).join(' · ') || 'Адрес не указан'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span style={{
                  background: b.is_active ? '#DCFCE7' : '#FEE2E2',
                  color: b.is_active ? '#15803D' : '#B91C1C',
                  borderRadius: 99, padding: '2px 9px', fontSize: 11, fontWeight: 600,
                }}>
                  {b.is_active ? 'Активен' : 'Неактивен'}
                </span>
                <button className="neu-icon-btn h-8 w-8" onClick={() => openEdit(b)}><Edit2 size={14} /></button>
                {!b.is_main && (
                  <button className="neu-icon-btn h-8 w-8 text-destructive" onClick={() => setDeletingId(b.id)}><Trash2 size={14} /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
