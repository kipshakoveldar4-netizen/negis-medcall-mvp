import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { Switch, Route, Redirect, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { useAuth } from "@/contexts/AuthContext";

// Eager: the public entry (Landing) and the shared fallbacks stay in the main
// chunk so the first paint never waits on a second request.
import Landing from "@/pages/Landing";
import DemoPlaceholder from "@/pages/DemoPlaceholder";
import NotFound from "@/pages/not-found";
import FbPixelInit from "@/components/FbPixelInit";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { RouteErrorBoundary } from "@/components/layout/RouteErrorBoundary";

// Lazy: every operational screen loads as its own chunk. Before this, all 28
// routes (including the 4.6k-line AdsAutomation) shipped in one bundle that
// the landing page had to download.
const Login = lazy(() => import("@/pages/Login"));
const Onboarding = lazy(() => import("@/pages/Onboarding"));
const JoinWorkspace = lazy(() => import("@/pages/JoinWorkspace"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const AiControlCenter = lazy(() => import("@/pages/AiControlCenter"));
// Security-1A: /agent, /ads and /ads/callback were removed from the router.
// Their pages query legacy tables that do not exist in the production Supabase
// project (agents, bookings, shifts, ad_accounts, ad_reports, platform_configs,
// clinics), so every request failed. Shift tracking and the legacy ad cabinet
// are out of the first commercial release; /ads-automation is the supported
// advertising module. Direct URLs now fall through to the not-found route.
const AdsAutomation = lazy(() => import("@/pages/AdsAutomation"));
const AppointmentsPage = lazy(() => import("@/pages/AppointmentsPage").then(m => ({ default: m.AppointmentsPage })));
const ContentStudio = lazy(() => import("@/pages/ContentStudio"));
const AdminCenter = lazy(() => import("@/pages/AdminCenter"));
const LeadsPage = lazy(() => import("@/pages/LeadsPage"));
const ClientsPage = lazy(() => import("@/pages/ClientsPage"));
const SalesPage = lazy(() => import("@/pages/SalesPage"));
const DemoCalls = lazy(() => import("@/pages/DemoCrmModules").then(m => ({ default: m.DemoCalls })));
const DemoChat = lazy(() => import("@/pages/DemoCrmModules").then(m => ({ default: m.DemoChat })));
const DemoMarket = lazy(() => import("@/pages/DemoCrmModules").then(m => ({ default: m.DemoMarket })));
const DemoReception = lazy(() => import("@/pages/DemoCrmModules").then(m => ({ default: m.DemoReception })));
const DemoReports = lazy(() => import("@/pages/DemoCrmModules").then(m => ({ default: m.DemoReports })));
const DemoTasks = lazy(() => import("@/pages/DemoCrmModules").then(m => ({ default: m.DemoTasks })));
const Privacy = lazy(() => import("@/pages/Privacy"));
const Terms = lazy(() => import("@/pages/Terms"));
const DataDeletion = lazy(() => import("@/pages/DataDeletion"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));

/**
 * Warms the lazy route chunks once the user is authenticated and the browser
 * is idle. Measured on production: ProtectedPage keeps a route unmounted until
 * auth resolves, so the page's chunk request used to start only ~2.3s into a
 * cold load, and every first visit to a section paid its chunk fetch inside
 * the transition. Vite deduplicates dynamic imports, so a warmed chunk makes
 * the later route render use it from module cache — and a prefetch failure is
 * harmless, the route import simply fetches again.
 */
const PREFETCH_ROUTES: Array<() => Promise<unknown>> = [
  () => import("@/pages/AiControlCenter"),
  () => import("@/pages/Dashboard"),
  () => import("@/pages/LeadsPage"),
  () => import("@/pages/ClientsPage"),
  () => import("@/pages/AppointmentsPage"),
  () => import("@/pages/SalesPage"),
  () => import("@/pages/AdminCenter"),
  () => import("@/pages/DemoCrmModules"),
  // The two heaviest chunks benefit the most: AdsAutomation alone is ~34KB
  // gzip, which used to sit inside the first transition to /ads-automation.
  () => import("@/pages/AdsAutomation"),
  () => import("@/pages/ContentStudio"),
];

function RoutePrefetcher() {
  const { isLoading, userRole } = useAuth();

  useEffect(() => {
    if (isLoading || !userRole) return;
    const idle: (cb: () => void) => number =
      typeof window.requestIdleCallback === "function"
        ? (cb) => window.requestIdleCallback(cb)
        : (cb) => window.setTimeout(cb, 1200);
    idle(() => {
      for (const load of PREFETCH_ROUTES) void load().catch(() => undefined);
    });
  }, [isLoading, userRole]);

  return null;
}

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: "var(--ng-bg)" }}>
      <div className="text-xs font-medium tracking-[0.14em]" style={{ color: "var(--ng-muted)" }}>
        ЗАГРУЗКА…
      </div>
    </div>
  );
}

