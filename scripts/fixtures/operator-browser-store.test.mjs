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
