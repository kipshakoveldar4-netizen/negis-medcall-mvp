import { controlConfig, supabase } from "./supabase";

// Портал ходит в существующий API продукта на его домене. Адрес задаётся
// переменной сборки; без проверенной конфигурации запросы запрещены.
// Токен — только в заголовке Authorization: не в адресе и не в логе.

export const API_BASE_URL = controlConfig.ready ? controlConfig.apiOrigin : "";

export async function controlFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!controlConfig.ready) throw new Error(controlConfig.error);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token || "";

  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const normalized = path.startsWith("/") ? path : `/${path}`;
  return fetch(`${API_BASE_URL}${normalized}`, { ...init, headers, redirect: "error" });
}
