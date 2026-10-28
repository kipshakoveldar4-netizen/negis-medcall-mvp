import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ownedRecoveryBrowser } from '../src/appointment-recovery-committed-fixture.ts';
import { createPartnerCompanyInboxBrowser, inboxIds, root, stopPartnerCompanyInboxBuilds, syntheticInboxItems } from './partner-company-inbox-browser.mjs';

const componentDirectory = path.join(root, 'artifacts/negis/src/components/contributors');
const component = path.join(componentDirectory, 'PartnerCompanyInbox.tsx');
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const a = syntheticInboxItems(inboxIds.a), b = syntheticInboxItems(inboxIds.b);
const surface = '.partner-company-inbox';
const encode = value => JSON.stringify(value);
async function until(check) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(30); }
  assert.fail('Owned read-only inbox transport did not settle');
}

test('actual PartnerCompanyInbox and PortalShell in owned Chromium; synthetic identity/read/workspace callbacks, not Auth/navigation/API/SQL proof', { timeout: 300000 }, async t => {
  const base = path.join(root, 'node_modules/.cache/partner-company-inbox-browser');
  await mkdir(base, { recursive: true });
  const output = await mkdtemp(path.join(base, 'run-'));
  const report = { actualComponent: component, actualShell: true, syntheticIdentity: true, syntheticTransport: true,
    selectedWorkspaceNavigation: false, genericShellTeamHref: '/login',
    syntheticWorkspaceCallback: true, actualAuthOrParentNavigation: false, originalTestCountIncludingParent: 15,
    nativeApiOrSqlProof: false, viewports: [375, 1440], passed: [], failed: [], captures: [], layouts: [], scenarios: [], sourceHashes: {},
    requests: [], exceptions: [], serverClosed: false, browserClosed: false };
  let server, browser;
  t.diagnostic('Owned inbox captures/source hashes/report: ' + output);
  t.after(async () => {
    try {
      if (browser) {
        report.finalState = await browser.evaluate('return f.snapshot();').catch(error => ({ error: error.message }));
        report.requests = [...browser.requests]; report.exceptions = [...browser.exceptions];
        await writeFile(path.join(output, 'last-state.png'), await browser.screenshot()).catch(() => {});
      }
    } finally {
      try {
        await browser?.evaluate('f?.unmount?.();f?.workspace?.release();').catch(() => {});
        await browser?.close(); report.browserClosed = true;
      }
      finally {
        try { await server?.close(); report.serverClosed = true; }
        finally {
          stopPartnerCompanyInboxBuilds();
          report.transport = server?.controls.snapshot();
          for (const [file, hashes] of Object.entries(report.sourceHashes)) hashes.after = await digest(file);
          await writeFile(path.join(output, 'source-hashes.json'), JSON.stringify(report.sourceHashes, null, 2));
          await writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
        }
      }
    }
    for (const [file, hashes] of Object.entries(report.sourceHashes)) assert.equal(hashes.after, hashes.before, 'Source unchanged during browser proof: ' + file);
  });
  report.componentSha256 = await digest(component);
  server = await createPartnerCompanyInboxBrowser();
  report.builtCss = server.builtCss;
  const sources = new Set([...server.sourceInputs, server.builtCss, component,
    path.join(componentDirectory, 'partner-company-inbox.css'),
    path.join(root, 'scripts/src/appointment-recovery-committed-fixture.ts'),
    path.join(root, 'scripts/fixtures/partner-company-inbox-browser.mjs'),
    path.join(root, 'scripts/fixtures/partner-company-inbox-browser.test.mjs'),
    ...['inter-latin.woff2', 'inter-cyrillic.woff2', 'inter-cyrillic-ext.woff2'].map(name => path.join(root, 'artifacts/negis/public/fonts/inter', name))]);
  for (const file of sources) report.sourceHashes[file] = { before: await digest(file) };
  assert.equal(report.sourceHashes[component].before, report.componentSha256, 'Frozen inbox source does not change while bundling');
  browser = await ownedRecoveryBrowser(server.origin, { settleTimeoutMs: 12000 });
  const { evaluate: ev, waitFor: wait } = browser;
  const controls = server.controls;
  const rootExpression = `document.querySelector(${encode(surface)})`;
  const buttons = `[...${rootExpression}.querySelectorAll('button')]`;
  const action = pattern => `(${buttons}.find(e=>${pattern}.test(e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent.trim())))`;
  const actions = {
    refresh: action('/Обновить/'), next: action('/Следующая страница/'), previous: action('/Предыдущая страница/'),
    fresh: action('/Новая заявка/'),
  };
  const row = item => `(${buttons}.find(e=>e.textContent.includes(${encode(item.company.name)})||e.getAttribute('aria-label')?.includes(${encode(item.company.name)})))`;
  const workspaceButton = `${rootExpression}?.querySelector('.pci-detail button')`;
  const click = expression => ev(`const e=${expression};if(!e||e.disabled)throw Error('Missing enabled inbox control');e.click();`);
  const setFilter = value => ev(`const e=${rootExpression}.querySelector('select');if(!e||e.disabled)throw Error('Missing enabled native filter');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${encode(value || 'all')});e.dispatchEvent(new Event('change',{bubbles:true}));`);
  const remember = (key, expression, event = 'onClick') => ev(`const e=${expression};if(!e)throw Error('Missing callback target');
    const props=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))];if(typeof props?.[${encode(event)}]!=='function')throw Error('Missing actual React callback');
    f[${encode(key)}]=props[${encode(event)}];`);
  const replay = key => ev(`f[${encode(key)}]({preventDefault(){},target:{value:'rejected'},currentTarget:{value:'rejected'}});`);
  const body = () => ev(`return ${rootExpression}?.innerText??'';`);
  const ready = async () => {
    await wait(`${rootExpression}&&${rootExpression}.getAttribute('aria-busy')!=='true'&&f.calls.length>0&&f.calls.at(-1).settled`);
    await ev('await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));');
  };
  const shownNames = async (items = a) => {
    const text = await body(); return items.filter(item => text.includes(item.company.name)).map(item => item.company.name);
  };
  const assertNoWorkspaceShortcut = async () => {
    assert.equal(await ev(`return ${rootExpression}?.querySelectorAll('a[href]').length??0;`), 0,
      'Read-only inbox must not offer a link that could open a previously selected workspace');
    assert.equal(await ev(`return !!${rootExpression}?.querySelector('.pci-detail button,.pci-detail [role="link"],.pci-detail [role="button"]');`), false,
      'Selected application detail is read-only, not a targeted workspace launcher');
  };
  const assertWorkspaceControl = async () => {
    const state = await ev(`const detail=${rootExpression}?.querySelector('.pci-detail');return {
      links:${rootExpression}?.querySelectorAll('a[href],[role="link"]').length??0,
      approved:!!detail?.querySelector('.pci-state-approved'),
      controls:detail?.querySelectorAll('button,[role="button"]').length??0};`);
    assert.equal(state.links, 0, 'No href or generic previously selected workspace shortcut');
    assert.equal(state.controls, state.approved ? 1 : 0, 'Only approved detail has the optional guarded workspace button');
  };
  const assertNoPrivate = async () => {
    assert.equal(/SYNTHETIC [AB] (?:COMPANY|OWNER)/.test(await body()), false, 'Unavailable scope must not show private rows or details');
    await assertNoWorkspaceShortcut();
  };
  const assertClean = async () => {
    const state = await ev('return f.snapshot();');
    assert.deepEqual(state.storageCalls, [], 'Inbox must not read, write, clear, or enumerate browser storage');
    assert.deepEqual(state.networkRefusals, []);
    assert.equal(await ev('return sessionStorage.length+localStorage.length;'), 0, 'No browser storage persistence');
    assert.ok(state.calls.every(call => call.unchanged), 'Actual inbox must not mutate received transport objects');
    assert.ok(state.workspace.calls.every(call => call.unchanged), 'Workspace action must not mutate its captured application');
    assert.ok(state.workspace.calls.every(call => call.guardAtDispatch), 'Synthetic callback is only invoked with a current guard');
    assert.deepEqual(state.workspace.held, [], 'No synthetic workspace action left held after a scenario');
    assert.deepEqual(controls.errors, []); assert.deepEqual(controls.refusals, []);
    assert.ok(controls.requests.every(record => record.method === 'GET'));
    assert.equal(await ev(`return !!${rootExpression}?.querySelector('form,input,textarea');`), false, 'Read-only inbox does not create a form or editable PII');
    assert.equal(/PRIVATE SYNTHETIC/.test(await body()), false, 'Private read/action error bodies are never rendered');
    assert.equal(await ev('return location.href;'), server.origin + '/', 'Synthetic callback never actually navigates');
    if (state.workspaceEnabled) await assertWorkspaceControl();
    else {
      assert.deepEqual(state.workspace.calls, [], 'An omitted optional callback cannot open a workspace');
      await assertNoWorkspaceShortcut();
    }
  };
  async function start(configure = () => {}) {
    await ev('f.unmount();f.workspace.release();'); await controls.reset(); configure();
    const boot = await ev('return f.bootId;');
    await browser.load(); await wait(`f.bootId!==${encode(boot)}&&!!${rootExpression}`);
  }
  const startWorkspace = (configure = () => {}) => start(() => { controls.workspaceCallback = true; configure(); });
  const workspaceState = () => ev('return f.workspace.snapshot();');
  const workspaceSettled = async () => {
    await wait('f.workspace.calls.length>0&&f.workspace.calls.every(call=>call.settled)');
    await ev('await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));');
  };
  const holdWorkspace = plan => ev(`f.workspace.queue(${encode({ hold: true, ...plan })});`);
  const releaseWorkspace = async () => { await ev('f.workspace.release();'); await workspaceSettled(); };
  const assertRetiredWorkspace = async () => {
    const state = await workspaceState();
    assert.equal(state.calls[0].aborted, true, 'UI aborts an obsolete workspace action');
    assert.equal(state.calls[0].current, false, 'Guard remains false for the obsolete action');
    assert.deepEqual(state.successes, [], 'No synthetic success from an obsolete action');
  };
  async function fit(name) {
    for (const width of [375, 1440]) {
      await browser.viewport(width, 1050);
      await ev('window.scrollTo(0,0);await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));');
      const layout = await ev(`const s=${rootExpression};const visible=e=>e.getBoundingClientRect().width>0;
        return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
          shell:!!document.querySelector('.portal-workspace .portal-content'),
          inter:getComputedStyle(document.body).fontFamily.includes('Inter')&&[...document.fonts].some(font=>font.family.includes('Inter')&&font.status==='loaded'),
          brokenImages:[...document.images].filter(e=>!e.complete||!e.naturalWidth).map(e=>e.src),
          offscreen:[...s.querySelectorAll('button,select,a')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.left<0||r.right>innerWidth+1;}).map(e=>e.outerHTML),
          clipped:[...s.querySelectorAll('button,select,h2,h3,dd')].filter(visible).filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>e.textContent.trim()),
          workspaceButton:(()=>{const e=s.querySelector('.pci-detail button');if(!e)return null;const r=e.getBoundingClientRect();
            return {text:e.textContent.trim(),disabled:e.disabled,left:r.left,right:r.right,width:r.width,height:r.height,
              scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,hasIcon:!!e.querySelector('svg')};})()};`);
      report.layouts.push({ name, ...layout });
      const filename = `${name}-${width}.png`, bytes = await browser.screenshot();
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG'); assert.ok(bytes.length > 5000, 'Nonblank actual shell/component capture');
      await writeFile(path.join(output, filename), bytes); report.captures.push(filename);
      assert.ok(layout.scrollWidth <= width, 'No page overflow: ' + JSON.stringify(layout));
      assert.equal(layout.shell, true); assert.equal(layout.inter, true, 'Actual local Inter font loaded');
      assert.deepEqual(layout.brokenImages, []); assert.deepEqual(layout.offscreen, []); assert.deepEqual(layout.clipped, []);
      if (name.startsWith('workspace-approved')) {
        assert.ok(layout.workspaceButton?.hasIcon, 'Actual approved action includes its icon');
        assert.ok(layout.workspaceButton.width > 0 && layout.workspaceButton.height >= 44, 'Approved button has usable stable dimensions');
        assert.ok(layout.workspaceButton.text.length > 0, 'Approved button has a visible accessible label');
        assert.ok(layout.workspaceButton.scrollWidth <= layout.workspaceButton.clientWidth + 2, 'Approved action label fits');
      }
      if (width === 375 && name.endsWith('-detail')) {
        await ev(`document.querySelector('.pci-detail').scrollIntoView({block:'start'});
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));`);
        const filename = `${name}-${width}-scrolled.png`;
        await writeFile(path.join(output, filename), await browser.screenshot()); report.captures.push(filename);
      }
    }
  }
  const scenario = (name, run, workspace = false) => t.test(name, async () => {
    try {
      await start(() => { controls.workspaceCallback = workspace; }); await run(); await assertClean();
      report.scenarios.push({ name, transport: controls.snapshot(), browser: await ev('return f.snapshot();') });
      report.passed.push(name);
    }
    catch (error) {
      report.failed.push({ name, error: error.stack });
      await writeFile(path.join(output, `failure-${report.failed.length}.png`), await browser.screenshot()).catch(() => {});
      throw error;
    }
  });

  await scenario('actual shell, list/detail at 375/1440, native status filter and exact 20+1 pagination', async () => {
    await ready();
    assert.deepEqual(await shownNames(), a.slice(0, 20).map(item => item.company.name));
    assert.deepEqual(await ev(`return [...${rootExpression}.querySelector('select').options].map(e=>e.value);`), ['all', 'pending', 'approved', 'rejected']);
    assert.equal(await ev(`return ${actions.previous}.disabled;`), true);
    await fit('ready-list');
    await click(row(a[0]));
    assert.ok((await body()).includes(a[0].company.ownerName), 'Actual detail shows the selected owner');
    await assertNoWorkspaceShortcut();
    await fit('pending-detail');
    await click(actions.next); await ready();
    assert.deepEqual(await shownNames(), [a[20].company.name]);
    assert.equal((await body()).includes(a[0].company.ownerName), false, 'Paging clears previous selected detail');
    assert.deepEqual(controls.requests.map(({ offset, state }) => ({ offset, state })), [{ offset: 0, state: null }, { offset: 20, state: null }]);
    assert.equal(await ev(`return ${actions.next}.disabled;`), true); await fit('page-two');
    await click(actions.previous); await ready();
    for (const state of ['pending', 'approved', 'rejected', '']) {
      await setFilter(state); await ready();
      assert.equal(controls.requests.at(-1).offset, 0); assert.equal(controls.requests.at(-1).state, state || null);
      assert.deepEqual(await shownNames(), a.filter(item => !state || item.state === state).slice(0, 20).map(item => item.company.name));
    }
  });

  await scenario('approved detail offers no misleading workspace shortcut; generic team entry stays in the shell only', async () => {
    await ready();
    for (const index of [1, 2, 0]) {
      await click(row(a[index]));
      assert.ok((await body()).includes(a[index].company.ownerName));
      await assertNoWorkspaceShortcut();
      assert.deepEqual(await ev(`return [...document.querySelectorAll('.portal-sidebar .portal-nav a[href]')]
        .map(e=>({href:e.getAttribute('href'),label:e.textContent.trim(),inInbox:!!e.closest(${encode(surface)})}));`),
      [{ href: '/login', label: 'Вход для команды', inInbox: false }], 'Team entry is generic shell navigation, not bound to the selected application');
      if (index === 1) await fit('approved-detail');
      if (index === 2) await fit('rejected-detail');
    }
    assert.equal(controls.requests.length, 1, 'Local detail selection does not issue any mutation or extra transport');
  });

  await scenario('loading, empty, safe error and explicit retry keep private data hidden', async () => {
    await start(() => controls.queue({ hold: true })); await until(() => controls.held.length === 1);
    await assertNoPrivate(); await fit('loading'); controls.release(); await ready();
    await start(() => { controls.items.set(inboxIds.a, []); }); await ready();
    assert.equal((await shownNames()).length, 0); assert.ok((await body()).length > 0); await fit('empty');
    await click(actions.fresh); assert.deepEqual(await ev('return f.newApplications;'), [{ actorId: inboxIds.a, revision: 0 }]);
    await start(() => controls.queue({ status: 503 })); await ready();
    assert.ok(await ev(`return !!${rootExpression}.querySelector('[role="alert"]');`));
    await assertNoPrivate(); await fit('error'); await click(actions.refresh); await ready();
    assert.equal(controls.requests.length, 2); assert.equal((await shownNames()).length, 20);
  });

  await scenario('401/403/404 deny without leaking private text, firing new-form callbacks or reviving refresh', async () => {
    for (const status of [401, 403, 404]) {
      await start(); await ready(); await click(row(a[1]));
      await remember('oldRefresh', actions.refresh); await remember('oldNew', actions.fresh);
      controls.queue({ status }); await click(actions.refresh); await ready();
      assert.deepEqual(await ev('return f.denials;'), [{ actorId: inboxIds.a, revision: 0 }]);
      await assertNoPrivate();
      const count = controls.requests.length;
      await replay('oldRefresh'); await replay('oldNew');
      await ev('window.dispatchEvent(new Event("focus"));'); await delay(60);
      assert.equal(controls.requests.length, count, 'Denied lifetime cannot silently revalidate');
      assert.deepEqual(await ev('return f.newApplications;'), []);
      await fit('denied-' + status);
    }
  });

  await scenario('A-B-A retires held response and retained row/filter/page/refresh/new callbacks', async () => {
    await ready();
    for (const [key, expression, event] of [['oldRow', row(a[0])], ['oldNext', actions.next], ['oldRefresh', actions.refresh],
      ['oldNew', actions.fresh], ['oldFilter', `${rootExpression}.querySelector('select')`, 'onChange']]) await remember(key, expression, event);
    controls.queue({ hold: true }); await click(actions.refresh); await until(() => controls.held.length === 1);
    await ev('f.oldCall=f.calls.at(-1);f.switch("b");'); await ready();
    assert.equal(await ev('return f.oldCall.signal.aborted&&!f.oldCall.isCurrent();'), true);
    assert.deepEqual(await shownNames(b), b.slice(0, 20).map(item => item.company.name));
    assert.equal((await shownNames(a)).length, 0);
    await ev('f.switch("a");'); await ready();
    const count = controls.requests.length;
    for (const key of ['oldRow', 'oldNext', 'oldRefresh', 'oldNew', 'oldFilter']) await replay(key);
    await delay(60); assert.equal(controls.requests.length, count);
    assert.deepEqual(await ev('return f.newApplications;'), []);
    controls.release(); await until(() => controls.tasks.size === 0); await ready();
    assert.equal(await ev('return f.oldCall.isCurrent();'), false);
    assert.deepEqual(await ev('return f.denials;'), []);
  });

  await scenario('late denied and failed replies from actor A never deny actor B or overwrite its list', async () => {
    for (const status of [401, 403, 404, 503]) {
      await start(); await ready();
      controls.queue({ status, hold: true }); await click(actions.refresh); await until(() => controls.held.length === 1);
      await ev('f.oldCall=f.calls.at(-1);f.switch("b");');
      await wait(`f.calls.some(c=>c.actorId===f.ids.b&&c.settled)`);
      controls.release(); await ready();
      assert.deepEqual(await shownNames(b), b.slice(0, 20).map(item => item.company.name));
      assert.deepEqual(await ev('return f.denials;'), []);
      assert.equal(await ev('return f.oldCall.signal.aborted&&!f.oldCall.isCurrent();'), true);
    }
  });

  await scenario('late filter response and retained callbacks cannot overwrite a newer filter', async () => {
    await ready();
    await remember('oldRow', row(a[0])); await remember('oldNext', actions.next);
    await remember('oldFilter', `${rootExpression}.querySelector('select')`, 'onChange');
    controls.queue({ state: 'pending', hold: true }); await setFilter('pending'); await until(() => controls.held.length === 1);
    await ev('f.oldCall=f.calls.at(-1);'); await setFilter('approved');
    await wait(`f.calls.some(c=>c.state==='approved'&&c.settled)`);
    const count = controls.requests.length;
    for (const key of ['oldRow', 'oldNext', 'oldFilter']) await replay(key);
    await delay(60); assert.equal(controls.requests.length, count);
    controls.release(); await ready();
    assert.equal(await ev('return f.oldCall.signal.aborted&&!f.oldCall.isCurrent();'), true);
    assert.equal(controls.requests.at(-1).state, 'approved');
    assert.deepEqual(await shownNames(), a.filter(item => item.state === 'approved').map(item => item.company.name));
  });

  await scenario('page callbacks are retired; a held page-two reply cannot revive after filter reset', async () => {
    await ready(); await remember('oldNext', actions.next); await remember('oldNew', actions.fresh);
    controls.queue({ offset: 20, hold: true }); await click(actions.next); await until(() => controls.held.length === 1);
    await ev('f.oldCall=f.calls.at(-1);');
    await setFilter('rejected'); await wait(`f.calls.some(c=>c.state==='rejected'&&c.settled)`);
    const count = controls.requests.length;
    await replay('oldNext'); await replay('oldNew'); await delay(60);
    assert.equal(controls.requests.length, count); assert.deepEqual(await ev('return f.newApplications;'), []);
    controls.release(); await ready();
    assert.equal(await ev('return f.oldCall.signal.aborted&&!f.oldCall.isCurrent();'), true);
    assert.equal(controls.requests.at(-1).offset, 0); assert.equal(controls.requests.at(-1).state, 'rejected');
    assert.deepEqual(await shownNames(), a.filter(item => item.state === 'rejected').map(item => item.company.name));
  });

  await scenario('blur removes list and owner detail immediately; only a fresh focus read restores data', async () => {
    await ready(); await click(row(a[1])); await remember('oldNew', actions.fresh); await remember('oldRow', row(a[0]));
    controls.queue({ hold: true }); await click(actions.refresh); await until(() => controls.held.length === 1);
    await ev('f.oldCall=f.calls.at(-1);window.dispatchEvent(new Event("blur"));');
    await assertNoPrivate();
    assert.equal(await ev('return f.oldCall.signal.aborted&&!f.oldCall.isCurrent();'), true);
    const count = controls.requests.length;
    await replay('oldNew'); await replay('oldRow');
    controls.release(); await until(() => controls.tasks.size === 0); await delay(60); await assertNoPrivate();
    assert.equal(controls.requests.length, count); assert.deepEqual(await ev('return f.newApplications;'), []);
    await fit('blurred');
    await ev('window.dispatchEvent(new Event("focus"));'); await ready();
    assert.equal(controls.requests.length, count + 1); assert.equal((await shownNames()).length, 20);
    assert.equal((await body()).includes(a[1].company.ownerName), false, 'Focus does not silently reopen old private detail');
  });

  await scenario('raw invalid session blocks retained new-form callback before a rerender; rendered invalidation hides PII', async () => {
    await ready(); await remember('oldNew', actions.fresh); await remember('oldRefresh', actions.refresh);
    await ev('f.gate(false);');
    const count = controls.requests.length;
    await replay('oldNew'); await replay('oldRefresh'); await delay(60);
    assert.equal(controls.requests.length, count); assert.deepEqual(await ev('return f.newApplications;'), []);
    await ev('f.invalidate();'); await assertNoPrivate();
    await replay('oldNew'); await replay('oldRefresh');
    assert.equal(controls.requests.length, count); assert.deepEqual(await ev('return f.newApplications;'), []);
  });

  await scenario('parent callback churn retains original actor-scoped request and denial callbacks', async () => {
    await ready(); const revision = await ev('return f.calls[0].revision;');
    await ev('f.swapCallbacks();'); await click(actions.refresh); await ready();
    assert.equal(await ev('return f.calls.at(-1).revision;'), revision);
    controls.queue({ status: 403 }); await click(actions.refresh); await ready();
    assert.deepEqual(await ev('return f.denials;'), [{ actorId: inboxIds.a, revision }]); await assertNoPrivate();
  });

  await scenario('new-application callback is actor-scoped and cannot be replayed from an obsolete frame', async () => {
    await ready(); await ev('f.swapCallbacks();'); await remember('oldNew', actions.fresh);
    const count = controls.requests.length;
    await click(actions.fresh); await replay('oldNew'); await replay('oldNew');
    assert.deepEqual(await ev('return f.newApplications;'), [{ actorId: inboxIds.a, revision: 0 }]);
    assert.equal(controls.requests.length, count, 'New form is a guarded parent callback, not an inbox mutation');
    await remember('newBeforeBlur', actions.fresh); await ev('window.dispatchEvent(new Event("blur"));');
    await replay('newBeforeBlur');
    assert.equal(await ev('return f.newApplications.length;'), 1);
    await assertNoPrivate();
  });

  await scenario('malformed, oversized, wrong-page and wrong-filter responses fail closed without phantom rows', async () => {
    for (const value of [null, { items: a.slice(0, 21), offset: 0, state: null, hasMore: false },
      { items: [a[0]], offset: 20, state: null, hasMore: false },
      { items: [a[0]], offset: 0, state: 'pending', hasMore: false },
      { items: [{ ...a[0], company: { ...a[0].company, email: 'not-a-real-field@fixture.invalid' } }], offset: 0, state: null, hasMore: false }]) {
      await start(() => controls.queue({ value })); await ready(); await assertNoPrivate();
      assert.ok(await ev(`return !!${rootExpression}.querySelector('[role="alert"]');`));
    }
    await fit('malformed-response');
  });

  await scenario('unmount aborts outstanding reads and retires every captured action', async () => {
    await ready(); await remember('oldNew', actions.fresh); await remember('oldNext', actions.next);
    controls.queue({ hold: true }); await click(actions.refresh); await until(() => controls.held.length === 1);
    await ev('f.oldCall=f.calls.at(-1);f.unmount();');
    assert.equal(await ev('return f.oldCall.signal.aborted&&!f.oldCall.isCurrent();'), true);
    const count = controls.requests.length;
    await replay('oldNew'); await replay('oldNext'); controls.release(); await until(() => controls.tasks.size === 0); await delay(60);
    assert.equal(controls.requests.length, count); assert.deepEqual(await ev('return f.newApplications;'), []);
    assert.equal(await ev(`return !!${rootExpression};`), false);
  });

  await scenario('optional synthetic workspace callback exposes a fitted approved button only, never pending/rejected links', async () => {
    await ready();
    for (const index of [0, 1, 2, 4]) {
      await click(row(a[index])); await assertWorkspaceControl();
      assert.ok((await body()).includes(a[index].company.ownerName));
      if (index === 1) await fit('workspace-approved-detail');
      if (index === 2) await assertNoWorkspaceShortcut();
    }
    assert.deepEqual((await workspaceState()).calls, [], 'Selection alone does not invoke the synthetic callback');
    assert.equal(controls.requests.length, 1, 'Displaying the optional action does not add reads or mutations');
  }, true);

  await scenario('busy duplicate DOM clicks and retained callback dispatch once; delayed synthetic success captures the exact target and guard', async () => {
    await ready(); await click(row(a[1])); await holdWorkspace();
    await remember('retainedOpen', workspaceButton);
    const reads = controls.requests.length;
    await ev(`const e=${workspaceButton};e.click();e.click();f.retainedOpen();f.retainedOpen();`);
    await wait('f.workspace.held.length===1');
    let state = await workspaceState();
    assert.equal(state.calls.length, 1); assert.equal(state.calls[0].settled, false);
    assert.deepEqual(state.calls[0].target, { applicationId: a[1].id, workspaceId: a[1].workspaceId });
    assert.equal(state.calls[0].current, true); assert.equal(state.calls[0].aborted, false);
    assert.deepEqual(state.successes, [], 'Held callback is not a successful workspace open');
    assert.equal(await ev(`return ${workspaceButton}.disabled;`), true, 'Actual workspace button is disabled while pending');
    await fit('workspace-approved-busy-detail');
    await releaseWorkspace(); state = await workspaceState();
    assert.equal(state.calls[0].guardAtSettlement, true); assert.equal(state.calls[0].outcome, 'success');
    assert.deepEqual(state.successes, [{ syntheticOnly: true, actorId: inboxIds.a, revision: 0,
      applicationId: a[1].id, workspaceId: a[1].workspaceId }]);
    await replay('retainedOpen'); await replay('retainedOpen');
    assert.equal((await workspaceState()).calls.length, 1, 'Old pre-busy closure cannot dispatch after completion');
    assert.equal(controls.requests.length, reads, 'The synthetic callback does not call any workspace/API transport');
  }, true);

  await scenario('delayed workspace failures never record synthetic success, expose private errors or prevent an explicit retry', async () => {
    for (const status of [409, 503]) {
      await startWorkspace(); await ready(); await click(row(a[1])); await holdWorkspace({ status });
      await click(workspaceButton); await wait('f.workspace.held.length===1');
      assert.deepEqual((await workspaceState()).successes, []);
      await releaseWorkspace();
      let state = await workspaceState();
      assert.equal(state.calls[0].outcome, 'failure'); assert.deepEqual(state.successes, []);
      assert.deepEqual(state.failures, [{ id: 1, status, current: true }]);
      assert.deepEqual(await ev('return f.denials;'), []);
      assert.ok(await ev(`return !!${rootExpression}.querySelector('[role="alert"]');`), 'Real component shows a safe action failure');
      assert.equal(/PRIVATE SYNTHETIC/.test(await body()), false);
      assert.ok((await body()).includes(a[1].company.ownerName), 'Non-access failure preserves the current selection');
      assert.equal(await ev(`return ${workspaceButton}.disabled;`), false, 'Explicit retry is enabled after failure');
      await fit('workspace-failure-' + status + '-detail');
      await click(workspaceButton); await workspaceSettled(); state = await workspaceState();
      assert.equal(state.calls.length, 2); assert.equal(state.successes.length, 1, 'Only the explicit successful retry is recorded');
      assert.equal(await ev(`return !!${rootExpression}.querySelector('[role="alert"]');`), false, 'Retry clears obsolete error');
    }
  }, true);

  await scenario('switching selection retires the old action closure; the busy target stays pinned to the newly selected application', async () => {
    await ready(); await click(row(a[1])); await remember('retainedOpen', workspaceButton);
    await click(row(a[4])); await replay('retainedOpen');
    assert.deepEqual((await workspaceState()).calls, [], 'Old action cannot retarget itself to the newer selection');
    await holdWorkspace(); await click(workspaceButton); await wait('f.workspace.held.length===1');
    assert.equal(await ev(`return ${row(a[1])}.disabled;`), true, 'Busy selection controls keep the captured target pinned');
    await ev(`${row(a[1])}.click();`); await replay('retainedOpen');
    assert.ok((await body()).includes(a[4].company.ownerName));
    assert.equal((await workspaceState()).calls.length, 1);
    await releaseWorkspace();
    assert.deepEqual((await workspaceState()).successes, [{ syntheticOnly: true, actorId: inboxIds.a, revision: 0,
      applicationId: a[4].id, workspaceId: inboxIds.otherWorkspace }]);
    await click(row(a[1])); await replay('retainedOpen');
    assert.equal((await workspaceState()).calls.length, 1, 'Selecting the original row again does not revive its old closure');
    await click(workspaceButton); await workspaceSettled();
    assert.deepEqual((await workspaceState()).calls.map(call => call.target), [
      { applicationId: a[4].id, workspaceId: inboxIds.otherWorkspace },
      { applicationId: a[1].id, workspaceId: inboxIds.workspace },
    ]);
  }, true);

  await scenario('blur aborts the action and hides private detail; neither late success nor late 403 can revive it', async () => {
    for (const status of [null, 403]) {
      await startWorkspace(); await ready(); await click(row(a[1]));
      await remember('retainedOpen', workspaceButton); await holdWorkspace({ status }); await click(workspaceButton);
      await wait('f.workspace.held.length===1'); await ev('window.dispatchEvent(new Event("blur"));');
      await assertNoPrivate(); await assertRetiredWorkspace(); await replay('retainedOpen');
      await releaseWorkspace(); await assertNoPrivate(); await assertRetiredWorkspace();
      assert.equal((await workspaceState()).calls.length, 1); assert.deepEqual(await ev('return f.denials;'), []);
      const reads = controls.requests.length;
      await ev('window.dispatchEvent(new Event("focus"));'); await ready();
      assert.equal(controls.requests.length, reads + 1);
      assert.equal((await body()).includes(a[1].company.ownerName), false);
      await assertNoWorkspaceShortcut();
      await click(row(a[4])); await click(workspaceButton); await workspaceSettled();
      assert.equal((await workspaceState()).successes.length, 1, 'A fresh post-focus action is independently usable');
    }
  }, true);

  await scenario('account A-B-A permanently retires old workspace callback and late success/403/failure without affecting the current actor', async () => {
    for (const status of [null, 403, 503]) {
      await startWorkspace(); await ready(); await click(row(a[1]));
      await remember('retainedOpen', workspaceButton); await holdWorkspace({ status }); await click(workspaceButton);
      await wait('f.workspace.held.length===1'); await ev('f.switch("b");'); await ready();
      await assertRetiredWorkspace();
      assert.deepEqual(await shownNames(b), b.slice(0, 20).map(item => item.company.name));
      assert.equal((await shownNames(a)).length, 0);
      await ev('f.switch("a");'); await ready(); await click(row(a[4]));
      await replay('retainedOpen'); assert.equal((await workspaceState()).calls.length, 1);
      await releaseWorkspace(); await assertRetiredWorkspace();
      assert.deepEqual(await ev('return f.denials;'), []);
      assert.ok((await body()).includes(a[4].company.ownerName));
      assert.equal(await ev(`return !!${rootExpression}.querySelector('[role="alert"]');`), false);
      await click(workspaceButton); await workspaceSettled();
      assert.deepEqual((await workspaceState()).successes, [{ syntheticOnly: true, actorId: inboxIds.a, revision: 0,
        applicationId: a[4].id, workspaceId: inboxIds.otherWorkspace }]);
    }
  }, true);

  await scenario('current workspace 403 hides all private content and retires action/new/refresh callbacks without a fake success', async () => {
    await ready(); await click(row(a[1]));
    await remember('retainedOpen', workspaceButton); await remember('oldNew', actions.fresh); await remember('oldRefresh', actions.refresh);
    await holdWorkspace({ status: 403 }); await click(workspaceButton); await wait('f.workspace.held.length===1');
    await releaseWorkspace();
    assert.deepEqual(await ev('return f.denials;'), [{ actorId: inboxIds.a, revision: 0 }]);
    await assertNoPrivate(); await assertRetiredWorkspace();
    const reads = controls.requests.length;
    for (const key of ['retainedOpen', 'oldNew', 'oldRefresh']) await replay(key);
    await ev('window.dispatchEvent(new Event("focus"));'); await delay(60);
    assert.equal(controls.requests.length, reads); assert.equal((await workspaceState()).calls.length, 1);
    assert.deepEqual(await ev('return f.newApplications;'), []); await assertNoPrivate(); await fit('workspace-denied-403');
  }, true);

  await scenario('raw invalid session and unmount fence delayed synthetic workspace completion and retained action callbacks', async () => {
    for (const invalidate of ['f.gate(false);f.retainedOpen();', 'f.unmount();']) {
      await startWorkspace(); await ready(); await click(row(a[1]));
      await remember('retainedOpen', workspaceButton); await holdWorkspace(); await click(workspaceButton);
      await wait('f.workspace.held.length===1'); await ev(invalidate);
      await assertNoPrivate(); await assertRetiredWorkspace(); await replay('retainedOpen');
      await releaseWorkspace(); await assertRetiredWorkspace(); await assertNoPrivate();
      assert.equal((await workspaceState()).calls.length, 1); assert.deepEqual(await ev('return f.denials;'), []);
    }
  }, true);

  await scenario('optional synthetic workspace callback remains captured to its original actor lifetime across callback churn', async () => {
    await ready(); await ev('f.swapCallbacks();'); await click(row(a[1]));
    await holdWorkspace(); await click(workspaceButton); await wait('f.workspace.held.length===1');
    await ev('f.swapCallbacks();'); await releaseWorkspace();
    const state = await workspaceState();
    assert.equal(state.calls[0].revision, 0); assert.equal(state.calls[0].actorId, inboxIds.a);
    assert.deepEqual(state.successes, [{ syntheticOnly: true, actorId: inboxIds.a, revision: 0,
      applicationId: a[1].id, workspaceId: inboxIds.workspace }]);
  }, true);

  assert.deepEqual(browser.exceptions, []);
  assert.ok(browser.requests.every(url => url.startsWith(server.origin + '/') || /^(about:|data:)/.test(url)), 'Only owned loopback browser requests');
});
