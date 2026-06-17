import React, { useState, useEffect, useRef } from 'react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Play, Square, Target, Calendar as CalendarIcon } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

interface AgentInfo {
  id: string;
  name: string;
  hourly_rate: number;
  weekly_target: number;
}

interface ShiftRecord {
  id: string;
  start_time: string;
  end_time: string | null;
}

export default function Agent() {
  const { clinicId, user } = useAuth();
  const [agentInfo, setAgentInfo]       = useState<AgentInfo | null>(null);
  const [activeShift, setActiveShift]   = useState<ShiftRecord | null>(null);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [bookingsToday, setBookingsToday]   = useState(0);
  const [weeklyBookings, setWeeklyBookings] = useState(0);
  const [loading, setLoading]           = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (clinicId && user) load();
  }, [clinicId, user]);

  useEffect(() => {
    if (activeShift) {
      const elapsed = Math.floor((Date.now() - new Date(activeShift.start_time).getTime()) / 1000);
      setSecondsElapsed(elapsed);
      intervalRef.current = setInterval(() => setSecondsElapsed(s => s + 1), 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [activeShift]);

  const load = async () => {
    if (!clinicId || !user) return;
    setLoading(true);

    const { data: agent } = await supabase
      .from('agents')
      .select('id, name, hourly_rate, weekly_target')
      .eq('clinic_id', clinicId)
      .eq('user_id', user.id)
      .single();

    if (!agent) { setLoading(false); return; }
    setAgentInfo(agent);

    const today = new Date().toISOString().split('T')[0];
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const [{ data: shift }, { count: todayCount }, { count: weekCount }] = await Promise.all([
      supabase
        .from('shifts')
        .select('id, start_time, end_time')
        .eq('clinic_id', clinicId)
        .eq('agent_id', agent.id)
        .is('end_time', null)
        .order('start_time', { ascending: false })
        .limit(1)
        .single(),
      supabase
        .from('bookings')
        .select('*', { count: 'exact', head: true })
        .eq('clinic_id', clinicId)
        .eq('agent_id', agent.id)
        .eq('date', today),
      supabase
        .from('bookings')
        .select('*', { count: 'exact', head: true })
        .eq('clinic_id', clinicId)
        .eq('agent_id', agent.id)
        .gte('date', weekStartStr),
    ]);

    if (shift && !shift.end_time) setActiveShift(shift);
    setBookingsToday(todayCount ?? 0);
    setWeeklyBookings(weekCount ?? 0);
    setLoading(false);
  };

  const toggleShift = async () => {
    if (!agentInfo || !clinicId) return;

    if (activeShift) {
      const durationMinutes = Math.floor(secondsElapsed / 60);
      const earnings = Math.floor((secondsElapsed / 3600) * agentInfo.hourly_rate);
      const { error } = await supabase
        .from('shifts')
        .update({ end_time: new Date().toISOString(), duration_minutes: durationMinutes, earnings })
        .eq('id', activeShift.id);
      if (error) { toast.error(error.message); return; }
      toast.success(`Смена завершена! Заработано: ${earnings} ₸`);
      setActiveShift(null);
      setSecondsElapsed(0);
    } else {
      const { data, error } = await supabase
        .from('shifts')
        .insert({ clinic_id: clinicId, agent_id: agentInfo.id, start_time: new Date().toISOString() })
        .select()
        .single();
      if (error) { toast.error(error.message); return; }
      toast.success('Смена начата. Успешной работы!');
      setActiveShift(data);
    }
  };

  const formatTime = (totalSeconds: number) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const earnings     = Math.floor((secondsElapsed / 3600) * (agentInfo?.hourly_rate ?? 0));
  const weeklyTarget = agentInfo?.weekly_target ?? 20;
  const weekPct      = Math.min(Math.round((weeklyBookings / weeklyTarget) * 100), 100);

  if (loading) {
    return (
      <PageLayout>
        <div className="flex items-center justify-center h-64 text-[#94A3B8]">Загрузка...</div>
      </PageLayout>
    );
  }

  if (!agentInfo) {
    return (
      <PageLayout>
        <div className="flex items-center justify-center h-64 text-[#94A3B8] text-center">
          Профиль агента не найден.<br />Обратитесь к администратору.
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 bg-[#E8EDF2] border-b border-border pb-6">
          <div>
            <h2 className="text-3xl font-extrabold text-[#1E293B]">Рабочее место</h2>
            <p className="text-[#64748B] font-medium mt-1">{agentInfo.name} • Оператор</p>
          </div>
          <div className="neu-sm px-6 py-3 flex flex-col items-end">
            <span className="text-xs font-bold text-[#64748B] uppercase tracking-wider mb-1">Ставка</span>
            <span className="text-xl font-black text-[#1A56DB]">{agentInfo.hourly_rate} ₸ / час</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 neu-lg p-8 flex flex-col items-center justify-center min-h-[300px] relative overflow-hidden">
            {!activeShift ? (
              <button
                onClick={toggleShift}
                className="w-48 h-48 rounded-full bg-[#E8EDF2] shadow-[12px_12px_24px_#c5cad4,-12px_-12px_24px_#ffffff] flex flex-col items-center justify-center text-[#1A56DB] hover:text-[#1648c0] transition-all hover:scale-105 active:shadow-[inset_8px_8px_16px_#c5cad4,inset_-8px_-8px_16px_#ffffff]"
              >
                <Play size={64} className="ml-3 mb-2" fill="currentColor" />
                <span className="font-extrabold text-lg tracking-widest">НАЧАТЬ</span>
              </button>
            ) : (
              <div className="w-full flex flex-col items-center">
                <div className="font-mono text-7xl font-black text-[#1E293B] mb-2 tracking-tighter drop-shadow-md">
                  {formatTime(secondsElapsed)}
                </div>
                <p className="text-[#64748B] font-bold tracking-widest uppercase mb-12 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  Смена активна
                </p>
                <div className="flex items-center gap-8 w-full max-w-sm">
                  <div className="flex-1 neu-pressed-sm p-4 text-center">
                    <p className="text-xs font-bold text-[#64748B] uppercase mb-1">Заработано</p>
                    <p className="text-2xl font-black text-green-600">{earnings} ₸</p>
                  </div>
                  <button
                    onClick={toggleShift}
                    className="neu-icon-btn w-20 h-20 bg-red-500 text-white shadow-[6px_6px_12px_#c5cad4] hover:bg-red-600 shrink-0 hover:text-white"
                  >
                    <Square size={32} fill="currentColor" />
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-6">
            <div className="neu-card flex-1 flex flex-col justify-center">
              <h3 className="font-bold text-[#1E293B] mb-4 flex items-center gap-2">
                <Target size={20} className="text-[#1A56DB]" />
                Недельный таргет
              </h3>
              <div className="flex items-end justify-between mb-2">
                <span className="text-4xl font-black text-[#1A56DB]">{weeklyBookings}</span>
                <span className="text-lg font-bold text-[#64748B] mb-1">/ {weeklyTarget}</span>
              </div>
              <div className="h-3 w-full bg-border rounded-full overflow-hidden neu-pressed-sm">
                <div
                  className="h-full bg-[#1A56DB] transition-all duration-500 rounded-full"
                  style={{ width: `${weekPct}%` }}
                />
              </div>
              <p className="text-right text-xs font-bold mt-2 text-[#1E293B]">{weekPct}% выполнено</p>
            </div>

            <div className="neu-card flex-1 flex flex-col justify-center bg-[#1A56DB] text-white shadow-[6px_6px_12px_#c5cad4]">
              <h3 className="font-bold mb-2 flex items-center gap-2 text-white/90">
                <CalendarIcon size={20} />
                Мои записи сегодня
              </h3>
              <p className="text-5xl font-black">{bookingsToday}</p>
              <p className="text-sm text-white/80 mt-2 font-medium">
                {bookingsToday >= 10 ? 'Отличный результат!' : bookingsToday >= 5 ? 'Хорошая работа!' : 'Продолжай работать!'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
