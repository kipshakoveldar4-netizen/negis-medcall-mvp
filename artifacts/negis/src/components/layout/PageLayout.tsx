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
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: '#EEF4F8' }}
      >
        <div style={{ fontSize: 12, letterSpacing: '0.14em', color: '#8EA0B7', fontFamily: "'Inter', sans-serif" }}>
          ЗАГРУЗКА...
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
        background: 'linear-gradient(135deg, #F8FCFB 0%, #EEF8F7 46%, #EEF6FF 100%)',
        color: '#0F172A',
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
