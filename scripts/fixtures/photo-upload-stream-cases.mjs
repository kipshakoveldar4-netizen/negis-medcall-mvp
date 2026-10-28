import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json', { paths: [path.join(root, 'artifacts/negis')] }))('esbuild');
export const sharp = require('sharp');
export const IMAGE_LIMIT = 10 * 1024 * 1024;
export const REQUEST_LIMIT = 101 * 1024 * 1024;
export const W = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const U = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const S = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const KEY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const BOUNDARY = 'owned-photo-stream-boundary';
export const TOKEN = 'owned.photo.stream';
const origin = 'https://photo-stream.fixture.invalid';
const secret = 'SYNTHETIC_PHOTO_STREAM_SECRET_NEVER_A_REAL_CREDENTIAL';
let compiled;

export function stopPhotoBuilds() { esbuild.stop(); }

async function compiledRoute() {
  compiled ??= esbuild.build({
    stdin: { contents: 'export {default as handler} from "./api/crm/[...path].ts";\n'
      + 'export {setSupabaseServerClientFactoryForTests as install} from "./lib/supabase/server.ts";',
    resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    target: 'node22', supported: { 'dynamic-import': false }, logLevel: 'silent',
  }).then(result => result.outputFiles[0].text);
  return compiled;
}

export async function bounded(promise, label, ms = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Owned photo fixture timed out: ' + label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Owned photo fixture did not settle: ' + label);
    await delay(10);
  }
}

