import { createClient } from "@supabase/supabase-js";

// Тот же проект Supabase, что и у CRM: владелец платформы входит своим обычным
// аккаунтом, а право на панель решает сервер по списку в переменной окружения.
// Здесь только anon-ключ — он публичный по замыслу Supabase; служебных ключей
// у портала нет и не будет.

const env = import.meta.env as Record<string, string | undefined>;
const url = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;

export const hasSupabaseEnv = Boolean(url && anonKey);

export const supabase = createClient(url || "https://placeholder.supabase.co", anonKey || "placeholder");
