import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Script } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
// @ts-expect-error Owned executable SQL fixture has no declaration file.
import { ADMIT, ADVANCE, setupTelegramDatabase, telegramScenario, telegramSqlCases } from "../fixtures/telegram-delivery-cases.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
// Keep scripts' isolated rootDir while executing the actual API adapter.
const delivery=await import(pathToFileURL(path.join(root,"lib/crm/telegram-delivery.ts")).href) as {
  TelegramDeliveryError:new(status:number,code:string)=>Error;
  telegramDeliveryHash(value:string):string;
  resolveTelegramRecipient(input:Row):Promise<string>;
  admitTelegramDelivery(input:{actor:{workspaceId:string;staffUserId:string;userId:string};payload:Row;isTest:boolean;
    packageText:string;parts:string[];token:string;chatId:string},client:SupabaseClient):Promise<unknown>;
  beginTelegramDeliveryPart(value:unknown,index:number):Promise<void>;
  acknowledgeTelegramDeliveryPart(value:unknown,index:number,hash:string):Promise<void>;
};
type Row=Record<string,unknown>;
type Fixture={workspace:string;staff:string;auth:string;video:string;version:string;manifest:{snapshot:Row;text:string;parts:string[]}};
type Handler=(req:{body:Row},res:ReturnType<typeof response>,context:Row)=>Promise<void>;
function response() {
  return {code:0,body:{} as Row,status(code:number){this.code=code;return this;},setHeader(){return this;},json(body:Row){this.body=JSON.parse(JSON.stringify(body));}};
}
async function handler(db:PGlite, options: { fetch?:(url:string,init:{body:string})=>Promise<unknown>; rpc?:(name:string,args:Row)=>Promise<unknown>; configured?:boolean; chatId?:string }={}) {
  const ts=createRequire(path.join(root,"package.json"))("typescript") as typeof import("typescript");
  const select=async(file:string,names:string[])=>{
    const text=await readFile(path.join(root,file),"utf8"), ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    return ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text||""))
      .map(node=>node.getText(ast)).join("\n");
  };
  const source=await select("lib/content-studio/core.ts",["telegramPackageText"])+"\n"+
    await select("api/content-studio/[...path].ts",["sendJson","readBody","splitLongText","splitTelegramMessage","telegramHint","readTelegramBody","sendTelegramMessage","handleSendTelegram"])+"\nexports.handler=handleSendTelegram;";
  const calls:{url:string;body:Row}[]=[], writes:Row[]=[];
  let n=0;
  const sqlRpc=async(name:string,args:Row)=>{
    try {
      const keys=name==="admit_content_telegram_delivery"
        ? ["p_workspace_id","p_staff_user_id","p_auth_user_id","p_video_id","p_package_version","p_kind","p_dispatch_id","p_recipient_sha256","p_manifest"]
        : ["p_workspace_id","p_staff_user_id","p_auth_user_id","p_video_id","p_package_version","p_kind","p_dispatch_id","p_part_index","p_part_sha256","p_acknowledgement_sha256"];
      const values=keys.map(key=>key==="p_manifest"?JSON.stringify(args[key]):args[key]);
      const result=await db.query<{result:unknown}>(name==="admit_content_telegram_delivery"?ADMIT:ADVANCE,values);
      return {data:result.rows[0]?.result,error:null};
    } catch(error) {return {data:null,error:{code:(error as {code?:string}).code}};}
  };
  const client={rpc:options.rpc ?? sqlRpc} as unknown as SupabaseClient;
  const exported={} as {handler:Handler};
  new Script(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText).runInNewContext({
    exports:exported,
    TelegramDeliveryError:delivery.TelegramDeliveryError,
    telegramDeliveryHash:delivery.telegramDeliveryHash,
    resolveTelegramRecipient:delivery.resolveTelegramRecipient,
    beginTelegramDeliveryPart:delivery.beginTelegramDeliveryPart,
    acknowledgeTelegramDeliveryPart:delivery.acknowledgeTelegramDeliveryPart,
    admitTelegramDelivery:(input:Parameters<typeof delivery.admitTelegramDelivery>[0])=>delivery.admitTelegramDelivery(input,client),
    process:{env:options.configured===false?{}:{TELEGRAM_BOT_TOKEN:"synthetic-not-real",TELEGRAM_CHAT_ID:options.chatId??"-100123"}},
    async fetch(url:string,init:{body:string}) {
      calls.push({url,body:JSON.parse(init.body)});n++;
      if(options.fetch) return options.fetch(url,init);
      return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,result:{message_id:n,date:100,chat:{id:-100123},text:JSON.parse(init.body).text}})};
    },
    async persistContentVideoPatchIfAvailable(input:Row) {writes.push(JSON.parse(JSON.stringify(input)));return false;},updateContentVideo(){throw Error("No unconfirmed local update");},
  });
  return {calls,writes,sqlRpc,async send(f:Fixture,body:Row={}) {
    const res=response();await exported.handler({body:{id:f.video,updatedAt:f.version,...f.manifest.snapshot,...body}},res,
      {workspaceId:f.workspace,staffUserId:f.staff,userId:f.auth});return res;
  }};
}

