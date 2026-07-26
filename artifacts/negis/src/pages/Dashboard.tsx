import { useState, useEffect } from 'react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Link } from 'wouter';
import { BarChart3, Calendar, CalendarCheck, DollarSign, PhoneCall, Rocket, TrendingUp, Users } from 'lucide-react';
import { useGetDashboardMetrics } from '@workspace/api-client-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { agentDisplayName, loadAgentRoleMaps } from '@/lib/agentDisplay';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';

const SLOT_HOURS = [10, 11, 12, 13, 14, 15, 16, 17];
const MAX_PER_SLOT = 3;

interface AgentRace {
  id: string;
  name: string;
  displayName: string;
  initials: string;
  bookings: number;
  weekly_target: number;
}

interface SlotLoad {
  time: string;
  booked: number;
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
            style={{ background: 'var(--negis-primary-soft)', borderColor: 'var(--ng-primary)' }}
          >
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--ng-accent)' }}>Новый главный экран: AI Control Center</p>
              <p className="mt-0.5 text-sm" style={{ color: 'var(--ng-primary)' }}>Заявки, реклама, продажи и AI-рекомендации в одном месте.</p>
            </div>
            <span className="shrink-0 text-sm font-semibold" style={{ color: 'var(--ng-accent)' }}>Открыть →</span>
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
                    style={{ background: 'var(--negis-primary-soft)', color: 'var(--ng-primary)' }}
                  >
                    <Icon size={15} />
                  </span>
                  <span className="text-xs font-semibold" style={{ color: 'var(--ng-muted)' }}>Открыть</span>
                </div>
                <h2 className="text-sm font-semibold" style={{ color: 'var(--ng-text)' }}>{label}</h2>
                <p className="mt-1.5 text-sm" style={{ color: 'var(--ng-muted)' }}>{value}</p>
              </div>
            </Link>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="neu-card lg:col-span-2">
            <h2 className="mb-4 text-base font-semibold" style={{ color: 'var(--ng-text)' }}>Воронка на сегодня</h2>
            <div className="space-y-2.5">
              {([
                ['Новые лиды', '24', 'var(--negis-secondary)'],
                ['Квалифицированные звонки', '14', 'var(--ng-primary)'],
                ['Записанные визиты', '7', 'var(--ng-success)'],
              ] as const).map(([label, value, color]) => (
                <div key={label} className="neu-pressed-sm flex items-center justify-between p-3 px-4">
                  <div className="flex items-center gap-3">
                    <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--ng-text-2)' }}>{label}</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--ng-text)' }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="neu-card">
            <h2 className="mb-4 text-base font-semibold" style={{ color: 'var(--ng-text)' }}>Срез кампании</h2>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--ng-muted)' }}>Статус</p>
                <p className="mt-1 text-sm font-semibold" style={{ color: 'var(--ng-text)' }}>Ожидает запуска</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--ng-muted)' }}>Оценка креатива</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--ng-primary)' }}>86</p>
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

