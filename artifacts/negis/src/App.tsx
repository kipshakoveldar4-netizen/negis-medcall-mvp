import { useEffect, type ComponentType } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { useAuth } from "@/contexts/AuthContext";

import Landing from "@/pages/Landing";
import Register from "@/pages/Register";
import Login from "@/pages/Login";
import Onboarding from "@/pages/Onboarding";
import Dashboard from "@/pages/Dashboard";
import Agent from "@/pages/Agent";
import Ads from "@/pages/Ads";
import AdsCallback from "@/pages/AdsCallback";
import { AppointmentsPage } from "@/pages/AppointmentsPage";
import TargetingAgent from "@/pages/TargetingAgent";
import ContentStudio from "@/pages/ContentStudio";
import {
  DemoAdmin,
  DemoCalls,
  DemoChat,
  DemoClients,
  DemoLeads,
  DemoMarket,
  DemoReception,
  DemoReports,
  DemoTasks,
} from "@/pages/DemoCrmModules";
import DemoPlaceholder from "@/pages/DemoPlaceholder";
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
  '/appointments': 'booking',
  '/reception': 'reception',
  '/calls': 'reception',
  '/sales': 'crm',
  '/leads': 'crm',
  '/clients': 'crm',
  '/tasks': 'tasks',
  '/chat': 'chat',
  '/marketplace': 'marketplace',
  '/market': 'marketplace',
  '/admin': 'admin',
  '/ads': 'ads',
  '/advertising': 'ads',
  '/reports': 'ads',
  '/profile': 'dashboard',
  '/targeting-agent': 'ads',
  '/content-studio': 'ads',
  '/ai-content-studio': 'ads',
  '/content': 'ads',
  '/studio': 'ads',
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

function ProtectedPage({
  component: Component,
  permission,
  demoFallbackTitle,
}: {
  component: ComponentType;
  permission: string;
  demoFallbackTitle?: string;
}) {
  const { isLoading, userRole, rolePermissions, isDemoMode } = useAuth();
  const [, setLocation] = useLocation();
  const allowed = userRole === 'owner' || userRole === 'manager' || !!rolePermissions[permission];

  useEffect(() => {
    if (!isLoading && !allowed) setLocation(firstAllowedRoute(rolePermissions));
  }, [allowed, isLoading, rolePermissions, setLocation]);

  if (isLoading || !allowed) return null;
  if (isDemoMode && demoFallbackTitle) return <DemoPlaceholder title={demoFallbackTitle} />;
  return <Component />;
}

/* ── Router ── */
function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/onboarding" component={Onboarding} />
      <Route path="/dashboard" component={() => <ProtectedPage component={Dashboard} permission="dashboard" />} />
      <Route path="/booking" component={() => <ProtectedPage component={AppointmentsPage} permission="booking" />} />
      <Route path="/appointments" component={() => <ProtectedPage component={AppointmentsPage} permission="booking" />} />
      <Route path="/reception" component={() => <ProtectedPage component={DemoReception} permission="reception" />} />
      <Route path="/calls" component={() => <ProtectedPage component={DemoCalls} permission="reception" />} />
      <Route path="/sales" component={() => <ProtectedPage component={DemoClients} permission="crm" />} />
      <Route path="/leads" component={() => <ProtectedPage component={DemoLeads} permission="crm" />} />
      <Route path="/clients" component={() => <ProtectedPage component={DemoClients} permission="crm" />} />
      <Route path="/tasks" component={() => <ProtectedPage component={DemoTasks} permission="tasks" />} />
      <Route path="/chat" component={() => <ProtectedPage component={DemoChat} permission="chat" />} />
      <Route path="/marketplace" component={() => <ProtectedPage component={DemoMarket} permission="marketplace" />} />
      <Route path="/market" component={() => <ProtectedPage component={DemoMarket} permission="marketplace" />} />
      <Route path="/agent" component={Agent} />
      <Route path="/admin" component={() => <ProtectedPage component={DemoAdmin} permission="admin" />} />
      <Route path="/ads" component={() => <ProtectedPage component={Ads} permission="ads" />} />
      <Route path="/advertising" component={() => <ProtectedPage component={Ads} permission="ads" />} />
      <Route path="/ads/callback" component={AdsCallback} />
      <Route path="/reports" component={() => <ProtectedPage component={DemoReports} permission="ads" />} />
      <Route path="/profile" component={() => <ProtectedPage component={() => <DemoPlaceholder title="Профиль" />} permission="dashboard" />} />
      <Route path="/targeting-agent" component={TargetingAgent} />
      <Route path="/content-studio" component={() => <ProtectedPage component={ContentStudio} permission="ads" />} />
      <Route path="/ai-content-studio" component={() => <ProtectedPage component={ContentStudio} permission="ads" />} />
      <Route path="/content" component={() => <ProtectedPage component={ContentStudio} permission="ads" />} />
      <Route path="/studio" component={() => <ProtectedPage component={ContentStudio} permission="ads" />} />
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
