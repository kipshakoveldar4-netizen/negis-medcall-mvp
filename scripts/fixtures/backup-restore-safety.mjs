import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { nativeEnvironment, nativeRunDirectory, ownedNativeServer } from './native-postgres.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const backupPaths = Object.freeze({
  cache: path.join(repo, 'node_modules/.cache'),
  runtime: path.join(repo, 'node_modules/.cache/native-postgres-17.11-3/pgsql/bin'),
  nativeRuns: path.join(repo, 'node_modules/.cache/medina-pg-runs'),
  backupRuns: path.join(repo, 'node_modules/.cache/medina-backup-runs'),
});
export const sourceDatabase = 'medina_disposable_test';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const targetPrefix = 'medina_restore_';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// NULL ACL means PostgreSQL's object-specific defaults, not an empty grant set.
// Keep every principal, privilege and grant option from explicit ACL entries.
export const catalogAclSql = Object.freeze({
  schemas: "array(select a::text from unnest(coalesce(nspacl,acldefault('n',nspowner))) a order by a::text)",
  relations: `array(select x::text from unnest(coalesce(c.relacl,
    acldefault(case when c.relkind='S' then 'S'::"char" else 'r'::"char" end,c.relowner))) x order by x::text)`,
  functions: "array(select x::text from unnest(coalesce(p.proacl,acldefault('f',p.proowner))) x order by x::text)",
});

export function assertCatalogMatches(actual, expected) {
  const categories = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const category of categories) {
    const a = actual[category], e = expected[category];
    if (isDeepStrictEqual(a, e)) continue;
    const index = Array.isArray(a) && Array.isArray(e)
      ? Array.from({ length: Math.max(a.length, e.length) }, (_, i) => i)
        .find(i => !isDeepStrictEqual(a[i], e[i])) : null;
    const left = index === null ? a : a[index], right = index === null ? e : e[index];
    const fields = left && right && typeof left === 'object' && typeof right === 'object'
      ? [...new Set([...Object.keys(left), ...Object.keys(right)])]
        .filter(key => !isDeepStrictEqual(left[key], right[key])).sort().join(',').slice(0, 120) : 'presence/type';
    // A failed full pg_get_functiondef snapshot must not dump megabytes of SQL.
    const fingerprint = value => digest(JSON.stringify(value) ?? 'undefined').slice(0, 16);
    throw new Error(`Catalog mismatch ${category.slice(0, 64)} entry ${index ?? '-'}; fields ${fields};`
      + ` expected ${fingerprint(right)}, actual ${fingerprint(left)};`
      + ` counts ${Array.isArray(e) ? e.length : '-'} -> ${Array.isArray(a) ? a.length : '-'}`);
  }
}

export function expectedTargetName(runId, kind = 'restored') {
  if (!uuid.test(runId) || !['restored', 'corrupt'].includes(kind)) throw new Error('Invalid owned restore identity');
  return `${targetPrefix}${kind}_${runId.replaceAll('-', '')}`;
}

export function validateServerIdentity(record, paths = backupPaths) {
  if (record?.database !== sourceDatabase || record?.user !== 'postgres'
    || record?.host !== '127.0.0.1' || !Number.isInteger(record?.port)
    || record.port < 1024 || record.port > 65535 || record?.version !== '17.11'
    || typeof record?.data !== 'string' || !path.isAbsolute(record.data)) {
    throw new Error('Not the fresh pinned loopback fixture');
  }
  const data = path.resolve(record.data);
  const directory = path.dirname(data), runId = path.basename(directory);
  if (!uuid.test(runId) || directory !== nativeRunDirectory(paths.nativeRuns, runId)
    || data !== path.join(directory, 'data')) throw new Error('Not an owned native data path');
  return Object.freeze({ ...record, data, runId, directory });
}

export function validateConnection(parameters, identity, database = sourceDatabase) {
  validateServerIdentity(identity);
  if (![sourceDatabase, expectedTargetName(identity.runId, 'restored'), expectedTargetName(identity.runId, 'corrupt')].includes(database)) {
    throw new Error('Unowned connection database');
  }
  if (parameters?.host !== identity.host || Number(parameters?.port) !== identity.port
    || parameters?.database !== database || parameters?.user !== identity.user
    || parameters?.ssl !== false) throw new Error('Connection escaped the owned fixture');
}

export function validateArtifactName(name) {
  if (!/^[a-z][a-z0-9-]{0,60}\.(dump|sha256)$/.test(name)) throw new Error('Invalid owned archive name');
  return name;
}

