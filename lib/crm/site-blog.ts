import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";
import { validateBlogWrite, type BlogDraft } from "../site/blog";

// Select * keeps draft CRUD compatible before optional migration 060. Only the
// explicit DTO below can leave the server; list responses still omit body.
const columns = "*";
const fullColumns = columns;
function dto(row: Record<string, unknown>): BlogDraft {
  return { id: String(row.id), locale: "ru", slug: String(row.slug), title: String(row.title),
    excerpt: String(row.excerpt), body: String(row.body ?? ""), status: "draft",
    version: Number(row.version), updatedAt: String(row.updated_at),
    publishedAt: typeof row.published_at === "string" ? row.published_at : null,
    publishedVersion: typeof row.published_version === "number" ? row.published_version : null,
    publishedSlug: row.published_snapshot && typeof row.published_snapshot === "object"
      && "slug" in row.published_snapshot && typeof row.published_snapshot.slug === "string"
      ? row.published_snapshot.slug : null };
}

export async function handleSiteBlog(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  const reply = (status: number, payload: unknown) => res.status(status).json(payload);
  const fail = (status: number, code: string) => reply(status, { success: false, code });
  const context = readWorkspaceContext(req);
  if (!context) return fail(401, "authentication_required");
  if (context.role !== "owner" && context.role !== "admin") return fail(403, "workspace_access_denied");
  const client = getSupabaseServerClient();
  if (!client) return fail(503, "blog_unavailable");
  const dbError = (error: { code?: string } | null) => error?.code === "23505"
    ? fail(409, "blog_conflict")
    : fail(503, ["PGRST205", "42P01", "42703"].includes(error?.code || "") ? "blog_not_configured" : "blog_unavailable");
  try {
    if (req.method === "GET") {
      if (req.query.id !== undefined) {
        if (typeof req.query.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.query.id)) return fail(400, "invalid_request");
        const { data, error } = await client.from("site_blog_posts").select(fullColumns)
          .eq("workspace_id", context.workspaceId).eq("id", req.query.id).maybeSingle();
        if (error) return dbError(error);
        return data ? reply(200, { success: true, data: dto(data) }) : fail(404, "blog_not_found");
      }
      const rawOffset = req.query.offset ?? "0";
      if (typeof rawOffset !== "string" || !/^\d{1,6}$/.test(rawOffset)) return fail(400, "invalid_request");
      const offset = Number(rawOffset);
      const { data, error } = await client.from("site_blog_posts").select(columns)
        .eq("workspace_id", context.workspaceId).order("updated_at", { ascending: false }).order("id")
        .range(offset, offset + 20);
      if (error) return dbError(error);
      const rows = Array.isArray(data) ? data : [];
      return reply(200, { success: true, data: rows.slice(0, 20).map(row => {
        const { body: _body, ...summary } = dto(row); return summary;
      }), hasMore: rows.length > 20 });
    }
    if (req.method !== "POST" && req.method !== "PATCH") return fail(405, "method_not_allowed");
    if (req.method === "PATCH" && req.body?.action !== undefined) {
      const body = req.body as Record<string, unknown>;
      if (Object.keys(body).some(key => !["id", "version", "action"].includes(key))
        || typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id)
        || !Number.isInteger(body.version) || Number(body.version) < 1
        || !["publish", "unpublish"].includes(String(body.action))) return fail(400, "invalid_request");
      const { data, error } = await client.rpc("set_site_blog_publication", {
        p_workspace_id: context.workspaceId, p_post_id: body.id,
        p_version: body.version, p_publish: body.action === "publish",
      });
      if (error?.code === "40001" || error?.code === "23505") return fail(409, "blog_conflict");
      if (error?.code === "22023") return fail(400, "incomplete_article");
      if (error?.code === "PGRST202" || error?.code === "42883") return fail(503, "publication_not_configured");
      if (error) return dbError(error);
      return reply(200, { success: true, data: dto(data) });
    }
    const input = validateBlogWrite(req.body, req.method === "PATCH");
    if (!input) return fail(400, "invalid_blog_draft");
    if (req.method === "POST") {
      const { data, error } = await client.from("site_blog_posts").insert({
        ...input.fields, id: input.id, workspace_id: context.workspaceId,
      }).select(fullColumns).single();
      if (error?.code === "23505") {
        // A lost create response can be retried with the same id and exact draft.
        const existing = await client.from("site_blog_posts").select(fullColumns)
          .eq("workspace_id", context.workspaceId).eq("id", input.id).maybeSingle();
        const saved: Record<string, unknown> | null = existing.data;
        if (!existing.error && saved && saved.version === 1
          && Object.entries(input.fields).every(([key, value]) => saved[key] === value)) {
          return reply(200, { success: true, data: dto(saved) });
        }
      }
      if (error) return dbError(error);
      return reply(201, { success: true, data: dto(data) });
    }
    const { data, error } = await client.from("site_blog_posts").update({
      ...input.fields, version: input.version! + 1, updated_at: new Date().toISOString(),
    }).eq("workspace_id", context.workspaceId).eq("id", input.id).eq("version", input.version!)
      .select(fullColumns).maybeSingle();
    if (error) return dbError(error);
    return data ? reply(200, { success: true, data: dto(data) }) : fail(409, "blog_conflict");
  } catch { return fail(503, "blog_unavailable"); }
}
