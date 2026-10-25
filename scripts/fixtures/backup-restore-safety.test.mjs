import assert from 'node:assert/strict';
import { link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertCatalogMatches, backupEnvironment, backupPaths, catalogAclSql, connectionArguments, createArchiveDirectory, digest,
  expectedTargetName, sourceDatabase, validateArtifactName, validateConnection,
  validateServerIdentity, verifyArchiveBytes } from './backup-restore-safety.mjs';

const runId = '00000000-0000-4000-8000-000000000001';
const record = { database: sourceDatabase, user: 'postgres', host: '127.0.0.1', port: 54321,
  version: '17.11', data: path.join(backupPaths.nativeRuns, runId, 'data') };
const identity = validateServerIdentity(record);
const connection = { host: identity.host, port: identity.port, user: identity.user, database: sourceDatabase, ssl: false };
const bytes = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(128, 7)]);

test('catalog diagnostics are bounded by category/entry hashes and never dump function bodies', () => {
  const expected = { functions: [{ proname: 'synthetic', definition: 'SYNTHETIC-NO-DUMP '.repeat(20000), acl: ['postgres=X/postgres'] }] };
  assertCatalogMatches(structuredClone(expected), expected);
  const actual = structuredClone(expected); actual.functions[0].definition += 'changed';
  assert.throws(() => assertCatalogMatches(actual, expected), error => {
    assert.ok(error.message.length < 300); assert.match(error.message, /Catalog mismatch functions entry 0; fields definition/);
    assert.doesNotMatch(error.message, /SYNTHETIC-NO-DUMP/); return true;
  });
  assert.throws(() => assertCatalogMatches({ functions: [] }, expected), /Catalog mismatch functions entry 0/);
  assert.throws(() => assertCatalogMatches({}, expected), /Catalog mismatch functions entry -/);
});

