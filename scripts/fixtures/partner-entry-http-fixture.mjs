import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), require = createRequire(path.join(root, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json', { paths: [path.join(root, 'artifacts/negis')] }))('esbuild');
export const ENTRY_ORIGIN = 'https://entry.fixture.invalid';
export const ENTRY_ACTOR = '11111111-1111-4111-8111-111111111111', ENTRY_OTHER = '22222222-2222-4222-8222-222222222222';
const base = { version: 'owned-partner-v1', purpose: 'partner_attribution', text: 'SYNTHETIC PARTNER NOTICE, NOT LEGAL COPY',
  policyRevision: 'owned-only', policyUrl: 'https://policy.fixture.invalid/partner' };
const notice = { ...base, sha256: createHash('sha256').update(JSON.stringify([base.version, base.text, base.purpose, base.policyRevision, base.policyUrl])).digest('hex') };
const companyBase = { ...base, version: 'owned-company-v1', purpose: 'partner_company_registration', text: 'SYNTHETIC COMPANY NOTICE, NOT LEGAL COPY' };
const companyNotice = { ...companyBase, sha256: createHash('sha256').update(JSON.stringify([companyBase.version, companyBase.text, companyBase.purpose, companyBase.policyRevision, companyBase.policyUrl])).digest('hex') };
const codeCache = new Map();
export const stopPartnerEntryBuilds = () => esbuild.stop();
export async function partnerEntryHttpFixture(adapter, options = {}) {
  const approval = options.approved !== false;
  const entrypoint=options.entrypoint??'crm';assert.ok(['crm','content-studio'].includes(entrypoint));
  const company = options.company === true;
  const cacheKey=approval+':'+entrypoint+':'+company;
  if (!codeCache.has(cacheKey)) codeCache.set(cacheKey, (await esbuild.build({ stdin: {
    contents: `export {default as handler} from ${JSON.stringify(path.join(root, 'api',entrypoint,'[...path].ts'))};
      export {setSupabaseServerClientFactoryForTests as install} from ${JSON.stringify(path.join(root, 'lib/supabase/server.ts'))};
      export * as cookies from ${JSON.stringify(path.join(root, 'lib/crm/partner-entry-cookie.ts'))};
      export * as terms from ${JSON.stringify(path.join(root, 'lib/crm/partner-terms-contracts.ts'))};`, loader: 'ts', resolveDir: root },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', target: 'node22', logLevel: 'silent',
    plugins: [{ name: 'synthetic-approved-notice-data-only', setup(build) {
      if (approval) build.onLoad({ filter: /consent-registry\.cjs$/ }, async args => {
        const original = await readFile(args.path, 'utf8'), marker = 'const resolveSiteConsent = createSiteConsentRegistry([]);';
        assert.equal(original.split(marker).length, 2, 'Only the approval DATA is synthetic; registry and handler implementation remain real');
        return { contents: original.replace(marker, 'const resolveSiteConsent = createSiteConsentRegistry(' + JSON.stringify(company ? [notice,companyNotice] : [notice]) + ');'), loader: 'js' };
      });
    } }] })).outputFiles[0].text);
  const env = { NODE_ENV: 'test', SUPABASE_URL: 'https://entry-auth.fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'owned-only-not-credential',
    MEDINA_PARTNER_ENTRY_ENABLED: 'true', MEDINA_APP_ORIGIN: ENTRY_ORIGIN, MEDINA_PARTNER_ENTRY_COOKIE_KEY: 'ab'.repeat(32),
    MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET: 'owned-turnstile-not-credential', MEDINA_PARTNER_ENTRY_TURNSTILE_SITE_KEY: 'owned-public-site-key',
    MEDINA_PARTNER_ENTRY_CONSENT_VERSION: notice.version,
    ...(company ? { MEDINA_PARTNER_COMPANY_ENABLED: 'true', MEDINA_PARTNER_COMPANY_CONSENT_VERSION: companyNotice.version } : {}), ...options.env };
  const state = { auth: [], challenges: [], unexpected: [], authUnavailable: false, challenge: { success: true, hostname: 'entry.fixture.invalid', action: 'partner_entry' }, challengeStatus: 200, challengeBytes: null, heldChallenge: null, holdChallenge: false };
  const processView = Object.create(process); Object.defineProperty(processView, 'env', { value: env }); const module = { exports: {} };
  const request = async (url, init) => {
    if (url === env.SUPABASE_URL + '/auth/v1/user') {
      state.auth.push(init.headers.Authorization); assert.equal(init.redirect, 'error');
      if (state.authUnavailable) throw Error('PRIVATE_AUTH_FIXTURE_DIAGNOSTIC');
      const identities = options.identities ?? new Map([['owned.owner.signature', ENTRY_ACTOR], ['owned.other.signature', ENTRY_OTHER]]);
      const token = init.headers.Authorization?.replace(/^Bearer /, ''), actor = identities.get(token);
      const user = options.authUsers?.has(token) ? options.authUsers.get(token) : actor ? { id: actor } : null;
      return new Response(JSON.stringify(user ?? { message: 'PRIVATE_AUTH_FIXTURE_DIAGNOSTIC' }), { status: user ? 200 : 401 });
    }
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      assert.equal(init.redirect, 'error'); assert.equal(init.method, 'POST'); assert.equal(JSON.parse(init.body).secret, env.MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET);
      state.challenges.push(JSON.parse(init.body).response);
      if (state.holdChallenge) { state.holdChallenge = false; await new Promise(resolve => { state.heldChallenge = resolve; }); }
      return new Response(state.challengeBytes ?? JSON.stringify(state.challenge), { status: state.challengeStatus });
    }
    if (entrypoint==='content-studio' && options.telegramFetch
      && /^synthetic-/.test(env.TELEGRAM_BOT_TOKEN??'')
      && ['getChat','sendMessage'].some(method=>url===`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`)) {
      return options.telegramFetch(url,init);
    }
    state.unexpected.push(String(url)); throw Error('Unapproved network boundary');
  };
  new Script(codeCache.get(cacheKey), { filename: 'owned-partner-entry-router.cjs' }).runInNewContext({ module, exports: module.exports, require,
    process: processView, fetch: request, Buffer, URL, URLSearchParams, AbortController, AbortSignal, DOMException, TextEncoder, TextDecoder,
    Request, Response, Headers, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, console,
    __dirname: root, __filename: path.join(root, 'owned-partner-entry-router.cjs') });
  module.exports.install(() => adapter);
  return { ...module.exports, env, state, notice, companyNotice, close() { module.exports.install(null); state.heldChallenge?.(); }, release() { state.heldChallenge?.(); state.heldChallenge = null; } };
}
