import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPortalDesignFixture } from './portal-design-browser.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(url, onEvent) {
  const ws = new WebSocket(url), pending = new Map(); let sequence = 0, closed = false;
  ws.addEventListener('message', event => {
    const value = JSON.parse(String(event.data));
    if (!value.id) { onEvent(value.method, value.params); return; }
    const item = pending.get(value.id); if (!item) return;
    pending.delete(value.id); clearTimeout(item.timer);
    value.error ? item.reject(Error(JSON.stringify(value.error))) : item.resolve(value.result);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Owned CDP connect timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Owned CDP connection failed')); }, { once: true });
  });
  return {
    call(method, params = {}) {
      if (closed) return Promise.reject(Error('Owned debugging connection is closed'));
      return new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, method === 'Page.navigate' ? 90000 : 20000);
        pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { closed = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Closed')); } pending.clear(); ws.close(); },
  };
}

test('actual portals: owned headless screenshots, navigation, states and console at 375/1440', { timeout: 600000 }, async t => {
  const executable = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync);
  assert.ok(executable, 'An already-installed browser is required; no download or install is permitted');
  const output = await mkdtemp(path.join(tmpdir(), 'medina-portal-design-render-'));
  const profile = path.join(output, 'owned-empty-profile'); await mkdir(profile);
  const server = await createPortalDesignFixture(0);
  assert.notEqual(new URL(server.origin).port, '5290');
  console.log(`Owned temporary fixture: ${server.origin}\nPortal screenshots/report: ${output}`);
  const report = { origin: server.origin, executable, browserPid: null, screenshots: [], layouts: [], console: [], exceptions: [], requests: [], blocked: [], failedRequests: [] };
  const browser = spawn(executable, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-component-update',
    '--disable-domain-reliability', '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication,Translate',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'DISPLAY'].includes(key))) });
  report.browserPid = browser.pid;
  const exited = new Promise(resolve => { browser.once('exit', resolve); browser.once('error', resolve); });
  let cdp;
  t.after(async () => {
    if (cdp) {
      try { const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path.join(output, 'last-state.png'), Buffer.from(result.data, 'base64')); } catch {}
      await cdp.call('Browser.close').catch(() => {});
    }
    await Promise.race([exited, delay(5000)]);
    if (browser.exitCode === null && browser.signalCode === null) { browser.kill(); await Promise.race([exited, delay(5000)]); }
    cdp?.close(); await server.close();
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(output));
    assert.ok(path.basename(output).startsWith('medina-portal-design-render-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port;
  for (let n = 0; n < 250; n++) {
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; } catch {}
    if (/^\d+$/.test(port || '')) break;
    if (browser.exitCode !== null) assert.fail('Owned browser exited before debugging was available');
    await delay(80);
  }
  assert.match(port || '', /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
  cdp = await connect(targets.find(target => target.type === 'page').webSocketDebuggerUrl, (method, params) => {
    if (method === 'Runtime.exceptionThrown') report.exceptions.push(params.exceptionDetails);
    if (method === 'Runtime.consoleAPICalled') report.console.push({ type: params.type, text: params.args.map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 2000) });
    if (method === 'Log.entryAdded') report.console.push({ type: params.entry.level, text: params.entry.text.slice(0, 2000) });
    if (method === 'Network.requestWillBeSent') report.requests.push(params.request.url);
    if (method === 'Network.loadingFailed') report.failedRequests.push(params);
    if (method === 'Page.javascriptDialogOpening') void cdp.call('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    if (method === 'Fetch.requestPaused') {
      const allowed = params.request.url.startsWith(server.origin + '/') || params.request.url.startsWith('data:');
      if (!allowed) report.blocked.push(params.request.url);
      void cdp.call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  });
  for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await cdp.call(domain + '.enable');
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const evaluate = async body => {
    const value = await cdp.call('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails)); return value.result.value;
  };
  const wait = async (body, timeout = 60000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (t.signal.aborted) throw Error('Owned rendering test was cancelled'); if (await evaluate(body)) return; await delay(60); }
    assert.fail(`Wait failed: ${body}\n${JSON.stringify(report.exceptions)}\n${await evaluate('return document.body.innerText;')}`);
  };
  const click = async text => evaluate(`const button=[...document.querySelectorAll('button')].find(element=>element.textContent.trim()===${JSON.stringify(text)});if(!button||button.disabled)throw Error('Missing enabled production button: '+${JSON.stringify(text)});button.click();`);
  const navigate = async (view, state = 'ready') => {
    const route = `${view === 'operator' ? '/operator' : '/contributors'}?mode=${view}&state=${state}`;
    await cdp.call('Page.navigate', { url: server.origin + route });
    await wait('return !!window.__portalDesignQA && !!document.querySelector(".portal-workspace h1");');
    if (state === 'error') await wait('return document.body.innerText.includes("Тестовая ошибка загрузки");');
    else {
      const surface = view === 'operator' ? 'Рабочие заявки оператора' : view === 'creator' ? 'Задания авторов' : 'Партнёрская статистика';
      await wait(`return !!document.querySelector('[aria-label="${surface}"]');`);
      if (view === 'operator' && state === 'ready') await wait(`return !!document.querySelector('[aria-label="Заявки оператора"]')&&window.__portalDesignQA.calls.some(call=>call.path.startsWith('/api/crm/operator-leads?'));`);
      if (view === 'creator') await wait(`return document.querySelector('.portal-mode-tabs button[aria-pressed="true"]')?.textContent.trim()==='Автор контента';`);
      await wait('return !document.body.innerText.includes("Загружаем");');
    }
    await evaluate('await document.fonts.ready;'); await delay(150);
  };
  const capture = async name => {
    await wait('return [...document.images].every(image=>image.complete);');
    await evaluate('window.scrollTo(0,0);await document.fonts.ready;');
    const layout = await evaluate(`return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,title:document.querySelector('h1')?.textContent,
      inter:getComputedStyle(document.body).fontFamily.includes('Inter')&&[...document.fonts].some(font=>font.family.includes('Inter')&&font.status==='loaded'),
      brokenImages:[...document.images].filter(image=>!image.complete||image.naturalWidth===0).map(image=>image.src),
      overflowingText:[...document.querySelectorAll('button,select')].filter(element=>element.getBoundingClientRect().width>0&&element.scrollWidth>element.clientWidth+2).map(element=>element.textContent.trim())};`);
    report.layouts.push({ name, ...layout });
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(output, name + '.png'); await writeFile(file, Buffer.from(screenshot.data, 'base64')); report.screenshots.push(file);
    console.log('Screenshot ready: ' + file);
    assert.ok(layout.scrollWidth <= layout.width, `Horizontal overflow: ${name}: ${JSON.stringify(layout)}`);
    assert.equal(layout.inter, true, `Local Inter font: ${name}`);
    assert.deepEqual(layout.brokenImages, [], `Broken images: ${name}`);
    assert.deepEqual(layout.overflowingText, [], `Clipped control text: ${name}`);
  };

  const assertIsolation = () => {
    assert.deepEqual(report.exceptions, [], 'No uncaught browser exceptions');
    assert.deepEqual(report.console.filter(entry => entry.type === 'error'), [], 'No browser console errors');
    assert.deepEqual(report.blocked, [], 'No attempted external requests');
    assert.ok(report.requests.every(url => url.startsWith(server.origin + '/') || url.startsWith('data:')), 'Only owned loopback assets');
    assert.ok(!report.requests.some(url => url.startsWith(server.origin + '/api/')), 'All API calls stay in memory');
  };
  const hotOnly = process.argv.includes('--hot-only');
  for (const state of hotOnly ? ['ready'] : ['ready', 'empty', 'error']) for (const view of ['partner', 'creator', 'operator']) for (const width of [375, 1440]) {
    if (t.signal.aborted) break;
    await t.test(`${view} ${state} ${width}`, async () => {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 900 : 1000, deviceScaleFactor: 1, mobile: width === 375 });
      await navigate(view, state); await capture(`${view}-${state}-${width}`);
    });
  }
  await t.test('production brand links stay in the actor portal and reset its active section', async () => {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const view of ['operator', 'partner']) {
      await navigate(view);
      const href = view === 'operator' ? '/operator' : '/contributors';
      const actor = await evaluate('return window.__portalDesignQA.snapshot().actor;');
      assert.equal(await evaluate(`return document.querySelector('.portal-sidebar .portal-brand').getAttribute('href');`), href);
      const profileLabel = await evaluate(`return [...document.querySelectorAll('.portal-sidebar nav button')].find(element=>/профиль/i.test(element.textContent)).textContent.trim();`);
      await click(profileLabel);
      await wait(`return document.querySelector('.portal-sidebar nav button[aria-current="page"]')?.textContent.trim()===${JSON.stringify(profileLabel)};`);
      await evaluate(`document.querySelector('.portal-sidebar .portal-brand').click();`);
      const surface = view === 'operator' ? 'Рабочие заявки оператора' : 'Партнёрская статистика';
      await wait(`return location.pathname===${JSON.stringify(href)}&&!!document.querySelector('[aria-label="${surface}"]');`);
      assert.equal(await evaluate('return window.__portalDesignQA.snapshot().actor;'), actor);
    }
  });
  await t.test('mobile native status select filters the same real creator job state', async () => {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: true });
    await navigate('creator');
    assert.equal(await evaluate(`const select=document.querySelector('select[aria-label="Статус заданий на текущей странице"]');return !!select&&select.getBoundingClientRect().width>0;`), true);
    const actor = await evaluate('return window.__portalDesignQA.snapshot().actor;');
    for (const [value, title] of [['in_progress', 'Reels для студии'], ['submitted', 'Обзор пространства'], ['changes_requested', 'Фото для каталога']]) {
      await evaluate(`const select=document.querySelector('select[aria-label="Статус заданий на текущей странице"]');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));`);
      await wait(`const buttons=[...document.querySelectorAll('button[aria-label^="Открыть задание:"]')];return buttons.length===1&&buttons[0].getAttribute('aria-label')===${JSON.stringify('Открыть задание: ' + title)};`);
    }
    await capture('creator-status-select-375');
    await evaluate(`const select=document.querySelector('select[aria-label="Статус заданий на текущей странице"]');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));`);
    await wait(`return document.querySelectorAll('button[aria-label^="Открыть задание:"]').length===3;`);
    assert.equal(await evaluate('return window.__portalDesignQA.snapshot().actor;'), actor);
  });
  if (hotOnly) { assertIsolation(); return; }
  await t.test('production mode and sidebar navigation retain the same contributor identity', async () => {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await navigate('partner');
    await wait(`return !!document.querySelector('[aria-label="Партнёрская статистика"]');`);
    const owner = await evaluate('return window.__portalDesignQA.snapshot();');
    await click('Автор контента'); await wait(`return !!document.querySelector('[aria-label="Задания авторов"]');`);
    assert.deepEqual(await evaluate('return window.__portalDesignQA.snapshot();'), owner);
    await click('Партнёр'); await wait(`return !!document.querySelector('[aria-label="Партнёрская статистика"]');`);
    const labels = await evaluate(`return [...document.querySelectorAll('.portal-sidebar nav button')].map(element=>element.textContent.trim());`);
    for (const label of labels) {
      await click(label);
      await wait(`return document.querySelector('.portal-sidebar nav button[aria-current="page"]')?.textContent.trim()===${JSON.stringify(label)};`);
      if (label === 'Профиль' || label === 'Мой профиль') await wait(`return document.body.innerText.includes('Автор контента')&&document.body.innerText.includes('Партнёр');`);
      if (label === 'Код и условия') await wait(`return !!document.querySelector('[aria-label="Условия партнёрства"]');`);
    }
    assert.deepEqual(await evaluate('return window.__portalDesignQA.snapshot();'), owner);
    await capture('partner-profile-navigation-1440');
  });
  await t.test('operator toggle lives in production profile, not default work view', async () => {
    await navigate('operator');
    assert.equal(await evaluate(`return !![...document.querySelectorAll('label')].find(element=>element.textContent.includes('Принимаю предложения клиник'));`), false);
    const label = await evaluate(`return [...document.querySelectorAll('.portal-sidebar nav button')].find(element=>/профиль/i.test(element.textContent)).textContent.trim();`);
    await click(label); await wait(`return !![...document.querySelectorAll('label')].find(element=>element.textContent.includes('Принимаю предложения клиник'));`);
    await evaluate(`document.querySelector('input[type="checkbox"]').click();`);
    await wait(`return window.__portalDesignQA.calls.some(call=>call.method==='PATCH'&&call.path==='/api/crm/operator-account'&&call.body.acceptingRequests===true)&&document.querySelector('input[type="checkbox"]').checked;`);
    await capture('operator-profile-toggle-1440');
  });
  await t.test('operator default workday and cooperation requests are separate real navigation views', async () => {
    await navigate('operator');
    const owner = await evaluate('return window.__portalDesignQA.snapshot();');
    const workLabel = await evaluate(`return document.querySelector('.portal-sidebar nav button[aria-current="page"]').textContent.trim();`);
    assert.equal(await evaluate(`return !!document.querySelector('[aria-label="Заявки оператора"]')&&!document.querySelector('[aria-label="Предложения о сотрудничестве"]');`), true);
    await click('Сотрудничество'); await wait(`return !!document.querySelector('[aria-label="Предложения о сотрудничестве"]');`);
    assert.equal(await evaluate(`return !!document.querySelector('[aria-label="Рабочие заявки оператора"]');`), false);
    await capture('operator-cooperations-1440');
    await click(workLabel); await wait(`return !!document.querySelector('[aria-label="Заявки оператора"]');`);
    assert.deepEqual(await evaluate('return window.__portalDesignQA.snapshot();'), owner);
  });
  await t.test('mobile production drawer opens and closes through actual navigation', async () => {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: true });
    await navigate('operator'); await evaluate(`document.querySelector('button[aria-label="Открыть меню"]').click();`);
    await wait(`return !!document.querySelector('[role="dialog"] nav');`); await capture('operator-drawer-375');
    await evaluate(`document.querySelector('[role="dialog"] nav button').click();`); await wait(`return !document.querySelector('[role="dialog"]');`);
  });
  await t.test('fixture URL states recover explicitly and production sign-out uses only synthetic auth', async () => {
    await navigate('creator', 'error');
    await evaluate(`window.__portalDesignQA.navigateView('creator','ready');`);
    await wait(`return !!document.querySelector('button[aria-label^="Открыть задание:"]');`);
    assert.equal(await evaluate(`return window.__portalDesignQA.snapshot().actor;`), '33333333-3333-4333-8333-333333333333');
    await evaluate(`document.querySelector('button[aria-label="Открыть меню"]').click();`);
    await wait(`return !!document.querySelector('[role="dialog"] button[aria-label="Выйти из аккаунта"]');`);
    await evaluate(`document.querySelector('[role="dialog"] button[aria-label="Выйти из аккаунта"]').click();`);
    await wait(`return window.__portalDesignQA.session()===null&&!!document.querySelector('input[type="password"]');`);
    assert.equal(await evaluate(`return !!document.querySelector('[aria-label="Задания авторов"]');`), false);
  });
  assertIsolation();
});
