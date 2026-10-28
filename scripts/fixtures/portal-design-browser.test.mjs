import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPortalDesignFixture, portalDesignRequestAllowed } from './portal-design-browser.mjs';

const require = createRequire(new URL('../../artifacts/negis/package.json', import.meta.url));
function loopbackRequest(origin, route, init = {}) {
  const target = new URL(route, origin);
  assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.origin, origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(target, { method: init.method || 'GET', headers: init.headers, agent: false }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk)); incoming.on('error', reject);
      incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers })));
    });
    req.on('error', error => reject(new Error(`Loopback ${route}: ${error.message}`, { cause: error })));
    req.setTimeout(15000, () => req.destroy(Error('Owned HTTP request timed out'))); req.end();
  });
}
// Bundle in memory to cross the repo's CJS/ESM package boundaries, without files.
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const { build: bundle } = esbuild;
after(() => esbuild.stop());
const compiled = await bundle({ write: false, bundle: true, format: 'esm', platform: 'node', stdin: {
  resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
    export * from './portal-design-store.ts';
    export { parseContributorProfile } from '../../lib/crm/contributor-contracts.ts';
    export { parseCreatorJobPage, parseCreatorJobDetail, parseCreatorCommandResult } from '../../lib/crm/creator-job-contracts.ts';
    export { parsePartnerLedger } from '../../lib/crm/partner-contracts.ts';
    export { parsePartnerHistory } from '../../lib/crm/partner-history-contracts.ts';
    export { parsePartnerTermsSnapshot } from '../../lib/crm/partner-terms-contracts.ts';
    export { parseOperatorCommandResult } from '../../lib/crm/operator-contracts.ts';`,
} });
const { createPortalDesignStore, portalDesignIds: ids, portalDesignLocation, portalDesignHref, portalDesignStates,
  parseContributorProfile, parseCreatorJobPage, parseCreatorJobDetail, parseCreatorCommandResult,
  parsePartnerLedger, parsePartnerHistory, parsePartnerTermsSnapshot, parseOperatorCommandResult,
} = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const url = route => new URL('/api/crm/' + route, 'http://fixture.invalid');
const request = (store, route, body, method = 'POST') => store.request(url(route), {
  method: body === undefined ? 'GET' : method, headers: { Authorization: `Bearer ${store.token()}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const data = async response => { const result = await response; assert.equal(result.status, 200); return (await result.json()).data; };
const accept = store => {
  const job = store.jobs.get(ids.job).job;
  Object.assign(job, { state: 'offered', acceptedAt: null });
  return { requestId: crypto.randomUUID(), jobId: job.id, revision: job.revision, action: 'accept', payload: { termsRevision: job.termsRevision } };
};

test('URL modes preserve one approved contributor actor and isolate the operator', async () => {
  const store = createPortalDesignStore('/contributors?mode=partner');
  const first = await data(request(store, 'contributor-account'));
  assert.ok(parseContributorProfile(first));
  assert.equal(first.partnerStatus, 'approved'); assert.equal(first.creatorStatus, 'approved');
  assert.deepEqual(first.portfolioUrls, []);
  const epoch = store.snapshot().epoch;
  store.navigate('creator');
  assert.equal(store.snapshot().actor, ids.contributor); assert.equal(store.snapshot().epoch, epoch);
  assert.deepEqual(await data(request(store, 'contributor-account')), first);
  assert.ok(parseCreatorJobPage(await data(request(store, 'creator-jobs?offset=0'))));
  assert.ok(parseCreatorJobDetail(await data(request(store, `creator-job-detail?jobId=${ids.job}&offset=0`))));
  store.navigate('operator');
  assert.equal(store.snapshot().actor, ids.operator);
  assert.equal((await request(store, 'creator-jobs')).status, 403);
  const operator = await data(request(store, 'operator-account'));
  assert.equal(operator.status, 'approved'); assert.equal(operator.acceptingRequests, false);
  store.navigate('partner');
  assert.equal(store.snapshot().actor, ids.contributor); assert.ok(store.snapshot().epoch > epoch);
  for (const view of ['partner', 'creator', 'operator']) for (const state of portalDesignStates) {
    assert.deepEqual(portalDesignLocation(portalDesignHref(view, state)), { view, state });
  }
});

test('approved partner read-only synthetic ledger never fabricates an agreement or executes payments/referrals', async () => {
  const store = createPortalDesignStore();
  const profile = await data(request(store, 'contributor-account'));
  const terms = await data(request(store, `partner-terms?profileId=${profile.id}`));
  assert.ok(parsePartnerTermsSnapshot(terms)); assert.equal(terms.state, 'not_offered'); assert.equal(terms.agreement, null);
  const ledger = await data(request(store, 'partner-ledger'));
  assert.ok(parsePartnerLedger(ledger)); assert.equal(ledger.state, 'ready');
  assert.equal(ledger.registrations, '5'); assert.equal(ledger.firstPayments, '5'); assert.equal(ledger.renewals, '3');
  assert.deepEqual(ledger.balances, [{ currency: 'KZT', earnedMinor: '7200000', paidMinor: '4800000', availableMinor: '2400000' }]);
  assert.equal(ledger.firstCommissionBps, null); assert.equal(ledger.renewalCommissionBps, null);
  const history = await data(request(store, 'partner-history?offset=0'));
  assert.ok(parsePartnerHistory(history, { offset: 0, month: null }));
  assert.deepEqual(history.items.map(item => item.kind), ['renewal', 'payout', 'first_payment']);
  assert.equal(history.items.filter(item => item.kind !== 'payout').reduce((sum, item) => sum + BigInt(item.amountMinor), 0n).toString(), ledger.balances[0].earnedMinor);
  const october = await data(request(store, 'partner-history?offset=0&month=2026-10'));
  assert.ok(parsePartnerHistory(october, { offset: 0, month: '2026-10' }));
  assert.equal(october.items.length, 2);
  const noRows = await data(request(store, 'partner-history?offset=20'));
  assert.ok(parsePartnerHistory(noRows, { offset: 20, month: null }));
  assert.deepEqual(noRows.items, []);
  for (const query of ['offset=-1', 'offset=01', 'offset=1000001', 'offset=0&offset=0', 'month=0000-01', 'month=2026-13', 'workspaceId=foreign']) {
    assert.equal((await request(store, 'partner-history?' + query)).status, 400);
  }
  for (const route of ['partner-referrals', 'partner-payments', 'platform-contributors', 'clinic-creator-jobs', 'meta-launches']) {
    assert.equal((await request(store, route, {})).status, 403);
  }
  assert.deepEqual(await data(request(store, 'partner-ledger')), ledger);
  assert.equal((await request(store, `partner-terms?profileId=${crypto.randomUUID()}`)).status, 403);
  store.setState('empty'); assert.deepEqual(await data(request(store, 'partner-ledger')), { state: 'not_activated' });
  assert.deepEqual(await data(request(store, 'partner-history?offset=0')), { state: 'not_activated' });
});

test('empty, error, denial, pending and suspended scenarios recover only by explicit fixture state change', async () => {
  const store = createPortalDesignStore('/contributors?state=empty&mode=creator');
  assert.deepEqual(await data(request(store, 'creator-jobs')), { items: [], hasMore: false });
  store.navigate('operator'); assert.deepEqual(await data(request(store, 'operator-inbox')), { items: [], hasMore: false });
  for (const [state, status] of [['error', 503], ['denied', 403]]) {
    store.setState(state); assert.equal((await request(store, 'operator-account')).status, status);
    store.setState('ready'); assert.equal((await request(store, 'operator-account')).status, 200);
  }
  for (const state of ['pending', 'suspended']) {
    store.setState(state); assert.equal((await data(request(store, 'operator-account'))).status, state);
    assert.equal((await request(store, 'operator-inbox')).status, 403);
    store.navigate('creator'); assert.equal((await data(request(store, 'contributor-account'))).creatorStatus, state);
    assert.equal((await request(store, 'creator-jobs')).status, 403); store.navigate('operator');
  }
  store.setState('signed-out'); assert.equal(store.session(), null); assert.equal((await request(store, 'operator-account')).status, 401);
  store.setState('ready'); store.failNext('operator-inbox'); assert.equal((await request(store, 'operator-inbox')).status, 503);
  assert.equal((await request(store, 'operator-inbox')).status, 200);
});

test('synthetic auth rejects foreign, old-session, unauthenticated and aborted dispatches', async () => {
  const store = createPortalDesignStore(), token = store.token(), events = [];
  const subscription = store.onAuthStateChange((event, session) => events.push([event, session?.user.id ?? null]));
  store.switchActor(ids.other); store.switchActor(ids.contributor);
  assert.notEqual(store.token(), token);
  assert.equal((await store.request(url('contributor-account'), { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await store.request(url('contributor-account'))).status, 401);
  await assert.rejects(store.request(new URL('https://foreign.invalid/api/crm/contributor-account')));
  await assert.rejects(store.request(url('contributor-account'), { signal: AbortSignal.abort() }), { name: 'AbortError' });
  store.switchActor(null); assert.deepEqual(events, [['SIGNED_IN', ids.other], ['SIGNED_IN', ids.contributor], ['SIGNED_OUT', null]]);
  subscription.data.subscription.unsubscribe(); store.switchActor(ids.contributor); assert.equal(events.length, 3);
});

test('creator committed lost response is recovered idempotently without another action', async () => {
  const store = createPortalDesignStore('/contributors?mode=creator'), body = accept(store);
  const identity = { requestId: body.requestId, action: body.action, targetId: body.jobId };
  store.loseNext(); await assert.rejects(request(store, 'creator-jobs', body), /committed response lost/);
  assert.equal(store.jobs.get(ids.job).job.state, 'in_progress'); assert.equal(store.receipts.size, 1);
  const recovered = await data(request(store, `creator-job-command?requestId=${body.requestId}`));
  assert.ok(parseCreatorCommandResult(recovered, identity)); assert.equal(recovered.state, 'committed');
  const replay = await data(request(store, 'creator-jobs', body));
  assert.ok(parseCreatorCommandResult(replay, identity)); assert.equal(replay.result.replayed, true); assert.equal(store.receipts.size, 1);
  assert.equal((await request(store, 'creator-jobs', { ...body, action: 'decline', payload: {} })).status, 409);
  const close = await data(request(store, 'creator-job-command', { operation: 'close', ...identity }));
  assert.equal(close.state, 'committed'); assert.equal(store.jobs.get(ids.job).job.state, 'in_progress');
  const job = store.jobs.get(ids.job).job;
  const submit = { requestId: crypto.randomUUID(), jobId: job.id, revision: job.revision, action: 'submit', payload: { links: ['https://example.com/fixture-result'], note: 'Synthetic only' } };
  assert.ok(parseCreatorCommandResult(await data(request(store, 'creator-jobs', submit)), { requestId: submit.requestId, action: 'submit', targetId: job.id }));
  assert.ok(parseCreatorJobDetail(await data(request(store, `creator-job-detail?jobId=${job.id}`))));
});

test('unconfirmed creator send needs explicit close; a close fence never executes it later', async () => {
  const store = createPortalDesignStore(), body = accept(store), identity = { requestId: body.requestId, action: body.action, targetId: body.jobId };
  store.failBeforeNext(); await assert.rejects(request(store, 'creator-jobs', body), /before processing/);
  assert.deepEqual(await data(request(store, `creator-job-command?requestId=${body.requestId}`)), { state: 'unconfirmed', requestId: body.requestId });
  const result = await data(request(store, 'creator-job-command', { operation: 'close', ...identity }));
  assert.ok(parseCreatorCommandResult(result, identity)); assert.equal(result.state, 'abandoned');
  assert.equal((await data(request(store, 'creator-jobs', body))).state, 'abandoned');
  assert.equal(store.jobs.get(ids.job).job.state, 'offered'); assert.equal(store.receipts.size, 0);
});

test('held original-actor replies and command recovery remain isolated across A/B/A', async () => {
  const store = createPortalDesignStore(), body = accept(store);
  store.holdNext('creator-jobs');
  const held = request(store, 'creator-jobs', body);
  while (store.receipts.size === 0) await new Promise(resolve => setTimeout(resolve, 1));
  store.switchActor(ids.other); assert.equal((await request(store, `creator-job-command?requestId=${body.requestId}`)).status, 403);
  store.switchActor(ids.contributor); store.release();
  assert.equal((await data(held)).state, 'committed');
  assert.equal(store.calls[0].actor, ids.contributor); assert.notEqual(store.calls[0].epoch, store.snapshot().epoch);
  assert.equal((await data(request(store, `creator-job-command?requestId=${body.requestId}`))).state, 'committed');
});

test('operator reuses read-only mock, toggles acceptance, and ends only synthetic cooperation with recoverable receipt', async () => {
  const store = createPortalDesignStore('/operator');
  const row = (await data(request(store, 'operator-inbox'))).items[0];
  assert.equal((await data(request(store, 'operator-account', { acceptingRequests: true }, 'PATCH'))).acceptingRequests, true);
  assert.equal((await request(store, `operator-bookings?requestId=${row.id}`, { arbitrary: true })).status, 403);
  assert.equal((await request(store, 'operator-leads?requestId=foreign')).status, 403);
  const commandId = crypto.randomUUID(), body = { id: row.id, action: 'end', commandId };
  store.loseNext(); await assert.rejects(request(store, 'operator-inbox', body, 'PATCH'), /committed response lost/);
  const result = await data(request(store, `operator-inbox?commandId=${commandId}`));
  assert.ok(parseOperatorCommandResult(result, commandId, { action: 'end', targetId: row.id }));
  assert.equal(result.state, 'committed'); assert.equal((await data(request(store, 'operator-inbox'))).items[0].status, 'ended');
  assert.equal((await request(store, `operator-leads?requestId=${row.id}`)).status, 403);
  assert.equal((await data(request(store, 'operator-account'))).status, 'approved');
  assert.deepEqual(await data(request(store, 'operator-inbox', body, 'PATCH')), result);
  store.suspendOperator(); assert.equal((await data(request(store, 'operator-account'))).status, 'suspended');
  assert.equal((await request(store, 'operator-account', { acceptingRequests: false }, 'PATCH')).status, 403);
  assert.equal((await request(store, 'operator-inbox')).status, 403);
  assert.equal((await request(store, `operator-inbox?commandId=${commandId}`)).status, 403);
});

test('HTTP gate is exact-host, exact-origin, GET only and refuses external and sensitive requests', () => {
  const origin = 'http://127.0.0.1:5290', req = { method: 'GET', url: '/contributors', headers: { host: '127.0.0.1:5290' } };
  assert.equal(portalDesignRequestAllowed(req, origin), true);
  for (const changes of [
    { method: 'POST' }, { url: 'https://foreign.invalid/contributors' }, { url: '//foreign.invalid/contributors' },
    { url: '/api/crm/operator-account' }, { url: '/sw.js' }, { url: '/.env.local' }, { url: '/%2eenv' },
    { url: '/@fs/C:/workspace/output/private.png' }, { url: '/@fs/C:/workspace/migrations/059.sql' },
    { headers: { host: 'localhost:5290' } }, { headers: { ...req.headers, origin: 'null' } },
    { headers: { ...req.headers, origin: 'http://127.0.0.1:5291' } },
    { headers: { ...req.headers, referer: 'https://foreign.invalid/' } },
    { headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } },
  ]) assert.equal(portalDesignRequestAllowed({ ...req, ...changes }, origin), false, JSON.stringify(changes));
});

test('loopback server serves actual portal entry and local Inter, with no API HTTP fallback', { timeout: 90000 }, async t => {
  // This immutable HTTP check must not retain development file watchers.
  const fixture = await createPortalDesignFixture(0, { prebundle: false, watch: false }); t.after(() => fixture.close());
  const drained = async (route, init) => {
    const response = await loopbackRequest(fixture.origin, route, init);
    await response.arrayBuffer(); return response;
  };
  assert.notEqual(new URL(fixture.origin).port, '5290');
  assert.notEqual(new URL(fixture.origin).port, '5173');
  for (const route of ['/contributors?mode=partner', '/contributors?mode=creator', '/operator']) {
    const response = await loopbackRequest(fixture.origin, route); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /worker-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await response.text(), /portal-design-browser\.tsx/);
  }
  const health = await (await loopbackRequest(fixture.origin, '/__fixture/health')).json(); assert.equal(health.syntheticOnly, true);
  for (const route of ['/api/crm/operator-account', '/sw.js', '/.env', '/package.json', '/src/lib/supabase.ts']) assert.equal((await drained(route)).status, 403);
  assert.equal((await drained('/operator', { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await drained('/operator', { method: 'POST' })).status, 403);
  assert.equal((await drained('/unowned', { headers: { Accept: 'text/html' } })).status, 404);
  assert.equal((await drained('/fonts/inter/inter-cyrillic.woff2')).status, 200);
});
