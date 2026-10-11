import { hasSupabaseFrontendEnv, supabase } from "@/lib/supabase";

export async function getSupabaseAccessToken(expectedUserId?: string): Promise<string> {
  if (!hasSupabaseFrontendEnv) return "";

  const { data, error } = await supabase.auth.getSession();
  if (error) return "";
  if (expectedUserId && data.session?.user.id !== expectedUserId) return "";
  return data.session?.access_token?.trim() || "";
}
