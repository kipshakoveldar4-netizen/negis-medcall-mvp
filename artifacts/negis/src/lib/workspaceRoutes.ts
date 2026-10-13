import type { WorkspacePurpose } from '../../../../lib/crm/workspace-purpose';

// This limits the first-stage interface, never grants a role permission.
export function workspaceAllowsRoute(purpose: WorkspacePurpose | null, role: string | null, path: string) {
  if (!purpose) return false;
  if (purpose !== 'mortgage_leads') return true;
  const route = path.split('?')[0];
  if (route === '/leads') return role === 'owner' || role === 'admin' || role === 'lead_manager';
  return route === '/admin' && (role === 'owner' || role === 'admin');
}

export function workspaceEntryRoute(purpose: WorkspacePurpose | null, role: string | null) {
  return purpose === 'mortgage_leads' || role === 'lead_manager' ? '/leads' : '/dashboard';
}
