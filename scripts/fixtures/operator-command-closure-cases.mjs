import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { seedOperatorCommandFixture, cleanupOperatorCommandFixture } from './operator-command-recovery-fixture.mjs';

const row=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
const denied=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.message);return true;});
async function blocked(db,waiter,holder){
  for(let n=0;n<250;n++){
    if((await row(db,'select $1::int=any(pg_blocking_pids($2::int)) waiting',[holder,waiter])).waiting)return;
    await delay(10);
  }
  assert.fail('Expected real command-key/authority wait');
}
export const operatorClosureSignatures=[
  'public.execute_clinic_operator_command_v2(uuid,uuid,uuid,uuid,text,uuid,uuid,text,bigint,text)',
  'public.execute_growth_operator_command_v2(uuid,uuid,uuid,text)',
  'public.read_operator_request_command_v2(uuid,uuid,text,uuid,uuid)',
  'public.close_operator_request_command_v2(uuid,uuid,text,uuid,uuid,text,uuid)',
];
export const operatorLegacySignatures=[
  'public.create_clinic_operator_request(uuid,uuid,uuid,uuid,text,bigint,text)',
  'public.transition_clinic_operator_request(uuid,uuid,uuid,uuid,text)',
  'public.transition_growth_operator_request(uuid,uuid,text)',
  'public.execute_clinic_operator_command(uuid,uuid,uuid,uuid,text,uuid,uuid,text,bigint,text)',
  'public.execute_growth_operator_command(uuid,uuid,uuid,text)',
  'public.read_operator_request_command(uuid,uuid,text,uuid,uuid)',
];

