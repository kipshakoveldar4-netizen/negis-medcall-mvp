import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { portalDesignConfig } from './portal-design-browser.mjs';

// Keep build-plugin resources out of the HTTP fixture's Vite development lifetime.
const require = createRequire(new URL('../../artifacts/negis/package.json', import.meta.url));
after(() => createRequire(require.resolve('vite'))('esbuild').stop());
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