test("097 SQL behavior in owned embedded PostgreSQL (not a native lock proof)",{timeout:180000},async t=>{
  const db=new PGlite();t.after(()=>db.close());await setupTelegramDatabase(db,true);await telegramSqlCases(t,db);
});
test("actual API uses durable SQL for inter-device delivery, receipt loss and no-dispatch boundaries",{timeout:180000},async t=>{
  const db=new PGlite();t.after(()=>db.close());await setupTelegramDatabase(db,true);
  await t.test("a mutable username resolves once and cannot split one package across numeric chat identities",async()=>{
    const f=await telegramScenario(db) as Fixture;
    f.manifest.snapshot.script='Owned long package '.repeat(700);
    await db.query('update public.content_videos set script=$2 where id=$1',[f.video,f.manifest.snapshot.script]);
    let lookups=0,sends=0;const recipients:number[]=[];
    const a=await handler(db,{chatId:'@OwnedQa',fetch:async(url,init)=>{
      const payload=JSON.parse(init.body);
      if(url.endsWith('/getChat')){lookups++;assert.deepEqual(payload,{chat_id:'@OwnedQa'});
        return new Response(JSON.stringify({ok:true,result:{id:-100123,type:'supergroup',username:'OwnedQa'}}));}
      assert.ok(url.endsWith('/sendMessage'));sends++;
      const recipient=payload.chat_id==='@OwnedQa'?(sends===1?-100123:-100456):Number(payload.chat_id);
      recipients.push(recipient);
      return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,result:{message_id:sends,date:1,
        chat:{id:recipient,username:'OwnedQa'},text:payload.text}})};
    }});
    const result=await a.send(f);assert.equal(result.code,200,JSON.stringify(result.body));assert.ok(sends>1);
    assert.deepEqual([...new Set(recipients)],[-100123],'One package must never follow a renamed username into a second chat');
    assert.equal(lookups,1);assert.ok(a.calls.slice(1).every(call=>call.body.chat_id==='-100123'));
    const ledger=await db.query<{recipient_sha256:string}>("select recipient_sha256 from content_telegram_deliveries where workspace_id=$1",[f.workspace]);
    assert.equal(ledger.rows[0]!.recipient_sha256,delivery.telegramDeliveryHash(JSON.stringify(['telegram-recipient-v1','synthetic-not-real','-100123'])));
  });
  await t.test("two independent handlers only dispatch once; status-only version bump also replays",async()=>{
    const f=await telegramScenario(db) as Fixture,a=await handler(db),b=await handler(db);
    const first=await a.send(f);assert.equal(first.code,200);assert.equal((first.body.data as Row).sent,true);
    assert.equal((await b.send(f)).code,200);assert.equal(a.calls.length,1);assert.equal(b.calls.length,0);
    await db.query("update public.content_videos set updated_at='2090-10-25T08:00:02.654321Z' where id=$1",[f.video]);
    assert.equal((await b.send(f,{updatedAt:'2090-10-25T08:00:02.654321Z'})).code,200);assert.equal(b.calls.length,0);
  });
  await t.test("concurrent device blocked while first fake provider call is pending",async()=>{
    const f=await telegramScenario(db) as Fixture;
    let release!:()=>void,started!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;}),begun=new Promise<void>(resolve=>{started=resolve;});
    const a=await handler(db,{fetch:async(_url,init)=>{started();await wait;return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,result:{message_id:1,date:1,chat:{id:-100123},text:JSON.parse(init.body).text}})};}});
    const first=a.send(f);await begun;const b=await handler(db),second=await b.send(f);
    assert.equal(second.code,409);assert.equal(second.body.code,'telegram_delivery_quarantined');assert.equal(b.calls.length,0);
    release();assert.equal((await first).code,200);assert.equal(a.calls.length,1);
  });
  for(const outcome of ['network','provider refusal','wrong recipient','wrong text','invalid acknowledgement','body failure'] as const) {
    await t.test(`${outcome} remains quarantined across devices without automatic resend`,async()=>{
      const f=await telegramScenario(db) as Fixture;
      const a=await handler(db,{fetch:async(_url,init)=>{
        if(outcome==='network')throw Error('secret marker must never escape');
        if(outcome==='provider refusal')return {ok:false,status:403,text:async()=>JSON.stringify({ok:false,error_code:403,description:'sensitive details'})};
        if(outcome==='body failure')return {ok:true,status:200,text:async()=>{throw Error('sensitive body');}};
        const body={message_id:outcome==='invalid acknowledgement'?null:1,date:1,chat:{id:outcome==='wrong recipient'?-999:-100123},text:outcome==='wrong text'?'wrong':JSON.parse(init.body).text};
        return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,result:body})};
      }});
      assert.equal((await a.send(f)).code,502);
      const b=await handler(db);assert.equal((await b.send(f)).code,409);assert.equal(b.calls.length,0);assert.equal(a.calls.length,1);
      assert.doesNotMatch(JSON.stringify((await b.send(f)).body),/synthetic-not-real|-100123|sensitive|secret marker/);
    });
  }
  await t.test("missing schema is a denial before any external call",async()=>{
    const f=await telegramScenario(db) as Fixture,a=await handler(db,{rpc:async()=>({data:null,error:{code:'PGRST202'}})});
    assert.equal((await a.send(f)).code,503);assert.equal(a.calls.length,0);
  });
  await t.test("lost admission ACK never dispatches or retries",async()=>{
    const f=await telegramScenario(db) as Fixture;let attempts=0;
    const a=await handler(db,{rpc:async(name,args)=>{
      attempts++;assert.equal(name,'admit_content_telegram_delivery');
      await db.query(ADMIT,[args.p_workspace_id,args.p_staff_user_id,args.p_auth_user_id,args.p_video_id,args.p_package_version,args.p_kind,args.p_dispatch_id,args.p_recipient_sha256,JSON.stringify(args.p_manifest)]);
      throw Error('lost ACK');
    }});
    assert.equal((await a.send(f)).code,503);assert.equal(a.calls.length,0);assert.equal(attempts,1);
    assert.equal((await (await handler(db)).send(f)).code,409);
  });
  for(const lost of ['start','intermediate ACK','final ACK'] as const) {
    await t.test(`${lost} lost after durable commit cannot repeat an external part`,async()=>{
      const f=await telegramScenario(db) as Fixture;
      if(lost==='intermediate ACK') {
        f.manifest.snapshot.script='X'.repeat(7000);
        await db.query('update public.content_videos set script=$2 where id=$1',[f.video,f.manifest.snapshot.script]);
      }
      const real=await handler(db);let faulted=false;
      const a=await handler(db,{rpc:async(name,args)=>{
        const result=await real.sqlRpc(name,args);
        if(name==='advance_content_telegram_delivery' && !faulted
          && (lost==='start'?args.p_acknowledgement_sha256===null:args.p_acknowledgement_sha256!==null)) {
          faulted=true;throw Error('lost committed receipt');
        }
        return result;
      }});
      const response=await a.send(f);assert.equal(response.code,503);assert.equal(faulted,true);
      assert.equal(a.calls.length,lost==='start'?0:1);
      const b=await handler(db),retry=await b.send(f);assert.equal(retry.code,lost==='final ACK'?200:409);assert.equal(b.calls.length,0);
    });
  }
  await t.test("uncommitted part ACK failure retains the in-flight fence without retry",async()=>{
    const f=await telegramScenario(db) as Fixture,real=await handler(db);let receipts=0;
    const a=await handler(db,{rpc:async(name,args)=>{
      if(name==='advance_content_telegram_delivery' && args.p_acknowledgement_sha256!==null) {
        receipts++;return {data:null,error:{code:'08006'}};
      }
      return real.sqlRpc(name,args);
    }});
    assert.equal((await a.send(f)).code,503);assert.equal(receipts,1);assert.equal(a.calls.length,1);
    const b=await handler(db);assert.equal((await b.send(f)).code,409);assert.equal(b.calls.length,0);
    const {rows}=await db.query<{in_flight:number;acknowledgements:unknown[]}>('select in_flight,acknowledgements from public.content_telegram_deliveries where workspace_id=$1',[f.workspace]);
    assert.equal(rows[0]!.in_flight,0);assert.equal(rows[0]!.acknowledgements.length,0);
  });
  await t.test("second part rejection retains first receipt and unknown part; no third part or status write",async()=>{
    const f=await telegramScenario(db) as Fixture;f.manifest.snapshot.script='Y'.repeat(8000);
    await db.query('update public.content_videos set script=$2 where id=$1',[f.video,f.manifest.snapshot.script]);let n=0;
    const a=await handler(db,{fetch:async(_url,init)=>{
      n++;return n===1?{ok:true,status:200,text:async()=>JSON.stringify({ok:true,result:{message_id:1,date:1,chat:{id:-100123},text:JSON.parse(init.body).text}})}
        :{ok:false,status:429,text:async()=>JSON.stringify({ok:false,error_code:429})};
    }});
    const res=await a.send(f);assert.equal(res.code,502);assert.equal(res.body.part,2);assert.equal(a.calls.length,2);assert.equal(a.writes.length,0);
    const {rows}=await db.query<{acknowledgements:unknown[];in_flight:number}>('select acknowledgements,in_flight from public.content_telegram_deliveries where workspace_id=$1',[f.workspace]);
    assert.equal(rows[0]!.acknowledgements.length,1);assert.equal(rows[0]!.in_flight,1);
    const b=await handler(db);assert.equal((await b.send(f)).code,409);assert.equal(b.calls.length,0);
  });
  await t.test("duplicate provider message identity cannot falsely acknowledge a long package",async()=>{
    const f=await telegramScenario(db) as Fixture;f.manifest.snapshot.script='D'.repeat(8000);
    await db.query('update public.content_videos set script=$2 where id=$1',[f.video,f.manifest.snapshot.script]);
    const a=await handler(db,{fetch:async(_url,init)=>({ok:true,status:200,text:async()=>JSON.stringify({ok:true,result:{message_id:1,date:1,chat:{id:-100123},text:JSON.parse(init.body).text}})})});
    assert.equal((await a.send(f)).code,409);assert.equal(a.calls.length,2);assert.equal(a.writes.length,0);
    const b=await handler(db);assert.equal((await b.send(f)).code,409);assert.equal(b.calls.length,0);
  });
  await t.test("revocation during the fake external call blocks receipt ACK and leaves durable uncertainty",async()=>{
    const f=await telegramScenario(db) as Fixture;
    const a=await handler(db,{fetch:async(_url,init)=>{
      await db.query("update public.staff_users set status='inactive' where id=$1",[f.staff]);
      return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,result:{message_id:1,date:1,chat:{id:-100123},text:JSON.parse(init.body).text}})};
    }});
    assert.equal((await a.send(f)).code,403);assert.equal(a.calls.length,1);
    const b=await handler(db);assert.equal((await b.send(f)).code,403);assert.equal(b.calls.length,0);
    await db.query("update public.staff_users set status='active' where id=$1",[f.staff]);
    assert.equal((await b.send(f)).code,409);assert.equal(b.calls.length,0);
  });
  await t.test("existing final package CAS receives its unrounded six-digit token",async()=>{
    const f=await telegramScenario(db) as Fixture,a=await handler(db);
    assert.equal((await a.send(f,{videoId:f.video,expectedUpdatedAt:f.version})).code,200);
    assert.deepEqual(a.writes,[{videoId:f.video,workspaceId:f.workspace,patch:{status:'telegram_ready'},expectedUpdatedAt:f.version}]);
    assert.equal(a.calls.length,1);
  });
  await t.test("canonical SQL snapshot agrees with the actual formatter for every field, Unicode and hashtags",async()=>{
    const f=await telegramScenario(db) as Fixture;
    const fields={title:'Synthetic 🧪 title',hook:'First\nSecond',script:'Body\n\nwith blocks',voiceover:'Voice',cta:'CTA',caption:'Caption',hashtags:['#fixture','#тест'],avatarPrompt:'Avatar',tapnowPrompt:'TapNow'};
    f.manifest.snapshot=fields;
    await db.query(`update public.content_videos set title=$2,hook=$3,script=$4,voiceover=$5,cta=$6,caption=$7,hashtags=$8::jsonb,avatar_prompt=$9,tapnow_prompt=$10 where id=$1`,
      [f.video,fields.title,fields.hook,fields.script,fields.voiceover,fields.cta,fields.caption,JSON.stringify(fields.hashtags),fields.avatarPrompt,fields.tapnowPrompt]);
    const a=await handler(db);assert.equal((await a.send(f)).code,200);assert.equal(a.calls.length,1);
    assert.match(String(a.calls[0]!.body.text),/#fixture #тест/);
  });
  await t.test("package edits between parts stop dispatch before sending the stale next part",async()=>{
    const f=await telegramScenario(db) as Fixture;f.manifest.snapshot.script='Z'.repeat(7000);
    await db.query('update public.content_videos set script=$2 where id=$1',[f.video,f.manifest.snapshot.script]);
    const a=await handler(db,{fetch:async(_url,init)=>{
      await db.query("update public.content_videos set updated_at='2090-10-25T08:00:00.123457Z' where id=$1",[f.video]);
      return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,result:{message_id:1,date:1,chat:{id:-100123},text:JSON.parse(init.body).text}})};
    }});
    assert.equal((await a.send(f)).code,409);assert.equal(a.calls.length,1);assert.equal(a.writes.length,0);
    const b=await handler(db);assert.equal((await b.send(f)).code,409);assert.equal(b.calls.length,0);
  });
  await t.test("malformed package/version denied; blank configuration stays explicitly unsent",async()=>{
    const f=await telegramScenario(db) as Fixture,a=await handler(db);
    for(const body of [{updatedAt:'bad'},{id:'bad'},{title:123},{hashtags:[{}]}]) {
      assert.equal((await a.send(f,body)).code,400);
    }
    assert.equal(a.calls.length,0);
    const b=await handler(db,{configured:false}),res=await b.send(f);
    assert.equal(res.code,200);assert.equal((res.body.data as Row).sent,false);assert.equal(b.calls.length,0);
  });
  await t.test("test-button first intent pings, exact replay is historical, new manual intent pings again",async()=>{
    const f=await telegramScenario(db) as Fixture,a=await handler(db),b=await handler(db);
    const firstId=randomUUID(),secondId=randomUUID();
    const first=await a.send(f,{test:true,testRequestId:firstId});assert.equal(first.code,200);
    assert.equal((first.body.data as Row).replayed,false);assert.equal((first.body.data as Row).testRequestId,firstId);
    const replay=await b.send(f,{test:true,testRequestId:firstId});assert.equal(replay.code,200);
    assert.equal((replay.body.data as Row).replayed,true);assert.equal(b.calls.length,0);
    const second=await b.send(f,{test:true,testRequestId:secondId});assert.equal(second.code,200);
    assert.equal((second.body.data as Row).replayed,false);assert.equal((second.body.data as Row).testRequestId,secondId);
    assert.equal(a.calls.length,1);assert.equal(b.calls.length,1);
  });
  await t.test("new manual intent detects a blocked bot instead of replaying an older successful test",async()=>{
    const f=await telegramScenario(db) as Fixture,a=await handler(db),firstId=randomUUID(),newId=randomUUID();
    assert.equal((await a.send(f,{test:true,testRequestId:firstId})).code,200);
    const blocked=await handler(db,{fetch:async()=>({ok:false,status:403,text:async()=>JSON.stringify({ok:false,error_code:403,description:'bot was blocked'})})});
    const response=await blocked.send(f,{test:true,testRequestId:newId});assert.equal(response.code,502);assert.equal(blocked.calls.length,1);
    assert.equal((await blocked.send(f,{test:true,testRequestId:newId})).code,409);assert.equal(blocked.calls.length,1);
    const historical=await blocked.send(f,{test:true,testRequestId:firstId});assert.equal(historical.code,200);
    assert.equal((historical.body.data as Row).replayed,true);assert.equal(blocked.calls.length,1);
  });
  await t.test("unknown test intent is quarantined on replay; explicit different intent is not an automatic retry",async()=>{
    const f=await telegramScenario(db) as Fixture,id=randomUUID();
    const a=await handler(db,{fetch:async()=>{throw Error('unknown synthetic delivery');}});
    assert.equal((await a.send(f,{test:true,testRequestId:id})).code,502);
    const b=await handler(db);assert.equal((await b.send(f,{test:true,testRequestId:id})).code,409);assert.equal(b.calls.length,0);
    assert.equal((await b.send(f,{test:true,testRequestId:randomUUID()})).code,200);assert.equal(b.calls.length,1);
  });
  await t.test("configured legacy test body and malformed intent fail closed without a fresh-success claim",async()=>{
    const f=await telegramScenario(db) as Fixture,a=await handler(db);
    for(const testRequestId of [undefined,null,'bad','00000000-0000-1000-8000-000000000097']) {
      const reply=await a.send(f,{test:true,testRequestId});assert.equal(reply.code,400);assert.equal(reply.body.success,false);
    }
    assert.equal(a.calls.length,0);
  });
});
