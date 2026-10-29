import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { portalDesignConfig } from './portal-design-browser.mjs';
import { partnerUiNativeBundle } from './partner-terms-native-ui-fixture.mjs';

// Keep build-plugin resources out of the HTTP fixture's Vite development lifetime.
const require = createRequire(new URL('../../artifacts/negis/package.json', import.meta.url));
after(() => createRequire(require.resolve('vite'))('esbuild').stop());
test('native partner UI fixture bundles its explicit synthetic provider boundary without loading real Auth', async () => {
  const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-00000000010${index}`);
  const result = await partnerUiNativeBundle({ owner: ids[0], a: ids[1], b: ids[2], profileA: ids[3], profileB: ids[4],
    tokens: Object.fromEntries(ids.slice(0, 3).map(id => [id, 'synthetic-native-ui:' + id])) });
  const js = new TextDecoder().decode(result.js);
  assert.ok(result.js.length > 10000);
  assert.ok(js.includes('synthetic-native-ui:'));
  assert.ok(!js.includes('GoTrueClient'), 'No real Supabase Auth implementation in this fixture');
  assert.ok(!js.includes('useAuth must be used within an AuthProvider'), 'The native fixture must supply the provider boundary explicitly');
});
test('in-memory build includes BOTH full production portals, PortalShell and real lifetimes, but no real Auth SDK', { timeout: 120000 }, async () => {
  const { build } = await import(pathToFileURL(require.resolve('vite')).href);
  const { config } = await portalDesignConfig(0);
  assert.equal(config.envDir, false); assert.equal(config.configFile, false); assert.equal(config.build.write, false);
  assert.equal(config.server.host, '127.0.0.1'); assert.equal(config.server.strictPort, true);
  const safety = config.plugins.find(plugin => plugin.name === 'isolated-portal-design');
  const importer = fileURLToPath(new URL('../../artifacts/negis/src/pages/Portal.tsx', import.meta.url));
  assert.match(safety.resolveId('../lib/supabase', importer).replaceAll('\\', '/'), /portal-design-browser-mocks\.ts$/);
  assert.match(safety.resolveId('../lib/supabase.js', importer).replaceAll('\\', '/'), /portal-design-browser-mocks\.ts$/);
  const output = await build({ ...config, logLevel: 'warn' });
  const assets = (Array.isArray(output) ? output : [output]).flatMap(result => result.output);
  const chunks = assets.filter(asset => asset.type === 'chunk');
  const modules = chunks.flatMap(chunk => Object.keys(chunk.modules)).join('\n').replaceAll('\\', '/');
  for (const name of ['pages/ContributorPortal.tsx', 'pages/OperatorPortal.tsx', 'portals/PortalShell.tsx', '/src/lib/operatorApi.ts', '/src/lib/useCreatorCommand.ts', '/src/lib/useOperatorCommand.ts', '/src/lib/serverAuth.ts', '/src/lib/api.ts', 'portal-design-browser-mocks.ts']) assert.ok(modules.includes(name), name);
  assert.doesNotMatch(modules, /@supabase\/|\/src\/lib\/supabase\.ts|\/src\/contexts\/AuthContext/);
  assert.ok(assets.some(asset => asset.type === 'asset' && asset.fileName.endsWith('.css')));
});
