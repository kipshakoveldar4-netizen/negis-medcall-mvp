import MarkdownIt from "markdown-it";

export type ArticleTag = "p" | "h2" | "h3" | "ul" | "ol" | "li" | "strong" | "em" | "a" | "br";
export type ArticleNode = string | { tag: ArticleTag; children: ArticleNode[]; href?: string; start?: number };

export function safeArticleLink(href: string): boolean {
  if (!href || href.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(href)) return false;
  if (/^\/ru\/(?:[a-z0-9-]+\/)*(?:#[a-z0-9-]+)?$/.test(href)) return true;
  try {
    const url = new URL(href);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

const parserOptions = { html: false, linkify: false, typographer: false, maxNesting: 16 };
const parser = new MarkdownIt("zero", parserOptions)
  .enable(["heading", "list", "newline", "escape", "entity", "emphasis", "link"]);
const defaultLinkCheck = parser.validateLink;
parser.validateLink = href => defaultLinkCheck(href) && safeArticleLink(href);
type Token = ReturnType<typeof parser.parse>[number];
const tags = new Set<ArticleTag>(["p", "h2", "h3", "ul", "ol", "li", "strong", "em", "a"]);

// Both renderers receive only this allowlisted tree, never parser HTML or attributes.
function nodesFromTokens(tokens: Token[]): ArticleNode[] {
  const root: ArticleNode[] = [];
  const stack: ArticleNode[][] = [root];
  for (const token of tokens) {
    const target = stack[stack.length - 1];
    if (token.type === "inline") target.push(...nodesFromTokens(token.children || []));
    else if (token.type === "text") target.push(token.content);
    else if (token.type === "softbreak" || token.type === "hardbreak") target.push({ tag: "br", children: [] });
    else if (token.nesting === 1) {
      const tag = (/^h[1-6]$/.test(token.tag) ? (Number(token.tag.slice(1)) <= 2 ? "h2" : "h3") : token.tag) as ArticleTag;
      if (!tags.has(tag)) throw new Error("Unsupported article element");
      const node: Exclude<ArticleNode, string> = { tag, children: [] };
      const href = token.attrGet("href");
      if (tag === "a" && href && safeArticleLink(href)) node.href = href;
      if (tag === "ol") {
        const start = Number(token.attrGet("start") || "1");
        if (Number.isSafeInteger(start) && start > 0) node.start = start;
      }
      target.push(node);
      stack.push(node.children);
    } else if (token.nesting === -1 && stack.length > 1) stack.pop();
    else throw new Error("Unsupported article token");
  }
  return root;
}

export function parseArticleBody(text: string): ArticleNode[] {
  if (text.length > 30000) throw new Error("Article is too long");
  return nodesFromTokens(parser.parse(text, {}));
}
