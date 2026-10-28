import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Script } from 'node:vm';
import { root } from '../src/appointment-recovery-committed-fixture.ts';
const frontend = path.join(root, 'artifacts/negis'), require = createRequire(path.join(root, 'package.json'));
const frontendRequire = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(frontendRequire.resolve('vite/package.json'))('esbuild');
export const creatorRpcArguments = Object.freeze({
  execute_growth_creator_job_v2: ['p_actor', 'p_workspace', 'p_staff', 'p_request', 'p_job', 'p_revision', 'p_action', 'p_payload'],
  read_growth_creator_jobs: ['p_actor', 'p_workspace', 'p_staff', 'p_offset'],
  read_growth_creator_command_v2: ['p_actor', 'p_workspace', 'p_staff', 'p_request'],
  close_growth_creator_command_v2: ['p_actor', 'p_workspace', 'p_staff', 'p_request', 'p_action', 'p_target'],
  read_growth_creator_directory: ['p_actor', 'p_workspace', 'p_staff', 'p_offset'],
  read_growth_creator_job_detail: ['p_actor', 'p_workspace', 'p_staff', 'p_job', 'p_offset'],
});
export function creatorNativeAdapter(fixture) {
  const controls = { calls: [], reads: [], held: null, holdNextWriter: false, malformedNextWrite: false, failReads: false };
  async function query(sql, args) { const db = await fixture.connect(); try { await db.query('set role service_role'); return await db.query(sql, args); } finally { await db.end(); } }
  const adapter = {
    async rpc(name, args) {
      assert.ok(Object.hasOwn(creatorRpcArguments, name), 'Only current creator entry RPCs, never a legacy writer/helper');
      const names = creatorRpcArguments[name]; assert.deepEqual(Object.keys(args).sort(), [...names].sort());
      controls.calls.push({ name, args: structuredClone(args) });
      if (name === 'execute_growth_creator_job_v2' && controls.holdNextWriter) {
        controls.holdNextWriter = false; await new Promise(resolve => { controls.held = resolve; });
      }
      try {
        const data = (await query(`select public.${name}(${names.map((_, i) => '$' + (i + 1)).join(',')}) value`, names.map(key => args[key]))).rows[0].value;
        if (name === 'execute_growth_creator_job_v2' && controls.malformedNextWrite) { controls.malformedNextWrite = false; return { data: { state: 'committed', requestId: args.p_request }, error: null }; }
        return { data, error: null };
      } catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
    },
    from(table) {
      const projections = { staff_users: 'id, workspace_id, role, status', workspace_settings: 'workspace_id, value' };
      assert.ok(Object.hasOwn(projections, table), 'No direct creator table, other tenant table or collection writer');
      const values = [], filters = [], entry = { table, filters: [] }; controls.reads.push(entry); let selected = false;
      const columns = table === 'staff_users' ? ['auth_user_id', 'status'] : ['workspace_id', 'key'];
      const q = {
        select(value) { assert.equal(value, projections[table]); selected = true; return q; },
        eq(column, value) { assert.ok(columns.includes(column)); values.push(value); filters.push(`${column}=$${values.length}`); entry.filters.push([column, value]); return q; },
        in(column, value) { assert.equal(table, 'workspace_settings'); assert.equal(column, 'workspace_id'); assert.ok(Array.isArray(value) && value.length <= 2);
          values.push(value); filters.push(`workspace_id=any($${values.length}::uuid[])`); entry.filters.push([column, value]); return q; },
        then(resolve, reject) {
          assert.ok(selected && filters.length === 2, 'Every identity/purpose read is narrowly selected and filtered');
          const run = async () => {
            if (controls.failReads) return { data: null, error: { code: 'OWNED_READ_FAILURE', message: 'PRIVATE_NATIVE_READ_DIAGNOSTIC' } };
            try { return { data: (await query(`select ${projections[table]} from public.${table} where ${filters.join(' and ')}`, values)).rows, error: null }; }
            catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
          }; return run().then(resolve, reject);
        },
      }; return q;
    },
  };
  return { adapter, controls, release() { const release = controls.held; controls.held = null; release?.(); } };
}

