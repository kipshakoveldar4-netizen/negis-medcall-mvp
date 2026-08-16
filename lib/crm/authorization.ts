import type { CrmPermission, StaffRole } from "../auth/permissions";

// Security-2B — the single authorization registry for /api/crm/*.
//
// Every route the catch-all can reach is listed here exactly once. Anything not
// listed is unknown and denied: there is no generic public category and no
// permissive fallback. service_role bypasses RLS, so the router must resolve a
// verified workspace context from this table before any CRM data client exists.

/** How a route proves who is calling. */
export type RouteKind =
  /** Browser CRM route: verified JWT + active membership + workspace authority. */
  | "browser"
  /** Verified JWT only; runs before a workspace has been selected. */
  | "bootstrap"
  /** Worker-to-server route protected by the existing HMAC contract. */
  | "internal_hmac"
  /**
   * Панель владельца ПЛАТФОРМЫ: читает поперёк арендаторов.
   *
   * Отдельный вид, а не роль и не право. Роли живут в staff_users, и назначает
   * их владелец клиники — значит роль «владелец платформы» он назначит себе.
   * Здесь пропуск даёт только список идентификаторов в переменной окружения,
   * править который может лишь тот, у кого есть доступ к развёртыванию.
   *
   * Эта ветка НЕ строит контекст рабочего пространства: у запроса его нет по
   * определению, и подставлять сюда чей-то workspaceId нельзя.
   */
  | "platform";

export type RouteAuthorization = {
  kind: RouteKind;
  /** Methods the route accepts. Anything else is 405. */
  methods: readonly string[];
  /** Restrict to specific staff roles. */
  roles?: readonly StaffRole[];
  /** Per-method permission requirement, resolved server-side from the role. */
  permissions?: Readonly<Partial<Record<string, CrmPermission>>>;
  /** Methods that are registered but intentionally refused. */
  disabledMethods?: readonly string[];
};

const WORKSPACE_ADMIN: readonly StaffRole[] = ["owner", "admin"];

/**
 * Generic CRM resources served by handleCrmResource.
 *
 * Read and write are separated wherever the existing permission catalog already
 * distinguishes them. Resources whose contents are configuration or credentials
 * are restricted to workspace administrators instead of being mapped onto a
 * broader CRM permission.
 */
export const CRM_RESOURCE_AUTHORIZATION: Readonly<Record<string, RouteAuthorization>> = {
  clients: {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_clients", POST: "manage_clients", PATCH: "manage_clients" },
  },
  leads: {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_leads", POST: "manage_leads", PATCH: "manage_leads" },
  },
  // Lead taxonomy is part of the lead module, so it follows the lead permissions.
  "lead-stages": {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_leads", POST: "manage_leads", PATCH: "manage_leads" },
  },
  "lead-sources": {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_leads", POST: "manage_leads", PATCH: "manage_leads" },
  },
  // Справочник услуг читает тот, кто записывает, а правит тот, кто отвечает за
  // прайс. Права разрешаются ПО МЕТОДУ, поэтому «читают все, правят
  // администраторы» выражается одной записью; поле roles этого не дало бы —
  // оно применяется ко всем методам сразу и отняло бы у ресепшн чтение, на
  // котором держится форма записи.
  "clinic-services": {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_appointments", POST: "manage_directory", PATCH: "manage_directory" },
  },
  // Справочник врачей и график — тот же раскол, что у услуг, и по той же
  // причине: форма записи без списка врачей и без их часов бесполезна, а
  // правит прайс и расписание тот, кто отвечает за клинику.
  "clinic-doctors": {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_appointments", POST: "manage_directory", PATCH: "manage_directory" },
  },
  "doctor-schedule": {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_appointments", POST: "manage_directory", PATCH: "manage_directory" },
  },
  // Deals sit in the same "crm" group as leads and clients in the app's own
  // route permission map, so they reuse the client permissions rather than
  // inventing a new one.
  deals: {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_clients", POST: "manage_clients", PATCH: "manage_clients" },
  },
  appointments: {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_appointments", POST: "manage_appointments", PATCH: "manage_appointments" },
  },
  calls: {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_calls", POST: "manage_calls", PATCH: "manage_calls" },
  },
  tasks: {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_tasks", POST: "manage_tasks", PATCH: "manage_tasks" },
  },
  chat: {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_chat", POST: "send_chat", PATCH: "send_chat" },
  },
  // Staff administration is owner/admin only through manage_staff. Creation is
  // registered but refused: there is no verified enrollment flow that links an
  // email to a Supabase Auth user, and accepting a browser-supplied
  // auth_user_id was the escalation path Commercial-3A found.
  staff: {
    kind: "browser",
    methods: ["GET", "PATCH"],
    disabledMethods: ["POST"],
    // POST carries a permission too: the disabled capability is only disclosed
    // to a caller who authenticated and was authorized for staff management.
    permissions: { GET: "manage_staff", PATCH: "manage_staff", POST: "manage_staff" },
  },
  "content-videos": {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_ai_content", POST: "manage_ai_content", PATCH: "manage_ai_content" },
  },
  // Configuration and credential-bearing resources: workspace administrators only.
  "admin-settings": { kind: "browser", methods: ["GET", "POST", "PATCH"], roles: WORKSPACE_ADMIN },
  "integration-statuses": { kind: "browser", methods: ["GET", "POST", "PATCH"], roles: WORKSPACE_ADMIN },
  "ai-providers": { kind: "browser", methods: ["GET", "POST", "PATCH"], roles: WORKSPACE_ADMIN },
  "meta-accounts": { kind: "browser", methods: ["GET", "POST", "PATCH"], roles: WORKSPACE_ADMIN },
  "release-checks": { kind: "browser", methods: ["GET", "POST", "PATCH"], roles: WORKSPACE_ADMIN },
  "meta-launches": {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_marketing", POST: "manage_marketing", PATCH: "manage_marketing" },
  },
  "ad-creatives": {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "view_marketing", POST: "manage_marketing", PATCH: "manage_marketing" },
  },
};

