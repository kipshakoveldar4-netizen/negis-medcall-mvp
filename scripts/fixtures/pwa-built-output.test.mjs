import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildServiceWorker } from '../../artifacts/negis/pwa-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis'), output = path.join(frontend, 'dist/public');

// Post-build only. Read public bytes without executing the application bundle
// or displaying its runtime configuration. No env, browser or network.
test('actual root build contains the exact stamped public graph and byte fingerprint', async t => {
  const source = await readFile(path.join(frontend, 'public/sw.js'), 'utf8');
  const script = await readFile(path.join(output, 'sw.js'), 'utf8');
  const names = ['index.html', 'manifest.webmanifest', ...(await readdir(path.join(output, 'assets'))).map(name => 'assets/' + name),
    'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
    'fonts/inter/inter-latin.woff2', 'fonts/inter/inter-cyrillic.woff2', 'fonts/inter/inter-cyrillic-ext.woff2'];
  const files = new Map(); for (const name of names) files.set(name, await readFile(path.join(output, name)));
  const expected = buildServiceWorker(source, files);
  assert.equal(script, expected.script);
  assert.equal(script.includes('__BUILD_ID__'), false); assert.equal(script.includes('__SHELL_ASSETS__'), false);
  assert.ok(expected.precache.length > 20, 'Complete real bundle graph, not just one synthetic entry');
  assert.equal(expected.precache.some(name => /^\/(?:api|auth|storage)(?:\/|$)|^[a-z]+:/i.test(name)), false);
  assert.equal(expected.precache.includes('/fonts/inter/inter-cyrillic.woff2'), true);
  const manifest = JSON.parse(files.get('manifest.webmanifest').toString('utf8'));
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.start_url, '/ai-control-center');
  t.diagnostic(`Verified build ${expected.buildId}: ${expected.precache.length} public precache paths; application JS not executed.`);
});
