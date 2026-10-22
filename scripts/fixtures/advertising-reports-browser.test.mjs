import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {once} from 'node:events';
import {stripVTControlCharacters} from 'node:util';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
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
 for(const route of ['/ads?reports=concurrency','/ads-automation/history?reports=concurrency']){
  const response=await get(route);assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(response.headers.get('content-security-policy'),/connect-src 'self' ws:\/\/127\.0\.0\.1:\*/);
  assert.doesNotMatch(response.headers.get('content-security-policy'),/https:/);
  assert.match(response.headers.get('content-security-policy'),/form-action 'none'; frame-src 'none'/);
  assert.match(await response.text(),/noindex,nofollow/);
 }
 for(const route of ['/ads','/ads?reports=demo','/ads-automation/history','/api/crm/ads-launch','/api/targeting/analyze'])assert.equal((await get(route)).status,403);
 assert.equal((await fetch(origin+'/api/crm/meta-launches',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 const auth=await get('/api/crm/auth-context?workspaceId=aaaaaaaa-1111-4111-8111-111111111111');assert.equal(auth.status,401);
 for(const file of ['scripts/fixtures/advertising-reports-browser.tsx','scripts/fixtures/advertising-reports-browser-mocks.tsx','artifacts/negis/src/lib/api.ts']){
  const response=await get('/@fs/'+path.join(root,file).replaceAll('\\','/'));assert.equal(response.status,200);
  const source=await response.text();assert.doesNotMatch(source,/eeoudrmohgftcdoexdmd|ukiobbwsdoblooynzlnx|supabase\.co/);
  if(file.endsWith('/api.ts')){assert.match(source,/expectedUserId/);assert.match(source,/dispatchGuard/);assert.match(source,/Bearer/);}
  if(file.endsWith('browser-mocks.tsx')){assert.match(source,/fixture-ads-/);assert.doesNotMatch(source,/createClient\(/);}
 }
 const state=await (await get('/__fixture/ads-reports')).json();assert.equal(state.externalCalls,0);
});
