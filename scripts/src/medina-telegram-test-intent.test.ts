import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import test from "node:test";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
type Row=Record<string,unknown>;
async function intentFixture() {
  const ts=createRequire(path.join(root,"package.json"))("typescript") as typeof import("typescript");
  const file="artifacts/negis/src/pages/ContentStudio.tsx",source=await readFile(path.join(root,file),"utf8");
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const names=["runLibraryTelegram","parseTelegramResponse","telegramErrorMessage"];
  const selected=new Map<string,string>();
  const visit=(node:import("typescript").Node)=>{
    if(ts.isFunctionDeclaration(node)&&node.name&&names.includes(node.name.text))selected.set(node.name.text,node.getText(ast));
    ts.forEachChild(node,visit);
  };
  visit(ast);assert.equal(selected.size,names.length);
  const compiled=ts.transpileModule([...selected.values()].join("\n")+"\nexports.run=runLibraryTelegram;",{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const actorId="00000000-0000-4000-8000-000000000001",workspaceId="00000000-0000-4000-8000-000000000002";
  const session={signal:new AbortController().signal},sessionRef={current:session};
  const libraryWritePending:{current:unknown}={current:null};
  const notices:string[]=[],requests:{body:Row;dispatchGuard:()=>boolean}[]=[];
  let ids=0,alive=true,reject=false;
  let transport:(body:Row)=>Promise<void>=async()=>{};
  const exported={} as {run(test:boolean):Promise<void>};
  new Script(compiled).runInNewContext({
    exports:exported,Error,CrmApiError:class extends Error {},
    actorId,workspaceId,sessionRef,libraryWritePending,libraryView:{},localDraftsOnly:false,
    crypto:{randomUUID(){ids++;return `00000000-0000-4000-8000-${String(ids).padStart(12,'0')}`;}},
    beginLibraryWrite(){
      if(libraryWritePending.current)return null;
      const write={session,snapshot:{videos:[],activeId:null}};libraryWritePending.current=write;return write;
    },
    isLibraryWriteVerified:async()=>alive,
    isLibraryWriteCurrent:()=>alive,
    setLoading(){},setNotice:(notice:string)=>notices.push(notice),
    toast:{error(){},warning(){},success(){}},
    handoffAccessDenied:()=>false,
    async crmFetch(_url:string,input:{body:string;expectedUserId:string;signal:AbortSignal;dispatchGuard:()=>boolean}) {
      assert.equal(input.expectedUserId,actorId);assert.equal(input.signal,session.signal);assert.equal(input.dispatchGuard(),alive);
      const body=JSON.parse(input.body) as Row;requests.push({body,dispatchGuard:input.dispatchGuard});
      await transport(body);if(reject)throw Error('Synthetic unknown transport');
      return {ok:true,body:{success:true,mode:'telegram',data:{sent:true,test:true,parts:1,packageText:'Synthetic test message',testRequestId:body.testRequestId,replayed:false}}};
    },
    safeJson:async(response:{body:unknown})=>response.body,
  });
  return {requests,notices,run:()=>exported.run(true),setAlive(value:boolean){alive=value;},setReject(){reject=true;},setTransport(fn:typeof transport){transport=fn;},get ids(){return ids;}};
}
test('actual test-button callback creates one stable UUID per explicit manual intent',async()=>{
  const f=await intentFixture();await f.run();await f.run();
  assert.equal(f.requests.length,2);assert.equal(f.ids,2);
  for(const request of f.requests)assert.match(String(request.body.testRequestId),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(f.requests[0]!.body.testRequestId,f.requests[1]!.body.testRequestId);
  assert.deepEqual(Object.keys(f.requests[0]!.body).sort(),['test','testRequestId']);
});
test('transport replay uses the same serialized intent, not another generated UUID',async()=>{
  const f=await intentFixture(),replayed:Row[]=[];
  f.setTransport(async body=>{replayed.push(JSON.parse(JSON.stringify(body)),JSON.parse(JSON.stringify(body)));});
  await f.run();assert.equal(f.ids,1);assert.equal(replayed.length,2);
  assert.equal(replayed[0]!.testRequestId,replayed[1]!.testRequestId);
});
test('pending callback suppresses duplicate clicks; unknown outcome never retries automatically',async()=>{
  const f=await intentFixture();let release!:()=>void,started!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;}),begun=new Promise<void>(resolve=>{started=resolve;});
  f.setTransport(async()=>{started();await wait;});f.setReject();
  const work=f.run();await begun;await f.run();assert.equal(f.ids,1);assert.equal(f.requests.length,1);
  release();await work;await Promise.resolve();assert.equal(f.requests.length,1);
});
test('original lifetime guards still deny before dispatch and suppress stale success after account change',async()=>{
  const blocked=await intentFixture();blocked.setAlive(false);await blocked.run();assert.equal(blocked.ids,0);assert.equal(blocked.requests.length,0);
  const f=await intentFixture();f.setTransport(async()=>{f.setAlive(false);});await f.run();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.dispatchGuard(),false);assert.ok(!f.notices.includes('Telegram подключён'));
});
