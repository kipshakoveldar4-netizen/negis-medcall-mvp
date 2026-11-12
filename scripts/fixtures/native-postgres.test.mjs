import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { cleanupNativeStartup, nativeEnvironment, nativePid, nativeRunDirectory, nativeServerOptions, ownedNativeServer } from './native-postgres.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const root = path.resolve('fixture-cache');
const data = path.join(root, id, 'data');
const pid = `123\n${data}\n1234567890\n54321\n\n127.0.0.1\n0 0\nready\n`;

test('native child ignores database, credential, loader and external context variables', () => {
  assert.deepEqual(nativeEnvironment({ PATH: 'path', SystemRoot: 'windows', TEMP: 'temp',
    DATABASE_URL: 'forbidden', PGHOST: 'remote', PGPORT: '5432', PGDATA: 'existing',
    PGSERVICEFILE: 'existing', PGPASSWORD: 'forbidden', PGOPTIONS: 'forbidden',
    SUPABASE_SERVICE_ROLE_KEY: 'forbidden', NODE_OPTIONS: '--require forbidden',
    MEDINA_TEST_POSTGRES_NATIVE: '1' }), { PATH: 'path', SystemRoot: 'windows', TEMP: 'temp' });
});

test('native fixture directory accepts only a fresh UUID child of its fixed root', () => {
  assert.equal(nativeRunDirectory(root, id), path.join(root, id));
  for (const invalid of ['', '..', '../existing', 'existing', `../${id}`, path.join(root, id)]) {
    assert.throws(() => nativeRunDirectory(root, invalid));
  }
});

test('native fixture server is loopback-only, connection-limited and timeout-bounded', () => {
  const options = nativeServerOptions(54321);
  assert.match(options, /-h 127\.0\.0\.1 -p 54321/);
  for (const setting of ['unix_socket_directories= ', 'max_connections=12', 'shared_buffers=32MB',
    'statement_timeout=10000', 'idle_in_transaction_session_timeout=20000']) assert.ok(options.includes(setting));
  for (const invalid of [0, 80, 65536, 5432.5, '5432', '5432 -h 0.0.0.0']) assert.throws(() => nativeServerOptions(invalid));
});

test('native stop requires exact data directory, PID, port and loopback binding', () => {
  assert.equal(ownedNativeServer(pid, data, 54321), true);
  for (const invalid of [pid.replace('123\n', '0\n'), pid.replace(data, root),
    pid.replace('54321', '54322'), pid.replace('127.0.0.1', '*'), '', '123']) {
    assert.equal(ownedNativeServer(invalid, data, 54321), false);
  }
  assert.equal(ownedNativeServer(pid, path.join(root, 'existing'), 54321), false);
});

test('bootstrap PID parsing never authorizes stopping a non-listening server', () => {
  const bootstrap = `-123\n${data}\n1234567890\n5432\n\n\n`;
  assert.equal(nativePid(bootstrap, data), 123);
  assert.equal(ownedNativeServer(bootstrap, data, 5432), false);
  assert.equal(nativePid(pid.replace(data, root), data), null);
  assert.equal(nativePid('invalid', data), null);
});

test('startup log failure cannot skip cleanup and cleanup failures remain visible', async () => {
  let cleaned = 0;
  assert.equal(await cleanupNativeStartup(async () => { throw new Error('unreadable diagnostic log'); },
    async () => { cleaned++; }), null);
  assert.equal(cleaned, 1);
  assert.equal(await cleanupNativeStartup(async () => 'fixture log', async () => { cleaned++; }), 'fixture log');
  assert.equal(cleaned, 2);
  await assert.rejects(cleanupNativeStartup(async () => { throw new Error('unreadable diagnostic log'); },
    async () => { throw new Error('cleanup not confirmed'); }), /cleanup not confirmed/);
});
