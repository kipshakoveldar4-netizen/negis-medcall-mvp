declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & {
      callMethod?: (...args: unknown[]) => void;
      queue: unknown[];
      push: (...args: unknown[]) => void;
      loaded: boolean;
      version: string;
    };
    _fbq?: unknown;
  }
}

let initialized = false;

/* The Meta Pixel base script is injected here, lazily, instead of living in
   index.html. The old inline loader downloaded fbevents.js for every visitor —
   demo mode, clinics without a pixel, the public landing — sending traffic to
   a third party before any pixel was configured. Now the script loads only
   when a clinic with a real pixel id reaches initPixel(). */
function ensureBaseScript(): void {
  if (typeof window === 'undefined' || window.fbq) return;

  const fbq = function (...args: unknown[]) {
    if (fbq.callMethod) {
      fbq.callMethod(...args);
    } else {
      fbq.queue.push(args);
    }
  } as NonNullable<Window['fbq']>;

  fbq.queue = [];
  fbq.loaded = true;
  fbq.version = '2.0';
  fbq.push = fbq as unknown as (...args: unknown[]) => void;

  window.fbq = fbq;
  if (!window._fbq) window._fbq = fbq;

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(script);
}

export function initPixel(pixelId: string): void {
  if (!pixelId || initialized || typeof window === 'undefined') return;
  ensureBaseScript();
  if (!window.fbq) return;
  window.fbq('init', pixelId);
  window.fbq('track', 'PageView');
  initialized = true;
}

export function trackEvent(event: string, data?: Record<string, unknown>): void {
  if (typeof window === 'undefined' || !window.fbq || !initialized) return;
  if (data) {
    window.fbq('track', event, data);
  } else {
    window.fbq('track', event);
  }
}