/** Non-resource routes handled directly by the catch-all. */
export const CRM_ROUTE_AUTHORIZATION: Readonly<Record<string, RouteAuthorization>> = {
  // Identity bootstrap: any authenticated user, before a workspace is chosen.
  "auth-context": { kind: "bootstrap", methods: ["GET"] },

  // Панель владельца платформы: единственный маршрут, читающий поперёк клиник.
  //
  // Ни roles, ни permissions здесь нет намеренно — и то и другое разрешается из
  // членства в одном рабочем пространстве, а у этого запроса рабочего
  // пространства нет. Пропуск даёт список идентификаторов в переменной
  // окружения (см. lib/auth/platform.ts). Список пуст — маршрут отвечает 404.
  // Клиника читает СВОЮ подписку: тариф, цену и период. Только чтение и только
  // администратор рабочего пространства — цена это коммерческое условие, а не
  // операционные данные, и регистратору она не нужна.
  //
  // Отдельно от platform-subscriptions: тот читает поперёк клиник и закрыт
  // списком владельцев платформы. Здесь арендатор берётся из проверенного
  // контекста, как у любого другого браузерного маршрута.
  subscription: { kind: "browser", methods: ["GET"], roles: WORKSPACE_ADMIN },

  "platform-overview": { kind: "platform", methods: ["GET"] },
  "platform-subscriptions": { kind: "platform", methods: ["GET", "POST", "PATCH"] },
  // Карточка одной клиники: активность по неделям, статус модулей, сигналы.
  // Только чтение и только счётчики — ни одной строки пациента наружу.
  "platform-clinic": { kind: "platform", methods: ["GET"] },
  // Подключение клиники: пространство + настройки + приглашение владельца.
  "platform-onboarding": { kind: "platform", methods: ["POST"] },
  // Советы платформы клиникам: платформа пишет и читает все, клиника — только
  // свои и только статусы. Единственная запись платформы в сторону клиник.
  "platform-recommendations": { kind: "platform", methods: ["GET", "POST"] },
  // Управляющий в списке намеренно: советы касаются прайса, графика и рекламы,
  // а это его ежедневная работа — совет без права его выполнить бесполезен.
  recommendations: { kind: "browser", methods: ["GET", "PATCH"], roles: ["owner", "admin", "manager"] },

  // Diagnostics were previously unauthenticated and enumerated which secrets are
  // configured. They are now administrator-only and the payload is coarse.
  health: { kind: "browser", methods: ["GET"], roles: WORKSPACE_ADMIN },
  "storage-health": { kind: "browser", methods: ["GET"], roles: WORKSPACE_ADMIN },

  // Staff enrollment. The invitation is the verified path the disabled staff
  // POST has been pointing at: an administrator names an email and a role here,
  // and the person who proves control of that address becomes the member.
  "staff-invitations": {
    kind: "browser",
    methods: ["GET", "POST", "PATCH"],
    permissions: { GET: "manage_staff", POST: "manage_staff", PATCH: "manage_staff" },
  },

  // Advertising actions touch the live Meta account.
  "meta-launch": { kind: "browser", methods: ["POST"], permissions: { POST: "manage_marketing" } },
  "meta-status": { kind: "browser", methods: ["GET"], permissions: { GET: "view_marketing" } },
  "meta-validate": { kind: "browser", methods: ["GET", "POST"], permissions: { GET: "view_marketing", POST: "manage_marketing" } },
  "meta-city-key": { kind: "browser", methods: ["GET", "POST"], permissions: { GET: "view_marketing", POST: "view_marketing" } },
  "ads-ai-fill": { kind: "browser", methods: ["POST"], permissions: { POST: "manage_marketing" } },
  "ad-creative-upload": { kind: "browser", methods: ["POST"], permissions: { POST: "manage_marketing" } },
  "ad-creative-meta-upload": { kind: "browser", methods: ["POST"], permissions: { POST: "manage_marketing" } },

  // Creative and video pipeline.
  "video-jobs": { kind: "browser", methods: ["GET", "POST", "PATCH"], permissions: { GET: "view_ai_content", POST: "manage_ai_content", PATCH: "manage_ai_content" } },
  "video-processing-jobs": { kind: "browser", methods: ["GET", "POST", "PATCH"], permissions: { GET: "view_ai_content", POST: "manage_ai_content", PATCH: "manage_ai_content" } },

  // Meta Insights kept at the Security-1B level: workspace administrators only.
  "meta-insights-sync": { kind: "browser", methods: ["POST"], roles: WORKSPACE_ADMIN },
  "meta-campaign-insights": { kind: "browser", methods: ["GET"], roles: WORKSPACE_ADMIN },
  "meta-insights-history": { kind: "browser", methods: ["GET"], roles: WORKSPACE_ADMIN },
  "meta-insights-sync-runs": { kind: "browser", methods: ["GET"], roles: WORKSPACE_ADMIN },

  // The clinic's own WhatsApp connection: which channels feed its inbound
  // pipeline, how much they have filed, and the switch that stops one. It
  // touches the tenancy tables the webhooks trust, so it stays at the
  // administrator level like every other configuration resource.
  "whatsapp-channels": { kind: "browser", methods: ["GET", "PATCH"], roles: WORKSPACE_ADMIN },

  // One record's history. Registered at membership level on purpose: the
  // permission that matters depends on which entity is being asked about, and
  // a single key here would either lock a receptionist out of the lead history
  // they work with all day, or hand a marketer the client history they must
  // not see. The handler resolves the right one from entityType and refuses
  // with 403 — see lib/crm/change-log.ts.
  "change-log": { kind: "browser", methods: ["GET"] },

  // Worker route: HMAC only. A browser JWT must never satisfy it.
  "meta-insights-background-cycle": { kind: "internal_hmac", methods: ["POST"] },
};

