import React from 'react';
import { Topbar } from './Topbar';
import { useAuth } from '@/contexts/AuthContext';
import { Redirect } from 'wouter';

interface PageLayoutProps {
  children: React.ReactNode;
  requireAuth?: boolean;
}

export function PageLayout({ children, requireAuth = true }: PageLayoutProps) {
  const { session, isLoading, isImpersonation } = useAuth();

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

  if (requireAuth && !session && !isImpersonation) {
    return <Redirect to="/" />;
  }

  return (
    <div
      className="min-h-[100dvh] flex flex-col font-sans"
      style={{
        background: 'radial-gradient(circle at 16% 0%, rgba(13, 148, 136, 0.10), transparent 30%), radial-gradient(circle at 86% 4%, rgba(15, 118, 110, 0.08), transparent 28%), #EEF4F8',
        color: '#0F172A',
        paddingTop: isImpersonation ? 40 : 0,
      }}
    >
      <Topbar />
      <main className="flex-1 overflow-y-auto" style={{ padding: '24px clamp(18px, 3vw, 40px) 40px' }}>
        {children}
      </main>
    </div>
  );
}
