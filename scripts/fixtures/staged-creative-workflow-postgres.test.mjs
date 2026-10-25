import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const readMigration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
const row = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
const reserveSignature = 'public.reserve_creative_upload(uuid,uuid,uuid,uuid,text,text,bigint,text)';
const finalizeSignature = 'public.finalize_creative_image_upload(uuid,uuid,uuid,uuid,jsonb)';
const rejectSignature = 'public.reject_creative_upload(uuid,uuid,uuid,uuid)';
const denied = { code: 'P8804', message: 'creative_upload_access_denied' };
const unavailable = { code: 'P8803', message: 'creative_upload_unavailable' };
const capacity = { code: 'P8805', message: 'creative_upload_capacity_exhausted' };
const requestConflict = { code: 'P8802', message: 'creative_upload_request_conflict' };
const hash = createHash('sha256').update('synthetic verified image receipt, not actual image bytes').digest('hex');
const maxImageBytes = 10 * 1024 * 1024;
const signedRawCharge = 100 * 1024 * 1024;
const rawBudget = 256 * 1024 * 1024;

async function newActor(db, workspace = randomUUID(), role = 'owner', status = 'active', auth = randomUUID()) {
  const staff = randomUUID();
  await db.query('insert into public.workspaces(id) values($1) on conflict do nothing', [workspace]);
  await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,role,status)
    values($1,$2,$3,$4,$5)`, [staff, workspace, auth, role, status]);
  return { workspace, staff, auth };
}

async function reserve(client, actor, options = {}) {
  const params = [actor.workspace, actor.staff, actor.auth, options.key ?? randomUUID(),
    options.name ?? 'synthetic.jpg', options.mime ?? 'image/jpeg', options.size ?? 128];
  if (Object.hasOwn(options, 'source')) params.push(options.source);
  return (await row(client, `select public.reserve_creative_upload(
    ${params.map((_, index) => `$${index + 1}`).join(',')}) as result`, params)).result;
}

function receipt(actor, operation, patch = {}) {
  const path = `${actor.workspace}/verified/${operation.ticket.id}/${hash}.jpg`;
  return { file_name: 'synthetic.jpg', file_type: 'image', mime_type: 'image/jpeg', file_size: 128,
    storage_bucket: 'ad-creatives', storage_path: path,
    public_url: `https://storage.fixture.invalid/storage/v1/object/public/ad-creatives/${path}`,
    sha256: hash, ...patch };
}

async function finalize(client, actor, operation, result = receipt(actor, operation)) {
  return (await row(client, 'select public.finalize_creative_image_upload($1,$2,$3,$4,$5::jsonb) as result',
    [operation.ticket.id, actor.workspace, actor.staff, actor.auth, JSON.stringify(result)])).result;
}

async function reject(client, actor, operation) {
  await client.query('select public.reject_creative_upload($1,$2,$3,$4)',
    [operation.ticket.id, actor.workspace, actor.staff, actor.auth]);
}

// Synthetic boundary history only, never a replacement for an RPC implementation.
async function seedHistory(db, actor, { count, size = 128, issuedAt = Date.now(),
  status = 'rejected', source = 'signed', rawDeleted = false }) {
  await db.query(`insert into public.creative_upload_operations(id,workspace_id,staff_user_id,auth_user_id,
    request_key,file_name,mime_type,file_size,source,issued_at,expires_at,status,raw_deleted_at)
    select gen_random_uuid(),$1,$2,$3,gen_random_uuid(),'synthetic.jpg','image/jpeg',$4,$5,$6,$6::bigint+7200000,$7,
      case when $8 then clock_timestamp() else null end from generate_series(1,$9::int)`,
  [actor.workspace, actor.staff, actor.auth, size, source, issuedAt, status, rawDeleted, count]);
}

async function snapshot(db, workspace) {
  return (await row(db, `select jsonb_build_object(
    'operations',coalesce((select jsonb_agg(to_jsonb(o) order by id)
      from public.creative_upload_operations o where workspace_id=$1),'[]'::jsonb),
    'assets',coalesce((select jsonb_agg(to_jsonb(a) order by id)
      from public.ad_creative_assets a where workspace_id=$1),'[]'::jsonb),
    'versions',coalesce((select jsonb_agg(to_jsonb(v) order by kind,id) from (
      select 'operation' as kind,id,xmin::text as xmin,ctid::text as ctid
        from public.creative_upload_operations where workspace_id=$1
      union all select 'asset',id,xmin::text,ctid::text
        from public.ad_creative_assets where workspace_id=$1) v),'[]'::jsonb)) as state`, [workspace])).state;
}

async function unchangedRefusal(db, workspace, promise, expected) {
  // Capture before starting the statement, not after its promise has been issued.
  const before = await snapshot(db, workspace);
  await assert.rejects(promise(), expected);
  assert.deepEqual(await snapshot(db, workspace), before);
}

