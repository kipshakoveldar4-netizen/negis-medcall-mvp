import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { readReviewedChain } from './migration-chain-review.mjs';
import { partnerEntryHttpFixture,stopPartnerEntryBuilds } from './partner-entry-http-fixture.mjs';
import { telegramScenario,ADMIT,ADVANCE,hash } from './telegram-delivery-cases.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const bot='synthetic-recipient-only';
const signatures={
  admit_content_telegram_delivery:[ADMIT,['p_workspace_id','p_staff_user_id','p_auth_user_id','p_video_id','p_package_version','p_kind','p_dispatch_id','p_recipient_sha256','p_manifest']],
  advance_content_telegram_delivery:[ADVANCE,['p_workspace_id','p_staff_user_id','p_auth_user_id','p_video_id','p_package_version','p_kind','p_dispatch_id','p_part_index','p_part_sha256','p_acknowledgement_sha256']],
};
const ident=value=>{assert.match(value,/^[a-z_][a-z0-9_]*$/);return '"'+value+'"';};
function adapter(fixture){
  const calls=[];
  async function query(sql,args){const db=await fixture.connect();try{await db.query('set role service_role');return await db.query(sql,args);}finally{await db.end();}}
  return {calls,client:{
    async rpc(name,args){
      assert.ok(Object.hasOwn(signatures,name),'No unrelated RPC');const[sql,keys]=signatures[name];
      assert.deepEqual(Object.keys(args).sort(),[...keys].sort());calls.push({name,args:structuredClone(args)});
      try{return{data:(await query(sql,keys.map(key=>key==='p_manifest'?JSON.stringify(args[key]):args[key]))).rows[0].result,error:null};}
      catch(error){return{data:null,error:{code:error.code,message:'OWNED_PRIVATE_SQL_DIAGNOSTIC'}};}
    },
    from(table){
      assert.ok(['staff_users','workspace_settings'].includes(table),'Only scoped authorization reads');
      let columns='*';const filters=[],values=[];
      const bind=value=>{values.push(value);return '$'+values.length;};
      const run=async single=>{
        assert.ok(filters.length,'No unscoped read');const fields=columns==='*'?'*':columns.split(',').map(v=>ident(v.trim())).join(',');
        const rows=(await query(`select ${fields} from public.${ident(table)} where ${filters.join(' and ')}`,values)).rows;
        assert.ok(!single||rows.length<=1);return{data:single?rows[0]??null:rows,error:null};
      };
      const q={select(value){columns=value;return q;},eq(key,value){filters.push(ident(key)+'='+bind(value));return q;},
        in(key,value){assert.ok(Array.isArray(value)&&value.length<=20);filters.push(value.length?ident(key)+' in ('+value.map(bind).join(',')+')':'false');return q;},
        maybeSingle(){return run(true);},then(resolve,reject){return run(false).then(resolve,reject);}};
      return q;
    },
  }};
}
async function server(handler){
  let origin;const active=new Set(),errors=[];
  const instance=createServer((req,out)=>{
    const work=(async()=>{
      if(!origin||req.headers.host!==new URL(origin).host||req.method!=='POST'){out.writeHead(404).end();return;}
      const url=new URL(req.url,origin);if(url.pathname!=='/api/content-studio/send-telegram'){out.writeHead(404).end();return;}
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>65536){out.writeHead(413).end();return;}chunks.push(chunk);}
      req.query={path:['send-telegram'],...Object.fromEntries(url.searchParams)};req.body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let status=200,body;const headers={};const res={status(value){status=value;return res;},setHeader(key,value){headers[key]=value;return res;},
        json(value){body=value;return res;},end(value){body=value;return res;}};
      await handler(req,res);out.writeHead(status,headers).end(JSON.stringify(body));
    })().catch(error=>{errors.push(error.stack);if(!out.destroyed)out.writeHead(500).end();});
    active.add(work);void work.finally(()=>active.delete(work));
  });
  await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+instance.address().port;
  return{origin,errors,async close(){await Promise.all([...active]);instance.closeAllConnections();await new Promise(resolve=>instance.close(resolve));}};
}
const lookup=(id=-100123)=>new Response(JSON.stringify({ok:true,result:{id,type:'supergroup',username:'OwnedQa'}}));
const ack=(id,text,n)=>new Response(JSON.stringify({ok:true,result:{message_id:n,date:1,chat:{id,username:'OwnedQa'},text}}));

