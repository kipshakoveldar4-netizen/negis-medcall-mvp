import React, { useState, useEffect } from 'react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Calendar, TrendingUp, DollarSign, Users } from 'lucide-react';
import { useGetDashboardMetrics } from '@workspace/api-client-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { agentDisplayName, loadAgentRoleMaps } from '@/lib/agentDisplay';

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

  const getLoadColor = (booked: number) => {
    const pct = booked / MAX_PER_SLOT;
    if (pct >= 1) return 'bg-destructive shadow-[0_0_8px_rgba(239,68,68,0.5)]';
    if (pct >= 0.5) return 'bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]';
    if (pct > 0) return 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]';
    return 'bg-[#CBD5E1]';
  };

  return (
    <PageLayout>
      <div className="space-y-8">

        {/* METRICS */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="neu-card flex flex-col justify-center relative overflow-hidden group">
            <div className="absolute -right-4 -top-4 opacity-10 text-[#2563EB] group-hover:scale-110 transition-transform duration-500">
              <Calendar size={100} />
            </div>
            <div className="flex items-center gap-3 mb-2 relative z-10">
              <div className="p-2 rounded-xl bg-blue-500/10 text-[#1A56DB]"><Calendar size={20} /></div>
              <h3 className="text-sm font-semibold text-[#64748B]">Записей сегодня</h3>
            </div>
            <p className="text-3xl font-bold text-[#1E293B] relative z-10">
              {isLoading ? '...' : (metrics?.bookingsToday ?? slots.reduce((s, sl) => s + sl.booked, 0))}
            </p>
          </div>

          <div className="neu-card flex flex-col justify-center relative overflow-hidden group">
            <div className="absolute -right-4 -top-4 opacity-10 text-[#F59E0B] group-hover:scale-110 transition-transform duration-500">
              <TrendingUp size={100} />
            </div>
            <div className="flex items-center gap-3 mb-2 relative z-10">
              <div className="p-2 rounded-xl bg-yellow-500/10 text-yellow-600"><TrendingUp size={20} /></div>
              <h3 className="text-sm font-semibold text-[#64748B]">Загрузка</h3>
            </div>
            <p className="text-3xl font-bold text-[#1E293B] relative z-10">
              {isLoading ? '...' : (metrics?.loadPercent != null ? `${metrics.loadPercent}%` :
                `${Math.round((slots.reduce((s, sl) => s + sl.booked, 0) / (SLOT_HOURS.length * MAX_PER_SLOT)) * 100)}%`)}
            </p>
          </div>

          <div className="neu-card flex flex-col justify-center relative overflow-hidden group">
            <div className="absolute -right-4 -top-4 opacity-10 text-[#16A34A] group-hover:scale-110 transition-transform duration-500">
              <DollarSign size={100} />
            </div>
            <div className="flex items-center gap-3 mb-2 relative z-10">
              <div className="p-2 rounded-xl bg-green-500/10 text-green-600"><DollarSign size={20} /></div>
              <h3 className="text-sm font-semibold text-[#64748B]">Выручка сегодня</h3>
            </div>
            <p className="text-3xl font-bold text-[#1E293B] relative z-10">
              {isLoading ? '...' : (metrics?.revenueToday != null ? `${metrics.revenueToday.toLocaleString('ru-RU')} ₸` : '—')}
            </p>
          </div>

          <div className="neu-card flex flex-col justify-center relative overflow-hidden group">
            <div className="absolute -right-4 -top-4 opacity-10 text-[#7C3AED] group-hover:scale-110 transition-transform duration-500">
              <Users size={100} />
            </div>
            <div className="flex items-center gap-3 mb-2 relative z-10">
              <div className="p-2 rounded-xl bg-purple-500/10 text-purple-600"><Users size={20} /></div>
              <h3 className="text-sm font-semibold text-[#64748B]">Пришло клиентов</h3>
            </div>
            <p className="text-3xl font-bold text-[#1E293B] relative z-10">
              {isLoading ? '...' : (metrics?.visitedToday ?? '—')}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* AGENT RACE */}
          <div className="neu-card lg:col-span-2 flex flex-col">
            <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
              <span>Гонка агентов</span>
            </h3>
            {loadingData ? (
              <p className="text-sm text-[#94A3B8]">Загрузка...</p>
            ) : agents.length === 0 ? (
              <p className="text-sm text-[#94A3B8]">Букинг-менеджеры не найдены</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {agents.map((agent, index) => {
                  const pct = Math.min(Math.round((agent.bookings / agent.weekly_target) * 100), 100);
                  const isLeader = index === 0 && agent.bookings > 0;
                  return (
                    <div
                      key={agent.id}
                      className={`neu-sm p-4 relative ${isLeader ? 'shadow-[0_0_15px_rgba(26,86,219,0.3)] border border-[#1A56DB]/20' : ''}`}
                    >
                      {isLeader && (
                        <div className="absolute -top-3 -right-3 text-2xl drop-shadow-md">👑</div>
                      )}
                      <div className="flex items-center gap-3 mb-4">
                        <div className={`neu-icon-btn font-bold text-sm ${isLeader ? 'text-[#1A56DB]' : ''}`}>
                          {agent.initials}
                        </div>
                        <div>
                          <p className="font-semibold text-sm">{agent.displayName}</p>
                          <p className="text-xs text-[#64748B]">{agent.bookings} / {agent.weekly_target} записей</p>
                        </div>
                      </div>
                      <div className="h-2.5 w-full bg-border rounded-full overflow-hidden neu-pressed-sm">
                        <div
                          className={`h-full transition-all duration-500 rounded-full ${isLeader ? 'bg-[#1A56DB]' : 'bg-[#64748B]'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-right text-xs font-bold mt-1 text-[#1E293B]">{pct}%</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* HOURLY LOAD */}
          <div className="neu-card">
            <h3 className="text-lg font-bold mb-6">Загрузка по часам</h3>
            {loadingData ? (
              <p className="text-sm text-[#94A3B8]">Загрузка...</p>
            ) : (
              <div className="space-y-3">
                {slots.map((slot) => (
                  <div key={slot.time} className="flex items-center justify-between neu-sm p-2 px-4">
                    <span className="font-medium text-sm">{slot.time}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-[#64748B]">{slot.booked} / {MAX_PER_SLOT}</span>
                      <div className={`h-3 w-3 rounded-full ${getLoadColor(slot.booked)}`} />
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
