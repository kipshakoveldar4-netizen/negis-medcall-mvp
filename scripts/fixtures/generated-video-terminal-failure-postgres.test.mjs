import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const read = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
const row = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const digest = value => createHash('sha256').update(value).digest('hex');
const actorArgs = who => [who.workspace, who.staff, who.auth];
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
const hash = digest('owned terminal failure fixture bytes; no provider or Storage');
const ackSignature = 'public.ack_generated_video_provider_failure(uuid,uuid,uuid,text,text,text)';

function identity(workspace, key = `v2:${randomUUID()}`) {
  const keyDigest = digest(JSON.stringify(['medina-generated-v1', workspace, key]));
  const bytes = createHash('sha1').update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex'))
    .update(`medina-generated-v1:${keyDigest}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return { key, keyDigest, assetId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    requestDigest: key.startsWith('v2:') ? digest(`owned fake request ${key}`) : null, fileName: `negis-video-${keyDigest.slice(0, 20)}.mp4` };
}
async function actor(db, workspace = randomUUID(), role = 'owner') {
  const who = { workspace, staff: randomUUID(), auth: randomUUID() };
  await db.query('insert into public.workspaces(id) values($1) on conflict do nothing', [workspace]);
  await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,role,status) values($1,$2,$3,$4,'active')", [who.staff, workspace, who.auth, role]);
  return who;
}
async function call(db, name, who, args) {
  assert.ok(['read_generated_video_workflow', 'admit_generated_video_workflow', 'begin_generated_video_dispatch', 'link_generated_video_provider',
    'bind_generated_video_input', 'queue_generated_video_workflow', 'ack_generated_video_provider_failure'].includes(name));
  const values = [...actorArgs(who), ...args];
  return (await row(db, `select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as value`, values)).value;
}
const admit = (db, who, id, provider = null) => call(db, 'admit_generated_video_workflow', who,
  [id.key, id.requestDigest, id.keyDigest, id.assetId, id.fileName, provider]);
const bind = (db, who, id) => call(db, 'bind_generated_video_input', who, [id.key, 100, hash, 'ad-creatives-raw']);
const ack = (db, who, state, provider = state.provider, status = 'failed') => call(db,
  'ack_generated_video_provider_failure', who, [state.id.key, provider, status]);
async function rendering(db, who, id = identity(who.workspace)) {
  await admit(db, who, id);
  const nonce = randomUUID(), provider = `owned-fake-provider-${randomUUID()}`;
  await call(db, 'begin_generated_video_dispatch', who, [id.key, nonce]);
  const envelope = await call(db, 'link_generated_video_provider', who, [id.key, nonce, provider]);
  return { id, nonce, provider, envelope };
}
async function snapshot(db, who) {
  return (await row(db, `select jsonb_build_object(
    'operations',coalesce((select jsonb_agg(to_jsonb(w) order by generation_key) from public.generated_video_workflows w where workspace_id=$1),'[]'::jsonb),
    'guards',coalesce((select jsonb_agg(to_jsonb(g)) from public.generated_video_admission_guards g where workspace_id=$1),'[]'::jsonb),
    'assets',coalesce((select jsonb_agg(to_jsonb(a) order by id) from public.ad_creative_assets a where workspace_id=$1),'[]'::jsonb),
    'jobs',coalesce((select jsonb_agg(to_jsonb(j) order by id) from public.video_processing_jobs j where workspace_id=$1),'[]'::jsonb)) as value`, [who.workspace])).value;
}
async function refuses(db, who, action, code = 'P9002') {
  const before = await snapshot(db, who);
  await assert.rejects(action(), { code });
  assert.deepEqual(await snapshot(db, who), before, 'Rejected acknowledgement/binding cannot partially change capacity, identity or assets');
}
async function waitForLock(db, waiter, holder) {
  for (let n = 0; n < 150; n++) {
    const result = await row(db, 'select pg_blocking_pids(pid) as blockers,wait_event_type from pg_stat_activity where pid=$1', [waiter]);
    if (result?.wait_event_type === 'Lock' && result.blockers.includes(holder)) return;
    await delay(20);
  }
  assert.fail('Expected owned PostgreSQL contender to wait on the controlled row lock');
}
async function peers(fixture, db, callback) {
  const clients = [], pids = [];
  try {
    for (let n = 0; n < 2; n++) {
      const client = await fixture.connect(); clients.push(client); await client.query('set role service_role');
      pids.push((await row(client, 'select pg_backend_pid() as pid')).pid);
    }
    await callback(...clients, pids);
  } finally {
    if (pids.length) await db.query("select pg_cancel_backend(pid) from pg_stat_activity where pid=any($1::integer[]) and state='active'", [pids]);
    for (const client of clients) { await client.query('rollback').catch(() => {}); await client.end(); }
  }
}

test('092 terminal provider failure runs actual 090/092 on owned PostgreSQL 17.11', {
  timeout: 300000,
  skip: process.env.MEDINA_TEST_POSTGRES_NATIVE !== '1' && 'Explicit owned native PostgreSQL opt-in required; no external database fallback',
}, async t => {
  const migration = await read('092_generated_video_terminal_failure.sql'), base = await read('090_generated_video_workflow.sql');
  t.diagnostic(`092 SHA-256 ${digest(migration)}; unchanged 090 SHA-256 ${digest(base)}`);
  const fixture = await startDisposablePostgres();
  try {
    const db = await fixture.connect();
    assert.equal((await row(db, 'show server_version_num')).server_version_num, '170011');
    await db.query(`create role anon nologin nobypassrls; create role authenticated nologin nobypassrls; create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      alter default privileges grant all on tables to public,anon,authenticated,service_role;
      alter default privileges grant execute on functions to public,anon,authenticated;
      create table public.workspaces(id uuid primary key);
      create table public.staff_users(id uuid primary key,workspace_id uuid references public.workspaces(id),auth_user_id uuid,role text,status text);
      create table public.meta_campaign_launches(id uuid primary key);
      create table public.owned_billing_sentinel(value integer); insert into public.owned_billing_sentinel values(0);`);
    for (const name of ['015_ad_creative_assets.sql', '016_video_processing_jobs.sql']) {
      const source = await read(name), boundary = source.indexOf('insert into storage.buckets');
      assert.ok(boundary > 0); await db.query(source.slice(0, boundary));
    }
    for (const name of ['017_video_jobs_completed_at.sql', '018_video_processing_jobs_contract.sql', '082_ad_creative_assets_server_access.sql',
      '085_generated_creative_identity.sql', '086_video_job_promotion.sql', '090_generated_video_workflow.sql']) await db.query(await read(name));
    const service = await fixture.connect(); await service.query('set role service_role');
    const blocked = await actor(db), first = await rendering(service, blocked), second = await rendering(service, blocked);
    await t.test('reproduce base defect: two known rendering rows exhaust slots and 090 cannot acknowledge terminal failure', async () => {
      await refuses(db, blocked, () => admit(service, blocked, identity(blocked.workspace)), 'P9005');
      assert.equal((await row(db, 'select to_regprocedure($1) as value', [ackSignature])).value, null);
      assert.equal((await snapshot(db, blocked)).operations.every(op => op.status === 'rendering'), true);
    });
    for (const kind of ['function', 'column']) await t.test(`inherited ${kind} grant causes atomic migration refusal`, async () => {
      await db.query('create role owned_legacy_access nologin; grant owned_legacy_access to authenticated');
      if (kind === 'function') await db.query('alter default privileges grant execute on functions to owned_legacy_access');
      else await db.query('grant select(generation_key) on public.generated_video_workflows to owned_legacy_access');
      try {
        await assert.rejects(db.query(migration), /generated_video_terminal_browser_(function|table)_access_unconfirmed/);
        await db.query('rollback');
        assert.equal((await row(db, "select count(*)::int as n from pg_attribute where attrelid='public.generated_video_workflows'::regclass and attname='provider_failure_receipt' and not attisdropped")).n, 0);
        assert.equal((await row(db, 'select to_regprocedure($1) as value', [ackSignature])).value, null);
      } finally {
        await db.query('rollback');
        if (kind === 'function') await db.query('alter default privileges revoke execute on functions from owned_legacy_access');
        else await db.query('revoke select(generation_key) on public.generated_video_workflows from owned_legacy_access');
        await db.query('revoke owned_legacy_access from authenticated; drop role owned_legacy_access');
      }
    });
    await db.query(migration);
    const unrelated = await actor(db); await rendering(service, unrelated); const unrelatedBefore = await snapshot(db, unrelated);
    await t.test('terminal ACK frees one slot but preserves the provider/key/digest and immutable server proof', async () => {
      const before = first.envelope.operation, result = await ack(service, blocked, first);
      assert.equal(result.operation.status, 'cancelled'); assert.equal(result.job, null); assert.equal(result.asset, null);
      for (const key of ['provider_job_id', 'generation_key', 'key_digest', 'request_digest', 'dispatch_id', 'asset_id', 'job_id']) assert.equal(result.operation[key], before[key], key);
      assert.equal(result.operation.provider_failure_receipt.kind, 'provider-terminal-failure-v1');
      assert.equal(result.operation.provider_failure_receipt.providerJobId, first.provider);
      assert.equal(result.operation.provider_failure_receipt.acknowledgedAt, result.operation.updated_at);
      const third = await admit(service, blocked, identity(blocked.workspace)); assert.equal(third.operation.status, 'reserved');
      await refuses(db, blocked, () => admit(service, blocked, identity(blocked.workspace)), 'P9005');
    });
    await t.test('lost ACK replay has the exact same receipt; no row, new asset or new job is minted', async () => {
      const one = await ack(service, blocked, first), two = await ack(service, blocked, first);
      assert.deepEqual(two, one); assert.equal((await snapshot(db, blocked)).assets.length, 0);
      assert.equal((await snapshot(db, blocked)).jobs.length, 0);
      const otherAdmin = await actor(db, blocked.workspace, 'admin');
      assert.deepEqual(await ack(service, otherAdmin, first), one, 'Workspace replay retains the original acknowledging actor');
    });
    for (const status of [null, 'queued', 'in_progress', 'completed', 'unknown', 'FAILED']) await t.test(`status ${String(status)} cannot free capacity`, async () => {
      await refuses(db, blocked, () => ack(service, blocked, second, second.provider, status), 'P9001');
    });
    await t.test('wrong provider on initial ACK and replay never changes the operation or guard', async () => {
      for (const state of [first, second]) await refuses(db, blocked, () => ack(service, blocked, state, 'other-owned-provider'));
    });
    await t.test('unlinked unknown dispatch stays quarantined even with a guessed failure id', async () => {
      const who = await actor(db), id = identity(who.workspace); await admit(service, who, id);
      await call(service, 'begin_generated_video_dispatch', who, [id.key, randomUUID()]);
      await refuses(db, who, () => ack(service, who, { id, provider: 'unknown-provider' }));
    });
    await t.test('legacy signed job identity is retained on failure without minting a v2 request or dispatch', async () => {
      const who = await actor(db), id = identity(who.workspace, `owned-legacy-${randomUUID()}`);
      await admit(service, who, id, id.key);
      const result = await ack(service, who, { id, provider: id.key });
      assert.equal(result.operation.status, 'cancelled'); assert.equal(result.operation.provider_job_id, id.key);
      assert.equal(result.operation.generation_key, id.key); assert.equal(result.operation.dispatch_id, null);
      assert.equal(result.operation.request_digest, null); assert.equal(result.operation.provider_failure_receipt.requestDigest, null);
    });
    await t.test('an error after writing the proof rolls back acknowledgement and admission-guard changes atomically', async () => {
      const who = await actor(db), state = await rendering(service, who);
      await db.query(`create function public.owned_fail_terminal_ack() returns trigger language plpgsql as $$ begin
        if new.workspace_id='${who.workspace}'::uuid and new.provider_failure_receipt is not null then
          raise exception using errcode='P9992',message='owned synthetic post-write refusal'; end if; return new; end $$;
        create trigger owned_fail_terminal_ack after update on public.generated_video_workflows
          for each row execute function public.owned_fail_terminal_ack()`);
      try { await refuses(db, who, () => ack(service, who, state), 'P9992'); }
      finally { await db.query('drop trigger owned_fail_terminal_ack on public.generated_video_workflows; drop function public.owned_fail_terminal_ack()'); }
      assert.equal((await snapshot(db, who)).operations[0].status, 'rendering');
    });
    for (const role of ['lead_manager', 'doctor', 'manager']) await t.test(`${role} cannot acknowledge a provider failure`, async () => {
      const who = await actor(db), state = await rendering(service, who); await db.query('update public.staff_users set role=$2 where id=$1', [who.staff, role]);
      await refuses(db, who, () => ack(service, who, state), 'P9004');
    });
    await t.test('revoked actor and cross-workspace actor cannot acknowledge failure', async () => {
      const who = await actor(db), state = await rendering(service, who), stranger = await actor(db);
      await refuses(db, who, () => ack(service, { ...stranger, workspace: who.workspace }, state), 'P9004');
      await db.query("update public.staff_users set status='inactive' where id=$1", [who.staff]);
      await refuses(db, who, () => ack(service, who, state), 'P9004');
    });
    await t.test('input binding and queued work refuse terminal cancellation without partial writes', async () => {
      const who = await actor(db), state = await rendering(service, who); await bind(service, who, state.id);
      await refuses(db, who, () => ack(service, who, state));
      await call(service, 'queue_generated_video_workflow', who, [state.id.key]);
      await refuses(db, who, () => ack(service, who, state));
    });
    for (const winner of ['bind', 'ack']) await t.test(`${winner} wins concurrent input/terminal ACK serialization; loser cannot partially commit`, async () => {
      const who = await actor(db), state = await rendering(service, who);
      await peers(fixture, db, async (holder, waiter, pids) => {
        await holder.query('begin');
        if (winner === 'bind') await bind(holder, who, state.id); else await ack(holder, who, state);
        const pending = observe(winner === 'bind' ? ack(waiter, who, state) : bind(waiter, who, state.id));
        await waitForLock(db, pids[1], pids[0]); await holder.query('commit');
        const outcome = await pending; assert.equal(outcome.error?.code, winner === 'bind' ? 'P9002' : 'P9003');
      });
      const after = await snapshot(db, who); assert.equal(after.operations[0].status, winner === 'bind' ? 'awaiting_upload' : 'cancelled');
      assert.equal(after.assets.length, winner === 'bind' ? 1 : 0); assert.equal(after.jobs.length, winner === 'bind' ? 1 : 0);
    });
    await t.test('two concurrent terminal ACKs retain one exact immutable proof and do not release two slots', async () => {
      const who = await actor(db), state = await rendering(service, who); await rendering(service, who);
      await peers(fixture, db, async (holder, waiter, pids) => {
        await holder.query('begin'); const firstAck = await ack(holder, who, state);
        const pending = observe(ack(waiter, who, state)); await waitForLock(db, pids[1], pids[0]); await holder.query('commit');
        const secondAck = await pending; assert.equal(secondAck.error, undefined); assert.deepEqual(secondAck.value, firstAck);
      });
      await admit(service, who, identity(who.workspace));
      await refuses(db, who, () => admit(service, who, identity(who.workspace)), 'P9005');
    });
    await t.test('admission waits for a terminal ACK to commit before reusing exactly one slot', async () => {
      const who = await actor(db), state = await rendering(service, who); await rendering(service, who);
      await peers(fixture, db, async (holder, waiter, pids) => {
        await holder.query('begin'); await ack(holder, who, state);
        const pending = observe(admit(waiter, who, identity(who.workspace)));
        await waitForLock(db, pids[1], pids[0]); await holder.query('commit');
        const admitted = await pending; assert.equal(admitted.error, undefined); assert.equal(admitted.value.operation.status, 'reserved');
      });
      await refuses(db, who, () => admit(service, who, identity(who.workspace)), 'P9005');
    });
    for (const isolation of ['repeatable read', 'serializable']) await t.test(`${isolation} stale snapshots cannot acknowledge across a committed input bind`, async () => {
      const who = await actor(db), state = await rendering(service, who);
      await peers(fixture, db, async (holder, waiter) => {
        await waiter.query(`begin isolation level ${isolation}`); await waiter.query('select count(*) from public.generated_video_workflows');
        await bind(holder, who, state.id);
        await assert.rejects(ack(waiter, who, state), { code: '40001' }); await waiter.query('rollback');
      });
      assert.equal((await snapshot(db, who)).operations[0].status, 'awaiting_upload');
    });
    await t.test('role withdrawal held before ACK is checked after lock wait, not accepted from stale membership', async () => {
      const who = await actor(db), state = await rendering(service, who);
      await peers(fixture, db, async (holder, waiter, pids) => {
        await holder.query('begin'); await holder.query("update public.staff_users set status='inactive' where id=$1", [who.staff]);
        const pending = observe(ack(waiter, who, state)); await waitForLock(db, pids[1], pids[0]); await holder.query('commit');
        assert.equal((await pending).error?.code, 'P9004');
      });
      assert.equal((await snapshot(db, who)).operations[0].status, 'rendering');
    });
    await t.test('proof cannot be removed, forged, altered or deleted directly; cancelled key cannot restart dispatch', async () => {
      const who = await actor(db), state = await rendering(service, who); await ack(service, who, state);
      for (const sql of ["update public.generated_video_workflows set provider_failure_receipt=null where workspace_id=$1",
        "update public.generated_video_workflows set provider_failure_receipt=provider_failure_receipt||'{\"status\":\"completed\"}' where workspace_id=$1",
        "update public.generated_video_workflows set input_size=1,input_sha256=repeat('a',64),raw_bucket='ad-creatives-raw',raw_path='forged' where workspace_id=$1",
        'delete from public.generated_video_workflows where workspace_id=$1']) await refuses(db, who, () => service.query(sql, [who.workspace]));
      const replay = await call(service, 'begin_generated_video_dispatch', who, [state.id.key, randomUUID()]);
      assert.equal(replay.dispatchAccepted, false); assert.equal(replay.operation.status, 'cancelled');
      await refuses(db, who, () => admit(service, who, state.id), 'P9003');
    });
    await t.test('a linked rendering row cannot be cancelled directly without a terminal proof', async () => {
      const who = await actor(db); await rendering(service, who);
      await refuses(db, who, () => service.query("update public.generated_video_workflows set status='cancelled' where workspace_id=$1", [who.workspace]));
    });
    await t.test('ready native processing refuses the ACK without modifying promotion proof', async () => {
      const who = await actor(db), state = await rendering(service, who), bound = await bind(service, who, state.id);
      await call(service, 'queue_generated_video_workflow', who, [state.id.key]);
      const job = bound.operation.job_id, claim = '2026-10-25T00:00:00Z', worker = 'owned-terminal-worker';
      await db.query("update public.video_processing_jobs set status='uploading',claimed_by=$2,claimed_at=$3,attempts=1 where id=$1", [job, worker, claim]);
      const version = (await row(db, "select to_jsonb(a)->>'updated_at' as value from public.ad_creative_assets a where id=$1", [state.id.assetId])).value;
      const path = `optimized/${who.workspace}/${job}-${hash.slice(0, 20)}.mp4`, thumbnail = path.slice(0, -4) + '-thumbnail.jpg';
      const origin = 'https://terminal.fixture.invalid', url = path => `${origin}/storage/v1/object/public/ad-creatives/${path}`;
      const proof = { storage_origin: origin, storage_bucket: 'ad-creatives', storage_path: path, public_url: url(path), file_size: 40,
        sha256: hash, thumbnail_path: thumbnail, thumbnail_public_url: url(thumbnail), thumbnail_size: 12, thumbnail_sha256: hash, input_size: 100 };
      await service.query('select public.finalize_video_job($1,$2,$3,$4,$5,$6,$7)', [job, who.workspace, worker, claim, 1, version, proof]);
      await service.query('select public.finalize_generated_video_workflow($1,$2,$3,$4)', [...actorArgs(who), state.id.key]);
      await refuses(db, who, () => ack(service, who, state));
    });
    await t.test('migration closes browser table, column and function rights despite permissive defaults and policies', async () => {
      await db.query('create policy owned_wide on public.generated_video_workflows for all to anon,authenticated using(true) with check(true)');
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await row(db, "select has_any_column_privilege($1,'public.generated_video_workflows','SELECT,INSERT,UPDATE,REFERENCES') as value", [role])).value, false);
        for (const signature of [ackSignature, 'public.protect_generated_video_terminal_failure()']) assert.equal((await row(db,
          "select has_function_privilege($1,$2,'EXECUTE') as value", [role, signature])).value, false);
        const browser = await fixture.connect();
        try {
          await browser.query(`set role ${role}`);
          await assert.rejects(browser.query('select provider_failure_receipt from public.generated_video_workflows'), { code: '42501' });
          await assert.rejects(ack(browser, blocked, first), { code: '42501' });
        } finally { await browser.end(); }
      }
      const functions = (await db.query(`select prosecdef,proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and proname in ('ack_generated_video_provider_failure','protect_generated_video_terminal_failure')`)).rows;
      assert.equal(functions.length, 2);
      for (const f of functions) { assert.equal(f.prosecdef, false); assert.deepEqual(f.proconfig, ['search_path=""']); }
    });
    await t.test('workspace deletion can remove its own audit proof while unrelated rows, staff and zero billing sentinel remain unchanged', async () => {
      const who = await actor(db), state = await rendering(service, who); await ack(service, who, state);
      await db.query('delete from public.staff_users where workspace_id=$1', [who.workspace]);
      await db.query('delete from public.workspaces where id=$1', [who.workspace]);
      assert.deepEqual(await snapshot(db, who), { operations: [], guards: [], jobs: [], assets: [] });
      assert.deepEqual(await snapshot(db, unrelated), unrelatedBefore);
      assert.deepEqual((await db.query('select * from public.owned_billing_sentinel')).rows, [{ value: 0 }]);
    });
    await service.end();
    t.diagnostic('Actual SQL decides eligibility, capacity, locking, immutability and ACL. Provider observations and native receipt bytes are synthetic; no external service or billing was contacted.');
  } finally { await fixture.close(); }
});
