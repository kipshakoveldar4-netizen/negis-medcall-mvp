import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPages, escapeHtml } from './render.mjs';
import { createPreviewServer } from './dev.mjs';

test('preview pages have safe metadata, valid internal links and disabled intake', () => {
  const pages = createPages();
  assert.equal(pages.size, 9);
  const titles = new Set();
  for (const html of pages.values()) {
    assert.match(html, /lang="ru"/);
    assert.match(html, /name="robots" content="noindex,nofollow"/);
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.doesNotMatch(html, /<script|localStorage|access_token/i);
    titles.add(html.match(/<title>(.*?)<\/title>/)[1]);
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (!href.startsWith('/ru/')) continue;
      const [route, anchor] = href.split('#');
      assert.ok(pages.has(route), `Missing route: ${route}`);
      if (anchor) assert.ok(pages.get(route).includes(`id="${anchor}"`));
    }
  }
  assert.equal(titles.size, pages.size);
  assert.match(pages.get('/ru/'), /<fieldset disabled>/);
  assert.match(pages.get('/ru/'), /type="button" disabled/);
  assert.match(pages.get('/ru/blog/after-the-lead/'), /Редакционный черновик/);
  assert.equal(escapeHtml('<"\'&>'), '&lt;&quot;&#39;&amp;&gt;');
});

test('preview HTTP routes, assets and privacy boundaries', async t => {
  const server = await createPreviewServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of createPages().keys()) {
    const response = await fetch(base + route);
    assert.equal(response.status, route === '/404.html' ? 404 : 200);
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
    assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
    await response.text();
  }
  const root = await fetch(base, { redirect: 'manual' });
  assert.equal(root.status, 308);
  assert.equal(root.headers.get('location'), '/ru/');
  assert.equal((await fetch(base + '/ru/blog', { redirect: 'manual' })).status, 308);
  assert.equal((await fetch(base + '/missing')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
  assert.equal((await fetch(base + '/ru/', { method: 'POST', body: 'test' })).status, 405);
  assert.equal(await (await fetch(base + '/ru/', { method: 'HEAD' })).text(), '');
  const image = await fetch(base + '/assets/brand.png');
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok((await image.arrayBuffer()).byteLength > 0);
  assert.match(await (await fetch(base + '/robots.txt')).text(), /Disallow: \//);
});