const queryClient = new QueryClient();

const ROUTE_PERMISSIONS: Record<string, string> = {
  '/ai-control-center': 'dashboard',
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
  '/ads-automation': 'ads',
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
/**
 * Pages that answer to more than one path get one stable component each.
 *
 * `component={() => <ProtectedPage ... />}` written inline creates a new
 * function on every Route, so two paths pointing at the same page are two
 * different element types to React. Switching between them unmounts the page
 * and mounts it again from scratch instead of keeping the mounted tree.
 *
 * On /ads-automation that was expensive in a way the user feels: opening
 * «История запусков» and coming back dropped the whole wizard — the uploaded
 * creative, the AI package, the confirmations — and silently killed the
 * setInterval watching a running video optimisation (AdsAutomation.tsx:1697),
 * so the job kept finishing on the server while the screen showed an empty
 * step 1. The other three pairs lose their page state the same way.
 *
 * Single-path routes below keep their inline wrapper: Router does not
 * re-render (only Switch subscribes to location), so those closures are stable
 * for the life of the app, and moving between two different pages is supposed
 * to unmount anyway.
 */
const AppointmentsRoute = () => <ProtectedPage component={AppointmentsPage} permission="booking" />;
const MarketRoute = () => <ProtectedPage component={DemoMarket} permission="marketplace" />;
const AdsAutomationRoute = () => <ProtectedPage component={AdsAutomation} permission="ads" />;
const ContentStudioRoute = () => <ProtectedPage component={ContentStudio} permission="ads" />;

function Router() {
  return (
    <RouteErrorBoundary>
    <Suspense fallback={<RouteFallback />}>
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={Login} />
      <Route path="/onboarding" component={Onboarding} />
      <Route path="/join" component={JoinWorkspace} />
      <Route path="/ai-control-center" component={() => <ProtectedPage component={AiControlCenter} permission="dashboard" />} />
      <Route path="/dashboard" component={() => <ProtectedPage component={Dashboard} permission="dashboard" />} />
      <Route path="/booking" component={AppointmentsRoute} />
      <Route path="/appointments" component={AppointmentsRoute} />
      <Route path="/reception" component={() => <ProtectedPage component={DemoReception} permission="reception" />} />
      <Route path="/calls" component={() => <ProtectedPage component={DemoCalls} permission="reception" />} />
      <Route path="/sales" component={() => <ProtectedPage component={SalesPage} permission="crm" />} />
      <Route path="/leads" component={() => <ProtectedPage component={LeadsPage} permission="crm" />} />
      <Route path="/clients" component={() => <ProtectedPage component={ClientsPage} permission="crm" />} />
      <Route path="/tasks" component={() => <ProtectedPage component={DemoTasks} permission="tasks" />} />
      <Route path="/chat" component={() => <ProtectedPage component={DemoChat} permission="chat" />} />
      <Route path="/marketplace" component={MarketRoute} />
      <Route path="/market" component={MarketRoute} />
      <Route path="/admin" component={() => <ProtectedPage component={AdminCenter} permission="admin" />} />
      <Route path="/ads-automation/history" component={AdsAutomationRoute} />
      <Route path="/ads-automation" component={AdsAutomationRoute} />
      {/* Legacy ad cabinet links keep working by pointing at the supported module. */}
      <Route path="/advertising">
        <Redirect to="/ads-automation" />
      </Route>
      <Route path="/reports" component={() => <ProtectedPage component={DemoReports} permission="ads" />} />
      <Route path="/profile" component={() => <ProtectedPage component={() => <DemoPlaceholder title="Профиль" />} permission="dashboard" />} />
      {/* AI Target is no longer a standalone module: its functionality lives inside
          Ads Automation ("ИИ заполнит"). Old links land on /ads-automation. */}
      <Route path="/targeting-agent">
        <Redirect to="/ads-automation" />
      </Route>
      <Route path="/content-studio" component={ContentStudioRoute} />
      <Route path="/ai-content-studio" component={ContentStudioRoute} />
      <Route path="/content" component={ContentStudioRoute} />
      <Route path="/studio" component={ContentStudioRoute} />
      <Route path="/privacy" component={Privacy} />
      <Route path="/terms" component={Terms} />
      <Route path="/data-deletion" component={DataDeletion} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route component={NotFound} />
    </Switch>
    </Suspense>
    </RouteErrorBoundary>
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
            <WorkspacePicker />
            <RoutePrefetcher />
            <Router />
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </AuthProvider>
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
