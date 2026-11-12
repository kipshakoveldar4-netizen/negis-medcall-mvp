import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { seedPartnerLedger } from './partner-ledger-cases.mjs';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';
import { startOwnedPartnerHttp } from './partner-entry-native-http-cases.mjs';

const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const observed = p => p.then(value => ({ value }), error => ({ error }));
const financialTables = ['platform_subscriptions', 'platform_subscription_payments', 'growth_referrals',
  'growth_partner_commissions', 'growth_partner_payouts', 'deals', 'growth_operator_arrivals'];
const companyTables = ['growth_contributor_profiles', 'growth_partners', 'growth_partner_sources',
  'growth_partner_company_applications', 'growth_partner_company_submission_fences',
  'growth_partner_company_review_fences', 'growth_partner_payment_windows', 'workspaces', 'staff_users', 'workspace_settings'];
const snapshot = async (db, tables = [...financialTables, ...companyTables]) => (await db.query(
  'select * from (' + tables.map(table => `select '${table}' relation,to_jsonb(r) value from public.${table} r`)
    .join(' union all ') + ') owned_company_snapshot order by relation,value::text')).rows;
export const partnerCompanyFinancialSnapshot = db => snapshot(db, financialTables);

function consent() {
  const v = { version: 'owned-company-v1', purpose: 'partner_company_registration', text: 'SYNTHETIC COMPANY NOTICE, NOT LEGAL COPY',
    policyRevision: 'owned-only', policyUrl: 'https://policy.fixture.invalid/partner' };
  return { ...v, sha256: createHash('sha256').update(JSON.stringify([v.version, v.text, v.purpose, v.policyRevision, v.policyUrl])).digest('hex') };
}
async function capture(db, x, claim = true) {
  const id = randomUUID(); x.sources.add(id);
  const started = new Date(Date.now() - 1000).toISOString(); x.started.set(id, started);
  await db.query("select public.capture_growth_partner_source_v2($1,$2,$3,'link',$4)", [id, x.proof, x.partner.code, started]);
  if (claim) await db.query('select public.claim_growth_partner_source($1,$2,$3)', [x.actor, id, x.proof]);
  return id;
}
async function seed(db, owned, { claim = true } = {}) {
  const token = randomBytes(32).toString('hex');
  const x = { partner: await seedPartnerLedger(db), actor: randomUUID(), owner: randomUUID(), request: randomUUID(), reviewRequest: randomUUID(),
    sources: new Set(), started: new Map(), submissionKeys: new Set(), token, proof: createHash('sha256').update(Buffer.from(token, 'hex')).digest('hex'),
    company: { name: 'Owned command company', ownerName: 'Owned Applicant', purpose: 'marketing', vertical: null, timeZone: 'Asia/Almaty' },
    email: 'applicant@example.invalid', consent: consent() };
  owned.push(x); x.submissionKeys.add(x.request); x.source = await capture(db, x, claim); return x;
}
const submit = async (db, x) => (await one(db, 'select public.submit_growth_partner_company($1,$2,$3,$4,$5,$6,$7) v',
  [x.actor, x.source, x.proof, x.request, x.company, x.email, x.consent])).v;
const submission = async (db, x, close = false) => (await one(db, 'select public.read_growth_partner_company_submission($1,$2,$3,$4) v',
  [x.actor, x.source, x.request, close])).v;
function decision(x, revision, changes) {
  return { owner: x.owner, application: x.request, revision, request: x.reviewRequest, action: 'approve', ...changes };
}
const review = async (db, x, revision, changes) => {
  const c = decision(x, revision, changes);
  return (await one(db, 'select public.review_growth_partner_company($1,$2,$3,$4,$5) v', [c.owner, c.application, c.revision, c.request, c.action])).v;
};
const reviewReceipt = async (db, x, revision, close = false, changes) => {
  const c = decision(x, revision, changes);
  return (await one(db, 'select public.read_growth_partner_company_review($1,$2,$3,$4,$5,$6) v', [c.owner, c.application, c.revision, c.request, c.action, close])).v;
};
const list = async (db, owner, offset = 0, state = null) => (await one(db,
  'select public.list_growth_partner_companies($1,$2,$3) v', [owner, offset, state])).v;
const submitReceipt = (x, state, application) => ({ state, requestId: x.request, sourceId: x.source, ...(application ? { application } : {}) });
const decisionReceipt = (x, revision, state, application) => ({ state, requestId: x.reviewRequest, applicationId: x.request,
  revision, action: 'approve', ...(application ? { application } : {}) });
