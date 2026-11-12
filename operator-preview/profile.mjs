import { isDedicatedQaProjectId, qaProjectId } from "./qa-project.mjs";

export const testDatabaseOrigin = "https://ukiobbwsdoblooynzlnx.supabase.co";
const testDatabaseRef = "ukiobbwsdoblooynzlnx";
const hostnamePattern = /^medina-os-[a-z0-9]{9}-yeldar-s-projects\.vercel\.app$/;
const allowedBindings = new Set([
  "MEDINA_OPERATOR_PREVIEW", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "MEDINA_OPERATOR_PREVIEW_WORKSPACE_ID", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_API_BASE_URL",
  "REACT_APP_VERCEL_OBSERVABILITY_CLIENT_CONFIG",
]);
const disabledFlags = new Set([
  "META_VIDEO_LAUNCH_ENABLED", "TIKTOK_DISABLED_LAUNCH_ENABLED", "TIKTOK_VIDEO_UPLOAD_ENABLED",
  "VIDEO_OPTIMIZATION_ENABLED", "MEDINA_PUBLIC_SITE_ENABLED", "MEDINA_SITE_INDEXABLE",
  "MEDINA_SITE_FORM_ENABLED", "MEDINA_SITE_INTAKE_ENABLED", "MEDINA_PARTNER_ENTRY_ENABLED",
  "MEDINA_PARTNER_COMPANY_ENABLED",
]);
const systemBindings = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SHELL", "USER", "LOGNAME",
  "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME",
  "PWD", "OLDPWD", "SHLVL", "_", "CI", "TZ", "NODE_ENV",
  "LANG", "LANGUAGE", "TERM", "FORCE_COLOR", "NO_COLOR", "COREPACK_HOME", "PNPM_HOME",
  "LD_LIBRARY_PATH", "LAMBDA_TASK_ROOT", "LAMBDA_RUNTIME_DIR",
  "UV_PYTHON_BIN_DIR",
  "PORT", "INIT_CWD", "PNPM_SCRIPT_SRC_DIR", "NPM_EXECPATH",
]);

function platformBinding(name) {
  return systemBindings.has(name)
    || /^(?:VERCEL_|AWS_|LAMBDA_|VC_|LC_|NPM_CONFIG_|__VC_)[A-Z0-9_]+$/.test(name);
}

function fail(code) {
  throw new Error("Operator Preview refused: " + code);
}

function isSafeNodeOptions(value) {
  return typeof value === "string" && value.trim().split(/\s+/).every(flag =>
    flag === "--enable-source-maps" || /^--max[_-]old[_-]space[_-]size=\d+$/.test(flag));
}

function assertLegacySupabaseBinding(value, role) {
  const parts = typeof value === "string" && value.length <= 4096 ? value.split(".") : [];
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) fail("key_format");
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
  catch { fail("key_format"); }
  // This is a configuration check, not verification of the JWT signature.
  if (claims?.iss !== "supabase" || claims.ref !== testDatabaseRef || claims.role !== role) fail("key_project");
}

const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const qaWorkspaceId = "11111111-1111-4111-8111-111111111111";

