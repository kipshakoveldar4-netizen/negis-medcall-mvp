import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('./form.js', import.meta.url), 'utf8');
function setup(responses) {
  const status = { textContent: '' }, button = { disabled: true }, fieldset = { disabled: false };
  let submit, callbacks, keys = 0, resets = 0;
  const requests = [];
  const form = {
    dataset: { intakeEndpoint: 'https://api.example.invalid/api/crm/site-inquiry', siteKey: 'public', consentVersion: 'v1' },
    querySelector: selector => selector === 'button' ? button : selector === 'fieldset' ? fieldset : {},
    reportValidity: () => true,
    addEventListener: (event, fn) => { if (event === 'submit') submit = fn; },
  };
  const fields = { name: 'Test', phone: '+77071234567', business: 'Salon', service: 'call-center', consent: 'on' };
  const window = { turnstile: { render: (element, options) => { callbacks = options; return 'widget'; }, reset: () => { resets++; } } };
  runInNewContext(source, {
    document: { querySelector: () => form, getElementById: () => status, createElement: () => ({}), head: { append() {} } },
    window, location: { pathname: '/ru/' },
    FormData: class { get(key) { return fields[key]; } },
    crypto: { randomUUID: () => `request-${++keys}` },
    AbortController, setTimeout, clearTimeout,
    fetch: async (url, init) => { requests.push({ url, ...init }); const response = await responses.shift(); if (response instanceof Error) throw response; return response; },
  });
  window.medinaChallengeReady();
  return { form, fields, status, button, fieldset, requests, resetCount: () => resets,
    token: () => callbacks.callback('challenge'), submit: () => submit({ preventDefault() {} }) };
}

test('success only after positive JSON response; no tenant, raw URLs or credentials in request', async () => {
  const ui = setup([{ ok: true, text: async () => '{"success":true}' }]);
  await ui.submit(); assert.equal(ui.requests.length, 0);
  ui.token(); await ui.submit();
  assert.match(ui.status.textContent, /Заявка принята/);
  assert.equal(ui.fieldset.disabled, true);
  assert.equal(ui.requests[0].credentials, 'omit');
  const body = JSON.parse(ui.requests[0].body);
  assert.equal(body.inquiry.pagePath, '/ru/'); assert.equal(body.inquiry.consent, true);
  assert.equal(Object.hasOwn(body.inquiry, 'workspaceId'), false);
});

test('empty or failed responses preserve fields, refresh challenge and reuse idempotency key', async () => {
  const ui = setup([{ ok: true, text: async () => '' }, new Error('network'), { ok: true, text: async () => '{"success":true}' }]);
  ui.token(); await ui.submit();
  assert.match(ui.status.textContent, /Не удалось подтвердить/); assert.equal(ui.fieldset.disabled, false);
  assert.equal(ui.button.disabled, true); assert.equal(ui.resetCount(), 1);
  ui.token(); await ui.submit(); ui.token(); await ui.submit();
  assert.equal(new Set(ui.requests.map(r => JSON.parse(r.body).requestKey)).size, 1);
  assert.equal(ui.fields.name, 'Test');
});

test('changed fields get a new request key; server errors are never printed verbatim', async () => {
  const ui = setup([{ ok: false, text: async () => '{"code":"constructor","error":"sensitive details"}' },
    { ok: false, text: async () => '{"code":"invalid_phone"}' }]);
  ui.token(); await ui.submit();
  assert.doesNotMatch(ui.status.textContent, /sensitive|function/);
  ui.fields.phone = '+77071234568'; ui.token(); await ui.submit();
  assert.notEqual(JSON.parse(ui.requests[0].body).requestKey, JSON.parse(ui.requests[1].body).requestKey);
  assert.match(ui.status.textContent, /Проверьте номер/);
});

test('accepted form stays closed after another challenge callback and submit', async () => {
  const ui = setup([{ ok: true, text: async () => '{"success":true}' }]);
  ui.token(); await ui.submit();
  ui.token();
  assert.equal(ui.button.disabled, true);
  await ui.submit();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.fieldset.disabled, true);
  assert.match(ui.status.textContent, /Заявка принята/);
});

test('rapid repeat submissions stay locked while the request is pending', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const ui = setup([pending]);
  ui.token();
  const first = ui.submit();
  ui.token(); await ui.submit();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.fieldset.disabled, true);
  finish({ ok: true, text: async () => '{"success":true}' });
  await first;
  assert.match(ui.status.textContent, /Заявка принята/);
});
