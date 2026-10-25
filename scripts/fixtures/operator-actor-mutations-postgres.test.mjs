import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const directory=new URL('../../migrations/',import.meta.url);
const candidate=await readFile(new URL('096_operator_request_actor_mutations.sql',directory),'utf8');
const row=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
const denied=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.message);return true;});
const signatures=[
  'public.create_clinic_operator_request(uuid,uuid,uuid,uuid,text,bigint,text)',
  'public.transition_clinic_operator_request(uuid,uuid,uuid,uuid,text)',
  'public.transition_growth_operator_request(uuid,uuid,text)',
];
async function blocked(observer,waiter,holder){
  for(let n=0;n<250;n++){
    if((await row(observer,'select $1::int=any(pg_blocking_pids($2::int)) as waiting',[holder,waiter])).waiting)return;
    await delay(10);
  }
  assert.fail('A real PostgreSQL lock wait was not observed');
}

test('096 real actor, database clock and concurrent operator mutations on owned PostgreSQL', {timeout:360000},async t=>{
  const f=await startDisposablePostgres();
  try{
    const db=await f.connect(),service=await f.connect();
    await db.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role');
    for(const name of ['009_medcall_mvp_persistence.sql','010_staff_ready_crm.sql','011_staff_auth_foundation.sql',
      '023_public_privilege_hardening.sql','029_audit_logs_change_journal.sql','034_platform_subscriptions.sql',
      '052_operators_and_partner_ledger.sql','053_operator_request_lifecycle.sql'])
      await db.query(await readFile(new URL(name,directory),'utf8'));
    await t.test('missing lead-scope dependency rolls back without partial RPCs',async()=>{
      try{await denied(db.query(candidate),'P0001');}finally{await db.query('rollback');}
      for(const signature of signatures)assert.equal((await row(db,'select to_regprocedure($1) as fn',[signature])).fn,null);
    });
    for(const name of ['054_operator_lead_access.sql','094_operator_request_concurrency.sql'])
      await db.query(await readFile(new URL(name,directory),'utf8'));
    // Existing CRM staff lookup/edit privileges. PostgreSQL row locking also
    // requires UPDATE: these reproduce the old invoker trigger, not new grants.
    await db.query('grant select,update on public.staff_users to service_role');
    await service.query('set role service_role');
    const seed=async()=>{
      const x=Object.fromEntries(['w','other','staff','auth','replacement','otherAuth','operator','operatorAuth','request'].map(k=>[k,randomUUID()]));
      await db.query("insert into public.workspaces(id,name) values($1,'Synthetic actor clinic'),($2,'Unrelated synthetic clinic')",[x.w,x.other]);
      for(const [id,auth] of [[x.staff,x.auth],[x.replacement,x.otherAuth]])
        await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,$4,'Synthetic actor','owner','active')",[id,x.w,auth,`${id}@example.invalid`]);
      await db.query("insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at) values($1,$2,'Synthetic operator','approved',true,$3,clock_timestamp())",[x.operator,x.operatorAuth,randomUUID()]);
      return x;
    };
    const legacyCreate=async x=>(await row(service,`insert into public.growth_operator_requests
      (id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,price_per_arrival_minor,currency,lead_scope)
      values($1,$2,$3,$4,'Synthetic technical agreement, no payment',0,'KZT','assigned') returning id`,[x.request,x.w,x.operator,x.staff])).id;
    await t.test('old clinic CAS can withdraw after its preflight employee was already revoked',async()=>{
      const x=await seed();await legacyCreate(x);
      await db.query("update public.staff_users set status='inactive' where id=$1",[x.staff]);
      const changed=await row(service,"update public.growth_operator_requests set status='declined' where id=$1 and workspace_id=$2 and status='requested' returning id",[x.request,x.w]);
      assert.equal(changed.id,x.request,'Reproduces the unchecked old write, not proof of safe authorization');
    });
    await t.test('094 insert guard alone does not detect a changed authentication binding',async()=>{
      const x=await seed();await db.query('update public.staff_users set auth_user_id=$2 where id=$1',[x.staff,randomUUID()]);
      assert.equal(await legacyCreate(x),x.request);
    });
    for(const column of [false,true])await t.test(`inherited ${column?'column':'table'} writer grant causes an atomic migration refusal`,async()=>{
      await db.query('create role legacy_operator_writer');
      await db.query(`grant update${column?'(status)':''} on public.growth_operator_requests to legacy_operator_writer`);
      await db.query('grant legacy_operator_writer to service_role');
      try{await denied(db.query(candidate),'P0001');}finally{await db.query('rollback');}
      for(const signature of signatures)assert.equal((await row(db,'select to_regprocedure($1) as fn',[signature])).fn,null);
      assert.equal((await row(db,"select has_table_privilege('service_role','public.growth_operator_requests','INSERT') as allowed")).allowed,true);
      await db.query('revoke legacy_operator_writer from service_role');
      await db.query('revoke update(status) on public.growth_operator_requests from legacy_operator_writer');
      await db.query('revoke all on public.growth_operator_requests from legacy_operator_writer');
      await db.query('drop role legacy_operator_writer');
    });
    await db.query(candidate);
    t.diagnostic(`PostgreSQL ${(await row(db,'show server_version')).server_version}; 096 SHA-256 ${createHash('sha256').update(candidate).digest('hex')}`);
    const create=async(x,c=service,patch={})=>(await row(c,'select public.create_clinic_operator_request($1,$2,$3,$4,$5,$6,$7) as id',
      [patch.w??x.w,patch.staff??x.staff,patch.auth??x.auth,patch.operator??x.operator,patch.brief??'Synthetic technical agreement, no payment',patch.price??'0',patch.scope??'assigned'])).id;
    const clinic=async(x,action,c=service,patch={})=>(await row(c,'select public.transition_clinic_operator_request($1,$2,$3,$4,$5) as id',
      [patch.w??x.w,patch.staff??x.staff,patch.auth??x.auth,patch.request??x.request,action])).id;
    const operator=async(x,action,c=service,auth=x.operatorAuth)=>(await row(c,'select public.transition_growth_operator_request($1,$2,$3) as id',[x.request,auth,action])).id;
    const requested=async()=>{const x=await seed();x.request=await create(x);return x;};
    const state=x=>row(db,'select * from public.growth_operator_requests where id=$1',[x.request]);
    const snapshot=async()=>JSON.stringify((await db.query('select id,to_jsonb(r) as value from public.growth_operator_requests r order by id')).rows);

    await t.test('verified creation, acceptance replay and ending retain immutable original terms',async()=>{
      const x=await requested();assert.equal((await state(x)).currency,'KZT');assert.equal((await state(x)).price_per_arrival_minor,'0');
      assert.equal(await operator(x,'accept'),x.request);const accepted=await state(x);
      assert.equal(await operator(x,'accept'),x.request);assert.deepEqual(await state(x),accepted);
      assert.equal(await clinic(x,'end'),x.request);const ended=await state(x);
      assert.equal(ended.status,'ended');assert.equal(ended.accepted_at.getTime(),accepted.accepted_at.getTime());
      assert.equal((await row(db,'select ended_at>=accepted_at as valid from public.growth_operator_requests where id=$1',[x.request])).valid,true);
      await denied(operator(x,'accept'),'P9602');await denied(clinic(x,'end'),'P9602');
      assert.deepEqual(await state(x),ended);
    });
    await t.test('ending uses database time after transaction/lock wait and never the JavaScript millisecond floor',async()=>{
      const x=await requested();await operator(x,'accept');
      const c=await f.connect();try{await c.query('begin; set local role service_role');
        const before=await row(c,'select clock_timestamp()::text as at,transaction_timestamp()::text as tx');
        await operator(x,'end',c);
        assert.equal((await row(c,'select ended_at>=$2::timestamptz and ended_at>=accepted_at and ended_at>$3::timestamptz as valid from public.growth_operator_requests where id=$1',[x.request,before.at,before.tx])).valid,true);
        await c.query('commit');
      }finally{await c.query('rollback');await c.end();}
    });
    for(const role of ['owner','admin','manager'])await t.test(`current ${role}, not departed author, may withdraw or end`,async()=>{
      const x=await requested();await db.query("update public.staff_users set status='inactive',role='doctor' where id=$1",[x.staff]);
      await db.query('update public.staff_users set role=$2 where id=$1',[x.replacement,role]);
      assert.equal(await clinic(x,'withdraw',service,{staff:x.replacement,auth:x.otherAuth}),x.request);
      const y=await requested();await operator(y,'accept');await db.query("update public.staff_users set status='inactive' where id=$1",[y.staff]);
      await db.query('update public.staff_users set role=$2 where id=$1',[y.replacement,role]);
      assert.equal(await clinic(y,'end',service,{staff:y.replacement,auth:y.otherAuth}),y.request);
    });
    const changes=[['inactive',"status='inactive'"],['demoted',"role='doctor'"],['rebound',`auth_user_id='${randomUUID()}'`]];
    for(const [name,patch] of changes)for(const action of ['create','withdraw','end'])await t.test(`${name} actor is rechecked after a real ${action} lock wait`,async()=>{
      const x=action==='create'?await seed():await requested();if(action==='end')await operator(x,'accept');
      const before=await snapshot(),a=await f.connect(),b=await f.connect();let pending;
      try{const ap=(await row(a,'select pg_backend_pid() as id')).id,bp=(await row(b,'select pg_backend_pid() as id')).id;
        await a.query('begin');await a.query(`update public.staff_users set ${patch} where id=$1`,[x.staff]);await b.query('set role service_role');
        pending=observed(action==='create'?create(x,b):clinic(x,action,b));await blocked(db,bp,ap);await a.query('commit');
        assert.equal((await pending).error?.code,'P9601');assert.equal(await snapshot(),before);
      }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
    });
    for(const action of ['accept','decline','end'])for(const patch of ["status='suspended',accepting_requests=false",`auth_user_id='${randomUUID()}'`])
      await t.test(`operator ${action} refuses approval/binding revoked during profile wait: ${patch.split('=')[0]}`,async()=>{
        const x=await requested();if(action==='end')await operator(x,'accept');const before=await snapshot();
        const a=await f.connect(),b=await f.connect();let pending;
        try{const ap=(await row(a,'select pg_backend_pid() as id')).id,bp=(await row(b,'select pg_backend_pid() as id')).id;
          await a.query('begin');await a.query(`update public.growth_operator_profiles set ${patch} where id=$1`,[x.operator]);await b.query('set role service_role');
          pending=observed(operator(x,action,b));await blocked(db,bp,ap);await a.query('commit');
          assert.equal((await pending).error?.code,'P9601');assert.equal(await snapshot(),before);
        }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
      });
    for(const actor of ['clinic','operator'])await t.test(`${actor} permission stays locked until its accepted transaction completes`,async()=>{
      const x=await requested(),a=await f.connect(),b=await f.connect();let pending;
      try{const ap=(await row(a,'select pg_backend_pid() as id')).id,bp=(await row(b,'select pg_backend_pid() as id')).id;
        await a.query('begin; set local role service_role');await (actor==='clinic'?clinic(x,'withdraw',a):operator(x,'decline',a));
        pending=observed(actor==='clinic'?b.query("update public.staff_users set status='inactive' where id=$1",[x.staff]):
          b.query("update public.growth_operator_profiles set status='suspended',accepting_requests=false where id=$1",[x.operator]));
        await blocked(db,bp,ap);await a.query('commit');assert.equal((await pending).value.rowCount,1);
      }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
    });
    for(const winner of ['accept','withdraw'])await t.test(`${winner} wins concurrent acceptance/withdrawal without misleading success`,async()=>{
      const x=await requested(),a=await f.connect(),b=await f.connect();let pending;
      try{const ap=(await row(a,'select pg_backend_pid() as id')).id,bp=(await row(b,'select pg_backend_pid() as id')).id;
        await a.query('begin; set local role service_role');await (winner==='accept'?operator(x,'accept',a):clinic(x,'withdraw',a));await b.query('set role service_role');
        pending=observed(winner==='accept'?clinic(x,'withdraw',b):operator(x,'accept',b));await blocked(db,bp,ap);await a.query('commit');
        assert.equal((await pending).error?.code,'P9602');assert.equal((await state(x)).status,winner==='accept'?'accepted':'declined');
      }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
    });
    await t.test('advisory contention is bounded by the RPC lock timeout and commits no mutation',async()=>{
      const x=await requested(),a=await f.connect(),b=await f.connect();let pending;
      const before=await state(x);
      try{const ap=(await row(a,'select pg_backend_pid() as id')).id,bp=(await row(b,'select pg_backend_pid() as id')).id;
        await a.query('begin');
        await a.query("select pg_advisory_xact_lock(hashtextextended('operator-request-v1:'||$1::text||':'||$2::text,0))",[x.w,x.operator]);
        await b.query('set role service_role');pending=observed(clinic(x,'withdraw',b));await blocked(db,bp,ap);
        assert.equal((await pending).error?.code,'55P03');assert.deepEqual(await state(x),before);
      }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
    });
    for(const isolation of ['repeatable read','serializable'])await t.test(`${isolation} stale membership snapshot cannot cross a committed revocation`,async()=>{
      const x=await requested(),a=await f.connect(),b=await f.connect();let pending;
      try{const ap=(await row(a,'select pg_backend_pid() as id')).id,bp=(await row(b,'select pg_backend_pid() as id')).id;
        await b.query(`begin isolation level ${isolation}; set local role service_role`);
        await b.query('select id from public.growth_operator_requests where id=$1',[x.request]);
        await a.query('begin');await a.query("update public.staff_users set status='inactive' where id=$1",[x.staff]);
        pending=observed(clinic(x,'withdraw',b));await blocked(db,bp,ap);await a.query('commit');assert.equal((await pending).error?.code,'40001');
      }finally{await a.query('rollback');await b.query('rollback');if(pending)await pending;await a.end();await b.end();}
    });
    await t.test('foreign staff, auth, workspace, operator and malformed actions do not mutate any request',async()=>{
      const x=await requested(),before=await snapshot();
      await denied(clinic(x,'withdraw',service,{auth:randomUUID()}),'P9601');
      await denied(clinic(x,'withdraw',service,{staff:randomUUID()}),'P9601');
      await denied(clinic(x,'withdraw',service,{w:x.other}),'P9603');
      await denied(operator(x,'accept',service,randomUUID()),'P9601');
      for(const action of [null,'remove',' end ']){await denied(clinic(x,action),'P9604');await denied(operator(x,action),'P9604');}
      assert.equal(await snapshot(),before);
    });
    await t.test('legacy direct writer, old acceptance and private actor helper are closed, including inherited browser ACL',async()=>{
      const x=await requested();
      await denied(service.query("update public.growth_operator_requests set status='declined' where id=$1",[x.request]),'42501');
      await denied(legacyCreate(await seed()),'42501');
      for(const signature of ['public.accept_growth_operator_request(uuid,uuid)','public.lock_clinic_operator_actor(uuid,uuid,uuid)'])
        assert.equal((await row(db,"select has_function_privilege('service_role',$1,'EXECUTE') as ok",[signature])).ok,false);
      for(const role of ['anon','authenticated','service_role']){
        for(const signature of signatures)assert.equal((await row(db,"select has_function_privilege($1,$2,'EXECUTE') as ok",[role,signature])).ok,role==='service_role');
        assert.equal((await row(db,"select has_table_privilege($1,'public.growth_operator_requests','INSERT,UPDATE,DELETE,TRUNCATE') as ok",[role])).ok,false);
      }
      const before=await state(x);await db.query(candidate);assert.deepEqual(await state(x),before);
      assert.equal((await row(db,"select proconfig @> array['search_path=\"\"'] as fixed,prosecdef from pg_proc where oid=$1::regprocedure",[signatures[1]])).fixed,true);
    });
    await t.test('no sale, subscription, arrival, payment, payout or staff membership is manufactured',async()=>{
      for(const table of ['growth_operator_arrivals','platform_subscription_payments','growth_partner_commissions','growth_partner_payouts','platform_subscriptions'])
        assert.equal((await row(db,`select count(*)::int as n from public.${table}`)).n,0);
    });
  }finally{await f.close();t.diagnostic('Owned PostgreSQL stopped and removed; no external database contacted');}
});
