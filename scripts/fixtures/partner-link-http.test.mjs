import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ACTOR, ENTRY_OTHER, ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';

after(stopPartnerEntryBuilds);
const profile = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const profileRevision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const agreementRevision = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const referralCode = 'A0123456789BCDEF'.repeat(2);
const policyVersion = '2026-10-27-7d-self-v1';
const rpcKeys = ['p_actor', 'p_side', 'p_profile', 'p_request', 'p_close', 'p_action'].sort();
function snapshot(state = 'accepted') {
  return { profileId: profile, profileRevision, state: 'managed', agreement: {
    revision: agreementRevision, state, firstCommissionBps: 1250, renewalCommissionBps: 650,
    terms: 'SYNTHETIC ACCEPTED TERMS, NOT A REAL AGREEMENT', offeredAt: '2026-10-27T01:00:00.000000Z',
    decidedAt: state === 'pending' ? null : '2026-10-27T02:00:00.000001Z',
    commercialStatus: state === 'accepted' ? 'active' : null, referralCode: state === 'accepted' ? referralCode : null,
  } };
}
function expectedLink(value = snapshot(), origin = ENTRY_ORIGIN) {
  return { success: true, data: { profileId: value.profileId, profileRevision: value.profileRevision,
    agreementRevision: value.agreement.revision, referralCode: value.agreement.referralCode,
    url: `${origin}/r/${value.agreement.referralCode}`, policyVersion } };
}
function response() {
  return { statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(v) { this.statusCode = v; return this; },
    json(v) { this.body = JSON.parse(JSON.stringify(v)); return this; },
    end(v) { this.body = v; return this; },
  };
}
function assertPrivate(f, res, cache = true) {
  if (cache) assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['set-cookie'], undefined);
  const raw = JSON.stringify(res.body) ?? '';
  for (const marker of ['PRIVATE_', 'owned-only-not-credential', 'owned.owner.signature', 'owned.other.signature',
    f.env.MEDINA_PARTNER_ENTRY_COOKIE_KEY, f.env.MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET].filter(v => typeof v === 'string' && v.length)) {
    assert.ok(!raw.includes(marker), 'No credentials or private diagnostics in response');
  }
  assert.deepEqual(f.state.unexpected, []);
  assert.deepEqual(f.state.challenges, [], 'Link retrieval never attempts a challenge/provider');
}
async function setup(options = {}) {
  const state = { calls: [], forbidden: [], value: snapshot(), error: null, thrown: null, rawResult: undefined,
    allowedActor: ENTRY_ACTOR, allowedProfile: profile };
  const adapter = new Proxy({ async rpc(name, args) {
    state.calls.push({ name, args: structuredClone(args) });
    if (name !== 'read_growth_partner_terms' || JSON.stringify(Object.keys(args).sort()) !== JSON.stringify(rpcKeys)
      || args.p_side !== 'partner' || args.p_request !== null || args.p_close !== false || args.p_action !== null) {
      state.forbidden.push({ name, args }); throw Error('PRIVATE_UNEXPECTED_RPC');
    }
    if (state.thrown) throw state.thrown;
    if (state.rawResult !== undefined) return state.rawResult;
    if (args.p_actor !== state.allowedActor || String(args.p_profile).toLowerCase() !== state.allowedProfile.toLowerCase())
      return { data: null, error: { code: 'P1141', message: 'PRIVATE_FOREIGN_PROFILE' } };
    return { data: state.value, error: state.error };
  } }, { get(target, key, receiver) {
    if (key === 'rpc') return Reflect.get(target, key, receiver);
    state.forbidden.push(String(key)); throw Error('PRIVATE_DIRECT_DB_ACCESS');
  } });
  const f = await partnerEntryHttpFixture(adapter, options);
  async function call({ method = 'GET', token = 'owned.owner.signature', query = {}, headers = {}, body,
    path = ['partner-link'], cache = true } = {}) {
    const req = Readable.from([]);
    Object.assign(req, { method, url: '/api/crm/' + (Array.isArray(path) ? path.join('/') : path),
      query: { path, profileId: profile, ...query }, headers: { origin: ENTRY_ORIGIN, 'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers } });
    if (body !== undefined) req.body = body;
    const res = response(); await f.handler(req, res); assertPrivate(f, res, cache);
    assert.deepEqual(state.forbidden, []); return res;
  }
  return { f, state, call, close() {
    f.close(); assert.deepEqual(state.forbidden, []); assert.deepEqual(f.state.unexpected, []); assert.deepEqual(f.state.challenges, []);
  } };
}
function assertFailure(res, status, code) {
  assert.equal(res.statusCode, status);
  assert.deepEqual(res.body, { success: false, code });
  assert.ok(!JSON.stringify(res.body).includes(referralCode));
}

test('actual compiled router returns only the accepted active link through the exact partner read RPC', async () => {
  const x = await setup(); try {
    assert.ok(x.f.terms.parsePartnerTermsSnapshot(x.state.value));
    const res = await x.call(); assert.equal(res.statusCode, 200); assert.deepEqual(res.body, expectedLink());
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(x.state.calls, [{ name: 'read_growth_partner_terms', args: { p_actor: ENTRY_ACTOR,
      p_side: 'partner', p_profile: profile, p_request: null, p_close: false, p_action: null } }]);
    assert.ok(x.f.state.auth.length > 0); assert.ok(x.f.state.auth.every(v => v === 'Bearer owned.owner.signature'));
  } finally { x.close(); }
});

test('verified Auth identity wins over JWT claims and browser actor or workspace headers', async () => {
  const token = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.'
    + Buffer.from(JSON.stringify({ sub: ENTRY_OTHER, actor: ENTRY_OTHER, workspaceId: ENTRY_OTHER })).toString('base64url') + '.synthetic';
  const x = await setup({ identities: new Map([[token, ENTRY_ACTOR], ['owned.other.signature', ENTRY_OTHER]]) }); try {
    const headers = { 'x-actor-id': ENTRY_OTHER, 'x-user-id': ENTRY_OTHER, 'x-workspace-id': ENTRY_OTHER,
      'x-forwarded-user': ENTRY_OTHER, cookie: 'actor=' + ENTRY_OTHER + '; workspaceId=' + ENTRY_OTHER };
    assert.equal((await x.call({ token, headers })).statusCode, 200);
    assert.equal(x.state.calls.at(-1).args.p_actor, ENTRY_ACTOR);
    assert.ok(x.f.state.auth.includes('Bearer ' + token));
    x.state.allowedActor = ENTRY_OTHER;
    assert.equal((await x.call({ token: 'owned.other.signature', headers: { 'x-actor-id': ENTRY_ACTOR } })).statusCode, 200);
    assert.equal(x.state.calls.at(-1).args.p_actor, ENTRY_OTHER);
  } finally { x.close(); }
});

test('anonymous, malformed, unverified and unavailable Auth fail closed with no-store before any RPC', async () => {
  const x = await setup(); try {
    for (const options of [{ token: null }, { token: '' }, { token: 'not-a-jwt' }, { token: 'owned.unknown.signature' },
      { token: null, headers: { authorization: 'Basic owned.owner.signature', 'x-actor-id': ENTRY_ACTOR } },
      { headers: { authorization: 'Bearer owned.owner.signature extra' } }]) {
      const res = await x.call(options); assert.equal(res.statusCode, 401); assert.equal(res.body.success, false);
      assert.equal(res.body.data, undefined);
    }
    x.f.state.authUnavailable = true;
    const res = await x.call(); assert.equal(res.statusCode, 503); assert.equal(res.body.success, false);
    assert.equal(res.body.data, undefined); assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('foreign verified actor and foreign profile selector are denied by the identity-bound RPC, never a fallback', async () => {
  const x = await setup(); try {
    assertFailure(await x.call({ token: 'owned.other.signature' }), 403, 'partner_link_access_denied');
    assert.equal(x.state.calls.at(-1).args.p_actor, ENTRY_OTHER);
    assertFailure(await x.call({ query: { profileId: ENTRY_OTHER } }), 403, 'partner_link_access_denied');
    assert.equal(x.state.calls.at(-1).args.p_profile, ENTRY_OTHER);
    assert.equal(x.state.calls.length, 2);
  } finally { x.close(); }
});

test('exact query rejects malformed profile selectors and all browser authority or URL selectors before RPC', async () => {
  const x = await setup(); try {
    for (const profileId of [undefined, null, '', 'not-a-uuid', [profile], [profile, ENTRY_OTHER], {}, 1, true])
      assertFailure(await x.call({ query: { profileId } }), 400, 'invalid_partner_link_query');
    for (const [key, value] of [['actor', ENTRY_OTHER], ['side', 'platform'], ['workspaceId', ENTRY_OTHER],
      ['staffId', ENTRY_OTHER], ['code', referralCode], ['referralCode', referralCode], ['requestId', agreementRevision],
      ['profileRevision', profileRevision], ['url', 'https://foreign.fixture.invalid/r/' + referralCode],
      ['origin', 'https://foreign.fixture.invalid'], ['access_token', 'owned.owner.signature']])
      assertFailure(await x.call({ query: { [key]: value } }), 400, 'invalid_partner_link_query');
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('preparsed GET bodies cannot select an actor, workspace, code, revision or copied URL', async () => {
  const x = await setup(); try {
    for (const body of [{ actor: ENTRY_OTHER }, { workspaceId: ENTRY_OTHER }, { profileId: ENTRY_OTHER },
      { code: referralCode }, { url: 'https://foreign.fixture.invalid' }, { profileRevision }, [], [profile], 'bad', 1, true])
      assertFailure(await x.call({ body }), 400, 'invalid_partner_link_query');
    assert.equal(x.state.calls.length, 0);
    assert.equal((await x.call({ body: {} })).statusCode, 200);
  } finally { x.close(); }
});

test('GET-only routing returns cold anonymous POST 405 before Auth and never dispatches unsupported methods', async () => {
  const x = await setup(); try {
    for (const token of [null, 'owned.owner.signature']) for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const res = await x.call({ method, token, body: { actor: ENTRY_OTHER } });
      assert.equal(res.statusCode, 405); assert.equal(res.body.success, false);
    }
    assert.equal(x.f.state.auth.length, 0); assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('unknown and malformed paths cannot dispatch the link read', async () => {
  const x = await setup(); try {
    for (const path of [['partner-link', 'extra'], ['partner-link', '..'], ['partner-link', '%2fextra'],
      ['partner-link-not-registered'], ['%ZZ']]) {
      const res = await x.call({ path, cache: false }); assert.equal(res.statusCode, 404); assert.equal(res.body.success, false);
    }
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('disabled or incomplete synthetic configuration and the empty canonical consent registry fail before RPC', async () => {
  const configurations = [{ approved: false }, ...[
    { MEDINA_PARTNER_ENTRY_ENABLED: '' }, { MEDINA_PARTNER_ENTRY_ENABLED: 'false' }, { MEDINA_PARTNER_ENTRY_ENABLED: 'TRUE' },
    { MEDINA_PARTNER_ENTRY_COOKIE_KEY: '' }, { MEDINA_PARTNER_ENTRY_COOKIE_KEY: 'not-a-key' },
    { MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET: '' }, { MEDINA_PARTNER_ENTRY_TURNSTILE_SITE_KEY: '' },
    { MEDINA_PARTNER_ENTRY_CONSENT_VERSION: '' }, { MEDINA_PARTNER_ENTRY_CONSENT_VERSION: 'unapproved-owned-notice' },
    { MEDINA_APP_ORIGIN: '' }, { MEDINA_APP_ORIGIN: 'http://entry.fixture.invalid' },
    { MEDINA_APP_ORIGIN: 'https://user:pass@entry.fixture.invalid' }, { MEDINA_APP_ORIGIN: 'https://entry.fixture.invalid/path' },
    { MEDINA_APP_ORIGIN: ENTRY_ORIGIN + '?code=foreign' }, { MEDINA_APP_ORIGIN: ENTRY_ORIGIN + '#foreign' },
    { MEDINA_APP_ORIGIN: 'https://entry.fixture.invalid\\foreign' },
  ].map(env => ({ env }))];
  for (const options of configurations) {
    const x = await setup(options); try {
      assertFailure(await x.call(), 503, 'partner_link_unavailable'); assert.equal(x.state.calls.length, 0);
    } finally { x.close(); }
  }
});

test('valid pending, declined, cancelled, suspended, not-offered and unmanaged snapshots never expose a link', async () => {
  const x = await setup(); try {
    const suspended = snapshot(); suspended.agreement.commercialStatus = 'suspended'; suspended.agreement.referralCode = null;
    const values = ['pending', 'declined', 'cancelled'].map(snapshot).concat(suspended,
      ...['not_offered', 'legacy_unmanaged'].map(state => ({ profileId: profile, profileRevision, state, agreement: null })));
    for (const value of values) {
      assert.ok(x.f.terms.parsePartnerTermsSnapshot(value)); x.state.value = value;
      assertFailure(await x.call(), 409, 'partner_link_not_active');
    }
    assert.equal(x.state.calls.length, values.length);
  } finally { x.close(); }
});

test('strict RPC snapshot parsing rejects invalid code, identity, negotiation, decisions and private extra fields', async () => {
  const x = await setup(); try {
    const changes = [v => { v.profileId = 'bad'; }, v => { v.profileRevision = 'bad'; },
      v => { v.agreement.revision = 'bad'; }, v => { delete v.profileRevision; }, v => { delete v.agreement.referralCode; },
      v => { v.auth_user_id = ENTRY_OTHER; }, v => { v.agreement.owner = ENTRY_OTHER; },
      v => { v.agreement.commercialStatus = null; }, v => { v.agreement.commercialStatus = 'suspended'; },
      v => { v.agreement.state = 'pending'; }, v => { v.agreement.state = 'unknown'; },
      v => { v.agreement.decidedAt = null; }, v => { v.agreement.offeredAt = '2026-02-31T00:00:00Z'; },
      v => { v.agreement.offeredAt = '2026-10-27T02:00:00.000002Z'; },
      v => { v.agreement.firstCommissionBps = '1250'; }, v => { v.agreement.renewalCommissionBps = 0; },
      v => { v.agreement.terms = ''; }];
    for (const code of [null, '', 'a'.repeat(32), 'G'.repeat(32), 'A'.repeat(31), 'A'.repeat(33), ' ' + referralCode,
      referralCode + '\n', '../' + referralCode, 'https://foreign.fixture.invalid/r/' + referralCode, 123, [referralCode], {}])
      changes.push(v => { v.agreement.referralCode = code; });
    const values = [null, {}, [], [snapshot()], { success: true, data: snapshot() }, ...changes.map(change => {
      const value = snapshot(); change(value); return value;
    })];
    for (const value of values) {
      assert.equal(x.f.terms.parsePartnerTermsSnapshot(value), null); x.state.value = value;
      assertFailure(await x.call(), 503, 'partner_link_unconfirmed');
    }
    const foreign = snapshot(); foreign.profileId = ENTRY_OTHER;
    assert.ok(x.f.terms.parsePartnerTermsSnapshot(foreign)); x.state.value = foreign;
    assertFailure(await x.call(), 503, 'partner_link_unconfirmed');
    x.state.value = snapshot(); x.state.value.profileId = profile.toUpperCase();
    assert.equal((await x.call({ query: { profileId: profile.toUpperCase() } })).statusCode, 200);
  } finally { x.close(); }
});

test('RPC errors, exceptions, malformed envelopes and a missing client are sanitized without fallback or success', async () => {
  const x = await setup(); try {
    for (const code of ['P1141', 'P1142', 'P1143', 'P1144', 'P1145', '42P01', 'PRIVATE_UNKNOWN']) {
      x.state.error = { code, message: 'PRIVATE_SQL_DIAGNOSTIC', details: 'owned-only-not-credential' };
      assertFailure(await x.call(), code === 'P1141' ? 403 : 503,
        code === 'P1141' ? 'partner_link_access_denied' : 'partner_link_unconfirmed');
    }
    x.state.error = null; x.state.thrown = Error('PRIVATE_RPC_EXCEPTION');
    assertFailure(await x.call(), 503, 'partner_link_unconfirmed'); x.state.thrown = null;
    for (const result of [null, {}, { data: null, error: null }, { data: [snapshot()], error: null }]) {
      x.state.rawResult = result; assertFailure(await x.call(), 503, 'partner_link_unconfirmed');
    }
    const count = x.state.calls.length; x.f.install(() => null);
    assertFailure(await x.call(), 503, 'partner_link_unconfirmed'); assert.equal(x.state.calls.length, count);
  } finally { x.close(); }
});

test('HTTPS copied URL comes from normalized MEDINA_APP_ORIGIN, never request Origin, Host or forwarding headers', async () => {
  const x = await setup({ env: { MEDINA_APP_ORIGIN: 'https://LINKS.fixture.invalid:443/' } }); try {
    for (const headers of [{}, { origin: 'https://foreign.fixture.invalid', host: 'foreign.fixture.invalid',
      'x-forwarded-host': 'forwarded.fixture.invalid', 'x-forwarded-proto': 'http',
      forwarded: 'host=forwarded.fixture.invalid;proto=http', 'x-original-url': 'https://foreign.fixture.invalid/r/FAKE' }]) {
      const res = await x.call({ headers }); assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, expectedLink(snapshot(), 'https://links.fixture.invalid'));
    }
    assert.equal(x.state.calls.length, 2);
  } finally { x.close(); }
});

test('every read rechecks the current RPC snapshot; faults or suspension cannot reuse a previously confirmed link', async () => {
  const x = await setup(); try {
    assert.deepEqual((await x.call()).body, expectedLink());
    x.state.value = null; assertFailure(await x.call(), 503, 'partner_link_unconfirmed');
    x.state.value = snapshot(); x.state.value.agreement.commercialStatus = 'suspended'; x.state.value.agreement.referralCode = null;
    assertFailure(await x.call(), 409, 'partner_link_not_active');
    x.state.value = snapshot(); x.state.value.profileRevision = ENTRY_ACTOR; x.state.value.agreement.revision = ENTRY_OTHER;
    x.state.value.agreement.referralCode = 'B'.repeat(32);
    const res = await x.call(); assert.equal(res.statusCode, 200); assert.deepEqual(res.body, expectedLink(x.state.value));
    assert.equal(x.state.calls.length, 4);
  } finally { x.close(); }
});

async function loopback(handler) {
  const errors = [];
  const server = createServer(async (req, out) => {
    try {
      assert.equal(req.socket.remoteAddress, '127.0.0.1');
      const url = new URL(req.url, 'http://127.0.0.1');
      req.query = { path: url.pathname.slice('/api/crm/'.length).split('/') };
      for (const [key, value] of url.searchParams) req.query[key] = req.query[key] === undefined ? value
        : Array.isArray(req.query[key]) ? [...req.query[key], value] : [req.query[key], value];
      const res = { setHeader(k, v) { out.setHeader(k, v); return res; }, status(v) { out.statusCode = v; return res; },
        json(v) { out.setHeader('Content-Type', 'application/json; charset=utf-8'); out.end(JSON.stringify(v)); return res; },
        end(v) { out.end(v); return res; } };
      await handler(req, res);
    } catch (error) { errors.push(error.message); out.statusCode = 500; out.end('{"success":false}'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  assert.equal(server.address().address, '127.0.0.1');
  const port = server.address().port;
  return { errors, async call({ path = '/api/crm/partner-link?profileId=' + profile, method = 'GET', token = 'owned.owner.signature', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false, timeout: 10000,
        headers: { Connection: 'close', Origin: ENTRY_ORIGIN, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { try { resolve({ statusCode: res.statusCode, headers: res.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(Error('Owned loopback HTTP timeout'))); req.end();
    });
  }, async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test('loopback HTTP preserves verified identity, duplicate-query refusal, method/path denials and no-store on cold failures', async () => {
  const x = await setup(); let http; try {
    http = await loopback(x.f.handler);
    let res = await http.call({ token: null }); assertPrivate(x.f, res); assert.equal(res.statusCode, 401);
    res = await http.call({ token: null, method: 'POST' }); assertPrivate(x.f, res); assert.equal(res.statusCode, 405);
    assert.equal(x.f.state.auth.length, 0); assert.equal(x.state.calls.length, 0);
    res = await http.call({ headers: { Host: 'foreign.fixture.invalid', Origin: 'https://foreign.fixture.invalid',
      'X-Forwarded-Host': 'foreign.fixture.invalid', 'X-Forwarded-Proto': 'http', 'X-Actor-Id': ENTRY_OTHER } });
    assertPrivate(x.f, res); assert.equal(res.statusCode, 200); assert.deepEqual(res.body, expectedLink());
    res = await http.call({ token: 'owned.other.signature' }); assertPrivate(x.f, res);
    assertFailure(res, 403, 'partner_link_access_denied');
    const count = x.state.calls.length;
    for (const suffix of ['&profileId=' + profile, '&actor=' + ENTRY_OTHER, '&workspaceId=' + ENTRY_OTHER,
      '&code=' + referralCode, '&url=https%3A%2F%2Fforeign.fixture.invalid']) {
      res = await http.call({ path: '/api/crm/partner-link?profileId=' + profile + suffix });
      assertPrivate(x.f, res); assertFailure(res, 400, 'invalid_partner_link_query');
    }
    res = await http.call({ path: '/api/crm/partner-link?profileId=bad' });
    assertPrivate(x.f, res); assertFailure(res, 400, 'invalid_partner_link_query');
    res = await http.call({ path: '/api/crm/partner-link/extra?profileId=' + profile });
    assertPrivate(x.f, res, false); assert.equal(res.statusCode, 404);
    assert.equal(x.state.calls.length, count); assert.deepEqual(http.errors, []);
  } finally { if (http) await http.close(); x.close(); }
});
