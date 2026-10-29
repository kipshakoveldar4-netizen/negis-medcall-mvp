import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createStartupRecoveryBrowser, startupOperation, startupRequestAllowed, coverageGaps, ids, limits, root, stopStartupRecoveryBuilds } from './auth-startup-recovery-browser.mjs';

// Final runs require explicit Main freeze; initial runs require separate explicit
// authorization. Use pinned Node in a clean OS-only child environment and execute
// this module directly: node --test discards the authorization argument.
const confirmed = process.argv.includes('--startup-recovery-freeze-confirmed');
const initialAuthorized = process.argv.includes('--startup-recovery-initial-authorized');
const startupOnly = process.argv.includes('--startup-only');
const invocation = { argv: process.argv.slice(1), execArgv: [...process.execArgv], startupRecoveryFreezeFlagReceived: confirmed,
  phase: confirmed ? 'final-frozen' : 'initial-unfrozen', selectedSuite: startupOnly ? 'AuthContext-impersonation-only' : 'startup-and-recovery' };
assert.equal(confirmed !== initialAuthorized, true, 'Require exactly one explicit Main authorization: --startup-recovery-freeze-confirmed or --startup-recovery-initial-authorized. No SDK/browser started.');
assert.ok(!confirmed || !startupOnly, 'Final frozen proof must run the full startup/recovery suite');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('startup/recovery fake HTTP is closed by host, origin, method and exact path', () => {
  const origin = 'http://127.0.0.1:5399', req = { method: 'GET', url: '/reset-password', headers: { host: '127.0.0.1:5399' } };
  assert.equal(startupRequestAllowed(req, origin), true);
  for (const change of [{ method: 'DELETE' }, { method: 'PATCH' }, { method: 'OPTIONS' }, { url: '//foreign.invalid/a' },
    { url: 'https://foreign.invalid/a' }, { url: '/a\n' }, { headers: { host: 'localhost:5399' } },
    { headers: { ...req.headers, origin: 'https://foreign.invalid' } }, { headers: { ...req.headers, referer: 'https://foreign.invalid' } },
    { headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } }]) assert.equal(startupRequestAllowed({ ...req, ...change }, origin), false);
  const op = (method, url) => startupOperation(method, new URL(url, origin));
  assert.equal(op('PUT', '/auth/v1/user'), 'password-put'); assert.equal(op('GET', '/auth/v1/user'), 'user');
  assert.equal(op('POST', '/auth/v1/verify'), 'otp'); assert.equal(op('POST', '/api/impersonation/verify'), 'imp-verify');
  assert.equal(op('POST', '/api/impersonation/session'), 'imp-session');
  for (const [method, route] of [['POST', '/auth/v1/token'], ['PUT', '/auth/v1/user?extra=1'], ['POST', '/auth/v1/recover'],
    ['GET', '/api/impersonation/verify'], ['POST', '/api/crm/operator-account'], ['PUT', '/rest/v1/users']]) assert.equal(op(method, route), null);
});

