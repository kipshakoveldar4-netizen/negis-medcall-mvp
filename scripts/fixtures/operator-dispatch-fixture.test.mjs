import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorDispatchFixture } from './operator-dispatch-fixture.ts';

const url = new URL('/api/crm/operator-account', 'http://fixture.invalid');
test('local dispatch gate refuses an obsolete action before queuing', async () => {
  let calls=0;
  const f=createOperatorDispatchFixture(() => { calls++; return new Response(null,{status:403}); });
  await assert.rejects(f.request(url,{method:'PATCH',dispatchGuard:()=>false}),{name:'AbortError'});
  assert.equal(calls,0);
  assert.deepEqual(f.snapshot(),{held:true,queued:0,canceled:1,dispatched:0});
});
test('local dispatch gate keeps reads synchronous in effect and rejects stale queued writes', async () => {
  let calls=0,current=true;
  const f=createOperatorDispatchFixture(() => { calls++; return new Response(null,{status:403}); });
  assert.equal((await f.request(url)).status,403);
  const pending=f.request(url,{method:'POST',dispatchGuard:()=>current});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  assert.equal(calls,1);
  current=false;
  f.release();
  await rejected;
  assert.equal(calls,1);
  assert.deepEqual(f.snapshot(),{held:false,queued:1,canceled:1,dispatched:0});
});
test('local dispatch gate never converts the delegate refusal into a successful write', async () => {
  const f=createOperatorDispatchFixture(() => new Response(null,{status:403}));
  const pending=f.request(url,{method:'PATCH',dispatchGuard:()=>true});
  f.release();
  assert.equal((await pending).status,403);
  assert.equal(f.snapshot().dispatched,1);
});
