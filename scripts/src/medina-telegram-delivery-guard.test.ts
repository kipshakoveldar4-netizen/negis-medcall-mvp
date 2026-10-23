import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type Receipt = { key: string; attemptId: string };
type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
type Locks = { request<T>(key: string, work: () => T | Promise<T>): Promise<T> };
const guard = await import(pathToFileURL(path.join(root, "lib/content-studio/telegram-delivery-guard.ts")).href) as {
  reserveTelegramDelivery(input: { storage: Store; locks?: Locks; actorId: string; workspaceId: string; videoId: string; packageText: string; isCurrent(): boolean }): Promise<Receipt>;
  confirmTelegramDelivery(storage: Store, receipt: Receipt): void;
  releaseUnsentTelegramDelivery(storage: Store, receipt: Receipt): void;
};
function setup() {
  const rows = new Map<string,string>();
  const storage: Store = { getItem: key => rows.get(key) ?? null, setItem: (key,value) => { rows.set(key,value); }, removeItem: key => { rows.delete(key); } };
  const tails = new Map<string,Promise<unknown>>();
  const locks: Locks = { request(key, work) { const next = (tails.get(key) ?? Promise.resolve()).then(work); tails.set(key,next.catch(()=>{})); return next; } };
  const input = { storage,locks,actorId:"actor-A",workspaceId:"test-W",videoId:"idea-A",packageText:"Synthetic QA payload",isCurrent:()=>true };
  return { rows,storage,locks,input,reserve: (change = {}) => guard.reserveTelegramDelivery({...input,...change}) };
}
test("receipt is persisted before dispatch and contains no package or credentials", async()=>{
  const f=setup(),receipt=await f.reserve();
  assert.equal(f.rows.size,1); assert.equal(JSON.parse(f.rows.get(receipt.key)!).state,"uncertain");
  assert.doesNotMatch(JSON.stringify([...f.rows]),/Synthetic QA payload|token|password|chat_id/);
  await assert.rejects(f.reserve(),/повторная отправка заблокирована/);
});
test("simultaneous reservations in separate views allow exactly one dispatch", async()=>{
  const f=setup(),results=await Promise.allSettled([f.reserve(),f.reserve(),f.reserve()]);
  assert.equal(results.filter(v=>v.status==="fulfilled").length,1); assert.equal(f.rows.size,1);
});
for(const state of ["uncertain","sent"]){
  test(`${state} survives a new helper/view and blocks exact-content retry`, async()=>{
    const f=setup(),receipt=await f.reserve(); if(state==="sent")guard.confirmTelegramDelivery(f.storage,receipt);
    await assert.rejects(guard.reserveTelegramDelivery({...f.input}),/повторная отправка заблокирована/);
    assert.equal(JSON.parse(f.rows.get(receipt.key)!).state,state);
  });
}
test("different actor, workspace, idea or content cannot consume the original receipt", async()=>{
  const f=setup(),original=await f.reserve();
  for(const change of [{actorId:"actor-B"},{workspaceId:"test-other"},{videoId:"idea-B"},{packageText:"Changed synthetic payload"}]) await f.reserve(change);
  assert.equal(f.rows.size,5); assert.equal(JSON.parse(f.rows.get(original.key)!).state,"uncertain");
});
test("proven unsent response can release only its own uncertain receipt", async()=>{
  const f=setup(),receipt=await f.reserve(); guard.releaseUnsentTelegramDelivery(f.storage,{...receipt,attemptId:"wrong"}); assert.equal(f.rows.size,1);
  guard.releaseUnsentTelegramDelivery(f.storage,receipt); assert.equal(f.rows.size,0);
  const next=await f.reserve(); assert.notEqual(next.attemptId,receipt.attemptId);
  guard.confirmTelegramDelivery(f.storage,next); guard.releaseUnsentTelegramDelivery(f.storage,next); assert.equal(f.rows.size,1);
});
test("stale account before lock grant creates no receipt", async()=>{
  const f=setup(); await assert.rejects(f.reserve({isCurrent:()=>false}),/аккаунт или пакет изменился/); assert.equal(f.rows.size,0);
});
test("unavailable lock manager, unreadable storage and failed writes stop before dispatch", async()=>{
  const f=setup(); await assert.rejects(f.reserve({locks:undefined}),/сохранить защиту/);
  await assert.rejects(f.reserve({storage:{...f.storage,getItem(){throw Error("unavailable");}}}),/сохранить защиту/);
  await assert.rejects(f.reserve({storage:{...f.storage,setItem(){}}}),/сохранить защиту/); assert.equal(f.rows.size,0);
});
test("damaged stored receipt fails closed instead of permitting retry", async()=>{
  const f=setup(),r=await f.reserve(); f.rows.set(r.key,"{damaged"); await assert.rejects(f.reserve(),/повторная отправка заблокирована/);
  guard.releaseUnsentTelegramDelivery(f.storage,r); assert.equal(f.rows.get(r.key),"{damaged"); assert.throws(()=>guard.confirmTelegramDelivery(f.storage,r),/сохранить защиту/);
});
