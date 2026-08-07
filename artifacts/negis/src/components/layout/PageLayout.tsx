import React from 'react';
import { Topbar } from './Topbar';
import { MobileNav } from './MobileNav';
import { Sidebar } from './Sidebar';
import { useAuth } from '@/contexts/AuthContext';
import { Redirect } from 'wouter';

interface PageLayoutProps {
  children: React.ReactNode;
  requireAuth?: boolean;
}

export function PageLayout({ children, requireAuth = true }: PageLayoutProps) {
  const { session, isLoading, isImpersonation, isDemoMode, isStaffMode } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: 'var(--negis-bg)' }}>
        <div className="text-xs font-medium tracking-[0.14em]" style={{ color: 'var(--negis-muted)' }}>
          ЗАГРУЗКА…
        </div>
      </div>
    );
  }

  if (requireAuth && !session && !isImpersonation && !isDemoMode && !isStaffMode) {
    return <Redirect to="/" />;
  }

  return (
    <div
      className="negis-app-shell min-h-[100dvh] font-sans"
      style={{
        background: 'var(--negis-ground)',
        color: 'var(--negis-text)',
        paddingTop: isImpersonation ? 40 : 0,
      }}
    >
      <div className="hidden md:block">
        <Sidebar />
      </div>
      <div className="flex min-h-[100dvh] flex-col md:pl-[268px]">
        {/* The header renders at every width: it is the only place the
            notification bell lives, so hiding it on desktop made realtime
            booking notifications unreachable there. */}
        <Topbar />
        <main className="negis-main flex-1 overflow-y-auto pb-24 md:pb-0">
          {children}
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
