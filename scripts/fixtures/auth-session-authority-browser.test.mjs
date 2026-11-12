import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { authorityAuthOperation, authorityRequestAllowed, createAuthSessionAuthorityBrowser,
  ids, root, sdkVersion, stopAuthSessionAuthorityBuilds } from './auth-session-authority-browser.mjs';

// Only after Main explicitly confirms both runtime and installed SDK freeze:
// node scripts/fixtures/auth-session-authority-browser.test.mjs --runtime-sdk-freeze-confirmed
// No environment switch, downloads, service credentials or user's browser profile.
const confirmed = process.argv.includes('--runtime-sdk-freeze-confirmed');
const invocation = { argv: process.argv.slice(1), execArgv: [...process.execArgv], runtimeSdkFreezeFlagReceived: confirmed };
console.log('auth-session-authority-browser-invocation ' + JSON.stringify(invocation));
assert.equal(confirmed, true, 'Explicit --runtime-sdk-freeze-confirmed must reach process.argv. Execute this test module directly; node --test does not forward this argument to its worker. No SDK/browser was started.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('authority browser host/method/path gates remain closed', () => {
  const origin = 'http://127.0.0.1:5299', req = { url: '/operator', method: 'GET', headers: { host: '127.0.0.1:5299' } };
  assert.equal(authorityRequestAllowed(req, origin), true);
  for (const change of [{ method: 'PATCH' }, { method: 'DELETE' }, { method: 'OPTIONS' }, { url: '//foreign.invalid/operator' },
    { url: 'https://foreign.invalid/operator' }, { url: '/operator\n' }, { url: '/\\foreign.invalid' },
    { headers: { host: 'localhost:5299' } }, { headers: { ...req.headers, origin: 'https://foreign.invalid' } },
    { headers: { ...req.headers, referer: 'https://foreign.invalid' } }, { headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } }])
    assert.equal(authorityRequestAllowed({ ...req, ...change }, origin), false);
  const op = (method, route) => authorityAuthOperation(method, new URL(route, origin));
  assert.equal(op('POST', '/auth/v1/token?grant_type=password'), 'password');
  assert.equal(op('POST', '/auth/v1/signup?redirect_to=' + encodeURIComponent(origin + '/operator')), 'signup');
  assert.equal(op('GET', '/auth/v1/user'), 'user');
  assert.equal(op('POST', '/auth/v1/logout?scope=local'), 'logout');
  for (const [method, route] of [['GET', '/auth/v1/token?grant_type=password'], ['POST', '/auth/v1/token?grant_type=refresh_token'],
    ['POST', '/auth/v1/token?grant_type=password&grant_type=password'], ['POST', '/auth/v1/logout?scope=local&scope=local'],
    ['GET', '/auth/v1/user?extra=1'], ['POST', '/auth/v1/signup?redirect_to=https://foreign.invalid'],
    ['POST', '/auth/v1/recover'], ['POST', '/rest/v1/users'], ['POST', '/api/crm/operator-account']]) assert.equal(op(method, route), null);
});

