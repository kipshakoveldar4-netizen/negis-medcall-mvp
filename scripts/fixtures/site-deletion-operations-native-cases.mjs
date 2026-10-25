import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {deletionOperation,seedDeletionOperation} from './site-deletion-operations-cases.mjs';
import {legacyCrmRlsSnapshot} from './legacy-crm-rls-cases.mjs';

const one=async(db,sql,args=[]) => (await db.query(sql,args)).rows[0];
const observed=promise=>promise.then(value=>({value}),error=>({error}));
async function waiting(observer,pid) {
  const end=Date.now()+1000;
  while(Date.now()<end) {
    if((await one(observer,'select wait_event_type from pg_stat_activity where pid=$1',[pid]))?.wait_event_type==='Lock')return;
    await delay(5);
  }
  assert.fail('Exact owned operation must reach its real native lock wait');
}

// Receives only the already-attested owned fixture, never a DSN/env connection.
export async function proveDeletionOperationConcurrency(fixture,observer,t) {
  const lock=await fixture.connect(),first=await fixture.connect(),second=await fixture.connect();
  const firstPid=(await one(first,'select pg_backend_pid() as pid')).pid;
  const secondPid=(await one(second,'select pg_backend_pid() as pid')).pid;
  try {
    for(const mode of ['execute-first','abandon-first','read-after-execute','revocation']) {
      let passed=false;
      await t.test(`101 actual native concurrency: ${mode}`,async()=>{
        const baseline=await legacyCrmRlsSnapshot(observer),owned=[],tasks=[];
        try {
          await observer.query('begin');const f=await seedDeletionOperation(observer);owned.push(f.workspace,f.otherWorkspace);await observer.query('commit');
          await deletionOperation(observer,'prepare',f);
          await lock.query('begin');
          if(mode==='revocation') await lock.query('select id from public.staff_users where id=$1 for update',[f.staff]);
          else await lock.query('select id from public.crm_intake_sites where id=$1 for update',[f.site]);
          const a=observed(deletionOperation(first,mode==='abandon-first'?'close':'execute',f,mode==='abandon-first'?{action:'abandon'}:undefined));tasks.push(a);
          await waiting(observer,firstPid);
          if(mode==='revocation') {
            await lock.query("update public.staff_users set status='inactive' where id=$1",[f.staff]);await lock.query('commit');
            assert.equal((await a).error?.message,'workspace_access_denied');
            await observer.query("update public.staff_users set status='active' where id=$1",[f.staff]);
            assert.equal((await deletionOperation(observer,'read',f)).operations[0].state,'prepared');
            assert.equal((await one(observer,'select count(*)::int as n from public.leads where workspace_id=$1',[f.workspace])).n,1);
          } else {
            const b=observed(deletionOperation(second,mode==='abandon-first'?'execute':mode==='read-after-execute'?'read':'close',f,
              mode==='execute-first'?{action:'abandon'}:undefined));tasks.push(b);await waiting(observer,secondPid);
            // Another tenant's real preparation completes while A is held.
            await observer.query('begin');const other=await seedDeletionOperation(observer);owned.push(other.workspace,other.otherWorkspace);await observer.query('commit');
            assert.equal((await deletionOperation(observer,'prepare',other)).state,'prepared');
            await lock.query('commit');const av=await a,bv=await b;
            assert.equal(av.error,undefined,av.error?.message);
            if(mode==='abandon-first') {
              assert.equal(av.value.state,'abandoned');assert.equal(bv.error?.message,'deletion_operation_abandoned');
              assert.equal((await one(observer,'select count(*)::int as n from public.leads where workspace_id=$1',[f.workspace])).n,1);
              assert.equal((await one(observer,'select count(*)::int as n from public.crm_site_inquiry_deletions where workspace_id=$1',[f.workspace])).n,0);
            } else {
              assert.equal(av.value.state,'committed');assert.equal(bv.error,undefined,bv.error?.message);
              assert.equal(mode==='read-after-execute'?bv.value.operations[0].state:bv.value.state,'committed');
              assert.equal((await one(observer,'select count(*)::int as n from public.crm_site_inquiry_deletions where workspace_id=$1',[f.workspace])).n,1);
              assert.equal((await one(observer,'select count(*)::int as n from public.leads where workspace_id=$1',[f.workspace])).n,0);
            }
          }
        } finally {
          await lock.query('rollback');await Promise.all(tasks);await observer.query('rollback');
          if(owned.length) await observer.query('delete from public.workspaces where id=any($1::uuid[])',[owned]);
        }
        assert.deepEqual(await legacyCrmRlsSnapshot(observer),baseline,'Only owned synthetic rows may be added and all must be removed');
        passed=true;
      });
      assert.ok(passed,'Do not accept later native scenarios after failed operation concurrency');
    }
  } finally {await lock.end();await first.end();await second.end();}
}