/** Sub-path routes, matched as `<resource>/<segment>`. */
export const CRM_SUBROUTE_AUTHORIZATION: Readonly<Record<string, RouteAuthorization>> = {
  // Redeeming an invitation is a bootstrap: the caller is authenticated but has
  // no membership yet, which is exactly what the request is asking to create.
  "staff-invitations/accept": {
    kind: "bootstrap",
    methods: ["POST"],
  },
  "ad-creatives/signed-upload": {
    kind: "browser",
    methods: ["POST"],
    permissions: { POST: "manage_marketing" },
  },
};

export type ResolvedRoute = {
  key: string;
  authorization: RouteAuthorization;
  /** Set when the route is one of the generic CRM resources. */
  resource?: string;
};

/**
 * Resolves a route from already-normalised path segments. Returns null for any
 * path that is not explicitly registered, which the router turns into a 404.
 */
export function resolveCrmRoute(segments: readonly string[]): ResolvedRoute | null {
  const first = segments[0] ?? "";
  if (!first) return null;

  // Поиск строго по СОБСТВЕННЫМ ключам реестра.
  //
  // Обычное обращение по индексу находит и ключи прототипа: `constructor`,
  // `toString`, `valueOf`. Сегмент «constructor» проходит нормализацию — он в
  // нижнем регистре и состоит из латиницы, — и реестр возвращал функцию
  // Object вместо null. Дальше роутер читал у неё `methods`, получал undefined
  // и падал с TypeError ВНЕ блока try: наружу уходил 500 вместо 404.
  //
  // Шапка этого файла обещает «всё, чего нет в списке, неизвестно и запрещено».
  // Пока поиск шёл по цепочке прототипов, обещание не выполнялось.
  const own = <T,>(registry: Readonly<Record<string, T>>, key: string): T | undefined =>
    Object.prototype.hasOwnProperty.call(registry, key) ? registry[key] : undefined;

  if (segments.length >= 2) {
    const subKey = `${first}/${segments[1]}`;
    const sub = own(CRM_SUBROUTE_AUTHORIZATION, subKey);
    if (sub) return { key: subKey, authorization: sub };
  }

  const direct = own(CRM_ROUTE_AUTHORIZATION, first);
  if (direct) return { key: first, authorization: direct };

  const resource = own(CRM_RESOURCE_AUTHORIZATION, first);
  if (resource) return { key: first, authorization: resource, resource: first };

  return null;
}

/**
 * Path normalisation used before route resolution. Rejects anything that could
 * be used to slip past the registry: encoded separators, traversal, empty or
 * whitespace-only segments and unexpected casing.
 */
export function normalizeCrmSegments(rawSegments: readonly string[]): string[] | null {
  const normalized: string[] = [];
  for (const raw of rawSegments) {
    if (typeof raw !== "string") return null;
    const segment = raw.trim();
    if (!segment) continue;
    // A decoded slash or backslash would let "leads%2Fx" masquerade as a
    // sub-route, and traversal must never reach the registry.
    if (segment.includes("/") || segment.includes("\\") || segment === "." || segment === "..") {
      return null;
    }
    if (!/^[a-z0-9-]+$/i.test(segment)) return null;
    normalized.push(segment.toLowerCase());
  }
  return normalized.length > 0 ? normalized : null;
}
