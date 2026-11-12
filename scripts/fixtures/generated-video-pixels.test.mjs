import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createGeneratedVideoBrowser } from './generated-video-browser.mjs';
import { generatedVideoFixtureIds } from './generated-video-browser-http-store.mjs';
import { ownedRecoveryBrowser, root } from '../src/appointment-recovery-committed-fixture.ts';

test('generated-video fixture refuses inherited browser bindings before server creation', async () => {
  assert.equal(Object.hasOwn(process.env, 'VITE_API_BASE_URL'), false, 'Run with the documented clean environment');
  process.env.VITE_API_BASE_URL = 'https://unusable-fixture.invalid';
  try { await assert.rejects(() => createGeneratedVideoBrowser(), /Inherited browser bindings are forbidden/); }
  finally { delete process.env.VITE_API_BASE_URL; }
});

test('G5 generated-video pixels at 390/1440 with owned media and no generation', { timeout: 240_000 }, async t => {
  const fixture = await createGeneratedVideoBrowser();
  t.after(fixture.close);
  const browser = await ownedRecoveryBrowser(fixture.origin + '/content-studio?video=validation', { settleTimeoutMs: 30000 });
  t.after(browser.close);
  const run = browser.evaluate, wait = browser.waitFor;
  const base = path.join(root, 'node_modules/.cache/generated-video-pixels'); await mkdir(base, { recursive: true });
  const output = await mkdtemp(path.join(base, 'run-'));
  const receipts = [];
  for (const state of ['generation', 'validation', 'failed', 'ready']) for (const width of [390, 1440]) {
    await t.test(`${state}: rendered layout and PNG at ${width}x900`, async () => {
      await browser.viewport(width, 900);
      const before = fixture.snapshot().polls;
      const beforeScene = await run('return f.snapshot().sceneEpoch;');
      await run(`const button=[...document.querySelectorAll('header button')].find(n=>n.textContent.trim()==='${state}');if(!button)throw Error('Missing fixture state');button.click();`);
      await wait(`f.snapshot().sceneEpoch>${beforeScene} && f.layoutSettled() && !!document.querySelector('[role=progressbar]')`);
      const expected = state === 'generation' ? '36' : state === 'ready' ? '100' : '82';
      await wait(`document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')==='${expected}'`);
      assert.ok(fixture.snapshot().polls > before, 'Actual ContentStudio must poll the local HTTP fixture');
      if (state === 'ready') {
        await wait('!!document.querySelector("video") && document.querySelector("video").readyState>=2');
        const media = await run(`const v=document.querySelector('video');v.muted=true;await v.play();return{error:v.error?.code??null,width:v.videoWidth,height:v.videoHeight,src:v.currentSrc};`);
        assert.equal(media.error, null); assert.ok(media.width > 0 && media.height > 0);
        assert.ok(media.src.startsWith(generatedVideoFixtureIds.storageOrigin + '/storage/v1/object/public/ad-creatives/optimized/'));
        await wait('document.querySelector("video").currentTime>0.05');
        await run('document.querySelector("video").pause();');
      } else assert.equal(await run('return !!document.querySelector("video");'), false,
        'Unconfirmed/failed processing must not expose a ready media URL');
      if (state === 'failed') {
        assert.equal(await run(`return ['Проверить ещё раз','Повторить обработку'].every(label=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===label&&!b.disabled));`), true);
      }
      await run(`await document.fonts.ready;document.querySelector('[role=progressbar]').closest('[aria-live]').scrollIntoView({block:'start',behavior:'instant'});`);
      const geometry = await run(`const scene=document.querySelector('[data-testid="generated-video-scene"]');const s=scene.getBoundingClientRect();return{viewport:[innerWidth,innerHeight],pageFits:document.documentElement.scrollWidth<=innerWidth,sceneFits:scene.scrollWidth<=scene.clientWidth,
        overflow:[...scene.querySelectorAll('button,a,input,textarea,select,video')].filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&(r.left<s.left-1||r.right>s.right+1)}).map(n=>n.tagName+':'+n.textContent.slice(0,100)),
        inter:getComputedStyle(document.body).fontFamily.includes('Inter')&&[...document.fonts].some(f=>f.family.includes('Inter')&&f.status==='loaded')};`);
      assert.deepEqual(geometry.viewport, [width, 900]); assert.equal(geometry.pageFits, true); assert.equal(geometry.sceneFits, true);
      assert.deepEqual(geometry.overflow, []); assert.equal(geometry.inter, true);
      if (state === 'ready') {
        const readyActions = await run(`const video=document.querySelector('video');const card=video.parentElement;const actions=[...card.querySelectorAll('a,button')];actions.at(-1).scrollIntoView({block:'nearest',behavior:'instant'});return actions.map(n=>{const r=n.getBoundingClientRect();const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {text:n.textContent.trim(),visible:r.top>=0&&r.bottom<=innerHeight,uncovered:!!top&&(n===top||n.contains(top))}});`);
        assert.ok(readyActions.length >= 2);
        assert.ok(readyActions.every(action => action.visible && action.uncovered), JSON.stringify(readyActions));
        assert.equal(await run(`return document.querySelector('[role=progressbar]').closest('[aria-live]').textContent.includes('Ролик готов');`), true);
      }
      const png = await browser.screenshot();
      assert.equal(png.readUInt32BE(16), width); assert.equal(png.readUInt32BE(20), 900);
      const file = `${state}-${width}.png`; await writeFile(path.join(output, file), png);
      receipts.push({ file, geometry, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') });
      assert.equal(fixture.snapshot().generationPosts, 0); assert.equal(fixture.snapshot().retryPosts, 0);
    });
  }
  await t.test('invalid receipt stays private and all media requests are locally intercepted', async () => {
    const beforeScene = await run('return f.snapshot().sceneEpoch;');
    await run(`const button=[...document.querySelectorAll('header button')].find(n=>n.textContent.trim()==='invalid');if(!button)throw Error('Missing invalid state');button.click();`);
    await wait(`f.snapshot().sceneEpoch>${beforeScene} && f.layoutSettled() && !!document.querySelector('[role=progressbar]')`);
    await wait(`document.body.innerText.includes('Проверка видео не подтверждена')`);
    assert.equal(await run('return !!document.querySelector("video");'), false);
    assert.ok(fixture.mediaRequests.some(r => r.path === '/__fixture/synthetic.mp4'));
    assert.equal(await run(`return navigator.serviceWorker.controller?.scriptURL===${JSON.stringify(fixture.origin + '/__fixture/generated-video-sw.js')};`), true);
    assert.equal(fixture.snapshot().generationPosts, 0); assert.equal(fixture.snapshot().retryPosts, 0);
    assert.ok(browser.requests.every(url => url.startsWith(fixture.origin + '/') || url.startsWith('data:')
      || url.startsWith(generatedVideoFixtureIds.storageOrigin + '/storage/v1/object/public/ad-creatives/optimized/')),
      browser.requests.filter(url => !url.startsWith(fixture.origin)));
    assert.deepEqual(browser.exceptions, []);
  });
  await writeFile(path.join(output, 'receipts.json'), JSON.stringify(receipts, null, 2));
  process.stdout.write(`G5 pixel receipts: ${output}\n`);
});
