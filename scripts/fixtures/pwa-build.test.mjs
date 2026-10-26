import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildServiceWorker } from '../../artifacts/negis/pwa-build.mjs';

const source = await readFile(new URL('../../artifacts/negis/public/sw.js', import.meta.url), 'utf8');
const input = () => new Map([
  ['index.html', '<!doctype html><div id="root"></div>'], ['manifest.webmanifest', '{"display":"standalone"}'],
  ['assets/index-Abcd123_.js', 'console.log("synthetic shell")'], ['assets/index-Abcd123_.css', 'body{margin:0}'],
  ['fonts/inter/inter-latin.woff2', new Uint8Array([1, 2, 3])],
]);

test('stamp contains the exact public precache list and no unresolved markers', () => {
  const files = input(), stamped = buildServiceWorker(source, files);
  assert.match(stamped.buildId, /^[a-f0-9]{12}$/);
  assert.equal(stamped.script.includes('__BUILD_ID__'), false); assert.equal(stamped.script.includes('__SHELL_ASSETS__'), false);
  const literal = stamped.script.match(/const SHELL_ASSETS = (\[[^\n]*\]);/)?.[1]; assert.ok(literal);
  assert.deepEqual(JSON.parse(literal), stamped.precache);
  assert.deepEqual([...stamped.precache], [...files.keys()].filter(name => name !== 'index.html').sort().map(name => '/' + name));
  assert.equal(files.get('assets/index-Abcd123_.js'), 'console.log("synthetic shell")');
  assert.ok(Object.isFrozen(stamped)); assert.ok(Object.isFrozen(stamped.precache));
});

test('fingerprint is order independent but includes HTML, manifest, fonts, assets and worker source bytes', () => {
  const files = input(), baseline = buildServiceWorker(source, files).buildId;
  assert.equal(buildServiceWorker(source, new Map([...files].reverse())).buildId, baseline);
  for (const name of files.keys()) {
    const changed = new Map(files); changed.set(name, Buffer.from('changed public bytes'));
    assert.notEqual(buildServiceWorker(source, changed).buildId, baseline, name);
  }
  assert.notEqual(buildServiceWorker(source + '\n// changed worker', files).buildId, baseline);
});

for (const name of ['../private.js', 'assets/../private-Abcd123_.js', '/api/crm/clients', 'api/clients.json',
  'https://remote.example.test/assets/index-Abcd123_.js', '.env', 'assets/index.js', 'assets/index-Abcd123_.js?token=x']) {
  test(`refuses a non-public build input: ${name}`, () => {
    const files = input(); files.set(name, 'synthetic refused bytes');
    assert.throws(() => buildServiceWorker(source, files), /public shell asset/);
  });
}

test('missing graph/entries and malformed markers fail closed without coercing objects', () => {
  const files = input(); files.delete('index.html'); assert.throws(() => buildServiceWorker(source, files), /shell entry/);
  const graph = input(); graph.delete('assets/index-Abcd123_.js'); assert.throws(() => buildServiceWorker(source, graph), /built graph/);
  assert.throws(() => buildServiceWorker(source.replace('__BUILD_ID__', 'removed'), input()), /build input/);
  assert.throws(() => buildServiceWorker(source + '__BUILD_ID__', input()), /build input/);
  assert.throws(() => buildServiceWorker(source.replace('__SHELL_ASSETS__', 'removed'), input()), /asset marker/);
  const invalid = input(); invalid.set('assets/index-Abcd123_.js', { toString() { assert.fail('No object coercion'); } });
  assert.throws(() => buildServiceWorker(source, invalid), /asset bytes/);
});

test('a frozen legacy worker is supported only with the explicit test-fixture option', () => {
  const legacy = 'const BUILD_ID="__BUILD_ID__";';
  assert.throws(() => buildServiceWorker(legacy, input()), /asset marker/);
  const stamped = buildServiceWorker(legacy, input(), { legacySource: true });
  assert.equal(stamped.script, `const BUILD_ID="${stamped.buildId}";`);
  assert.throws(() => buildServiceWorker(source, input(), { legacySource: true }), /asset marker/);
});
