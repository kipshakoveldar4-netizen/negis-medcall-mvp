import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const read = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
const row = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
const digest = value => createHash('sha256').update(value).digest('hex');
const inputHash = digest('owned fixture synthetic private MP4 bytes; not an actual video');
const outputHash = digest('owned fixture synthetic native output receipt; no Storage HTTP');
const thumbHash = digest('owned fixture synthetic native thumbnail receipt');
const origin = 'https://generated-video.fixture.invalid';
const rawBucket = 'ad-creatives-raw';
const worker = 'owned-fixture-worker', claimAt = '2026-10-25T00:00:00.000Z';
const fence = { kind: 'occupied-key-v1', size: 56,
  sha256: '7522cc049e7a011985341bb575c7634f6333318a191b08beb1196b7e7426c1e2' };
const actorArgs = actor => [actor.workspace, actor.staff, actor.auth];
const rpcNames = [
  'read_generated_video_workflow', 'admit_generated_video_workflow', 'begin_generated_video_dispatch',
  'link_generated_video_provider', 'cancel_generated_video_workflow', 'bind_generated_video_input',
  'queue_generated_video_workflow', 'finalize_generated_video_workflow',
];
const technicalTables = ['generated_video_workflows', 'generated_video_admission_guards'];
const allFunctionNames = ['assert_generated_video_actor', 'protect_generated_video_workflow',
  'protect_generated_video_asset_proof', 'generated_video_envelope', ...rpcNames, 'ack_generated_video_raw_reclamation'];

// Fixture input identities use the producer's documented hashing recipe. All state
// transitions, access decisions and capacity checks execute the actual migrations.
function identity(workspace, key = `v2:${randomUUID()}`) {
  const keyDigest = digest(JSON.stringify(['medina-generated-v1', workspace, key]));
  const id = createHash('sha1').update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex'))
    .update(`medina-generated-v1:${keyDigest}`).digest().subarray(0, 16);
  id[6] = (id[6] & 15) | 80;
  id[8] = (id[8] & 63) | 128;
  const hex = id.toString('hex');
  return { key, keyDigest,
    assetId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    fileName: `negis-video-${keyDigest.slice(0, 20)}.mp4`, requestDigest: digest(`owned fake request ${key}`) };
}

