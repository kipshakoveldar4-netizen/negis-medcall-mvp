export interface AgentDisplayInfo {
  id: string;
  name: string;
  user_id: string | null;
  role_id?: string | null;
  avatar_url?: string | null;
  avatar_icon?: string | null;
  avatar_color?: string | null;
}

export const SYSTEM_ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  manager: 'Руководитель',
  agent: 'Менеджер',
  booking_agent: 'Агент записи',
  receptionist: 'Ресепшн',
};

export function agentDisplayName(
  agent: AgentDisplayInfo | null | undefined,
  customRoleMap: Record<string, string> = {},
  userRoleMap: Record<string, string> = {},
) {
  if (!agent) return '—';
  const customRole = agent.role_id ? customRoleMap[agent.role_id] : '';
  const systemRole = agent.user_id ? SYSTEM_ROLE_LABELS[userRoleMap[agent.user_id]] : '';
  const title = customRole || systemRole;
  return title ? `${agent.name} · ${title}` : agent.name;
}

export function agentInitials(agent: Pick<AgentDisplayInfo, 'name'> | null | undefined, fallback = 'U') {
  const source = agent?.name || fallback;
  return source
    .split(' ')
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function agentAvatarStyle(agent: AgentDisplayInfo | null | undefined) {
  return {
    background: agent?.avatar_color || 'linear-gradient(145deg, #EFF6FF, #FFFFFF)',
  };
}

export async function loadAgentRoleMaps(
  supabase: any,
  clinicId: string | null,
  agents: AgentDisplayInfo[],
) {
  if (!clinicId) return { customRoleMap: {}, userRoleMap: {} };
  const userIds = agents.map(agent => agent.user_id).filter(Boolean) as string[];
  const roleQuery = supabase.from('roles').select('id, name').eq('clinic_id', clinicId);
  const userRoleQuery = userIds.length
    ? supabase.from('user_roles').select('user_id, role').eq('clinic_id', clinicId).in('user_id', userIds)
    : Promise.resolve({ data: [] });

  const [{ data: roles }, { data: userRoles }] = await Promise.all([roleQuery, userRoleQuery]);
  return {
    customRoleMap: Object.fromEntries((roles ?? []).map((role: any) => [role.id, role.name])),
    userRoleMap: Object.fromEntries((userRoles ?? []).map((row: any) => [row.user_id, row.role])),
  };
}
