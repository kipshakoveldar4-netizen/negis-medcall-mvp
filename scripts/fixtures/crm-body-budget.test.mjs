import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json', { paths: [path.join(root, 'artifacts/negis')] }))('esbuild');
const routerFile = path.join(root, 'api/crm/[...path].ts');
const source = await readFile(routerFile, 'utf8');
const code = (await esbuild.build({ stdin: { contents: source + '\nexport {ensureParsedBody};\n'
  + 'export {setSupabaseServerClientFactoryForTests as install} from "../../lib/supabase/server";',
  resolveDir: path.dirname(routerFile), loader: 'ts' }, bundle: true, write: false, platform: 'node',
  format: 'cjs', packages: 'external', logLevel: 'silent', target: 'node22' })).outputFiles[0].text;
after(() => esbuild.stop());
const LIMIT = 1024 * 1024, A = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222', S = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'owned.body.budget', PRIVATE = 'PRIVATE_BODY_DIAGNOSTIC_NEVER_RETURN';
const WORKER_SECRET = 'owned-worker-secret-never-a-real-credential';

function fixture() {
  const state = { auth: 0, reads: [], rpc: [], role: 'admin', memberships: true, purpose: 'clinic', authUnavailable: false, unexpected: [] };
  const db = { from(table) {
    assert.ok(['staff_users', 'workspace_settings'].includes(table), 'No business table admission in body tests');
    state.reads.push(table);
    const q = { select() { return q; }, eq() { return q; }, in() { return q; }, then(resolve, reject) {
      return Promise.resolve({ data: table === 'staff_users' ? state.memberships ? [{ id: S, workspace_id: W, role: state.role, status: 'active' }] : []
        : state.purpose === 'clinic' ? [] : [{ workspace_id: W, value: { purpose: state.purpose } }], error: null }).then(resolve, reject);
    } }; return q;
  }, async rpc(name, args) { state.rpc.push({ name, args }); return { data: null, error: { code: 'P1104', message: PRIVATE } }; } };
  const env = { NODE_ENV: 'test', SUPABASE_URL: 'https://body-budget.fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-not-a-credential',
    MEDINA_PLATFORM_OWNER_IDS: A, META_WORKSPACE_ID: S, META_INSIGHTS_WORKER_SECRET: WORKER_SECRET };
  const processView = Object.create(process); Object.defineProperty(processView, 'env', { value: env });
  const module = { exports: {} };
  new Script(code, { filename: 'owned-crm-body-budget.cjs' }).runInNewContext({ module, exports: module.exports, require, process: processView,
    fetch: async (url, options) => {
      if (url !== env.SUPABASE_URL + '/auth/v1/user') { state.unexpected.push(String(url)); throw Error('External fetch forbidden'); }
      state.auth++; assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      if (state.authUnavailable) throw Error(PRIVATE);
      const ok = options.headers.Authorization === `Bearer ${TOKEN}`;
      return { ok, status: ok ? 200 : 401, text: async () => JSON.stringify(ok ? { id: A } : { message: PRIVATE }) };
    }, Buffer, URL, URLSearchParams, AbortController, AbortSignal, DOMException, TextEncoder, TextDecoder,
    Request, Response, Headers, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval,
    console, __dirname: root, __filename: routerFile });
  module.exports.install(() => db);
  return { ...module.exports, state };
}
function stream(chunks, { route = 'clinic-creator-jobs', token = TOKEN, headers = {}, method = 'POST', body } = {}) {
  const stats = { next: 0, returned: 0, bytes: 0 };
  const req = { method, url: '/api/crm/' + route, query: { path: [route] }, body,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, stats,
    async *[Symbol.asyncIterator]() { try { for (const chunk of chunks) { stats.next++; if (chunk instanceof Error) throw chunk;
      stats.bytes += Buffer.byteLength(chunk); yield chunk; } } finally { stats.returned++; } } };
  return req;
}
function response() {
  return { statusCode: 200, headers: {}, body: null, status(v) { this.statusCode = v; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }, json(v) { this.body = v; return this; }, end(v) { this.body = v; return this; } };
}
async function call(f, req) { const res = response(); await f.default(req, res); assert.deepEqual(f.state.unexpected, []); return res; }
function tooLarge(res) { assert.equal(res.statusCode, 413); assert.equal(res.body.code, 'request_body_too_large');
  assert.equal(res.headers['cache-control'], 'no-store'); assert.ok(!JSON.stringify(res.body).includes(PRIVATE)); }