export async function compiledCreatorRouter(adapter, identities) {
  const auth = { calls: [], unavailable: false, unexpected: [] };
  const source = `export {default as handler} from ${JSON.stringify(path.join(root, 'api/crm/[...path].ts'))};
    export {setSupabaseServerClientFactoryForTests as install} from ${JSON.stringify(path.join(root, 'lib/supabase/server.ts'))};`;
  const code = (await esbuild.build({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node',
    format: 'cjs', packages: 'external', logLevel: 'silent', target: 'node22' })).outputFiles[0].text;
  const env = { NODE_ENV: 'test', SUPABASE_URL: 'https://creator-auth-fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-only-not-a-credential' };
  const processView = Object.create(process); Object.defineProperty(processView, 'env', { value: env });
  const module = { exports: {} };
  const fetchAuth = async (url, options) => {
    if (url !== env.SUPABASE_URL + '/auth/v1/user') { auth.unexpected.push(String(url)); throw Error('External fetch forbidden'); }
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
    const id = identities.get(options.headers.Authorization?.replace(/^Bearer /, ''));
    auth.calls.push(id ?? null);
    if (auth.unavailable) throw Error('PRIVATE_AUTH_DIAGNOSTIC');
    return { ok: Boolean(id), status: id ? 200 : 401, text: async () => JSON.stringify(id ? { id } : { message: 'PRIVATE_AUTH_DIAGNOSTIC' }) };
  };
  new Script(code, { filename: 'owned-compiled-creator-router.cjs' }).runInNewContext({ module, exports: module.exports, require, process: processView,
    fetch: fetchAuth, Buffer, URL, URLSearchParams, AbortController, AbortSignal, DOMException, TextEncoder, TextDecoder,
    Request, Response, Headers, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, console,
    __dirname: root, __filename: path.join(root, 'owned-compiled-creator-router.cjs') });
  module.exports.install(() => adapter);
  return { handler: module.exports.handler, auth, close() { module.exports.install(null); } };
}