// The compilation/VM isolation follows crm-body-budget.test.mjs. Auth, RPC and
// Storage below are doubles, not evidence about SQL/RLS or a deployed gateway.
export async function photoFixture(t) {
  const state = { auth: [], queries: [], rpcs: [], storage: [], publicGets: [], unexpected: [],
    errors: [], transportErrors: [], requests: [], operations: new Map(), assets: new Map(), published: new Map() };
  const member = { id: S, workspace_id: W, auth_user_id: U, role: 'owner', status: 'active' };
  const sdk = {
    from(table) {
      state.queries.push({ table });
      assert.ok(['staff_users', 'workspace_settings', 'creative_upload_operations'].includes(table),
        'No direct business-table mutation or unmodeled read');
      const filters = [], q = {};
      const result = single => {
        let rows = table === 'staff_users' ? [member] : table === 'creative_upload_operations' ? [...state.operations.values()] : [];
        rows = rows.filter(row => filters.every(([kind, key, value]) => kind === 'in' ? value.includes(row[key]) : row[key] === value));
        return { data: single ? rows[0] ?? null : rows, error: null };
      };
      Object.assign(q, { select() { return q; },
        eq(key, value) { filters.push(['eq', key, value]); return q; },
        in(key, value) { filters.push(['in', key, value]); return q; },
        maybeSingle() { return Promise.resolve(result(true)); },
        then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject); } });
      return q;
    },
    async rpc(name, args) {
      state.rpcs.push({ name, args: structuredClone(args) });
      assert.equal(args.p_workspace_id, W); assert.equal(args.p_staff_user_id, S); assert.equal(args.p_auth_user_id, U);
      if (name === 'reserve_creative_upload') {
        assert.equal(args.p_source, 'inline'); assert.equal(args.p_request_key, KEY);
        assert.equal(args.p_mime_type, 'image/jpeg');
        assert.ok(args.p_file_size > 0 && args.p_file_size <= IMAGE_LIMIT);
        const at = Date.now(), op = { id: randomUUID(), workspace_id: W, auth_user_id: U, staff_user_id: S,
          file_name: args.p_file_name, mime_type: args.p_mime_type, file_size: args.p_file_size,
          source: 'inline', issued_at: at, expires_at: at + 7200000, status: 'reserved' };
        state.operations.set(op.id, op);
        return { data: { requestKey: KEY, status: op.status, ticket: { v: 1, id: op.id,
          workspaceId: W, userId: U, staffUserId: S, fileName: op.file_name, mimeType: op.mime_type,
          fileSize: op.file_size, issuedAt: at, expiresAt: op.expires_at } }, error: null };
      }
      assert.equal(name, 'finalize_creative_image_upload', 'No other RPC is part of a valid inline upload');
      const op = state.operations.get(args.p_operation_id); assert.ok(op); assert.equal(op.status, 'reserved');
      const result = args.p_result;
      assert.ok(state.published.has(result.storage_path));
      const asset = { ...result, id: op.id, workspace_id: W, status: 'uploaded', verified_upload_key: op.id,
        verified_upload_actor_id: U, verified_upload_sha256: result.sha256, metadata: { uploadMode: 'verified-staged' } };
      state.assets.set(op.id, asset); op.status = 'finalized'; op.result = structuredClone(result);
      return { data: { operationId: op.id, status: 'finalized', replayed: false, asset }, error: null };
    },
    storage: {
      from(bucket) {
        state.storage.push({ op: 'from', bucket }); assert.equal(bucket, 'ad-creatives');
        return { async upload(key, bytes, options) {
          state.storage.push({ op: 'upload', bucket, key, options: structuredClone(options) });
          assert.deepEqual({ ...options }, { contentType: 'image/jpeg', upsert: false });
          assert.ok(key.startsWith(W + '/verified/')); assert.equal(state.published.has(key), false);
          state.published.set(key, Buffer.from(bytes)); return { data: { path: key }, error: null };
        } };
      },
    },
  };
  const env = { NODE_ENV: 'test', SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: secret };
  const processView = Object.create(process); Object.defineProperty(processView, 'env', { value: env });
  const module = { exports: {} };
  const syntheticFetch = async (input, options) => {
    const url = String(input), headers = new Headers(options?.headers);
    assert.equal(options?.method, 'GET'); assert.equal(options?.redirect, 'error');
    if (url === origin + '/auth/v1/user') {
      state.auth.push(headers.get('authorization')); assert.equal(headers.get('apikey'), secret);
      const valid = headers.get('authorization') === 'Bearer ' + TOKEN;
      return new Response(JSON.stringify(valid ? { id: U } : {}), { status: valid ? 200 : 401 });
    }
    const prefix = origin + '/storage/v1/object/public/ad-creatives/';
    if (url.startsWith(prefix)) {
      state.publicGets.push(url); assert.equal(headers.get('authorization'), null);
      const bytes = state.published.get(url.slice(prefix.length));
      return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404,
        headers: { 'content-type': 'image/jpeg', ...(bytes ? { 'content-length': String(bytes.length) } : {}) } });
    }
    state.unexpected.push(url); throw Error('Non-fixture fetch forbidden');
  };
  new Script(await compiledRoute(), { filename: path.join(root, 'owned-photo-stream.cjs') }).runInNewContext({
    module, exports: module.exports, require, process: processView, fetch: syntheticFetch,
    Buffer, URL, URLSearchParams, AbortController, AbortSignal, DOMException, TextEncoder, TextDecoder,
    Request, Response, Headers, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval,
    console, __dirname: root, __filename: path.join(root, 'owned-photo-stream.cjs'),
  });
  module.exports.install(() => sdk);
  const active = new Set(), sockets = new Set(), clients = new Set();
  const server = createServer((req, out) => {
    const seen = { req, out, headers: { ...req.headers }, headerBytes: req.socket.bytesRead, settled: false, aborted: false };
    state.requests.push(seen);
    req.on('aborted', () => { seen.aborted = true; });
    req.on('error', error => state.transportErrors.push(error.code));
    const url = new URL(req.url, 'http://127.0.0.1');
    req.query = { ...Object.fromEntries(url.searchParams), path: url.pathname.slice('/api/crm/'.length).split('/') };
    const res = {
      status(code) { out.statusCode = code; return res; },
      setHeader(key, value) { out.setHeader(key, value); return res; },
      json(body) {
        seen.reply = { status: out.statusCode, destroyed: req.destroyed, complete: req.complete };
        if (!out.destroyed) { out.setHeader('content-type', 'application/json'); out.end(JSON.stringify(body)); }
        return res;
      },
      end(body) { if (!out.destroyed) out.end(body); return res; },
    };
    const task = Promise.resolve().then(() => module.exports.handler(req, res)).catch(error => {
      state.errors.push(String(error));
      if (!out.destroyed) { out.statusCode = 500; out.end('{}'); }
    }).finally(() => { seen.settled = true; active.delete(task); });
    active.add(task);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await bounded(new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  }), 'loopback listen');
  let closed = false;
  const fixture = { state, port: server.address().port, clients,
    async consumed(upload) {
      await until(() => state.requests.length === 1 && state.auth.length === 1, 'native request/auth');
      const seen = state.requests[0];
      await until(() => seen.req.socket.bytesRead >= seen.headerBytes + upload.sentBytes
        && seen.req.readableLength === 0, 'written chunks consumed without HTTP EOF');
      assert.equal(seen.req.complete, false); assert.equal(seen.settled, false);
    },
    async settled() { await until(() => state.requests.length === 1 && state.requests[0].settled, 'handler completion'); },
    async close() {
      if (closed) return; closed = true;
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const client of clients) client.destroy();
      for (const socket of sockets) socket.destroy();
      try { await bounded(Promise.all([stopped, ...active]), 'owned server and handlers close'); }
      finally { module.exports.install(null); }
      assert.deepEqual(state.errors, [], 'No uncaught adapter failures');
      assert.deepEqual(state.unexpected, [], 'No provider, real Storage, or other network request');
    },
  };
  t.after(() => fixture.close());
  return fixture;
}

