import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { root } from '../src/appointment-recovery-committed-fixture.ts';
import { seedOperatorWorkday, cleanupOperatorWorkday } from './operator-workday-cases.mjs';

const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const rpcArguments = {
  read_growth_operator_lead_search: ['p_actor', 'p_search', 'p_group', 'p_request_id', 'p_offset'],
  set_growth_operator_lead_stage: ['p_request_id', 'p_operator_user_id', 'p_lead_id', 'p_stage_id', 'p_expected_stage_id', 'p_expected_status'],
  read_growth_operator_booking_context: ['p_request_id', 'p_operator_user_id', 'p_lead_id'],
  create_growth_operator_booking: ['p_request_id', 'p_operator_user_id', 'p_lead_id', 'p_request_key', 'p_doctor_id', 'p_service_ids', 'p_starts_local', 'p_time_zone'],
};
const selections = {
  growth_operator_profiles: { id: 'id' }, growth_operator_requests: { workspace_id: 'workspace_id' },
  clinic_doctors: { id: 'id', 'id,full_name,specialty': 'id,full_name,specialty' },
  clinic_services: { 'id,name,base_price_minor::text,duration_minutes': 'id,name,base_price_minor::text,duration_minutes' },
};
const columns = new Set(['id', 'workspace_id', 'auth_user_id', 'operator_id', 'status', 'is_active', 'full_name', 'name']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const explorerFinancialTables = ['platform_subscription_payments', 'growth_partner_commissions', 'growth_partner_payouts', 'deals', 'growth_operator_arrivals'];
export const explorerFinancialSnapshot = async db => (await db.query('select * from (' + explorerFinancialTables.map(name =>
  `select '${name}' table_name,to_jsonb(r) value from public.${name} r`).join(' union all ') + ') q order by table_name,value::text')).rows;

export async function seedOperatorExplorer(db) {
  const a = await seedOperatorWorkday(db, { companies: 2, visits: 0, label: 'EXPLORER_A' });
  const b = await seedOperatorWorkday(db, { companies: 1, visits: 0, label: 'EXPLORER_B' });
  const tokens = Object.fromEntries([a.actor, b.actor].map(actor => [actor, 'owned.' + randomUUID() + '.signature']));
  for (const c of [...a.companies, ...b.companies]) {
    c.deferred = randomUUID(); c.lost = randomUUID();
    await db.query("insert into public.lead_stages(id,workspace_id,stage_key,name,semantic_group,sort_order) values($1,$2,'qa_explorer_deferred','OWNED Deferred','postponed',81),($3,$2,'qa_explorer_lost','OWNED Lost','lost',82)", [c.deferred, c.workspace, c.lost]);
    await db.query("update public.clinic_services set base_price_minor=case id when $2::uuid then 125049 else 25001 end,duration_minutes=case id when $2::uuid then 45 else 30 end where workspace_id=$1", [c.workspace, c.services[0]]);
    await db.query('insert into public.clinic_doctor_shifts(workspace_id,doctor_id,weekday,is_working,start_minute,end_minute) values($1,$2,1,true,480,1140)', [c.workspace, c.doctor]);
  }
  // A same-contact row in each company stays independently addressable.
  for (const c of a.companies) await db.query("update public.leads set full_name='EXPLORER_MATCHED',phone='+77000005201' where id=$1", [c.leads[0]]);
  a.companies[0].extraLeads = [];
  for (let i = 0; i < 24; i++) {
    const c = a.companies[0], id = randomUUID(); c.extraLeads.push(id);
    await db.query("insert into public.leads(id,workspace_id,full_name,phone,status,source) values($1,$2,$3,$4,'in_progress','Owned later-page fixture')", [id, c.workspace, 'EXPLORER_A page ' + String(i).padStart(2, '0'), '+7009990' + String(i).padStart(4, '0')]);
    await db.query('select public.set_growth_operator_lead_assignment($1,$2,$3,true)', [c.request, id, c.staff]);
  }
  const workspaces = [...a.companies, ...b.companies].map(c => c.workspace);
  return {
    a, b, tokens,
    counts: () => one(db, `select
      (select count(*)::int from public.appointments where workspace_id=any($1::uuid[])) appointments,
      (select count(*)::int from public.clients where workspace_id=any($1::uuid[])) clients,
      (select count(*)::int from public.growth_operator_bookings where workspace_id=any($1::uuid[])) receipts,
      (select count(*)::int from public.audit_logs where workspace_id=any($1::uuid[]) and action='operator_appointment_created') booking_audits,
      (select count(*)::int from public.audit_logs where workspace_id=any($1::uuid[]) and action='operator_lead_stage_changed') stage_audits`, [workspaces]),
    async cleanup() { await cleanupOperatorWorkday(db, a); await cleanupOperatorWorkday(db, b); },
  };
}

// A narrow SDK wire adapter, not canned business data. Every RPC/read runs on
// the owned native database under the actual service_role and original SQL guards.
export function operatorExplorerNativeAdapter(fixture) {
  const controls = { calls: [], reads: [], holdNext: null, held: [] };
  async function query(sql, args) {
    const db = await fixture.connect();
    try { await db.query('set role service_role'); return await db.query(sql, args); }
    finally { await db.end(); }
  }
  return {
    controls,
    release() { for (const release of controls.held.splice(0)) release(); },
    adapter: {
      async rpc(name, args) {
        assert.ok(Object.hasOwn(rpcArguments, name), 'Only actual Explorer/booking RPCs');
        const keys = rpcArguments[name]; assert.deepEqual(Object.keys(args).sort(), [...keys].sort());
        const call = { name, args: structuredClone(args), code: null }; controls.calls.push(call);
        if (controls.holdNext === name) { controls.holdNext = null; await new Promise(resolve => controls.held.push(resolve)); }
        try { return { data: (await query(`select public.${name}(${keys.map((_, i) => '$' + (i + 1)).join(',')}) value`, keys.map(key => args[key]))).rows[0].value, error: null }; }
        catch (error) { call.code = error.code; return { data: null, error: { code: error.code, message: error.message } }; }
      },
      from(table) {
        assert.ok(Object.hasOwn(selections, table), 'Only existing operator catalogue read tables');
        let selected; const conditions = [], values = [], order = [];
        const q = {
          select(fields) { selected = selections[table][fields]; assert.ok(selected, table + ':' + fields); return q; },
          eq(column, value) { assert.ok(columns.has(column)); values.push(value); conditions.push(column + '=$' + values.length); return q; },
          or(value) {
            const match = /^doctor_id\.eq\.([0-9a-f-]{36}),doctor_id\.is\.null$/i.exec(value);
            assert.ok(match && uuid(match[1])); values.push(match[1]); conditions.push('(doctor_id=$' + values.length + ' or doctor_id is null)'); return q;
          },
          order(column) { assert.ok(columns.has(column)); order.push(column); return q; },
          async run(start = 0, count = 2) {
            assert.ok(selected && conditions.length && Number.isInteger(start) && start >= 0 && Number.isInteger(count) && count > 0 && count <= 26);
            controls.reads.push({ table, selected, values: structuredClone(values), start, count });
            try { return { data: (await query(`select ${selected} from public.${table} where ${conditions.join(' and ')}${order.length ? ' order by ' + order.join(',') : ''} offset ${start} limit ${count}`, values)).rows, error: null }; }
            catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
          },
          async maybeSingle() { const result = await q.run(); assert.ok(result.error || result.data.length <= 1); return { ...result, data: result.data?.[0] ?? null }; },
          range(start, end) { return q.run(start, end - start + 1); },
        };
        return q;
      },
    },
  };
}

export async function operatorExplorerNativeBundle(f) {
  const component = JSON.stringify(path.join(frontend, 'src/components/operators/OperatorLeadExplorer.tsx').replaceAll('\\', '/'));
  const initial = f.a.actor;
  const sdk = `export const hasSupabaseFrontendEnv=true;let actor=new URLSearchParams(location.search).get('actor')||${JSON.stringify(initial)};
    const tokens=${JSON.stringify(f.tokens)};export function changeActor(next){actor=next;}
    export const supabase={auth:{getSession:async()=>({data:{session:actor?{user:{id:actor},access_token:tokens[actor]}:null},error:null})}};`;
  const entry = `import React,{StrictMode,useRef,useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{OperatorLeadExplorer}from ${component};import{changeActor}from'owned-explorer-sdk';
    const initial=new URLSearchParams(location.search).get('actor')||${JSON.stringify(initial)};
    const f={bootId:crypto.randomUUID(),actor:initial,denials:[],view:{isCurrentMutationScope:()=>true},
      ids:${JSON.stringify({ a: f.a.actor, b: f.b.actor, companies: f.a.companies, other: f.b.companies })},
      snapshot(){return{text:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth+1,
        actor:this.actor,denials:this.denials,attempts:Object.keys(sessionStorage).filter(k=>k.startsWith('medina_operator_booking_attempt')).map(k=>[k,sessionStorage.getItem(k)])};}};
    window.__appointmentRecovery=f;
    function Host(){const[view,setView]=useState({actor:initial,epoch:0});const live=useRef({active:true});
      f.switchActor=next=>{live.current.active=false;live.current={active:true};f.actor=next;changeActor(next);
        history.replaceState(null,'','/?actor='+(next||''));flushSync(()=>setView(v=>({actor:next,epoch:v.epoch+1})));};
      f.remount=()=>f.switchActor(f.actor);const lifetime=live.current;
      return <main style={{padding:16,maxWidth:1120,margin:'0 auto'}}><h1>Тестовый кабинет оператора</h1>{view.actor?<OperatorLeadExplorer key={view.epoch} actorId={view.actor}
        isSessionCurrent={()=>lifetime.active} onAccessDenied={()=>{if(lifetime.active)f.denials.push(view.actor);}}/>:<p>Вход завершён</p>}</main>;}
    createRoot(document.getElementById('root')).render(<StrictMode><Host/></StrictMode>);`;
  const result = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, loader: 'tsx' }, bundle: true, write: false,
    outfile: 'bundle.js', format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.VITE_API_BASE_URL': '""' },
    plugins: [{ name: 'owned-explorer-identity-only', setup(build) {
      build.onResolve({ filter: /^(owned-explorer-sdk|@\/lib\/supabase)$/ }, () => ({ path: 'sdk', namespace: 'owned' }));
      build.onLoad({ filter: /.*/, namespace: 'owned' }, () => ({ contents: sdk, loader: 'ts' }));
      build.onResolve({ filter: /^@\// }, args => {
        const base = path.join(frontend, 'src', args.path.slice(2)), file = [base + '.ts', base + '.tsx'].find(existsSync);
        assert.ok(file, args.path); return { path: file };
      });
    } }],
  });
  return { js: result.outputFiles.find(file => file.path.endsWith('.js')).contents, css: result.outputFiles.find(file => file.path.endsWith('.css'))?.contents ?? Buffer.alloc(0) };
}

