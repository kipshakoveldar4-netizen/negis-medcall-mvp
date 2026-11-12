import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ACTOR, ENTRY_OTHER, ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';

after(stopPartnerEntryBuilds);

const TOKEN = 'owned.owner.signature', OTHER_TOKEN = 'owned.other.signature';
const APPLICATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', REVISION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKSPACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const READ_RPC = 'list_own_growth_partner_companies';
const COMPANY = { name: 'Owned inbox company', purpose: 'marketing', vertical: null, timeZone: 'Asia/Almaty', ownerName: 'Owned Applicant' };
const plain = value => JSON.parse(JSON.stringify(value));
const application = (changes = {}) => ({ id: APPLICATION, revision: REVISION, state: 'pending', company: { ...COMPANY },
  workspaceId: null, sourceState: 'expired', expiresAt: '2026-01-08T00:00:00.000000Z',
  submittedAt: '2026-01-01T00:00:00.000000Z', reviewedAt: null, ...changes });
const terminal = (state, changes = {}) => application({ state, workspaceId: state === 'approved' ? WORKSPACE : null,
  sourceState: state === 'approved' ? 'bound' : 'expired', reviewedAt: '2026-01-02T00:00:00.000001Z', ...changes });
const page = (changes = {}) => ({ items: [application()], offset: 0, state: null, hasMore: false, ...changes });
const pageItems = count => Array.from({ length: count }, (_, n) => application({
  id: 'dddddddd-dddd-4ddd-8ddd-' + (count - n).toString(16).padStart(12, '0') }));

async function setup(options = {}) {
  const state = { calls: [], forbidden: [], data: page(), error: null, thrown: null, result: undefined };
  // Only database return values are synthetic; the shared fixture compiles the real router and contracts.
  const adapter = new Proxy({ async rpc(name, args) {
    state.calls.push({ name, args: structuredClone(args) });
    if (name !== READ_RPC) { state.forbidden.push(name); throw Error('PRIVATE_UNEXPECTED_RPC'); }
    if (state.thrown) throw state.thrown;
    return state.result === undefined ? { data: state.data, error: state.error } : state.result;
  } }, { get(target, key, receiver) {
    if (key === 'rpc') return Reflect.get(target, key, receiver);
    state.forbidden.push(String(key)); throw Error('PRIVATE_DIRECT_DATABASE_OR_AUTH_LOOKUP');
  } });
  const authUsers = options.authUsers ?? new Map([[TOKEN, { id: ENTRY_ACTOR }], [OTHER_TOKEN, { id: ENTRY_OTHER }]]);
  const f = await partnerEntryHttpFixture(adapter, { approved: false, ...options, authUsers,
    env: { MEDINA_PLATFORM_OWNER_IDS: '', ...options.env } });

  async function call({ method = 'GET', token = TOKEN, query = {}, body, headers = {}, path = ['partner-company'] } = {}) {
    const req = Readable.from([]);
    Object.assign(req, { method, url: '/api/crm/' + (Array.isArray(path) ? path.join('/') : path),
      query: { path, view: 'list', ...query }, headers: { origin: ENTRY_ORIGIN, 'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers } });
    if (body !== undefined) req.body = body;
    const res = { statusCode: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      status(v) { this.statusCode = v; return this; },
      json(v) { this.body = plain(v); return this; },
      end(v) { this.body = v; return this; } };
    const before = state.calls.length;
    await f.handler(req, res);
    const calls = state.calls.slice(before);
    assert.ok(calls.length <= 1, 'One read cannot retry or dispatch a fallback');
    for (const call of calls) assert.deepEqual(Object.keys(call.args).sort(), ['p_actor', 'p_offset', 'p_state']);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['set-cookie'], undefined, 'Historic reads cannot refresh or clear attribution');
    assert.deepEqual(state.forbidden, [], 'Inbox reads cannot use tables, Auth role lookup, recovery, platform or mutation RPCs');
    assert.deepEqual(f.state.unexpected, [], 'Only the synthetic verified Auth boundary may be contacted');
    assert.deepEqual(f.state.challenges, [], 'Historic reads never invoke a challenge or provider');
    const serialized = JSON.stringify({ body: res.body, headers: res.headers });
    for (const marker of ['PRIVATE_', TOKEN, OTHER_TOKEN, f.env.SUPABASE_SERVICE_ROLE_KEY,
      f.env.MEDINA_PARTNER_ENTRY_COOKIE_KEY, f.env.MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET].filter(v => typeof v === 'string' && v.length))
      assert.ok(!serialized.includes(marker), 'No credentials or private diagnostics in the response');
    return res;
  }
  return { f, state, authUsers, call, close() {
    f.close();
    assert.deepEqual(state.forbidden, []);
    assert.deepEqual(f.state.unexpected, []);
    assert.deepEqual(f.state.challenges, []);
  } };
}

function expectData(res, data) {
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: plain(data) });
}
function expectFailure(res, status = 503, code = 'partner_company_unconfirmed') {
  assert.equal(res.statusCode, status);
  assert.deepEqual(res.body, { success: false, code });
}
function expectRead(x, actor = ENTRY_ACTOR, offset = 0, state = null) {
  assert.deepEqual(x.state.calls.at(-1), { name: READ_RPC, args: { p_actor: actor, p_offset: offset, p_state: state } });
}

