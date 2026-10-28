import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),control=path.join(root,'artifacts/medina-control');
const require=createRequire(path.join(control,'package.json')),app=path.join(control,'src/App.tsx'),base='757d5f7';
const baselineScreens=['Overview','ClinicCard','Onboarding','Operators','Contributors'];
const screenNames=[...baselineScreens,'PartnerCompanies'];
const settings={NODE_ENV:'production',VITE_MEDINA_CONTROL_MODE:'isolated-preview',
  VITE_MEDINA_API_URL:'https://negis-medcall-mvp-api-server-abc123def-yeldar-s-projects.vercel.app',
  VITE_SUPABASE_URL:'https://ukiobbwsdoblooynzlnx.supabase.co',VITE_SUPABASE_ANON_KEY:'sb_publishable_owned_control_build_fixture'};
function describe(result){
  assert.ok(!Array.isArray(result));const chunks=result.output.filter(f=>f.type==='chunk'),byName=new Map(chunks.map(c=>[c.fileName,c]));
  const entry=chunks.find(c=>c.isEntry);assert.ok(entry);
  function closure(names){const seen=new Set();function visit(name){if(seen.has(name))return;seen.add(name);const c=byName.get(name);assert.ok(c,'Only bundled local JS imports');for(const i of c.imports)visit(i);}names.forEach(visit);return [...seen].map(n=>byName.get(n));}
  function size(list){return{requests:list.length,bytes:list.reduce((n,c)=>n+Buffer.byteLength(c.code),0),gzipBytes:list.reduce((n,c)=>n+gzipSync(c.code).length,0)};}
  const initial=closure([entry.fileName]),screens={};for(const name of screenNames){const chunk=chunks.find(c=>c.facadeModuleId?.replaceAll('\\','/').endsWith('/screens/'+name+'.tsx'));if(chunk)screens[name]=chunk;}
  return{chunks,entry,initial,screens,initialSize:size(initial),overviewSize:screens.Overview?size(closure([entry.fileName,screens.Overview.fileName])):size(initial)};
}
test('Control production build defers all business screens and reduces the actual initial JS without changing warning limits',{timeout:120000},async t=>{
  const previous=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));Object.assign(process.env,settings);
  t.after(()=>{for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const {build,createLogger}=await import(pathToFileURL(require.resolve('vite')).href);
  const original=execFileSync('git',['show',base+':artifacts/medina-control/src/App.tsx'],{cwd:root,encoding:'utf8',windowsHide:true});
  async function compile(baseline){const warnings=[],logger=createLogger('silent');logger.warn=m=>warnings.push(m);logger.warnOnce=m=>warnings.push(m);
    const result=await build({configFile:path.join(control,'vite.config.ts'),customLogger:logger,build:{write:false,emptyOutDir:false,
      ...(baseline?{rollupOptions:{output:{manualChunks:()=>undefined}}}:{})},plugins:baseline?[{name:'owned-baseline-app-only',enforce:'pre',
        transform(_code,id){return path.normalize(id)===app?{code:original,map:null}:undefined;}}]:[]});return{...describe(result),warnings};}
  const before=await compile(true),after=await compile(false);
  const initialModules=new Set(after.initial.flatMap(c=>Object.keys(c.modules).map(p=>p.replaceAll('\\','/'))));
  for(const name of screenNames){assert.ok(after.screens[name],'Every business screen has its own import boundary: '+name);
    assert.ok(after.entry.dynamicImports.includes(after.screens[name].fileName));
    assert.equal([...initialModules].some(p=>p.endsWith('/screens/'+name+'.tsx')),false,'No unselected business screen enters initial JS: '+name);
    if(baselineScreens.includes(name))assert.ok(before.initial.some(c=>Object.keys(c.modules).some(p=>p.replaceAll('\\','/').endsWith('/screens/'+name+'.tsx'))),'Baseline actually contains '+name);
  }
  assert.ok(after.initialSize.bytes<before.initialSize.bytes);assert.ok(after.initialSize.gzipBytes<before.initialSize.gzipBytes);
  assert.ok(after.overviewSize.bytes<before.initialSize.bytes,'Opening the first authorized screen must still save JS');
  assert.ok(after.chunks.every(c=>Buffer.byteLength(c.code)<=500000),'No chunk exceeds the existing default 500 kB warning threshold');
  assert.equal(after.warnings.some(m=>/Some chunks|larger than 500/.test(m)),false);
  const report={baseline:base,mode:'production; synthetic public config; no execution of browser/Auth/API code',
    before:before.initialSize,after:after.initialSize,firstOverview:after.overviewSize,
    largestChunkBytes:Math.max(...after.chunks.map(c=>Buffer.byteLength(c.code))),
    screens:Object.fromEntries(screenNames.map(name=>[name,after.screens[name].fileName]))};
  const folder=path.join(root,'node_modules/.cache');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'control-lazy-production-metrics.json'),JSON.stringify(report,null,2));
  t.diagnostic(JSON.stringify(report));
});
