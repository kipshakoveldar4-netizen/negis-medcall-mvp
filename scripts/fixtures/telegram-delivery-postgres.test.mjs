import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';
import { setupTelegramDatabase,telegramScenario,telegramSqlCases,readTelegramMigration,migrationName,hash } from './telegram-delivery-cases.mjs';

const observe=promise=>promise.then(value=>({value}),error=>({error}));
const adapter=client=>({query:(...args)=>client.query(...args),exec:sql=>client.query(sql)});
async function lockWait(observer,pid) {
  const end=Date.now()+4000;
  while(Date.now()<end) {
    const {rows}=await observer.query('select wait_event_type from pg_stat_activity where pid=$1',[pid]);
    if(rows[0]?.wait_event_type==='Lock')return;
    await delay(10);
  }
  assert.fail('The owned dispatcher did not reach an authoritative PostgreSQL lock wait');
}

test('097 actual PostgreSQL serialization: one dispatcher, live actor and bounded non-expiring receipts',{timeout:180000},async t=>{
  const fixture=await startDisposablePostgres();
  try {
    const admin=await fixture.connect(),one=await fixture.connect(),two=await fixture.connect(),db=adapter(admin);
    const pid=(await two.query('select pg_backend_pid() as pid')).rows[0].pid;
    const sql=await readTelegramMigration(migrationName);
    t.diagnostic(`PostgreSQL ${(await admin.query('show server_version')).rows[0].server_version}; no external database URL`);
    t.diagnostic(`097 SHA-256 ${createHash('sha256').update(sql).digest('hex')}`);
    await t.test('missing dependency refuses atomically before creating any ledger',async()=>{
      await assert.rejects(admin.query(sql),/telegram_delivery_dependencies_unconfirmed/);await admin.query('rollback');
      assert.equal((await admin.query("select to_regclass('public.content_telegram_deliveries') as value")).rows[0].value,null);
    });
    await setupTelegramDatabase(db,false,async()=>{
      await t.test('unreviewed inherited server table access refuses the migration atomically',async()=>{
        await admin.query('create role inherited_telegram_reader; grant inherited_telegram_reader to service_role');
        await admin.query('alter default privileges in schema public grant select on tables to inherited_telegram_reader');
        try{await assert.rejects(admin.query(sql),/telegram_delivery_server_acl_unconfirmed/);}
        finally{await admin.query('rollback');}
        assert.equal((await admin.query("select to_regclass('public.content_telegram_deliveries') as value")).rows[0].value,null);
        await admin.query('alter default privileges in schema public revoke select on tables from inherited_telegram_reader');
        await admin.query('revoke inherited_telegram_reader from service_role; drop role inherited_telegram_reader');
      });
    });
    await telegramSqlCases(t,db);
    await t.test('two transactions racing admission produce exactly one dispatcher',async()=>{
      const f=await telegramScenario(db);await one.query('begin');
      assert.equal((await f.admit({},one)).state,'admitted');
      const blocked=observe(f.admit({6:randomUUID()},two));
      await lockWait(admin,pid);await one.query('commit');
      assert.equal((await blocked).error?.code,'P9703');assert.equal((await f.state()).length,1);
    });
    await t.test('duplicate start of the same part cannot dispatch twice, even for the same nonce',async()=>{
      const f=await telegramScenario(db);await f.admit();await one.query('begin');
      await f.advance(0,null,{},one);
      const blocked=observe(f.advance(0,null,{},two));await lockWait(admin,pid);await one.query('commit');
      assert.equal((await blocked).error?.code,'P9703');assert.equal((await f.state())[0].in_flight,0);
    });
    await t.test('admission rechecks live actor after the workspace serialization wait',async()=>{
      const f=await telegramScenario(db);
      await admin.query('insert into public.content_telegram_delivery_guards(workspace_id) values($1)',[f.workspace]);
      await one.query('begin');await one.query('update public.content_telegram_delivery_guards set revision=revision+1 where workspace_id=$1',[f.workspace]);
      const blocked=observe(f.admit({},two));await lockWait(admin,pid);
      await admin.query("update public.staff_users set role='lead_manager' where id=$1",[f.staff]);await one.query('commit');
      assert.equal((await blocked).error?.code,'P9704');assert.equal((await f.state()).length,0);
    });
    await t.test('part start rechecks live actor after waiting on the delivery row',async()=>{
      const f=await telegramScenario(db);await f.admit();await one.query('begin');
      await one.query('select 1 from public.content_telegram_deliveries where workspace_id=$1 for update',[f.workspace]);
      const blocked=observe(f.advance(0,null,{},two));await lockWait(admin,pid);
      await admin.query("update public.staff_users set status='inactive' where id=$1",[f.staff]);await one.query('commit');
      assert.equal((await blocked).error?.code,'P9704');assert.equal((await f.state())[0].in_flight,null);
    });
    await t.test('an actor revoked while its staff row is locked never admits a dispatcher',async()=>{
      const f=await telegramScenario(db);await one.query('begin');
      await one.query("update public.staff_users set status='inactive' where id=$1",[f.staff]);
      const blocked=observe(f.admit({},two));await lockWait(admin,pid);await one.query('commit');
      assert.equal((await blocked).error?.code,'P9704');assert.equal((await f.state()).length,0);
    });
    await t.test('receipt ACK cannot clear uncertainty after concurrent actor revocation',async()=>{
      const f=await telegramScenario(db);await f.admit();await f.advance(0);await one.query('begin');
      await one.query('select 1 from public.content_telegram_deliveries where workspace_id=$1 for update',[f.workspace]);
      const blocked=observe(f.advance(0,hash('observed fake provider ACK'),{},two));await lockWait(admin,pid);
      await admin.query('update public.staff_users set auth_user_id=$2 where id=$1',[f.staff,randomUUID()]);await one.query('commit');
      assert.equal((await blocked).error?.code,'P9704');assert.equal((await f.state())[0].in_flight,0);
      assert.equal((await f.state())[0].status,'dispatching');
    });
    for(const isolation of ['repeatable read','serializable']) {
      await t.test(`${isolation} cannot authorize from an obsolete actor snapshot`,async()=>{
        const f=await telegramScenario(db);await two.query(`begin isolation level ${isolation}`);
        await two.query('select status from public.staff_users where id=$1',[f.staff]);
        await admin.query("update public.staff_users set status='inactive' where id=$1",[f.staff]);
        const result=await observe(f.admit({},two));await two.query('rollback');
        assert.ok(['40001','P9704'].includes(result.error?.code));assert.equal((await f.state()).length,0);
      });
    }
    await t.test('browser roles cannot invoke the admission or mutate/read delivery records',async()=>{
      const f=await telegramScenario(db);await f.admit();
      for(const role of ['anon','authenticated']) {
        await two.query(`set role ${role}`);
        try {
          await assert.rejects(two.query('select * from public.content_telegram_deliveries'),e=>e.code==='42501');
          await assert.rejects(f.admit({},two),e=>e.code==='42501');
        } finally {await two.query('reset role');}
      }
    });
    await t.test('a failed receipt write atomically preserves the prior in-flight fence',async()=>{
      const f=await telegramScenario(db);await f.admit();await f.advance(0);
      await admin.query(`alter table public.content_telegram_deliveries add constraint synthetic_receipt_write_refusal
        check(workspace_id<>'${f.workspace}'::uuid or jsonb_array_length(acknowledgements)=0) not valid`);
      await assert.rejects(f.advance(0,hash('fake ACK')),e=>e.code==='23514');
      await admin.query('alter table public.content_telegram_deliveries drop constraint synthetic_receipt_write_refusal');
      assert.equal((await f.state())[0].in_flight,0);assert.deepEqual((await f.state())[0].acknowledgements,[]);
      await assert.rejects(f.admit({6:randomUUID()}),e=>e.code==='P9703');
    });
  } finally {await fixture.close();}
});
