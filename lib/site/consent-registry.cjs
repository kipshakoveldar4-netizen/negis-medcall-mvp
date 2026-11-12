const { createHash } = require('node:crypto');

// Deliberately empty pending owner/legal approval. Neither env nor DB labels
// can approve a notice. The factory is also used with explicit synthetic data
// by local tests; there is no mutable registry or runtime override.
function createSiteConsentRegistry(notices) {
  const registry = new Map();
  for (const notice of notices) {
    if (!notice || typeof notice.version !== 'string' || !/^[a-zA-Z0-9._-]{1,40}$/.test(notice.version)
      || typeof notice.policyUrl !== 'string' || typeof notice.sha256 !== 'string'
      || registry.has(notice.version)
      || ['text', 'purpose', 'policyRevision'].some(key => typeof notice[key] !== 'string' || !notice[key].trim())) {
      throw new Error('site_consent_notice_invalid');
    }
    const url = new URL(notice.policyUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('site_consent_policy_invalid');
    const binding = [notice.version, notice.text, notice.purpose, notice.policyRevision, notice.policyUrl];
    const sha256 = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
    if (notice.sha256 !== sha256) throw new Error('site_consent_binding_invalid');
    registry.set(notice.version, Object.freeze({ version: notice.version, text: notice.text, purpose: notice.purpose,
      policyRevision: notice.policyRevision, policyUrl: notice.policyUrl, sha256 }));
  }
  return version => typeof version === 'string' ? registry.get(version) ?? null : null;
}

const resolveSiteConsent = createSiteConsentRegistry([]);
module.exports = { createSiteConsentRegistry, resolveSiteConsent };
