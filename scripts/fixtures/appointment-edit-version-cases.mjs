import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const zero='00000000-0000-0000-0000-000000000000';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
async function rollback(db,action){await db.query('begin');try{return await action();}finally{await db.query('rollback');}}
const read=(db,id)=>one(db,'select to_jsonb(a) value,ctid::text tid,xmin::text transaction,pg_relation_filenode(\'appointments\')::text file from appointments a where id=$1',[id]);

export async function prepareAppointmentEditVersion(db,source,t){
  for(const change of [
    'grant update on appointments to service_role',
    'alter table appointments add column edit_version uuid',
    'alter function public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb) security invoker',
    "create function public.owned_edit_probe() returns trigger language plpgsql as $$begin return new;end $$;create trigger owned_edit_probe before update on appointments for each row execute function public.owned_edit_probe()",
  ])await t.test('117 refuses an unreviewed baseline atomically: '+change,()=>rollback(db,async()=>{
    await db.query(change);await assert.rejects(()=>db.query(source),error=>['appointment_edit_version_dependencies_unconfirmed','appointment_edit_version_already_installed_requires_review'].includes(error.message));
  }));
  assert.equal((await one(db,"select count(*)::int n from pg_attribute where attrelid='appointments'::regclass and attname='edit_version' and not attisdropped")).n,0);
  const workspace=randomUUID(),id=randomUUID();
  await db.query("insert into workspaces(id,name) values($1,'Owned pre-version row')",[workspace]);
  await db.query("insert into appointments(id,workspace_id,client_name,notes,status,starts_at,updated_at) values($1,$2,'Owned old client','Owned unchanged note','cancelled','2026-10-20T08:00:00.123456Z','2026-10-20T08:00:00.654321Z')",[id,workspace]);
  const before=await read(db,id);
  return async()=>{
    try{await t.test('117 fast default preserves the old tuple, xmin, file and every previous field',async()=>{
      const after=await read(db,id);assert.equal(after.value.edit_version,zero);
      delete after.value.edit_version;assert.deepEqual(after,before);
    });}finally{await db.query('delete from workspaces where id=$1',[workspace]);}
  };
}

export async function exerciseAppointmentEditVersion(db,source,t){
  await t.test('117 every insert gets an independent version and every update rotates it without a timestamp clock',()=>rollback(db,async()=>{
    const workspace=randomUUID();await db.query("insert into workspaces(id,name) values($1,'Owned edit version')",[workspace]);
    const rows=(await db.query("insert into appointments(workspace_id,status,notes) values($1,'cancelled','Owned note'),($1,'cancelled','Owned note') returning id,edit_version,updated_at",[workspace])).rows;
    assert.notEqual(rows[0].edit_version,zero);assert.notEqual(rows[0].edit_version,rows[1].edit_version);
    const first=await one(db,"update appointments set notes='Owned changed note' where id=$1 returning edit_version,updated_at",[rows[0].id]);
    assert.notEqual(first.edit_version,rows[0].edit_version);assert.deepEqual(first.updated_at,rows[0].updated_at);
    const second=await one(db,'update appointments set notes=notes,edit_version=$2 where id=$1 returning edit_version',[rows[0].id,rows[0].edit_version]);
    assert.notEqual(second.edit_version,first.edit_version);assert.notEqual(second.edit_version,rows[0].edit_version,'A caller cannot reset the token');
  }));
  for(const role of ['anon','authenticated','service_role'])await t.test('117 trigger is not a callable '+role+' API',async()=>{
    await db.query('set role '+role);try{await assert.rejects(()=>db.query('select public.stamp_appointment_edit_version()'),error=>error.code==='42501');}
    finally{await db.query('reset role');}
  });
  await t.test('117 exact rerun refuses review without replacing the installed trigger or UUID default',()=>rollback(db,async()=>{
    await assert.rejects(()=>db.query(source),error=>error.message==='appointment_edit_version_already_installed_requires_review');
  }));
}
