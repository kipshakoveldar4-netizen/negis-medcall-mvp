import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase, sessionAuth, hasSupabaseFrontendEnv } from '@/lib/supabase';
import { StaleAuthIntentError, type AuthStamp } from '@/lib/authSessionAuthority';
import { DEFAULT_VERTICAL, readVertical, type Vertical } from '../../../../lib/vertical/terms';
import { isWorkspacePurpose, type WorkspacePurpose } from '../../../../lib/crm/workspace-purpose';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { apiUrl, clearCrmCache, crmFetch, CrmApiError } from '@/lib/api';
import { getSupabaseAccessToken } from '@/lib/serverAuth';
import { isSignOutPending, getSignOutRevision, markSignOutPending, clearSignOutPending } from '@/lib/authSignOut';
import { bindWorkspaceReadScope, clearWorkspaceReadScope, clearListReadCache, WORKSPACE_SELECTOR_KEY } from '@/lib/demoStorage';
import { isStaffRole, permissionsForRole, type StaffRole } from '@/lib/permissions';

/* ── Types ────────────────────────────────────────────────── */
interface ImpersonationData {
  active: boolean;
  clinic_id: string;
  clinic_name: string;
  owner_email: string;
  issued_by: string;
  auth_user_id?: string;
}

type StartupLifetime = {
  active: boolean; provider: object; controller: AbortController; stamp: AuthStamp;
  signOutRevision: number; transitioning: boolean; phase: 'bootstrap' | 'verify' | 'exchange' | 'finished';
  path: string;
  exchangeEmail?: string;
};

interface DemoWorkspaceData {
  id: string;
  name: string;
}

interface DemoUserData {
  id?: string;
  name?: string;
  email?: string;
}

interface DemoSessionData {
  mode: 'demo';
  authenticated: boolean;
  createdAt: string;
}

interface DemoAuthData {
  user: DemoUserData;
  workspace: DemoWorkspaceData;
  session: DemoSessionData;
}

interface StaffUserData {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
  status?: string;
  workspaceId?: string;
  workspace_id?: string;
  authUserId?: string;
  auth_user_id?: string;
}

interface StaffSessionData {
  mode: 'staff';
  authenticated: boolean;
  createdAt: string;
  email: string;
  workspaceId?: string;
  supabaseUserId?: string;
}

interface StaffAuthData {
  user: StaffUserData;
  session: StaffSessionData;
}

export type UserRole = StaffRole | 'agent' | 'booking_agent';
export type RolePermissions = Record<string, boolean>;

interface AuthContextType {
  session: Session | null;
  user: User | null;
  clinicId: string | null;
  userRole: UserRole | null;
  rolePermissions: RolePermissions;
  isLoading: boolean;
  isSigningOut: boolean;
  signOutFailed: boolean;
  isImpersonation: boolean;
  isDemoMode: boolean;
  isStaffMode: boolean;
  /** Ниша рабочего пространства: она решает подписи и правила рекламы. */
  vertical: Vertical;
  workspacePurpose: WorkspacePurpose | null;
  impersonationClinicName: string | null;
  /**
   * Selection-1: every workspace the server listed for this user. The server
   * has said `requiresWorkspaceSelection` since Security-2B; this is the list
   * the choice is made from, and it is never wider than the memberships the
   * server verified.
   */
  availableWorkspaces: WorkspaceChoice[];
  workspaceSelectionFailed: boolean;
  /** Applies one of `availableWorkspaces`. Anything else is refused. */
  selectWorkspace: (workspaceId: string) => void;
  /** Fresh owner membership is required; a previous selector is never a fallback. */
  enterWorkspace: (workspaceId: string, options: { expectedUserId: string; signal: AbortSignal; isCurrent(): boolean;
    confirm?(): Promise<void> }) => Promise<boolean>;
  /** Drops the current choice and returns the user to the picker. */
  clearWorkspaceSelection: () => void;
  /** Apply only the confirmed display name; never replace an SDK session. */
  applyConfirmedProfile: (confirmed: Pick<User, 'id' | 'user_metadata'>, isCurrent: () => boolean) => void;
  signOut: () => Promise<void>;
}

export type WorkspaceChoice = { id: string; name: string; role: string; vertical: Vertical; purpose: WorkspacePurpose };

/* ── Constants ────────────────────────────────────────────── */
const IMP_KEY     = 'negis_impersonation';
const DEMO_USER_KEY = 'negis_demo_user';
const DEMO_WORKSPACE_KEY = 'negis_demo_workspace';
const DEMO_SESSION_KEY = 'negis_demo_session';
const STAFF_USER_KEY = 'negis_staff_user';
const STAFF_SESSION_KEY = 'negis_staff_session';

const ALL_PERMISSIONS: RolePermissions = {
  dashboard: true,
  booking: true,
  reception: true,
  crm: true,
  tasks: true,
  chat: true,
  marketplace: true,
  admin: true,
  // Справочник исполнителей и график. Ключа здесь не было, а маршрут
  // /staff-schedule спрашивает именно его — и роль admin (директор) получала
  // отказ на странице, ссылка на которую стоит у неё в меню. Не заметили
  // потому, что владелец и управляющий проходят гейт по роли, минуя таблицу,
  // а директор — единственный, кто ходит через неё.
  //
  // Ключ пропал молча: RolePermissions — это Record<string, boolean>, и
  // отсутствующий ключ для типов неотличим от false.
  directory: true,
  reports: true,
  ads: true,
  settings: true,
};

const SYSTEM_ROLE_PERMISSIONS: Partial<Record<UserRole, RolePermissions>> = {
  owner: ALL_PERMISSIONS,
  manager: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  marketer: { dashboard: true, marketplace: true, ads: true, reports: true, tasks: true, chat: true },
  // crm СНЯТО. Право открывало /clients, /leads и /sales — три экрана со
  // списками клиентов клиники целиком, при том что серверные маршруты роли
  // отвечают 403, а правило «мастер видит только свою работу» им противоречит.
  // Таблица сейчас не используется — и именно поэтому строку легко было бы
  // однажды подключить, не заметив, что она открывает.
  doctor: { dashboard: true, booking: true, crm: false, chat: true, tasks: true },
  agent: { dashboard: true, booking: true, crm: true, tasks: true, chat: true },
  booking_agent: { dashboard: true, booking: true, chat: true },
  receptionist: { dashboard: true, booking: true, reception: true, crm: true, chat: true },
};