async function scope(db, x) {
  return one(db, `select
    (select count(*)::int from public.growth_partner_company_applications where id=$1) applications,
    (select count(*)::int from public.workspaces) workspaces,
    (select count(*)::int from public.staff_users where auth_user_id=$2) staff,
    (select count(*)::int from public.workspace_settings) settings,
    (select count(*)::int from public.growth_partner_company_submission_fences where actor_id=$2 and request_id=$1) submissions,
    (select count(*)::int from public.growth_partner_company_review_fences where owner_id=$3 and request_id=$4) reviews`,
  [x.request, x.actor, x.owner, x.reviewRequest]);
}
async function cleanup(db, owned) {
  // Tombstones outlive parents: remove exact owned keys before source/app rows.
  for (const x of owned) {
    await db.query('delete from public.growth_partner_company_submission_fences where actor_id=$1 and request_id=any($2::uuid[]) and source_id=any($3::uuid[])',
      [x.actor, [...x.submissionKeys], [...x.sources]]);
    await db.query('delete from public.growth_partner_company_review_fences where owner_id=$1 and request_id=$2 and application_id=$3',
      [x.owner, x.reviewRequest, x.request]);
  }
  for (const x of [...owned].reverse()) {
    const app = await one(db, 'select workspace_id from public.growth_partner_company_applications where id=$1 and applicant_auth_user_id=$2', [x.request, x.actor]);
    await db.query('delete from public.growth_partner_company_applications where id=$1 and applicant_auth_user_id=$2 and source_id=any($3::uuid[])', [x.request, x.actor, [...x.sources]]);
    await db.query('delete from public.growth_partner_payment_windows where source_id=any($1::uuid[])', [[...x.sources]]);
    if (app?.workspace_id) {
      await db.query('delete from public.staff_users where workspace_id=$1 and auth_user_id=$2', [app.workspace_id, x.actor]);
      await db.query('delete from public.workspace_settings where workspace_id=$1', [app.workspace_id]);
    }
    await db.query('delete from public.growth_partner_sources where id=any($1::uuid[]) and partner_id=$2', [[...x.sources], x.partner.partner]);
    if (app?.workspace_id) await db.query('delete from public.workspaces where id=$1', [app.workspace_id]);
    await db.query('delete from public.growth_partners where id=$1 and auth_user_id=$2', [x.partner.partner, x.partner.actor]);
    await db.query('delete from public.growth_contributor_profiles where id=$1 and auth_user_id=$2', [x.partner.profile, x.partner.actor]);
  }
}
async function scenario(db, fixture, run) {
  const owned = [], before = await partnerCompanyFinancialSnapshot(db), service = await fixture.connect();
  try {
    await service.query('set role service_role');
    await run({ service, seed: options => seed(db, owned, options), owned });
    assert.deepEqual(await partnerCompanyFinancialSnapshot(db), before, 'No financial rows may be written');
  } finally {
    await service.end(); await cleanup(db, owned);
    assert.deepEqual(await partnerCompanyFinancialSnapshot(db), before, 'Financial data unchanged after exact owned cleanup');
  }
}
async function blocked(db, waiter, blocker) {
  for (let n = 0; n < 150; n++) {
    if ((await one(db, 'select $1::int=any(pg_blocking_pids($2::int)) v', [blocker, waiter])).v) return;
    await delay(10);
  }
  assert.fail('Expected an actual owned command/source lock wait');
}
async function serialized(db, fixture, first, second) {
  const a = await fixture.connect(), b = await fixture.connect(); let pending;
  try {
    await a.query('set role service_role'); await b.query('set role service_role');
    const ap = (await one(a, 'select pg_backend_pid() v')).v, bp = (await one(b, 'select pg_backend_pid() v')).v;
    await a.query('begin'); const before = await first(a); pending = observed(second(b));
    await blocked(db, bp, ap); await a.query('commit'); return { before, after: await pending };
  } finally {
    await a.query('rollback'); if (pending) await pending; await a.end(); await b.end();
  }
}

