declare global {
  interface Window {
    fbq: ((...args: unknown[]) => void) & {
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

export function initPixel(pixelId: string): void {
  if (!pixelId || initialized || typeof window === 'undefined' || !window.fbq) return;
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
