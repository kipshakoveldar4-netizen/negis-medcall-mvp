import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import MarkdownIt from "markdown-it";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, "docs/blog-drafts");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const { validateBlogWrite } = await load("lib/site/blog.ts") as {
  validateBlogWrite(value: unknown, updating: boolean): unknown;
};
const { parseArticleBody } = await load("lib/site/article.ts") as { parseArticleBody(body: string): unknown[] };
const { createPages, createSitemap } = createRequire(import.meta.url)(path.join(root, "artifacts/medina-site/render.cjs")) as {
  createPages(intake?: null, options?: Record<string, unknown>): Map<string, string>;
  createSitemap(pages: Map<string, string>, origin: string): string;
};
const filenames = (await readdir(directory)).filter(file => file.endsWith(".md") && file !== "README.md").sort();
const pendingFilenames = (await readdir(path.join(directory, "pending"))).filter(file => file.endsWith(".md")).sort();
const allEditorialFiles = [...filenames, ...pendingFilenames.map(file => path.join("pending", file))];
const markdown = new MarkdownIt("commonmark", { html: false });

// Editorial files are documents, not seeds: read title/intro using Markdown's
// block boundaries, then validate the existing editor contract entirely locally.
async function readDraft(file: string) {
  const source = (await readFile(path.join(directory, file), "utf8")).replaceAll("\r\n", "\n");
  const tokens = markdown.parse(source, {});
  assert.equal(tokens[0]?.type, "heading_open", file);
  assert.equal(tokens[0]?.tag, "h1", file);
  assert.equal(tokens[1]?.type, "inline", file);
  assert.equal(tokens[3]?.type, "paragraph_open", file);
  assert.equal(tokens[4]?.type, "inline", file);
  assert.ok(tokens[3].map, file);
  assert.equal(tokens.filter(token => token.type === "heading_open" && token.tag === "h1").length, 1, file);
  const draft = { title: tokens[1].content, excerpt: tokens[4].content,
    slug: path.basename(file, ".md"), locale: "ru",
    body: source.split("\n").slice(tokens[3].map[1]).join("\n").trim() };
  assert.ok(draft.body.startsWith("## "), file);
  assert.ok(validateBlogWrite({ ...draft, id: "00000000-0000-4000-8000-000000000001" }, false), file);
  return draft;
}

test("three editorial drafts match the editor contract and have distinct metadata", async () => {
  assert.deepEqual(filenames, ["clinic-advertising-report.md", "dentistry-first-contact.md", "salon-multiple-services-booking.md"]);
  const drafts = await Promise.all(filenames.map(readDraft));
  for (const key of ["title", "slug", "excerpt"] as const) assert.equal(new Set(drafts.map(draft => draft[key])).size, 3);
});

test("new search-led drafts stay separate from the three approved materials", async () => {
  assert.deepEqual(pendingFilenames, ["dentistry-advertising-proposal.md", "salon-booking-software-checklist.md"]);
  const drafts = await Promise.all(allEditorialFiles.map(readDraft));
  for (const key of ["title", "slug", "excerpt"] as const) {
    assert.equal(new Set(drafts.map(draft => draft[key])).size, allEditorialFiles.length);
  }
  const pending = await readDraft(path.join("pending", "salon-booking-software-checklist.md"));
  assert.match(pending.body, /вымышленные записи/);
  assert.match(pending.body, /не перечень функций/);
  assert.match(pending.body, /Неизвестную стоимость отметьте как вопрос, а не как ноль/);
});

test("dentistry proposal draft keeps responsibilities explicit without inventing outcomes", async () => {
  const draft = await readDraft(path.join("pending", "dentistry-advertising-proposal.md"));
  assert.match(draft.body, /Условная ситуация/);
  assert.match(draft.body, /Неизвестную стоимость не записывайте как ноль/);
  assert.match(draft.body, /на вымышленных данных в отдельной тестовой среде/);
  assert.match(draft.body, /Суммы в разных валютах сохраняйте отдельно/);
  assert.match(draft.body, /не готовый договор/);
  const headings = markdown.parse(draft.body, {}).filter(token => token.type === "heading_open" && token.tag === "h3");
  assert.equal(headings.length, 6);
});

for (const file of allEditorialFiles) {
  test(`editorial article renders safely with working links: ${file}`, async () => {
    const draft = await readDraft(file);
    const article = { ...draft, summary: draft.excerpt, nodes: parseArticleBody(draft.body) };
    const pages = createPages(null, { preview: false, indexable: false, articles: [article], origin: "https://site.example.invalid" });
    const html = pages.get(`/ru/blog/${draft.slug}/`);
    assert.ok(html);
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.ok((html.match(/<h2>/g) || []).length >= 4);
    assert.match(html, /name="robots" content="noindex,nofollow"/);
    assert.ok(html.includes(`name="description" content="${draft.excerpt}"`));
    assert.match(html, /href="\/ru\/#consultation"/);
    assert.match(html, /href="\/ru\/solutions\//);
    if (filenames.includes(file)) assert.match(html, /href="\/ru\/services\//);
    assert.doesNotMatch(html, /<script|<iframe|<svg|onerror=|access_token|service_role|workspace_id/i);
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (!href.startsWith("/ru/")) continue;
      const [route, anchor] = href.split("#");
      assert.ok(pages.has(route), `${file}: ${route}`);
      if (anchor) assert.ok(pages.get(route)!.includes(`id="${anchor}"`), `${file}: ${href}`);
    }
  });
}

test("local editorial files are absent from default public/preview pages and sitemap", async () => {
  const drafts = await Promise.all(allEditorialFiles.map(readDraft));
  for (const pages of [createPages(null, { preview: false }), createPages()]) {
    const sitemap = createSitemap(pages, "https://site.example.invalid");
    const html = [...pages.values()].join("\n");
    for (const draft of drafts) {
      assert.equal(pages.has(`/ru/blog/${draft.slug}/`), false);
      assert.equal(html.includes(draft.title), false);
      assert.equal(sitemap.includes(draft.slug), false);
    }
  }
});
