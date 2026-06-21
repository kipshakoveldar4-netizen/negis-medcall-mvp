export const staffRoles = ["owner", "admin", "receptionist", "marketer", "doctor", "manager"] as const;

export type StaffRole = (typeof staffRoles)[number];

export const crmPermissions = [
  "view_clients",
  "manage_clients",
  "view_appointments",
  "manage_appointments",
  "view_leads",
  "manage_leads",
  "view_calls",
  "manage_calls",
  "view_tasks",
  "manage_tasks",
  "view_chat",
  "send_chat",
  "view_marketing",
  "manage_marketing",
  "view_ai_content",
  "manage_ai_content",
  "view_targeting",
  "manage_targeting",
  "view_reports",
  "view_admin",
  "manage_staff",
  "manage_integrations",
] as const;

export type CrmPermission = (typeof crmPermissions)[number];

const rolePermissions: Record<StaffRole, CrmPermission[]> = {
  owner: [...crmPermissions],
  admin: [
    "view_clients",
    "manage_clients",
    "view_appointments",
    "manage_appointments",
    "view_leads",
    "manage_leads",
    "view_calls",
    "manage_calls",
    "view_tasks",
    "manage_tasks",
    "view_chat",
    "send_chat",
    "view_marketing",
    "manage_marketing",
    "view_ai_content",
    "manage_ai_content",
    "view_targeting",
    "manage_targeting",
    "view_reports",
    "view_admin",
    "manage_staff",
    "manage_integrations",
  ],
  receptionist: [
    "view_clients",
    "manage_clients",
    "view_appointments",
    "manage_appointments",
    "view_leads",
    "manage_leads",
    "view_calls",
    "manage_calls",
    "view_tasks",
    "manage_tasks",
    "view_chat",
    "send_chat",
  ],
  marketer: [
    "view_clients",
    "view_leads",
    "manage_leads",
    "view_tasks",
    "manage_tasks",
    "view_chat",
    "send_chat",
    "view_marketing",
    "manage_marketing",
    "view_ai_content",
    "manage_ai_content",
    "view_targeting",
    "manage_targeting",
    "view_reports",
  ],
  doctor: [
    "view_clients",
    "view_appointments",
    "manage_appointments",
    "view_tasks",
    "manage_tasks",
    "view_chat",
    "send_chat",
  ],
  manager: [
    "view_clients",
    "manage_clients",
    "view_appointments",
    "manage_appointments",
    "view_leads",
    "manage_leads",
    "view_calls",
    "manage_calls",
    "view_tasks",
    "manage_tasks",
    "view_chat",
    "send_chat",
    "view_marketing",
    "view_ai_content",
    "view_targeting",
    "view_reports",
    "view_admin",
  ],
};

export const roleLabels: Record<StaffRole, string> = {
  owner: "Владелец",
  admin: "Администратор",
  receptionist: "Ресепшн",
  marketer: "Маркетолог",
  doctor: "Врач",
  manager: "Менеджер",
};

export const permissionLabels: Record<CrmPermission, string> = {
  view_clients: "Просмотр клиентов",
  manage_clients: "Управление клиентами",
  view_appointments: "Просмотр записей",
  manage_appointments: "Управление записями",
  view_leads: "Просмотр лидов",
  manage_leads: "Управление лидами",
  view_calls: "Просмотр звонков",
  manage_calls: "Управление звонками",
  view_tasks: "Просмотр задач",
  manage_tasks: "Управление задачами",
  view_chat: "Просмотр чата",
  send_chat: "Отправка сообщений",
  view_marketing: "Маркетинг",
  manage_marketing: "Управление маркетингом",
  view_ai_content: "ИИ студия контента",
  manage_ai_content: "Управление ИИ контентом",
  view_targeting: "ИИ таргетолог",
  manage_targeting: "Управление таргетингом",
  view_reports: "Отчёты",
  view_admin: "Админ панель",
  manage_staff: "Сотрудники",
  manage_integrations: "Интеграции",
};

export function permissionsForRole(role: StaffRole): CrmPermission[] {
  return rolePermissions[role] ?? [];
}

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && staffRoles.includes(value as StaffRole);
}

export function hasPermission(role: StaffRole | string | null | undefined, permission: CrmPermission): boolean {
  if (!isStaffRole(role)) return false;
  return permissionsForRole(role).includes(permission);
}
