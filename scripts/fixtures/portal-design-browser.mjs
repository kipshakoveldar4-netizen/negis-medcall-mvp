import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createPortProbe } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedPwaResolve } from './pwa-update-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const entry = path.join(root, 'scripts/fixtures/portal-design-browser.tsx').replaceAll('\\', '/');
const mocks = path.join(root, 'scripts/fixtures/portal-design-browser-mocks.ts');
const normalize = value => value.replaceAll('\\', '/').toLowerCase();
const within = (file, parent) => normalize(file).startsWith(normalize(parent) + '/');
export const portalDesignPaths = ['/contributors?mode=partner', '/contributors?mode=creator', '/operator'];
export function portalDesignRequestAllowed(req, origin) {
  if (!origin || req.method !== 'GET' || req.headers.host !== new URL(origin).host) return false;
  if (req.headers.origin && req.headers.origin !== origin) return false;
  if (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) return false;
  try {
    const url = new URL(req.url || '/', origin);
    if (url.origin !== origin || url.username || url.password) return false;
    if (req.headers.referer && new URL(req.headers.referer).origin !== origin) return false;
    const pathname = decodeURIComponent(url.pathname);
    if (/(^|[/\\])(?:\.env[^/\\]*|\.git|api|output|migrations|sw\.js|manifest\.webmanifest)(?:[/\\]|$)/i.test(pathname)) return false;
    if (/\/src\/lib\/supabase(?:\.[cm]?[jt]s)?$/i.test(pathname)) return false;
    if (pathname.includes('\\') || pathname.includes('\0')) return false;
    return true;
  } catch { return false; }
}
export async function portalDesignConfig(port = 5290, { prebundle = true, watch = true } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid fixture port');
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: tailwind } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const resolve = isolatedPwaResolve();
  resolve.alias = resolve.alias.filter(alias => !['@/contexts/AuthContext', '@/lib/api', '@/lib/supabase'].includes(alias.find));
  resolve.alias.unshift({ find: '@/lib/supabase', replacement: mocks });
  resolve.alias.unshift({ find: '@/contexts/AuthContext', replacement: mocks });
  const cache = path.join(tmpdir(), `medina-portal-design-${process.pid}-${port}`, 'node_modules/.vite');
  const allowed = [path.join(frontend, 'src'), path.join(frontend, 'public'), path.join(root, 'scripts/fixtures'), path.join(root, 'lib/crm'), path.join(root, 'lib/auth'), path.join(root, 'node_modules'), path.join(frontend, 'node_modules'), cache];
  let origin;
  const safety = {
    name: 'isolated-portal-design', enforce: 'pre',
    resolveId(source, importer) {
      if (/^(?:https?:|\/\/|@supabase\/|@anthropic-ai\/|openai(?:\/|$)|node:)/i.test(source)) throw Error('Fixture blocked an external or server import');
      const target = source.startsWith('.') && importer ? path.resolve(path.dirname(importer.split('?')[0]), source) : source;
      if (/\/src\/lib\/supabase(?:\.[cm]?[jt]s)?$/.test(normalize(target))) return mocks;
      if (/\/src\/contexts\/authcontext(?:\.tsx)?$/.test(normalize(target))) return mocks;
      return null;
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!portalDesignRequestAllowed(req, origin)) { res.writeHead(403); res.end('Fixture request refused'); return; }
        const url = new URL(req.url || '/', origin), pathname = decodeURIComponent(url.pathname);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${origin.replace('http:', 'ws:')}; img-src 'self' data:; font-src 'self'; media-src 'self'; worker-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
        if (pathname === '/__fixture/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ fixture: 'portal-design-browser', pid: process.pid, origin, syntheticOnly: true })); return; }
        if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (pathname === '/') { res.writeHead(302, { Location: portalDesignPaths[0] }); res.end(); return; }
        if (['/contributors', '/operator'].includes(pathname)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          try {
            res.end(await vite.transformIndexHtml(pathname, `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Medina OS - LOCAL synthetic fixture</title></head><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`));
          } catch (error) { next(error); }
          return;
        }
        if (req.headers['sec-fetch-dest'] === 'document' || req.headers.accept?.includes('text/html')) { res.writeHead(404); res.end(); return; }
        const physical = pathname.startsWith('/@fs/') ? pathname.slice(5)
          : path.join(frontend, pathname.startsWith('/src/') || pathname.startsWith('/node_modules/') ? '' : 'public', pathname);
        const virtual = ['/@vite/client', '/@react-refresh'].includes(pathname) || pathname.startsWith('/@id/');
        if (!virtual && (!allowed.some(parent => within(physical, parent)) || !/\.(?:[cm]?[jt]sx?|css|woff2?|png|jpe?g|webp|svg|gif|avif|map)$/.test(pathname))) { res.writeHead(403); res.end(); return; }
        next();
      });
    },
  };
  return {
    config: { configFile: false, envFile: false, envDir: false, root: frontend, appType: 'custom', cacheDir: cache,
      // Never forward inherited VITE_* variables into the browser bundle.
      envPrefix: '__PORTAL_FIXTURE_UNUSED__', define: { 'import.meta.env': { BASE_URL: '/', DEV: true, PROD: false, MODE: 'portal-design-fixture', SSR: false } },
      resolve, plugins: [safety, react(), tailwind()], optimizeDeps: prebundle ? { entries: [entry] } : { noDiscovery: true, include: [], entries: [] },
      server: { host: '127.0.0.1', port, strictPort: true, watch: watch ? undefined : null, cors: false, allowedHosts: ['127.0.0.1'], fs: { strict: true, allow: allowed } },
      build: { write: false, emptyOutDir: false, rollupOptions: { input: entry } },
    },
    setOrigin(value) { origin = value; },
  };
}
export async function createPortalDesignFixture(port = 5290, options) {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  let bindPort = port;
  if (port === 0) {
    // Vite maps zero to a default port. Select an ephemeral port, then use its
    // public listen lifecycle so initialization and shutdown both run normally.
    bindPort = await new Promise((resolve, reject) => {
      const probe = createPortProbe();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(error => error ? reject(error) : resolve(address.port));
      });
    });
  }
  const { config, setOrigin } = await portalDesignConfig(bindPort, options);
  const server = await createServer(config);
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    setOrigin(origin);
    server.httpServer.prependListener('upgrade', (req, socket) => {
      if (!portalDesignRequestAllowed({ ...req, method: 'GET', url: req.url, headers: req.headers }, origin) || req.headers.origin !== origin) socket.destroy();
    });
    return { origin, close: () => server.close(), transform: url => server.transformRequest(url) };
  } catch (error) { await server.close(); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const key of Object.keys(process.env)) if (!['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA'].includes(key)) delete process.env[key];
  const fixture = await createPortalDesignFixture(Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? 5290));
  process.stdout.write(`LOCAL synthetic fixture, owner PID ${process.pid}; stop with Ctrl+C (SIGINT) or SIGTERM.\n${portalDesignPaths.map(route => fixture.origin + route).join('\n')}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
