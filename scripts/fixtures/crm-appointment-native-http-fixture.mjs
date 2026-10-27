import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { ids, visit } from '../src/appointment-recovery-committed-fixture.ts';

// Actual router/Auth/workspace checks and SQL; only the SDK transport and Auth
// identities are synthetic. No receipt, appointment or authorization result is
// manufactured here. Domain writes must go through the existing atomic RPC.
const rpcArgs = {
  read_crm_appointment_request_v2: ['p_workspace_id','p_staff_user_id','p_auth_user_id','p_actor_role','p_request_key','p_request_fingerprint'],
  create_crm_appointment_v2: ['p_workspace_id','p_staff_user_id','p_auth_user_id','p_actor_role','p_request_key','p_request_fingerprint','p_new_client','p_appointment','p_client_match'],
  patch_crm_appointment_journaled: ['p_workspace_id','p_staff_user_id','p_auth_user_id','p_actor_role','p_appointment_id','p_expected_edit_version','p_before','p_patch','p_journal'],
};
const allowed = new Set(['staff_users','workspace_settings','clients','clinic_doctors','clinic_services','appointments','clinic_doctor_shifts','audit_logs']);
const identifier = value => { assert.match(value,/^[a-z_][a-z0-9_]*$/); return '"'+value+'"'; };
export function appointmentNativeAdapter(fixture) {
  const controls = { calls:[], reads:[], writes:[], beforeRpc:null, beforePatch:null, beforeAppointmentRead:null, errors:[] };
  async function query(sql,args) {
    const db=await fixture.connect();
    try { await db.query('set role service_role'); return await db.query(sql,args); }
    finally { await db.end(); }
  }
  const adapter={
    async rpc(name,args) {
      assert.ok(Object.hasOwn(rpcArgs,name),'No unrelated RPC or synthetic domain implementation');
      const keys=rpcArgs[name];assert.deepEqual(Object.keys(args).sort(),[...keys].sort());
      controls.calls.push({name,args:structuredClone(args)});
      if(controls.beforeRpc)await controls.beforeRpc(name,args);
      if(name==='patch_crm_appointment_journaled'&&controls.beforePatch)await controls.beforePatch();
      try {return {data:(await query(`select public.${name}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) value`,keys.map(key=>args[key]))).rows[0].value,error:null};}
      catch(e){controls.errors.push({name,code:e.code});return {data:null,error:{code:e.code,message:e.code==='23P01'?'appointment_capacity_exceeded':'PRIVATE_NATIVE_APPOINTMENT_SQL'}};}
    },
    from(table) {
      assert.ok(allowed.has(table),'Only bounded CRM appointment dependencies: '+table);
      let fields='*',filters=[],values=[],orders=[],limit=null,insert=null,update=null;
      const q={
        select(columns){fields=columns;assert.ok(fields==='*'||fields.split(',').every(v=>/^[a-z_][a-z0-9_]*$/.test(v.trim())));return q;},
        eq(k,v){return add(k,'=',v);},gte(k,v){return add(k,'>=',v);},lt(k,v){return add(k,'<',v);},lte(k,v){return add(k,'<=',v);},
        in(k,v){assert.ok(Array.isArray(v));assert.ok(v.length<=20);filters.push(v.length?`${identifier(k)} in (${v.map(item=>bind(item)).join(',')})`:'false');return q;},
        ilike(k,v){return add(k,'ilike',v);},
        order(k,options){orders.push(identifier(k)+(options?.ascending===false?' desc':' asc'));return q;},
        limit(n){assert.ok(Number.isInteger(n)&&n>0&&n<=500);limit=n;return q;},
        insert(value){assert.equal(table,'audit_logs','No direct domain writes');assert.equal(insert,null);insert=value;return q;},
        update(value){assert.equal(table,'appointments','Only legacy diagnostic appointment PATCH');assert.equal(update,null);update=value;return q;},
        maybeSingle(){return run(true);},single(){return run(true);},then(resolve,reject){return run(false).then(resolve,reject);},
      };
      function bind(v){values.push(Array.isArray(v)?JSON.stringify(v):v);return '$'+values.length;}
      function add(k,op,v){filters.push(`${identifier(k)} ${op} ${bind(v)}`);return q;}
      async function run(single) {
        assert.ok(insert||filters.length,'No unscoped dependency read');
        if (!insert&&!update&&table==='appointments'&&fields==='*'&&controls.beforeAppointmentRead) await controls.beforeAppointmentRead();
        const projection=fields==='*'?'*':fields.split(',').map(v=>identifier(v.trim())).join(',');
        let sql;
        if(insert){const columns=Object.keys(insert);sql=`insert into public.${identifier(table)} (${columns.map(identifier).join(',')}) values (${columns.map(k=>bind(insert[k])).join(',')}) returning ${projection}`;controls.writes.push({table,columns});}
        else if(update){assert.ok(filters.length);const columns=Object.keys(update);sql=`update public.${identifier(table)} set ${columns.map(k=>identifier(k)+'='+bind(update[k])).join(',')} where ${filters.join(' and ')} returning ${projection}`;
          controls.writes.push({table,columns});if(controls.beforePatch)await controls.beforePatch();}
        else {sql=`select ${projection} from public.${identifier(table)} where ${filters.join(' and ')}${orders.length?' order by '+orders.join(','):''}${limit?' limit '+limit:''}`;controls.reads.push({table,fields});}
        // PostgREST serializes timestamps in PostgreSQL, before a JS Date can
        // discard microseconds. Preimage comparisons must use that real shape.
        const serialized=insert||update?`with owned_projection as (${sql}) select row_to_json(owned_projection) value from owned_projection`
          :`select row_to_json(owned_projection) value from (${sql}) owned_projection`;
        try {const rows=(await query(serialized,values)).rows.map(row=>row.value);assert.ok(!single||rows.length<=1);return {data:single?rows[0]??null:rows,error:null};}
        catch(e){controls.errors.push({table,code:e.code});return {data:null,error:{code:e.code,message:'PRIVATE_NATIVE_APPOINTMENT_QUERY'}};}
      }
      return q;
    },
  };
  return {adapter,controls};
}

