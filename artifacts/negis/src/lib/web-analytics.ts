export const webAnalyticsOrigin = 'https://medinaos.com';

// Only literal section names, never client IDs, document paths or auth flows.
const analyticsPaths = new Set([
  '/', '/login', '/dashboard', '/analytics', '/booking', '/appointments',
  '/reception', '/calls', '/sales', '/services', '/client-base', '/staff-schedule',
  '/leads', '/clients', '/tasks', '/chat', '/marketplace', '/market', '/admin',
  '/ads', '/ads-automation/history', '/ads-automation', '/advertising', '/reports',
  '/profile', '/targeting-agent', '/content-studio', '/site-blog',
  '/ai-content-studio', '/content', '/studio', '/privacy', '/terms',
  '/data-deletion', '/ai-control-center', '/operator',
]);

export function canCollectWebAnalytics(production: boolean, origin: string): boolean {
  return production === true && origin === webAnalyticsOrigin;
}

export function sanitizeWebAnalyticsEvent(event: unknown, origin: string, referrer: string): {
  type: 'pageview'; url: string;
} | null {
  try {
    if (origin !== webAnalyticsOrigin || !event || typeof event !== 'object' || Array.isArray(event)) return null;
    const view = event as { type?: unknown; url?: unknown };
    if (view.type !== 'pageview' || typeof view.url !== 'string') return null;
    const url = new URL(view.url);
    if (url.origin !== origin || url.username || url.password || !analyticsPaths.has(url.pathname)) return null;

    // The provider's hook cannot rewrite its separate referrer field. Drop the
    // entire view if that field could contain private paths or query values.
    if (referrer) {
      const source = new URL(referrer);
      if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || source.search || source.hash) return null;
      if (source.origin === origin ? !analyticsPaths.has(source.pathname) : source.pathname !== '/') return null;
    }
    return { type: 'pageview', url: `${webAnalyticsOrigin}${url.pathname}` };
  } catch {
    return null;
  }
}
