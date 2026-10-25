import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const source = await readFile(path.join(root, "lib/crm/operators.ts"), "utf8");
const code = new Script(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText);
const W="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U="11111111-1111-4111-8111-111111111111", S="22222222-2222-4222-8222-222222222222";
const O="33333333-3333-4333-8333-333333333333", R="44444444-4444-4444-8444-444444444444";
type Row=Record<string,any>;
function fixture(options: Row={}) {
  const calls: Row[]=[], reads: Row[]=[], exports: Row={};
  const db={
    from(table: string) {
      const filters: Row={}; reads.push({table,filters});
      const q: Row={select:()=>q,eq:(key:string,value:unknown)=>{filters[key]=value;return q;},
        maybeSingle:async()=>({data:table==="growth_operator_profiles"?{id:O}:options.foreign?null:{id:R},error:null}),
        insert:()=>{throw new Error("Ungarded direct INSERT is forbidden");},
        update:()=>{throw new Error("Unguarded direct UPDATE is forbidden");}};
      return q;
    },
    async rpc(name:string,args:Row) {
      calls.push({name,args:structuredClone(args)});
      if(options.rpc) return options.rpc(name,args);
      return {data:Object.hasOwn(options,"data")?options.data:R,error:options.error??null};
    },
  };
  const imports: Row={
    "../auth/server":{requireAuthenticatedUser:async()=>({id:U}),isUuidValue:(v:unknown)=>typeof v==="string"
      && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)},
    "../auth/platform":{readPlatformOwner:()=>null},
    "../supabase/server":{getSupabaseServerClient:()=>options.noDb?null:db},
    "./server":{readWorkspaceContext:()=>options.noContext?null:{workspaceId:W,staffUserId:S,userId:U,role:Object.hasOwn(options,"role")?options.role:"owner"}},
    "./operator-contracts":{OPERATOR_PAGE_SIZE:20},
  };
  code.runInNewContext({exports,require(name:string){assert.ok(name in imports,name);return imports[name];}});
  return {calls,reads,async call(clinic:boolean,body:Row,method="PATCH") {
    const res: Row={statusCode:0,body:null,headers:{},setHeader(k:string,v:unknown){this.headers[k]=v;},
      status(status:number){this.statusCode=status;return this;},json(value:unknown){this.body=JSON.parse(JSON.stringify(value));return this;}};
    await exports[clinic?"handleClinicOperators":"handleOperatorInbox"]({method,body,query:{}},res);
    return res;
  }};
}

for(const action of ["withdraw","end"]) test(`clinic ${action} forwards only the verified actor to one atomic RPC`,async()=>{
  const f=fixture(); const res=await f.call(true,{id:R,action,workspaceId:B,staffUserId:B,userId:B,ended_at:"2030-01-01",price:999});
  assert.equal(res.statusCode,200);assert.deepEqual(res.body,{success:true});
  assert.deepEqual(f.calls,[{name:"transition_clinic_operator_request",args:{p_workspace_id:W,p_staff_user_id:S,p_auth_user_id:U,p_request_id:R,p_action:action}}]);
  assert.equal(f.reads.length,0);assert.equal(res.headers["Cache-Control"],"no-store");
});
for(const action of ["accept","decline","end"]) test(`operator ${action} is atomically bound to authenticated user, never the body`,async()=>{
  const f=fixture();assert.equal((await f.call(false,{id:R,action,p_operator_user_id:B,operatorId:B,role:"owner"})).statusCode,200);
  assert.deepEqual(f.calls,[{name:"transition_growth_operator_request",args:{p_request_id:R,p_operator_user_id:U,p_action:action}}]);
  assert.deepEqual(f.reads.map(x=>({table:x.table,filters:x.filters})),[
    {table:"growth_operator_profiles",filters:{auth_user_id:U,status:"approved"}},
    {table:"growth_operator_requests",filters:{id:R,operator_id:O}},
  ]);
});
test("proposal creation uses a live actor RPC and returns only its confirmed UUID",async()=>{
  const f=fixture();const res=await f.call(true,{operatorId:O,clinicBrief:"  Synthetic  ",pricePerArrivalMinor:"0",leadScope:"assigned",workspaceId:B,userId:B},"POST");
  assert.equal(res.statusCode,201);assert.deepEqual(res.body,{success:true,data:{id:R}});
  assert.deepEqual(f.calls,[{name:"create_clinic_operator_request",args:{p_workspace_id:W,p_staff_user_id:S,p_auth_user_id:U,p_operator_id:O,p_clinic_brief:"Synthetic",p_price_minor:"0",p_lead_scope:"assigned"}}]);
});
for(const clinic of [true,false]) for(const data of [null,{},[],{id:R},B,7,true]) {
  test(`unconfirmed ${clinic?"clinic":"operator"} mutation result ${JSON.stringify(data)} is never success`,async()=>{
    const f=fixture({data});assert.equal((await f.call(clinic,{id:R,action:"end"})).statusCode,503);
    assert.equal(f.calls.length,1);
  });
}
for(const data of [null,{},[],{id:R},7,true]) test(`unconfirmed create result ${JSON.stringify(data)} fails closed`,async()=>{
  const f=fixture({data});assert.equal((await f.call(true,{operatorId:O,clinicBrief:"Synthetic",pricePerArrivalMinor:"0"},"POST")).statusCode,503);
});
for(const [code,status] of [["P9601",403],["P9602",409],["P9603",404],["P9604",400],
  ["PGRST202",503],["42883",503],["42P01",503],["40001",409],["40P01",409],["55P03",409],["XX000",503]] as const) {
  for(const clinic of [true,false]) test(`${code}: ${clinic?"clinic":"operator"} refuses without fallback or private details`,async()=>{
    const f=fixture({error:{code,message:"private-db-secret",details:"private-details",hint:"private-hint"}});
    const res=await f.call(clinic,{id:R,action:"end"});assert.equal(res.statusCode,status);
    assert.equal(f.calls.length,1);assert.doesNotMatch(JSON.stringify(res.body),/private-/);
  });
}
for(const role of ["doctor","receptionist","lead_manager",null]) test(`clinic role ${role} cannot reach mutation RPC`,async()=>{
  const f=fixture({role});assert.equal((await f.call(true,{id:R,action:"end"})).statusCode,403);assert.equal(f.calls.length,0);
});
test("foreign operator target stays hidden before any mutation RPC",async()=>{
  const f=fixture({foreign:true});assert.equal((await f.call(false,{id:R,action:"end"})).statusCode,404);assert.equal(f.calls.length,0);
});
for(const clinic of [true,false]) test(`${clinic?"clinic":"operator"} rejects malformed action without mutation`,async()=>{
  for(const action of [null,{},["end"],"remove"," end "]) {
    const f=fixture();assert.equal((await f.call(clinic,{id:R,action})).statusCode,400);assert.equal(f.calls.length,0);
  }
});
test("UUID identity comparison is case-insensitive, not a string-spelling conflict after commit",async()=>{
  const id="abcdefab-abcd-4abc-8abc-abcdefabcdef";
  const f=fixture({data:id});assert.equal((await f.call(true,{id:id.toUpperCase(),action:"end"})).statusCode,200);
});
