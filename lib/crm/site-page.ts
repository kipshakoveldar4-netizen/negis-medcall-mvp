import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { createPages, createSitemap, type PublicArticle } from "../../artifacts/medina-site/render.mjs";
import { readSiteIntakeConfig } from "./site-intake-handler";

export function publicSiteConfig(env: Record<string, string | undefined> = process.env) {
  if (env.MEDINA_PUBLIC_SITE_ENABLED !== "true") return null;
  const workspaceId = env.MEDINA_PUBLIC_SITE_WORKSPACE_ID || "";
  const origin = env.MEDINA_SITE_ORIGIN || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) return null;
  try { if (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin) return null; }
  catch { return null; }
  return { workspaceId, origin, indexable: env.MEDINA_SITE_INDEXABLE === "true" };
}

export function publicArticle(value: unknown): PublicArticle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.locale !== "ru" || typeof row.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug)
    || row.slug.length > 100 || typeof row.title !== "string" || !row.title.trim() || row.title.length > 200
    || typeof row.excerpt !== "string" || row.excerpt.length > 500
    || typeof row.body !== "string" || row.body.length > 30000) return null;
  return { slug: row.slug, title: row.title, summary: row.excerpt, body: row.body };
}

// Isolated public read surface. No caller-selected tenant, draft fields or IDs.
export async function handleSitePage(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const end = (status: number, body: string) => res.status(status).end(req.method === "HEAD" ? undefined : body);
  if (req.method !== "GET" && req.method !== "HEAD") { res.setHeader("Allow", "GET, HEAD"); return end(405, "Method not allowed"); }
  const config = publicSiteConfig();
  if (!config) return end(404, "Страница недоступна.");
  // Advertising tags may arrive on landing URLs. Ignore them: never store,
  // echo or include them in canonical URLs. Tenant selectors remain forbidden.
  const ignoredTags = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id", "fbclid", "gclid", "ttclid"];
  if (Object.keys(req.query).some(key => !["path", "page", ...ignoredTags].includes(key))
    || ignoredTags.some(key => req.query[key] !== undefined && (typeof req.query[key] !== "string" || req.query[key]!.length > 512))) return end(400, "Некорректный адрес.");
  const route = req.query.page;
  if (typeof route !== "string" || route.length > 200 || (!/^\/ru\/(?:[a-z0-9-]+\/)*$/.test(route) && !["/ru/sitemap.xml", "/ru/robots.txt"].includes(route))) {
    return end(404, "Страница не найдена.");
  }
  if (route === "/ru/robots.txt") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return end(200, config.indexable
      ? `User-agent: *\nDisallow: /\nAllow: /ru/\nSitemap: ${config.origin}/ru/sitemap.xml\n`
      : "User-agent: *\nDisallow: /\n");
  }
  try {
    const client = getSupabaseServerClient();
    if (!client) return end(503, "Сайт временно недоступен. Попробуйте позже.");
    // Bounded catalogue: exceeding the MVP cap fails instead of hiding articles.
    const { data, error } = await client.from("site_blog_posts")
      .select("published_snapshot").eq("workspace_id", config.workspaceId)
      .not("published_snapshot", "is", null).order("published_at", { ascending: false }).order("id").limit(201);
    if (error || !Array.isArray(data) || data.length > 200) return end(503, "Сайт временно недоступен. Попробуйте позже.");
    const articles = data.map(row => publicArticle(row.published_snapshot));
    if (articles.some(row => !row)) return end(503, "Сайт временно недоступен. Попробуйте позже.");
    // Form activation also requires the DB mapping to match this public site.
    let intake = null;
    const intakeConfig = readSiteIntakeConfig(process.env);
    const publicKey = process.env.MEDINA_SITE_TURNSTILE_SITE_KEY || "";
    if (process.env.MEDINA_SITE_FORM_ENABLED === "true" && intakeConfig && intakeConfig.origin === config.origin
      && /^[a-zA-Z0-9_-]{10,100}$/.test(publicKey)) {
      const site = await client.from("crm_intake_sites").select("workspace_id,enabled,consent_version,allowed_page_paths")
        .eq("site_key", intakeConfig.siteKey).maybeSingle();
      if (!site.error && site.data?.enabled === true && site.data.workspace_id === config.workspaceId
        && typeof site.data.consent_version === "string" && /^[a-zA-Z0-9._-]{1,40}$/.test(site.data.consent_version)
        && Array.isArray(site.data.allowed_page_paths) && site.data.allowed_page_paths.includes("/ru/")) {
        intake = { endpoint: `${config.origin}/api/crm/site-inquiry`, siteKey: publicKey, consentVersion: site.data.consent_version };
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      }
    }
    const pages = createPages(intake, { articles: articles as PublicArticle[], preview: false,
      origin: config.origin, indexable: config.indexable, assetBase: "/medina-site" });
    if (route === "/ru/sitemap.xml") {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      return end(200, createSitemap(pages, config.origin));
    }
    const html = pages.get(route);
    if (html && config.indexable) res.setHeader("X-Robots-Tag", "index, follow");
    return end(html ? 200 : 404, html || pages.get("/404.html")!);
  } catch { return end(503, "Сайт временно недоступен. Попробуйте позже."); }
}
