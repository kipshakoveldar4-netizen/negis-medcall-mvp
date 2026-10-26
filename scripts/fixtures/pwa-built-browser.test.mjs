import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBuiltPwaFixture } from './pwa-built-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(url, events) {
  const ws = new WebSocket(url), pending = new Map(); let id = 0;
  ws.addEventListener('message', event => {
    const value = JSON.parse(String(event.data));
    if (!value.id) { events(value.method, value.params); return; }
    const item = pending.get(value.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(value.id);
    if (value.error) item.reject(Error(JSON.stringify(value.error))); else item.resolve(value.result);
  });
  ws.addEventListener('close', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Owned browser closed')); }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error('Owned connect timeout')); }, 10_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Owned connect failed')); }, { once: true });
  });
  return { call(method, params = {}) { return new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error('Owned timeout: ' + method)); }, 20_000);
    pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
  }); }, close() { ws.close(); } };
}

test('built PWA graph, private API exclusion and offline launch', { timeout: 240_000 }, async t => {
  const executable = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
  assert.ok(executable, 'Installed Chromium only, no install or download fallback');
  const fixture = await createBuiltPwaFixture();
  const profile = await mkdtemp(path.join(tmpdir(), 'medina-pwa-built-owned-'));
  const child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-extensions', '--disable-sync', '--disable-component-update', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'DISPLAY'].includes(key))) });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  let cdp, other, port = '';
  t.after(async () => {
    if (cdp) await cdp.call('Browser.close').catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(5000)]); }
    cdp?.close(); other?.close(); await fixture.close();
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('medina-pwa-built-owned-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  for (let i = 0; i < 250; i++) {
    assert.equal(child.exitCode, null, 'Owned browser must remain live until cleanup');
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; } catch {}
    if (/^\d+$/.test(port)) break; await delay(80);
  }
  assert.match(port, /^\d+$/);
  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const target = (await targets()).find(value => value.type === 'page'); assert.ok(target);
  const requests = [], exceptions = [];
  let navigations = 0, otherNavigations = 0;
  cdp = await connect(target.webSocketDebuggerUrl, (method, params) => {
    if (method === 'Network.requestWillBeSent') requests.push(params.request.url);
    if (method === 'Runtime.exceptionThrown') exceptions.push(params.exceptionDetails);
    if (method === 'Page.frameNavigated' && !params.frame.parentId) navigations++;
  });
  await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable');
  await cdp.call('Network.setCacheDisabled', { cacheDisabled: true });
  const evaluate = async (body, connection = cdp) => {
    const result = await connection.call('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const wait = async (body, message, connection = cdp) => {
    for (let i = 0; i < 200; i++) { if (await evaluate(body, connection)) return; await delay(40); }
    assert.fail(message + ': ' + JSON.stringify(exceptions));
  };
  const ready = label => `return document.querySelector('[data-testid=pwa-built-label]')?.textContent===${JSON.stringify(label)} && navigator.serviceWorker?.controller?.state==='activated' && !![...document.querySelectorAll('button')].find(n=>n.textContent==='Новая встреча'&&!n.disabled)`;
  const cacheKeys = () => evaluate(`const cache=await caches.open('medina-shell-${fixture.builds.get('current').buildId}');return(await cache.keys()).map(r=>new URL(r.url).pathname).sort();`);
  await cdp.call('Page.navigate', { url: fixture.origin + '/appointments?fixturePurpose=mortgage_leads&fixtureRole=admin' });
  await wait(ready('current'), 'Built synthetic UI and activated worker must load');
  const assets = [...fixture.builds.get('current').files.keys()].filter(name => /\.(?:js|css)$/.test(name)).map(name => '/' + name).sort();
  assert.ok(assets.length >= 2); assert.ok(assets.every(name => /-[\w-]{8,}\.(js|css)$/.test(name)), 'Real Vite hashed output, not hand-authored names');
  await t.test('first activation already contains the built JS/CSS graph', async () => {
    const keys = await cacheKeys(); for (const asset of assets) assert.ok(keys.includes(asset), 'Not precached: ' + asset);
  });
  await t.test('private API is reachable online but never placed in CacheStorage', async () => {
    const body = await evaluate(`return await new Promise(resolve=>{const r=new XMLHttpRequest();r.open('GET','/api/crm/private-qa');r.onload=()=>resolve(r.responseText);r.onerror=()=>resolve('network error');r.send()});`);
    assert.equal(body, '{"syntheticPrivate":"QA NOT CACHEABLE"}');
    assert.equal(await evaluate(`return !!(await caches.match('/api/crm/private-qa'))`), false);
    assert.equal((await cacheKeys()).some(key => key.startsWith('/api/') || key.startsWith('/auth/')), false);
  });
  fixture.setAvailable(false);
  await cdp.call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await t.test('offline cold reload launches the built shell with HTTP cache disabled', async () => {
    await cdp.call('Page.reload'); await wait(ready('current'), 'Offline shell must execute real built JS/CSS');
    assert.equal(await evaluate(`return await new Promise(resolve=>{const r=new XMLHttpRequest();r.open('GET','/api/crm/private-qa');r.onload=()=>resolve('unexpected response');r.onerror=()=>resolve('unavailable');r.send()});`), 'unavailable');
    await evaluate('await document.fonts.ready;');
    assert.equal(await evaluate(`return document.fonts.check('16px Inter','Тестовая команда')`), true, 'Local Inter font must remain available');
    const parent = path.join(root, 'node_modules/.cache/pwa-built-20261026'); await mkdir(parent, { recursive: true });
    const folder = await mkdtemp(path.join(parent, 'run-'));
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(folder, 'offline-built.png'), Buffer.from(data, 'base64'));
    t.diagnostic('Offline screenshot: ' + path.relative(root, path.join(folder, 'offline-built.png')));
  });
  fixture.setAvailable(true);
  await cdp.call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.call('Page.reload'); await wait(ready('current'), 'Online controlled reload must load after the first offline launch');
  await t.test('controlled visits retain actual dash-hashed assets, not only HTML', async () => {
    const keys = await cacheKeys(); for (const asset of assets) assert.ok(keys.includes(asset), 'Not cached: ' + asset);
  });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // Reset only this disposable origin/profile, never the user's browser.
  await cdp.call('Storage.clearDataForOrigin', { origin: fixture.origin, storageTypes: 'all' });
  fixture.select('legacy');
  await cdp.call('Page.navigate', { url: fixture.origin + '/appointments?fixturePurpose=mortgage_leads&fixtureRole=admin' });
  await wait(ready('legacy') + ";", 'Frozen legacy prompt/worker must load');
  await wait("return performance.getEntriesByType('navigation')[0]?.type==='reload' && document.querySelector('[data-testid=pwa-built-label]')?.textContent==='legacy'", 'Old first-controller handler performs its known reload');
  const targetInfo = await cdp.call('Target.createTarget', { url: fixture.origin + '/appointments?fixturePurpose=mortgage_leads&fixtureRole=admin' });
  const otherTarget = (await targets()).find(value => value.id === targetInfo.targetId); assert.ok(otherTarget);
  other = await connect(otherTarget.webSocketDebuggerUrl, (method, params) => {
    if (method === 'Page.frameNavigated' && !params.frame.parentId) otherNavigations++;
  });
  await other.call('Page.enable'); await other.call('Runtime.enable'); await other.call('Network.enable');
  await other.call('Network.setCacheDisabled', { cacheDisabled: true });
  await wait(ready('legacy'), 'Second frozen legacy tab must load', other);
  await evaluate("[...document.querySelectorAll('button')].find(n=>n.textContent==='Новая встреча').click();", other);
  await wait('return !!document.querySelector("input[id$=\'-title\']")', 'Second tab meeting editor must open', other);
  await evaluate(`const n=document.querySelector("input[id$='-title']");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'QA LEGACY DRAFT');n.dispatchEvent(new Event('input',{bubbles:true}));`, other);
  fixture.select('current');
  await evaluate('await (await navigator.serviceWorker.getRegistration()).update();');
  await wait("return !![...document.querySelectorAll('button')].find(n=>n.textContent==='Обновить')", 'Legacy update button must be offered');
  const beforeUpdate = navigations, beforeOther = otherNavigations;
  const point = await evaluate("const n=[...document.querySelectorAll('button')].find(n=>n.textContent==='Обновить'),r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}");
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await wait(ready('current'), 'Explicit legacy upgrade must load current built code');
  await t.test('explicit legacy upgrade loads the current stamped graph exactly once', async () => {
    assert.equal(navigations, beforeUpdate + 1);
    const keys = await cacheKeys(); for (const asset of assets) assert.ok(keys.includes(asset));
    assert.deepEqual(await evaluate('return (await caches.keys()).sort()'), ['medina-active-shell', 'medina-shell-' + fixture.builds.get('current').buildId]);
  });
  await t.test('characterization only: already loaded legacy code still reloads its other tab and loses its unsaved form', async () => {
    await wait(ready('current'), 'Other legacy tab receives its unconditional reload', other);
    assert.equal(otherNavigations, beforeOther + 1);
    assert.equal(await evaluate('return !!document.querySelector("input[id$=\'-title\']")', other), false);
    t.diagnostic('NOT readiness approval: a legacy first-upgrade maintenance/save-all-tabs procedure remains required.');
  });
  await cdp.call('Target.closeTarget', { targetId: targetInfo.targetId });
  const nextJs = [...fixture.builds.get('next').files.keys()].find(name => name.endsWith('.js')); assert.ok(nextJs);
  fixture.select('next'); fixture.setMissingAsset('/' + nextJs);
  await t.test('missing candidate asset rejects installation and keeps the current controller and shell', async () => {
    const outcome = await evaluate(`const r=await navigator.serviceWorker.getRegistration();return await new Promise((resolve,reject)=>{
      let worker;const timer=setTimeout(()=>{r.removeEventListener('updatefound',found);reject(Error('Install outcome timeout'))},12000);
      const state=()=>{if(worker?.state==='redundant'||worker?.state==='installed'){clearTimeout(timer);worker.removeEventListener('statechange',state);resolve(worker.state)}};
      const found=()=>{if(worker)return;worker=r.installing;if(worker){worker.addEventListener('statechange',state);state()}};
      r.addEventListener('updatefound',found,{once:true});r.update().then(found,reject);
    });`);
    assert.equal(outcome, 'redundant');
    assert.equal(await evaluate("return document.querySelector('[data-testid=pwa-built-label]').textContent"), 'current');
    assert.equal(await evaluate(`return await(await caches.match('/__medina_active_shell',{cacheName:'medina-active-shell'})).text()`), fixture.builds.get('current').buildId);
    const keys = await cacheKeys(); for (const asset of assets) assert.ok(keys.includes(asset));
  });
  fixture.setMissingAsset(null);
  assert.deepEqual(requests.filter(value => !value.startsWith(fixture.origin + '/') && !value.startsWith('data:image/')), []);
  assert.deepEqual(exceptions, []);
});
