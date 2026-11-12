// Runs only in the sanitized cold-start child, against compiled CommonJS code.
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function checkRuntimeAccess(handler, { brokenRenderer = false } = {}) {
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const workspace = id(1);
  const roles = ['owner', 'admin', 'doctor'];
  const users = roles.map((role, i) => ({ id: id(10 + i), auth_user_id: id(20 + i),
    workspace_id: workspace, role, status: 'active', full_name: `Test ${role}` }));
  const tokens = new Map(roles.map((role, i) => [`fixture.${role}.signature`, users[i].auth_user_id]));
  const log = [];
  let membershipFailure = false;
  let checks = 0;
  const tables = {
    staff_users: users,
    workspaces: [{ id: workspace, name: 'Isolated runtime fixture' }],
    workspace_settings: [], clinic_doctors: [], appointments: [], clients: [],
    crm_intake_sites: [{ id: id(40), workspace_id: workspace, site_key: 'runtime-fixture', manual_deletion_enabled: false }],
    leads: [{ id: id(41), workspace_id: workspace, source: 'website', status: 'new', updated_at: '2026-09-28T01:02:03.123456Z' }],
    crm_site_inquiries: [{ id: id(42), site_id: id(40), lead_id: id(41) }],
    deals: [], tasks: [], wazzup_inbound_messages: [], whatsapp_cloud_inbound_messages: [],
    growth_operator_lead_assignments: [], growth_operator_bookings: [], audit_logs: [],
    growth_contributor_profiles: [{ id: id(71), auth_user_id: users[0].auth_user_id, revision: id(72),
      display_name: 'Own blogger', portfolio_urls: [], partner_status: 'pending', creator_status: 'pending', private_review: 'NEVER_RETURN_CONTRIBUTOR' },
      { id: id(73), auth_user_id: id(74), revision: id(75), display_name: 'Other blogger', portfolio_urls: [], partner_status: null, creator_status: 'pending' }],
    site_blog_posts: [{ id: id(30), workspace_id: workspace, title: 'Private fixture',
      slug: 'private-fixture', excerpt: 'Private', body: 'Never public', version: 1,
      updated_at: '2026-01-01T00:00:00Z' }],
  };
  const client = {
    async rpc(name, args) {
      if (['read_growth_creator_jobs','execute_growth_creator_job_v2','read_growth_creator_command_v2',
        'close_growth_creator_command_v2','read_growth_creator_directory','read_growth_creator_job_detail'].includes(name)) {
        const expected = ['read_growth_creator_jobs','read_growth_creator_directory'].includes(name) ? ['p_actor','p_workspace','p_staff','p_offset']
          : name === 'read_growth_creator_command_v2' ? ['p_actor','p_workspace','p_staff','p_request']
          : name === 'close_growth_creator_command_v2' ? ['p_actor','p_workspace','p_staff','p_request','p_action','p_target']
          : name === 'read_growth_creator_job_detail' ? ['p_actor','p_workspace','p_staff','p_job','p_offset']
          : ['p_actor','p_workspace','p_staff','p_job','p_revision','p_request','p_action','p_payload'];
        assert.deepEqual(Object.keys(args),expected);
        log.push({rpc:name,args});
        if(args.p_workspace===null){
          assert.equal(args.p_staff,null);
          const own=tables.growth_contributor_profiles.find(p=>p.auth_user_id===args.p_actor);
          if(own?.creator_status!=='approved')return{data:null,error:{code:'P1101',message:'private database diagnostic'}};
        }else{
          assert.equal(args.p_workspace,workspace);
          const staff=users.find(u=>u.id===args.p_staff&&u.auth_user_id===args.p_actor&&u.status==='active');
          assert.ok(staff&&['owner','admin'].includes(staff.role));
        }
        if(name==='read_growth_creator_jobs')return{data:{items:[],hasMore:false},error:null};
        if(name==='read_growth_creator_command_v2')return{data:{state:'unconfirmed',requestId:args.p_request},error:null};
        if(name==='close_growth_creator_command_v2')return{data:{state:'abandoned',requestId:args.p_request,
          action:args.p_action,targetId:args.p_target,closedAt:'2026-10-27T00:00:00.000Z'},error:null};
        if(name==='read_growth_creator_directory')return{data:{items:tables.growth_contributor_profiles.filter(p=>p.creator_status==='approved')
          .map(p=>({id:p.id,displayName:p.display_name,portfolioUrls:p.portfolio_urls})),hasMore:false},error:null};
        if(name==='read_growth_creator_job_detail')return{data:null,error:{code:'P1111',message:'private database diagnostic'}};
        // No business writes are modelled here. Native 110/111 covers persistence and locking.
        return{data:null,error:{code:'P1104',message:'private database diagnostic'}};
      }
      if (name === 'read_growth_partner_ledger') {
        assert.deepEqual(Object.keys(args), ['p_actor']);
        log.push({ rpc: name, actor: args.p_actor });
        const own = tables.growth_contributor_profiles.find(p => p.auth_user_id === args.p_actor);
        return own?.partner_status === 'approved'
          ? { data: { state: 'not_activated' }, error: null }
          : { data: null, error: { code: 'P1091', message: 'private database diagnostic' } };
      }
      assert.ok(['execute_site_deletion_operation','read_site_deletion_operations','prepare_site_deletion_operation','close_site_deletion_operation'].includes(name));
      assert.equal(args.p_workspace, workspace);
      assert.equal(args.p_site_key, 'runtime-fixture');
      const actor = users.find(row => row.id === args.p_staff && row.auth_user_id === args.p_actor);
      assert.ok(actor && ['owner', 'admin'].includes(actor.role));
      log.push({ rpc: name });
      if (name === 'read_site_deletion_operations') return { data: { operations: [], complete: true, deletionEnabled: false }, error: null };
      assert.equal(args.p_request.confirmed, true);
      assert.equal(args.p_request.leadUpdatedAt, tables.leads[0].updated_at);
      // Do not model a write here; real persistence is tested in isolated PGlite.
      return { data: null, error: { message: 'site_deletion_disabled' } };
    },
    from(table) {
      assert.ok(Object.hasOwn(tables, table), `Unexpected table: ${table}`);
      const entry = { table, filters: [] };
      log.push(entry);
      let single = false, exactCount = false;
      const predicates = [];
      const query = {
        select(_columns, options) { exactCount = options?.count === 'exact'; return query; }, order() { return query; }, limit() { return query; },
        range() { return query; },
        eq(key, value) { entry.filters.push([key, value]); predicates.push(row => row[key] === value); return query; },
        neq(key, value) { predicates.push(row => row[key] !== value); return query; },
        in(key, values) { predicates.push(row => values.includes(row[key])); return query; },
        is(key, value) { predicates.push(row => (row[key] ?? null) === value); return query; },
        not(key, operator, value) {
          assert.equal(operator, 'is'); assert.equal(value, null);
          predicates.push(row => row[key] != null); return query;
        },
        ilike(key, value) { predicates.push(row => String(row[key] ?? '').toLowerCase() === value.toLowerCase()); return query; },
        single() { single = true; return query; }, maybeSingle() { single = true; return query; },
        then(resolve, reject) {
          const rows = tables[table].filter(row => predicates.every(test => test(row)));
          const result = membershipFailure && table === 'staff_users'
            ? { data: null, error: { code: 'TEST', message: 'private database diagnostic' } }
            : { data: single ? rows[0] ?? null : rows, count: exactCount ? rows.length : null, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
  process.env.SUPABASE_URL = 'https://runtime-fixture.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-only-not-a-credential';
  process.env.MEDINA_PUBLIC_SITE_WORKSPACE_ID = workspace;
  process.env.MEDINA_SITE_INTAKE_KEY = 'runtime-fixture';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://runtime-fixture.invalid/auth/v1/user');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.apikey, 'fixture-only-not-a-credential');
    const token = options.headers.Authorization.replace(/^Bearer /, '');
    const userId = tokens.get(token);
    return { ok: Boolean(userId), status: userId ? 200 : 401,
      text: async () => JSON.stringify(userId ? { id: userId } : { message: 'private auth diagnostic' }) };
  };
  const supabase = require(path.resolve('lib/supabase/server.js'));
  supabase.setSupabaseServerClientFactoryForTests(() => client);
  async function call(route, role, expected, query = {}, method = 'GET', payload = {}) {
    log.length = 0;
    let status, body;
    const headers = {};
    const response = { setHeader(key, value) { headers[key] = value; }, status(value) { status = value; return response; },
      json(value) { body = value; }, end(value) { body = value; } };
    await handler({ method, url: `/api/crm/${route}`, headers: { 'content-type': 'application/json',
      ...(role ? { authorization: `Bearer fixture.${role}.signature` } : {}) },
      ...(method === 'GET' ? {} : { body: payload }),
      query: { path: [route], ...(['site-page','partner-ledger','creator-jobs','creator-job-command','creator-job-detail'].includes(route) ? {} : { workspaceId: workspace }), ...query } }, response);
    assert.equal(status, expected, `${route}: ${role || 'anonymous'}`);
    if(['creator-jobs','creator-job-command','clinic-creator-jobs','clinic-creator-job-command',
      'creator-job-detail','clinic-creator-job-detail','creator-directory'].includes(route))assert.equal(headers['Cache-Control'],'no-store');
    const serialized = JSON.stringify(body) ?? '';
    if (route === 'site-page' && expected === 503) {
      assert.equal(headers['Cache-Control'], 'no-store');
      assert.equal(headers['X-Robots-Tag'], 'noindex, nofollow');
      if (method === 'HEAD') assert.equal(body, undefined);
    }
    for (const forbidden of ['fixture-only-not-a-credential', 'signature', 'private auth diagnostic', 'private database diagnostic', 'SIMULATED_PRIVATE_RENDERER_FAILURE']) {
      assert.ok(!serialized.includes(forbidden), 'No credential or private diagnostic in response');
    }
    checks++;
    return body;
  }
  try {
    for (const role of roles) {
      const contributor = await call('contributor-account', role, 200);
      assert.ok(!log.some(entry => entry.table === 'staff_users'), 'Independent application is not a clinic membership');
      assert.equal(JSON.stringify(contributor).includes('NEVER_RETURN_CONTRIBUTOR'), false);
      if (role === 'owner') assert.equal(contributor.data.displayName, 'Own blogger');
      else assert.equal(contributor.data, null);
      await call('platform-contributors', role, 404);
      assert.ok(!log.some(entry => entry.table === 'growth_contributor_profiles'));
      await call('partner-ledger', role, 403);
      assert.deepEqual(log, [{ rpc: 'read_growth_partner_ledger', actor: users.find(u=>u.role===role).auth_user_id }]);
      await call('partner-ledger', role, 405, {}, 'POST');
      await call('partner-ledger', role, 400, { workspaceId: workspace });
      assert.deepEqual(log, []);
      await call('creator-jobs',role,403);
      assert.deepEqual(log,[{rpc:'read_growth_creator_jobs',args:{p_actor:users.find(u=>u.role===role).auth_user_id,p_workspace:null,p_staff:null,p_offset:0}}]);
      await call('creator-job-command',role,403,{requestId:id(81)});
      await call('creator-jobs',role,403,{},'POST',{requestId:id(81),action:'create',terms:{}});
      assert.deepEqual(log,[],'Creator cannot create a company order');
      const companyJobs=await call('clinic-creator-jobs',role,role==='doctor'?403:200);
      if(role!=='doctor')assert.deepEqual(companyJobs.data,{items:[],hasMore:false});
      await call('clinic-creator-job-command',role,role==='doctor'?403:200,{requestId:id(81)});
      const directory=await call('creator-directory',role,role==='doctor'?403:200);
      if(role!=='doctor')assert.deepEqual(directory.data,{items:[],hasMore:false});
      await call('creator-job-detail',role,403,{jobId:id(82)});
      await call('clinic-creator-job-detail',role,403,{jobId:id(82)});
      for(const [route,action] of [['creator-job-command','submit'],['clinic-creator-job-command','create']]) {
        const stopped=await call(route,role,route==='creator-job-command'||role==='doctor'?403:200,{},'POST',
          {operation:'close',requestId:id(81),action,targetId:id(82)});
        if(route==='clinic-creator-job-command'&&role!=='doctor')assert.equal(stopped.data.state,'abandoned');
      }
      const context = await call('auth-context', role, 200);
      assert.equal(context.mode, 'supabase');
      assert.equal(context.data.workspaceId, workspace);
      assert.equal(context.data.role, role);
      assert.equal(context.data.isAdmin, role !== 'doctor');
      const visits = await call('appointments', role, 200);
      assert.equal(visits.mode, 'supabase');
      assert.deepEqual(visits.data.items, []);
      const blog = await call('site-blog', role, role === 'doctor' ? 403 : 200);
      if (role === 'doctor') assert.ok(!log.some(entry => entry.table === 'site_blog_posts'));
      else {
        assert.equal(blog.data[0].title, 'Private fixture');
        assert.ok(log.some(entry => entry.table === 'site_blog_posts'
          && entry.filters.some(([key, value]) => key === 'workspace_id' && value === workspace)));
      }
      await call('appointments', role, 403, { workspaceId: id(2) });
      assert.ok(!log.some(entry => entry.table === 'appointments'));
      const scope = await call('site-inquiry-deletion-preview', role, role === 'doctor' ? 403 : 200, { leadId: id(41) });
      if (role === 'doctor') assert.ok(!log.some(entry => entry.table === 'crm_site_inquiries'));
      else {
        assert.equal(scope.data.deletionEnabled, false);
        assert.equal(scope.data.deletionAvailability, 'disabled');
        assert.deepEqual(scope.data.receiptIds, [id(42)]);
      }
      const operations = await call('site-inquiry-deletion-operations', role, role === 'doctor' ? 403 : 200);
      if (role === 'doctor') assert.ok(!log.some(entry => entry.rpc));
      else assert.deepEqual(operations.data, { operations: [], complete: true, deletionEnabled: false });
    }
    tables.crm_intake_sites[0].manual_deletion_enabled = true;
    const eligibleScope = await call('site-inquiry-deletion-preview', 'owner', 200, { leadId: id(41) });
    assert.equal(eligibleScope.data.deletionAvailability, 'confirmation_required');
    assert.equal(eligibleScope.data.deletionEnabled, true);
    assert.ok(!log.some(entry => entry.rpc));
    tables.crm_intake_sites[0].manual_deletion_enabled = false;
    await call('site-inquiry-deletion-preview', 'owner', 403, { workspaceId: id(2), leadId: id(41) });
    assert.ok(!log.some(entry => entry.table === 'crm_site_inquiries'));
    await call('site-inquiry-deletion-preview', 'expired', 401, { leadId: id(41) });
    assert.equal(log.length, 0);
    await call('site-inquiry-deletion-preview', undefined, 401, { role: 'owner', leadId: id(41) });
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      await call('site-inquiry-deletion-preview', 'owner', 405, { leadId: id(41) }, method);
    }
    await call('site-inquiry-deletion-preview/extra', 'owner', 404, { leadId: id(41), path: ['site-inquiry-deletion-preview', 'extra'] });
    const confirmation = { leadId: id(41), receiptIds: [id(42)], leadUpdatedAt: tables.leads[0].updated_at,
      confirmed: true, requestKey: id(43) };
    for (const role of ['owner', 'admin']) {
      const result = await call('site-inquiry-deletion', role, 409, {}, 'POST', confirmation);
      assert.equal(result.code, 'site_deletion_disabled');
      assert.equal(log.filter(entry => entry.rpc).length, 1);
      const preparation = await call('site-inquiry-deletion-operations', role, 409, {}, 'POST', { action: 'prepare', request: confirmation });
      assert.equal(preparation.code, 'site_deletion_disabled');
      assert.equal(log.filter(entry => entry.rpc).length, 1);
    }
    for (const [role, expected, query] of [[undefined, 401, {}], ['expired', 401, {}], ['doctor', 403, {}], ['owner', 403, { workspaceId: id(2) }]]) {
      await call('site-inquiry-deletion', role, expected, query, 'POST', '{unparsed');
      assert.ok(!log.some(entry => entry.rpc));
    }
    await call('site-inquiry-deletion', 'owner', 400, {}, 'POST', '{unparsed');
    await call('site-inquiry-deletion', 'owner', 400, {}, 'POST', { ...confirmation, confirmed: false });
    await call('site-inquiry-deletion', 'owner', 400, {}, 'POST', { ...confirmation, userId: id(21) });
    await call('site-inquiry-deletion', 'owner', 405);
    await call('site-inquiry-deletion/extra', 'owner', 404, { path: ['site-inquiry-deletion', 'extra'] }, 'POST', confirmation);
    await call('site-inquiry-deletion-operations', 'doctor', 403, {}, 'POST', '{unparsed');
    assert.ok(!log.some(entry => entry.rpc));
    await call('site-inquiry-deletion-operations', 'owner', 400, {}, 'POST', '{unparsed');
    await call('site-inquiry-deletion-operations', 'owner', 400, {}, 'POST', { action: 'prepare', request: { ...confirmation, actorId: id(21) } });
    await call('site-inquiry-deletion-operations', 'owner', 405, {}, 'PATCH');
    await call('site-inquiry-deletion-operations/extra', 'owner', 404, { path: ['site-inquiry-deletion-operations', 'extra'] });
    await call('site-blog', 'doctor', 403, {}, 'POST');
    await call('site-blog', 'owner', 403, { workspaceId: id(2) });
    await call('auth-context', 'expired', 401);
    assert.equal(log.length, 0, 'Invalid token must not reach membership or CRM data');
    await call('site-blog', undefined, 401, { role: 'owner', uiMode: 'admin' });
    users[0].status = 'inactive';
    await call('appointments', 'owner', 403);
    users[0].status = 'active';
    membershipFailure = true;
    await call('appointments', 'owner', 503);
    assert.ok(!log.some(entry => entry.table === 'appointments'));
    membershipFailure = false;
    process.env.MEDINA_PLATFORM_OWNER_IDS = users[0].auth_user_id;
    tables.growth_contributor_profiles[0].partner_status = 'approved';
    tables.growth_contributor_profiles[0].creator_status = 'approved';
    const creatorJobs=await call('creator-jobs','owner',200);
    assert.deepEqual(creatorJobs.data,{items:[],hasMore:false});
    assert.ok(!log.some(entry=>entry.table==='staff_users'),'Independent creator Auth does not require a clinic membership');
    const creatorDirectory=await call('creator-directory','owner',200);
    assert.deepEqual(creatorDirectory.data,{items:[{id:id(71),displayName:'Own blogger',portfolioUrls:[]}],hasMore:false});
    users[0].status='inactive';
    await call('creator-jobs','owner',200);
    await call('clinic-creator-jobs','owner',403);
    users[0].status='active';
    await call('creator-job-command','owner',200,{requestId:id(81)});
    const stopped=await call('creator-job-command','owner',200,{},'POST',
      {operation:'close',requestId:id(81),action:'submit',targetId:id(82)});
    assert.equal(stopped.data.state,'abandoned');
    assert.ok(!log.some(entry=>entry.table==='staff_users'),'Creator close uses only its verified Auth');
    await call('creator-job-detail','owner',403,{jobId:id(82)});
    tables.growth_contributor_profiles[0].creator_status='suspended';
    await call('creator-jobs','owner',403);
    tables.growth_contributor_profiles[0].creator_status='approved';
    for(const route of ['creator-jobs','creator-job-command','clinic-creator-jobs','clinic-creator-job-command',
      'creator-job-detail','clinic-creator-job-detail','creator-directory'])
      await call(route,'owner',404,{path:[route,'unexpected']});
    await call('creator-jobs','owner',400,{workspaceId:workspace});
    await call('clinic-creator-jobs','owner',403,{workspaceId:id(2)});
    await call('creator-jobs','owner',405,{},'PATCH');
    for(const route of ['creator-job-detail','clinic-creator-job-detail','creator-directory']) {
      await call(route,'owner',405,{},'POST');
      await call(route,'owner',400,{offset:'01',jobId:id(82)});
    }
    await call('creator-directory','owner',403,{workspaceId:id(2)});
    assert.ok(!log.some(entry=>entry.rpc),'Directory cannot select another company');
    const ownLedger = await call('partner-ledger', 'owner', 200);
    assert.deepEqual(ownLedger.data, { state: 'not_activated' });
    assert.ok(!log.some(entry=>entry.table==='staff_users'), 'Own partner report does not require clinic membership');
    await call('partner-ledger', 'owner', 404, { path: ['partner-ledger','unexpected'] });
    const applicants = await call('platform-contributors', 'owner', 200);
    assert.equal(applicants.data.items.length, 2);
    await call('contributor-account', 'owner', 404, { path: ['contributor-account', 'unexpected'] });
    delete process.env.MEDINA_PLATFORM_OWNER_IDS;
    await call('site-page', undefined, brokenRenderer ? 503 : 404);
    if (brokenRenderer) {
      await call('site-page', undefined, 503, {}, 'HEAD');
      // A failed optional import must not poison later requests in a warm function.
      await call('auth-context', 'owner', 200);
      await call('appointments', 'doctor', 200);
      await call('site-blog', 'admin', 200);
      return checks;
    }
    // Exercise the enabled renderer too; drafts and visitor-selected tenants stay private.
    process.env.MEDINA_PUBLIC_SITE_ENABLED = 'true';
    process.env.MEDINA_PUBLIC_SITE_WORKSPACE_ID = workspace;
    process.env.MEDINA_SITE_ORIGIN = 'https://site-fixture.invalid';
    tables.site_blog_posts.push({ id: id(31), workspace_id: workspace,
      body: 'Unpublished edit must stay private', published_snapshot: {
        locale: 'ru', slug: 'published-fixture', title: 'Published fixture',
        excerpt: 'Approved summary', body: '<script>fixture()</script>' } });
    const html = await call('site-page', undefined, 200, { page: '/ru/blog/' });
    assert.ok(!html.includes('Private fixture'));
    assert.ok(html.includes('Published fixture'));
    const article = await call('site-page', undefined, 200, { page: '/ru/blog/published-fixture/' });
    assert.ok(!article.includes('<script>fixture()'));
    assert.ok(!article.includes('Unpublished edit must stay private'));
    assert.ok(!article.includes(workspace));
    tables.site_blog_posts.pop();
    await call('site-page', undefined, 404, { page: '/ru/blog/published-fixture/' });
    await call('site-page', undefined, 404, { page: '/ru/blog/private-fixture/' });
    await call('site-page', undefined, 400, { page: '/ru/', workspaceId: id(2) });
    return checks;
  } finally {
    supabase.setSupabaseServerClientFactoryForTests(null);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.MEDINA_PUBLIC_SITE_ENABLED;
    delete process.env.MEDINA_PUBLIC_SITE_WORKSPACE_ID;
    delete process.env.MEDINA_SITE_INTAKE_KEY;
    delete process.env.MEDINA_SITE_ORIGIN;
    delete process.env.MEDINA_PLATFORM_OWNER_IDS;
    global.fetch = async () => { throw new Error('Network forbidden'); };
  }
};
