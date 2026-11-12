import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startDisposablePostgres } from './disposable-postgres.mjs';

// Execute actual 015 table/index SQL, 082 and 085, with only prerequisite tables
// and roles scaffolded. This is NOT full-chain/Storage/runtime identity proof.
const migrations = new URL('../../migrations/', import.meta.url);
const source015 = await readFile(new URL('015_ad_creative_assets.sql', migrations), 'utf8');
const storageMarker = 'insert into storage.buckets';
assert.equal(source015.split(storageMarker).length, 2);
const table015 = source015.slice(0, source015.indexOf(storageMarker));
assert.doesNotMatch(table015, /storage\./i);
const access082 = await readFile(new URL('082_ad_creative_assets_server_access.sql', migrations), 'utf8');
const identity085 = await readFile(new URL('085_generated_creative_identity.sql', migrations), 'utf8');
const A = '10000000-0000-4000-8000-000000000001';
const B = '20000000-0000-4000-8000-000000000002';
const CONTENT_HASH = 'c'.repeat(64);
const observe = promise => promise.then(value => ({ value }), error => ({ error }));

// Synthetic row shapes only: these do not reproduce/test the runtime digest,
// UUID-v5 algorithm, legacy URL validator, or streamed byte verification.
function asset(workspace, job, canonical = false) {
  const digest = createHash('sha256').update(`sql-fixture:${workspace}:${job}`).digest('hex');
  const name = canonical ? `negis-video-${digest.slice(0, 20)}.mp4` : 'negis-video-1792886400000.mp4';
  const path = canonical ? `${workspace}/generated/${digest}` : `${workspace}/2026/10/${job}-${name}`;
  return {
    id: randomUUID(), workspace_id: workspace, uploaded_by: 'synthetic-sql-fixture',
    file_name: name, file_type: 'video', mime_type: 'video/mp4', file_size: 32,
    storage_bucket: 'ad-creatives', storage_path: path,
    public_url: `https://storage.invalid/storage/v1/object/public/ad-creatives/${path}`,
    status: 'uploaded', metadata: { uploadMode: 'ai-generated', kind: 'generated-video', jobId: job },
    ...(canonical ? { generated_key: `v1:${job}`, generated_sha256: CONTENT_HASH } : {}),
  };
}

function insert(db, row) {
  const columns = Object.keys(row);
  assert.ok(columns.every(column => /^[a-z_][a-z_0-9]*$/.test(column)));
  return db.query(`insert into public.ad_creative_assets (${columns.join(',')})
    values (${columns.map((_, index) => `$${index + 1}`).join(',')}) returning *`, Object.values(row));
}

async function rows(db) {
  return (await db.query('select to_jsonb(a) as row from public.ad_creative_assets a order by id')).rows.map(row => row.row);
}

async function catalog(db) {
  return (await db.query(`select jsonb_build_object(
    'table', (select jsonb_build_object('rls',relrowsecurity,'force',relforcerowsecurity,'acl',relacl::text)
      from pg_class where oid='public.ad_creative_assets'::regclass),
    'columns', (select jsonb_agg(jsonb_build_object('name',attname,'type',format_type(atttypid,atttypmod),
      'null',attnotnull,'acl',attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.ad_creative_assets'::regclass and a.attnum>0 and not a.attisdropped),
    'indexes', (select jsonb_agg(indexdef order by indexname) from pg_indexes
      where schemaname='public' and tablename='ad_creative_assets'),
    'triggers', (select jsonb_agg(pg_get_triggerdef(oid) order by tgname) from pg_trigger
      where tgrelid='public.ad_creative_assets'::regclass and not tgisinternal),
    'functions', (select jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl::text)
      order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f'),
    'policies', (select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p
      where schemaname='public' and tablename='ad_creative_assets')
    ) as snapshot`)).rows[0].snapshot;
}

async function refusedMigration(db, message = 'generated_creative_identity_duplicates') {
  const result = await observe(db.query(identity085));
  await db.query('rollback');
  assert.ok(result.error, '085 must fail closed on an invalid prerequisite or ambiguous legacy identity');
  assert.match(result.error.code ?? '', /^[A-Z0-9]{5}$/);
  assert.equal(result.error.message, message);
}

