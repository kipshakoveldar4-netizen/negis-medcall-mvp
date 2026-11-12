import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { seedPartnerLedger } from './partner-ledger-cases.mjs';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';
import { startOwnedPartnerHttp } from './partner-entry-native-http-cases.mjs';

const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const financialTables = ['platform_subscriptions', 'platform_subscription_payments', 'growth_referrals',
  'growth_partner_commissions', 'growth_partner_payouts', 'deals', 'growth_operator_arrivals'];
const companyTables = ['growth_contributor_profiles', 'growth_partners', 'growth_partner_sources',
  'growth_partner_company_applications', 'growth_partner_company_submission_fences',
  'growth_partner_company_review_fences', 'growth_partner_payment_windows', 'workspaces', 'staff_users', 'workspace_settings'];
const snapshot = async (db, tables = [...financialTables, ...companyTables]) => (await db.query(
  'select * from (' + tables.map(table => `select '${table}' relation,to_jsonb(r) value from public.${table} r`)
    .join(' union all ') + ') owned_inbox_snapshot order by relation,value::text')).rows;
export const partnerCompanyInboxFinancialSnapshot = db => snapshot(db, financialTables);
export const listOwnPartnerCompanies = async (db, actor, offset = 0, state = null) => (await one(db,
  'select public.list_own_growth_partner_companies($1,$2,$3) v', [actor, offset, state])).v;
const read = async (db, x, actor = x.actor) => (await one(db,
  'select public.read_growth_partner_company($1,$2) v', [actor, x.request])).v;
const review = async (db, x, revision, action = 'approve') => (await one(db,
  'select public.review_growth_partner_company($1,$2,$3,$4,$5) v', [x.owner, x.request, revision, x.reviewRequest, action])).v;