export function connectionArguments(identity, database, target = null) {
  validateServerIdentity(identity);
  if (identity?.host !== '127.0.0.1' || identity?.database !== sourceDatabase
    || identity?.user !== 'postgres' || !Number.isInteger(identity?.port)
    || identity.port < 1024 || identity.port > 65535) throw new Error('Invalid dump connection identity');
  if (database !== sourceDatabase && database !== expectedTargetName(identity.runId, target)) {
    throw new Error('Restore target is not this run\'s database');
  }
  if (database === sourceDatabase && target !== null) throw new Error('Source cannot be a restore target');
  return ['--no-password', '--host=127.0.0.1', `--port=${identity.port}`, '--username=postgres', `--dbname=${database}`];
}

// The only credential is generated by startNativePostgres in this process. No
// URL, password file, service, ambient PG* option, or user config is consulted.
export function backupEnvironment(password, directory, source = process.env) {
  if (typeof password !== 'string' || !/^[a-f0-9]{64}$/.test(password)
    || !path.isAbsolute(directory)) throw new Error('Invalid private fixture connection');
  return { ...nativeEnvironment(source), PGPASSWORD: password, PGSSLMODE: 'disable',
    PGGSSENCMODE: 'disable', PGCONNECT_TIMEOUT: '3', PGCLIENTENCODING: 'UTF8',
    PGPASSFILE: path.join(directory, 'no-password-file'), PGSYSCONFDIR: directory,
    PGAPPNAME: 'medina_owned_backup_restore',
    PGOPTIONS: '-c statement_timeout=30000 -c idle_in_transaction_session_timeout=20000' };
}

export async function attestServerFiles(identity, paths = backupPaths) {
  validateServerIdentity(identity, paths);
  for (const entry of [paths.cache, paths.nativeRuns, paths.runtime, identity.directory, identity.data]) {
    if (await realpath(entry) !== entry || (await lstat(entry)).isSymbolicLink()) {
      throw new Error('Owned PostgreSQL path redirected');
    }
  }
  const markerPath = path.join(identity.directory, 'fixture.json');
  if (!(await lstat(markerPath)).isFile() || (await lstat(markerPath)).nlink !== 1) throw new Error('Fixture marker redirected');
  const pidPath = path.join(identity.data, 'postmaster.pid');
  if (!(await lstat(pidPath)).isFile() || (await lstat(pidPath)).nlink !== 1) throw new Error('Fixture PID redirected');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (Object.keys(marker).sort().join(',') !== 'data,port,runId'
    || marker.runId !== identity.runId || marker.data !== identity.data || marker.port !== identity.port
    || !ownedNativeServer(await readFile(pidPath, 'utf8'), identity.data, identity.port)) {
    throw new Error('Owned PostgreSQL marker or server PID mismatch');
  }
}

export async function createArchiveDirectory(paths = backupPaths) {
  if (await realpath(paths.cache) !== paths.cache) throw new Error('Backup cache redirected');
  await mkdir(paths.backupRuns, { recursive: true });
  if (await realpath(paths.backupRuns) !== paths.backupRuns || (await lstat(paths.backupRuns)).isSymbolicLink()) {
    throw new Error('Backup root redirected');
  }
  const runId = randomUUID(), directory = nativeRunDirectory(paths.backupRuns, runId);
  await mkdir(directory);
  const identity = JSON.stringify({ kind: 'medina-synthetic-backup', runId, directory });
  await writeFile(path.join(directory, 'fixture.json'), identity, { flag: 'wx', mode: 0o600 });
  const attest = async () => {
    if (directory !== nativeRunDirectory(paths.backupRuns, runId) || await realpath(directory) !== directory
      || await realpath(paths.backupRuns) !== paths.backupRuns
      || !(await lstat(path.join(directory, 'fixture.json'))).isFile()
      || (await lstat(path.join(directory, 'fixture.json'))).nlink !== 1
      || await readFile(path.join(directory, 'fixture.json'), 'utf8') !== identity) {
      throw new Error('Backup directory ownership not confirmed');
    }
  };
  const artifact = async name => {
    await attest();
    const filename = path.join(directory, validateArtifactName(name));
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.nlink !== 1 || await realpath(filename) !== filename) throw new Error('Archive path redirected');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return filename;
  };
  return { runId, directory, attest, artifact, async close() {
    await attest();
    // No arbitrary children or junctions may be hidden under recursive cleanup.
    for (const entry of await readdir(directory)) {
      if (entry !== 'fixture.json') validateArtifactName(entry);
      const filename = path.join(directory, entry);
      const info = await lstat(filename);
      if (!info.isFile() || info.nlink !== 1 || await realpath(filename) !== filename) {
        throw new Error('Unsafe backup cleanup child');
      }
    }
    await attest();
    await rm(directory, { recursive: true });
  } };
}

export function verifyArchiveBytes(bytes, expectedHash) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > 16 * 1024 * 1024
    || bytes.subarray(0, 5).toString('ascii') !== 'PGDMP'
    || !/^[a-f0-9]{64}$/.test(expectedHash) || digest(bytes) !== expectedHash) {
    throw new Error('Owned custom archive integrity check failed');
  }
}
