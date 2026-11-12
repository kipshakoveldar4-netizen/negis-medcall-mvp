import type { MortgageSnapshot } from '../../lib/crm/mortgage-contract';

// Disposable in-memory visual data only. This is not a substitute for SQL tests.
type Contract = { id: string; leadId: string; reference: string; signedAt: string; responsibleStaffId: string;
  responsibleName: string; recordedByName: string; voidedAt: string | null; voidReason: string };
const contracts: Contract[] = [];
const receipts = new Map<string, { fingerprint: string; id: string }>();
const ok = (data: unknown) => Response.json({ success: true, mode: 'supabase', data });
const fail = (status: number, error: string, code = 'fixture_error') => Response.json({ success: false, error, code }, { status });

export function mortgageOutcomesBrowserRequest(url: URL, init: RequestInit | undefined, role: string, snapshot: MortgageSnapshot) {
  if (!['owner', 'admin', 'lead_manager'].includes(role)) return fail(403, 'Доступ закрыт');
  const method = init?.method || 'GET';
  if (url.pathname.endsWith('/mortgage-results')) {
    if (method !== 'GET' || !['owner', 'admin'].includes(role)) return fail(403, 'Доступ закрыт');
    const days = Number(url.searchParams.get('days') || 30);
    if (![7, 30, 90].includes(days)) return fail(400, 'Некорректный период');
    const now = new Date().toISOString(), from = new Date(Date.parse(now) - days * 86400000).toISOString();
    const active = contracts.filter(c => !c.voidedAt);
    return ok({ timeZone: snapshot.timeZone, generatedAt: now, period: { days, from, to: now }, unassignedLeads: snapshot.metrics.unassignedLeads,
      otherAssigneeLeads: snapshot.contacts.filter(c => c.responsibleUserId && !snapshot.members.some(m => m.id === c.responsibleUserId)).length,
      members: snapshot.members.map(m => {
        const mine = snapshot.contacts.filter(c => c.responsibleUserId === m.id);
        const held = (lead: string) => snapshot.activities.filter(a => a.leadId === lead && a.kind === 'meeting' && a.status === 'done'
          && a.endsAt && Date.parse(a.endsAt) <= Date.parse(now));
        return { staffId: m.id, name: m.name, role: m.role, status: m.status, assignedLeads: mine.length,
          heldLeads: mine.filter(c => held(c.id).length).length,
          signedLeads: mine.filter(c => active.some(s => s.leadId === c.id)).length,
          heldSignedLeads: mine.filter(c => active.some(s => s.leadId === c.id && held(c.id).some(a => Date.parse(a.endsAt!) <= Date.parse(s.signedAt)))).length,
          signedInPeriod: active.filter(c => c.responsibleStaffId === m.id && c.signedAt >= from && c.signedAt <= now).length };
      }) });
  }
  const body = method === 'GET' ? {} : JSON.parse(String(init?.body || '{}'));
  const leadId = method === 'GET' ? url.searchParams.get('leadId') : body.leadId;
  const contact = snapshot.contacts.find(c => c.id === leadId);
  if (!contact) return fail(404, 'Клиент недоступен');
  if (method === 'GET') return ok({ records: contracts.filter(c => c.leadId === leadId).slice().reverse(), truncated: false });
  if (!['POST', 'PATCH'].includes(method) || (method === 'PATCH' && role === 'lead_manager')) return fail(403, 'Доступ закрыт');
  const key = `${role}:${body.requestId}`, fingerprint = JSON.stringify(body), receipt = receipts.get(key);
  if (receipt) return receipt.fingerprint === fingerprint ? ok({ id: receipt.id, replayed: true }) : fail(409, 'Ключ уже использован', 'request_conflict');
  let id: string;
  if (method === 'POST') {
    if (!contact.responsibleUserId) return fail(409, 'Назначьте ответственного', 'lead_requires_assignment');
    if (contracts.some(c => c.leadId === leadId && !c.voidedAt)) return fail(409, 'Договор уже учтён', 'contract_already_recorded');
    if (!Number.isFinite(Date.parse(body.signedAt)) || Date.parse(body.signedAt) > Date.now()) return fail(400, 'Проверьте дату договора', 'invalid_contract');
    id = crypto.randomUUID();
    contracts.push({ id, leadId, signedAt: body.signedAt, reference: body.reference, responsibleStaffId: contact.responsibleUserId,
      responsibleName: contact.responsibleName || '', recordedByName: 'Тестовый сотрудник', voidedAt: null, voidReason: '' });
  } else {
    const contract = contracts.find(c => c.id === body.id && c.leadId === leadId);
    if (!contract) return fail(404, 'Договор недоступен');
    if (contract.voidedAt) return fail(409, 'Запись уже исправлена', 'contract_already_corrected');
    if (typeof body.reason !== 'string' || !body.reason.trim()) return fail(400, 'Укажите причину');
    id = contract.id; contract.voidedAt = new Date().toISOString(); contract.voidReason = body.reason.trim();
  }
  receipts.set(key, { id, fingerprint });
  return ok({ id, replayed: false });
}
