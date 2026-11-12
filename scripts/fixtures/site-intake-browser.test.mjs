import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startSiteIntakeFixture } from './site-intake-browser.mjs';

test('loopback form fixture persists only in its disposable database and stays fail-closed', async t => {
  const fixture = await startSiteIntakeFixture();
  t.after(() => fixture.close());
  const call = (path, options = {}) => fetch(fixture.origin + path, { ...options,
    headers: { Origin: fixture.origin, ...options.headers } });
  const state = async () => (await call('/__fixture/state')).json();
  const mode = value => call(`/__fixture/mode?value=${value}`, { method: 'POST' });
  const challenge = async () => (await (await call('/__fixture/challenge', { method: 'POST' })).json()).token;
  const inquiry = { name: 'Fixture visitor', phone: '+77070000001', business: 'Fixture salon', service: 'call-center',
    pagePath: '/ru/', consent: true, consentVersion: 'v1' };
  const submit = async (requestKey, overrides = {}) => {
    const response = await call('/api/crm/site-inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestKey, inquiry, challengeToken: await challenge(), ...overrides }) });
    return { status: response.status, body: await response.json() };
  };

  await t.test('page uses real form assets but a local challenge and no remote requests', async () => {
    const response = await call('/ru/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.match(await response.text(), /Локальная тестовая форма/);
    for (const route of ['/ru/blog/', '/ru/solutions/salons/', '/ru/solutions/dentistry/', '/ru/solutions/clinics/']) {
      const page = await call(route);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('x-robots-tag'), /noindex/);
    }
    assert.equal((await call('/ru/blog/clinic-advertising-report/')).status, 404);
    const script = await (await call('/form.js')).text();
    assert.match(script, /\/__fixture\/challenge.js/);
    assert.doesNotMatch(script, /https:\/\/challenges.cloudflare.com/);
    for (const asset of ['/site.css', '/assets/brand.png', '/__fixture/challenge.js']) {
      assert.equal((await call(asset)).status, 200);
    }
    assert.equal((await call('/__fixture/mode?value=normal', { method: 'POST', headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  });
  await t.test('missing consent and oversized HTTP bodies cannot create leads', async () => {
    assert.deepEqual(await submit(randomUUID(), { inquiry: { ...inquiry, consent: false } }),
      { status: 400, body: { success: false, code: 'consent_required' } });
    const response = await call('/api/crm/site-inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(9000) }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await state(), { leads: 0, receipts: 0, other_workspace_leads: 0 });
  });
  await t.test('failed challenge never writes', async () => {
    await mode('challenge-failed');
    assert.deepEqual(await submit(randomUUID()), { status: 403, body: { success: false, code: 'challenge_failed' } });
    assert.deepEqual(await state(), { leads: 0, receipts: 0, other_workspace_leads: 0 });
  });
  await t.test('receipt failure rolls back the real SQL lead write', async () => {
    await mode('storage-failed');
    assert.deepEqual(await submit(randomUUID()), { status: 503, body: { success: false, code: 'intake_unavailable' } });
    assert.deepEqual(await state(), { leads: 0, receipts: 0, other_workspace_leads: 0 });
  });
  await t.test('lost success response is safely retryable without creating a second lead', async () => {
    await mode('response-lost');
    const key = randomUUID();
    await assert.rejects(() => submit(key));
    assert.deepEqual(await state(), { leads: 1, receipts: 1, other_workspace_leads: 0 });
    assert.deepEqual(await submit(key), { status: 200, body: { success: true } });
    assert.deepEqual(await state(), { leads: 1, receipts: 1, other_workspace_leads: 0 });
    assert.deepEqual(await submit(key, { inquiry: { ...inquiry, name: 'Changed' } }),
      { status: 409, body: { success: false, code: 'request_conflict' } });
  });
  await t.test('visitor cannot select another workspace', async () => {
    assert.equal((await submit(randomUUID(), { inquiry: { ...inquiry, workspaceId: '00000000-0000-4000-8000-000000000002' } })).status, 400);
    assert.deepEqual(await state(), { leads: 1, receipts: 1, other_workspace_leads: 0 });
  });
  await t.test('one-time challenge cannot be reused even for a previously accepted request', async () => {
    const challengeToken = await challenge();
    const key = randomUUID();
    assert.deepEqual(await submit(key, { challengeToken }), { status: 200, body: { success: true } });
    const before = await state();
    assert.deepEqual(await submit(key, { challengeToken }), { status: 403, body: { success: false, code: 'challenge_failed' } });
    assert.deepEqual(await state(), before);
  });
});

test('editorial preview is explicit, loopback-only and remains noindex', async t => {
  const fixture = await startSiteIntakeFixture({ articles: [{ slug: 'fixture-article', title: 'Fixture article',
    summary: 'Local editorial preview', nodes: [{ tag: 'p', children: ['Fixture body'] }] }] });
  t.after(() => fixture.close());
  const response = await fetch(`${fixture.origin}/ru/blog/fixture-article/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  const html = await response.text();
  assert.match(html, /Fixture body/);
  assert.ok(html.includes('rel="canonical" href="https://site.example.invalid/ru/blog/fixture-article/"'));
  assert.match(html, /name="robots" content="noindex,nofollow"/);
});
