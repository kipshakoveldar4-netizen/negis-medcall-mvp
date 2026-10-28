import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { seedPartnerLedger } from './partner-ledger-cases.mjs';
import { partnerEntryHttpFixture } from './partner-entry-http-fixture.mjs';
import { startOwnedPartnerHttp } from './partner-entry-native-http-cases.mjs';

const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const TOKEN = 'owned.workspace.signature', FOREIGN_TOKEN = 'owned.foreign.workspace';
const READ_RPC = 'read_growth_partner_company';
const financialTables = ['platform_subscriptions', 'platform_subscription_payments', 'growth_referrals',
  'growth_partner_commissions', 'growth_partner_payouts', 'deals', 'growth_operator_arrivals'];
const companyTables = ['growth_contributor_profiles', 'growth_partners', 'growth_partner_sources',
  'growth_partner_company_applications', 'growth_partner_company_submission_fences',
  'growth_partner_company_review_fences', 'growth_partner_payment_windows', 'workspaces', 'staff_users', 'workspace_settings'];
export const partnerCompanyWorkspaceSnapshot = async (db, tables = [...financialTables, ...companyTables]) => (await db.query(
  'select * from (' + tables.map(table => `select '${table}' relation,to_jsonb(r) value from public.${table} r`)
    .join(' union all ') + ') owned_workspace_snapshot order by relation,value::text')).rows;
const financialSnapshot = db => partnerCompanyWorkspaceSnapshot(db, financialTables);

function consent() {
  const value = { version: 'owned-company-v1', purpose: 'partner_company_registration',
    text: 'SYNTHETIC COMPANY NOTICE, NOT LEGAL COPY', policyRevision: 'owned-only', policyUrl: 'https://policy.fixture.invalid/partner' };
  return { ...value, sha256: createHash('sha256').update(JSON.stringify([
    value.version, value.text, value.purpose, value.policyRevision, value.policyUrl])).digest('hex') };
}
async function transaction(db, run) {
  await db.query('begin');
  try { const result = await run(); await db.query('commit'); return result; }
  catch (error) { await db.query('rollback'); throw error; }
}
async function review(db, x, revision, action = 'approve') {
  return (await one(db, 'select public.review_growth_partner_company($1,$2,$3,$4,$5) value',
    [x.owner, x.request, revision, x.reviewRequest, action])).value;
}
async function seed(db, context, { state = 'approved', name = 'Owned native workspace company' } = {}) {
  const x = { actor: context.actor, owner: context.owner, source: randomUUID(), request: randomUUID(), reviewRequest: randomUUID(),
    proof: createHash('sha256').update(randomUUID()).digest('hex'), application: null, pendingRevision: null,
    company: { name, ownerName: 'Owned Applicant', purpose: 'marketing', vertical: null, timeZone: 'Asia/Almaty' } };
  context.applications.push(x);
  await transaction(db, async () => {
    await db.query('set local role service_role');
    await db.query("select public.capture_growth_partner_source_v2($1,$2,$3,'link',$4)",
      [x.source, x.proof, context.partner.code, new Date(Date.now() - 1000).toISOString()]);
    x.application = (await one(db, 'select public.submit_growth_partner_company($1,$2,$3,$4,$5,$6,$7) value',
      [x.actor, x.source, x.proof, x.request, x.company, 'applicant@example.invalid', consent()])).value;
    x.pendingRevision = x.application.revision;
    if (state !== 'pending') x.application = await review(db, x, x.pendingRevision, state === 'approved' ? 'approve' : 'reject');
  });
  return x;
}
async function cleanup(db, context) {
  await transaction(db, async () => {
    for (const x of [...context.applications].reverse()) {
      const stored = await one(db, 'select workspace_id from public.growth_partner_company_applications where id=$1 and applicant_auth_user_id=$2 and source_id=$3',
        [x.request, x.actor, x.source]);
      await db.query('delete from public.growth_partner_company_submission_fences where actor_id=$1 and request_id=$2 and source_id=$3', [x.actor, x.request, x.source]);
      await db.query('delete from public.growth_partner_company_review_fences where owner_id=$1 and request_id=$2 and application_id=$3', [x.owner, x.reviewRequest, x.request]);
      await db.query('delete from public.growth_partner_company_applications where id=$1 and applicant_auth_user_id=$2 and source_id=$3', [x.request, x.actor, x.source]);
      await db.query('delete from public.growth_partner_payment_windows where source_id=$1', [x.source]);
      if (stored?.workspace_id) {
        await db.query('delete from public.staff_users where workspace_id=$1 and auth_user_id=any($2::uuid[])',
          [stored.workspace_id, [x.actor, context.foreign]]);
        await db.query('delete from public.workspace_settings where workspace_id=$1', [stored.workspace_id]);
      }
      await db.query('delete from public.growth_partner_sources where id=$1 and partner_id=$2', [x.source, context.partner.partner]);
      if (stored?.workspace_id) await db.query('delete from public.workspaces where id=$1', [stored.workspace_id]);
    }
    if (context.partner) {
      await db.query('delete from public.growth_partners where id=$1 and auth_user_id=$2', [context.partner.partner, context.partner.actor]);
      await db.query('delete from public.growth_contributor_profiles where id=$1 and auth_user_id=$2', [context.partner.profile, context.partner.actor]);
    }
  });
}