const page = (items, offset = 0, state = null, hasMore = false) => ({ items, offset, state, hasMore });
const ordered = items => [...items].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id));

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
async function expire(db, x) {
  await db.query(`update public.growth_partner_sources
    set captured_at=$2::timestamptz+interval '1 microsecond'-interval '168 hours',
      expires_at=$2::timestamptz+interval '1 microsecond' where id=$1`, [x.source, x.application.submittedAt]);
}
async function seed(db, context, { actor = context.actor, state = 'pending', expired = false, submittedAt, revoked = false } = {}) {
  const x = { actor, owner: context.owner, source: randomUUID(), request: randomUUID(), reviewRequest: randomUUID(),
    proof: createHash('sha256').update(randomUUID()).digest('hex'),
    company: { name: 'Owned inbox company', ownerName: 'Owned Applicant', purpose: 'marketing', vertical: null, timeZone: 'Asia/Almaty' },
    email: 'applicant@example.invalid', consent: consent(), application: null };
  context.applications.push(x);
  await transaction(db, async () => {
    await db.query('set local role service_role');
    await db.query("select public.capture_growth_partner_source_v2($1,$2,$3,'link',$4)",
      [x.source, x.proof, context.partner.code, new Date(Date.now() - 1000).toISOString()]);
    if (submittedAt) {
      // Fixed timestamps create a genuine ordering tie without changing an immutable submission.
      await db.query('select public.claim_growth_partner_source($1,$2,$3)', [x.actor, x.source, x.proof]);
      await db.query('reset role');
      await db.query(`insert into public.growth_partner_company_applications
        (id,source_id,applicant_auth_user_id,company,owner_email,consent_snapshot,submitted_at)
        values($1,$2,$3,$4,$5,$6,$7)`, [x.request, x.source, x.actor, x.company, x.email, x.consent, submittedAt]);
      await db.query('set local role service_role');
      x.application = await read(db, x);
    } else {
      x.application = (await one(db, 'select public.submit_growth_partner_company($1,$2,$3,$4,$5,$6,$7) v',
        [x.actor, x.source, x.proof, x.request, x.company, x.email, x.consent])).v;
    }
    if (state !== 'pending') x.application = await review(db, x, x.application.revision, state === 'approved' ? 'approve' : 'reject');
    if (expired || revoked) await db.query('reset role');
    if (expired) await expire(db, x);
    if (revoked) await db.query("update public.staff_users set status='disabled' where workspace_id=$1 and auth_user_id=$2", [x.application.workspaceId, x.actor]);
  });
  return x;
}
async function cleanup(db, context) {
  await transaction(db, async () => {
    for (const x of [...context.applications].reverse()) {
      const stored = await one(db, 'select workspace_id from public.growth_partner_company_applications where id=$1 and applicant_auth_user_id=$2', [x.request, x.actor]);
      await db.query('delete from public.growth_partner_company_submission_fences where actor_id=$1 and request_id=$2 and source_id=$3', [x.actor, x.request, x.source]);
      await db.query('delete from public.growth_partner_company_review_fences where owner_id=$1 and request_id=$2 and application_id=$3', [x.owner, x.reviewRequest, x.request]);
      await db.query('delete from public.growth_partner_company_applications where id=$1 and applicant_auth_user_id=$2 and source_id=$3', [x.request, x.actor, x.source]);
      await db.query('delete from public.growth_partner_payment_windows where source_id=$1', [x.source]);
      if (stored?.workspace_id) {
        await db.query('delete from public.staff_users where workspace_id=$1 and auth_user_id=any($2::uuid[])', [stored.workspace_id, [x.actor, ...context.extraMembers]]);
        await db.query('delete from public.workspace_settings where workspace_id=$1', [stored.workspace_id]);
      }
      await db.query('delete from public.growth_partner_sources where id=$1 and partner_id=$2', [x.source, context.partner.partner]);
      if (stored?.workspace_id) await db.query('delete from public.workspaces where id=$1', [stored.workspace_id]);
    }
    await db.query('delete from public.growth_partners where id=$1 and auth_user_id=$2', [context.partner.partner, context.partner.actor]);
    await db.query('delete from public.growth_contributor_profiles where id=$1 and auth_user_id=$2', [context.partner.profile, context.partner.actor]);
  });
}
async function scenario(db, fixture, run) {
  const before = await snapshot(db), money = await partnerCompanyInboxFinancialSnapshot(db);
  const context = { actor: randomUUID(), owner: randomUUID(), applications: [], extraMembers: new Set() };
  context.partner = await transaction(db, () => seedPartnerLedger(db));
  const service = await fixture.connect();
  try {
    await service.query('set role service_role');
    assert.equal((await one(service, 'select current_user role')).role, 'service_role');
    assert.equal((await one(service, "select current_setting('transaction_isolation') isolation")).isolation, 'read committed');
    await run({ ...context, service, seed: options => seed(db, context, options) });
    assert.deepEqual(await partnerCompanyInboxFinancialSnapshot(db), money, 'Inbox calls must not write financial rows');
  } finally {
    await service.query('rollback'); await service.end(); await cleanup(db, context);
    assert.deepEqual(await snapshot(db), before, 'Exact owned cleanup leaves all company and financial rows unchanged');
  }
}
function assertDto(application) {
  assert.deepEqual(Object.keys(application).sort(), ['id', 'revision', 'state', 'company', 'workspaceId', 'sourceState', 'expiresAt', 'submittedAt', 'reviewedAt'].sort());
  assert.deepEqual(Object.keys(application.company).sort(), ['name', 'ownerName', 'purpose', 'vertical', 'timeZone'].sort());
  assert.doesNotMatch(JSON.stringify(application), /applicant_auth_user_id|owner_email|sourceId|source_id|capability|consent|@example/);
}
async function blocked(db, waiter, blocker, locktype) {
  for (let n = 0; n < 200; n++) {
    const state = await one(db, `select $1::int=any(pg_blocking_pids($2::int)) blocked,
      exists(select 1 from pg_locks where pid=$2 and not granted and locktype=$3) expected`, [blocker, waiter, locktype]);
    if (state.blocked && state.expected) return;
    await delay(10);
  }
  assert.fail('Expected a real owned inbox ' + locktype + ' lock wait');
}
async function race(db, fixture, { lock, waiting, commit, locktype = 'advisory' }) {
  const writer = await fixture.connect(), reader = await fixture.connect(); let pending;
  try {
    await reader.query('set role service_role');
    const writerPid = (await one(writer, 'select pg_backend_pid() id')).id;
    const readerPid = (await one(reader, 'select pg_backend_pid() id')).id;
    await writer.query('begin'); await lock(writer);
    pending = observed(waiting(reader));
    await blocked(db, readerPid, writerPid, locktype);
    await commit(writer, readerPid); await writer.query('commit');
    return await pending;
  } finally {
    await writer.query('rollback'); if (pending) await pending;
    await writer.end(); await reader.end();
  }
}
const sourceLock = (db, source) => db.query("select pg_advisory_xact_lock(hashtextextended('partner-source:'||$1::text,0))", [source]);

