import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { diffForJournal }=createRequire(import.meta.url)('../../lib/crm/change-journal.ts');

const previous='public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb)';
const current='public.patch_crm_appointment_journaled(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb,jsonb)';
const sql='select public.patch_crm_appointment_journaled($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) value';
const one=async(db,statement,args=[])=>(await db.query(statement,args)).rows[0];
async function rollback(db,action){await db.query('begin');try{await action();}finally{await db.query('rollback');}}
async function role(db,name,action){await db.query('set role '+name);try{return await action();}finally{await db.query('reset role');}}
async function owned(db){
  const f=Object.fromEntries(['workspace','staff','actor','appointment'].map(key=>[key,randomUUID()]));
  await db.query("insert into workspaces(id,name) values($1,'Owned journal atomicity')",[f.workspace]);
  await db.query("insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role,status) values($1,$2,$3,'Owned editor',$4,'owner','active')",
    [f.staff,f.workspace,f.actor,f.staff+'@example.invalid']);
  await db.query("insert into appointments(id,workspace_id,status,notes,client_name,client_phone) values($1,$2,'cancelled','Owned private original note','Owned original patient','+77000000001')",[f.appointment,f.workspace]);
  f.read=async()=>(await one(db,'select to_jsonb(a) value from appointments a where id=$1',[f.appointment])).value;
  f.audits=async()=>(await db.query('select to_jsonb(a) value from audit_logs a where workspace_id=$1 order by created_at,id',[f.workspace])).rows.map(row=>row.value);
  f.before=await f.read();
  f.args=(patch,journal)=>[f.workspace,f.staff,f.actor,'owner',f.appointment,f.before.edit_version,JSON.stringify(f.before),JSON.stringify(patch),
    JSON.stringify(journal??{actorName:'owned@example.invalid',outsideSchedule:false,changes:diffForJournal('appointment',f.before,patch)})];
  f.patch=(patch,journal)=>role(db,'service_role',async()=>(await one(db,sql,f.args(patch,journal))).value);
  f.close=()=>db.query('delete from workspaces where id=$1',[f.workspace]);
  return f;
}

export async function exerciseAppointmentJournalBefore(db,source,t){
  await t.test('before 119 the two-statement legacy flow can commit a visit while the later audit refuses',async()=>{
    const f=await owned(db);try{
      const args=f.args({notes:'Owned legacy committed note'}).slice(0,8);
      await role(db,'service_role',async()=>{
        await db.query('select public.patch_crm_appointment_v2($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)',args);
        await assert.rejects(()=>db.query('insert into audit_logs(workspace_id,action) values($1,null)',[f.workspace]),error=>error.code==='23502');
      });
      assert.equal((await f.read()).notes,'Owned legacy committed note');assert.deepEqual(await f.audits(),[]);
    }finally{await f.close();}
  });
  for(const change of ['alter table audit_logs disable row level security','alter table audit_logs rename column actor_kind to owned_missing_kind',
    'grant select(metadata) on audit_logs to authenticated',
    "create function public.owned_audit_probe() returns trigger language plpgsql as $$begin return new;end$$;create trigger owned_audit_probe before insert on audit_logs for each row execute function public.owned_audit_probe()",
    'create role owned_old_journal_caller;grant execute on function '+previous+' to owned_old_journal_caller;grant owned_old_journal_caller to service_role',
  ])await t.test('119 refuses an incompatible journal or effective legacy grant: '+change,()=>rollback(db,async()=>{
    await db.query(change);await assert.rejects(()=>db.query(source),error=>['appointment_patch_journal_dependencies_unconfirmed','appointment_patch_journal_legacy_access_unconfirmed'].includes(error.message));
  }));
  assert.equal((await one(db,'select to_regprocedure($1) value',[current])).value,null);
}

