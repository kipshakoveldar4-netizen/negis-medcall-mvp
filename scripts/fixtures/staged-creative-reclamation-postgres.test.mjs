import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const readMigration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
const row = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
const invalid = { code: 'P8901', message: 'creative_reclamation_invalid' };
const unconfirmed = { code: 'P8902', message: 'creative_reclamation_claim_unconfirmed' };
const capacity = { code: 'P8805', message: 'creative_upload_capacity_exhausted' };
const claimSignature = 'public.claim_creative_upload_reclamation(uuid,uuid,integer)';
const completeSignature = 'public.complete_creative_upload_reclamation(uuid,uuid,uuid,text,bigint)';
const reserveSignature = 'public.reserve_creative_upload(uuid,uuid,uuid,uuid,text,text,bigint,text)';
const hash = createHash('sha256').update('synthetic permanent tombstone receipt, not Storage bytes').digest('hex');
const signedRawCharge = 100 * 1024 * 1024;
const rawBudget = 256 * 1024 * 1024;
const old = () => Date.now() - 3 * 60 * 60 * 1000;

async function newActor(db, workspace = randomUUID()) {
  const staff = randomUUID(), auth = randomUUID();
  await db.query('insert into public.workspaces(id) values($1) on conflict do nothing', [workspace]);
  await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,role,status)
    values($1,$2,$3,'owner','active')`, [staff, workspace, auth]);
  return { workspace, staff, auth };
}

async function reserve(client, actor, options = {}) {
  return (await row(client, 'select public.reserve_creative_upload($1,$2,$3,$4,$5,$6,$7,$8) as result',
    [actor.workspace, actor.staff, actor.auth, options.key ?? randomUUID(), 'synthetic.jpg', 'image/jpeg',
      options.size ?? 1, options.source ?? 'signed'])).result;
}

async function finalize(client, actor, operation) {
  const path = `${actor.workspace}/verified/${operation.ticket.id}/${hash}.jpg`;
  const receipt = { file_name: 'synthetic.jpg', file_type: 'image', mime_type: 'image/jpeg', file_size: 1,
    storage_bucket: 'ad-creatives', storage_path: path,
    public_url: `https://storage.fixture.invalid/storage/v1/object/public/ad-creatives/${path}`, sha256: hash };
  return (await row(client, 'select public.finalize_creative_image_upload($1,$2,$3,$4,$5::jsonb) as result',
    [operation.ticket.id, actor.workspace, actor.staff, actor.auth, JSON.stringify(receipt)])).result;
}

async function reject(client, actor, operation) {
  await client.query('select public.reject_creative_upload($1,$2,$3,$4)',
    [operation.ticket.id, actor.workspace, actor.staff, actor.auth]);
}

async function claim(client, workspace, claimId = randomUUID(), limit) {
  const args = [workspace, claimId];
  if (limit !== undefined) args.push(limit);
  return (await row(client, `select public.claim_creative_upload_reclamation(
    ${args.map((_, index) => `$${index + 1}`).join(',')}) as result`, args)).result;
}

async function complete(client, workspace, operationId, claimId, sha256 = hash, size = 128) {
  return (await row(client, 'select public.complete_creative_upload_reclamation($1,$2,$3,$4,$5) as result',
    [workspace, operationId, claimId, sha256, size])).result;
}

// Admin-only synthetic clock boundary. Keep both durable lease records and their
// manifest timestamp consistent; the service role must never update this journal.
async function setClaimDeadline(db, workspace, claimId, milliseconds) {
  const changed = await row(db, `with deadline as materialized (
      select clock_timestamp()+$3::double precision*interval '1 millisecond' as until),
    operation_leases as (
      update public.creative_upload_operations o set raw_cleanup_claimed_until=d.until from deadline d
        where o.workspace_id=$1 and o.raw_cleanup_claim_id=$2 returning o.id),
    journal_lease as (
      update public.creative_upload_reclamation_claims c set claimed_until=d.until,
        manifest=(select jsonb_agg(jsonb_set(item,'{claimedUntil}',to_jsonb(d.until)) order by ordinal)
          from jsonb_array_elements(c.manifest) with ordinality as entries(item,ordinal))
        from deadline d where c.workspace_id=$1 and c.claim_id=$2 returning c.claim_id)
    select (select count(*)::int from operation_leases) as operations,
      (select count(*)::int from journal_lease) as claims,(select until from deadline) as until`,
  [workspace, claimId, milliseconds]);
  assert.ok(changed.operations > 0);
  assert.equal(changed.claims, 1, 'A synthetic time shift must also update the durable claim journal');
  return changed.until;
}

async function waitForClaimExpiry(db, workspace, claimId) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const lease = await row(db, `select claimed_until<=clock_timestamp() as expired
      from public.creative_upload_reclamation_claims where workspace_id=$1 and claim_id=$2`, [workspace, claimId]);
    if (lease?.expired) return;
    await delay(20);
  }
  assert.fail('The synthetic claim deadline must have elapsed on the PostgreSQL clock');
}

// Synthetic boundary history only. All RPCs and triggers come from actual migrations.
async function seedHistory(db, actor, { count = 1, issuedAt = old(), status = 'rejected', source = 'signed',
  tombstoneSize = null, expiresIn = 7200000 } = {}) {
  return (await db.query(`insert into public.creative_upload_operations(id,workspace_id,staff_user_id,auth_user_id,
    request_key,file_name,mime_type,file_size,source,issued_at,expires_at,status,raw_deleted_at,
    raw_cleanup_claim_id,raw_cleanup_claimed_until,raw_cleanup_kind,raw_cleanup_size,raw_cleanup_sha256)
    select gen_random_uuid(),$1,$2,$3,gen_random_uuid(),'synthetic.jpg','image/jpeg',1,$4,$5,$5::bigint+$6,$7,
      case when $4='inline' or $8::bigint is not null then clock_timestamp() else null end,
      case when $8::bigint is not null then gen_random_uuid() else null end,
      case when $8::bigint is not null then clock_timestamp()-interval '1 second' else null end,
      case when $8::bigint is not null then 'tombstone' else null end,$8,
      case when $8::bigint is not null then $9 else null end
    from generate_series(1,$10::int) returning *`,
  [actor.workspace, actor.staff, actor.auth, source, issuedAt, expiresIn, status, tombstoneSize, hash, count])).rows;
}

