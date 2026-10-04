import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inquiry = { name: 'Fixture visitor', phone: '+77070000001', business: 'Fixture business',
  service: 'call-center', pagePath: '/ru/', consentVersion: 'v1', consent: true };
const row = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));

async function mustBlock(observer, waiter, blocker) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const { blocked } = await row(observer, 'select $1::int = any(pg_blocking_pids($2::int)) as blocked', [blocker, waiter]);
    if (blocked) return;
    await delay(15);
  }
  assert.fail('Expected database lock wait was not observed; timing alone is not evidence of contention');
}

async function makeCase(fixture, observer, t) {
  const a = await fixture.connect(); const b = await fixture.connect();
  t.after(async () => {
    await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {});
    await a.end(); await b.end();
  });
  const aPid = (await row(a, 'select pg_backend_pid() as pid')).pid;
  const bPid = (await row(b, 'select pg_backend_pid() as pid')).pid;
  const workspace = randomUUID(), site = randomUUID(), staff = randomUUID(), user = randomUUID();
  const siteKey = `fixture-${randomUUID()}`;
  const keys = [randomUUID(), randomUUID()];
  await observer.query('insert into public.workspaces(id,name) values($1,\'Disposable fixture\')', [workspace]);
  await observer.query(`insert into public.crm_intake_sites(id,site_key,workspace_id,consent_version,allowed_page_paths,enabled,manual_deletion_enabled)
    values($1,$2,$3,'v1',array['/ru/'],true,true)`, [site, siteKey, workspace]);
  await observer.query(`insert into public.staff_users(id,workspace_id,auth_user_id,full_name,email,role)
    values($1,$2,$3,'Fixture owner',$4,'owner')`, [staff, workspace, user, `${user}@example.invalid`]);
  const submit = (client, key = randomUUID()) => client.query('select public.accept_crm_site_inquiry($1,$2,$3) as result', [siteKey, key, inquiry]);
  for (const key of keys) await submit(observer, key);
  const lead = await row(observer, 'select id,updated_at::text as stamp from public.leads where workspace_id=$1', [workspace]);
  const receipts = (await observer.query('select id from public.crm_site_inquiries where lead_id=$1 order by id', [lead.id])).rows.map(item => item.id);
  const requestKey = randomUUID();
  const erase = async client => (await row(client, 'select public.delete_crm_site_inquiry($1,$2,$3,$4,$5,$6,$7,$8,true) as result',
    [workspace, siteKey, lead.id, receipts, lead.stamp, staff, user, requestKey])).result;
  const counts = async () => row(observer, `select
    (select count(*)::int from public.leads where workspace_id=$1) as leads,
    (select count(*)::int from public.crm_site_inquiries where site_id=$2) as receipts,
    (select count(*)::int from public.crm_site_inquiry_deletions where workspace_id=$1) as completions,
    (select count(*)::int from public.crm_site_inquiry_erased_requests where site_id=$2) as tombstones`, [workspace, site]);
  return { a, b, aPid, bPid, workspace, site, siteKey, keys, lead, erase, submit, counts,
    blocked: () => mustBlock(observer, bPid, aPid) };
}

