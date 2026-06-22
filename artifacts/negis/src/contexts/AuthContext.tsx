import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { apiUrl } from '@/lib/api';
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
  impersonationClinicName: string | null;
  signOut: () => Promise<void>;
}

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
  const [rolePermissions,         setRolePermissions]         = useState<RolePermissions>({});
  const [isLoading,               setIsLoading]               = useState(true);
  const [isImpersonation,         setIsImpersonation]         = useState(false);
  const [isDemoMode,              setIsDemoMode]              = useState(false);
  const [isStaffMode,             setIsStaffMode]             = useState(false);
  const [impersonationClinicName, setImpersonationClinicName] = useState<string | null>(null);
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

  const fetchStaffByEmail = async (email: string): Promise<StaffUserData | null> => {
    if (!email.trim()) return null;

    try {
      const response = await fetch(apiUrl(`/api/crm/staff?email=${encodeURIComponent(email.trim().toLowerCase())}`));
      const text = await response.text();
      const body = text ? JSON.parse(text) as { success?: boolean; data?: Record<string, unknown> } : null;
      if (!response.ok || body?.success !== true || !body.data) return null;

      const staffList = Array.isArray(body.data.staff)
        ? body.data.staff
        : Array.isArray(body.data.items)
          ? body.data.items
          : [];
      return normalizeStaffUser(staffList[0]);
    } catch {
      return null;
    }
  };

  const tryApplySupabaseStaffUser = async (supabaseUser: User): Promise<boolean> => {
    const email = supabaseUser.email || '';
    const staffUser = await fetchStaffByEmail(email);
    if (!staffUser) return false;

    const sessionData: StaffSessionData = {
      mode: 'staff',
      authenticated: true,
      createdAt: new Date().toISOString(),
      email,
      workspaceId: staffUser.workspaceId || staffUser.workspace_id,
      supabaseUserId: supabaseUser.id,
    };

    localStorage.setItem(STAFF_USER_KEY, JSON.stringify(staffUser));
    localStorage.setItem(STAFF_SESSION_KEY, JSON.stringify(sessionData));
    applyStaffWorkspaceState({ user: staffUser, session: sessionData }, supabaseUser);
    return true;
  };

  /* ── 1. Init ──────────────────────────────────────────── */
  const initAuth = async () => {
    const params = new URLSearchParams(window.location.search);
    const token  = params.get('impersonate_token');
    const testHash = params.get('test_token_hash');

    /* A) E2E test login via access/refresh tokens (URL params) */
    const devAccessToken  = params.get('dev_access_token');
    const devRefreshToken = params.get('dev_refresh_token');
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
          await fetchUserRole(sess.user.id);
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
      await fetchUserRole(sess.user.id);
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

  /* ── 4. Fetch user role (normal auth only) ────────────── */
  const fetchRolePermissions = async (userId: string, activeClinicId: string, role: UserRole) => {
    if (role === 'owner' || role === 'manager') {
      setRolePermissions(ALL_PERMISSIONS);
      return;
    }

    const fallback = SYSTEM_ROLE_PERMISSIONS[role] ?? {};
    const { data: agentRow } = await supabase
      .from('agents')
      .select('role_id')
      .eq('clinic_id', activeClinicId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!agentRow?.role_id) {
      setRolePermissions(fallback);
      return;
    }

    const { data: customRole } = await supabase
      .from('roles')
      .select('permissions')
      .eq('clinic_id', activeClinicId)
      .eq('id', agentRow.role_id)
      .maybeSingle();

    setRolePermissions((customRole?.permissions as RolePermissions | null) || fallback);
  };

  const fetchUserRole = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('clinic_id, role')
        .eq('user_id', userId)
        .single();
      if (error) throw error;
      if (data) {
        setClinicId(data.clinic_id);
        const role = data.role as UserRole;
        setUserRole(role);
        await fetchRolePermissions(userId, data.clinic_id, role);
      } else {
        setLocation('/onboarding');
      }
    } catch {
      toast.error('Не удалось загрузить профиль. Попробуйте перезайти.');
    } finally {
      setIsLoading(false);
    }
  };

  /* ── 5. Sign out ──────────────────────────────────────── */
  const signOut = async () => {
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
      isImpersonation, isDemoMode, isStaffMode, impersonationClinicName,
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