test('actual App startup and native implicit recovery remain scoped to their original synthetic actor', { timeout: 240_000 }, async t => {
  let fixture, browser, output, active = false;
  const scenarios = [], screenshots = [], documentClosures = [], gateProbes = [];
  const cleanup = { react: null, browserClosed: false, server: null, esbuildStopped: false };
  const receipt = () => ({ invocation, scope: fixture?.scope, coverageGaps, selectedProof: invocation.selectedSuite, phase: invocation.phase, limits, sdk: fixture?.sdk, sourceHashes: fixture?.sourceHashes,
    bundleHashes: fixture?.bundleHashes, bootHashes: fixture?.controls.bootHashes, scenarios, screenshots, documentClosures,
    network: { requests: fixture?.controls.requests, rejected: fixture?.controls.rejected, releases: fixture?.controls.releases,
      mutations: fixture?.controls.mutations, browserRequests: browser?.requests, exceptions: browser?.exceptions, gateProbes }, cleanup });
  const assertClosed = close => {
    assert.equal(close.rootChildren, 0); assert.equal(close.observerUnsubscribed, true); assert.equal(close.facadeDisposed, true); assert.equal(close.sdkDisposed, true);
    assert.equal(close.pendingTasks, 0); assert.equal(close.pendingFetches, 0); assert.deepEqual(close.denied, []);
    assert.deepEqual(close.listeners, { storage: 0, visibility: 0 });
    assert.equal(close.watchOverflow, false);
    assert.ok(close.detachedPasswordLengths.every(length => length === 0), 'Retired DOM nodes must retain no password');
  };
  t.after(async () => {
    try {
      if (browser) {
        try { fixture.controls.releaseAll(); if (active) cleanup.react = await browser.evaluate('return await f.shutdown();'); }
        finally { await browser.close(); cleanup.browserClosed = true; }
      }
    } finally {
      try { if (fixture) cleanup.server = await fixture.close(); }
      finally {
        stopStartupRecoveryBuilds(); cleanup.esbuildStopped = true;
        t.diagnostic('startup-close-receipt ' + JSON.stringify(cleanup));
        if (output) {
          await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt(), null, 2));
          await writeFile(path.join(output, 'close.json'), JSON.stringify(cleanup, null, 2));
        }
      }
    }
    if (browser) assert.equal(cleanup.browserClosed, true);
    if (fixture) assert.deepEqual(cleanup.server, { listening: false, held: 0, plans: 0, sockets: 0 });
    if (active) assertClosed(cleanup.react);
  });
  fixture = await createStartupRecoveryBrowser({ startupRecoveryRunAuthorized: confirmed || initialAuthorized });
  const base = path.join(root, 'output/auth-startup-recovery-browser'); await mkdir(base, { recursive: true }); output = await mkdtemp(path.join(base, 'run-'));
  await writeFile(path.join(output, 'sources.json'), JSON.stringify({ invocation, sdk: fixture.sdk, sourceHashes: fixture.sourceHashes, bundleHashes: fixture.bundleHashes }, null, 2));
  t.diagnostic('startup-evidence ' + output); t.diagnostic('startup-scope ' + fixture.scope); t.diagnostic('startup-listener ' + fixture.origin);
  const { ownedRecoveryBrowser } = await import('../src/appointment-recovery-committed-fixture.ts');
  browser = await ownedRecoveryBrowser(fixture.origin, { settleTimeoutMs: 12_000 }); active = true;
  const { evaluate: ev, waitFor: wait } = browser;
  const state = () => ev('return await f.snapshot();');
  const until = async (predicate, label, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate() && Date.now() < deadline) await sleep(20);
    assert.ok(predicate(), label);
  };
  const pending = async operation => {
    await until(() => fixture.controls.pending().some(item => item.operation === operation && item.actor === 'A'), 'Expected held synthetic ' + operation);
    return fixture.controls.pending().find(item => item.operation === operation && item.actor === 'A');
  };
  const reset = async (name, width, options) => {
    fixture.controls.releaseAll(); assert.deepEqual(fixture.controls.unconsumed(), [], 'Every planned startup hold must actually occur');
    if (active) { const close = await ev('return await f.shutdown();'); documentClosures.push(close); active = false; assertClosed(close); }
    const previous = await ev('return f.run;'); fixture.controls.configure(name, options); await browser.viewport(width, 900);
    await browser.load(); active = true; await wait(`f.run!==${JSON.stringify(previous)}`); await ev('f.observe();');
  };
  const formReady = () => wait(`!!document.querySelector('form input[name=password]')&&!!document.querySelector('form input[name=confirm]')`);
  const invalidReady = () => wait(`!document.querySelector('form input[name=password]')&&/\u043d\u0435\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043b|\u0438\u0441\u0442\u0435\u043a\u043b|\u0443\u0441\u0442\u0430\u0440\u0435\u043b/i.test(document.getElementById('root').textContent)`);
  const fill = () => ev(`f.fill('input[name=password]','SyntheticRecovery42!');f.fill('input[name=confirm]','SyntheticRecovery42!');f.remember();f.retainSubmit();`);
  const switchB = async record => {
    await ev('f.startB();'); await wait('f.task()?.done'); const task = await ev('return f.task();'); assert.equal(task.error, null, JSON.stringify(task));
    await ev('await f.idle();'); record.beforeRelease = await state();
    assert.equal(record.beforeRelease.storedId, ids.B); assert.equal(record.beforeRelease.sdkId, ids.B); assert.equal(record.beforeRelease.sdkError, false);
    assert.equal(record.beforeRelease.privateA, false, 'Original A private labels must disappear before its held HTTP response');
    assert.equal(record.beforeRelease.recoveryForm, false, 'Original recovery form must be retired when B replaces A');
    assert.ok(record.beforeRelease.passwordLengths.every(length => length === 0));
    assert.ok(record.beforeRelease.detachedPasswordLengths.every(length => length === 0));
    record.eventCutoff = record.beforeRelease.events.length; record.requestCutoff = fixture.controls.requests.length;
    await ev('f.watchPrivate();');
  };
  const assertBUnchanged = async record => {
    await ev('await f.idle();'); record.after = await state();
    assert.equal(record.after.storedId, ids.B); assert.equal(record.after.sdkId, ids.B); assert.equal(record.after.sdkError, false);
    for (const key of ['storedHash', 'revisionHash', 'intentHash']) assert.equal(record.after[key], record.beforeRelease[key], 'Late A cannot change B ' + key);
    assert.equal(record.after.privateA, false); assert.equal(record.after.recoveryForm, false); assert.equal(record.after.success, false);
    assert.equal(record.after.watchOverflow, false);
    assert.ok(record.after.passwordLengths.every(length => length === 0)); assert.ok(record.after.detachedPasswordLengths.every(length => length === 0));
    assert.ok(record.after.watch.every(frame => !frame.A && !frame.success && !frame.recoveryForm), 'No transient private A, old form or stale success may return');
    assert.ok(record.after.events.slice(record.eventCutoff).every(event => event.id === ids.B), 'No stale A auth publication after B');
    assert.ok(fixture.controls.requests.slice(record.requestCutoff).filter(item => item.path.startsWith('/api/crm/')).every(item => item.actor === 'B'), 'No new private A business read after B');
    assert.equal(fixture.controls.mutations.filter(item => item.actor === 'B').length, 0, 'No password mutation may target B');
  };
  const screenshot = async name => {
    await ev('await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));');
    const metrics = await ev(`const nodes=[...document.querySelectorAll('#root input,#root button,#root label,#root h1,#root p')].filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden');
      const sidebarEllipsis=n=>{const s=getComputedStyle(n);return n.matches('aside.medina-sidebar p.truncate')&&s.textOverflow==='ellipsis'&&s.overflowX==='hidden';};
      const describe=n=>({tag:n.tagName,type:n.type||null,className:n.className,rect:n.getBoundingClientRect().toJSON(),clientWidth:n.clientWidth,scrollWidth:n.scrollWidth});
      const bad=nodes.filter(n=>{const r=n.getBoundingClientRect();return r.left<0||r.right>innerWidth+1||r.width<=0||(n.scrollWidth>n.clientWidth+2&&!sidebarEllipsis(n));});
      const intentionalSidebarEllipsis=nodes.filter(n=>n.scrollWidth>n.clientWidth+2&&sidebarEllipsis(n)).map(describe);
      const fields=[...document.querySelectorAll('form input')].filter(n=>n.getClientRects().length).map(n=>n.getBoundingClientRect().toJSON());
      return{width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,bad:bad.map(describe),intentionalSidebarEllipsis,fields};`);
    const png = await browser.screenshot(); assert.ok(png.length > 5000); assert.equal(png.readUInt32BE(16), metrics.width); assert.equal(png.readUInt32BE(20), metrics.height);
    const file = name + '-' + metrics.width + '.png'; await writeFile(path.join(output, file), png);
    const receipt = { file, sha256: hash(png), bytes: png.length, ...metrics }; screenshots.push(receipt);
    assert.equal(metrics.overflow, false, JSON.stringify(metrics)); assert.deepEqual(metrics.bad, []);
    for (let index = 1; index < metrics.fields.length; index++) assert.ok(metrics.fields[index].top >= metrics.fields[index - 1].bottom, 'Recovery fields must not overlap');
    return receipt;
  };

  for (const width of [375, 1440]) {
    if (!startupOnly) {
    for (const name of ['no-hash', 'forged-user-metadata', 'forged-query-marker', 'expired-link']) await t.test(`${name} cannot grant recovery at ${width}`, async () => {
      const record = { scenario: 'invalid-recovery-grant', caseName: name, width }; scenarios.push(record);
      await reset(name, width); const before = fixture.controls.mutations.length; await invalidReady(); record.state = await state();
      assert.equal(record.state.recoveryForm, false); assert.equal(record.state.success, false);
      assert.equal(fixture.controls.mutations.length, before, 'A URL marker, metadata or expired link cannot authorize a password PUT');
      await screenshot(name);
    });

    await t.test(`native implicit recovery presents actual form and updates only A at ${width}`, async () => {
      const record = { scenario: 'native-valid-recovery', width }; scenarios.push(record);
      await reset('valid-recovery', width); await formReady(); record.validated = await state();
      assert.equal(record.validated.sdkId, ids.A); assert.equal(record.validated.storedId, ids.A);
      assert.ok(fixture.controls.requests.some(item => item.caseRun === record.validated.caseRun && item.operation === 'user' && item.actor === 'A' && item.status === 200), 'Actual native URL recovery must validate synthetic user A');
      await screenshot('valid-recovery-form'); const before = fixture.controls.mutations.length;
      fixture.controls.holdPasswordPut(); await fill(); await ev('f.submit();'); const old = await pending('password-put');
      record.busy = await state(); assert.ok(record.busy.passwordLengths.every(length => length === 0), 'Dispatch clears both synthetic password fields');
      await screenshot('valid-recovery-busy'); record.release = fixture.controls.release(old.id);
      await wait(`document.getElementById('root').textContent.includes('\u041f\u0430\u0440\u043e\u043b\u044c \u043e\u0431\u043d\u043e\u0432\u043b\u0451\u043d')`);
      record.success = await state(); assert.equal(record.success.sdkId, ids.A); assert.equal(record.success.storedId, ids.A);
      assert.equal(fixture.controls.mutations.length - before, 1); assert.equal(fixture.controls.mutations.at(-1).actor, 'A');
      assert.ok(record.success.passwordLengths.every(length => length === 0)); await screenshot('valid-recovery-success');
    });

    await t.test(`held native user validation cannot grant a recovery form before its response at ${width}`, async () => {
      const record = { scenario: 'native-recovery-validation-gate', width }; scenarios.push(record);
      await reset('held-recovery-validation', width); const old = await pending('user');
      record.beforeValidation = await ev('return f.domSnapshot();');
      assert.equal(record.beforeValidation.recoveryForm, false, 'Implicit URL bytes alone must not grant the form before actual SDK user validation');
      record.release = fixture.controls.release(old.id); await formReady(); record.afterValidation = await state();
      assert.equal(record.afterValidation.sdkId, ids.A); assert.equal(record.afterValidation.storedId, ids.A);
      await screenshot('native-recovery-validation-gate');
    });
    }

    for (const [name, operation] of [['held-impersonation-verify', 'imp-verify'], ['held-impersonation-otp', 'otp']])
      await t.test(`${name}: B replaces original A before late response at ${width}`, async () => {
        const record = { scenario: 'held-startup-A-to-B', caseName: name, operation, width }; scenarios.push(record);
        await reset(name, width); const old = await pending(operation); await switchB(record);
        record.release = fixture.controls.release(old.id); await assertBUnchanged(record);
        if (operation === 'imp-verify') assert.equal(fixture.controls.requests.slice(record.requestCutoff).filter(item => item.operation === 'imp-session' || item.operation === 'otp').length, 0, 'Retired verification must not proceed to session/OTP exchange');
        await screenshot(name + '-B-preserved');
      });

    if (!startupOnly) {
    await t.test(`positive native owner-Control startup stores a verified hint and enters the actual owner dashboard at ${width}`, async () => {
      const record = { scenario: 'positive-native-owner-control', width, scope: 'Actual App/AuthProvider and actual Dashboard; four exact empty synthetic list DTOs, not server authorization or operational-data acceptance.' }; scenarios.push(record);
      await reset('held-impersonation-otp', width, { positiveOwner: true }); const old = await pending('otp');
      record.beforeOtp = await state();
      assert.equal(record.beforeOtp.impersonationPresent, false, 'No impersonation hint may be stored before actual native OTP response');
      assert.equal(record.beforeOtp.path, '/operator');
      record.release = fixture.controls.release(old.id); assert.equal(record.release.delivered, true);
      await wait(`location.pathname==='/dashboard'&&!!document.querySelector('.negis-app-shell .negis-main')`);
      const paths = ['/api/crm/appointments', '/api/crm/leads', '/api/crm/clients', '/api/crm/deals'];
      await until(() => paths.every(path => fixture.controls.requests.some(item => item.caseRun === record.beforeOtp.caseRun && item.path === path && item.status === 200)), 'Actual Dashboard must read all four exact synthetic workspace lists');
      await ev('await f.idle();'); record.after = await state();
      assert.equal(record.after.sdkId, ids.A); assert.equal(record.after.storedId, ids.A);
      assert.equal(record.after.dashboardRendered, true); assert.equal(record.after.path, '/dashboard');
      assert.deepEqual(record.after.impersonationHint, { actorId: ids.A, workspaceId: ids.workspace });
      assert.equal(record.after.privateA, true, 'Only a freshly verified owner startup may show the synthetic target hint/banner');
      assert.ok(fixture.controls.requests.some(item => item.caseRun === record.beforeOtp.caseRun && item.path === '/api/crm/auth-context' && item.actor === 'A' && item.id > old.id), 'Owner membership must be reread after the actual OTP response');
      const lists = fixture.controls.requests.filter(item => item.caseRun === record.beforeOtp.caseRun && item.operation === 'dashboard-list');
      assert.ok(lists.every(item => item.actor === 'A' && item.workspaceId === ids.workspace));
      await screenshot('positive-native-owner-control-dashboard');
    });

    await t.test(`held recovery password PUT for A cannot mutate B or revive form/success at ${width}`, async () => {
      const record = { scenario: 'held-password-put-A-to-B', width }; scenarios.push(record);
      await reset('valid-recovery', width); await formReady(); fixture.controls.holdPasswordPut(); await fill(); await ev('f.submit();');
      const old = await pending('password-put'); await switchB(record);
      const mutations = fixture.controls.mutations.length; await ev('await f.invokeRetiredSubmit();');
      assert.equal(fixture.controls.mutations.length, mutations, 'Retired real form handler cannot dispatch another update');
      record.release = fixture.controls.release(old.id); await assertBUnchanged(record);
      await ev('await new Promise(resolve=>setTimeout(resolve,3300));'); await assertBUnchanged(record);
      assert.equal(record.after.path, record.beforeRelease.path, 'Retired recovery success timer cannot redirect B');
      await screenshot('held-password-put-B-preserved');
    });

    await t.test(`App unmount retires held recovery PUT and its retained form callback at ${width}`, async () => {
      const record = { scenario: 'recovery-App-unmount', width }; scenarios.push(record);
      await reset('valid-recovery', width); await formReady(); fixture.controls.holdPasswordPut(); await fill(); await ev('f.submit();');
      const old = await pending('password-put'); record.beforeUnmount = await state(); await ev('f.unmount();await f.invokeRetiredSubmit();');
      record.release = fixture.controls.release(old.id); await ev('await f.idle();'); record.state = await state();
      assert.equal(record.state.text, ''); assert.equal(record.state.recoveryForm, false); assert.equal(record.state.success, false);
      assert.equal(record.state.storedHash, record.beforeUnmount.storedHash, 'An unmounted form cannot publish a late SDK user/session write');
      assert.ok(record.state.detachedPasswordLengths.every(length => length === 0));
      assert.equal(fixture.controls.mutations.filter(item => item.id === old.id).length, 1);
      assert.equal(fixture.controls.mutations.filter(item => item.actor === 'B').length, 0);
    });
    }
  }

  await t.test('startup network, source hashes, caps and screenshot receipts stay closed', async () => {
    assert.deepEqual(browser.exceptions, []); assert.deepEqual(fixture.controls.rejected, []);
    assert.deepEqual(fixture.controls.pending(), []); assert.deepEqual(fixture.controls.unconsumed(), []);
    assert.ok(!fixture.controls.requests.some(item => item.leaseExpired), 'Held response lease must not expire during a valid test');
    assert.ok(browser.requests.every(url => new URL(url).origin === fixture.origin));
    assert.ok(fixture.controls.mutations.every(item => item.actor === 'A'));
    for (const item of fixture.controls.requests) if (['PUT', 'POST'].includes(item.method)) assert.ok(['password-put', 'otp', 'imp-verify', 'imp-session'].includes(item.operation));
    for (const [method, route] of [['PUT', '/operator'], ['POST', '/api/crm/operator-account'], ['GET', '/api/crm/unknown'], ['POST', '/auth/v1/token'], ['GET', '/sw.js']]) {
      const response = await fetch(fixture.origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(3000) });
      await response.arrayBuffer(); assert.equal(response.status, 403); gateProbes.push({ method, path: route, status: response.status });
    }
    await fixture.assertSourcesUnchanged();
    for (const screenshot of screenshots) assert.equal(hash(await readFile(path.join(output, screenshot.file))), screenshot.sha256);
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt(), null, 2));
  });
});