export async function exerciseOperatorCommandClosure(db,fixture,source,t){
  const seeds=[],service=await fixture.connect();await service.query('set role service_role');
  const own=async()=>{const x=await seedOperatorCommandFixture(db);seeds.push(x);return x;};
  const execute=async(x,origin,action,key,connection=service)=>(await row(connection,origin==='clinic'
    ?'select public.execute_clinic_operator_command_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result'
    :'select public.execute_growth_operator_command_v2($1,$2,$3,$4) result',origin==='clinic'
    ?[key,x.w,x.staff,x.auth,action,action==='propose'?null:x.request,action==='propose'?x.operator:null,
      action==='propose'?'Owned technical terms, no payment':null,action==='propose'?'0':null,action==='propose'?'assigned':null]
    :[key,x.request,x.operatorAuth,action])).result;
  const target=(x,action)=>action==='propose'?x.operator:x.request;
  const read=async(x,origin,key,connection=service)=>(await row(connection,'select public.read_operator_request_command_v2($1,$2,$3,$4,$5) result',
    [key,origin==='clinic'?x.auth:x.operatorAuth,origin,origin==='clinic'?x.w:null,origin==='clinic'?x.staff:null])).result;
  const close=async(x,origin,action,key,connection=service)=>(await row(connection,'select public.close_operator_request_command_v2($1,$2,$3,$4,$5,$6,$7) result',
    [key,origin==='clinic'?x.auth:x.operatorAuth,origin,origin==='clinic'?x.w:null,origin==='clinic'?x.staff:null,action,target(x,action)])).result;
  const prepare=async(action)=>{const x=await own();if(action!=='propose'){
    x.request=(await execute(x,'clinic','propose',randomUUID())).requestId;
    if(action==='end')await execute(x,'operator','accept',randomUUID());
  }return x;};
  const snapshot=async()=>JSON.stringify((await db.query(`select 'request' kind,id::text,to_jsonb(r) value from public.growth_operator_requests r
    union all select 'command',command_id::text,to_jsonb(c) from public.growth_operator_request_commands c
    union all select 'fence',command_id::text,to_jsonb(f) from public.growth_operator_command_fences f order by kind,id`)).rows);
  try{
    for(const [origin,action] of [['clinic','propose'],['clinic','withdraw'],['clinic','end'],['operator','accept'],['operator','decline'],['operator','end']]){
      await t.test(`${origin} ${action}: closing an unknown key fences every late admission`,async()=>{
        const x=await prepare(action),key=randomUUID(),result=await close(x,origin,action,key),before=await snapshot();
        assert.equal(result.state,'abandoned');assert.equal(result.commandId,key);assert.equal(result.action,action);assert.equal(result.targetId,target(x,action));
        assert.deepEqual(await execute(x,origin,action,key),result);assert.deepEqual(await close(x,origin,action,key),result);
        assert.deepEqual(await read(x,origin,key),result);assert.equal(await snapshot(),before);
        assert.equal((await row(db,'select count(*)::int n from public.growth_operator_request_commands where command_id=$1',[key])).n,0);
      });
      for(const winner of ['admission','closure'])await t.test(`${origin} ${action}: ${winner} wins the real key wait, never both`,async()=>{
        const x=await prepare(action),key=randomUUID(),a=await fixture.connect(),b=await fixture.connect();let pending;
        try{
          const ap=(await row(a,'select pg_backend_pid() id')).id,bp=(await row(b,'select pg_backend_pid() id')).id;
          await a.query('begin;set local role service_role');await b.query('set role service_role');
          const first=winner==='admission'?await execute(x,origin,action,key,a):await close(x,origin,action,key,a);
          pending=observed(winner==='admission'?close(x,origin,action,key,b):execute(x,origin,action,key,b));
          await blocked(db,bp,ap);await a.query('commit');assert.deepEqual((await pending).value,first);
          const count=await row(db,`select (select count(*)::int from public.growth_operator_request_commands where command_id=$1) committed,
            (select count(*)::int from public.growth_operator_command_fences where command_id=$1) fenced`,[key]);
          assert.deepEqual(count,winner==='admission'?{committed:1,fenced:0}:{committed:0,fenced:1});
        }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
      });
    }
    for(const origin of ['clinic','operator'])await t.test(`${origin}: an unconfirmed read cannot exclude a subsequently arriving original command`,async()=>{
      const x=await prepare(origin==='clinic'?'propose':'accept'),key=randomUUID(),a=await fixture.connect(),b=await fixture.connect();let pending;
      try{
        const ap=(await row(a,'select pg_backend_pid() id')).id,bp=(await row(b,'select pg_backend_pid() id')).id;
        await a.query('begin;set local role service_role');await b.query('set role service_role');
        assert.deepEqual(await read(x,origin,key,a),{state:'unconfirmed',commandId:key});
        pending=observed(execute(x,origin,origin==='clinic'?'propose':'accept',key,b));await blocked(db,bp,ap);
        await a.query('commit');assert.equal((await pending).value.state,'committed');
      }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
    });
    await t.test('historical read and close confirm a committed result after the business row was removed',async()=>{
      const x=await prepare('propose'),key=randomUUID(),result=await execute(x,'clinic','propose',key);
      await db.query('delete from public.growth_operator_requests where id=$1',[result.requestId]);const before=await snapshot();
      assert.deepEqual(await read(x,'clinic',key),result);assert.deepEqual(await close(x,'clinic','propose',key),result);
      assert.equal(await snapshot(),before);assert.doesNotMatch(JSON.stringify(result),/Owned|auth|staff|brief|phone|workspace/);
    });
    for(const state of ['committed','abandoned'])for(const origin of ['clinic','operator'])
      await t.test(`${origin} ${state} read/closure rechecks revocation during a real authority wait`,async()=>{
        const action=origin==='clinic'?'propose':'accept',x=await prepare(action),key=randomUUID();
        await (state==='committed'?execute(x,origin,action,key):close(x,origin,action,key));
        const a=await fixture.connect(),b=await fixture.connect();let pending;
        try{
          const ap=(await row(a,'select pg_backend_pid() id')).id,bp=(await row(b,'select pg_backend_pid() id')).id;
          await a.query('begin');await a.query(origin==='clinic'?"update public.staff_users set status='inactive' where id=$1":
            "update public.growth_operator_profiles set status='suspended',accepting_requests=false where id=$1",[origin==='clinic'?x.staff:x.operator]);
          await b.query('set role service_role');pending=observed(read(x,origin,key,b));await blocked(db,bp,ap);
          await a.query('commit');assert.equal((await pending).error?.code,'P9601');await denied(close(x,origin,action,key),'P9601');
        }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();}
      });
    await t.test('another identity, scope, action or target cannot close or consume an owned command',async()=>{
      const x=await prepare('propose'),key=randomUUID();await close(x,'clinic','propose',key);const before=await snapshot();
      await denied(close({...x,auth:randomUUID()},'clinic','propose',key),'P9601');
      await denied(close({...x,w:x.foreign},'clinic','propose',key),'P9601');
      await denied(close({...x,staff:randomUUID()},'clinic','propose',key),'P9601');
      await denied(close({...x,operator:randomUUID()},'clinic','propose',key),'P1072');
      await denied(close({...x,request:randomUUID()},'clinic','withdraw',key),'P1072');
      await denied(close({...x,request:randomUUID()},'operator','accept',key),'P9601');
      assert.equal(await snapshot(),before);
    });
    await t.test('old unbound and v1 RPCs cannot bypass fences; only four v2 entry points remain',async()=>{
      for(const signature of operatorLegacySignatures)assert.equal((await row(db,'select has_function_privilege(\'service_role\',$1,\'EXECUTE\') allowed',[signature])).allowed,false);
      const x=await prepare('propose');
      await denied(service.query('select public.create_clinic_operator_request($1,$2,$3,$4,$5,0,\'assigned\')',[x.w,x.staff,x.auth,x.operator,'Owned']),'42501');
      await denied(service.query('select public.execute_clinic_operator_command($1,$2,$3,$4,\'propose\',null,$5,\'Owned\',0,\'assigned\')',[randomUUID(),x.w,x.staff,x.auth,x.operator]),'42501');
      for(const role of ['anon','authenticated','service_role']){
        const privileges=await row(db,"select has_table_privilege($1,'public.growth_operator_command_fences','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') t,has_any_column_privilege($1,'public.growth_operator_command_fences','SELECT,INSERT,UPDATE,REFERENCES') c",[role]);
        assert.deepEqual(privileges,{t:false,c:false});
        for(const signature of operatorClosureSignatures)assert.equal((await row(db,'select has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,signature])).allowed,role==='service_role');
      }
    });
    await t.test('exact closure rerun keeps historical receipts/fences and never restores old writers',async()=>{
      const before=await snapshot();await db.query(source);assert.equal(await snapshot(),before);
      for(const signature of operatorLegacySignatures)assert.equal((await row(db,'select has_function_privilege(\'service_role\',$1,\'EXECUTE\') allowed',[signature])).allowed,false);
    });
  }finally{
    await service.end();
    for(const x of seeds){await db.query('delete from public.growth_operator_command_fences where actor_auth_user_id=any($1::uuid[])',[[x.auth,x.operatorAuth]]);await cleanupOperatorCommandFixture(db,x);}
  }
  for(const table of ['growth_operator_command_fences','growth_operator_request_commands','growth_operator_requests','growth_operator_profiles','staff_users','workspaces'])
    assert.equal((await row(db,`select count(*)::int n from public.${table}`)).n,0,table+' owned cleanup');
}