export async function provisionAppointmentNative(db,role='owner') {
  const staff=randomUUID(),otherStaff=randomUUID();
  await db.query("insert into workspaces(id,name) values($1,'Owned appointment recovery'),($2,'Owned other workspace')",[ids.workspace,ids.otherWorkspace]);
  await db.query("insert into workspace_settings(workspace_id,key,value) values($1,'clinic_schedule','{\"timeZone\":\"UTC\"}')",[ids.workspace]);
  await db.query("insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role,status) values($1,$2,$3,'Synthetic doctor','owned-a@example.invalid',$4,'active'),($5,$2,$6,'Synthetic other actor','owned-b@example.invalid','admin','active')",[staff,ids.workspace,ids.A,role,otherStaff,ids.B]);
  await db.query("insert into clients(id,workspace_id,full_name,phone,whatsapp) values($1,$2,$3,$4,$4)",[ids.client,ids.workspace,visit.client,visit.phone]);
  await db.query("insert into clinic_doctors(id,workspace_id,staff_user_id,full_name,capacity) values($1,$2,$3,$4,2)",[ids.doctor,ids.workspace,staff,visit.doctor]);
  await db.query("insert into clinic_services(id,workspace_id,doctor_id,name,base_price_minor,duration_minutes) values($1,$2,$3,$4,$5,45)",[ids.service,ids.workspace,ids.doctor,visit.service,visit.priceMinor]);
  await db.query("insert into clinic_doctor_shifts(workspace_id,doctor_id,weekday,is_working,start_minute,end_minute) select $1,$2,n,true,480,1140 from generate_series(1,7)n",[ids.workspace,ids.doctor]);
  return {staff,otherStaff,counts:async()=> (await db.query(`select (select count(*)::int from appointments where workspace_id=$1) appointments,
    (select count(*)::int from clients where workspace_id=$1) clients,(select count(*)::int from crm_appointment_create_requests where workspace_id=$1) receipts,
    (select count(*)::int from audit_logs where workspace_id=$1 and entity_type='appointment') audits`,[ids.workspace])).rows[0],
    async close(){await db.query('delete from workspaces where id in ($1,$2)',[ids.workspace,ids.otherWorkspace]);}};
}

export async function appointmentNativeServer(handler,script='') {
  const controls={mode:'',responses:[],held:[],errors:[],active:new Set()};let origin;
  const server=createServer(async(req,out)=>{
    if(!origin||req.headers.host!==new URL(origin).host){out.writeHead(403).end();return;}
    const url=new URL(req.url,origin);
    if(req.method==='GET'&&url.pathname==='/bundle.js'){out.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'}).end(script);return;}
    if(req.method==='GET'&&url.pathname==='/'){out.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"})
      .end('<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/bundle.js"></script></html>');return;}
    if(req.method==='GET'&&url.pathname==='/favicon.ico'){out.writeHead(204).end();return;}
    if(!['POST','PATCH','DELETE'].includes(req.method)||url.pathname!=='/api/crm/appointments'){out.writeHead(404).end();return;}
    const run=async()=>{
      req.query={path:['appointments'],...Object.fromEntries(url.searchParams)};
      // The real catch-all owns body parsing, Auth and workspace resolution.
      let status=200,body;const headers={};const res={setHeader(k,v){headers[k]=v;return res;},status(v){status=v;return res;},json(v){body=v;return res;},end(v){body=v;return res;}};
      await handler(req,res);const raw=JSON.stringify(body);controls.responses.push({status,body,request:req.body,cache:headers['Cache-Control']});
      const send=()=>{if(!out.destroyed)out.writeHead(status,{...headers,'Content-Type':'application/json'}).end(raw);};
      if(status>=200&&status<300){const mode=controls.mode;controls.mode='';
        if(mode==='hold'){controls.held.push(send);return;}
        if(mode==='drop'){out.writeHead(status,{...headers,'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw)+1});out.flushHeaders();out.write('{"success":');setTimeout(()=>out.destroy(),15).unref();return;}}
      send();
    };
    const task=run().catch(e=>{controls.errors.push(e.stack);if(!out.destroyed)out.writeHead(500).end();});controls.active.add(task);void task.finally(()=>controls.active.delete(task));await task;
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  return {origin,controls,release(){for(const send of controls.held.splice(0))send();},async close(){for(const send of controls.held.splice(0))send();for(const p of [...controls.active])await p;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
