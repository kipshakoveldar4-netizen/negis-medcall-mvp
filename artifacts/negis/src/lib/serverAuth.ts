import { hasSupabaseFrontendEnv, supabase } from "@/lib/supabase";

export async function getSupabaseAccessToken(): Promise<string> {
  if (!hasSupabaseFrontendEnv) return "";

  const { data, error } = await supabase.auth.getSession();
  if (error) return "";
  return data.session?.access_token?.trim() || "";
}
