import assert from 'node:assert/strict';
import { readFile,readdir,mkdtemp,realpath,rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { appointmentActorReadinessQuery,buildAppointmentActorReadiness } from './appointment-actor-readiness.mjs';
import { appointmentReadinessQuery,buildAppointmentPreviewReadiness } from './appointment-preview-readiness.mjs';
import { exerciseAppointmentReadiness,exerciseAppointmentReadinessBeforeCutover,exerciseAppointmentPatchReadinessBeforeCutover,exerciseAppointmentVersionReadinessBeforeCutover,exerciseAppointmentEntryReadinessBeforeCutover,exerciseAppointmentJournalReadinessBeforeCutover } from './appointment-actor-readiness-cases.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
test('CLI writes only the current read-only gate and never replaces an existing output',async t=>{
  const cache=path.join(root,'node_modules/.cache'),folder=await mkdtemp(path.join(cache,'appointment-readiness-cli-'));
  t.after(async()=>{assert.equal(path.dirname(folder),cache);assert.equal(await realpath(folder),folder);await rm(folder,{recursive:true,force:true});});
  const output=path.join(folder,'read-only.sql'),env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(SystemRoot|WINDIR|COMSPEC|PATH|TEMP|TMP|PATHEXT)$/i.test(key)));
  const run=(...args)=>spawnSync(process.execPath,[path.join(root,'scripts/fixtures/appointment-preview-readiness.mjs'),...args],{env,encoding:'utf8'});
  assert.equal(run(output).status,0);assert.equal(await readFile(output,'utf8'),buildAppointmentActorReadiness());
  assert.notEqual(run(output).status,0);assert.equal(await readFile(output,'utf8'),buildAppointmentActorReadiness());
  assert.notEqual(run('relative.sql').status,0);assert.notEqual(run(output,'extra').status,0);
});

test('current appointment Preview metadata gate, synthetic WASM schema only',{timeout:120000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await t.test('default export and generator select v2, not the historical v1 contract',()=>{
    assert.equal(appointmentReadinessQuery,appointmentActorReadinessQuery);assert.equal(buildAppointmentPreviewReadiness(),buildAppointmentActorReadiness());
    const sql=buildAppointmentActorReadiness();assert.match(sql,/begin read only;/);assert.match(sql,/NOT end-to-end/);
    assert.doesNotMatch(sql,/\b(?:insert|update|delete|alter|grant|revoke|truncate|drop)\s+(?:into|from|table|on|all)/i);
    assert.doesNotMatch(sql,/select\s+\*|\bfrom\s+public\./i);assert.doesNotMatch(sql,/\b(?:http|dblink|pg_read_file|pg_sleep)\s*[.(]/i);
  });
  await t.test('an empty database returns blockers, not errors or a ready result',async()=>{
    const result=(await db.query(appointmentActorReadinessQuery)).rows;assert.equal(result.length,130);assert.ok(result.some(r=>!r.ready));
    assert.ok(result.some(r=>r.check_name==='receipt:shape:crm_appointment_request_actors'&&!r.ready));
  });
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  const numbers=new Set([9,10,11,12,13,14,19,20,29,30,32,33,34,35,36,40,43,45,52,53,54,55,56,57,61,63,64,72,73,76,102]);
  for(const file of (await readdir(path.join(root,'migrations'))).sort())if(numbers.has(Number(file.slice(0,3)))){
    const source=await readFile(path.join(root,'migrations',file),'utf8');
    await db.exec(Number(file.slice(0,3))===9?source.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i,''):source);
  }
  // Shared cases accept pg's query surface; exec handles multi-statement SQL in WASM.
  const adapter={async query(sql,args){return args?.length?db.query(sql,args):(await db.exec(sql)).at(-1)??{rows:[]};}};
  await exerciseAppointmentReadinessBeforeCutover(adapter,t);
  await db.exec(await readFile(path.join(root,'migrations/115_appointment_request_actor.sql'),'utf8'));
  await exerciseAppointmentPatchReadinessBeforeCutover(adapter,t);
  await db.exec(await readFile(path.join(root,'migrations/116_appointment_patch_actor.sql'),'utf8'));
  await exerciseAppointmentVersionReadinessBeforeCutover(adapter,t);
  await db.exec(await readFile(path.join(root,'migrations/117_appointment_edit_version.sql'),'utf8'));
  await exerciseAppointmentEntryReadinessBeforeCutover(adapter,t);
  await db.exec(await readFile(path.join(root,'migrations/118_appointment_version_entry.sql'),'utf8'));
  await exerciseAppointmentJournalReadinessBeforeCutover(adapter,t);
  await db.exec(await readFile(path.join(root,'migrations/119_appointment_patch_journal.sql'),'utf8'));
  await exerciseAppointmentReadiness(adapter,t);
});
