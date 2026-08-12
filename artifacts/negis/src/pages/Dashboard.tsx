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
  return <LiveDashboard />;
}

// Сводка без базы удалена.
//
// Она рисовала четыре плитки, воронку и «оценку креатива 86» — ни одно
// число не было связано с источником. При этом ветка была недостижима:
// isDemoMode включается только из сохранённой сессии, которую в этом
// репозитории никто не записывает. То есть выдуманные числа ждали в коде
// случая, когда кто-нибудь сделает ветку достижимой.

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
