import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrations = [
  '009_medcall_mvp_persistence.sql', '010_staff_ready_crm.sql', '011_staff_auth_foundation.sql',
  '014_meta_ad_launches.sql', '019_crm_lead_pipeline_foundation.sql', '028_leads_phone_normalized.sql',
  '038_staff_join_requests.sql', '069_assigned_lead_manager.sql', '070_mortgage_workspace.sql',
  '078_mortgage_signed_contracts.sql',
];
const row = async (c, sql, args = []) => (await c.query(sql, args)).rows[0];
const observed = p => p.then(value => ({ value }), error => ({ error }));
const identity = p => [p.w, p.id, p.auth];
const save = async (c, p, lead, payload, key = randomUUID(), contract = null) =>
  (await row(c, 'select public.save_mortgage_contract($1,$2,$3,$4,$5,$6,$7::jsonb) as result',
    [...identity(p), lead, contract, key, JSON.stringify(payload)])).result;
const read = async (c, p, lead) => (await row(c,
  'select public.read_mortgage_contracts($1,$2,$3,$4) as result', [...identity(p), lead])).result;
const results = async (c, p, days = 30) => (await row(c,
  'select public.read_mortgage_results($1,$2,$3,$4) as result', [...identity(p), days])).result;
const member = (report, p) => report.members.find(m => m.staffId === p.id);
const contractRow = async (c, id) => (await row(c,
  'select to_jsonb(c) as item from public.mortgage_signed_contracts c where id=$1', [id])).item;
const draft = signedAt => ({ signedAt, reference: 'Synthetic contract' });

async function denied(operation, code, message) {
  const r = await observed(operation);
  assert.ok(r.error, `Expected ${code}, but the real RPC succeeded`);
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.equal(r.error.message, message);
  return r.error;
}

async function snapshot(c) {
  const state = {};
  for (const table of ['leads', 'mortgage_signed_contracts', 'mortgage_contract_requests', 'mortgage_activities']) {
    state[table] = (await row(c, `select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) as rows from public.${table} r`)).rows;
  }
  return state;
}

async function seed(db) {
  const w = randomUUID(), foreign = randomUUID();
  for (const id of [w, foreign]) {
    await db.query("insert into public.workspaces(id,name) values($1,'Synthetic mortgage contracts')", [id]);
    await db.query(`insert into public.workspace_settings(workspace_id,key,value)
      values($1,'workspace_purpose','{"purpose":"mortgage_leads"}')`, [id]);
  }
  const people = ['owner', 'admin', 'lead_manager', 'lead_manager', 'manager', 'lead_manager', 'lead_manager']
    .map((role, i) => ({ w: i === 6 ? foreign : w, id: randomUUID(), auth: randomUUID(), role,
      name: `Synthetic full staff name ${i}`, status: i === 5 ? 'inactive' : 'active' }));
  for (const [i, p] of people.entries()) await db.query(`insert into public.staff_users
    (id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,$4,$5,$6,$7)`,
  [p.id, p.w, p.auth, `synthetic-contract-${i}@example.invalid`, p.name, p.role, p.status]);
  const [owner, admin, a, b, manager, inactive, outsider] = people;
  const now = Date.parse((await row(db, 'select statement_timestamp() as now')).now);
  const ago = days => new Date(now - days * 86400000).toISOString();
  const lead = async (assignee = a, workspace = w, created = ago(120)) => {
    const id = randomUUID();
    await db.query(`insert into public.leads(id,workspace_id,responsible_user_id,full_name,phone,created_at)
      values($1,$2,$3,'Synthetic mortgage lead','+77000000000',$4)`, [id, workspace, assignee?.id ?? null, created]);
    return id;
  };
  const meeting = async (leadId, end, options = {}) => {
    const ends = new Date(end);
    await db.query(`insert into public.mortgage_activities
      (workspace_id,lead_id,kind,title,status,starts_at,ends_at,created_by_staff_user_id)
      values($1,$2,'meeting','Synthetic meeting',$3,$4,$5,$6)`,
    [options.w ?? w, leadId, options.status ?? 'done', new Date(+ends - 3600000).toISOString(), ends.toISOString(), options.actor ?? owner.id]);
  };
  return { w, foreign, people, owner, admin, a, b, manager, inactive, outsider, ago, lead, meeting };
}

