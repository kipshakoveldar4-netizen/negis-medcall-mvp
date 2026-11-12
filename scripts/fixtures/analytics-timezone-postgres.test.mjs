import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {startNativePostgres} from './native-postgres.mjs';
import {one,seedClock,exactPeriod} from './mortgage-report-clock-cases.mjs';
import {timezoneReport,exerciseAnalyticsTimezone,exerciseAnalyticsTimezoneRefusals} from './analytics-timezone-cases.mjs';
const directory=new URL('../../migrations/',import.meta.url);
const observed=p=>p.then(value=>({value}),error=>({error}));

test('104 report-owned timezone on attested disposable PostgreSQL',{timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1');
  const fixture=await startNativePostgres();t.after(()=>fixture.close());const db=await fixture.connect();
  await db.query('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to anon,authenticated,service_role');
  const numbers=new Set([9,10,11,13,14,19,28,29,38,69,70,78,83,95,103]);
  for(const file of (await readdir(directory)).sort()) if(numbers.has(Number(file.slice(0,3)))) await db.query(await readFile(new URL(file,directory),'utf8'));
  await t.test('before 104, both current child report functions omit the workspace timezone',async()=>{
    const actor=await seedClock(db);
    for(const kind of ['team','results']) assert.equal(Object.hasOwn(await timezoneReport(db,kind,actor),'timeZone'),false);
  });
  const source=await readFile(new URL('104_analytics_report_timezone.sql',directory),'utf8');
  await db.query(source);await exerciseAnalyticsTimezoneRefusals(db,source,t);await exerciseAnalyticsTimezone(db,t);
  for(const kind of ['team','results'])for(const role of ['owner','admin']) await t.test(`104 ${kind}/${role} captures the zone and clock after a real zone-row lock wait`,async()=>{
    const actor=await seedClock(db,role),holder=await fixture.connect(),waiter=await fixture.connect();let pending;
    try {
      const hp=(await one(holder,'select pg_backend_pid() as pid')).pid,wp=(await one(waiter,'select pg_backend_pid() as pid')).pid;
      await holder.query('begin');await holder.query("update workspace_settings set value=$2::jsonb where workspace_id=$1 and key='clinic_schedule'",[actor.w,JSON.stringify({timeZone:'UTC'})]);
      await waiter.query('set role service_role');pending=observed(timezoneReport(waiter,kind,actor));
      let blocked;
      for(let i=0;i<250;i++) {
        const state=await one(db,'select pg_blocking_pids(pid) as blockers,query_start::text as started from pg_stat_activity where pid=$1',[wp]);
        if(state?.blockers.includes(hp)){blocked=state;break;}await delay(10);
      }assert.ok(blocked,'Require a real PostgreSQL wait, not elapsed time alone');
      const after=(await one(holder,'select clock_timestamp()::text as at')).at;await holder.query('commit');
      const r=await pending;if(r.error)throw r.error;assert.equal(r.value.timeZone,'UTC');await exactPeriod(db,r.value,30);
      assert.deepEqual(await one(db,'select $1::timestamptz>$2::timestamptz as fresh,$1::timestamptz>=$3::timestamptz as after_zone',
        [r.value.generatedAt,blocked.started,after]),{fresh:true,after_zone:true});
    } finally {await holder.query('rollback').catch(()=>{});if(pending)await pending;await holder.end();await waiter.end();}
  });
  t.diagnostic('Owned loopback SQL only; no real workspace settings, authentication, providers or expenses.');
});
