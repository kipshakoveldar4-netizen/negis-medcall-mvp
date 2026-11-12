import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = new URL('../../migrations/', import.meta.url);
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const callSql = 'select public.create_crm_sale_once($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::jsonb) as item';
const readSql = 'select public.read_crm_sale_create_request($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text) as item';

async function waitBlocked(observer, pid) {
  for (let i = 0; i < 100; i++) {
    if ((await observer.query('select cardinality(pg_blocking_pids($1))>0 as blocked', [pid])).rows[0].blocked) return;
    await delay(15);
  }
  assert.fail('a real PostgreSQL lock waiter was not observed');
}

test('manual sale receipts on isolated native PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  let db;
  try {
    db = await fixture.connect();
    await db.query('create role anon; create role authenticated; create role service_role bypassrls;');
    const numbers = new Set([9,10,11,12,13,14,19,20,23,32,33,34,36,40,43,45,55,61]);
    for (const name of (await readdir(root)).sort()) {
      if (numbers.has(Number(name.slice(0,3)))) await db.query(await readFile(new URL(name, root), 'utf8'));
    }
    await db.query(await readFile(new URL('076_crm_sale_create_requests.sql', root), 'utf8'));
    const workspace = randomUUID(), other = randomUUID(), staff = randomUUID(), auth = randomUUID();
    await db.query('insert into public.workspaces(id,name) values($1,$3),($2,$3)', [workspace, other, 'Synthetic sale concurrency']);
    await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
      values($1,$2,$3,'sale-native@example.invalid','Synthetic administrator','admin','active')`, [staff,workspace,auth]);
    const otherBefore = (await db.query('select to_jsonb(w) as item from public.workspaces w where id=$1', [other])).rows[0].item;
    const payload = {workspace_id:workspace,title:'Synthetic pending sale',amount_minor:700050,currency:'KZT',status:'pending'};
    const args = (key = randomUUID(), fingerprint = 'a'.repeat(64)) => [workspace,staff,auth,key,fingerprint,JSON.stringify(payload)];
    const counts = async () => (await db.query(`select
      (select count(*)::int from public.deals where workspace_id=$1) as sales,
      (select count(*)::int from public.crm_sale_create_requests where workspace_id=$1) as receipts,
      (select count(*)::int from public.deals where status='paid' or paid_at is not null) as paid`, [workspace])).rows[0];

    await t.test('two empty reads converge on one committed sale and one receipt', async () => {
      const a = await fixture.connect(), b = await fixture.connect();
      const request = args();
      try {
        await a.query('begin; set local role service_role');
        await b.query('begin; set local role service_role');
        for (const client of [a,b]) assert.equal((await client.query(readSql, request.slice(0,5))).rows[0].item, null);
        const saved = (await a.query(callSql, request)).rows[0].item;
        assert.equal(saved.replayed, false);
        const pid = (await b.query('select pg_backend_pid() as id')).rows[0].id;
        const pending = observed(b.query(callSql, request));
        await waitBlocked(db,pid);
        await a.query('commit');
        const second = await pending;
        assert.ifError(second.error);
        assert.deepEqual(second.value.rows[0].item, {sale:saved.sale,replayed:true});
        await b.query('commit');
        assert.deepEqual(await counts(), {sales:1,receipts:1,paid:0});
        assert.deepEqual((await db.query('select to_jsonb(d) as item from public.deals d where id=$1', [saved.sale.id])).rows[0].item, saved.sale);
      } finally { await a.query('rollback'); await b.query('rollback'); await a.end(); await b.end(); }
    });
    await t.test('same-key changed intent waits then conflicts, while new intent remains allowed', async () => {
      const a = await fixture.connect(), b = await fixture.connect();
      const request = args();
      try {
        await a.query('begin; set local role service_role');
        await b.query('begin; set local role service_role');
        await a.query(callSql,request);
        const pid = (await b.query('select pg_backend_pid() as id')).rows[0].id;
        const pending = observed(b.query(callSql,[...request.slice(0,4),'b'.repeat(64),request[5]]));
        await waitBlocked(db,pid);
        await a.query('commit');
        assert.equal((await pending).error?.code,'P7602');
        await b.query('rollback');
        assert.deepEqual(await counts(),{sales:2,receipts:2,paid:0});
        await b.query('begin; set local role service_role');
        assert.equal((await b.query(callSql,args())).rows[0].item.replayed,false);
        await b.query('commit');
        assert.deepEqual(await counts(),{sales:3,receipts:3,paid:0});
      } finally { await a.query('rollback'); await b.query('rollback'); await a.end(); await b.end(); }
    });
    await t.test('revocation winning the row lock refuses the waiting create without domain writes', async () => {
      const revoker = await fixture.connect(), caller = await fixture.connect();
      const before = await counts();
      try {
        await revoker.query('begin');
        await revoker.query("update public.staff_users set status='inactive' where id=$1 and workspace_id=$2",[staff,workspace]);
        await caller.query('begin; set local role service_role');
        const pid = (await caller.query('select pg_backend_pid() as id')).rows[0].id;
        const pending = observed(caller.query(callSql,args()));
        await waitBlocked(db,pid);
        await revoker.query('commit');
        assert.equal((await pending).error?.code,'P7604');
        await caller.query('rollback');
        assert.deepEqual(await counts(),before);
      } finally { await revoker.query('rollback'); await caller.query('rollback'); await revoker.end(); await caller.end(); }
    });
    assert.deepEqual((await db.query('select to_jsonb(w) as item from public.workspaces w where id=$1',[other])).rows[0].item,otherBefore);
    assert.equal((await db.query('select count(*)::int as count from public.deals where workspace_id=$1',[other])).rows[0].count,0);
  } finally {
    if (db) await db.end();
    await fixture.close();
  }
});
