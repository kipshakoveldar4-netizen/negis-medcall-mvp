export type ContributorStatus = "pending" | "approved" | "suspended";
export type ContributorRole = "partner" | "creator";
export type ContributorProfile = {
  id: string;
  revision: string;
  displayName: string;
  portfolioUrls: string[];
  partnerStatus: ContributorStatus | null;
  creatorStatus: ContributorStatus | null;
};
export const CONTRIBUTOR_PAGE_SIZE = 20;
export const contributorStatusLabels: Record<ContributorStatus, string> = {
  pending: "На рассмотрении", approved: "Одобрено", suspended: "Приостановлено",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function publicPortfolioUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !url.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname)
      || /^[\d.:\[\]]+$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
export function parseContributorProfile(value: unknown): ContributorProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const status = (v: unknown) => v === null || v === "pending" || v === "approved" || v === "suspended";
  if (typeof row.id !== "string" || !uuid.test(row.id) || typeof row.revision !== "string" || !uuid.test(row.revision)
    || typeof row.displayName !== "string" || !row.displayName.trim() || row.displayName.length > 120 || /[\u0000-\u001f\u007f]/.test(row.displayName)
    || !status(row.partnerStatus) || !status(row.creatorStatus) || (row.partnerStatus === null && row.creatorStatus === null)
    || !Array.isArray(row.portfolioUrls) || row.portfolioUrls.length > 5 || new Set(row.portfolioUrls).size !== row.portfolioUrls.length
    || !row.portfolioUrls.every(url => publicPortfolioUrl(url) === url)) return null;
  return { id: row.id, revision: row.revision, displayName: row.displayName,
    portfolioUrls: [...row.portfolioUrls], partnerStatus: row.partnerStatus as ContributorStatus | null,
    creatorStatus: row.creatorStatus as ContributorStatus | null };
}
export function parseContributorApplication(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["displayName", "partner", "creator", "portfolioUrls"].includes(key))
    || typeof row.displayName !== "string" || !row.displayName.trim() || row.displayName.trim().length > 120
    || /[\u0000-\u001f\u007f]/.test(row.displayName) || typeof row.partner !== "boolean" || typeof row.creator !== "boolean"
    || (!row.partner && !row.creator) || !Array.isArray(row.portfolioUrls) || row.portfolioUrls.length > 5) return null;
  const urls = row.portfolioUrls.map(publicPortfolioUrl);
  if (urls.some(url => url === null) || new Set(urls).size !== urls.length) return null;
  return { displayName: row.displayName.trim(), partner: row.partner, creator: row.creator, portfolioUrls: urls as string[] };
}