async function contenders(fixture, db, t) {
  const a = await fixture.connect(), b = await fixture.connect();
  t.after(async () => {
    await a.query('rollback').catch(() => {});
    await b.query('rollback').catch(() => {});
    await a.end(); await b.end();
  });
  const aPid = (await row(a, 'select pg_backend_pid() as pid')).pid;
  const bPid = (await row(b, 'select pg_backend_pid() as pid')).pid;
  const observerPid = (await row(db, 'select pg_backend_pid() as pid')).pid;
  assert.equal(new Set([aPid, bPid, observerPid]).size, 3);
  assert.equal((await row(b, 'show transaction_isolation')).transaction_isolation, 'read committed');
  await b.query('set role service_role');
  const blocked = async () => {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const lock = await row(db, `select pg_blocking_pids(pid) as blockers,wait_event_type
        from pg_stat_activity where pid=$1`, [bPid]);
      if (lock?.blockers.includes(aPid)) {
        assert.equal(lock.wait_event_type, 'Lock');
        t.diagnostic('pg_blocking_pids observed the distinct waiting connection and expected holder');
        return;
      }
      await delay(15);
    }
    assert.fail('Expected real PostgreSQL blocking edge was not observed');
  };
  return { a, b, blocked };
}

test('mortgage signed contracts on owned disposable PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  try {
    const db = await fixture.connect();
    await db.query(`create role anon; create role authenticated; create role service_role bypassrls;
      grant usage on schema public to anon,authenticated,service_role;`);
    for (const file of migrations) {
      if (file.startsWith('070_')) {
        // Only the real settings table DDL from 013 is needed by 070's actor check.
        const settings = await readFile(path.join(root, 'migrations/013_release_admin_settings.sql'), 'utf8');
        await db.query(settings.slice(0, settings.indexOf(';') + 1));
      }
      await db.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
    }
    t.diagnostic(`PostgreSQL ${(await row(db, 'show server_version')).server_version}; real 009/010/011/014/019/028/038/069/070/078; synthetic only`);
    const f = await seed(db), { owner, admin, a, b, manager, inactive, outsider } = f;
    const service = await fixture.connect();
    await service.query('set role service_role');

    await t.test('same key replays one row and receipt; changed payload and different key conflict without writes', async () => {
      const lead = await f.lead(), key = randomUUID(), payload = draft(f.ago(1));
      const created = await save(service, a, lead, payload, key);
      assert.equal(created.replayed, false);
      const before = await snapshot(db);
      assert.deepEqual(await save(service, a, lead, payload, key), { id: created.id, replayed: true });
      await denied(save(service, a, lead, { ...payload, reference: 'Changed' }, key), 'P7807');
      await denied(save(service, a, lead, { ...payload, signedAt: f.ago(2) }, key), 'P7807');
      await denied(save(service, a, lead, payload), 'P7804');
      assert.deepEqual(await snapshot(db), before);
      assert.equal((await row(db, 'select count(*)::int as n from public.mortgage_signed_contracts where lead_id=$1', [lead])).n, 1);
      assert.equal((await row(db, 'select count(*)::int as n from public.mortgage_contract_requests where contract_id=$1', [created.id])).n, 1);
    });

    await t.test('unique partial index independently forbids a second active contract', async () => {
      const lead = await f.lead();
      await save(service, a, lead, draft(f.ago(1)));
      const before = await snapshot(db);
      const error = await denied(db.query(`insert into public.mortgage_signed_contracts
        (workspace_id,lead_id,signed_at,responsible_staff_user_id,recorded_by_staff_user_id)
        values($1,$2,$3,$4,$4)`, [f.w, lead, f.ago(1), a.id]), '23505');
      assert.equal(error.constraint, 'mortgage_signed_contracts_active_lead_idx');
      assert.deepEqual(await snapshot(db), before);
    });

    await t.test('lead managers read/create only their own; inaccessible lead identities are indistinguishable', async () => {
      const own = await f.lead(), other = await f.lead(b), unassigned = await f.lead(null);
      const foreign = await f.lead(outsider, f.foreign), foreignAssigned = await f.lead(a, f.foreign);
      const saved = await save(service, a, own, draft(f.ago(1)));
      assert.deepEqual((await read(service, a, own)).records.map(c => c.id), [saved.id]);
      const before = await snapshot(db);
      for (const lead of [other, unassigned, foreign, foreignAssigned, randomUUID()]) {
        await denied(read(service, a, lead), 'P7002', 'lead_not_found');
        await denied(save(service, a, lead, draft(f.ago(1))), 'P7002', 'lead_not_found');
      }
      for (const p of [owner, admin]) {
        await denied(read(service, p, foreign), 'P7002');
        await denied(save(service, p, foreign, draft(f.ago(1))), 'P7002');
      }
      await denied(results(service, a), 'P7001');
      assert.deepEqual(await snapshot(db), before);
    });

    await t.test('owner/admin create and correct; lead manager cannot void and legacy manager has no access', async () => {
      for (const p of [owner, admin]) {
        const lead = await f.lead(p);
        const saved = await save(service, p, lead, draft(f.ago(1)));
        assert.equal((await read(service, p, lead)).records[0].responsibleStaffId, p.id);
        await save(service, p, lead, { reason: 'Synthetic correction' }, randomUUID(), saved.id);
        assert.ok((await read(service, p, lead)).records[0].voidedAt);
        assert.ok(member(await results(service, p), p));
      }
      const lead = await f.lead(), saved = await save(service, a, lead, draft(f.ago(1)));
      const before = await snapshot(db);
      await denied(save(service, a, lead, { reason: 'Denied correction' }, randomUUID(), saved.id), 'P7001');
      for (const operation of [() => read(service, manager, lead), () => results(service, manager), () => save(service, manager, lead, draft(f.ago(1)))]) {
        await denied(operation(), 'P7001');
      }
      assert.deepEqual(await snapshot(db), before);
    });

    await t.test('full staff names use workspace-scoped joins; tenant and poisoned cross-staff data never leak', async () => {
      const lead = await f.lead(), saved = await save(service, owner, lead, draft(f.ago(1)));
      const record = (await read(service, a, lead)).records[0];
      assert.equal(record.responsibleName, a.name);
      assert.equal(record.recordedByName, owner.name);
      assert.doesNotMatch(JSON.stringify(record), /@example\.invalid|auth_user_id|workspace_id/);
      const foreignLead = await f.lead(outsider, f.foreign);
      await save(service, outsider, foreignLead, { ...draft(f.ago(1)), reference: 'FOREIGN-CONTRACT-SENTINEL' });
      // Legacy single-column FKs admit inconsistent rows; reads must still scope every join.
      await db.query(`update public.mortgage_signed_contracts set responsible_staff_user_id=$1,
        recorded_by_staff_user_id=$1 where id=$2`, [outsider.id, saved.id]);
      const poisoned = (await read(service, owner, lead)).records[0];
      assert.equal(poisoned.responsibleName, ''); assert.equal(poisoned.recordedByName, '');
      const beforeForeign = await results(service, owner);
      await db.query(`insert into public.mortgage_signed_contracts
        (workspace_id,lead_id,reference,signed_at,responsible_staff_user_id,recorded_by_staff_user_id)
        values($1,$2,'FOREIGN-CONTRACT-SENTINEL',$3,$4,$4)`, [f.foreign, lead, f.ago(1), outsider.id]);
      const localRead = await read(service, owner, lead), report = await results(service, owner);
      assert.deepEqual(localRead.records.map(c => c.id), [saved.id]);
      assert.deepEqual({ ...report, generatedAt: null, period: null }, { ...beforeForeign, generatedAt: null, period: null },
        'a foreign-workspace contract referencing a local lead must not alter any portfolio or signing count');
      assert.ok(report.members.every(m => f.people.filter(p => p.w === f.w && p.role !== 'manager').some(p => p.id === m.staffId)));
      assert.ok(!JSON.stringify([localRead, report]).includes(outsider.name));
      assert.doesNotMatch(JSON.stringify([localRead, report]), /FOREIGN-CONTRACT-SENTINEL|@example\.invalid/);
      await db.query('update public.mortgage_signed_contracts set responsible_staff_user_id=$1,recorded_by_staff_user_id=$2 where id=$3', [a.id, owner.id, saved.id]);
    });

    await t.test('correction requires reason, preserves original signing attribution and history, and is not a refund', async () => {
      const lead = await f.lead(), key = randomUUID(), payload = draft(f.ago(2));
      const saved = await save(service, a, lead, payload, key), original = await contractRow(db, saved.id);
      const before = await snapshot(db), previous = member(await results(service, owner), a).signedInPeriod;
      for (const correction of [{}, { reason: '' }, { reason: '   ' }, { reason: null }, { reason: 'r'.repeat(501) }, { reason: 'Refund', amount: -1 }]) {
        await denied(save(service, owner, lead, correction, randomUUID(), saved.id), 'P7803');
        assert.deepEqual(await snapshot(db), before);
      }
      const correctionKey = randomUUID(), correction = { reason: '  Duplicate synthetic entry  ' };
      assert.deepEqual(await save(service, admin, lead, correction, correctionKey, saved.id), { id: saved.id, replayed: false });
      const corrected = await contractRow(db, saved.id);
      for (const field of Object.keys(original).filter(k => !['voided_at', 'voided_by_staff_user_id', 'void_reason'].includes(k))) {
        assert.deepEqual(corrected[field], original[field], field);
      }
      assert.ok(corrected.voided_at); assert.equal(corrected.voided_by_staff_user_id, admin.id);
      assert.equal(corrected.void_reason, 'Duplicate synthetic entry');
      assert.equal(member(await results(service, owner), a).signedInPeriod, previous - 1);
      const after = await snapshot(db);
      assert.deepEqual(await save(service, admin, lead, correction, correctionKey, saved.id), { id: saved.id, replayed: true });
      assert.deepEqual(await save(service, a, lead, payload, key), { id: saved.id, replayed: true });
      await denied(save(service, admin, lead, { reason: 'Another' }, correctionKey, saved.id), 'P7807');
      await denied(save(service, owner, lead, { reason: 'Again' }, randomUUID(), saved.id), 'P7805');
      assert.deepEqual(await snapshot(db), after);
      const replacement = await save(service, owner, lead, { ...draft(f.ago(1)), reference: 'Corrected synthetic contract' });
      const history = await read(service, owner, lead);
      assert.deepEqual(history.records.map(c => c.id), [replacement.id, saved.id]);
      assert.equal(history.records[1].voidReason, corrected.void_reason);
      assert.equal((await row(db, 'select count(*)::int as n from public.mortgage_contract_requests where contract_id=$1', [saved.id])).n, 2);
      assert.doesNotMatch(JSON.stringify(history), /amount|payment|refund|commission|paid/i);
    });

    await t.test('reassignment moves current portfolio but not original signedInPeriod credit; replay reauthorizes first', async () => {
      const lead = await f.lead(), key = randomUUID(), payload = draft(f.ago(1));
      const saved = await save(service, a, lead, payload, key), original = await contractRow(db, saved.id);
      const before = await results(service, owner);
      await db.query('update public.leads set responsible_user_id=$1 where id=$2', [b.id, lead]);
      const after = await results(service, owner);
      for (const [p, delta] of [[a, -1], [b, 1]]) {
        assert.equal(member(after, p).assignedLeads, member(before, p).assignedLeads + delta);
        assert.equal(member(after, p).signedLeads, member(before, p).signedLeads + delta);
        assert.equal(member(after, p).signedInPeriod, member(before, p).signedInPeriod);
      }
      const state = await snapshot(db);
      await denied(save(service, a, lead, payload, key), 'P7002');
      await denied(read(service, a, lead), 'P7002');
      assert.equal((await read(service, b, lead)).records[0].responsibleStaffId, a.id);
      await denied(save(service, b, lead, payload, key), 'P7804', 'contract_already_recorded');
      assert.deepEqual(await contractRow(db, saved.id), original);
      assert.deepEqual(await snapshot(db), state);
    });

    await t.test('current-assignee all-time cohorts count distinct leads and require meeting before signing', async () => {
      const before = await results(service, owner);
      const positive = await f.lead(), reversed = await f.lead(), future = await f.lead(), old = await f.lead();
      await f.meeting(positive, f.ago(4)); await f.meeting(positive, f.ago(3));
      await f.meeting(reversed, f.ago(1)); await f.meeting(future, f.ago(-1));
      await f.meeting(old, f.ago(70));
      await save(service, a, positive, draft(f.ago(2)));
      const convertedBefore = member(before, a).heldSignedLeads;
      assert.equal(member(await results(service, owner), a).heldSignedLeads, convertedBefore + 1,
        'two done meetings followed by signing convert exactly one lead');
      await save(service, a, reversed, draft(f.ago(2)));
      assert.equal(member(await results(service, owner), a).heldSignedLeads, convertedBefore + 1,
        'a contract signed before its done meeting is not converted');
      await save(service, a, future, draft(f.ago(2)));
      assert.equal(member(await results(service, owner), a).heldSignedLeads, convertedBefore + 1,
        'a future-ended done meeting cannot convert a past signing');
      await save(service, a, old, draft(f.ago(60)));
      const after = await results(service, owner), x = member(before, a), y = member(after, a);
      assert.equal(y.assignedLeads - x.assignedLeads, 4);
      assert.equal(y.heldLeads - x.heldLeads, 3, 'repeated meetings count one lead; future-ended done is not held');
      assert.equal(y.signedLeads - x.signedLeads, 4, 'portfolio is all-time, not period-filtered');
      assert.equal(y.heldSignedLeads - x.heldSignedLeads, 2, 'only positive and old have meetings before signing');
      assert.equal(y.signedInPeriod - x.signedInPeriod, 3);
      const ninety = await results(service, owner, 90), seven = await results(service, owner, 7);
      assert.equal(member(ninety, a).signedInPeriod, y.signedInPeriod + 1);
      assert.equal(member(seven, a).heldSignedLeads, y.heldSignedLeads);
      assert.equal(after.period.days, 30);
      assert.equal(Date.parse(after.period.to) - Date.parse(after.period.from), 30 * 86400000);
      assert.equal(after.generatedAt, after.period.to);
      await db.query('update public.leads set responsible_user_id=$1 where id=$2', [b.id, positive]);
      const moved = await results(service, owner);
      for (const field of ['assignedLeads', 'heldLeads', 'signedLeads', 'heldSignedLeads']) {
        assert.equal(member(moved, a)[field], y[field] - 1, field);
        assert.equal(member(moved, b)[field], member(after, b)[field] + 1, field);
      }
      assert.equal(member(moved, a).signedInPeriod, y.signedInPeriod);
      assert.equal(member(moved, b).signedInPeriod, member(after, b).signedInPeriod);
    });

    await t.test('future/nonfinite times and invalid payloads leave no partial records or receipts', async () => {
      const lead = await f.lead(a, f.w, f.ago(10)), before = await snapshot(db);
      for (const payload of [null, [], {}, { ...draft(f.ago(1)), amount: 1 },
        draft(f.ago(-1)), draft('infinity'), draft('-infinity'), draft('not-a-date'),
        { ...draft(f.ago(1)), reference: 7 }, { ...draft(f.ago(1)), reference: 'x'.repeat(101) }]) {
        await denied(save(service, a, lead, payload), 'P7803');
        assert.deepEqual(await snapshot(db), before);
      }
      await denied(save(service, a, lead, draft(f.ago(1)), null), 'P7803');
      await denied(save(service, a, null, draft(f.ago(1))), 'P7803');
      await denied(read(service, a, null), 'P7002');
      for (const days of [null, 0, 1, 31, 365]) await denied(results(service, owner, days), 'P7803');
      assert.deepEqual(await snapshot(db), before);
    });

    await t.test('past signing before CRM import is accepted and database creation clock bounds signed_at', async () => {
      const lead = await f.lead(a, f.w, f.ago(1));
      const saved = await save(service, a, lead, draft(f.ago(60)));
      const record = await contractRow(db, saved.id);
      assert.equal(Date.parse(record.signed_at), Date.parse(f.ago(60)));
      assert.ok(Date.parse(record.signed_at) < Date.parse(f.ago(1)));
      assert.ok(Date.parse(record.signed_at) <= Date.parse(record.created_at));
      const second = await f.lead(), before = await snapshot(db);
      await denied(db.query(`insert into public.mortgage_signed_contracts
        (workspace_id,lead_id,signed_at,responsible_staff_user_id,recorded_by_staff_user_id)
        values($1,$2,$3,$4,$4)`, [f.w, second, f.ago(-1), a.id]), '23514');
      assert.deepEqual(await snapshot(db), before);
    });

    await t.test('creation requires an active workspace-local eligible assignee at signing time', async () => {
      const leads = [];
      for (const p of [null, inactive, manager, outsider]) leads.push(await f.lead(p));
      const before = await snapshot(db);
      for (const lead of leads) await denied(save(service, owner, lead, draft(f.ago(1))), 'P7806');
      assert.deepEqual(await snapshot(db), before);
    });

    await t.test('RLS and table privileges deny browser CRUD; only service_role can execute all three RPCs', async () => {
      const lead = await f.lead(), before = await snapshot(db);
      const signatures = ['public.save_mortgage_contract(uuid,uuid,uuid,uuid,uuid,uuid,jsonb)',
        'public.read_mortgage_contracts(uuid,uuid,uuid,uuid)', 'public.read_mortgage_results(uuid,uuid,uuid,integer)'];
      for (const signature of signatures) {
        for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await row(db,
          "select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).allowed, role === 'service_role');
        assert.equal((await row(db, `select count(*)::int as n from pg_proc p
          cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'`, [signature])).n, 0);
      }
      for (const table of ['mortgage_signed_contracts', 'mortgage_contract_requests']) {
        assert.equal((await row(db, 'select relrowsecurity as enabled from pg_class where oid=$1::regclass', [`public.${table}`])).enabled, true);
        for (const role of ['anon', 'authenticated']) for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          assert.equal((await row(db, 'select has_table_privilege($1,$2,$3) as allowed', [role, `public.${table}`, privilege])).allowed, false);
        }
      }
      const browser = await fixture.connect();
      try {
        for (const role of ['anon', 'authenticated']) {
          await browser.query(`set role ${role}`);
          await denied(read(browser, owner, lead), '42501');
          await denied(results(browser, owner), '42501');
          await denied(save(browser, owner, lead, draft(f.ago(1))), '42501');
          for (const table of ['mortgage_signed_contracts', 'mortgage_contract_requests']) {
            await denied(browser.query(`select * from public.${table}`), '42501');
            await denied(browser.query(`insert into public.${table} default values`), '42501');
            await denied(browser.query(`update public.${table} set workspace_id=workspace_id`), '42501');
            await denied(browser.query(`delete from public.${table}`), '42501');
          }
        }
        // Even with a temporary table grant, enabled RLS has no browser policy.
        await db.query('begin');
        await db.query('grant select on public.mortgage_signed_contracts,public.mortgage_contract_requests to authenticated');
        await db.query('set local role authenticated');
        for (const table of ['mortgage_signed_contracts', 'mortgage_contract_requests']) {
          assert.equal((await row(db, `select count(*)::int as n from public.${table}`)).n, 0);
        }
      } finally { await db.query('rollback'); await browser.end(); }
      assert.deepEqual(await snapshot(db), before);
    });

    await t.test('revoked membership, identity substitution and non-mortgage purpose cannot read, replay or write', async () => {
      const lead = await f.lead(), key = randomUUID(), payload = draft(f.ago(1));
      await save(service, a, lead, payload, key);
      for (const p of [{ ...a, auth: b.auth }, { ...a, w: f.foreign }, { ...a, id: outsider.id }, { ...a, auth: null }, inactive]) {
        const before = await snapshot(db);
        await denied(read(service, p, lead), 'P7001'); await denied(results(service, p), 'P7001');
        await denied(save(service, p, lead, payload), 'P7001');
        assert.deepEqual(await snapshot(db), before);
      }
      await db.query("update public.staff_users set status='inactive' where id=$1", [a.id]);
      try {
        const before = await snapshot(db);
        await denied(save(service, a, lead, payload, key), 'P7001');
        await denied(save(service, a, lead, payload), 'P7001');
        await denied(read(service, a, lead), 'P7001');
        assert.deepEqual(await snapshot(db), before);
      } finally { await db.query("update public.staff_users set status='active' where id=$1", [a.id]); }
      await db.query("update public.workspace_settings set value='{}' where workspace_id=$1 and key='workspace_purpose'", [f.w]);
      try {
        const before = await snapshot(db);
        await denied(save(service, owner, lead, payload), 'P7001');
        await denied(results(service, owner), 'P7001');
        assert.deepEqual(await snapshot(db), before);
      } finally { await db.query(`update public.workspace_settings set value='{"purpose":"mortgage_leads"}' where workspace_id=$1 and key='workspace_purpose'`, [f.w]); }
    });

    await t.test('two distinct requests on one lead serialize: one create, one P7804, with observed lock edge', async t => {
      const lead = await f.lead(), c = await contenders(fixture, db, t), payload = draft(f.ago(1));
      const firstKey = randomUUID(), secondKey = randomUUID();
      await c.a.query('begin'); await c.a.query('set local role service_role');
      const first = await save(c.a, a, lead, payload, firstKey);
      const pending = observed(save(c.b, a, lead, payload, secondKey));
      await c.blocked();
      assert.equal((await row(db, 'select count(*)::int as n from public.mortgage_signed_contracts where lead_id=$1', [lead])).n, 0);
      await c.a.query('commit');
      const second = await pending;
      assert.equal(first.replayed, false); assert.equal(second.error?.code, 'P7804', second.error?.message);
      assert.equal((await row(db, 'select count(*)::int as n from public.mortgage_signed_contracts where lead_id=$1', [lead])).n, 1);
      assert.deepEqual((await db.query('select request_id from public.mortgage_contract_requests where contract_id=$1', [first.id])).rows, [{ request_id: firstKey }]);
    });

    await t.test('concurrent membership revocation commits before waiting write: P7001 and no receipt', async t => {
      const lead = await f.lead(b), c = await contenders(fixture, db, t), before = await snapshot(db);
      await c.a.query('begin');
      await c.a.query("update public.staff_users set status='inactive' where id=$1", [b.id]);
      const pending = observed(save(c.b, b, lead, draft(f.ago(1))));
      await c.blocked(); await c.a.query('commit');
      try {
        const r = await pending;
        assert.equal(r.error?.code, 'P7001', r.error?.message);
        assert.deepEqual(await snapshot(db), before);
      } finally { await db.query("update public.staff_users set status='active' where id=$1", [b.id]); }
    });

    await t.test('concurrent reassignment commits before same-key replay: authorization wins over receipt', async t => {
      const lead = await f.lead(), key = randomUUID(), payload = draft(f.ago(1));
      await save(service, a, lead, payload, key);
      const c = await contenders(fixture, db, t);
      await c.a.query('begin');
      await c.a.query('update public.leads set responsible_user_id=$1 where id=$2', [b.id, lead]);
      const pending = observed(save(c.b, a, lead, payload, key));
      await c.blocked(); await c.a.query('commit');
      const before = await snapshot(db), r = await pending;
      assert.equal(r.error?.code, 'P7002', r.error?.message);
      assert.deepEqual(await snapshot(db), before);
    });
  } finally {
    await fixture.close();
    t.diagnostic('Owned disposable PostgreSQL stopped and removed; no URL or external database used');
  }
});
