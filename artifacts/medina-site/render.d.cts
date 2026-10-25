import type { ArticleNode } from "../../lib/site/article";
import type { SiteConsentResolver } from "../../lib/site/consent-registry.cjs";
export type PublicArticle = { slug: string; title: string; summary: string; body: string; category?: string; nodes?: ArticleNode[]; publishedAt?: string };
export type IntakeSettings = { endpoint: string; siteKey: string; consentVersion: string };
export function escapeHtml(value: unknown): string;
export function createPages(intake?: IntakeSettings | null, options?: {
  articles?: PublicArticle[]; preview?: boolean; indexable?: boolean; origin?: string; assetBase?: string;
}): Map<string, string>;
export function createSitemap(pages: Map<string, string>, origin: string, articles?: PublicArticle[]): string;
export function renderArticleNodes(nodes: ArticleNode[]): string;
export function createPageRenderer(resolveConsent?: SiteConsentResolver): typeof createPages;
