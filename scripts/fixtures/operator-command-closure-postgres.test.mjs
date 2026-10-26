import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { inspectMigration,migrationReview } from './migration-chain-review.mjs';
import { exerciseOperatorCommandClosure } from './operator-command-closure-cases.mjs';

const directory=new URL('../../migrations/',import.meta.url),candidate=await readFile(new URL('108_operator_command_closure.sql',directory),'utf8');
const evidence=inspectMigration(candidate);assert.equal(evidence.functions.length,6);assert.equal(evidence.dynamicSqlLines.length,0);
test('108 keyed operator command closure/admission on owned PostgreSQL',{timeout:360000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Explicit native opt-in only');
  const fixture=await startNativePostgres();
  try{
    const db=await fixture.connect();await db.query('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to anon,authenticated,service_role');
    await t.test('missing 107 refuses atomically',async()=>{
      await assert.rejects(db.query(candidate),e=>e.message==='operator_command_closure_dependencies_unconfirmed');await db.query('rollback');
      assert.equal((await db.query("select to_regclass('public.growth_operator_command_fences') f")).rows[0].f,null);
    });
    for(const name of ['009_medcall_mvp_persistence.sql','010_staff_ready_crm.sql','011_staff_auth_foundation.sql','023_public_privilege_hardening.sql',
      '029_audit_logs_change_journal.sql','034_platform_subscriptions.sql','052_operators_and_partner_ledger.sql','053_operator_request_lifecycle.sql',
      '054_operator_lead_access.sql','094_operator_request_concurrency.sql','096_operator_request_actor_mutations.sql','099_application_function_default_access.sql','107_operator_request_commands.sql']){
      const s=await readFile(new URL(name,directory),'utf8');assert.equal(createHash('sha256').update(s).digest('hex'),migrationReview[name]);await db.query(s);
    }
    await t.test('an incompatible fence table is refused without changing it',async()=>{
      await db.query('create table public.growth_operator_command_fences(command_id uuid primary key,owned_marker text)');
      try{await assert.rejects(db.query(candidate),e=>e.message==='operator_command_closure_shape_unconfirmed');await db.query('rollback');}
      finally{await db.query('drop table public.growth_operator_command_fences');}
    });
    await t.test('inherited old executor permission causes atomic refusal rather than a bypass',async()=>{
      await db.query('create role owned_legacy_operator;grant execute on function public.transition_growth_operator_request(uuid,uuid,text) to owned_legacy_operator;grant owned_legacy_operator to service_role');
      try{await assert.rejects(db.query(candidate),e=>e.message==='operator_command_closure_executor_unconfirmed');await db.query('rollback');}
      finally{await db.query('revoke owned_legacy_operator from service_role;revoke all on function public.transition_growth_operator_request(uuid,uuid,text) from owned_legacy_operator;drop role owned_legacy_operator');}
      assert.equal((await db.query("select to_regclass('public.growth_operator_command_fences') f")).rows[0].f,null);
    });
    await db.query(candidate);await exerciseOperatorCommandClosure(db,fixture,candidate,t);
    t.diagnostic(`108 SHA-256 ${createHash('sha256').update(candidate).digest('hex')}; native SQL only, no actual HTTP/Auth/cloud claim`);
  }finally{await fixture.close();}
});
