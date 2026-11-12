import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { seedPartnerLedger } from './partner-ledger-cases.mjs';

const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const observed = p => p.then(value => ({ value }), error => ({ error }));
const signatures = [
  'public.capture_growth_partner_source(uuid,text,text,text)', 'public.claim_growth_partner_source(uuid,uuid,text)',
  'public.read_growth_partner_source(uuid,uuid)', 'public.bind_growth_partner_source(uuid,uuid,uuid)',
];
export const partnerSourceHelpers = ['public.partner_source_profile(uuid)', 'public.partner_source_result(public.growth_partner_sources)', 'public.partner_source_owner(uuid,uuid)'];
async function rollback(db, run) { await db.query('begin'); try { await run(); } finally { await db.query('rollback'); } }
async function denied(db, run, code) { await db.query('savepoint partner_source_denial'); try { await assert.rejects(run, e => e.code === code); }
  finally { await db.query('rollback to savepoint partner_source_denial;release savepoint partner_source_denial'); } }
const visit = async (db, x, code = x.partner.code) => (await one(db,
  'select public.capture_growth_partner_source($1,$2,$3,$4) value', [x.intent, x.proof, code, 'link'])).value;
const claim = async (db, x) => (await one(db, 'select public.claim_growth_partner_source($1,$2,$3) value', [x.actor, x.intent, x.proof])).value;
const capture = async (db, x, code = x.partner.code) => { await visit(db, x, code); return claim(db, x); };
const read = async (db, x) => (await one(db, 'select public.read_growth_partner_source($1,$2) value', [x.actor, x.intent])).value;
const bind = async (db, x, workspace) => (await one(db, 'select public.bind_growth_partner_source($1,$2,$3) value', [x.actor, x.intent, workspace])).value;
async function seed(db) { const token = randomBytes(32); return { actor: randomUUID(), intent: randomUUID(), proof: createHash('sha256').update(token).digest('hex'),
  partner: await seedPartnerLedger(db), other: await seedPartnerLedger(db), workspaces: [], staff: [] }; }
async function company(db, x, options = {}) {
  const w = randomUUID(), s = randomUUID(); x.workspaces.push(w); x.staff.push(s);
  await db.query("insert into public.workspaces(id,name,created_at) values($1,'Owned new referral company',coalesce($2::timestamptz,clock_timestamp()))", [w, options.created ?? null]);
  await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,'owned-new@example.invalid','Owned new owner',$4,'active')",
    [s, w, options.actor ?? x.actor, options.role ?? 'owner']); return w;
}
async function cleanup(db, x) {
  await db.query('delete from public.growth_partner_sources where id=$1', [x.intent]);
  await db.query('delete from public.growth_partner_commissions where payment_id in(select id from public.platform_subscription_payments where workspace_id=any($1::uuid[]))', [x.workspaces]);
  await db.query('delete from public.platform_subscription_payments where workspace_id=any($1::uuid[])', [x.workspaces]);
  await db.query('delete from public.platform_subscriptions where workspace_id=any($1::uuid[])', [x.workspaces]);
  await db.query('delete from public.growth_referrals where workspace_id=any($1::uuid[])', [x.workspaces]);
  await db.query('delete from public.staff_users where id=any($1::uuid[])', [x.staff]);
  await db.query('delete from public.workspaces where id=any($1::uuid[])', [x.workspaces]);
  for (const p of [x.partner, x.other]) {
    await db.query('delete from public.growth_partners where id=$1', [p.partner]);
    await db.query('delete from public.growth_contributor_profiles where id=$1', [p.profile]);
  }
}
async function blocked(db, waiting, blocker) { for (let n = 0; n < 160; n++) {
  if ((await one(db, 'select $1::int=any(pg_blocking_pids($2::int)) yes', [blocker, waiting])).yes) return;
  await new Promise(r => setTimeout(r, 15));
} assert.fail('Expected a real owned partner-source lock wait'); }
const counts = db => one(db, `select (select count(*)::int from public.growth_partner_sources) sources,
  (select count(*)::int from public.growth_referrals) referrals,(select count(*)::int from public.platform_subscription_payments) payments,
  (select count(*)::int from public.growth_partner_commissions) commissions,(select count(*)::int from public.growth_partner_payouts) payouts`);

