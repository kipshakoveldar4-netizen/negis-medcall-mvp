import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {once} from 'node:events';
import {stripVTControlCharacters} from 'node:util';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
test('fake AuthContext selects only its synthetic workspace before notifying React',async()=>{
 const source=await readFile(path.join(root,'scripts/fixtures/advertising-reports-browser-mocks.tsx'),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const values=new Map(),exports={};
 vm.runInNewContext(code,{exports,require(name){assert.equal(name,'react/jsx-runtime');return {jsx(){}};},
  window:{localStorage:{setItem(key,value){values.set(key,value);}}}});
 const key='negis_workspace_selector',fixture=exports.reportsAuthFixture;
 assert.equal(values.get(key),exports.reportIds.W1);
 let selectedAtNotification;
 const unsubscribe=fixture.subscribe(()=>{selectedAtNotification=values.get(key);});
 fixture.workspace('W2');assert.equal(selectedAtNotification,exports.reportIds.W2);
 fixture.switchActor();assert.equal(selectedAtNotification,exports.reportIds.W1);
 fixture.reset();assert.equal(values.get(key),exports.reportIds.W1);
 unsubscribe();
});
test('isolated report browser serves real transport, CSP and fake-only HTTP', {timeout:60000},async t=>{
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,['scripts/fixtures/advertising-reports-browser.mjs',`--port=${port}`],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
 await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error(`Fixture did not start: ${output.slice(-1500)}`)),30000);
  const read=()=>{if(stripVTControlCharacters(output).includes(`127.0.0.1:${port}`)){clearTimeout(timeout);resolve();}};
  child.stdout.on('data',read);child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Fixture exited ${code}: ${output.slice(-1500)}`));});
 });
 const origin=`http://127.0.0.1:${port}`;
 const get=route=>fetch(origin+route,{redirect:'error'});
 for(const route of ['/ads?reports=concurrency','/ads-automation/history?reports=concurrency','/content-studio?reports=concurrency']){
  const response=await get(route);assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(response.headers.get('content-security-policy'),/connect-src 'self' ws:\/\/127\.0\.0\.1:\*/);
  assert.doesNotMatch(response.headers.get('content-security-policy'),/https:/);
  assert.match(response.headers.get('content-security-policy'),/img-src 'self' data: blob:;/);
  assert.match(response.headers.get('content-security-policy'),/form-action 'none'; frame-src 'none'/);
  assert.match(await response.text(),/noindex,nofollow/);
 }
 for(const route of ['/ads','/ads?reports=demo','/ads-automation/history','/api/crm/ads-launch','/api/targeting/analyze'])assert.equal((await get(route)).status,403);
 for(const route of ['/content-studio','/content-studio?reports=demo','/content-studio?reports=concurrency&extra=1','/content-studio?reports=concurrency&reports=concurrency'])assert.equal((await get(route)).status,403);
 assert.equal((await fetch(origin+'/content-studio/other?reports=concurrency',{headers:{accept:'text/html'}})).status,404);
 assert.equal((await fetch(origin+'/api/crm/meta-launches',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 const auth=await get('/api/crm/auth-context?workspaceId=aaaaaaaa-1111-4111-8111-111111111111');assert.equal(auth.status,401);
 for(const file of ['scripts/fixtures/advertising-reports-browser.tsx','scripts/fixtures/advertising-reports-browser-mocks.tsx','artifacts/negis/src/lib/api.ts',
  'artifacts/negis/src/pages/ContentStudio.tsx','artifacts/negis/src/lib/serverAuth.ts','artifacts/negis/src/lib/demoStorage.ts',
  'lib/content-studio/core.ts','lib/content-studio/paid-generation.ts','lib/advertising/campaignBrief.ts','lib/meta/compliance.ts','lib/vertical/terms.ts']){
  const response=await get('/@fs/'+path.join(root,file).replaceAll('\\','/'));assert.equal(response.status,200);
  const source=await response.text();assert.doesNotMatch(source,/eeoudrmohgftcdoexdmd|ukiobbwsdoblooynzlnx|supabase\.co/);
  if(file.endsWith('/api.ts')){assert.match(source,/expectedUserId/);assert.match(source,/dispatchGuard/);assert.match(source,/Bearer/);}
  if(file.endsWith('browser-mocks.tsx')){assert.match(source,/fixture-ads-/);assert.doesNotMatch(source,/createClient\(/);}
  if(file.endsWith('advertising-reports-browser.tsx')){
   assert.match(source,/\/src\/pages\/ContentStudio\.tsx/);assert.match(source,/content-usage/);
   assert.match(source,/\/content-studio\?reports=concurrency/);assert.match(source,/Лимиты/);
  }
  if(file.endsWith('/ContentStudio.tsx')||file.endsWith('/serverAuth.ts')){
   assert.match(source,/advertising-reports-browser-mocks\.tsx/);
   assert.doesNotMatch(source,/\/src\/(?:contexts\/AuthContext|lib\/supabase|components\/layout\/PageLayout)\.tsx?["?]/);
  }
  if(file.endsWith('/ContentStudio.tsx')){
   assert.match(source,/\/src\/lib\/api\.ts/);assert.match(source,/\/api\/content-studio\/usage/);assert.match(source,/\/api\/crm\/content-videos/);
  }
 }
 const workspace='aaaaaaaa-1111-4111-8111-111111111111';
 const headers={Authorization:'Bearer fixture-ads-A'};
 for(const resource of ['/api/content-studio/usage','/api/crm/content-videos']){
  assert.equal((await get(resource+'?workspaceId='+workspace)).status,401);
  assert.equal((await fetch(origin+resource+'?workspaceId=bbbbbbbb-2222-4222-8222-222222222222',{headers})).status,403);
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS','HEAD'])assert.equal((await fetch(origin+resource+'?workspaceId='+workspace,{method,headers})).status,403);
 }
 for(const route of ['/api/content-studio/generate-photo','/api/content-studio/generate-video','/api/content-studio/generate-package','/api/content-studio/telegram'])assert.equal((await fetch(origin+route,{method:'POST',headers,body:'{}'})).status,403);
 const quota=await (await fetch(origin+'/api/content-studio/usage?workspaceId='+workspace,{headers})).json();
 assert.equal(quota.mode,'tracked');assert.equal(quota.data.planTitle,'QA quota A/W1 r1');
 assert.equal(quota.data.images.remaining,149);assert.equal(quota.data.videoSeconds.remaining,172);
 const videos=await (await fetch(origin+'/api/crm/content-videos?workspaceId='+workspace,{headers})).json();
 assert.equal(videos.mode,'supabase');assert.deepEqual(videos.data.videos,[]);
 const state=await (await get('/__fixture/ads-reports')).json();assert.equal(state.externalCalls,0);
 assert.equal(state.forbiddenWrites,13);
});