// This is intentionally separate from the PGlite suite: missing Docker/image
// fails the command, never skips tests or connects to a supplied DATABASE_URL.
test('site deletion contention on a disposable multi-session PostgreSQL', { timeout: 180000 }, async t => {
  const fixture = await startDisposablePostgres();
  t.after(() => fixture.close());
  const observer = await fixture.connect();
  await observer.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;');
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 26, 27, 30, 31, 32, 33, 34, 36, 40, 45, 52, 53, 54, 55, 56, 57, 58, 62]);
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    if (numbers.has(Number(file.slice(0, 3)))) await observer.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
  }
  await observer.query(await readFile(path.join(root, 'migrations/062_site_inquiry_manual_deletion.sql'), 'utf8'));
  const version = await row(observer, 'show server_version');
  t.diagnostic(`Disposable PostgreSQL ${version.server_version}; real migrations, distinct backend connections, synthetic records only`);

  await t.test('concurrent same-key deletion waits, then replays a single committed result', async t => {
    const f = await makeCase(fixture, observer, t);
    await f.a.query('begin; set local role service_role');
    assert.deepEqual(await f.erase(f.a), { deleted: true, receiptsDeleted: 2, replayed: false });
    await f.b.query('set role service_role');
    const second = observed(f.erase(f.b));
    await f.blocked(); await f.a.query('commit');
    assert.deepEqual((await second).value, { deleted: true, receiptsDeleted: 2, replayed: true });
    assert.deepEqual(await f.counts(), { leads: 0, receipts: 0, completions: 1, tombstones: 2 });
  });

  await t.test('in-flight intake commits another receipt and invalidates the earlier confirmation', async t => {
    const f = await makeCase(fixture, observer, t);
    await f.a.query('begin'); await f.submit(f.a);
    const deletion = observed(f.erase(f.b));
    await f.blocked(); await f.a.query('commit');
    assert.equal((await deletion).error?.message, 'deletion_scope_changed');
    assert.deepEqual(await f.counts(), { leads: 1, receipts: 3, completions: 0, tombstones: 0 });
  });

  await t.test('in-flight deletion prevents a delayed original intake retry from resurrecting the lead', async t => {
    const f = await makeCase(fixture, observer, t);
    await f.a.query('begin'); await f.erase(f.a);
    const retry = observed(f.submit(f.b, f.keys[0]));
    await f.blocked(); await f.a.query('commit');
    assert.equal((await retry).error?.message, 'inquiry_erased');
    assert.deepEqual(await f.counts(), { leads: 0, receipts: 0, completions: 1, tombstones: 2 });
    await f.submit(f.b); // A genuinely new consent remains allowed.
    assert.deepEqual(await f.counts(), { leads: 1, receipts: 1, completions: 1, tombstones: 2 });
  });

  await t.test('rollback releases locks and a waiting identical deletion performs the real first commit', async t => {
    const f = await makeCase(fixture, observer, t);
    await f.a.query('begin'); await f.erase(f.a);
    const second = observed(f.erase(f.b));
    await f.blocked();
    assert.deepEqual(await f.counts(), { leads: 1, receipts: 2, completions: 0, tombstones: 0 });
    await f.a.query('rollback');
    assert.deepEqual((await second).value, { deleted: true, receiptsDeleted: 2, replayed: false });
    assert.deepEqual(await f.counts(), { leads: 0, receipts: 0, completions: 1, tombstones: 2 });
  });

  await t.test('concurrent lead edit is re-read after waiting and cannot be erased with a stale version', async t => {
    const f = await makeCase(fixture, observer, t);
    await f.a.query('begin');
    await f.a.query("update public.leads set updated_at=updated_at+interval '1 second' where id=$1", [f.lead.id]);
    const deletion = observed(f.erase(f.b));
    await f.blocked(); await f.a.query('commit');
    assert.equal((await deletion).error?.message, 'deletion_scope_changed');
    assert.deepEqual(await f.counts(), { leads: 1, receipts: 2, completions: 0, tombstones: 0 });
  });

  await t.test('concurrent clinical dependency is preserved and requires separate review', async t => {
    const f = await makeCase(fixture, observer, t);
    await f.a.query('begin');
    await f.a.query("insert into public.deals(workspace_id,lead_id,title) values($1,$2,'Fixture pending sale')", [f.workspace, f.lead.id]);
    const deletion = observed(f.erase(f.b));
    await f.blocked(); await f.a.query('commit');
    assert.equal((await deletion).error?.message, 'deletion_requires_review');
    assert.deepEqual(await f.counts(), { leads: 1, receipts: 2, completions: 0, tombstones: 0 });
    assert.equal((await row(observer, 'select count(*)::int as n from public.deals where lead_id=$1', [f.lead.id])).n, 1);
  });

  await t.test('bounded lock timeout leaves every copy intact', async t => {
    const f = await makeCase(fixture, observer, t);
    await f.a.query('begin');
    await f.a.query('select id from public.crm_intake_sites where id=$1 for update', [f.site]);
    const deletion = observed(f.erase(f.b));
    await f.blocked();
    assert.equal((await deletion).error?.code, '55P03');
    await f.a.query('rollback');
    assert.deepEqual(await f.counts(), { leads: 1, receipts: 2, completions: 0, tombstones: 0 });
  });

  await t.test('a locked site does not block a different workspace intake', async t => {
    const f = await makeCase(fixture, observer, t);
    const other = await makeCase(fixture, observer, t);
    await f.a.query('begin');
    await f.a.query('select id from public.crm_intake_sites where id=$1 for update', [f.site]);
    await other.b.query("set statement_timeout='1500ms'");
    await other.submit(other.b);
    assert.deepEqual(await other.counts(), { leads: 1, receipts: 3, completions: 0, tombstones: 0 });
    assert.deepEqual(await f.counts(), { leads: 1, receipts: 2, completions: 0, tombstones: 0 });
    await f.a.query('rollback');
  });
});