export async function exercisePartnerCompanyInboxRerunRefusals(db, source, t) {
  const signature = 'public.list_own_growth_partner_companies(uuid,integer,text)';
  const metadata = async () => one(db, `select p.proowner::regrole::text owner,p.provolatile,p.prosecdef,
    p.prorettype::regtype::text result,p.pronargdefaults,p.proconfig,p.prosrc,p.proacl::text acl
    from pg_proc p where p.oid=$1::regprocedure`, [signature]);
  const original = await metadata(), before = await snapshot(db);
  const cases = [
    ['volatility', 'alter function ' + signature + ' stable', 'partner_company_inbox_reader_unconfirmed'],
    ['search path', 'alter function ' + signature + ' set search_path=public', 'partner_company_inbox_reader_unconfirmed'],
    ['body', `create or replace function public.list_own_growth_partner_companies(p_actor uuid,p_offset integer,p_state text)
      returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s'
      as $owned_inbox_tamper$begin return '{}'::jsonb; end$owned_inbox_tamper$`, 'partner_company_inbox_reader_unconfirmed'],
    ['anon grant', 'grant execute on function ' + signature + ' to anon', 'partner_company_inbox_acl_unconfirmed'],
    ['authenticated grant', 'grant execute on function ' + signature + ' to authenticated', 'partner_company_inbox_acl_unconfirmed'],
    ['missing service grant', 'revoke execute on function ' + signature + ' from service_role', 'partner_company_inbox_acl_unconfirmed'],
  ];
  for (const [name, tamper, message] of cases) {
    await t.test('126 actual rerun refuses changed reader ' + name + ' without repairing or broadening it', async () => {
      await db.query('begin');
      try {
        await db.query(tamper); const changed = await metadata();
        assert.notDeepEqual(changed, original, 'The negative control must actually alter the installed reader');
        await db.query('savepoint owned_inbox_rerun_refusal');
        await assert.rejects(() => db.query(source), { code: 'P0001', message });
        await db.query('rollback to savepoint owned_inbox_rerun_refusal');
        assert.deepEqual(await metadata(), changed, 'A refused migration must not silently normalize the altered reader');
      } finally { await db.query('rollback'); }
      assert.deepEqual(await metadata(), original, 'The isolated negative control restores the actual reader');
      assert.deepEqual(await snapshot(db), before);
    });
  }
}

