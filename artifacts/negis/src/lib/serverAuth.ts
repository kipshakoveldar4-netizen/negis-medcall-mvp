import { hasSupabaseFrontendEnv, supabase } from "@/lib/supabase";
import { isSignOutPending, getSignOutRevision } from "@/lib/authSignOut";

export async function getSupabaseAccessToken(expectedUserId?: string): Promise<string> {
  if (!hasSupabaseFrontendEnv || isSignOutPending()) return "";
  const revision = getSignOutRevision();

  const { data, error } = await supabase.auth.getSession();
  if (error || isSignOutPending() || getSignOutRevision() !== revision) return "";
  if (expectedUserId && data.session?.user.id !== expectedUserId) return "";
  return data.session?.access_token?.trim() || "";
}