test('canonical Telegram recipient through complete HTTP/Auth/workspace/adapter/native SQL',{timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1');t.after(stopPartnerEntryBuilds);
  const chain=await readReviewedChain(path.join(root,'migrations')),fixture=await startNativePostgres();t.after(()=>fixture.close());
  const db=await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
    alter table storage.objects enable row level security;`);
  for(const entry of chain)await db.query(entry.source);
  async function owned(chatId,provider,existing){
    const f=existing??await telegramScenario(db),transport=adapter(fixture),requests=[];
    const http=await partnerEntryHttpFixture(transport.client,{entrypoint:'content-studio',approved:false,
      identities:new Map([['owned.owner.signature',f.auth]]),env:{TELEGRAM_BOT_TOKEN:bot,TELEGRAM_CHAT_ID:chatId,MEDINA_PARTNER_ENTRY_ENABLED:'false'},
      telegramFetch:async(url,init)=>{requests.push({method:url.split('/').at(-1),payload:JSON.parse(init.body)});return provider(url,init,f);}});
    const listener=await server(http.handler);
    return{...f,requests,transport,async send(authorization='Bearer owned.owner.signature'){
      const response=await fetch(listener.origin+'/api/content-studio/send-telegram?workspaceId='+f.workspace,{method:'POST',headers:{'Content-Type':'application/json',...(authorization?{authorization}:{})},
        body:JSON.stringify({id:f.video,updatedAt:f.version,...f.manifest.snapshot})});
      assert.match(response.headers.get('cache-control')??'',/private.*no-store/);
      return{status:response.status,body:await response.json()};},
      async close(){await listener.close();http.close();assert.deepEqual(listener.errors,[]);assert.deepEqual(http.state.unexpected,[]);
        if(!existing)await db.query('delete from workspaces where id=$1',[f.workspace]);}};
  }
  await t.test('long alias package pins all parts; another device replays without another content send',async()=>{
    let sends=0,lookups=0,other;const provider=async(url,init)=>{
      const body=JSON.parse(init.body);if(url.endsWith('/getChat')){lookups++;assert.deepEqual(body,{chat_id:'@OwnedQa'});return lookup();}
      sends++;assert.equal(body.chat_id,'-100123');return ack(Number(body.chat_id),body.text,sends);
    };const f=await owned('@OwnedQa',provider);
    try{
      f.manifest.snapshot.script='Owned long package '.repeat(700);await db.query('update content_videos set script=$2 where id=$1',[f.video,f.manifest.snapshot.script]);
      const first=await f.send();assert.equal(first.status,200,JSON.stringify(first.body));assert.ok(sends>1);
      const count=sends;other=await owned('@OwnedQa',provider,f);
      const second=await other.send();assert.equal(second.status,200);assert.equal(second.body.data.replayed,true);assert.equal(sends,count);assert.equal(lookups,2);
      assert.deepEqual(other.requests.map(item=>item.method),['getChat']);assert.deepEqual(other.transport.calls.map(item=>item.name),['admit_content_telegram_delivery']);
      const state=await f.state();assert.equal(state.length,1);assert.equal(state[0].status,'succeeded');
      assert.equal(state[0].recipient_sha256,hash(JSON.stringify(['telegram-recipient-v1',bot,'-100123'])));
      assert.equal(state[0].acknowledgements.length,count);
    }finally{await other?.close();await f.close();}
  });
  await t.test('two independent HTTP/Auth runtimes cannot dispatch concurrently after resolving the same alias',async()=>{
    let sends=0,release,started,other,first;
    const held=new Promise(resolve=>{release=resolve;}),begun=new Promise(resolve=>{started=resolve;});
    const provider=async(url,init)=>{
      if(url.endsWith('/getChat'))return lookup();
      sends++;if(sends===1){started();await held;}const body=JSON.parse(init.body);return ack(Number(body.chat_id),body.text,sends);
    };
    const f=await owned('@OwnedQa',provider);
    try{
      other=await owned('@OwnedQa',provider,f);first=f.send();
      await Promise.race([begun,first.then(value=>{throw Error('First request ended before the controlled provider boundary: '+value.status);})]);
      const blocked=await other.send();assert.equal(blocked.status,409);assert.equal(blocked.body.code,'telegram_delivery_quarantined');assert.equal(sends,1);
      release();assert.equal((await first).status,200);assert.equal(sends,1);
      const state=await f.state();assert.equal(state.length,1);assert.equal(state[0].status,'succeeded');assert.equal(state[0].acknowledgements.length,1);
    }finally{release();await first;await other?.close();await f.close();}
  });
  await t.test('revocation after real HTTP authorization but during lookup denies before admission/content',async()=>{
    const f=await owned('@OwnedQa',async(url,_init,current)=>{assert.ok(url.endsWith('/getChat'));
      await db.query("update staff_users set role='lead_manager' where id=$1",[current.staff]);return lookup();});
    try{const result=await f.send();assert.equal(result.status,403,JSON.stringify(result.body));assert.equal(result.body.code,'telegram_delivery_access_denied');
      assert.equal(f.requests.length,1);assert.deepEqual(await f.state(),[]);assert.equal(f.transport.calls.length,1);
    }finally{await f.close();}
  });
  await t.test('failed lookup proves this request is unsent and a later explicit retry can deliver once',async()=>{
    let healthy=false,sends=0;const f=await owned('@OwnedQa',async(url,init)=>{
      if(url.endsWith('/getChat'))return healthy?lookup():new Response('OWNED_PRIVATE_LOOKUP_FAILURE',{status:503});
      const body=JSON.parse(init.body);return ack(Number(body.chat_id),body.text,++sends);
    });
    try{
      const failed=await f.send();assert.equal(failed.status,503);assert.equal(failed.body.code,'telegram_recipient_unconfirmed');
      assert.deepEqual(failed.body.data,{sent:false,phase:'recipient_lookup'});assert.deepEqual(await f.state(),[]);
      assert.deepEqual(f.transport.calls,[]);assert.equal(sends,0);assert.equal(f.requests.length,1);
      assert.equal(JSON.stringify(failed.body).includes('OWNED_PRIVATE_LOOKUP_FAILURE'),false);
      healthy=true;const retried=await f.send();assert.equal(retried.status,200);assert.equal(retried.body.data.replayed,false);
      assert.equal(sends,1);assert.equal((await f.state()).length,1);
    }finally{await f.close();}
  });
  await t.test('changed numeric identity on retry cannot rebind an already sent package',async()=>{
    let lookups=0,sends=0;const f=await owned('@OwnedQa',async(url,init)=>{
      if(url.endsWith('/getChat'))return lookup(++lookups===1?-100123:-100456);
      const body=JSON.parse(init.body);return ack(Number(body.chat_id),body.text,++sends);
    });
    try{assert.equal((await f.send()).status,200);const before=await f.state();const retry=await f.send();assert.equal(retry.status,409);
      assert.equal(retry.body.code,'telegram_delivery_conflict');assert.equal(sends,1);assert.deepEqual(await f.state(),before);
    }finally{await f.close();}
  });
  await t.test('a same-username acknowledgement from another numeric chat is quarantined',async()=>{
    let sends=0;const f=await owned('@OwnedQa',async(url,init)=>url.endsWith('/getChat')?lookup():ack(-100456,JSON.parse(init.body).text,++sends));
    try{assert.equal((await f.send()).status,502);const state=await f.state();assert.equal(state[0].in_flight,0);assert.deepEqual(state[0].acknowledgements,[]);
      assert.equal((await f.send()).status,409);assert.equal(sends,1);
    }finally{await f.close();}
  });
  await t.test('old alias-based receipt is preserved for review, never adopted as numeric or resent',async()=>{
    const f=await owned('@OwnedQa',async url=>{assert.ok(url.endsWith('/getChat'));return lookup();});
    try{await f.admit({7:hash(JSON.stringify(['telegram-recipient-v1',bot,'@OwnedQa']))});const before=await f.state();
      const result=await f.send();assert.equal(result.status,409);assert.equal(result.body.code,'telegram_delivery_conflict');assert.deepEqual(await f.state(),before);
      assert.deepEqual(f.requests.map(item=>item.method),['getChat']);
    }finally{await f.close();}
  });
  await t.test('anonymous/invalid Auth and a current lead manager cannot even look up the recipient',async()=>{
    const f=await owned('@OwnedQa',async()=>{throw Error('No lookup allowed');});
    try{for(const token of ['', 'Bearer owned.invalid.signature'])assert.equal((await f.send(token)).status,401);
      await db.query("update staff_users set role='lead_manager' where id=$1",[f.staff]);assert.equal((await f.send()).status,403);
      assert.deepEqual(f.requests,[]);assert.deepEqual(f.transport.calls,[]);assert.deepEqual(await f.state(),[]);
    }finally{await f.close();}
  });
  for(const table of ['workspaces','staff_users','content_videos','content_telegram_deliveries','content_telegram_delivery_guards'])
    assert.equal((await db.query('select count(*)::int n from public.'+table)).rows[0].n,0,table);
  assert.deepEqual((await readReviewedChain(path.join(root,'migrations'))).map(row=>[row.file,row.sha256]),chain.map(row=>[row.file,row.sha256]));
  t.diagnostic('Full compiled handler and owned HTTP/native SQL; Auth identity, SDK transport and Telegram are explicit doubles. No provider, real Auth, cloud, paid generation or financial action.');
});
