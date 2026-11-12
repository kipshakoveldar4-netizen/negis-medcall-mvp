import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { migrationReview, inspectMigration } from './migration-chain-review.mjs';
import { reproduceUnboundOperatorProposal, exerciseOperatorCommands, operatorCommandSignatures } from './operator-command-recovery-fixture.mjs';

const directory=new URL('../../migrations/',import.meta.url);
const candidate=await readFile(new URL('107_operator_request_commands.sql',directory),'utf8');
const evidence=inspectMigration(candidate);
assert.equal(evidence.functions.length,5);assert.equal(evidence.dynamicSqlLines.length,0);
assert.deepEqual(evidence.tables,['public.growth_operator_request_commands']);

test('107 durable operator request receipts on an owned PostgreSQL cluster',{timeout:360000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Explicit native opt-in; no DSN/install/container fallback');
  const fixture=await startNativePostgres();
  try{
    const db=await fixture.connect();
    await db.query('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to anon,authenticated,service_role');
    await t.test('missing 096 refuses atomically before creating command tables/functions',async()=>{
      await assert.rejects(db.query(candidate),e=>e.message==='operator_command_dependencies_unconfirmed');await db.query('rollback');
      assert.equal((await db.query("select to_regclass('public.growth_operator_request_commands') value")).rows[0].value,null);
    });
    for(const name of ['009_medcall_mvp_persistence.sql','010_staff_ready_crm.sql','011_staff_auth_foundation.sql',
      '023_public_privilege_hardening.sql','029_audit_logs_change_journal.sql','034_platform_subscriptions.sql',
      '052_operators_and_partner_ledger.sql','053_operator_request_lifecycle.sql','054_operator_lead_access.sql',
      '094_operator_request_concurrency.sql','096_operator_request_actor_mutations.sql','099_application_function_default_access.sql']){
      const source=await readFile(new URL(name,directory),'utf8');assert.equal(createHash('sha256').update(source).digest('hex'),migrationReview[name]);
      await db.query(source);
    }
    await reproduceUnboundOperatorProposal(db,t);
    await t.test('changed dependency security refuses before creating any public command RPC',async()=>{
      await db.query('alter function public.lock_clinic_operator_actor(uuid,uuid,uuid) security invoker');
      try{await assert.rejects(db.query(candidate),e=>e.message==='operator_command_dependencies_unconfirmed');await db.query('rollback');}
      finally{await db.query('alter function public.lock_clinic_operator_actor(uuid,uuid,uuid) security definer');}
      for(const signature of operatorCommandSignatures)assert.equal((await db.query('select to_regprocedure($1) value',[signature])).rows[0].value,null);
    });
    await t.test('inherited browser table grant rolls the migration back without partial schema',async()=>{
      await db.query('create role owned_command_reader;grant owned_command_reader to authenticated;alter default privileges in schema public grant select on tables to owned_command_reader');
      try{await assert.rejects(db.query(candidate),e=>e.message==='operator_command_direct_access_unconfirmed');await db.query('rollback');}
      finally{await db.query('alter default privileges in schema public revoke select on tables from owned_command_reader;revoke owned_command_reader from authenticated;drop role owned_command_reader');}
      assert.equal((await db.query("select to_regclass('public.growth_operator_request_commands') value")).rows[0].value,null);
    });
    await t.test('an incompatible existing receipt table is preserved and refuses atomically',async()=>{
      await db.query("create table public.growth_operator_request_commands(command_id uuid primary key,owned_marker text);insert into public.growth_operator_request_commands values(gen_random_uuid(),'Owned incompatible shape')");
      try{
        await assert.rejects(db.query(candidate),e=>e.message==='operator_command_receipt_shape_unconfirmed');await db.query('rollback');
        assert.equal((await db.query('select owned_marker from public.growth_operator_request_commands')).rows[0].owned_marker,'Owned incompatible shape');
        assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.growth_operator_request_commands'::regclass")).rows[0].relrowsecurity,false);
      }finally{await db.query('drop table public.growth_operator_request_commands');}
    });
    await db.query(candidate);
    await exerciseOperatorCommands(db,fixture,candidate,t);
    t.diagnostic(`107 SHA-256 ${createHash('sha256').update(candidate).digest('hex')}; native SQL only, no Auth/HTTP/provider/cloud acceptance`);
  }finally{await fixture.close();}
});
