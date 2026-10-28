import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
export const readOperatorWorkday=async(db,x,offset=0)=>(await one(db,'select public.read_growth_operator_workday($1,$2) v',[x.actor,offset])).v;
async function blocked(db,waiter,blocker){for(let i=0;i<200;i++){if((await one(db,'select $1::integer=any(pg_blocking_pids($2::integer)) yes',[blocker,waiter])).yes)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected actual owned operator workday lock wait');}
const business=['workspaces','workspace_settings','staff_users','growth_operator_profiles','growth_operator_requests','growth_operator_lead_assignments','leads','appointments','growth_operator_bookings','growth_operator_arrivals','clinic_doctors','clinic_services','audit_logs','growth_operator_request_commands'];
const snapshot=async db=>JSON.stringify((await db.query('select * from ('+business.map(n=>`select '${n}' t,to_jsonb(r) v from public.${n} r`).join(' union all ')+') q order by t,v::text')).rows);

// Structural, synthetic records inserted as fixture owner. This is NOT an Auth
// signup, commercial agreement, production booking command or payment receipt.
export async function seedOperatorWorkday(db,{companies=25,visits=25,label='OWNED'}={}){
  const x={actor:randomUUID(),profile:randomUUID(),companies:[],appointments:[],noise:[]};
  await db.query("insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at) values($1,$2,$3,'approved',true,$4,now())",[x.profile,x.actor,label,randomUUID()]);
  for(let i=0;i<companies;i++){
    const c={workspace:randomUUID(),request:randomUUID(),staff:randomUUID(),staffActor:randomUUID(),scope:i%2?'clinic':'assigned',zone:i===1?'Asia/Almaty':'UTC',leads:Array.from({length:4},()=>randomUUID()),doctor:randomUUID(),services:[randomUUID(),randomUUID()]};
    x.companies.push(c);
    await db.query('insert into public.workspaces(id,name) values($1,$2)',[c.workspace,label+' company '+i]);
    await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,full_name,email,role) values($1,$2,$3,'Owned clinic owner',$4,'owner')",[c.staff,c.workspace,c.staffActor,c.staff+'@example.invalid']);
    await db.query("insert into public.workspace_settings(workspace_id,key,value) values($1,'clinic_schedule',jsonb_build_object('timeZone',$2::text))",[c.workspace,c.zone]);
    if(i===0)for(let n=0;n<25;n++){const id=randomUUID();x.noise.push(id);
      await db.query("insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,lead_scope,price_per_arrival_minor) values($1,$2,$3,$4,'Synthetic recent non-accepted noise','assigned',0)",[id,c.workspace,x.profile,c.staff]);
      await db.query("update public.growth_operator_requests set status='declined' where id=$1",[id]);
    }
    await db.query("insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,lead_scope,price_per_arrival_minor,created_at) values($1,$2,$3,$4,'Synthetic zero-term read fixture',$5,0,now()-interval '1 year')",[c.request,c.workspace,x.profile,c.staff,c.scope]);
    await db.query("update public.growth_operator_requests set status='accepted',accepted_at=now() where id=$1",[c.request]);
    for(const [j,id]of c.leads.entries()){
      await db.query("insert into public.leads(id,workspace_id,full_name,phone,status,notes) values($1,$2,$3,$4,'in_progress','PRIVATE_LEAD_NOTE')",[id,c.workspace,`${label} permitted lead ${i}/${j}`,'+7000000'+String(i*10+j).padStart(4,'0')]);
      if(j<3)await db.query('insert into public.growth_operator_lead_assignments(operator_request_id,workspace_id,lead_id,assigned,changed_by_staff_user_id) values($1,$2,$3,$4,$5)',[c.request,c.workspace,id,j<2,c.staff]);
    }
    if(i<2){
      await db.query("insert into public.clinic_doctors(id,workspace_id,staff_user_id,full_name) values($1,$2,$3,'Public booked specialist')",[c.doctor,c.workspace,c.staff]);
      for(const[j,id]of c.services.entries())await db.query("insert into public.clinic_services(id,workspace_id,doctor_id,name,base_price_minor,duration_minutes) values($1,$2,$3,$4,0,15)",[id,c.workspace,c.doctor,'Public service '+String.fromCharCode(65+j)]);
    }
  }
  const c=x.companies[0];
  async function visit(company,index,{undated=false,boundary=false}={}){
    const id=randomUUID(),key=randomUUID();x.appointments.push(id);
    const status=['scheduled','confirmed','arrived','no_show','cancelled','PRIVATE_UNKNOWN_STATUS'][index%6];
    const starts=undated?null:(await one(db,"select ((clock_timestamp() at time zone $1)::date::timestamp+make_interval(mins=>$2::integer)) at time zone $1 t",[company.zone,boundary?0:480+index*30])).t;
    await db.query("insert into public.appointments(id,workspace_id,doctor_id,client_name,client_phone,service,doctor_name,starts_at,duration_minutes,status,notes,created_at) values($1,$2,$3,'PRIVATE_APPOINTMENT_CLIENT','+79999999999','PRIVATE_APPOINTMENT_SERVICE','PRIVATE_APPOINTMENT_DOCTOR',$4,15,$5,'PRIVATE_APPOINTMENT_NOTE',now()-interval '10 years')",[id,company.workspace,company.doctor,starts,status]);
    await db.query("insert into public.growth_operator_bookings(request_key,workspace_id,operator_request_id,lead_id,appointment_id,doctor_id,service_ids,starts_local,time_zone,created_at) values($1,$2,$3,$4,$5,$6,$7,'2090-01-01 12:00','UTC',now()-interval '5 years')",[key,company.workspace,company.request,company.leads[0],id,company.doctor,company.services]);
    return id;
  }
  for(let i=0;i<visits;i++)await visit(c,i);
  if(c&&visits){x.undated=await visit(c,visits,{undated:true});x.receipt=randomUUID();await db.query("insert into public.growth_operator_arrivals(id,workspace_id,operator_request_id,appointment_id,clinic_confirmed_by_staff_user_id,clinic_confirmed_at,price_minor,currency) values($1,$2,$3,$4,$5,now()-interval '1 year',0,'KZT')",[x.receipt,c.workspace,c.request,x.appointments[Math.min(3,visits-1)],c.staff]);}
  if(x.companies[1]&&visits)x.boundary=await visit(x.companies[1],0,{boundary:true});
  return x;
}
export async function cleanupOperatorWorkday(db,x){
  const workspaces=x.companies.map(c=>c.workspace);
  for(const table of ['growth_operator_arrivals','growth_operator_bookings','appointments','growth_operator_lead_assignments','audit_logs'])await db.query('delete from public.'+table+' where workspace_id=any($1::uuid[])',[workspaces]);
  await db.query('delete from public.growth_operator_requests where operator_id=$1',[x.profile]);
  for(const table of ['leads','clinic_services','clinic_doctors','workspace_settings','staff_users'])await db.query('delete from public.'+table+' where workspace_id=any($1::uuid[])',[workspaces]);
  await db.query('delete from public.workspaces where id=any($1::uuid[])',[workspaces]);
  await db.query('delete from public.growth_operator_profiles where id=$1',[x.profile]);
}
export async function exerciseOperatorWorkday(db,fixture,source,t){
  await t.test('123 native day bounds reproduce nominal folded-midnight error, then preserve real 23/25-hour and skipped-date boundaries',async()=>{
    for(const zone of [null,'','Not/AZone','UTC;DROP','x'.repeat(81),'CST','EST','CST6CDT','US/Eastern','posix/America/Chicago','right/America/Chicago'])assert.equal((await one(db,'select public.operator_workday_zone($1) v',[zone])).v,null);
    for(const zone of ['UTC','GMT','Etc/GMT+6','Asia/Almaty','America/Havana','America/Chicago'])assert.equal((await one(db,'select public.operator_workday_zone($1) v',[zone])).v,zone);
    const bad=await one(db,"select '2026-11-01'::date::timestamp at time zone 'America/Havana' nominal");
    assert.equal(bad.nominal.toISOString(),'2026-11-01T05:00:00.000Z');
    for(const[day,zone,start,end]of [
      ['2026-11-01','America/Havana','2026-11-01T04:00:00.000Z','2026-11-02T05:00:00.000Z'],
      ['2026-03-08','America/New_York','2026-03-08T05:00:00.000Z','2026-03-09T04:00:00.000Z'],
      ['2026-11-01','America/New_York','2026-11-01T04:00:00.000Z','2026-11-02T05:00:00.000Z'],
      ['2026-09-06','America/Santiago','2026-09-06T04:00:00.000Z','2026-09-07T03:00:00.000Z'],
      ['2026-10-28','Asia/Almaty','2026-10-27T19:00:00.000Z','2026-10-28T19:00:00.000Z'],
      ['2011-12-29','Pacific/Apia','2011-12-29T10:00:00.000Z','2011-12-30T10:00:00.000Z'],
    ]){const got=await one(db,'select public.operator_workday_day_start($1::date,$2) a,public.operator_workday_day_start($1::date+1,$2) b',[day,zone]);assert.equal(got.a.toISOString(),start,day+zone);assert.equal(got.b.toISOString(),end,day+zone);}
  });
  const x=await seedOperatorWorkday(db),foreign=await seedOperatorWorkday(db,{companies:1,visits:1,label:'FOREIGN'}),service=await fixture.connect();
  await service.query('set role service_role');
  try{
    await t.test('123 approved operator with no accepted cooperation has a genuine complete zero, not an access-denial fallback',async()=>{
      const empty=await seedOperatorWorkday(db,{companies:0,visits:0});try{
        const r=await readOperatorWorkday(service,empty);assert.deepEqual(r.companies,[]);assert.equal(r.summary.availableLeads,'0');assert.equal(r.summary.attributedBookings,'0');
        assert.deepEqual(r.today,{state:'ready',total:'0',actionable:'0',items:[],hasMore:false});
      }finally{await cleanupOperatorWorkday(db,empty);}
    });
    await t.test('123 complete accepted companies survive more than a page of newer declined proposals; counts are not service/lead funnel counts',async()=>{
      const before=await snapshot(db),r=await readOperatorWorkday(service,x);
      assert.equal(r.companies.length,25);assert.deepEqual(r.companies.map(c=>c.requestId),x.companies.map(c=>c.request).sort());
      assert.deepEqual({...r.summary,bookingStatuses:undefined},{availableLeads:'74',assignedLeads:'26',clinicLeads:'48',attributedBookings:'27',clinicConfirmedArrivals:'1',undatedBookings:'1',contacts:'not_tracked',bookingStatuses:undefined});
      assert.equal(Object.values(r.summary.bookingStatuses).reduce((s,v)=>s+BigInt(v),0n),27n);
      assert.equal(r.today.total,'26');assert.equal(r.today.items.length,20);assert.equal(r.today.hasMore,true);
      assert.doesNotMatch(JSON.stringify(r),/PRIVATE_|FOREIGN|auth_user_id|workspace_id|notes|price_minor|currency|approved_by/);
      const second=await readOperatorWorkday(service,x,20);assert.equal(second.today.items.length,6);assert.equal(second.today.hasMore,false);assert.deepEqual(second.summary,r.summary);
      const items=[...r.today.items,...second.today.items];assert.equal(new Set(items.map(a=>a.appointmentId)).size,26);
      assert.ok(items.some(a=>a.appointmentId===x.boundary));assert.ok(items.every(a=>a.clientName==='OWNED permitted lead 0/0'||a.clientName==='OWNED permitted lead 1/0'));
      assert.ok(items.every(a=>a.service==='Public service A / Public service B'&&a.doctorName==='Public booked specialist'));
      assert.ok(items.some(a=>a.status==='no_show'&&a.clinicConfirmedAt!==null),'Receipt is separate from current appointment status');
      assert.equal((await readOperatorWorkday(service,foreign)).summary.availableLeads,'2');
      assert.equal(await snapshot(db),before,'Read changes no business row');
    });
    for(const actor of [null,randomUUID()])await t.test('123 missing/foreign nonoperator authority is denied even for empty reads: '+actor,async()=>{await assert.rejects(readOperatorWorkday(service,{actor}),e=>e.code==='P1231');});
    for(const offset of [null,-1,1000001])await t.test('123 query bound is closed: '+offset,async()=>{await assert.rejects(readOperatorWorkday(service,x,offset),e=>e.code==='P1233');});
    await t.test('123 any missing/invalid timezone makes ALL Today unavailable without hiding the independently complete company/stock summary',async()=>{
      const c=x.companies.at(-1);try{for(const value of [null,{}, {timeZone:'Not/AZone'},{timeZone:123},{timeZone:'CST'}]){
        await db.query("update public.workspace_settings set value=$2::jsonb where workspace_id=$1 and key='clinic_schedule'",[c.workspace,JSON.stringify(value)]);
        const r=await readOperatorWorkday(service,x);assert.equal(r.companies.length,25);assert.equal(r.summary.availableLeads,'74');assert.deepEqual(r.today,{state:'unavailable_timezone',total:null,actionable:null,items:[],hasMore:false});
      }}finally{await db.query("update public.workspace_settings set value=jsonb_build_object('timeZone','UTC') where workspace_id=$1 and key='clinic_schedule'",[c.workspace]);}
    });
    await t.test('123 absent schedule row also refuses all Today, without manufacturing a UTC default',async()=>{
      await db.query('begin');try{
        await db.query("delete from public.workspace_settings where workspace_id=$1 and key='clinic_schedule'",[x.companies[0].workspace]);
        const r=await readOperatorWorkday(db,x);assert.equal(r.today.state,'unavailable_timezone');assert.equal(r.today.total,null);assert.equal(r.companies.length,25);
      }finally{await db.query('rollback');}
    });
    await t.test('123 current assignment removal hides all corresponding Today contacts but retains separate own historical attribution/receipt counts',async()=>{
      const c=x.companies[0];try{
        await db.query('select public.set_growth_operator_lead_assignment($1,$2,$3,false)',[c.request,c.leads[0],c.staff]);
        const r=await readOperatorWorkday(service,x);assert.equal(r.summary.availableLeads,'73');assert.equal(r.summary.attributedBookings,'27');assert.equal(r.summary.clinicConfirmedArrivals,'1');
        assert.equal(r.today.total,'1');assert.ok(r.today.items.every(a=>a.requestId!==c.request));assert.doesNotMatch(JSON.stringify(r.today),/OWNED permitted lead 0\/0/);
      }finally{await db.query('select public.set_growth_operator_lead_assignment($1,$2,$3,true)',[c.request,c.leads[0],c.staff]);}
    });
    await t.test('123 inactive original doctor/catalogue cannot fall back to renamed private appointment or directory values',async()=>{
      const c=x.companies[0];try{
        await db.query("update public.clinic_doctors set is_active=false,full_name='PRIVATE_INACTIVE_DOCTOR' where id=$1",[c.doctor]);
        const r=await readOperatorWorkday(service,x);assert.equal(r.today.total,'26');
        assert.ok(r.today.items.filter(a=>a.requestId===c.request).every(a=>a.doctorName===''&&a.service===''));
        assert.doesNotMatch(JSON.stringify(r),/PRIVATE_/);
      }finally{await db.query("update public.clinic_doctors set is_active=true,full_name='Public booked specialist' where id=$1",[c.doctor]);}
    });
    for(const kind of ['nonfinite receipt','cross-workspace booking'])await t.test('123 inconsistent '+kind+' refuses the whole report instead of plausible incomplete totals',async()=>{
      await db.query('begin');try{
        if(kind==='nonfinite receipt')await db.query("update public.growth_operator_arrivals set clinic_confirmed_at='infinity' where id=$1",[x.receipt]);
        else{
          const id=randomUUID(),c=foreign.companies[0];
          await db.query("insert into public.appointments(id,workspace_id,client_name,status) values($1,$2,'PRIVATE_FOREIGN_UNBOOKED','cancelled')",[id,c.workspace]);
          await db.query('update public.growth_operator_bookings set appointment_id=$2 where appointment_id=$1',[x.appointments[0],id]);
        }
        await assert.rejects(readOperatorWorkday(db,x),e=>e.code==='P1232');
      }finally{await db.query('rollback');}
    });
    await t.test('123 old ended cooperation cannot lend historical bookings or assignments to a new accepted request',async()=>{
      const c=x.companies[0],next=randomUUID();await db.query('begin');try{
        await db.query("update public.growth_operator_requests set status='ended',ended_at=clock_timestamp() where id=$1",[c.request]);
        await db.query("insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,lead_scope,price_per_arrival_minor) values($1,$2,$3,$4,'Owned new cooperation','assigned',0)",[next,c.workspace,x.profile,c.staff]);
        await db.query("update public.growth_operator_requests set status='accepted',accepted_at=now() where id=$1",[next]);
        const r=await readOperatorWorkday(db,x);assert.equal(r.companies.length,25);assert.equal(r.summary.attributedBookings,'1');assert.equal(r.summary.clinicConfirmedArrivals,'0');assert.equal(r.today.total,'1');assert.ok(!r.companies.some(q=>q.requestId===c.request));
      }finally{await db.query('rollback');}
    });
    for(const mutation of ['profile','assignment','new acceptance'])await t.test('123 waiting read observes committed '+mutation+' instead of old authority or a partial manifest',async()=>{
      const blocker=await fixture.connect(),writer=await fixture.connect();const c=mutation==='assignment'?x.companies[0]:x.companies.filter(c=>c.scope==='assigned').sort((a,b)=>a.request.localeCompare(b.request))[0];let pending,newRequest,command;
      try{
        await blocker.query('begin');
        if(mutation==='profile')await blocker.query("update public.growth_operator_profiles set status='suspended',accepting_requests=false where id=$1",[x.profile]);
        else await blocker.query('select id from public.growth_operator_requests where id=$1 for update',[c.request]);
        const blockerId=(await one(blocker,'select pg_backend_pid() id')).id,readerId=(await one(service,'select pg_backend_pid() id')).id;
        pending=observed(readOperatorWorkday(service,x));await blocked(db,readerId,blockerId);
        if(mutation==='assignment')await blocker.query('select public.set_growth_operator_lead_assignment($1,$2,$3,false)',[c.request,c.leads[0],c.staff]);
        if(mutation==='new acceptance'){
          const target=randomUUID(),destination=foreign.companies[0];await writer.query("insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,lead_scope,price_per_arrival_minor) values($1,$2,$3,$4,'Owned new proposal','assigned',0)",[target,destination.workspace,x.profile,destination.staff]);newRequest=target;command=randomUUID();
          await writer.query('set role service_role');await writer.query("select public.execute_growth_operator_command_v2($1,$2,$3,'accept')",[command,target,x.actor]);
        }
        await blocker.query('commit');const result=await pending;
        if(mutation==='profile')assert.equal(result.error?.code,'P1231');
        else if(mutation==='new acceptance')assert.equal(result.error?.code,'P1232');
        else{assert.equal(result.error,undefined);if(c.scope==='assigned')assert.ok(result.value.today.items.every(a=>a.requestId!==c.request));}
      }finally{
        await blocker.query('rollback');if(pending)await pending;await blocker.end();await writer.end();
        await db.query("update public.growth_operator_profiles set status='approved',accepting_requests=true where id=$1",[x.profile]);
        await db.query('select public.set_growth_operator_lead_assignment($1,$2,$3,true)',[c.request,c.leads[0],c.staff]);
        if(command)await db.query('delete from public.growth_operator_request_commands where command_id=$1',[command]);
        if(newRequest)await db.query('delete from public.growth_operator_requests where id=$1',[newRequest]);
      }
    });
    await t.test('123 manifest overflow is refused at 1001 actual cooperations, never truncated to a successful first thousand',async()=>{
      const rows=Array.from({length:1001},()=>({workspace:randomUUID(),staff:randomUUID(),staffActor:randomUUID(),request:randomUUID()})),actor=randomUUID(),profile=randomUUID();
      await db.query('begin');try{
        await db.query("insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at) values($1,$2,'Owned overflow','approved',true,$3,now())",[profile,actor,randomUUID()]);
        const record="jsonb_to_recordset($1::jsonb) as x(workspace uuid,staff uuid,\"staffActor\" uuid,request uuid)";
        await db.query("insert into public.workspaces(id,name) select workspace,'Owned overflow' from "+record,[JSON.stringify(rows)]);
        await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,full_name,email,role) select staff,workspace,\"staffActor\",'Owned overflow',staff::text||'@example.invalid','owner' from "+record,[JSON.stringify(rows)]);
        await db.query("insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,lead_scope,price_per_arrival_minor) select request,workspace,$2,staff,'Owned overflow','assigned',0 from "+record,[JSON.stringify(rows),profile]);
        await db.query("update public.growth_operator_requests set status='accepted',accepted_at=now() where operator_id=$1",[profile]);
        await assert.rejects(readOperatorWorkday(db,{actor}),e=>e.code==='P1232');
      }finally{await db.query('rollback');}
    });
    await t.test('123 browser RPCs and private helper stay closed, stronger isolation is unavailable, and reapply is read-only',async()=>{
      for(const role of ['anon','authenticated','service_role']){
        assert.equal((await one(db,"select has_function_privilege($1,'public.operator_workday_day_start(date,text)','EXECUTE') yes",[role])).yes,false);
        assert.equal((await one(db,"select has_function_privilege($1,'public.operator_workday_zone(text)','EXECUTE') yes",[role])).yes,false);
        assert.equal((await one(db,"select has_function_privilege($1,'public.read_growth_operator_workday(uuid,integer)','EXECUTE') yes",[role])).yes,role==='service_role');
      }
      await service.query('begin isolation level repeatable read');try{await assert.rejects(readOperatorWorkday(service,x),e=>e.code==='P1232');}finally{await service.query('rollback');}
      const before=await snapshot(db);await db.query(source);assert.equal(await snapshot(db),before);
    });
  }finally{await service.end();await cleanupOperatorWorkday(db,x);await cleanupOperatorWorkday(db,foreign);}
}
