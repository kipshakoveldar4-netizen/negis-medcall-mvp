import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const workspaceSignature='public.read_mortgage_workspace(uuid,uuid,uuid,text,integer,uuid,timestamp with time zone,timestamp with time zone,integer)';
export const resultsSignature='public.read_mortgage_results(uuid,uuid,uuid,integer)';
export const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
export const report=async(db,kind,actor,days=30)=>(await one(db,kind==='workspace'
  ? "select public.read_mortgage_workspace($1,$2,$3,'',0,null,null,null,$4) as report"
  : 'select public.read_mortgage_results($1,$2,$3,$4) as report',[actor.w,actor.id,actor.auth,days])).report;
export async function seedClock(db,role='owner') {
  const actor={w:randomUUID(),id:randomUUID(),auth:randomUUID()};
  await db.query("insert into workspaces(id,name) values($1,'Owned mortgage clock fixture')",[actor.w]);
  await db.query(`insert into workspace_settings(workspace_id,key,value) values
    ($1,'workspace_purpose','{"purpose":"mortgage_leads"}'),($1,'clinic_schedule','{"timeZone":"Asia/Almaty"}')`,[actor.w]);
  await db.query(`insert into staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
    values($1,$2,$3,$4,'Owned clock member',$5,'active')`,[actor.id,actor.w,actor.auth,`${actor.id}@example.invalid`,role]);
  return actor;
}
export async function exactPeriod(db,value,days) {
  assert.equal(value.period.days,days);
  assert.equal(value.generatedAt,value.period.to);
  assert.deepEqual(await one(db,`select $1::timestamptz=$2::timestamptz as same,
    $2::timestamptz-$3::timestamptz=$4::integer*interval '24 hours' as exact`,
  [value.generatedAt,value.period.to,value.period.from,days]),{same:true,exact:true});
}
async function rollback(db,action) {
  await db.query('begin');
  try {return await action();} finally {await db.query('rollback');}
}
async function denied(db,action,code) {
  await db.query('savepoint denied_report');
  try {await assert.rejects(action,error=>error.code===code);}
  finally {await db.query('rollback to savepoint denied_report');}
}

// Actual source functions, reused after the full raw chain. Every synthetic row
// and SET LOCAL ROLE/TIME ZONE is rolled back, without mutating business history.
export async function exerciseMortgageReportClock(db,t) {
  for(const zone of ['UTC','Asia/Almaty','Europe/Berlin','America/New_York']) {
    let passed=false;
    await t.test(`103 exact 7/30/90 elapsed-day periods with SQL session zone ${zone}`,async()=>rollback(db,async()=>{
      const actor=await seedClock(db);
      await db.query("select set_config('TimeZone',$1,true)",[zone]);
      await db.query('set local role service_role');
      for(const kind of ['workspace','results']) for(const days of [7,30,90]) {
        const value=await report(db,kind,actor,days);await exactPeriod(db,value,days);
        if(kind==='workspace') assert.equal(value.timeZone,'Asia/Almaty');
      }
      // A fixed DST transition makes the old calendar-day mismatch deterministic,
      // independently of when the owned server happens to run this test.
      await db.query("select set_config('TimeZone','America/New_York',true)");
      assert.deepEqual(await one(db,`select
        '2026-03-31T14:00:00Z'::timestamptz-30*interval '24 hours'='2026-03-01T14:00:00Z'::timestamptz as elapsed,
        '2026-03-31T14:00:00Z'::timestamptz-make_interval(days=>30)='2026-03-01T15:00:00Z'::timestamptz as old_calendar`),
      {elapsed:true,old_calendar:true});
      passed=true;
    }));assert.ok(passed,'Stop after an inexact report period');
  }
  await t.test('103 preserves role/identity denials and private report EXECUTE',async()=>rollback(db,async()=>{
    const owner=await seedClock(db),manager=await seedClock(db,'lead_manager');
    for(const signature of [workspaceSignature,resultsSignature]) for(const role of ['anon','authenticated','service_role']) {
      assert.equal((await one(db,'select has_function_privilege($1,$2,\'EXECUTE\') as allowed',[role,signature])).allowed,role==='service_role');
    }
    await db.query('set local role service_role');
    for(const kind of ['workspace','results']) {
      await denied(db,()=>report(db,kind,{...owner,auth:randomUUID()}),'P7001');
      await denied(db,()=>report(db,kind,{...owner,w:manager.w}),'P7001');
      for(const days of [null,0,14,365]) await denied(db,()=>report(db,kind,owner,days),kind==='workspace'?'P7003':'P7803');
    }
    await denied(db,()=>report(db,'results',manager),'P7001');
    const own=await report(db,'workspace',manager);assert.deepEqual(own.memberMetrics,[]);
  }));
}

export async function exerciseReportClockRefusals(db,source,t) {
  const snapshot=async()=> (await db.query(`select p.oid::regprocedure::text as name,pg_get_functiondef(p.oid) as definition,
    p.proacl::text as acl from pg_proc p where p.oid in ($1::regprocedure,$2::regprocedure,$3::regprocedure) order by p.oid`,
  [workspaceSignature,resultsSignature,'public.mortgage_actor_role(uuid,uuid,uuid)'])).rows;
  for(const [name,change,message] of [
    ['changed workspace volatility',`alter function ${workspaceSignature} stable`,'mortgage_report_clock_dependencies_unconfirmed'],
    ['changed authorization body',"create or replace function public.mortgage_actor_role(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid) returns text language plpgsql security definer set search_path='' as $$begin return 'owner';end$$",'mortgage_report_clock_dependencies_unconfirmed'],
    ['changed results search path',`alter function ${resultsSignature} set search_path=public`,'mortgage_report_clock_dependencies_unconfirmed'],
    ['changed owner',`alter function ${resultsSignature} owner to service_role`,'mortgage_report_clock_dependencies_unconfirmed'],
    ['browser report execution',`grant execute on function ${resultsSignature} to authenticated`,'mortgage_report_clock_acl_unconfirmed'],
    ['missing server execution',`revoke execute on function ${workspaceSignature} from service_role`,'mortgage_report_clock_acl_unconfirmed'],
  ]) {
    let passed=false;
    await t.test(`103 refuses ${name} without a partial replacement`,async()=>{
      const before=await snapshot();await db.query('begin');
      try {
        await db.query(change);
        await assert.rejects(db.query(source),error=>error.message===message);
      } finally {await db.query('rollback');}
      assert.deepEqual(await snapshot(),before);passed=true;
    });assert.ok(passed,'Stop after a failed report migration refusal');
  }
  await t.test('103 reapply preserves both exact definitions and grants',async()=>{
    const before=await snapshot();await db.query(source);assert.deepEqual(await snapshot(),before);
  });
}