export async function exercisePartnerCompanyInboxNative(db, fixture, source, t) {
  await t.test('126 own pending/rejected require no memberships; foreign applications stay private even for their current owner', async () => scenario(db, fixture, async ({ service, seed, actor, extraMembers }) => {
    const pending = await seed(), rejected = await seed({ state: 'rejected' });
    const foreign = await seed({ actor: randomUUID(), state: 'approved' });
    assert.equal((await one(db, 'select count(*)::int n from public.staff_users where auth_user_id=$1', [actor])).n, 0);
    extraMembers.add(actor);
    await db.query(`insert into public.staff_users(workspace_id,auth_user_id,email,full_name,role,status)
      values($1,$2,'foreign-owner@example.invalid','Owned extra member','owner','active')`, [foreign.application.workspaceId, actor]);
    const before = await snapshot(db), expected = ordered([await read(service, pending), await read(service, rejected)]);
    assert.deepEqual(await listOwnPartnerCompanies(service, actor), page(expected));
    assert.deepEqual(await listOwnPartnerCompanies(service, randomUUID()), page([]));
    await assert.rejects(() => read(service, foreign, actor), { code: 'P1211' });
    for (const dto of expected) assertDto(dto);
    assert.deepEqual(await snapshot(db), before, 'Listing does not claim sources, create membership, or change applications');
  }));
  await t.test('126 eligibility precedes offset and 21-row lookahead across more than 20 own, foreign, and revoked approved rows', async () => scenario(db, fixture, async ({ service, seed, actor }) => {
    const own = [];
    for (let i = 0; i < 23; i++) {
      own.push(await seed({ state: i % 7 === 0 ? 'approved' : 'pending' }));
      if (i % 4 === 0) {
        await seed({ actor: randomUUID() });
        await seed({ state: 'approved', revoked: true });
      }
    }
    const tiedAt = new Date().toISOString();
    own.push(await seed({ submittedAt: tiedAt }), await seed({ submittedAt: tiedAt }));
    const expected = ordered(await Promise.all(own.map(x => read(service, x))));
    const before = await snapshot(db);
    for (const offset of [0, 1, 4, 5, 20, 24, 25, 1000000]) {
      assert.deepEqual(await listOwnPartnerCompanies(service, actor, offset), page(expected.slice(offset, offset + 20), offset, null, expected.length > offset + 20));
    }
    assert.equal(expected[0].submittedAt, expected[1].submittedAt, 'Exercise the id DESC tie-break, not only distinct timestamps');
    assert.ok(expected[0].id > expected[1].id);
    assert.deepEqual(await snapshot(db), before, 'Pagination and lookahead are fully read-only');
  }));
  await t.test('126 state filters and terminal expiry preserve full DTOs, original dates, and all financial/company rows', async () => scenario(db, fixture, async ({ service, seed, actor }) => {
    const xs = [];
    for (const state of ['pending', 'rejected', 'approved']) {
      xs.push(await seed({ state }), await seed({ state, expired: true }));
      await seed({ actor: randomUUID(), state });
    }
    const expected = ordered(await Promise.all(xs.map(x => read(service, x)))), before = await snapshot(db);
    for (const dto of expected) assertDto(dto);
    for (const state of ['pending', 'rejected', 'approved']) {
      const filtered = expected.filter(x => x.state === state);
      assert.equal(filtered.filter(x => x.sourceState === 'expired').length, 1);
      for (const offset of [0, 1, 2]) assert.deepEqual(await listOwnPartnerCompanies(service, actor, offset, state), page(filtered.slice(offset), offset, state));
    }
    assert.deepEqual(await listOwnPartnerCompanies(service, actor), page(expected));
    assert.deepEqual(await snapshot(db), before, 'Expiry reads never renew captured/expires dates or reserve/confirm money');
  }));
  for (const revocation of ['disabled', 'receptionist', 'deleted']) {
    await t.test('126 confirmed ' + revocation + ' membership revocation removes approved workspaces from readback', async () => scenario(db, fixture, async ({ service, seed, actor }) => {
      const approved = await seed({ state: 'approved' }), pending = await seed();
      assert.deepEqual(await listOwnPartnerCompanies(service, actor, 0, 'approved'), page([approved.application], 0, 'approved'));
      if (revocation === 'deleted') await db.query('delete from public.staff_users where workspace_id=$1 and auth_user_id=$2', [approved.application.workspaceId, actor]);
      else await db.query('update public.staff_users set ' + (revocation === 'disabled' ? "status='disabled'" : "role='receptionist'") + ' where workspace_id=$1 and auth_user_id=$2', [approved.application.workspaceId, actor]);
      const stored = await one(db, 'select role,status from public.staff_users where workspace_id=$1 and auth_user_id=$2', [approved.application.workspaceId, actor]);
      if (revocation === 'deleted') assert.equal(stored, undefined);
      else assert.deepEqual(stored, revocation === 'disabled' ? { role: 'owner', status: 'disabled' } : { role: 'receptionist', status: 'active' });
      const before = await snapshot(db);
      await assert.rejects(() => read(service, approved), { code: 'P1121' });
      assert.deepEqual(await listOwnPartnerCompanies(service, actor), page([pending.application]));
      assert.deepEqual(await listOwnPartnerCompanies(service, actor, 0, 'approved'), page([], 0, 'approved'));
      assert.deepEqual(await snapshot(db), before);
    }));
  }
  await t.test('126 invalid pagination/state and non-read-committed calls fail P1212; actorless calls fail P1211', async () => scenario(db, fixture, async ({ service, seed, actor }) => {
    await seed(); const before = await snapshot(db);
    for (const offset of [null, -1, 1000001]) await assert.rejects(() => listOwnPartnerCompanies(service, actor, offset), { code: 'P1212' });
    for (const state of ['', 'unknown', 'Pending', ' approved ']) await assert.rejects(() => listOwnPartnerCompanies(service, actor, 0, state), { code: 'P1212' });
    await assert.rejects(() => listOwnPartnerCompanies(service, null), { code: 'P1211' });
    for (const isolation of ['repeatable read', 'serializable']) {
      await service.query('begin isolation level ' + isolation);
      try { await assert.rejects(() => listOwnPartnerCompanies(service, actor), { code: 'P1212' }); }
      finally { await service.query('rollback'); }
    }
    assert.deepEqual(await snapshot(db), before);
  }));
  for (const lockTarget of ['workspace', 'membership']) {
    await t.test('126 actual ' + lockTarget + ' row wait reaches the existing owner guard; committed revocation fails the entire page without leakage', async () => scenario(db, fixture, async ({ service, seed, actor }) => {
      const approved = await seed({ state: 'approved' }); await seed();
      const after = await race(db, fixture, {
        locktype: 'transactionid',
        lock: writer => writer.query(lockTarget === 'workspace'
          ? 'select id from public.workspaces where id=$1 for update'
          : 'select id from public.staff_users where workspace_id=$1 and auth_user_id=$2 for update',
        lockTarget === 'workspace' ? [approved.application.workspaceId] : [approved.application.workspaceId, actor]),
        waiting: reader => listOwnPartnerCompanies(reader, actor),
        commit: async (writer, readerPid) => {
          const key = await one(writer, "select hashtextextended('partner-source:'||$1::text,0) key", [approved.source]);
          assert.equal((await one(writer, `select exists(select 1 from pg_locks where pid=$1 and granted and locktype='advisory'
            and classid::bigint=(($2::bigint>>32)&4294967295) and objid::bigint=($2::bigint&4294967295)) yes`, [readerPid, key.key])).yes, true,
          'The reader holds the source lock before waiting on the existing owner guard');
          await writer.query("update public.staff_users set status='disabled' where workspace_id=$1 and auth_user_id=$2", [approved.application.workspaceId, actor]);
        },
      });
      assert.equal(after.error?.code, 'P1121'); assert.equal(after.value, undefined, 'No partial page or stale approved DTO escapes the owner guard');
      const before = await snapshot(db), retry = await listOwnPartnerCompanies(service, actor);
      assert.equal(retry.items.length, 1); assert.equal(retry.items[0].state, 'pending');
      assert.deepEqual(await snapshot(db), before);
    }));
  }
  for (const filtered of [false, true]) {
    await t.test('126 application review while waiting on its source returns P1262 for the whole ' + (filtered ? 'filtered' : 'unfiltered') + ' page', async () => scenario(db, fixture, async ({ service, seed, actor }) => {
      const changed = await seed(); await seed();
      const before = await snapshot(db);
      const after = await race(db, fixture, {
        lock: writer => sourceLock(writer, changed.source),
        waiting: reader => listOwnPartnerCompanies(reader, actor, 0, filtered ? 'pending' : null),
        commit: async writer => { await writer.query('set local role service_role'); await review(writer, changed, changed.application.revision, 'reject'); },
      });
      assert.equal(after.error?.code, 'P1262'); assert.equal(after.value, undefined);
      const committed = await snapshot(db); assert.notDeepEqual(committed, before, 'A real review must have committed');
      const retry = await listOwnPartnerCompanies(service, actor, 0, filtered ? 'pending' : null);
      assert.equal(retry.items.length, filtered ? 1 : 2);
      assert.equal(retry.items.some(x => x.id === changed.request), !filtered);
      assert.deepEqual(await snapshot(db), committed, 'Whole-page retry is read-only');
    }));
  }
  await t.test('126 a state-only change with the same revision after a source wait still fails the whole page P1262', async () => scenario(db, fixture, async ({ service, seed, actor }) => {
    const changed = await seed(); await seed();
    const after = await race(db, fixture, {
      lock: writer => sourceLock(writer, changed.source),
      waiting: reader => listOwnPartnerCompanies(reader, actor),
      commit: writer => writer.query(`update public.growth_partner_company_applications set state='rejected',
        reviewed_by=$2,reviewed_at=clock_timestamp(),decision_request=$3,decision_revision=revision where id=$1`,
      [changed.request, changed.owner, changed.reviewRequest]),
    });
    assert.equal(after.error?.code, 'P1262'); assert.equal(after.value, undefined);
    assert.deepEqual(await one(db, 'select state,revision from public.growth_partner_company_applications where id=$1', [changed.request]),
      { state: 'rejected', revision: changed.application.revision });
    const before = await snapshot(db), retry = await listOwnPartnerCompanies(service, actor);
    assert.equal(retry.items.find(x => x.id === changed.request).state, 'rejected');
    assert.deepEqual(await snapshot(db), before);
  }));
  await t.test('126 revision-only change at row 21 fails P1262 instead of returning a stale hasMore or partial page', async () => scenario(db, fixture, async ({ service, seed, actor }) => {
    const xs = []; for (let i = 0; i < 21; i++) xs.push(await seed());
    const changed = xs[0], revision = randomUUID();
    const after = await race(db, fixture, {
      lock: writer => sourceLock(writer, changed.source),
      waiting: reader => listOwnPartnerCompanies(reader, actor),
      commit: writer => writer.query('update public.growth_partner_company_applications set revision=$2 where id=$1', [changed.request, revision]),
    });
    assert.equal(after.error?.code, 'P1262'); assert.equal(after.value, undefined);
    const before = await snapshot(db);
    assert.equal((await listOwnPartnerCompanies(service, actor)).hasMore, true);
    const last = await listOwnPartnerCompanies(service, actor, 20);
    assert.equal(last.items[0].id, changed.request); assert.equal(last.items[0].revision, revision); assert.equal(last.hasMore, false);
    assert.deepEqual(await snapshot(db), before);
  }));
  await t.test('126 effective anon/authenticated/service ACL closes tables and private helpers, and rerun preserves live rows', async () => scenario(db, fixture, async ({ service, seed, actor }) => {
    const x = await seed({ state: 'approved' }), before = await snapshot(db);
    const catalog = async () => (await db.query(`select c.oid,c.relname,c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p','S','v','m') order by c.oid`)).rows;
    const relations = await catalog();
    await db.query(source);
    assert.deepEqual(await catalog(), relations, '126 rerun creates no tables and broadens no relation grants');
    const signature = 'public.list_own_growth_partner_companies(uuid,integer,text)';
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await one(db, "select has_function_privilege($1,$2,'EXECUTE') yes", [role, signature])).yes, role === 'service_role');
      for (const table of ['growth_partner_company_applications', 'growth_partner_sources', 'growth_partner_company_submission_fences', 'growth_partner_company_review_fences']) {
        assert.equal((await one(db, "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') yes", [role, 'public.' + table])).yes, false);
        assert.equal((await one(db, "select has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') yes", [role, 'public.' + table])).yes, false);
      }
      for (const helper of ['public.partner_source_owner(uuid,uuid)', 'public.partner_company_result(public.growth_partner_company_applications)',
        'public.submit_growth_partner_company_121(uuid,uuid,text,uuid,jsonb,text,jsonb)', 'public.review_growth_partner_company_121(uuid,uuid,uuid,uuid,text)']) {
        assert.equal((await one(db, "select has_function_privilege($1,$2,'EXECUTE') yes", [role, helper])).yes, false);
      }
      const client = await fixture.connect();
      try {
        await client.query('set role ' + role);
        assert.equal((await one(client, 'select current_user role')).role, role);
        if (role === 'service_role') assert.deepEqual(await listOwnPartnerCompanies(client, actor), page([x.application]));
        else await assert.rejects(() => listOwnPartnerCompanies(client, actor), { code: '42501' });
        await assert.rejects(() => client.query('select id from public.growth_partner_company_applications limit 1'), { code: '42501' });
        await assert.rejects(() => client.query('select public.partner_source_owner($1,$2)', [actor, x.application.workspaceId]), { code: '42501' });
      } finally { await client.end(); }
    }
    assert.deepEqual(await listOwnPartnerCompanies(service, actor), page([x.application]));
    assert.deepEqual(await snapshot(db), before);
  }));
}

