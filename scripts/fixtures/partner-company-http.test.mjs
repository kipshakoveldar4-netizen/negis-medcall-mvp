import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ACTOR, ENTRY_OTHER, ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';

after(stopPartnerEntryBuilds);

const ENTRY = 'partner-entry/company', RECOVERY = 'partner-company', PLATFORM = 'platform-partner-companies';
const REQUEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', REVISION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REVIEW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', TERMINAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WORKSPACE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const APPLICANT_TOKEN = 'owned.owner.signature', PLATFORM_TOKEN = 'owned.other.signature';
const EMAIL = 'applicant@example.invalid', CONFIRMED = '2026-10-27T00:00:00.000Z';
const COOKIE_KEY = Buffer.from('ab'.repeat(32), 'hex');
const COMPANY = { name: 'Owned synthetic company', purpose: 'marketing', vertical: null, timeZone: 'Asia/Almaty', ownerName: 'Owned Applicant' };
const COMMAND = { requestId: REVIEW, applicationId: REQUEST, revision: REVISION, action: 'approve' };
const RPCS = ['claim_growth_partner_source', 'submit_growth_partner_company', 'read_growth_partner_company_submission',
  'list_growth_partner_companies', 'review_growth_partner_company', 'read_growth_partner_company_review'];
const user = (changes = {}) => ({ id: ENTRY_ACTOR, email: EMAIL, email_confirmed_at: CONFIRMED, ...changes });
const plain = value => JSON.parse(JSON.stringify(value));

async function setup(options = {}) {
  const state = { calls: [], direct: [], unexpected: [], data: null, error: null, throws: false };
  // Only returned database data is synthetic; no HTTP or database business logic is reproduced here.
  const db = {
    from(...args) { state.direct.push(args); throw Error('PRIVATE_DIRECT_TABLE_ACCESS'); },
    async rpc(name, args) {
      state.calls.push({ name, args: structuredClone(args) });
      if (!RPCS.includes(name)) { state.unexpected.push(name); throw Error('PRIVATE_UNEXPECTED_RPC'); }
      if (state.throws) throw Error('PRIVATE_DATABASE_EXCEPTION');
      return { data: state.data, error: state.error };
    },
  };
  const authUsers = options.authUsers ?? new Map([[APPLICANT_TOKEN, user()], [PLATFORM_TOKEN, user({ id: ENTRY_OTHER, email: 'platform@example.invalid' })]]);
  const f = await partnerEntryHttpFixture(db, { ...options, company: options.company ?? true, authUsers,
    env: { MEDINA_PLATFORM_OWNER_IDS: ENTRY_OTHER, ...options.env } });
  const frame = f.cookies.newPartnerEntryFrame('OWNED_CODE', 'link', f.notice.version, f.notice.sha256, Date.now() - 1000);
  const expiresAt = new Date(Date.parse(frame.startedAt) + f.cookies.PARTNER_WINDOW_MS).toISOString();
  const cookieHeader = f.cookies.partnerEntrySetCookie(frame, ENTRY_ORIGIN, COOKIE_KEY, Date.now());
  const cookie = cookieHeader.split(';')[0];
  const source = () => ({ id: frame.id, capturedAt: frame.startedAt.replace('Z', '000Z'), expiresAt: expiresAt.replace('Z', '000Z'),
    policyVersion: f.cookies.PARTNER_POLICY_VERSION, state: 'captured', source: frame.source, workspaceId: null });
  const application = (changes = {}) => ({ id: REQUEST, revision: REVISION, state: 'pending', company: { ...COMPANY },
    workspaceId: null, sourceState: 'captured', expiresAt, submittedAt: frame.startedAt, reviewedAt: null, ...changes });
  const reviewedAt = new Date(Date.parse(frame.startedAt) + 500).toISOString();
  const terminal = (action = 'approve') => application({ revision: TERMINAL, state: action === 'approve' ? 'approved' : 'rejected',
    workspaceId: action === 'approve' ? WORKSPACE : null, sourceState: action === 'approve' ? 'pending_payment' : 'captured', reviewedAt });
  const submissionReceipt = (status = 'committed', app = application()) => ({ state: status, requestId: REQUEST, sourceId: frame.id,
    ...(status === 'committed' ? { application: app } : {}) });
  const reviewReceipt = (status = 'committed', command = COMMAND, app = terminal(command.action)) => ({ ...command, state: status,
    ...(status === 'committed' ? { application: app } : {}) });
  const submit = (changes = {}) => ({ requestId: REQUEST, company: { ...COMPANY }, consent: true, consentVersion: f.companyNotice.version, ...changes });
  const readQuery = () => ({ requestId: REQUEST, sourceId: frame.id });
  const closeBody = () => ({ operation: 'close', ...readQuery() });

  async function call(path = ENTRY, config = {}) {
    const { method = path === ENTRY ? 'POST' : 'GET', query = {}, body = path === ENTRY ? {} : undefined,
      token = path === PLATFORM ? PLATFORM_TOKEN : APPLICANT_TOKEN, headers = {}, raw,
      cookie: requestCookie = path === ENTRY ? cookie : undefined } = config;
    const bytes = raw ?? (body === undefined ? '' : JSON.stringify(body));
    let bodyReads = 0;
    const req = Readable.from((function* () { bodyReads++; yield Buffer.from(bytes); })());
    Object.assign(req, { url: '/api/crm/' + path, method, query: { path: path.split('/'), ...query },
      headers: { origin: ENTRY_ORIGIN, 'content-type': 'application/json', ...(requestCookie ? { cookie: requestCookie } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers } });
    if (config.preparsed) req.body = body;
    if (config.rawBody !== undefined) req.rawBody = config.rawBody;
    const res = { statusCode: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      status(v) { this.statusCode = v; return this; },
      json(v) { this.body = plain(v); return this; },
      end(v) { this.body = v; return this; } };
    await f.handler(req, res);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(f.state.unexpected, [], 'No real network or unapproved provider boundary');
    assert.deepEqual(f.state.challenges, [], 'Company routes never invoke the challenge provider');
    assert.deepEqual(state.direct, [], 'Company routes never access tables directly');
    assert.deepEqual(state.unexpected, [], 'Company routes never fall through to a broader RPC');
    const serialized = JSON.stringify(res.body);
    for (const secret of ['PRIVATE_', f.env.SUPABASE_SERVICE_ROLE_KEY, f.env.MEDINA_PARTNER_ENTRY_COOKIE_KEY,
      f.env.MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET, frame.token, APPLICANT_TOKEN, PLATFORM_TOKEN].filter(v => typeof v === 'string' && v.length))
      assert.ok(!serialized?.includes(secret), 'Response must not expose private diagnostics or credentials');
    assert.equal(res.headers['set-cookie'], undefined, 'Company operations cannot reset the original attribution window');
    return { ...res, bodyReads };
  }
  return { f, state, authUsers, frame, cookie, cookieHeader, expiresAt, source, application, terminal,
    submissionReceipt, reviewReceipt, submit, readQuery, closeBody, call, close: () => f.close() };
}

function expectFailure(response, status, code) {
  assert.equal(response.statusCode, status);
  assert.equal(response.body.success, false);
  assert.equal(response.body.code, code);
}
function expectData(response, data) {
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { success: true, data: plain(data) });
}