for (const route of ['clinic-creator-jobs', 'creator-jobs', 'platform-onboarding', 'leads', 'ad-creative-upload', 'meta-insights-sync']) {
  test(`Unauthenticated ${route} never reads even malformed oversized input`, async () => {
    const f = fixture(), req = stream([Buffer.alloc(LIMIT + 1), Error(PRIVATE)], { route, token: null });
    const res = await call(f, req); assert.equal(res.statusCode, route.startsWith('platform') ? 404 : 401);
    assert.equal(req.stats.next, 0); assert.equal(req.rawBody, undefined); assert.deepEqual(f.state.reads, []); assert.deepEqual(f.state.rpc, []);
  });
}
test('Role, membership, purpose and provider gates precede body consumption', async () => {
  for (const mode of ['role', 'membership', 'purpose', 'provider']) {
    const f = fixture(); if (mode === 'role') f.state.role = 'doctor'; if (mode === 'membership') f.state.memberships = false;
    if (mode === 'purpose') f.state.purpose = 'mortgage_leads';
    const req = stream([Error(PRIVATE)], { route: mode === 'provider' ? 'meta-accounts' : 'clinic-creator-jobs' });
    const res = await call(f, req); assert.equal(res.statusCode, 403, mode); assert.equal(req.stats.next, 0, mode); assert.deepEqual(f.state.rpc, []);
  }
});
test('Unknown paths, refused methods and disabled staff creation never read input', async () => {
  for (const [route, method, status] of [['owned-unknown', 'POST', 404], ['clinic-creator-jobs', 'DELETE', 405], ['staff', 'POST', 409]]) {
    const f = fixture(), req = stream([Error(PRIVATE)], { route, method }); const res = await call(f, req);
    assert.equal(res.statusCode, status); assert.equal(req.stats.next, 0); assert.deepEqual(f.state.rpc, []);
  }
});
test('Mortgage body restrictions still run after parsing but before any business call', async () => {
  for (const [route, method, body] of [['leads', 'POST', { clientId: W }], ['staff-credentials', 'POST', { role: 'owner' }],
    ['whatsapp-channels', 'PATCH', { enabled: true }]]) {
    const f = fixture(); f.state.purpose = 'mortgage_leads';
    const req = stream([JSON.stringify(body)], { route, method }), res = await call(f, req);
    assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'workspace_module_unavailable');
    assert.equal(req.stats.next, 1); assert.deepEqual(f.state.rpc, []);
  }
});
test('Auth failure remains generic and does not consume the body', async () => {
  const f = fixture(); f.state.authUnavailable = true;
  const req = stream([Error(PRIVATE)]), res = await call(f, req);
  assert.equal(res.statusCode, 503); assert.equal(req.stats.next, 0); assert.ok(!JSON.stringify(res.body).includes(PRIVATE));
});
test('Length header rejects before reading without allocating the declared size', async () => {
  for (const length of [String(LIMIT + 1), '999999999999999999999999999999999999999999999999']) {
    const f = fixture(), req = stream([Error(PRIVATE)], { headers: { 'content-length': length } }); tooLarge(await call(f, req));
    assert.equal(req.stats.next, 0); assert.deepEqual(f.state.rpc, []);
  }
});
test('Actual bytes stop at first excess chunk, with missing or understated length', async () => {
  for (const headers of [{}, { 'content-length': '2' }]) {
    const f = fixture(), req = stream([Buffer.alloc(LIMIT), '!', Error(PRIVATE)], { headers }); tooLarge(await call(f, req));
    assert.equal(req.stats.next, 2); assert.equal(req.stats.returned, 1); assert.equal(req.body, undefined); assert.equal(req.rawBody, undefined);
    assert.deepEqual(f.state.rpc, []);
  }
});
test('Boundary uses UTF-8 bytes, preserves exact signed bytes, not character counts', async () => {
  const f = fixture(), prefix = Buffer.from('{"value":"'), suffix = Buffer.from('"}');
  const raw = Buffer.concat([prefix, Buffer.from('я'.repeat((LIMIT - prefix.length - suffix.length) / 2)), suffix]);
  assert.equal(raw.length, LIMIT);
  const req = stream([raw.subarray(0, 41), raw.subarray(41)], { route: 'creator-jobs' });
  await f.ensureParsedBody(req); assert.equal(req.body.value.length, (LIMIT - prefix.length - suffix.length) / 2);
  assert.equal(createHash('sha256').update(req.rawBody).digest('hex'), createHash('sha256').update(raw).digest('hex'));
  const over = stream([Buffer.from('{"value":"' + 'я'.repeat(LIMIT / 2) + '"}')]); tooLarge(await call(f, over));
});
test('Malformed lengths and JSON return sanitized 400, not a business command', async () => {
  for (const headers of [{ 'content-length': '-1' }, { 'content-length': '1e6' }, { 'content-length': ['1', '2'] }, {}]) {
    const f = fixture(), req = stream(['{"' + PRIVATE], { headers }), res = await call(f, req);
    assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'invalid_request_body');
    assert.equal(res.headers['cache-control'], 'no-store'); assert.ok(!JSON.stringify(res.body).includes(PRIVATE)); assert.deepEqual(f.state.rpc, []);
  }
});
test('Pre-parsed adapters cannot bypass byte budgets or raw-byte checks', async () => {
  for (const value of [{ text: 'я'.repeat(LIMIT / 2) }, 'x'.repeat(LIMIT + 1), Buffer.alloc(LIMIT + 1)]) {
    const f = fixture(), req = stream([Error(PRIVATE)], { body: value }); tooLarge(await call(f, req)); assert.equal(req.stats.next, 0);
  }
  for (const raw of [Buffer.alloc(LIMIT + 1), 'я'.repeat(LIMIT / 2 + 1), new Uint8Array(LIMIT + 1)]) {
    const f = fixture(), req = stream([], { body: {} }); req.rawBody = raw; tooLarge(await call(f, req));
  }
});
test('An adapter with exact raw bytes but no parsed body does not read an exhausted stream', async () => {
  const expected = Buffer.from(' {"value":"я"} \n'), storage = Buffer.concat([Buffer.from('ignored-prefix'), expected, Buffer.from('ignored-suffix')]);
  const view = new Uint8Array(storage.buffer, storage.byteOffset + 14, expected.length);
  for (const raw of [expected, expected.toString('utf8'), view]) {
    const f = fixture(), req = stream([Error(PRIVATE)]); req.rawBody = raw; await f.ensureParsedBody(req);
    assert.equal(req.stats.next, 0); assert.equal(req.body.value, 'я'); assert.deepEqual(req.rawBody, expected);
  }
});
test('Small real body reaches the real handler once, with server-derived identity', async () => {
  const f = fixture(), raw = Buffer.from(JSON.stringify({ requestId: W, action: 'cancel', jobId: W, revision: S, payload: {} }));
  const req = stream([raw]), res = await call(f, req);
  assert.equal(res.statusCode, 409); assert.equal(f.state.rpc.length, 1);
  assert.equal(f.state.rpc[0].args.p_actor, A); assert.equal(f.state.rpc[0].args.p_staff, S); assert.equal(f.state.rpc[0].args.p_workspace, W);
  assert.deepEqual(req.rawBody, raw);
});
test('Platform owner parsing is bounded; a forbidden platform method is unread', async () => {
  const f = fixture(), req = stream([Error(PRIVATE)], { route: 'platform-onboarding', headers: { 'content-length': String(LIMIT + 1) } });
  tooLarge(await call(f, req)); assert.equal(req.stats.next, 0);
  const denied = stream([Error(PRIVATE)], { route: 'platform-onboarding', method: 'DELETE' });
  assert.equal((await call(f, denied)).statusCode, 405); assert.equal(denied.stats.next, 0);
});
test('Internal HMAC parsing is capped; multipart remains delegated without generic reads', async () => {
  const f = fixture(), req = stream([Buffer.alloc(LIMIT), '!', Error(PRIVATE)], { route: 'meta-insights-background-cycle' });
  tooLarge(await call(f, req)); assert.equal(f.state.auth, 0); assert.deepEqual(f.state.reads, []);
  for (const type of ['multipart/form-data; boundary=qa', 'Multipart/Form-Data; boundary=qa']) {
    const multipart = stream([Error(PRIVATE)], { headers: { 'content-type': type, 'content-length': '9999999999' } });
    await f.ensureParsedBody(multipart); assert.equal(multipart.stats.next, 0); assert.equal(multipart.rawBody, undefined);
  }
});
test('Real signed handler verifies noncanonical whitespace over the exact raw body', async () => {
  const f = fixture(), raw = Buffer.from(' { "workerId" : "owned-no-external-work" } \n');
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'owned-body-budget';
  const canonical = ['POST', '/api/crm/meta-insights-background-cycle', timestamp, nonce, createHash('sha256').update(raw).digest('hex')].join('\n');
  const signature = createHmac('sha256', WORKER_SECRET).update(canonical).digest('hex');
  const headers = { 'x-negis-worker-timestamp': timestamp, 'x-negis-worker-nonce': nonce,
    'x-negis-worker-request-id': 'owned-budget', 'x-negis-worker-signature': signature };
  const req = stream([raw.subarray(0, 9), raw.subarray(9)], { route: 'meta-insights-background-cycle', token: null, headers });
  const res = await call(f, req); assert.equal(res.statusCode, 200); assert.equal(res.body.claimed, 0);
  assert.equal(f.state.auth, 0); assert.deepEqual(f.state.reads, []); assert.deepEqual(f.state.rpc, []); assert.deepEqual(req.rawBody, raw);
  const forged = stream([Buffer.from(JSON.stringify(JSON.parse(raw)))], { route: 'meta-insights-background-cycle', token: null, headers });
  assert.equal((await call(f, forged)).statusCode, 401, 'Changing only whitespace invalidates the old signature');
});
test('URL-encoded and unknown content types share byte bounds; GET/HEAD remain unread', async () => {
  const f = fixture(), encoded = stream(['name=%D1%8F&count=1'], { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  await f.ensureParsedBody(encoded); assert.equal(encoded.body.name, 'я'); assert.equal(encoded.body.count, '1');
  for (const contentType of ['application/x-www-form-urlencoded', 'application/octet-stream', '']) {
    const req = stream([Buffer.alloc(LIMIT + 1)], { headers: { 'content-type': contentType } }); tooLarge(await call(f, req));
  }
  for (const method of ['GET', 'HEAD']) {
    const req = stream([Error(PRIVATE)], { method }); await f.ensureParsedBody(req); assert.equal(req.stats.next, 0);
  }
});
test('Real IncomingMessage returns JSON 413 without destroying the socket before response', async () => {
  const f = fixture(), observed = [];
  const server = createServer(async (req, out) => {
    req.query = { path: ['clinic-creator-jobs'] };
    const res = { status(v) { out.statusCode = v; return res; }, setHeader(k, v) { out.setHeader(k, v); return res; },
      json(value) { observed.push({ destroyed: req.destroyed, complete: req.complete, bytes: req.rawBody?.length }); out.end(JSON.stringify(value)); return res; }, end(v) { out.end(v); return res; } };
    try { await f.default(req, res); } catch { out.statusCode = 500; out.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  try {
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/crm/clinic-creator-jobs', method: 'POST',
        headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'transfer-encoding': 'chunked', connection: 'close' }, timeout: 10000 }, res => {
        req.end();
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('Owned HTTP request timed out')));
      req.write(Buffer.alloc(LIMIT)); req.write('!'); // No EOF: the server must respond without draining the whole request.
    });
    tooLarge(result); assert.deepEqual(observed, [{ destroyed: false, complete: false, bytes: undefined }]); assert.deepEqual(f.state.rpc, []);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
