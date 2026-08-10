import { useState, useEffect } from 'react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Link } from 'wouter';
import { BarChart3, Calendar, CalendarCheck, DollarSign, PhoneCall, Rocket, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { apiUrl, crmFetch } from '@/lib/api';
import { readWorkspaceId } from '@/lib/demoStorage';
import { clinicToday, isOnClinicDay } from '@/lib/clinicDay';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';

type CrmRecord = Record<string, unknown>;

/* Real CRM list read. A failed endpoint reports ok:false so the metric can
   render an honest "—" instead of a fabricated zero. */
async function fetchList(path: string, listKey: string): Promise<{ ok: boolean; items: CrmRecord[]; timeZone: string }> {
  try {
    const response = await crmFetch(path);
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok || body.success !== true) return { ok: false, items: [], timeZone: '' };
    const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
    const list = Array.isArray(data[listKey]) ? data[listKey] : Array.isArray(data.items) ? data.items : [];
    // Пояс клиники приезжает вместе со списком записей: спрашивать его у
    // маршрута настроек нельзя — он открыт только владельцу и администратору.
    return { ok: true, items: list as CrmRecord[], timeZone: typeof data.timeZone === 'string' ? data.timeZone : '' };
  } catch {
    return { ok: false, items: [], timeZone: '' };
  }
}

export default function Dashboard() {
  const { isDemoMode } = useAuth();

  if (isDemoMode) {
    return <DemoDashboard />;
  }

  return <LiveDashboard />;
}

