import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ownedRecoveryBrowser } from '../src/appointment-recovery-committed-fixture.ts';
import { createWorkspaceBrowser, stopWorkspaceBrowserBuilds, root, ids } from './partner-company-workspace-browser.mjs';

const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
test('actual applicant page/client/provider handoff in local Chromium, synthetic SDK and HTTP only', { timeout: 180000 }, async t => {
  const base = path.join(root, 'node_modules/.cache/partner-company-workspace-browser'); await mkdir(base, { recursive: true });
  const output = await mkdtemp(path.join(base, 'run-'));
  const report = { actualParent: true, actualClient: true, actualAuthProvider: true, actualTokenAndFetchGuards: true,
    syntheticSdkAndApi: true, nativeOrRealAuthProof: false, productionOrCloud: false, passed: [], captures: [], sourceHashes: {} };
  let server, browser;
  t.diagnostic(output);
  t.after(async () => {
    try { if (browser) { report.final = await browser.evaluate('return f.snapshot();').catch(() => null); await browser.close(); report.browserClosed = true; } }
    finally { try { if (server) { await server.close(); report.serverClosed = true; report.transport = server.controls.snapshot(); } }
      finally { stopWorkspaceBrowserBuilds();
        for (const [file, hash] of Object.entries(report.sourceHashes)) hash.after = await digest(file);
        await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      } }
    for (const hash of Object.values(report.sourceHashes)) assert.equal(hash.after, hash.before, 'Freeze sources during integration acceptance');
  });
  server = await createWorkspaceBrowser();
  for (const file of [...server.sourceInputs, server.builtCss,
    path.join(root, 'scripts/fixtures/partner-company-workspace-browser.mjs'),
    path.join(root, 'scripts/fixtures/partner-company-workspace-browser.test.mjs')]) report.sourceHashes[file] = { before: await digest(file) };
  browser = await ownedRecoveryBrowser(server.origin, { settleTimeoutMs: 12000 });
  const { evaluate: ev, waitFor: wait } = browser;
  const button = `document.querySelector('.pci-open-workspace')`;
  async function ready() { await wait(`f.auth&&!f.auth.isLoading&&${button}&&!${button}.disabled`); }
  async function reset() { await ev('f?.unmount?.();localStorage.clear();'); await server.controls.reset(); await browser.load(); await ready(); }
  async function click() { await ev(`const b=${button};if(!b||b.disabled)throw Error('Missing enabled workspace button');b.click();`); }
  async function capture(name) { await writeFile(path.join(output, name + '.png'), await browser.screenshot()); report.captures.push(name); }
  async function check(name, run) { await t.test(name, run); report.passed.push(name); }
  for (const width of [375, 1440]) await check(`selected target replaces a different persisted company at ${width}`, async () => {
    await browser.viewport(width, width === 375 ? 812 : 960); await reset();
    assert.equal(await ev('return f.snapshot().selector;'), ids.previous);
    assert.equal(await ev('return f.auth.clinicId;'), ids.previous);
    await capture('approved-before-' + width);
    await click(); await wait(`location.pathname==='/dashboard'&&f.auth.clinicId==='${ids.target}'&&f.dashboardReads.length===4`);
    const current = await ev('return f.snapshot();');
    assert.equal(current.selector, ids.target); assert.equal(current.auth.role, 'owner'); assert.equal(current.auth.purpose, 'marketing');
    assert.equal(current.dashboardReads.length, 4); assert.ok(current.dashboardReads.every(read => read.id === ids.target && read.status === 200));
    assert.equal(current.readWorkspaceId, ids.target);
    const handoff = server.controls.calls.findIndex(call => call.kind === 'workspace');
    assert.ok(handoff > 0); assert.ok(server.controls.calls.slice(0, handoff).some(call => call.kind === 'auth'));
    assert.deepEqual(server.controls.calls.slice(handoff).map(call => call.kind), ['workspace', 'auth', 'data', 'data', 'data', 'data']);
    assert.ok(server.controls.calls.every(call => call.actor === ids.a));
    const layout = await ev('return {viewport:innerWidth,width:document.documentElement.scrollWidth};');
    assert.ok(layout.width <= layout.viewport + 1); await capture('target-after-' + width);
  });
  await check('held membership check clears old selection and never reads old-company data', async () => {
    await reset(); server.controls.queue('auth', { hold: true }); await click();
    await wait('f.auth.isLoading&&f.auth.clinicId===null');
    const current = await ev('return f.snapshot();'); assert.equal(current.selector, null); assert.equal(current.pathname, '/partner-company');
    assert.equal(current.dashboardReads.length, 0); assert.equal(server.controls.held.length, 1);
    server.controls.release(); await wait(`location.pathname==='/dashboard'&&f.auth.clinicId==='${ids.target}'`);
  });
  for (const all of [false, true]) await check(`actual destination stays target-safe with ${all ? 'all storage blocked' : 'old selector readable and writes blocked'}`, async () => {
    await reset(); await ev(`f.failStorage(${all});`); await click();
    await wait(`location.pathname==='/dashboard'&&f.dashboardReads.length===4`);
    const current = await ev('return f.snapshot();');
    assert.equal(current.auth.clinicId, ids.target); assert.equal(current.readWorkspaceId, ids.target);
    assert.ok(current.dashboardReads.every(read => read.id === ids.target && read.status === 200));
    assert.equal(current.selector, all ? '<storage unavailable>' : ids.previous);
  });
  await check('shared selector overwrite cannot redirect the destination reads after entry', async () => {
    await reset(); await click(); await wait(`location.pathname==='/dashboard'&&f.dashboardReads.length===4`);
    await ev(`localStorage.setItem('negis_workspace_selector','${ids.previous}');f.navigate('/partner-company');`);
    await ready(); await ev("f.clearCache();f.navigate('/dashboard');"); await wait('f.dashboardReads.length===8');
    const current = await ev('return f.snapshot();');
    assert.equal(current.selector, ids.previous); assert.equal(current.readWorkspaceId, ids.target);
    assert.ok(current.dashboardReads.every(read => read.id === ids.target));
  });
  await check('actual ProtectedPage remounts an already mounted destination on an explicit tenant switch', async () => {
    await reset(); await click(); await wait(`location.pathname==='/dashboard'&&f.dashboardReads.length===4`);
    server.controls.dataWorkspaces.add(ids.previous);
    await ev(`f.clearCache();f.select('${ids.previous}');`); await wait('f.dashboardReads.length===8');
    assert.ok((await ev('return f.dashboardReads.slice(4);')).every(read => read.id === ids.previous));
    await ev(`f.clearCache();f.select('${ids.target}');`); await wait('f.dashboardReads.length===12');
    assert.ok((await ev('return f.dashboardReads.slice(8);')).every(read => read.id === ids.target));
    assert.equal(await ev('return location.pathname;'), '/dashboard');
  });
  await check('actual ProtectedPage cannot open the previous destination during the first authority check', async () => {
    await reset(); server.controls.queue('workspace', { hold: true }); await click(); await wait('f.auth.isLoading&&f.auth.clinicId===null');
    await ev("f.navigate('/dashboard');"); server.controls.release(); await wait('!f.auth.isLoading');
    assert.equal(await ev('return f.dashboardReads.length;'), 0); assert.equal(await ev('return f.auth.clinicId;'), null);
    assert.equal(await ev('return f.snapshot().readWorkspaceId;'), '');
    await ev("f.navigate('/partner-company');"); await ready();
    assert.equal(server.controls.calls.filter(call => call.kind === 'workspace').length, 1, 'Returning to inbox never replays the cancelled entry');
  });
  for (const event of ['TOKEN_REFRESHED', 'USER_UPDATED']) await check(`newer ${event} cannot restore a sole other company during the first check`, async () => {
    await reset(); server.controls.queue('workspace', { hold: true }); await click(); await wait('f.auth.isLoading&&f.auth.clinicId===null');
    server.controls.owner = false; await ev(`f.refresh('${event}');`); await wait('!f.auth.isLoading');
    server.controls.release(); await wait(`document.querySelector('[role="alert"]')`);
    const current = await ev('return f.snapshot();');
    assert.equal(current.pathname, '/partner-company'); assert.equal(current.auth.clinicId, null); assert.equal(current.selector, null);
    assert.equal(current.readWorkspaceId, ''); assert.equal(current.dashboardReads.length, 0);
  });
  for (const refusal of ['revoked', '503', 'malformed']) await check(`fresh membership ${refusal} has no previous-company fallback`, async () => {
    await reset();
    if (refusal === 'revoked') server.controls.owner = false;
    if (refusal === '503') server.controls.queue('auth', { status: 503 });
    if (refusal === 'malformed') server.controls.queue('auth', { value: { success: true, data: { memberships: [{ workspaceId: ids.target, role: 'owner' }] } } });
    await click(); await wait(`!f.auth.isLoading&&document.querySelector('[role="alert"]')`);
    const current = await ev('return f.snapshot();');
    assert.equal(current.pathname, '/partner-company'); assert.equal(current.auth.clinicId, null); assert.equal(current.selector, null);
    assert.equal(current.dashboardReads.length, 0);
    if (refusal === 'revoked') assert.equal(await ev(`return !!${button};`), false, 'Confirmed refusal hides private selected application');
    await capture('membership-' + refusal);
  });
  await check('actor ABA during held application confirmation cannot navigate later', async () => {
    await reset(); server.controls.queue('workspace', { hold: true }); await click();
    await wait(`document.querySelector('.pci-open-workspace')?.getAttribute('aria-busy')==='true'`);
    await ev('f.aba();'); server.controls.release(); await ready();
    await ev('await new Promise(r=>setTimeout(r,50));');
    const current = await ev('return f.snapshot();'); assert.equal(current.pathname, '/partner-company');
    assert.equal(current.dashboardReads.length, 0); assert.equal(server.controls.calls.filter(call => call.kind === 'workspace').length, 1);
  });
  await check('blur during held membership check cancels the target and leaves no selected fallback', async () => {
    await reset(); server.controls.queue('auth', { hold: true }); await click(); await wait('f.auth.isLoading&&f.auth.clinicId===null');
    await ev("window.dispatchEvent(new Event('blur'));"); server.controls.release();
    await wait('!f.auth.isLoading');
    const current = await ev('return f.snapshot();'); assert.equal(current.pathname, '/partner-company');
    assert.equal(current.auth.clinicId, null); assert.equal(current.selector, null); assert.equal(current.dashboardReads.length, 0);
    await ev("window.dispatchEvent(new Event('focus'));"); await ready();
  });
  await check('workspace HTTP denial hides the selected application before membership selection', async () => {
    await reset(); server.controls.queue('workspace', { status: 403 }); await click();
    await wait(`document.querySelector('[role="alert"]')&&!${button}`);
    assert.equal(server.controls.calls.filter(call => call.kind === 'auth').length, 1);
    assert.equal(await ev('return f.dashboardReads.length;'), 0);
    assert.equal(await ev('return f.auth.clinicId;'), null); assert.equal(await ev('return f.snapshot().readWorkspaceId;'), '');
  });
  for (const fail of [false, true]) await check(`page sign-out fences a held first confirmation before SDK ${fail ? 'failure' : 'success'}`, async () => {
    await reset(); server.controls.queue('workspace', { hold: true }); await click(); await wait('f.auth.isLoading&&f.auth.clinicId===null');
    await ev(`f.signOutPlan={hold:true,fail:${fail}};document.querySelector('.portal-signout').click();`);
    await wait('f.auth.isSigningOut&&f.signOutCalls===1'); server.controls.release();
    assert.equal(await ev('return f.auth.clinicId;'), null);
    assert.equal(await ev('return f.snapshot().readWorkspaceId;'), '');
    assert.equal(await ev('return f.dashboardReads.length;'), 0);
    await ev('f.releaseSignOut();');
    if (!fail) await wait('!f.auth.isSigningOut');
    else await wait('f.auth.isSigningOut&&!document.querySelector(".pci-open-workspace")');
    assert.equal(await ev('return location.pathname==="/dashboard";'), false);
    assert.equal(server.controls.calls.filter(call => call.kind === 'auth').length, 1, 'No fresh membership dispatch after exit intent');
  });
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(server.controls.errors, []); assert.deepEqual(server.controls.refusals, []);
  assert.deepEqual(await ev('return f.refusals;'), []);
  assert.ok(browser.requests.every(url => url.startsWith(server.origin + '/')), 'No external requests');
});