test('actual App, authority observer bridge and actual frontend SDK protect persistence and private DOM',
  { timeout: 240_000 }, async t => {
    let fixture, browser, output, active = false;
    const screenshots = [], scenarios = [], pageClosures = [], intentionalGateProbes = [];
    const cleanup = { react: null, browserClosed: false, server: null, esbuildStopped: false };
    const receipt = () => ({ invocation, sdk: fixture?.sdk, scope: fixture?.scope, sourceHashes: fixture?.sourceHashes,
      bundleHashes: fixture?.bundleHashes, screenshots, scenarios, pageClosures, network: {
        requests: fixture?.controls.requests, rejected: fixture?.controls.rejected, releases: fixture?.controls.releases,
        browserRequests: browser?.requests, exceptions: browser?.exceptions, intentionalGateProbes }, cleanup });
    t.after(async () => {
      try {
        if (browser) {
          try {
            fixture.controls.releaseAll();
            if (active) cleanup.react = await browser.evaluate('return await f.shutdown();');
          } finally { await browser.close(); cleanup.browserClosed = true; }
        }
      } finally {
        try { if (fixture) cleanup.server = await fixture.close(); }
        finally {
          stopAuthSessionAuthorityBuilds(); cleanup.esbuildStopped = true;
          t.diagnostic('close-receipt ' + JSON.stringify(cleanup));
          if (output) {
            await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt(), null, 2));
            await writeFile(path.join(output, 'close.json'), JSON.stringify(cleanup, null, 2));
          }
        }
      }
      if (browser) assert.equal(cleanup.browserClosed, true);
      if (fixture) assert.deepEqual(cleanup.server, { listening: false, held: 0, plans: 0, sockets: 0 });
      if (active) {
        assert.equal(cleanup.react?.sdkDisposed, true); assert.equal(cleanup.react?.observerUnsubscribed, true);
        assert.equal(cleanup.react?.rootChildren, 0); assert.deepEqual(cleanup.react?.pendingControlledTasks, []);
        assert.equal(cleanup.react?.pendingFetches, 0);
        assert.deepEqual(cleanup.react?.listeners, { storage: 0, visibility: 0 });
        assert.deepEqual(cleanup.react?.networkDenied, []);
        assert.equal(cleanup.react?.childFrames, 0); assert.equal(cleanup.react?.sessionLockHeld, false);
        for (const child of cleanup.react?.children ?? []) {
          assert.equal(child.sdkDisposed, true); assert.equal(child.rootChildren, 0); assert.equal(child.pendingFetches, 0);
          assert.deepEqual(child.pendingControlledTasks, []); assert.deepEqual(child.listeners, { storage: 0, visibility: 0 }); assert.deepEqual(child.networkDenied, []);
        }
        assert.ok(cleanup.react?.detachedPasswordLengths.every(length => length === 0));
      }
    });
    t.diagnostic('runtime-cli ' + JSON.stringify(invocation));
    fixture = await createAuthSessionAuthorityBrowser({ runtimeSdkFreezeConfirmed: confirmed });
    assert.equal(fixture.sdk.version, sdkVersion); assert.equal(fixture.sdk.authVersion, sdkVersion);
    const base = path.join(root, 'output/auth-session-authority-browser');
    await mkdir(base, { recursive: true }); output = await mkdtemp(path.join(base, 'run-'));
    await writeFile(path.join(output, 'sources.json'), JSON.stringify({ sdk: fixture.sdk, sourceHashes: fixture.sourceHashes, bundleHashes: fixture.bundleHashes }, null, 2));
    t.diagnostic('evidence ' + output); t.diagnostic('scope ' + fixture.scope); t.diagnostic('listener ' + fixture.origin);
    // Reuse the existing owned headless runner unchanged. It creates and removes
    // its own temporary profile; it does not attach to an existing browser.
    const { ownedRecoveryBrowser } = await import('../src/appointment-recovery-committed-fixture.ts');
    browser = await ownedRecoveryBrowser(fixture.origin, { settleTimeoutMs: 12_000 }); active = true;
    const { evaluate: ev, waitFor: wait } = browser;
    const snapshot = () => ev('return await f.snapshot();');
    const until = async (predicate, label) => {
      const deadline = Date.now() + 12_000;
      while (!predicate() && Date.now() < deadline) await sleep(20);
      assert.ok(predicate(), label);
    };
    const held = async (operation, actor) => {
      await until(() => fixture.controls.pending().some(item => item.operation === operation && item.actor === actor), 'Expected synthetic held ' + operation + ' ' + actor);
      return fixture.controls.pending().find(item => item.operation === operation && item.actor === actor);
    };
    const waitTask = async name => {
      const deadline = Date.now() + 12_000;
      let state;
      do { state = await snapshot(); if (state.tasks.find(task => task.name === name)?.done) return state; await sleep(20); } while (Date.now() < deadline);
      assert.fail('Actual authority operation did not settle: ' + name + '; ' + JSON.stringify(state));
    };
    const readyForm = () => wait(`!!document.querySelector('form input[type=password]')&&!document.querySelector('form button[type=submit]')?.disabled`);
    const privateActor = actor => wait(`document.querySelector('.portal-identity')?.textContent.includes('PRIVATE SYNTHETIC ${actor}')`);
    const reset = async route => {
      fixture.controls.releaseAll();
      assert.deepEqual(fixture.controls.unconsumed(), [], 'Every synthetic auth plan must be exercised');
      if (active) {
        const close = await ev('return await f.shutdown();'); pageClosures.push(close); active = false;
        assert.deepEqual(close.pendingControlledTasks, []); assert.equal(close.pendingFetches, 0);
        assert.equal(close.rootChildren, 0); assert.equal(close.observerUnsubscribed, true); assert.equal(close.sdkDisposed, true);
        assert.deepEqual(close.listeners, { storage: 0, visibility: 0 }, 'Actual App/bridge/SDK DOM subscriptions must be torn down');
        assert.deepEqual(close.networkDenied, [], 'Every owned page, not only the final page, must stay inside the closed network boundary');
        assert.equal(close.childFrames, 0); assert.equal(close.sessionLockHeld, false);
        for (const child of close.children) {
          assert.equal(child.sdkDisposed, true); assert.equal(child.observerUnsubscribed, true); assert.equal(child.rootChildren, 0); assert.equal(child.pendingFetches, 0);
          assert.deepEqual(child.pendingControlledTasks, []); assert.deepEqual(child.listeners, { storage: 0, visibility: 0 }); assert.deepEqual(child.networkDenied, []);
        }
      }
      const oldRun = await ev('return f.run;'); await browser.load(); active = true;
      await wait(`f.run!==${JSON.stringify(oldRun)}`);
      if (route !== '/operator') await ev(`f.navigate(${JSON.stringify(route)});`);
      await readyForm(); await ev('f.observe();await f.idle();');
      const state = await snapshot(); assert.equal(state.storedId, null); assert.equal(state.sdkId, null);
    };
    const start = async (name, operation, actor, { hold = false, outcome = 'session' } = {}) => {
      const httpOperation = { signInWithPassword: 'password', signUp: 'signup', signOut: 'logout', verifyOtp: 'verify' }[operation];
      if (httpOperation) fixture.controls.plan({ operation: httpOperation, actor, hold, outcome });
      await ev(`f.start(${JSON.stringify(name)},${JSON.stringify(operation)},${JSON.stringify(actor)});`);
      if (!hold) {
        const state = await waitTask(name), task = state.tasks.find(task => task.name === name);
        assert.equal(task.error, null, JSON.stringify(task));
      }
    };
    const stableB = async (before, eventCutoff, requestCutoff) => {
      await ev('await f.idle();'); await privateActor('B'); const after = await snapshot();
      assert.equal(after.storedId, ids.B); assert.equal(after.sdkId, ids.B); assert.equal(after.sdkError, false);
      assert.equal(after.storedHash, before.storedHash, 'Late original operation cannot replace/remove the exact saved B session');
      assert.equal(after.revisionHash, before.revisionHash, 'Late original operation cannot change the B revision');
      assert.equal(after.intentHash, before.intentHash, 'Late original operation cannot change the B intent');
      assert.equal(after.listeners.storage, before.listeners.storage, 'Late settlement cannot recreate an auth observer');
      assert.equal(after.text.includes('PRIVATE SYNTHETIC A'), false);
      assert.equal(after.privateIdentity, true, 'Actual private B identity must remain rendered');
      assert.ok(after.watch.every(item => !item.A), 'Not even a transient private A DOM is allowed after B settles');
      assert.ok(after.events.slice(eventCutoff).every(item => item.id === ids.B), 'No stale SIGNED_IN A or SIGNED_OUT observer publication after B');
      assert.ok(fixture.controls.requests.slice(requestCutoff).filter(item => item.path.startsWith('/api/')).every(item => item.actor === 'B'), 'Stale auth may not dispatch private A business reads');
      return after;
    };
    const fit = async name => {
      await ev('await document.fonts.ready;await f.idle();');
      const metrics = await ev(`const nodes=[...document.querySelectorAll('main input,main button,main label,main h1,.portal-page-header h1')]
        .filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden');
        const bad=nodes.filter(n=>{const r=n.getBoundingClientRect();return r.width<=0||r.left<0||r.right>innerWidth+1||n.scrollWidth>n.clientWidth+2;});
        const fields=[...document.querySelectorAll('main input')].filter(n=>n.getClientRects().length).map(n=>({type:n.type,rect:n.getBoundingClientRect().toJSON()}));
        return{width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,bad:bad.map(n=>n.outerHTML.slice(0,180)),fields};`);
      assert.equal(metrics.overflow, false, JSON.stringify(metrics)); assert.deepEqual(metrics.bad, [], 'Actual visible controls and text must fit');
      for (let index = 1; index < metrics.fields.length; index++)
        assert.ok(metrics.fields[index].rect.top >= metrics.fields[index - 1].rect.bottom, 'Actual form fields do not overlap');
      const png = await browser.screenshot(), file = name + '-' + metrics.width + '.png';
      assert.ok(png.length > 5000, 'Rendered screenshot must not be empty');
      assert.equal(png.readUInt32BE(16), metrics.width); assert.equal(png.readUInt32BE(20), metrics.height);
      await writeFile(path.join(output, file), png);
      const result = { file, sha256: sha(png), bytes: png.length, ...metrics }; screenshots.push(result); return result;
    };

    await t.test('actual bridge observes own authority writes, real SDK reads, unsubscribe, and accepted sign-out', async () => {
      await reset('/operator'); await start('set-B', 'setSession', 'B'); await privateActor('B');
      let state = await snapshot(); assert.equal(state.storedId, ids.B); assert.equal(state.sdkId, ids.B);
      assert.ok(state.events.some(item => item.event === 'SIGNED_IN' && item.id === ids.B), 'Actual observer bridge must publish an isolated-client write');
      assert.ok(fixture.controls.requests.some(item => item.operation === 'user' && item.actor === 'B'), 'setSession uses actual installed SDK user HTTP');
      assert.ok(fixture.controls.requests.some(item => item.path === '/api/crm/auth-context' && item.actor === 'B'), 'Actual AuthProvider reads current B auth-context');
      await start('out-B', 'signOut', 'B'); await readyForm();
      state = await snapshot(); assert.equal(state.storedId, null); assert.equal(state.sdkId, null);
      assert.ok(state.events.some(item => item.event === 'SIGNED_OUT' && item.id === null));
      await ev('f.stopObserving();'); const cutoff = (await snapshot()).events.length;
      await start('in-A', 'signInWithPassword', 'A'); await privateActor('A');
      state = await snapshot(); assert.equal(state.events.length, cutoff, 'Unsubscribed real bridge callback must stay silent');
      scenarios.push({ scenario: 'observer-bridge', state });
    });

    for (const route of ['/operator', '/contributors']) {
      await t.test(route + ': held original sign-in A settles after B without replacing B storage or App UI', async () => {
        await reset(route); await start('held-A', 'signInWithPassword', 'A', { hold: true }); const old = await held('password', 'A');
        await start('winner-B', 'signInWithPassword', 'B'); await privateActor('B');
        const before = await snapshot(), eventCutoff = before.events.length, requestCutoff = fixture.controls.requests.length;
        assert.equal(before.tasks.find(task => task.name === 'held-A').current, true, 'Original caller remains current: this exercises authority ownership, not only unmount');
        await ev('f.watchPrivate();'); const release = fixture.controls.release(old.id); await waitTask('held-A');
        const after = await stableB(before, eventCutoff, requestCutoff);
        assert.ok(after.tasks.find(task => task.name === 'held-A').error, 'Retired A must not report an accepted auth receipt');
        await fit(route.slice(1) + '-late-signin-B');
        scenarios.push({ scenario: 'late-signin', route, release, before, after });
      });

      await t.test(route + ': held original logout cannot delete newer B or publish a stale sign-out', async () => {
        await reset(route); await start('initial-A', 'setSession', 'A'); await privateActor('A');
        await start('held-out-A', 'signOut', 'A', { hold: true }); const old = await held('logout', 'A');
        await start('winner-B', 'signInWithPassword', 'B'); await privateActor('B');
        const before = await snapshot(), eventCutoff = before.events.length, requestCutoff = fixture.controls.requests.length;
        assert.equal(before.tasks.find(task => task.name === 'held-out-A').current, true);
        await ev('f.watchPrivate();'); const release = fixture.controls.release(old.id); await waitTask('held-out-A');
        const after = await stableB(before, eventCutoff, requestCutoff);
        assert.ok(after.tasks.find(task => task.name === 'held-out-A').error);
        await fit(route.slice(1) + '-late-logout-B');
        scenarios.push({ scenario: 'late-logout-controlled-caller-not-provider-tombstone', route, release, before, after });
      });

      await t.test(route + ': real provider logout hides App immediately and cannot delete a newer B', async () => {
        await reset(route); await start('initial-A', 'setSession', 'A'); await privateActor('A');
        fixture.controls.plan({ operation: 'logout', actor: 'A', hold: true });
        await ev(`f.click('[aria-label="\u0412\u044b\u0439\u0442\u0438 \u0438\u0437 \u0430\u043a\u043a\u0430\u0443\u043d\u0442\u0430"]');`);
        const immediate = await snapshot();
        assert.equal(immediate.portal, false); assert.equal(immediate.text.includes('PRIVATE SYNTHETIC'), false, 'Real App SessionContent removes private tree before the logout HTTP answers');
        const old = await held('logout', 'A'); await start('winner-B', 'signInWithPassword', 'B');
        const before = await snapshot(), cutoff = before.events.length;
        assert.equal(before.storedId, ids.B); assert.equal(before.sdkId, ids.B);
        await ev('f.watchPrivate();'); const release = fixture.controls.release(old.id); await ev('await f.idle();');
        const after = await snapshot();
        assert.equal(after.storedId, ids.B); assert.equal(after.sdkId, ids.B);
        assert.equal(after.storedHash, before.storedHash); assert.equal(after.revisionHash, before.revisionHash); assert.equal(after.intentHash, before.intentHash);
        assert.equal(after.text.includes('PRIVATE SYNTHETIC A'), false); assert.ok(after.watch.every(item => !item.A));
        assert.ok(after.events.slice(cutoff).every(item => item.id === ids.B));
        scenarios.push({ scenario: 'actual-provider-late-logout-B-storage-preserved', route, immediate, before, after, release,
          note: 'Provider tombstone may intentionally keep private B UI hidden; controlled authority logout above separately proves private B remains rendered.' });
      });

      for (const mode of ['signin', 'signup']) {
        await t.test(`${route}: held actual ${mode} A form cannot replace a settled second-caller B`, async () => {
          await reset(route); if (mode === 'signup') await ev('f.mode("signup");');
          const operation = mode === 'signup' ? 'signup' : 'password';
          fixture.controls.plan({ operation, actor: 'A', hold: true });
          await ev(`f.fill('form input[autocomplete=username]','authority-a@example.test');f.fill('form input[type=password]','SyntheticEntry42!');f.remember();f.submitDuplicate();`);
          const old = await held(operation, 'A');
          await start('winner-B', 'signInWithPassword', 'B'); await privateActor('B');
          const before = await snapshot(), cutoff = before.events.length, requestCutoff = fixture.controls.requests.length;
          await ev('f.watchPrivate();'); const release = fixture.controls.release(old.id); await ev('await f.idle();');
          const after = await stableB(before, cutoff, requestCutoff);
          assert.deepEqual(after.detachedPasswordLengths, [0]);
          scenarios.push({ scenario: 'actual-form-late-auth', route, mode, before, after, release });
        });

        await t.test(`${route}: retired actual ${mode} form cannot authenticate after route unmount`, async () => {
          await reset(route); if (mode === 'signup') await ev('f.mode("signup");');
          const operation = mode === 'signup' ? 'signup' : 'password';
          fixture.controls.plan({ operation, actor: 'A', hold: true });
          await ev(`f.fill('form input[autocomplete=username]','authority-a@example.test');f.fill('form input[type=password]','SyntheticEntry42!');f.remember();f.retainSubmit();f.submitDuplicate();`);
          const old = await held(operation, 'A');
          assert.deepEqual((await snapshot()).passwordLengths, [0], 'Dispatch clears password while real auth HTTP is held');
          const other = route === '/operator' ? '/contributors' : '/operator';
          await ev(`f.navigate(${JSON.stringify(other)});`); await readyForm();
          const before = await snapshot(), count = fixture.controls.requests.filter(item => item.operation === operation).length;
          await ev('f.invokeRetiredSubmit();'); await ev('await f.idle();');
          assert.equal(fixture.controls.requests.filter(item => item.operation === operation).length, count, 'Retired real handler cannot dispatch another auth HTTP');
          const release = fixture.controls.release(old.id); await ev('await f.idle();');
          const after = await snapshot();
          scenarios.push({ scenario: 'stale-route-form', route, mode, before, after, release });
          await fit(route.slice(1) + '-' + mode + '-retired-form-public-route');
          assert.equal(after.path, other); assert.equal(after.storedId, null); assert.equal(after.sdkId, null);
          assert.deepEqual(after.passwordLengths, [0]); assert.deepEqual(after.detachedPasswordLengths, [0]);
          assert.equal(after.portal, true, 'The public PortalShell intentionally remains around the new auth form');
          assert.equal(after.privateIdentity, false); assert.equal(after.privateProfile, false);
          assert.deepEqual(after.privatePortalSelectors, [], 'No actual private identity/profile/sign-out controls may survive');
          assert.equal(after.publicAuthForm, true); assert.equal(after.text.includes('PRIVATE SYNTHETIC'), false);
          assert.equal(after.storedHash, null, 'No raw session may remain in storage'); assert.equal(after.sdkError, false);
          assert.ok(after.events.every(item => item.id !== ids.A), 'Retired real form cannot publish A through the bridge');
        });
      }

      await t.test(route + ': entire App unmount retires a held actual auth form', async () => {
        await reset(route); fixture.controls.plan({ operation: 'password', actor: 'A', hold: true });
        await ev(`f.fill('form input[autocomplete=username]','authority-a@example.test');f.fill('form input[type=password]','SyntheticEntry42!');f.retainSubmit();f.submitDuplicate();`);
        const old = await held('password', 'A');
        const unmounted = await ev('return f.unmount();'); assert.equal(unmounted.rootChildren, 0); assert.deepEqual(unmounted.detachedPasswordLengths, [0]);
        await ev('f.invokeRetiredSubmit();'); const release = fixture.controls.release(old.id); await ev('await f.idle();');
        const state = await snapshot(); assert.equal(state.storedId, null); assert.equal(state.sdkId, null); assert.equal(state.text, '');
        assert.ok(state.events.every(item => item.id !== ids.A));
        scenarios.push({ scenario: 'App-unmount', route, release, state });
      });

      for (const width of [375, 1440]) await t.test(`${route}: actual signin/signup forms, busy/error/confirmation at ${width}`, async () => {
        await reset(route); await browser.viewport(width, 900);
        for (const mode of ['signin', 'signup']) {
          if (mode === 'signup') await ev('f.mode("signup");');
          assert.equal(await ev(`return document.querySelector('input[type=password]').autocomplete;`), mode === 'signup' ? 'new-password' : 'current-password');
          await fit(route.slice(1) + '-' + mode);
          const operation = mode === 'signup' ? 'signup' : 'password';
          const count = fixture.controls.requests.filter(item => item.operation === operation).length;
          fixture.controls.plan({ operation, actor: 'A', hold: true, outcome: 'error' });
          await ev(`f.fill('form input[autocomplete=username]','authority-a@example.test');f.fill('form input[type=password]','SyntheticEntry42!');f.remember();f.submitDuplicate();`);
          const pending = await held(operation, 'A');
          const busy = await snapshot(); assert.deepEqual(busy.passwordLengths, [0]);
          assert.equal(fixture.controls.requests.filter(item => item.operation === operation).length - count, 1, 'Duplicate DOM submit must send exactly one actual auth HTTP');
          assert.equal(await ev(`return [...document.querySelectorAll('form input,form button,[role=tab],[aria-label="\u0421\u043f\u043e\u0441\u043e\u0431 \u0432\u0445\u043e\u0434\u0430"] button')].filter(n=>n.getClientRects().length).every(n=>n.disabled);`), true);
          await fit(route.slice(1) + '-' + mode + '-busy');
          fixture.controls.release(pending.id); await readyForm(); await ev('await f.idle();');
          const failed = await snapshot(); assert.deepEqual(failed.passwordLengths, [0]); assert.equal(failed.storedId, null); assert.equal(failed.sdkId, null);
          assert.equal(await ev(`return [...document.querySelectorAll('main [role=status]')].some(n=>n.textContent.trim().length>0);`), true, 'Actual auth failure must be visible');
          if (mode === 'signup') assert.equal(fixture.controls.requests.filter(item => item.operation === 'signup').at(-1).redirectPath, route);
          await fit(route.slice(1) + '-' + mode + '-error');
          if (mode === 'signup') {
            fixture.controls.plan({ operation, actor: 'A', outcome: 'confirmation' });
            await ev(`f.fill('form input[type=password]','SyntheticEntry42!');f.submitDuplicate();`);
            await readyForm(); await ev('await f.idle();');
            const confirmation = await snapshot(); assert.equal(confirmation.storedId, null); assert.equal(confirmation.sdkId, null); assert.deepEqual(confirmation.passwordLengths, [0]);
            assert.equal(await ev(`return [...document.querySelectorAll('main [role=status]')].some(n=>n.textContent.trim().length>0);`), true, 'Actual email confirmation state must be visible');
            await fit(route.slice(1) + '-signup-confirmation');
          }
        }
      });
    }

    await t.test('one genuine parent/iframe document race shares native storage and Web Locks without sharing facade/SDK instances', async () => {
      await reset('/operator'); await browser.viewport(1440, 900);
      const scenario = { scenario: 'genuine-two-document-parent-iframe',
        scope: 'One same-origin iframe and parent in the owned profile; separate actual App/AuthProvider/sessionAuth/SDK instances. NOT two tabs or cross-process proof.' };
      scenarios.push(scenario);
      try {
        await start('initial-A', 'setSession', 'A'); await privateActor('A');
        await ev('f.openChild();');
        await wait('f.childRuntime()?.childAppRoot>0');
        await wait(`f.child()?.runtimeHandles().document.querySelector('.portal-identity')?.textContent.includes('PRIVATE SYNTHETIC A')`);
        await ev('f.child().observe();await f.child().runtimeHandles().document.fonts.ready;await f.child().idle();');
        scenario.runtime = await ev('return f.childRuntime();');
        for (const name of ['distinctWindow', 'distinctDocument', 'distinctFacade', 'distinctSDK', 'sameOrigin', 'childWebLocks']) assert.equal(scenario.runtime[name], true, name);
        assert.notEqual(scenario.runtime.parentRun, scenario.runtime.childRun);
        assert.equal(scenario.runtime.parentKind, 'parent'); assert.equal(scenario.runtime.childKind, 'iframe');
        scenario.initialParent = await snapshot(); scenario.initialChild = await ev('return await f.child().snapshot();');
        assert.equal(scenario.initialParent.sdkId, ids.A); assert.equal(scenario.initialChild.sdkId, ids.A);
        assert.equal(scenario.initialParent.storedHash, scenario.initialChild.storedHash, 'Both actual SDK instances initially read the same saved A');
        await start('parent-held-A', 'signInWithPassword', 'A', { hold: true }); const old = await held('password', 'A');
        const storageCutoff = (await snapshot()).storageEvents.length;
        const bRequests = fixture.controls.requests.filter(item => item.operation === 'password' && item.actor === 'B').length;
        await ev('f.holdSessionLock();'); await wait('f.sessionLockProbe.held');
        try {
          fixture.controls.plan({ operation: 'password', actor: 'B' });
          await ev(`f.child().start('child-winner-B','signInWithPassword','B');`);
          const deadline = Date.now() + 3500;
          do {
            scenario.sharedLock = await ev('return {parent:await navigator.locks.query(),child:await f.childLocks(),task:f.child().taskState("child-winner-B")};');
            if (scenario.sharedLock.child.pending.some(lock => lock.name === scenario.runtime.sessionLockName)) break;
            await sleep(20);
          } while (Date.now() < deadline);
          const parentHeld = scenario.sharedLock.parent.held.find(lock => lock.name === scenario.runtime.sessionLockName);
          assert.ok(parentHeld, 'Parent holds the actual standard SDK session lock');
          assert.ok(scenario.sharedLock.child.held.some(lock => lock.name === parentHeld.name && lock.clientId === parentHeld.clientId), 'Child sees the same native parent-held Web Lock');
          assert.ok(scenario.sharedLock.child.pending.some(lock => lock.name === parentHeld.name), 'Child actual facade must wait on the same standard session lock');
          assert.equal(scenario.sharedLock.task.done, false);
          assert.equal(fixture.controls.requests.filter(item => item.operation === 'password' && item.actor === 'B').length, bRequests, 'Child cannot dispatch auth HTTP before acquiring the shared lock');
        } finally { await ev('await f.releaseSessionLock();'); }
        await wait(`f.child()?.taskState('child-winner-B')?.done`); await privateActor('B');
        scenario.before = await snapshot(); scenario.childBefore = await ev('return await f.child().snapshot();');
        assert.equal(scenario.childBefore.tasks.find(task => task.name === 'child-winner-B').error, null);
        assert.equal(scenario.before.storedId, ids.B); assert.equal(scenario.before.sdkId, ids.B);
        assert.equal(scenario.childBefore.storedId, ids.B); assert.equal(scenario.childBefore.sdkId, ids.B);
        assert.equal(scenario.before.storedHash, scenario.childBefore.storedHash);
        assert.equal(scenario.before.tasks.find(task => task.name === 'parent-held-A').current, true, 'Original caller is still live in a different document from the B writer');
        scenario.crossDocumentEvents = scenario.before.storageEvents.slice(storageCutoff);
        for (const key of [scenario.before.storageKey, scenario.before.storageKey + '.medina-revision'])
          assert.ok(scenario.crossDocumentEvents.some(event => event.key === key && event.trusted && event.hasNew && new URL(event.url).origin === fixture.origin), 'Parent must receive genuine child-originated storage events for ' + key);
        assert.equal(scenario.before.text.includes('PRIVATE SYNTHETIC A'), false, 'Parent hides A before releasing original A HTTP');
        const cutoff = scenario.before.events.length, requestCutoff = fixture.controls.requests.length;
        await ev('f.watchPrivate();f.child().watchPrivate();'); scenario.release = fixture.controls.release(old.id);
        assert.equal(scenario.release.delivered, true, 'Actual held A HTTP response is delivered only after child B has committed');
        await waitTask('parent-held-A'); scenario.after = await stableB(scenario.before, cutoff, requestCutoff);
        scenario.childAfter = await ev('await f.child().idle();return await f.child().snapshot();');
        assert.ok(scenario.after.tasks.find(task => task.name === 'parent-held-A').error);
        assert.equal(scenario.after.tasks.find(task => task.name === 'parent-held-A').current, true);
        assert.equal(scenario.childAfter.sdkId, ids.B); assert.equal(scenario.childAfter.storedId, ids.B);
        assert.equal(scenario.childAfter.storedHash, scenario.before.storedHash);
        assert.equal(scenario.childAfter.revisionHash, scenario.before.revisionHash); assert.equal(scenario.childAfter.intentHash, scenario.before.intentHash);
        assert.equal(scenario.childAfter.text.includes('PRIVATE SYNTHETIC A'), false); assert.ok(scenario.childAfter.watch.every(item => !item.A));
        assert.deepEqual(scenario.childAfter.network.denied, []);
        await fit('genuine-two-document-parent-iframe-B');
      } finally {
        scenario.childClose = await ev('return await f.closeChild();');
        if (scenario.childClose) {
          assert.equal(scenario.childClose.sdkDisposed, true); assert.equal(scenario.childClose.observerUnsubscribed, true);
          assert.equal(scenario.childClose.rootChildren, 0); assert.equal(scenario.childClose.pendingFetches, 0);
          assert.deepEqual(scenario.childClose.pendingControlledTasks, []); assert.deepEqual(scenario.childClose.listeners, { storage: 0, visibility: 0 });
          assert.deepEqual(scenario.childClose.networkDenied, []);
        }
      }
    });

    await t.test('closed network and unchanged actual source receipts', async () => {
      const state = await snapshot(); assert.deepEqual(state.network.denied, []);
      assert.deepEqual(browser.exceptions, []); assert.deepEqual(fixture.controls.rejected, []);
      assert.deepEqual(fixture.controls.pending(), []); assert.deepEqual(fixture.controls.unconsumed(), []);
      assert.ok(browser.requests.every(url => new URL(url).origin === fixture.origin), 'No external browser request');
      for (const item of fixture.controls.requests) {
        if (item.path.startsWith('/api/')) assert.ok(item.method === 'GET' && ['/api/crm/auth-context', '/api/crm/operator-account', '/api/crm/contributor-account'].includes(item.path));
        else if (item.method === 'POST') assert.ok(['password', 'signup', 'verify', 'logout'].includes(item.operation));
        else assert.equal(item.method, 'GET');
      }
      for (const [method, route] of [['POST', '/operator'], ['POST', '/api/crm/operator-account'], ['GET', '/api/crm/unknown'],
        ['GET', '/sw.js'], ['POST', '/auth/v1/token?grant_type=refresh_token'], ['GET', '/auth/v1/user?extra=1']]) {
        const response = await fetch(fixture.origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(3000) });
        await response.arrayBuffer(); assert.equal(response.status, 403);
        intentionalGateProbes.push({ method, path: route, status: response.status });
      }
      await fixture.assertSourcesUnchanged();
      await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt(), null, 2));
    });
  });
