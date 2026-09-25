export type BlogDraftFields = { title: string; slug: string; excerpt: string; body: string; locale: "ru" };
export type BlogDraft = BlogDraftFields & { id: string; status: "draft"; version: number; updatedAt: string;
  publishedAt?: string | null; publishedVersion?: number | null; publishedSlug?: string | null };
export type BlogSummary = Omit<BlogDraft, "body">;
export const emptyBlogDraft = (): BlogDraftFields => ({ title: "", slug: "", excerpt: "", body: "", locale: "ru" });

export function validateBlogWrite(value: unknown, updating: boolean):
  { fields: BlogDraftFields; id: string; version?: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = ["title", "slug", "excerpt", "body", "locale", "id", ...(updating ? ["version"] : [])];
  if (Object.keys(body).some(key => !keys.includes(key))) return null;
  if (typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id)
    || body.locale !== "ru") return null;
  for (const [key, max] of [["title", 200], ["slug", 100], ["excerpt", 500], ["body", 30000]] as const) {
    const text = body[key];
    if (typeof text !== "string" || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
  }
  const fields: BlogDraftFields = {
    title: (body.title as string).trim(), slug: (body.slug as string).trim(),
    excerpt: (body.excerpt as string).trim(), body: (body.body as string).trim(), locale: "ru",
  };
  if (!fields.title || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.slug)) return null;
  if (updating && (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 1 || body.version >= 2147483647)) return null;
  return { fields, id: body.id, ...(updating ? { version: body.version as number } : {}) };
}
