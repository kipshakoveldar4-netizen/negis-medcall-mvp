import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inspect } from 'node:util';
import { ENTRY_ACTOR, partnerEntryHttpFixture, stopPartnerEntryBuilds } from './partner-entry-http-fixture.mjs';
import { startOwnedPartnerHttp } from './partner-entry-native-http-cases.mjs';

const path = '/api/crm/operator-lead-search';
const search = 'SYNTHETIC_SEARCH_NAME +77015551234';
const requestId = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
const maxBytes = 1024 * 1024;

test('actual CRM HTTP search transport is authenticated, bounded, body-only and non-echoing', async t => {
  t.after(stopPartnerEntryBuilds);
  const logs = ['log', 'info', 'warn', 'error', 'debug'].map(method => t.mock.method(console, method, () => {}));
  const calls = [];
  let fault;
  const fixture = await partnerEntryHttpFixture({
    async rpc(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (fault === 'denied') return { error: { code: 'P1241', message: search } };
      if (fault === 'unavailable') throw Error(search);
      return { data: {
        generatedAt: '2026-10-28T12:00:00Z', offset: args.p_offset,
        filters: { search: fault === 'mismatch' ? args.p_search.toLowerCase() : args.p_search, group: args.p_group, requestId: args.p_request_id },
        companies: [{ requestId, displayName: 'Synthetic company', leadScope: 'assigned' }],
        totals: { all: '0', new: '0', in_progress: '0', booked: '0', postponed: '0', lost: '0', other: '0' },
        matched: '0', items: [], stageOptions: [], hasMore: false,
      }, error: null };
    },
  }, { approved: false });
  t.after(() => fixture.close());
  const { routes } = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const [rewritePath, routeQuery] = routes.find(route => route.src === '/api/crm/(.*)').dest.replace('$1', 'operator-lead-search').split('?');
  const encodedRewritePath = rewritePath.replace('[', '%5B').replace(']', '%5D');
  const rewrite = '?' + routeQuery;
  const server = await startOwnedPartnerHttp((req, res) => {
    const rawPath = req.url.split('?', 1)[0];
    if (rawPath === rewritePath || rawPath === encodedRewritePath || rawPath === rewritePath + '/extra') {
      // The loopback helper injects a public pathname. For a rewritten request,
      // model the adapter populating path from the rewrite query instead.
      const [, ...values] = req.query.path;
      if (values.length) req.query.path = rawPath === encodedRewritePath ? values : values[0];
      else delete req.query.path;
    } else if (Array.isArray(req.query.path)) {
      req.query.path = req.query.path.at(-1); // Also exercise an adapter that collapses path duplicates.
    }
    return fixture.handler(req, res);
  }, [path, path + '/extra', rewritePath, encodedRewritePath, rewritePath + '/extra']);
  t.after(() => server.close());

  async function send(status, { urlPath = path, query = '', method = 'POST', type = 'application/json', body = '{}', token = 'owned.owner.signature' } = {}) {
    const streamed = body instanceof ReadableStream;
    const response = await fetch(server.origin + urlPath + query, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(type ? { 'Content-Type': type } : {}) },
      ...(method === 'POST' ? { body, ...(streamed ? { duplex: 'half' } : {}) } : {}),
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const payload = await response.text();
    assert.doesNotMatch(payload, /SYNTHETIC_SEARCH_NAME|77015551234/i);
    const result = JSON.parse(payload);
    assert.equal(result.success, status === 200);
    if (status !== 200) assert.equal(result.data, undefined);
    return result;
  }

  await send(405, { method: 'GET', query: '?search=' + encodeURIComponent(search) });
  await send(405, { method: 'GET', token: null });
  await send(405, { method: 'GET', urlPath: rewritePath, query: rewrite });
  assert.deepEqual(fixture.state.auth, []);
  await send(401, { token: null, body: 'invalid' });
  await send(401, { token: 'owned.unknown.signature' });
  for (const query of ['?search=' + encodeURIComponent(search), '?%73earch=', '?group=all', '?offset=0&offset=20',
    '?requestId=' + requestId, '?workspaceId=' + requestId, '?actorId=' + ENTRY_ACTOR]) {
    await send(400, { query, body: JSON.stringify({ search }) });
  }
  for (const query of ['?path=operator-lead-search', '?path=operator-account', '?path=operator-lead-search&path=operator-account']) {
    await send(400, { query });
  }
  await send(404, { urlPath: path + '/extra', query: '?path=operator-lead-search' });
  for (const query of [rewrite + '&search=' + encodeURIComponent(search), rewrite + '&%73earch=', rewrite + '&offset=0',
    rewrite + '&group=all', rewrite + '&requestId=' + requestId, rewrite + '&path=operator-lead-search',
    rewrite + '&path=operator-account', '?path=operator-account&' + routeQuery, rewrite + '/']) {
    await send(400, { urlPath: rewritePath, query });
  }
  await send(400, { urlPath: encodedRewritePath, query: rewrite + '&path=operator-lead-search' });
  await send(404, { urlPath: rewritePath, query: rewrite + '/extra' });
  await send(400, { urlPath: rewritePath + '/extra', query: rewrite });

  for (const body of ['', '"text"', 'null', '[]', '{"search":' + JSON.stringify(search), JSON.stringify({ search, actorId: ENTRY_ACTOR }),
    '{"offset":"0"}', '{"search":null}', '{"path":"operator-lead-search"}']) {
    await send(400, { body });
  }
  for (const type of [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=test', 'text/application/json']) {
    await send(400, { type, body: JSON.stringify({ search }) });
  }
  const bounded = Buffer.alloc(maxBytes, 32);
  bounded.write('{}');
  await send(413, { body: Buffer.concat([bounded, Buffer.from(' ')]) });
  await send(413, { body: new ReadableStream({
    start(controller) {
      controller.enqueue(bounded);
      controller.enqueue(Buffer.from(' '));
      controller.close();
    },
  }) });
  assert.deepEqual(calls, [], 'Refusals must not reach the reader');

  await send(200, { body: bounded });
  assert.deepEqual(calls.pop(), { name: 'read_growth_operator_lead_search', args: {
    p_actor: ENTRY_ACTOR, p_search: '', p_group: 'all', p_request_id: null, p_offset: 0,
  } });
  const body = JSON.stringify({ search: ' ' + search + ' ', group: 'new', requestId: requestId.toUpperCase(), offset: 20 });
  const result = await send(200, { body, type: 'application/json; charset=utf-8' });
  assert.deepEqual(result.data.filters, { group: 'new', requestId });
  assert.equal(result.data.offset, 20);
  assert.deepEqual(calls.pop(), { name: 'read_growth_operator_lead_search', args: {
    p_actor: ENTRY_ACTOR, p_search: search, p_group: 'new', p_request_id: requestId, p_offset: 20,
  } });
  for (const urlPath of [rewritePath, encodedRewritePath]) {
    const rewritten = await send(200, { urlPath, query: rewrite, body });
    assert.deepEqual(rewritten, result);
    assert.deepEqual(calls.pop(), { name: 'read_growth_operator_lead_search', args: {
      p_actor: ENTRY_ACTOR, p_search: search, p_group: 'new', p_request_id: requestId, p_offset: 20,
    } });
  }
  for (const [name, status] of [['mismatch', 503], ['denied', 403], ['unavailable', 503]]) {
    fault = name;
    await send(status, { body });
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(server.state.errors, []);
  assert.deepEqual(fixture.state.unexpected, []);
  assert.deepEqual(fixture.state.challenges, []);
  assert.doesNotMatch(inspect(logs.flatMap(log => log.mock.calls.map(call => call.arguments)), { depth: null }),
    /SYNTHETIC_SEARCH_NAME|77015551234/i);
});