function DemoDashboard() {
  const { clinicId } = useAuth();
  const releaseChecks = (() => {
    try {
      return JSON.parse(localStorage.getItem('negis_release_checks') || '[]') as Array<{ status?: string; critical?: boolean }>;
    } catch {
      return [];
    }
  })();
  const releaseBlockers = releaseChecks.filter((check) => check.critical !== false && check.status !== 'passed' && check.status !== 'skipped').length;
  const releaseComplete = releaseChecks.length > 0 && releaseBlockers === 0;
  const metrics = [
    { label: 'Лиды сегодня', value: '24', icon: Users, tone: 'info' as const },
    { label: 'Звонки', value: '18', icon: PhoneCall, tone: 'primary' as const },
    { label: 'Записи', value: '7', icon: CalendarCheck, tone: 'success' as const },
    { label: 'Расход рекламы', value: '300 USD', icon: DollarSign, tone: 'warning' as const },
  ];
  const sections = [
    { href: '/ads-automation', label: 'AI запуск рекламы', value: 'ИИ заполнит и запустит кампанию', icon: Rocket },
    { href: '/leads', label: 'Лиды', value: '24 активных лида', icon: Users },
    { href: '/calls', label: 'Звонки', value: '18 звонков в очереди', icon: PhoneCall },
    { href: '/appointments', label: 'Записи', value: '7 запланированных визитов', icon: CalendarCheck },
    { href: '/reports', label: 'Отчёты', value: 'Демо-отчёт кампании', icon: BarChart3 },
  ];

  return (
    <PageLayout>
      <div className="space-y-6">
        <PageHeader
          kicker="Демо-режим"
          title="Medina OS"
          description={`${clinicId || 'demo-workspace'} · данные сохранены локально, подключение Supabase будет в production-версии.`}
        />

        <Link href="/ai-control-center">
          <div
            className="neu-sm flex cursor-pointer items-center justify-between gap-3 p-4"
            style={{ background: 'var(--negis-primary-soft)', borderColor: 'var(--negis-primary)' }}
          >
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--negis-accent)' }}>Новый главный экран: AI Control Center</p>
              <p className="mt-0.5 text-sm" style={{ color: 'var(--negis-primary)' }}>Заявки, реклама, продажи и AI-рекомендации в одном месте.</p>
            </div>
            <span className="shrink-0 text-sm font-semibold" style={{ color: 'var(--negis-accent)' }}>Открыть →</span>
          </div>
        </Link>

        <div className="neu-sm p-4" style={releaseComplete
          ? { background: '#ECFDF5', borderColor: '#A7F3D0', color: '#047857' }
          : { background: '#FFFBEB', borderColor: '#FDE68A', color: '#B45309' }}>
          <p className="font-semibold">
            {releaseComplete ? 'Платформа готова к тестовой работе сотрудников' : 'Платформа в режиме подготовки к релизу'}
          </p>
          <p className="mt-1 text-sm">
            {releaseComplete ? 'Release checklist закрыт.' : `Осталось закрыть блокеры: ${releaseChecks.length ? releaseBlockers : 'откройте /admin'}.`}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map(({ label, value, icon, tone }) => (
            <MetricCard key={label} label={label} value={value} icon={icon} tone={tone} />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {sections.map(({ href, label, value, icon: Icon }) => (
            <Link key={href} href={href}>
              <div className="neu-card h-full cursor-pointer">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <span
                    className="flex h-8 w-8 items-center justify-center rounded-lg"
                    style={{ background: 'var(--negis-primary-soft)', color: 'var(--negis-primary)' }}
                  >
                    <Icon size={15} />
                  </span>
                  <span className="text-xs font-semibold" style={{ color: 'var(--negis-muted)' }}>Открыть</span>
                </div>
                <h2 className="text-sm font-semibold" style={{ color: 'var(--negis-text)' }}>{label}</h2>
                <p className="mt-1.5 text-sm" style={{ color: 'var(--negis-muted)' }}>{value}</p>
              </div>
            </Link>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="neu-card lg:col-span-2">
            <h2 className="mb-4 text-base font-semibold" style={{ color: 'var(--negis-text)' }}>Воронка на сегодня</h2>
            <div className="space-y-2.5">
              {([
                ['Новые лиды', '24', 'var(--negis-secondary)'],
                ['Квалифицированные звонки', '14', 'var(--negis-primary)'],
                ['Записанные визиты', '7', 'var(--negis-success)'],
              ] as const).map(([label, value, color]) => (
                <div key={label} className="neu-pressed-sm flex items-center justify-between p-3 px-4">
                  <div className="flex items-center gap-3">
                    <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--negis-text-2)' }}>{label}</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--negis-text)' }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="neu-card">
            <h2 className="mb-4 text-base font-semibold" style={{ color: 'var(--negis-text)' }}>Срез кампании</h2>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--negis-muted)' }}>Статус</p>
                <p className="mt-1 text-sm font-semibold" style={{ color: 'var(--negis-text)' }}>Ожидает запуска</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--negis-muted)' }}>Оценка креатива</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--negis-primary)' }}>86</p>
              </div>
              <Link href="/ads-automation">
                <div className="neu-btn-primary inline-flex cursor-pointer items-center gap-2">
                  <Rocket size={16} />
                  AI запуск рекламы
                </div>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}


// Security-1A: LiveDashboard previously read `agents` and `bookings` directly
// from the browser and called /api/dashboard/metrics. None of those exist in
// production (the tables are absent and there is no dashboard metrics API), so
// every widget failed silently. The agent race and hourly booking load were
// employee/booking features with no backing data and are removed rather than
// faked. What remains is sourced from the same real CRM endpoints already used
// by the operational overview.
function LiveDashboard() {
  const [counts, setCounts] = useState<{
    appointmentsToday: number | null;
    newLeads: number | null;
    clients: number | null;
    revenueTodayMinor: number | null;
  }>({ appointmentsToday: null, newLeads: null, clients: null, revenueTodayMinor: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const workspaceId = readWorkspaceId();
      const q = `workspaceId=${encodeURIComponent(workspaceId)}`;
      const [appointments, leads, clients, deals] = await Promise.all([
        fetchList(`/api/crm/appointments?${q}`, 'appointments'),
        fetchList(`/api/crm/leads?${q}`, 'leads'),
        fetchList(`/api/crm/clients?${q}`, 'clients'),
        fetchList(`/api/crm/deals?${q}`, 'deals'),
      ]);
      if (cancelled) return;

      // «Сегодня» — это сутки клиники, а не UTC. Прежняя строка брала
      // toISOString(), то есть Гринвич, под комментарием «текущая локальная
      // дата»: в UTC+5 экран называл чужой день примерно пять часов каждую
      // ночь, и обе цифры ниже в это время были не про сегодня.
      const timeZone = appointments.timeZone;
      const today = clinicToday(timeZone);
      const isToday = (value: unknown) => isOnClinicDay(value, today, timeZone);

      setCounts({
        appointmentsToday: appointments.ok
          ? appointments.items.filter((item) => isToday(item.date ?? item.startsAt ?? item.starts_at)).length
          : null,
        newLeads: leads.ok
          ? leads.items.filter((item) => String(item.status ?? '').toLowerCase() === 'new').length
          : null,
        clients: clients.ok ? clients.items.length : null,
        // CRM9d definition: paid deals whose paidAt falls on the clinic's day.
        revenueTodayMinor: deals.ok
          ? deals.items
              .filter((item) => String(item.status ?? '').toLowerCase() === 'paid' && isToday(item.paidAt ?? item.paid_at))
              .reduce((sum, item) => {
                const minor = Number(item.amountMinor ?? item.amount_minor);
                return sum + (Number.isFinite(minor) && minor > 0 ? Math.round(minor) : 0);
              }, 0)
          : null,
      });
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  return (
    <PageLayout>
      <div className="space-y-6">
        <PageHeader kicker="Обзор" title="Аналитика" description="Записи, заявки, клиенты и оплаченная выручка за сегодня." />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Записей сегодня" value={counts.appointmentsToday} icon={Calendar} tone="info" loading={loading} />
          <MetricCard label="Новые заявки" value={counts.newLeads} icon={Users} tone="primary" loading={loading} />
          <MetricCard label="Клиенты" value={counts.clients} icon={CalendarCheck} tone="success" loading={loading} />
          <MetricCard
            label="Выручка сегодня"
            value={counts.revenueTodayMinor === null ? null : `${Math.floor(counts.revenueTodayMinor / 100).toLocaleString('ru-RU')} ₸`}
            icon={DollarSign}
            tone="success"
            loading={loading}
          />
        </div>

        <p className="text-xs leading-relaxed" style={{ color: 'var(--negis-muted)' }}>
          Показатели рассчитываются по реальным данным CRM за текущую дату. «—» означает, что данные не удалось загрузить.
        </p>
      </div>
    </PageLayout>
  );
}