function LiveDashboard() {
  const { clinicId } = useAuth();
  const { data: metrics, isLoading } = useGetDashboardMetrics();
  const [agents, setAgents] = useState<AgentRace[]>([]);
  const [slots, setSlots] = useState<SlotLoad[]>(
    SLOT_HOURS.map(h => ({ time: `${String(h).padStart(2, '0')}:00`, booked: 0 }))
  );
  const [loadingData, setLoadingData] = useState(true);

  useEffect(() => {
    if (clinicId) loadDashboardData();
  }, [clinicId]);

  const loadDashboardData = async () => {
    if (!clinicId) return;
    setLoadingData(true);

    const today = new Date().toISOString().split('T')[0];
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const [{ data: agentsData }, { data: todayBookings }, { data: weekBookings }] = await Promise.all([
      supabase.from('agents').select('id, name, user_id, role_id, weekly_target').eq('clinic_id', clinicId).order('name'),
      supabase.from('bookings').select('time, agent_id').eq('clinic_id', clinicId).eq('date', today),
      supabase.from('bookings').select('agent_id').eq('clinic_id', clinicId).gte('date', weekStartStr),
    ]);

    if (todayBookings) {
      const countMap: Record<string, number> = {};
      for (const b of todayBookings) {
        const hour = parseInt(b.time ?? '0');
        const key = `${String(hour).padStart(2, '0')}:00`;
        countMap[key] = (countMap[key] ?? 0) + 1;
      }
      setSlots(SLOT_HOURS.map(h => {
        const key = `${String(h).padStart(2, '0')}:00`;
        return { time: key, booked: countMap[key] ?? 0 };
      }));
    }

    if (agentsData) {
      const maps = await loadAgentRoleMaps(supabase, clinicId, agentsData as any);
      const weekMap: Record<string, number> = {};
      for (const b of (weekBookings ?? [])) {
        if (b.agent_id) weekMap[b.agent_id] = (weekMap[b.agent_id] ?? 0) + 1;
      }
      const bookingAgents = agentsData.filter(a => {
        const customRole = (maps.customRoleMap[(a as any).role_id] ?? '').toLowerCase();
        const systemRole = maps.userRoleMap[(a as any).user_id] ?? '';
        return systemRole === 'booking_agent' || /booking|book|запис/i.test(customRole);
      });
      const race: AgentRace[] = bookingAgents.map(a => {
        const parts = a.name.trim().split(' ');
        const initials = parts.map((p: string) => p[0]?.toUpperCase() ?? '').slice(0, 2).join('');
        return {
          id: a.id, name: a.name, displayName: agentDisplayName(a as any, maps.customRoleMap, maps.userRoleMap), initials,
          bookings: weekMap[a.id] ?? 0,
          weekly_target: a.weekly_target ?? 20,
        };
      }).sort((a, b) => (b.bookings / b.weekly_target) - (a.bookings / a.weekly_target));
      setAgents(race);
    }

    setLoadingData(false);
  };

  // Slot load is triage-coded: free / partial / full. Colors come from the
  // token palette; no glow shadows — state is also carried by the count text.
  const slotTone = (booked: number) => {
    if (booked >= MAX_PER_SLOT) return 'var(--ng-error)';
    if (booked > 0) return booked / MAX_PER_SLOT >= 0.5 ? 'var(--ng-warning)' : 'var(--ng-success)';
    return 'var(--ng-border)';
  };

  const bookingsToday = slots.reduce((s, sl) => s + sl.booked, 0);

  return (
    <PageLayout>
      <div className="space-y-6">
        <PageHeader kicker="Обзор" title="Аналитика" description="Записи, загрузка и выручка за сегодня." />

        {/* METRICS */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Записей сегодня"
            value={isLoading ? undefined : (metrics?.bookingsToday ?? bookingsToday)}
            icon={Calendar}
            tone="info"
            loading={isLoading}
          />
          <MetricCard
            label="Загрузка"
            value={isLoading ? undefined : (metrics?.loadPercent != null
              ? `${metrics.loadPercent}%`
              : `${Math.round((bookingsToday / (SLOT_HOURS.length * MAX_PER_SLOT)) * 100)}%`)}
            icon={TrendingUp}
            tone="warning"
            loading={isLoading}
          />
          <MetricCard
            label="Выручка сегодня"
            value={isLoading ? undefined : (metrics?.revenueToday != null ? `${metrics.revenueToday.toLocaleString('ru-RU')} ₸` : null)}
            icon={DollarSign}
            tone="success"
            loading={isLoading}
          />
          <MetricCard
            label="Пришло клиентов"
            value={isLoading ? undefined : (metrics?.visitedToday ?? null)}
            icon={Users}
            tone="primary"
            loading={isLoading}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* AGENT RACE */}
          <div className="neu-card flex flex-col lg:col-span-2">
            <h2 className="mb-5 text-base font-semibold" style={{ color: 'var(--ng-text)' }}>Гонка агентов</h2>
            {loadingData ? (
              <p className="text-sm" style={{ color: 'var(--ng-muted)' }}>Загрузка…</p>
            ) : agents.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--ng-muted)' }}>Букинг-менеджеры не найдены</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {agents.map((agent, index) => {
                  const pct = Math.min(Math.round((agent.bookings / agent.weekly_target) * 100), 100);
                  const isLeader = index === 0 && agent.bookings > 0;
                  return (
                    <div key={agent.id} className="neu-sm p-4">
                      <div className="mb-3 flex items-center gap-3">
                        <span
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold"
                          style={isLeader
                            ? { background: 'var(--negis-primary-soft)', color: 'var(--ng-primary)' }
                            : { background: 'var(--ng-surface-2)', color: 'var(--ng-text-2)', border: '1px solid var(--ng-border)' }}
                        >
                          {agent.initials}
                        </span>
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ng-text)' }}>
                            <span className="truncate">{agent.displayName}</span>
                            {isLeader && <span className="badge badge-success shrink-0">Лидер</span>}
                          </p>
                          <p className="text-xs tabular-nums" style={{ color: 'var(--ng-muted)' }}>
                            {agent.bookings} / {agent.weekly_target} записей
                          </p>
                        </div>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--ng-plate)' }}>
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%`, background: isLeader ? 'var(--ng-primary)' : 'var(--ng-muted)' }}
                        />
                      </div>
                      <p className="mt-1 text-right text-xs font-semibold tabular-nums" style={{ color: 'var(--ng-text-2)' }}>{pct}%</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* HOURLY LOAD */}
          <div className="neu-card">
            <h2 className="mb-5 text-base font-semibold" style={{ color: 'var(--ng-text)' }}>Загрузка по часам</h2>
            {loadingData ? (
              <p className="text-sm" style={{ color: 'var(--ng-muted)' }}>Загрузка…</p>
            ) : (
              <div className="space-y-2">
                {slots.map((slot) => (
                  <div key={slot.time} className="neu-pressed-sm flex items-center justify-between p-2 px-4">
                    <span className="text-sm font-medium tabular-nums" style={{ color: 'var(--ng-text-2)' }}>{slot.time}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold tabular-nums" style={{ color: 'var(--ng-muted)' }}>
                        {slot.booked} / {MAX_PER_SLOT}
                      </span>
                      <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: slotTone(slot.booked) }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
    </PageLayout>
  );
}
