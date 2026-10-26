import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const sha = text => createHash('sha256').update(text).digest('hex');
const signature = 'public.begin_generated_video_dispatch_with_usage(uuid,uuid,uuid,text,uuid,uuid,text,integer,integer,text)';
const oldSignature = 'public.begin_generated_video_dispatch(uuid,uuid,uuid,text,uuid)';
async function rollback(db, action) { await db.query('begin'); try { return await action(); } finally { await db.query('rollback'); } }
async function service(db, action) {
  await db.query('set role service_role'); let failure;
  try { return await action(); } catch (error) { failure=error; throw error; }
  finally { try { await db.query('reset role'); } catch (error) { if (!failure || error.code!=='25P02') throw error; } }
}
async function setup(db) {
  const w = randomUUID(), s = randomUUID(), a = randomUUID(), key = randomUUID(), generation = `v2:${key}`;
  const digest = sha(JSON.stringify(['medina-generated-v1', w, generation]));
  const bytes = createHash('sha1').update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex'))
    .update(`medina-generated-v1:${digest}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex'), asset = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const f = { w, s, a, key, generation, digest: sha(`owned quota request ${key}`), usage: null, nonce: randomUUID() };
  await db.query("insert into workspaces(id,name) values($1,'Owned quota recovery')", [w]);
  await db.query(`insert into staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
    values($1,$2,$3,$4,'Owned quota owner','owner','active')`, [s,w,a,`${s}@example.invalid`]);
  await service(db, () => db.query('select public.admit_generated_video_workflow($1,$2,$3,$4,$5,$6,$7,$8,null)',
    [w,s,a,generation,f.digest,digest,asset,`negis-video-${digest.slice(0,20)}.mp4`]));
  return f;
}
async function reserve(db, f) {
  const result = await service(db, () => one(db, `select * from public.reserve_content_generation_usage($1,$2,$3,'generated_video','video_seconds',4,40,'openai','owned-model')`, [f.w,f.s,f.key]));
  f.usage = result.usage_id; return result;
}
async function withReceipt(db, action) {
  // Match the application's separate PostgREST transactions: quota now() must
  // follow admission clock_timestamp(), not the start of a test outer BEGIN.
  const f=await setup(db), first=await reserve(db,f);
  try { return await rollback(db, async () => {
    await db.query('savepoint valid_quota_control');
    const control=await service(db,()=>begin(db,f)); assert.equal(control.dispatchAccepted,true);
    await db.query('rollback to savepoint valid_quota_control; release savepoint valid_quota_control');
    return action(f,first);
  }); } finally { await db.query('delete from workspaces where id=$1',[f.w]); }
}
async function begin(db, f, patch = {}) {
  const args = { workspace: f.w, staff: f.s, auth: f.a, generation: f.generation, nonce: f.nonce,
    usage: f.usage, digest: f.digest, units: 4, limit: 40, model: 'owned-model', ...patch };
  return (await one(db, `select public.begin_generated_video_dispatch_with_usage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value`, Object.values(args))).value;
}
const operation = (db, f) => one(db, 'select to_jsonb(w) value from public.generated_video_workflows w where workspace_id=$1 and generation_key=$2', [f.w,f.generation]).then(row => row.value);
const quota = (db, f) => one(db, 'select to_jsonb(u) value from public.content_generation_usage u where workspace_id=$1 order by id limit 1', [f.w]).then(row => row?.value ?? null);
async function denied(db, action, code = 'P9002') {
  await db.query('savepoint owned_quota_denial');
  try { await assert.rejects(action, error => error.code === code); }
  finally { await db.query('rollback to savepoint owned_quota_denial; release savepoint owned_quota_denial'); }
}
async function waiting(db, waiter, holder) {
  for (let n = 0; n < 150; n++) {
    if ((await one(db, 'select $2::int=any(pg_blocking_pids($1)) blocked', [waiter,holder])).blocked) return;
    await delay(10);
  }
  assert.fail('Expected a real owned PostgreSQL row-lock wait');
}

export async function reproduceUnboundVideoDispatch(db, t) {
  await t.test('before 106, original service dispatch admits a native operation with no quota receipt', async () => rollback(db, async () => {
    const f = await setup(db);
    const value = await service(db, () => one(db, 'select public.begin_generated_video_dispatch($1,$2,$3,$4,$5) value', [f.w,f.s,f.a,f.generation,f.nonce]));
    assert.equal(value.value.dispatchAccepted, true);
    assert.equal((await one(db, 'select count(*)::int n from content_generation_usage where workspace_id=$1', [f.w])).n, 0);
  }));
}

export async function exerciseVideoQuotaMissing(db,source,t) {
  await t.test('106 refuses an absent application foundation without creating objects', async () => {
    await assert.rejects(db.query(source),{code:'P1060'}); await db.query('rollback');
    assert.equal((await one(db,"select to_regclass('public.generated_video_workflows') item")).item,null);
  });
}

export async function exerciseVideoQuotaDispatch(db, fixture, source, t) {
  await t.test('106 has service-only RPC/column access and disables the old unbound service dispatch', async () => {
    assert.deepEqual(await one(db, `select has_function_privilege('service_role',$1,'EXECUTE') bridge,
      has_function_privilege('service_role',$2,'EXECUTE') legacy`, [signature,oldSignature]), { bridge: true, legacy: false });
    for (const role of ['anon','authenticated']) {
      assert.equal((await one(db, 'select has_function_privilege($1,$2,\'EXECUTE\') allowed', [role,signature])).allowed, false);
      assert.equal((await one(db, "select has_column_privilege($1,'public.generated_video_workflows','quota_usage_id','SELECT,INSERT,UPDATE,REFERENCES') allowed", [role])).allowed, false);
    }
  });
  await t.test('106 replays one reserved receipt/nonce without changing quota, author, units or model', async () => withReceipt(db, async (f,first) => {
    const duplicate = await reserve(db,f), before = await quota(db,f);
    assert.equal(first.allowed,true); assert.equal(duplicate.allowed,false); assert.equal(duplicate.duplicate,true); assert.equal(first.usage_id,duplicate.usage_id);
    const proof = await one(db, `select u.created_at>=o.created_at fresh,
      u.period_start=date_trunc('month',u.created_at at time zone 'UTC')::date period,
      to_jsonb(u) receipt,to_jsonb(o) operation from generated_video_workflows o
      join content_generation_usage u on u.id=$2 where o.workspace_id=$1`, [f.w,f.usage]);
    assert.equal(proof.fresh,true,JSON.stringify(proof)); assert.equal(proof.period,true,JSON.stringify(proof));
    const dispatched = await service(db, () => begin(db,f)); assert.equal(dispatched.dispatchAccepted,true);
    assert.equal(dispatched.operation.quota_usage_id,first.usage_id);
    const replay = await service(db, () => begin(db,f)); assert.deepEqual(replay,dispatched);
    const loser = await service(db, () => begin(db,f,{nonce:randomUUID()})); assert.equal(loser.dispatchAccepted,false);
    assert.deepEqual(await quota(db,f),before);
    await denied(db, () => db.query('update generated_video_workflows set quota_usage_id=null where workspace_id=$1', [f.w]));
  }));
  for (const [label, change] of [
    ['absent receipt', async (_db,f) => { f.usage=randomUUID(); }],
    ['wrong units', async (db,f) => db.query('update content_generation_usage set units=8 where id=$1',[f.usage])],
    ['wrong model', async (db,f) => db.query("update content_generation_usage set model='other-model' where id=$1",[f.usage])],
    ['wrong operation', async (db,f) => db.query("update content_generation_usage set operation='generated_image' where id=$1",[f.usage])],
    ['wrong kind', async (db,f) => db.query("update content_generation_usage set kind='image' where id=$1",[f.usage])],
    ['wrong provider', async (db,f) => db.query("update content_generation_usage set provider='other' where id=$1",[f.usage])],
    ['missing staff binding', async (db,f) => db.query('update content_generation_usage set staff_user_id=null where id=$1',[f.usage])],
    ['wrong key', async (db,f) => db.query('update content_generation_usage set request_key=$2 where id=$1',[f.usage,randomUUID()])],
    ['pre-native receipt', async (db,f) => db.query("update content_generation_usage set created_at=created_at-interval '1 day' where id=$1",[f.usage])],
    ['bad period', async (db,f) => db.query("update content_generation_usage set period_start=period_start-interval '1 month' where id=$1",[f.usage])],
    ['unknown receipt', async (db,f) => db.query("update content_generation_usage set status='unknown',completed_at=clock_timestamp(),error_code='request_unknown' where id=$1",[f.usage])],
    ['failed receipt', async (db,f) => db.query("update content_generation_usage set status='failed',completed_at=clock_timestamp(),error_code='provider_rejected' where id=$1",[f.usage])],
    ['succeeded receipt', async (db,f) => db.query("update content_generation_usage set status='succeeded',completed_at=clock_timestamp() where id=$1",[f.usage])],
  ]) await t.test(`106 refuses ${label} without native mutation or quota replacement`, async () => withReceipt(db, async f => {
    await change(db,f);
    const before = await operation(db,f), receipt = await quota(db,f);
    await db.query('set local role service_role'); await denied(db, () => begin(db,f)); await db.query('reset role');
    assert.deepEqual(await operation(db,f),before); assert.deepEqual(await quota(db,f),receipt);
  }));
  for (const [label, patch, code] of [['no current entitlement',{limit:0},'P9001'],['changed request',{digest:'b'.repeat(64)},'P9002'],
    ['different actor',{auth:randomUUID()},'P9004'],['different tenant',{workspace:randomUUID()},'P9004']]) {
    await t.test(`106 refuses ${label}`, async () => withReceipt(db, async f => {
      const before = await operation(db,f);
      await db.query('set local role service_role'); await denied(db, () => begin(db,f,patch),code); await db.query('reset role');
      assert.deepEqual(await operation(db,f),before);
    }));
  }
  await t.test('106 refuses a different active owner and a rebound original identity', async () => withReceipt(db,async f => {
    const other=randomUUID(), auth=randomUUID();
    await db.query(`insert into staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
      values($1,$2,$3,$4,'Other owned owner','owner','active')`,[other,f.w,auth,`${other}@example.invalid`]);
    await db.query('set local role service_role'); await denied(db,()=>begin(db,f,{staff:other,auth})); await db.query('reset role');
    await db.query('update staff_users set auth_user_id=$2 where id=$1',[f.s,randomUUID()]);
    const newAuth=(await one(db,'select auth_user_id id from staff_users where id=$1',[f.s])).id;
    await db.query('set local role service_role'); await denied(db,()=>begin(db,f,{auth:newAuth})); await db.query('reset role');
    assert.equal((await operation(db,f)).status,'reserved');
  }));
  await t.test('106 browser rows stay hidden under an accidental read grant and RPCs remain denied', async () => withReceipt(db,async f => {
    await db.query('grant select on generated_video_workflows,content_generation_usage to anon,authenticated');
    for(const role of ['anon','authenticated']) {
      await db.query(`set local role ${role}`);
      assert.equal((await one(db,'select count(*)::int n from generated_video_workflows')).n,0);
      assert.equal((await one(db,'select count(*)::int n from content_generation_usage')).n,0);
      await denied(db,()=>begin(db,f),'42501'); await db.query('reset role');
    }
  }));
  for(const [label,change] of [
    ['disabled quota RLS','alter table content_generation_usage disable row level security'],
    ['wrong same-named index','drop index generated_video_workflows_quota_usage_unique; create index generated_video_workflows_quota_usage_unique on generated_video_workflows(workspace_id)'],
    ['unexpected cascading quota FK',`alter table generated_video_workflows drop constraint generated_video_workflows_quota_usage_id_fkey;
      alter table generated_video_workflows add constraint generated_video_workflows_quota_usage_id_fkey foreign key(quota_usage_id)
      references content_generation_usage(id) on delete cascade deferrable initially deferred`],
    ['superuser service role','alter role service_role superuser'],
    ['inherited legacy dispatch privilege',`create role owned_legacy_dispatch nologin;
      grant owned_legacy_dispatch to service_role;
      grant execute on function ${oldSignature} to owned_legacy_dispatch`],
  ]) await t.test(`106 rerun refuses ${label} atomically`,async()=>{
    await db.query('begin');
    try { await db.query(change); await assert.rejects(db.query(source),{code:'P1060'}); }
    finally { await db.query('rollback'); }
    assert.equal((await one(db,"select relrowsecurity rls from pg_class where oid='content_generation_usage'::regclass")).rls,true);
    assert.equal((await one(db,"select has_function_privilege('service_role',$1,'EXECUTE') allowed",[oldSignature])).allowed,false);
  });
  const concurrency = async (label, action) => t.test(label, async () => {
    const f = await setup(db); await reserve(db,f);
    const a = await fixture.connect(), b = await fixture.connect();
    try {
      const apid = (await one(a,'select pg_backend_pid() pid')).pid, bpid = (await one(b,'select pg_backend_pid() pid')).pid;
      await a.query('set role service_role'); await b.query('set role service_role');
      await action(f,a,b,apid,bpid);
    } finally {
      await a.query('rollback'); await b.query('rollback'); await a.end(); await b.end();
      await db.query('delete from workspaces where id=$1',[f.w]);
    }
  });
  await concurrency('106 competing nonces wait on the actual operation row and only one admits provider dispatch', async (f,a,b,apid,bpid) => {
    await a.query('begin'); const first = await begin(a,f);
    const pending = begin(b,f,{nonce:randomUUID()}); await waiting(db,bpid,apid); await a.query('commit');
    const second = await pending; assert.equal(first.dispatchAccepted,true); assert.equal(second.dispatchAccepted,false);
    assert.equal(second.operation.dispatch_id,f.nonce); assert.equal((await quota(db,f)).status,'reserved');
  });
  await concurrency('106 revocation wins a real actor-lock wait with no dispatch', async (f,a,b,apid,bpid) => {
    await a.query('reset role; begin'); await a.query('select id from staff_users where id=$1 for update',[f.s]);
    const pending = begin(b,f).then(value=>({value}),error=>({error})); await waiting(db,bpid,apid);
    await a.query("update staff_users set status='inactive' where id=$1",[f.s]); await a.query('commit');
    assert.equal((await pending).error?.code,'P9004'); assert.equal((await operation(db,f)).status,'reserved');
  });
  await concurrency('106 unknown quota completion wins a ledger-lock wait and cannot be reactivated', async (f,a,b,apid,bpid) => {
    await a.query('begin'); await a.query('select id from content_generation_usage where id=$1 for update',[f.usage]);
    const pending = begin(b,f).then(value=>({value}),error=>({error})); await waiting(db,bpid,apid);
    await a.query("select public.complete_content_generation_usage($1,$2,'unknown','request_unknown',null,null)",[f.w,f.usage]); await a.query('commit');
    assert.equal((await pending).error?.code,'P9002'); assert.equal((await operation(db,f)).status,'reserved');
    assert.equal((await quota(db,f)).status,'unknown');
  });
  await concurrency('106 reservation expiry is checked after an actual operation-lock wait',async(f,a,b,apid,bpid)=>{
    await a.query('begin'); await a.query('select generation_key from generated_video_workflows where workspace_id=$1 for update',[f.w]);
    await a.query("update generated_video_workflows set reserved_until=clock_timestamp()+interval '100 milliseconds' where workspace_id=$1",[f.w]);
    const pending=begin(b,f).then(value=>({value}),error=>({error})); await waiting(db,bpid,apid);
    let expired=false;
    for(let n=0;n<150;n++) {
      expired=(await one(a,'select reserved_until<=clock_timestamp() expired from generated_video_workflows where workspace_id=$1',[f.w])).expired;
      if(expired) break; await delay(10);
    }
    assert.equal(expired,true); await a.query('commit'); assert.equal((await pending).error?.code,'P9003');
    assert.equal((await operation(db,f)).status,'reserved'); assert.equal((await quota(db,f)).status,'reserved');
  });
  await t.test('106 exact repeat preserves a committed bound operation and original quota', async () => {
    const f = await setup(db); await reserve(db,f);
    try {
      await service(db, () => begin(db,f)); const before = await operation(db,f), receipt = await quota(db,f);
      await db.query(source); assert.deepEqual(await operation(db,f),before); assert.deepEqual(await quota(db,f),receipt);
    } finally { await db.query('delete from workspaces where id=$1',[f.w]); }
  });
}
