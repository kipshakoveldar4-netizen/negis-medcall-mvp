import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {seedOperatorWorkday,cleanupOperatorWorkday} from './operator-workday-cases.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
export const readOperatorLeadSearch=async(db,x,{search='',group='all',requestId=null,offset=0}={})=>(await one(db,'select public.read_growth_operator_lead_search($1,$2,$3,$4,$5) v',[x.actor,search,group,requestId,offset])).v;
const observed=p=>p.then(value=>({value}),error=>({error}));
async function blocked(db,waiter,blocker){for(let i=0;i<200;i++){if((await one(db,'select $1::integer=any(pg_blocking_pids($2::integer)) yes',[blocker,waiter])).yes)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected actual owned lead-search lock wait');}

export async function exerciseOperatorLeadSearch(db,fixture,source,t){
  const x=await seedOperatorWorkday(db,{companies:25,visits:0,label:'SEARCH_A'}),foreign=await seedOperatorWorkday(db,{companies:1,visits:0,label:'PRIVATE_FOREIGN_SEARCH'});
  const service=await fixture.connect();await service.query('set role service_role');
  const c=x.companies[0],second=x.companies[1],stages=[],extra=[];
  const snapshot=async()=>JSON.stringify((await db.query("select table_name,row_data from (select 'leads' table_name,to_jsonb(l) row_data from public.leads l union all select 'assignments',to_jsonb(a) from public.growth_operator_lead_assignments a union all select 'stages',to_jsonb(s) from public.lead_stages s union all select 'audit',to_jsonb(a) from public.audit_logs a) x order by table_name,row_data::text")).rows);
  try{
    for(const[i,group]of ['new','in_progress','booked','postponed','lost'].entries()){
      const id=randomUUID();stages.push(id);await db.query('insert into public.lead_stages(id,workspace_id,stage_key,name,semantic_group,sort_order) values($1,$2,$3,$4,$5,$6)',[id,c.workspace,'qa124_'+group,'Owned '+group,group,i]);
    }
    const retired=randomUUID();await db.query("insert into public.lead_stages(id,workspace_id,stage_key,name,semantic_group,is_active) values($1,$2,'retired','Owned retired postponed','postponed',false)",[retired,c.workspace]);
    await db.query("update public.leads set stage_id=$2,status='Новая' where id=$1",[c.leads[0],retired]);
    for(const[i,status]of ['\u00a0Отложена\u3000','Записана','Потеряна','Needs review'].entries())await db.query('update public.leads set status=$2 where id=$1',[second.leads[i],status]);
    for(let i=0;i<30;i++){
      const id=randomUUID(),name=i===0?'ӘЛИЯ QA124':i===1?'ТЕСТ %_ literal':i===2?'Совпадающее имя':'QA124 extra '+i;
      extra.push(id);await db.query("insert into public.leads(id,workspace_id,full_name,phone,status,stage_id,source,notes,created_at) values($1,$2,$3,'+7 (700) 000-11-22',$4,$5,'Synthetic source','PRIVATE_SEARCH_NOTE','2026-10-28T00:00:00Z'::timestamptz+$6::integer*interval '1 microsecond')",[id,c.workspace,name,i%6===5?'Unknown source state':'STALE TEXT',i%6===5?null:stages[i%6],i]);
      await db.query('insert into public.growth_operator_lead_assignments(operator_request_id,workspace_id,lead_id,assigned,changed_by_staff_user_id) values($1,$2,$3,true,$4)',[c.request,c.workspace,id,c.staff]);
    }
    await db.query("update public.leads set full_name='Совпадающее имя',phone='+7 (700) 000-11-22' where id=$1",[second.leads[0]]);
    await t.test('124 complete authorized stock, semantic buckets and 20-row pages use all accepted companies, not newer proposal pages',async()=>{
      const before=await snapshot(),r=await readOperatorLeadSearch(service,x);
      assert.equal(r.companies.length,25);assert.equal(r.totals.all,'104');assert.equal(r.matched,'104');assert.equal(r.items.length,20);assert.equal(r.hasMore,true);
      assert.equal(Object.entries(r.totals).filter(([k])=>k!=='all').reduce((n,[,v])=>n+BigInt(v),0n),104n);
      const rows=[];for(let offset=0;offset<104;offset+=20){const page=await readOperatorLeadSearch(service,x,{offset});assert.deepEqual(page.totals,r.totals);rows.push(...page.items);assert.equal(page.items.length,Math.min(20,104-offset));}
      assert.equal(new Set(rows.map(l=>l.id)).size,104);assert.equal(rows.find(l=>l.id===c.leads[0]).group,'postponed');
      assert.equal(rows.find(l=>l.id===second.leads[3]).group,'other');
      assert.ok(rows.filter(l=>extra.includes(l.id)&&l.stageId!==null).every(l=>l.group!=='other'),'Semantic stage wins over stale raw text');
      assert.doesNotMatch(JSON.stringify(r),/PRIVATE_|auth_user_id|workspace_id|notes|approved_by|price_minor/);
      for(const opt of r.stageOptions){const company=x.companies.find(v=>v.request===opt.requestId),allowed=(await db.query('select id from public.lead_stages where workspace_id=$1 and is_active order by sort_order,id',[company.workspace])).rows.map(v=>v.id);assert.ok(r.items.some(l=>l.requestId===opt.requestId));assert.deepEqual(opt.items.map(s=>s.id),allowed);assert.ok(!opt.items.some(s=>s.id===retired));}
      assert.equal(await snapshot(),before,'Search is read-only');
    });
    await t.test('124 literal wildcards, Kazakh/Russian case, formatted phone, company search and selected-group totals are independent',async()=>{
      const literal=await readOperatorLeadSearch(service,x,{search:'%_'});assert.equal(literal.matched,'1');assert.equal(literal.items[0].id,extra[1]);
      const kz=await readOperatorLeadSearch(service,x,{search:'әлия'});assert.equal(kz.matched,'1');assert.equal(kz.items[0].id,extra[0]);
      const same=await readOperatorLeadSearch(service,x,{search:'СОВПАДАЮЩЕЕ ИМЯ'});assert.equal(same.matched,'2');assert.equal(new Set(same.items.map(l=>l.requestId)).size,2);
      for(const search of ['+7 700 000 11 22','87000001122','0077000001122','77000001122']){const phone=await readOperatorLeadSearch(service,x,{search});assert.equal(phone.matched,'31',search);}
      const company=await readOperatorLeadSearch(service,x,{search:'search_a company 0'});assert.equal(company.matched,'32');
      const all=await readOperatorLeadSearch(service,x,{search:'QA124'});
      for(const group of ['new','in_progress','booked','postponed','lost','other']){const r=await readOperatorLeadSearch(service,x,{search:'QA124',group});assert.deepEqual(r.totals,all.totals);assert.equal(r.matched,all.totals[group]);assert.ok(r.items.every(l=>l.group===group));}
      const own=await readOperatorLeadSearch(service,x,{requestId:c.request});assert.equal(own.matched,'32');assert.equal(own.companies.length,25);assert.ok(own.items.every(l=>l.requestId===c.request));
    });
    await t.test('124 other operator, unauthorized selector and missing identity never receive even an empty authority-free report',async()=>{
      const other=await readOperatorLeadSearch(service,foreign);assert.equal(other.totals.all,'2');assert.ok(other.items.every(l=>l.name.startsWith('PRIVATE_FOREIGN_SEARCH')));
      for(const actor of [null,randomUUID()])await assert.rejects(readOperatorLeadSearch(service,{actor}),e=>e.code==='P1241');
      for(const requestId of [randomUUID(),foreign.companies[0].request])await assert.rejects(readOperatorLeadSearch(service,x,{requestId}),e=>e.code==='P1241');
      const empty=await seedOperatorWorkday(db,{companies:0,visits:0});try{const r=await readOperatorLeadSearch(service,empty);assert.equal(r.matched,'0');assert.deepEqual(r.items,[]);assert.deepEqual(r.companies,[]);assert.deepEqual(r.stageOptions,[]);}finally{await cleanupOperatorWorkday(db,empty);}
    });
    await t.test('124 invalid arguments and stronger isolation cannot return partial or stale search data',async()=>{
      for(const args of [{search:null},{search:'x'.repeat(121)},{search:'a\nb'},{group:'private'},{group:null},{offset:null},{offset:-1},{offset:1000001}])await assert.rejects(readOperatorLeadSearch(service,x,args),e=>e.code==='P1243');
      await service.query('begin isolation level repeatable read');try{await assert.rejects(readOperatorLeadSearch(service,x),e=>e.code==='P1242');}finally{await service.query('rollback');}
    });
    await t.test('124 displayed active-stage choices compose with the existing guarded CAS writer without replay audit duplicates',async()=>{
      const r=await readOperatorLeadSearch(service,x,{search:'ӘЛИЯ'}),lead=r.items[0],choice=r.stageOptions.find(o=>o.requestId===c.request).items.find(s=>s.id===stages[1]);
      const audits=(await one(db,"select count(*)::int n from public.audit_logs where action='operator_lead_stage_changed'")).n;
      await service.query('select public.set_growth_operator_lead_stage($1,$2,$3,$4,$5,$6)',[c.request,x.actor,lead.id,choice.id,lead.stageId,lead.status]);
      const after=await readOperatorLeadSearch(service,x,{search:'ӘЛИЯ'});assert.equal(after.items[0].group,'in_progress');assert.equal(after.items[0].stageId,choice.id);
      await assert.rejects(service.query('select public.set_growth_operator_lead_stage($1,$2,$3,$4,$5,$6)',[c.request,x.actor,lead.id,choice.id,lead.stageId,lead.status]),e=>e.code==='PT409');
      assert.equal((await one(db,"select count(*)::int n from public.audit_logs where action='operator_lead_stage_changed'")).n,audits+1);
    });
    for(const mutation of ['profile','assignment','new acceptance'])await t.test('124 blocked report rechecks committed '+mutation+' under the original request/profile lock order',async()=>{
      const blocker=await fixture.connect(),writer=await fixture.connect();let pending,newRequest,command;
      try{
        await blocker.query('begin');
        if(mutation==='profile')await blocker.query("update public.growth_operator_profiles set status='suspended',accepting_requests=false where id=$1",[x.profile]);
        else await blocker.query('select id from public.growth_operator_requests where id=$1 for update',[c.request]);
        const blockerId=(await one(blocker,'select pg_backend_pid() id')).id,readerId=(await one(service,'select pg_backend_pid() id')).id;
        pending=observed(readOperatorLeadSearch(service,x,{search:'ӘЛИЯ'}));await blocked(db,readerId,blockerId);
        if(mutation==='assignment')await blocker.query('select public.set_growth_operator_lead_assignment($1,$2,$3,false)',[c.request,extra[0],c.staff]);
        if(mutation==='new acceptance'){
          const destination=foreign.companies[0];newRequest=randomUUID();command=randomUUID();await writer.query("insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,lead_scope,price_per_arrival_minor) values($1,$2,$3,$4,'Owned search pending proposal','assigned',0)",[newRequest,destination.workspace,x.profile,destination.staff]);
          await writer.query('set role service_role');await writer.query("select public.execute_growth_operator_command_v2($1,$2,$3,'accept')",[command,newRequest,x.actor]);
        }
        await blocker.query('commit');const result=await pending;
        if(mutation==='profile')assert.equal(result.error?.code,'P1241');
        else if(mutation==='new acceptance')assert.equal(result.error?.code,'P1242');
        else{assert.equal(result.error,undefined);assert.equal(result.value.matched,'0');assert.deepEqual(result.value.items,[]);}
      }finally{
        await blocker.query('rollback');if(pending)await pending;await blocker.end();await writer.end();
        await db.query("update public.growth_operator_profiles set status='approved',accepting_requests=true where id=$1",[x.profile]);
        await db.query('select public.set_growth_operator_lead_assignment($1,$2,$3,true)',[c.request,extra[0],c.staff]);
        if(command)await db.query('delete from public.growth_operator_request_commands where command_id=$1',[command]);
        if(newRequest)await db.query('delete from public.growth_operator_requests where id=$1',[newRequest]);
      }
    });
    await t.test('124 ending then reaccepting the same company cannot lend old assigned leads to the new request',async()=>{
      await db.query('begin');try{
        const next=randomUUID();await db.query("update public.growth_operator_requests set status='ended',ended_at=clock_timestamp() where id=$1",[c.request]);
        await db.query("insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,lead_scope,price_per_arrival_minor) values($1,$2,$3,$4,'Owned replacement search','assigned',0)",[next,c.workspace,x.profile,c.staff]);
        await db.query("update public.growth_operator_requests set status='accepted',accepted_at=now() where id=$1",[next]);
        const r=await readOperatorLeadSearch(db,x,{search:'QA124'});assert.equal(r.matched,'0');assert.ok(!r.companies.some(v=>v.requestId===c.request));
      }finally{await db.query('rollback');}
    });
    await t.test('124 manifest and active-stage overflow refuse instead of quietly truncating authority or choices',async()=>{
      await db.query('begin');try{
        const rows=Array.from({length:1001},()=>({workspace:randomUUID(),staff:randomUUID(),staffActor:randomUUID(),request:randomUUID()})),actor=randomUUID(),profile=randomUUID();
        await db.query("insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at) values($1,$2,'Owned search overflow','approved',true,$3,now())",[profile,actor,randomUUID()]);
        const record='jsonb_to_recordset($1::jsonb) as x(workspace uuid,staff uuid,"staffActor" uuid,request uuid)';
        await db.query("insert into public.workspaces(id,name) select workspace,'Owned search overflow' from "+record,[JSON.stringify(rows)]);
        await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,full_name,email,role) select staff,workspace,\"staffActor\",'Owned search overflow',staff::text||'@example.invalid','owner' from "+record,[JSON.stringify(rows)]);
        await db.query("insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,lead_scope,price_per_arrival_minor) select request,workspace,$2,staff,'Owned search overflow','assigned',0 from "+record,[JSON.stringify(rows),profile]);
        await db.query("update public.growth_operator_requests set status='accepted',accepted_at=now() where operator_id=$1",[profile]);
        await assert.rejects(readOperatorLeadSearch(db,{actor}),e=>e.code==='P1242');
      }finally{await db.query('rollback');}
      await db.query('begin');try{
        await db.query("insert into public.lead_stages(workspace_id,stage_key,name,semantic_group) select $1,'qa124_overflow_'||i,'Owned excess choice','new' from generate_series(1,1001) i",[c.workspace]);
        await assert.rejects(readOperatorLeadSearch(db,x,{search:'ӘЛИЯ'}),e=>e.code==='P1242');
      }finally{await db.query('rollback');}
    });
    await t.test('124 corrupted cross-company stage cannot leak its identity/name and nonfinite dates fail closed',async()=>{
      for(const kind of ['stage','date']){await db.query('begin');try{
        if(kind==='stage'){const id=randomUUID();await db.query("insert into public.lead_stages(id,workspace_id,stage_key,name,semantic_group) values($1,$2,'private','PRIVATE_FOREIGN_STAGE','new')",[id,foreign.companies[0].workspace]);await db.query('update public.leads set stage_id=$2 where id=$1',[extra[0],id]);}
        else await db.query("update public.leads set created_at='infinity' where id=$1",[extra[0]]);
        await assert.rejects(readOperatorLeadSearch(db,x,{search:'ӘЛИЯ'}),e=>e.code==='P1242');
      }finally{await db.query('rollback');}}
    });
    await t.test('124 effective browser ACL stays closed and reapplication writes no business row',async()=>{
      for(const role of ['anon','authenticated','service_role'])assert.equal((await one(db,"select has_function_privilege($1,'public.read_growth_operator_lead_search(uuid,text,text,uuid,integer)','EXECUTE') yes",[role])).yes,role==='service_role');
      const before=await snapshot();await db.query(source);assert.equal(await snapshot(),before);
    });
  }finally{await service.end();await cleanupOperatorWorkday(db,x);await cleanupOperatorWorkday(db,foreign);}
}
