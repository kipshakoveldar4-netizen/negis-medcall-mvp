import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export type SyntheticNotice = Readonly<{ version: string; text: string; purpose: string;
  policyRevision: string; policyUrl: string; sha256: string }>;
export type ConsentResolver = (version: unknown) => SyntheticNotice | null;
const registry = createRequire(import.meta.url)("../../lib/site/consent-registry.cjs") as {
  createSiteConsentRegistry(notices: SyntheticNotice[]): ConsentResolver;
};

// Test-only dependency; never a production-approved legal revision.
export function syntheticSiteConsent(versions: readonly string[] = ["v1", "old"]): ConsentResolver {
  return registry.createSiteConsentRegistry(versions.map(version => {
    const notice = { version, text: `SYNTHETIC TEST NOTICE ${version} <not legal copy>`,
      purpose: "SYNTHETIC TEST PURPOSE", policyRevision: `SYNTHETIC-${version}`,
      policyUrl: `https://policy.fixture.invalid/revisions/${encodeURIComponent(version)}` };
    return { ...notice, sha256: createHash("sha256").update(JSON.stringify([
      notice.version, notice.text, notice.purpose, notice.policyRevision, notice.policyUrl,
    ])).digest("hex") };
  }));
}
