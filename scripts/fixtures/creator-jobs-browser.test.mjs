import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCreatorJobsFixture } from './creator-jobs-browser.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(url, onEvent) {
  const ws = new WebSocket(url), pending = new Map(); let sequence = 0;
  ws.addEventListener('message', event => {
    const data = JSON.parse(String(event.data));
    if (!data.id) { onEvent(data.method, data.params); return; }
    const item = pending.get(data.id); if (!item) return; pending.delete(data.id); clearTimeout(item.timer);
    if (data.error) item.reject(Error(JSON.stringify(data.error))); else item.resolve(data.result);
  });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('CDP connect timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('CDP connect failed')); }, { once: true }); });
  return { call(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); }); }, close() { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Closed')); } pending.clear(); ws.close(); } };
}
test('creator job screens in real React/StrictMode with isolated Auth/API doubles, no provider or database', { timeout: 220000 }, async t => {
  const executable = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync);
  assert.ok(executable, 'Installed browser required; no download');
  const server = await createCreatorJobsFixture(), profile = await mkdtemp(path.join(tmpdir(), 'medina-creator-jobs-owned-'));
  const base = path.join(root, 'node_modules/.cache/creator-jobs-browser'); await mkdir(base, { recursive: true });
  const output = await mkdtemp(path.join(base, 'run-'));
  const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-component-update',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'DISPLAY'].includes(key))) });
  const exited = new Promise(resolve => { browser.once('exit', resolve); browser.once('error', resolve); });
  let cdp;
  t.after(async () => {
    if (cdp) await cdp.call('Browser.close').catch(() => {}); await Promise.race([exited, delay(5000)]);
    if (browser.exitCode === null && browser.signalCode === null) { browser.kill(); await Promise.race([exited, delay(5000)]); }
    cdp?.close(); await server.close();
    assert.ok(browser.exitCode !== null || browser.signalCode !== null, 'Owned browser must terminate before removing its profile');
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('medina-creator-jobs-owned-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port;
  for (let n = 0; n < 250; n++) { try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; } catch {} if (/^\d+$/.test(port || '')) break; await delay(80); }
  assert.match(port || '', /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
  const exceptions = [], requests = [];
  cdp = await connect(targets.find(item => item.type === 'page').webSocketDebuggerUrl, (method, params) => {
    if (method === 'Runtime.exceptionThrown') exceptions.push(params.exceptionDetails);
    if (method === 'Network.requestWillBeSent') requests.push(params.request.url);
  });
  for (const domain of ['Page', 'Runtime', 'Network']) await cdp.call(domain + '.enable');
  const evaluate = async body => { const value = await cdp.call('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true }); assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails)); return value.result.value; };
  const wait = async body => { for (let n = 0; n < 250; n++) { if (await evaluate(body)) return; await delay(40); } assert.fail('Wait failed: ' + body + '\n' + JSON.stringify(exceptions) + '\n' + await evaluate('return document.body.innerText;') + '\n' + await evaluate('return JSON.stringify(window.__creatorQA?.calls.map(c=>({path:c.path,method:c.method,actor:c.actor})).slice(-8));')); };
  const click = async (text, selector = 'button') => {
    const point = await evaluate(`const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!el||el.disabled)throw Error('Missing enabled button '+${JSON.stringify(text)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const fill = async (name, value) => evaluate(`const l=[...document.querySelectorAll('label')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(name)}));const el=l?.querySelector('input,textarea,select');if(!el||el.disabled)throw Error('Missing field '+${JSON.stringify(name)});const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));`);
  const screenshot = async name => { const value = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path.join(output, name), Buffer.from(value.data, 'base64')); };
  const openJob = async () => { await wait(`return !!document.querySelector('button[aria-label^="Открыть задание:"]');`); await evaluate(`document.querySelector('button[aria-label^="Открыть задание:"]').click();`); await wait(`return !!document.querySelector('[aria-label="Карточка задания"] h4');`); };
  const view = async mode => { await evaluate(`window.__creatorQA.view(${JSON.stringify(mode)});`); await wait(`return document.querySelector('h1')?.innerText===${JSON.stringify(mode === 'company' ? 'Тестовая компания Medina' : 'Кабинет блогера')} && !!document.querySelector('[aria-label="Задания авторов"] h2');`); };
  const checkbox = async text => click(text, 'label');
  const newForm = async title => {
    await click('Новое задание'); await wait(`return document.querySelector('form[aria-label="Новое задание автору"] select option[value="55555555-5555-4555-8555-555555555555"]')!==null;`);
    await fill('Автор', '55555555-5555-4555-8555-555555555555'); await fill('Название', title); await fill('Бриф', 'QA PRIVATE BRIEF '+title);
    await fill('Вознаграждение', '9007199254740993,01'); await fill('Срок', '2030-01-07T10:15'); await fill('Условия использования контента', 'QA explicit rights '+title);
  };
  await cdp.call('Page.navigate', { url: server.origin + '/company' });
  await wait(`return !!window.__creatorQA?.view && !!document.querySelector('[aria-label="Задания авторов"] h2');`);
  await t.test('company form uses explicit exact terms and fits 375/1440 without clipped controls', async () => {
    await newForm('QA Video');
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width === 375 }); await evaluate('await document.fonts.ready;');
      assert.equal(await evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true);
      assert.equal(await evaluate('return [...document.querySelectorAll("input,textarea,select,button")].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0});'), true);
      assert.equal(await evaluate('return getComputedStyle(document.body).fontFamily.includes("Inter");'), true); await screenshot(`create-${width}.png`);
    }
    await click('Предложить задание'); await wait(`return document.querySelector('[aria-label="Карточка задания"]')?.innerText.includes('Предложено');`);
    assert.equal(await evaluate('return [...window.__creatorQA.jobs.values()][0].job.feeMinor;'), '900719925474099301');
    assert.equal(await evaluate('return [...window.__creatorQA.jobs.values()][0].job.brief;'), 'QA PRIVATE BRIEF QA Video');
    assert.equal(await evaluate(`return [...Array(sessionStorage.length)].map((_,i)=>sessionStorage.key(i)).filter(k=>k.startsWith('medina_creator_command_v1:')).length;`), 0);
  });
  await t.test('author sees original terms, explicit acceptance, company context and own assignment only', async () => {
    await view('creator'); await openJob();
    assert.equal(await evaluate(`return document.querySelector('[aria-label="Карточка задания"]').innerText.includes('Тестовая компания Medina');`), true);
    assert.equal(await evaluate(`return [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Принять задание').disabled;`), true);
    await checkbox('Подтверждаю бриф, вознаграждение, срок и условия использования контента');
    await evaluate(`const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Принять задание');window.__creatorQA.oldAccept=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onClick;`);
    const beforeAccept = await evaluate(`return window.__creatorQA.calls.filter(c=>c.method==='POST').length;`);
    await checkbox('Подтверждаю бриф, вознаграждение, срок и условия использования контента');
    await evaluate('window.__creatorQA.oldAccept();');
    assert.equal(await evaluate(`return window.__creatorQA.calls.filter(c=>c.method==='POST').length;`), beforeAccept);
    await checkbox('Подтверждаю бриф, вознаграждение, срок и условия использования контента'); await click('Принять задание');
    await wait(`return !!document.querySelector('form[aria-label="Результат задания"]');`);
    await fill('Ссылки на результат', 'https://example.com/v1.mp4'); await fill('Комментарий', 'QA version 1');
    await evaluate(`const e=document.querySelector('form[aria-label="Результат задания"]');window.__creatorQA.oldSubmit=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onSubmit;document.querySelector('button[aria-label="Закрыть карточку"]').click();`);
    await wait(`return !document.querySelector('[aria-label="Карточка задания"]');`);
    const beforeClosed = await evaluate(`return window.__creatorQA.calls.filter(c=>c.method==='POST').length;`);
    await evaluate('window.__creatorQA.oldSubmit({preventDefault(){}});');
    assert.equal(await evaluate(`return window.__creatorQA.calls.filter(c=>c.method==='POST').length;`), beforeClosed);
    await openJob(); await fill('Ссылки на результат', 'https://example.com/v1.mp4'); await fill('Комментарий', 'QA version 1');
    await evaluate(`window.dispatchEvent(new Event('focus'));`); await wait(`return !!document.querySelector('form[aria-label="Результат задания"]');`);
    assert.equal(await evaluate(`return document.querySelector('form[aria-label="Результат задания"] textarea').value;`), 'https://example.com/v1.mp4');
    await click('Отправить результат'); await wait(`return document.querySelector('[aria-label="Карточка задания"]')?.innerText.includes('Версия 1');`);
    await evaluate(`window.__creatorQA.switchActor(window.__creatorQA.ids.b);`); await wait(`return document.body.innerText.includes('Тестовый Борис');`);
    assert.equal(await evaluate(`return document.body.innerText.includes('QA PRIVATE BRIEF')||document.body.innerText.includes('QA Video');`), false);
    await evaluate(`window.__creatorQA.switchActor(window.__creatorQA.ids.a);`); await openJob();
  });
  await t.test('company requests revision, author resubmits, company explicitly accepts without a payment claim', async () => {
    await view('company'); await openJob(); await fill('Что доработать', 'QA add caption'); await click('Запросить доработку');
    await wait(`return document.querySelector('[aria-label="Карточка задания"]')?.innerText.includes('Нужна доработка');`);
    await view('creator'); await openJob(); await fill('Ссылки на результат', 'https://example.com/v2.mp4'); await fill('Комментарий', 'QA version 2'); await click('Отправить результат');
    await wait(`return document.querySelector('[aria-label="Карточка задания"]')?.innerText.includes('Версия 2');`);
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width === 375 });
      assert.equal(await evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true); await screenshot(`author-${width}.png`);
    }
    await view('company'); await openJob(); await click('Принять результат'); await click('Подтвердить');
    await wait(`return document.querySelector('[aria-label="Карточка задания"]')?.innerText.includes('Результат принят:');`);
    assert.equal(await evaluate('return [...window.__creatorQA.jobs.values()][0].job.state;'), 'approved');
    assert.equal(await evaluate('return document.body.innerText.includes("Оплачено");'), false);
  });
  await t.test('lost acknowledgement keeps metadata only and exact original retry never duplicates a create', async () => {
    await newForm('QA Lost ACK'); await evaluate('window.__creatorQA.loseNext();'); await click('Предложить задание');
    await wait(`return document.body.innerText.includes('Тестовый потерянный ответ');`);
    const before = await evaluate('return window.__creatorQA.jobs.size;');
    assert.equal(await evaluate(`return [...Array(sessionStorage.length)].map((_,i)=>sessionStorage.getItem(sessionStorage.key(i))).some(v=>/PRIVATE|explicit rights|900719925|example.com/.test(v));`), false);
    await click('Повторить исходную отправку'); await wait(`return !document.querySelector('[aria-label="Состояние отправки"]');`);
    assert.equal(await evaluate('return window.__creatorQA.jobs.size;'), before);
    const writes = await evaluate(`return window.__creatorQA.calls.filter(c=>c.method==='POST'&&c.body?.terms?.title==='QA Lost ACK').map(c=>c.body);`);
    assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  });
  await t.test('remount loses the raw body but restores the original descriptor for committed outcome inspection', async () => {
    await newForm('QA Remount'); await evaluate('window.__creatorQA.loseNext();'); await click('Предложить задание'); await wait(`return document.body.innerText.includes('Тестовый потерянный ответ');`);
    await evaluate('window.__creatorQA.remount();'); await wait(`return !!document.querySelector('[aria-label="Состояние отправки"]');`);
    assert.equal(await evaluate(`return document.body.innerText.includes('Повторить исходную отправку')||document.body.innerText.includes('QA PRIVATE BRIEF QA Remount');`), false);
    const before = await evaluate('return window.__creatorQA.jobs.size;'); await click('Проверить состояние');
    await wait(`return !document.querySelector('[aria-label="Состояние отправки"]');`); assert.equal(await evaluate('return window.__creatorQA.jobs.size;'), before);
  });
  await t.test('held A response cannot publish private job or success after B and returned A', async () => {
    await newForm('QA Held'); await evaluate(`window.__creatorQA.holdNext('clinic-creator-jobs');`); await click('Предложить задание');
    await wait(`return window.__creatorQA.calls.some(c=>c.body?.terms?.title==='QA Held');`);
    await evaluate(`window.__creatorQA.switchActor(window.__creatorQA.ids.b);`); await wait(`return document.body.innerText.includes('Нет доступа к компании');`);
    assert.equal(await evaluate(`return document.body.innerText.includes('QA PRIVATE')||document.querySelector('form')!==null;`), false);
    await evaluate(`window.__creatorQA.switchActor(window.__creatorQA.ids.owner);`); await wait(`return !!document.querySelector('[aria-label="Состояние отправки"]');`);
    await wait(`return document.querySelectorAll('button[aria-label^="Открыть задание:"]').length===window.__creatorQA.jobs.size;`);
    const before = await evaluate('return document.body.innerText;'); await evaluate('window.__creatorQA.release();'); await delay(150);
    assert.equal(await evaluate('return document.body.innerText;'), before);
    await click('Проверить состояние'); await wait(`return !document.querySelector('[aria-label="Состояние отправки"]');`);
  });
  await t.test('unknown outcome stays blocked until explicit close; close never creates a job', async () => {
    await evaluate(`const q=window.__creatorQA;sessionStorage.setItem('medina_creator_command_v1:'+q.ids.owner+':'+q.ids.workspace,JSON.stringify({actorId:q.ids.owner,workspaceId:q.ids.workspace,requestId:crypto.randomUUID(),action:'create',targetId:q.ids.profileA}));q.remount();`);
    await wait(`return !!document.querySelector('[aria-label="Состояние отправки"]');`);
    const before = await evaluate('return window.__creatorQA.jobs.size;');
    assert.equal(await evaluate(`return [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Закрыть отправку').disabled;`), true);
    await click('Проверить состояние'); await wait(`return document.body.innerText.includes('Исход отправки ещё не подтверждён.');`);
    assert.equal(await evaluate(`return [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Новое задание').disabled;`), true);
    await checkbox('Закрыть неподтверждённую отправку. Уже сохранённое действие не отменяется.'); await click('Закрыть отправку');
    await wait(`return !document.querySelector('[aria-label="Состояние отправки"]');`);
    assert.equal(await evaluate('return window.__creatorQA.jobs.size;'), before);
    assert.equal(await evaluate(`return [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Новое задание').disabled;`), false);
  });
  await t.test('22 immutable versions paginate 20/2; stale approval confirmation cannot silently adopt a new revision', async () => {
    await evaluate(`const q=window.__creatorQA,r=[...q.jobs.values()][0],accepted=Date.parse(r.job.acceptedAt);r.history=Array.from({length:22},(_,i)=>({sequence:i+1,links:['https://example.com/v'+(i+1)+'.mp4'],note:'QA version '+(i+1),submittedAt:new Date(accepted+(i+1)*1000).toISOString()}));Object.assign(r.job,{title:'А'.repeat(120),state:'submitted',approvedAt:null,feedback:null,revision:crypto.randomUUID(),submissionCount:22,latestSubmission:r.history.at(-1)});q.remount();`);
    await openJob(); await wait(`return document.querySelector('[aria-label="Версии результата"]')?.querySelectorAll('article').length===20;`);
    await click('Принять результат'); await wait(`return !!document.querySelector('[aria-label="Подтверждение действия"]');`);
    await evaluate(`const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Подтвердить');window.__creatorQA.oldConfirm=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onClick;`);
    await click('Назад'); const beforeConfirm = await evaluate(`return window.__creatorQA.calls.filter(c=>c.method==='POST').length;`);
    await evaluate('window.__creatorQA.oldConfirm();');
    assert.equal(await evaluate(`return window.__creatorQA.calls.filter(c=>c.method==='POST').length;`), beforeConfirm);
    await click('Принять результат');
    await evaluate(`const q=window.__creatorQA,r=[...q.jobs.values()][0];r.job.revision=crypto.randomUUID();document.querySelector('button[aria-label="Обновить задания"]').click();`);
    await wait(`return !!document.querySelector('[aria-label="Карточка задания"] h4');`);
    assert.equal(await evaluate(`return !!document.querySelector('[aria-label="Подтверждение действия"]');`), false);
    await evaluate(`document.querySelector('button[aria-label="Страницы версий: далее"]').click();`);
    await wait(`return document.querySelector('[aria-label="Версии результата"]')?.querySelectorAll('article').length===2;`);
    assert.deepEqual(await evaluate(`return [...document.querySelectorAll('[aria-label="Версии результата"] h5')].map(e=>e.textContent);`), ['Версия 2', 'Версия 1']);
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width === 375 });
      assert.equal(await evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true); await screenshot(`history-${width}.png`);
    }
  });
  await t.test('403 removes private terms and forms without auto retry, and malformed local metadata stays blocked', async () => {
    await openJob(); await evaluate(`window.__creatorQA.holdNext('clinic-creator-job-detail');document.querySelector('button[aria-label="Обновить задания"]').click();`);
    await wait(`return !document.querySelector('[aria-label="Карточка задания"] h4');`);
    await evaluate(`window.__creatorQA.deny();document.querySelector('button[aria-label="Обновить задания"]').click();`);
    await wait(`return document.body.innerText.includes('Доступ к заданиям изменился.');`);
    assert.equal(await evaluate(`return document.body.innerText.includes('QA PRIVATE')||document.querySelector('form')!==null||document.querySelector('[aria-label="Карточка задания"]')!==null;`), false);
    const count = await evaluate('return window.__creatorQA.calls.length;'); await delay(150); assert.equal(await evaluate('return window.__creatorQA.calls.length;'), count);
    await evaluate('window.__creatorQA.release();'); await delay(150);
    assert.equal(await evaluate(`return !!document.querySelector('[aria-label="Карточка задания"]');`), false);
    await evaluate(`const q=window.__creatorQA;q.deny(false);sessionStorage.setItem('medina_creator_command_v1:'+q.ids.owner+':'+q.ids.workspace,'{bad');q.remount();`);
    await wait(`return document.body.innerText.includes('Ключ прежней отправки повреждён.');`);
    assert.equal(await evaluate(`return [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Новое задание').disabled;`), true);
  });
  await t.test('explicit local demo shows a fictional assignment and role switching without real accounts', async () => {
    await evaluate(`const q=window.__creatorQA;sessionStorage.removeItem('medina_creator_command_v1:'+q.ids.owner+':'+q.ids.workspace);`);
    await cdp.call('Page.navigate', { url: server.origin + '/company?demo=1' });
    await wait(`return document.body.innerText.includes('Тестовый стенд · вымышленные данные')&&!!document.querySelector('button[aria-label^="Открыть задание:"]');`);
    await click('Автор А'); await wait(`return document.querySelector('h1')?.textContent==='Кабинет блогера'&&!!document.querySelector('button[aria-label^="Открыть задание:"]');`);
    await click('Автор Б'); await wait(`return document.body.innerText.includes('Тестовый Борис');`);
    assert.equal(await evaluate(`return document.body.innerText.includes('Тестовое видео о сервисе');`), false);
    await click('Компания'); await wait(`return !!document.querySelector('button[aria-label^="Открыть задание:"]');`);
    for (const width of [375, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 375 });
      assert.equal(await evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true); await screenshot(`demo-${width}.png`);
    }
  });
  assert.deepEqual(exceptions, []); assert.ok(requests.every(url => url.startsWith(server.origin + '/') || url.startsWith('data:')), 'Only owned loopback assets');
  console.log('Creator UI screenshots: ' + output);
});