export function requireOperatorPreview(env, phase, expectedProjectId = qaProjectId, expectedWorkspaceId = qaWorkspaceId) {
  if (phase !== "build" && phase !== "runtime") fail("phase");
  if (!isDedicatedQaProjectId(expectedProjectId) || env.VERCEL_PROJECT_ID !== expectedProjectId) fail("project_identity");
  if (expectedWorkspaceId !== null && (!workspaceIdPattern.test(expectedWorkspaceId)
    || env.MEDINA_OPERATOR_PREVIEW_WORKSPACE_ID !== expectedWorkspaceId)) fail("workspace_identity");
  const targetEnvironment = env.VERCEL_TARGET_ENV;
  if (env.MEDINA_OPERATOR_PREVIEW !== "1" || env.VERCEL_ENV !== "preview"
    || (targetEnvironment && targetEnvironment !== "preview")
    || !hostnamePattern.test(env.VERCEL_URL || "")) fail("target");
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET) fail("automation_bypass");
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (allowedBindings.has(name)) continue;
    if (disabledFlags.has(name) && value === "false") continue;
    if (name === "NODE_OPTIONS" && isSafeNodeOptions(value)) continue;
    if (platformBinding(name.toUpperCase())) continue;
    fail("unexpected_binding:" + name);
  }
  if (phase === "build") {
    if (env.VITE_SUPABASE_URL !== testDatabaseOrigin
      || (env.VITE_API_BASE_URL && env.VITE_API_BASE_URL !== "/")) fail("frontend_origin");
    assertLegacySupabaseBinding(env.VITE_SUPABASE_ANON_KEY, "anon");
  }
  if (phase === "runtime" || env.SUPABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY) {
    if (env.SUPABASE_URL !== testDatabaseOrigin) fail("server_origin");
    assertLegacySupabaseBinding(env.SUPABASE_SERVICE_ROLE_KEY, "service_role");
  }
  if (phase === "runtime" && ((env.VITE_SUPABASE_URL && env.VITE_SUPABASE_URL !== testDatabaseOrigin)
    || (env.VITE_SUPABASE_ANON_KEY && !env.VITE_SUPABASE_URL)
    || (env.VITE_API_BASE_URL && env.VITE_API_BASE_URL !== "/"))) fail("frontend_origin");
  if (phase === "runtime" && env.VITE_SUPABASE_ANON_KEY) assertLegacySupabaseBinding(env.VITE_SUPABASE_ANON_KEY, "anon");
  return { hostname: env.VERCEL_URL, databaseOrigin: testDatabaseOrigin, workspaceId: expectedWorkspaceId };
}

export const operatorPreviewRoutes = Object.freeze({
  "auth-context": Object.freeze(["GET"]),
  "operator-account": Object.freeze(["GET"]),
  "operator-inbox": Object.freeze(["GET", "PATCH"]),
  "operator-handoffs": Object.freeze(["GET", "POST", "PATCH"]),
  "operator-leads": Object.freeze(["GET", "PATCH"]),
  "operator-workday": Object.freeze(["GET"]),
  "operator-lead-search": Object.freeze(["POST"]),
  "operator-services": Object.freeze(["GET"]),
  "operator-bookings": Object.freeze(["GET", "POST"]),
  "operator-arrivals": Object.freeze(["GET", "PATCH"]),
  "operator-directory": Object.freeze(["GET"]),
  "clinic-operator-requests": Object.freeze(["GET", "POST", "PATCH"]),
  "clinic-operator-leads": Object.freeze(["GET", "PATCH"]),
  "clinic-operator-arrivals": Object.freeze(["GET", "POST"]),
  "leads": Object.freeze(["GET"]),
});

function refuse(res, status, code) {
  return res.status(status).json({ success: false, error: code });
}

export function createOperatorPreviewHandler(loadCrm, environment = () => process.env, expectedProjectId = qaProjectId,
  expectedWorkspaceId = qaWorkspaceId) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("X-Content-Type-Options", "nosniff");
    let hostname;
    try { ({ hostname } = requireOperatorPreview(environment(), "runtime", expectedProjectId, expectedWorkspaceId)); }
    catch { return refuse(res, 503, "operator_preview_unavailable"); }
    if (req.headers.host !== hostname || (req.headers.origin && req.headers.origin !== "https://" + hostname)) {
      return refuse(res, 404, "not_found");
    }

    const url = typeof req.url === "string" ? req.url.split("?", 1)[0] : "";
    const routeFromUrl = /^\/api\/crm\/([a-z-]+)$/.exec(url)?.[1];
    const rewritten = ["/api/crm/[...path].ts", "/api/crm/%5B...path%5D.ts"].includes(url);
    const rawPath = req.query?.path;
    const routeFromQuery = typeof rawPath === "string" ? rawPath
      : Array.isArray(rawPath) && rawPath.length === 1 ? rawPath[0] : undefined;
    const route = routeFromUrl || routeFromQuery;
    if ((!routeFromUrl && !rewritten) || (rawPath !== undefined && (!routeFromQuery || routeFromQuery !== route))
      || typeof route !== "string" || !Object.hasOwn(operatorPreviewRoutes, route)) {
      return refuse(res, 404, "not_found");
    }
    if (!operatorPreviewRoutes[route].includes(req.method)) return refuse(res, 405, "method_not_allowed");
    req.query = { ...req.query, path: [route] };
    const crm = await loadCrm();
    return crm(req, res);
  };
}
