import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPartnerLinkEntryBrowserFixture, root, stopPartnerLinkBrowserBuilds } from './partner-link-entry-browser.mjs';
import { ownedRecoveryBrowser } from '../src/appointment-recovery-committed-fixture.ts';

test('actual partner link and anonymous entry React UI in an owned browser; synthetic transport/challenge only', { timeout: 180000 }, async t => {
  t.after(stopPartnerLinkBrowserBuilds);
  const server = await createPartnerLinkEntryBrowserFixture(); t.after(() => server.close());
  const browser = await ownedRecoveryBrowser(server.origin, { settleTimeoutMs: 15000 }); t.after(() => browser.close());
  const base = path.join(root, 'node_modules/.cache/partner-link-entry-browser'); await mkdir(base, { recursive: true });
  const output = await mkdtemp(path.join(base, 'run-'));
  const { evaluate: ev, waitFor: wait } = browser;
  const click = label => ev(`const e=document.querySelector('[aria-label='+JSON.stringify(${JSON.stringify(label)})+']');if(!e||e.disabled)throw Error('Missing enabled control');e.click();`);
  const press = text => ev(`const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing enabled '+${JSON.stringify(text)});e.click();`);
  const phase = value => wait(`document.querySelector('.partner-entry')?.dataset.phase===${JSON.stringify(value)}`);
  const ready = () => wait(`!!document.querySelector('output[aria-label="Партнёрская ссылка"]')`);
  const consent = () => ev(`document.querySelector('.partner-entry-consent input').click();`);
  async function fit(name, selector) {
    for (const width of [375, 1440]) {
      await browser.viewport(width, width === 375 ? 900 : 1000);
      await ev('await document.fonts.ready;');
      assert.equal(await ev('return document.documentElement.scrollWidth<=innerWidth;'), true, 'No horizontal page overflow');
      assert.equal(await ev(`return [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length&&!e.closest('[hidden]')).every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;});`), true, 'Controls fit the viewport');
      assert.equal(await ev(`return [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length&&!e.closest('[hidden]')).every(e=>e.scrollWidth<=e.clientWidth+2);`), true, 'Control text is not clipped');
      await writeFile(path.join(output, `${name}-${width}.png`), await browser.screenshot());
    }
  }

  await t.test('verified URL, refresh and clipboard controls fit 375/1440', async () => {
    await ready();
    assert.equal(await ev('return document.querySelector("output").textContent;'), 'https://entry.fixture.invalid/r/' + 'A'.repeat(32));
    await fit('link-ready', '.partner-link button,.partner-link output');
    await click('Скопировать партнёрскую ссылку');
    await wait(`document.body.innerText.includes('Ссылка скопирована.')`);
    assert.deepEqual(await ev('return f.copies;'), ['https://entry.fixture.invalid/r/' + 'A'.repeat(32)]);
  });
  await t.test('refresh hides the old URL synchronously; stale copy callback cannot copy it', async () => {
    await ev(`const b=document.querySelector('[aria-label="Скопировать партнёрскую ссылку"]');f.oldCopy=b[Object.keys(b).find(k=>k.startsWith('__reactProps$'))].onClick;f.holdNext=true;`);
    const copied = await ev('return f.copies.length;');
    await click('Обновить партнёрскую ссылку');
    assert.equal(await ev(`return !!document.querySelector('output[aria-label="Партнёрская ссылка"]');`), false);
    await ev('f.oldCopy();'); assert.equal(await ev('return f.copies.length;'), copied);
    await ev('f.release();'); await ready();
  });
  await t.test('held read and clipboard completion do not publish across A-B-A', async () => {
    await ev(`f.holdCopy=true;document.querySelector('[aria-label="Скопировать партнёрскую ссылку"]').click();f.holdNext=true;document.querySelector('[aria-label="Обновить партнёрскую ссылку"]').click();f.switch('b');f.switch('a');`);
    await ready(); await ev('f.release();f.releaseCopies();f.holdCopy=false;');
    assert.equal(await ev(`return document.body.innerText.includes('Ссылка скопирована.');`), false);
    assert.equal(await ev('return document.querySelector("output").textContent;'), 'https://entry.fixture.invalid/r/' + 'A'.repeat(32));
  });
  await t.test('revocation and unavailable/malformed reads leave no actionable URL', async () => {
    await ev('f.linkError=403;window.dispatchEvent(new Event("focus"));');
    await wait('f.denied===1');
    assert.equal(await ev(`return !!document.querySelector('output')||!document.querySelector('[aria-label="Скопировать партнёрскую ссылку"]').disabled;`), false);
    await ev('f.linkError=503;f.switch("b");');
    await wait(`document.querySelector('.partner-link [role="alert"]')`);
    assert.equal(await ev(`return !!document.querySelector('output');`), false);
    await ev(`f.linkError=0;f.linkValue={...{profileId:f.ids.profileA,profileRevision:f.ids.revision,agreementRevision:f.ids.agreement,referralCode:'A'.repeat(32),url:'https://entry.fixture.invalid/r/'+'B'.repeat(32),policyVersion:'2026-10-27-7d-self-v1'}};f.switch('a');`);
    await wait(`document.querySelector('.partner-link [role="alert"]')`);
    assert.equal(await ev(`return !!document.querySelector('output');`), false);
  });
  await t.test('notice is literal and unchecked, no challenge or mutation before explicit consent', async () => {
    await ev('f.show("entry");');
    await wait(`!!document.querySelector('.partner-entry-consent input')`); await phase('idle');
    assert.equal(await ev(`return document.querySelector('.partner-entry-consent input').checked;`), false);
    assert.equal(await ev('return f.challengeCalls;'), 0);
    assert.equal(await ev(`return f.calls.filter(c=>c.op==='prepare'||c.op==='capture').length;`), 0);
    await fit('entry-notice', '.partner-entry button,.partner-entry input,.partner-entry-policy');
  });
  await t.test('a cancelled held challenge cannot dispatch preparation through a retained callback', async () => {
    await consent(); await ev('f.challengeHeld=true;'); await press('Начать проверку'); await phase('challenge');
    await click('Закрыть проверку'); await phase('idle'); await ev('f.challengeHeld=false;f.release();');
    assert.equal(await ev(`return f.calls.filter(c=>c.op==='prepare').length;`), 0);
  });
  await t.test('lost prepare ACK retries the exact original payload without a new challenge or deadline', async () => {
    await ev('f.dropPrepare=true;');
    const before = await ev('return f.challengeCalls;');
    await press('Начать проверку'); await phase('prepare-unknown');
    await press('Повторить исходную подготовку'); await phase('ready');
    const sent = await ev(`return f.calls.filter(c=>c.op==='prepare').map(c=>c.body);`);
    assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
    assert.equal(await ev('return f.challengeCalls;'), before + 1);
  });
  await t.test('lost capture ACK retries only the existing source and original deadline, without another challenge/prepare', async () => {
    await phase('ready');
    const before = await ev(`return {challenges:f.challengeCalls,prepare:f.calls.filter(c=>c.op==='prepare').length};`);
    await ev('f.dropCapture=true;'); await press('Зафиксировать источник перехода'); await phase('capture-unknown');
    await fit('entry-recovery', '.partner-entry button,.partner-entry input');
    await press('Повторить фиксацию'); await phase('captured');
    const after = await ev(`return {challenges:f.challengeCalls,prepare:f.calls.filter(c=>c.op==='prepare').length,captures:f.calls.filter(c=>c.op==='capture').map(c=>c.body),deadline:document.querySelector('.partner-entry-deadline time').dateTime};`);
    assert.equal(after.challenges, before.challenges); assert.equal(after.prepare, before.prepare); assert.deepEqual(after.captures, [{}, {}]);
    assert.equal(after.deadline, '2026-11-04T08:00:00.000Z');
    assert.equal(await ev(`return document.body.innerText.includes('Компания не зарегистрирована');`), true);
  });
  await t.test('code change retires a held challenge and its original consent', async () => {
    await ev('f.remountEntry();'); await wait(`!!document.querySelector('.partner-entry-consent input')`); await consent();
    await ev('f.challengeHeld=true;'); await press('Начать проверку'); await phase('challenge');
    const before = await ev(`return f.calls.filter(c=>c.op==='prepare').length;`);
    await ev(`f.changeCode('B'.repeat(32));f.challengeHeld=false;f.release();`);
    await wait(`!!document.querySelector('.partner-entry-consent input')`);
    assert.equal(await ev(`return document.querySelector('.partner-entry-consent input').checked;`), false);
    assert.equal(await ev(`return f.calls.filter(c=>c.op==='prepare').length;`), before);
  });
  await t.test('invalid route code and unusable notice do not start challenge or source mutations', async () => {
    let before = await ev('return f.calls.length;'); await ev(`f.changeCode('../not-a-code');`); await phase('blocked');
    assert.equal(await ev('return f.calls.length;'), before);
    await ev(`f.notice.notice.purpose='other_purpose';f.changeCode('A'.repeat(32));`);
    await wait(`document.querySelector('.partner-entry-notice-section [role="alert"]')`);
    assert.equal(await ev(`return !!document.querySelector('.partner-entry-consent input');`), false);
    assert.equal(await ev(`return [...document.querySelectorAll('button')].find(b=>b.textContent.includes('Начать проверку')).disabled;`), true);
  });
  assert.deepEqual(browser.exceptions, []);
  assert.equal(browser.requests.every(url => url.startsWith(server.origin + '/') || /^(data:|about:)/.test(url)), true);
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify({ syntheticTransport: true, syntheticChallenge: true,
    actualProductionComponents: true, viewports: [375, 1440], requests: browser.requests, exceptions: browser.exceptions,
    state: await ev('return f.snapshot();') }, null, 2));
  t.diagnostic('Owned screenshot/report output: ' + output);
});
