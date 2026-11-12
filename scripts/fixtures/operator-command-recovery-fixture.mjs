import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const row=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
const denied=(p,code)=>assert.rejects(p,error=>{assert.equal(error.code,code,error.message);return true;});
export const operatorCommandSignatures=[
  'public.execute_clinic_operator_command(uuid,uuid,uuid,uuid,text,uuid,uuid,text,bigint,text)',
  'public.execute_growth_operator_command(uuid,uuid,uuid,text)',
  'public.read_operator_request_command(uuid,uuid,text,uuid,uuid)',
];
const internals=[
  'public.operator_request_command_receipt(public.growth_operator_request_commands)',
  'public.confirm_operator_request_command(uuid,uuid,text,uuid,uuid,text)',
];
async function blocked(db,waiter,holder){
  for(let n=0;n<250;n++){
    if((await row(db,'select $1::int=any(pg_blocking_pids($2::int)) waiting',[holder,waiter])).waiting)return;
    await delay(10);
  }
  assert.fail('The owned native authority/command wait was not observed');
}
async function seed(db){
  const x=Object.fromEntries(['w','foreign','staff','auth','operator','operatorAuth'].map(key=>[key,randomUUID()]));
  await db.query("insert into public.workspaces(id,name) values($1,'Owned command clinic'),($2,'Owned unrelated clinic')",[x.w,x.foreign]);
  await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,$4,'Owned owner','owner','active')",[x.staff,x.w,x.auth,x.staff+'@example.invalid']);
  await db.query("insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at) values($1,$2,'Owned operator','approved',true,$3,clock_timestamp())",[x.operator,x.operatorAuth,x.auth]);
  return x;
}
async function clean(db,x,commands=true){
  if(commands)await db.query('delete from public.growth_operator_request_commands where workspace_id=$1',[x.w]);
  await db.query('delete from public.growth_operator_requests where workspace_id=$1',[x.w]);
  await db.query('delete from public.workspaces where id=any($1::uuid[])',[[x.w,x.foreign]]);
  await db.query('delete from public.growth_operator_profiles where id=$1',[x.operator]);
}
const legacyPropose=(db,x)=>row(db,'select public.create_clinic_operator_request($1,$2,$3,$4,$5,0,\'assigned\') id',
  [x.w,x.staff,x.auth,x.operator,'Owned technical terms, no payment']);
export { seed as seedOperatorCommandFixture, clean as cleanupOperatorCommandFixture };

export async function reproduceUnboundOperatorProposal(db,t){
  await t.test('old proposal after committed lost ACK and ended cooperation creates an unintended replacement',async()=>{
    const x=await seed(db), c=await db.query('select current_user role');
    try{
      await db.query('set role service_role');
      const first=(await legacyPropose(db,x)).id;
      await db.query("select public.transition_growth_operator_request($1,$2,'accept')",[first,x.operatorAuth]);
      await db.query("select public.transition_growth_operator_request($1,$2,'end')",[first,x.operatorAuth]);
      const repeat=(await legacyPropose(db,x)).id;
      assert.notEqual(repeat,first,'Reproduces the old missing command identity, not desired retry behavior');
      await db.query('reset role');
      assert.equal((await row(db,'select count(*)::int n from public.growth_operator_requests where workspace_id=$1',[x.w])).n,2);
    }finally{await db.query('reset role');await clean(db,x,false);assert.equal(c.rows[0].role,'postgres');}
  });
}

