import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPages, createSitemap, escapeHtml } from './render.mjs';
import { createPreviewServer } from './dev.mjs';
import { readFormSettings } from './settings.mjs';

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

test('form requires explicit public settings; secret is never rendered', () => {
  assert.equal(readFormSettings({}), null);
  assert.throws(() => readFormSettings({ MEDINA_SITE_FORM_ENABLED: 'true' }));
  const config = readFormSettings({ MEDINA_SITE_FORM_ENABLED: 'true', MEDINA_SITE_API_ORIGIN: 'https://api.example.invalid',
    MEDINA_SITE_TURNSTILE_SITE_KEY: 'public-test-key', MEDINA_SITE_CONSENT_VERSION: 'v1', MEDINA_SITE_TURNSTILE_SECRET: 'MUST-NOT-RENDER' });
  const html = createPages(config).get('/ru/');
  assert.match(html, /data-intake-endpoint="https:\/\/api.example.invalid\/api\/crm\/site-inquiry"/);
  assert.match(html, /name="consent" required/);
  assert.match(html, /method="post"/);
  assert.doesNotMatch(html, /MUST-NOT-RENDER|workspaceId|<fieldset disabled/);
  assert.match(html, /type="submit" disabled/);
});

test('public rendering excludes example drafts and escapes approved text', () => {
  const origin = 'https://site.example.invalid';
  const pages = createPages(null, { preview: false, indexable: true, origin, articles: [
    { slug: 'approved', title: '<script>bad</script>', summary: '"quoted"', body: '<img src=x onerror=alert(1)>\n\nText' },
  ] });
  assert.equal(pages.has('/ru/blog/after-the-lead/'), false);
  const article = pages.get('/ru/blog/approved/');
  assert.match(article, /&lt;script&gt;/);
  assert.doesNotMatch(article, /<script|<img src=x|Редакционный черновик|undefined/);
  assert.match(article, /rel="canonical" href="https:\/\/site.example.invalid\/ru\/blog\/approved\/"/);
  assert.match(article, /name="robots" content="index,follow"/);
  assert.match(pages.get('/404.html'), /noindex,nofollow/);
  const sitemap = createSitemap(pages, origin);
  assert.match(sitemap, /\/ru\/blog\/approved\//);
  assert.doesNotMatch(sitemap, /404.html|after-the-lead/);
  assert.match(createPages(null, { preview: false }).get('/ru/blog/'), /Материалы готовятся/);
});
