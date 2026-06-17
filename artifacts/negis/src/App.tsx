import { useEffect, type ComponentType } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { useAuth } from "@/contexts/AuthContext";

import Landing from "@/pages/Landing";
import Register from "@/pages/Register";
import Onboarding from "@/pages/Onboarding";
import Dashboard from "@/pages/Dashboard";
import Booking from "@/pages/Booking";
import Reception from "@/pages/Reception";
import Sales from "@/pages/Sales";
import Tasks from "@/pages/Tasks";
import Chat from "@/pages/Chat";
import Marketplace from "@/pages/Marketplace";
import Agent from "@/pages/Agent";
import Admin from "@/pages/Admin";
import Ads from "@/pages/Ads";
import AdsCallback from "@/pages/AdsCallback";
import TargetingAgent from "@/pages/TargetingAgent";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";
import DataDeletion from "@/pages/DataDeletion";
import ResetPassword from "@/pages/ResetPassword";
import NotFound from "@/pages/not-found";
import FbPixelInit from "@/components/FbPixelInit";

const queryClient = new QueryClient();

const ROUTE_PERMISSIONS: Record<string, string> = {
  '/dashboard': 'dashboard',
  '/booking': 'booking',
  '/reception': 'reception',
  '/sales': 'crm',
  '/tasks': 'tasks',
  '/chat': 'chat',
  '/marketplace': 'marketplace',
  '/admin': 'admin',
  '/ads': 'ads',
  '/targeting-agent': 'ads',
};

function firstAllowedRoute(rolePermissions: Record<string, boolean>) {
  const first = Object.entries(ROUTE_PERMISSIONS).find(([, permission]) => rolePermissions[permission]);
  return first?.[0] ?? '/';
}

/* ── Impersonation Banner ────────────────────────────────── */
function ImpersonationBanner() {
  const { isImpersonation, impersonationClinicName, signOut } = useAuth();
  if (!isImpersonation) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
      height: 40,
      background: '#DC2626',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
      fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 500,
      color: '#FFFFFF',
      letterSpacing: '0.01em',
    }}>
      <span style={{ opacity: 0.75, fontSize: 12 }}>РЕЖИМ ПРОСМОТРА</span>
      <span style={{ opacity: 0.35 }}>|</span>
      <span>{impersonationClinicName}</span>
      <span style={{ opacity: 0.35 }}>|</span>
      <button
        onClick={signOut}
        style={{
          background: 'rgba(255,255,255,0.15)',
          border: '1px solid rgba(255,255,255,0.30)',
          borderRadius: 6,
          color: '#FFFFFF', cursor: 'pointer',
          fontSize: 12, fontWeight: 600,
          padding: '3px 10px',
          fontFamily: "'Inter', sans-serif",
          letterSpacing: '0.03em',
        }}
      >
        Выйти
      </button>
    </div>
  );
}

function ProtectedPage({ component: Component, permission }: { component: ComponentType; permission: string }) {
  const { isLoading, userRole, rolePermissions } = useAuth();
  const [, setLocation] = useLocation();
  const allowed = userRole === 'owner' || userRole === 'manager' || !!rolePermissions[permission];

  useEffect(() => {
    if (!isLoading && !allowed) setLocation(firstAllowedRoute(rolePermissions));
  }, [allowed, isLoading, rolePermissions, setLocation]);

  if (isLoading || !allowed) return null;
  return <Component />;
}

/* ── Router ── */
function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/register" component={Register} />
      <Route path="/onboarding" component={Onboarding} />
      <Route path="/dashboard" component={() => <ProtectedPage component={Dashboard} permission="dashboard" />} />
      <Route path="/booking" component={() => <ProtectedPage component={Booking} permission="booking" />} />
      <Route path="/reception" component={() => <ProtectedPage component={Reception} permission="reception" />} />
      <Route path="/sales" component={() => <ProtectedPage component={Sales} permission="crm" />} />
      <Route path="/tasks" component={() => <ProtectedPage component={Tasks} permission="tasks" />} />
      <Route path="/chat" component={() => <ProtectedPage component={Chat} permission="chat" />} />
      <Route path="/marketplace" component={() => <ProtectedPage component={Marketplace} permission="marketplace" />} />
      <Route path="/agent" component={Agent} />
      <Route path="/admin" component={() => <ProtectedPage component={Admin} permission="admin" />} />
      <Route path="/ads" component={() => <ProtectedPage component={Ads} permission="ads" />} />
      <Route path="/ads/callback" component={AdsCallback} />
      <Route path="/targeting-agent" component={TargetingAgent} />
      <Route path="/privacy" component={Privacy} />
      <Route path="/terms" component={Terms} />
      <Route path="/data-deletion" component={DataDeletion} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route component={NotFound} />
    </Switch>
  );
}

/* ── App ── */
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <AuthProvider>
          <TooltipProvider>
            <FbPixelInit />
            <ImpersonationBanner />
            <Router />
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </AuthProvider>
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