async function replay(db, workspace, job) {
  return (await db.query(`select * from public.ad_creative_assets
    where workspace_id=$1 and generated_key=$2 limit 2`, [workspace, `v1:${job}`])).rows;
}

async function withPeers(fixture, observer, callback) {
  const clients = [];
  const pids = [];
  try {
    for (let index = 0; index < 2; index++) {
      const client = await fixture.connect();
      clients.push(client);
      await client.query('set role service_role');
      pids.push((await client.query('select pg_backend_pid() as pid')).rows[0].pid);
    }
    await callback(clients[0], clients[1], pids);
  } finally {
    if (pids.length) await observer.query(`select pg_cancel_backend(pid) from pg_stat_activity
      where pid=any($1::integer[]) and state='active'`, [pids]);
    for (const client of clients) {
      try { await client.query('rollback'); } finally { await client.end(); }
    }
  }
}

async function waitForLock(observer, waiter, holder, t) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const { rows: [state] } = await observer.query(`select pg_blocking_pids(pid) as blockers,wait_event_type
      from pg_stat_activity where pid=$1`, [waiter]);
    if (state?.blockers.includes(holder) && state.wait_event_type === 'Lock') {
      t.diagnostic(`Observed backend ${waiter} waiting on Lock held by backend ${holder}`);
      return;
    }
    await delay(20);
  }
  assert.fail(`No native PostgreSQL lock wait observed: ${waiter} blocked by ${holder}`);
}