export async function exercisePartnerCompanyCommandClosure(db, fixture, source, t) {
  t.after(stopPartnerEntryBuilds);
  await t.test('125 unknown recovery requires an already-claimed source; unconfirmed reads never write', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed({ claim: false }), before = await snapshot(db);
    for (const close of [false, true]) await assert.rejects(() => submission(service, x, close), { code: 'P1211' });
    assert.deepEqual(await snapshot(db), before);
    await service.query('select public.claim_growth_partner_source($1,$2,$3)', [x.actor, x.source, x.proof]);
    const claimed = await snapshot(db); assert.deepEqual(await submission(service, x), submitReceipt(x, 'unconfirmed'));
    assert.deepEqual(await snapshot(db), claimed);
  }));
  await t.test('125 real submit-before-close commits one pending application and returns the exact receipt', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), { before, after } = await serialized(db, fixture, a => submit(a, x), b => submission(b, x, true));
    assert.equal(after.error, undefined); assert.equal(before.state, 'pending');
    assert.deepEqual(after.value, submitReceipt(x, 'committed', before)); assert.deepEqual(await submit(service, x), before);
    assert.deepEqual(await scope(db, x), { applications: 1, workspaces: 0, staff: 0, settings: 0, submissions: 0, reviews: 0 });
  }));
  await t.test('125 real close-before-late-submit abandons permanently and commits no application', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), { before, after } = await serialized(db, fixture, a => submission(a, x, true), b => submit(b, x));
    assert.deepEqual(before, submitReceipt(x, 'abandoned')); assert.equal(after.error?.code, 'P1253');
    const closed = await snapshot(db);
    for (const close of [false, true]) assert.deepEqual(await submission(service, x, close), before);
    assert.deepEqual(await snapshot(db), closed, 'Repeated close cannot change closed_at');
    assert.deepEqual(await scope(db, x), { applications: 0, workspaces: 0, staff: 0, settings: 0, submissions: 1, reviews: 0 });
  }));
  await t.test('125 expired known application recovery is read-only and never renews source dates', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), app = await submit(service, x);
    await db.query(`update public.growth_partner_sources set captured_at=$2::timestamptz+interval '1 microsecond'-interval '168 hours',
      expires_at=$2::timestamptz+interval '1 microsecond' where id=$1`, [x.source, app.submittedAt]);
    const before = await snapshot(db), expired = { ...app, sourceState: 'expired', expiresAt: (await one(db,
      `select to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') v from public.growth_partner_sources where id=$1`, [x.source])).v };
    for (const close of [false, true]) assert.deepEqual(await submission(service, x, close), submitReceipt(x, 'committed', expired));
    assert.deepEqual(await snapshot(db), before);
  }));
  await t.test('125 foreign applicant and changed submit tuple are denied without row mutations', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(); await submit(service, x); const replacement = await capture(db, x), before = await snapshot(db);
    for (const close of [false, true]) await assert.rejects(() => submission(service, { ...x, actor: randomUUID() }, close), { code: 'P1211' });
    const changedNotice = { ...x.consent, version: 'changed-v1' };
    changedNotice.sha256 = createHash('sha256').update(JSON.stringify([changedNotice.version, changedNotice.text, changedNotice.purpose, changedNotice.policyRevision, changedNotice.policyUrl])).digest('hex');
    for (const change of [{ source: replacement }, { company: { ...x.company, name: 'Changed owned company' } }, { email: 'changed@example.invalid' }, { consent: changedNotice }])
      await assert.rejects(() => submit(service, { ...x, ...change }), { code: 'P1213' });
    assert.deepEqual(await snapshot(db), before);
  }));
  await t.test('125 submit tombstone survives source deletion and rejects a new source for the same actor/request', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), receipt = await submission(service, x, true);
    assert.equal((await db.query('delete from public.growth_partner_sources where id=$1 and actor_auth_user_id=$2', [x.source, x.actor])).rowCount, 1);
    const next = { ...x, source: await capture(db, x) }, before = await snapshot(db);
    await assert.rejects(() => submit(service, next), { code: 'P1253' });
    for (const close of [false, true]) await assert.rejects(() => submission(service, next, close), { code: 'P1213' });
    assert.deepEqual(await submission(service, x), receipt); assert.deepEqual(await snapshot(db), before);
  }));
  await t.test('125 real review-close-before-approve prevents workspace creation and preserves pending revision', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), pending = await submit(service, x);
    const { before, after } = await serialized(db, fixture, a => reviewReceipt(a, x, pending.revision, true), b => review(b, x, pending.revision));
    assert.deepEqual(before, decisionReceipt(x, pending.revision, 'abandoned')); assert.equal(after.error?.code, 'P1253');
    const closed = await snapshot(db); assert.deepEqual(await reviewReceipt(service, x, pending.revision, true), before);
    assert.deepEqual(await snapshot(db), closed); assert.deepEqual(await submission(service, x), submitReceipt(x, 'committed', pending));
    assert.deepEqual(await scope(db, x), { applications: 1, workspaces: 0, staff: 0, settings: 0, submissions: 0, reviews: 1 });
  }));
  await t.test('125 real approve-before-close returns the exact receipt and creates one original-owner workspace', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), pending = await submit(service, x);
    const { before, after } = await serialized(db, fixture, a => review(a, x, pending.revision), b => reviewReceipt(b, x, pending.revision, true));
    assert.equal(after.error, undefined); assert.equal(before.state, 'approved'); assert.deepEqual(after.value, decisionReceipt(x, pending.revision, 'committed', before));
    const committed = await snapshot(db); assert.deepEqual(await review(service, x, pending.revision), before);
    assert.deepEqual(await reviewReceipt(service, x, pending.revision), after.value); assert.deepEqual(await submission(service, x, true), submitReceipt(x, 'committed', before));
    assert.deepEqual(await snapshot(db), committed);
    assert.deepEqual(await scope(db, x), { applications: 1, workspaces: 1, staff: 1, settings: 2, submissions: 0, reviews: 0 });
    assert.deepEqual(await one(db, 'select auth_user_id,role,status,password_reset_required from public.staff_users where workspace_id=$1', [before.workspaceId]),
      { auth_user_id: x.actor, role: 'owner', status: 'active', password_reset_required: false });
  }));
  await t.test('125 approved applicant recovery rechecks current owner membership', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), pending = await submit(service, x), app = await review(service, x, pending.revision);
    await db.query("update public.staff_users set status='disabled' where workspace_id=$1 and auth_user_id=$2", [app.workspaceId, x.actor]);
    const before = await snapshot(db);
    for (const close of [false, true]) await assert.rejects(() => submission(service, x, close), { code: 'P1121' });
    assert.deepEqual(await snapshot(db), before);
  }));
  await t.test('125 foreign reviewer and changed tuple cannot recover or repeat a committed decision', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), pending = await submit(service, x); await review(service, x, pending.revision); const before = await snapshot(db);
    for (const changes of [{ owner: randomUUID() }, { revision: randomUUID() }, { request: randomUUID() }, { action: 'reject' }]) {
      await assert.rejects(() => review(service, x, pending.revision, changes), { code: 'P1213' });
      for (const close of [false, true]) await assert.rejects(() => reviewReceipt(service, x, pending.revision, close, changes), { code: 'P1213' });
    }
    await assert.rejects(() => reviewReceipt(service, x, pending.revision, false, { application: randomUUID() }), { code: 'P1211' });
    assert.deepEqual(await snapshot(db), before);
  }));
  await t.test('125 review tombstone survives deleted application and rejects a new pending row for the same owner/request', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), pending = await submit(service, x), receipt = await reviewReceipt(service, x, pending.revision, true);
    assert.equal((await db.query('delete from public.growth_partner_company_applications where id=$1 and applicant_auth_user_id=$2', [x.request, x.actor])).rowCount, 1);
    const next = await seed(), nextPending = await submit(service, next), change = { application: next.request, revision: nextPending.revision }, before = await snapshot(db);
    await assert.rejects(() => review(service, x, pending.revision, change), { code: 'P1253' });
    for (const altered of [change, { revision: randomUUID() }, { action: 'reject' }])
      for (const close of [false, true]) await assert.rejects(() => reviewReceipt(service, x, pending.revision, close, altered), { code: 'P1213' });
    assert.deepEqual(await reviewReceipt(service, x, pending.revision), receipt); assert.deepEqual(await snapshot(db), before);
  }));
  await t.test('125 service cannot bypass closed markers via either private original alias', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), pending = await submit(service, x); x.submissionKeys.add(x.reviewRequest);
    await submission(service, { ...x, request: x.reviewRequest }, true); await reviewReceipt(service, x, pending.revision, true);
    for (const role of ['anon', 'authenticated', 'service_role']) for (const signature of [
      'public.submit_growth_partner_company_121(uuid,uuid,text,uuid,jsonb,text,jsonb)', 'public.review_growth_partner_company_121(uuid,uuid,uuid,uuid,text)'])
      assert.equal((await one(db, "select has_function_privilege($1,$2,'EXECUTE') v", [role, signature])).v, false);
    await assert.rejects(() => service.query('select public.submit_growth_partner_company_121($1,$2,$3,$4,$5,$6,$7)',
      [x.actor, x.source, x.proof, x.reviewRequest, x.company, x.email, x.consent]), { code: '42501' });
    await assert.rejects(() => service.query('select public.review_growth_partner_company_121($1,$2,$3,$4,$5)',
      [x.owner, x.request, pending.revision, x.reviewRequest, 'approve']), { code: '42501' });
  }));
  await t.test('125 queue uses 21-row lookahead, exact state filters and offsets without staff/company selectors', async () => scenario(db, fixture, async ({ service, seed }) => {
    const xs = []; for (let n = 0; n < 21; n++) { const x = await seed(); x.pending = await submit(service, x); xs.push(x); }
    const ids = async state => (await db.query(`select id from public.growth_partner_company_applications
      where $1::text is null or state=$1 order by submitted_at desc,id desc`, [state])).rows.map(r => r.id);
    const before = await snapshot(db), ordered = await ids(null), first = await list(service, xs[0].owner), last = await list(service, xs[0].owner, 20);
    assert.deepEqual({ ...first, items: first.items.map(r => r.id) }, { items: ordered.slice(0, 20), offset: 0, state: null, hasMore: true });
    assert.deepEqual({ ...last, items: last.items.map(r => r.id) }, { items: ordered.slice(20), offset: 20, state: null, hasMore: false });
    assert.deepEqual(await list(service, xs[0].owner, 21), { items: [], offset: 21, state: null, hasMore: false });
    assert.deepEqual(await snapshot(db), before, 'Queue is read-only across applicants without workspace memberships');
    await withHttp(db, fixture, xs[0], async h => {
      const firstResponse = await h.call('platform-partner-companies');
      assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse.value));
      assert.deepEqual(firstResponse.value.data, first);
      const lastResponse = await h.call('platform-partner-companies', { query: { offset: '20' } });
      assert.equal(lastResponse.status, 200, JSON.stringify(lastResponse.value));
      assert.deepEqual(lastResponse.value.data, last);
      for (const selector of ['workspaceId', 'companyId', 'ownerId', 'actorId']) {
        const count = h.calls.length;
        assert.equal((await h.call('platform-partner-companies', { query: { [selector]: randomUUID() } })).status, 400);
        assert.equal(h.calls.length, count, 'A client company selector cannot reach SQL');
      }
      assert.ok(h.calls.every(c => c.name === 'list_growth_partner_companies' && c.args.p_owner === xs[0].owner));
    });
    for (const x of xs.slice(0, 2)) await review(service, x, x.pending.revision, { action: 'reject' });
    const filteredBefore = await snapshot(db);
    for (const state of ['pending', 'rejected', 'approved']) {
      const expected = await ids(state), page = await list(service, xs[0].owner, 0, state);
      assert.deepEqual({ ...page, items: page.items.map(r => r.id) }, { items: expected, offset: 0, state, hasMore: false });
    }
    await withHttp(db, fixture, xs[0], async h => {
      for (const state of ['pending', 'rejected', 'approved']) {
        const response = await h.call('platform-partner-companies', { query: { state, offset: '1' } });
        assert.equal(response.status, 200);
        assert.deepEqual(response.value.data, await list(service, xs[0].owner, 1, state));
      }
    });
    await assert.rejects(() => list(service, xs[0].owner, -1), { code: 'P1212' });
    await assert.rejects(() => list(service, xs[0].owner, 0, 'unknown'), { code: 'P1212' });
    assert.deepEqual(await snapshot(db), filteredBefore);
  }));
  await t.test('125 list blocked by a real review revision change fails P1252 with no partial page', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), pending = await submit(service, x), newer = await seed(); await submit(service, newer);
    const { after } = await serialized(db, fixture, a => review(a, x, pending.revision, { action: 'reject' }), b => list(b, x.owner));
    assert.equal(after.error?.code, 'P1252'); assert.equal(after.value, undefined);
    assert.equal((await list(service, x.owner)).items.length, 2, 'A fresh whole-page retry succeeds');
  }));
  await t.test('125 exact migration rerun preserves receipts and closed markers on both sides', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), y = await seed(); await submission(service, x, true); const pending = await submit(service, y);
    await reviewReceipt(service, y, pending.revision, true); const before = await snapshot(db); await db.query(source);
    assert.deepEqual(await snapshot(db), before); await assert.rejects(() => submit(service, x), { code: 'P1253' });
    await assert.rejects(() => review(service, y, pending.revision), { code: 'P1253' });
  }));
  await t.test('125 expiry crossing at final insert rolls back the application and its first claim', async () => {
    const before = await snapshot(db); let reached = false;
    const notice = value => { if (value.message === 'owned_company_expiry_trigger_reached') reached = true; };
    db.on('notice', notice); await db.query('begin');
    try {
      const x = await seed(db, [], { claim: false });
      await db.query(`create function public.owned_company_cross_expiry() returns trigger language plpgsql as $$
        declare expires timestamptz; begin
          select expires_at into expires from public.growth_partner_sources where id=new.source_id;
          perform pg_sleep(greatest(0,extract(epoch from expires-clock_timestamp()))+0.005);
          raise notice 'owned_company_expiry_trigger_reached';
          new.submitted_at:=clock_timestamp(); return new;
        end $$;
        create trigger owned_company_cross_expiry before insert on public.growth_partner_company_applications
          for each row execute function public.owned_company_cross_expiry();`);
      await db.query(`update public.growth_partner_sources set captured_at=c.expires_at-interval '168 hours',expires_at=c.expires_at
        from (select clock_timestamp()+interval '1 second' as expires_at)c where id=$1`, [x.source]);
      await db.query('set local role service_role;savepoint crossing_expiry');
      await assert.rejects(() => submit(db, x), { code: 'P1213' });
      assert.equal(reached, true, 'The actual final insert must cross expiry, not fail the earlier check');
      await db.query('rollback to savepoint crossing_expiry;reset role');
      assert.equal((await one(db, 'select count(*)::int v from public.growth_partner_company_applications where id=$1', [x.request])).v, 0);
      assert.equal((await one(db, 'select actor_auth_user_id from public.growth_partner_sources where id=$1', [x.source])).actor_auth_user_id, null);
    } finally { db.off('notice', notice); await db.query('rollback'); }
    assert.deepEqual(await snapshot(db), before);
  });
}

