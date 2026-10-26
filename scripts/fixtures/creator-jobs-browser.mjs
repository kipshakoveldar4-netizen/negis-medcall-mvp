import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedPwaResolve } from './pwa-update-browser.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
export async function createCreatorJobsFixture(port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid port');
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: tailwind } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const mocks = path.join(root, 'scripts/fixtures/creator-jobs-browser-mocks.ts'), resolve = isolatedPwaResolve();
  resolve.alias.unshift(...['@/lib/supabase', '@/lib/operatorApi'].map(find => ({ find, replacement: mocks })));
  const entry = path.join(root, 'scripts/fixtures/creator-jobs-browser.tsx').replaceAll('\\', '/');
  let origin;
  const server = await createServer({ configFile: false, envDir: false, root: frontend, appType: 'custom',
    cacheDir: path.join(tmpdir(), `medina-creator-jobs-${process.pid}-${port}`), optimizeDeps: { entries: [entry] },
    resolve, plugins: [react(), tailwind(), { name: 'creator-jobs-fixture', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!origin || req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return; }
        const url = new URL(req.url || '/', origin); res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') { res.writeHead(403); res.end(); return; }
        if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (!['/company', '/contributors'].includes(url.pathname)) {
          if (req.headers['sec-fetch-dest'] === 'document') { res.writeHead(404); res.end(); return; } return next();
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; font-src 'self'; worker-src 'none'; form-action 'none'; frame-src 'none'");
        res.end(await vite.transformIndexHtml(url.pathname, `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Medina OS - Creator QA</title></head><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`));
      });
    } }], server: { host: '127.0.0.1', port, strictPort: port !== 0, cors: false, fs: { allow: [root] } } });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  return { origin, close: () => server.close() };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const key of Object.keys(process.env)) if (!['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA'].includes(key)) delete process.env[key];
  const fixture = await createCreatorJobsFixture(Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] || 5266));
  process.stdout.write(`${fixture.origin}/company\n${fixture.origin}/contributors\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