async function snapshot(db, workspace) {
  return (await row(db, `select jsonb_build_object(
    'operations',coalesce((select jsonb_agg(to_jsonb(o) order by id)
      from public.creative_upload_operations o where workspace_id=$1),'[]'::jsonb),
    'assets',coalesce((select jsonb_agg(to_jsonb(a) order by id)
      from public.ad_creative_assets a where workspace_id=$1),'[]'::jsonb),
    'claims',coalesce((select jsonb_agg(to_jsonb(c) order by claim_id)
      from public.creative_upload_reclamation_claims c where workspace_id=$1),'[]'::jsonb),
    'versions',coalesce((select jsonb_agg(to_jsonb(v) order by kind,id) from (
      select 'operation' as kind,id,xmin::text as xmin,ctid::text as ctid
        from public.creative_upload_operations where workspace_id=$1
      union all select 'asset',id,xmin::text,ctid::text
        from public.ad_creative_assets where workspace_id=$1
      union all select 'claim',claim_id,xmin::text,ctid::text
        from public.creative_upload_reclamation_claims where workspace_id=$1) v),'[]'::jsonb)) as state`, [workspace])).state;
}

async function guard(db, workspace) {
  return (await db.query(`select to_jsonb(g) as data,xmin::text as xmin,ctid::text as ctid
    from public.creative_upload_admission_guards g where workspace_id=$1`, [workspace])).rows;
}

async function unchangedRefusal(db, workspace, invoke, expected) {
  const before = await snapshot(db, workspace), beforeGuard = await guard(db, workspace);
  await assert.rejects(invoke(), expected);
  assert.deepEqual(await snapshot(db, workspace), before);
  assert.deepEqual(await guard(db, workspace), beforeGuard);
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
  assert.fail(`Expected owned backend ${waiter} to block on owned backend ${holder}`);
}