async function assertSecure(db) {
  assert.equal((await db.query(`select relrowsecurity from pg_class
    where oid='public.ad_creative_assets'::regclass`)).rows[0].relrowsecurity, true);
  assert.equal((await db.query(`select count(*)::int as count from pg_class c,
    lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    where c.oid='public.ad_creative_assets'::regclass and a.grantee=0`)).rows[0].count, 0);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_table_privilege($1,'public.ad_creative_assets',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed`, [role])).rows[0].allowed, false);
    assert.equal((await db.query(`select has_any_column_privilege($1,'public.ad_creative_assets',
      'SELECT,INSERT,UPDATE,REFERENCES') as allowed`, [role])).rows[0].allowed, false);
  }
}

test('G5-C53 actual 015 table-only + 082 + 085 on owned disposable PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  try {
    const db = await fixture.connect();
    await db.query(`create role anon nologin nobypassrls;
      create role authenticated nologin nobypassrls;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      create table public.workspaces(id uuid primary key);
      create table public.meta_campaign_launches(id uuid primary key);
      create table public.unrelated(id integer primary key, note text);
      insert into public.unrelated values(1,'Synthetic unchanged sentinel');
      grant select(note) on public.unrelated to authenticated;
      alter default privileges grant all on tables to anon, authenticated;`);
    await db.query('insert into public.workspaces values($1),($2)', [A, B]);
    await db.query(table015);
    await db.query(access082);
    await assertSecure(db);
    const sentinel = async () => (await db.query(`select to_jsonb(u) as row,
      (select relacl::text from pg_class where oid='public.unrelated'::regclass) as acl from public.unrelated u`)).rows;
    const untouched = await sentinel();
    const legacy = asset(A, 'video_migration_duplicate');
    const duplicate = { ...legacy, id: randomUUID(), file_name: 'negis-video-1792886400001.mp4' };
    const foreign = asset(B, legacy.metadata.jobId);
    const manual = { ...asset(A, legacy.metadata.jobId), metadata: { ...legacy.metadata, uploadMode: 'server-storage' } };
    const image = { ...asset(A, legacy.metadata.jobId), file_type: 'image', mime_type: 'image/png',
      metadata: { ...legacy.metadata, kind: 'generated-photo' } };
    for (const row of [legacy, duplicate, foreign, manual, image]) await insert(db, row);

    await t.test('085 refuses missing 082 protections before adding columns or changing rows', async () => {
      for (const weaken of [
        'alter table public.ad_creative_assets disable row level security',
        'grant select on public.ad_creative_assets to anon',
        'grant update on public.ad_creative_assets to authenticated',
        'revoke select on public.ad_creative_assets from service_role',
        'revoke insert on public.ad_creative_assets from service_role',
        'revoke update on public.ad_creative_assets from service_role',
      ]) {
        await db.query(weaken);
        try {
          const beforeRows = await rows(db);
          const beforeCatalog = await catalog(db);
          await refusedMigration(db, 'generated_creative_requires_082_server_only_access');
          assert.deepEqual(await rows(db), beforeRows, weaken);
          assert.deepEqual(await catalog(db), beforeCatalog, weaken);
        } finally { await db.query(access082); }
      }
      await assertSecure(db);
    });

    await t.test('duplicate preflight refuses with all rows, schema and 082 permissions unchanged', async () => {
      const beforeRows = await rows(db);
      const beforeCatalog = await catalog(db);
      await refusedMigration(db);
      assert.deepEqual(await rows(db), beforeRows);
      assert.deepEqual(await catalog(db), beforeCatalog);
      assert.equal((await db.query(`select count(*)::int as count from public.ad_creative_assets
        where workspace_id=$1 and metadata->>'jobId'=$2 and metadata->>'uploadMode'='ai-generated'
        and metadata->>'kind'='generated-video'`, [A, legacy.metadata.jobId])).rows[0].count, 2);
      await assertSecure(db);
    });

    // Only fixture-owned synthetic duplicate is removed to permit the success case.
    await db.query('delete from public.ad_creative_assets where id=$1', [duplicate.id]);
    await t.test('085 waits for an old writer and refuses its newly committed duplicate atomically', async () => {
      const beforeCatalog = await catalog(db);
      await withPeers(fixture, db, async (writer, migration, [holder, waiter]) => {
        await migration.query('reset role');
        await writer.query('begin');
        await insert(writer, duplicate);
        const pending = observe(migration.query(identity085));
        await waitForLock(db, waiter, holder, t);
        await writer.query('commit');
        const expectedRows = await rows(db);
        const result = await pending;
        await migration.query('rollback');
        assert.ok(result.error, 'Concurrent legacy duplicate must not be silently accepted');
        assert.deepEqual(await rows(db), expectedRows);
        assert.deepEqual(await catalog(db), beforeCatalog);
      });
    });
    await db.query('delete from public.ad_creative_assets where id=$1', [duplicate.id]);

    await t.test('backfill preserves legacy identity/hash-null and does not key manual or photo rows', async () => {
      const before = await rows(db);
      await db.query(identity085);
      const after = await rows(db);
      assert.deepEqual(after.map(({ generated_key, generated_sha256, ...row }) => row), before);
      for (const row of after) {
        const isLegacy = [legacy.id, foreign.id].includes(row.id);
        assert.equal(row.generated_key, isLegacy ? `v1:${legacy.metadata.jobId}` : null);
        assert.equal(row.generated_sha256, null, 'SQL cannot invent byte verification');
      }
      assert.equal((await replay(db, A, legacy.metadata.jobId))[0].id, legacy.id);
      assert.equal((await replay(db, B, legacy.metadata.jobId))[0].id, foreign.id);
      const definitions = (await db.query(`select pg_get_indexdef(i.indexrelid) as definition
        from pg_index i where i.indrelid='public.ad_creative_assets'::regclass and i.indisunique`)).rows;
      assert.ok(definitions.some(row => /\(workspace_id, generated_key\)/.test(row.definition)));
      await assertSecure(db);
    });

    for (const [label, firstCanonical, secondCanonical, commit] of [
      ['legacy commits before new client', false, true, true],
      ['new client commits before legacy', true, false, true],
      ['legacy rollback releases new client', false, true, false],
    ]) {
      await t.test(`${label}: observed lock wait, no overwrite, exact keyed replay`, async () => {
        const job = `video_race_${firstCanonical}_${secondCanonical}_${commit}`;
        const first = asset(A, job, firstCanonical);
        const second = asset(A, job, secondCanonical);
        await withPeers(fixture, db, async (left, right, [holder, waiter]) => {
          await left.query('begin');
          const held = (await insert(left, first)).rows[0];
          await right.query('begin');
          const pending = observe(insert(right, second));
          await waitForLock(db, waiter, holder, t);
          await left.query(commit ? 'commit' : 'rollback');
          const result = await pending;
          if (commit) {
            assert.equal(result.error?.code, '23505', 'Distinct PKs must collide on workspace/generated_key');
            await right.query('rollback');
            assert.deepEqual(await replay(db, A, job), [held]);
            assert.equal((await db.query('select count(*)::int as count from public.ad_creative_assets where id=$1', [second.id])).rows[0].count, 0);
          } else {
            assert.equal(result.error, undefined);
            await right.query('commit');
            assert.deepEqual(await replay(db, A, job), result.value.rows);
            assert.equal(result.value.rows[0].id, second.id);
          }
        });
      });
    }

    await t.test('same job in another tenant commits while first tenant still holds its transaction', async () => {
      const job = 'video_independent_tenants';
      const first = asset(A, job);
      const second = asset(B, job, true);
      await withPeers(fixture, db, async (left, right) => {
        await left.query('begin');
        const held = (await insert(left, first)).rows[0];
        await right.query('begin');
        await right.query("set local lock_timeout='1500ms'");
        const inserted = (await insert(right, second)).rows[0];
        await right.query('commit');
        assert.deepEqual(await replay(db, B, job), [inserted]);
        assert.deepEqual(await replay(db, A, job), [], 'Other connection must not see uncommitted tenant A');
        await left.query('commit');
        assert.deepEqual(await replay(db, A, job), [held]);
      });
    });

    await t.test('new/new same explicit assetId cannot insert twice', async () => {
      const original = asset(A, 'video_canonical_pk', true);
      const committed = (await insert(db, original)).rows[0];
      await assert.rejects(insert(db, original), error => error.code === '23505');
      assert.deepEqual(await replay(db, A, original.metadata.jobId), [committed]);
    });

    await t.test('status/Meta/metadata updates preserve keyed replay after jobId is removed', async () => {
      const original = asset(A, 'video_mutable_metadata', true);
      const stored = (await insert(db, original)).rows[0];
      const { rows: [updated] } = await db.query(`update public.ad_creative_assets set status='ready',
        meta_asset_id='synthetic-meta-asset',meta_video_id='synthetic-meta-video',
        metadata=$2,updated_at=updated_at+interval '1 second' where id=$1 returning *`,
      [original.id, { source: 'synthetic-meta-update', jobId: 'video_other_job' }]);
      assert.equal(updated.generated_key, stored.generated_key);
      assert.equal(updated.generated_sha256, stored.generated_sha256);
      assert.equal(updated.status, 'ready');
      assert.equal(updated.meta_asset_id, 'synthetic-meta-asset');
      assert.equal(updated.meta_video_id, 'synthetic-meta-video');
      assert.deepEqual(await replay(db, A, original.metadata.jobId), [updated]);
      assert.deepEqual(await replay(db, A, 'video_other_job'), []);
      await assert.rejects(insert(db, asset(A, original.metadata.jobId)), error => error.code === '23505');
      const { rows: [legacyUpdated] } = await db.query(`update public.ad_creative_assets
        set status='ready',metadata=$2 where id=$1 returning *`, [legacy.id, { source: 'synthetic-meta-update' }]);
      assert.equal(legacyUpdated.generated_key, `v1:${legacy.metadata.jobId}`);
      assert.equal(legacyUpdated.generated_sha256, null);
      assert.deepEqual(await replay(db, A, legacy.metadata.jobId), [legacyUpdated]);
    });

    await t.test('keyed critical fields and nonnull hash cannot be changed or cleared', async () => {
      const original = asset(A, 'video_immutable', true);
      await insert(db, original);
      const before = await rows(db);
      for (const [field, value] of [
        ['id', randomUUID()], ['workspace_id', B], ['generated_key', 'v1:video_retarget'],
        ['generated_key', null], ['generated_sha256', 'd'.repeat(64)], ['generated_sha256', null],
        ['file_name', 'replacement.mp4'], ['file_type', 'image'], ['mime_type', 'video/webm'],
        ['file_size', 33], ['storage_bucket', 'another-bucket'], ['storage_path', `${A}/replaced.mp4`],
        ['public_url', 'https://storage.invalid/replaced.mp4'],
      ]) {
        await assert.rejects(db.query(`update public.ad_creative_assets set ${field}=$2 where id=$1`,
          [original.id, value]), error => /^[A-Z0-9]{5}$/.test(error.code ?? ''), `${field} must be immutable`);
        assert.deepEqual(await rows(db), before, `${field} refusal must leave all rows unchanged`);
      }
      for (const field of ['workspace_id', 'file_name', 'storage_path', 'public_url']) {
        const value = field === 'workspace_id' ? B : 'synthetic-replacement';
        await assert.rejects(db.query(`update public.ad_creative_assets set ${field}=$2 where id=$1`, [legacy.id, value]));
        assert.deepEqual(await rows(db), before, 'Legacy keyed rows need the same file/tenant protection');
      }
    });

    await t.test('unkeyed uploads remain independent, and exact different keys are not normalized together', async () => {
      const one = { ...asset(A, 'video_manual_duplicate'), metadata: { uploadMode: 'server-storage' } };
      const two = { ...one, id: randomUUID() };
      for (const row of [one, two]) {
        const saved = (await insert(db, row)).rows[0];
        assert.equal(saved.generated_key, null);
        assert.equal(saved.generated_sha256, null);
      }
      const changed = await db.query('update public.ad_creative_assets set file_name=$2 where id=$1 returning file_name',
        [one.id, 'manual-replacement.mp4']);
      assert.equal(changed.rows[0].file_name, 'manual-replacement.mp4');
      for (const job of ['video_exact_key', 'VIDEO_exact_key']) {
        const row = (await insert(db, asset(A, job, true))).rows[0];
        assert.deepEqual(await replay(db, A, job), [row]);
      }
    });

    await t.test('082 still denies browser CRUD and direct key/hash access even with permissive RLS', async () => {
      await db.query(`create policy synthetic_browser_all on public.ad_creative_assets
        for all to anon, authenticated using(true) with check(true)`);
      await assertSecure(db);
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await db.query(`select has_function_privilege($1,
          'public.protect_generated_creative_identity()','EXECUTE') as allowed`, [role])).rows[0].allowed, false);
      }
      const beforeRows = await rows(db);
      for (const role of ['anon', 'authenticated']) {
        const browser = await fixture.connect();
        try {
          await browser.query(`set role ${role}`);
          for (const sql of [
            'select * from public.ad_creative_assets',
            'select generated_key,generated_sha256 from public.ad_creative_assets',
            'insert into public.ad_creative_assets default values',
            "update public.ad_creative_assets set generated_key='v1:forged'",
            "update public.ad_creative_assets set generated_sha256=repeat('a',64)",
            "update public.ad_creative_assets set status='changed'",
            'delete from public.ad_creative_assets',
          ]) await assert.rejects(browser.query(sql), error => error.code === '42501');
        } finally { await browser.end(); }
      }
      assert.deepEqual(await rows(db), beforeRows);
    });

    await t.test('service role keeps CRUD and keyed lookup under 082 after 085', async () => {
      const server = await fixture.connect();
      try {
        await server.query('set role service_role');
        const original = asset(A, 'video_service_crud', true);
        const stored = (await insert(server, original)).rows[0];
        assert.deepEqual(await replay(server, A, original.metadata.jobId), [stored]);
        assert.equal((await server.query("update public.ad_creative_assets set status='ready' where id=$1", [original.id])).rowCount, 1);
        assert.equal((await server.query('delete from public.ad_creative_assets where id=$1', [original.id])).rowCount, 1);
        assert.deepEqual(await replay(server, A, original.metadata.jobId), []);
      } finally { await server.end(); }
    });

    await t.test('085 repeat is data/schema/ACL-idempotent and never provisions Storage or touches unrelated rows', async () => {
      const beforeRows = await rows(db);
      const beforeCatalog = await catalog(db);
      await db.query(identity085);
      assert.deepEqual(await rows(db), beforeRows);
      assert.deepEqual(await catalog(db), beforeCatalog);
      assert.deepEqual(await sentinel(), untouched);
      assert.equal((await db.query("select to_regnamespace('storage') as storage")).rows[0].storage, null);
      await assertSecure(db);
    });
  } finally { await fixture.close(); }
});