async function withHttp(db, fixture, context, metrics, run) {
  const calls = [], forbidden = [], received = [];
  const adapter = new Proxy({ async rpc(name, args) {
    if (name !== READ_RPC || Object.keys(args).sort().join(',') !== 'p_actor,p_application') {
      forbidden.push({ name, args }); throw Error('PRIVATE_UNEXPECTED_WORKSPACE_RPC');
    }
    const call = { name, args: structuredClone(args), pid: null, data: null, error: null };
    calls.push(call); metrics.rpc++;
    const client = await fixture.connect();
    try {
      await client.query('set role service_role');
      const identity = await one(client, "select current_user role,pg_backend_pid() pid,current_setting('transaction_isolation') isolation");
      assert.equal(identity.role, 'service_role'); assert.equal(identity.isolation, 'read committed');
      call.pid = identity.pid;
      call.data = (await one(client, 'select public.read_growth_partner_company($1,$2) value', [args.p_actor, args.p_application])).value;
      return { data: call.data, error: null };
    } catch (error) {
      call.error = error.code;
      return { data: null, error: { code: error.code, message: 'PRIVATE_WORKSPACE_SQL_DIAGNOSTIC' } };
    } finally { await client.end(); }
  } }, { get(target, key, receiver) {
    if (key === 'rpc') return Reflect.get(target, key, receiver);
    forbidden.push(String(key)); throw Error('PRIVATE_DIRECT_DATABASE_OR_AUTH_LOOKUP');
  } });
  // Only the Auth boundary is synthetic: every allowed RPC reaches the owned native database unchanged.
  const f = await partnerEntryHttpFixture(adapter, { approved: false,
    authUsers: new Map([[TOKEN, { id: context.actor }], [FOREIGN_TOKEN, { id: context.foreign }]]),
    env: { MEDINA_PLATFORM_OWNER_IDS: '', MEDINA_PARTNER_ENTRY_ENABLED: 'false', MEDINA_PARTNER_COMPANY_ENABLED: 'false',
      MEDINA_APP_ORIGIN: '', MEDINA_PARTNER_ENTRY_COOKIE_KEY: '', MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET: '',
      MEDINA_PARTNER_ENTRY_CONSENT_VERSION: '', MEDINA_PARTNER_COMPANY_CONSENT_VERSION: '' } });
  let server;
  try {
    server = await startOwnedPartnerHttp((req, res) => {
      received.push({ url: req.url, query: structuredClone(req.query) });
      return f.handler(req, res);
    }, ['/api/crm/partner-company']);
    assert.equal(new URL(server.origin).hostname, '127.0.0.1');
    async function call(x, { query = {}, queryEntries = [], token = TOKEN, headers = {}, checkSnapshot = true } = {}) {
      const before = checkSnapshot ? await partnerCompanyWorkspaceSnapshot(db) : null;
      const start = calls.length;
      metrics.http++;
      const params = new URLSearchParams({ view: 'workspace', applicationId: x.request, revision: x.application.revision, ...query });
      for (const [key, value] of queryEntries) params.append(key, value);
      const response = await fetch(server.origin + '/api/crm/partner-company?' + params, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
      });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('set-cookie'), null);
      if (response.status !== 401) {
        assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      }
      const value = await response.json();
      assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|owned-only-not-credential|owned\.workspace\.signature|owned\.foreign\.workspace|auth_user_id|capability|sourceId|source_id|owner_email|consent_snapshot/);
      assert.ok(calls.length - start <= 1, 'One actual HTTP request cannot issue a retry, fallback or mutation RPC');
      if (checkSnapshot) assert.deepEqual(await partnerCompanyWorkspaceSnapshot(db), before, 'HTTP GET changes no exact financial or company row');
      return { status: response.status, value };
    }
    await run({ f, server, calls, call, received });
  } finally {
    try {
      if (server) { await server.close(); assert.deepEqual(server.state.errors, []); }
    } finally {
      f.close();
      assert.deepEqual(f.state.unexpected, [], 'No external network or providers');
      assert.deepEqual(f.state.challenges, [], 'No Turnstile or other provider sends');
      assert.deepEqual(forbidden, [], 'Only the existing service-role application read is allowed');
    }
  }
}
async function scenario(db, fixture, metrics, run) {
  const before = await partnerCompanyWorkspaceSnapshot(db), money = await financialSnapshot(db);
  const context = { actor: randomUUID(), foreign: randomUUID(), owner: randomUUID(), applications: [], partner: null };
  try {
    context.partner = await transaction(db, () => seedPartnerLedger(db));
    await withHttp(db, fixture, context, metrics, h => run({ ...context, ...h, seed: options => seed(db, context, options) }));
    assert.deepEqual(await financialSnapshot(db), money, 'No endpoint or seed creates subscriptions, payments, referrals, commissions, payouts, deals or arrivals');
  } finally {
    await cleanup(db, context);
    assert.deepEqual(await partnerCompanyWorkspaceSnapshot(db), before, 'Exact owned fixture cleanup restores every company and financial row');
  }
}
function expectData(response, application) {
  assert.deepEqual(response, { status: 200, value: { success: true, data: application } });
}
function expectFailure(response, status, code) {
  assert.deepEqual(response, { status, value: { success: false, code } });
}
function expectRead(h, x, actor = h.actor, expectedError = null) {
  const call = h.calls.at(-1);
  assert.deepEqual({ name: call.name, args: call.args, error: call.error }, {
    name: READ_RPC, args: { p_actor: actor, p_application: x.request }, error: expectedError });
  assert.ok(Number.isInteger(call.pid), 'The request reached an actual native PostgreSQL backend');
}
async function blocked(db, getWaiter, blocker, locktype) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiter = getWaiter();
    if (waiter) {
      const row = await one(db, `select pg_blocking_pids($1::int) blockers,
        exists(select 1 from pg_locks where pid=$1 and not granted and locktype=$2) expected`, [waiter, locktype]);
      if (row.blockers.includes(blocker) && row.expected) return { waiter, blocker, locktype, blockers: row.blockers };
    }
    await delay(10);
  }
  assert.fail('Expected pg_blocking_pids to prove the actual HTTP RPC ' + locktype + ' wait');
}
async function waitingHttp(db, fixture, h, x, metrics, t, { locktype, lock, change }) {
  const writer = await fixture.connect(); let pending;
  try {
    const blocker = (await one(writer, 'select pg_backend_pid() pid')).pid;
    await writer.query('begin'); await lock(writer);
    const start = h.calls.length;
    let settled = false;
    pending = observed(h.call(x, { checkSnapshot: false })).then(result => { settled = true; return result; });
    const proof = await blocked(db, () => h.calls[start]?.pid, blocker, locktype);
    assert.equal(settled, false, 'The HTTP response must still be waiting on the proven PostgreSQL lock');
    metrics.waits.push(proof);
    t.diagnostic(`Actual HTTP RPC pid ${proof.waiter} blocked by writer ${proof.blocker}; pg_blocking_pids=${JSON.stringify(proof.blockers)}; ${proof.locktype}.`);
    const changed = await change(writer, proof.waiter);
    await writer.query('reset role');
    const expected = await partnerCompanyWorkspaceSnapshot(writer);
    await writer.query('commit');
    const result = await pending;
    assert.equal(result.error, undefined, 'The actual owned HTTP request must settle as an HTTP response');
    assert.deepEqual(await partnerCompanyWorkspaceSnapshot(db), expected, 'Only the competing writer committed; the endpoint added no DML');
    return { response: result.value, changed, call: h.calls[start] };
  } finally {
    try { await writer.query('rollback'); }
    finally { try { if (pending) await pending; } finally { await writer.end(); } }
  }
}

