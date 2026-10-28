import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ACTOR, ENTRY_OTHER, ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';

after(stopPartnerEntryBuilds);

const TOKEN = 'owned.owner.signature', OTHER_TOKEN = 'owned.other.signature';
const APPLICATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', REVISION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKSPACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', SOURCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const READ_RPC = 'read_growth_partner_company';
const COMPANY = { name: 'Owned workspace company', purpose: 'marketing', vertical: null, timeZone: 'Asia/Almaty', ownerName: 'Owned Applicant' };
const plain = value => JSON.parse(JSON.stringify(value));
const application = (changes = {}) => ({ id: APPLICATION, revision: REVISION, state: 'approved', company: { ...COMPANY },
  workspaceId: WORKSPACE, sourceState: 'bound', expiresAt: '2026-01-08T00:00:00.000000Z',
  submittedAt: '2026-01-01T00:00:00.000000Z', reviewedAt: '2026-01-02T00:00:00.000001Z', ...changes });
const unapproved = (state, changes = {}) => application({ state, workspaceId: null, sourceState: 'expired',
  reviewedAt: state === 'pending' ? null : '2026-01-02T00:00:00.000001Z', ...changes });

async function setup(options = {}) {
  const state = { calls: [], forbidden: [], data: application(), error: null, thrown: null, result: undefined, related: new Map() };
  // The shared fixture compiles the real catchall and parsers; only Auth and RPC responses are synthetic.
  const adapter = new Proxy({ async rpc(name, args) {
    state.calls.push({ name, args: structuredClone(args) });
    if (state.related.has(name)) return { data: state.related.get(name), error: null };
    if (name !== READ_RPC) { state.forbidden.push(name); throw Error('PRIVATE_UNEXPECTED_RPC'); }
    if (state.thrown) throw state.thrown;
    return state.result === undefined ? { data: state.data, error: state.error } : state.result;
  } }, { get(target, key, receiver) {
    if (key === 'rpc') return Reflect.get(target, key, receiver);
    state.forbidden.push(String(key)); throw Error('PRIVATE_DIRECT_DATABASE_OR_AUTH_LOOKUP');
  } });
  const authUsers = options.authUsers ?? new Map([[TOKEN, { id: ENTRY_ACTOR }], [OTHER_TOKEN, { id: ENTRY_OTHER }]]);
  const f = await partnerEntryHttpFixture(adapter, { ...options, approved: false, authUsers,
    env: { MEDINA_PLATFORM_OWNER_IDS: '', ...options.env } });

  async function call({ method = 'GET', token = TOKEN, query = {}, body, raw, headers = {}, path = ['partner-company'], workspace = true } = {}) {
    const req = Readable.from(raw === undefined ? [] : [raw]);
    Object.assign(req, { method, url: '/api/crm/' + (Array.isArray(path) ? path.join('/') : path),
      query: { path, ...(workspace ? { view: 'workspace', applicationId: APPLICATION, revision: REVISION } : {}), ...query },
      headers: { origin: ENTRY_ORIGIN, 'content-type': 'application/json',
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
    assert.ok(calls.length <= 1, 'One request cannot retry or fall back to another RPC');
    for (const call of calls) if (call.name === READ_RPC)
      assert.deepEqual(Object.keys(call.args).sort(), ['p_actor', 'p_application']);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['set-cookie'], undefined, 'Workspace reads cannot refresh or clear attribution');
    assert.deepEqual(state.forbidden, [], 'No direct tables, Auth role lookup, recovery, wider reads or mutation fallback');
    assert.deepEqual(f.state.unexpected, [], 'No real network or provider boundary may be contacted');
    assert.deepEqual(f.state.challenges, [], 'Workspace reads never invoke a challenge');
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
function expectRead(x, actor = ENTRY_ACTOR, id = APPLICATION) {
  assert.deepEqual(x.state.calls.at(-1), { name: READ_RPC, args: { p_actor: actor, p_application: id } });
}

test('compiled workspace route returns only the strict approved application through the existing single read RPC', async () => {
  const x = await setup(); try {
    expectData(await x.call(), x.state.data); expectRead(x);
    assert.equal(x.state.calls.length, 1);
    const res = await x.call({ body: {} });
    expectData(res, x.state.data); expectRead(x);
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(x.f.state.auth.length > 0);
    assert.ok(x.f.state.auth.every(header => header === 'Bearer ' + TOKEN));
  } finally { x.close(); }
});

test('approved bound, pending-payment and expired sources retain the complete authoritative company DTO', async () => {
  const x = await setup(); try {
    for (const sourceState of ['bound', 'pending_payment', 'expired']) for (const company of [COMPANY,
      { ...COMPANY, purpose: 'mortgage_leads', timeZone: 'UTC' },
      ...['clinic', 'beauty', 'dental'].map(vertical => ({ ...COMPANY, purpose: 'clinic_services', vertical }))]) {
      x.state.data = application({ sourceState, company });
      expectData(await x.call(), x.state.data); expectRead(x);
    }
  } finally { x.close(); }
});

test('application and revision matching is case-insensitive without replacing the RPC application or rewriting its DTO', async () => {
  const x = await setup(); try {
    for (const id of [APPLICATION, APPLICATION.toUpperCase()]) for (const revision of [REVISION, REVISION.toUpperCase()]) {
      for (const uppercase of [false, true]) {
        x.state.data = application(uppercase ? { id: APPLICATION.toUpperCase(), revision: REVISION.toUpperCase(), workspaceId: WORKSPACE.toUpperCase() } : {});
        expectData(await x.call({ query: { applicationId: id, revision } }), x.state.data);
        expectRead(x, ENTRY_ACTOR, id);
      }
    }
  } finally { x.close(); }
});

test('each read returns the database title and workspace, never a previously successful title or client hint', async () => {
  const x = await setup(); try {
    expectData(await x.call(), x.state.data);
    x.state.data = application({ company: { ...COMPANY, name: 'Authoritative renamed company' }, workspaceId: SOURCE });
    expectData(await x.call(), x.state.data); expectRead(x);
    x.state.data = application({ revision: SOURCE, company: { ...COMPANY, name: 'Same title cannot confirm a new revision' } });
    expectFailure(await x.call(), 409, 'partner_company_changed');
    assert.equal(x.state.calls.length, 3);
  } finally { x.close(); }
});

test('only the verified Auth subject binds p_actor despite forged claims, metadata, headers and cookies', async () => {
  const token = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.'
    + Buffer.from(JSON.stringify({ sub: ENTRY_OTHER, actor: ENTRY_OTHER, role: 'owner', workspaceId: WORKSPACE })).toString('base64url') + '.synthetic';
  const identity = { id: ENTRY_ACTOR, email: 'owned@staff.negis.online', user_metadata: { id: ENTRY_OTHER, role: 'owner' },
    app_metadata: { actor: ENTRY_OTHER, workspaceId: WORKSPACE, role: 'platform_owner' } };
  const x = await setup({ authUsers: new Map([[token, identity], [OTHER_TOKEN, { id: ENTRY_OTHER }]]) }); try {
    const headers = { 'x-actor-id': ENTRY_OTHER, 'x-user-id': ENTRY_OTHER, 'x-workspace-id': SOURCE,
      'x-forwarded-user': ENTRY_OTHER, 'x-partner-id': ENTRY_OTHER, cookie: 'actor=' + ENTRY_OTHER + '; workspaceId=' + SOURCE };
    expectData(await x.call({ token, headers }), x.state.data); expectRead(x);
    assert.ok(x.f.state.auth.includes('Bearer ' + token));
    assert.ok(!JSON.stringify(x.state.calls).includes(token));
    expectData(await x.call({ token: OTHER_TOKEN, headers: { 'x-actor-id': ENTRY_ACTOR } }), x.state.data);
    expectRead(x, ENTRY_OTHER); assert.equal(x.state.calls.length, 2);
  } finally { x.close(); }
});

test('missing, synthetic, malformed and unconfirmed email do not gate a verified own-workspace read', async () => {
  const x = await setup(); try {
    for (const fields of [{}, { email: 'owned@staff.negis.online' }, { email: 'OWNED@STAFF.NEGIS.LOCAL' },
      { email: 'applicant@example.invalid', email_confirmed_at: null }, { email: 'applicant@example.invalid' },
      { email: 'not-an-email', email_confirmed_at: true }, { email: 'applicant@example.invalid', email_confirmed_at: '2026-02-31T00:00:00Z' },
      { email: 'applicant@example.invalid', email_confirmed_at: '2026-10-27T00:00:00Z' }]) {
      x.authUsers.set(TOKEN, { id: ENTRY_ACTOR, ...fields });
      expectData(await x.call(), x.state.data); expectRead(x);
    }
  } finally { x.close(); }
});

test('missing, malformed or unverified Auth and Auth outages fail before any database read', async () => {
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

test('disabled intake, empty notice registry, absent Origin and expired or malformed cookies do not gate readonly workspace reads', async () => {
  for (const options of [{}, { company: true }, { env: {
    MEDINA_PARTNER_ENTRY_ENABLED: 'false', MEDINA_PARTNER_COMPANY_ENABLED: 'false', MEDINA_APP_ORIGIN: '',
    MEDINA_PARTNER_ENTRY_COOKIE_KEY: '', MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET: '', MEDINA_PARTNER_ENTRY_TURNSTILE_SITE_KEY: '',
    MEDINA_PARTNER_ENTRY_CONSENT_VERSION: '', MEDINA_PARTNER_COMPANY_CONSENT_VERSION: '' } },
  { env: { MEDINA_PARTNER_ENTRY_CONSENT_VERSION: 'changed-notice', MEDINA_PARTNER_COMPANY_CONSENT_VERSION: 'unapproved-notice' } }]) {
    const x = await setup(options); try {
      const key = Buffer.from('ab'.repeat(32), 'hex'), now = Date.now();
      const frame = x.f.cookies.newPartnerEntryFrame('OWNED_CODE', 'link', x.f.notice.version, x.f.notice.sha256,
        now - x.f.cookies.PARTNER_WINDOW_MS - 1000);
      const expired = x.f.cookies.PARTNER_ENTRY_COOKIE + '=' + x.f.cookies.sealPartnerEntry(frame, ENTRY_ORIGIN, key);
      assert.equal(x.f.cookies.readPartnerEntryCookie(expired, ENTRY_ORIGIN, key, now).state, 'expired');
      for (const cookie of [undefined, expired, x.f.cookies.PARTNER_ENTRY_COOKIE + '=malformed']) {
        expectData(await x.call({ headers: { cookie, origin: 'https://foreign.fixture.invalid', host: 'foreign.fixture.invalid',
          'x-forwarded-host': 'foreign.fixture.invalid', 'x-forwarded-proto': 'http' } }), x.state.data); expectRead(x);
      }
      expectData(await x.call({ headers: { origin: undefined } }), x.state.data);
      assert.equal(x.state.calls.length, 4);
    } finally { x.close(); }
  }
});

test('workspace view must be an exact scalar selector and cannot be absent, coerced, duplicated or a different view', async () => {
  const x = await setup(); try {
    for (const view of [undefined, null, '', 'WORKSPACE', 'workspace ', ' workspace', 'workspace\n', 'workspace\u0000',
      'list', 'context', 'submit', 'receipt', ['workspace'], ['workspace', 'workspace'], ['workspace', 'list'], [], {}, 1, true]) {
      expectFailure(await x.call({ query: { view } }), 400, 'invalid_partner_company_query');
      assert.equal(x.state.calls.length, 0, JSON.stringify(view));
    }
  } finally { x.close(); }
});

test('application and revision require canonical portable UUID scalars with both selectors present', async () => {
  const x = await setup(); try {
    for (const key of ['applicationId', 'revision']) for (const value of [undefined, null, '', 'not-a-uuid', ' ' + APPLICATION,
      APPLICATION + ' ', APPLICATION + '\n', APPLICATION + '\u0000', APPLICATION.replaceAll('-', ''), '{' + APPLICATION + '}',
      '00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-6aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa',
      [APPLICATION], [APPLICATION, APPLICATION], [APPLICATION, SOURCE], [], {}, 42, false]) {
      expectFailure(await x.call({ query: { [key]: value } }), 400, 'invalid_partner_company_query');
      assert.equal(x.state.calls.length, 0, key + ':' + JSON.stringify(value));
    }
    expectFailure(await x.call({ query: { applicationId: undefined, revision: undefined } }), 400, 'invalid_partner_company_query');
  } finally { x.close(); }
});

test('workspace queries refuse receipt tuples, inbox pagination, client titles and every extra authority or command key', async () => {
  const x = await setup(); try {
    for (const key of ['requestId', 'sourceId', 'request_id', 'source_id', 'offset', 'state', 'limit', 'cursor', 'order', 'search',
      'actor', 'p_actor', 'actorId', 'userId', 'email', 'emailConfirmed', 'applicantEmail', 'company', 'companyId', 'name', 'title',
      'companyName', 'workspaceId', 'workspace_id', 'revisionId', 'p_revision', 'p_application', 'operation', 'op', 'action', 'close',
      'owner', 'side', 'partnerId', 'source', 'capability', 'capabilityHash', 'capability_hash', 'token', 'access_token',
      'consent', 'consentVersion', 'notice', 'origin', 'url', 'unknown']) {
      expectFailure(await x.call({ query: { [key]: SOURCE } }), 400, 'invalid_partner_company_query');
      assert.equal(x.state.calls.length, 0, key);
    }
    for (const query of [{ requestId: APPLICATION, sourceId: SOURCE }, { offset: '0', state: 'approved' },
      { operation: 'close', requestId: APPLICATION, sourceId: SOURCE }, { requestId: SOURCE, action: 'approve' }]) {
      expectFailure(await x.call({ query }), 400, 'invalid_partner_company_query'); assert.equal(x.state.calls.length, 0);
    }
  } finally { x.close(); }
});

test('GET accepts only an absent or empty-object body and rejects selectors, titles and commands in the body', async () => {
  const x = await setup(); try {
    for (const body of [null, {}]) { expectData(await x.call({ body }), x.state.data); expectRead(x); }
    const count = x.state.calls.length;
    for (const body of [{ view: 'workspace' }, { applicationId: APPLICATION }, { revision: REVISION }, { actor: ENTRY_OTHER },
      { company: COMPANY }, { name: 'Untrusted title' }, { title: 'Untrusted title' }, { workspaceId: WORKSPACE },
      { operation: 'close', requestId: APPLICATION, sourceId: SOURCE }, { requestId: APPLICATION, company: COMPANY, consent: true },
      [], [APPLICATION], 'workspace', '', 0, false]) {
      expectFailure(await x.call({ body }), 400, 'invalid_partner_company_query'); assert.equal(x.state.calls.length, count);
    }
    expectData(await x.call(), x.state.data); assert.equal(x.state.calls.length, count + 1);
  } finally { x.close(); }
});

test('unsupported methods, POST selector mixtures and unregistered workspace subpaths cannot dispatch any RPC', async () => {
  const x = await setup(); try {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const res = await x.call({ method }); assert.equal(res.statusCode, 405); assert.equal(res.body.code, 'method_not_allowed');
    }
    for (const body of [undefined, {}, { view: 'workspace', applicationId: APPLICATION, revision: REVISION },
      { operation: 'close', requestId: APPLICATION, sourceId: SOURCE }]) {
      expectFailure(await x.call({ method: 'POST', body }), 400, 'invalid_partner_company_request');
    }
    for (const path of [['partner-company', 'workspace'], ['partner-company', APPLICATION], ['partner-company', 'extra'],
      ['partner-company', '..'], ['partner-company-not-registered'], ['%ZZ']]) {
      assert.equal((await x.call({ path })).statusCode, 404);
    }
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('valid pending or rejected applications and changed revisions return conflict without exposing the application', async () => {
  const x = await setup(); try {
    for (const data of [unapproved('pending'), unapproved('pending', { sourceState: 'captured' }),
      unapproved('rejected'), unapproved('rejected', { sourceState: 'captured' }), application({ revision: SOURCE }),
      unapproved('pending', { revision: SOURCE }), unapproved('rejected', { revision: SOURCE })]) {
      x.state.data = data; expectFailure(await x.call(), 409, 'partner_company_changed'); expectRead(x);
    }
    x.state.data = application();
    expectFailure(await x.call({ query: { revision: SOURCE } }), 409, 'partner_company_changed'); expectRead(x);
  } finally { x.close(); }
});

test('wrong returned application identity is opaque even with matching revision, title or terminal state', async () => {
  const x = await setup(); try {
    for (const data of [application({ id: SOURCE }), application({ id: SOURCE, revision: SOURCE }),
      unapproved('pending', { id: SOURCE }), unapproved('rejected', { id: SOURCE })]) {
      x.state.data = data; expectFailure(await x.call()); expectRead(x);
    }
    x.state.data = application();
    expectFailure(await x.call({ query: { applicationId: SOURCE } })); expectRead(x, ENTRY_ACTOR, SOURCE);
  } finally { x.close(); }
});

test('legacy DTOs, receipt or page wrappers and malformed application fields never pass an older permissive parser', async () => {
  const x = await setup(); try {
    const values = [null, {}, [], [application()], { success: true, data: application() },
      { state: 'committed', requestId: APPLICATION, sourceId: SOURCE, application: application() },
      { items: [application()], offset: 0, state: 'approved', hasMore: false },
      application({ id: 'not-a-uuid' }), application({ revision: null }), application({ revision: '2026-01-02T00:00:00Z' }),
      application({ revision: [] }), application({ state: 'unknown' }), application({ state: 'APPROVED' }),
      application({ workspaceId: null }), application({ workspaceId: '' }), application({ workspaceId: 42 }),
      application({ workspaceId: '00000000-0000-0000-0000-000000000000' }),
      application({ sourceState: 'captured' }), application({ sourceState: 'unknown' }),
      application({ expiresAt: '2026-02-31T00:00:00Z' }), application({ submittedAt: '2026-01-08T00:00:00.000000Z' }),
      application({ reviewedAt: null }), application({ reviewedAt: '2025-12-31T23:59:59Z' }),
      unapproved('pending', { workspaceId: WORKSPACE }), unapproved('pending', { reviewedAt: '2026-01-02T00:00:00Z' }),
      unapproved('rejected', { reviewedAt: null }), unapproved('rejected', { sourceState: 'bound' })];
    for (const key of Object.keys(application())) { const value = application(); delete value[key]; values.push(value); }
    for (const key of ['private', 'actor', 'auth_user_id', 'sourceId', 'requestId', 'capabilityHash', 'applicantEmail', 'notice', 'title'])
      values.push(application({ [key]: 'PRIVATE_APPLICATION_FIELD' }));
    for (const value of values) { x.state.data = value; expectFailure(await x.call()); expectRead(x); }
    assert.equal(x.state.calls.length, values.length);
  } finally { x.close(); }
});

test('company titles and nested company fields must satisfy the strict current contract without aliases or private extras', async () => {
  const x = await setup(); try {
    const companies = [null, {}, [], { ...COMPANY, name: '' }, { ...COMPANY, name: 'X' }, { ...COMPANY, name: ' Padded title' },
      { ...COMPANY, name: 'Control\nTitle' }, { ...COMPANY, name: 'x'.repeat(121) }, { ...COMPANY, name: ['Title'] },
      { ...COMPANY, timeZone: 'bad/timezone' }, { ...COMPANY, purpose: 'unknown' }, { ...COMPANY, vertical: 'clinic' },
      { ...COMPANY, purpose: 'clinic_services', vertical: null }, { ...COMPANY, ownerName: '' },
      { ...COMPANY, title: 'PRIVATE_LEGACY_TITLE' }, { ...COMPANY, ownerEmail: 'PRIVATE_CONTACT@example.invalid' }];
    for (const key of Object.keys(COMPANY)) { const company = { ...COMPANY }; delete company[key]; companies.push(company); }
    const legacy = { ...COMPANY, title: COMPANY.name }; delete legacy.name; companies.push(legacy);
    for (const company of companies) { x.state.data = application({ company }); expectFailure(await x.call()); expectRead(x); }
    assert.equal(x.state.calls.length, companies.length);
  } finally { x.close(); }
});

test('only P1211 and P1121 map to access denied, discarding returned data and private diagnostics', async () => {
  const x = await setup(); try {
    x.state.data = application({ company: { ...COMPANY, name: 'PRIVATE_FOREIGN_COMPANY' } });
    for (const code of ['P1211', 'P1121']) {
      x.state.error = { code, message: 'PRIVATE_ACCESS_DIAGNOSTIC', details: ENTRY_OTHER, hint: 'PRIVATE_CONTACT' };
      expectFailure(await x.call(), 403, 'partner_company_access_denied'); expectRead(x);
      expectFailure(await x.call({ token: OTHER_TOKEN }), 403, 'partner_company_access_denied'); expectRead(x, ENTRY_OTHER);
    }
    assert.equal(x.state.calls.length, 4);
  } finally { x.close(); }
});

test('all non-denial RPC errors stay opaque 503, including expiry and review conflict codes from other operations', async () => {
  const x = await setup(); try {
    for (const code of ['P1133', 'P1213', 'P1253', 'P1212', 'P1252', 'P1262', '42P01', '57014', '23505',
      'unknown', 'p1211', 'P1211 ', '', null, undefined]) {
      x.state.error = { code, message: 'PRIVATE_SQL_DIAGNOSTIC', details: 'PRIVATE_CONTACT', hint: 'PRIVATE_HINT' };
      expectFailure(await x.call()); expectRead(x);
    }
  } finally { x.close(); }
});

test('exceptions, malformed RPC envelopes and absent storage cannot reuse an earlier successful workspace or dispatch fallback', async () => {
  const x = await setup(); try {
    expectData(await x.call(), x.state.data);
    for (const thrown of [Error('PRIVATE_DATABASE_EXCEPTION'), { code: 'P1211', message: 'PRIVATE_THROWN_DENIAL' }]) {
      x.state.thrown = thrown; expectFailure(await x.call()); expectRead(x);
    }
    x.state.thrown = null;
    for (const result of [null, {}, [], { data: null, error: null }, { data: [application()], error: null },
      { data: application(), error: {} }, { data: application(), error: 'PRIVATE_ERROR' }]) {
      x.state.result = result; expectFailure(await x.call()); expectRead(x);
    }
    x.state.result = undefined; x.state.data = null; expectFailure(await x.call());
    x.state.data = application(); expectData(await x.call(), x.state.data);
    const count = x.state.calls.length; x.f.install(() => null);
    expectFailure(await x.call()); assert.equal(x.state.calls.length, count);
  } finally { x.close(); }
});

test('workspace view leaves existing inbox and submission receipt handlers distinct and unrelated handlers gated', async () => {
  const x = await setup(); try {
    const page = { items: [application()], offset: 0, state: null, hasMore: false };
    const receipt = { state: 'committed', requestId: APPLICATION, sourceId: SOURCE, application: application() };
    x.state.related.set('list_own_growth_partner_companies', page);
    x.state.related.set('read_growth_partner_company_submission', receipt);
    expectData(await x.call({ workspace: false, query: { view: 'list' } }), page);
    assert.deepEqual(x.state.calls.at(-1), { name: 'list_own_growth_partner_companies', args: { p_actor: ENTRY_ACTOR, p_offset: 0, p_state: null } });
    expectData(await x.call({ workspace: false, query: { requestId: APPLICATION, sourceId: SOURCE }, headers: { origin: undefined } }), receipt);
    assert.deepEqual(x.state.calls.at(-1), { name: 'read_growth_partner_company_submission', args: {
      p_actor: ENTRY_ACTOR, p_source: SOURCE, p_request: APPLICATION, p_close: false } });
    expectData(await x.call({ workspace: false, method: 'POST', body: { operation: 'close', requestId: APPLICATION, sourceId: SOURCE } }), receipt);
    assert.deepEqual(x.state.calls.at(-1), { name: 'read_growth_partner_company_submission', args: {
      p_actor: ENTRY_ACTOR, p_source: SOURCE, p_request: APPLICATION, p_close: true } });
    const count = x.state.calls.length;
    expectFailure(await x.call({ workspace: false, query: { applicationId: APPLICATION, revision: REVISION } }), 400, 'invalid_partner_company_query');
    expectFailure(await x.call({ workspace: false, path: ['partner-entry', 'company'], method: 'POST', query: { op: 'context' }, body: {} }),
      503, 'partner_company_registration_unavailable');
    assert.equal((await x.call({ workspace: false, path: ['platform-partner-companies'] })).statusCode, 404);
    assert.equal(x.state.calls.length, count);
    expectData(await x.call(), x.state.data); expectRead(x);
  } finally { x.close(); }
});