export function openUpload(f, { contentType = `multipart/form-data; boundary=${BOUNDARY}`, length, token = TOKEN } = {}) {
  let complete;
  const result = new Promise(resolve => { complete = resolve; });
  const headers = { 'content-type': contentType, connection: 'close', ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(length === undefined ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(length) }) };
  const req = request({ host: '127.0.0.1', port: f.port, path: '/api/crm/ad-creative-upload?workspaceId=' + W,
    method: 'POST', agent: false, headers, timeout: 15000 }, res => {
    if (!req.writableEnded) req.end();
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('error', error => complete({ error }));
    res.on('end', () => {
      try { complete({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
      catch (error) { complete({ error }); }
    });
  });
  f.clients.add(req); req.on('close', () => f.clients.delete(req));
  req.on('error', error => complete({ error }));
  req.on('timeout', () => req.destroy(Error('Owned photo client timed out')));
  req.setNoDelay(true); req.flushHeaders();
  return { req, result, sentBytes: 0, writes: 0,
    async write(bytes) {
      this.sentBytes += bytes.length; this.writes++;
      await bounded(new Promise((resolve, reject) => req.write(bytes, error => error ? reject(error) : resolve())), 'chunk write');
    },
    end() { req.end(); },
    abort() { req.destroy(Error('Owned photo upload intentionally interrupted')); },
  };
}

export function multipart(jpeg, { fields = [['requestKey', KEY]], tail = `\r\n--${BOUNDARY}--\r\n` } = {}) {
  const fieldParts = fields.map(([name, value]) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('');
  const head = Buffer.from(fieldParts + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="owned.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
  return { head, jpeg, tail: Buffer.from(tail), body: Buffer.concat([head, jpeg, Buffer.from(tail)]) };
}

export async function sendChunks(upload, bytes, size = 64 * 1024) {
  for (let at = 0; at < bytes.length; at += size) await upload.write(bytes.subarray(at, at + size));
}

// Real JPEG COM segments reach the exact byte limit without increasing pixels.
export function paddedJpeg(jpeg, size) {
  assert.equal(jpeg.readUInt16BE(0), 0xffd8); assert.ok(size >= jpeg.length + 4);
  const parts = [jpeg.subarray(0, 2)]; let left = size - jpeg.length;
  while (left) {
    let length = Math.min(left, 65537);
    if (left > length && left - length < 4) length -= 4;
    const segment = Buffer.alloc(length, 65); segment.writeUInt16BE(0xfffe); segment.writeUInt16BE(length - 2, 2);
    parts.push(segment); left -= length;
  }
  parts.push(jpeg.subarray(2)); return Buffer.concat(parts, size);
}

export function noUploadEffects(f) {
  assert.deepEqual(f.state.rpcs, [], 'No operation reservation, rejection or creative finalization');
  assert.deepEqual(f.state.storage, [], 'No synthetic Storage call, including reads/signatures');
  assert.deepEqual(f.state.publicGets, []); assert.deepEqual(f.state.unexpected, []);
  assert.equal(f.state.operations.size, 0); assert.equal(f.state.assets.size, 0); assert.equal(f.state.published.size, 0);
  assert.ok(f.state.queries.every(query => ['staff_users', 'workspace_settings'].includes(query.table)), 'Authorization reads only');
}

export function refused(result, status) {
  assert.equal(result.error, undefined, 'A live client must receive the controlled HTTP refusal, not a reset');
  assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.success, false);
  assert.doesNotMatch(JSON.stringify(result.body), /SYNTHETIC_PHOTO_STREAM_SECRET|fixture\.invalid|owned\.photo\.stream/);
}
