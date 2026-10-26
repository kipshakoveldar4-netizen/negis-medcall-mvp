import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContributorFixture } from './contributor-browser.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(url, onEvent) {
  const ws = new WebSocket(url), pending = new Map(); let sequence = 0;
  ws.addEventListener('message', event => {
    const data = JSON.parse(String(event.data));
    if (!data.id) { onEvent(data.method, data.params); return; }
    const item = pending.get(data.id); if (!item) return;
    pending.delete(data.id); clearTimeout(item.timer);
    if (data.error) item.reject(Error(JSON.stringify(data.error))); else item.resolve(data.result);
  });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('CDP connect timeout')), 10_000); ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('CDP connect failed')); }, { once: true }); });
  return { call(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 20_000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); }); }, close() { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(Error('Closed')); } pending.clear(); ws.close(); } };
}
test('contributor intake and independent platform review in real React, isolated browser', { timeout: 180_000 }, async t => {
  const executable = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync);
  assert.ok(executable, 'Installed browser required, no download');
  const server = await createContributorFixture();
  const profile = await mkdtemp(path.join(tmpdir(), 'medina-contributor-owned-'));
  const outBase = path.join(root, 'node_modules/.cache/contributor-browser'); await mkdir(outBase, { recursive: true });
  const output = await mkdtemp(path.join(outBase, 'run-'));
  const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-component-update', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'DISPLAY'].includes(key))) });
  const exited = new Promise(resolve => { browser.once('exit', resolve); browser.once('error', resolve); });
  let cdp;
  t.after(async () => {
    if (cdp) await cdp.call('Browser.close').catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (browser.exitCode === null && browser.signalCode === null) { browser.kill(); await Promise.race([exited, delay(5000)]); }
    cdp?.close(); await server.close();
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('medina-contributor-owned-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port;
  for (let n = 0; n < 250; n++) { try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; } catch {} if (/^\d+$/.test(port || '')) break; await delay(80); }
  assert.match(port || '', /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const exceptions = [], requests = [];
  cdp = await connect(targets.find(item => item.type === 'page').webSocketDebuggerUrl, (method, params) => {
    if (method === 'Runtime.exceptionThrown') exceptions.push(params.exceptionDetails);
    if (method === 'Network.requestWillBeSent') requests.push(params.request.url);
    if (method === 'Page.javascriptDialogOpening') void cdp.call('Page.handleJavaScriptDialog', { accept: true });
  });
  for (const domain of ['Page', 'Runtime', 'Network']) await cdp.call(domain + '.enable');
  const evaluate = async body => { const value = await cdp.call('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true }); assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails)); return value.result.value; };
  const wait = async body => { for (let n = 0; n < 300; n++) { if (await evaluate(body)) return; await delay(40); } assert.fail('Wait failed: ' + body + '\n' + JSON.stringify(exceptions)); };
  const clickText = async text => {
    const point = await evaluate(`const el=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!el||el.disabled)throw Error('Missing enabled button');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const navigate = async pathname => { await cdp.call('Page.navigate', { url: server.origin + pathname }); await wait('return !!window.__contributorQA && !!document.querySelector("h1");'); };
  const fill = async name => evaluate(`const input=document.querySelector('input:not([type=checkbox])');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}));`);
  const screenshot = async name => { const image = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path.join(output, name), Buffer.from(image.data, 'base64')); };
  await t.test('both roles apply once and persist after refresh, without customer or payout data', async () => {
    await navigate('/contributors'); await wait('return !!document.querySelector("input:not([type=checkbox])");');
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 375 });
      await evaluate('await document.fonts.ready;');
      assert.equal(await evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true);
      await screenshot(`application-${width}.png`);
    }
    assert.equal(await evaluate('return document.querySelectorAll("input[type=checkbox]:checked").length;'), 2);
    await fill('QA Both Roles'); await clickText('Подать заявку');
    await wait('return document.body.innerText.includes("QA Both Roles") && document.querySelectorAll("article").length===2;');
    assert.equal(await evaluate('return document.body.innerText.split("На рассмотрении").length-1;'), 2);
    await evaluate(`document.querySelector('button[aria-label="Обновить профиль"]').click();`);
    await wait('return document.querySelectorAll("article").length===2;');
    assert.equal(await evaluate('return window.__contributorQA.calls.filter(c=>c.method==="POST").length;'), 1);
  });
  await t.test('375 and 1440 layouts fit with visible working controls and real local font', async () => {
    await navigate('/contributors?seed=1'); await wait('return document.querySelectorAll("article").length===2;');
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 375 });
      await evaluate('await document.fonts.ready;');
      assert.equal(await evaluate('return getComputedStyle(document.body).fontFamily.includes("Inter") && [...document.fonts].some(f=>f.family.includes("Inter")&&f.status==="loaded");'), true);
      assert.equal(await evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true);
      assert.equal(await evaluate('return [...document.querySelectorAll("button")].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height>=30});'), true);
      await screenshot(`blogger-${width}.png`);
    }
  });
  await t.test('late A response cannot restore its form in B or downgrade returned A', async () => {
    await navigate('/contributors'); await wait('return !!document.querySelector("input:not([type=checkbox])");');
    await evaluate('window.__contributorQA.holdNext();'); await fill('QA Held A'); await clickText('Подать заявку');
    await wait('return window.__contributorQA.calls.some(c=>c.method==="POST");');
    await evaluate('window.__contributorQA.switchActor("blogger-b");'); await wait('return !!document.querySelector("input:not([type=checkbox])");');
    assert.equal(await evaluate('return document.body.innerText.includes("QA Held A");'), false);
    await evaluate('const qa=window.__contributorQA;const old=qa.profiles.get("blogger-a");qa.profiles.set("blogger-a",{...old,partnerStatus:"approved",creatorStatus:"approved"});qa.switchActor("blogger-a");');
    await wait('return document.body.innerText.split("Одобрено").length-1===2;');
    await evaluate('window.__contributorQA.release();'); await delay(200);
    assert.equal(await evaluate('return document.body.innerText.includes("На рассмотрении");'), false);
  });
  await t.test('maximum-length unbroken profile name cannot overflow a 375px view', async () => {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: true });
    await evaluate(`const qa=window.__contributorQA;const p=qa.profiles.get("blogger-a");qa.profiles.set("blogger-a",{...p,displayName:"А".repeat(120)});document.querySelector('button[title="Обновить профиль"]').click();`);
    await wait('return document.querySelector("h2")?.textContent.length===120;');
    assert.equal(await evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true);
  });
  await t.test('actual Control app reviews roles independently and suspends one without the other', async () => {
    await navigate('/review?seed=1'); await clickText('Блогеры');
    await wait('return document.querySelectorAll(".operator-row").length===1;');
    await clickText('Одобрить заявку'); await wait('return document.body.innerText.includes("Партнёр: Одобрено");');
    assert.equal(await evaluate('return document.body.innerText.includes("Автор контента: На рассмотрении");'), true);
    await clickText('Одобрить заявку'); await wait('return document.body.innerText.includes("Автор контента: Одобрено");');
    await clickText('Отозвать одобрение'); await wait('return document.body.innerText.includes("Партнёр: Приостановлено");');
    assert.equal(await evaluate('return document.body.innerText.includes("Автор контента: Одобрено");'), true);
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 375 });
      assert.equal(await evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true);
      await screenshot(`review-${width}.png`);
    }
  });
  await t.test('account change during review clears old platform list and prevents late publication', async () => {
    await evaluate('window.__contributorQA.holdNext();'); await clickText('Одобрить заявку');
    await wait('return window.__contributorQA.calls.filter(c=>c.method==="PATCH").length===4;');
    await evaluate('window.__contributorQA.switchActor("blogger-b");');
    await wait('return !document.querySelector(".operator-row");');
    await evaluate('window.__contributorQA.release();'); await delay(200);
    assert.equal(await evaluate('return !!document.querySelector(".operator-row");'), false);
  });
  await t.test('no real auth, database, providers or external portfolio fetches', async () => {
    assert.deepEqual(exceptions, []);
    assert.ok(requests.every(url => url.startsWith(server.origin + '/') || url.startsWith('data:')), requests.filter(url => !url.startsWith(server.origin)));
    assert.equal(requests.some(url => /\/api\/|supabase|facebook|telegram/.test(url)), false);
  });
  process.stdout.write(`Contributor screenshots: ${output}\n`);
});
