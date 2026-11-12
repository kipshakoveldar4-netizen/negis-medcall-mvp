import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createPortalAuthEntryBrowser, portalAuthRequestAllowed, root, stopPortalAuthEntryBuilds } from './portal-auth-entry-browser.mjs';
import { ownedRecoveryBrowser } from '../src/appointment-recovery-committed-fixture.ts';

test('installed Supabase SDK 2.105.4 characterization: late auth responses mutate persistence before UI result guards', async t => {
  // Keep this negative control on the root baseline when the frontend upgrades.
  const require = createRequire(path.join(root, 'package.json'));
  const { AuthClient } = require('@supabase/supabase-js');
  const sdkPackage = require.resolve('@supabase/supabase-js/package.json');
  assert.equal(JSON.parse(await readFile(sdkPackage, 'utf8')).version, '2.105.4');
  const authPackage = createRequire(sdkPackage).resolve('@supabase/auth-js/package.json');
  const source = await readFile(path.join(path.dirname(authPackage), 'src/GoTrueClient.ts'));
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const origin = 'http://127.0.0.1:9', key = 'owned-portal-auth-characterization', storage = new Map(), events = [], requests = [];
  const ids = { A: '11111111-1111-4111-8111-111111111111', B: '22222222-2222-4222-8222-222222222222' };
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const user = actor => ({ id: ids[actor], email: 'owned-' + actor.toLowerCase() + '@example.test', aud: 'authenticated',
    app_metadata: { provider: 'synthetic' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  const token = actor => [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: ids[actor], aud: 'authenticated', exp: expiry, session_id: 'synthetic-' + actor })).toString('base64url'),
    Buffer.from('not-a-real-signature').toString('base64url')].join('.');
  const response = actor => Response.json({ access_token: token(actor), refresh_token: 'synthetic-' + actor,
    token_type: 'bearer', expires_in: 3600, user: user(actor) });
  let heldLogin, heldLogout, instantLogin = false, loginSettled = false, subscription;
  const fakeFetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, origin, 'No real service may be addressed');
    requests.push({ path: url.pathname, method: init.method });
    if (url.pathname === '/auth/v1/token' && url.search === '?grant_type=password' && init.method === 'POST') {
      const actor = JSON.parse(init.body).email === 'owned-a@example.test' ? 'A' : 'B';
      return instantLogin ? response(actor) : new Promise(resolve => { heldLogin = () => { resolve(response(actor)); heldLogin = null; }; });
    }
    if (url.pathname === '/auth/v1/user' && init.method === 'GET') {
      const authorization = new Headers(init.headers).get('Authorization');
      return Response.json(user(authorization === 'Bearer ' + token('B') ? 'B' : 'A'));
    }
    if (url.pathname === '/auth/v1/logout' && init.method === 'POST') return new Promise(resolve => { heldLogout = () => { resolve(new Response(null, { status: 204 })); heldLogout = null; }; });
    throw Error('Closed SDK fetch refused ' + url.pathname);
  };
  const client = new AuthClient({ url: origin + '/auth/v1', fetch: fakeFetch, autoRefreshToken: false,
    detectSessionInUrl: false, persistSession: true, storageKey: key,
    storage: { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value), removeItem: name => storage.delete(name) } });
  const operations = [];
  t.after(async () => {
    heldLogin?.(); heldLogout?.(); await Promise.allSettled(operations); subscription?.unsubscribe();
    await client.stopAutoRefresh(); storage.clear();
    t.diagnostic('installed-sdk-cleanup ' + JSON.stringify({ heldLogin: !!heldLogin, heldLogout: !!heldLogout, storage: storage.size, network: 'custom fake fetch only' }));
  });
  await client.initialize();
  subscription = client.onAuthStateChange((event, session) => events.push({ event, id: session?.user.id ?? null, loginSettled })).data.subscription;
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'Closed SDK operation reached its held response');
  };
  const login = client.signInWithPassword({ email: 'owned-a@example.test', password: 'SyntheticEntry42!' }).then(result => { loginSettled = true; return result; });
  operations.push(login); await until(() => !!heldLogin);
  assert.equal((await client.setSession({ access_token: token('B'), refresh_token: 'synthetic-B' })).error, null);
  assert.equal(JSON.parse(storage.get(key)).user.id, ids.B);
  heldLogin(); assert.equal((await login).error, null);
  assert.equal(JSON.parse(storage.get(key)).user.id, ids.A, 'Late password sign-in really overwrites B in SDK persistence');
  assert.ok(events.some(item => item.event === 'SIGNED_IN' && item.id === ids.A && !item.loginSettled), 'SDK publishes A before the caller can reject its late result');
  const logout = client.signOut(); operations.push(logout); await until(() => !!heldLogout);
  instantLogin = true;
  assert.equal((await client.signInWithPassword({ email: 'owned-b@example.test', password: 'SyntheticEntry42!' })).error, null);
  assert.equal(JSON.parse(storage.get(key)).user.id, ids.B);
  heldLogout(); assert.equal((await logout).error, null);
  assert.equal(storage.has(key), false, 'Late logout removes the newer SDK session');
  assert.equal((await client.getSession()).data.session, null);
  t.diagnostic('installed-sdk-boundary ' + JSON.stringify({ version: '2.105.4', sourceHash, requests,
    lateLoginOverwritesOtherActor: true, emitsBeforePromiseSettles: true, lateLogoutRemovesNewSession: true,
    scope: 'SDK characterization only; this does not prove an App-level atomic auth fix.' }));
});

