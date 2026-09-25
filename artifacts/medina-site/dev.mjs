import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, output } from './build.mjs';

export async function createPreviewServer() {
  const pages = await buildSite();
  const assets = new Map([['/site.css', ['site.css', 'text/css; charset=utf-8']], ['/assets/brand.png', ['assets/brand.png', 'image/png']], ['/robots.txt', ['robots.txt', 'text/plain; charset=utf-8']]]);
  return http.createServer(async (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    let url;
    try { url = new URL(req.url, 'http://localhost').pathname; } catch { res.writeHead(400); res.end(); return; }
    const redirect = url === '/' ? '/ru/' : pages.has(`${url}/`) ? `${url}/` : null;
    if (redirect) { res.writeHead(308, { Location: redirect }); res.end(); return; }
    try {
      if (assets.has(url)) {
        const [file, contentType] = assets.get(url);
        const bytes = await readFile(path.join(output, file));
        res.writeHead(200, { 'Content-Type': contentType }); res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      const found = pages.has(url) && url !== '/404.html';
      res.writeHead(found ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : pages.get(found ? url : '/404.html'));
    } catch { res.writeHead(500); res.end(); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || '5186');
  const server = await createPreviewServer();
  server.listen(port, '127.0.0.1', () => console.log(`Medina site preview: http://127.0.0.1:${port}/ru/`));
}