function clearDemoStorage() {
  localStorage.removeItem(DEMO_USER_KEY);
  localStorage.removeItem(DEMO_WORKSPACE_KEY);
  localStorage.removeItem(DEMO_SESSION_KEY);
  localStorage.removeItem('negis_clinic_id');
  localStorage.removeItem('negis_session');
}

function clearStaffStorage() {
  localStorage.removeItem(STAFF_USER_KEY);
  localStorage.removeItem(STAFF_SESSION_KEY);
}

function clearImpersonationStorage() {
  localStorage.removeItem(IMP_KEY);
}

function clearAuthStorage() {
  clearImpersonationStorage();
  clearDemoStorage();
  clearStaffStorage();
}

function cleanUrl() {
  window.history.replaceState(
    {}, document.title,
    window.location.origin + window.location.pathname,
  );
}

function loadStoredImpersonation(): ImpersonationData | null {
  try {
    const raw = localStorage.getItem(IMP_KEY);
    if (!raw) return null;
    const d: unknown = JSON.parse(raw);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const value = d as Record<string, unknown>;
    return value.active === true && ['clinic_id', 'owner_email', 'auth_user_id'].every(key => typeof value[key] === 'string' && value[key].trim())
      && typeof value.clinic_name === 'string' && typeof value.issued_by === 'string' ? value as unknown as ImpersonationData : null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function loadStoredDemoAuth(): DemoAuthData | null {
  const session = readJson<DemoSessionData>(DEMO_SESSION_KEY);
  const workspace = readJson<DemoWorkspaceData>(DEMO_WORKSPACE_KEY);
  const user = readJson<DemoUserData>(DEMO_USER_KEY) ?? {};

  if (session?.mode !== 'demo' || session.authenticated !== true || !workspace?.id) {
    return null;
  }

  return { session, workspace, user };
}

function loadStoredStaffAuth(): StaffAuthData | null {
  if (hasSupabaseFrontendEnv) return null;
  const session = readJson<StaffSessionData>(STAFF_SESSION_KEY);
  const user = readJson<StaffUserData>(STAFF_USER_KEY);

  if (session?.mode !== 'staff' || session.authenticated !== true || !user?.email) {
    return null;
  }

  return { session, user };
}

function routePermissionsForStaffRole(role: StaffRole): RolePermissions {
  if (role === 'owner' || role === 'admin') return ALL_PERMISSIONS;
  if (role === 'lead_manager') return {
    dashboard: false,
    booking: false,
    reception: false,
    crm: true,
    tasks: false,
    chat: false,
    marketplace: false,
    admin: false,
    directory: false,
    reports: false,
    ads: false,
    settings: false,
  };

  const crmPermissions = new Set(permissionsForRole(role));

  return {
    dashboard: true,
    booking: crmPermissions.has('view_appointments') || crmPermissions.has('manage_appointments'),
    reception: role === 'receptionist' || crmPermissions.has('view_calls') || crmPermissions.has('manage_calls'),
    crm: crmPermissions.has('view_clients') || crmPermissions.has('manage_clients') || crmPermissions.has('view_leads') || crmPermissions.has('manage_leads'),
    tasks: crmPermissions.has('view_tasks') || crmPermissions.has('manage_tasks'),
    chat: crmPermissions.has('view_chat') || crmPermissions.has('send_chat'),
    marketplace: crmPermissions.has('view_marketing') || crmPermissions.has('manage_marketing'),
    admin: crmPermissions.has('view_admin') || crmPermissions.has('manage_staff'),
    // Справочники — отдельный маршрут, а не вкладка админ-центра: администратор
    // салона правит прайс и смены, но ключи интеграций и список сотрудников ему
    // по-прежнему закрыты.
    directory: crmPermissions.has('manage_directory'),
    reports: crmPermissions.has('view_reports'),
    ads:
      crmPermissions.has('view_marketing') ||
      crmPermissions.has('manage_marketing') ||
      crmPermissions.has('view_ai_content') ||
      crmPermissions.has('manage_ai_content') ||
      crmPermissions.has('view_targeting') ||
      crmPermissions.has('manage_targeting') ||
      crmPermissions.has('view_reports'),
    settings: role === 'manager',
  };
}

function normalizeStaffUser(value: unknown): StaffUserData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const email = typeof record.email === 'string' ? record.email.trim() : '';
  if (!email) return null;

  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
    email,
    role: typeof record.role === 'string' ? record.role : undefined,
    status: typeof record.status === 'string' ? record.status : undefined,
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : undefined,
    workspace_id: typeof record.workspace_id === 'string' ? record.workspace_id : undefined,
    authUserId: typeof record.authUserId === 'string' ? record.authUserId : undefined,
    auth_user_id: typeof record.auth_user_id === 'string' ? record.auth_user_id : undefined,
  };
}

