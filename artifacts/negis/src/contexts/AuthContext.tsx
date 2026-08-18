import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { DEFAULT_VERTICAL, readVertical, type Vertical } from '../../../../lib/vertical/terms';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { apiUrl, clearCrmCache, crmFetch } from '@/lib/api';
import { getSupabaseAccessToken } from '@/lib/serverAuth';
import { WORKSPACE_SELECTOR_KEY } from '@/lib/demoStorage';
import { isStaffRole, permissionsForRole, type StaffRole } from '@/lib/permissions';

/* ── Types ────────────────────────────────────────────────── */
interface ImpersonationData {
  active: boolean;
  clinic_id: string;
  clinic_name: string;
  owner_email: string;
  issued_by: string;
}

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
  isImpersonation: boolean;
  isDemoMode: boolean;
  isStaffMode: boolean;
  /** Ниша рабочего пространства: она решает подписи и правила рекламы. */
  vertical: Vertical;
  impersonationClinicName: string | null;
  /**
   * Selection-1: every workspace the server listed for this user. The server
   * has said `requiresWorkspaceSelection` since Security-2B; this is the list
   * the choice is made from, and it is never wider than the memberships the
   * server verified.
   */
  availableWorkspaces: WorkspaceChoice[];
  /** Applies one of `availableWorkspaces`. Anything else is refused. */
  selectWorkspace: (workspaceId: string) => void;
  /** Drops the current choice and returns the user to the picker. */
  clearWorkspaceSelection: () => void;
  signOut: () => Promise<void>;
}

export type WorkspaceChoice = { id: string; name: string; role: string; vertical: Vertical };

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
  reports: true,
  ads: true,
  settings: true,
};

const SYSTEM_ROLE_PERMISSIONS: Partial<Record<UserRole, RolePermissions>> = {
  owner: ALL_PERMISSIONS,
  manager: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  marketer: { dashboard: true, marketplace: true, ads: true, reports: true, tasks: true, chat: true },
  doctor: { dashboard: true, booking: true, crm: true, chat: true, tasks: true },
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
    const d: ImpersonationData = JSON.parse(raw);
    return d.active && d.clinic_id ? d : null;
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
  const session = readJson<StaffSessionData>(STAFF_SESSION_KEY);
  const user = readJson<StaffUserData>(STAFF_USER_KEY);

  if (session?.mode !== 'staff' || session.authenticated !== true || !user?.email) {
    return null;
  }

  return { session, user };
}