test('staged creative reclamation on owned native PostgreSQL 17.11', {
  timeout: 300000,
  skip: process.env.MEDINA_TEST_POSTGRES_NATIVE !== '1' && 'Explicit MEDINA_TEST_POSTGRES_NATIVE=1 required; no Docker or external fallback',
}, async t => {
  const migration = await readMigration('089_staged_creative_reclamation.sql');
  t.diagnostic(`089 SHA-256: ${createHash('sha256').update(migration).digest('hex')}`);
  const fixture = await startDisposablePostgres();
  try {
    const db = await fixture.connect();
    assert.equal((await row(db, 'show server_version_num')).server_version_num, '170011');
    await db.query(`create role anon nologin nobypassrls;
      create role authenticated nologin nobypassrls;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      alter default privileges grant all on tables to public,anon,authenticated,service_role;
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

    await t.test('089 refuses an absent 088 base without creating partial cleanup RPCs', async () => {
      try {
        await assert.rejects(db.query(migration), error => error.code === '42P01'
          || error.message === 'creative_reclamation_dependencies_unconfirmed');
      } finally { await db.query('rollback'); }
      assert.equal((await row(db, 'select to_regprocedure($1) as fn', [claimSignature])).fn, null);
      assert.equal((await row(db, 'select to_regprocedure($1) as fn', [completeSignature])).fn, null);
      assert.equal((await row(db, "select to_regclass('public.creative_upload_operations') as table_name")).table_name, null);
      assert.equal((await row(db, "select to_regclass('public.creative_upload_reclamation_claims') as table_name")).table_name, null);
    });

    await db.query(await readMigration('088_staged_creative_workflow.sql'));
    await db.query(migration);
    t.diagnostic('PostgreSQL 17.11; actual 015/082/085/087/088/089; synthetic local rows only; no Storage HTTP');
    const service = await fixture.connect();
    await service.query('set role service_role');
    const foreign = await newActor(db), foreignOperation = await reserve(service, foreign);
    await finalize(service, foreign, foreignOperation);
    const foreignBefore = await snapshot(db, foreign.workspace), foreignGuard = await guard(db, foreign.workspace);
    const storageSnapshot = async () => (await row(db, `select jsonb_build_object(
      'buckets',(select jsonb_agg(to_jsonb(b) order by id) from storage.buckets b),
      'objects',(select jsonb_agg(to_jsonb(o) order by id) from storage.objects o)) as state`)).state;
    const storageBefore = await storageSnapshot();

    await t.test('claim returns the exact receipt, defaults to one, leases for 120 seconds and selects oldest eligible signed raw', async () => {
      const actor = await newActor(db), claimId = randomUUID();
      const finalized = await reserve(service, actor);
      await finalize(service, actor, finalized);
      const active = await reserve(service, actor);
      const inline = await reserve(service, actor, { source: 'inline' });
      await reject(service, actor, inline);
      const [expired] = await seedHistory(db, actor, { status: 'reserved', issuedAt: old() - 3000 });
      const [rejected] = await seedHistory(db, actor, { issuedAt: old() - 2000 });
      const [reclaimed] = await seedHistory(db, actor, { tombstoneSize: 128 });
      const first = await claim(service, actor.workspace, claimId);
      assert.equal(first.length, 1);
      const item = first[0];
      assert.deepEqual(Object.keys(item).sort(), ['claimId', 'claimedUntil', 'expiresAt', 'fileName',
        'fileSize', 'issuedAt', 'mimeType', 'operationId', 'workspaceId']);
      assert.deepEqual({ ...item, claimedUntil: null }, { operationId: expired.id, workspaceId: actor.workspace,
        fileName: 'synthetic.jpg', mimeType: 'image/jpeg', fileSize: 1, issuedAt: Number(expired.issued_at),
        expiresAt: Number(expired.expires_at), claimId, claimedUntil: null });
      const lease = await row(db, `select raw_cleanup_claimed_until-updated_at=interval '120 seconds' as exact,
        raw_cleanup_claimed_until=$2::timestamptz as matches_receipt
        from public.creative_upload_operations where id=$1`, [expired.id, item.claimedUntil]);
      assert.equal(lease.exact, true, 'The server-side lease interval is exactly 120 seconds');
      assert.equal(lease.matches_receipt, true, 'The manifest retains the full PostgreSQL timestamp precision');
      const journal = (await snapshot(db, actor.workspace)).claims;
      assert.equal(journal.length, 1);
      assert.deepEqual(journal[0], { workspace_id: actor.workspace, claim_id: claimId, batch_limit: 1,
        claimed_until: item.claimedUntil, manifest: first });
      const second = await claim(service, actor.workspace, randomUUID(), 2);
      assert.deepEqual(second.map(o => o.operationId), [rejected.id, finalized.ticket.id]);
      assert.deepEqual(await claim(service, actor.workspace), []);
      const saved = await snapshot(db, actor.workspace);
      for (const id of [active.ticket.id, inline.ticket.id, reclaimed.id]) {
        assert.equal(saved.operations.find(o => o.id === id).raw_cleanup_claim_id,
          id === reclaimed.id ? reclaimed.raw_cleanup_claim_id : null);
      }
      for (const id of [expired.id, rejected.id, finalized.ticket.id]) {
        assert.equal(saved.operations.find(o => o.id === id).raw_deleted_at, null);
      }
      assert.equal(saved.assets.length, 1);
    });

    await t.test('claim validates workspace, UUID-v4 identity and the one-or-two limit without writes', async () => {
      const actor = await newActor(db);
      await seedHistory(db, actor);
      for (const [workspace, id, limit] of [[null, randomUUID(), 1], [actor.workspace, null, 1],
        [actor.workspace, '11111111-1111-1111-8111-111111111111', 1], [actor.workspace, randomUUID(), null],
        [actor.workspace, randomUUID(), 0], [actor.workspace, randomUUID(), -1], [actor.workspace, randomUUID(), 3]]) {
        await unchangedRefusal(db, actor.workspace, () => claim(service, workspace, id, limit), invalid);
      }
      await unchangedRefusal(db, actor.workspace, () => claim(service, randomUUID()), { code: '23503' });
    });

    await t.test('concurrent leases SKIP LOCKED, never share an operation, and rolled-back claims become available', async () => {
      const actor = await newActor(db);
      const [first] = await seedHistory(db, actor, { issuedAt: old() - 3000 });
      const [second] = await seedHistory(db, actor, { issuedAt: old() - 2000 });
      const [third] = await seedHistory(db, actor, { issuedAt: old() - 1000 });
      await withPeers(fixture, db, async (left, right) => {
        await left.query('begin');
        await left.query('select id from public.creative_upload_operations where id=any($1::uuid[]) for update', [[first.id, second.id]]);
        const rightId = randomUUID();
        await right.query("set lock_timeout='1500ms'");
        assert.deepEqual((await claim(right, actor.workspace, rightId, 2)).map(o => o.operationId), [third.id]);
        assert.deepEqual(await claim(right, actor.workspace, randomUUID(), 2), []);
        await left.query('rollback');
        const retry = await claim(right, actor.workspace, randomUUID(), 2);
        assert.deepEqual(retry.map(o => o.operationId), [first.id, second.id]);
        assert.equal(new Set([...retry.map(o => o.operationId), third.id]).size, 3);
      });
    });

    await t.test('duplicate concurrent claim requests wait on the workspace guard and replay one unchanged manifest', async () => {
      const actor = await newActor(db), id = randomUUID();
      await seedHistory(db, actor, { count: 3 });
      await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
        await left.query('begin');
        const manifest = await claim(left, actor.workspace, id, 2);
        assert.equal(manifest.length, 2);
        const pending = observe(claim(right, actor.workspace, id, 2));
        await waitForLock(db, waiter, holder);
        await left.query('commit');
        const saved = await snapshot(db, actor.workspace), result = await pending;
        assert.ifError(result.error);
        assert.deepEqual(result.value, manifest);
        assert.deepEqual(await snapshot(db, actor.workspace), saved, 'A duplicate cannot renew or expand the lease');
        assert.equal(saved.operations.filter(o => o.raw_cleanup_claim_id === id).length, 2);
        assert.equal(saved.operations.filter(o => o.raw_cleanup_claim_id === null).length, 1);
      });
    });

    await t.test('a lost claim response replays the original manifest even after completion without selecting another row', async () => {
      const actor = await newActor(db), id = randomUUID();
      await seedHistory(db, actor, { count: 3 });
      const manifest = await claim(service, actor.workspace, id), saved = await snapshot(db, actor.workspace);
      assert.equal(manifest.length, 1);
      assert.deepEqual(await claim(service, actor.workspace, id), manifest);
      assert.deepEqual(await snapshot(db, actor.workspace), saved);
      await unchangedRefusal(db, actor.workspace, () => claim(service, actor.workspace, id, 2), invalid);
      const ack = await complete(service, actor.workspace, manifest[0].operationId, id);
      const completed = await snapshot(db, actor.workspace);
      assert.deepEqual(await claim(service, actor.workspace, id), manifest,
        'A completed original row still identifies its lost claim response');
      assert.deepEqual(await snapshot(db, actor.workspace), completed);
      assert.deepEqual(await complete(service, actor.workspace, manifest[0].operationId, id), ack);
      assert.deepEqual(await snapshot(db, actor.workspace), completed);
      assert.equal(completed.operations.filter(o => o.raw_cleanup_claim_id === null).length, 2);
    });

    await t.test('an expired claim ID refuses renewal and cannot select a different row after another claimant takes over', async () => {
      const actor = await newActor(db), id = randomUUID();
      const [first] = await seedHistory(db, actor, { issuedAt: old() - 1000 });
      await seedHistory(db, actor);
      assert.equal((await claim(service, actor.workspace, id))[0].operationId, first.id);
      await setClaimDeadline(db, actor.workspace, id, -1000);
      await unchangedRefusal(db, actor.workspace, () => claim(service, actor.workspace, id), unconfirmed);
      const replacementId = randomUUID();
      assert.equal((await claim(service, actor.workspace, replacementId))[0].operationId, first.id);
      await unchangedRefusal(db, actor.workspace, () => claim(service, actor.workspace, id), unconfirmed);
    });

    await t.test('an original two-row claim refuses a changed limit and replays both rows after partial completion', async () => {
      const actor = await newActor(db), id = randomUUID();
      await seedHistory(db, actor, { count: 3 });
      const manifest = await claim(service, actor.workspace, id, 2);
      assert.equal(manifest.length, 2);
      await unchangedRefusal(db, actor.workspace, () => claim(service, actor.workspace, id), invalid);
      await complete(service, actor.workspace, manifest[0].operationId, id);
      const saved = await snapshot(db, actor.workspace);
      assert.deepEqual(await claim(service, actor.workspace, id, 2), manifest);
      assert.deepEqual(await snapshot(db, actor.workspace), saved);
      assert.equal(saved.claims.length, 1);
      assert.deepEqual(saved.claims[0].manifest, manifest);
    });

    await t.test('only nonempty claim manifests enter the append-only journal; service history mutation is denied', async () => {
      const actor = await newActor(db), id = randomUUID();
      assert.deepEqual(await claim(service, actor.workspace, id), []);
      assert.deepEqual((await snapshot(db, actor.workspace)).claims, []);
      await seedHistory(db, actor);
      const manifest = await claim(service, actor.workspace, id);
      assert.equal(manifest.length, 1);
      const saved = await snapshot(db, actor.workspace);
      assert.equal(saved.claims.length, 1);
      assert.deepEqual((await service.query(`select manifest from public.creative_upload_reclamation_claims
        where workspace_id=$1 and claim_id=$2`, [actor.workspace, id])).rows, [{ manifest }]);
      for (const sql of [
        'update public.creative_upload_reclamation_claims set claimed_until=clock_timestamp()',
        'update public.creative_upload_reclamation_claims set manifest=manifest',
        'delete from public.creative_upload_reclamation_claims',
        'truncate public.creative_upload_reclamation_claims']) {
        await unchangedRefusal(db, actor.workspace, () => service.query(sql), { code: '42501' });
      }
      await unchangedRefusal(db, actor.workspace, () => service.query(`insert into public.creative_upload_reclamation_claims
        select * from public.creative_upload_reclamation_claims where workspace_id=$1 and claim_id=$2`, [actor.workspace, id]),
      { code: '23505' });
      assert.deepEqual(await snapshot(db, actor.workspace), saved);
    });

    await t.test('the same claim UUID is workspace-scoped and another workspace never waits on its guard', async () => {
      const actor = await newActor(db), other = await newActor(db), id = randomUUID();
      await seedHistory(db, actor);
      await seedHistory(db, other);
      await withPeers(fixture, db, async (left, right) => {
        await left.query('begin');
        const first = await claim(left, actor.workspace, id);
        await right.query("set lock_timeout='1500ms'");
        const second = await claim(right, other.workspace, id);
        assert.equal(second[0].workspaceId, other.workspace);
        assert.notEqual(first[0].operationId, second[0].operationId);
        await left.query('commit');
        assert.deepEqual(await claim(right, actor.workspace, id), first);
        assert.deepEqual(await claim(right, other.workspace, id), second);
        assert.equal((await snapshot(db, actor.workspace)).claims.length, 1);
        assert.equal((await snapshot(db, other.workspace)).claims.length, 1);
      });
    });

    await t.test('wrong claim, missing claim, foreign workspace, malformed hash and invalid ACK size refuse atomically', async () => {
      const actor = await newActor(db), other = await newActor(db);
      const [operation] = await seedHistory(db, actor);
      const id = randomUUID();
      await unchangedRefusal(db, actor.workspace, () => complete(service, actor.workspace, operation.id, id), unconfirmed);
      await claim(service, actor.workspace, id);
      for (const [sha, size] of [[null, 128], ['', 128], ['A'.repeat(64), 128], ['a'.repeat(63), 128],
        [`${hash}\n`, 128], [hash, null], [hash, 0], [hash, -1], [hash, 2049]]) {
        await unchangedRefusal(db, actor.workspace, () => complete(service, actor.workspace, operation.id, id, sha, size), invalid);
      }
      for (const [workspace, operationId, claimId, expected] of [
        [actor.workspace, operation.id, randomUUID(), unconfirmed],
        [other.workspace, operation.id, id, unconfirmed],
        [actor.workspace, randomUUID(), id, unconfirmed],
        [null, operation.id, id, invalid], [actor.workspace, null, id, invalid],
        [actor.workspace, operation.id, null, invalid]]) {
        const otherBefore = await snapshot(db, other.workspace), otherGuard = await guard(db, other.workspace);
        await unchangedRefusal(db, actor.workspace, () => complete(service, workspace, operationId, claimId), expected);
        assert.deepEqual(await snapshot(db, other.workspace), otherBefore);
        assert.deepEqual(await guard(db, other.workspace), otherGuard);
      }
    });

    await t.test('expired leases cannot ACK; a new claimant fences the previous claimant', async () => {
      const actor = await newActor(db), [operation] = await seedHistory(db, actor), firstId = randomUUID();
      await claim(service, actor.workspace, firstId);
      // Move only this synthetic row to the elapsed-lease boundary; do not wait two minutes.
      await setClaimDeadline(db, actor.workspace, firstId, -1000);
      await unchangedRefusal(db, actor.workspace, () => complete(service, actor.workspace, operation.id, firstId), unconfirmed);
      const secondId = randomUUID(), replacement = await claim(service, actor.workspace, secondId);
      assert.equal(replacement[0].operationId, operation.id);
      await unchangedRefusal(db, actor.workspace, () => complete(service, actor.workspace, operation.id, firstId), unconfirmed);
      assert.equal((await complete(service, actor.workspace, operation.id, secondId)).cleanupKind, 'tombstone');
    });

    for (const blockedOn of ['admission guard', 'operation row']) await t.test(`an ACK waiting on the ${blockedOn} rechecks its lease after the wait`, async () => {
      const actor = await newActor(db), [operation] = await seedHistory(db, actor), id = randomUUID();
      await claim(service, actor.workspace, id);
      const beforeGuard = await guard(db, actor.workspace);
      await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
        await left.query('begin');
        const until = await setClaimDeadline(db, actor.workspace, id, 1000);
        if (blockedOn === 'admission guard') {
          await left.query(`insert into public.creative_upload_admission_guards(workspace_id,revision) values($1,1)
            on conflict(workspace_id) do update set revision=public.creative_upload_admission_guards.revision+1`, [actor.workspace]);
        } else {
          await left.query('select id from public.creative_upload_operations where id=$1 for update', [operation.id]);
        }
        const before = await snapshot(db, actor.workspace);
        const pending = observe(complete(right, actor.workspace, operation.id, id));
        await waitForLock(db, waiter, holder);
        await delay(Math.max(0, until.getTime() - Date.now() + 40));
        await waitForClaimExpiry(db, actor.workspace, id);
        await left.query('commit');
        const result = await pending;
        assert.equal(result.error?.code, unconfirmed.code, 'Elapsed leases must not ACK using a pre-lock timestamp');
        assert.equal(result.error?.message, unconfirmed.message);
        assert.deepEqual(await snapshot(db, actor.workspace), before);
        const savedGuard = await guard(db, actor.workspace);
        if (blockedOn === 'admission guard') {
          assert.equal(Number(savedGuard[0].data.revision), Number(beforeGuard[0].data.revision) + 1);
        } else assert.deepEqual(savedGuard, beforeGuard);
      });
    });

    await t.test('active valid reservations and inline uploads cannot be acknowledged even with a forged service-side lease', async () => {
      const actor = await newActor(db), operation = await reserve(service, actor), id = randomUUID();
      await db.query(`update public.creative_upload_operations set raw_cleanup_claim_id=$2,
        raw_cleanup_claimed_until=clock_timestamp()+interval '120 seconds' where id=$1`, [operation.ticket.id, id]);
      await unchangedRefusal(db, actor.workspace, () => complete(service, actor.workspace, operation.ticket.id, id), unconfirmed);
      const inline = await reserve(service, actor, { source: 'inline' });
      await reject(service, actor, inline);
      await unchangedRefusal(db, actor.workspace, () => complete(service, actor.workspace, inline.ticket.id, id), unconfirmed);
      await unchangedRefusal(db, actor.workspace, () => service.query(`update public.creative_upload_operations
        set raw_cleanup_claim_id=$2,raw_cleanup_claimed_until=clock_timestamp() where id=$1`, [inline.ticket.id, id]), { code: '23514' });
    });

    await t.test('ACK preserves the ledger and asset, stores an exact immutable tombstone receipt, and replays after lease expiry', async () => {
      const actor = await newActor(db), operation = await reserve(service, actor);
      const asset = (await finalize(service, actor, operation)).asset, id = randomUUID();
      await claim(service, actor.workspace, id);
      // Preserve the real 120-second lease assertion above; shorten only this fixture's boundary.
      await setClaimDeadline(db, actor.workspace, id, 1000);
      const before = await snapshot(db, actor.workspace), beforeGuard = await guard(db, actor.workspace);
      const acknowledged = await complete(service, actor.workspace, operation.ticket.id, id, hash, 2048);
      assert.deepEqual(Object.keys(acknowledged).sort(), ['cleanupKind', 'operationId', 'rawDeletedAt', 'sha256', 'size', 'workspaceId']);
      assert.deepEqual({ ...acknowledged, rawDeletedAt: null }, { operationId: operation.ticket.id,
        workspaceId: actor.workspace, rawDeletedAt: null, cleanupKind: 'tombstone', size: 2048, sha256: hash });
      assert.ok(Number.isFinite(Date.parse(acknowledged.rawDeletedAt)));
      const saved = await snapshot(db, actor.workspace), current = saved.operations[0];
      assert.equal(saved.operations.length, 1, 'ACK is not a row or Storage-object deletion');
      assert.deepEqual(saved.assets, [asset]);
      for (const key of Object.keys(before.operations[0])) {
        if (!['raw_deleted_at', 'raw_cleanup_kind', 'raw_cleanup_size', 'raw_cleanup_sha256', 'updated_at'].includes(key)) {
          assert.deepEqual(current[key], before.operations[0][key], `${key} must survive ACK unchanged`);
        }
      }
      assert.equal(current.raw_cleanup_kind, 'tombstone');
      assert.equal(current.raw_cleanup_size, 2048);
      assert.equal(current.raw_cleanup_sha256, hash);
      assert.ok(Number((await guard(db, actor.workspace))[0].data.revision) > Number(beforeGuard[0].data.revision));
      await delay(Math.max(0, Date.parse(current.raw_cleanup_claimed_until) - Date.now() + 40));
      await waitForClaimExpiry(db, actor.workspace, id);
      assert.deepEqual(await complete(service, actor.workspace, operation.ticket.id, id, hash, 2048), acknowledged);
      assert.deepEqual(await snapshot(db, actor.workspace), saved, 'Exact replay cannot rewrite the operation or asset tuple');
      assert.deepEqual(await claim(service, actor.workspace), []);
      await unchangedRefusal(db, actor.workspace, () => claim(service, actor.workspace, id), unconfirmed);
      for (const [claimId, sha, size] of [[randomUUID(), hash, 2048], [id, 'b'.repeat(64), 2048], [id, hash, 1]]) {
        await unchangedRefusal(db, actor.workspace, () => complete(service, actor.workspace, operation.ticket.id, claimId, sha, size), unconfirmed);
      }
      for (const [column, value] of [['raw_cleanup_claim_id', randomUUID()], ['raw_cleanup_claimed_until', '2090-01-01'],
        ['raw_cleanup_kind', null], ['raw_cleanup_size', 1], ['raw_cleanup_sha256', 'b'.repeat(64)]]) {
        await unchangedRefusal(db, actor.workspace, () => service.query(`update public.creative_upload_operations
          set ${column}=$2 where id=$1`, [operation.ticket.id, value]),
        { code: 'P0001', message: 'creative_cleanup_receipt_immutable' });
      }
      await unchangedRefusal(db, actor.workspace, () => service.query(`update public.creative_upload_operations
        set raw_deleted_at=null where id=$1`, [operation.ticket.id]),
      { code: 'P0001', message: 'creative_upload_operation_immutable' });
    });

    await t.test('bare raw_deleted_at without full tombstone proof is refused by the actual constraint', async () => {
      const actor = await newActor(db), [operation] = await seedHistory(db, actor);
      for (const values of ["raw_deleted_at=clock_timestamp()",
        "raw_deleted_at=clock_timestamp(),raw_cleanup_kind='tombstone',raw_cleanup_size=128",
        `raw_deleted_at=clock_timestamp(),raw_cleanup_kind='tombstone',raw_cleanup_size=128,raw_cleanup_sha256='${hash}'`]) {
        await unchangedRefusal(db, actor.workspace, () => service.query(`update public.creative_upload_operations
          set ${values} where id=$1`, [operation.id]), { code: '23514' });
      }
    });

    await t.test('a late ACK schema failure rolls back both receipt and admission guard and permits retry', async () => {
      const actor = await newActor(db), [operation] = await seedHistory(db, actor), id = randomUUID();
      await claim(service, actor.workspace, id);
      await db.query(`create function public.fixture_fail_creative_cleanup() returns trigger language plpgsql as $$
        begin if new.raw_deleted_at is not null then
          if new.raw_cleanup_kind is distinct from 'tombstone' or new.raw_cleanup_size is null
            then raise exception 'fixture_expected_full_tombstone_receipt'; end if;
          raise exception 'fixture_injected_cleanup_schema_failure';
        end if; return new; end $$;
        create trigger fixture_fail_creative_cleanup after update on public.creative_upload_operations
          for each row execute function public.fixture_fail_creative_cleanup()`);
      try {
        await unchangedRefusal(db, actor.workspace, () => complete(service, actor.workspace, operation.id, id),
          { code: 'P0001', message: 'fixture_injected_cleanup_schema_failure' });
      } finally {
        await db.query(`drop trigger fixture_fail_creative_cleanup on public.creative_upload_operations;
          drop function public.fixture_fail_creative_cleanup()`);
      }
      assert.equal((await complete(service, actor.workspace, operation.id, id)).cleanupKind, 'tombstone');
    });

    await t.test('concurrent exact ACK waits on the real guard and returns the same persisted receipt', async () => {
      const actor = await newActor(db), [operation] = await seedHistory(db, actor), id = randomUUID();
      await claim(service, actor.workspace, id);
      await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
        const before = await snapshot(db, actor.workspace);
        await left.query('begin');
        const first = await complete(left, actor.workspace, operation.id, id);
        const pending = observe(complete(right, actor.workspace, operation.id, id));
        await waitForLock(db, waiter, holder);
        assert.deepEqual(await snapshot(db, actor.workspace), before);
        await left.query('commit');
        const saved = await snapshot(db, actor.workspace), result = await pending;
        assert.ifError(result.error);
        assert.deepEqual(result.value, first);
        assert.deepEqual(await snapshot(db, actor.workspace), saved);
      });
    });

    await t.test('rejected/finalized/expired status and a claim never regain quota; only committed ACK does', async () => {
      const actor = await newActor(db), first = await reserve(service, actor), second = await reserve(service, actor);
      await finalize(service, actor, first);
      await reject(service, actor, second);
      await unchangedRefusal(db, actor.workspace, () => reserve(service, actor), capacity);
      const id = randomUUID();
      const claimed = await claim(service, actor.workspace, id, 2);
      assert.equal(claimed.length, 2);
      await unchangedRefusal(db, actor.workspace, () => reserve(service, actor), capacity);
      await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
        const beforeGuard = await guard(db, actor.workspace);
        await left.query('begin');
        await complete(left, actor.workspace, claimed[0].operationId, id);
        const pending = observe(reserve(right, actor));
        await waitForLock(db, waiter, holder);
        assert.deepEqual(await guard(db, actor.workspace), beforeGuard, 'No quota is released before ACK commits');
        await left.query('commit');
        const result = await pending;
        assert.ifError(result.error);
        assert.equal(result.value.status, 'reserved');
      });
      await unchangedRefusal(db, actor.workspace, () => reserve(service, actor), capacity);
      const expired = await newActor(db);
      await seedHistory(db, expired, { count: 2, status: 'reserved' });
      await unchangedRefusal(db, expired.workspace, () => reserve(service, expired), capacity);
    });

    await t.test('rolling recent and four-pending limits still apply after reclamation', async () => {
      const pending = await newActor(db);
      for (let i = 0; i < 4; i++) await reserve(service, pending, { source: 'inline' });
      await unchangedRefusal(db, pending.workspace, () => reserve(service, pending, { source: 'inline' }), capacity);
      const recent = await newActor(db);
      await seedHistory(db, recent, { count: 128, issuedAt: Date.now(), tombstoneSize: 1 });
      await unchangedRefusal(db, recent.workspace, () => reserve(service, recent, { source: 'inline' }), capacity);
      const historical = await newActor(db);
      await seedHistory(db, historical, { count: 129, tombstoneSize: 1 });
      assert.equal((await reserve(service, historical)).status, 'reserved');
    });

    for (const isolation of ['repeatable read', 'serializable']) {
      await t.test(`${isolation} stale admission aborts on the cleanup MVCC fence and succeeds only on a fresh retry`, async () => {
        const actor = await newActor(db), first = await reserve(service, actor), second = await reserve(service, actor);
        await reject(service, actor, first);
        await reject(service, actor, second);
        const id = randomUUID(), [claimed] = await claim(service, actor.workspace, id);
        await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
          await right.query(`begin isolation level ${isolation}`);
          assert.equal((await row(right, `select count(*)::int as n from public.creative_upload_operations
            where workspace_id=$1 and raw_deleted_at is null`, [actor.workspace])).n, 2);
          const beforeGuard = await guard(db, actor.workspace);
          await left.query('begin');
          await complete(left, actor.workspace, claimed.operationId, id);
          const pending = observe(reserve(right, actor));
          await waitForLock(db, waiter, holder);
          await left.query('commit');
          const result = await pending;
          assert.equal(result.error?.code, '40001', 'A real technical-row update must invalidate the stale snapshot');
          await right.query('rollback');
          const afterGuard = await guard(db, actor.workspace);
          assert.ok(Number(afterGuard[0].data.revision) > Number(beforeGuard[0].data.revision));
          assert.notEqual(afterGuard[0].xmin, beforeGuard[0].xmin);
          assert.equal((await reserve(right, actor)).status, 'reserved');
          assert.equal((await snapshot(db, actor.workspace)).operations.filter(o => o.raw_deleted_at === null).length, 2);
        });
      });
    }

    await t.test('permanent tombstone bytes count at the exact 256 MiB boundary', async () => {
      const actor = await newActor(db), count = (rawBudget - 2 * signedRawCharge) / 2048;
      assert.equal(count, 28672);
      // Old, fully evidenced receipts isolate byte accounting from the 128-recent bound.
      await seedHistory(db, actor, { count, tombstoneSize: 2048 });
      const first = await reserve(service, actor), second = await reserve(service, actor);
      const usage = async () => (await row(db, `select sum(case when source='signed' then
        case when raw_deleted_at is null then 104857600 else raw_cleanup_size end else 0 end)::bigint as bytes,
        count(*)::int as n from public.creative_upload_operations where workspace_id=$1`, [actor.workspace]));
      assert.equal(Number((await usage()).bytes), rawBudget);
      await reject(service, actor, first);
      await reject(service, actor, second);
      const id = randomUUID(), claimed = await claim(service, actor.workspace, id);
      assert.equal(claimed.length, 1);
      await complete(service, actor.workspace, claimed[0].operationId, id, hash, 1);
      assert.equal(Number((await usage()).bytes), rawBudget - signedRawCharge + 1);
      const before = await usage(), beforeGuard = await guard(db, actor.workspace);
      await assert.rejects(reserve(service, actor), capacity);
      assert.deepEqual(await usage(), before, 'The extra one-byte tombstone must prevent over-budget admission');
      assert.deepEqual(await guard(db, actor.workspace), beforeGuard);
    });

    await t.test('migration rerun preserves all receipts and clears broad browser and service journal grants', async () => {
      const actor = await newActor(db), [operation] = await seedHistory(db, actor), id = randomUUID();
      await claim(service, actor.workspace, id);
      await complete(service, actor.workspace, operation.id, id);
      await db.query(`create policy synthetic_browser_operations on public.creative_upload_operations for all to anon,authenticated
        using(true) with check(true);
        grant select(id,raw_cleanup_claim_id,raw_cleanup_claimed_until,raw_cleanup_kind,raw_cleanup_size,raw_cleanup_sha256),
          insert(raw_cleanup_size),update(raw_cleanup_size),references(raw_cleanup_size)
          on public.creative_upload_operations to public,anon,authenticated;
        create policy synthetic_browser_claims on public.creative_upload_reclamation_claims for all to anon,authenticated
          using(true) with check(true);
        grant all on public.creative_upload_reclamation_claims to public,anon,authenticated,service_role;
        grant select(workspace_id,claim_id,batch_limit,claimed_until,manifest),
          insert(workspace_id,claim_id,batch_limit,claimed_until,manifest),
          update(workspace_id,claim_id,batch_limit,claimed_until,manifest),
          references(workspace_id,claim_id,batch_limit,claimed_until,manifest)
          on public.creative_upload_reclamation_claims to public,anon,authenticated,service_role`);
      const before = await snapshot(db, actor.workspace), beforeGuard = await guard(db, actor.workspace);
      await db.query(migration);
      await db.query(migration);
      assert.deepEqual(await snapshot(db, actor.workspace), before);
      assert.deepEqual(await guard(db, actor.workspace), beforeGuard);
      const tables = ['ad_creative_assets', 'creative_upload_operations', 'creative_upload_admission_guards',
        'creative_upload_reclamation_claims'];
      for (const table of tables) {
        assert.equal((await row(db, 'select relrowsecurity from pg_class where oid=$1::regclass', [`public.${table}`])).relrowsecurity, true);
        for (const role of ['anon', 'authenticated']) {
          assert.equal((await row(db, "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed",
            [role, `public.${table}`])).allowed, false);
          assert.equal((await row(db, "select has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as allowed",
            [role, `public.${table}`])).allowed, false);
        }
      }
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        assert.equal((await row(db, 'select has_table_privilege($1,$2,$3) as allowed',
          ['service_role', 'public.creative_upload_reclamation_claims', privilege])).allowed,
        privilege === 'SELECT' || privilege === 'INSERT');
      }
      assert.equal((await row(db, "select has_any_column_privilege('service_role',"
        + "'public.creative_upload_reclamation_claims','UPDATE,REFERENCES') as allowed")).allowed, false);
      for (const sql of [
        'update public.creative_upload_reclamation_claims set manifest=manifest',
        'delete from public.creative_upload_reclamation_claims',
        'truncate public.creative_upload_reclamation_claims']) {
        await unchangedRefusal(db, actor.workspace, () => service.query(sql), { code: '42501' });
      }
      for (const signature of [claimSignature, completeSignature, reserveSignature, 'public.protect_creative_cleanup_receipt()']) {
        for (const role of ['anon', 'authenticated', 'service_role']) {
          assert.equal((await row(db, "select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).allowed, role === 'service_role');
        }
        const fn = await row(db, 'select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [signature]);
        assert.equal(fn.prosecdef, false);
        assert.deepEqual(fn.proconfig, ['search_path=""']);
      }
      for (const role of ['anon', 'authenticated']) {
        const browser = await fixture.connect();
        try {
          await browser.query(`set role ${role}`);
          for (const table of tables) {
            await assert.rejects(browser.query(`select * from public.${table}`), { code: '42501' });
            await assert.rejects(browser.query(`delete from public.${table}`), { code: '42501' });
          }
          await assert.rejects(browser.query('select raw_cleanup_size from public.creative_upload_operations'), { code: '42501' });
          await assert.rejects(browser.query('update public.creative_upload_operations set raw_cleanup_size=1'), { code: '42501' });
          await assert.rejects(browser.query('select manifest from public.creative_upload_reclamation_claims'), { code: '42501' });
          await assert.rejects(browser.query('update public.creative_upload_reclamation_claims set manifest=manifest'), { code: '42501' });
          await assert.rejects(browser.query(`insert into public.creative_upload_reclamation_claims
            (workspace_id,claim_id,batch_limit,claimed_until,manifest) values($1,$2,1,clock_timestamp(),'[{}]'::jsonb)`,
          [actor.workspace, randomUUID()]), { code: '42501' });
          await assert.rejects(browser.query('truncate public.creative_upload_reclamation_claims'), { code: '42501' });
          await assert.rejects(claim(browser, actor.workspace, id), { code: '42501' });
          await assert.rejects(complete(browser, actor.workspace, operation.id, id), { code: '42501' });
          await assert.rejects(reserve(browser, actor), { code: '42501' });
          assert.deepEqual((await browser.query('select bucket_id,name from storage.objects')).rows,
            [{ bucket_id: 'unrelated', name: 'unchanged-sentinel' }]);
        } finally { await browser.end(); }
      }
      assert.deepEqual(await snapshot(db, actor.workspace), before);
      assert.deepEqual(await guard(db, actor.workspace), beforeGuard);
    });

    await t.test('RLS independently hides operation, guard and claim-history rows when table grants are temporarily restored', async () => {
      await db.query('begin');
      try {
        await db.query(`drop policy synthetic_browser_operations on public.creative_upload_operations;
          drop policy synthetic_browser_claims on public.creative_upload_reclamation_claims;
          grant select on public.creative_upload_operations,public.creative_upload_admission_guards,
            public.creative_upload_reclamation_claims to anon,authenticated`);
        for (const role of ['anon', 'authenticated']) {
          await db.query(`set local role ${role}`);
          assert.deepEqual((await db.query('select * from public.creative_upload_operations')).rows, []);
          assert.deepEqual((await db.query('select * from public.creative_upload_admission_guards')).rows, []);
          assert.deepEqual((await db.query('select * from public.creative_upload_reclamation_claims')).rows, []);
          await db.query('reset role');
        }
      } finally { await db.query('rollback'); }
    });

    await t.test('migration fails closed if a separate inherited role still grants journal mutation', async () => {
      const actor = await newActor(db), id = randomUUID();
      await seedHistory(db, actor);
      await claim(service, actor.workspace, id);
      const before = await snapshot(db, actor.workspace), beforeGuard = await guard(db, actor.workspace);
      await db.query(`create role fixture_claim_history_writer nologin;
        grant update(manifest) on public.creative_upload_reclamation_claims to fixture_claim_history_writer;
        grant fixture_claim_history_writer to service_role`);
      try {
        try {
          await assert.rejects(db.query(migration), { code: 'P0001', message: 'creative_reclamation_history_not_append_only' });
        } finally { await db.query('rollback'); }
      } finally {
        await db.query(`revoke fixture_claim_history_writer from service_role;
          revoke all on public.creative_upload_reclamation_claims from fixture_claim_history_writer;
          revoke update(manifest) on public.creative_upload_reclamation_claims from fixture_claim_history_writer;
          drop role fixture_claim_history_writer`);
      }
      assert.deepEqual(await snapshot(db, actor.workspace), before);
      assert.deepEqual(await guard(db, actor.workspace), beforeGuard);
      assert.deepEqual(await claim(service, actor.workspace, id), before.claims[0].manifest);
    });

    await t.test('foreign workspace ledger, asset tuples, guard and all Storage rows remain unchanged', async () => {
      assert.deepEqual(await snapshot(db, foreign.workspace), foreignBefore);
      assert.deepEqual(await guard(db, foreign.workspace), foreignGuard);
      assert.deepEqual(await storageSnapshot(), storageBefore);
    });
  } finally {
    await fixture.close();
    t.diagnostic('Owned native PostgreSQL stopped and its disposable run directory removed; no foreign processes signalled');
  }
});