export async function exercisePartnerCompanyWorkspaceNativeHttp(db, fixture, t) {
  const metrics = { http: 0, rpc: 0, waits: [] };
  const run = body => scenario(db, fixture, metrics, body);
  await t.test('original verified applicant opens both separately approved workspaces through real HTTP and the existing read RPC', async () => run(async h => {
    const first = await h.seed({ name: 'Owned native first company' }), second = await h.seed({ name: 'Owned native second company' });
    assert.notEqual(first.application.workspaceId, second.application.workspaceId);
    assert.notEqual(first.application.revision, first.pendingRevision);
    assert.equal((await one(db, "select count(*)::int n from public.staff_users where auth_user_id=$1 and role='owner' and status='active'", [h.actor])).n, 2);
    expectData(await h.call(first), first.application); expectRead(h, first);
    expectData(await h.call(second), second.application); expectRead(h, second);
    assert.equal(h.calls.length, 2);
  }));
  await t.test('foreign original subject stays forbidden even after becoming another active owner of the approved workspace', async () => run(async h => {
    const x = await h.seed();
    expectFailure(await h.call(x, { token: FOREIGN_TOKEN }), 403, 'partner_company_access_denied'); expectRead(h, x, h.foreign, 'P1211');
    await db.query(`insert into public.staff_users(workspace_id,auth_user_id,email,full_name,role,status)
      values($1,$2,'foreign-owner@example.invalid','Owned other owner','owner','active')`, [x.application.workspaceId, h.foreign]);
    assert.deepEqual(await one(db, 'select role,status from public.staff_users where workspace_id=$1 and auth_user_id=$2',
      [x.application.workspaceId, h.foreign]), { role: 'owner', status: 'active' });
    expectFailure(await h.call(x, { token: FOREIGN_TOKEN, headers: { 'x-actor-id': h.actor, 'x-workspace-id': x.application.workspaceId } }),
      403, 'partner_company_access_denied'); expectRead(h, x, h.foreign, 'P1211');
    expectData(await h.call(x), x.application); expectRead(h, x);
  }));
  for (const state of ['pending', 'rejected']) {
    await t.test('valid own ' + state + ' application is a 409 change rather than an approved workspace', async () => run(async h => {
      const x = await h.seed({ state });
      assert.equal((await one(db, 'select count(*)::int n from public.staff_users where auth_user_id=$1', [h.actor])).n, 0);
      expectFailure(await h.call(x), 409, 'partner_company_changed'); expectRead(h, x);
      assert.deepEqual(h.calls.at(-1).data, x.application, 'The 409 follows a real valid DTO, not a synthetic RPC failure');
    }));
  }
  await t.test('stale expected approval revision returns 409 while the current revision opens the same real company', async () => run(async h => {
    const x = await h.seed();
    expectFailure(await h.call(x, { query: { revision: x.pendingRevision } }), 409, 'partner_company_changed'); expectRead(h, x);
    assert.deepEqual(h.calls.at(-1).data, x.application);
    expectData(await h.call(x), x.application); expectRead(h, x);
  }));
  for (const change of ['disabled', 'role_changed', 'deleted']) {
    await t.test('existing original owner ' + change + ' loses HTTP workspace access immediately without changing company or money rows', async () => run(async h => {
      const x = await h.seed();
      expectData(await h.call(x), x.application); expectRead(h, x);
      if (change === 'deleted') await db.query('delete from public.staff_users where workspace_id=$1 and auth_user_id=$2', [x.application.workspaceId, h.actor]);
      else await db.query('update public.staff_users set ' + (change === 'disabled' ? "status='disabled'" : "role='receptionist'")
        + ' where workspace_id=$1 and auth_user_id=$2', [x.application.workspaceId, h.actor]);
      const stored = await one(db, 'select role,status from public.staff_users where workspace_id=$1 and auth_user_id=$2', [x.application.workspaceId, h.actor]);
      assert.deepEqual(stored, change === 'deleted' ? undefined : change === 'disabled'
        ? { role: 'owner', status: 'disabled' } : { role: 'receptionist', status: 'active' });
      expectFailure(await h.call(x), 403, 'partner_company_access_denied'); expectRead(h, x, h.actor, 'P1121');
    }));
  }
  await t.test('real HTTP staff-row waiter observes committed revocation and cannot return a stale 200', async () => run(async h => {
    const x = await h.seed();
    expectData(await h.call(x), x.application); expectRead(h, x);
    const result = await waitingHttp(db, fixture, h, x, metrics, t, {
      locktype: 'transactionid',
      lock: writer => writer.query('select id from public.staff_users where workspace_id=$1 and auth_user_id=$2 for update', [x.application.workspaceId, h.actor]),
      change: async (writer, waiter) => {
        const key = await one(writer, "select hashtextextended('partner-source:'||$1::text,0) key", [x.source]);
        assert.equal((await one(writer, `select exists(select 1 from pg_locks where pid=$1 and granted and locktype='advisory'
          and classid::bigint=(($2::bigint>>32)&4294967295) and objid::bigint=($2::bigint&4294967295)) yes`, [waiter, key.key])).yes, true,
        'The real read RPC holds its source lock before waiting at the current-owner guard');
        await writer.query("update public.staff_users set status='disabled' where workspace_id=$1 and auth_user_id=$2", [x.application.workspaceId, h.actor]);
      },
    });
    expectFailure(result.response, 403, 'partner_company_access_denied');
    assert.equal(result.call.error, 'P1121'); assert.equal(result.call.data, null);
    expectFailure(await h.call(x), 403, 'partner_company_access_denied'); expectRead(h, x, h.actor, 'P1121');
  }));
  await t.test('real HTTP source-lock waiter rereads a committed approval revision and refuses stale expected revision with 409', async () => run(async h => {
    const x = await h.seed({ state: 'pending' }), original = x.application;
    const result = await waitingHttp(db, fixture, h, x, metrics, t, {
      locktype: 'advisory',
      lock: writer => writer.query("select pg_advisory_xact_lock(hashtextextended('partner-source:'||$1::text,0))", [x.source]),
      change: async writer => { await writer.query('set local role service_role'); return review(writer, x, original.revision); },
    });
    assert.equal(result.changed.state, 'approved'); assert.ok(result.changed.workspaceId);
    assert.notEqual(result.changed.revision, original.revision);
    assert.deepEqual(result.call.data, result.changed, 'The native reader must reread the committed new revision after its real source wait');
    assert.equal(result.call.error, null);
    expectFailure(result.response, 409, 'partner_company_changed');
    x.application = result.changed;
    expectData(await h.call(x), result.changed); expectRead(h, x);
    expectFailure(await h.call(x, { query: { revision: original.revision } }), 409, 'partner_company_changed'); expectRead(h, x);
  }));
  await t.test('actual HTTP selector mixing and missing Auth fail before the native RPC and leave exact rows untouched', async () => run(async h => {
    const x = await h.seed();
    for (const query of [{ requestId: x.request, sourceId: x.source }, { offset: '0', state: 'approved' },
      { workspaceId: x.application.workspaceId }, { revision: 'invalid' }]) {
      expectFailure(await h.call(x, { query }), 400, 'invalid_partner_company_query');
    }
    const missing = await h.call(x, { token: null });
    assert.equal(missing.status, 401); assert.equal(missing.value.code, 'authentication_required'); assert.equal(missing.value.data, undefined);
    assert.equal(h.calls.length, 0);
    expectData(await h.call(x), x.application); expectRead(h, x);
  }));
  await t.test('W03 raw duplicate applicationId reaches the actual router as an array and returns 400 without RPC', async () => run(async h => {
    const x = await h.seed();
    expectFailure(await h.call(x, { queryEntries: [['applicationId', x.request]] }), 400, 'invalid_partner_company_query');
    assert.equal(h.received.length, 1);
    const request = h.received[0];
    assert.deepEqual(new URL(request.url, h.server.origin).searchParams.getAll('applicationId'), [x.request, x.request]);
    assert.deepEqual(request.query.applicationId, [x.request, x.request], 'The owned HTTP adapter must preserve both raw values as a Vercel-style query array');
    assert.equal(h.calls.length, 0, 'Duplicate selectors must fail before even the real service-role read');
  }));
  assert.equal(metrics.waits.length, 2);
  assert.deepEqual(metrics.waits.map(proof => proof.locktype).sort(), ['advisory', 'transactionid']);
  return metrics;
}