export async function operatorExplorerNativeServer(handler, bundle) {
  const folder = path.join(frontend, 'dist/public/assets'), names = (await readdir(folder)).filter(name => /^index-[\w-]+\.css$/.test(name));
  assert.equal(names.length, 1, 'Build the current frontend before browser acceptance');
  const files = new Map([
    ['/bundle.js', { type: 'application/javascript', data: bundle.js }], ['/components.css', { type: 'text/css', data: bundle.css }],
    ['/style.css', { type: 'text/css', data: await readFile(path.join(folder, names[0])) }],
  ]);
  for (const name of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'inter-cyrillic-ext.woff2']) files.set('/fonts/inter/' + name, { type: 'font/woff2', data: await readFile(path.join(frontend, 'public/fonts/inter', name)) });
  const controls = { mode: '', held: [], active: new Set(), requests: [], errors: [] };
  const routes = new Set(['operator-lead-search', 'operator-leads', 'operator-services', 'operator-bookings']);
  let origin;
  const server = createServer(async (req, out) => {
    if (!origin || req.headers.host !== new URL(origin).host) { out.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && files.has(url.pathname)) { const file = files.get(url.pathname); out.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' }).end(file.data); return; }
    if (req.method === 'GET' && url.pathname === '/') {
      out.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'" })
        .end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/components.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
      return;
    }
    const route = url.pathname.slice('/api/crm/'.length);
    if (!url.pathname.startsWith('/api/crm/') || !routes.has(route)) { out.writeHead(404).end(); return; }
    req.query = { path: [route] };
    for (const [key, value] of url.searchParams) req.query[key] = req.query[key] === undefined ? value : Array.isArray(req.query[key]) ? [...req.query[key], value] : [req.query[key], value];
    const mutation = route === 'operator-leads' && req.method === 'PATCH' || route === 'operator-bookings' && req.method === 'POST';
    const mode = mutation ? controls.mode : ''; if (mutation) controls.mode = '';
    const run = async () => {
      let status = 200, payload; const headers = {};
      const res = { setHeader(key, value) { headers[key] = value; return res; }, status(value) { status = value; return res; }, end(value) { payload = value; return res; }, json(value) { payload = value; return res; } };
      await handler(req, res);
      const raw = JSON.stringify(payload);
      controls.requests.push({ route, method: req.method, url: url.pathname + url.search, actorToken: req.headers.authorization,
        body: req.body === undefined ? null : structuredClone(req.body), status, cache: headers['Cache-Control'] ?? headers['cache-control'] });
      const send = () => { if (!out.destroyed) out.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(raw); };
      if (mutation && mode === 'after') { controls.held.push(send); return; }
      if (mutation && mode === 'drop' && status === 200) {
        if (!out.destroyed) { out.writeHead(status, { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) + 1 }); out.flushHeaders(); out.write('{"success":'); setTimeout(() => out.destroy(), 15).unref(); }
        return;
      }
      send();
    };
    const task = run().catch(error => { controls.errors.push(error.message); if (!out.destroyed) out.writeHead(500).end(); });
    controls.active.add(task); void task.finally(() => controls.active.delete(task));
    await task;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, controls,
    release() { for (const send of controls.held.splice(0)) send(); },
    async close() { for (const send of controls.held.splice(0)) send(); for (const task of [...controls.active]) await task; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
export const stopOperatorExplorerBuilds = () => esbuild.stop();