export async function exercisePartnerSources(db, fixture, source, t) {
  await t.test('112 the anonymous first visit precedes sign-in; only its opaque capability can claim it', async () => rollback(db, async () => {
    const x = await seed(db); await db.query('set local role service_role'); const first = await visit(db, x);
    assert.deepEqual(Object.keys(first).sort(), ['id','capturedAt','expiresAt','policyVersion'].sort());
    await denied(db, () => read(db, x), 'P1121');
    await denied(db, () => claim(db, { ...x, proof: '0'.repeat(64) }), 'P1121');
    await denied(db, () => visit(db, { ...x, proof: '0'.repeat(64) }), 'P1121');
    const claimed = await claim(db, x); assert.equal(claimed.state, 'captured'); assert.equal(claimed.capturedAt, first.capturedAt); assert.equal(claimed.expiresAt, first.expiresAt);
    await db.query('reset role'); assert.equal((await one(db, 'select actor_auth_user_id actor from public.growth_partner_sources where id=$1', [x.intent])).actor, x.actor);
  }));
  await t.test('112 signing in after seven days cannot restart or claim the expired first visit', async () => rollback(db, async () => {
    const x = await seed(db); await visit(db, x);
    await db.query("update public.growth_partner_sources set captured_at=statement_timestamp()-interval '8 days',expires_at=statement_timestamp()-interval '1 day' where id=$1", [x.intent]);
    const expired = await claim(db, x); assert.equal(expired.state, 'expired'); assert.equal((await one(db, 'select actor_auth_user_id actor from public.growth_partner_sources where id=$1', [x.intent])).actor, null);
    assert.equal((await visit(db, x, x.other.code)).expiresAt, expired.expiresAt);
    await denied(db, () => read(db, x), 'P1121');
  }));
  await t.test('112 visit-cookie possession never discloses a bound company or grants its owner access', async () => rollback(db, async () => {
    const x = await seed(db); await capture(db, x); const w = await company(db, x); await bind(db, x, w);
    await db.query("update public.staff_users set status='inactive' where workspace_id=$1", [w]);
    const publicReceipt = await visit(db, x); assert.deepEqual(Object.keys(publicReceipt).sort(), ['id','capturedAt','expiresAt','policyVersion'].sort());
    assert.ok(!JSON.stringify(publicReceipt).includes(w)); await denied(db, () => claim(db, x), 'P1121');
  }));
  await t.test('112 first registration-intent source wins; later code cannot replace or renew it', async () => rollback(db, async () => {
    const x = await seed(db); await db.query('set local role service_role');
    const first = await capture(db, x); assert.equal(first.state, 'captured'); assert.equal(first.id, x.intent); assert.equal(first.workspaceId, null);
    assert.deepEqual(await capture(db, x, x.other.code), first); assert.deepEqual(await read(db, x), first);
    assert.doesNotMatch(JSON.stringify(first), /actor|partner|auth|commission|code|Owned/);
    await db.query('reset role'); const stored = await one(db, 'select partner_id,policy_version from public.growth_partner_sources where id=$1', [x.intent]);
    assert.deepEqual(stored, { partner_id: x.partner.partner, policy_version: '2026-10-27-7d-self-v1' });
    assert.deepEqual(await counts(db), { sources: 1, referrals: 0, payments: 0, commissions: 0, payouts: 0 });
  }));
  await t.test('112 the intent belongs to its verified applicant, not another account or partner', async () => rollback(db, async () => {
    const x = await seed(db); await capture(db, x); const foreign = { ...x, actor: randomUUID() };
    await db.query('set local role service_role'); await denied(db, () => read(db, foreign), 'P1121'); await denied(db, () => capture(db, foreign), 'P1121');
    assert.deepEqual(await read(db, { ...x, intent: randomUUID() }), { state: 'unconfirmed' });
  }));
  await t.test('112 approved seven-day/self policy is fixed on server; no invented rate or browser policy override', async () => rollback(db, async () => {
    const x = await seed(db);
    await db.query('update public.growth_partners set first_commission_bps=null,renewal_commission_bps=null where id=$1', [x.partner.partner]);
    await db.query('set local role service_role');
    for (const code of [null, '', 'bad']) await denied(db, () => capture(db, x, code), 'P1122');
    const captured = await capture(db, x); assert.equal(captured.state, 'captured');
    assert.equal(Date.parse(captured.expiresAt)-Date.parse(captured.capturedAt), 7*24*60*60*1000);
    assert.equal(captured.policyVersion, '2026-10-27-7d-self-v1');
    assert.equal((await one(db, "select to_regprocedure('public.capture_growth_partner_source(uuid,uuid,text,text,integer,boolean)') old")).old, null);
    await db.query('reset role'); assert.deepEqual(await counts(db), { sources: 1, referrals: 0, payments: 0, commissions: 0, payouts: 0 });
    assert.deepEqual(await one(db, 'select first_commission_bps,renewal_commission_bps from public.growth_partners where id=$1', [x.partner.partner]),
      { first_commission_bps: null, renewal_commission_bps: null });
  }));
  await t.test('112 approved self-referrals follow the same source/ownership rules and create no money', async () => rollback(db, async () => {
    const x = await seed(db); x.actor = x.partner.actor;
    assert.equal((await capture(db, x)).state, 'captured'); const w = await company(db, x);
    assert.equal((await bind(db, x, w)).state, 'bound'); assert.deepEqual(await counts(db), { sources: 1, referrals: 1, payments: 0, commissions: 0, payouts: 0 });
  }));
  await t.test('112 current approval and commercial status are independent requirements', async () => rollback(db, async () => {
    const x = await seed(db); await capture(db, x);
    for (const mode of ['approval', 'commercial']) {
      if (mode === 'approval') await db.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1", [x.partner.profile]);
      else await db.query("update public.growth_partners set status='suspended' where id=$1", [x.partner.partner]);
      await denied(db, () => read(db, x), 'P1121'); await denied(db, () => capture(db, x, x.other.code), 'P1121');
      if (mode === 'approval') await db.query("update public.growth_contributor_profiles set partner_status='approved' where id=$1", [x.partner.profile]);
      else await db.query("update public.growth_partners set status='active' where id=$1", [x.partner.partner]);
    }
  }));
  await t.test('112 source before company creation binds only to its active owner, replays, and never creates money', async () => rollback(db, async () => {
    const x = await seed(db); await capture(db, x); const w = await company(db, x); await db.query('set local role service_role');
    const result = await bind(db, x, w); assert.equal(result.state, 'bound'); assert.equal(result.workspaceId, w);
    assert.deepEqual(await bind(db, x, w), result); assert.deepEqual(await read(db, x), result);
    await db.query('reset role'); assert.equal((await one(db, 'select partner_id from public.growth_referrals where workspace_id=$1', [w])).partner_id, x.partner.partner);
    assert.deepEqual(await counts(db), { sources: 1, referrals: 1, payments: 0, commissions: 0, payouts: 0 });
    await db.query("update public.staff_users set status='inactive' where workspace_id=$1", [w]);
    await denied(db, () => read(db, x), 'P1121'); await denied(db, () => capture(db, x), 'P1121'); await denied(db, () => bind(db, x, w), 'P1121');
  }));
  for (const mode of ['legacy', 'undated', 'future', 'infinite', 'admin', 'foreign', 'expired', 'prebound-same', 'prebound-other']) await t.test(`112 refuses ${mode} without adopting a legacy or foreign registration`, async () => rollback(db, async () => {
    const x = await seed(db); await capture(db, x);
    const w = await company(db, x, { created: mode === 'legacy' ? '2000-01-01T00:00:00Z' : null,
      role: mode === 'admin' ? 'admin' : 'owner', actor: mode === 'foreign' ? randomUUID() : x.actor });
    if (mode === 'undated') await db.query('update public.workspaces set created_at=null where id=$1', [w]);
    if (mode === 'future') await db.query("update public.workspaces set created_at='2999-01-01T00:00:00Z' where id=$1", [w]);
    if (mode === 'infinite') await db.query("update public.workspaces set created_at='infinity' where id=$1", [w]);
    if (mode === 'expired') await db.query("update public.growth_partner_sources set captured_at=statement_timestamp()-interval '8 days',expires_at=statement_timestamp()-interval '1 day' where id=$1", [x.intent]);
    if (mode.startsWith('prebound-')) await db.query('select public.bind_growth_referral($1,$2,\'link\')', [w, mode === 'prebound-same' ? x.partner.code : x.other.code]);
    const before = await counts(db); await db.query('set local role service_role');
    await denied(db, () => bind(db, x, w), ['admin', 'foreign'].includes(mode) ? 'P1121' : ['undated', 'future', 'infinite'].includes(mode) ? 'P1122' : 'P1123');
    await db.query('reset role'); assert.deepEqual(await counts(db), before);
    if (mode === 'expired') { const value = await read(db, x); assert.equal(value.state, 'expired'); assert.deepEqual(await capture(db, x, x.other.code), value); }
  }));
  await t.test('112 a consumed source cannot name a second company', async () => rollback(db, async () => {
    const x = await seed(db); await capture(db, x); const w = await company(db, x), other = await company(db, x);
    await bind(db, x, w); await denied(db, () => bind(db, x, other), 'P1123'); assert.equal((await counts(db)).referrals, 1);
  }));
  await t.test('112 the registered first-source binding remains permanent after its seven-day intake window', async () => rollback(db, async () => {
    const x = await seed(db); await capture(db, x); const w = await company(db, x); await bind(db, x, w);
    await db.query("update public.growth_partner_sources set captured_at=statement_timestamp()-interval '8 days',expires_at=statement_timestamp()-interval '1 day' where id=$1", [x.intent]);
    const result = await read(db, x); assert.equal(result.state, 'bound'); assert.equal(result.workspaceId, w);
    assert.deepEqual(await bind(db, x, w), result); assert.deepEqual(await capture(db, x, x.other.code), result);
    assert.deepEqual(await counts(db), { sources: 1, referrals: 1, payments: 0, commissions: 0, payouts: 0 });
  }));
  for (const mode of ['missing', 'partner', 'source']) await t.test(`112 ${mode} referral corruption never reports a confirmed binding`, async () => rollback(db, async () => {
    const x = await seed(db); await capture(db, x); const w = await company(db, x); await bind(db, x, w);
    if (mode === 'missing') await db.query('delete from public.growth_referrals where workspace_id=$1', [w]);
    if (mode === 'partner') await db.query('update public.growth_referrals set partner_id=$2 where workspace_id=$1', [w, x.other.partner]);
    if (mode === 'source') await db.query("update public.growth_referrals set source='promo_code' where workspace_id=$1", [w]);
    const before = await counts(db); await denied(db, () => read(db, x), 'P1122'); await denied(db, () => bind(db, x, w), 'P1122');
    assert.deepEqual(await counts(db), before);
  }));
  await t.test('112 RLS, zero direct/column grants, private helpers, closed legacy writer and only four service entries', async () => rollback(db, async () => {
    assert.equal((await one(db, "select relrowsecurity yes from pg_class where oid='public.growth_partner_sources'::regclass")).yes, true);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.deepEqual(await one(db, 'select has_table_privilege($1,$2,\'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER\') tab,has_any_column_privilege($1,$2,\'SELECT,INSERT,UPDATE,REFERENCES\') col',
        [role, 'public.growth_partner_sources']), { tab: false, col: false });
      for (const sig of signatures) assert.equal((await one(db, 'select has_function_privilege($1,$2,\'EXECUTE\') yes', [role, sig])).yes, role === 'service_role');
      for (const sig of [...partnerSourceHelpers, 'public.bind_growth_referral(uuid,text,text)'])
        assert.equal((await one(db, 'select has_function_privilege($1,$2,\'EXECUTE\') yes', [role, sig])).yes, false);
      await db.query('set local role ' + role); await denied(db, () => db.query('select * from public.growth_partner_sources'), '42501');
      if (role !== 'service_role') await denied(db, () => read(db, { actor: randomUUID(), intent: randomUUID() }), '42501');
      else await denied(db, () => db.query('select public.bind_growth_referral(null,null,null)'), '42501');
      await db.query('reset role');
    }
  }));
  for (const isolation of ['repeatable read', 'serializable']) await t.test(`112 rejects stale ${isolation} snapshot`, async () => {
    await db.query('begin isolation level ' + isolation); try { await denied(db, () => read(db, { actor: randomUUID(), intent: randomUUID() }), 'P1122'); }
    finally { await db.query('rollback'); }
  });
  await t.test('112 exact rerun preserves captured sources and bindings, with no side effects', async () => {
    const x = await seed(db); try { const result = await capture(db, x); await db.query(source); assert.deepEqual(await read(db, x), result); }
    finally { await cleanup(db, x); }
  });
  for (const mode of ['capture', 'claim', 'approval', 'commercial', 'identity', 'owner', 'consume', 'payment-lock', 'payment', 'expiry']) await t.test(`112 real ${mode} wait rechecks current state or preserves the original source`, async () => {
    const x = await seed(db), a = await fixture.connect(), b = await fixture.connect(); let pending;
    try {
      if (mode === 'claim') await visit(db, x); else if (mode !== 'capture') await capture(db, x); const w = await company(db, x);
      let subscription;
      if (mode === 'payment') {
        subscription = randomUUID(); await db.query("insert into public.platform_subscriptions(id,workspace_id,plan,currency,price_minor) values($1,$2,'basic','KZT',100)", [subscription, w]);
      }
      if (mode === 'expiry') await db.query("update public.growth_partner_sources set captured_at=statement_timestamp()-interval '7 days'+interval '2 seconds',expires_at=statement_timestamp()+interval '2 seconds' where id=$1", [x.intent]);
      const ap = (await one(a, 'select pg_backend_pid() id')).id, bp = (await one(b, 'select pg_backend_pid() id')).id;
      await a.query('begin');
      if (mode === 'capture') await capture(a, x);
      if (mode === 'claim') await claim(a, x);
      if (mode === 'approval') await a.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1", [x.partner.profile]);
      if (mode === 'commercial') await a.query("update public.growth_partners set status='suspended' where id=$1", [x.partner.partner]);
      if (mode === 'identity') await a.query('update public.growth_partners set auth_user_id=$2 where id=$1', [x.partner.partner, randomUUID()]);
      if (mode === 'owner') await a.query("update public.staff_users set status='inactive' where workspace_id=$1", [w]);
      if (mode === 'consume') await bind(a, x, w);
      if (['payment-lock', 'payment', 'expiry'].includes(mode)) await a.query('select id from public.workspaces where id=$1 for update', [w]);
      if (mode === 'payment') await a.query("insert into public.platform_subscription_payments(workspace_id,subscription_id,request_key,kind,amount_minor,currency,paid_at,confirmed_by) values($1,$2,$3,'first',100,'KZT',clock_timestamp(),$4)", [w, subscription, randomUUID(), x.partner.owner]);
      await b.query('set role service_role');
      pending = observed(mode === 'capture' ? capture(b, x, x.other.code) : mode === 'claim' ? claim(b, { ...x, actor: randomUUID() }) : bind(b, x, w));
      await blocked(db, bp, ap);
      if (mode === 'expiry') { assert.equal((await one(db, 'select clock_timestamp()<expires_at yes from public.growth_partner_sources where id=$1', [x.intent])).yes, true); await new Promise(r => setTimeout(r, 2200)); }
      await a.query('commit'); const result = await pending;
      if (['claim', 'approval', 'commercial', 'identity', 'owner'].includes(mode)) assert.equal(result.error?.code, 'P1121');
      else if (['payment', 'expiry'].includes(mode)) assert.equal(result.error?.code, 'P1123');
      else { assert.equal(result.error, undefined, result.error?.message); assert.equal(result.value.state, mode === 'capture' ? 'captured' : 'bound'); }
      if (mode === 'capture') assert.equal((await one(db, 'select partner_id from public.growth_partner_sources where id=$1', [x.intent])).partner_id, x.partner.partner);
    } finally { await a.query('rollback'); if (pending) await pending; await a.end(); await b.end(); await cleanup(db, x); }
  });
}