/* ── Context ──────────────────────────────────────────────── */
const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session,                 setSession]                 = useState<Session | null>(null);
  const [user,                    setUser]                    = useState<User | null>(null);
  const [clinicId,                setClinicId]                = useState<string | null>(null);
  const [userRole,                setUserRole]                = useState<UserRole | null>(null);
  const [vertical,                setVertical]                = useState<Vertical>(DEFAULT_VERTICAL);
  const [workspacePurpose, setWorkspacePurpose] = useState<WorkspacePurpose | null>(null);
  const [rolePermissions,         setRolePermissions]         = useState<RolePermissions>({});
  const [isLoading,               setIsLoading]               = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(isSignOutPending);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [isImpersonation,         setIsImpersonation]         = useState(false);
  const [isDemoMode,              setIsDemoMode]              = useState(false);
  const [isStaffMode,             setIsStaffMode]             = useState(false);
  const [impersonationClinicName, setImpersonationClinicName] = useState<string | null>(null);
  // Memberships the server confirmed for this user; drives explicit workspace choice.
  const [availableWorkspaces, setAvailableWorkspaces] = useState<WorkspaceChoice[]>([]);
  const [workspaceSelectionFailed, setWorkspaceSelectionFailed] = useState(false);
  // The picker runs long after the bootstrap resolved, so the memberships and
  // the verified user are kept in refs: reading them from state inside the
  // callback would capture whatever the closure saw when it was created.
  const membershipsRef = useRef<AuthContextMembership[]>([]);
  const userRef = useRef<User | null>(null);
  const authRevisionRef = useRef(0);
  const authSignOutRevisionRef = useRef(getSignOutRevision());
  const authIdentityRef = useRef<string | null>(null);
  const profileSubjectRevisionRef = useRef(0);
  const profileSubjectRevision = profileSubjectRevisionRef.current;
  const workspaceSelectionRevisionRef = useRef(0);
  const workspaceReadOwner = useRef({}).current;
  const workspaceIntentRef = useRef<{ actorId: string; workspaceId: string | null; blocked: boolean } | null>(null);
  const mountedRef = useRef(true);
  const providerLifetimeRef = useRef<object | null>(null);
  const startupRef = useRef<StartupLifetime | null>(null);
  const sdkSetupRevisionRef = useRef(0);
  const signOutRequestRef = useRef<Promise<void> | null>(null);
  const profileContextRef = useRef({ userId: user?.id, sessionUserId: session?.user.id,
    isImpersonation, isDemoMode, isSigningOut });
  profileContextRef.current = { userId: user?.id, sessionUserId: session?.user.id,
    isImpersonation, isDemoMode, isSigningOut };
  useEffect(() => {
    userRef.current = user;
  }, [user]);
  const [, setLocation] = useLocation();

  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);

  useLayoutEffect(() => {
    const provider = {};
    providerLifetimeRef.current = provider;
    signOutRequestRef.current = null;
    mountedRef.current = true;
    beginAuthResolution(null);
    setSession(null); setUser(null); setIsLoading(true);
    bindWorkspaceReadScope(workspaceReadOwner, null);
    let startup: StartupLifetime | null = null;
    try {
      startup = { active: true, provider, controller: new AbortController(), stamp: sessionAuth.capture(),
        signOutRevision: getSignOutRevision(), transitioning: false, phase: 'bootstrap', path: window.location.pathname };
      startupRef.current = startup;
      void initAuth(startup);
    } catch {
      setIsLoading(false);
      toast.error('Не удалось проверить вход. Обновите страницу.');
    }
    return () => {
      mountedRef.current = false;
      providerLifetimeRef.current = null;
      if (startup) { startup.active = false; startup.controller.abort(); }
      if (startupRef.current === startup) startupRef.current = null;
      authRevisionRef.current += 1;
      clearWorkspaceReadScope(workspaceReadOwner);
      subscriptionRef.current?.unsubscribe();
    };
  }, []);

  /* ── Helpers ──────────────────────────────────────────── */

  const isCurrentAuthResolution = (userId: string, revision: number) =>
    mountedRef.current && !isSignOutPending()
    && authSignOutRevisionRef.current === getSignOutRevision()
    && authIdentityRef.current === userId && authRevisionRef.current === revision;

  const applyConfirmedProfile: AuthContextType['applyConfirmedProfile'] = (confirmed, callerIsCurrent) => {
    const subject = user?.id;
    const revision = authRevisionRef.current;
    const fullName = confirmed.user_metadata?.full_name;
    const canApply = () => {
      const context = profileContextRef.current;
      return typeof subject === 'string' && Boolean(subject) && confirmed.id === subject && typeof fullName === 'string'
        && profileSubjectRevisionRef.current === profileSubjectRevision
        && isCurrentAuthResolution(subject, revision) && userRef.current?.id === subject
        && context.userId === subject && context.sessionUserId === subject
        && !context.isImpersonation && !context.isDemoMode && !context.isSigningOut
        && !loadStoredDemoAuth() && callerIsCurrent();
    };
    if (!canApply()) return;
    setUser(previous => {
      // React may process or replay this update after an account/epoch change.
      if (!previous || !canApply() || previous.id !== subject) return previous;
      return { ...previous, user_metadata: { ...previous.user_metadata, full_name: fullName } };
    });
  };

  const applyResolvedUser = (resolved: User) => {
    const revision = authRevisionRef.current;
    setUser(previous => {
      if (!isCurrentAuthResolution(resolved.id, revision)) return previous;
      // A membership read carries the SDK user from when it started. A local
      // confirmed name may have committed since, without changing that session.
      const fullName = previous?.id === resolved.id ? previous.user_metadata?.full_name : undefined;
      return typeof fullName === 'string' && previous !== resolved
        ? { ...resolved, user_metadata: { ...resolved.user_metadata, full_name: fullName } }
        : resolved;
    });
  };

  const beginAuthResolution = (nextUser: User | null) => {
    const nextId = nextUser?.id ?? null;
    const changed = authIdentityRef.current !== nextId;
    authIdentityRef.current = nextId;
    authSignOutRevisionRef.current = getSignOutRevision();
    userRef.current = nextUser;
    const revision = ++authRevisionRef.current;
    if (changed || !nextUser) {
      setWorkspaceSelectionFailed(false);
      workspaceIntentRef.current = null;
      bindWorkspaceReadScope(workspaceReadOwner, null);
      profileSubjectRevisionRef.current++;
      clearCrmCache();
      clearListReadCache();
      membershipsRef.current = [];
      setAvailableWorkspaces([]);
      setClinicId(null);
      setUserRole(null);
      setRolePermissions({});
      setVertical(DEFAULT_VERTICAL);
      setWorkspacePurpose(null);
      setIsStaffMode(false);
      setIsDemoMode(false);
      setIsImpersonation(false);
      setImpersonationClinicName(null);
      setIsLoading(Boolean(nextUser));
    }
    return revision;
  };

  const applyDemoWorkspaceState = (d: DemoAuthData) => {
    bindWorkspaceReadScope(workspaceReadOwner, d.workspace.id);
    const demoUser = {
      id: d.user.id || 'demo-user',
      email: d.user.email || '',
      user_metadata: { full_name: d.user.name || d.workspace.name },
      app_metadata: {},
      aud: 'authenticated',
      created_at: d.session.createdAt,
    } as User;

    setIsDemoMode(true);
    setIsImpersonation(false);
    setIsStaffMode(false);
    setClinicId(d.workspace.id);
    setImpersonationClinicName(null);
    setUserRole('owner');
    setRolePermissions(ALL_PERMISSIONS);
    setVertical(DEFAULT_VERTICAL);
    setWorkspacePurpose('clinic_services');
    setSession(null);
    setUser(demoUser);
  };

  const applyStaffWorkspaceState = (d: StaffAuthData, supabaseUser?: User | null) => {
    const role = isStaffRole(d.user.role) ? d.user.role : 'receptionist';
    const workspaceId = d.user.workspaceId || d.user.workspace_id || d.session.workspaceId || 'demo-workspace';
    bindWorkspaceReadScope(workspaceReadOwner, workspaceId);
    const staffUser = supabaseUser ?? ({
      id: d.user.authUserId || d.user.auth_user_id || d.user.id || 'staff-user',
      email: d.user.email || d.session.email,
      user_metadata: { full_name: d.user.name || d.user.email || 'Staff user', role },
      app_metadata: {},
      aud: 'authenticated',
      created_at: d.session.createdAt,
    } as User);

    setIsDemoMode(false);
    setIsImpersonation(false);
    setIsStaffMode(true);
    setClinicId(workspaceId);
    setImpersonationClinicName(null);
    setUserRole(role);
    setRolePermissions(routePermissionsForStaffRole(role));
    setVertical(DEFAULT_VERTICAL);
    setWorkspacePurpose('clinic_services');
    setUser(staffUser);
  };

  // Security-2B: identity comes from the verified session, not from an email
  // lookup. GET /api/crm/auth-context returns only this user's active
  // memberships with server-computed permissions; the browser never decides its
  // own role and never asks the server about another address.

  type AuthContextMembership = {
    staffUserId: string;
    workspaceId: string;
    workspaceName: string;
    role: string;
    permissions: string[];
    vertical: Vertical;
    purpose: WorkspacePurpose;
  };

  const fetchAuthContext = async (userId: string, revision: number, scope?: { signal: AbortSignal; isCurrent(): boolean }): Promise<{
    memberships: AuthContextMembership[];
    status: number;
    sessionChanged?: boolean;
  }> => {
    const changedSession = { memberships: [], status: 0, sessionChanged: true };
    let accessToken = '';
    const isCurrentRequest = () => isCurrentAuthResolution(userId, revision)
      && (!scope || (!scope.signal.aborted && scope.isCurrent()));
    const hasCurrentToken = async () => {
      if (!accessToken || !isCurrentRequest()) return false;
      try {
        const currentToken = await getSupabaseAccessToken(userId);
        return currentToken === accessToken && isCurrentRequest();
      } catch {
        return false;
      }
    };
    try {
      accessToken = await getSupabaseAccessToken(userId);
      if (!isCurrentRequest() || !accessToken) return changedSession;

      const response = await crmFetch('/api/crm/auth-context', {
        accessToken, expectedUserId: userId, dispatchGuard: isCurrentRequest,
        ...(scope ? { signal: scope.signal, cache: 'no-store' as const } : {}),
      });
      const text = response.ok ? await response.text() : '';
      // The SDK can replace its session before this tab receives its auth event.
      if (!await hasCurrentToken()) return changedSession;
      if (!response.ok) return { memberships: [], status: response.status };

      const body = text ? (JSON.parse(text) as { success?: boolean; data?: Record<string, unknown> }) : null;
      if (body?.success !== true || !body.data || !Array.isArray(body.data.memberships)) {
        return { memberships: [], status: 422 };
      }

      const raw = body.data.memberships;
      if (raw.some((entry) => !entry || typeof entry !== 'object'
        || typeof (entry as Record<string, unknown>).workspaceId !== 'string'
        || !(entry as { workspaceId: string }).workspaceId.trim()
        || !isStaffRole((entry as Record<string, unknown>).role)
        || !isWorkspacePurpose((entry as Record<string, unknown>).purpose))) {
        return { memberships: [], status: 422 };
      }
      const memberships = raw
        .map((entry) => entry as Record<string, unknown>)
        .map((entry) => ({
          staffUserId: String(entry.staffUserId || ''),
          workspaceId: String(entry.workspaceId),
          workspaceName: String(entry.workspaceName || ''),
          role: String(entry.role),
          permissions: Array.isArray(entry.permissions) ? entry.permissions.map(String) : [],
          // Ниша приезжает вместе с членством: словарь подписей выбирается до
          // первого запроса данных, а переключение клиники меняет его сразу.
          // Неизвестное значение — клиника: readVertical сам падает в умолчание.
          vertical: readVertical(entry.vertical),
          purpose: entry.purpose as WorkspacePurpose,
        }));

      return { memberships, status: response.status };
    } catch {
      return await hasCurrentToken() ? { memberships: [], status: 0 } : changedSession;
    }
  };

  const toWorkspaceChoices = (memberships: AuthContextMembership[]): WorkspaceChoice[] =>
    memberships.map((entry) => ({
      id: entry.workspaceId,
      name: entry.workspaceName,
      role: entry.role,
      // Ниша нужна прямо здесь: в списке клиник у одной роли разные подписи —
      // «Врач» в клинике и «Мастер» в салоне.
      vertical: entry.vertical,
      purpose: entry.purpose,
    }));

  const rememberSelector = (workspaceId: string | null) => {
    try {
      if (workspaceId) localStorage.setItem(WORKSPACE_SELECTOR_KEY, workspaceId);
      else localStorage.removeItem(WORKSPACE_SELECTOR_KEY);
    } catch {
      /* selector is best-effort only */
    }
  };

  const applyMembership = (
    supabaseUser: User,
    selected: AuthContextMembership,
    memberships: AuthContextMembership[],
  ) => {
    rememberSelector(selected.workspaceId);
    bindWorkspaceReadScope(workspaceReadOwner, selected.workspaceId);

    const role = isStaffRole(selected.role) ? selected.role : 'receptionist';
    setIsDemoMode(false);
    setIsImpersonation(false);
    setIsStaffMode(true);
    setClinicId(selected.workspaceId);
    setImpersonationClinicName(null);
    setUserRole(role);
    setVertical(selected.vertical);
    setWorkspacePurpose(selected.purpose);
    setRolePermissions(routePermissionsForStaffRole(role));
    applyResolvedUser(supabaseUser);
    setAvailableWorkspaces(toWorkspaceChoices(memberships));
  };

  const tryApplySupabaseStaffUser = async (supabaseUser: User, revision: number): Promise<boolean> => {
    const { memberships, status, sessionChanged } = await fetchAuthContext(supabaseUser.id, revision);
    if (!isCurrentAuthResolution(supabaseUser.id, revision)) return true;

    // «Прочитать не удалось» — не то же самое, что «членств нет». Разница стала
    // видна, когда смену пароля вынесли в кабинет: updateUser поднимает
    // USER_UPDATED, подписчик тут же перечитывает контекст, и одного моргнувшего
    // Wi-Fi хватало, чтобы обнулить роль и права и объявить человеку «Аккаунт не
    // привязан к клинике» — сразу после того, как его пароль успешно сменился.
    const readFailed = !sessionChanged && memberships.length === 0 && (status === 0 || status === 429 || status >= 500);
    if (readFailed) {
      toast.error(
        membershipsRef.current.length > 0
          ? 'Сервис авторизации не ответил — обновите страницу, доступ не изменился.'
          : 'Сервис авторизации не ответил. Обновите страницу или войдите ещё раз.',
      );
      // Права и выбранная клиника остаются как были: неудачное чтение никого не
      // повышает и никого не должно понижать.
      return true;
    }

    if (sessionChanged || status >= 400 || JSON.stringify(membershipsRef.current) !== JSON.stringify(memberships)) {
      clearCrmCache();
      clearListReadCache();
    }
    membershipsRef.current = memberships;
    const intent = workspaceIntentRef.current?.actorId === supabaseUser.id ? workspaceIntentRef.current : null;
    const hint = loadStoredImpersonation();
    const impersonationTarget = hint?.auth_user_id === supabaseUser.id
      && hint.owner_email?.trim().toLowerCase() === supabaseUser.email?.trim().toLowerCase()
      ? memberships.find(entry => entry.workspaceId === hint.clinic_id && entry.role === 'owner') ?? null : null;
    if (intent?.blocked) {
      setAvailableWorkspaces(toWorkspaceChoices(memberships));
      rememberSelector(null);
      applyNoWorkspaceAccess(false);
      return true;
    }
    if (memberships.length === 0) {
      setAvailableWorkspaces([]);
      rememberSelector(null);
      if (sessionChanged || status === 401 || status === 403) {
        applyNoWorkspaceAccess(false);
        if (!sessionChanged) {
          toast.error(status === 401 ? 'Сессия истекла. Войдите снова.' : 'Недостаточно прав для этого действия.');
        }
        return true;
      }
      if (status >= 400) {
        applyNoWorkspaceAccess(false);
        toast.error('Не удалось подтвердить профиль рабочего пространства. Обновите страницу или обратитесь в поддержку.');
        return true;
      }
      return false;
    }

    // A stored selector is a UX convenience only: it is discarded unless the
    // server still lists it among this user's memberships.
    const storedSelector = (() => {
      try {
        return localStorage.getItem(WORKSPACE_SELECTOR_KEY) || '';
      } catch {
        return '';
      }
    })();

    const selected = impersonationTarget ?? (intent
      ? memberships.find((entry) => entry.workspaceId === intent.workspaceId) ?? null
      : memberships.find((entry) => entry.workspaceId === storedSelector) ||
      (memberships.length === 1 ? memberships[0] : null));

    if (!selected) {
      // Several memberships and no valid stored choice: the server does not pick
      // one, and neither do we. Selection-1: the list is published so the user
      // can, which is what `requiresWorkspaceSelection` has been asking for.
      rememberSelector(null);
      applyResolvedUser(supabaseUser);
      setAvailableWorkspaces(toWorkspaceChoices(memberships));
      return false;
    }

    applyMembership(supabaseUser, selected, memberships);
    if (impersonationTarget) {
      // Stored metadata labels a freshly verified owner entry; it grants no role.
      setIsImpersonation(true);
      setImpersonationClinicName(selected.workspaceName);
    }
    return true;
  };

  /**
   * Selection-1: applies a workspace the user picked.
   *
   * The candidate has to come from the memberships the server returned for this
   * session — a workspace id from anywhere else is refused here, and would be
   * refused again by every request, since the browser has not been the tenant
   * authority since Security-2B.
   */
  const selectWorkspace = (workspaceId: string) => {
    const memberships = membershipsRef.current;
    const selected = memberships.find((entry) => entry.workspaceId === workspaceId);
    const supabaseUser = userRef.current;

    if (!mountedRef.current || isSignOutPending() || !supabaseUser || authIdentityRef.current !== supabaseUser.id
      || profileSubjectRevisionRef.current !== profileSubjectRevision) return;
    if (!selected) {
      toast.error('Клиника недоступна. Войдите заново.');
      return;
    }
    const subject = supabaseUser.id, controller = new AbortController();
    const cancel = () => controller.abort();
    const events = ['popstate', 'pushState', 'replaceState', 'hashchange'];
    for (const event of events) window.addEventListener(event, cancel);
    setWorkspaceSelectionFailed(false);
    const pending = resolveWorkspaceSelection(selected.workspaceId, { expectedUserId: subject,
      signal: controller.signal, isCurrent: () => !controller.signal.aborted }, false);
    const revision = authRevisionRef.current, selection = workspaceSelectionRevisionRef.current;
    const current = () => !controller.signal.aborted && isCurrentAuthResolution(subject, revision)
      && workspaceSelectionRevisionRef.current === selection;
    const failed = async () => {
      if (!current()) return;
      try { if (!await getSupabaseAccessToken(subject) || !current()) return; }
      catch { return; }
      setWorkspaceSelectionFailed(true);
      toast.error('Не удалось подтвердить доступ. Повторите выбор или обновите список доступов.');
    };
    void pending.then(opened => opened ? undefined : failed(), failed).finally(() => {
      for (const event of events) window.removeEventListener(event, cancel);
      controller.abort();
    });
  };

  const resolveWorkspaceSelection = async (workspaceId: string, options: Parameters<AuthContextType['enterWorkspace']>[1],
    ownerOnly: boolean): Promise<boolean> => {
    const subject = options.expectedUserId;
    const sameSubject = () => {
      try {
        const context = profileContextRef.current;
        return Boolean(subject) && !options.signal.aborted && options.isCurrent()
          && mountedRef.current && !isSignOutPending()
          && profileSubjectRevisionRef.current === profileSubjectRevision
          && authIdentityRef.current === subject && userRef.current?.id === subject
          && context.userId === subject && context.sessionUserId === subject
          && !context.isImpersonation && !context.isDemoMode && !context.isSigningOut
          && !loadStoredDemoAuth() && !loadStoredStaffAuth();
      } catch { return false; }
    };
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(workspaceId) || !sameSubject()) return false;
    const revision = ++authRevisionRef.current;
    const selection = ++workspaceSelectionRevisionRef.current;
    const previousMemberships = membershipsRef.current;
    workspaceIntentRef.current = { actorId: subject, workspaceId, blocked: true };
    const ownsRead = () => isCurrentAuthResolution(subject, revision) && workspaceSelectionRevisionRef.current === selection;
    const current = () => ownsRead() && sameSubject();
    // Clear the previous tenant before the read. A failed handoff cannot revive it.
    clearCrmCache();
    clearListReadCache();
    rememberSelector(null);
    membershipsRef.current = [];
    setAvailableWorkspaces([]);
    applyNoWorkspaceAccess(false);
    setIsLoading(true);
    try {
      if (options.confirm) {
        if (!current()) return false;
        await options.confirm();
        if (!current()) return false;
      }
      const result = await fetchAuthContext(subject, revision, { signal: options.signal, isCurrent: current });
      if (!current() || result.sessionChanged) return false;
      if (result.status === 401 || result.status === 403)
        throw new CrmApiError(result.status, 'partner_company_access_denied', 'Доступ к выбранной компании изменился.');
      if (result.status !== 200) {
        // Candidates are not authority: a transient failure may offer retry,
        // but the next choice still performs a fresh subject-bound read.
        if (!ownerOnly && (result.status === 0 || result.status === 429 || result.status >= 500)) {
          membershipsRef.current = previousMemberships;
          setAvailableWorkspaces(toWorkspaceChoices(previousMemberships));
        }
        return false;
      }
      if (!ownerOnly) {
        membershipsRef.current = result.memberships;
        setAvailableWorkspaces(toWorkspaceChoices(result.memberships));
      }
      const matches = result.memberships.filter(entry => entry.workspaceId.toLowerCase() === workspaceId.toLowerCase());
      if (matches.length !== 1 || (ownerOnly && matches[0].role !== 'owner'))
        throw new CrmApiError(403, 'partner_company_access_denied', 'Доступ к выбранной компании изменился.');
      const resolvedUser = userRef.current;
      if (!resolvedUser || !current()) return false;
      workspaceIntentRef.current = { actorId: subject, workspaceId: matches[0].workspaceId, blocked: false };
      membershipsRef.current = result.memberships;
      applyMembership(resolvedUser, matches[0], result.memberships);
      setIsLoading(false);
      setLocation(matches[0].purpose === 'mortgage_leads' ? '/dashboard' : matches[0].role === 'lead_manager' ? '/leads' : '/dashboard');
      return true;
    } catch (error) {
      if (current() && error instanceof CrmApiError) throw error;
      return false;
    }
    finally { if (ownsRead()) setIsLoading(false); }
  };

  const enterWorkspace: AuthContextType['enterWorkspace'] = (workspaceId, options) =>
    resolveWorkspaceSelection(workspaceId, options, true);

  /** Returns a multi-clinic user to the picker without ending the session. */
  const clearWorkspaceSelection = () => {
    if (!mountedRef.current || isSignOutPending() || membershipsRef.current.length < 2) return;
    workspaceSelectionRevisionRef.current++;
    workspaceIntentRef.current = userRef.current ? { actorId: userRef.current.id, workspaceId: null, blocked: true } : null;
    bindWorkspaceReadScope(workspaceReadOwner, null);
    clearCrmCache();
    rememberSelector(null);
    setClinicId(null);
    setUserRole(null);
    setRolePermissions({});
    setVertical(DEFAULT_VERTICAL);
    setWorkspacePurpose(null);
  };

  /* ── 1. Init ──────────────────────────────────────────── */
  const providerCurrent = (provider: object | null) => Boolean(provider && mountedRef.current && providerLifetimeRef.current === provider);
  const startupAlive = (scope: StartupLifetime) => providerCurrent(scope.provider) && startupRef.current === scope
    && scope.active && !scope.controller.signal.aborted && !isSignOutPending()
    && scope.signOutRevision === getSignOutRevision() && window.location.pathname === scope.path;
  const startupCurrent = (scope: StartupLifetime) => startupAlive(scope) && sessionAuth.isCurrent(scope.stamp);
  const finishAuthLoading = () => setIsLoading(Boolean(startupRef.current?.active && startupRef.current.transitioning));

  const initAuth = async (scope: StartupLifetime) => {
    if (isSignOutPending()) {
      await signOut(true);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const token  = params.get('impersonate_token');
    const testHash = params.get('test_token_hash');

    /* A) E2E test login via access/refresh tokens (URL params).
     *
     * Development only. `import.meta.env.DEV` is replaced with a literal at
     * build time, so this whole branch is eliminated from the production
     * bundle rather than merely skipped at runtime — a session established
     * from a query string would have put the tokens through the address bar,
     * the Referer header, access logs and browser history before cleanUrl()
     * could remove them. The endpoint that mints these tokens
     * (artifacts/api-server, POST /api/test/login) is not part of the Vercel
     * deployment at all; this closes the consuming half. */
    const devAccessToken  = import.meta.env.DEV ? params.get('dev_access_token') : null;
    const devRefreshToken = import.meta.env.DEV ? params.get('dev_refresh_token') : null;
    scope.transitioning = Boolean(token || (devAccessToken && devRefreshToken));
    if (token || testHash || params.has('dev_access_token') || params.has('dev_refresh_token')) cleanUrl();
    const deadline = scope.transitioning ? setTimeout(() => {
      if (startupRef.current !== scope || !providerCurrent(scope.provider)) return;
      scope.active = false; scope.transitioning = false; scope.controller.abort(); startupRef.current = null;
      if (!isSignOutPending()) {
        toast.error('Проверка входа не завершилась. Повторите вход из панели управления.');
        void setupSupabaseAuth(scope.provider);
      }
    }, 30_000) : undefined;
    try {
      if (!scope.transitioning) {
        const staffAuth = loadStoredStaffAuth();
        if (staffAuth) { applyStaffWorkspaceState(staffAuth); setIsLoading(false); return; }
        const demoAuth = loadStoredDemoAuth();
        if (demoAuth) { applyDemoWorkspaceState(demoAuth); setIsLoading(false); return; }
      }
      await setupSupabaseAuth(scope.provider);
      if (!startupCurrent(scope)) return;
      scope.phase = 'verify';
      if (devAccessToken && devRefreshToken) {
        let receipt: AuthStamp | null = null;
        const { error } = await sessionAuth.setSession({ access_token: devAccessToken, refresh_token: devRefreshToken }, {
          expected: scope.stamp, isCurrent: () => startupAlive(scope), signal: scope.controller.signal,
          onReceipt: value => { receipt = value; },
        });
        if (!providerCurrent(scope.provider) || startupRef.current !== scope || !receipt || !sessionAuth.isCurrent(receipt)) return;
        scope.stamp = receipt;
        if (error) toast.error('Тестовый вход не удался. Повторите вход.');
      } else if (token) await handleImpersonationToken(token, scope);
    } catch {
      if (startupCurrent(scope)) toast.error('Не удалось проверить вход. Повторите попытку.');
    } finally {
      clearTimeout(deadline);
      if (startupRef.current === scope) {
        const transitioning = scope.transitioning;
        scope.active = false; scope.transitioning = false; scope.phase = 'finished'; scope.controller.abort();
        startupRef.current = null;
        if (transitioning && providerCurrent(scope.provider) && !isSignOutPending()) await setupSupabaseAuth(scope.provider);
      }
    }
  };

  /* ── 2. Supabase subscription setup ───────────────────── */
  const setupSupabaseAuth = async (provider = providerLifetimeRef.current) => {
    if (!providerCurrent(provider)) return;
    const setupRevision = ++sdkSetupRevisionRef.current;
    authRevisionRef.current++;
    /* Set up the persistent listener FIRST so we don't miss events */
    subscriptionRef.current?.unsubscribe();
    const { data: { subscription } } = sessionAuth.onAuthStateChange((_event, sess) => {
      if (!providerCurrent(provider) || setupRevision !== sdkSetupRevisionRef.current || isSignOutPending()) return;
      const startup = startupRef.current;
      if (_event === 'TOKEN_REFRESHED' && startup?.phase === 'bootstrap') {
        const stamp = sessionAuth.capture();
        if (stamp.intent === startup.stamp.intent) startup.stamp = stamp;
      }
      if (startup && ((!sessionAuth.isCurrent(startup.stamp) && startup.phase !== 'exchange')
        || (startup.phase === 'exchange' && startup.exchangeEmail
          && sess?.user.email?.trim().toLowerCase() !== startup.exchangeEmail))) {
        startup.active = false; startup.transitioning = false; startup.controller.abort(); startupRef.current = null;
      }
      const revision = beginAuthResolution(sess?.user ?? null);
      setSession(sess);
      setUser(sess?.user ?? null);

      const staffAuth = loadStoredStaffAuth();
      if (staffAuth) {
        applyStaffWorkspaceState(staffAuth, sess?.user ?? null);
        finishAuthLoading();
        return;
      }

      const demoAuth = loadStoredDemoAuth();
      if (demoAuth) {
        applyDemoWorkspaceState(demoAuth);
        finishAuthLoading();
        return;
      }

      if (sess?.user) {
        void (async () => {
          const handledAsStaff = await tryApplySupabaseStaffUser(sess.user, revision);
          if (!isCurrentAuthResolution(sess.user.id, revision)) return;
          if (handledAsStaff) {
            finishAuthLoading();
            return;
          }
          applyNoWorkspaceAccess();
        })();
      } else {
        setClinicId(null);
        setUserRole(null);
        setRolePermissions({});
        finishAuthLoading();
      }
    });
    subscriptionRef.current = subscription;

    /* Then check the current session */
    const initialRevision = authRevisionRef.current;
    let sess: Session | null;
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      sess = data.session;
    } catch {
      if (providerCurrent(provider) && setupRevision === sdkSetupRevisionRef.current && authRevisionRef.current === initialRevision) {
        beginAuthResolution(null); setSession(null); setUser(null); finishAuthLoading();
      }
      return;
    }
    if (!providerCurrent(provider) || setupRevision !== sdkSetupRevisionRef.current || authRevisionRef.current !== initialRevision) return;
    const revision = beginAuthResolution(sess?.user ?? null);
    setSession(sess);
    setUser(sess?.user ?? null);

    const staffAuth = loadStoredStaffAuth();
    if (staffAuth) {
      applyStaffWorkspaceState(staffAuth, sess?.user ?? null);
      finishAuthLoading();
      return;
    }

    const demoAuth = loadStoredDemoAuth();
    if (demoAuth) {
      applyDemoWorkspaceState(demoAuth);
      finishAuthLoading();
      return;
    }

    if (sess?.user) {
      const handledAsStaff = await tryApplySupabaseStaffUser(sess.user, revision);
      if (!isCurrentAuthResolution(sess.user.id, revision)) return;
      if (handledAsStaff) {
        finishAuthLoading();
        return;
      }
      applyNoWorkspaceAccess();
    } else {
      finishAuthLoading();
    }
  };

  /* ── 3. Handle fresh impersonation token from URL ─────── */
  const handleImpersonationToken = async (token: string, scope: StartupLifetime) => {
    const controlApiUrl =
      (import.meta.env.VITE_NEGIS_CONTROL_API_URL as string | undefined)
      || 'https://admin.negis.online';

    try {
      if (!startupCurrent(scope)) return;
      const verifyRes = await fetch(`${controlApiUrl}/api/impersonation/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
        signal: scope.controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      });
      if (!startupCurrent(scope)) return;

      if (verifyRes.status === 401 || verifyRes.status === 403) throw new Error('expired_token');
      if (!verifyRes.ok) throw new Error('invalid_token');

      const value: unknown = await verifyRes.json();
      if (!startupCurrent(scope)) return;
      if (!value || typeof value !== 'object') throw new Error('invalid_token');
      const data = value as Record<string, unknown>;
      if (typeof data.clinicId !== 'string' || !data.clinicId.trim() || typeof data.ownerEmail !== 'string'
        || !data.ownerEmail.trim() || typeof data.clinicName !== 'string' || typeof data.issuedBy !== 'string') throw new Error('invalid_token');
      const clinicId = data.clinicId.trim(), ownerEmail = data.ownerEmail.trim().toLowerCase();

      const sessionRes = await fetch(apiUrl('/api/impersonation/session'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ impersonateToken: token, ownerEmail: data.ownerEmail }),
        signal: scope.controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      });
      if (!startupCurrent(scope)) return;
      if (!sessionRes.ok) throw new Error('invalid_session');
      const sessionBody: unknown = await sessionRes.json();
      if (!startupCurrent(scope)) return;
      const tokenHash = sessionBody && typeof sessionBody === 'object' && 'tokenHash' in sessionBody ? sessionBody.tokenHash : null;
      if (typeof tokenHash !== 'string' || !tokenHash) throw new Error('invalid_session');

      scope.phase = 'exchange';
      scope.exchangeEmail = ownerEmail;
      let receipt: AuthStamp | null = null;
      const result = await sessionAuth.verifyOtp({ token_hash: tokenHash, type: 'email' }, {
        expected: scope.stamp, isCurrent: () => startupAlive(scope), signal: scope.controller.signal,
        onReceipt: stamp => { receipt = stamp; },
      });
      if (!providerCurrent(scope.provider) || startupRef.current !== scope || !scope.active
        || isSignOutPending() || scope.signOutRevision !== getSignOutRevision() || !receipt || !sessionAuth.isCurrent(receipt)) return;
      scope.stamp = receipt;
      if (!startupCurrent(scope)) return;
      const exchanged = result.data.session;
      if (result.error || !exchanged || exchanged.user.email?.trim().toLowerCase() !== ownerEmail) throw new Error('invalid_session');
      const { data: live, error } = await supabase.auth.getSession();
      if (!startupCurrent(scope)) return;
      if (error || live.session?.user.id !== exchanged.user.id || live.session.access_token !== exchanged.access_token) throw new Error('invalid_session');

      const revision = beginAuthResolution(exchanged.user);
      const access = await fetchAuthContext(exchanged.user.id, revision, { signal: scope.controller.signal, isCurrent: () => startupCurrent(scope) });
      if (!startupCurrent(scope) || !isCurrentAuthResolution(exchanged.user.id, revision)) return;
      const owner = access.memberships.find(entry => entry.workspaceId === clinicId && entry.role === 'owner');
      if (access.sessionChanged || access.status !== 200 || !owner) throw new Error('invalid_membership');
      const hint: ImpersonationData = { active: true, auth_user_id: exchanged.user.id, clinic_id: owner.workspaceId,
        clinic_name: owner.workspaceName, owner_email: ownerEmail, issued_by: data.issuedBy };
      localStorage.setItem(IMP_KEY, JSON.stringify(hint));
      setLocation('/dashboard');
    } catch (err) {
      if (!startupCurrent(scope)) return;
      toast.error(
        err instanceof Error && err.message === 'expired_token'
          ? 'Доступ по ссылке истёк. Войдите снова из Medina OS.'
          : 'Не удалось проверить доступ через Medina OS.',
      );
    }
  };

  /* ── 4. Resolve access for a Supabase-authenticated user ──
     Security-1A: the previous implementation read `user_roles`, `agents` and
     `roles` directly from the browser. None of those tables exist in the
     production project, so the queries always failed and surfaced a generic
     "не удалось загрузить профиль" error.

     The authoritative path is `tryApplySupabaseStaffUser`, which resolves the
     workspace and role through the server API (/api/crm/staff, service-role
     backed). It runs before this function. Reaching here therefore means the
     signed-in account is not linked to any clinic — we grant NO role and NO
     permissions rather than guessing or elevating. */
  const applyNoWorkspaceAccess = (notifyUnlinked = true) => {
    bindWorkspaceReadScope(workspaceReadOwner, null);
    setClinicId(null);
    setUserRole(null);
    setRolePermissions({});
    setVertical(DEFAULT_VERTICAL);
    setWorkspacePurpose(null);
    setIsStaffMode(false);
    finishAuthLoading();
    if (!notifyUnlinked || startupRef.current?.transitioning) return;
    // Selection-1: a user with several memberships is not unlinked, they have
    // not chosen yet. Telling them to call their administrator sent them to
    // someone who could not have helped.
    if (membershipsRef.current.length > 1) return;
    // На /join членств ещё нет ПО ЗАМЫСЛУ: человек держит валидное приглашение
    // и как раз собирается его принять. Пугать его тревогой на этом шаге —
    // повод для звонка администратору на пустом месте.
    if (typeof window !== 'undefined') {
      const path = window.location.pathname || '';
      let pendingInvite = '';
      try {
        pendingInvite = window.sessionStorage.getItem('negis_pending_invite')?.trim() || '';
      } catch {
        // Нет хранилища — судим только по адресу.
      }
      if (path.includes('/join') || path === '/reset-password' || path === '/operator' || path === '/contributors' || path === '/partner-company' || /^\/r\/[^/?#\\\s]+\/?$/.test(path) || pendingInvite) return;
    }
    toast.error(
      'Аккаунт не привязан к клинике. Если вам присылали ссылку-приглашение — откройте её ещё раз; если нет — попросите администратора клиники выслать приглашение.',
    );
  };

  /* ── 5. Sign out ──────────────────────────────────────── */
  const signOut = (restorePending = false): Promise<void> => {
    if (signOutRequestRef.current) return signOutRequestRef.current;
    if (restorePending !== true && (!mountedRef.current || profileSubjectRevisionRef.current !== profileSubjectRevision)) return Promise.resolve();
    const subject = userRef.current?.id ?? null;
    let expected: AuthStamp | undefined, captureError: unknown;
    try { expected = sessionAuth.capture(); } catch (error) { captureError = error; }
    const startup = startupRef.current;
    if (startup) { startup.active = false; startup.transitioning = false; startup.controller.abort(); startupRef.current = null; }
    const provider = providerLifetimeRef.current;
    const recovering = isSignOutPending();
    markSignOutPending();
    const signOutRevision = getSignOutRevision();
    const ownsSignOut = () => providerCurrent(provider) && getSignOutRevision() === signOutRevision;
    sdkSetupRevisionRef.current++;
    subscriptionRef.current?.unsubscribe(); subscriptionRef.current = null;
    beginAuthResolution(null);
    setIsSigningOut(true);
    setSignOutFailed(false);
    setIsLoading(true);
    setSession(null);
    setUser(null);
    clearCrmCache();
    clearListReadCache();
    clearStaffStorage();
    clearDemoStorage();
    clearImpersonationStorage();
    const request = Promise.resolve().then(async () => {
      try {
        if (!ownsSignOut()) return;
        if (captureError) throw captureError;
        if (!isDemoMode) {
          const { error } = await sessionAuth.signOut({ expected, ...(!recovering || subject ? { expectedUserId: subject } : {}), isCurrent: ownsSignOut });
          // A remounted provider may already own a newer exit. This response
          // must not clear its marker or publish an old completion/error.
          if (!ownsSignOut()) return;
          if (error) throw error;
        }
        if (!clearSignOutPending()) throw new Error('signout_marker_unavailable');
        if (!mountedRef.current) return;
        setIsSigningOut(false);
        setIsLoading(false);
        setLocation('/');
        if (!recovering && !isDemoMode && !isStaffMode && !isImpersonation) {
          toast.success('Вы успешно вышли из системы');
        }
        // Recovery after a reload ends the stored SDK session before starting
        // the subscription; subsequent sign-ins must still be observed.
        if (!isDemoMode && !subscriptionRef.current) await setupSupabaseAuth();
      } catch (error) {
        if (ownsSignOut() && error instanceof StaleAuthIntentError && clearSignOutPending()) {
          setIsSigningOut(false); setSignOutFailed(false);
          await setupSupabaseAuth(provider);
          return;
        }
        if (mountedRef.current && ownsSignOut()) setSignOutFailed(true);
      } finally {
        if (signOutRequestRef.current === request) signOutRequestRef.current = null;
      }
    });
    signOutRequestRef.current = request;
    return request;
  };

  return (
    <AuthContext.Provider value={{
      session, user, clinicId, userRole, isLoading, isSigningOut, signOutFailed,
      rolePermissions,
      isImpersonation, isDemoMode, isStaffMode, impersonationClinicName, vertical,
      workspacePurpose,
      availableWorkspaces, workspaceSelectionFailed, selectWorkspace, enterWorkspace, clearWorkspaceSelection,
      applyConfirmedProfile,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
