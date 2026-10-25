import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { startDisposablePostgres } from './disposable-postgres.mjs';
import { assertCatalogMatches, attestServerFiles, backupEnvironment, backupPaths, catalogAclSql, connectionArguments,
  createArchiveDirectory, digest, expectedTargetName, sourceDatabase, validateConnection,
  validateServerIdentity, verifyArchiveBytes } from './backup-restore-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exec = promisify(execFile);
const schemas = "('public','backup_fixture')";
const ident = value => `"${value.replaceAll('"', '""')}"`;
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const collect = async (db, sql) => (await db.query(sql)).rows;
const sqlState = code => error => error?.code === code;

async function serverRecord(db) {
  const record = await one(db, `select current_database() as database,current_user as "user",
    host(inet_server_addr()) as host,inet_server_port() as port,
    current_setting('data_directory') as data,current_setting('server_version') as version`);
  return { ...record, data: path.resolve(record.data) };
}

async function snapshot(db) {
  const tables = await collect(db, `select n.nspname as schema,c.relname as name
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ${schemas} and c.relkind='r' order by 1,2`);
  const data = {};
  for (const table of tables) data[`${table.schema}.${table.name}`] = (await one(db,
    `select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) as rows
      from ${ident(table.schema)}.${ident(table.name)} r`)).rows;
  const catalog = {};
  const queries = {
    schemas: `select nspname,pg_get_userbyid(nspowner) as owner,
      ${catalogAclSql.schemas} as acl
      from pg_namespace where nspname in ${schemas} order by 1`,
    relations: `select n.nspname,c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
      c.relreplident,pg_get_userbyid(c.relowner) as owner,
      ${catalogAclSql.relations} as acl,
      obj_description(c.oid,'pg_class') as comment from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname in ${schemas} order by 1,2`,
    columns: `select n.nspname,c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) as type,
      a.attnotnull,a.attidentity,a.attgenerated,
      case when a.attacl is null then null else array(select x::text from unnest(a.attacl) x order by x::text) end as acl,
      pg_get_expr(d.adbin,d.adrelid) as default_expression,
      col_description(c.oid,a.attnum) as comment from pg_attribute a
      join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
      where n.nspname in ${schemas} and c.relkind in ('r','S','v','m')
        and a.attnum>0 and not a.attisdropped order by 1,2,3`,
    constraints: `select n.nspname,c.relname,k.conname,k.contype,k.convalidated,k.condeferrable,k.condeferred,
      pg_get_constraintdef(k.oid,true) as definition from pg_constraint k
      join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ${schemas} order by 1,2,3`,
    triggers: `select n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ${schemas} and not t.tgisinternal order by 1,2,3`,
    indexes: `select n.nspname,c.relname,i.indisvalid,i.indisready,pg_get_indexdef(c.oid) as definition
      from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ${schemas} order by 1,2`,
    functions: `select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_functiondef(p.oid) as definition,pg_get_userbyid(p.proowner) as owner,
      ${catalogAclSql.functions} as acl,
      obj_description(p.oid,'pg_proc') as comment from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname in ${schemas} and p.prokind in ('f','p') order by 1,2,3`,
    policies: `select schemaname,tablename,policyname,permissive,roles::text,cmd,qual,with_check
      from pg_policies where schemaname in ${schemas} order by 1,2,3`,
    defaultAcl: `select pg_get_userbyid(d.defaclrole) as owner,n.nspname,d.defaclobjtype,
      case when d.defaclacl is null then null else array(select x::text from unnest(d.defaclacl) x order by x::text) end as acl
      from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace
      where n.nspname in ${schemas} order by 1,2,3`,
    extensions: `select e.extname,e.extversion,n.nspname,pg_get_userbyid(e.extowner) as owner
      from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by 1`,
    sequenceOwnership: `select n.nspname,s.relname,nt.nspname as table_schema,t.relname as table_name,
      a.attname,d.deptype from pg_class s join pg_namespace n on n.oid=s.relnamespace
      join pg_depend d on d.objid=s.oid and d.classid='pg_class'::regclass and d.deptype in ('a','i')
      join pg_class t on t.oid=d.refobjid join pg_namespace nt on nt.oid=t.relnamespace
      join pg_attribute a on a.attrelid=t.oid and a.attnum=d.refobjsubid
      where n.nspname in ${schemas} and s.relkind='S' order by 1,2`,
  };
  for (const [name, sql] of Object.entries(queries)) catalog[name] = await collect(db, sql);
  const sequences = await collect(db, `select schemaname,sequencename,sequenceowner,data_type::text,
    start_value,min_value,max_value,increment_by,cycle,cache_size,last_value
    from pg_sequences where schemaname in ${schemas} order by 1,2`);
  for (const sequence of sequences) sequence.state = await one(db,
    `select last_value::text,is_called from ${ident(sequence.schemaname)}.${ident(sequence.sequencename)}`);
  return { data, catalog, sequences };
}

