import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedPwaResolve } from './pwa-update-browser.mjs';
import { buildServiceWorker } from '../../artifacts/negis/pwa-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const type = name => name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css'
  : name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.png') ? 'image/png' : 'application/octet-stream';

// In-memory production-mode Vite builds of actual components with fake Auth/CRM.
// Public static files only. No app env, Vercel config, DSN, SDK session or provider.
export async function createBuiltPwaFixture(initial = 'current') {
  if (!['legacy', 'current', 'next'].includes(initial)) throw Error('Invalid fixture version');
  const { build } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const legacyWorker = execFileSync('git', ['show', 'f18f411:artifacts/negis/public/sw.js'], { cwd: root, encoding: 'utf8' });
  const legacyPrompt = execFileSync('git', ['show', 'f18f411:artifacts/negis/src/components/layout/UpdatePrompt.tsx'], { cwd: root, encoding: 'utf8' });
  const currentWorker = await readFile(path.join(frontend, 'public/sw.js'), 'utf8');
  const staticFiles = new Map();
  for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
    'fonts/inter/inter-latin.woff2', 'fonts/inter/inter-cyrillic.woff2', 'fonts/inter/inter-cyrillic-ext.woff2']) {
    staticFiles.set(name, await readFile(path.join(frontend, 'public', name)));
  }
  const manifest = await readFile(path.join(frontend, 'public/manifest.webmanifest'));
  const builds = new Map();
  for (const label of ['legacy', 'current', 'next']) {
    const result = await build({ configFile: false, root: frontend, envDir: false, publicDir: false, logLevel: 'error',
      resolve: isolatedPwaResolve(), define: { 'import.meta.env.VITE_PWA_FIXTURE_LABEL': JSON.stringify(label) },
      plugins: [{ name: 'frozen-legacy-prompt', enforce: 'pre', load(id) {
        if (label === 'legacy' && id.replaceAll('\\', '/').endsWith('/src/components/layout/UpdatePrompt.tsx')) return legacyPrompt;
      } }, react(), tailwindcss()],
      build: { write: false, assetsInlineLimit: 0, rollupOptions: { input: path.join(root, 'scripts/fixtures/pwa-update-browser.tsx') } },
    });
    if (Array.isArray(result) || !result.output) throw Error('Expected one in-memory build output');
    const files = new Map(result.output.map(asset => [asset.fileName, Buffer.from(asset.type === 'chunk' ? asset.code : asset.source)]));
    const entry = result.output.find(asset => asset.type === 'chunk' && asset.isEntry);
    if (!entry) throw Error('Missing built entry');
    const styles = [...files.keys()].filter(name => name.endsWith('.css'));
    const html = `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="manifest" href="/manifest.webmanifest"><title>Medina OS - built PWA QA</title>${styles.map(name => `<link rel="stylesheet" href="/${name}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
    const stamped = buildServiceWorker(label === 'legacy' ? legacyWorker : currentWorker,
      new Map([...files, ...staticFiles, ['index.html', html], ['manifest.webmanifest', manifest]]), { legacySource: label === 'legacy' });
    builds.set(label, { files, buildId: stamped.buildId, script: stamped.script, html, precache: stamped.precache });
  }
  let selected = initial, origin, available = true, missingAsset = null; const calls = [];
  const server = createServer((req, res) => {
    if (!origin || req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url || '/', origin); calls.push({ path: url.pathname, method: req.method, selected });
    if (!available) { req.socket.destroy(); return; }
    res.setHeader('Cache-Control', 'no-store');
    const current = builds.get(selected);
    if (url.pathname === '/__qa/version' && req.method === 'POST' && req.headers.origin === origin && req.headers['content-type'] === 'application/json') {
      selected = selected === 'legacy' ? 'current' : 'next';
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: selected })); return;
    }
    if (req.method !== 'GET' || url.pathname.startsWith('/__qa/')) { res.writeHead(403); res.end(); return; }
    if (url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end('{"syntheticPrivate":"QA NOT CACHEABLE"}'); return; }
    if (url.pathname === '/sw.js' && !url.search) { res.setHeader('Content-Type', 'application/javascript'); res.end(current.script); return; }
    if (url.pathname === '/manifest.webmanifest' && !url.search) { res.setHeader('Content-Type', 'application/manifest+json'); res.end(manifest); return; }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (url.pathname === missingAsset) { res.writeHead(404); res.end(); return; }
    const asset = [...builds.values()].map(value => value.files.get(url.pathname.slice(1))).find(Boolean) || staticFiles.get(url.pathname.slice(1));
    if (asset) { res.setHeader('Content-Type', type(url.pathname)); res.end(asset); return; }
    if (['/', '/appointments', '/ai-control-center'].includes(url.pathname)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; worker-src 'self'; form-action 'none'; frame-src 'none'");
      res.end(current.html); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, calls, builds, setAvailable(value) { available = value === true; },
    setMissingAsset(name) {
      if (name !== null && ![...builds.values()].some(value => value.files.has(String(name).slice(1)))) throw Error('Unknown fixture asset');
      missingAsset = name;
    },
    select(label) { if (!builds.has(label)) throw Error('Unknown fixture build'); selected = label; },
    close: () => new Promise(resolve => server.close(resolve)) };
}
