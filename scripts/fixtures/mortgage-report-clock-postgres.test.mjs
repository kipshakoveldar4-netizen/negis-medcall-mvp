import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { one,report,seedClock,exactPeriod,exerciseMortgageReportClock,exerciseReportClockRefusals } from './mortgage-report-clock-cases.mjs';

const directory=new URL('../../migrations/',import.meta.url);
const observed=promise=>promise.then(value=>({value}),error=>({error}));
async function waitForLock(db,waiter,holder) {
  for(let i=0;i<250;i++) {
    const state=await one(db,'select pg_blocking_pids(pid) as blockers,query_start::text as started from pg_stat_activity where pid=$1',[waiter]);
    if(state?.blockers.includes(holder)) return state;
    await delay(10);
  }assert.fail('An actual owned PostgreSQL authorization lock wait is required');
}
async function delayed(fixture,db,actor,kind,days,gate='membership',change=null) {
  const holder=await fixture.connect(),waiter=await fixture.connect();let pending;
  try {
    const hp=(await one(holder,'select pg_backend_pid() as pid')).pid,wp=(await one(waiter,'select pg_backend_pid() as pid')).pid;
    await holder.query('begin');await waiter.query("set role service_role; set timezone='UTC'");
    if(gate==='membership') await holder.query('update staff_users set full_name=full_name where id=$1',[actor.id]);
    else await holder.query('update workspace_settings set value=value where workspace_id=$1 and key=$2',
      [actor.w,gate==='purpose'?'workspace_purpose':'clinic_schedule']);
    pending=observed(report(waiter,kind,actor,days));
    const {started}=await waitForLock(db,wp,hp);
    if(change) await change(holder);
    const times=await one(holder,"select ($1::timestamptz-$2::integer*interval '24 hours'+interval '1 microsecond')::text as old,clock_timestamp()::text as fresh",[started,days]);
    for(const at of [times.old,times.fresh,times.fresh]) {
      const lead=randomUUID(),activity=randomUUID();
      await holder.query("insert into leads(id,workspace_id,responsible_user_id,full_name) values($1,$2,$3,'Owned clock lead')",[lead,actor.w,actor.id]);
      await holder.query(`insert into mortgage_activities(id,workspace_id,lead_id,kind,title,status,starts_at,ends_at,created_by_staff_user_id)
        values($1,$2,$3,'meeting','Owned clock meeting','done',$4::timestamptz-interval '1 hour',$4,$5)`,[activity,actor.w,lead,times.fresh,actor.id]);
      await holder.query(`insert into mortgage_activity_events(workspace_id,activity_id,actor_staff_user_id,action,title,created_at)
        values($1,$2,$3,'done','Owned clock done',$4)`,[actor.w,activity,actor.id,at]);
      await holder.query(`insert into mortgage_signed_contracts(workspace_id,lead_id,signed_at,responsible_staff_user_id,recorded_by_staff_user_id)
        values($1,$2,$3,$4,$4)`,[actor.w,lead,at,actor.id]);
    }
    await holder.query('commit');return {...(await pending),started,...times};
  } finally {
    await holder.query('rollback').catch(()=>{});
    if(pending) await pending;
    await holder.end();await waiter.end();
  }
}
const member=(value,actor)=>value[Array.isArray(value.memberMetrics)?'memberMetrics':'members'].find(m=>(m.id??m.staffId)===actor.id);

