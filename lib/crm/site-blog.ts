import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";
import { validateBlogWrite, type BlogDraft } from "../site/blog";

const columns = "id,locale,slug,title,excerpt,status,version,updated_at";
const fullColumns = `${columns},body`;
function dto(row: Record<string, unknown>): BlogDraft {
  return { id: String(row.id), locale: "ru", slug: String(row.slug), title: String(row.title),
    excerpt: String(row.excerpt), body: String(row.body ?? ""), status: "draft",
    version: Number(row.version), updatedAt: String(row.updated_at) };
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
