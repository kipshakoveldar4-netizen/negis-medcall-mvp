import { createElement, type ReactNode } from "react";
import { parseArticleBody, type ArticleNode } from "../../../../../lib/site/article";

function renderNodes(nodes: ArticleNode[]): ReactNode[] {
  return nodes.map((node, index) => typeof node === "string" ? node : createElement(node.tag, {
    key: index,
    ...(node.tag === "a" && node.href ? { href: node.href, rel: "noopener noreferrer" } : {}),
    ...(node.tag === "ol" ? { start: node.start } : {}),
  }, ...(node.tag === "br" ? [] : renderNodes(node.children))));
}

export function BlogArticleBody({ body }: { body: string }) {
  return createElement("div", {
    className: "min-w-0 [overflow-wrap:anywhere] [&_p]:mb-4 [&_p]:whitespace-pre-wrap [&_p]:leading-relaxed [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-3 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-2 [&_a]:text-[var(--negis-primary)] [&_a]:underline",
  }, ...renderNodes(parseArticleBody(body)));
}
