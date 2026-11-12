import { Analytics, type BeforeSendEvent } from '@vercel/analytics/react';
import { canCollectWebAnalytics, sanitizeWebAnalyticsEvent } from '@/lib/web-analytics';

function beforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  try {
    // Do not inherit optional identity attribution or feature-flag metadata
    // from another script sharing this origin.
    if (window.localStorage.getItem('__va_attribution') || document.querySelector('[data-flag-values]')) return null;
    return sanitizeWebAnalyticsEvent(event, window.location.origin, document.referrer);
  } catch {
    return null;
  }
}

export function WebAnalytics() {
  if (typeof window === 'undefined' || !canCollectWebAnalytics(import.meta.env.PROD, window.location.origin)) return null;
  return <Analytics mode="production" debug={false} beforeSend={beforeSend} />;
}