async function withHttp(fixture, actor, run) {
  const calls = [], direct = [], errors = [], token = 'owned.inbox.signature';
  const adapter = {
    from(...args) { direct.push(args); throw Error('PRIVATE_UNEXPECTED_DIRECT_TABLE'); },
    async rpc(name, args) {
      assert.equal(name, 'list_own_growth_partner_companies');
      assert.deepEqual(Object.keys(args).sort(), ['p_actor', 'p_offset', 'p_state']);
      calls.push({ name, args: structuredClone(args) });
      const client = await fixture.connect();
      try {
        await client.query('set role service_role');
        return { data: await listOwnPartnerCompanies(client, args.p_actor, args.p_offset, args.p_state), error: null };
      } catch (error) { errors.push(error.code); return { data: null, error: { code: error.code, message: 'PRIVATE_INBOX_SQL_DIAGNOSTIC' } }; }
      finally { await client.end(); }
    },
  };
  const f = await partnerEntryHttpFixture(adapter, { company: true,
    authUsers: new Map([[token, { id: actor, email: 'applicant@example.invalid', email_confirmed_at: '2026-10-27T00:00:00.000Z' }]]),
    env: { MEDINA_PARTNER_ENTRY_ENABLED: 'false', MEDINA_PARTNER_COMPANY_ENABLED: 'false' } });
  let server;
  try {
    server = await startOwnedPartnerHttp((req, res) => {
      req.query.path = req.query.path.flatMap(segment => segment.split('/')); return f.handler(req, res);
    }, ['/api/crm/partner-company']);
    async function call(query = {}, { authorization = token } = {}) {
      const response = await fetch(server.origin + '/api/crm/partner-company?' + new URLSearchParams({ view: 'list', ...query }), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Origin: ENTRY_ORIGIN,
          ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}) },
      });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('set-cookie'), null);
      const value = await response.json();
      assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|owned-only-not-credential|owned\.inbox\.signature|auth_user_id|capability|sourceId|source_id|owner_email/);
      return { status: response.status, value };
    }
    await run({ f, call, calls, errors });
  } finally {
    if (server) { await server.close(); assert.deepEqual(server.state.errors, []); }
    f.close(); assert.deepEqual(f.state.unexpected, []); assert.deepEqual(f.state.challenges, []); assert.deepEqual(direct, []);
  }
}
export async function exercisePartnerCompanyInboxNativeHttp(db, fixture, t) {
  t.after(stopPartnerEntryBuilds);
  await t.test('126 real compiled GET list uses the verified subject and actual service RPC with intake disabled and no capability cookie', async () => scenario(db, fixture, async ({ service, seed, actor }) => {
    const pending = await seed(), rejected = await seed({ state: 'rejected', expired: true }), approved = await seed({ state: 'approved' });
    await seed({ actor: randomUUID() }); const before = await snapshot(db);
    await withHttp(fixture, actor, async h => {
      for (const [offset, state] of [[0, null], [1, null], [0, 'pending'], [0, 'rejected'], [0, 'approved']]) {
        const response = await h.call({ offset: String(offset), ...(state ? { state } : {}) });
        assert.equal(response.status, 200, JSON.stringify(response.value));
        assert.deepEqual(response.value, { success: true, data: await listOwnPartnerCompanies(service, actor, offset, state) });
      }
      assert.ok(h.calls.every(call => call.args.p_actor === actor));
      assert.equal(h.calls.length, 5); assert.deepEqual(h.errors, []);
      assert.deepEqual(await snapshot(db), before);
      await db.query("update public.staff_users set role='receptionist' where workspace_id=$1 and auth_user_id=$2", [approved.application.workspaceId, actor]);
      assert.deepEqual(await one(db, 'select role,status from public.staff_users where workspace_id=$1 and auth_user_id=$2', [approved.application.workspaceId, actor]),
        { role: 'receptionist', status: 'active' });
      const revoked = await snapshot(db), response = await h.call();
      assert.deepEqual(response, { status: 200, value: { success: true, data: page(ordered([await read(service, pending), await read(service, rejected)])) } });
      assert.deepEqual(await snapshot(db), revoked);
    });
  }));
  await t.test('126 compiled GET rejects browser identity/workspace/source selectors and malformed pagination before any SQL call', async () => scenario(db, fixture, async ({ seed, actor }) => {
    await seed(); const before = await snapshot(db);
    await withHttp(fixture, actor, async h => {
      for (const selector of ['actorId', 'ownerId', 'workspaceId', 'companyId', 'requestId', 'sourceId', 'p_actor']) {
        assert.equal((await h.call({ [selector]: randomUUID() })).status, 400);
      }
      for (const query of [{ offset: '-1' }, { offset: '01' }, { offset: '1.5' }, { offset: '1000001' }, { state: 'unknown' }, { view: 'unknown' }]) {
        assert.equal((await h.call(query)).status, 400);
      }
      assert.equal((await h.call({}, { authorization: null })).status, 401);
      assert.deepEqual(h.calls, []); assert.deepEqual(h.errors, []);
      assert.deepEqual(await snapshot(db), before);
    });
  }));
}
