export function readFormSettings(env = process.env) {
  if (env.MEDINA_SITE_FORM_ENABLED !== 'true') return null;
  const origin = env.MEDINA_SITE_API_ORIGIN?.trim() || '';
  const siteKey = env.MEDINA_SITE_TURNSTILE_SITE_KEY?.trim() || '';
  const consentVersion = env.MEDINA_SITE_CONSENT_VERSION?.trim() || '';
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || !/^[a-zA-Z0-9_-]{10,100}$/.test(siteKey)
    || !/^[a-zA-Z0-9._-]{1,40}$/.test(consentVersion)) throw new Error('Incomplete public form configuration');
  return { endpoint: `${origin}/api/crm/site-inquiry`, siteKey, consentVersion };
}
