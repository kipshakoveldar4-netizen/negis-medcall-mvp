import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPwaUpdateFixture } from './pwa-update-browser.mjs';

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
    const timer = setTimeout(() => { ws.close(); reject(Error('Owned browser connect timeout')); }, 10_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Owned browser connect failed')); }, { once: true });
  });
  return { call(method, params = {}) { return new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error('Owned CDP timeout: ' + method)); }, 20_000);
    pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
  }); }, close() { ws.close(); } };
}

test('real two-version PWA update, navigation geometry and cancelled reload recovery', { timeout: 240_000 }, async t => {
  const executable = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
  assert.ok(executable, 'Installed Chromium required, no install or download fallback');
  const server = await createPwaUpdateFixture();
  const profile = await mkdtemp(path.join(tmpdir(), 'medina-pwa-owned-'));
  const child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-extensions', '--disable-sync', '--disable-component-update', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'DISPLAY'].includes(key))) });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const connections = []; let cdp, port = '';
  t.after(async () => {
    if (cdp) await cdp.call('Browser.close').catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(5000)]); }
    for (const connection of connections) connection.close();
    await server.close();
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('medina-pwa-owned-'));
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
  const dialogs = [], requests = [], exceptions = []; let navigations = 0;
  cdp = await connect(target.webSocketDebuggerUrl, (method, params) => {
    if (method === 'Page.javascriptDialogOpening') dialogs.push(params);
    if (method === 'Page.frameNavigated' && !params.frame.parentId) navigations++;
    if (method === 'Network.requestWillBeSent') requests.push(params.request.url);
    if (method === 'Runtime.exceptionThrown') exceptions.push(params.exceptionDetails);
  });
  connections.push(cdp);
  await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable');
  const evaluate = async (body, connection = cdp) => {
    const result = await connection.call('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const wait = async (body, message, connection = cdp) => {
    for (let i = 0; i < 300; i++) { if (await evaluate(body, connection)) return; await delay(40); }
    assert.fail(message + ': ' + JSON.stringify(exceptions));
  };
  const click = async selector => {
    const point = await evaluate(`const node=${selector};if(!node)throw Error('Missing control');node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const updateButton = "[...document.querySelectorAll('button')].find(n=>['Обновить','Перезагрузить','Обновляем...'].includes(n.textContent))";
  const offer = async () => {
    const response = await fetch(server.origin + '/__qa/version', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    await evaluate('await (await navigator.serviceWorker.getRegistration()).update();');
    await wait(`return !!${updateButton}`, 'Current worker update must be offered');
  };
  const version = () => evaluate(`return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker build reply timeout')),3000);
    const receive=event=>{if(event.data?.type==='build-id'){clearTimeout(timer);navigator.serviceWorker.removeEventListener('message',receive);resolve(event.data.buildId)}};
    navigator.serviceWorker.addEventListener('message',receive);navigator.serviceWorker.controller.postMessage('build-id');});`);
  const artifacts = path.join(root, 'node_modules/.cache/pwa-update-20261026');
  await mkdir(artifacts, { recursive: true });
  const screenshotFolder = await mkdtemp(path.join(artifacts, 'run-'));
  t.diagnostic('Screenshots: ' + path.relative(root, screenshotFolder));
  const screenshot = async name => {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(screenshotFolder, name + '.png'), Buffer.from(data, 'base64'));
  };
  await cdp.call('Page.navigate', { url: server.origin + '/appointments?fixturePurpose=mortgage_leads&fixtureRole=admin' });
  await wait('return navigator.serviceWorker?.controller?.state===\'activated\' && !![...document.querySelectorAll("button")].find(n=>n.textContent===\'Новая встреча\'&&!n.disabled)', 'Initial app and fully activated controller must load');
  await t.test('first installation is silent and only a shell cache exists', async () => {
    assert.equal(await version(), 'qa-pwa-1');
    assert.equal(await evaluate(`return !!${updateButton}`), false);
    assert.deepEqual(await evaluate('return (await caches.keys()).sort()'), ['medina-active-shell', 'medina-shell-qa-pwa-1']);
  });
  // Vite may finish dependency optimization with an initial development reload.
  // Compare worker operations to the loaded fixture, not that dev-server count.
  const initialNavigations = navigations;
  await click("[...document.querySelectorAll('button')].find(n=>n.textContent==='Новая встреча')");
  await wait('return !!document.querySelector("input[id$=\'-title\']")', 'Actual meeting editor must open');
  await evaluate(`const node=document.querySelector("input[id$='-title']");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'QA draft retained across worker activation');node.dispatchEvent(new Event('input',{bubbles:true}));`);
  await offer();
  await t.test('waiting worker does not reload or clear a real meeting editor', async () => {
    assert.equal(await version(), 'qa-pwa-1'); assert.equal(navigations, initialNavigations);
    assert.equal(await evaluate('return document.querySelector("input[id$=\'-title\']").value'), 'QA draft retained across worker activation');
  });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait('return !document.querySelector("[role=dialog]")', 'Meeting editor must be dismissed before banner hit-testing');
  for (const [width, height] of [[375, 640], [390, 812], [768, 900], [1023, 768], [1024, 900], [1440, 900]]) {
    await t.test(`${width}x${height}: update and every bottom-nav button are unobscured`, async () => {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
      const geometry = await evaluate(`const button=${updateButton},nav=document.querySelector('.mobile-bottom-nav'),r=button.getBoundingClientRect();
        const controls=[button,...(getComputedStyle(nav).display==='none'?[]:nav.querySelectorAll('button'))];
        return{width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,
          button:{top:r.top,bottom:r.bottom},navTop:getComputedStyle(nav).display==='none'?null:nav.getBoundingClientRect().top,
          visible:controls.map(n=>{const b=n.getBoundingClientRect();return{label:n.getAttribute('aria-label')||n.textContent,hit:n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),inside:b.x>=0&&b.right<=innerWidth&&b.y>=0&&b.bottom<=innerHeight}})};`);
      t.diagnostic(JSON.stringify(geometry));
      await screenshot(`banner-${width}`);
      assert.equal(geometry.overflow, false);
      for (const control of geometry.visible) { assert.equal(control.hit, true, control.label); assert.equal(control.inside, true, control.label); }
      if (geometry.navTop !== null) assert.ok(geometry.button.bottom + 8 <= geometry.navTop, 'Update must stay clear of compact navigation');
    });
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('input[aria-label="ТЕСТ: несохранённый текст"]').value='QA guarded draft';`);
  await click("document.getElementById('qa-protect-draft')");
  await click(updateButton);
  for (let i = 0; i < 150 && !dialogs.length; i++) await delay(40);
  assert.equal(dialogs.at(-1)?.type, 'beforeunload', 'Native browser must offer cancellation');
  await cdp.call('Page.handleJavaScriptDialog', { accept: false });
  await t.test('cancelling a native reload keeps the draft and offers a usable retry', async () => {
    await delay(1200);
    assert.equal(navigations, initialNavigations); assert.equal(await version(), 'qa-pwa-2');
    assert.equal(await evaluate('return document.querySelector(\'input[aria-label="ТЕСТ: несохранённый текст"]\').value'), 'QA guarded draft');
    assert.equal(await evaluate(`const b=${updateButton};return b?.textContent`), 'Перезагрузить');
    assert.equal(await evaluate(`return ${updateButton}?.disabled`), false);
    await screenshot('reload-cancelled');
  });
  // Release only the synthetic beforeunload guard, then explicitly request a retry.
  await click("document.getElementById('qa-protect-draft')");
  const beforeRetry = navigations;
  await click(updateButton);
  await wait(`return !!document.querySelector('input[aria-label="ТЕСТ: несохранённый текст"]') && !(${updateButton})`, 'Explicit retry must load the latest shell');
  assert.equal(navigations, beforeRetry + 1); assert.equal(await version(), 'qa-pwa-2');
  await click("[...document.querySelectorAll('button')].find(n=>n.textContent==='Новая встреча')");
  await evaluate(`const n=document.querySelector("input[id$='-title']");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'QA draft survives another tab');n.dispatchEvent(new Event('input',{bubbles:true}));`);
  await offer();
  const newTarget = await cdp.call('Target.createTarget', { url: server.origin + '/appointments?fixturePurpose=mortgage_leads&fixtureRole=admin' });
  const otherTarget = (await targets()).find(value => value.id === newTarget.targetId); assert.ok(otherTarget);
  const other = await connect(otherTarget.webSocketDebuggerUrl, () => {}); connections.push(other);
  await wait('return !!navigator.serviceWorker?.controller && !!document.querySelector("h1")', 'Second owned tab must load', other);
  const beforeForeign = navigations;
  await evaluate(`const r=await navigator.serviceWorker.getRegistration();if(!r.waiting)throw Error('Expected third waiting version');r.waiting.postMessage('skip-waiting');`, other);
  await wait(`return ${updateButton}?.textContent==='Перезагрузить'`, 'Foreign activation must offer reload only');
  // controllerchange can precede completion of activation waitUntil/cleanup.
  await wait("return navigator.serviceWorker.controller?.state==='activated'", 'Third worker must finish activation before inspecting eviction');
  await t.test('another real tab activation leaves the original draft and old shell untouched', async () => {
    assert.equal(navigations, beforeForeign); assert.equal(await version(), 'qa-pwa-3');
    assert.equal(await evaluate('return document.querySelector("input[id$=\'-title\']").value'), 'QA draft survives another tab');
    const cacheNames = await evaluate('return await caches.keys()');
    assert.deepEqual(cacheNames.sort(), ['medina-active-shell', 'medina-shell-qa-pwa-3']);
    t.diagnostic('Observed shell caches after activation: ' + JSON.stringify(cacheNames));
  });
  await cdp.call('Target.closeTarget', { targetId: newTarget.targetId });
  const unexpected = requests.filter(value => {
    if (value.startsWith('data:image/')) return false; // Embedded native date-picker icon, no transport.
    const url = new URL(value), own = new URL(server.origin);
    return url.hostname !== own.hostname || url.port !== own.port || !['http:', 'ws:'].includes(url.protocol);
  });
  assert.deepEqual(unexpected, [], 'Only owned HTTP and its Vite websocket may be requested');
  assert.deepEqual(exceptions, []);
});
