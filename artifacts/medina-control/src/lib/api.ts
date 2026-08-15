import { supabase } from "./supabase";

// Портал ходит в существующий API продукта на его домене. Адрес задаётся
// переменной сборки; умолчание — канонический адрес производственного API.
// Токен — только в заголовке Authorization: не в адресе и не в логе.

const configured = (import.meta.env.VITE_MEDINA_API_URL as string | undefined)?.replace(/\/$/, "");

export const API_BASE_URL = configured || "https://negis-medcall-mvp-api-server.vercel.app";

export async function controlFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token || "";

  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const normalized = path.startsWith("/") ? path : `/${path}`;
  return fetch(`${API_BASE_URL}${normalized}`, { ...init, headers });
}
