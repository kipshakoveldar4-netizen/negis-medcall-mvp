import { getSupabaseServerClient } from '../supabase/server';
import { isUuidValue, WorkspaceAdminAuthError } from '../auth/server';
import { isWorkspacePurpose, WORKSPACE_PURPOSE_SETTINGS_KEY, type WorkspacePurpose } from './workspace-purpose';

export async function lookupWorkspacePurposes(workspaceIds: string[]): Promise<Record<string, WorkspacePurpose>> {
  const ids = [...new Set(workspaceIds.filter(isUuidValue))];
  if (ids.length === 0) return {};
  try {
    const supabase = getSupabaseServerClient();
    if (!supabase) throw new Error('workspace_profile_unavailable');
    const { data, error } = await supabase.from('workspace_settings')
      .select('workspace_id, value').in('workspace_id', ids).eq('key', WORKSPACE_PURPOSE_SETTINGS_KEY);
    if (error || !Array.isArray(data)) throw new Error('workspace_profile_unavailable');
    const purposes: Record<string, WorkspacePurpose> = {};
    for (const id of ids) purposes[id] = 'clinic_services';
    const seen = new Set<string>();
    for (const row of data) {
      if (!row || typeof row !== 'object' || !isUuidValue(row.workspace_id)) throw new Error('workspace_profile_unavailable');
      if (!ids.includes(row.workspace_id)) continue;
      const purpose = row.value?.purpose;
      if (!isWorkspacePurpose(purpose) || seen.has(row.workspace_id)) throw new Error('workspace_profile_unavailable');
      purposes[row.workspace_id] = purpose;
      seen.add(row.workspace_id);
    }
    return purposes;
  } catch {
    throw new WorkspaceAdminAuthError(503, 'Не удалось проверить профиль пространства', 'workspace_profile_unavailable');
  }
}

// First-stage mortgage work is inbound leads and manual team administration.
// Existing route permissions still run first; purpose only narrows them.
const MORTGAGE_METHODS: Readonly<Record<string, readonly string[]>> = {
  leads: ['GET', 'POST', 'PATCH'],
  'lead-stages': ['GET'],
  'lead-sources': ['GET'],
  'lead-assignees': ['GET'],
  'lead-team-analytics': ['GET'],
  staff: ['GET', 'PATCH'],
  'staff-credentials': ['POST', 'PATCH'],
  'staff-invitations': ['GET', 'POST', 'PATCH'],
  'staff-join-requests': ['GET', 'PATCH'],
  'join-code': ['GET', 'POST'],
  'push-subscriptions': ['GET', 'POST', 'PATCH'],
};

export function mortgageRouteAllowed(role: string, route: string, method: string) {
  if (!['owner', 'admin', 'lead_manager'].includes(role)) return false;
  if (role === 'lead_manager') return (route === 'leads' && ['GET', 'PATCH'].includes(method))
    || (['lead-stages', 'lead-sources'].includes(route) && method === 'GET')
    || (route === 'push-subscriptions' && ['GET', 'POST', 'PATCH'].includes(method));
  return Object.hasOwn(MORTGAGE_METHODS, route) && MORTGAGE_METHODS[route].includes(method);
}

export function requirePurposeRoute(purpose: WorkspacePurpose, role: string, route: string, method: string) {
  if (purpose === 'mortgage_leads' && !mortgageRouteAllowed(role, route, method)) {
    throw new WorkspaceAdminAuthError(403, 'Раздел недоступен для этого пространства', 'workspace_module_unavailable');
  }
}

export function requireMortgagePayload(route: string, method: string, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || method === 'GET') return;
  const record = body as Record<string, unknown>;
  const updates = record.updates && typeof record.updates === 'object' && !Array.isArray(record.updates)
    ? record.updates as Record<string, unknown> : {};
  for (const payload of [record, updates]) {
    const forbiddenLink = route === 'leads' && ['clientId', 'client_id', 'metaCampaignLaunchId', 'meta_campaign_launch_id']
      .some((key) => payload[key] !== undefined);
    const teamRoute = ['staff', 'staff-credentials', 'staff-invitations', 'staff-join-requests'].includes(route);
    const unsupportedRole = teamRoute && payload.role !== undefined && !['lead_manager', 'admin'].includes(String(payload.role));
    if (forbiddenLink || unsupportedRole) {
      throw new WorkspaceAdminAuthError(403, 'Действие недоступно для этого пространства', 'workspace_module_unavailable');
    }
  }
}