export async function exerciseOperatorCommands(db,fixture,source,t){
  const seeds=[];
  const own=async()=>{const x=await seed(db);seeds.push(x);return x;};
  const service=await fixture.connect();await service.query('set role service_role');
  const clinic=async(x,action='propose',key=randomUUID(),connection=service,patch={})=>(await row(connection,
    'select public.execute_clinic_operator_command($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result',
    [key,patch.w??x.w,patch.staff??x.staff,patch.auth??x.auth,action,action==='propose'?null:(patch.request??x.request),
      action==='propose'?(patch.operator??x.operator):null,action==='propose'?(patch.brief??'Owned technical terms, no payment'):null,
      action==='propose'?(patch.price??'0'):null,action==='propose'?(patch.scope??'assigned'):null])).result;
  const operator=async(x,action,key=randomUUID(),connection=service,auth=x.operatorAuth)=>(await row(connection,
    'select public.execute_growth_operator_command($1,$2,$3,$4) result',[key,x.request,auth,action])).result;
  const read=async(x,key,origin='clinic',connection=service,auth=origin==='clinic'?x.auth:x.operatorAuth)=>(await row(connection,
    'select public.read_operator_request_command($1,$2,$3,$4,$5) result',[key,auth,origin,origin==='clinic'?x.w:null,origin==='clinic'?x.staff:null])).result;
  const propose=async()=>{const x=await own();x.proposal=await clinic(x);x.request=x.proposal.requestId;return x;};
  const snapshot=async()=>JSON.stringify((await db.query(`select 'request' kind,id::text,to_jsonb(r) value from public.growth_operator_requests r
    union all select 'command',command_id::text,to_jsonb(c) from public.growth_operator_request_commands c order by kind,id`)).rows);
  const counts=x=>row(db,`select (select count(*)::int from public.growth_operator_requests where workspace_id=$1) requests,
    (select count(*)::int from public.growth_operator_request_commands where workspace_id=$1) commands`,[x.w]);
  try{
    await t.test('committed proposal keeps its original receipt after end and a genuinely new proposal',async()=>{
      const x=await propose();await operator(x,'accept');await operator(x,'end');
      const newer=await clinic(x);assert.notEqual(newer.requestId,x.request);const before=await snapshot();
      assert.deepEqual(await clinic(x,'propose',x.proposal.commandId),x.proposal);
      assert.deepEqual(await read(x,x.proposal.commandId),x.proposal);assert.equal(await snapshot(),before);
      assert.equal(x.proposal.statusAtCommit,'requested');assert.deepEqual(await counts(x),{requests:2,commands:4});
      assert.deepEqual(Object.keys(x.proposal).sort(),['action','commandId','committedAt','requestId','statusAtCommit'].sort());
    });
    for(const [origin,action] of [['clinic','withdraw'],['clinic','end'],['operator','accept'],['operator','decline'],['operator','end']])
      await t.test(`${origin} ${action} committed recovery is stable and makes no second transition`,async()=>{
        const x=await propose();if(action==='end')await operator(x,'accept');
        const key=randomUUID(),send=origin==='clinic'?clinic:operator;
        const result=await send(x,action,key),before=await snapshot();
        assert.deepEqual(await send(x,action,key),result);assert.deepEqual(await read(x,key,origin),result);
        assert.equal(await snapshot(),before);assert.equal(result.commandId,key);assert.equal(result.requestId,x.request);
        assert.ok(Number.isFinite(Date.parse(result.committedAt)));assert.equal(result.action,action);
      });
    for(const [origin,action] of [['clinic','propose'],['clinic','withdraw'],['clinic','end'],['operator','accept'],['operator','decline'],['operator','end']])
      await t.test(`${origin} ${action} same-key wait returns one committed immutable receipt`,async()=>{
        const x=action==='propose'?await own():await propose();if(action==='end')await operator(x,'accept');
        const a=await fixture.connect(),b=await fixture.connect(),key=randomUUID(),send=origin==='clinic'?clinic:operator;
        let pending;
        try{
          const ap=(await row(a,'select pg_backend_pid() id')).id,bp=(await row(b,'select pg_backend_pid() id')).id;
          await a.query('begin;set local role service_role');await b.query('set role service_role');
          const first=await send(x,action,key,a);pending=observed(send(x,action,key,b));await blocked(db,bp,ap);
          await a.query('commit');assert.deepEqual((await pending).value,first);
          assert.equal((await row(db,'select count(*)::int n from public.growth_operator_request_commands where command_id=$1',[key])).n,1);
        }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
      });
    for(const origin of ['clinic','operator'])await t.test(`${origin} read waits for the original admitted command and confirms its commit`,async()=>{
      const x=origin==='clinic'?await own():await propose(),a=await fixture.connect(),b=await fixture.connect(),key=randomUUID();let pending;
      try{
        const ap=(await row(a,'select pg_backend_pid() id')).id,bp=(await row(b,'select pg_backend_pid() id')).id;
        await a.query('begin;set local role service_role');await b.query('set role service_role');
        const result=origin==='clinic'?await clinic(x,'propose',key,a):await operator(x,'accept',key,a);
        pending=observed(read(x,key,origin,b));await blocked(db,bp,ap);await a.query('commit');
        assert.deepEqual((await pending).value,result);
      }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
    });
    await t.test('a command key cannot be redirected to changed terms, scope, target, action, actor or origin',async()=>{
      const x=await propose(),key=x.proposal.commandId,before=await snapshot();
      for(const patch of [{brief:'Changed owned brief'},{price:'1'},{scope:'clinic'},{operator:randomUUID()}])
        await denied(clinic(x,'propose',key,service,patch),'P1072');
      await denied(clinic(x,'withdraw',key),'P1072');
      for(const patch of [{w:x.foreign},{staff:randomUUID()},{auth:randomUUID()}])
        await denied(clinic(x,'propose',key,service,patch),'P9601');
      await denied(operator(x,'accept',key),'P9601');
      assert.equal(await snapshot(),before);
    });
    for(const change of ["status='inactive'","role='doctor'",`auth_user_id='${randomUUID()}'`])
      await t.test(`clinic replay/read rechecks live ${change.split('=')[0]} and does not leak the receipt`,async()=>{
        const x=await propose();await db.query(`update public.staff_users set ${change} where id=$1`,[x.staff]);const before=await snapshot();
        await denied(read(x,x.proposal.commandId),'P9601');
        await denied(clinic(x,'propose',x.proposal.commandId,service,{brief:'Different after revocation'}),'P9601');
        assert.equal(await snapshot(),before);
      });
    for(const change of ["status='suspended',accepting_requests=false",`auth_user_id='${randomUUID()}'`])
      await t.test(`operator committed replay/read rechecks live ${change.split('=')[0]}`,async()=>{
        const x=await propose(),result=await operator(x,'accept');
        await db.query(`update public.growth_operator_profiles set ${change} where id=$1`,[x.operator]);const before=await snapshot();
        await denied(operator(x,'accept',result.commandId),'P9601');await denied(read(x,result.commandId,'operator'),'P9601');
        assert.equal(await snapshot(),before);
      });
    for(const origin of ['clinic','operator'])for(const operation of ['read','replay'])
      await t.test(`${origin} committed ${operation} observes real authorization revocation while waiting`,async()=>{
        const x=await propose(),result=origin==='clinic'?x.proposal:await operator(x,'accept');
        const a=await fixture.connect(),b=await fixture.connect();let pending;
        try{
          const ap=(await row(a,'select pg_backend_pid() id')).id,bp=(await row(b,'select pg_backend_pid() id')).id;
          await a.query('begin');
          await a.query(origin==='clinic'?"update public.staff_users set status='inactive' where id=$1":
            "update public.growth_operator_profiles set status='suspended',accepting_requests=false where id=$1",[origin==='clinic'?x.staff:x.operator]);
          await b.query('set role service_role');
          pending=observed(operation==='read'?read(x,result.commandId,origin,b):origin==='clinic'?clinic(x,'propose',result.commandId,b):operator(x,'accept',result.commandId,b));
          await blocked(db,bp,ap);await a.query('commit');assert.equal((await pending).error?.code,'P9601');
        }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
      });
    for(const isolation of ['repeatable read','serializable'])for(const origin of ['clinic','operator'])for(const operation of ['read','replay'])
      await t.test(`${origin} ${operation} refuses a stale ${isolation} authority snapshot`,async()=>{
        const x=await propose(),result=origin==='clinic'?x.proposal:await operator(x,'accept');
        const a=await fixture.connect(),b=await fixture.connect();let pending;
        try{
          const ap=(await row(a,'select pg_backend_pid() id')).id,bp=(await row(b,'select pg_backend_pid() id')).id;
          await b.query(`begin isolation level ${isolation};set local role service_role`);
          // Establish a real MVCC snapshot without acquiring the authority locks.
          await b.query('select id from public.growth_operator_requests where id=$1',[x.request]);
          await a.query('begin');
          await a.query(origin==='clinic'?"update public.staff_users set status='inactive' where id=$1":
            "update public.growth_operator_profiles set status='suspended',accepting_requests=false where id=$1",[origin==='clinic'?x.staff:x.operator]);
          pending=observed(operation==='read'?read(x,result.commandId,origin,b):origin==='clinic'?clinic(x,'propose',result.commandId,b):operator(x,'accept',result.commandId,b));
          await blocked(db,bp,ap);await a.query('commit');assert.equal((await pending).error?.code,'40001');
        }finally{await a.query('rollback');await b.query('rollback');if(pending)await pending;await a.end();await b.end();}
      });
    for(const action of ['propose','end'])await t.test(`${action} and its receipt roll back atomically if receipt insertion fails`,async()=>{
      const x=action==='propose'?await own():await propose();if(action==='end')await operator(x,'accept');
      const key=randomUUID(),before=await snapshot();
      await db.query(`alter table public.growth_operator_request_commands add constraint owned_command_failure check(command_id<>'${key}'::uuid)`);
      try{await denied(clinic(x,action,key),'23514');assert.equal(await snapshot(),before);}
      finally{await db.query('alter table public.growth_operator_request_commands drop constraint owned_command_failure');}
      const result=await clinic(x,action,key);assert.equal(result.commandId,key);
    });
    await t.test('an explicitly rolled back first call leaves no command and same-key retry commits once',async()=>{
      const x=await own(),c=await fixture.connect(),key=randomUUID();
      try{await c.query('begin;set local role service_role');await clinic(x,'propose',key,c);await c.query('rollback');}
      finally{await c.end();}
      assert.deepEqual(await counts(x),{requests:0,commands:0});assert.equal(await read(x,key),null);
      await clinic(x,'propose',key);assert.deepEqual(await counts(x),{requests:1,commands:1});
    });
    await t.test('deleting an old request retains a tombstone and never reuses that command for a proposal',async()=>{
      const x=await propose(),key=x.proposal.commandId;
      await db.query('delete from public.growth_operator_requests where id=$1',[x.request]);
      await denied(clinic(x,'propose',key),'P9603');await denied(read(x,key),'P9603');
      assert.deepEqual(await counts(x),{requests:0,commands:1});
    });
    await t.test('unknown reads require live actor authority and are not a mutation or rollback receipt',async()=>{
      const x=await own(),before=await snapshot();assert.equal(await read(x,randomUUID()),null);
      assert.equal(await read(x,randomUUID(),'operator'),null);assert.equal(await snapshot(),before);
      await denied(read(x,randomUUID(),'clinic',service,randomUUID()),'P9601');
      await denied(read(x,randomUUID(),'operator',service,randomUUID()),'P9601');
    });
    await t.test('body text is absent from receipts, and rerun preserves every committed result and ACL',async()=>{
      const before=await snapshot();await db.query(source);assert.equal(await snapshot(),before);
      const shape=(await db.query("select attname from pg_attribute where attrelid='public.growth_operator_request_commands'::regclass and attnum>0 and not attisdropped")).rows.map(x=>x.attname);
      assert.equal(shape.some(name=>/brief|phone|contact|payload|price|currency/.test(name)),false);
      for(const role of ['anon','authenticated','service_role']){
        await service.query(`set role ${role}`);
        await denied(service.query('select * from public.growth_operator_request_commands'),'42501');
        for(const signature of internals)assert.equal((await row(db,'select has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,signature])).allowed,false);
        for(const signature of operatorCommandSignatures)assert.equal((await row(db,'select has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,signature])).allowed,role==='service_role');
      }
      await service.query('set role service_role');
    });
  }finally{
    await service.end();
    for(const x of seeds)await clean(db,x);
  }
  for(const table of ['growth_operator_request_commands','growth_operator_requests','growth_operator_profiles','workspaces','staff_users'])
    assert.equal((await row(db,`select count(*)::int n from public.${table}`)).n,0,`Owned ${table} cleanup`);
}