export async function exerciseAppointmentJournal(db,source,t){
  for(const name of ['anon','authenticated','service_role'])await t.test('119 closes legacy service PATCH for '+name,()=>role(db,name,async()=>{
    await assert.rejects(()=>db.query('select public.patch_crm_appointment_v2($1,$2,$3,$4,$5,$6,$7,$8)',Array(8).fill(null)),error=>error.code==='42501');
  }));
  for(const name of ['anon','authenticated'])await t.test('119 current writer remains closed to '+name,()=>role(db,name,async()=>{
    await assert.rejects(()=>db.query(sql,Array(9).fill(null)),error=>error.code==='42501');
  }));
  const samples=[{notes:'Owned changed private note'},
    {status:'confirmed',service:'Owned technical service',starts_at:'2090-10-27T11:00:00Z',doctor_name:'Owned technical doctor'},
    {client_name:'Synthetic new patient',client_phone:'+77000000002'},
    {client_name:'\u{1f33b} Owned Unicode name'},
    {client_phone:'87000000001'}, // Same subscriber: no spurious journal event.
    {price_minor:12345}, // Not a newly classified journal field.
  ];
  for(const patch of samples)await t.test('119 stores the existing private diff exactly once: '+Object.keys(patch).join(','),async()=>{
    const f=await owned(db);try{
      const changes=diffForJournal('appointment',f.before,patch),saved=await f.patch(patch),rows=await f.audits();
      assert.notEqual(saved.edit_version,f.before.edit_version);assert.equal(rows.length,changes.length?1:0);
      if(rows.length){const row=rows[0];assert.deepEqual(row.metadata,{changes});assert.equal(row.actor_name,'owned@example.invalid');
        assert.equal(row.actor_staff_user_id,f.staff);assert.equal(row.actor_role,'owner');assert.equal(row.actor_kind,'manual');
        assert.equal(row.entity_type,'appointment');assert.equal(row.entity_id,f.appointment);assert.equal(row.action,'updated');
        assert.ok(!JSON.stringify(row.metadata).includes('Owned private original note'));
      }
      await assert.rejects(()=>f.patch(patch),error=>error.code==='P1164');assert.deepEqual(await f.audits(),rows,'Lost reply retry cannot duplicate audit');
    }finally{await f.close();}
  });
  const badJournals=[null,{}, {actorName:'owned',outsideSchedule:false,changes:{}},
    {actorName:'owned',outsideSchedule:false,changes:[{field:'notes',label:'Заметка',from:'PRIVATE',to:null}]},
    {actorName:'owned',outsideSchedule:false,changes:[{field:'client_phone',label:'Телефон',from:null,to:'+77000000001'}]},
    {actorName:'owned',outsideSchedule:false,changes:[{field:'notes',label:'Заметка',from:null,to:null,private:'secret'}]},
    {actorName:'owned',outsideSchedule:false,changes:Array(2).fill({field:'notes',label:'Заметка',from:null,to:null})},
    {actorName:'owned',outsideSchedule:false,changes:[{field:'status',label:'Wrong label',from:null,to:'confirmed'}]},
  ];
  for(const [index,journal] of badJournals.entries())await t.test('119 malformed/unmasked journal refuses before mutation '+index,async()=>{
    const f=await owned(db);try{
      const args=f.args({notes:'Owned refused note'});args[8]=JSON.stringify(journal);
      await role(db,'service_role',()=>assert.rejects(()=>db.query(sql,args),error=>error.code==='P1191'));
      assert.deepEqual(await f.read(),f.before);assert.deepEqual(await f.audits(),[]);
    }finally{await f.close();}
  });
  for(const mode of ['throw-first','throw-second','drop','mutate'])await t.test('119 '+mode+' audit failure rolls the visit, token and both events back',async()=>{
    const f=await owned(db);try{
      const behavior=mode==='throw-first'?"raise exception 'Owned audit failure'":mode==='throw-second'?"if new.action='updated' then raise exception 'Owned audit failure';end if;return new":mode==='drop'?'return null':"new.entity_id='owned_wrong_entity';return new";
      await db.query(`create function public.owned_journal_failure() returns trigger language plpgsql as $$begin ${behavior};end$$;
        create trigger owned_journal_failure before insert on audit_logs for each row execute function public.owned_journal_failure()`);
      const patch={notes:'Owned refused note'},journal={actorName:'owned@example.invalid',outsideSchedule:true,changes:diffForJournal('appointment',f.before,patch)};
      await assert.rejects(()=>f.patch(patch,journal),error=>['P0001','P1192'].includes(error.code));
      assert.deepEqual(await f.read(),f.before);assert.deepEqual(await f.audits(),[]);
    }finally{await db.query('drop trigger if exists owned_journal_failure on audit_logs;drop function if exists public.owned_journal_failure()');await f.close();}
  });
  await t.test('119 exact rerun refuses without reopening either entry',()=>rollback(db,async()=>{
    await assert.rejects(()=>db.query(source),error=>error.message==='appointment_patch_journal_dependencies_unconfirmed'||error.message==='appointment_patch_journal_already_installed_requires_review');
  }));
}