async function withPeers(fixture, observer, callback) {
  const peers = [], pids = [];
  try {
    for (let i = 0; i < 2; i++) {
      const client = await fixture.connect();
      peers.push(client);
      await client.query('set role service_role');
      pids.push((await row(client, 'select pg_backend_pid() as pid')).pid);
    }
    assert.equal(new Set(pids).size, 2);
    await callback(peers[0], peers[1], pids);
  } finally {
    if (pids.length) await observer.query(`select pg_cancel_backend(pid) from pg_stat_activity
      where pid=any($1::integer[]) and state='active'`, [pids]);
    for (const client of peers) {
      await client.query('rollback').catch(() => {});
      await client.end();
    }
  }
}

async function waitForLock(observer, waiter, holder) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const state = await row(observer, `select pg_blocking_pids(pid) as blockers,wait_event_type
      from pg_stat_activity where pid=$1`, [waiter]);
    if (state?.wait_event_type === 'Lock' && state.blockers.includes(holder)) return;
    await delay(20);
  }
  assert.fail(`Expected an observed PostgreSQL lock: backend ${waiter} blocked by ${holder}`);
}

// Only roles and prerequisite tables are synthetic. Every workflow function is
// loaded from the real migrations. This proves neither Storage HTTP nor byte validation.
test('staged creative workflow on owned disposable PostgreSQL, with native opt-in supported',
  { timeout: 300000 }, async t => {
    const migration = await readMigration('088_staged_creative_workflow.sql');
    t.diagnostic(`088 SHA-256: ${createHash('sha256').update(migration).digest('hex')}`);
    const fixture = await startDisposablePostgres();
    try {
      const db = await fixture.connect();
      await db.query(`create role anon nologin nobypassrls;
        create role authenticated nologin nobypassrls;
        create role service_role nologin bypassrls;
        grant usage on schema public to anon,authenticated,service_role;
        alter default privileges grant all on tables to public,anon,authenticated;
        create table public.workspaces(id uuid primary key);
        create table public.staff_users(id uuid primary key,workspace_id uuid references public.workspaces(id),
          auth_user_id uuid,role text not null,status text not null default 'active');
        create table public.meta_campaign_launches(id uuid primary key);
        create schema storage;
        grant usage on schema storage to anon,authenticated,service_role;
        create table storage.buckets(id text primary key,name text,public boolean,
          file_size_limit bigint,allowed_mime_types text[]);
        create table storage.objects(id uuid primary key default gen_random_uuid(),
          bucket_id text references storage.buckets(id),name text);
        alter table storage.objects enable row level security;
        grant all on storage.objects to anon,authenticated,service_role;
        create policy synthetic_broad on storage.objects for all to anon,authenticated
          using(true) with check(true);
        insert into storage.buckets values('unrelated','unrelated',false,20,array['image/jpeg']);
        insert into storage.objects(bucket_id,name) values('unrelated','unchanged-sentinel');`);
      for (const name of ['015_ad_creative_assets.sql', '082_ad_creative_assets_server_access.sql',
        '085_generated_creative_identity.sql', '087_staged_creative_foundation.sql']) {
        await db.query(await readMigration(name));
      }
      await db.query(migration);
      t.diagnostic(`PostgreSQL ${(await row(db, 'show server_version')).server_version}; synthetic local rows only`);
      const service = await fixture.connect();
      await service.query('set role service_role');
      await t.test('ticket uses the exact contract, default signed source and millisecond timestamps', async () => {
        const actor = await newActor(db), key = randomUUID(), before = Date.now();
        const operation = await reserve(service, actor, { key });
        assert.deepEqual(Object.keys(operation).sort(), ['requestKey', 'status', 'ticket']);
        assert.deepEqual(Object.keys(operation.ticket).sort(), ['expiresAt', 'fileName', 'fileSize', 'id',
          'issuedAt', 'mimeType', 'staffUserId', 'userId', 'v', 'workspaceId']);
        const ticket = operation.ticket;
        assert.equal(operation.requestKey, key);
        assert.equal(operation.status, 'reserved');
        assert.match(ticket.id, /^[0-9a-f-]{36}$/);
        assert.deepEqual({ ...ticket, id: null, issuedAt: null, expiresAt: null }, {
          v: 1, id: null, workspaceId: actor.workspace, userId: actor.auth, staffUserId: actor.staff,
          fileName: 'synthetic.jpg', mimeType: 'image/jpeg', fileSize: 128, issuedAt: null, expiresAt: null });
        assert.ok(Number.isSafeInteger(ticket.issuedAt) && ticket.issuedAt >= before && ticket.issuedAt <= Date.now());
        assert.equal(ticket.expiresAt - ticket.issuedAt, 7200000);
        const state = await snapshot(db, actor.workspace);
        assert.equal(state.operations.length, 1);
        assert.equal(state.operations[0].source, 'signed');
        assert.equal(state.operations[0].raw_deleted_at, null);
        assert.deepEqual(state.assets, []);
        assert.deepEqual(await reserve(service, actor, { key }), operation);
        assert.deepEqual(await snapshot(db, actor.workspace), state);
      });

      await t.test('active owner, admin and marketer may reserve; account/workspace/status/role mismatches refuse', async () => {
        for (const role of ['owner', 'admin', 'marketer']) {
          const actor = await newActor(db, randomUUID(), role);
          assert.equal((await reserve(service, actor)).status, 'reserved');
        }
        for (const [role, status] of [['receptionist', 'active'], ['owner', 'inactive'], ['marketer', 'disabled']]) {
          const actor = await newActor(db, randomUUID(), role, status);
          await unchangedRefusal(db, actor.workspace, () => reserve(service, actor), denied);
        }
        const actor = await newActor(db), other = await newActor(db);
        for (const patch of [{ auth: randomUUID() }, { staff: randomUUID() }, { workspace: other.workspace }]) {
          await unchangedRefusal(db, actor.workspace, () => reserve(service, { ...actor, ...patch }), denied);
        }
      });

      await t.test('image-only admission validates extension, size, source, name and UUID-v4 request keys', async () => {
        const actor = await newActor(db);
        for (const options of [{ mime: 'video/mp4', name: 'synthetic.mp4' }, { mime: 'image/gif', name: 'synthetic.gif' },
          { mime: 'image/png' }, { name: '../synthetic.jpg' }, { name: 'folder\\synthetic.jpg' },
          { name: 'bad\n.jpg' }, { name: `${'a'.repeat(252)}.jpg` }, { name: '' },
          { size: 0 }, { size: -1 }, { size: maxImageBytes + 1 }, { source: 'browser' },
          { key: '11111111-1111-1111-8111-111111111111' }]) {
          await unchangedRefusal(db, actor.workspace, () => reserve(service, actor, options),
            { code: 'P8801', message: 'creative_upload_invalid' });
        }
        for (const [name, mime] of [['synthetic.jpeg', 'image/jpeg'], ['synthetic.png', 'image/png'],
          ['synthetic.webp', 'image/webp']]) {
          assert.equal((await reserve(service, actor, { name, mime, size: maxImageBytes, source: 'inline' })).status, 'reserved');
        }
      });

      await t.test('same-key metadata, source and staff conflicts refuse without changing the original', async () => {
        const actor = await newActor(db), key = randomUUID();
        await reserve(service, actor, { key });
        for (const options of [{ name: 'other.jpg' }, { name: 'synthetic.png', mime: 'image/png' },
          { size: 129 }, { source: 'inline' }]) {
          await unchangedRefusal(db, actor.workspace, () => reserve(service, actor, { key, ...options }), requestConflict);
        }
        const colleague = await newActor(db, actor.workspace, 'admin', 'active', actor.auth);
        await unchangedRefusal(db, actor.workspace, () => reserve(service, colleague, { key }), requestConflict);
        const independent = await newActor(db, actor.workspace);
        const foreign = await newActor(db, randomUUID(), 'owner', 'active', actor.auth);
        assert.notEqual((await reserve(service, independent, { key })).ticket.id,
          (await reserve(service, foreign, { key })).ticket.id);
      });

      for (const commit of [true, false]) await t.test(`same-key concurrent reserve waits and ${commit ? 'replays one operation' : 'survives writer rollback'}`, async () => {
        const actor = await newActor(db), key = randomUUID();
        await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
          await left.query('begin');
          const first = await reserve(left, actor, { key });
          const pending = observe(reserve(right, actor, { key }));
          await waitForLock(db, waiter, holder);
          assert.deepEqual((await snapshot(db, actor.workspace)).operations, []);
          await left.query(commit ? 'commit' : 'rollback');
          const result = await pending;
          assert.ifError(result.error);
          if (commit) assert.deepEqual(result.value, first);
          else assert.notEqual(result.value.ticket.id, first.ticket.id);
          assert.equal((await snapshot(db, actor.workspace)).operations.length, 1);
        });
      });

      for (const bound of ['active', 'recent', 'raw']) await t.test(`${bound} quota competition is serialized at its actual boundary`, async () => {
        const actor = await newActor(db), old = Date.now() - 3 * 60 * 60 * 1000;
        const options = bound === 'raw' ? { source: 'signed', size: 1 } : { source: 'inline' };
        if (bound === 'active') for (let i = 0; i < 3; i++) await reserve(service, actor, options);
        if (bound === 'recent') await seedHistory(db, actor, { count: 127, source: 'inline', rawDeleted: true });
        if (bound === 'raw') await seedHistory(db, actor, { count: 1, size: 1, issuedAt: old, status: 'reserved' });
        const before = await snapshot(db, actor.workspace);
        await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
          await left.query('begin');
          const first = await reserve(left, actor, options);
          const pending = observe(reserve(right, actor, options));
          await waitForLock(db, waiter, holder);
          assert.deepEqual(await snapshot(db, actor.workspace), before);
          await left.query('commit');
          const result = await pending;
          assert.ok(result.error, 'The competing request must lose admission');
          assert.equal(result.error.code, capacity.code);
          assert.equal(result.error.message, capacity.message);
          const after = await snapshot(db, actor.workspace);
          assert.equal(after.operations.length, before.operations.length + 1);
          assert.ok(after.operations.some(o => o.id === first.ticket.id));
          assert.deepEqual(after.assets, []);
          assert.deepEqual(await reserve(service, actor, { ...options, key: first.requestKey }), first,
            'An exact replay must still succeed at a full admission bound');
          assert.deepEqual(await snapshot(db, actor.workspace), after);
        });
      });

      for (const isolation of ['repeatable read', 'serializable']) await t.test(`${isolation} stale snapshots cannot admit a fifth active reservation`, async () => {
        const actor = await newActor(db);
        for (let i = 0; i < 3; i++) await reserve(service, actor, { source: 'inline' });
        await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
          await right.query(`begin isolation level ${isolation}`);
          assert.equal((await row(right, `select count(*)::int as n from public.creative_upload_operations
            where workspace_id=$1`, [actor.workspace])).n, 3);
          await left.query('begin');
          await reserve(left, actor, { source: 'inline' });
          const pending = observe(reserve(right, actor, { source: 'inline' }));
          await waitForLock(db, waiter, holder);
          await left.query('commit');
          const result = await pending;
          if (result.error) {
            assert.ok(result.error.code === '40001' || result.error.code === capacity.code,
              `Only serialization or capacity refusal is expected, got ${result.error.code}`);
            await right.query('rollback');
          } else {
            const committed = await observe(right.query('commit'));
            if (committed.error) assert.equal(committed.error.code, '40001');
          }
          assert.equal((await snapshot(db, actor.workspace)).operations.length, 4,
            'A stale transaction must fail closed, not exceed the four-active technical bound');
        });
      });

      await t.test('rolling issuance ignores older history, while expiry alone never frees raw bytes', async () => {
        const actor = await newActor(db), old = Date.now() - 3 * 60 * 60 * 1000;
        await seedHistory(db, actor, { count: 129, issuedAt: old, source: 'inline', rawDeleted: true });
        const inline = await reserve(service, actor, { source: 'inline' });
        assert.ok((await snapshot(db, actor.workspace)).operations.find(o => o.id === inline.ticket.id).raw_deleted_at);
        const full = await newActor(db);
        await seedHistory(db, full, { count: 2, size: 1, issuedAt: old, status: 'reserved' });
        await unchangedRefusal(db, full.workspace, () => reserve(service, full, { size: 1 }), capacity);
        await reserve(service, full, { source: 'inline', size: maxImageBytes });
        const deleted = (await snapshot(db, full.workspace)).operations.find(o => o.source === 'signed').id;
        await db.query(`update public.creative_upload_operations set raw_deleted_at=clock_timestamp()
          where id=$1`, [deleted]);
        assert.equal((await reserve(service, full, { size: maxImageBytes })).status, 'reserved');
      });

      await t.test('lying fileSize=1 claims cannot exceed two retained signed tickets or free raw on finalize/reject', async () => {
        const actor = await newActor(db);
        const first = await reserve(service, actor, { size: 1 });
        const second = await reserve(service, actor, { size: 1 });
        assert.equal(first.ticket.fileSize, 1);
        assert.equal(second.ticket.fileSize, 1);
        const retained = async () => (await snapshot(db, actor.workspace)).operations
          .filter(o => o.source === 'signed' && o.raw_deleted_at === null);
        const assertBudget = async () => {
          const operations = await retained();
          assert.equal(operations.length, 2);
          assert.equal(operations.reduce((sum, o) => sum + o.file_size, 0), 2);
          assert.ok(operations.length * signedRawCharge <= rawBudget);
          assert.ok((operations.length + 1) * signedRawCharge > rawBudget);
        };
        await assertBudget();
        await unchangedRefusal(db, actor.workspace, () => reserve(service, actor, { size: 1 }), capacity);
        await finalize(service, actor, first, receipt(actor, first, { file_size: 1 }));
        await reject(service, actor, second);
        await assertBudget();
        await unchangedRefusal(db, actor.workspace, () => reserve(service, actor, { size: 1 }), capacity);
        const inline = await reserve(service, actor, { size: 1, source: 'inline' });
        assert.ok((await snapshot(db, actor.workspace)).operations.find(o => o.id === inline.ticket.id).raw_deleted_at);
        await unchangedRefusal(db, actor.workspace, () => reserve(service, actor, { size: 1 }), capacity);
        await service.query('update public.creative_upload_operations set raw_deleted_at=clock_timestamp() where id=$1',
          [first.ticket.id]);
        assert.equal((await reserve(service, actor, { size: 1 })).status, 'reserved');
        await assertBudget();
        await unchangedRefusal(db, actor.workspace, () => reserve(service, actor, { size: 1 }), capacity);
      });

      await t.test('another workspace is independent while an admission transaction is held', async () => {
        const actor = await newActor(db), other = await newActor(db);
        await withPeers(fixture, db, async (left, right) => {
          await left.query('begin');
          await reserve(left, actor);
          await right.query("set lock_timeout='1500ms'");
          assert.equal((await reserve(right, other)).status, 'reserved');
          await left.query('commit');
        });
      });

      await t.test('admission writes its private tenant guard without rewriting workspace business rows', async () => {
        const actor = await newActor(db), key = randomUUID();
        const workspaceVersion = () => row(db, `select to_jsonb(w) as data,xmin::text as xmin,ctid::text as ctid
          from public.workspaces w where id=$1`, [actor.workspace]);
        const before = await workspaceVersion();
        assert.equal((await service.query('select * from public.creative_upload_admission_guards where workspace_id=$1',
          [actor.workspace])).rowCount, 0);
        const operation = await reserve(service, actor, { key });
        const first = await row(service, `select workspace_id,revision::text as revision
          from public.creative_upload_admission_guards where workspace_id=$1`, [actor.workspace]);
        assert.equal(first.workspace_id, actor.workspace);
        assert.ok(BigInt(first.revision) > 0n);
        assert.deepEqual(await reserve(service, actor, { key }), operation);
        const replay = await row(service, `select revision::text as revision
          from public.creative_upload_admission_guards where workspace_id=$1`, [actor.workspace]);
        assert.ok(BigInt(replay.revision) > BigInt(first.revision));
        assert.deepEqual(await workspaceVersion(), before);
      });

      await t.test('finalize atomically saves a raw DB asset and exact receipt; replay writes nothing', async () => {
        const actor = await newActor(db), key = randomUUID(), operation = await reserve(service, actor, { key });
        const result = receipt(actor, operation), first = await finalize(service, actor, operation, result);
        assert.deepEqual(Object.keys(first).sort(), ['asset', 'operationId', 'replayed', 'status']);
        assert.equal(first.operationId, operation.ticket.id);
        assert.equal(first.status, 'finalized');
        assert.equal(first.replayed, false);
        const saved = await snapshot(db, actor.workspace);
        assert.deepEqual(saved.assets, [first.asset]);
        assert.equal(first.asset.id, operation.ticket.id);
        assert.equal(first.asset.workspace_id, actor.workspace);
        assert.equal(first.asset.verified_upload_actor_id, actor.auth);
        assert.equal(first.asset.verified_upload_key, operation.ticket.id);
        assert.equal(first.asset.verified_upload_sha256, hash);
        for (const field of ['file_name', 'file_type', 'mime_type', 'file_size', 'storage_bucket', 'storage_path', 'public_url']) {
          assert.equal(first.asset[field], result[field]);
        }
        assert.equal(saved.operations[0].status, 'finalized');
        assert.equal(saved.operations[0].asset_id, first.asset.id);
        assert.equal(saved.operations[0].raw_deleted_at, null, 'Finalization is not proof that raw Storage was deleted');
        assert.deepEqual(saved.operations[0].result, result);
        assert.deepEqual(await finalize(service, actor, operation, result), { ...first, replayed: true });
        assert.deepEqual(await snapshot(db, actor.workspace), saved);
        assert.equal((await reserve(service, actor, { key })).status, 'finalized');
        assert.deepEqual(await snapshot(db, actor.workspace), saved);
      });

      await t.test('concurrent finalize waits, then replays the same asset without a second write', async () => {
        const actor = await newActor(db), operation = await reserve(service, actor);
        await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
          await left.query('begin');
          const first = await finalize(left, actor, operation);
          const pending = observe(finalize(right, actor, operation));
          await waitForLock(db, waiter, holder);
          assert.deepEqual((await snapshot(db, actor.workspace)).assets, []);
          await left.query('commit');
          const afterCommit = await snapshot(db, actor.workspace), result = await pending;
          assert.ifError(result.error);
          assert.deepEqual(result.value, { ...first, replayed: true });
          assert.deepEqual(await snapshot(db, actor.workspace), afterCommit);
        });
      });

      await t.test('malformed and noncanonical final receipts refuse before saving either row', async () => {
        const actor = await newActor(db), operation = await reserve(service, actor), valid = receipt(actor, operation);
        const invalid = [null, [], 'forged', { ...valid, extra: true }, { ...valid, file_name: 'other.jpg' },
          { ...valid, file_type: 'video' }, { ...valid, mime_type: 'image/png' }, { ...valid, file_size: '128' },
          { ...valid, file_size: 1.5 }, { ...valid, file_size: 0 }, { ...valid, file_size: maxImageBytes + 1 },
          { ...valid, storage_bucket: 'ad-creatives-staging' }, { ...valid, storage_path: `${actor.workspace}/verified/forged/${hash}.jpg` },
          { ...valid, storage_path: `${randomUUID()}/verified/${operation.ticket.id}/${hash}.jpg` },
          { ...valid, public_url: valid.public_url.replace('https:', 'http:') }, { ...valid, sha256: 'bad' }];
        for (const field of Object.keys(valid)) {
          const missing = { ...valid }; delete missing[field]; invalid.push(missing);
          invalid.push({ ...valid, [field]: null });
        }
        for (const value of invalid) await unchangedRefusal(db, actor.workspace,
          () => finalize(service, actor, operation, value), error =>
            (error.code === 'P8801' && error.message === 'creative_upload_result_invalid')
            || (error.code === 'P0001' && error.message === 'verified_creative_upload_invalid'));
      });

      await t.test('invalid JSON numeric receipts refuse before bigint casting with a controlled result error', async () => {
        const actor = await newActor(db), operation = await reserve(service, actor), valid = receipt(actor, operation);
        for (const file_size of ['not-a-number', '999999999999999999999999999999999999999999', '1e99999',
          'NaN', 'Infinity', true, false, {}, [], null, 1.5, 0, -1, 1e100, Number.MAX_SAFE_INTEGER, maxImageBytes + 1]) {
          await unchangedRefusal(db, actor.workspace,
            () => finalize(service, actor, operation, { ...valid, file_size }),
            { code: 'P8801', message: 'creative_upload_result_invalid' });
        }
      });

      await t.test('replay refuses every changed receipt field instead of rewriting the asset or ledger', async () => {
        const actor = await newActor(db), operation = await reserve(service, actor), result = receipt(actor, operation);
        await finalize(service, actor, operation, result);
        for (const patch of [{ file_name: 'other.jpg' }, { file_type: 'video' }, { mime_type: 'image/png' },
          { file_size: 129 }, { storage_bucket: 'other' }, { storage_path: 'other' },
          { public_url: 'https://other.fixture.invalid/image' }, { sha256: 'b'.repeat(64) }]) {
          await unchangedRefusal(db, actor.workspace, () => finalize(service, actor, operation, { ...result, ...patch }),
            error => error.code === 'P8801' || error.code === 'P8802');
        }
      });

      await t.test('archived/deleted/mismatched asset receipts refuse replay without resurrection', async () => {
        for (const change of ['archived', 'deleted', 'mismatched']) {
          const actor = await newActor(db), operation = await reserve(service, actor);
          const first = await finalize(service, actor, operation);
          if (change === 'archived') await db.query("update public.ad_creative_assets set status='archived' where id=$1", [first.asset.id]);
          if (change === 'deleted') await db.query('delete from public.ad_creative_assets where id=$1', [first.asset.id]);
          if (change === 'mismatched') {
            const other = await reserve(service, actor), otherAsset = await finalize(service, actor, other);
            await db.query('update public.creative_upload_operations set asset_id=$2 where id=$1', [operation.ticket.id, otherAsset.asset.id]);
          }
          await unchangedRefusal(db, actor.workspace, () => finalize(service, actor, operation), unavailable);
        }
      });

      await t.test('expiry refuses initial finalize and reserve replay but preserves raw bytes', async () => {
        const actor = await newActor(db), old = Date.now() - 3 * 60 * 60 * 1000;
        await seedHistory(db, actor, { count: 1, issuedAt: old, status: 'reserved' });
        const saved = (await snapshot(db, actor.workspace)).operations[0];
        const operation = { ticket: { id: saved.id } };
        await unchangedRefusal(db, actor.workspace, () => finalize(service, actor, operation), unavailable);
        await unchangedRefusal(db, actor.workspace, () => reserve(service, actor, { key: saved.request_key }), unavailable);
        assert.equal((await snapshot(db, actor.workspace)).operations[0].raw_deleted_at, null);
      });

      await t.test('reject is service-only, terminal and idempotent, and does not pretend raw was deleted', async () => {
        const actor = await newActor(db), key = randomUUID(), operation = await reserve(service, actor, { key });
        await reject(service, actor, operation);
        const saved = await snapshot(db, actor.workspace);
        assert.equal(saved.operations[0].status, 'rejected');
        assert.equal(saved.operations[0].error_code, 'invalid_image');
        assert.equal(saved.operations[0].raw_deleted_at, null);
        assert.deepEqual(saved.assets, []);
        await reject(service, actor, operation);
        assert.deepEqual(await snapshot(db, actor.workspace), saved);
        await unchangedRefusal(db, actor.workspace, () => finalize(service, actor, operation), unavailable);
        await unchangedRefusal(db, actor.workspace, () => reserve(service, actor, { key }), unavailable);
        const inline = await reserve(service, actor, { source: 'inline' });
        const beforeInline = (await snapshot(db, actor.workspace)).operations.find(o => o.id === inline.ticket.id);
        assert.ok(beforeInline.raw_deleted_at);
        await finalize(service, actor, inline);
        assert.equal((await snapshot(db, actor.workspace)).operations.find(o => o.id === inline.ticket.id).raw_deleted_at,
          beforeInline.raw_deleted_at);
      });

      await t.test('operation identity, terminal status, saved receipt and raw-deletion acknowledgement are immutable', async () => {
        const actor = await newActor(db), other = await newActor(db), operation = await reserve(service, actor);
        await finalize(service, actor, operation);
        const current = (await snapshot(db, actor.workspace)).operations[0];
        for (const [column, value] of [['id', randomUUID()], ['workspace_id', other.workspace],
          ['staff_user_id', randomUUID()], ['auth_user_id', randomUUID()], ['request_key', randomUUID()],
          ['file_name', 'other.jpg'], ['mime_type', 'image/png'], ['file_size', 129], ['source', 'inline'],
          ['issued_at', current.issued_at + 1], ['expires_at', current.expires_at + 1], ['status', 'reserved'],
          ['status', 'rejected'], ['result', { ...current.result, file_size: 129 }], ['result', null]]) {
          await unchangedRefusal(db, actor.workspace,
            () => service.query(`update public.creative_upload_operations set ${column}=$2 where id=$1`, [operation.ticket.id, value]),
            { code: 'P0001', message: 'creative_upload_operation_immutable' });
        }
        await service.query('update public.creative_upload_operations set raw_deleted_at=clock_timestamp() where id=$1', [operation.ticket.id]);
        for (const value of [null, '2090-01-01T00:00:00Z']) await unchangedRefusal(db, actor.workspace,
          () => service.query('update public.creative_upload_operations set raw_deleted_at=$2 where id=$1', [operation.ticket.id, value]),
          { code: 'P0001', message: 'creative_upload_operation_immutable' });
        const before = await snapshot(db, actor.workspace);
        await reject(service, actor, operation);
        assert.deepEqual(await snapshot(db, actor.workspace), before, 'Reject must not rewrite a finalized operation');
      });

      await t.test('late ledger failure rolls back an already-inserted asset and allows a clean retry', async () => {
        const actor = await newActor(db), operation = await reserve(service, actor);
        await db.query(`create function public.fixture_fail_creative_finalize() returns trigger language plpgsql as $$
          begin if new.status='finalized' then
            if new.result is null or not exists(select 1 from public.ad_creative_assets where id=new.asset_id)
              then raise exception 'fixture_expected_inserted_asset_and_receipt'; end if;
            raise exception 'fixture_injected_after_ledger_write';
          end if; return new; end $$;
          create trigger fixture_fail_creative_finalize after update on public.creative_upload_operations
            for each row execute function public.fixture_fail_creative_finalize()`);
        try {
          await unchangedRefusal(db, actor.workspace, () => finalize(service, actor, operation),
            { code: 'P0001', message: 'fixture_injected_after_ledger_write' });
        } finally {
          await db.query(`drop trigger fixture_fail_creative_finalize on public.creative_upload_operations;
            drop function public.fixture_fail_creative_finalize()`);
        }
        const retried = await finalize(service, actor, operation);
        assert.equal(retried.replayed, false);
        assert.deepEqual((await snapshot(db, actor.workspace)).assets, [retried.asset]);
      });

      for (const action of ['reserve', 'finalize', 'reject']) await t.test(`${action} waits for a revocation row lock and rechecks authority`, async () => {
        const actor = await newActor(db), operation = await reserve(service, actor);
        const invoke = client => action === 'reserve' ? reserve(client, actor)
          : action === 'finalize' ? finalize(client, actor, operation) : reject(client, actor, operation);
        const before = await snapshot(db, actor.workspace);
        await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
          await left.query('reset role');
          await left.query('begin');
          await left.query("update public.staff_users set status='inactive' where id=$1", [actor.staff]);
          const pending = observe(invoke(right));
          await waitForLock(db, waiter, holder);
          assert.deepEqual(await snapshot(db, actor.workspace), before);
          await left.query('commit');
          const result = await pending;
          assert.equal(result.error?.code, denied.code);
          assert.equal(result.error?.message, denied.message);
          assert.deepEqual(await snapshot(db, actor.workspace), before);
        });
      });

      for (const action of ['reserve', 'finalize', 'reject']) await t.test(`${action} retains its staff authority row lock through commit`, async () => {
        const actor = await newActor(db), operation = await reserve(service, actor);
        await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
          await left.query('begin');
          if (action === 'reserve') await reserve(left, actor);
          if (action === 'finalize') await finalize(left, actor, operation);
          if (action === 'reject') await reject(left, actor, operation);
          await right.query('reset role');
          const pending = observe(right.query("update public.staff_users set role='receptionist' where id=$1", [actor.staff]));
          await waitForLock(db, waiter, holder);
          await left.query('commit');
          const result = await pending;
          assert.ifError(result.error);
          assert.equal(result.value.rowCount, 1);
          await unchangedRefusal(db, actor.workspace, () => reserve(service, actor), denied);
        });
      });

      await t.test('valid foreign/same-account colleagues cannot finalize or reject another receipt', async () => {
        const actor = await newActor(db), operation = await reserve(service, actor);
        const colleagues = [await newActor(db, actor.workspace), await newActor(db, actor.workspace, 'admin', 'active', actor.auth),
          await newActor(db, randomUUID(), 'owner', 'active', actor.auth)];
        for (const colleague of colleagues) {
          await unchangedRefusal(db, actor.workspace, () => finalize(service, colleague, operation), unavailable);
          const before = await snapshot(db, actor.workspace);
          await reject(service, colleague, operation);
          assert.deepEqual(await snapshot(db, actor.workspace), before, 'A foreign reject must not change the target operation');
        }
      });

      await t.test('RLS, table/column ACLs and every workflow RPC deny browsers despite permissive scaffolds', async () => {
        await db.query(`create policy synthetic_browser_assets on public.ad_creative_assets for all to anon,authenticated
          using(true) with check(true);
          create policy synthetic_browser_operations on public.creative_upload_operations for all to anon,authenticated
          using(true) with check(true);
          create policy synthetic_browser_guards on public.creative_upload_admission_guards for all to anon,authenticated
          using(true) with check(true);
          grant select(id),insert(id),update(id),references(id) on public.creative_upload_operations to public,anon,authenticated;
          grant select(workspace_id,revision),insert(workspace_id,revision),update(workspace_id,revision),references(workspace_id,revision)
            on public.creative_upload_admission_guards to public,anon,authenticated`);
        // Repeat the actual migration to exercise removal of legacy column grants.
        const actor = await newActor(db), operation = await reserve(service, actor), before = await snapshot(db, actor.workspace);
        const guards = async () => (await db.query(`select to_jsonb(g) as data,xmin::text as xmin,ctid::text as ctid
          from public.creative_upload_admission_guards g order by workspace_id`)).rows;
        const beforeGuards = await guards();
        await db.query(migration);
        assert.deepEqual(await snapshot(db, actor.workspace), before);
        assert.deepEqual(await guards(), beforeGuards);
        const signatures = [reserveSignature, finalizeSignature, rejectSignature,
          'public.assert_creative_upload_actor(uuid,uuid,uuid)', 'public.protect_creative_upload_operation()',
          'public.creative_upload_ticket(public.creative_upload_operations)'];
        for (const table of ['ad_creative_assets', 'creative_upload_operations', 'creative_upload_admission_guards']) {
          assert.equal((await row(db, 'select relrowsecurity from pg_class where oid=$1::regclass', [`public.${table}`])).relrowsecurity, true);
          for (const role of ['anon', 'authenticated']) {
            assert.equal((await row(db, `select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed`,
              [role, `public.${table}`])).allowed, false);
            assert.equal((await row(db, `select has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as allowed`,
              [role, `public.${table}`])).allowed, false);
          }
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await row(db,
            'select has_table_privilege($1,$2,$3) as allowed', ['service_role', `public.${table}`, privilege])).allowed, true);
        }
        for (const signature of signatures) {
          for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await row(db,
            "select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).allowed, role === 'service_role');
          const fn = await row(db, 'select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [signature]);
          assert.equal(fn.prosecdef, false);
          assert.deepEqual(fn.proconfig, ['search_path=""']);
        }
        for (const role of ['anon', 'authenticated']) {
          const browser = await fixture.connect();
          try {
            await browser.query(`set role ${role}`);
            for (const table of ['ad_creative_assets', 'creative_upload_operations', 'creative_upload_admission_guards']) {
              const keyColumn = table === 'creative_upload_admission_guards' ? 'workspace_id' : 'id';
              for (const sql of [`select * from public.${table}`, `select ${keyColumn} from public.${table}`,
                `insert into public.${table}(${keyColumn}) values(gen_random_uuid())`,
                `update public.${table} set ${keyColumn}=gen_random_uuid()`,
                `delete from public.${table}`, `truncate public.${table}`]) {
                await assert.rejects(browser.query(sql), { code: '42501' });
              }
            }
            await assert.rejects(browser.query('select revision from public.creative_upload_admission_guards'), { code: '42501' });
            await assert.rejects(browser.query('update public.creative_upload_admission_guards set revision=revision+1'), { code: '42501' });
            await assert.rejects(reserve(browser, actor), { code: '42501' });
            await assert.rejects(finalize(browser, actor, operation), { code: '42501' });
            await assert.rejects(reject(browser, actor, operation), { code: '42501' });
            assert.deepEqual((await browser.query('select bucket_id,name from storage.objects')).rows,
              [{ bucket_id: 'unrelated', name: 'unchanged-sentinel' }]);
            await assert.rejects(browser.query(`insert into storage.objects(bucket_id,name)
              values('ad-creatives-staging','forged')`), { code: '42501' });
          } finally { await browser.end(); }
        }
        assert.deepEqual(await snapshot(db, actor.workspace), before);
        assert.deepEqual(await guards(), beforeGuards);
        assert.equal((await finalize(service, actor, operation)).status, 'finalized');
      });
    } finally {
      await fixture.close();
      t.diagnostic('Owned disposable PostgreSQL stopped and its run directory removed');
    }
  });