test('actual compiled inbox route returns the existing page DTO through only the own-company read RPC', async () => {
  const x = await setup(); try {
    expectData(await x.call(), x.state.data);
    assert.equal(x.state.calls.length, 1); expectRead(x);
    x.state.data = page({ items: [] });
    const res = await x.call({ query: { offset: '0' }, body: {} });
    expectData(res, x.state.data); expectRead(x);
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(x.f.state.auth.length > 0);
    assert.ok(x.f.state.auth.every(header => header === 'Bearer ' + TOKEN));
  } finally { x.close(); }
});

test('inbox accepts exact offset boundaries and all three state filters without coercion', async () => {
  const x = await setup(); try {
    for (const offset of [0, 1, 19, 20, 999999, 1000000]) for (const state of [null, 'pending', 'approved', 'rejected']) {
      const item = state === 'approved' || state === 'rejected' ? terminal(state) : application();
      x.state.data = page({ items: [item], offset, state });
      expectData(await x.call({ query: { offset: String(offset), ...(state === null ? {} : { state }) } }), x.state.data);
      expectRead(x, ENTRY_ACTOR, offset, state);
    }
    for (const state of ['pending', 'approved', 'rejected']) {
      x.state.data = page({ items: [], state });
      expectData(await x.call({ query: { state } }), x.state.data); expectRead(x, ENTRY_ACTOR, 0, state);
    }
  } finally { x.close(); }
});

test('verified Auth subject alone wins over JWT claims, browser headers, cookies and role metadata', async () => {
  const token = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.'
    + Buffer.from(JSON.stringify({ sub: ENTRY_OTHER, actor: ENTRY_OTHER, role: 'owner', workspaceId: WORKSPACE })).toString('base64url') + '.synthetic';
  const identity = { id: ENTRY_ACTOR, email: 'owned@staff.negis.online', user_metadata: { id: ENTRY_OTHER, role: 'owner' },
    app_metadata: { actor: ENTRY_OTHER, workspaceId: WORKSPACE, role: 'platform_owner' } };
  const x = await setup({ authUsers: new Map([[token, identity], [OTHER_TOKEN, { id: ENTRY_OTHER }]]) }); try {
    const headers = { 'x-actor-id': ENTRY_OTHER, 'x-user-id': ENTRY_OTHER, 'x-workspace-id': WORKSPACE,
      'x-forwarded-user': ENTRY_OTHER, 'x-partner-id': ENTRY_OTHER, cookie: 'actor=' + ENTRY_OTHER + '; workspaceId=' + WORKSPACE };
    expectData(await x.call({ token, headers }), x.state.data); expectRead(x);
    assert.ok(x.f.state.auth.includes('Bearer ' + token));
    assert.ok(!JSON.stringify(x.state.calls).includes(token));
    const otherPage = page({ items: [terminal('rejected', { id: ENTRY_OTHER, company: { ...COMPANY, name: 'Other own company' } })] });
    x.state.data = otherPage;
    expectData(await x.call({ token: OTHER_TOKEN, headers: { 'x-actor-id': ENTRY_ACTOR } }), otherPage);
    expectRead(x, ENTRY_OTHER); assert.equal(x.state.calls.length, 2);
  } finally { x.close(); }
});