test('entry Auth precedes disabled configuration and neither absence nor invalid Auth reaches company storage', async () => {
  for (const options of [{}, { company: false }, { approved: false }, { env: { MEDINA_PARTNER_COMPANY_ENABLED: 'false' } }]) {
    const x = await setup(options);
    try {
      for (const token of [null, 'not-a-jwt', 'owned.forged.signature']) {
        const r = await x.call(ENTRY, { token, query: { op: 'context' }, raw: '{PRIVATE_BAD_JSON' });
        expectFailure(r, 401, 'authentication_required'); assert.equal(r.bodyReads, 0);
      }
      assert.equal(x.state.calls.length, 0);
    } finally { x.close(); }
  }
});

test('company registration needs explicit enabled configuration and both real approved registry purposes', async () => {
  for (const options of [{ company: false }, { approved: false },
    ...['MEDINA_PARTNER_ENTRY_ENABLED', 'MEDINA_PARTNER_COMPANY_ENABLED'].map(key => ({ env: { [key]: 'false' } })),
    ...['MEDINA_APP_ORIGIN', 'MEDINA_PARTNER_ENTRY_COOKIE_KEY', 'MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET',
      'MEDINA_PARTNER_ENTRY_TURNSTILE_SITE_KEY', 'MEDINA_PARTNER_ENTRY_CONSENT_VERSION', 'MEDINA_PARTNER_COMPANY_CONSENT_VERSION'].map(key => ({ env: { [key]: '' } })),
    { env: { MEDINA_PARTNER_COMPANY_CONSENT_VERSION: 'owned-partner-v1' } },
    { env: { MEDINA_PARTNER_ENTRY_CONSENT_VERSION: 'owned-company-v1' } },
    { env: { MEDINA_PARTNER_COMPANY_CONSENT_VERSION: 'not-approved' } }]) {
    const x = await setup(options);
    try {
      for (const op of ['context', 'submit']) expectFailure(await x.call(ENTRY, { query: { op }, body: op === 'submit' ? x.submit() : {} }),
        503, 'partner_company_registration_unavailable');
      assert.equal(x.state.calls.length, 0);
    } finally { x.close(); }
  }
});

