import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));

export function isolatedPwaResolve() {
  const mocks = path.join(root, 'scripts/fixtures/crm-browser-mocks.ts');
  return { dedupe: ['react', 'react-dom'], alias: [
    { find: '@/contexts/AuthContext', replacement: mocks }, { find: '@/lib/api', replacement: mocks },
    { find: '@/lib/supabase', replacement: mocks }, { find: '@', replacement: path.join(frontend, 'src') },
    ...['wouter', 'sonner', 'react', 'react-dom'].map(name => ({ find: new RegExp('^' + name + '$'), replacement: require.resolve(name) })),
    ...['react', 'react-dom'].map(name => ({ find: new RegExp('^' + name + '/'), replacement: path.dirname(require.resolve(name + '/package.json')) + '/' })),
  ] };
}

// A separate loopback origin with real worker bytes, full CSS and fake CRM/Auth.
// No application env/config, credentials, providers or remote API are loaded.
export async function createPwaUpdateFixture(port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid fixture port');
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const worker = await readFile(path.join(frontend, 'public/sw.js'), 'utf8');
  if (worker.split('__BUILD_ID__').length !== 2) throw Error('Expected one worker build placeholder');
  const entry = path.join(root, 'scripts/fixtures/pwa-update-browser.tsx');
  let version = 1, origin;
  const server = await createServer({ configFile: false, root: frontend, envDir: false, appType: 'custom',
    cacheDir: path.join(tmpdir(), `medina-pwa-update-${process.pid}-${port}`), optimizeDeps: { entries: [entry] },
    resolve: isolatedPwaResolve(), plugins: [react(), tailwindcss(), { name: 'isolated-pwa-update', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!origin || req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return; }
        const url = new URL(req.url || '/', origin);
        res.setHeader('Cache-Control', 'no-store');
        if (url.pathname === '/__qa/version' && !url.search) {
          if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') {
            res.writeHead(403); res.end(); return;
          }
          version++;
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version })); return;
        }
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__qa/') || req.method !== 'GET') {
          res.writeHead(403); res.end(); return;
        }
        if (url.pathname === '/sw.js' && !url.search) {
          res.setHeader('Content-Type', 'application/javascript');
          res.end(worker.replace('__BUILD_ID__', `qa-pwa-${version}`)); return;
        }
        if (url.pathname === '/manifest.webmanifest' && !url.search) {
          res.setHeader('Content-Type', 'application/manifest+json'); res.end('{}'); return;
        }
        if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (!['/', '/appointments'].includes(url.pathname)) {
          if (req.headers['sec-fetch-dest'] === 'document' || req.headers.accept?.includes('text/html')) {
            res.writeHead(404); res.end(); return;
          }
          return next();
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; font-src 'self'; worker-src 'self'; form-action 'none'; frame-src 'none'");
        res.end(await vite.transformIndexHtml(url.pathname, `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Medina OS - PWA QA</title></head><body><div id="root"></div><script type="module" src="/@fs/${entry.replaceAll('\\', '/')}"></script></body></html>`));
      });
    } }], server: { host: '127.0.0.1', port, strictPort: port !== 0, cors: false, fs: { allow: [root] } } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  return { origin, close: () => server.close() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const key of Object.keys(process.env)) if (!['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA'].includes(key)) delete process.env[key];
  const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] || 5262);
  const fixture = await createPwaUpdateFixture(port);
  process.stdout.write(`${fixture.origin}/appointments?fixturePurpose=mortgage_leads&fixtureRole=admin\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