test('missing, synthetic, malformed or unconfirmed email does not gate historic own-company reads', async () => {
  const x = await setup(); try {
    for (const fields of [{}, { email: 'owned@staff.negis.online' }, { email: 'OWNED@STAFF.NEGIS.LOCAL' },
      { email: 'owned@staff.negis.online', email_confirmed_at: '2026-10-27T00:00:00Z' },
      { email: 'applicant@example.invalid', email_confirmed_at: null }, { email: 'applicant@example.invalid' },
      { email: 'not-an-email', email_confirmed_at: true }, { email: 'applicant@example.invalid', email_confirmed_at: '2026-02-31T00:00:00Z' },
      { email: 'applicant@example.invalid', email_confirmed_at: '2026-10-27T00:00:00Z' }]) {
      x.authUsers.set(TOKEN, { id: ENTRY_ACTOR, ...fields });
      expectData(await x.call(), x.state.data); expectRead(x);
    }
  } finally { x.close(); }
});

test('Auth absence, malformed or unverified identity and Auth outage fail before the read RPC with no-store', async () => {
  const x = await setup(); try {
    for (const config of [{ token: null }, { token: '' }, { token: 'not-a-jwt' }, { token: 'owned.forged.signature' },
      { token: null, headers: { authorization: 'Basic ' + TOKEN, 'x-actor-id': ENTRY_ACTOR } },
      { headers: { authorization: 'Bearer ' + TOKEN + ' extra' } }]) {
      const res = await x.call(config);
      assert.equal(res.statusCode, 401); assert.equal(res.body.success, false);
      assert.equal(res.body.code, 'authentication_required'); assert.equal(res.body.data, undefined);
    }
    for (const identity of [{}, { id: '' }, { id: null }, { id: 42 }, { user_metadata: { id: ENTRY_ACTOR } }]) {
      x.authUsers.set(TOKEN, identity);
      const res = await x.call(); assert.equal(res.statusCode, 401); assert.equal(res.body.code, 'authentication_required');
    }
    x.authUsers.set(TOKEN, { id: ENTRY_ACTOR }); x.f.state.authUnavailable = true;
    const res = await x.call(); assert.equal(res.statusCode, 503); assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'authorization_unavailable'); assert.equal(res.body.data, undefined);
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('disabled intake, missing notice configuration and the real empty registry do not gate historic reads or require a cookie', async () => {
  const options = [{}, { company: true, approved: false }, { env: {
    MEDINA_PARTNER_ENTRY_ENABLED: 'false', MEDINA_PARTNER_COMPANY_ENABLED: 'false', MEDINA_APP_ORIGIN: '',
    MEDINA_PARTNER_ENTRY_COOKIE_KEY: '', MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET: '', MEDINA_PARTNER_ENTRY_TURNSTILE_SITE_KEY: '',
    MEDINA_PARTNER_ENTRY_CONSENT_VERSION: '', MEDINA_PARTNER_COMPANY_CONSENT_VERSION: '' } },
  { env: { MEDINA_PARTNER_ENTRY_CONSENT_VERSION: 'changed-notice', MEDINA_PARTNER_COMPANY_CONSENT_VERSION: 'unapproved-notice' } }];
  for (const option of options) {
    const x = await setup(option); try {
      const key = Buffer.from('ab'.repeat(32), 'hex'), now = Date.now();
      const frame = x.f.cookies.newPartnerEntryFrame('OWNED_CODE', 'link', x.f.notice.version, x.f.notice.sha256,
        now - x.f.cookies.PARTNER_WINDOW_MS - 1000);
      const expired = x.f.cookies.PARTNER_ENTRY_COOKIE + '=' + x.f.cookies.sealPartnerEntry(frame, ENTRY_ORIGIN, key);
      assert.equal(x.f.cookies.readPartnerEntryCookie(expired, ENTRY_ORIGIN, key, now).state, 'expired');
      for (const cookie of [undefined, expired, x.f.cookies.PARTNER_ENTRY_COOKIE + '=malformed']) {
        expectData(await x.call({ headers: { cookie, origin: 'https://foreign.fixture.invalid', host: 'foreign.fixture.invalid',
          'x-forwarded-host': 'foreign.fixture.invalid', 'x-forwarded-proto': 'http' } }), x.state.data);
        expectRead(x);
      }
      expectData(await x.call({ headers: { origin: undefined } }), x.state.data);
      assert.equal(x.state.calls.length, 4);
    } finally { x.close(); }
  }
});

test('view, offset and state reject noncanonical values, duplicate arrays and unknown query keys before RPC', async () => {
  const x = await setup(); try {
    const queries = [
      ...[null, '', 'LIST', 'list ', 'list\n', 'context', 'submit', ['list'], ['list', 'list'], {}, 1, true].map(view => ({ view })),
      ...['', '-1', '+0', '-0', '00', '01', '1.0', '1e3', '0x10', ' 0', '0 ', '0\n', '1000001', '9999999',
        '10000000', '9'.repeat(100), ['0'], ['0', '20'], [], {}, 0, 1, false].map(offset => ({ offset })),
      ...['', 'all', 'PENDING', 'pending ', 'pending\n', 'null', ['pending'], ['pending', 'approved'], [], {}, 1, false].map(state => ({ state })),
      ...['actor', 'p_actor', 'actorId', 'userId', 'email', 'applicantEmail', 'emailConfirmed', 'company', 'companyId', 'workspaceId',
        'workspace_id', 'source', 'sourceId', 'source_id', 'p_source', 'capability', 'capabilityHash', 'capability_hash',
        'code', 'referralCode', 'partnerId', 'token', 'access_token', 'owner', 'side', 'profileId', 'notice', 'consent',
        'consentVersion', 'startedAt', 'expiresAt', 'origin', 'url', 'applicationId', 'requestId', 'revision', 'action',
        'operation', 'op', 'limit', 'cursor', 'search', 'order', 'unknown'].map(key => ({ [key]: ENTRY_OTHER })),
    ];
    for (const query of queries) {
      expectFailure(await x.call({ query }), 400, 'invalid_partner_company_query');
      assert.equal(x.state.calls.length, 0, JSON.stringify(query));
    }
    for (const query of [{ view: undefined, offset: '0' }, { view: undefined, state: 'pending' }]) {
      assert.equal((await x.call({ query })).statusCode, 400); assert.equal(x.state.calls.length, 0);
    }
  } finally { x.close(); }
});

test('inbox refuses nonempty GET bodies and mixed submission or recovery metadata without any RPC', async () => {
  const x = await setup(); try {
    for (const body of [{ view: 'list' }, { offset: 0 }, { state: 'pending' }, { actor: ENTRY_OTHER }, { company: COMPANY },
      { workspaceId: WORKSPACE }, { sourceId: ENTRY_OTHER }, { capabilityHash: 'ab'.repeat(32) },
      { operation: 'close', requestId: APPLICATION, sourceId: ENTRY_OTHER }, { requestId: APPLICATION, company: COMPANY, consent: true },
      [], [APPLICATION], 'list', '', 0, false]) {
      expectFailure(await x.call({ body }), 400, 'invalid_partner_company_query'); assert.equal(x.state.calls.length, 0);
    }
    for (const query of [{ requestId: APPLICATION, sourceId: ENTRY_OTHER },
      { requestId: APPLICATION, applicationId: APPLICATION, revision: REVISION, action: 'approve' },
      { operation: 'close', requestId: APPLICATION, sourceId: ENTRY_OTHER }]) {
      expectFailure(await x.call({ query }), 400, 'invalid_partner_company_query'); assert.equal(x.state.calls.length, 0);
    }
    const res = await x.call({ method: 'POST', body: { operation: 'close', requestId: APPLICATION, sourceId: ENTRY_OTHER } });
    assert.equal(res.statusCode, 400); assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('unsupported methods and unregistered inbox subpaths cannot dispatch a list, recovery or mutation RPC', async () => {
  const x = await setup(); try {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const res = await x.call({ method }); assert.equal(res.statusCode, 405); assert.equal(res.body.code, 'method_not_allowed');
    }
    for (const path of [['partner-company', 'extra'], ['partner-company', 'list'], ['partner-company', '..'],
      ['partner-company-not-registered'], ['%ZZ']]) {
      assert.equal((await x.call({ path })).statusCode, 404);
    }
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('strict pages preserve empty, partial and full results and historic pending, approved and rejected states', async () => {
  const x = await setup(); try {
    for (const count of [0, 1, 19, 20]) for (const hasMore of count === 20 ? [false, true] : [false]) {
      x.state.data = page({ items: pageItems(count), hasMore });
      expectData(await x.call(), x.state.data);
    }
    x.state.data = page({ items: [application(), terminal('approved', { id: ENTRY_OTHER }), terminal('rejected', { id: ENTRY_ACTOR })] });
    expectData(await x.call(), x.state.data);
    x.state.data = page({ items: [application({ id: ENTRY_ACTOR, submittedAt: '2026-01-01T00:00:00.000002Z' }),
      application({ submittedAt: '2026-01-01T00:00:00.000001Z' })] });
    expectData(await x.call(), x.state.data);
  } finally { x.close(); }
});

test('malformed, extra or private page and application data fail opaque instead of being repaired or leaked', async () => {
  const x = await setup(); try {
    const values = [null, {}, [], [page()], { success: true, data: page() }, page({ items: null }), page({ items: {} }),
      page({ items: [null] }), page({ items: new Array(1) }), page({ items: pageItems(21) }),
      page({ offset: '0' }), page({ offset: -1 }), page({ offset: 1000001 }), page({ offset: 0.5 }),
      page({ state: 'all' }), page({ hasMore: 'false' }), page({ hasMore: true }),
      page({ items: [application({ state: 'unknown' })] }), page({ items: [application({ id: 'not-a-uuid' })] }),
      page({ items: [application({ revision: null })] }), page({ items: [application({ company: { ...COMPANY, timeZone: 'bad/timezone' } })] }),
      page({ items: [application({ workspaceId: WORKSPACE })] }), page({ items: [terminal('approved', { workspaceId: null })] }),
      page({ items: [terminal('rejected', { reviewedAt: null })] }), page({ items: [application({ sourceState: 'bound' })] }),
      page({ items: [application({ expiresAt: '2026-02-31T00:00:00Z' })] }),
      page({ items: [application({ submittedAt: '2026-01-08T00:00:00.000000Z' })] }),
      page({ items: [application(), application({ id: APPLICATION.toUpperCase() })] }),
      page({ items: [application({ id: ENTRY_ACTOR }), application()] }),
      page({ items: [application({ submittedAt: '2026-01-01T00:00:00.000001Z' }),
        application({ id: ENTRY_ACTOR, submittedAt: '2026-01-01T00:00:00.000002Z' })] }),
    ];
    for (const field of ['items', 'offset', 'state', 'hasMore']) { const value = page(); delete value[field]; values.push(value); }
    for (const field of ['private', 'actor', 'auth_user_id', 'sourceId', 'capabilityHash', 'applicantEmail', 'notice', 'total']) {
      values.push(page({ [field]: 'PRIVATE_PAGE_FIELD' }), page({ items: [application({ [field]: 'PRIVATE_APPLICATION_FIELD' })] }));
    }
    values.push(page({ items: [application({ company: { ...COMPANY, ownerEmail: 'PRIVATE_CONTACT@example.invalid' } })] }));
    for (const value of values) {
      x.state.data = value;
      expectFailure(await x.call()); expectRead(x);
    }
    assert.equal(x.state.calls.length, values.length);
  } finally { x.close(); }
});

test('foreign offset, filter or item-state pages are unconfirmed rather than returned as this request', async () => {
  const x = await setup(); try {
    for (const [query, value] of [[{}, page({ offset: 20 })], [{ offset: '20' }, page()],
      [{}, page({ state: 'pending' })], [{ state: 'pending' }, page()],
      [{ state: 'approved' }, page({ state: 'rejected', items: [terminal('rejected')] })],
      [{ state: 'approved' }, page({ state: 'approved', items: [application()] })],
      [{ state: 'pending' }, page({ state: 'pending', items: [terminal('approved')] })]]) {
      x.state.data = value; expectFailure(await x.call({ query }));
    }
  } finally { x.close(); }
});

test('access denials expose neither returned company data nor diagnostics and never fall back to a wider read', async () => {
  const x = await setup(); try {
    x.state.data = page({ items: [application({ company: { ...COMPANY, name: 'PRIVATE_FOREIGN_COMPANY' } })] });
    for (const code of ['P1121', 'P1211']) {
      x.state.error = { code, message: 'PRIVATE_ACCESS_DIAGNOSTIC', details: ENTRY_OTHER, hint: 'PRIVATE_CONTACT' };
      expectFailure(await x.call(), 403, 'partner_company_access_denied'); expectRead(x);
      expectFailure(await x.call({ token: OTHER_TOKEN }), 403, 'partner_company_access_denied'); expectRead(x, ENTRY_OTHER);
    }
    assert.equal(x.state.calls.length, 4);
  } finally { x.close(); }
});

test('P1262 and every non-access-denial RPC error remain opaque unconfirmed 503 outcomes', async t => {
  const x = await setup(); try {
    for (const code of ['P1262', 'P1212', 'P1252', 'P1133', 'P1213', 'P1253', '42P01', '57014', 'unknown', undefined]) {
      await t.test(String(code), async () => {
        x.state.error = { code, message: 'PRIVATE_SQL_DIAGNOSTIC', details: 'PRIVATE_CONTACT', hint: 'PRIVATE_HINT' };
        expectFailure(await x.call()); expectRead(x);
      });
    }
  } finally { x.close(); }
});

test('exceptions, malformed RPC envelopes and missing storage cannot reuse a confirmed page or dispatch a fallback', async () => {
  const x = await setup(); try {
    expectData(await x.call(), x.state.data);
    x.state.thrown = Error('PRIVATE_DATABASE_EXCEPTION'); expectFailure(await x.call()); x.state.thrown = null;
    for (const result of [null, {}, { data: null, error: null }, { data: [page()], error: null }, { data: page(), error: {} }]) {
      x.state.result = result; expectFailure(await x.call());
    }
    x.state.result = undefined; x.state.data = null; expectFailure(await x.call());
    x.state.data = page({ items: [] }); expectData(await x.call(), x.state.data);
    const count = x.state.calls.length; x.f.install(() => null);
    expectFailure(await x.call()); assert.equal(x.state.calls.length, count);
  } finally { x.close(); }
});
