import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ownedRecoveryBrowser } from '../src/appointment-recovery-committed-fixture.ts';
import { companyIds, createPartnerCompanyApplicationBrowser, root, stopPartnerCompanyApplicationBuilds } from './partner-company-application-browser.mjs';

const component = path.join(root, 'artifacts/negis/src/components/contributors/PartnerCompanyApplication.tsx');
const digest = async () => createHash('sha256').update(await readFile(component)).digest('hex');
const labels = { submit: 'Подать заявку', retry: 'Повторить исходную отправку', read: 'Проверить результат',
  close: 'Закрыть отправку', fresh: 'Новая заявка' };
const privateCompany = 'PRIVATE SYNTHETIC COMPANY', privateOwner = 'PRIVATE SYNTHETIC OWNER';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
async function until(check) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(30); }
  assert.fail('Owned synthetic transport did not settle');
}

test('actual PartnerCompanyApplication in owned Chromium; synthetic identity/transport only, no API/SQL/provider proof', { timeout: 240000 }, async t => {
  const before = await digest();
  const server = await createPartnerCompanyApplicationBrowser();
  let browser;
  const passed = [];
  const base = path.join(root, 'node_modules/.cache/partner-company-application-browser');
  await mkdir(base, { recursive: true });
  const output = await mkdtemp(path.join(base, 'run-'));
  t.after(async () => {
    try { await browser?.close(); }
    finally { try { await server.close(); } finally { stopPartnerCompanyApplicationBuilds(); } }
    assert.equal(await digest(), before, 'The actual component remains untouched by the fixture/tests');
  });
  browser = await ownedRecoveryBrowser(server.origin, { settleTimeoutMs: 15000 });
  const { evaluate: ev, waitFor: wait } = browser;
  const controls = server.controls;
  const form = () => wait('!!document.querySelector(".partner-company-application form")');
  const recovery = () => wait('!!document.querySelector(".pca-recovery")');
  const result = () => wait('!!document.querySelector(".pca-result")');
  const button = text => `([...document.querySelectorAll('.partner-company-application button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}))`;
  const click = text => ev(`const e=${button(text)};if(!e||e.disabled)throw Error('Missing enabled '+${JSON.stringify(text)});e.click();`);
  const hasButton = text => ev(`return !!${button(text)};`);
  const fill = (name, value) => ev(`const e=document.querySelector('[name='+JSON.stringify(${JSON.stringify(name)})+']');
    if(!e||e.disabled)throw Error('Missing enabled field');
    Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});
    e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));`);
  const draft = async () => { await form(); await fill('companyName', privateCompany); await fill('ownerName', privateOwner); };
  const consent = () => ev(`const e=document.querySelector('form input[type="checkbox"]');if(!e)throw Error('Missing consent');e.click();`);
  const closeConsent = () => ev(`const e=document.querySelector('.pca-recovery input[type="checkbox"]');if(!e)throw Error('Missing close consent');e.click();`);
  const refresh = () => ev(`const e=document.querySelector('[aria-label="Обновить данные заявки"]');if(!e||e.disabled)throw Error('Missing refresh');e.click();`);
  const requests = op => controls.requests.filter(record => record.operation === op);
  const lastSubmit = () => requests('submit').at(-1);
  const metadata = async () => {
    const entries = await ev('return Object.keys(sessionStorage).map(key=>[key,sessionStorage.getItem(key)]);');
    assert.equal(await ev('return localStorage.length;'), 0, 'No localStorage persistence');
    for (const [key, raw] of entries) {
      const value = JSON.parse(raw);
      assert.deepEqual(Object.keys(value).sort(), ['actorId', 'requestId', 'sourceId']);
      assert.equal(key, 'medina_partner_company_v1:' + value.actorId);
      assert.ok([companyIds.a, companyIds.b].includes(value.actorId));
      assert.match(value.requestId, uuid); assert.match(value.sourceId, uuid);
      for (const pii of [privateCompany, privateOwner, 'private.a@fixture.invalid', 'private.b@fixture.invalid', 'consentVersion', 'token', 'notice']) {
        assert.equal(raw.includes(pii), false, 'Storage contains only actor/request/source identity');
      }
    }
    return entries.map(([, raw]) => JSON.parse(raw));
  };
  const noFields = async () => {
    assert.equal(await ev(`return document.querySelectorAll('.partner-company-application form,.partner-company-application input,.partner-company-application select').length;`), 0);
    assert.equal(await ev(`return /private\\.[ab]@fixture\\.invalid|PRIVATE SYNTHETIC OWNER|PRIVATE SYNTHETIC COMPANY/.test(document.body.innerText);`), false);
  };
  async function start(configure = () => {}) {
    await ev('f.restoreStorage();f.unmount();sessionStorage.clear();localStorage.clear();');
    await controls.reset();
    configure();
    await browser.load();
  }
  async function fit(name) {
    for (const width of [375, 1440]) {
      await browser.viewport(width, 1050);
      await ev('await document.fonts.ready;');
      assert.equal(await ev('return document.documentElement.scrollWidth<=innerWidth;'), true, 'No page overflow at ' + width);
      assert.equal(await ev(`return [...document.querySelectorAll('.partner-company-application input,.partner-company-application select,.partner-company-application button,.partner-company-application a.pca-button')]
        .every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;});`), true, 'Controls fit at ' + width);
      assert.equal(await ev(`return [...document.querySelectorAll('.partner-company-application button,.partner-company-application a.pca-button,.partner-company-application h2,.partner-company-application h3,.partner-company-application dd,.partner-company-application .pca-caption')]
        .every(e=>e.scrollWidth<=e.clientWidth+2);`), true, 'Button/headline/result text is not clipped at ' + width);
      const bytes = await browser.screenshot();
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      assert.ok(bytes.length > 1000, 'Rendered screenshot is nonempty');
      await writeFile(path.join(output, `${name}-${width}.png`), bytes);
    }
  }
  async function scenario(name, execute) {
    await t.test(name, async () => {
      await start();
      await execute();
      assert.deepEqual(browser.exceptions, []);
      assert.deepEqual(await ev('return f.networkRefusals;'), []);
      assert.deepEqual(controls.errors, [], 'No synthetic fixture assertion failures');
      assert.ok(controls.requests.every(record => record.status !== 500), 'No synthetic fixture assertion failures');
      passed.push(name);
    });
  }

  await scenario('native form fits 375/1440; verified email is readonly, consent starts unchecked, and zones are geographic plus UTC', async () => {
    await form();
    const value = await ev(`const e=document.querySelector('input[type="email"]');return {readonly:e.readOnly,aria:e.getAttribute('aria-readonly'),email:e.value,
      consent:document.querySelector('form input[type="checkbox"]').checked,zones:[...document.querySelector('[name="timeZone"]').options].map(o=>o.value)};`);
    assert.equal(value.readonly, true); assert.equal(value.aria, 'true');
    assert.equal(value.email, 'private.a@fixture.invalid'); assert.equal(value.consent, false);
    assert.equal(await ev(`const text=document.querySelector('.pca-caption').innerText;return text.includes('Исходный срок партнёрского перехода:')
      &&text.includes('Подача и одобрение заявки не продлевают срок первой оплаты подписки.');`), true);
    for (const zone of ['UTC', 'Asia/Almaty', 'Asia/Tokyo', 'Europe/London']) assert.ok(value.zones.includes(zone));
    assert.equal(value.zones.some(zone => zone.startsWith('Etc/')), false);
    await draft();
    assert.equal(await ev(`return ${button(labels.submit)}.disabled;`), true);
    await ev(`const e=document.querySelector('form');e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onSubmit({preventDefault(){}});`);
    assert.equal(requests('submit').length, 0, 'Retained native validation cannot bypass explicit consent');
    await fit('form');
  });

  await scenario('submit freezes the exact company payload and never takes applicant email or source from browser form fields', async () => {
    await draft(); await consent();
    await ev(`const e=document.querySelector('input[type="email"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'attacker@fixture.invalid');`);
    await click(labels.submit); await result();
    assert.deepEqual(Object.keys(lastSubmit().body).sort(), ['company', 'consent', 'consentVersion', 'requestId']);
    assert.match(lastSubmit().body.requestId, uuid); assert.equal(lastSubmit().body.consent, true);
    assert.equal(lastSubmit().body.consentVersion, 'owned-v1');
    assert.deepEqual(lastSubmit().body.company, { name: privateCompany, purpose: 'clinic_services', vertical: 'clinic', timeZone: 'Asia/Almaty', ownerName: privateOwner });
    assert.equal(await ev(`return f.calls.find(c=>c.operation==='submit').frozen;`), true);
    assert.equal(controls.commits, 1);
    assert.equal((await metadata()).length, 1, 'Committed result retains its safe status pointer');
    assert.equal(await ev('return !!document.querySelector("form");'), false);
  });

  await scenario('pre-commit failure blocks duplicate/new submits and retries the same frozen in-memory object', async () => {
    await draft(); await consent();
    await ev(`const e=document.querySelector('form');f.originalSubmit=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onSubmit;`);
    controls.queue('submit', { hold: 'before', failure: 'before' });
    await click(labels.submit); await until(() => controls.held.length === 1);
    await noFields();
    await ev('f.originalSubmit({preventDefault(){}});');
    assert.equal(requests('submit').length, 1); assert.equal((await metadata()).length, 1);
    controls.release(); await recovery(); await fit('unconfirmed');
    await click(labels.retry); await result();
    assert.equal(requests('submit').length, 2); assert.equal(controls.commits, 1);
    assert.deepEqual(requests('submit')[0].body, requests('submit')[1].body);
    assert.equal(await ev(`const a=f.calls.filter(c=>c.operation==='submit');return a[0].body===a[1].body&&a.every(c=>c.frozen);`), true);
  });

  await scenario('lost committed ACK retries the original request without creating a second synthetic application', async () => {
    await draft(); await consent(); controls.queue('submit', { failure: 'after' });
    await click(labels.submit); await recovery();
    const id = lastSubmit().body.requestId;
    assert.equal(controls.commits, 1); assert.equal(controls.applications.size, 1);
    await click(labels.retry); await result();
    assert.equal(lastSubmit().body.requestId, id); assert.equal(controls.commits, 1); assert.equal(controls.applications.size, 1);
    assert.equal(await ev(`const a=f.calls.filter(c=>c.operation==='submit');return a.length===2&&a[0].body===a[1].body;`), true);
    assert.equal(controls.receipt(companyIds.a, id).application.id, id);
  });

  await scenario('real reload after lost ACK restores metadata only and reads committed status without context, PII, or another submit', async () => {
    await draft(); await consent(); controls.queue('submit', { failure: 'after' });
    await click(labels.submit); await recovery();
    const saved = (await metadata())[0], boot = await ev('return f.bootId;');
    controls.cookieAvailable = false;
    const count = controls.requests.length;
    await browser.load(); await result();
    assert.notEqual(await ev('return f.bootId;'), boot, 'A real document reload occurred');
    assert.deepEqual(controls.requests.slice(count).map(record => record.operation), ['read']);
    assert.equal(requests('submit').length, 1);
    assert.equal(requests('read').at(-1).sourceId, saved.sourceId);
    assert.equal(requests('read').at(-1).requestId, saved.requestId);
    assert.deepEqual(await metadata(), [saved]);
    assert.equal(await hasButton(labels.retry), false); assert.equal(await ev('return !!document.querySelector("form");'), false);
  });

  await scenario('real reload before commit loses payload; explicit unchecked close uses original IDs and only abandoned unlocks a new form', async () => {
    await draft(); await consent(); controls.queue('submit', { failure: 'before' });
    await click(labels.submit); await recovery();
    const saved = (await metadata())[0];
    controls.sources.set(companyIds.a, companyIds.sourceB); controls.cookieAvailable = false;
    const count = controls.requests.length;
    await browser.load(); await recovery();
    assert.deepEqual(controls.requests.slice(count).map(record => record.operation), ['read']);
    assert.equal(await hasButton(labels.retry), false); assert.equal(await hasButton(labels.submit), false);
    assert.equal(await ev(`return document.querySelector('.pca-recovery input').checked;`), false);
    assert.equal(await ev(`return ${button(labels.close)}.disabled;`), true);
    await ev(`const e=${button(labels.close)};f.staleUncheckedClose=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onClick;f.staleUncheckedClose();`);
    assert.equal(requests('close').length, 0);
    await closeConsent(); await click(labels.close); await result();
    assert.equal(controls.receipt(companyIds.a, saved.requestId).state, 'abandoned');
    assert.deepEqual(requests('close').map(({ requestId, sourceId }) => ({ requestId, sourceId })), [{ requestId: saved.requestId, sourceId: saved.sourceId }]);
    assert.deepEqual(await metadata(), []);
    assert.equal(controls.applications.size, 0);
    controls.cookieAvailable = true;
    await click(labels.fresh); await form();
    assert.equal(await ev(`return document.querySelector('form input[type="checkbox"]').checked;`), false);
  });

  await scenario('successful submission retains status metadata across reload and own refresh observes pending to approved', async () => {
    await draft(); await consent(); await click(labels.submit); await result();
    const saved = (await metadata())[0];
    assert.ok(saved, 'Success must retain the only pointer to the original application');
    const count = controls.requests.length, boot = await ev('return f.bootId;');
    await browser.load(); await result();
    assert.notEqual(await ev('return f.bootId;'), boot);
    assert.deepEqual(controls.requests.slice(count).map(record => record.operation), ['read']);
    assert.equal(await ev('return !!document.querySelector("form");'), false);
    assert.equal(await ev(`return document.querySelector('.pca-result').innerText.includes('На рассмотрении');`), true);
    assert.equal(await ev(`return !!document.querySelector('.pca-result a[href="/dashboard"]');`), false, 'Pending status does not expose an approved-only CTA');
    controls.approve(companyIds.a, saved.requestId);
    await refresh(); await wait(`document.querySelector('.pca-result')?.innerText.includes('Одобрена')`);
    assert.equal(await ev(`return !!document.querySelector('.pca-result a[href="/dashboard"]');`), false,
      'A generic dashboard must not pretend to select this approved application workspace');
    assert.equal(requests('submit').length, 1); assert.equal(controls.commits, 1);
    assert.deepEqual(await metadata(), [saved]);
    await fit('approved');
  });

  await scenario('recovery may return approved with expired source; expiry never becomes abandonment or false cancellation', async () => {
    await draft(); await consent(); await click(labels.submit); await result();
    const saved = (await metadata())[0];
    controls.approve(companyIds.a, saved.requestId, { expired: true }); controls.cookieAvailable = false;
    const count = controls.requests.length;
    await browser.load(); await wait(`document.querySelector('.pca-result')?.innerText.includes('Одобрена')`);
    assert.deepEqual(controls.requests.slice(count).map(record => record.operation), ['read']);
    const receipt = controls.receipt(companyIds.a, saved.requestId);
    assert.equal(receipt.state, 'committed'); assert.equal(receipt.application.state, 'approved');
    assert.equal(receipt.application.sourceState, 'expired'); assert.ok(Date.parse(receipt.application.expiresAt) < Date.now());
    assert.equal(await ev(`return /закрыта|отменена|отклонена/i.test(document.querySelector('.pca-result').innerText);`), false);
    assert.equal(await ev(`return !!document.querySelector('.pca-result a[href="/dashboard"]');`), false, 'No unverified target-workspace shortcut');
    assert.equal(await hasButton(labels.close), false); assert.equal(requests('close').length, 0);
    assert.equal(controls.applications.size, 1); assert.deepEqual(await metadata(), [saved]);
  });

  await scenario('focus aborts held submit; close fences late delivery and a lost close ACK never revives payload retry', async () => {
    await draft(); await consent(); controls.queue('submit', { hold: 'before' });
    await click(labels.submit); await until(() => controls.held.length === 1);
    await ev(`f.oldCall=f.calls.find(c=>c.operation==='submit');window.dispatchEvent(new Event('focus'));`);
    await recovery();
    assert.equal(await ev('return f.oldCall.signal.aborted&&!f.oldCall.isCurrent();'), true);
    const saved = (await metadata())[0];
    controls.queue('close', { failure: 'after' }); await closeConsent(); await click(labels.close); await recovery();
    assert.equal(await hasButton(labels.retry), false);
    assert.equal(controls.receipt(companyIds.a, saved.requestId).state, 'abandoned');
    controls.release(); await until(() => controls.tasks.size === 0);
    assert.equal(controls.commits, 0); assert.equal(controls.applications.size, 0);
    assert.equal(await hasButton(labels.retry), false);
    await click(labels.read); await result();
    assert.equal(await ev(`return document.querySelector('.pca-result').innerText.includes('Исходная отправка закрыта');`), true);
    assert.deepEqual(await metadata(), []);
  });

  await scenario('focus clears private draft and consent; retained form callbacks cannot submit against a replaced context', async () => {
    await draft(); await consent();
    await ev(`const e=document.querySelector('form');f.oldSubmit=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onSubmit;window.dispatchEvent(new Event('focus'));`);
    await form();
    await ev('f.oldSubmit({preventDefault(){}});');
    assert.equal(requests('submit').length, 0);
    assert.equal(await ev(`return document.querySelector('[name="companyName"]').value;`), '');
    assert.equal(await ev(`return document.querySelector('[name="ownerName"]').value;`), '');
    assert.equal(await ev(`return document.querySelector('form input[type="checkbox"]').checked;`), false);
  });

  await scenario('original request and access-denied callbacks survive parent rerenders; 401/403/404 hide fields and private refusal text', async () => {
    for (const status of [401, 403, 404]) {
      await start(); await form();
      const revision = await ev('return f.calls[0].revision;');
      await ev('f.swapCallbacks();window.dispatchEvent(new Event("focus"));'); await form();
      assert.equal(await ev('return f.calls.at(-1).revision;'), revision);
      controls.contextStatus = status;
      await refresh(); await wait(`document.body.innerText.includes('Доступ к регистрации компании изменился.')`);
      await noFields();
      assert.deepEqual(await ev('return f.denials;'), [{ revision, actorId: companyIds.a }]);
      assert.equal(await ev(`return document.body.innerText.includes('PRIVATE SYNTHETIC TRANSPORT REFUSAL');`), false);
    }
  });

  await scenario('Auth invalidation and A-B-A retire held operations and retained callbacks without showing another actor private state', async () => {
    await draft(); await consent();
    await ev(`const e=document.querySelector('form');f.oldSubmit=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onSubmit;`);
    controls.queue('submit', { hold: 'after' });
    await click(labels.submit); await until(() => controls.held.length === 1);
    await ev(`f.oldCall=f.calls.find(c=>c.operation==='submit');f.invalidate();`);
    await noFields();
    assert.equal(await ev('return f.oldCall.signal.aborted&&!f.oldCall.isCurrent();'), true);
    await ev(`f.switch('b');`); await form();
    assert.equal(await ev(`return document.querySelector('input[type="email"]').value;`), 'private.b@fixture.invalid');
    await ev('f.oldSubmit({preventDefault(){}});');
    controls.release(); await until(() => controls.tasks.size === 0);
    assert.equal(requests('submit').length, 1);
    assert.equal(await ev(`return !!document.querySelector('.pca-result')||document.body.innerText.includes(${JSON.stringify(privateCompany)});`), false);
    assert.equal((await metadata())[0].actorId, companyIds.a, 'Actor B must not consume actor A recovery');
    await ev(`f.switch('a');`); await result();
    assert.equal(await ev('return f.oldCall.isCurrent();'), false);
    assert.equal(requests('read').at(-1).actorId, companyIds.a);
    assert.deepEqual(await ev('return f.denials;'), []);
  });

  await scenario('blur hides contacts immediately; held stale context cannot reveal them until a new focus check', async () => {
    await form(); controls.queue('context', { hold: 'after' });
    await refresh(); await until(() => controls.held.length === 1);
    await ev('f.oldContext=f.calls.at(-1);window.dispatchEvent(new Event("blur"));');
    await noFields();
    assert.equal(await ev('return f.oldContext.signal.aborted&&!f.oldContext.isCurrent();'), true);
    controls.release(); await until(() => controls.tasks.size === 0);
    await noFields();
    await ev('window.dispatchEvent(new Event("focus"));'); await form();
  });

  await scenario('context expiry hides form, verified email, and consent without automatically resubmitting', async () => {
    await form(); controls.expiresAt = new Date(Date.now() + 600).toISOString();
    await refresh(); await form();
    await wait(`document.body.innerText.includes('Срок регистрации по этой ссылке истёк.')`);
    await noFields(); assert.equal(requests('submit').length, 0); assert.deepEqual(await metadata(), []);
  });

  await scenario('malformed, foreign, extra-field, oversized, and newline recovery metadata fail closed before another request', async () => {
    const valid = { actorId: companyIds.a, requestId: companyIds.revision, sourceId: companyIds.sourceA };
    for (const raw of ['{broken', 'x'.repeat(513), JSON.stringify({ ...valid, actorId: companyIds.b }),
      JSON.stringify({ ...valid, company: privateCompany }), JSON.stringify({ ...valid, requestId: valid.requestId + '\n' }),
      JSON.stringify({ ...valid, sourceId: valid.sourceId + '\r\n' })]) {
      await start(); await form();
      const count = controls.requests.length;
      await ev(`sessionStorage.setItem('medina_partner_company_v1:'+f.ids.a,${JSON.stringify(raw)});f.remount();`);
      await wait(`document.body.innerText.includes('Новая заявка заблокирована.')`);
      await noFields(); assert.equal(controls.requests.length, count);
    }
  });

  await scenario('storage write/get refusal sends no new submission and cannot expose a private draft', async () => {
    await draft(); await consent(); await ev(`f.failStorage('setItem');`);
    await click(labels.submit); await wait(`document.body.innerText.includes('Запрос не отправлен.')`);
    assert.equal(requests('submit').length, 0); await noFields();
    await ev(`f.restoreStorage();f.failStorage('getItem');f.remount();`);
    await wait(`document.body.innerText.includes('Новая заявка заблокирована.')`);
    await noFields(); await ev('f.restoreStorage();');
  });

  await scenario('confirmed abandonment cannot unlock a new form when removing recovery metadata fails', async () => {
    await draft(); await consent(); controls.queue('submit', { failure: 'before' });
    await click(labels.submit); await recovery(); await ev(`f.failStorage('removeItem');`);
    await closeConsent(); await click(labels.close); await result();
    assert.equal((await metadata()).length, 1);
    assert.equal(await ev(`return ${button(labels.fresh)}.disabled;`), true);
    assert.equal(await ev(`return document.body.innerText.includes('Новая заявка заблокирована.');`), true);
    await ev('f.restoreStorage();'); await refresh(); await result();
    assert.deepEqual(await metadata(), []); assert.equal(await ev(`return ${button(labels.fresh)}.disabled;`), false);
  });

  await scenario('foreign source/request/application or different company receipt cannot confirm or release the original command', async () => {
    for (const reply of ['wrong-source', 'wrong-request', 'wrong-application', 'wrong-company']) {
      await start(); await draft(); await consent(); controls.queue('submit', { reply });
      await click(labels.submit); await recovery();
      assert.equal((await metadata()).length, 1);
      assert.equal(await ev('return !!document.querySelector(".pca-result")||!!document.querySelector("form");'), false);
      assert.equal(await hasButton(labels.retry), true);
    }
  });

  await scenario('marketing and mortgage native purposes use null vertical, reset consent, and support UTC', async () => {
    for (const purpose of ['marketing', 'mortgage_leads']) {
      await start(); await draft(); await consent(); await fill('purpose', purpose);
      assert.equal(await ev('return !!document.querySelector("[name=vertical]");'), false);
      assert.equal(await ev('return document.querySelector("form input[type=checkbox]").checked;'), false);
      await fill('timeZone', 'UTC'); await consent(); await click(labels.submit); await result();
      assert.equal(lastSubmit().body.company.purpose, purpose); assert.equal(lastSubmit().body.company.vertical, null);
      assert.equal(lastSubmit().body.company.timeZone, 'UTC');
    }
  });

  await scenario('explicit close of an already committed command returns the saved application without deleting or cancelling it', async () => {
    await draft(); await consent(); controls.queue('submit', { failure: 'after' });
    await click(labels.submit); await recovery();
    const saved = (await metadata())[0];
    await closeConsent(); await click(labels.close); await result();
    assert.equal(controls.applications.size, 1); assert.equal(controls.commits, 1);
    assert.equal(controls.receipt(companyIds.a, saved.requestId).application.state, 'pending');
    assert.equal(await ev(`return document.querySelector('.pca-result').innerText.includes('Заявка сохранена');`), true);
    assert.deepEqual(await metadata(), [saved]); assert.equal(await hasButton(labels.fresh), false);
  });

  await scenario('unavailable or malformed initial context exposes no fields, applicant email, or consent', async () => {
    for (const mode of ['unavailable', 'malformed']) {
      await start(() => {
        if (mode === 'unavailable') controls.contextStatus = 503;
        else controls.contextValue = { sourceId: companyIds.sourceA, expiresAt: controls.expiresAt,
          applicantEmail: 'private.a@fixture.invalid', notice: { purpose: 'partner_attribution' } };
      });
      await wait(`document.body.innerText.includes('Не удалось загрузить данные регистрации.')`);
      await noFields(); assert.equal(requests('submit').length, 0); assert.deepEqual(await metadata(), []);
      await fit('context-' + mode);
    }
  });

  assert.deepEqual(browser.exceptions, []);
  assert.ok(browser.requests.every(url => url.startsWith(server.origin + '/') || /^(about:|data:)/.test(url)), 'Only owned loopback browser requests');
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify({ actualComponent: component, syntheticIdentity: true,
    syntheticTransport: true, nativeApiOrSqlProof: false, viewports: [375, 1440], builtCss: server.builtCss,
    passed, requests: browser.requests, exceptions: browser.exceptions, componentSha256: before }, null, 2));
  t.diagnostic('Owned company application screenshots/report: ' + output);
});
