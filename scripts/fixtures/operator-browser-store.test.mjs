import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorBrowserFixture } from './operator-browser-store.ts';

const url = path => new URL(`/api/crm/${path}`, 'http://fixture.invalid');
test('operator visual fixture isolates read routes and refuses writes and foreign selectors', async () => {
  const f = createOperatorBrowserFixture();
  assert.equal(f.request(url('operator-account')).status, 200);
  assert.equal(f.request(url('operator-account'), { method: 'PATCH' }).status, 403);
  assert.equal(f.request(url('operator-leads?requestId=foreign')).status, 403);
  assert.throws(() => f.request(new URL('https://production.invalid/api/crm/operator-account')));
  assert.throws(() => f.request(url('clients')));
  const request = (await f.request(url('operator-inbox')).json()).data.items[0].id;
  const leads = (await f.request(url(`operator-leads?requestId=${request}`)).json()).data.items;
  assert.equal(leads.length, 1);
  assert.equal(f.request(url(`operator-bookings?requestId=${request}`), { method: 'POST' }).status, 403);
  assert.throws(() => f.request(url(`operator-leads?requestId=${request}`), { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('operator visual fixture revokes all protected reads, but still returns the suspended profile', async () => {
  const f = createOperatorBrowserFixture();
  const request = (await f.request(url('operator-inbox')).json()).data.items[0].id;
  f.suspend();
  assert.equal((await f.request(url('operator-account')).json()).data.status, 'suspended');
  for (const route of ['operator-inbox', 'operator-leads', 'operator-services', 'operator-bookings', 'operator-arrivals']) {
    assert.equal(f.request(url(`${route}?requestId=${request}`)).status, 403);
  }
});

test('operator visual fixture ends cooperation while the profile remains approved', async () => {
  const f = createOperatorBrowserFixture();
  const request = (await f.request(url('operator-inbox')).json()).data.items[0];
  const lead = (await f.request(url(`operator-leads?requestId=${request.id}`)).json()).data.items[0].id;
  const children = [
    `operator-leads?requestId=${request.id}`,
    `operator-services?requestId=${request.id}`,
    `operator-bookings?requestId=${request.id}&leadId=${lead}`,
    `operator-arrivals?requestId=${request.id}`,
  ];
  for (const route of children) assert.equal(f.request(url(route)).status, 200, route);

  f.endCooperation();

  const profile = f.request(url('operator-account'));
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).data.status, 'approved');
  const inbox = f.request(url('operator-inbox'));
  assert.equal(inbox.status, 200);
  assert.deepEqual((await inbox.json()).data.items, [{ ...request, status: 'ended' }]);
  for (const route of children) assert.equal(f.request(url(route)).status, 403, route);
  for (const route of ['operator-account', 'operator-inbox', ...children]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(f.request(url(route), { method }).status, 403, `${method} ${route}`);
    }
  }
});

test('operator visual fixture preserves all denials when ended cooperation is followed by suspension', async () => {
  const f = createOperatorBrowserFixture();
  const request = (await f.request(url('operator-inbox')).json()).data.items[0].id;
  const lead = (await f.request(url(`operator-leads?requestId=${request}`)).json()).data.items[0].id;
  const protectedRoutes = [
    'operator-inbox',
    `operator-leads?requestId=${request}`,
    `operator-services?requestId=${request}`,
    `operator-bookings?requestId=${request}&leadId=${lead}`,
    `operator-arrivals?requestId=${request}`,
  ];

  f.endCooperation();
  f.suspend();

  const profile = f.request(url('operator-account'));
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).data.status, 'suspended');
  for (const route of protectedRoutes) assert.equal(f.request(url(route)).status, 403, route);
  for (const route of ['operator-account', ...protectedRoutes]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(f.request(url(route), { method }).status, 403, `${method} ${route}`);
    }
  }
});