async function assertEmpty(db) {
  const value = await one(db, `select
    (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ${schemas}) as relations,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ${schemas}) as functions`);
  assert.deepEqual(value, { relations: 0, functions: 0 }, 'Restore target is not empty');
}

function assertSnapshotMatches(actual, expected) {
  assertCatalogMatches(actual.catalog, expected.catalog);
  assert.deepEqual(actual.data, expected.data);
  assert.deepEqual(actual.sequences, expected.sequences);
}

test('G8/L4 real pg_dump/pg_restore of a newly owned synthetic native cluster only', {
  timeout: 360000,
  skip: process.env.MEDINA_TEST_POSTGRES_NATIVE !== '1' ? 'Explicit native opt-in required; no automatic Docker/download/URL fallback' : false,
}, async t => {
  const fixture = await startDisposablePostgres();
  const otherConnections = [];
  let artifacts;
  t.after(async () => {
    const failures = [];
    for (const db of otherConnections) await db.end().catch(() => failures.push(new Error('Owned restore client cleanup failed')));
    if (artifacts) await artifacts.close().catch(error => failures.push(error));
    await fixture.close().catch(error => failures.push(error));
    if (failures.length) throw new AggregateError(failures, 'Owned backup fixture cleanup incomplete');
  });
  const source = await fixture.connect();
  // 009 installs pgcrypto in the application schema. Putting pg_catalog first
  // here would make extension installation collide with native UUID routines.
  await source.query("set timezone='UTC'; set search_path=public,pg_catalog");
  const identity = validateServerIdentity(await serverRecord(source));
  validateConnection(source.connectionParameters, identity);
  await attestServerFiles(identity);
  artifacts = await createArchiveDirectory();
  // This is the helper's fresh per-run credential, not any ambient PG variable,
  // platform key, user's password, real backup source or external database URL.
  const childEnv = backupEnvironment(source.connectionParameters.password, artifacts.directory);
  const run = async (binary, args, { timeout = 60000, expectFailure = false } = {}) => {
    if (!['pg_dump', 'pg_restore'].includes(binary)) throw new Error('Unsupported fixture utility');
    const executable = path.join(backupPaths.runtime, `${binary}.exe`);
    if (await realpath(executable) !== executable || !(await lstat(executable)).isFile()) throw new Error('Fixture binary redirected');
    await attestServerFiles(identity); await artifacts.attest();
    const observation = await exec(executable, args, { env: childEnv, timeout, windowsHide: true,
      maxBuffer: 1024 * 1024 }).then(value => ({ ok: true, stdout: value.stdout }),
      error => ({ ok: false, code: error.code, timedOut: !!error.killed }));
    if (expectFailure) {
      assert.equal(observation.ok, false, 'Expected a bounded pg utility refusal');
      assert.equal(observation.timedOut, false, 'Refusal must be an actual utility result, not a killed process');
    } else if (!observation.ok) throw new Error(`${binary} failed in the owned fixture (status ${observation.code}); no external fallback attempted`);
    return observation;
  };
  for (const binary of ['pg_dump', 'pg_restore']) {
    assert.equal((await run(binary, ['--version'])).stdout.trim(), `${binary} (PostgreSQL) 17.11`);
  }
  await source.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role');
  const selected = new Set([9, 10, 11, 13, 14, 19, 23, 58, 62, 68, 91, 93]);
  const migrationProof = [];
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    if (!selected.has(Number(file.slice(0, 3)))) continue;
    const sql = await readFile(path.join(root, 'migrations', file), 'utf8');
    await source.query(sql); migrationProof.push({ file, sha256: digest(sql) });
  }
  assert.equal(migrationProof.length, selected.size);
  await source.query('set search_path=pg_catalog,public');
  const notice = { version: 'synthetic-backup-v1', text: 'SYNTHETIC ONLY: backup and restore receipt',
    purpose: 'SYNTHETIC TEST ONLY', policyRevision: 'SYNTHETIC-REV-1', policyUrl: 'https://policy.fixture.invalid/backup/v1' };
  notice.sha256 = digest(JSON.stringify([notice.version, notice.text, notice.purpose, notice.policyRevision, notice.policyUrl]));
  const tenants = [];
  for (const suffix of ['a', 'b']) {
    const workspace = randomUUID(), staff = randomUUID(), auth = randomUUID(), site = randomUUID(), request = randomUUID();
    const siteKey = `synthetic-${randomUUID()}`;
    await source.query('insert into public.workspaces(id,name,owner_email) values($1,$2,$3)',
      [workspace, `SYNTHETIC BACKUP ${suffix}`, `${suffix}@fixture.invalid`]);
    await source.query(`insert into public.staff_users(id,workspace_id,auth_user_id,full_name,email,role)
      values($1,$2,$3,$4,$5,'owner')`, [staff, workspace, auth, `SYNTHETIC OWNER ${suffix}`, `${auth}@fixture.invalid`]);
    await source.query(`insert into public.leads(workspace_id,full_name,phone,responsible_user_id,status,notes)
      values($1,$2,'+77000000001',$3,'in_progress','SYNTHETIC ONLY')`, [workspace, `SYNTHETIC LEAD ${suffix}`, staff]);
    await source.query(`insert into public.crm_intake_sites(id,site_key,workspace_id,consent_version,allowed_page_paths,enabled,manual_deletion_enabled)
      values($1,$2,$3,$4,array['/ru/'],true,true)`, [site, siteKey, workspace, notice.version]);
    const inquiry = { name: `SYNTHETIC VISITOR ${suffix}`, phone: '+77000000002', business: 'SYNTHETIC BUSINESS',
      service: 'call-center', pagePath: '/ru/', consentVersion: notice.version, consent: true };
    await source.query('select public.accept_crm_site_inquiry_with_consent($1,$2,$3,$4)', [siteKey, request, inquiry, notice]);
    tenants.push({ workspace, staff, auth, site, siteKey, request, inquiry });
  }
  // App identities are UUIDs, so a clearly separate synthetic sequence exercises
  // state/ownership/gaps without inventing a sequence in an application table.
  await source.query(`create schema backup_fixture;
    create table backup_fixture.sequence_probe(
      id bigint generated always as identity (start with 700 increment by 7 cache 1) primary key,
      workspace_id uuid not null references public.workspaces(id),label text not null unique,
      positive integer not null check(positive>0));
    alter table backup_fixture.sequence_probe enable row level security;
    alter table backup_fixture.sequence_probe force row level security;
    create policy synthetic_service_only on backup_fixture.sequence_probe for select to service_role using(true);
    revoke all on schema backup_fixture from public,anon,authenticated;
    grant usage on schema backup_fixture to service_role;
    grant select(label) on backup_fixture.sequence_probe to service_role;`);
  for (let n = 0; n < 3; n++) await source.query('insert into backup_fixture.sequence_probe(workspace_id,label,positive) values($1,$2,1)',
    [tenants[n % 2].workspace, `SYNTHETIC-${n}`]);
  await source.query("delete from backup_fixture.sequence_probe where label='SYNTHETIC-2'; select setval('backup_fixture.sequence_probe_id_seq',978,true)");
  const before = await snapshot(source);
  assert.equal(before.data['public.workspaces'].length, 2);
  assert.equal(before.data['public.staff_users'].length, 2);
  assert.equal(before.data['public.leads'].length, 4);
  assert.equal(before.data['public.crm_site_consent_receipts'].length, 2);
  assert.equal(before.sequences.length, 1);
  const openTarget = async kind => {
    const database = expectedTargetName(identity.runId, kind);
    connectionArguments(identity, database, kind);
    const fresh = await serverRecord(source); assert.deepEqual(fresh, {
      database: identity.database, user: identity.user, host: identity.host, port: identity.port, data: identity.data, version: identity.version,
    });
    await source.query(`create database ${ident(database)} template template0`);
    const db = new pg.Client({ host: identity.host, port: identity.port, database, user: identity.user,
      password: source.connectionParameters.password, ssl: false, connectionTimeoutMillis: 3000,
      query_timeout: 15000, application_name: 'medina_owned_restore_target',
      options: '-c statement_timeout=10000 -c idle_in_transaction_session_timeout=20000' });
    db.on('error', () => {});
    try { await db.connect(); otherConnections.push(db); }
    catch (error) { await db.end().catch(() => {}); throw error; }
    validateConnection(db.connectionParameters, identity, database);
    await db.query("set timezone='UTC'; set search_path=pg_catalog,public");
    const actual = await serverRecord(db);
    assert.equal(actual.database, database); assert.equal(actual.data, identity.data);
    assert.equal(actual.host, identity.host); assert.equal(actual.port, identity.port);
    await assertEmpty(db);
    return { db, database, kind };
  };
  const archive = await artifacts.artifact('synthetic.dump');
  const dump = async (filename, expectFailure = false) => {
    assert.equal(await artifacts.artifact(path.basename(filename)), filename);
    await writeFile(filename, '', { flag: 'wx', mode: 0o600 });
    const result = await run('pg_dump', [...connectionArguments(identity, sourceDatabase),
      '--format=custom', '--compress=0', '--lock-wait-timeout=1000ms', `--file=${filename}`], { expectFailure });
    if (!result.ok) { await artifacts.attest(); await rm(filename); }
    return result;
  };
  await t.test('lock contention yields a bounded actual dump failure and no approved partial artifact', async () => {
    const lock = await fixture.connect();
    try {
      await lock.query('begin; lock table public.leads in access exclusive mode');
      const failed = await artifacts.artifact('locked.dump'); await dump(failed, true);
      await assert.rejects(lstat(failed), error => error.code === 'ENOENT');
    } finally { await lock.query('rollback'); await lock.end(); }
    assertSnapshotMatches(await snapshot(source), before);
  });
  await dump(archive);
  const bytes = await readFile(archive), hash = digest(bytes);
  verifyArchiveBytes(bytes, hash);
  const manifest = await artifacts.artifact('synthetic.sha256');
  await writeFile(manifest, `${hash}\n`, { flag: 'wx', mode: 0o600 });
  assert.equal((await readFile(manifest, 'utf8')).trim(), hash);
  const toc = (await run('pg_restore', ['--list', archive])).stdout;
  assert.match(toc, /crm_site_consent_receipts/); assert.match(toc, /SEQUENCE SET/);
  assert.match(toc, /ACL/); assert.match(toc, /POLICY/);
  const restored = await openTarget('restored');
  const restore = async (target, filename, expectedHash) => {
    assert.equal(target.database, expectedTargetName(identity.runId, target.kind));
    validateConnection(target.db.connectionParameters, identity, target.database);
    const actual = await serverRecord(target.db);
    assert.equal(actual.database, target.database); assert.equal(actual.data, identity.data);
    assert.equal(actual.host, '127.0.0.1'); assert.equal(actual.port, identity.port);
    assert.equal(filename, await artifacts.artifact(path.basename(filename)));
    verifyArchiveBytes(await readFile(filename), expectedHash);
    await assertEmpty(target.db);
    return run('pg_restore', [...connectionArguments(identity, target.database, target.kind),
      '--exit-on-error', '--single-transaction', filename]);
  };
  await t.test('restore refuses the source connection or a substituted database name without any write', async () => {
    await assert.rejects(restore({ ...restored, db: source }, archive, hash), /Connection escaped/);
    await assert.rejects(restore({ ...restored, database: sourceDatabase }, archive, hash));
    await assertEmpty(restored.db);
    assertSnapshotMatches(await snapshot(source), before);
  });
  await t.test('nonempty restore target is refused before pg_restore and existing target row remains intact', async () => {
    await restored.db.query('create table public.synthetic_do_not_overwrite(v text); insert into public.synthetic_do_not_overwrite values(\'SYNTHETIC KEEP\')');
    await assert.rejects(restore(restored, archive, hash), /Restore target is not empty/);
    assert.deepEqual(await collect(restored.db, 'select * from public.synthetic_do_not_overwrite'), [{ v: 'SYNTHETIC KEEP' }]);
    await restored.db.query('drop table public.synthetic_do_not_overwrite');
    await assertEmpty(restored.db);
  });
  await t.test('modified body, wrong checksum and foreign paths cannot reach the restore utility', async () => {
    const modified = Buffer.from(bytes); modified[modified.length - 1] ^= 1;
    const file = await artifacts.artifact('modified.dump'); await writeFile(file, modified, { flag: 'wx' });
    await assert.rejects(restore(restored, file, hash), /integrity check failed/);
    await assert.rejects(restore(restored, archive, '0'.repeat(64)), /integrity check failed/);
    await assert.rejects(restore(restored, path.join(root, 'synthetic.dump'), hash));
    await assertEmpty(restored.db);
    assertSnapshotMatches(await snapshot(source), before);
  });
  await t.test('actual pg_restore refuses a truncated archive atomically in a separate empty owned target', async () => {
    const corrupt = await openTarget('corrupt');
    const truncated = await artifacts.artifact('truncated.dump');
    await writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)), { flag: 'wx' });
    // Intentionally bypass only the outer SHA gate, never target/host/path gates,
    // to test pg_restore's own bounded corruption handling and transaction.
    assert.equal(truncated, await artifacts.artifact('truncated.dump'));
    await run('pg_restore', [...connectionArguments(identity, corrupt.database, corrupt.kind),
      '--exit-on-error', '--single-transaction', truncated], { expectFailure: true });
    await assertEmpty(corrupt.db);
    assertSnapshotMatches(await snapshot(source), before);
  });
  await restore(restored, archive, hash);
  await t.test('all synthetic rows including cross-tenant assignments and exact 093 notice snapshots match', async () => {
    assert.deepEqual((await snapshot(restored.db)).data, before.data);
    for (const tenant of tenants) {
      const value = await one(restored.db, `select count(*)::int as count from public.leads l join public.staff_users s
        on s.id=l.responsible_user_id and s.workspace_id=l.workspace_id where l.workspace_id=$1`, [tenant.workspace]);
      assert.equal(value.count, 1);
      assert.deepEqual((await one(restored.db, 'select notice_snapshot from public.crm_site_consent_receipts where site_id=$1', [tenant.site])).notice_snapshot, notice);
    }
  });
  await t.test('schema owners/ACL/defaults, RLS, indexes, functions, triggers and constraints survive without --no-owner/--no-acl', async () => {
    assertCatalogMatches((await snapshot(restored.db)).catalog, before.catalog);
    assert.ok(before.catalog.policies.length > 0);
    assert.ok(before.catalog.triggers.some(row => row.tgname === 'require_crm_site_consent_receipt'));
  });
  await t.test('sequence state, ownership and a non-row-derived gap are faithfully restored', async () => {
    assert.deepEqual((await snapshot(restored.db)).sequences, before.sequences);
    assert.equal((await one(restored.db, "select nextval('backup_fixture.sequence_probe_id_seq')::text as value")).value, '985');
  });
  await t.test('restored browser roles cannot read/mutate CRM identities, leads, consent audit, RPCs or sequences', async () => {
    for (const role of ['anon', 'authenticated']) {
      await restored.db.query(`set role ${role}`);
      try {
        for (const table of ['workspaces', 'staff_users', 'leads', 'crm_site_inquiries', 'crm_site_consent_receipts']) {
          await assert.rejects(restored.db.query(`select * from public.${table}`), sqlState('42501'));
          await assert.rejects(restored.db.query(`delete from public.${table}`), sqlState('42501'));
          await assert.rejects(restored.db.query(`insert into public.${table} default values`), sqlState('42501'));
        }
        for (const [table, field] of [['workspaces', 'name'], ['staff_users', 'role'], ['leads', 'full_name'],
          ['crm_site_inquiries', 'inquiry'], ['crm_site_consent_receipts', 'notice_snapshot']]) {
          await assert.rejects(restored.db.query(`update public.${table} set ${field}=${field}`), sqlState('42501'));
        }
        await assert.rejects(restored.db.query('create table public.synthetic_browser_object(v text)'), sqlState('42501'));
        await assert.rejects(restored.db.query("select nextval('backup_fixture.sequence_probe_id_seq')"), sqlState('42501'));
        await assert.rejects(restored.db.query('select public.accept_crm_site_inquiry_with_consent($1,$2,$3,$4)',
          [tenants[0].siteKey, randomUUID(), tenants[0].inquiry, notice]), sqlState('42501'));
      } finally { await restored.db.query('reset role'); }
    }
  });
  await t.test('restored service RPC replays exactly and immutable receipt guard remains executable', async () => {
    const count = (await snapshot(restored.db)).data;
    await restored.db.query('set role service_role');
    try {
      for (const tenant of tenants) assert.deepEqual((await one(restored.db,
        'select public.accept_crm_site_inquiry_with_consent($1,$2,$3,$4) as result',
        [tenant.siteKey, tenant.request, tenant.inquiry, notice])).result, { accepted: true });
      await assert.rejects(restored.db.query('update public.crm_site_consent_receipts set notice_snapshot=$1', [notice]), sqlState('42501'));
    } finally { await restored.db.query('reset role'); }
    await assert.rejects(restored.db.query('update public.crm_site_consent_receipts set notice_snapshot=$1', [notice]), sqlState('23001'));
    assert.deepEqual((await snapshot(restored.db)).data, count);
  });
  await t.test('restored FK/check/unique and deferred receipt constraints reject invalid rows and roll back', async () => {
    const db = restored.db;
    await assert.rejects(db.query('insert into backup_fixture.sequence_probe(workspace_id,label,positive) values($1,$2,1)',
      [randomUUID(), 'SYNTHETIC INVALID FK']), sqlState('23503'));
    await assert.rejects(db.query('insert into backup_fixture.sequence_probe(workspace_id,label,positive) values($1,$2,0)',
      [tenants[0].workspace, 'SYNTHETIC INVALID CHECK']), sqlState('23514'));
    await assert.rejects(db.query('insert into backup_fixture.sequence_probe(workspace_id,label,positive) values($1,$2,1)',
      [tenants[0].workspace, 'SYNTHETIC-0']), sqlState('23505'));
    await db.query('begin');
    try {
      await db.query('insert into public.crm_site_inquiries(site_id,request_key,inquiry) values($1,$2,$3)',
        [tenants[0].site, randomUUID(), tenants[0].inquiry]);
      await assert.rejects(db.query('commit'), error => error?.code === '23514' && /consent_receipt_required/.test(error.message));
    } finally { await db.query('rollback'); }
    assert.deepEqual((await snapshot(db)).data, before.data);
    assertSnapshotMatches(await snapshot(source), before);
  });
  t.diagnostic(`Synthetic-only pg_dump/pg_restore 17.11; ${bytes.length} archive bytes; unsigned SHA-256 ${hash}; ${Object.keys(before.data).length} tables; existing synthetic cluster roles are prerequisites, not pg_dumpall role-backup evidence; no real backup settings, credentials, storage-location or legal-compliance proof`);
  for (const proof of migrationProof) t.diagnostic(`${proof.file} SHA-256 ${proof.sha256}`);
});