function routePermissionsForStaffRole(role: StaffRole): RolePermissions {
  if (role === 'owner' || role === 'admin') return ALL_PERMISSIONS;

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
  const [rolePermissions,         setRolePermissions]         = useState<RolePermissions>({});
  const [isLoading,               setIsLoading]               = useState(true);
  const [isImpersonation,         setIsImpersonation]         = useState(false);
  const [isDemoMode,              setIsDemoMode]              = useState(false);
  const [isStaffMode,             setIsStaffMode]             = useState(false);
  const [impersonationClinicName, setImpersonationClinicName] = useState<string | null>(null);
  // Memberships the server confirmed for this user; drives explicit workspace choice.
  const [availableWorkspaces, setAvailableWorkspaces] = useState<WorkspaceChoice[]>([]);
  // The picker runs long after the bootstrap resolved, so the memberships and
  // the verified user are kept in refs: reading them from state inside the
  // callback would capture whatever the closure saw when it was created.
  const membershipsRef = useRef<AuthContextMembership[]>([]);
  const userRef = useRef<User | null>(null);
  useEffect(() => {
    userRef.current = user;
  }, [user]);
  const [, setLocation] = useLocation();

  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);

  useEffect(() => {
    initAuth();
    return () => { subscriptionRef.current?.unsubscribe(); };
  }, []);

  /* ── Helpers ──────────────────────────────────────────── */

  /** Apply stored impersonation state to React state (idempotent). */
  const applyImpersonationState = (d: ImpersonationData) => {
    setIsImpersonation(true);
    setIsDemoMode(false);
    setIsStaffMode(false);
    setClinicId(d.clinic_id);
    setImpersonationClinicName(d.clinic_name);
    setUserRole('owner');
    setRolePermissions(ALL_PERMISSIONS);
  };

  const applyDemoWorkspaceState = (d: DemoAuthData) => {
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
    setSession(null);
    setUser(demoUser);
  };

  const applyStaffWorkspaceState = (d: StaffAuthData, supabaseUser?: User | null) => {
    const role = isStaffRole(d.user.role) ? d.user.role : 'receptionist';
    const workspaceId = d.user.workspaceId || d.user.workspace_id || d.session.workspaceId || 'demo-workspace';
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
  };

  const fetchAuthContext = async (): Promise<{
    memberships: AuthContextMembership[];
    status: number;
  }> => {
    try {
      const accessToken = await getSupabaseAccessToken();
      if (!accessToken) return { memberships: [], status: 401 };

      const response = await crmFetch('/api/crm/auth-context', { accessToken });
      if (!response.ok) return { memberships: [], status: response.status };

      const text = await response.text();
      const body = text ? (JSON.parse(text) as { success?: boolean; data?: Record<string, unknown> }) : null;
      if (body?.success !== true || !body.data) return { memberships: [], status: response.status };

      const raw = Array.isArray(body.data.memberships) ? body.data.memberships : [];
      const memberships = raw
        .map((entry) => entry as Record<string, unknown>)
        .filter((entry) => typeof entry.workspaceId === 'string' && typeof entry.role === 'string')
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
        }));

      return { memberships, status: response.status };
    } catch {
      // A network failure must not upgrade anyone; it resolves to no access.
      return { memberships: [], status: 0 };
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

    const role = isStaffRole(selected.role) ? selected.role : 'receptionist';
    setIsDemoMode(false);
    setIsImpersonation(false);
    setIsStaffMode(true);
    setClinicId(selected.workspaceId);
    setImpersonationClinicName(null);
    setUserRole(role);
    setVertical(selected.vertical);
    setRolePermissions(routePermissionsForStaffRole(role));
    setUser(supabaseUser);
    setAvailableWorkspaces(toWorkspaceChoices(memberships));
  };

  const tryApplySupabaseStaffUser = async (supabaseUser: User): Promise<boolean> => {
    const { memberships, status } = await fetchAuthContext();

    // «Прочитать не удалось» — не то же самое, что «членств нет». Разница стала
    // видна, когда смену пароля вынесли в кабинет: updateUser поднимает
    // USER_UPDATED, подписчик тут же перечитывает контекст, и одного моргнувшего
    // Wi-Fi хватало, чтобы обнулить роль и права и объявить человеку «Аккаунт не
    // привязан к клинике» — сразу после того, как его пароль успешно сменился.
    const readFailed = memberships.length === 0 && (status === 0 || status >= 500);
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

    membershipsRef.current = memberships;
    if (memberships.length === 0) {
      setAvailableWorkspaces([]);
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

    const selected =
      memberships.find((entry) => entry.workspaceId === storedSelector) ||
      (memberships.length === 1 ? memberships[0] : null);

    if (!selected) {
      // Several memberships and no valid stored choice: the server does not pick
      // one, and neither do we. Selection-1: the list is published so the user
      // can, which is what `requiresWorkspaceSelection` has been asking for.
      rememberSelector(null);
      setUser(supabaseUser);
      setAvailableWorkspaces(toWorkspaceChoices(memberships));
      return false;
    }

    applyMembership(supabaseUser, selected, memberships);
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

    if (!selected || !supabaseUser) {
      toast.error('Клиника недоступна. Войдите заново.');
      return;
    }

    // The read cache is keyed by path, and workspaceId travels in the path, so
    // the previous clinic's answers could not be served here anyway. Dropping
    // them is belt and braces: a cache that outlives a tenant switch is exactly
    // the bug that would leak one clinic's list into another's screen.
    clearCrmCache();
    applyMembership(supabaseUser, selected, memberships);
    // Every staff role in the permission table carries `dashboard`, and
    // ProtectedPage redirects anyone it does not fit, so this lands correctly
    // without duplicating the route table here.
    setLocation('/dashboard');
  };

  /** Returns a multi-clinic user to the picker without ending the session. */
  const clearWorkspaceSelection = () => {
    if (membershipsRef.current.length < 2) return;
    clearCrmCache();
    rememberSelector(null);
    setClinicId(null);
    setUserRole(null);
    setRolePermissions({});
  };

  /* ── 1. Init ──────────────────────────────────────────── */
  const initAuth = async () => {
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
    if (devAccessToken && devRefreshToken) {
      cleanUrl();
      const { error } = await supabase.auth.setSession({
        access_token:  devAccessToken,
        refresh_token: devRefreshToken,
      });
      if (error) {
        toast.error('Тестовый вход не удался: ' + error.message);
      }
      /* Session established via SDK — setupSupabaseAuth will pick it up */
      await setupSupabaseAuth();
      return;
    }

    /* B) Fresh impersonation via URL token */
    if (token) {
      await handleImpersonationToken(token);
      return;
    }

    /* C) Restore existing impersonation session (page refresh) */
    const stored = loadStoredImpersonation();
    if (stored) {
      applyImpersonationState(stored);
      /* Also restore the real Supabase session so RLS works */
      await setupSupabaseAuth();
      return;
    }

    const staffAuth = loadStoredStaffAuth();
    if (staffAuth) {
      applyStaffWorkspaceState(staffAuth);
      setIsLoading(false);
      return;
    }

    const demoAuth = loadStoredDemoAuth();
    if (demoAuth) {
      applyDemoWorkspaceState(demoAuth);
      setIsLoading(false);
      return;
    }

    /* D) Normal Supabase auth */
    await setupSupabaseAuth();
  };

  /* ── 2. Supabase subscription setup ───────────────────── */
  const setupSupabaseAuth = async () => {
    /* Set up the persistent listener FIRST so we don't miss events */
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setUser(sess?.user ?? null);

      /* If impersonation is active, keep its context (skip normal role fetch) */
      const imp = loadStoredImpersonation();
      if (imp) {
        applyImpersonationState(imp);
        setIsLoading(false);
        return;
      }

      const staffAuth = loadStoredStaffAuth();
      if (staffAuth) {
        applyStaffWorkspaceState(staffAuth, sess?.user ?? null);
        setIsLoading(false);
        return;
      }

      const demoAuth = loadStoredDemoAuth();
      if (demoAuth) {
        applyDemoWorkspaceState(demoAuth);
        setIsLoading(false);
        return;
      }

      if (sess?.user) {
        void (async () => {
          const handledAsStaff = await tryApplySupabaseStaffUser(sess.user);
          if (handledAsStaff) {
            setIsLoading(false);
            return;
          }
          applyNoWorkspaceAccess();
        })();
      } else {
        setClinicId(null);
        setUserRole(null);
        setRolePermissions({});
        setIsLoading(false);
      }
    });
    subscriptionRef.current = subscription;

    /* Then check the current session */
    const { data: { session: sess } } = await supabase.auth.getSession();
    setSession(sess);
    setUser(sess?.user ?? null);

    const imp = loadStoredImpersonation();
    if (imp) {
      /* Session may or may not be present — either way, use impersonation data */
      applyImpersonationState(imp);
      setIsLoading(false);
      return;
    }

    const staffAuth = loadStoredStaffAuth();
    if (staffAuth) {
      applyStaffWorkspaceState(staffAuth, sess?.user ?? null);
      setIsLoading(false);
      return;
    }

    const demoAuth = loadStoredDemoAuth();
    if (demoAuth) {
      applyDemoWorkspaceState(demoAuth);
      setIsLoading(false);
      return;
    }

    if (sess?.user) {
      const handledAsStaff = await tryApplySupabaseStaffUser(sess.user);
      if (handledAsStaff) {
        setIsLoading(false);
        return;
      }
      applyNoWorkspaceAccess();
    } else {
      setIsLoading(false);
    }
  };

  /* ── 3. Handle fresh impersonation token from URL ─────── */
  const handleImpersonationToken = async (token: string) => {
    const controlApiUrl =
      (import.meta.env.VITE_NEGIS_CONTROL_API_URL as string | undefined)
      || 'https://admin.negis.online';

    try {
      /* Step 1: verify with Negis Control */
      let verifyRes: Response;
      try {
        verifyRes = await fetch(`${controlApiUrl}/api/impersonation/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
      } catch {
        cleanUrl();
        toast.error('Не удалось проверить доступ через Negis Control');
        await setupSupabaseAuth();
        return;
      }

      if (verifyRes.status === 401 || verifyRes.status === 403) throw new Error('expired_token');
      if (!verifyRes.ok) throw new Error('invalid_token');

      const data: {
        clinicId: string;
        clinicName: string;
        ownerEmail: string;
        issuedBy: string;
      } = await verifyRes.json();

      /* Step 2: persist impersonation metadata */
      const impData: ImpersonationData = {
        active:      true,
        clinic_id:   data.clinicId,
        clinic_name: data.clinicName,
        owner_email: data.ownerEmail,
        issued_by:   data.issuedBy,
      };
      localStorage.setItem(IMP_KEY,    JSON.stringify(impData));

      /* Step 3: apply UI state */
      applyImpersonationState(impData);
      cleanUrl();

      /* Step 4: obtain a real Supabase session from the API server
         so that Supabase RLS policies work exactly like normal login. */
      try {
        const sessionRes = await fetch(apiUrl('/api/impersonation/session'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            impersonateToken: token,
            ownerEmail: data.ownerEmail,
          }),
        });

        if (sessionRes.ok) {
          const { tokenHash } = await sessionRes.json() as { tokenHash?: string };
          if (tokenHash) {
            /* Exchange the magic-link hash for a real access/refresh token pair */
            await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
          }
        }
      } catch {
        /* Non-fatal: banner + clinic_id still work, but RLS queries will be empty */
        toast.warning('Сессия загружена частично — обновите страницу если данные не отображаются');
      }

      /* Step 5: set up the Supabase subscription (respects impersonation) */
      await setupSupabaseAuth();

      setIsLoading(false);
      setLocation('/dashboard');
    } catch (err: any) {
      cleanUrl();
      clearAuthStorage();
      toast.error(
        err?.message === 'expired_token'
          ? 'Доступ по ссылке истёк. Войдите снова из Negis Control.'
          : 'Не удалось проверить доступ через Negis Control.',
      );
      await setupSupabaseAuth();
      setIsLoading(false);
      setLocation('/');
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
  const applyNoWorkspaceAccess = () => {
    setClinicId(null);
    setUserRole(null);
    setRolePermissions({});
    setIsLoading(false);
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
      if (path.includes('/join') || pendingInvite) return;
    }
    toast.error(
      'Аккаунт не привязан к клинике. Если вам присылали ссылку-приглашение — откройте её ещё раз; если нет — попросите администратора клиники выслать приглашение.',
    );
  };

  /* ── 5. Sign out ──────────────────────────────────────── */
  const signOut = async () => {
    // Nothing the previous account read may survive into the next one.
    clearCrmCache();
    if (isDemoMode) {
      clearDemoStorage();
      clearStaffStorage();
      setIsDemoMode(false);
      setIsStaffMode(false);
      setSession(null);
      setUser(null);
      setClinicId(null);
      setUserRole(null);
      setRolePermissions({});
      setLocation('/');
      return;
    }

    if (isStaffMode) {
      clearStaffStorage();
      clearDemoStorage();
      setIsStaffMode(false);
      setSession(null);
      setUser(null);
      setClinicId(null);
      setUserRole(null);
      setRolePermissions({});
      await supabase.auth.signOut();
      setLocation('/');
      return;
    }

    if (isImpersonation) {
      clearImpersonationStorage();
      clearStaffStorage();
      setIsImpersonation(false);
      setSession(null);
      setUser(null);
      setImpersonationClinicName(null);
      setClinicId(null);
      setUserRole(null);
      setRolePermissions({});
      /* Also terminate the Supabase session created for RLS */
      await supabase.auth.signOut();
      setLocation('/');
      return;
    }
    clearStaffStorage();
    clearDemoStorage();
    await supabase.auth.signOut();
    setLocation('/');
    toast.success('Вы успешно вышли из системы');
  };

  return (
    <AuthContext.Provider value={{
      session, user, clinicId, userRole, isLoading,
      rolePermissions,
      isImpersonation, isDemoMode, isStaffMode, impersonationClinicName, vertical,
      availableWorkspaces, selectWorkspace, clearWorkspaceSelection,
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