export async function creatorNativeBundle(f, initialSide = 'company') {
  const component = JSON.stringify(path.join(frontend, 'src/components/contributors/CreatorJobs.tsx').replaceAll('\\', '/'));
  const sdk = `export const hasSupabaseFrontendEnv=true;
    export const supabase={auth:{getSession:async()=>{const f=window.__appointmentRecovery;return{data:{session:f.sdkActor?{user:{id:f.sdkActor},access_token:f.tokens[f.sdkActor]}:null},error:null};}}};`;
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{CreatorJobs}from ${component};
    const ids=${JSON.stringify({ owner: f.owner, a: f.actor, b: f.other, workspace: f.w })},tokens=${JSON.stringify(f.tokens)};
    const side=new URLSearchParams(location.search).get('side')||'${initialSide}',actor=side==='company'?ids.owner:ids.a;
    const f={ids,tokens,sdkActor:actor,side,view:{isCurrentMutationScope:()=>true},snapshot(){return{text:document.body.innerText,actor:this.sdkActor,
      metadata:Object.keys(sessionStorage).filter(k=>k.startsWith('medina_creator_command_v1:')).map(k=>sessionStorage.getItem(k)),
      overflow:document.documentElement.scrollWidth>innerWidth+1};}};window.__appointmentRecovery=f;
    function Host(){const[view,setView]=React.useState({actor,side,epoch:0}),live=React.useRef({active:true});const scope=live.current;
      f.change=(nextSide,nextActor=nextSide==='company'?ids.owner:ids.a)=>{scope.active=false;live.current={active:true};f.sdkActor=nextActor;f.side=nextSide;
        history.replaceState(null,'','/?side='+nextSide);flushSync(()=>setView(v=>({actor:nextActor,side:nextSide,epoch:v.epoch+1})));};
      f.raw=id=>{f.sdkActor=id;};f.view={isCurrentMutationScope:()=>scope.active};
      return <main className="mx-auto min-w-0 max-w-4xl px-4 py-6"><h1 className="mb-5 text-xl font-semibold">${'Тестовая сквозная проверка заданий'}</h1>
        <CreatorJobs key={view.epoch} actorId={view.actor} workspaceId={view.side==='company'?ids.workspace:undefined} isSessionCurrent={()=>scope.active}/></main>;}
    createRoot(document.getElementById('root')).render(<Host/>);`;
  const bundled = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, loader: 'tsx' }, bundle: true, write: false,
    outfile: path.join(root, 'node_modules/.cache/creator-native-browser/bundle.js'), format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.VITE_API_BASE_URL': '""' },
    plugins: [{ name: 'owned-creator-sdk-only', setup(build) {
      build.onResolve({ filter: /^@\/lib\/supabase$/ }, () => ({ path: 'sdk', namespace: 'owned' }));
      build.onLoad({ filter: /.*/, namespace: 'owned' }, () => ({ contents: sdk, loader: 'ts' }));
      build.onResolve({ filter: /^@\// }, args => { const base = path.join(frontend, 'src', args.path.slice(2)), file = [base + '.ts', base + '.tsx'].find(existsSync); assert.ok(file, args.path); return { path: file }; });
    } }] });
  const js = bundled.outputFiles.find(file => path.basename(file.path) === 'bundle.js');
  const css = bundled.outputFiles.find(file => path.basename(file.path) === 'bundle.css');
  assert.ok(js?.text.trim() && css?.text.trim(), 'Creator browser fixture requires real JavaScript and extracted CSS');
  return { js: js.text, css: css.text };
}

async function assets() {
  const folder = path.join(frontend, 'dist/public/assets'), names = (await readdir(folder)).filter(name => /^index-[\w-]+\.css$/.test(name));
  assert.equal(names.length, 1, 'Build the current application before native styled acceptance');
  const result = new Map([['/style.css', { type: 'text/css', data: await readFile(path.join(folder, names[0])) }]]);
  for (const name of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'inter-cyrillic-ext.woff2']) result.set('/fonts/inter/' + name, { type: 'font/woff2', data: await readFile(path.join(frontend, 'public/fonts/inter', name)) });
  for (const name of ['filming.webp', 'interior.webp', 'photography.webp']) result.set('/images/contributors/' + name, { type: 'image/webp', data: await readFile(path.join(frontend, 'public/images/contributors', name)) });
  return result;
}
export async function creatorNativeServer(handler, code) {
  const files = await assets(), controls = { mode: '', held: [], active: new Set(), requests: [], errors: [] }; let origin;
  const bundle = typeof code === 'string' ? { js: code, css: '' } : code;
  assert.ok(bundle && typeof bundle.js === 'string' && typeof bundle.css === 'string');
  files.set('/bundle.js', { type: 'application/javascript', data: bundle.js });
  if (bundle.css) files.set('/bundle.css', { type: 'text/css', data: bundle.css });
  const routes = ['creator-jobs', 'creator-job-command', 'clinic-creator-jobs', 'clinic-creator-job-command', 'creator-directory', 'creator-job-detail', 'clinic-creator-job-detail', 'owned-unknown'];
  const server = createServer(async (incoming, outgoing) => {
    if (!origin || incoming.headers.host !== new URL(origin).host) { outgoing.writeHead(403).end(); return; }
    const url = new URL(incoming.url, origin);
    if (incoming.method === 'GET' && files.has(url.pathname)) { const file = files.get(url.pathname); outgoing.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' }).end(file.data); return; }
    if (incoming.method === 'GET' && url.pathname === '/') {
      outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'" })
        .end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/style.css">'
          + (bundle.css ? '<link rel="stylesheet" href="/bundle.css">' : '')
          + '</head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return;
    }
    if (!url.pathname.startsWith('/api/crm/') || !routes.includes(url.pathname.split('/')[3])) { outgoing.writeHead(404).end(); return; }
    try {
      const chunks = []; let size = 0; for await (const part of incoming) { size += part.length; assert.ok(size <= 32768); chunks.push(part); }
      const raw = Buffer.concat(chunks), query = Object.create(null);
      for (const [key, value] of url.searchParams) query[key] = query[key] === undefined ? value : Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
      query.path = url.pathname.slice('/api/crm/'.length).split('/');
      const request = Readable.from(raw.length ? [raw] : []); Object.assign(request, { method: incoming.method, headers: incoming.headers, url: incoming.url, query });
      const business = incoming.method === 'POST' && ['creator-jobs', 'clinic-creator-jobs'].includes(query.path[0]);
      let mode = ''; if (business) { mode = controls.mode; controls.mode = ''; }
      const execute = async () => {
        let status = 200, payload; const headers = {};
        const response = { setHeader(key, value) { headers[key] = value; return response; }, status(value) { status = value; return response; },
          json(value) { payload = value; return response; }, end(value) { payload = value; return response; } };
        await handler(request, response);
        const json = JSON.stringify(payload);
        controls.requests.push({ path: query.path.join('/'), method: incoming.method, status, state: payload?.data?.state,
          requestId: request.body?.requestId, cache: headers['Cache-Control'] });
        const send = () => { if (!outgoing.destroyed) outgoing.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(json); };
        if (business && status === 200 && mode === 'after') { controls.held.push({ send }); return; }
        if (business && status === 200 && mode === 'drop') {
          if (!outgoing.destroyed) { outgoing.writeHead(status, { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) + 1 }); outgoing.flushHeaders(); outgoing.write('{"success":'); setTimeout(() => outgoing.destroy(), 20).unref(); } return;
        } send();
      };
      const run = () => { const task = execute().catch(error => { controls.errors.push(error.message); if (!outgoing.destroyed) outgoing.writeHead(500).end(); });
        controls.active.add(task); void task.finally(() => controls.active.delete(task)); return task; };
      if (business && mode === 'before') { controls.held.push({ run }); return; }
      await run();
    } catch (error) { controls.errors.push(error.message); if (!outgoing.destroyed) outgoing.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, controls, async release() { for (const item of controls.held.splice(0)) if (item.run) await item.run(); else item.send(); },
    async close() { controls.held = []; for (const task of [...controls.active]) await task; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
export function stopCreatorFixtureBuilds() { esbuild.stop(); }
