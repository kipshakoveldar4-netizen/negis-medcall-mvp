// Local production-format regression: no credentials, network or live tenants.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const cache = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const output = fs.mkdtempSync(path.join(cache, 'crm-cold-start-'));

function compile(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) { compile(relative); continue; }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
    const result = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const target = path.join(output, relative.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, result.outputText);
  }
}

try {
  compile('api'); compile('lib');
  fs.writeFileSync(path.join(output, 'package.json'), '{"type":"commonjs"}');
  const rendererDirectory = path.join(output, 'artifacts', 'medina-site');
  fs.mkdirSync(rendererDirectory, { recursive: true });
  for (const file of ['render.cjs', 'content.cjs']) {
    fs.copyFileSync(path.join(root, 'artifacts', 'medina-site', file), path.join(rendererDirectory, file));
  }
  const environment = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  environment.NODE_ENV = 'test';
  for (const brokenRenderer of [false, true]) {
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const brokenRenderer = ${JSON.stringify(brokenRenderer)};
    if (brokenRenderer) {
      const Module = require('node:module');
      const originalLoad = Module._load;
      Module._load = function(request, ...args) {
        if (request.endsWith('render.cjs')) throw new Error('SIMULATED_PRIVATE_RENDERER_FAILURE');
        return originalLoad.call(this, request, ...args);
      };
    }
    global.fetch = async () => { throw new Error('Network forbidden in cold-start test'); };
    const handler = require('./api/crm/[...path].js').default;
    async function check(resource, expected, authorization) {
      let status, body;
      const res = { setHeader() {}, status(n) { status = n; return res; },
        json(value) { body = value; }, end(value) { body = value; } };
      await handler({ method: 'GET', url: '/api/crm/' + resource,
        query: { path: [resource] }, headers: authorization ? { authorization } : {} }, res);
      assert.equal(status, expected, resource);
      if (expected === 401) assert.equal(body.success, false);
      assert.ok(!JSON.stringify(body).includes('SIMULATED_PRIVATE_RENDERER_FAILURE'));
    }
    (async () => {
      for (const route of ['auth-context', 'appointments', 'clients', 'staff', 'site-blog']) {
        await check(route, 401);
      }
      await check('auth-context', 401, 'Bearer invalid-test-token');
      await check('site-page', brokenRenderer ? 503 : 404);
      const accessChecks = await require(${JSON.stringify(path.join(root, 'scripts', 'fixtures', 'crm-runtime-access.cjs'))})(handler, { brokenRenderer });
      console.log('CommonJS CRM cold start (' + (brokenRenderer ? 'broken site' : 'normal') + '): 7 anonymous + ' + accessChecks + ' authenticated/denial checks passed; isolated fixtures, no network or credentials.');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: output, env: environment, encoding: 'utf8', timeout: 30000 });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  assert.equal(child.status, 0, 'Compiled CRM must boot and enforce auth before deployment');
  }
} finally {
  // Only the freshly created, verified test directory can be removed.
  assert.equal(path.dirname(output), cache);
  assert.ok(path.basename(output).startsWith('crm-cold-start-'));
  fs.rmSync(output, { recursive: true, force: true });
}
