import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { apiUrl } from '@/lib/api';

/* ── Types ────────────────────────────────────────────────── */
interface ImpersonationData {
  active: boolean;
  clinic_id: string;
  clinic_name: string;
  owner_email: string;
  issued_by: string;
}

export type UserRole = 'owner' | 'manager' | 'agent' | 'booking_agent' | 'receptionist';
export type RolePermissions = Record<string, boolean>;

interface AuthContextType {
  session: Session | null;
  user: User | null;
  clinicId: string | null;
  userRole: UserRole | null;
  rolePermissions: RolePermissions;
  isLoading: boolean;
  isImpersonation: boolean;
  impersonationClinicName: string | null;
  signOut: () => Promise<void>;
}

/* ── Constants ────────────────────────────────────────────── */
const IMP_KEY     = 'negis_impersonation';
const CLINIC_KEY  = 'negis_clinic_id';
const SESSION_KEY = 'negis_session';

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

const SYSTEM_ROLE_PERMISSIONS: Record<UserRole, RolePermissions> = {
  owner: ALL_PERMISSIONS,
  manager: ALL_PERMISSIONS,
  agent: { dashboard: true, booking: true, crm: true, tasks: true, chat: true },
  booking_agent: { dashboard: true, booking: true, chat: true },
  receptionist: { reception: true, chat: true },
};

function clearImpersonationStorage() {
  localStorage.removeItem(IMP_KEY);
  localStorage.removeItem(CLINIC_KEY);
  localStorage.removeItem(SESSION_KEY);
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
    setClinicId(d.clinic_id);
    setImpersonationClinicName(d.clinic_name);
    setUserRole('owner');
    setRolePermissions(ALL_PERMISSIONS);
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

      if (sess?.user) {
        fetchUserRole(sess.user.id);
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

    if (sess?.user) {
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
      localStorage.setItem(CLINIC_KEY, data.clinicId);
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        mode: 'impersonation', role: 'owner',
        clinic_id: data.clinicId, clinic_name: data.clinicName,
        email: data.ownerEmail, issued_by: data.issuedBy,
        started_at: new Date().toISOString(),
      }));

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
      clearImpersonationStorage();
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
    if (isImpersonation) {
      clearImpersonationStorage();
      setIsImpersonation(false);
      setImpersonationClinicName(null);
      setClinicId(null);
      setUserRole(null);
      setRolePermissions({});
      /* Also terminate the Supabase session created for RLS */
      await supabase.auth.signOut();
      setLocation('/');
      return;
    }
    await supabase.auth.signOut();
    setLocation('/');
    toast.success('Вы успешно вышли из системы');
  };

  return (
    <AuthContext.Provider value={{
      session, user, clinicId, userRole, isLoading,
      rolePermissions,
      isImpersonation, impersonationClinicName,
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