test('103 mortgage reports use post-authorization exact elapsed periods on owned PG17.11',{timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1');
  const fixture=await startNativePostgres();t.after(()=>fixture.close());
  const db=await fixture.connect();
  await db.query('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to anon,authenticated,service_role');
  const numbers=new Set([9,10,11,13,14,19,28,29,38,69,70,78]);
  for(const file of (await readdir(directory)).sort()) if(numbers.has(Number(file.slice(0,3)))) await db.query(await readFile(new URL(file,directory),'utf8'));
  for(const kind of ['workspace','results']) {
    let reproduced=false;
    await t.test(`before 103, ${kind} reproduces stale cutoff despite visible post-lock rows`,async()=>{
      const actor=await seedClock(db);const r=await delayed(fixture,db,actor,kind,7);
      if(r.error) throw r.error;
      const own=member(r.value,actor);
      assert.equal(kind==='workspace'?own.doneMeetings:own.signedInPeriod,1);
      if(kind==='results') assert.equal(r.value.period.to,r.value.generatedAt);
      assert.equal(own.assignedLeads,3);
      reproduced=true;
    });assert.ok(reproduced,'Do not install 103 without the original timing failure');
  }
  const source=await readFile(new URL('103_mortgage_report_clock.sql',directory),'utf8');
  await db.query(source);await exerciseReportClockRefusals(db,source,t);
  await exerciseMortgageReportClock(db,t);
  for(const kind of ['workspace','results']) for(const role of ['owner','admin']) for(const days of [7,30,90]) {
    await t.test(`103 ${kind} ${role} ${days}d uses post-wait bounds at both access gates`,async()=>{
      for(const gate of ['membership','purpose']) {
        const actor=await seedClock(db,role),r=await delayed(fixture,db,actor,kind,days,gate);
        if(r.error) throw r.error;
        await exactPeriod(db,r.value,days);
        assert.deepEqual(await one(db,`select $1::timestamptz>$2::timestamptz as later,
          $1::timestamptz>=$3::timestamptz as includes_fresh,$4::timestamptz<$5::timestamptz as excludes_old`,
        [r.value.period.to,r.started,r.fresh,r.old,r.value.period.from]),{later:true,includes_fresh:true,excludes_old:true});
        const own=member(r.value,actor);assert.equal(kind==='workspace'?own.doneMeetings:own.signedInPeriod,2);
        assert.equal(own.assignedLeads,3);
        // The old contract predates its meeting: preserve the existing rule
        // that it must not count as a contract following a completed meeting.
        if(kind==='results') {assert.equal(own.heldLeads,3);assert.equal(own.signedLeads,3);assert.equal(own.heldSignedLeads,2);}
      }
    });
  }
  await t.test('103 workspace timezone lock wait precedes its report clock',async()=>{
    const actor=await seedClock(db),r=await delayed(fixture,db,actor,'workspace',30,'schedule');
    if(r.error) throw r.error;
    await exactPeriod(db,r.value,30);assert.equal(member(r.value,actor).doneMeetings,2);
  });
  await t.test('103 lead-manager own-lead wait precedes the clock and overdue-task cutoff',async()=>{
    const actor=await seedClock(db,'lead_manager'),lead=randomUUID();
    await db.query("insert into leads(id,workspace_id,responsible_user_id,full_name) values($1,$2,$3,'Owned lead wait')",[lead,actor.w,actor.id]);
    const holder=await fixture.connect(),waiter=await fixture.connect();let pending;
    try {
      const hp=(await one(holder,'select pg_backend_pid() as pid')).pid,wp=(await one(waiter,'select pg_backend_pid() as pid')).pid;
      await holder.query('begin');await holder.query('update leads set notes=notes where id=$1',[lead]);
      await waiter.query('set role service_role');pending=observed(report(waiter,'workspace',actor));
      const {started}=await waitForLock(db,wp,hp);
      const due=(await one(holder,'select clock_timestamp()::text as at')).at;
      await holder.query(`insert into mortgage_activities(workspace_id,lead_id,kind,title,status,due_at,created_by_staff_user_id)
        values($1,$2,'task','Owned after-wait due','open',$3,$4)`,[actor.w,lead,due,actor.id]);
      await holder.query('commit');const r=await pending;if(r.error) throw r.error;
      await exactPeriod(db,r.value,30);assert.equal(r.value.metrics.overdueTasks,1);assert.deepEqual(r.value.memberMetrics,[]);
      assert.deepEqual(await one(db,'select $1::timestamptz>$2::timestamptz as later,$1::timestamptz>=$3::timestamptz as after_due',
        [r.value.generatedAt,started,due]),{later:true,after_due:true});
    } finally {
      await holder.query('rollback').catch(()=>{});if(pending) await pending;await holder.end();await waiter.end();
    }
  });
  for(const kind of ['workspace','results']) for(const change of ['inactive','role','auth','purpose']) {
    await t.test(`103 ${kind} rejects ${change} changed during an actual authorization wait`,async()=>{
      const actor=await seedClock(db),gate=change==='purpose'?'purpose':'membership';
      const r=await delayed(fixture,db,actor,kind,30,gate,async holder=>{
        if(change==='purpose') await holder.query("update workspace_settings set value='{}' where workspace_id=$1 and key='workspace_purpose'",[actor.w]);
        else if(change==='inactive') await holder.query("update staff_users set status='inactive' where id=$1",[actor.id]);
        else if(change==='role') await holder.query("update staff_users set role='manager' where id=$1",[actor.id]);
        else await holder.query('update staff_users set auth_user_id=$1 where id=$2',[randomUUID(),actor.id]);
      });
      assert.equal(r.error?.code,'P7001');assert.equal(r.value,undefined);
    });
  }
  t.diagnostic('Only owned loopback PostgreSQL and synthetic records; no Auth/Storage/providers, actual contracts, payments or cloud database.');
});
