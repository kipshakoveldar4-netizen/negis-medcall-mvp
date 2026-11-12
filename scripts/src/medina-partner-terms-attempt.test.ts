import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {Script} from "node:vm";
const ts=createRequire(import.meta.url)("typescript") as typeof import("typescript");
const contracts:Record<string,any>={},exports:Record<string,any>={};
new Script(ts.transpileModule(await readFile(new URL('../../lib/crm/partner-terms-contracts.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText).runInNewContext({exports:contracts,Date});
new Script(ts.transpileModule(await readFile(new URL('../../artifacts/negis/src/lib/partnerTermsAttempt.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText).runInNewContext({exports,BigInt,
    require(name:string){assert.equal(name,'../../../../lib/crm/partner-terms-contracts');return contracts;}});
const{clearPartnerTerms,parsePartnerTermsWrite,partnerPercentToBps,persistPartnerTerms,restorePartnerTerms}=
  Object.fromEntries(Object.entries(exports).map(([name,fn])=>[name,(...args:unknown[])=>structuredClone(fn(...args))]));
const actor="11111111-1111-4111-8111-111111111111",profile="22222222-2222-4222-8222-222222222222",request="33333333-3333-4333-8333-333333333333";
const attempt={actorId:actor,profileId:profile,side:"platform" as const,requestId:request,action:"offer" as const};
function store(){const values=new Map<string,string>();return{values,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};}
test("partner rates use exact hundredths, no invented defaults or floating rounding",()=>{
  for(const[v,kind,n]of [["23.50","first",2350],["50","first",5000],["10,01","first",1001],["5.25","renewal",525],["10","renewal",1000]]as const)assert.equal(partnerPercentToBps(v,kind),n);
  for(const v of ["","1e1","10.001","-10","99","5.01","0x10","010.5"])assert.equal(partnerPercentToBps(v,"first"),null);
  for(const v of ["4.99","10.01","NaN"])assert.equal(partnerPercentToBps(v,"renewal"),null);
});
test("partner command storage retains only original identity, no negotiated body",()=>{
  const s=store();assert.equal(persistPartnerTerms(s,attempt),true);assert.deepEqual(restorePartnerTerms(s,actor,profile,"platform"),{attempt,error:""});
  const value=[...s.values.values()][0];assert.deepEqual(Object.keys(JSON.parse(value)),["actorId","profileId","side","requestId","action"]);
  assert.equal(/terms|Commission|payload|password|token/.test(value),false);assert.equal(clearPartnerTerms(s,attempt),true);assert.equal(s.values.size,0);
});
test("pending original cannot be overwritten or cleared by a different operation",()=>{
  const s=store();assert.equal(persistPartnerTerms(s,attempt),true);const other={...attempt,requestId:profile};
  assert.equal(persistPartnerTerms(s,other),false);assert.equal(clearPartnerTerms(s,other),false);assert.deepEqual(restorePartnerTerms(s,actor,profile,"platform").attempt,attempt);
});
test("storage is scoped to actor, side and target, never another account's recovery",()=>{
  const s=store();persistPartnerTerms(s,attempt);assert.equal(restorePartnerTerms(s,request,profile,"platform").attempt,null);
  assert.equal(restorePartnerTerms(s,actor,request,"platform").attempt,null);assert.equal(restorePartnerTerms(s,actor,profile,"partner").attempt,null);
});
test("storage refusal, truncation and malformed identities block new sending",()=>{
  assert.ok(restorePartnerTerms(null,actor,profile,"platform").error);assert.equal(persistPartnerTerms(null,attempt),false);
  const s=store();persistPartnerTerms(s,attempt);const key=[...s.values.keys()][0];
  for(const value of ['{bad','x'.repeat(1025),JSON.stringify({...attempt,actorId:request}),JSON.stringify({...attempt,side:"partner"}),JSON.stringify({...attempt,payload:{terms:"private"}})]){
    s.values.set(key,value);const result=restorePartnerTerms(s,actor,profile,"platform");assert.equal(result.attempt,null);assert.ok(result.error);
  }
  const denied={getItem(){throw Error("Denied");},setItem(){throw Error("Denied");},removeItem(){throw Error("Denied");}};
  assert.ok(restorePartnerTerms(denied,actor,profile,"platform").error);assert.equal(persistPartnerTerms(denied,attempt),false);assert.equal(clearPartnerTerms(denied,attempt),false);
});
test("writes are versioned and side/target bound without caller-selected command IDs",()=>{
  const offer={profileId:profile,profileRevision:request,revision:null,action:"offer",payload:{firstCommissionBps:2500,renewalCommissionBps:650,terms:"Owned explicit terms"}};
  assert.ok(parsePartnerTermsWrite(offer,profile,"platform"));assert.equal(parsePartnerTermsWrite(offer,profile,"partner"),null);
  assert.equal(parsePartnerTermsWrite({...offer,requestId:request},profile,"platform"),null);assert.equal(parsePartnerTermsWrite(offer,actor,"platform"),null);
  assert.equal(parsePartnerTermsWrite({...offer,actorId:actor},profile,"platform"),null);
  assert.equal(parsePartnerTermsWrite({...offer,profileRevision:null},profile,"platform"),null);
  assert.ok(parsePartnerTermsWrite({...offer,revision:request,action:"accept",payload:{accepted:true}},profile,"partner"));
});
