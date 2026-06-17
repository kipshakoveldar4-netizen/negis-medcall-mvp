import { supabase } from '@/lib/supabase';

export async function getConversionBySource(
  clinicId: string,
  dateStart: string,
  dateEnd: string
) {
  const { data: leads } = await supabase
    .from('leads')
    .select('id, source, status_id, created_at')
    .eq('clinic_id', clinicId)
    .gte('created_at', dateStart)
    .lte('created_at', dateEnd);

  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, lead_id, visited')
    .eq('clinic_id', clinicId)
    .gte('created_at', dateStart)
    .lte('created_at', dateEnd);

  const bookedLeadIds = new Set(bookings?.map(b => b.lead_id).filter(Boolean));
  const visitedLeadIds = new Set(
    bookings?.filter(b => b.visited === true).map(b => b.lead_id).filter(Boolean)
  );

  const sources = ['Facebook', 'TikTok', 'Instagram', 'Google', 'WhatsApp', '2GIS', 'Вручную', 'Webhook'];

  return sources.map(source => {
    const sourceLeads = leads?.filter(l => l.source === source) || [];
    const total = sourceLeads.length;
    const booked = sourceLeads.filter(l => bookedLeadIds.has(l.id)).length;
    const visited = sourceLeads.filter(l => visitedLeadIds.has(l.id)).length;
    return {
      source,
      total,
      booked,
      visited,
      lost: total - booked,
      bookingRate: total > 0 ? (booked / total * 100).toFixed(1) : '0',
      visitRate: total > 0 ? (visited / total * 100).toFixed(1) : '0',
    };
  }).filter(r => r.total > 0);
}

export async function getConversionSummary(
  clinicId: string,
  dateStart: string,
  dateEnd: string
) {
  const rows = await getConversionBySource(clinicId, dateStart, dateEnd);
  const totalLeads = rows.reduce((s, r) => s + r.total, 0);
  const totalBooked = rows.reduce((s, r) => s + r.booked, 0);
  const totalVisited = rows.reduce((s, r) => s + r.visited, 0);
  return {
    leads: totalLeads,
    booked: totalBooked,
    visited: totalVisited,
    lost: totalLeads - totalBooked,
    bookingRate: totalLeads > 0 ? (totalBooked / totalLeads * 100).toFixed(1) : '0',
    visitRate: totalLeads > 0 ? (totalVisited / totalLeads * 100).toFixed(1) : '0',
  };
}
