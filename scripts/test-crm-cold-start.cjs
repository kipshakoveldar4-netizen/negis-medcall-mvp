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
    if (entry.name.endsWith('.cjs')) {
      const target = path.join(output, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, relative), target);
      continue;
    }
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
    let entryChecks = 0;
    async function check(resource, expected, authorization, method = 'GET', query = {}) {
      let status, body;
      const headers = {};
      const res = { setHeader(key, value) { headers[key] = value; }, status(n) { status = n; return res; },
        json(value) { body = value; }, end(value) { body = value; } };
      await handler({ method, url: '/api/crm/' + resource,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: {} }),
        query: { path: resource.split('/'), ...query }, headers: authorization ? { authorization } : {} }, res);
      assert.equal(status, expected, resource);
      if (['partner-link','partner-company','platform-partner-companies','creator-jobs','creator-job-command','clinic-creator-jobs','clinic-creator-job-command',
        'creator-job-detail','clinic-creator-job-detail','creator-directory'].includes(resource)) assert.equal(headers['Cache-Control'],'no-store');
      if (expected === 401) assert.equal(body.success, false);
      assert.ok(!JSON.stringify(body).includes('SIMULATED_PRIVATE_RENDERER_FAILURE'));
      entryChecks++;
    }
    (async () => {
      for (const route of ['auth-context', 'appointments', 'clients', 'staff', 'site-blog', 'site-inquiry-deletion-preview', 'site-inquiry-deletion-operations', 'lead-team-analytics', 'contributor-account', 'partner-ledger',
        'creator-jobs','creator-job-command','clinic-creator-jobs','clinic-creator-job-command',
        'creator-job-detail','clinic-creator-job-detail','creator-directory']) {
        await check(route, 401);
      }
      await check('auth-context', 401, 'Bearer invalid-test-token');
      await check('contributor-account', 401, 'Bearer invalid-test-token');
      await check('contributor-account', 401, undefined, 'POST');
      await check('partner-ledger', 401, 'Bearer invalid-test-token');
      for(const route of ['partner-terms','platform-partner-terms']){
        await check(route,route.startsWith('platform-')?404:401,'Bearer invalid-test-token');
        await check(route,route.startsWith('platform-')?404:401,undefined,'POST');
      }
      await check('partner-link',401);
      await check('partner-link',401,'Bearer invalid-test-token');
      await check('partner-link',405,undefined,'POST');
      for (const method of ['GET','POST']) {
        await check('partner-company',401,undefined,method);
        await check('partner-company',401,'Bearer invalid-test-token',method);
        await check('platform-partner-companies',404,undefined,method);
        await check('platform-partner-companies',404,'Bearer invalid-test-token',method);
      }
      await check('partner-company',405,undefined,'PATCH');
      await check('partner-entry',503,undefined,'POST');
      await check('partner-entry',503,'Bearer invalid-test-token','POST');
      await check('partner-entry/company',401,undefined,'POST',{op:'context'});
      await check('partner-entry/company',401,'Bearer invalid-test-token','POST',{op:'context'});
      await check('partner-entry/unknown',404,undefined,'POST');
      await check('partner-entry/company/unexpected',404,undefined,'POST');
      for (const route of ['creator-jobs','creator-job-command','clinic-creator-jobs','clinic-creator-job-command',
        'creator-job-detail','clinic-creator-job-detail','creator-directory']) await check(route,401,'Bearer invalid-test-token');
      await check('creator-jobs',401,undefined,'POST');
      await check('clinic-creator-jobs',401,undefined,'POST');
      await check('creator-job-command',401,undefined,'POST');
      await check('clinic-creator-job-command',401,undefined,'POST');
      await check('platform-contributors', 404);
      await check('platform-contributors', 404, undefined, 'PATCH');
      await check('site-inquiry-deletion-preview', 401, 'Bearer invalid-test-token');
      await check('site-inquiry-deletion', 401, undefined, 'POST');
      await check('site-inquiry-deletion', 401, 'Bearer invalid-test-token', 'POST');
      await check('site-inquiry-deletion-operations', 401, undefined, 'POST');
      await check('site-inquiry-deletion-operations', 401, 'Bearer invalid-test-token', 'POST');
      await check('site-inquiry-deletion-operations', 401, 'Bearer invalid-test-token');
      await check('site-page', brokenRenderer ? 503 : 404);
      const accessChecks = await require(${JSON.stringify(path.join(root, 'scripts', 'fixtures', 'crm-runtime-access.cjs'))})(handler, { brokenRenderer });
      // Exercise the compiled shared import and both company gates without tenant data.
      const actor = '11111111-1111-4111-8111-111111111111';
      const ordinary = '22222222-2222-4222-8222-222222222222';
      const requestId = '33333333-3333-4333-8333-333333333333';
      const sourceId = '44444444-4444-4444-8444-444444444444';
      const applicationId = '55555555-5555-4555-8555-555555555555';
      const revision = '66666666-6666-4666-8666-666666666666';
      const origin = 'https://company-cold-start.invalid';
      const rpcCalls = [];
      let authCalls = 0, tableCalls = 0, companyChecks = 0;
      const server = require('./lib/supabase/server.js');
      process.env.SUPABASE_URL = 'https://company-cold-start.invalid';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-company-cold-start';
      process.env.MEDINA_APP_ORIGIN = origin;
      process.env.MEDINA_PLATFORM_OWNER_IDS = actor;
      process.env.MEDINA_PARTNER_COMPANY_ENABLED = 'false';
      global.fetch = async (url, options) => {
        assert.equal(url, origin + '/auth/v1/user');
        assert.equal(options.method, 'GET');
        const token = options.headers.Authorization;
        const id = token === 'Bearer fixture.company.signature' ? actor
          : token === 'Bearer fixture.ordinary.signature' ? ordinary : null;
        authCalls++;
        return { ok: Boolean(id), status: id ? 200 : 401,
          text: async () => JSON.stringify(id ? {id} : {message:'PRIVATE_AUTH_DIAGNOSTIC'}) };
      };
      server.setSupabaseServerClientFactoryForTests(() => ({
        from() { tableCalls++; assert.fail('Company bootstrap/platform routes must not resolve clinic membership or data'); },
        async rpc(name, args) {
          rpcCalls.push({name,args});
          if (name === 'read_growth_partner_company_submission') {
            assert.deepEqual(args,{p_actor:actor,p_source:sourceId,p_request:requestId,p_close:args.p_close});
            assert.equal(typeof args.p_close,'boolean');
            return {data:{requestId,sourceId,state:'abandoned'},error:null};
          }
          if (name === 'list_growth_partner_companies') {
            assert.deepEqual(args,{p_owner:actor,p_offset:0,p_state:null});
            return {data:{items:[],offset:0,state:null,hasMore:false},error:null};
          }
          if (name === 'list_own_growth_partner_companies') {
            assert.ok([actor,ordinary].includes(args.p_actor));
            assert.ok([0,20].includes(args.p_offset));assert.ok([null,'pending'].includes(args.p_state));
            assert.deepEqual(Object.keys(args).sort(),['p_actor','p_offset','p_state']);
            return {data:{items:[],offset:args.p_offset,state:args.p_state,hasMore:false},error:null};
          }
          if (name === 'read_growth_partner_company') {
            assert.deepEqual(args,{p_actor:actor,p_application:applicationId});
            return {data:{id:applicationId,revision,state:'approved',workspaceId:sourceId,sourceState:'pending_payment',
              company:{name:'Fixture company',ownerName:'Fixture owner',purpose:'marketing',vertical:null,timeZone:'UTC'},
              submittedAt:'2026-10-28T01:00:00Z',reviewedAt:'2026-10-28T02:00:00Z',expiresAt:'2026-11-01T01:00:00Z'},error:null};
          }
          assert.equal(name,'read_growth_partner_company_review');
          assert.deepEqual(args,{p_owner:actor,p_application:applicationId,p_revision:revision,
            p_request:requestId,p_action:'approve',p_close:true});
          return {data:{requestId,applicationId,revision,action:'approve',state:'abandoned'},error:null};
        },
      }));
      async function companyCheck(resource, method, expected, {query={},body={},token='fixture.company.signature',rpc}={}) {
        const beforeRpc = rpcCalls.length;
        let status, payload;
        const headers = {};
        const res = {setHeader(key,value){headers[key]=value;},status(value){status=value;return res;},
          json(value){payload=value;},end(value){payload=value;}};
        await handler({method,url:'/api/crm/'+resource,query:{path:resource.split('/'),...query},
          headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},
          ...(method==='GET'?{}:{body})},res);
        assert.equal(status,expected,resource+' '+method);
        assert.equal(headers['Cache-Control'],'no-store',resource);
        assert.equal(tableCalls,0,'Company routes must not resolve clinic membership or data');
        assert.equal(rpcCalls.length-beforeRpc,rpc?1:0,resource+' must reach only its classified handler');
        if(rpc)assert.equal(rpcCalls[beforeRpc].name,rpc);
        const serialized=JSON.stringify(payload);
        for(const secret of ['synthetic-company-cold-start','PRIVATE_AUTH_DIAGNOSTIC'])assert.ok(!serialized.includes(secret));
        companyChecks++;
      }
      try {
        await companyCheck('partner-company','GET',200,{query:{requestId,sourceId},rpc:'read_growth_partner_company_submission'});
        await companyCheck('partner-company','GET',200,{query:{view:'list'},rpc:'list_own_growth_partner_companies'});
        await companyCheck('partner-company','GET',200,{query:{view:'list',offset:'20',state:'pending'},token:'fixture.ordinary.signature',rpc:'list_own_growth_partner_companies'});
        await companyCheck('partner-company','GET',401,{query:{view:'list'},token:null});
        await companyCheck('partner-company','GET',400,{query:{view:'list',requestId,sourceId}});
        await companyCheck('partner-company','GET',400,{query:{view:'list',workspaceId:sourceId}});
        await companyCheck('partner-company','POST',400,{query:{view:'list'}});
        await companyCheck('partner-company','GET',200,{query:{view:'workspace',applicationId,revision},rpc:'read_growth_partner_company'});
        await companyCheck('partner-company','GET',401,{query:{view:'workspace',applicationId,revision},token:null});
        await companyCheck('partner-company','GET',400,{query:{view:'workspace',applicationId,revision,workspaceId:sourceId}});
        await companyCheck('partner-company','GET',400,{query:{view:'workspace',applicationId,revision,requestId}});
        await companyCheck('partner-company','GET',400,{query:{view:'workspace',applicationId}});
        await companyCheck('partner-company','POST',400,{query:{view:'workspace',applicationId,revision}});
        await companyCheck('partner-company','POST',200,{body:{operation:'close',requestId,sourceId},rpc:'read_growth_partner_company_submission'});
        await companyCheck('platform-partner-companies','GET',200,{rpc:'list_growth_partner_companies'});
        await companyCheck('platform-partner-companies','POST',200,{body:{operation:'close',requestId,applicationId,revision,action:'approve'},rpc:'read_growth_partner_company_review'});
        for(const method of ['GET','POST','PATCH']) {
          await companyCheck('platform-partner-companies',method,404,{token:'fixture.ordinary.signature'});
          await companyCheck('platform-partner-companies',method,404,{token:null});
        }
        await companyCheck('partner-company','PATCH',405);
        await companyCheck('platform-partner-companies','PATCH',405);
        for(const route of ['partner-company/unexpected','platform-partner-companies/unexpected']) {
          for(const method of ['GET','POST'])await companyCheck(route,method,404);
        }
        await companyCheck('partner-entry/company','POST',503,{query:{op:'context'}});
        await companyCheck('partner-entry/company','GET',405,{query:{op:'context'}});
        for(const route of ['partner-entry/unknown','partner-entry/company/unexpected']) {
          const beforeAuth=authCalls;
          await companyCheck(route,'POST',404,{query:{op:'context'}});
          assert.equal(authCalls,beforeAuth,'unknown nested entry must be refused before Auth');
        }
      } finally {
        server.setSupabaseServerClientFactoryForTests(null);
        for(const key of ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','MEDINA_APP_ORIGIN',
          'MEDINA_PLATFORM_OWNER_IDS','MEDINA_PARTNER_COMPANY_ENABLED'])delete process.env[key];
        global.fetch=async()=>{throw new Error('Network forbidden in cold-start test');};
      }
      console.log('CommonJS CRM cold start (' + (brokenRenderer ? 'broken site' : 'normal') + '): ' + entryChecks + ' anonymous/public entry + ' + accessChecks + ' authenticated/denial + ' + companyChecks + ' company routing checks passed; isolated fixtures, no network or credentials.');
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
