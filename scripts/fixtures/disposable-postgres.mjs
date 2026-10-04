import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const exec = promisify(execFile);
const image = 'postgres:17-alpine';
const label = 'medina.fixture.run';
const database = 'medina_disposable_test';

export function localDockerHosts(platform = process.platform) {
  return platform === 'win32'
    ? ['npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine']
    : ['unix:///var/run/docker.sock'];
}

export function dockerEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    /^(path|systemroot|windir|temp|tmp|home|userprofile)$/i.test(key)));
}

export function containerArgs(runId, imageId) {
  if (!/^[a-f0-9-]{36}$/.test(runId) || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error('Invalid disposable container identity');
  }
  return ['run', '--detach', '--pull=never', '--rm', '--name', `medina-pg-test-${runId}`,
    '--label', `${label}=${runId}`, '--publish', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data:rw,size=256m', '--memory', '512m', '--cpus', '1',
    '--pids-limit', '128', '--env', 'POSTGRES_PASSWORD', '--env', `POSTGRES_DB=${database}`,
    imageId, 'postgres', '-c', 'listen_addresses=*', '-c', 'statement_timeout=10000',
    '-c', 'idle_in_transaction_session_timeout=20000'];
}

export function loopbackPort(output) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(output.trim());
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Disposable PostgreSQL must bind only one loopback port');
  }
  return port;
}

export function ownedContainer(output, runId) {
  const record = JSON.parse(output);
  return record?.Config?.Labels?.[label] === runId
    && record?.Name === `/medina-pg-test-${runId}`
    && typeof record?.Id === 'string' && /^[a-f0-9]{64}$/.test(record.Id)
    ? record.Id : null;
}

// No connection URL, Docker context override, host mounts or existing database
// are accepted. Only this invocation's fresh, labelled container may be removed.
export async function startDisposablePostgres() {
  const env = dockerEnvironment();
  let host;
  for (const candidate of localDockerHosts()) {
    try {
      const { stdout } = await exec('docker', ['--host', candidate, 'info', '--format', '{{.OSType}}'],
        { env, timeout: 5000, windowsHide: true });
      if (stdout.trim() === 'linux') { host = candidate; break; }
    } catch { /* Never fall back to the current context or a remote engine. */ }
  }
  if (!host) throw new Error('Local Linux Docker engine is unavailable. No database was contacted. Start Docker Desktop explicitly, then retry.');
  const run = async (args, extraEnv = {}) => (await exec('docker', ['--host', host, ...args],
    { env: { ...env, ...extraEnv }, timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout.trim();
  let imageId;
  try { imageId = await run(['image', 'inspect', '--format', '{{.Id}}', image]); }
  catch { throw new Error(`Local ${image} image is missing. This test never downloads images automatically.`); }
  const runId = randomUUID();
  const name = `medina-pg-test-${runId}`;
  const password = randomBytes(32).toString('hex');
  const sessions = new Set();
  let closePromise;
  const close = () => closePromise ??= (async () => {
    let cleanupError;
    // Remove the owned server first so blocked clients are disconnected too.
    try {
      let output;
      try { output = await run(['inspect', '--format', '{{json .}}', name]); }
      catch { throw new Error('Cannot confirm disposable container cleanup; inspect its fixture label locally.'); }
      const id = ownedContainer(output, runId);
      if (!id) throw new Error('Refusing to remove a container without this test run identity');
      await run(['rm', '--force', '--volumes', id]);
    } catch (error) { cleanupError = error; }
    for (const client of sessions) await client.end().catch(() => {});
    if (cleanupError) throw cleanupError;
  })();
  try {
    await run(containerArgs(runId, imageId), { POSTGRES_PASSWORD: password });
    const port = loopbackPort(await run(['port', name, '5432/tcp']));
    const connect = async () => {
      const client = new pg.Client({ host: '127.0.0.1', port, database, user: 'postgres', password,
        ssl: false, application_name: 'medina_disposable_test', connectionTimeoutMillis: 1500,
        query_timeout: 15000, options: '-c statement_timeout=10000 -c idle_in_transaction_session_timeout=20000' });
      client.on('error', () => {}); // Container teardown may disconnect idle sessions.
      try { await client.connect(); } catch (error) { await client.end().catch(() => {}); throw error; }
      sessions.add(client);
      return client;
    };
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { const client = await connect(); await client.end(); sessions.delete(client); ready = true; break; }
      catch { await delay(250); }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
    return { connect, close };
  } catch {
    await close();
    throw new Error('Disposable PostgreSQL startup failed; no external database fallback was attempted.');
  }
}