const rpcArgs = Object.freeze({
  claim_growth_partner_source: ['p_actor', 'p_intent', 'p_capability_hash'],
  submit_growth_partner_company: ['p_actor', 'p_source', 'p_capability_hash', 'p_request', 'p_company', 'p_email', 'p_consent'],
  read_growth_partner_company_submission: ['p_actor', 'p_source', 'p_request', 'p_close'],
  review_growth_partner_company: ['p_owner', 'p_application', 'p_revision', 'p_request', 'p_action'],
  read_growth_partner_company_review: ['p_owner', 'p_application', 'p_revision', 'p_request', 'p_action', 'p_close'],
  list_growth_partner_companies: ['p_owner', 'p_offset', 'p_state'],
});
async function until(check) {
  for (let n = 0; n < 300; n++) { if (check()) return; await delay(10); }
  assert.fail('Owned HTTP gate did not reach the expected real RPC');
}
async function withHttp(db, fixture, x, run) {
  const calls = [], errors = [], direct = [], controls = { hold: null, held: false, release: null };
  const adapter = {
    from(...args) { direct.push(args); throw Error('PRIVATE_UNEXPECTED_DIRECT_TABLE'); },
    async rpc(name, args) {
      assert.ok(Object.hasOwn(rpcArgs, name), 'Only exact company/source RPCs may cross the HTTP boundary');
      assert.deepEqual(Object.keys(args).sort(), [...rpcArgs[name]].sort());
      calls.push({ name, args: structuredClone(args) });
      const hold = controls.hold?.name === name ? controls.hold : null;
      if (hold) controls.hold = null;
      const gate = async () => { controls.held = true; await new Promise(resolve => { controls.release = resolve; }); controls.held = false; controls.release = null; };
      if (hold?.when === 'before') await gate();
      const client = await fixture.connect();
      try {
        await client.query('set role service_role');
        const data = (await one(client, 'select public.' + name + '(' + rpcArgs[name].map((_, i) => '$' + (i + 1)).join(',') + ') v',
          rpcArgs[name].map(key => args[key]))).v;
        if (hold?.when === 'after') await gate();
        return { data, error: null };
      } catch (error) { errors.push(error.code); return { data: null, error: { code: error.code, message: 'PRIVATE_NATIVE_COMPANY_DIAGNOSTIC' } }; }
      finally { await client.end(); }
    },
  };
  const applicantToken = 'owned.applicant.signature', ownerToken = 'owned.platform.signature', foreignToken = 'owned.foreign.signature';
  for (const token of [applicantToken, ownerToken, foreignToken]) assert.equal(token.split('.').length, 3);
  const foreign = randomUUID(), authUsers = new Map([
    [applicantToken, { id: x.actor, email: x.email, email_confirmed_at: '2026-10-27T00:00:00.000Z' }],
    [ownerToken, { id: x.owner, email: 'platform@example.invalid', email_confirmed_at: '2026-10-27T00:00:00.000Z' }],
    [foreignToken, { id: foreign, email: 'foreign@example.invalid', email_confirmed_at: '2026-10-27T00:00:00.000Z' }],
  ]);
  const f = await partnerEntryHttpFixture(adapter, { company: true, authUsers, env: { MEDINA_PLATFORM_OWNER_IDS: x.owner } });
  const key = Buffer.from('ab'.repeat(32), 'hex');
  const frame = { ...f.cookies.newPartnerEntryFrame(x.partner.code, 'link', f.notice.version, f.notice.sha256, Date.parse(x.started.get(x.source))),
    id: x.source, token: x.token };
  assert.equal(f.cookies.partnerCapabilityHash(frame), x.proof);
  assert.deepEqual(JSON.parse(JSON.stringify(f.companyNotice)), x.consent);
  const cookie = f.cookies.partnerEntrySetCookie(frame, ENTRY_ORIGIN, key, Date.now()).split(';')[0];
  const paths = ['partner-entry/company', 'partner-company', 'platform-partner-companies'];
  // Vercel exposes catch-all path segments separately; adapt only that transport
  // shape while preserving the actual compiled router and handlers.
  const server = await startOwnedPartnerHttp((req, res) => {
    req.query.path = req.query.path.flatMap(segment => segment.split('/')); return f.handler(req, res);
  }, paths.map(path => '/api/crm/' + path));
  const release = () => controls.release?.();
  const inflight = new Set();
  async function call(path, options = {}) {
    const { method = path === 'partner-entry/company' ? 'POST' : 'GET', query = {}, body,
      token = path === 'platform-partner-companies' ? ownerToken : applicantToken,
      cookie: requestCookie = path === 'partner-entry/company' ? cookie : undefined, raw = false } = options;
    const response = await fetch(server.origin + '/api/crm/' + path + '?' + new URLSearchParams(query), {
      method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Origin: ENTRY_ORIGIN, 'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token, ...(requestCookie ? { Cookie: requestCookie } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (raw) return response;
    const value = await response.json();
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|owned-only-not-credential|owned\.(?:applicant|platform|foreign)\.signature|auth_user_id|capability_hash/);
    assert.equal(response.headers.get('set-cookie'), null, 'Recovery never renews the attribution cookie');
    return { status: response.status, value };
  }
  const track = promise => { const settled = observed(promise); inflight.add(settled); return settled; };
  const h = { f, calls, errors, controls, server, release, call, track, foreignToken,
    submit: () => call('partner-entry/company', { query: { op: 'submit' }, body: { requestId: x.request, company: x.company, consent: true, consentVersion: f.companyNotice.version } }),
    read: () => call('partner-company', { query: { requestId: x.request, sourceId: x.source } }),
    close: () => call('partner-company', { method: 'POST', body: { operation: 'close', requestId: x.request, sourceId: x.source } }),
    command: revision => ({ requestId: x.reviewRequest, applicationId: x.request, revision, action: 'approve' }),
  };
  try { await run(h); }
  finally {
    release(); for (const pending of inflight) await pending;
    await server.close(); f.close();
    assert.deepEqual(server.state.errors, []); assert.deepEqual(f.state.unexpected, []); assert.deepEqual(f.state.challenges, []); assert.deepEqual(direct, []);
  }
}

export async function exercisePartnerCompanyCommandNativeHttp(db, fixture, t) {
  t.after(stopPartnerEntryBuilds);
  await t.test('HTTP delayed submit arriving after close gets the real P1253 denial and no application', async () => scenario(db, fixture, async ({ seed }) => {
    const x = await seed(); await withHttp(db, fixture, x, async h => {
      h.controls.hold = { name: 'submit_growth_partner_company', when: 'before' };
      const pending = h.track(h.submit()); await until(() => h.controls.held);
      assert.deepEqual(await h.close(), { status: 200, value: { success: true, data: submitReceipt(x, 'abandoned') } });
      h.release(); const result = await pending; assert.equal(result.error, undefined);
      assert.deepEqual(result.value, { status: 409, value: { success: false, code: 'partner_company_changed' } });
      assert.deepEqual(h.errors, ['P1253']); assert.equal((await scope(db, x)).applications, 0);
    });
  }));
  await t.test('HTTP committed submit wins close while its response is delayed; receipt has one pending application', async () => scenario(db, fixture, async ({ seed }) => {
    const x = await seed(); await withHttp(db, fixture, x, async h => {
      h.controls.hold = { name: 'submit_growth_partner_company', when: 'after' };
      const pending = h.track(h.submit()); await until(() => h.controls.held); const closed = await h.close();
      assert.equal(closed.status, 200); assert.equal(closed.value.data.state, 'committed');
      h.release(); const result = await pending; assert.equal(result.error, undefined); assert.deepEqual(result.value, closed);
      assert.deepEqual(await scope(db, x), { applications: 1, workspaces: 0, staff: 0, settings: 0, submissions: 0, reviews: 0 });
    });
  }));
  await t.test('HTTP lost submit body recovers without cookie, after expiry and with intake disabled, without writes', async () => scenario(db, fixture, async ({ seed }) => {
    const x = await seed(); await withHttp(db, fixture, x, async h => {
      h.server.state.dropNextPost = true;
      const lost = await h.call('partner-entry/company', { method: 'POST', query: { op: 'submit' }, raw: true,
        body: { requestId: x.request, company: x.company, consent: true, consentVersion: h.f.companyNotice.version } });
      assert.equal(lost.status, 200); await assert.rejects(() => lost.json());
      const committed = await snapshot(db), first = await h.read(); assert.equal(first.status, 200);
      assert.equal(first.value.data.state, 'committed'); assert.deepEqual(await snapshot(db), committed);
      const app = first.value.data.application;
      await db.query(`update public.growth_partner_sources set captured_at=$2::timestamptz+interval '1 microsecond'-interval '168 hours',
        expires_at=$2::timestamptz+interval '1 microsecond' where id=$1`, [x.source, app.submittedAt]);
      h.f.env.MEDINA_PARTNER_ENTRY_ENABLED = 'false'; h.f.env.MEDINA_PARTNER_COMPANY_ENABLED = 'false';
      const expired = await snapshot(db), recovered = await h.read();
      assert.equal(recovered.status, 200); assert.equal(recovered.value.data.application.sourceState, 'expired');
      assert.deepEqual(await h.close(), recovered); assert.deepEqual(await snapshot(db), expired);
      assert.ok(h.calls.filter(c => c.name === 'read_growth_partner_company_submission').every(c =>
        c.args.p_actor === x.actor && c.args.p_source === x.source && c.args.p_request === x.request));
    });
  }));
  await t.test('HTTP review close-before-late-approve prevents workspace creation via actual P1253', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), app = await submit(service, x); await withHttp(db, fixture, x, async h => {
      h.controls.hold = { name: 'review_growth_partner_company', when: 'before' };
      const pending = h.track(h.call('platform-partner-companies', { method: 'POST', body: h.command(app.revision) }));
      await until(() => h.controls.held);
      const closed = await h.call('platform-partner-companies', { method: 'POST', body: { operation: 'close', ...h.command(app.revision) } });
      assert.deepEqual(closed, { status: 200, value: { success: true, data: decisionReceipt(x, app.revision, 'abandoned') } });
      h.release(); const result = await pending; assert.equal(result.error, undefined); assert.equal(result.value.status, 409);
      assert.deepEqual(h.errors, ['P1253']); assert.equal((await scope(db, x)).workspaces, 0);
    });
  }));
  await t.test('HTTP lost approval response recovers exact receipt, wins close and creates one original-owner workspace', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), app = await submit(service, x); await withHttp(db, fixture, x, async h => {
      h.server.state.dropNextPost = true;
      const lost = await h.call('platform-partner-companies', { method: 'POST', body: h.command(app.revision), raw: true });
      assert.equal(lost.status, 200); await assert.rejects(() => lost.json()); const before = await snapshot(db);
      const receipt = await h.call('platform-partner-companies', { query: h.command(app.revision) });
      assert.equal(receipt.status, 200); assert.equal(receipt.value.data.state, 'committed');
      assert.equal(receipt.value.data.application.state, 'approved');
      assert.deepEqual(await h.call('platform-partner-companies', { method: 'POST', body: { operation: 'close', ...h.command(app.revision) } }), receipt);
      assert.deepEqual(await h.call('platform-partner-companies', { method: 'POST', body: h.command(app.revision) }), receipt);
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual(await scope(db, x), { applications: 1, workspaces: 1, staff: 1, settings: 2, submissions: 0, reviews: 0 });
    });
  }));
  await t.test('HTTP foreign actor and changed source/review tuple are denied without receipt leakage or mutation', async () => scenario(db, fixture, async ({ service, seed }) => {
    const x = await seed(), app = await submit(service, x); await review(service, x, app.revision);
    await withHttp(db, fixture, x, async h => {
      const before = await snapshot(db);
      assert.equal((await h.call('partner-company', { token: h.foreignToken, query: { requestId: x.request, sourceId: x.source } })).status, 403);
      assert.equal((await h.call('partner-company', { query: { requestId: x.request, sourceId: randomUUID() } })).status, 403);
      const count = h.calls.length;
      assert.equal((await h.call('platform-partner-companies', { token: h.foreignToken })).status, 404);
      assert.equal(h.calls.length, count, 'Foreign platform identity cannot reach a database RPC');
      assert.equal((await h.call('platform-partner-companies', { query: { ...h.command(app.revision), action: 'reject' } })).status, 409);
      assert.deepEqual(await snapshot(db), before); assert.deepEqual(h.errors, ['P1211', 'P1211', 'P1213']);
    });
  }));
}
