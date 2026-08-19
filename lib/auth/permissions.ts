// Server-canonical staff role and permission catalog.
//
// The browser copy in artifacts/negis/src/lib/permissions.ts drives UI affordances
// only. It is never authority: the server recomputes permissions from the role
// stored in staff_users. The two catalogs are kept identical by an assertion in
// scripts/src/medina-tenant-isolation.test.ts, because the frontend package has
// no path alias into lib/ and adding one would change the Vite build graph.

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
  // Справочники клиники: прайс, исполнители и их график.
  //
  // Отдельно от view_admin намеренно. Прайс и расписание правит тот, кто ведёт
  // запись каждый день, — в салоне это администратор, в клинике старший
  // регистратор. Дать им view_admin значило бы открыть и ключи интеграций, и
  // список сотрудников: право на прайс не должно тянуть за собой право на
  // секреты.
  "manage_directory",
  "manage_staff",
  "manage_integrations",
] as const;

export type CrmPermission = (typeof crmPermissions)[number];

const rolePermissions: Record<StaffRole, CrmPermission[]> = {
  owner: [...crmPermissions],
  admin: [
    "manage_directory",
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
    // Администратор салона правит прайс, мастеров и их смены: без этого он не
    // может выполнять свою работу и вынужден звать владельца ради каждой
    // новой услуги.
    "manage_directory",
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
    // view_clients СНЯТО намеренно. Владелец: «мастера не должны видеть
    // контактные данные клиентов, только имя и время записи». Это право
    // открывало сразу три двери: список клиентов целиком, обратный поиск
    // «номер → карточка» и сделки (они посажены на то же право). Записи
    // мастеру нужны по работе и остаются — из них контакты срезаются слоем
    // lib/crm/contact-privacy.ts.
    "view_appointments",
    "manage_appointments",
    "view_tasks",
    "manage_tasks",
    "view_chat",
    "send_chat",
  ],
  manager: [
    // Управляющий правил прайс через view_admin; с выделением отдельного
    // права справочников оно ему возвращается явно, а не через админку.
    "manage_directory",
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

/** Roles allowed to administer a workspace. Unchanged from Security-1B. */
export const workspaceAdminRoles: readonly StaffRole[] = ["owner", "admin"];

/**
 * Role rank used to stop privilege escalation: an actor may never grant a role
 * at or above its own rank, and only the bootstrap flow creates an owner.
 */
const roleRank: Record<StaffRole, number> = {
  owner: 100,
  admin: 80,
  manager: 60,
  marketer: 40,
  doctor: 40,
  receptionist: 20,
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

export function isWorkspaceAdminRole(role: StaffRole | string | null | undefined): boolean {
  return isStaffRole(role) && workspaceAdminRoles.includes(role);
}

export function rankOfRole(role: StaffRole): number {
  return roleRank[role];
}

/**
 * An actor may only assign roles strictly below its own rank. owner is never
 * assignable through the generic staff endpoint, so an admin cannot mint an
 * owner and an owner cannot mint a second owner by accident.
 */
export function canAssignRole(actorRole: StaffRole, targetRole: StaffRole): boolean {
  if (targetRole === "owner") return false;
  return roleRank[actorRole] > roleRank[targetRole];
}
