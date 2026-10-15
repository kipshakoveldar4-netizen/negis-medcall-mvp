import type { WorkspacePurpose } from '../../../../lib/crm/workspace-purpose';

// This limits the first-stage interface, never grants a role permission.
export function workspaceAllowsRoute(purpose: WorkspacePurpose | null, role: string | null, path: string) {
  if (!purpose) return false;
  if (purpose !== 'mortgage_leads') return true;
  const route = path.split('?')[0];
  if (!['owner','admin','lead_manager'].includes(role || '')) return false;
  if (['/dashboard','/leads','/clients','/appointments','/booking','/tasks'].includes(route)) return true;
  return ['/admin','/analytics'].includes(route) && (role === 'owner' || role === 'admin');
}

export function workspaceEntryRoute(purpose: WorkspacePurpose | null, role: string | null) {
  return purpose === 'mortgage_leads' ? '/dashboard' : role === 'lead_manager' ? '/leads' : '/dashboard';
}
