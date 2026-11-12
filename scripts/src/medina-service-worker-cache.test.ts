import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

// Real SW source and native Response objects; only CacheStorage, worker events
// and the deferred network are synthetic. No browser, SDK, env or network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(path.join(root, 'artifacts/negis/public/sw.js'), 'utf8');
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const key = (request: string | { url: string }) => typeof request === 'string' ? request : request.url;
class Cache {
  readonly rows = new Map<string, Response>();
  async match(request: string | { url: string }) { return this.rows.get(key(request))?.clone(); }
  async put(request: string | { url: string }, response: Response) { this.rows.set(key(request), response); }
  async addAll(requests: string[]) { for (const request of requests) await this.put(request, new Response('synthetic shell ' + request)); }
}
function storage() {
  const caches = new Map<string, Cache>(), opened: string[] = [];
  return { caches, opened,
    async open(name: string) { opened.push(name); if (!caches.has(name)) caches.set(name, new Cache()); return caches.get(name)!; },
    async keys() { return [...caches.keys()]; },
    async delete(name: string) { return caches.delete(name); },
    async match(request: string | { url: string }, options?: { cacheName?: string }) {
      const selected = options?.cacheName ? [caches.get(options.cacheName)].filter(Boolean) as Cache[] : [...caches.values()];
      for (const cache of selected) { const response = await cache.match(request); if (response) return response; }
      return undefined;
    },
  };
}
type Store = ReturnType<typeof storage>;
function worker(caches: Store, buildId: string) {
  const events = new Map<string, (event: any) => void>();
  const network = deferred<Response>(), calls: string[] = [];
  let claimed = 0;
  const self = { location: { origin: 'https://pwa.example.test' },
    addEventListener(type: string, handler: (event: any) => void) { events.set(type, handler); },
    clients: { async claim() { claimed++; } },
  };
  new Script(source.replace('__BUILD_ID__', buildId), { filename: 'actual-sw.js' }).runInNewContext({ self, caches, URL, Response,
    fetch(request: { url: string }) { calls.push(request.url); return network.promise; } });
  return { network, calls, claimed: () => claimed,
    async lifecycle(type: 'install' | 'activate') {
      const work: Promise<unknown>[] = []; events.get(type)!({ waitUntil(promise: Promise<unknown>) { work.push(promise); } });
      await Promise.all(work);
    },
    request(url: string, mode = 'navigate', method = 'GET') {
      let response: Promise<Response> | undefined;
      events.get('fetch')!({ request: { url, mode, method }, respondWith(promise: Promise<Response>) { assert.equal(response, undefined); response = promise; } });
      return response;
    },
  };
}

