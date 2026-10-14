const previewHost = /^negis-medcall-mvp-api-server-[a-z0-9]{9}-yeldar-s-projects\.vercel\.app$/;
const previewDatabase = "https://ukiobbwsdoblooynzlnx.supabase.co";

export function resolveControlPreviewTarget(env) {
  if (env.VERCEL_ENV !== "preview"
    || env.VERCEL_GIT_COMMIT_REF !== "codex/site-blog-release-20260929") {
    return null;
  }

  const rawHostname = env.VERCEL_URL;
  const rawDatabase = env.VITE_SUPABASE_URL;
  const hostname = typeof rawHostname === "string" ? rawHostname.trim() : "";
  const supabaseUrl = typeof rawDatabase === "string" ? rawDatabase.trim() : "";
  if (!previewHost.test(hostname) || supabaseUrl !== previewDatabase) {
    throw new Error("Invalid Medina Control preview target.");
  }

  return { apiOrigin: `https://${hostname}`, supabaseUrl };
}