test('entry accepts only exact context/submit selectors and exact same origin before body or RPC access', async () => {
  const x = await setup();
  try {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
      expectFailure(await x.call(ENTRY, { method, query: { op: 'context' } }), 405, 'method_not_allowed');
    for (const query of [{}, { op: 'notice' }, { op: ['context'] }, { op: '' }, { op: 'CONTEXT' },
      ...['actor', 'sourceId', 'requestId', 'email', 'workspaceId', 'token'].map(k => ({ op: 'context', [k]: ENTRY_OTHER }))])
      expectFailure(await x.call(ENTRY, { query }), 400, 'invalid_partner_company_query');
    for (const origin of [undefined, '', ENTRY_ORIGIN + '/', 'https://foreign.fixture.invalid', [ENTRY_ORIGIN]]) {
      const r = await x.call(ENTRY, { query: { op: 'context' }, headers: { origin }, raw: '{PRIVATE_BAD_JSON' });
      expectFailure(r, 403, 'origin_denied'); assert.equal(r.bodyReads, 0);
    }
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('entry uses a bounded exact JSON body without coercing consent, company values or browser authority', async () => {
  const x = await setup();
  try {
    for (const config of [{ raw: '{bad' }, { raw: 'null' }, { raw: '[]' },
      { raw: '{}', headers: { 'content-type': 'text/plain' } }, { body: { private: 'extra' }, preparsed: true }])
      expectFailure(await x.call(ENTRY, { query: { op: 'context' }, ...config }), 400, 'invalid_partner_company_request');
    for (const config of [{ raw: ' '.repeat(8193) }, { raw: '{}', headers: { 'content-length': '8193' } }, { rawBody: Buffer.alloc(8193) }])
      expectFailure(await x.call(ENTRY, { query: { op: 'context' }, ...config }), 413, 'request_body_too_large');
    for (const body of [x.submit({ consent: false }), x.submit({ consent: 'true' }), x.submit({ consentVersion: 'owned-partner-v1' }),
      x.submit({ requestId: [REQUEST] }), x.submit({ requestId: ' ' + REQUEST }), x.submit({ company: { ...COMPANY, vertical: 'clinic' } }),
      x.submit({ company: { ...COMPANY, timeZone: 'unknown/timezone' } }), x.submit({ company: { ...COMPANY, ownerName: '' } }),
      ...['actor', 'email', 'applicantEmail', 'emailConfirmed', 'origin', 'sourceId', 'source', 'workspaceId', 'capabilityHash', 'notice', 'startedAt'].map(k => x.submit({ [k]: ENTRY_OTHER })),
      x.submit({ company: { ...COMPANY, email: EMAIL } }), x.submit({ company: { ...COMPANY, workspaceId: WORKSPACE } })])
      expectFailure(await x.call(ENTRY, { query: { op: 'submit' }, body }), 400, 'invalid_partner_company_request');
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('only directly verified Auth email confirmation and a nonsynthetic email authorize context or submit', async () => {
  const x = await setup();
  try {
    for (const identity of [user({ email: undefined }), user({ email: 'not-an-email' }), user({ email: 'x'.repeat(250) + '@example.invalid' }),
      user({ email: 'owned@staff.negis.online' }), user({ email: 'OWNED@STAFF.NEGIS.LOCAL' }),
      user({ email_confirmed_at: undefined }), user({ email_confirmed_at: null }), user({ email_confirmed_at: true }),
      user({ email_confirmed_at: '2026-02-31T00:00:00.000Z' }), user({ email_confirmed_at: 'not-a-date' }),
      user({ email_confirmed_at: undefined, confirmed_at: CONFIRMED }),
      user({ email_confirmed_at: undefined, emailConfirmed: true }),
      user({ email_confirmed_at: undefined, user_metadata: { email: EMAIL, email_confirmed_at: CONFIRMED, emailConfirmed: true }, app_metadata: { emailConfirmed: true } })]) {
      x.authUsers.set(APPLICANT_TOKEN, identity);
      for (const op of ['context', 'submit']) expectFailure(await x.call(ENTRY, { query: { op }, body: op === 'submit' ? x.submit() : {} }),
        403, 'partner_company_confirmed_email_required');
    }
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('context claims only the sealed original source and returns the approved notice with trusted readonly email', async () => {
  const x = await setup();
  try {
    x.state.data = x.source();
    x.authUsers.set(APPLICANT_TOKEN, user({ user_metadata: { id: ENTRY_OTHER, email: 'forged@example.invalid' } }));
    const r = await x.call(ENTRY, { query: { op: 'context' } });
    expectData(r, { sourceId: x.frame.id, expiresAt: x.expiresAt, notice: x.f.companyNotice, applicantEmail: EMAIL });
    assert.deepEqual(x.state.calls, [{ name: 'claim_growth_partner_source', args: {
      p_actor: ENTRY_ACTOR, p_intent: x.frame.id, p_capability_hash: x.f.cookies.partnerCapabilityHash(x.frame) } }]);
    assert.match(x.cookieHeader, /Path=\/api\/crm\/partner-entry; Secure; HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(JSON.stringify(r.body), /capability|OWNED_CODE|user_metadata|auth_user_id/);
  } finally { x.close(); }
});

test('JWT payload claims cannot replace the trusted Auth response subject, email or email confirmation', async () => {
  const x = await setup();
  try {
    const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: ENTRY_OTHER, email: 'forged@example.invalid', email_confirmed_at: CONFIRMED,
        emailConfirmed: true, role: 'platform' })).toString('base64url'), 'owned-fixture-signature'].join('.');
    x.authUsers.set(token, user({ email_confirmed_at: undefined }));
    expectFailure(await x.call(ENTRY, { token, query: { op: 'context' } }), 403, 'partner_company_confirmed_email_required');
    assert.equal(x.state.calls.length, 0);
    x.authUsers.set(token, user()); x.state.data = x.source();
    const r = await x.call(ENTRY, { token, query: { op: 'context' } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.data.applicantEmail, EMAIL);
    assert.equal(x.state.calls.at(-1).args.p_actor, ENTRY_ACTOR);
    assert.equal(x.f.state.auth.at(-1), 'Bearer ' + token);
    assert.ok(!JSON.stringify(r.body).includes(token));
  } finally { x.close(); }
});

test('missing, tampered, duplicate, wrong-origin and expired sealed cookies cannot claim or submit', async () => {
  const x = await setup();
  try {
    const old = x.f.cookies.newPartnerEntryFrame('OWNED_CODE', 'link', x.f.notice.version, x.f.notice.sha256, Date.now() - 8 * 86400000);
    const wrongNotice = { ...x.frame, consentHash: '0'.repeat(64) };
    for (const [cookie, status, code] of [[null, 409, 'partner_entry_not_prepared'], [x.cookie + 'a', 409, 'partner_entry_not_prepared'],
      [x.cookie + '; ' + x.cookie, 409, 'partner_entry_not_prepared'],
      ['__Secure-medina_partner_entry=' + x.f.cookies.sealPartnerEntry(x.frame, 'https://foreign.fixture.invalid', COOKIE_KEY), 409, 'partner_entry_not_prepared'],
      ['__Secure-medina_partner_entry=' + x.f.cookies.sealPartnerEntry(old, ENTRY_ORIGIN, COOKIE_KEY), 410, 'partner_entry_expired'],
      ['__Secure-medina_partner_entry=' + x.f.cookies.sealPartnerEntry(wrongNotice, ENTRY_ORIGIN, COOKIE_KEY), 409, 'partner_notice_changed']]) {
      for (const op of ['context', 'submit']) expectFailure(await x.call(ENTRY, { cookie, query: { op }, body: op === 'submit' ? x.submit() : {} }), status, code);
    }
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('context rejects private, unconfirmed, foreign or contradictory source acknowledgements', async () => {
  const x = await setup();
  try {
    for (const data of [null, { state: 'unconfirmed' }, { ...x.source(), id: ENTRY_OTHER }, { ...x.source(), workspaceId: WORKSPACE },
      { ...x.source(), state: 'pending_payment' }, { ...x.source(), source: 'promo_code' }, { ...x.source(), policyVersion: 'unknown' },
      { ...x.source(), capturedAt: new Date().toISOString() }, { ...x.source(), expiresAt: new Date().toISOString() },
      { ...x.source(), actor: ENTRY_OTHER }, { ...x.source(), private: 'PRIVATE_SOURCE_DIAGNOSTIC' }]) {
      x.state.data = data;
      expectFailure(await x.call(ENTRY, { query: { op: 'context' } }), 503, 'partner_company_unconfirmed');
    }
  } finally { x.close(); }
});

test('submit uses exact verified actor/email, sealed capability/source and approved full company notice RPC scope', async () => {
  const x = await setup();
  try {
    const body = x.submit(); x.state.data = x.application();
    expectData(await x.call(ENTRY, { query: { op: 'submit' }, body }), x.submissionReceipt());
    assert.deepEqual(x.state.calls, [{ name: 'submit_growth_partner_company', args: { p_actor: ENTRY_ACTOR, p_source: x.frame.id,
      p_capability_hash: x.f.cookies.partnerCapabilityHash(x.frame), p_request: REQUEST, p_company: COMPANY, p_email: EMAIL, p_consent: x.f.companyNotice } }]);
    assert.deepEqual(body, x.submit(), 'Handler does not rewrite the original retry payload');
    x.authUsers.set(APPLICANT_TOKEN, user({ id: ENTRY_OTHER, email: 'second@example.invalid' }));
    expectData(await x.call(ENTRY, { query: { op: 'submit' }, body }), x.submissionReceipt());
    assert.equal(x.state.calls.at(-1).args.p_actor, ENTRY_OTHER);
    assert.equal(x.state.calls.at(-1).args.p_email, 'second@example.invalid');
  } finally { x.close(); }
});

test('submit accepts only an exact application identity, company and original expiry as a committed acknowledgement', async () => {
  const x = await setup();
  try {
    for (const data of [null, { state: 'unconfirmed' }, x.submissionReceipt('unconfirmed'), x.submissionReceipt(),
      x.application({ id: ENTRY_OTHER }), x.application({ company: { ...COMPANY, name: 'Different original company' } }),
      x.application({ expiresAt: new Date(Date.parse(x.expiresAt) + 1000).toISOString() }), x.application({ workspaceId: WORKSPACE }),
      x.application({ reviewedAt: new Date().toISOString() }), x.application({ owner_email: 'PRIVATE_EMAIL' })]) {
      x.state.data = data;
      expectFailure(await x.call(ENTRY, { query: { op: 'submit' }, body: x.submit() }), 503, 'partner_company_unconfirmed');
    }
    x.state.data = x.application();
    expectData(await x.call(ENTRY, { query: { op: 'submit' }, body: x.submit() }), x.submissionReceipt());
    assert.ok(x.state.calls.every(v => v.name === 'submit_growth_partner_company'));
  } finally { x.close(); }
});

test('applicant recovery and explicit close survive expired or absent cookies and entirely disabled intake/notices', async () => {
  const x = await setup({ company: false, approved: false, env: { MEDINA_PARTNER_ENTRY_ENABLED: 'false', MEDINA_PARTNER_COMPANY_ENABLED: 'false',
    MEDINA_PARTNER_ENTRY_COOKIE_KEY: '', MEDINA_PARTNER_COMPANY_CONSENT_VERSION: '' },
    authUsers: new Map([[APPLICANT_TOKEN, { id: ENTRY_ACTOR }]]) });
  try {
    const old = x.f.cookies.newPartnerEntryFrame('OWNED_CODE', 'link', x.f.notice.version, x.f.notice.sha256, Date.now() - 8 * 86400000);
    const expired = '__Secure-medina_partner_entry=' + x.f.cookies.sealPartnerEntry(old, ENTRY_ORIGIN, COOKIE_KEY);
    for (const cookie of [undefined, expired, 'invalid-cookie']) {
      x.state.data = x.submissionReceipt('unconfirmed');
      expectData(await x.call(RECOVERY, { query: x.readQuery(), cookie }), x.state.data);
      assert.deepEqual(x.state.calls.at(-1), { name: 'read_growth_partner_company_submission', args: {
        p_actor: ENTRY_ACTOR, p_source: x.frame.id, p_request: REQUEST, p_close: false } });
      x.state.data = x.submissionReceipt('abandoned');
      expectData(await x.call(RECOVERY, { method: 'POST', body: x.closeBody(), cookie }), x.state.data);
      assert.deepEqual(x.state.calls.at(-1), { name: 'read_growth_partner_company_submission', args: {
        p_actor: ENTRY_ACTOR, p_source: x.frame.id, p_request: REQUEST, p_close: true } });
      x.state.data = x.submissionReceipt('committed', x.terminal());
      expectData(await x.call(RECOVERY, { method: 'POST', body: x.closeBody(), cookie }), x.state.data);
      assert.equal(x.state.data.application.state, 'approved', 'Closing a receipt never means cancelling an approved company');
    }
  } finally { x.close(); }
});

test('applicant recovery requires verified Auth, exact selectors and same-origin explicit close before RPC', async () => {
  const x = await setup();
  try {
    expectFailure(await x.call(RECOVERY, { token: null, query: x.readQuery() }), 401, 'authentication_required');
    for (const query of [{}, { requestId: REQUEST }, { sourceId: x.frame.id }, { ...x.readQuery(), requestId: [REQUEST] },
      { ...x.readQuery(), sourceId: [x.frame.id] }, { ...x.readQuery(), requestId: ' ' + REQUEST },
      ...['actor', 'email', 'workspaceId', 'operation', 'offset'].map(k => ({ ...x.readQuery(), [k]: ENTRY_OTHER }))])
      assert.equal((await x.call(RECOVERY, { query })).statusCode, 400);
    assert.equal((await x.call(RECOVERY, { query: x.readQuery(), body: { actor: ENTRY_OTHER }, preparsed: true })).statusCode, 400);
    for (const body of [{ ...x.closeBody(), actor: ENTRY_OTHER }, { ...x.closeBody(), email: EMAIL },
      { ...x.closeBody(), workspaceId: WORKSPACE }, { ...x.closeBody(), operation: 'cancel' }, { ...x.closeBody(), requestId: [REQUEST] }])
      expectFailure(await x.call(RECOVERY, { method: 'POST', body }), 400, 'invalid_partner_company_request');
    for (const origin of [undefined, ENTRY_ORIGIN + '/', 'https://foreign.fixture.invalid'])
      expectFailure(await x.call(RECOVERY, { method: 'POST', body: x.closeBody(), headers: { origin } }), 403, 'origin_denied');
    expectFailure(await x.call(RECOVERY, { method: 'POST', query: x.readQuery(), body: x.closeBody() }), 400, 'invalid_partner_company_request');
    assert.equal(x.state.calls.length, 0);
    x.state.data = x.submissionReceipt();
    expectData(await x.call(RECOVERY, { query: x.readQuery(), headers: { origin: undefined } }), x.state.data);
  } finally { x.close(); }
});

test('applicant recovery rejects mismatched, extra or unconfirmed close receipts without claiming success', async () => {
  const x = await setup();
  try {
    for (const data of [null, { state: 'unconfirmed' }, { ...x.submissionReceipt(), sourceId: ENTRY_OTHER },
      { ...x.submissionReceipt(), requestId: ENTRY_OTHER }, { ...x.submissionReceipt(), private: 'PRIVATE_RECEIPT' },
      { ...x.submissionReceipt(), application: x.application({ id: ENTRY_OTHER }) }]) {
      x.state.data = data;
      expectFailure(await x.call(RECOVERY, { query: x.readQuery() }), 503, 'partner_company_unconfirmed');
    }
    x.state.data = x.submissionReceipt('unconfirmed');
    expectFailure(await x.call(RECOVERY, { method: 'POST', body: x.closeBody() }), 503, 'partner_company_unconfirmed');
    x.state.data = x.submissionReceipt('abandoned');
    expectData(await x.call(RECOVERY, { query: x.readQuery() }), x.state.data);
  } finally { x.close(); }
});

test('submission and recovery selectors reject UUIDs that cannot be represented by the portable receipt contract', async () => {
  const x = await setup();
  try {
    const observed = [];
    for (const id of ['00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa']) {
      observed.push((await x.call(ENTRY, { query: { op: 'submit' }, body: x.submit({ requestId: id }) })).statusCode);
      observed.push((await x.call(RECOVERY, { query: { ...x.readQuery(), requestId: id } })).statusCode);
      observed.push((await x.call(RECOVERY, { query: { ...x.readQuery(), sourceId: id } })).statusCode);
      observed.push((await x.call(RECOVERY, { method: 'POST', body: { ...x.closeBody(), requestId: id } })).statusCode);
    }
    assert.deepEqual(observed, Array(12).fill(400), 'Unsupported receipt identities must fail before any mutation or recovery RPC');
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('platform routes conceal anonymous, ordinary, forged and unavailable Auth before method and malformed body', async () => {
  const x = await setup();
  try {
    const missing = await x.call('owned-missing-company-route', { token: null });
    for (const token of [null, APPLICANT_TOKEN, 'owned.forged.signature']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const r = await x.call(PLATFORM, { token, method, raw: '{PRIVATE_MALFORMED_BODY' });
        assert.equal(r.statusCode, 404); assert.deepEqual(r.body, missing.body); assert.deepEqual(r.headers, missing.headers); assert.equal(r.bodyReads, 0);
      }
    }
    x.f.state.authUnavailable = true;
    assert.equal((await x.call(PLATFORM, { method: 'PUT' })).statusCode, 404);
    x.f.state.authUnavailable = false;
    assert.equal((await x.call(PLATFORM, { method: 'PUT', raw: '{bad' })).statusCode, 405);
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('platform identity is an allowlisted verified subject, never email or user metadata', async () => {
  for (const env of [{ MEDINA_PLATFORM_OWNER_IDS: EMAIL }, { MEDINA_PLATFORM_OWNER_IDS: '' }]) {
    const x = await setup({ env });
    try { assert.equal((await x.call(PLATFORM)).statusCode, 404); assert.equal(x.state.calls.length, 0); } finally { x.close(); }
  }
  const x = await setup();
  try {
    x.authUsers.set(APPLICANT_TOKEN, user({ user_metadata: { id: ENTRY_OTHER, role: 'platform', platformOwner: true }, email: 'platform@example.invalid' }));
    assert.equal((await x.call(PLATFORM, { token: APPLICANT_TOKEN })).statusCode, 404);
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('platform lists only the requested exact page/filter and rejects ambiguous or coerced selectors before RPC', async () => {
  const x = await setup({ approved: false, company: false });
  try {
    for (const [query, offset, state] of [[{}, 0, null], [{ offset: '20', state: 'pending' }, 20, 'pending'],
      [{ offset: '0', state: 'approved' }, 0, 'approved'], [{ offset: '0', state: 'rejected' }, 0, 'rejected']]) {
      x.state.data = { items: [], offset, state, hasMore: false };
      expectData(await x.call(PLATFORM, { query }), x.state.data);
      assert.deepEqual(x.state.calls.at(-1), { name: 'list_growth_partner_companies', args: { p_owner: ENTRY_OTHER, p_offset: offset, p_state: state } });
    }
    const count = x.state.calls.length;
    for (const query of [{ offset: ['0'] }, { offset: 0 }, { offset: '-1' }, { offset: '01' }, { offset: '1.0' }, { offset: '1e2' },
      { offset: '1000001' }, { offset: '' }, { state: ['pending'] }, { state: 'all' }, { state: '' },
      { state: 'pending', requestId: REVIEW }, { offset: '0', ...COMMAND },
      ...['actor', 'owner', 'workspaceId', 'email', 'limit'].map(k => ({ [k]: ENTRY_ACTOR }))])
      assert.equal((await x.call(PLATFORM, { query })).statusCode, 400);
    assert.equal(x.state.calls.length, count);
  } finally { x.close(); }
});

test('platform validates returned page identity, filter, strict DTOs, ordering and 20-row pagination', async () => {
  const x = await setup();
  try {
    const page = { items: [x.application()], offset: 20, state: 'pending', hasMore: false };
    for (const data of [null, { ...page, offset: 0 }, { ...page, state: null }, { ...page, hasMore: true },
      { ...page, private: 'PRIVATE_PAGE' }, { ...page, items: [x.terminal()] }, { ...page, items: [x.application(), x.application()] },
      { ...page, items: [x.application(), x.application({ id: WORKSPACE })] },
      { ...page, items: Array.from({ length: 21 }, () => x.application()) }]) {
      x.state.data = data;
      expectFailure(await x.call(PLATFORM, { query: { offset: '20', state: 'pending' } }), 503, 'partner_company_unconfirmed');
    }
    x.state.data = { ...page, items: [x.application({ id: WORKSPACE }), x.application()] };
    expectData(await x.call(PLATFORM, { query: { offset: '20', state: 'pending' } }), x.state.data);
    x.state.data = { ...page, items: Array.from({ length: 20 }, (_, n) => x.application({
      id: 'ffffffff-ffff-4fff-8fff-' + (20 - n).toString(16).padStart(12, '0') })), hasMore: true };
    expectData(await x.call(PLATFORM, { query: { offset: '20', state: 'pending' } }), x.state.data);
    x.state.data = { ...page, items: [x.application({ submittedAt: new Date(Date.parse(x.frame.startedAt) - 1000).toISOString() }),
      x.application({ id: WORKSPACE })] };
    expectFailure(await x.call(PLATFORM, { query: { offset: '20', state: 'pending' } }), 503, 'partner_company_unconfirmed');
  } finally { x.close(); }
});

test('platform review, receipt and close preserve the exact original tuple and committed close is not rejection', async () => {
  const x = await setup({ company: false, approved: false });
  try {
    for (const action of ['approve', 'reject']) {
      const command = { ...COMMAND, action }, args = { p_owner: ENTRY_OTHER, p_application: REQUEST, p_revision: REVISION, p_request: REVIEW, p_action: action };
      x.state.data = x.terminal(action);
      expectData(await x.call(PLATFORM, { method: 'POST', body: command }), x.reviewReceipt('committed', command));
      assert.deepEqual(x.state.calls.at(-1), { name: 'review_growth_partner_company', args });
      x.state.data = x.reviewReceipt('unconfirmed', command);
      expectData(await x.call(PLATFORM, { query: command }), x.state.data);
      assert.deepEqual(x.state.calls.at(-1), { name: 'read_growth_partner_company_review', args: { ...args, p_close: false } });
      for (const status of ['abandoned', 'committed']) {
        x.state.data = x.reviewReceipt(status, command);
        expectData(await x.call(PLATFORM, { method: 'POST', body: { operation: 'close', ...command } }), x.state.data);
        assert.deepEqual(x.state.calls.at(-1), { name: 'read_growth_partner_company_review', args: { ...args, p_close: true } });
      }
    }
  } finally { x.close(); }
});

test('platform commands and receipt selectors reject body authority, arrays, missing or mixed original metadata', async () => {
  const x = await setup();
  try {
    for (const command of [{ ...COMMAND, requestId: [REVIEW] }, { ...COMMAND, applicationId: [REQUEST] }, { ...COMMAND, revision: null },
      { ...COMMAND, action: 'APPROVE' }, { ...COMMAND, action: 'approve ' }, { ...COMMAND, operation: 'cancel' },
      ...['actor', 'owner', 'email', 'workspaceId', 'company', 'side', 'sourceId'].map(k => ({ ...COMMAND, [k]: ENTRY_ACTOR }))]) {
      assert.equal((await x.call(PLATFORM, { method: 'POST', body: command })).statusCode, 400);
      assert.equal((await x.call(PLATFORM, { query: command })).statusCode, 400);
    }
    for (const key of Object.keys(COMMAND)) {
      const command = { ...COMMAND }; delete command[key];
      assert.equal((await x.call(PLATFORM, { method: 'POST', body: command })).statusCode, 400);
      assert.equal((await x.call(PLATFORM, { query: command })).statusCode, 400);
    }
    assert.equal((await x.call(PLATFORM, { method: 'POST', query: { state: 'pending' }, body: COMMAND })).statusCode, 400);
    assert.equal((await x.call(PLATFORM, { method: 'POST', body: { operation: 'close', ...COMMAND, actor: ENTRY_ACTOR } })).statusCode, 400);
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('platform mutation and recovery reject mismatched revisions, identities, decisions or unconfirmed close', async () => {
  const x = await setup();
  try {
    for (const data of [null, { state: 'unconfirmed' }, x.reviewReceipt('unconfirmed'), x.reviewReceipt(),
      x.terminal('reject'), { ...x.terminal(), id: ENTRY_OTHER },
      { ...x.terminal(), revision: REVISION }, { ...x.terminal(), state: 'pending' }, { ...x.terminal(), private: 'PRIVATE_REVIEW' }]) {
      x.state.data = data;
      expectFailure(await x.call(PLATFORM, { method: 'POST', body: COMMAND }), 503, 'partner_company_unconfirmed');
    }
    for (const data of [{ ...x.reviewReceipt(), requestId: ENTRY_ACTOR }, { ...x.reviewReceipt(), applicationId: ENTRY_ACTOR },
      { ...x.reviewReceipt(), revision: ENTRY_ACTOR }, { ...x.reviewReceipt(), action: 'reject' },
      { ...x.reviewReceipt(), application: x.terminal('reject') }, { ...x.reviewReceipt(), private: 'PRIVATE_REVIEW_RECEIPT' }]) {
      x.state.data = data;
      expectFailure(await x.call(PLATFORM, { query: COMMAND }), 503, 'partner_company_unconfirmed');
    }
    x.state.data = x.reviewReceipt('unconfirmed');
    expectFailure(await x.call(PLATFORM, { method: 'POST', body: { operation: 'close', ...COMMAND } }), 503, 'partner_company_unconfirmed');
    x.state.data = x.reviewReceipt('committed');
    expectData(await x.call(PLATFORM, { query: { ...COMMAND, revision: REVISION.toUpperCase() } }), x.state.data);
  } finally { x.close(); }
});

test('RPC refusals/conflicts remain distinct from opaque unknown outcomes on every company operation', async () => {
  const x = await setup();
  try {
    const routes = [[ENTRY, { query: { op: 'context' } }], [ENTRY, { query: { op: 'submit' }, body: x.submit() }],
      [RECOVERY, { query: x.readQuery() }], [RECOVERY, { method: 'POST', body: x.closeBody() }],
      [PLATFORM, {}], [PLATFORM, { method: 'POST', body: COMMAND }], [PLATFORM, { query: COMMAND }],
      [PLATFORM, { method: 'POST', body: { operation: 'close', ...COMMAND } }]];
    for (const [code, status, expected] of [['P1133', 410, 'partner_entry_expired'],
      ['P1211', 403, 'partner_company_access_denied'], ['P1121', 403, 'partner_company_access_denied'],
      ['P1213', 409, 'partner_company_changed'], ['P1253', 409, 'partner_company_changed'],
      ...['P1212', 'P1252', '42P01', '57014', 'unknown'].map(code => [code, 503, 'partner_company_unconfirmed'])]) {
      x.state.error = { code, message: 'PRIVATE_SQL_DIAGNOSTIC', details: 'PRIVATE_CONTACT', hint: 'PRIVATE_HINT' };
      for (const [path, config] of routes) {
        const r = await x.call(path, config); expectFailure(r, status, expected);
        assert.deepEqual(r.body, { success: false, code: expected });
      }
    }
    x.state.error = null; x.state.throws = true;
    for (const [path, config] of routes) expectFailure(await x.call(path, config), 503, 'partner_company_unconfirmed');
  } finally { x.close(); }
});

test('Auth and missing-storage failures cannot dispatch or expose private company data', async () => {
  const x = await setup();
  try {
    x.f.state.authUnavailable = true;
    for (const [path, config] of [[ENTRY, { query: { op: 'context' } }], [ENTRY, { query: { op: 'submit' }, body: x.submit() }],
      [RECOVERY, { query: x.readQuery() }], [RECOVERY, { method: 'POST', body: x.closeBody() }]])
      expectFailure(await x.call(path, config), 503, 'authorization_unavailable');
    assert.equal(x.state.calls.length, 0);
    x.f.state.authUnavailable = false; x.f.install(() => null);
    for (const [path, config] of [[ENTRY, { query: { op: 'context' } }], [ENTRY, { query: { op: 'submit' }, body: x.submit() }],
      [RECOVERY, { query: x.readQuery() }], [RECOVERY, { method: 'POST', body: x.closeBody() }],
      [PLATFORM, {}], [PLATFORM, { method: 'POST', body: COMMAND }], [PLATFORM, { query: COMMAND }],
      [PLATFORM, { method: 'POST', body: { operation: 'close', ...COMMAND } }]])
      expectFailure(await x.call(path, config), 503, 'partner_company_unconfirmed');
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('authenticated recovery and platform POST bodies retain the central bounded parser before company RPCs', async () => {
  const x = await setup();
  try {
    for (const path of [RECOVERY, PLATFORM]) {
      expectFailure(await x.call(path, { method: 'POST', raw: '{PRIVATE_MALFORMED_BODY' }), 400, 'invalid_request_body');
      expectFailure(await x.call(path, { method: 'POST', raw: ' '.repeat(1024 * 1024 + 1) }), 413, 'request_body_too_large');
    }
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});

test('unregistered company subpaths never dispatch a company RPC or invoke providers', async () => {
  const x = await setup();
  try {
    for (const path of ['partner-entry/company/extra', 'partner-entry/companies'])
      assert.equal((await x.call(path, { token: null, query: { op: 'context' } })).statusCode, 404);
    assert.equal(x.f.state.auth.length, 0);
    for (const [path, token] of [['partner-company/extra', APPLICANT_TOKEN], ['platform-partner-companies/extra', PLATFORM_TOKEN]])
      assert.equal((await x.call(path, { token })).statusCode, 404);
    assert.equal(x.state.calls.length, 0);
  } finally { x.close(); }
});
