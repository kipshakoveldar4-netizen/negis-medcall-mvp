import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {one,report,seedClock,exactPeriod} from './mortgage-report-clock-cases.mjs';

export const timezoneReport=async(db,kind,actor,days=30)=>kind==='team'
  ? (await one(db,'select public.read_lead_team_analytics($1,$2,$3,$4) as report',[actor.w,actor.id,actor.auth,days])).report
  : report(db,kind,actor,days);
const rollback=async(db,fn)=>{await db.query('begin');try{return await fn();}finally{await db.query('rollback');}};
async function denied(db,fn,code) {
  await db.query('savepoint denied_timezone');
  try {await assert.rejects(fn,error=>error.code===code);}
  finally {await db.query('rollback to savepoint denied_timezone');}
}
export async function exerciseAnalyticsTimezone(db,t) {
  for(const zone of ['UTC','Asia/Almaty','America/New_York','Pacific/Chatham']) {
    let passed=false;
    await t.test(`104 all three reports return their authoritative workspace zone ${zone}`,async()=>rollback(db,async()=>{
      const actor=await seedClock(db);
      await db.query("update workspace_settings set value=jsonb_build_object('timeZone',$2::text) where workspace_id=$1 and key='clinic_schedule'",[actor.w,zone]);
      await db.query("set local timezone='Europe/Berlin';set local role service_role");
      for(const kind of ['team','results','workspace']) {
        const r=await timezoneReport(db,kind,actor);assert.equal(r.timeZone,zone);await exactPeriod(db,r,30);
      }passed=true;
    }));assert.ok(passed,'Stop after an invalid report timezone');
  }
  await t.test('104 missing/malformed zones fail after authorization without exposing report data',async()=>rollback(db,async()=>{
    const actor=await seedClock(db);
    for(const value of [{},null,[],{timeZone:null},{timeZone:42},{timeZone:''},{timeZone:' UTC '},{timeZone:'Invalid/Zone'}]) {
      await db.query("update workspace_settings set value=$2::jsonb where workspace_id=$1 and key='clinic_schedule'",[actor.w,JSON.stringify(value)]);
      await db.query('set local role service_role');
      for(const kind of ['team','results','workspace']) {
        await denied(db,()=>timezoneReport(db,kind,actor),'P7008');
        await denied(db,()=>timezoneReport(db,kind,{...actor,auth:randomUUID()}),'P7001');
      }await db.query('reset role');
    }
  }));
  await t.test('104 manager cannot read team/results or foreign workspace metadata',async()=>rollback(db,async()=>{
    const actor=await seedClock(db,'lead_manager'),foreign=await seedClock(db);
    await db.query('set local role service_role');
    for(const kind of ['team','results']) await denied(db,()=>timezoneReport(db,kind,actor),'P7001');
    for(const kind of ['team','results','workspace']) await denied(db,()=>timezoneReport(db,kind,{...actor,w:foreign.w}),'P7001');
    assert.equal((await timezoneReport(db,'workspace',actor)).timeZone,'Asia/Almaty');
  }));
}
export async function exerciseAnalyticsTimezoneRefusals(db,source,t) {
  const signatures=['public.read_lead_team_analytics(uuid,uuid,uuid,integer)','public.read_mortgage_results(uuid,uuid,uuid,integer)'];
  const snapshot=async()=> (await db.query('select pg_get_functiondef(p.oid) as body,p.proacl::text as acl from pg_proc p where p.oid in ($1::regprocedure,$2::regprocedure) order by p.oid',signatures)).rows;
  for(const [name,change,message] of [
    ['volatility',`alter function ${signatures[0]} stable`,'analytics_timezone_dependencies_unconfirmed'],
    ['owner',`alter function ${signatures[1]} owner to service_role`,'analytics_timezone_dependencies_unconfirmed'],
    ['search path',`alter function ${signatures[1]} set search_path=public`,'analytics_timezone_dependencies_unconfirmed'],
    ['browser grant',`grant execute on function ${signatures[0]} to anon`,'analytics_timezone_acl_unconfirmed'],
    ['server grant revoked',`revoke execute on function ${signatures[1]} from service_role`,'analytics_timezone_acl_unconfirmed'],
  ]) {
    let passed=false;
    await t.test(`104 refuses ${name} baseline without partially replacing reports`,async()=>{
      const before=await snapshot();await db.query('begin');
      try {await db.query(change);await assert.rejects(db.query(source),e=>e.message===message);}
      finally {await db.query('rollback');}
      assert.deepEqual(await snapshot(),before);passed=true;
    });assert.ok(passed,'Stop after a failed timezone migration refusal');
  }
  await t.test('104 reapply preserves definitions and closed browser/server grants',async()=>{
    const before=await snapshot();await db.query(source);assert.deepEqual(await snapshot(),before);
    for(const signature of signatures)for(const role of ['anon','authenticated','service_role']) {
      assert.equal((await one(db,'select has_function_privilege($1,$2,\'EXECUTE\') as yes',[role,signature])).yes,role==='service_role');
    }
  });
}
