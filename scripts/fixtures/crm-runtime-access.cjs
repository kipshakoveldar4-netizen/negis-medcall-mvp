// Runs only in the sanitized cold-start child, against compiled CommonJS code.
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function checkRuntimeAccess(handler) {
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
    site_blog_posts: [{ id: id(30), workspace_id: workspace, title: 'Private fixture',
      slug: 'private-fixture', excerpt: 'Private', body: 'Never public', version: 1,
      updated_at: '2026-01-01T00:00:00Z' }],
  };
  const client = {
    from(table) {
      assert.ok(Object.hasOwn(tables, table), `Unexpected table: ${table}`);
      const entry = { table, filters: [] };
      log.push(entry);
      let single = false;
      const predicates = [];
      const query = {
        select() { return query; }, order() { return query; }, limit() { return query; },
        range() { return query; },
        eq(key, value) { entry.filters.push([key, value]); predicates.push(row => row[key] === value); return query; },
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
            : { data: single ? rows[0] ?? null : rows, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
  process.env.SUPABASE_URL = 'https://runtime-fixture.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-only-not-a-credential';
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
  async function call(route, role, expected, query = {}, method = 'GET') {
    log.length = 0;
    let status, body;
    const response = { setHeader() {}, status(value) { status = value; return response; },
      json(value) { body = value; }, end(value) { body = value; } };
    await handler({ method, url: `/api/crm/${route}`, headers: role ? { authorization: `Bearer fixture.${role}.signature` } : {},
      ...(method === 'GET' ? {} : { body: {} }),
      query: { path: [route], ...(route === 'site-page' ? {} : { workspaceId: workspace }), ...query } }, response);
    assert.equal(status, expected, `${route}: ${role || 'anonymous'}`);
    const serialized = JSON.stringify(body);
    for (const forbidden of ['fixture-only-not-a-credential', 'signature', 'private auth diagnostic', 'private database diagnostic']) {
      assert.ok(!serialized.includes(forbidden), 'No credential or private diagnostic in response');
    }
    checks++;
    return body;
  }
  try {
    for (const role of roles) {
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
    }
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
    await call('site-page', undefined, 404);
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
    delete process.env.MEDINA_SITE_ORIGIN;
    global.fetch = async () => { throw new Error('Network forbidden'); };
  }
};
