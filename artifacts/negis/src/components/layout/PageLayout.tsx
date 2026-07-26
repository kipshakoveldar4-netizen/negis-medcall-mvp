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
      <div className="flex min-h-screen items-center justify-center" style={{ background: 'var(--ng-bg)' }}>
        <div className="text-xs font-medium tracking-[0.14em]" style={{ color: 'var(--ng-muted)' }}>
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
        background: 'var(--ng-bg)',
        color: 'var(--ng-text)',
        paddingTop: isImpersonation ? 40 : 0,
      }}
    >
      <div className="hidden md:block">
        <Sidebar />
      </div>
      <div className="flex min-h-[100dvh] flex-col md:pl-[248px]">
        <div className="md:hidden">
          <Topbar />
        </div>
        <main className="negis-main flex-1 overflow-y-auto pb-24 md:pb-0">
          {children}
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
