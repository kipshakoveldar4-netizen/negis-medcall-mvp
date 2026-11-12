import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const ts=createRequire(path.join(root,"package.json"))("typescript") as typeof import("typescript");
const {parsePartnerLedger}=await import(new URL("../../lib/crm/partner-contracts.ts",import.meta.url).href);
const ready={state:"ready",generatedAt:"2026-10-27T01:02:03.123456Z",firstCommissionBps:1000,renewalCommissionBps:null,
  registrations:"3",paidCompanies:"2",firstPayments:"2",renewals:"1",
  balances:[{currency:"KZT",earnedMinor:"900719925474099301",paidMinor:"1",availableMinor:"900719925474099300"}]};

test("partner report preserves exact strings above Number.MAX_SAFE_INTEGER and strips private fields",()=>{
  assert.deepEqual(parsePartnerLedger({...ready,privateAuth:"secret",workspaceId:"foreign",referralCode:"dead-link"}),ready);
  assert.deepEqual(parsePartnerLedger({...ready,balances:ready.balances.map(b=>({...b,privatePayment:"secret"}))}),ready);
  assert.deepEqual(parsePartnerLedger({state:"not_activated"}),{state:"not_activated"});
  assert.deepEqual(parsePartnerLedger({state:"suspended"}),{state:"suspended"});
});
test("a known empty ledger is different from missing, inactive, malformed or unavailable data",()=>{
  assert.ok(parsePartnerLedger({...ready,firstCommissionBps:null,registrations:"0",paidCompanies:"0",firstPayments:"0",renewals:"0",balances:[]}));
  for(const value of [null,{},[],{state:"ready"},{state:"not_activated",balances:ready.balances},{state:"suspended",earnedMinor:"100"}])assert.equal(parsePartnerLedger(value),null);
});
for(const [field,value]of [["registrations","1"],["paidCompanies","4"],["firstPayments","3"],["renewals","-1"],["registrations",3],["firstCommissionBps",0],["firstCommissionBps",5001],["renewalCommissionBps",1001],["generatedAt","2026-02-30T00:00:00Z"],["generatedAt","2026-01-01"],["generatedAt","2026-01-01T00:00:00+05:00"]] as const)
  test(`invalid partner metadata fails closed: ${field}=${value}`,()=>assert.equal(parsePartnerLedger({...ready,[field]:value}),null));
for(const patch of [{earnedMinor:"00"},{earnedMinor:100},{earnedMinor:"-1"},{availableMinor:"1"},{currency:"kzt"},{currency:""},{earnedMinor:"1".repeat(65)}])
  test(`invalid partner money fails closed: ${JSON.stringify(patch)}`,()=>assert.equal(parsePartnerLedger({...ready,balances:[{...ready.balances[0],...patch}]}),null));
test("duplicate currencies, inconsistent zero counts, impossible rows and oversized balances are refused",()=>{
  for(const patch of [{balances:[ready.balances[0],ready.balances[0]]},{paidCompanies:"0",firstPayments:"0",renewals:"0"},
    {paidCompanies:"0",firstPayments:"0",renewals:"1",balances:[]},{balances:[]},{balances:Array(257).fill(ready.balances[0])}])assert.equal(parsePartnerLedger({...ready,...patch}),null);
});

const source=await readFile(path.join(root,"lib/crm/partner-ledger.ts"),"utf8");
async function api(options:{data?:unknown;error?:unknown;method?:string;query?:Record<string,unknown>;configured?:boolean}={}){
  const calls:unknown[]=[],exports:Record<string,any>={},headers:Record<string,unknown>={};let status=0,body:any;
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Script(code).runInNewContext({exports,Error,require(name:string){
    if(name==="../auth/server")return{requireAuthenticatedUser:async()=>({id:"00000000-0000-4000-8000-000000000101"})};
    if(name==="../supabase/server")return{getSupabaseServerClient:()=>options.configured===false?null:{rpc:async(name:string,args:unknown)=>{calls.push([name,JSON.parse(JSON.stringify(args))]);return{data:options.data??ready,error:options.error??null};}}};
    if(name==="./partner-contracts")return{parsePartnerLedger};
    throw Error("Unexpected import "+name);
  }});
  const res={setHeader:(k:string,v:unknown)=>{headers[k]=v;},status:(value:number)=>{status=value;return res;},json:(value:any)=>{body=JSON.parse(JSON.stringify(value));return res;}};
  await exports.handlePartnerLedger({method:options.method??"GET",query:options.query??{},body:{p_actor:"forged",partnerId:"foreign"}},res);
  return{status,body,headers,calls};
}
test("partner API uses only verified Auth identity, no caller partner/workspace, no money writes",async()=>{
  const r=await api();assert.equal(r.status,200);assert.deepEqual(r.body,{success:true,data:ready});
  assert.deepEqual(r.calls,[["read_growth_partner_ledger",{p_actor:"00000000-0000-4000-8000-000000000101"}]]);assert.equal(r.headers["Cache-Control"],"no-store");
  for(const key of["partnerId","workspaceId","actor","offset"]){const bad=await api({query:{[key]:"foreign"}});assert.equal(bad.status,400);assert.deepEqual(bad.calls,[]);}
});
test("partner API safely refuses unsupported methods, missing schema/client, revocation and broken DTOs",async()=>{
  for(const method of["POST","PATCH","DELETE"]){const r=await api({method});assert.equal(r.status,405);assert.deepEqual(r.calls,[]);}
  assert.equal((await api({configured:false})).status,503);
  assert.equal((await api({data:{state:"ready"}})).status,503);
  for(const code of["P1091","P1092","PGRST202","40001","55P03"]){const r=await api({error:{code,message:"DO_NOT_LEAK_secret"}});assert.equal(r.status,code==="P1091"?403:503);assert.ok(!JSON.stringify(r.body).includes("DO_NOT_LEAK"));assert.equal(r.headers["Cache-Control"],"no-store");}
});
