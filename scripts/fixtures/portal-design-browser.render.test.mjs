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
      if (view === 'operator' && state === 'ready') await wait(`return !!document.querySelector('[aria-label="Заявки оператора"]')&&window.__portalDesignQA.calls.some(call=>call.path==='/api/crm/operator-lead-search');`);
      if (view === 'creator') await wait(`return document.querySelector('.portal-mode-tabs button[aria-pressed="true"]')?.textContent.trim()==='Автор контента';`);
      await wait('return !document.body.innerText.includes("Загружаем");');
    }
    await evaluate('await document.fonts.ready;'); await delay(150);
  };
  const capture = async (name, scrollSelector) => {
    await wait('return [...document.images].every(image=>image.complete);');
    await evaluate(`${scrollSelector ? `document.querySelector(${JSON.stringify(scrollSelector)}).scrollIntoView({block:'start'});` : 'window.scrollTo(0,0);'}await document.fonts.ready;`);
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
      await navigate(view, state);
      if (view === 'partner' && state === 'ready') {
        await wait(`return !!document.querySelector('output[aria-label="Партнёрская ссылка"]');`);
        assert.equal(await evaluate(`return document.querySelector('output[aria-label="Партнёрская ссылка"]').textContent;`), 'https://entry.fixture.invalid/r/' + 'A'.repeat(32));
        if (width === 1440) assert.equal(await evaluate(`const row=document.querySelector('.ph-table tbody tr');return !!row&&row.getBoundingClientRect().bottom<innerHeight;`), true, 'Partner link must not push the whole history below the first desktop viewport');
      }
      await capture(`${view}-${state}-${width}`);
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
  await t.test('partner confirmation history filters UTC months and resets without financial writes at 375/1440', async () => {
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 900 : 1000, deviceScaleFactor: 1, mobile: width === 375 });
      await navigate('partner');
      await wait(`return !!document.querySelector('.ph-table tbody tr')&&!!document.querySelector('.ph-cards li');`);
      assert.equal(await evaluate(`return document.querySelectorAll('.ph-table tbody tr').length;`), 3);
      assert.equal(await evaluate(`return getComputedStyle(document.querySelector('.ph-table-wrap')).display!=='none';`), width === 1440);
      assert.equal(await evaluate(`return getComputedStyle(document.querySelector('.ph-cards')).display!=='none';`), width === 375);
      await evaluate(`const input=document.querySelector('.ph-month input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'2026-10');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));`);
      await wait(`return document.querySelectorAll('.ph-table tbody tr').length===2&&document.querySelector('.ph-heading p')?.textContent==='За 2026-10';`);
      await capture(`partner-october-${width}`);
      await evaluate(`document.querySelector('.partner-history').scrollIntoView({block:'start'});`);
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(output, `partner-history-filter-${width}.png`); await writeFile(file, Buffer.from(screenshot.data, 'base64')); report.screenshots.push(file);
      await evaluate(`document.querySelector('button[aria-label="Показать историю за всё время"]').click();`);
      await wait(`return document.querySelectorAll('.ph-table tbody tr').length===3&&document.querySelector('.ph-heading p')?.textContent==='За всё время';`);
      assert.equal(await evaluate(`return window.__portalDesignQA.calls.filter(call=>call.path.startsWith('/api/crm/partner-history')).every(call=>call.method==='GET'&&!call.body);`), true);
    }
  });
  await t.test('creator nearest deadline opens the existing job detail and closes at 375/1440', async () => {
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 900 : 1000, deviceScaleFactor: 1, mobile: width === 375 });
      await navigate('creator');
      await wait(`return !!document.querySelector('.creator-deadline');`);
      await evaluate(`document.querySelector('.creator-deadline').click();`);
      await wait(`return window.__portalDesignQA.calls.some(call=>call.path.startsWith('/api/crm/creator-job-detail?'))&&!!document.querySelector('[aria-label="Карточка задания"]');`);
      await evaluate(`document.querySelector('[aria-label="Карточка задания"]').scrollIntoView({block:'start'});`);
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(output, `creator-deadline-detail-${width}.png`); await writeFile(file, Buffer.from(screenshot.data, 'base64')); report.screenshots.push(file);
      await evaluate(`document.querySelector('[aria-label="Карточка задания"] button[aria-label="Закрыть карточку"]').click();`);
      await wait(`return !document.querySelector('[aria-label="Карточка задания"]');`);
    }
  });
  await t.test('operator global search, complete group counts, company filtering and real lead cards at 375/1440', async () => {
    const root = '[aria-label="Заявки оператора"]';
    const totals = { all: 34, new: 22, in_progress: 6, booked: 1, postponed: 3, lost: 1, other: 1 };
    const firstRequest = '00000000-0000-4000-8000-000000000801', secondRequest = '00000000-0000-4000-8000-000000000806';
    const visibleRows = `const root=document.querySelector(${JSON.stringify(root)});const rows=[...(root?.querySelectorAll('[data-lead-id]')||[])].filter(element=>element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0);`;
    const rows = () => evaluate(`${visibleRows}return rows.map(element=>({id:element.dataset.leadId,text:element.innerText}));`);
    const waitPage = async (expected, count, counts = totals) => {
      const query = { search: '', group: 'all', requestId: null, offset: 0, ...expected };
      await wait(`${visibleRows}
        const call=window.__portalDesignQA.calls.filter(call=>call.path==='/api/crm/operator-lead-search').at(-1);
        const query=call?.body;
        return !!root&&call?.method==='POST'&&!!query&&query.search===${JSON.stringify(query.search)}&&query.group===${JSON.stringify(query.group)}
          &&query.requestId===${JSON.stringify(query.requestId)}&&query.offset===${JSON.stringify(query.offset)}
          &&rows.length===${count}&&root.getAttribute('aria-busy')==='false'&&root.querySelector('[data-lead-group="${query.group}"]')?.getAttribute('aria-pressed')==='true';`);
      assert.deepEqual(await evaluate(`return Object.fromEntries([...document.querySelectorAll(${JSON.stringify(root + ' [data-lead-group]')})].map(button=>[button.dataset.leadGroup,Number(button.textContent.match(/[0-9]+/g)?.at(-1))]));`), counts);
      assert.equal(await evaluate(`return document.querySelectorAll(${JSON.stringify(root + ' [data-lead-group][aria-pressed="true"]')}).length;`), 1);
      assert.equal(await evaluate(`return window.__portalDesignQA.calls.filter(call=>call.path.startsWith('/api/crm/operator-lead-search')).every(call=>call.path==='/api/crm/operator-lead-search'&&call.method==='POST'&&call.body!==null);`), true);
      return rows();
    };
    const action = async selector => evaluate(`const button=document.querySelector(${JSON.stringify(root)})?.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)throw Error('Missing enabled lead control: '+${JSON.stringify(selector)});button.click();`);
    const group = async value => {
      const mobile = await evaluate(`const select=document.querySelector('select[aria-label="Группа заявок"]');return !!select&&select.getBoundingClientRect().width>0;`);
      if (mobile) await evaluate(`const select=document.querySelector('select[aria-label="Группа заявок"]');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));`);
      else await action(`[data-lead-group="${value}"]`);
    };
    const setCompany = async requestId => evaluate(`const select=document.querySelector('select[aria-label="Компания заявок"]');select.value=${JSON.stringify(requestId)};if(select.selectedIndex<0)throw Error('Company option missing');select.dispatchEvent(new Event('change',{bubbles:true}));`);
    const search = async value => {
      await evaluate(`const input=document.querySelector('input[aria-label="Поиск заявок"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));`);
      await action('button[aria-label="Найти заявки"]');
    };
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 900 : 1000, deviceScaleFactor: 1, mobile: width === 375 });
      await navigate('operator');
      const actor = await evaluate('return window.__portalDesignQA.snapshot().actor;');
      const first = await waitPage({}, 20);
      assert.equal(new Set(first.map(row => row.id)).size, 20);
      assert.equal(await evaluate(`const select=document.querySelector('select[aria-label="Группа заявок"]');return select.getBoundingClientRect().width>0;`), width===375);
      assert.deepEqual(await evaluate(`return Object.fromEntries([...document.querySelector('select[aria-label="Группа заявок"]').options].map(option=>[option.value,Number(option.textContent.match(/[0-9]+/g)?.at(-1))]));`), totals);
      if (width===375) {
        assert.equal(await evaluate(`return document.querySelector('[data-lead-id]').getBoundingClientRect().top<innerHeight;`), true, 'The compact mobile filter leaves the first lead in the initial viewport');
      }
      assert.equal(await evaluate(`return [...document.querySelector('select[aria-label="Компания заявок"]').options].length;`), 3);
      await action('button[aria-label^="Следующая"]');
      const second = await waitPage({ offset: 20 }, 14);
      assert.equal(new Set([...first, ...second].map(row => row.id)).size, 34, 'Page two replaces, never appends or repeats page one');
      assert.equal(await evaluate(`return document.querySelector(${JSON.stringify(root)})?.querySelector('button[aria-label^="Следующая"]').disabled;`), true);
      await capture(`operator-lead-page2-${width}`, root);
      await group('new'); const newFirst = await waitPage({ group: 'new' }, 20);
      await action('button[aria-label^="Следующая"]'); const newSecond = await waitPage({ group: 'new', offset: 20 }, 2);
      assert.equal(new Set([...newFirst, ...newSecond].map(row => row.id)).size, 22);
      await capture(`operator-lead-new-page2-${width}`, root);
      await group('in_progress'); assert.equal((await waitPage({ group: 'in_progress' }, 6)).length, 6);
      await capture(`operator-lead-in-progress-${width}`);
      await group('postponed'); assert.equal((await waitPage({ group: 'postponed' }, 3)).length, 3);
      assert.equal(await evaluate(`return document.querySelector('select[aria-label="Группа заявок"]').value;`), 'postponed');
      await group('all'); await waitPage({}, 20);
      await action('button[aria-label="Следующая страница заявок"]'); await waitPage({ offset: 20 }, 14);
      await setCompany(secondRequest);
      const companyTotals = { all: 17, new: 10, in_progress: 4, booked: 1, postponed: 1, lost: 0, other: 1 };
      const companyRows = await waitPage({ requestId: secondRequest }, 17, companyTotals);
      assert.ok(companyRows.every(row => row.text.includes('ТЕСТ O2 Қамқор')));
      await capture(`operator-lead-company-${width}`, root);
      await setCompany(firstRequest); await waitPage({ requestId: firstRequest }, 17,
        { all: 17, new: 12, in_progress: 2, booked: 0, postponed: 2, lost: 1, other: 0 });
      const allOption = await evaluate(`return [...document.querySelector('select[aria-label="Компания заявок"]').options].find(option=>!${JSON.stringify([firstRequest, secondRequest])}.includes(option.value)).value;`);
      await setCompany(allOption); await waitPage({}, 20);
      await action('button[aria-label^="Следующая"]'); await waitPage({ offset: 20 }, 14);
      for (const [term, names, counts] of [
        ['%_', ['ТЕСТ 100%_контакт'], { all: 1, new: 0, in_progress: 0, booked: 1, postponed: 0, lost: 0, other: 0 }],
        ['аЛеКсАнДрА', ['ТЕСТ Александра Соколова'], { all: 1, new: 0, in_progress: 0, booked: 0, postponed: 1, lost: 0, other: 0 }],
        ['қарлығаш', ['ТЕСТ Қарлығаш Әлия'], { all: 1, new: 0, in_progress: 1, booked: 0, postponed: 0, lost: 0, other: 0 }],
        ['+7 (000) 000-09-91', ['ТЕСТ O1 контакт', 'ТЕСТ Қарлығаш Әлия'], { all: 2, new: 1, in_progress: 1, booked: 0, postponed: 0, lost: 0, other: 0 }],
        ['8 (000) 000-09-91', ['ТЕСТ O1 контакт', 'ТЕСТ Қарлығаш Әлия'], { all: 2, new: 1, in_progress: 1, booked: 0, postponed: 0, lost: 0, other: 0 }],
        ['0070000000991', ['ТЕСТ O1 контакт', 'ТЕСТ Қарлығаш Әлия'], { all: 2, new: 1, in_progress: 1, booked: 0, postponed: 0, lost: 0, other: 0 }],
      ]) {
        await search(term); const matches = await waitPage({ search: term }, names.length, counts);
        assert.ok(matches.every((row, index) => row.text.includes(names[index])));
        assert.equal(await evaluate(`return [...document.querySelector('select[aria-label="Компания заявок"]').options].length;`), 3, 'Search never truncates the company manifest');
      }
      await capture(`operator-lead-phone-search-${width}`, root);
      await search(''); await waitPage({}, 20);
      assert.equal(await evaluate(`return document.querySelector('input[aria-label="Поиск заявок"]').value;`), '');
      await action('button[aria-label="Открыть заявку: ТЕСТ O1 контакт"]');
      await wait(`return !!document.querySelector(${JSON.stringify(root + ' [aria-label="Заявка: ТЕСТ O1 контакт"]')});`);
      await action('[aria-label="Заявка: ТЕСТ O1 контакт"] .operator-lead-explorer__booking-button');
      await wait(`return !!document.querySelector(${JSON.stringify(root + ' [aria-label="Запись пациента"]')})&&window.__portalDesignQA.calls.some(call=>call.path==='/api/crm/operator-bookings?requestId=${firstRequest}&leadId=00000000-0000-4000-8000-000000000802');`);
      assert.equal(await evaluate(`return document.querySelector(${JSON.stringify(root)}).innerText.includes('+70000000991');`), true);
      assert.equal(await evaluate(`return !!document.querySelector(${JSON.stringify(root + ' select[aria-label*="Стадия"]')});`), false, 'No synthetic stage write is advertised');
      await capture(`operator-lead-card-${width}`, root + ' [aria-label="Заявка: ТЕСТ O1 контакт"]');
      await action('button[aria-label="Открыть заявку: ТЕСТ O1 контакт"]');
      await wait(`return !document.querySelector(${JSON.stringify(root + ' [aria-label="Заявка: ТЕСТ O1 контакт"]')})&&!document.querySelector(${JSON.stringify(root + ' [aria-label="Запись пациента"]')});`);
      await action('button[aria-label="Открыть заявку: ТЕСТ Қарлығаш Әлия"]');
      await wait(`return !!document.querySelector(${JSON.stringify(root + ' [aria-label="Заявка: ТЕСТ Қарлығаш Әлия"]')});`);
      await action('[aria-label="Заявка: ТЕСТ Қарлығаш Әлия"] .operator-lead-explorer__booking-button');
      await wait(`return !!document.querySelector(${JSON.stringify(root + ' [aria-label="Запись пациента"]')})&&window.__portalDesignQA.calls.some(call=>call.path==='/api/crm/operator-bookings?requestId=${secondRequest}&leadId=60000000-0000-4000-8000-000000000001');`);
      await evaluate(`window.__portalDesignQA.deny();window.dispatchEvent(new Event('focus'));`);
      await wait(`return !document.querySelector('[data-lead-id]')&&!document.querySelector('[aria-label="Запись пациента"]')&&!document.body.innerText.includes('+70000000991');`);
      assert.equal(await evaluate(`return window.__portalDesignQA.snapshot().actor;`), actor);
      assert.equal(await evaluate(`return window.__portalDesignQA.calls.filter(call=>/operator-(leads|bookings|services)/.test(call.path)).every(call=>call.method==='GET'&&call.body===null);`), true);
      await capture(`operator-lead-denied-${width}`);
    }
  });
  await t.test('operator complete totals, company dates, 20+1 paging and missing timezone at 375/1440', async () => {
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 900 : 1000, deviceScaleFactor: 1, mobile: width === 375 });
      await navigate('operator');
      assert.equal(await evaluate(`return [...document.querySelectorAll('h1,h2')].filter(element=>element.textContent==='Мой рабочий день'&&element.getBoundingClientRect().width>10).length;`), 1);
      assert.equal(await evaluate(`return document.querySelector('.operator-workday__visit-more').open;`), false);
      await evaluate(`document.querySelector('.operator-workday__visit-more summary').click();`);
      assert.equal(await evaluate(`const details=document.querySelector('.operator-workday__visit-more');return details.open&&details.querySelector('dl').getBoundingClientRect().height>0&&details.innerText.includes('ТЕСТ O1 услуга');`), true);
      await evaluate(`document.querySelector('.operator-workday__visit-more summary').click();`);
      await evaluate(`document.querySelector('.operator-workday__company-days summary').click();`);
      assert.equal(await evaluate(`return document.querySelector('.operator-workday__company-days').open&&document.querySelector('.operator-workday__company-days li').innerText.includes('UTC');`), true);
      await evaluate(`window.__portalDesignQA.expandWorkday();window.dispatchEvent(new Event('focus'));`);
      await wait(`return document.querySelectorAll('.operator-workday__agenda > li').length===20;`);
      const summary = await evaluate(`return document.querySelector('.operator-workday__metrics').innerText;`);
      await evaluate(`document.querySelector('button[aria-label="Следующая страница записей на сегодня"]').click();`);
      await wait(`return document.querySelectorAll('.operator-workday__agenda > li').length===1&&document.querySelector('.operator-workday__today-footer').innerText.includes('21–21');`);
      assert.equal(await evaluate(`return document.querySelector('button[aria-label="Следующая страница записей на сегодня"]').disabled;`), true);
      assert.equal(await evaluate(`return document.querySelector('.operator-workday__metrics').innerText;`), summary);
      await capture(`operator-today-page2-${width}`);
      await evaluate(`document.querySelector('button[aria-label="Предыдущая страница записей на сегодня"]').click();`);
      await wait(`return document.querySelectorAll('.operator-workday__agenda > li').length===20;`);
      await evaluate(`window.__portalDesignQA.setWorkdayZoneMissing();window.dispatchEvent(new Event('focus'));`);
      await wait(`return document.body.innerText.includes('Записи на сегодня недоступны');`);
      assert.equal(await evaluate(`return !!document.querySelector('.operator-workday__agenda')||!!document.querySelector('.operator-workday__today-totals');`), false);
      assert.equal(await evaluate(`return document.querySelector('.operator-workday__metrics').innerText;`), summary);
      await capture(`operator-timezone-unavailable-${width}`);
    }
  });
  await t.test('operator Today failure clears report data, ended cooperation empties Explorer, denial and sign-out hide private views at 375/1440', async () => {
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 900 : 1000, deviceScaleFactor: 1, mobile: width === 375 });
      await navigate('operator');
      await evaluate(`window.__portalDesignReloadProbe=true;`);
      await cdp.call('Page.reload');
      await wait(`return !window.__portalDesignReloadProbe&&!!window.__portalDesignQA&&document.querySelectorAll('.operator-workday__agenda > li').length===2&&document.querySelector('[aria-label="Заявки оператора"]')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('[data-lead-id]').length===20;`);
      const authorizedLeadIds = await evaluate(`return [...document.querySelectorAll('[data-lead-id]')].map(row=>row.dataset.leadId);`);
      await evaluate(`window.__portalDesignQA.failNext('operator-workday',503);document.querySelector('button[aria-label="Обновить рабочий день"]').click();`);
      await wait(`return !!document.querySelector('.operator-workday > [role="alert"]');`);
      assert.equal(await evaluate(`return !!document.querySelector('.operator-workday__summary')||!!document.querySelector('.operator-workday__metrics')||!!document.querySelector('.operator-workday__agenda')||!!document.querySelector('.operator-workday__today-totals');`), false);
      assert.equal(await evaluate(`const today=document.querySelector('[aria-label="Записи на сегодня"]');return !!today.querySelector('.operator-workday__client,.operator-workday__phone,.operator-workday__visit-details')||['ТЕСТ O1 контакт','+70000000991','ТЕСТ O1 услуга','ТЕСТ O1 специалист'].some(value=>today.innerText.includes(value));`), false, 'Failed Today report retains no visit contacts or details');
      assert.deepEqual(await evaluate(`return [...document.querySelectorAll('[aria-label="Заявки оператора"] [data-lead-id]')].map(row=>row.dataset.leadId);`), authorizedLeadIds, 'Separately authorized lead-search data survives a Today-only failure');
      assert.equal(await evaluate(`return document.querySelector('[aria-label="Заявки оператора"]').innerText.includes('+70000000991');`), true);
      await evaluate(`document.querySelector('button[aria-label="Обновить рабочий день"]').click();`);
      await wait(`return document.querySelectorAll('.operator-workday__agenda > li').length===2;`);
      const leadReadsBeforeEnd = await evaluate(`return window.__portalDesignQA.calls.filter(call=>call.path==='/api/crm/operator-lead-search').length;`);
      await evaluate(`window.__portalDesignQA.endCooperation();window.dispatchEvent(new Event('focus'));`);
      await wait(`const explorer=document.querySelector('[aria-label="Заявки оператора"]');return !!explorer&&explorer.getAttribute('aria-busy')==='false'&&explorer.innerText.includes('Нет доступных компаний.')&&window.__portalDesignQA.calls.filter(call=>call.path==='/api/crm/operator-lead-search').length>${leadReadsBeforeEnd}&&!document.querySelector('.operator-workday__agenda')&&!document.querySelector('[data-lead-id]');`);
      assert.equal(await evaluate(`return document.querySelector('select[aria-label="Компания заявок"]').options.length;`), 1, 'Ended cooperation removes every company from the fresh Explorer manifest');
      assert.deepEqual(await evaluate(`return [...document.querySelectorAll('[aria-label="Заявки оператора"] [data-lead-group]')].map(button=>button.textContent.match(/[0-9]+/g)?.at(-1));`), Array(7).fill('0'));
      assert.equal(await evaluate(`return !!document.querySelector('[aria-label="Заявки оператора"] [role="alert"]')||!!document.querySelector('[aria-label="Запись пациента"]')||document.body.innerText.includes('+70000000991');`), false, 'Approved profile shows a genuine empty result, never stale contacts or an error disguised as zero');
      await capture(`operator-cooperation-ended-${width}`);
      await navigate('operator');
      await evaluate(`window.__portalDesignQA.deny();document.querySelector('button[aria-label="Обновить рабочий день"]').click();`);
      await wait(`return !document.querySelector('.operator-workday__agenda')&&!document.querySelector('[aria-label="Заявки оператора"]')&&!document.querySelector('.operator-workday__metrics');`);
      assert.equal(await evaluate(`return document.body.innerText.includes('+70000000991');`), false);
      await wait(`return !document.body.innerText.includes('Загружаем');`);
      await capture(`operator-denied-${width}`);
      await navigate('operator');
      await wait(`return document.querySelectorAll('[data-lead-id]').length===20;`);
      await evaluate(`window.__portalDesignQA.switchActor(null);`);
      await wait(`return window.__portalDesignQA.session()===null&&!document.querySelector('[aria-label="Заявки оператора"]')&&!document.querySelector('.operator-workday__agenda')&&!document.querySelector('[aria-label="Запись пациента"]')&&!document.body.innerText.includes('+70000000991');`);
      await capture(`operator-signed-out-${width}`);
    }
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
