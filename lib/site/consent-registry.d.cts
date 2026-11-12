export type SiteConsentNotice = Readonly<{
  version: string; text: string; purpose: string; policyRevision: string; policyUrl: string; sha256: string;
}>;
export type SiteConsentResolver = (version: unknown) => SiteConsentNotice | null;
export function createSiteConsentRegistry(notices: readonly SiteConsentNotice[]): SiteConsentResolver;
export const resolveSiteConsent: SiteConsentResolver;
