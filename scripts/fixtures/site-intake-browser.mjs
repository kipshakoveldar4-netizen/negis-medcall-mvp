import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createPages } from '../../artifacts/medina-site/render.cjs';
import intake from '../../lib/crm/site-intake-handler.ts';
import supabase from '../../lib/supabase/server.ts';

const { createSiteIntakeHandler } = intake;
const { setSupabaseServerClientFactoryForTests } = supabase;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = '00000000-0000-4000-8000-000000000001';
const otherWorkspace = '00000000-0000-4000-8000-000000000002';
const simulatedOrigin = 'https://site.example.invalid';

// Loopback-only, disposable database. Never reads .env or accepts database URLs.
export async function startSiteIntakeFixture({ articles = [] } = {}) {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon, authenticated, service_role;');
  const selected = new Set([9, 10, 11, 12, 13, 14, 19, 58]);
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    if (selected.has(Number(file.slice(0, 3)))) {
      await db.exec((await readFile(path.join(root, 'migrations', file), 'utf8')).replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, ''));
    }
  }
  await db.query('insert into public.workspaces(id,name) values($1,$2),($3,$4)', [workspace, 'Fixture marketing', otherWorkspace, 'Fixture other']);
  await db.query(`insert into public.crm_intake_sites(site_key,workspace_id,consent_version,allowed_page_paths,enabled)
    values('browser-fixture',$1,'v1',array['/ru/'],true)`, [workspace]);
  let mode = 'normal';
  const tokens = new Set();
  const counts = async () => (await db.query(`select
    (select count(*)::int from public.leads where workspace_id=$1) as leads,
    (select count(*)::int from public.crm_site_inquiries i join public.crm_intake_sites s on s.id=i.site_id where s.workspace_id=$1) as receipts,
    (select count(*)::int from public.leads where workspace_id=$2) as other_workspace_leads`, [workspace, otherWorkspace])).rows[0];
  setSupabaseServerClientFactoryForTests(() => ({
    async rpc(name, args) {
      assert.equal(name, 'accept_crm_site_inquiry');
      try {
        const result = await db.query('select public.accept_crm_site_inquiry($1,$2,$3::jsonb) as result',
          [args.p_site_key, args.p_request_key, JSON.stringify(args.p_inquiry)]);
        return { data: result.rows[0].result, error: null };
      } catch (error) { return { data: null, error: { message: error.message } }; }
    },
  }));
  const handler = createSiteIntakeHandler({
    env: () => ({ MEDINA_SITE_INTAKE_ENABLED: 'true', MEDINA_SITE_ORIGIN: simulatedOrigin,
      MEDINA_SITE_INTAKE_KEY: 'browser-fixture', MEDINA_SITE_TURNSTILE_SECRET: 'fixture-only-not-a-secret' }),
    verify: async (_config, token) => tokens.delete(token) && mode !== 'challenge-failed',
  });
  let origin;
  const json = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      return json(res, 403, { error: 'local_only' });
    }
    const url = new URL(req.url, origin);
    if (req.method !== 'GET' && req.headers.origin !== origin) return json(res, 403, { error: 'local_origin_required' });
    try {
      if (url.pathname === '/api/crm/site-inquiry' && req.method === 'POST') {
        // Only the fixture maps its exact HTTP loopback origin to the production
        // handler's HTTPS fixture origin. Production HTTPS/Origin rules stay intact.
        req.headers.origin = simulatedOrigin;
        const adapter = {
          status(code) { res.statusCode = code; return adapter; },
          setHeader(key, value) { res.setHeader(key, key === 'Access-Control-Allow-Origin' ? origin : value); },
          json(payload) {
            if (mode === 'response-lost' && res.statusCode === 200) { mode = 'normal'; res.destroy(); return; }
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload));
          },
          end() { res.end(); },
        };
        await handler(req, adapter);
        return;
      }
      if (url.pathname === '/__fixture/state' && req.method === 'GET') return json(res, 200, await counts());
      if (url.pathname === '/__fixture/challenge' && req.method === 'POST') {
        const token = crypto.randomUUID(); tokens.add(token);
        return json(res, 200, { token });
      }
      if (url.pathname === '/__fixture/mode' && req.method === 'POST') {
        const nextMode = url.searchParams.get('value');
        if (!['normal', 'challenge-failed', 'storage-failed', 'response-lost'].includes(nextMode)) return json(res, 400, { error: 'invalid_fixture_mode' });
        await db.exec('alter table public.crm_site_inquiries drop constraint if exists fixture_write_failure');
        if (nextMode === 'storage-failed') await db.exec('alter table public.crm_site_inquiries add constraint fixture_write_failure check(false) not valid');
        mode = nextMode;
        return json(res, 200, { mode });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
      const assets = new Map([
        ['/site.css', ['artifacts/medina-site/site.css', 'text/css']],
        ['/assets/brand.png', ['artifacts/negis/public/icon-512.png', 'image/png']],
      ]);
      if (assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        const bytes = await readFile(path.join(root, file));
        res.writeHead(200, { 'Content-Type': type }); res.end(bytes); return;
      }
      if (url.pathname === '/form.js') {
        const source = await readFile(path.join(root, 'artifacts/medina-site/form.js'), 'utf8');
        assert.ok(source.includes('https://challenges.cloudflare.com/turnstile/v0/api.js?onload=medinaChallengeReady&render=explicit'));
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(source.replace('https://challenges.cloudflare.com/turnstile/v0/api.js?onload=medinaChallengeReady&render=explicit', '/__fixture/challenge.js')); return;
      }
      if (url.pathname === '/__fixture/challenge.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(`window.turnstile = {
          render(element, options) {
            const button = document.createElement('button'); button.type = 'button';
            button.textContent = 'Тест: подтвердить защиту';
            button.onclick = async () => {
              const response = await fetch('/__fixture/challenge', {method:'POST'});
              options.callback((await response.json()).token);
            };
            element.append(button); return 'fixture';
          }, reset() {}
        }; window.medinaChallengeReady();`); return;
      }
      const pages = createPages({ endpoint: `${origin}/api/crm/site-inquiry`, siteKey: 'fixture-site-key', consentVersion: 'v1' },
        { preview: false, indexable: false, articles, origin: simulatedOrigin });
      if (pages.has(url.pathname)) {
        const html = pages.get(url.pathname).replace('<body>', '<body><div class="preview">Локальная тестовая форма. Только вымышленные данные. База и защита изолированы.</div>');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
      }
      json(res, 404, { error: 'not_found' });
    } catch {
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: 'fixture_error' });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      setSupabaseServerClientFactoryForTests(null);
      await db.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startSiteIntakeFixture();
  console.log(`Disposable form fixture: ${fixture.origin}/ru/#consultation`);
  const stop = async () => { await fixture.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