async function actor(db, workspace = randomUUID(), role = 'owner') {
  const result = { workspace, staff: randomUUID(), auth: randomUUID() };
  await db.query('insert into public.workspaces(id) values($1) on conflict do nothing', [workspace]);
  await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,role,status)
    values($1,$2,$3,$4,'active')`, [result.staff, workspace, result.auth, role]);
  return result;
}

async function call(db, name, who, args = []) {
  assert.ok(rpcNames.includes(name), 'Only the explicit generated-video RPCs are invoked');
  const values = [...actorArgs(who), ...args];
  return (await row(db, `select public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) as result`, values)).result;
}

const readWorkflow = (db, who, key) => call(db, 'read_generated_video_workflow', who, [key]);
const admit = (db, who, id = identity(who.workspace), provider = null) => call(db,
  'admit_generated_video_workflow', who, [id.key, provider === null ? id.requestDigest : null,
    id.keyDigest, id.assetId, id.fileName, provider]);
const begin = (db, who, id, nonce = randomUUID()) => call(db, 'begin_generated_video_dispatch', who, [id.key, nonce]);
const link = (db, who, id, nonce, provider = `fake-provider-${randomUUID()}`) => call(db,
  'link_generated_video_provider', who, [id.key, nonce, provider]);
const cancel = (db, who, id, nonce = null, known = false) => call(db,
  'cancel_generated_video_workflow', who, [id.key, nonce, known]);
const bind = (db, who, id, size = 100, hash = inputHash, bucket = rawBucket) => call(db,
  'bind_generated_video_input', who, [id.key, size, hash, bucket]);
const queue = (db, who, id) => call(db, 'queue_generated_video_workflow', who, [id.key]);
const finish = (db, who, id) => call(db, 'finalize_generated_video_workflow', who, [id.key]);

async function reclaim(db, who, state, overrides = {}) {
  const args = [state.envelope.operation.job_id, who.workspace, worker, claimAt, 1, fence.size, fence.sha256]
    .map((value, index) => Object.hasOwn(overrides, index) ? overrides[index] : value);
  return (await row(db, 'select public.ack_generated_video_raw_reclamation($1,$2,$3,$4,$5,$6,$7) as result', args)).result;
}

async function rendering(db, who, id = identity(who.workspace)) {
  await admit(db, who, id);
  const nonce = randomUUID();
  await begin(db, who, id, nonce);
  return { id, nonce, envelope: await link(db, who, id, nonce) };
}

async function bound(db, who, id = identity(who.workspace)) {
  const state = await rendering(db, who, id);
  return { ...state, envelope: await bind(db, who, id) };
}

async function queued(db, who, id = identity(who.workspace)) {
  const state = await bound(db, who, id);
  return { ...state, envelope: await queue(db, who, id) };
}

function nativeResult(who, job) {
  const path = `optimized/${who.workspace}/${job}-${outputHash.slice(0, 20)}.mp4`;
  const thumbnail = `${path.slice(0, -4)}-thumbnail.jpg`;
  return { storage_origin: origin, storage_bucket: 'ad-creatives', storage_path: path,
    public_url: `${origin}/storage/v1/object/public/ad-creatives/${path}`, file_size: 40, sha256: outputHash,
    thumbnail_path: thumbnail, thumbnail_public_url: `${origin}/storage/v1/object/public/ad-creatives/${thumbnail}`,
    thumbnail_size: 12, thumbnail_sha256: thumbHash, input_size: 100 };
}

async function promote(db, service, who, state) {
  const operation = state.envelope.operation;
  await db.query(`update public.video_processing_jobs set status='uploading',claimed_by=$3,
    claimed_at=$2,attempts=1 where id=$1`, [operation.job_id, claimAt, worker]);
  const version = (await row(db, `select to_jsonb(a)->>'updated_at' as version
    from public.ad_creative_assets a where id=$1`, [operation.asset_id])).version;
  const receipt = nativeResult(who, operation.job_id);
  const saved = (await row(service, `select public.finalize_video_job($1,$2,$3,$4,$5,$6,$7) as result`,
    [operation.job_id, who.workspace, worker, claimAt, 1, version, receipt])).result;
  assert.equal(saved.status, 'ready');
  return receipt;
}

async function snapshot(db, workspace) {
  return (await row(db, `select jsonb_build_object(
    'operations',coalesce((select jsonb_agg(to_jsonb(w) order by generation_key)
      from public.generated_video_workflows w where workspace_id=$1),'[]'::jsonb),
    'guards',coalesce((select jsonb_agg(to_jsonb(g))
      from public.generated_video_admission_guards g where workspace_id=$1),'[]'::jsonb),
    'jobs',coalesce((select jsonb_agg(to_jsonb(j) order by id)
      from public.video_processing_jobs j where workspace_id=$1),'[]'::jsonb),
    'assets',coalesce((select jsonb_agg(to_jsonb(a) order by id)
      from public.ad_creative_assets a where workspace_id=$1),'[]'::jsonb)) as value`, [workspace])).value;
}

async function refuses(db, who, callback, code) {
  const before = await snapshot(db, who.workspace);
  await assert.rejects(callback(), error => error.code === code);
  assert.deepEqual(await snapshot(db, who.workspace), before, 'Refusal must not partially write any workflow, guard, asset or job');
}

async function waitForLock(db, waiter, holder) {
  for (let n = 0; n < 150; n++) {
    const state = await row(db, `select pg_blocking_pids(pid) as blockers,wait_event_type
      from pg_stat_activity where pid=$1`, [waiter]);
    if (state?.wait_event_type === 'Lock' && state.blockers.includes(holder)) return;
    await delay(20);
  }
  assert.fail('Expected the owned PostgreSQL contender to wait on the controlled row lock');
}

async function peers(fixture, db, callback) {
  const clients = [], pids = [];
  try {
    for (let i = 0; i < 2; i++) {
      const client = await fixture.connect();
      clients.push(client);
      await client.query('set role service_role');
      pids.push((await row(client, 'select pg_backend_pid() as pid')).pid);
    }
    await callback(clients[0], clients[1], pids);
  } finally {
    if (pids.length) await db.query(`select pg_cancel_backend(pid) from pg_stat_activity
      where pid=any($1::integer[]) and state='active'`, [pids]);
    for (const client of clients) {
      await client.query('rollback').catch(() => {});
      await client.end();
    }
  }
}

test('G5-C56 generated video workflow uses actual 086/090 on owned PostgreSQL 17.11', {
  timeout: 300000,
  skip: process.env.MEDINA_TEST_POSTGRES_NATIVE !== '1'
    && 'Explicit MEDINA_TEST_POSTGRES_NATIVE=1 required; no Docker or external database fallback',
}, async t => {
  const migration = await read('090_generated_video_workflow.sql');
  const promotion = await read('086_video_job_promotion.sql');
  t.diagnostic(`090 SHA-256: ${digest(migration)}`);
  t.diagnostic(`086 SHA-256: ${digest(promotion)}`);
  const fixture = await startDisposablePostgres();
  try {
    const db = await fixture.connect();
    assert.equal((await row(db, 'show server_version_num')).server_version_num, '170011');
    await db.query(`create role anon nologin nobypassrls;
      create role authenticated nologin nobypassrls;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      alter default privileges grant all on tables to public,anon,authenticated,service_role;
      alter default privileges grant execute on functions to public,anon,authenticated;
      create table public.workspaces(id uuid primary key);
      create table public.staff_users(id uuid primary key,workspace_id uuid references public.workspaces(id),
        auth_user_id uuid,role text not null,status text not null default 'active');
      create table public.meta_campaign_launches(id uuid primary key);
      create table public.synthetic_subscription_sentinel(id uuid primary key,amount integer);
      insert into public.synthetic_subscription_sentinel values(gen_random_uuid(),0);`);
    for (const name of ['015_ad_creative_assets.sql', '016_video_processing_jobs.sql']) {
      const source = await read(name), boundary = source.indexOf('insert into storage.buckets');
      assert.ok(boundary > 0, 'Storage provisioning is deliberately excluded; no Storage HTTP is modeled by this SQL fixture');
      await db.query(source.slice(0, boundary));
    }
    for (const name of ['017_video_jobs_completed_at.sql', '018_video_processing_jobs_contract.sql',
      '082_ad_creative_assets_server_access.sql', '085_generated_creative_identity.sql']) await db.query(await read(name));

    await t.test('missing native promotion dependency refuses 090 without partial schema', async () => {
      try { await assert.rejects(db.query(migration), /generated_video_dependencies_unconfirmed/); }
      finally { await db.query('rollback'); }
      assert.equal((await row(db, "select to_regclass('public.generated_video_workflows') as value")).value, null);
      assert.equal((await row(db, "select count(*)::int as count from pg_attribute where attrelid='public.ad_creative_assets'::regclass and attname='generated_video_job_id' and not attisdropped")).count, 0);
    });
    await db.query(promotion);
    await t.test('inherited legacy browser column access aborts 090 without partial new tables or proof columns', async () => {
      await db.query(`create role synthetic_generated_legacy nologin;
        grant synthetic_generated_legacy to authenticated;
        grant select(raw_path) on public.video_processing_jobs to synthetic_generated_legacy`);
      try {
        try { await assert.rejects(db.query(migration), /generated_video_browser_table_access_unconfirmed/); }
        finally { await db.query('rollback'); }
        assert.equal((await row(db, "select to_regclass('public.generated_video_workflows') as value")).value, null);
        assert.equal((await row(db, "select count(*)::int as count from pg_attribute where attrelid='public.ad_creative_assets'::regclass and attname='generated_video_job_id' and not attisdropped")).count, 0);
      } finally {
        await db.query(`revoke synthetic_generated_legacy from authenticated;
          revoke select(raw_path) on public.video_processing_jobs from synthetic_generated_legacy;
          drop role synthetic_generated_legacy`);
      }
    });
    for (const kind of ['table', 'function']) {
      await t.test(`inherited ${kind} default grants abort 090 rather than leave indirect browser access`, async () => {
        await db.query(`create role synthetic_generated_default nologin;
          grant synthetic_generated_default to authenticated`);
        const grant = kind === 'table' ? 'all on tables' : 'execute on functions';
        await db.query(`alter default privileges grant ${grant} to synthetic_generated_default`);
        try {
          try { await assert.rejects(db.query(migration), /generated_video_browser_(table|function)_access_unconfirmed/); }
          finally { await db.query('rollback'); }
          assert.equal((await row(db, "select to_regclass('public.generated_video_workflows') as value")).value, null);
          assert.equal((await row(db, "select count(*)::int as count from pg_attribute where attrelid='public.ad_creative_assets'::regclass and attname='generated_video_job_id' and not attisdropped")).count, 0);
        } finally {
          await db.query(`alter default privileges revoke ${grant} from synthetic_generated_default`);
          await db.query(`revoke synthetic_generated_default from authenticated; drop role synthetic_generated_default`);
        }
      });
    }
    await db.query(migration);
    const service = await fixture.connect();
    await service.query('set role service_role');
    const other = await actor(db), otherId = identity(other.workspace);
    await admit(service, other, otherId);
    const otherBefore = await snapshot(db, other.workspace);
    const sentinelBefore = (await db.query('select to_jsonb(s) as value from public.synthetic_subscription_sentinel s')).rows;

    await t.test('broad table/function defaults cannot give browsers any RPC, table or column access', async () => {
      for (const table of technicalTables) await db.query(`create policy synthetic_broad on public.${table}
        for all to anon,authenticated using(true) with check(true)`);
      const functions = (await db.query(`select p.oid::regprocedure::text as signature from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])`, [allFunctionNames])).rows;
      assert.equal(functions.length, 13);
      for (const role of ['anon', 'authenticated']) {
        for (const table of [...technicalTables, 'ad_creative_assets', 'video_processing_jobs']) {
          assert.equal((await row(db, 'select relrowsecurity from pg_class where oid=$1::regclass', [`public.${table}`])).relrowsecurity, true);
          assert.equal((await row(db, `select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            or has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as allowed`, [role, `public.${table}`])).allowed, false);
        }
        for (const fn of functions) assert.equal((await row(db, "select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, fn.signature])).allowed, false);
        const browser = await fixture.connect();
        try {
          await browser.query(`set role ${role}`);
          for (const table of technicalTables) {
            await assert.rejects(browser.query(`select * from public.${table}`), { code: '42501' });
            await assert.rejects(browser.query(`delete from public.${table}`), { code: '42501' });
          }
          await assert.rejects(browser.query('select generated_video_job_id from public.ad_creative_assets'), { code: '42501' });
          await assert.rejects(browser.query('select raw_reclamation_receipt from public.video_processing_jobs'), { code: '42501' });
          await assert.rejects(readWorkflow(browser, other, otherId.key), { code: '42501' });
          await assert.rejects(reclaim(browser, other, { envelope: { operation: { job_id: randomUUID() } } }), { code: '42501' });
        } finally { await browser.end(); }
      }
    });

    await t.test('all generated-video functions keep invoker rights and an empty search path', async () => {
      const functions = (await db.query(`select p.proname,p.prosecdef,p.proconfig from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])`, [allFunctionNames])).rows;
      assert.equal(functions.length, 13);
      for (const fn of functions) {
        assert.equal(fn.prosecdef, false, fn.proname);
        assert.deepEqual(fn.proconfig, ['search_path=""'], fn.proname);
      }
    });

    await t.test('reservation precedes provider dispatch and creates no public/raw asset or job', async () => {
      const who = await actor(db), id = identity(who.workspace);
      const envelope = await admit(service, who, id);
      assert.deepEqual(Object.keys(envelope).sort(), ['asset', 'job', 'operation']);
      assert.equal(envelope.asset, null); assert.equal(envelope.job, null);
      const op = envelope.operation;
      assert.equal(op.status, 'reserved'); assert.equal(op.provider_job_id, null); assert.equal(op.dispatch_id, null);
      assert.equal(op.input_size, null); assert.equal(op.result, null);
      assert.equal(op.asset_id, id.assetId); assert.equal(op.file_name, id.fileName); assert.equal(op.key_digest, id.keyDigest);
      assert.equal(op.created_by_staff_user_id, who.staff); assert.equal(op.created_by_auth_user_id, who.auth);
      const seconds = (await row(db, `select extract(epoch from reserved_until-created_at)::numeric as seconds
        from public.generated_video_workflows where workspace_id=$1`, [who.workspace])).seconds;
      assert.ok(Number(seconds) > 119 && Number(seconds) <= 120);
      assert.deepEqual(await admit(service, who, id), envelope);
      await refuses(db, who, () => admit(service, who, { ...id, requestDigest: digest('different prompt') }), 'P9002');
    });

    await t.test('invalid source identities are rejected without admission or partial rows', async () => {
      const who = await actor(db), id = identity(who.workspace);
      for (const changes of [{ key: 'v2:not-a-uuid' }, { keyDigest: 'a'.repeat(64) }, { assetId: randomUUID() },
        { fileName: 'raw.mp4' }, { requestDigest: null }, { requestDigest: 'not-a-hash' }]) {
        await refuses(db, who, () => admit(service, who, { ...id, ...changes }), 'P9001');
      }
    });

    await t.test('dispatch nonce retries replay acceptance; another request cannot dispatch twice', async () => {
      const who = await actor(db), id = identity(who.workspace), nonce = randomUUID();
      await admit(service, who, id);
      const first = await begin(service, who, id, nonce), before = await snapshot(db, who.workspace);
      assert.equal(first.dispatchAccepted, true); assert.equal(first.operation.status, 'dispatching');
      assert.deepEqual(await begin(service, who, id, nonce), first);
      const denied = await begin(service, who, id, randomUUID());
      assert.equal(denied.dispatchAccepted, false); assert.deepEqual(denied.operation, first.operation);
      assert.deepEqual(await snapshot(db, who.workspace), before);
      await refuses(db, who, () => begin(service, who, id, null), 'P9001');
    });

    await t.test('provider link replay is exact and cannot replace the provider or dispatch identity', async () => {
      const who = await actor(db), { id, nonce, envelope } = await rendering(service, who);
      const before = await snapshot(db, who.workspace);
      assert.equal(envelope.operation.status, 'rendering');
      assert.deepEqual(await link(service, who, id, nonce, envelope.operation.provider_job_id), envelope);
      await refuses(db, who, () => link(service, who, id, nonce, 'another-fake-provider'), 'P9002');
      await refuses(db, who, () => link(service, who, id, randomUUID(), envelope.operation.provider_job_id), 'P9002');
      assert.deepEqual(await snapshot(db, who.workspace), before);
      assert.equal((await begin(service, who, id, nonce)).dispatchAccepted, false);
    });

    await t.test('two competing API dispatches serialize and only one fresh nonce owns the provider call', async () => {
      const who = await actor(db), id = identity(who.workspace), firstNonce = randomUUID(), secondNonce = randomUUID();
      await admit(service, who, id);
      await peers(fixture, db, async (holder, waiter, pids) => {
        await holder.query('begin');
        const first = await begin(holder, who, id, firstNonce);
        assert.equal(first.dispatchAccepted, true);
        const pending = observe(begin(waiter, who, id, secondNonce));
        await waitForLock(db, pids[1], pids[0]);
        await holder.query('commit');
        const second = await pending;
        assert.equal(second.error, undefined); assert.equal(second.value.dispatchAccepted, false);
        assert.deepEqual(second.value.operation, first.operation);
      });
      assert.equal((await readWorkflow(service, who, id.key)).operation.dispatch_id, firstNonce);
    });

    await t.test('another marketing administrator in the same workspace may resume, another workspace may not', async () => {
      const who = await actor(db), admin = await actor(db, who.workspace, 'admin'), marketer = await actor(db, who.workspace, 'marketer');
      const { id, envelope } = await rendering(service, who);
      assert.deepEqual(await readWorkflow(service, admin, id.key), envelope);
      assert.deepEqual(await readWorkflow(service, marketer, id.key), envelope);
      const resumed = await bind(service, admin, id);
      assert.equal(resumed.operation.created_by_staff_user_id, who.staff);
      await refuses(db, who, () => readWorkflow(service, { ...other, workspace: who.workspace }, id.key), 'P9004');
      assert.equal(await readWorkflow(service, other, id.key), null);
    });

    await t.test('revoked role, inactive status or changed auth identity refuse all resumptions before changing rows', async () => {
      const who = await actor(db), { id, nonce } = await rendering(service, who);
      for (const change of [{ role: 'lead_manager' }, { status: 'inactive' }, { auth_user_id: randomUUID() }]) {
        const [column, value] = Object.entries(change)[0];
        await db.query(`update public.staff_users set ${column}=$2 where id=$1`, [who.staff, value]);
        for (const invoke of [() => readWorkflow(service, who, id.key), () => begin(service, who, id, nonce),
          () => link(service, who, id, nonce), () => bind(service, who, id), () => queue(service, who, id),
          () => finish(service, who, id), () => cancel(service, who, id)]) await refuses(db, who, invoke, 'P9004');
        await db.query("update public.staff_users set role='owner',status='active',auth_user_id=$2 where id=$1", [who.staff, who.auth]);
      }
    });

    await t.test('withdrawal committed while actor row is locked is observed after the wait', async () => {
      const who = await actor(db), id = identity(who.workspace);
      await admit(service, who, id);
      await peers(fixture, db, async (holder, waiter, pids) => {
        await holder.query('begin');
        await holder.query('select id from public.staff_users where id=$1 for update', [who.staff]);
        const pending = observe(begin(waiter, who, id));
        await waitForLock(db, pids[1], pids[0]);
        await holder.query("update public.staff_users set role='lead_manager' where id=$1", [who.staff]);
        await holder.query('commit');
        assert.equal((await pending).error?.code, 'P9004');
      });
      const saved = (await snapshot(db, who.workspace)).operations[0];
      assert.equal(saved.status, 'reserved'); assert.equal(saved.dispatch_id, null);
    });

    await t.test('predispatch lease expiry is checked after the workflow row lock wait', async () => {
      const who = await actor(db), id = identity(who.workspace);
      await admit(service, who, id);
      await peers(fixture, db, async (holder, waiter, pids) => {
        await holder.query('begin');
        await holder.query(`select generation_key from public.generated_video_workflows
          where workspace_id=$1 and generation_key=$2 for update`, [who.workspace, id.key]);
        const pending = observe(begin(waiter, who, id));
        await waitForLock(db, pids[1], pids[0]);
        await holder.query(`update public.generated_video_workflows set reserved_until=clock_timestamp()-interval '1 second'
          where workspace_id=$1 and generation_key=$2`, [who.workspace, id.key]);
        await holder.query('commit');
        assert.equal((await pending).error?.code, 'P9003');
      });
      assert.equal((await readWorkflow(service, who, id.key)).operation.status, 'reserved');
      await refuses(db, who, () => admit(service, who, id), 'P9003');
    });

    await t.test('admission replay also evaluates lease expiry after the operation row lock wait', async () => {
      const who = await actor(db), id = identity(who.workspace);
      await admit(service, who, id);
      await peers(fixture, db, async (holder, waiter, pids) => {
        await holder.query('begin');
        await holder.query(`update public.generated_video_workflows set reserved_until=clock_timestamp()+interval '2 seconds'
          where workspace_id=$1 and generation_key=$2`, [who.workspace, id.key]);
        const pending = observe(admit(waiter, who, id));
        await waitForLock(db, pids[1], pids[0]);
        assert.equal((await row(holder, `select reserved_until>clock_timestamp() as live
          from public.generated_video_workflows where workspace_id=$1 and generation_key=$2`, [who.workspace, id.key])).live,
        true, 'The admission must already be blocked before its original lease expires');
        let expired = false;
        for (let n = 0; n < 150; n++) {
          expired = (await row(holder, `select reserved_until<=clock_timestamp() as expired
            from public.generated_video_workflows where workspace_id=$1 and generation_key=$2`, [who.workspace, id.key])).expired;
          if (expired) break;
          await delay(20);
        }
        assert.equal(expired, true, 'The controlled PostgreSQL clock has crossed the reservation deadline');
        await holder.query('commit');
        assert.equal((await pending).error?.code, 'P9003');
      });
    });

    await t.test('unknown dispatches stay quarantined after the lease and cannot be cancelled as ordinary retries', async () => {
      const who = await actor(db), entries = [];
      for (let i = 0; i < 2; i++) {
        const id = identity(who.workspace), nonce = randomUUID();
        await admit(service, who, id); await begin(service, who, id, nonce); entries.push({ id, nonce });
      }
      await db.query(`update public.generated_video_workflows set reserved_until=clock_timestamp()-interval '3 hours'
        where workspace_id=$1`, [who.workspace]);
      for (const { id, nonce } of entries) {
        await refuses(db, who, () => cancel(service, who, id, nonce, false), 'P9002');
        await refuses(db, who, () => cancel(service, who, id, randomUUID(), true), 'P9002');
        assert.equal((await begin(service, who, id, randomUUID())).dispatchAccepted, false);
      }
      await refuses(db, who, () => admit(service, who), 'P9005');
      const { id, nonce } = entries[0], cancelled = await cancel(service, who, id, nonce, true);
      assert.equal(cancelled.operation.status, 'cancelled');
      assert.deepEqual(await cancel(service, who, id, nonce, true), cancelled);
      assert.equal((await admit(service, who)).operation.status, 'reserved');
    });

    await t.test('source binding is private and immutable and creates one exact raw asset/job', async () => {
      const who = await actor(db), { id, envelope } = await bound(service, who);
      assert.equal(envelope.operation.status, 'awaiting_upload'); assert.equal(envelope.job.status, 'awaiting_upload');
      const path = `${who.workspace}/generated-raw/${id.keyDigest}/original.mp4`;
      assert.equal(envelope.operation.raw_path, path); assert.equal(envelope.operation.raw_bucket, rawBucket);
      assert.equal(envelope.asset.storage_bucket, rawBucket); assert.equal(envelope.asset.storage_path, path);
      assert.equal(envelope.asset.public_url, null); assert.equal(envelope.asset.generated_key, null);
      assert.equal(envelope.asset.generated_sha256, null); assert.equal(envelope.asset.generated_video_job_id, null);
      assert.equal(envelope.asset.metadata.kind, 'generated-video-pending');
      assert.equal(envelope.asset.metadata.uploadMode, 'native-generated-pending');
      assert.equal(envelope.job.raw_public_url, null); assert.equal(envelope.job.asset_id, id.assetId);
      assert.equal(envelope.job.source_file_name, id.fileName); assert.equal(envelope.job.source_mime_type, 'video/mp4');
      assert.equal(envelope.job.metadata.kind, 'generated-video-native');
      assert.equal(envelope.job.metadata.inputSha256, inputHash);
      const before = await snapshot(db, who.workspace);
      assert.deepEqual(await bind(service, who, id), envelope);
      for (const args of [[101, inputHash, rawBucket], [100, digest('different bytes'), rawBucket], [100, inputHash, 'different-private-bucket']])
        await refuses(db, who, () => bind(service, who, id, ...args), 'P9002');
      assert.deepEqual(await snapshot(db, who.workspace), before);
    });

    for (const [label, size, hash, bucket] of [['zero size', 0, inputHash, rawBucket], ['oversize', 104857601, inputHash, rawBucket],
      ['bad hash', 100, 'not-sha256', rawBucket], ['public raw bucket', 100, inputHash, 'ad-creatives'],
      ['unsafe bucket', 100, inputHash, '../raw'], ['missing bucket', 100, inputHash, null]]) {
      await t.test(`input ${label} refuses without provisional writes`, async () => {
        const who = await actor(db), { id } = await rendering(service, who);
        await refuses(db, who, () => bind(service, who, id, size, hash, bucket), 'P9001');
      });
    }

    await t.test('failure during native job insertion rolls back the provisional asset and input binding', async () => {
      const who = await actor(db), { id } = await rendering(service, who);
      await db.query(`create function public.synthetic_generated_job_failure() returns trigger language plpgsql as $$ begin
        if new.metadata->>'kind'='generated-video-native' then raise exception 'SYNTHETIC_GENERATED_JOB_FAILURE'; end if; return new; end $$;
        create trigger synthetic_generated_job_failure before insert on public.video_processing_jobs
          for each row execute function public.synthetic_generated_job_failure()`);
      try { await refuses(db, who, () => bind(service, who, id), 'P0001'); }
      finally { await db.query('drop trigger synthetic_generated_job_failure on public.video_processing_jobs; drop function public.synthetic_generated_job_failure()'); }
    });

    await t.test('queue only advances a bound private source and exact replay leaves timestamps unchanged', async () => {
      const who = await actor(db), { id } = await bound(service, who);
      const envelope = await queue(service, who, id), before = await snapshot(db, who.workspace);
      assert.equal(envelope.operation.status, 'queued'); assert.equal(envelope.job.status, 'queued');
      assert.equal(envelope.asset.public_url, null); assert.equal(envelope.asset.generated_key, null);
      assert.deepEqual(await queue(service, who, id), envelope); assert.deepEqual(await snapshot(db, who.workspace), before);
      await refuses(db, who, () => finish(service, who, id), 'P9002');
    });

    await t.test('failure while setting operation queued rolls back the native job transition', async () => {
      const who = await actor(db), { id } = await bound(service, who);
      await db.query(`create function public.synthetic_generated_queue_failure() returns trigger language plpgsql as $$ begin
        if new.status='queued' then raise exception 'SYNTHETIC_GENERATED_QUEUE_FAILURE'; end if; return new; end $$;
        create trigger synthetic_generated_queue_failure before update on public.generated_video_workflows
          for each row execute function public.synthetic_generated_queue_failure()`);
      try { await refuses(db, who, () => queue(service, who, id), 'P0001'); }
      finally { await db.query('drop trigger synthetic_generated_queue_failure on public.generated_video_workflows; drop function public.synthetic_generated_queue_failure()'); }
    });

    await t.test('mutated worker source hash cannot be queued or declared ready', async () => {
      const who = await actor(db), { id, envelope } = await bound(service, who);
      await db.query(`update public.video_processing_jobs set metadata=jsonb_set(metadata,'{inputSha256}',to_jsonb($2::text))
        where id=$1`, [envelope.operation.job_id, digest('substituted worker source')]);
      await refuses(db, who, () => queue(service, who, id), 'P9002');
    });

    await t.test('actual 086 promotion preserves generated .mp4 filename and 090 then freezes canonical native identity', async () => {
      const who = await actor(db), state = await queued(service, who);
      const result = await promote(db, service, who, state);
      const promoted = await readWorkflow(service, who, state.id.key);
      assert.equal(promoted.asset.file_name, state.id.fileName, '086 must not produce .mp4.mp4');
      assert.equal(promoted.asset.generated_key, null, '086 output alone is not a completed generated-workflow identity');
      assert.equal(promoted.operation.status, 'queued'); assert.equal(promoted.asset.storage_path, result.storage_path);
      const completed = await finish(service, who, state.id), op = completed.operation, asset = completed.asset;
      assert.equal(op.status, 'ready'); assert.equal(asset.generated_key, `v1:${state.id.key}`);
      assert.equal(asset.generated_sha256, outputHash); assert.equal(asset.generated_video_job_id, op.job_id);
      assert.deepEqual(op.result, { assetId: state.id.assetId, validationJobId: op.job_id, nativeValidated: true,
        fileName: state.id.fileName, mimeType: 'video/mp4', fileSize: 40, storageBucket: 'ad-creatives',
        storagePath: result.storage_path, creativeUrl: result.public_url, sha256: outputHash,
        thumbnailUrl: result.thumbnail_public_url, thumbnailPath: result.thumbnail_path, thumbnailSize: 12, thumbnailSha256: thumbHash });
      const before = await snapshot(db, who.workspace);
      assert.deepEqual(await finish(service, who, state.id), completed); assert.deepEqual(await snapshot(db, who.workspace), before);
      await refuses(db, who, () => cancel(service, who, state.id, state.nonce, true), 'P9002');
    });

    await t.test('failure while finalizing operation rolls back generated identity after real 086 promotion', async () => {
      const who = await actor(db), state = await queued(service, who);
      await promote(db, service, who, state);
      await db.query(`create function public.synthetic_generated_finish_failure() returns trigger language plpgsql as $$ begin
        if new.status='ready' then raise exception 'SYNTHETIC_GENERATED_FINISH_FAILURE'; end if; return new; end $$;
        create trigger synthetic_generated_finish_failure before update on public.generated_video_workflows
          for each row execute function public.synthetic_generated_finish_failure()`);
      try { await refuses(db, who, () => finish(service, who, state.id), 'P0001'); }
      finally { await db.query('drop trigger synthetic_generated_finish_failure on public.generated_video_workflows; drop function public.synthetic_generated_finish_failure()'); }
      assert.equal((await readWorkflow(service, who, state.id.key)).asset.generated_key, null);
    });

    await t.test('ready status without native promotion proof cannot be finalized', async () => {
      const who = await actor(db), state = await queued(service, who);
      await db.query("update public.video_processing_jobs set status='ready' where id=$1", [state.envelope.operation.job_id]);
      await db.query("update public.ad_creative_assets set status='ready' where id=$1", [state.id.assetId]);
      await refuses(db, who, () => finish(service, who, state.id), 'P9002');
    });

    for (const [label, field, value] of [['foreign output', 'storage_path', 'optimized/foreign/file.mp4'],
      ['missing hash', 'sha256', null], ['changed input length', 'input_size', 101],
      ['missing thumbnail hash', 'thumbnail_sha256', null], ['untrusted thumbnail', 'thumbnail_public_url', 'https://foreign.invalid/file.jpg']]) {
      await t.test(`tampered native receipt ${label} cannot finalize or fill generated identity`, async () => {
        const who = await actor(db), state = await queued(service, who);
        await promote(db, service, who, state);
        await db.query(`update public.video_processing_jobs set promotion_receipt=jsonb_set(promotion_receipt,
          $2::text[],$3::jsonb) where id=$1`, [state.envelope.operation.job_id, ['result', field], JSON.stringify(value)]);
        await refuses(db, who, () => finish(service, who, state.id), 'P9002');
      });
    }

    await t.test('canonical generated asset identity, hash and native proof become immutable after finalization', async () => {
      const who = await actor(db), state = await queued(service, who);
      await promote(db, service, who, state); await finish(service, who, state.id);
      for (const [column, value] of [['file_name', 'other.mp4'], ['storage_path', `${who.workspace}/public-raw.mp4`],
        ['generated_sha256', digest('substitution')], ['generated_video_job_id', null]]) {
        const before = await snapshot(db, who.workspace);
        await assert.rejects(service.query(`update public.ad_creative_assets set ${column}=$2 where id=$1`, [state.id.assetId, value]),
          /generated_creative_identity_immutable|generated_video_proof_immutable/);
        assert.deepEqual(await snapshot(db, who.workspace), before);
      }
      await refuses(db, who, () => service.query(`update public.generated_video_workflows set result=result||'{"extra":true}'::jsonb
        where workspace_id=$1 and generation_key=$2`, [who.workspace, state.id.key]), 'P9002');
    });

    await t.test('legacy public identity collision is refused without rewriting or deleting the old asset', async () => {
      const who = await actor(db), id = identity(who.workspace, `legacy-provider-${randomUUID()}`);
      await db.query(`insert into public.ad_creative_assets(id,workspace_id,file_name,file_type,mime_type,file_size,
        storage_bucket,storage_path,public_url,metadata,generated_key,generated_sha256)
        values($1,$2,'legacy.mp4','video','video/mp4',100,'ad-creatives',$3,$4,'{}',$5,$6)`,
      [id.assetId, who.workspace, `${who.workspace}/legacy.mp4`, `${origin}/legacy.mp4`, `v1:${id.key}`, inputHash]);
      await refuses(db, who, () => admit(service, who, id, id.key), 'P9002');
      assert.equal((await snapshot(db, who.workspace)).operations.length, 0);
    });

    await t.test('signed legacy provider recovery creates a private validation workflow without a new dispatch', async () => {
      const who = await actor(db), id = identity(who.workspace, `legacy-provider-${randomUUID()}`);
      const accepted = await admit(service, who, id, id.key);
      assert.equal(accepted.operation.status, 'rendering'); assert.equal(accepted.operation.dispatch_id, null);
      assert.equal(accepted.operation.provider_job_id, id.key); assert.equal(accepted.operation.request_digest, null);
      assert.equal((await begin(service, who, id)).dispatchAccepted, false);
      const prepared = await bind(service, who, id);
      assert.equal(prepared.asset.generated_key, null); assert.equal(prepared.asset.public_url, null);
    });

    await t.test('expired predispatch reservations can release capacity but cannot be revived under the same key', async () => {
      const who = await actor(db), ids = [identity(who.workspace), identity(who.workspace)];
      for (const id of ids) await admit(service, who, id);
      await refuses(db, who, () => admit(service, who), 'P9005');
      await db.query(`update public.generated_video_workflows set reserved_until=clock_timestamp()-interval '1 second'
        where workspace_id=$1`, [who.workspace]);
      await refuses(db, who, () => admit(service, who, ids[0]), 'P9003');
      assert.equal((await admit(service, who)).operation.status, 'reserved');
    });

    await t.test('ready video originals retain their full raw budget until cleanup is explicitly acknowledged', async () => {
      const who = await actor(db), completed = [], states = [];
      for (let n = 0; n < 2; n++) {
        const state = await queued(service, who);
        await promote(db, service, who, state);
        states.push(state);
        completed.push(await finish(service, who, state.id));
      }
      assert.ok(completed.every(item => item.operation.status === 'ready' && item.job.raw_deleted_at === null));
      await refuses(db, who, () => admit(service, who), 'P9005');
      await service.query('update public.video_processing_jobs set raw_deleted_at=clock_timestamp() where id=$1', [completed[0].operation.job_id]);
      await refuses(db, who, () => admit(service, who), 'P9005');
      const receipt = await reclaim(service, who, states[0]);
      assert.deepEqual(receipt, { jobId: completed[0].operation.job_id, workspaceId: who.workspace,
        status: 'reclaimed', fenceSize: fence.size, fenceSha256: fence.sha256 });
      const before = await snapshot(db, who.workspace);
      const job = before.jobs.find(item => item.id === completed[0].operation.job_id);
      assert.deepEqual(job.raw_reclamation_receipt, fence);
      assert.equal(job.raw_path, completed[0].operation.raw_path, 'The occupied raw key is retained, not erased from its durable identity');
      assert.equal(job.raw_bucket, rawBucket); assert.ok(job.raw_deleted_at);
      assert.deepEqual(await reclaim(service, who, states[0]), receipt);
      const replay = await snapshot(db, who.workspace);
      assert.deepEqual(replay.jobs, before.jobs); assert.deepEqual(replay.assets, before.assets);
      assert.deepEqual(replay.operations, before.operations);
      assert.equal((await admit(service, who)).operation.status, 'reserved');
    });

    await t.test('worker may acknowledge the occupied key after 086 but quota stays charged until generated workflow is ready', async () => {
      const who = await actor(db), first = await queued(service, who);
      await queued(service, who);
      await promote(db, service, who, first);
      await reclaim(service, who, first);
      assert.equal((await readWorkflow(service, who, first.id.key)).operation.status, 'queued');
      await refuses(db, who, () => admit(service, who), 'P9005');
      await finish(service, who, first.id);
      assert.equal((await admit(service, who)).operation.status, 'reserved');
    });

    for (const [label, overrides, code] of [['foreign job', { 0: randomUUID() }, 'P9002'],
      ['foreign workspace', { 1: null }, 'P9001'], ['wrong worker', { 2: 'other-fixture-worker' }, 'P9002'],
      ['wrong claim timestamp', { 3: '2026-10-24T00:00:00Z' }, 'P9002'], ['wrong attempt', { 4: 2 }, 'P9002'],
      ['missing attempt', { 4: null }, 'P9001'], ['wrong marker size', { 5: 55 }, 'P9001'],
      ['wrong marker digest', { 6: digest('wrong marker') }, 'P9001']]) {
      await t.test(`raw reclamation ${label} refuses without releasing quota or changing canonical rows`, async () => {
        const who = await actor(db), state = await queued(service, who);
        await promote(db, service, who, state); await finish(service, who, state.id);
        await refuses(db, who, () => reclaim(service, who, state, overrides), code);
      });
    }

    await t.test('reclamation refuses another existing workspace without changing either workspace guard', async () => {
      const who = await actor(db), state = await queued(service, who);
      await promote(db, service, who, state); await finish(service, who, state.id);
      const foreignBefore = await snapshot(db, other.workspace);
      await refuses(db, who, () => reclaim(service, who, state, { 1: other.workspace }), 'P9002');
      assert.deepEqual(await snapshot(db, other.workspace), foreignBefore);
    });

    await t.test('a job that has not passed actual 086 cannot acknowledge reclaimed input', async () => {
      const who = await actor(db), state = await queued(service, who);
      await refuses(db, who, () => reclaim(service, who, state), 'P9002');
      await db.query(`update public.video_processing_jobs set status='ready',claimed_by=$2,claimed_at=$3,attempts=1
        where id=$1`, [state.envelope.operation.job_id, worker, claimAt]);
      await refuses(db, who, () => reclaim(service, who, state), 'P9002');
    });

    await t.test('reclamation refuses tampered input proof after native promotion', async () => {
      const who = await actor(db), state = await queued(service, who);
      await promote(db, service, who, state);
      await db.query(`update public.video_processing_jobs set metadata=jsonb_set(metadata,'{inputSha256}',to_jsonb($2::text))
        where id=$1`, [state.envelope.operation.job_id, digest('wrong promoted source')]);
      await refuses(db, who, () => reclaim(service, who, state), 'P9002');
    });

    await t.test('reclamation requires the exact existing receipt and refuses a contradictory earlier acknowledgement', async () => {
      const who = await actor(db), state = await queued(service, who);
      await promote(db, service, who, state);
      await db.query(`update public.video_processing_jobs set raw_reclamation_receipt=$2::jsonb,raw_deleted_at=clock_timestamp()
        where id=$1`, [state.envelope.operation.job_id, JSON.stringify({ ...fence, size: fence.size + 1 })]);
      await refuses(db, who, () => reclaim(service, who, state), 'P9002');
    });

    await t.test('a changed worker claim committed during the job lock wait refuses stale reclamation', async () => {
      const who = await actor(db), state = await queued(service, who);
      await promote(db, service, who, state);
      await peers(fixture, db, async (holder, waiter, pids) => {
        await holder.query('begin');
        await holder.query('select id from public.video_processing_jobs where id=$1 for update', [state.envelope.operation.job_id]);
        const pending = observe(reclaim(waiter, who, state));
        await waitForLock(db, pids[1], pids[0]);
        await holder.query("update public.video_processing_jobs set claimed_by='new-fixture-worker',attempts=2 where id=$1", [state.envelope.operation.job_id]);
        await holder.query('commit');
        assert.equal((await pending).error?.code, 'P9002');
      });
      const saved = await readWorkflow(service, who, state.id.key);
      assert.equal(saved.job.raw_deleted_at, null); assert.equal(saved.job.raw_reclamation_receipt, null);
    });

    await t.test('failed reclamation update rolls back admission guard and keeps the original budget charged', async () => {
      const who = await actor(db), state = await queued(service, who);
      await promote(db, service, who, state);
      await db.query(`create function public.synthetic_reclamation_failure() returns trigger language plpgsql as $$ begin
        if new.raw_reclamation_receipt is not null then raise exception 'SYNTHETIC_RECLAMATION_FAILURE'; end if; return new; end $$;
        create trigger synthetic_reclamation_failure before update on public.video_processing_jobs
          for each row execute function public.synthetic_reclamation_failure()`);
      try { await refuses(db, who, () => reclaim(service, who, state), 'P0001'); }
      finally { await db.query('drop trigger synthetic_reclamation_failure on public.video_processing_jobs; drop function public.synthetic_reclamation_failure()'); }
    });

    await t.test('128 recent cancelled reservations retain the technical issuance bound without touching billing', async () => {
      const who = await actor(db);
      for (let n = 0; n < 128; n++) {
        const id = identity(who.workspace);
        await admit(service, who, id); await cancel(service, who, id);
      }
      await refuses(db, who, () => admit(service, who), 'P9005');
      assert.equal((await snapshot(db, who.workspace)).operations.length, 128);
    });

    for (const isolation of ['repeatable read', 'serializable']) {
      await t.test(`${isolation} stale admission aborts rather than exceeding the two-pending capacity`, async () => {
        const who = await actor(db), initial = identity(who.workspace);
        await admit(service, who, initial); await cancel(service, who, initial);
        await peers(fixture, db, async (holder, waiter, pids) => {
          await waiter.query(`begin isolation level ${isolation}`);
          await waiter.query('select count(*) from public.generated_video_workflows where workspace_id=$1', [who.workspace]);
          await holder.query('begin');
          await admit(holder, who); await admit(holder, who);
          const pending = observe(admit(waiter, who));
          await waitForLock(db, pids[1], pids[0]);
          await holder.query('commit');
          assert.equal((await pending).error?.code, '40001');
          await waiter.query('rollback');
        });
        const saved = await snapshot(db, who.workspace);
        assert.equal(saved.operations.filter(item => item.status === 'reserved').length, 2);
        await refuses(db, who, () => admit(service, who), 'P9005');
      });
    }

    await t.test('two competing native finalizers commit one identity and replay the same receipt', async () => {
      const who = await actor(db), state = await queued(service, who);
      await promote(db, service, who, state);
      await peers(fixture, db, async (holder, waiter, pids) => {
        await holder.query('begin');
        const first = await finish(holder, who, state.id);
        const pending = observe(finish(waiter, who, state.id));
        await waitForLock(db, pids[1], pids[0]);
        await holder.query('commit');
        const second = await pending;
        assert.equal(second.error, undefined); assert.deepEqual(second.value, first);
      });
    });

    await t.test('archived or missing provisional assets are never recreated by resumptions', async () => {
      const who = await actor(db), state = await bound(service, who);
      await db.query("update public.ad_creative_assets set status='archived' where id=$1", [state.id.assetId]);
      await refuses(db, who, () => bind(service, who, state.id), 'P9003');
      await refuses(db, who, () => queue(service, who, state.id), 'P9002');
      await db.query('delete from public.ad_creative_assets where id=$1', [state.id.assetId]);
      await refuses(db, who, () => bind(service, who, state.id), 'P9003');
      assert.equal((await snapshot(db, who.workspace)).assets.length, 0);
    });

    await t.test('deferred native proof references allow deleting only the owned test workspace without an orphan cycle', async () => {
      const who = await actor(db), state = await queued(service, who);
      await promote(db, service, who, state); await finish(service, who, state.id);
      await db.query('delete from public.staff_users where workspace_id=$1', [who.workspace]);
      await db.query('delete from public.workspaces where id=$1', [who.workspace]);
      assert.deepEqual(await snapshot(db, who.workspace), { operations: [], guards: [], jobs: [], assets: [] });
    });

    await t.test('all owned scenarios preserve unrelated workspace and billing sentinels', async () => {
      assert.deepEqual(await snapshot(db, other.workspace), otherBefore);
      assert.deepEqual((await db.query('select to_jsonb(s) as value from public.synthetic_subscription_sentinel s')).rows, sentinelBefore);
    });
    await service.end();
    t.diagnostic('All decisions ran in actual SQL on an owned disposable PostgreSQL cluster. Worker claims and receipt JSON are synthetic: no FFmpeg, provider, Storage HTTP, cloud or billing was contacted.');
  } finally { await fixture.close(); }
});
