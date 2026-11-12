import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {startNativePostgres} from './native-postgres.mjs';
import {readReviewedChain} from './migration-chain-review.mjs';
import {exerciseCreatorJobs,exerciseCreatorJobRefusals,reproduceUnfencedCreatorCommand} from './creator-job-cases.mjs';
import {exerciseCreatorClosure,exerciseCreatorClosureRefusals} from './creator-command-closure-cases.mjs';

test('creator workflow on owned native PostgreSQL, exact source chain and no remote service',{timeout:220000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Explicit owned native opt-in; no DSN/download/container fallback');
  const chain=await readReviewedChain(fileURLToPath(new URL('../../migrations/',import.meta.url)));
  const fixture=await startNativePostgres();t.after(()=>fixture.close());const db=await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
    alter table storage.objects enable row level security;`);
  const index=chain.findIndex(entry=>entry.file==='110_creator_job_workflow.sql');assert.ok(index>=0);
  const source=chain[index].source;
  await assert.rejects(db.query(source),e=>e.message==='creator_job_dependencies_unconfirmed');await db.query('rollback');
  for(const entry of chain.slice(0,index))await db.query(entry.source);
  await exerciseCreatorJobRefusals(db,source,t);await db.query(source);
  if(process.argv.includes('--unfenced-baseline')){await reproduceUnfencedCreatorCommand(db,t);return;}
  await exerciseCreatorJobs(db,fixture,source,t);
  for(const entry of chain.slice(index+1)){
    assert.equal(entry.file,'111_creator_command_closure.sql');
    await reproduceUnfencedCreatorCommand(db,t);await exerciseCreatorClosureRefusals(db,entry.source,t);
    await db.query(entry.source);await exerciseCreatorClosure(db,fixture,entry.source,t);
  }
  for(const {name} of (await db.query("select tablename name from pg_tables where schemaname='public'")).rows)
    assert.equal((await db.query('select count(*)::int n from public."'+name.replaceAll('"','""')+'"')).rows[0].n,0,name+': all owned fixture records removed');
});