test('portal auth host/origin/method gate is closed without consulting disk or services', () => {
  const origin = 'http://127.0.0.1:5299', req = { url: '/operator', method: 'GET', headers: { host: '127.0.0.1:5299' } };
  assert.equal(portalAuthRequestAllowed(req, origin), true);
  for (const change of [{ method: 'POST' }, { url: '//foreign.invalid/operator' }, { url: 'https://foreign.invalid/operator' },
    { headers: { host: 'localhost:5299' } }, { headers: { ...req.headers, origin: 'https://foreign.invalid' } },
    { headers: { ...req.headers, referer: 'https://foreign.invalid' } }, { headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } }])
    assert.equal(portalAuthRequestAllowed({ ...req, ...change }, origin), false);
});

test('actual App and provider compose portal entry, picker exclusions, and fenced sign-out in an owned browser', async t => {
  let server, browser, output;
  const receipt = { browserClosed: false, server: null, react: null, esbuildStopped: false };
  t.after(async () => {
    try {
      if (browser) {
        try { receipt.react = await browser.evaluate('return f.unmount();'); } finally { await browser.close(); receipt.browserClosed = true; }
      }
    } finally {
      try { if (server) receipt.server = await server.close(); } finally {
        stopPortalAuthEntryBuilds(); receipt.esbuildStopped = true;
        t.diagnostic('cleanup-receipt ' + JSON.stringify(receipt));
        if (output) await writeFile(path.join(output, 'cleanup.json'), JSON.stringify(receipt, null, 2));
      }
    }
    assert.deepEqual(receipt.server, { listening: false, held: 0 });
    assert.equal(receipt.react?.listeners, 0); assert.deepEqual(receipt.react?.pending, []);
  });
  server = await createPortalAuthEntryBrowser();
  t.diagnostic('source-hashes ' + JSON.stringify(server.sourceHashes));
  t.diagnostic('scope ' + server.scope);
  t.diagnostic('owned-listener ' + server.origin);
  browser = await ownedRecoveryBrowser(server.origin, { settleTimeoutMs: 12000 });
  const base = path.join(root, 'node_modules/.cache/portal-auth-entry-browser');
  await mkdir(base, { recursive: true }); output = await mkdtemp(path.join(base, 'run-'));
  t.diagnostic('evidence ' + output);
  const { evaluate: ev, waitFor: wait } = browser;
  const reset = async (route, actor = null) => {
    server.controls.holdProfiles = false; server.controls.release(); server.controls.memberships = 0;
    server.controls.profileName = 'PRIVATE SYNTHETIC A';
    await ev(`f.mount(${JSON.stringify(route)},${JSON.stringify(actor)});`);
    await wait(actor ? `document.querySelector('.portal-identity')?.textContent.includes('PRIVATE SYNTHETIC A')` : `!!document.querySelector('form input[type=password]')`);
  };
  const state = () => ev('return f.snapshot();');
  const fit = async name => {
    await ev('await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));');
    const metrics = await ev(`const visible=[...document.querySelectorAll('main input,main button,main label,main h1,.portal-page-header h1')]
      .filter(node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');
      const bad=visible.filter(node=>{const r=node.getBoundingClientRect();return r.width<=0||r.left<0||r.right>innerWidth+1||node.scrollWidth>node.clientWidth+2;});
      const fields=[...document.querySelectorAll('main input')].filter(node=>node.getClientRects().length).map(node=>({type:node.type,rect:node.getBoundingClientRect().toJSON()}));
      return{width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,bad:bad.map(node=>node.outerHTML.slice(0,240)),fields};`);
    assert.equal(metrics.overflow, false, JSON.stringify(metrics)); assert.deepEqual(metrics.bad, [], 'Visible controls/text must fit');
    for (let index = 1; index < metrics.fields.length; index++) assert.ok(metrics.fields[index].rect.top >= metrics.fields[index - 1].rect.bottom, 'Fields must not overlap');
    const screenshot = await browser.screenshot();
    assert.ok(screenshot.length > 5000, 'A rendered page, not an empty screenshot');
    const file = `${name}-${metrics.width}.png`; await writeFile(path.join(output, file), screenshot);
    return { file, sha256: createHash('sha256').update(screenshot).digest('hex'), ...metrics };
  };
  const screenshots = [];

  for (const route of ['/operator', '/contributors']) {
    for (const width of [375, 1440]) await t.test(`${route} actual login/signup forms at ${width}; duplicate submit and password cleanup`, async () => {
      await browser.viewport(width, 900); await reset(route);
      for (const mode of ['signin', 'signup']) {
        if (mode === 'signup') await ev(`f.press('\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044f');`);
        assert.equal(await ev(`return document.querySelector('input[type=password]').autocomplete;`), mode === 'signup' ? 'new-password' : 'current-password');
        screenshots.push(await fit(route.slice(1) + '-' + mode));
        for (const outcome of ['error', 'throw', 'success']) {
          await ev(`f.fill('form input[autocomplete=username]','owned-form@example.test');f.fill('form input[type=password]','SyntheticEntry42!');
            f.before=f.calls.length;f.remember();`);
          await ev(`const form=document.querySelector('form'),button=form.querySelector('button[type=submit]');
            const props=form[Object.keys(form).find(key=>key.startsWith('__reactProps$'))];f.retainedSubmit=props.onSubmit;
            f.click('form button[type=submit]');button.click();form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
          assert.equal(await ev('return f.calls.length-f.before;'), 1, 'Duplicate DOM submit dispatches exactly one fake SDK call');
          assert.deepEqual((await state()).passwords, [''], 'Dispatch clears the password while the SDK is held');
          assert.equal(await ev(`return [...document.querySelectorAll('form input,form button,[aria-label="\u0421\u043f\u043e\u0441\u043e\u0431 \u0432\u0445\u043e\u0434\u0430"] button')].every(node=>node.disabled);`), true, 'Busy fields and auth-mode controls are disabled');
          const operation = mode === 'signup' ? 'signUp' : 'signInWithPassword';
          await ev(`f.release(${JSON.stringify(operation)},${JSON.stringify(outcome)});`);
          await wait(`document.querySelector('form button[type=submit]')&&!document.querySelector('form button[type=submit]').disabled`);
          assert.deepEqual((await state()).passwords, [''], 'Settled auth result clears the password, including thrown failures');
          if (mode === 'signup') assert.equal(await ev('return f.calls.at(-1).redirect;'), server.origin + route);
        }
      }
      await ev(`f.fill('form input[type=password]','SyntheticEntry42!');f.click(${JSON.stringify(route === '/operator' ? '[role=tab]:first-child' : '[aria-label="Способ входа"] button:first-child')});`);
      assert.deepEqual((await state()).passwords, [''], 'Changing mode clears the password');
      await ev(`f.fill('form input[type=password]','SyntheticEntry42!');f.remember();f.click('form button[type=submit]');f.navigate(${JSON.stringify(route === '/operator' ? '/contributors' : '/operator')});`);
      await wait(`!!document.querySelector('form input[type=password]')`);
      assert.deepEqual((await state()).detached, [''], 'Retired submitted form retains no password in its detached node');
      await ev(`f.release('signInWithPassword','error');`);
      assert.deepEqual((await state()).passwords, [''], 'Late simple-promise result does not refill the new route form; no SDK persistence claim');
    });
  }

  await t.test('actual WorkspacePicker is active on workspace routes but never overlays contributor/operator/legal/reset routes', async () => {
    await browser.viewport(375, 900); await reset('/contributors', 'A'); server.controls.memberships = 2;
    await ev(`f.aba();`); await wait(`!!document.querySelector('.portal-identity')`);
    await ev(`f.navigate('/dashboard');`); await wait(`!!document.querySelector('[role=dialog][aria-label="\u0412\u044b\u0431\u043e\u0440 \u043a\u043b\u0438\u043d\u0438\u043a\u0438"]')`);
    for (const route of ['/contributors', '/contributors?mode=partner', '/contributors?mode=creator', '/operator', '/privacy', '/terms', '/data-deletion', '/reset-password']) {
      await ev(`f.navigate(${JSON.stringify(route)});`);
      await wait(`!!document.querySelector('main')`);
      assert.equal((await state()).picker, false, route + ' remains public with two unselected workspaces');
      if (route.includes('contributors')) assert.equal(await ev(`return !!document.querySelector('.portal-workspace')`), true);
    }
  });

  for (const route of ['/operator', '/contributors']) {
    await t.test(`${route} held profile read cannot publish after A/B/A`, async () => {
      await browser.viewport(1440, 900);
      await reset(route, 'A'); server.controls.profileName = 'STALE PRIVATE RESPONSE'; server.controls.holdProfiles = true;
      const selector = route === '/operator' ? '[aria-label="\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u0440\u0430\u0431\u043e\u0447\u0438\u0439 \u0434\u0435\u043d\u044c"]' : '[aria-label="\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u043f\u0440\u043e\u0444\u0438\u043b\u044c"]';
      await ev(`f.click(${JSON.stringify(selector)});`);
      await wait(`!document.body.innerText.includes('PRIVATE SYNTHETIC A')`);
      const deadline = Date.now() + 12000;
      while (!server.controls.held.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(server.controls.held.length, 'Owned profile GET reached its held response');
      const old = server.controls.held[0]; server.controls.profileName = 'FRESH PRIVATE RESPONSE'; await ev('f.aba();');
      old.send(); server.controls.held.splice(server.controls.held.indexOf(old), 1);
      await ev('await new Promise(resolve=>setTimeout(resolve,80));');
      assert.equal((await state()).text.includes('STALE PRIVATE RESPONSE'), false, 'Retired profile cannot revive after returning to A');
      server.controls.holdProfiles = false; server.controls.release();
      await wait(`document.body.innerText.includes('FRESH PRIVATE RESPONSE')`);
    });

    for (const outcome of ['error', 'throw']) await t.test(`${route} provider sign-out ${outcome} hides private UI before held SDK settles and survives A/B/A`, async () => {
      await browser.viewport(1440, 900); await reset(route, 'A');
      await ev(`const node=document.querySelector('[aria-label="\u0412\u044b\u0439\u0442\u0438 \u0438\u0437 \u0430\u043a\u043a\u0430\u0443\u043d\u0442\u0430"]');
        f.retainedExit=node[Object.keys(node).find(key=>key.startsWith('__reactProps$'))].onClick;f.before=f.calls.length;
        f.click('[aria-label="\u0412\u044b\u0439\u0442\u0438 \u0438\u0437 \u0430\u043a\u043a\u0430\u0443\u043d\u0442\u0430"]');`);
      const immediate = await state();
      assert.equal(immediate.text.includes('PRIVATE SYNTHETIC A'), false, 'Private profile disappears before the SDK answers');
      assert.equal(await ev(`return !!document.querySelector('.portal-workspace')`), false, 'Actual App SessionContent removes private portal tree');
      await ev('f.retainedExit();f.aba();');
      assert.equal(await ev(`return f.calls.filter(item=>item.operation==='signOut').length;`), 1, 'Retained exit joins provider in-flight sign-out');
      assert.equal((await state()).text.includes('PRIVATE'), false);
      await ev(`f.release('signOut',${JSON.stringify(outcome)});`);
      await wait(`document.body.innerText.includes('\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044c \u0432\u044b\u0445\u043e\u0434')`);
      await ev('f.aba();'); assert.equal((await state()).text.includes('PRIVATE'), false);
      screenshots.push(await fit(route.slice(1) + '-exit-' + outcome));
      await ev(`f.press('\u041f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u044c \u0432\u044b\u0445\u043e\u0434');`);
      await wait(`f.calls.filter(item=>item.operation==='signOut').length===2`);
      await ev(`f.release('signOut','success');`); await wait(`location.pathname==='/'&&!document.body.innerText.includes('PRIVATE')`);
    });
  }

  await t.test('network/SDK isolation and runtime source receipt', async () => {
    assert.deepEqual(await ev('return f.forbidden;'), []); assert.deepEqual(await ev('return f.networkDenied;'), []);
    assert.deepEqual(browser.exceptions, []);
    assert.ok(browser.requests.every(url => new URL(url).origin === server.origin), 'No external browser requests');
    assert.ok(server.controls.requests.every(item => item.method === 'GET'), 'HTTP is read-only');
    for (const url of ['/.env', '/api/crm/unknown', '/auth/v1/signup', '/sw.js']) {
      const response = await fetch(server.origin + url); await response.arrayBuffer(); assert.equal(response.status, 403);
    }
    const response = await fetch(server.origin + '/operator', { method: 'POST' }); await response.arrayBuffer(); assert.equal(response.status, 403);
    await server.assertSourcesUnchanged();
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ sourceHashes: server.sourceHashes, bundleHash: server.bundleHash,
      styleHash: server.styleHash, scope: server.scope, screenshots, requests: server.controls.requests }, null, 2));
  });
});
