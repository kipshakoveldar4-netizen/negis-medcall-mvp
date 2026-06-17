const appBasePath = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
const configuredApiBase =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

export const API_BASE_URL = configuredApiBase || appBasePath;

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

export function publicApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = configuredApiBase || `${window.location.origin}${appBasePath}`;
  return `${base}${normalizedPath}`;
}
