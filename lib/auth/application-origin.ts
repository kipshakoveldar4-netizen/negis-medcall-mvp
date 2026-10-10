function httpsOrigin(value: string): string {
  if (!/^https:\/\//i.test(value) || /[\s\\]/.test(value)) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

/** Auth links must not inherit Host, Origin or forwarding headers from a request. */
export function readApplicationOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MEDINA_APP_ORIGIN?.trim();
  if (configured) return httpsOrigin(configured);

  // Use this deployment, never VERCEL_PROJECT_PRODUCTION_URL in a Preview.
  const deployment = env.VERCEL_URL?.trim().toLowerCase() || "";
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+vercel\.app$/.test(deployment)) return "";
  return httpsOrigin(`https://${deployment}`);
}
