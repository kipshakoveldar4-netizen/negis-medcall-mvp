import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cache = path.join(repo, 'node_modules/.cache');
const runtime = path.join(cache, 'native-postgres-17.11-3/pgsql/bin');
const runs = path.join(cache, 'medina-pg-runs');
const database = 'medina_disposable_test';

export function nativeEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    /^(path|systemroot|windir|temp|tmp|home|userprofile)$/i.test(key)));
}

export function nativeRunDirectory(root, runId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId)) {
    throw new Error('Invalid native PostgreSQL fixture identity');
  }
  return path.join(path.resolve(root), runId);
}

export function nativeServerOptions(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
  return `-h 127.0.0.1 -p ${port} -c unix_socket_directories= -c max_connections=12`
    + ' -c shared_buffers=32MB -c work_mem=4MB -c maintenance_work_mem=32MB'
    + ' -c statement_timeout=10000 -c idle_in_transaction_session_timeout=20000';
}

export function ownedNativeServer(pidFile, data, port) {
  const lines = pidFile.trim().split(/\r?\n/);
  return /^[1-9]\d*$/.test(lines[0] ?? '') && path.resolve(lines[1] ?? '') === path.resolve(data)
    && lines[3] === String(port) && lines[5] === '127.0.0.1';
}

export function nativePid(pidFile, data) {
  const lines = pidFile.trim().split(/\r?\n/);
  return /^-?[1-9]\d*$/.test(lines[0] ?? '') && path.resolve(lines[1] ?? '') === path.resolve(data)
    ? Math.abs(Number(lines[0])) : null;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function optionalFile(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function cleanupNativeStartup(readLog, close) {
  let startupLog = null;
  try { startupLog = await readLog(); }
  catch { /* Diagnostic failures must not bypass owned-server cleanup. */ }
  await close();
  return startupLog;
}

// Explicit opt-in only. No installation, URL, existing cluster, environment-selected
// binary or service is accepted. The archive is provisioned/verified separately.
export async function startNativePostgres() {
  if (process.platform !== 'win32') throw new Error('The pinned native fixture is Windows-only');
  if (await realpath(runtime) !== runtime || await realpath(cache) !== cache) {
    throw new Error('Native fixture paths must not redirect outside the repository cache');
  }
  const env = nativeEnvironment();
  const run = async (binary, args, timeout = 60000) => (await exec(path.join(runtime, `${binary}.exe`), args,
    { env, timeout, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (!/^postgres \(PostgreSQL\) 17\.11$/.test(await run('postgres', ['--version']))) {
    throw new Error('The native fixture requires the verified PostgreSQL 17.11 archive');
  }
  await mkdir(runs, { recursive: true });
  if (await realpath(runs) !== runs) throw new Error('Native fixture root must not be a link');
  const runId = randomUUID();
  const directory = nativeRunDirectory(runs, runId);
  await mkdir(directory); // Never reuse an existing directory.
  const data = path.join(directory, 'data');
  const marker = path.join(directory, 'fixture.json');
  const passwordFile = path.join(directory, 'bootstrap-password');
  const port = await freeLoopbackPort();
  const identity = JSON.stringify({ runId, data, port });
  await writeFile(marker, identity, { flag: 'wx', mode: 0o600 });
  const password = randomBytes(32).toString('hex');
  const sessions = new Set();
  let closePromise;
  const close = () => closePromise ??= (async () => {
    try {
      if (directory !== nativeRunDirectory(runs, runId) || await realpath(directory) !== directory
        || await readFile(marker, 'utf8') !== identity) {
        throw new Error('Refusing cleanup without this native fixture identity');
      }
      const pid = await optionalFile(path.join(data, 'postmaster.pid'));
      if (pid !== null) {
        if (ownedNativeServer(pid, data, port)) {
          await run('pg_ctl', ['stop', '-D', data, '-m', 'immediate', '-w', '-t', '20']);
          if (await optionalFile(path.join(data, 'postmaster.pid')) !== null) throw new Error('Fixture server did not stop');
        } else {
          // initdb uses a negative bootstrap PID without a listening server.
          // Never signal it or delete its files while that process is alive.
          const bootstrapPid = nativePid(pid, data);
          if (bootstrapPid === null || processAlive(bootstrapPid)) throw new Error('Refusing to stop an unowned PostgreSQL server');
        }
      }
      for (const client of sessions) await client.end().catch(() => {});
      // Final resolved target and identity checks precede recursive removal.
      if (await realpath(directory) !== nativeRunDirectory(runs, runId)
        || await readFile(marker, 'utf8') !== identity) throw new Error('Unsafe native fixture cleanup target');
      // Windows may retain a stopped backend's file handles briefly.
      await rm(directory, { recursive: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      for (const client of sessions) await client.end().catch(() => {});
    }
  })();
  try {
    await writeFile(passwordFile, `${password}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await run('initdb', ['-D', data, '--username=postgres', '--auth=scram-sha-256',
        `--pwfile=${passwordFile}`, '--encoding=UTF8', '--locale=C', '--no-instructions'], 150000);
    } finally { await rm(passwordFile, { force: true }); }
    await run('pg_ctl', ['start', '-D', data, '-l', path.join(directory, 'server.log'), '-w', '-t', '20',
      '-o', nativeServerOptions(port)]);
    if (!ownedNativeServer(await readFile(path.join(data, 'postmaster.pid'), 'utf8'), data, port)) {
      throw new Error('Native fixture server identity mismatch');
    }
    const connect = async (db = database) => {
      const client = new pg.Client({ host: '127.0.0.1', port, database: db, user: 'postgres', password,
        ssl: false, application_name: 'medina_disposable_test', connectionTimeoutMillis: 1500,
        query_timeout: 15000, options: '-c statement_timeout=10000 -c idle_in_transaction_session_timeout=20000' });
      client.on('error', () => {});
      try {
        await client.connect();
        const { rows: [settings] } = await client.query("select current_setting('data_directory') as data,"
          + " current_setting('listen_addresses') as host, current_setting('port') as port");
        if (path.resolve(settings.data) !== data || settings.host !== '127.0.0.1' || settings.port !== String(port)) {
          throw new Error('Connected server is not this disposable fixture');
        }
      } catch (error) { await client.end().catch(() => {}); throw error; }
      sessions.add(client);
      return client;
    };
    const setup = await connect('postgres');
    await setup.query(`create database ${database}`);
    await setup.end(); sessions.delete(setup);
    return { connect: () => connect(), close };
  } catch (error) {
    const startupLog = await cleanupNativeStartup(() => optionalFile(path.join(directory, 'server.log')), close);
    throw new Error('Native PostgreSQL fixture failed; no external database was contacted.'
      + (startupLog ? ` Startup log: ${startupLog.slice(0, 2000)}` : ''), { cause: error });
  }
}