for (const mode of ['navigate', 'asset'] as const) {
  test(`late ${mode} response cannot reopen a shell cache deleted by newer activation`, async () => {
    const caches = storage(), old = worker(caches, 'old'), current = worker(caches, 'new');
    await old.lifecycle('install'); await old.lifecycle('activate');
    const retained = caches.caches.get('medina-shell-old')!;
    const url = mode === 'navigate' ? 'https://pwa.example.test/appointments' : 'https://pwa.example.test/assets/index.abcdefgh.js';
    const response = old.request(url, mode === 'navigate' ? 'navigate' : 'cors'); assert.ok(response);
    for (let i = 0; i < 100 && !old.calls.length; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(old.calls, [url]);
    await current.lifecycle('install'); await current.lifecycle('activate');
    assert.equal(current.claimed(), 1); assert.deepEqual((await caches.keys()).sort(), ['medina-active-shell', 'medina-shell-new']);
    const openedBefore = [...caches.opened]; old.network.resolve(new Response('late synthetic response'));
    assert.equal(await (await response).text(), 'late synthetic response');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(caches.opened, openedBefore, 'No late CacheStorage.open is allowed');
    assert.deepEqual((await caches.keys()).sort(), ['medina-active-shell', 'medina-shell-new']);
    // Cache handles remain valid after deletion, but do not resurrect their name.
    assert.ok(retained.rows.has(mode === 'navigate' ? '/' : url));
  });
}

test('asset lookup is scoped to this shell rather than an unrelated cache', async () => {
  const caches = storage(), app = worker(caches, 'current'); await app.lifecycle('install'); await app.lifecycle('activate');
  const url = 'https://pwa.example.test/assets/index.abcdefgh.js';
  const unrelated = await caches.open('other-application'); await unrelated.put(url, new Response('foreign cached bytes'));
  const response = app.request(url, 'cors'); assert.ok(response);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  app.network.resolve(new Response('own fetched bytes'));
  assert.equal(await (await response).text(), 'own fetched bytes'); assert.deepEqual(app.calls, [url]);
});

for (const mode of ['navigate', 'asset'] as const) {
  test(`${mode}: a request delivered to an already retired worker stays online without reopening its name`, async () => {
    const caches = storage(), old = worker(caches, 'old'), current = worker(caches, 'new');
    await old.lifecycle('install'); await old.lifecycle('activate');
    await current.lifecycle('install'); await current.lifecycle('activate');
    const opened = [...caches.opened];
    const url = mode === 'navigate' ? 'https://pwa.example.test/appointments' : 'https://pwa.example.test/assets/index.abcdefgh.js';
    const response = old.request(url, mode === 'navigate' ? 'navigate' : 'cors'); assert.ok(response);
    old.network.resolve(new Response('retired online response'));
    assert.equal(await (await response).text(), 'retired online response');
    assert.deepEqual(caches.opened, opened);
    assert.deepEqual((await caches.keys()).sort(), ['medina-active-shell', 'medina-shell-new']);
  });

  test(`${mode}: activation between ownership read and open cannot leave a reopened old cache`, async () => {
    const caches = storage(), old = worker(caches, 'old'), current = worker(caches, 'new');
    await old.lifecycle('install'); await old.lifecycle('activate');
    const open = caches.open.bind(caches), gate = deferred<void>(); let entered = false;
    caches.open = async (name: string) => {
      if (name === 'medina-shell-old') { entered = true; await gate.promise; }
      return open(name);
    };
    const url = mode === 'navigate' ? 'https://pwa.example.test/appointments' : 'https://pwa.example.test/assets/index.abcdefgh.js';
    const response = old.request(url, mode === 'navigate' ? 'navigate' : 'cors'); assert.ok(response);
    for (let i = 0; i < 100 && !entered; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(entered, true);
    await current.lifecycle('install'); await current.lifecycle('activate');
    assert.deepEqual((await caches.keys()).sort(), ['medina-active-shell', 'medina-shell-new']);
    gate.resolve(); old.network.resolve(new Response('response after ownership race'));
    assert.equal(await (await response).text(), 'response after ownership race');
    assert.deepEqual((await caches.keys()).sort(), ['medina-active-shell', 'medina-shell-new']);
  });
}

test('a restarted active worker can read its existing shell without installing again', async () => {
  const caches = storage(), initial = worker(caches, 'current');
  await initial.lifecycle('install'); await initial.lifecycle('activate');
  const restarted = worker(caches, 'current'), response = restarted.request('https://pwa.example.test/appointments'); assert.ok(response);
  for (let i = 0; i < 100 && !restarted.calls.length; i++) await new Promise<void>(resolve => setImmediate(resolve));
  restarted.network.reject(Error('Synthetic offline'));
  assert.equal(await (await response).text(), 'synthetic shell /');
  assert.deepEqual((await caches.keys()).sort(), ['medina-active-shell', 'medina-shell-current']);
});

test('storage failure during activation still claims clients and online requests remain usable', async () => {
  const caches = storage(), app = worker(caches, 'current'); await app.lifecycle('install');
  caches.open = async () => { throw Error('Synthetic storage denied'); };
  await app.lifecycle('activate'); assert.equal(app.claimed(), 1);
  const response = app.request('https://pwa.example.test/appointments'); assert.ok(response);
  app.network.resolve(new Response('online with unavailable ownership marker'));
  assert.equal(await (await response).text(), 'online with unavailable ownership marker');
});

test('a failed precache rejects installation without changing the current owner', async () => {
  const caches = storage(), old = worker(caches, 'old'), candidate = worker(caches, 'candidate');
  await old.lifecycle('install'); await old.lifecycle('activate');
  const open = caches.open.bind(caches);
  caches.open = async name => {
    const cache = await open(name);
    if (name === 'medina-shell-candidate') cache.addAll = async () => { throw Error('Synthetic missing built file'); };
    return cache;
  };
  await assert.rejects(candidate.lifecycle('install'), /missing built file/);
  assert.equal(candidate.claimed(), 0);
  const marker = await caches.match('https://pwa.example.test/__medina_active_shell', { cacheName: 'medina-active-shell' });
  assert.equal(await marker!.text(), 'old'); assert.ok(caches.caches.has('medina-shell-old'));
});

for (const filename of ['index-Abcd123_.js', 'index-Abcd123_.css', 'index.Abcd123_.js']) {
  test(`actual Vite/dot hash spelling is cached: ${filename}`, async () => {
    const caches = storage(), app = worker(caches, 'current'); await app.lifecycle('install'); await app.lifecycle('activate');
    const url = 'https://pwa.example.test/assets/' + filename, response = app.request(url, 'cors'); assert.ok(response);
    app.network.resolve(new Response('public built bytes')); assert.equal(await (await response).text(), 'public built bytes');
    assert.ok(caches.caches.get('medina-shell-current')!.rows.has(url));
  });
}

test('API, auth, no-sw, external, non-GET and ordinary non-shell requests never open a cache', async () => {
  const caches = storage(), app = worker(caches, 'current');
  for (const [url, mode, method] of [
    ['https://pwa.example.test/api/crm/clients', 'navigate', 'GET'],
    ['https://pwa.example.test/auth/v1/user', 'navigate', 'GET'],
    ['https://pwa.example.test/appointments?no-sw', 'navigate', 'GET'],
    ['https://other.example.test/assets/index.abcdefgh.js', 'cors', 'GET'],
    ['https://pwa.example.test/appointments', 'navigate', 'POST'],
    ['https://pwa.example.test/private/avatar.jpg', 'cors', 'GET'],
  ]) assert.equal(app.request(url, mode, method), undefined, url);
  assert.deepEqual(caches.opened, []); assert.deepEqual(app.calls, []);
});

for (const mode of ['navigate', 'asset'] as const) {
  for (const failure of ['open', 'put'] as const) test(`${mode}: CacheStorage ${failure} failure does not discard an online response`, async () => {
    const caches = storage(), app = worker(caches, 'current'); await app.lifecycle('install'); await app.lifecycle('activate');
    if (failure === 'open') caches.open = async () => { throw Error('Synthetic storage refusal'); };
    else caches.caches.get('medina-shell-current')!.put = async () => { throw Error('Synthetic quota refusal'); };
    const url = mode === 'navigate' ? 'https://pwa.example.test/appointments' : 'https://pwa.example.test/assets/index.abcdefgh.js';
    const response = app.request(url, mode === 'navigate' ? 'navigate' : 'cors'); assert.ok(response);
    app.network.resolve(new Response('online despite cache failure'));
    assert.equal(await (await response).text(), 'online despite cache failure');
  });
}

test('offline navigation reads only its own shell; unrelated caches are not fallback documents', async () => {
  for (const ownShell of [true, false]) {
    const caches = storage(), app = worker(caches, 'current'); await app.lifecycle('install'); await app.lifecycle('activate');
    if (!ownShell) caches.caches.get('medina-shell-current')!.rows.clear();
    await (await caches.open('unrelated')).put('/', new Response('foreign private document'));
    const response = app.request('https://pwa.example.test/appointments'); assert.ok(response);
    for (let i = 0; i < 100 && !app.calls.length; i++) await new Promise<void>(resolve => setImmediate(resolve));
    app.network.reject(Error('Synthetic offline'));
    const result = await response;
    if (ownShell) assert.equal(await result.text(), 'synthetic shell /');
    else assert.equal(result.type, 'error');
  }
});

test('a cached immutable asset avoids the network and a non-ok navigation cannot replace the shell', async () => {
  const caches = storage(), app = worker(caches, 'current'); await app.lifecycle('install'); await app.lifecycle('activate');
  const cache = caches.caches.get('medina-shell-current')!, url = 'https://pwa.example.test/assets/index.abcdefgh.js';
  await cache.put(url, new Response('owned immutable bytes'));
  const asset = app.request(url, 'cors'); assert.ok(asset); assert.equal(await (await asset).text(), 'owned immutable bytes');
  assert.deepEqual(app.calls, []);
  const page = app.request('https://pwa.example.test/appointments'); assert.ok(page);
  app.network.resolve(new Response('refused document', { status: 403 }));
  const result = await page; assert.equal(result.status, 403); assert.equal(await result.text(), 'refused document');
  assert.equal(await (await cache.match('/'))!.text(), 'synthetic shell /');
});
