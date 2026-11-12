import assert from 'node:assert/strict';
import test from 'node:test';
import { containerArgs, dockerEnvironment, localDockerHosts, loopbackPort, ownedContainer } from './disposable-postgres.mjs';

const runId = '00000000-0000-4000-8000-000000000001';
const imageId = `sha256:${'a'.repeat(64)}`;

test('only local engines are considered, never an environment-selected context', () => {
  assert.deepEqual(localDockerHosts('win32'), ['npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine']);
  assert.deepEqual(localDockerHosts('linux'), ['unix:///var/run/docker.sock']);
  assert.deepEqual(dockerEnvironment({ PATH: 'path', SystemRoot: 'windows', TEMP: 'temp',
    DATABASE_URL: 'forbidden', PGHOST: 'forbidden', SUPABASE_SERVICE_ROLE_KEY: 'forbidden',
    DOCKER_HOST: 'tcp://remote.invalid', DOCKER_CONTEXT: 'production', NODE_OPTIONS: '--require forbidden' }),
    { PATH: 'path', SystemRoot: 'windows', TEMP: 'temp' });
});

test('fresh container is bounded, loopback-only, has no host mount and never pulls', () => {
  const args = containerArgs(runId, imageId);
  assert.equal(args[args.indexOf('--publish') + 1], '127.0.0.1::5432');
  assert.equal(args[args.indexOf('--tmpfs') + 1], '/var/lib/postgresql/data:rw,size=256m');
  for (const option of ['--pull=never', '--rm', '--memory', '--cpus', '--pids-limit']) assert.ok(args.includes(option));
  for (const option of ['--volume', '-v', '--mount', '--privileged', '--network=host']) assert.ok(!args.includes(option));
  assert.ok(args.includes(imageId));
  assert.ok(args.includes('POSTGRES_PASSWORD')); // Value is random and passed in child env, not CLI arguments.
  assert.ok(!args.some(value => value.startsWith('POSTGRES_PASSWORD=')));
  assert.throws(() => containerArgs('existing-production-container', imageId));
  assert.throws(() => containerArgs(runId, 'postgres:latest'));
});

test('wildcard, remote, invalid or multiple published addresses fail closed', () => {
  assert.equal(loopbackPort('127.0.0.1:54321\n'), 54321);
  for (const value of ['0.0.0.0:5432', '10.0.0.1:5432', '[::]:5432', '127.0.0.1:80',
    '127.0.0.1:65536', '127.0.0.1:5432\n0.0.0.0:5432', '5432']) assert.throws(() => loopbackPort(value));
});

test('cleanup requires both unique run label and exact container name', () => {
  const record = { Id: 'b'.repeat(64), Name: `/medina-pg-test-${runId}`, Config: { Labels: { 'medina.fixture.run': runId } } };
  assert.equal(ownedContainer(JSON.stringify(record), runId), record.Id);
  assert.equal(ownedContainer(JSON.stringify({ ...record, Name: '/existing-database' }), runId), null);
  assert.equal(ownedContainer(JSON.stringify({ ...record, Config: { Labels: {} } }), runId), null);
  assert.equal(ownedContainer(JSON.stringify({ ...record, Id: 'existing' }), runId), null);
});