test('actual PostgreSQL ACL defaults and pretty constraint deparse retain meaningful differences in PGlite', { timeout: 90000 }, async t => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema backup_semantic;
    create table backup_semantic.a(n integer, paths text[],
      constraint nested_check check ((n>=1 and n<=200) and array_position(paths,null) is null));
    create table backup_semantic.b(n integer, paths text[],
      constraint flat_check check (n>=1 and n<=200 and array_position(paths,null) is null));
    create sequence backup_semantic.seq;
    create function backup_semantic.f() returns integer language sql as 'select 1';`);
  const relation = async name => (await db.query(`select c.relname,${catalogAclSql.relations} as acl
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='backup_semantic' and c.relname=$1`, [name])).rows;
  const routine = async () => (await db.query(`select p.proname,${catalogAclSql.functions} as acl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='backup_semantic' and p.proname='f'`)).rows;
  const schema = async () => (await db.query(`select nspname,${catalogAclSql.schemas} as acl
    from pg_namespace where nspname='backup_semantic'`)).rows;
  const rejectsChange = (actual, expected, category = 'relations') =>
    assert.throws(() => assertCatalogMatches({ [category]: actual }, { [category]: expected }), /Catalog mismatch/);
  await t.test('NULL relation ACL equals explicit owner defaults, but every browser/server grant remains visible', async () => {
    const original = await relation('a');
    await db.exec('revoke all on backup_semantic.a from anon');
    const raw = (await db.query("select relacl from pg_class where oid='backup_semantic.a'::regclass")).rows[0];
    assert.notEqual(raw.relacl, null);
    assertCatalogMatches({ relations: await relation('a') }, { relations: original });
    for (const statement of ['grant select on backup_semantic.a to anon',
      'grant update on backup_semantic.a to authenticated', 'grant insert on backup_semantic.a to service_role',
      'grant select on backup_semantic.a to anon with grant option']) {
      await db.exec(statement); rejectsChange(await relation('a'), original);
      await db.exec('revoke all on backup_semantic.a from anon,authenticated,service_role');
      assertCatalogMatches({ relations: await relation('a') }, { relations: original });
    }
  });
  await t.test('sequence USAGE and schema USAGE grants are not collapsed into owner defaults', async () => {
    const seq = await relation('seq'), beforeSchema = await schema();
    await db.exec('grant usage on sequence backup_semantic.seq to authenticated');
    rejectsChange(await relation('seq'), seq);
    await db.exec('grant usage on schema backup_semantic to anon');
    rejectsChange(await schema(), beforeSchema, 'schemas');
  });
  await t.test('routine NULL default PUBLIC EXECUTE is not confused with revoked or service-only execution', async () => {
    const original = await routine();
    await db.exec('revoke execute on function backup_semantic.f() from public');
    const revoked = await routine(); rejectsChange(revoked, original, 'functions');
    await db.exec('grant execute on function backup_semantic.f() to service_role');
    rejectsChange(await routine(), revoked, 'functions');
    rejectsChange(await routine(), original, 'functions');
  });
  await t.test('PostgreSQL pretty deparse normalizes AND nesting without hiding bounds or OR changes', async () => {
    const definition = async name => (await db.query(`select pg_get_constraintdef(k.oid,true) as definition
      from pg_constraint k where k.conrelid=$1::regclass and k.contype='c'`, [name])).rows[0].definition;
    const expected = [{ definition: await definition('backup_semantic.a') }];
    assertCatalogMatches({ constraints: [{ definition: await definition('backup_semantic.b') }] }, { constraints: expected });
    await db.exec(`alter table backup_semantic.b drop constraint flat_check;
      alter table backup_semantic.b add constraint flat_check check (n>=1 and n<=199 and array_position(paths,null) is null)`);
    rejectsChange([{ definition: await definition('backup_semantic.b') }], expected, 'constraints');
    await db.exec(`alter table backup_semantic.b drop constraint flat_check;
      alter table backup_semantic.b add constraint flat_check check (n>=1 or n<=200 or array_position(paths,null) is null)`);
    rejectsChange([{ definition: await definition('backup_semantic.b') }], expected, 'constraints');
  });
});

test('backup guard accepts only the fresh native loopback database with exact owned data path', () => {
  assert.equal(identity.runId, runId); assert.equal(Object.isFrozen(identity), true);
  assert.equal(identity.directory, path.join(backupPaths.nativeRuns, runId));
  const invalid = [
    { database: 'postgres' }, { database: 'working_db' }, { user: 'service_role' },
    { host: 'localhost' }, { host: '::1' }, { host: 'database.example.invalid' },
    { host: '127.0.0.1; --dbname=working' }, { port: 80 }, { port: '54321' }, { port: 65536 },
    { version: '17.10' }, { data: path.join(backupPaths.cache, 'existing', 'data') },
    { data: path.join(backupPaths.nativeRuns, runId, 'other') }, { data: 'relative/data' },
    { data: path.join(backupPaths.nativeRuns, 'not-a-fresh-uuid', 'data') },
  ];
  for (const change of invalid) assert.throws(() => validateServerIdentity({ ...record, ...change }));
});

test('restore targets are two specific new DB names tied to this exact native run, never source or caller text', () => {
  for (const kind of ['restored', 'corrupt']) {
    const name = expectedTargetName(runId, kind);
    assert.equal(name, `medina_restore_${kind}_${runId.replaceAll('-', '')}`);
    const args = connectionArguments(identity, name, kind);
    assert.ok(args.includes(`--dbname=${name}`)); assert.ok(args.includes('--host=127.0.0.1'));
    validateConnection({ ...connection, database: name }, identity, name);
  }
  assert.ok(connectionArguments(identity, sourceDatabase).includes(`--dbname=${sourceDatabase}`));
  for (const value of ['postgres', 'working', sourceDatabase, 'postgresql://remote/db', 'medina_restore_restored_other']) {
    assert.throws(() => connectionArguments(identity, value, 'restored'));
  }
  assert.throws(() => expectedTargetName('../owned', 'restored'));
  assert.throws(() => expectedTargetName(runId, 'working'));
  assert.throws(() => connectionArguments(identity, expectedTargetName(runId), 'corrupt'));
  assert.throws(() => connectionArguments({ ...identity, host: 'remote.invalid' }, sourceDatabase));
});

test('driver credentials cannot escape to a different host, port, TLS context or DB', () => {
  validateConnection(connection, identity);
  for (const change of [{ host: 'localhost' }, { port: 54322 }, { user: 'other' }, { database: 'postgres' }, { ssl: true }]) {
    assert.throws(() => validateConnection({ ...connection, ...change }, identity));
  }
  assert.throws(() => validateConnection({ ...connection, database: 'working_db' }, identity, 'working_db'));
});

test('native utility environment discards all ambient connection URLs, keys, service and loader overrides', () => {
  const password = 'a'.repeat(64), directory = path.join(backupPaths.backupRuns, runId);
  const env = backupEnvironment(password, directory, { PATH: 'fixture-path', SystemRoot: 'windows',
    TEMP: 'temp', PGHOST: 'external', PGPORT: '5432', PGDATABASE: 'working', PGUSER: 'actual-user',
    PGPASSWORD: 'ambient-secret-must-never-be-used', PGSSLMODE: 'require', PGOPTIONS: 'unsafe',
    PGSERVICE: 'working', PGSERVICEFILE: 'real-service-file', PGPASSFILE: 'real-password-file',
    DATABASE_URL: 'external', SUPABASE_SERVICE_ROLE_KEY: 'real-key', NODE_OPTIONS: '--require real-loader' });
  assert.equal(env.PGPASSWORD, password); assert.equal(env.PGSSLMODE, 'disable');
  assert.equal(env.PGPASSFILE, path.join(directory, 'no-password-file'));
  assert.equal(env.PGSYSCONFDIR, directory); assert.equal(env.PGCONNECT_TIMEOUT, '3');
  assert.equal(env.PATH, 'fixture-path');
  for (const key of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGSERVICE', 'PGSERVICEFILE', 'DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NODE_OPTIONS']) {
    assert.equal(Object.hasOwn(env, key), false);
  }
  assert.throws(() => backupEnvironment('not-owned-credential', directory));
  assert.throws(() => backupEnvironment(password, 'relative'));
});

test('custom archive integrity gate rejects bad headers, empty/truncated/oversized data and payload mutation', () => {
  verifyArchiveBytes(bytes, digest(bytes));
  for (const value of [Buffer.alloc(0), bytes.subarray(0, 12), Buffer.from('SQL SELECT NOT AN ARCHIVE'.repeat(3)),
    Buffer.alloc(16 * 1024 * 1024 + 1), bytes.toString('utf8')]) {
    assert.throws(() => verifyArchiveBytes(value, digest(bytes)));
  }
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  assert.throws(() => verifyArchiveBytes(changed, digest(bytes)));
  assert.throws(() => verifyArchiveBytes(bytes, '0'.repeat(64)));
  assert.throws(() => verifyArchiveBytes(bytes, digest(bytes).toUpperCase()));
});

test('artifact names reject traversal, URLs, alternate data streams and unknown suffixes', () => {
  for (const value of ['synthetic.dump', 'synthetic.sha256', 'locked.dump', 'truncated.dump']) assert.equal(validateArtifactName(value), value);
  for (const value of ['../synthetic.dump', '..\\synthetic.dump', '/synthetic.dump', 'C:\\synthetic.dump',
    'synthetic.dump:stream', 'https://example.invalid/a.dump', 'a.sql', 'a.dump/extra', 'a.dump\\extra', 'a.DUMP', '']) {
    assert.throws(() => validateArtifactName(value));
  }
});

test('owned artifact cleanup needs unchanged identity and refuses directories/hardlinks before recursive remove', async () => {
  const owned = await createArchiveDirectory();
  const marker = path.join(owned.directory, 'fixture.json'), savedMarker = await readFile(marker);
  const filename = await owned.artifact('synthetic.dump');
  await writeFile(filename, bytes, { flag: 'wx' });
  const original = await lstat(filename);
  assert.equal(original.nlink, 1);
  await writeFile(marker, '{}');
  await assert.rejects(owned.close(), /ownership not confirmed/);
  assert.equal((await lstat(filename)).isFile(), true);
  await writeFile(marker, savedMarker);
  const linked = path.join(owned.directory, 'linked.dump');
  await link(filename, linked);
  await assert.rejects(owned.artifact('linked.dump'), /redirected/);
  await assert.rejects(owned.close(), /Unsafe backup cleanup child/);
  assert.equal((await lstat(filename)).isFile(), true);
  await rm(linked);
  const child = path.join(owned.directory, 'nested.dump'); await mkdir(child);
  await assert.rejects(owned.close(), /Unsafe backup cleanup child/);
  // The exact empty directory was created just above; no recursive unknown path.
  await rm(child, { recursive: false }).catch(async error => {
    if (error.code !== 'ERR_FS_EISDIR' && error.code !== 'EISDIR') throw error;
    const { rmdir } = await import('node:fs/promises'); await rmdir(child);
  });
  await owned.close();
  await assert.rejects(lstat(owned.directory), error => error.code === 'ENOENT');
});
