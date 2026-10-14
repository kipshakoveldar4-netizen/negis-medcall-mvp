import { createClient } from "@supabase/supabase-js";
import { resolveControlConfig } from "./control-config";

// Проект Auth задаётся явно и сверяется с режимом портала. Право на панель
// решает сервер по списку в переменной окружения.
// Здесь только anon-ключ — он публичный по замыслу Supabase; служебных ключей
// у портала нет и не будет.

const env = import.meta.env as Record<string, string | undefined>;
export const controlConfig = resolveControlConfig(env, import.meta.env.DEV);

export const supabase = createClient(
  controlConfig.ready ? controlConfig.supabaseUrl : "http://127.0.0.1:1",
  controlConfig.ready ? controlConfig.anonKey : "unconfigured",
  {
    auth: {
      persistSession: controlConfig.ready,
      autoRefreshToken: controlConfig.ready,
      detectSessionInUrl: controlConfig.ready,
    },
    ...(controlConfig.ready ? {} : {
      global: { fetch: () => Promise.reject(new Error(controlConfig.error)) },
    }),
  },
);
