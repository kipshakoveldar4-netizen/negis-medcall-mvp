import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreignWorkspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = '11111111-1111-4111-8111-111111111111';
const staff = '22222222-2222-4222-8222-222222222222';
const assignee = '33333333-3333-4333-8333-333333333333';
const lead = '44444444-4444-4444-8444-444444444444';
type Row = Record<string, any>;
type Query = { table: string; operation: string; filters: Record<string, unknown>; payload?: Row; columns?: string };
type ResponseFixture = { statusCode: number; body: Row; status(code: number): ResponseFixture; setHeader(...args: unknown[]): ResponseFixture; json(body: Row): ResponseFixture };
function response(): ResponseFixture {
  return { statusCode: 0, body: {}, status(code) { this.statusCode = code; return this; }, setHeader() { return this; }, json(body) { this.body = body; return this; } };
}

async function fixture(run: (f: {
  rows: Record<string, Row[]>; queries: Query[];
  errors: Record<string, boolean>; rpcCalls: Row[];
  call(route: string, method?: string, body?: Row, query?: Row): Promise<ResponseFixture>;
  privateCall(): Promise<ResponseFixture>;
}) => Promise<void>, role = 'owner') {
  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://local.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-fixture-only';
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    assert.match(String(url), /\/auth\/v1\/user$/);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: user }) };
  }) as unknown as typeof fetch;
  const queries: Query[] = [], rpcCalls: Row[] = [];
  const errors: Record<string, boolean> = {};
  const rows: Record<string, Row[]> = {
    staff_users: [
      { id: staff, workspace_id: workspace, auth_user_id: user, role, status: 'active', full_name: 'Local actor' },
      { id: assignee, workspace_id: workspace, auth_user_id: 'local-other-user', role: 'lead_manager', status: 'active', full_name: 'Local manager' },
    ],
    workspace_settings: [{ workspace_id: workspace, key: 'workspace_purpose', value: { purpose: 'mortgage_leads' } }],
    leads: [{ id: lead, workspace_id: workspace, name: 'Local incoming lead', phone: '', status: 'new', notes: '', source: 'whatsapp' }],
  };
  const server = await load('lib/supabase/server.ts') as { setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void };
  server.setSupabaseServerClientFactoryForTests(() => ({
    from(table: string) {
      const entry: Query = { table, operation: 'select', filters: {} };
      queries.push(entry);
      const builder: Row = {};
      const settle = (single = false) => {
        if (errors[table]) return Promise.resolve({ data: null, error: { message: 'local fixture storage outage' } });
        const selected = (rows[table] ?? []).filter((row) => Object.entries(entry.filters).every(([key, value]) =>
          Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
        const data = entry.operation === 'select' ? selected : selected.map((row) => ({ ...row, ...entry.payload }));
        return Promise.resolve({ data: single ? data[0] ?? null : data, error: null, count: data.length });
      };
      Object.assign(builder, {
        select(columns: string) { entry.columns = columns; return builder; },
        eq(key: string, value: unknown) { entry.filters[key] = value; return builder; },
        in(key: string, value: unknown) { entry.filters[key] = value; return builder; },
        update(payload: Row) { entry.operation = 'update'; entry.payload = payload; return builder; },
        insert(payload: Row) { entry.operation = 'insert'; entry.payload = payload; return builder; },
        order: () => builder, limit: () => builder, range: () => builder,
        single: () => settle(true), maybeSingle: () => settle(true),
        then(resolve: (value: unknown) => unknown) { return settle().then(resolve); },
      });
      return builder;
    },
    async rpc(name: string, args: Row) {
      rpcCalls.push({ name, args });
      return { data: name.includes('list') ? [] : null, error: null };
    },
  }));
  const router = await load('api/crm/[...path].ts') as { default(req: unknown, res: ResponseFixture): Promise<unknown> };
  const guard = await load('lib/auth/route-guard.ts') as { authorizePrivateRoute(req: unknown, res: ResponseFixture, authorization: unknown): Promise<unknown> };
  const req = (method: string, body?: Row, query?: Row) => ({ method, headers: { authorization: 'Bearer local.fixture.token' }, body, query: { workspaceId: workspace, ...query } });
  try {
    await run({ rows, queries, errors, rpcCalls,
      async call(route, method = 'GET', body, query) {
        queries.length = 0; rpcCalls.length = 0;
        const res = response();
        await router.default({ ...req(method, body, query), query: { path: [route], workspaceId: workspace, ...query } }, res);
        return res;
      },
      async privateCall() {
        queries.length = 0;
        const res = response();
        const context = await guard.authorizePrivateRoute(req('POST'), res, { kind: 'browser', methods: ['POST'], permissions: { POST: 'manage_marketing' } });
        assert.equal(context, null);
        return res;
      },
    });
  } finally {
    server.setSupabaseServerClientFactoryForTests(null); globalThis.fetch = fetchBefore;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
const business = (queries: Query[]) => queries.filter((q) => !['staff_users', 'workspace_settings'].includes(q.table));

test('mortgage policy closes unknown keys and unsupported roles by default', async () => {
  const policy = await load('lib/crm/workspace-policy.ts') as { mortgageRouteAllowed(role: string, route: string, method: string): boolean };
  for (const role of ['owner', 'admin', 'lead_manager', 'manager', 'marketer', 'doctor']) {
    for (const route of ['constructor', 'toString', '__proto__', 'new-module', 'admin-settings', 'appointments', 'meta-launch']) {
      assert.equal(policy.mortgageRouteAllowed(role, route, 'POST'), false, `${role}:${route}`);
    }
  }
});

test('mortgage owner/admin direct medical, financial, marketing and configuration routes deny before business work', async () => {
  for (const role of ['owner', 'admin']) await fixture(async (f) => {
    for (const [route, method] of [['clients', 'POST'], ['appointments', 'POST'], ['deals', 'POST'], ['clinic-services', 'GET'], ['clinic-doctors', 'GET'],
      ['meta-launch', 'POST'], ['ads-ai-fill', 'POST'], ['meta-launches', 'GET'], ['tiktok-launch', 'POST'], ['admin-settings', 'POST'],
      ['site-blog', 'GET'], ['subscription', 'GET'], ['whatsapp-channels', 'PATCH'], ['tasks', 'POST']]) {
      const res = await f.call(route, method, { purpose: 'clinic_services', role: 'owner', key: 'workspace_purpose', value: { purpose: 'clinic_services' } });
      assert.equal(res.statusCode, 403, `${role}:${route}`);
      assert.equal(res.body.code, 'workspace_module_unavailable');
      assert.deepEqual(business(f.queries), []);
      assert.ok(f.queries.every((q) => q.operation === 'select'));
    }
    const res = await f.privateCall(); assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'workspace_module_unavailable');
    assert.deepEqual(business(f.queries), []);
  }, role);
});

test('purpose is queried from the verified tenant each time and malformed/unreadable data fail closed', async () => {
  await fixture(async (f) => {
    let res = await f.call('leads', 'GET', { purpose: 'clinic_services', workspaceId: foreignWorkspace });
    assert.equal(res.statusCode, 200);
    const query = f.queries.find((q) => q.table === 'workspace_settings')!;
    assert.deepEqual(query.filters, { workspace_id: [workspace], key: 'workspace_purpose' });
    f.rows.workspace_settings[0].value.purpose = 'unrecognized';
    res = await f.call('leads'); assert.equal(res.statusCode, 503); assert.deepEqual(business(f.queries), []);
    f.rows.workspace_settings[0].value.purpose = 'mortgage_leads';
    f.rows.workspace_settings.push({ ...f.rows.workspace_settings[0] });
    res = await f.call('leads'); assert.equal(res.statusCode, 503);
    f.rows.workspace_settings.pop(); f.errors.workspace_settings = true;
    res = await f.call('leads'); assert.equal(res.statusCode, 503); assert.deepEqual(business(f.queries), []);
    assert.equal(res.body.code, 'workspace_profile_unavailable');
  });
});

test('missing legacy profile and explicit clinic profile keep their current medical access', async () => {
  await fixture(async (f) => {
    for (const settings of [[], [{ workspace_id: workspace, key: 'workspace_purpose', value: { purpose: 'clinic_services' } }]]) {
      f.rows.workspace_settings = settings;
      const res = await f.call('clinic-services');
      assert.equal(res.statusCode, 200);
      assert.ok(business(f.queries).length > 0);
    }
  });
});

test('mortgage team creation cannot substitute manager/medical roles or bypass normal rank checks', async () => {
  await fixture(async (f) => {
    for (const role of ['manager', 'owner', 'doctor', 'receptionist', 'marketer']) {
      for (const [route, method] of [['staff-credentials', 'POST'], ['staff', 'PATCH'], ['staff-invitations', 'POST'], ['staff-join-requests', 'PATCH']]) {
        const res = await f.call(route, method, { role, id: assignee, email: 'local@example.test' });
        assert.equal(res.statusCode, 403, `${route}:${role}`);
        assert.ok(f.queries.every((q) => q.operation === 'select'));
        if (method === 'PATCH') {
          const nested = await f.call(route, method, { id: assignee, updates: { role } });
          assert.equal(nested.statusCode, 403, `${route}:nested:${role}`);
          assert.ok(f.queries.every((q) => q.operation === 'select'));
        }
      }
    }
  });
  await fixture(async (f) => {
    const res = await f.call('staff', 'PATCH', { id: assignee, role: 'admin' });
    assert.equal(res.statusCode, 403, 'admin still cannot create or promote a peer');
    assert.ok(f.queries.every((q) => q.operation === 'select'));
  }, 'admin');
});

test('assignment list and writes accept only an active lead manager in this workspace', async () => {
  await fixture(async (f) => {
    const res = await f.call('lead-assignees'); assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.assignees.map((row: Row) => row.id), [assignee]);
    for (const change of [{ role: 'admin' }, { role: 'manager' }, { role: 'lead_manager', status: 'inactive' }, { role: 'lead_manager', status: 'active', workspace_id: foreignWorkspace }]) {
      Object.assign(f.rows.staff_users[1], change);
      const denied = await f.call('leads', 'PATCH', { id: lead, responsibleUserId: assignee });
      assert.equal(denied.statusCode, 400, JSON.stringify(change));
      assert.ok(f.queries.every((q) => q.operation === 'select'));
    }
    Object.assign(f.rows.staff_users[1], { role: 'lead_manager', status: 'active', workspace_id: workspace });
    const assigned = await f.call('leads', 'PATCH', { id: lead, responsibleUserId: assignee });
    assert.equal(assigned.statusCode, 200, JSON.stringify(assigned.body));
    const update = f.queries.find((q) => q.table === 'leads' && q.operation === 'update');
    assert.ok(update, 'a confirmed assignment must have a real scoped UPDATE');
    assert.equal(update.payload?.responsible_user_id, assignee);
    assert.equal(update.filters.workspace_id, workspace);
  });
});

test('mortgage leads cannot link clients or paid advertising through payload aliases', async () => {
  await fixture(async (f) => {
    for (const key of ['clientId', 'client_id', 'metaCampaignLaunchId', 'meta_campaign_launch_id']) {
      const res = await f.call('leads', 'PATCH', { id: lead, [key]: assignee });
      assert.equal(res.statusCode, 403, key);
      assert.deepEqual(business(f.queries), []);
      const nested = await f.call('leads', 'PATCH', { id: lead, updates: { [key]: assignee } });
      assert.equal(nested.statusCode, 403, `nested:${key}`);
      assert.deepEqual(business(f.queries), []);
    }
  });
});

test('five active lead managers remain assignable while owner/admin and foreign staff stay outside that list', async () => {
  await fixture(async (f) => {
    const managerIds = Array.from({ length: 5 }, (_, index) => `33333333-3333-4333-8333-33333333333${index}`);
    f.rows.staff_users = [f.rows.staff_users[0], ...managerIds.map((id, index) => ({ id, workspace_id: workspace,
      auth_user_id: `fixture-manager-${index}`, role: 'lead_manager', status: 'active', full_name: `Local manager ${index}` })),
      { id: assignee, workspace_id: workspace, role: 'admin', status: 'active', full_name: 'Local distributor' },
      { id: '55555555-5555-4555-8555-555555555555', workspace_id: foreignWorkspace, role: 'lead_manager', status: 'active' }];
    const res = await f.call('lead-assignees'); assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.assignees.map((row: Row) => row.id), managerIds);
    for (const id of managerIds) {
      const saved = await f.call('leads', 'PATCH', { id: lead, updates: { responsibleUserId: id } });
      assert.equal(saved.statusCode, 200);
      assert.equal(f.queries.find((q) => q.table === 'leads' && q.operation === 'update')?.payload?.responsible_user_id, id);
    }
  });
});

test('revoked and foreign membership never reaches profile or business queries', async () => {
  await fixture(async (f) => {
    let res = await f.call('leads', 'GET', undefined, { workspaceId: foreignWorkspace });
    assert.equal(res.statusCode, 403);
    assert.ok(f.queries.every((q) => q.table === 'staff_users'));
    f.rows.staff_users[0].status = 'inactive';
    res = await f.call('leads'); assert.equal(res.statusCode, 403);
    assert.ok(f.queries.every((q) => q.table === 'staff_users'));
  });
});
