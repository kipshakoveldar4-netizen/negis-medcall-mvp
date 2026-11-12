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
type RpcResult = { error: Row | null; data?: unknown };
type ResponseFixture = { statusCode: number; body: Row; status(code: number): ResponseFixture; setHeader(...args: unknown[]): ResponseFixture; json(body: Row): ResponseFixture };
function response(): ResponseFixture {
  return { statusCode: 0, body: {}, status(code) { this.statusCode = code; return this; }, setHeader() { return this; }, json(body) { this.body = body; return this; } };
}

async function fixture(run: (f: {
  rows: Record<string, Row[]>; queries: Query[];
  errors: Record<string, boolean>; rpcCalls: Row[]; rpcResult: RpcResult;
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
  const rpcResult: RpcResult = { error: null };
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
      if (name === 'save_mortgage_admin_self_lead') {
        if (rpcResult.error || 'data' in rpcResult) return { data: rpcResult.data ?? null, error: rpcResult.error };
        const before = rows.leads.find((row) => row.id === args.p_lead_id) ?? {};
        return { data: {
          id: args.p_lead_id ?? '77777777-7777-4777-8777-777777777777', workspace_id: args.p_workspace_id,
          full_name: before.full_name ?? before.name ?? '', phone: before.phone ?? '', notes: before.notes ?? '',
          status: before.status ?? 'new', source: before.source ?? null, campaign: null, client_id: null,
          stage_id: null, source_id: null, meta_campaign_launch_id: null,
          created_at: '2026-10-19T00:00:00.000Z', updated_at: '2026-10-19T00:00:00.000Z',
          ...args.p_row, responsible_user_id: args.p_staff_user_id,
          stage_definition: rows.lead_stages?.find((row) => row.id === args.p_row.stage_id) ?? null,
          source_definition: rows.lead_sources?.find((row) => row.id === args.p_row.source_id) ?? null,
        }, error: null };
      }
      return { data: name.includes('list') ? [] : null, error: null };
    },
  }));
  const router = await load('api/crm/[...path].ts') as { default(req: unknown, res: ResponseFixture): Promise<unknown> };
  const guard = await load('lib/auth/route-guard.ts') as { authorizePrivateRoute(req: unknown, res: ResponseFixture, authorization: unknown): Promise<unknown> };
  const req = (method: string, body?: Row, query?: Row) => ({ method, headers: { authorization: 'Bearer local.fixture.token' }, body, query: { workspaceId: workspace, ...query } });
  try {
    await run({ rows, queries, errors, rpcCalls, rpcResult,
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

test('owner assignment list and writes still accept only an active lead manager in this workspace', async () => {
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

test('current active admin can choose herself and active managers through both aliases and nested PATCH', async () => {
  await fixture(async (f) => {
    const listed = await f.call('lead-assignees');
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(new Set(listed.body.data.assignees.map((row: Row) => row.id)), new Set([staff, assignee]));
    assert.ok(f.queries.every((q) => q.operation === 'select'), 'listing must never reassign a lead');
    for (const target of [staff, assignee]) for (const key of ['responsibleUserId', 'responsible_user_id']) {
      for (const nested of [false, true]) {
        const body = nested ? { id: lead, updates: { [key]: target } } : { id: lead, [key]: target };
        const saved = await f.call('leads', 'PATCH', body);
        assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
        if (target === staff) {
          assert.equal(f.rpcCalls.length, 1);
          const rpc = f.rpcCalls[0];
          assert.equal(rpc.name, 'save_mortgage_admin_self_lead');
          assert.deepEqual({ ...rpc.args, p_row: undefined }, { p_workspace_id: workspace, p_staff_user_id: staff,
            p_auth_user_id: user, p_lead_id: lead, p_row: undefined });
          assert.equal(rpc.args.p_row.responsible_user_id, staff);
          assert.ok(f.queries.every((q) => q.table !== 'leads' || q.operation === 'select'));
          assert.equal(saved.body.data.item.id, lead);
          assert.equal(saved.body.data.item.responsibleUserId, staff);
        } else {
          const update = f.queries.find((q) => q.table === 'leads' && q.operation === 'update');
          assert.equal(update?.payload?.responsible_user_id, target);
          assert.deepEqual(update?.filters, { id: lead, workspace_id: workspace });
          assert.equal(f.rpcCalls.length, 0, 'manager distribution keeps its existing write path');
        }
      }
      const created = await f.call('leads', 'POST', { name: 'Synthetic contact', phone: '+77000000000', [key]: target });
      assert.equal(created.statusCode, 201, JSON.stringify(created.body));
      if (target === staff) {
        assert.equal(f.rpcCalls.length, 1);
        assert.equal(f.rpcCalls[0].name, 'save_mortgage_admin_self_lead');
        assert.deepEqual({ ...f.rpcCalls[0].args, p_row: undefined }, { p_workspace_id: workspace, p_staff_user_id: staff,
          p_auth_user_id: user, p_lead_id: null, p_row: undefined });
        assert.equal(f.rpcCalls[0].args.p_row.full_name, 'Synthetic contact');
        assert.equal(f.rpcCalls[0].args.p_row.responsible_user_id, staff);
        assert.ok(f.queries.every((q) => q.table !== 'leads' || q.operation === 'select'));
        assert.equal(created.body.data.item.responsibleUserId, staff);
      } else {
        const insert = f.queries.find((q) => q.table === 'leads' && q.operation === 'insert');
        assert.equal(insert?.payload?.responsible_user_id, target);
        assert.equal(insert?.payload?.workspace_id, workspace);
        assert.equal(f.rpcCalls.length, 0);
      }
    }
    const unassigned = await f.call('leads', 'POST', { name: 'Synthetic unassigned', phone: '+77000000001' });
    assert.equal(unassigned.statusCode, 201);
    assert.equal(f.queries.find((q) => q.table === 'leads' && q.operation === 'insert')?.payload?.responsible_user_id ?? null, null);
  }, 'admin');
});

test('mixed-case admin-self PATCH returns canonical UUID and records exactly one canonical journal entry', async () => {
  await fixture(async (f) => {
    const canonical = 'abcd1234-abcd-4abc-8def-abcdef123456';
    const requested = 'AbCd1234-aBcD-4aBc-8DeF-aBcDeF123456';
    assert.notEqual(requested, canonical);assert.equal(requested.toLowerCase(), canonical);
    f.rows.leads[0].id = canonical;
    const saved = await f.call('leads', 'PATCH', { id: requested, updates: { responsibleUserId: staff, notes: 'Synthetic canonical patch' } });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.item.id, canonical);
    assert.equal(saved.body.data.item.responsibleUserId, staff);
    assert.equal(saved.body.data.item.notes, 'Synthetic canonical patch');
    assert.equal(f.rpcCalls.length, 1);
    assert.equal(f.rpcCalls[0].name, 'save_mortgage_admin_self_lead');
    assert.equal(f.rpcCalls[0].args.p_lead_id, canonical);
    assert.equal(f.queries.filter((q) => q.table === 'leads' && q.operation !== 'select').length, 0);
    const journal = f.queries.filter((q) => q.table === 'audit_logs' && q.operation === 'insert');
    assert.equal(journal.length, 1);
    assert.equal(journal[0].payload?.entity_id, canonical);
    assert.equal(journal[0].payload?.workspace_id, workspace);
    assert.equal(journal[0].payload?.action, 'updated');
    assert.equal(journal[0].payload?.entity_type, 'lead');
    assert.equal(journal[0].payload?.actor_staff_user_id, staff);
  }, 'admin');
});

test('admin-self missing, denied and invalid RPC results never fall back to legacy lead writes', async () => {
  await fixture(async (f) => {
    for (const [code, status, expected] of [
      ...['PGRST202', '42883', '42703', 'PGRST204', '42P01', 'PGRST205'].map((code) => [code, 503, 'mortgage_admin_self_unavailable']),
      ['P7001', 403, 'mortgage_admin_self_access_denied'], ['P7703', 403, 'mortgage_admin_self_access_denied'],
      ['P7702', 404, 'lead_not_found'], ['P7701', 400, 'mortgage_admin_self_invalid'],
    ] as Array<[string, number, string]>) {
      f.rpcResult.error = { code, message: 'fixture-private RPC details' };
      for (const method of ['POST', 'PATCH']) for (const key of ['responsibleUserId', 'responsible_user_id']) {
        const body = method === 'PATCH' ? { id: lead, updates: { [key]: staff } }
          : { name: 'Synthetic denied self', phone: '+77000000000', [key]: staff };
        const denied = await f.call('leads', method, body);
        assert.equal(denied.statusCode, status, `${method}:${code}`);
        assert.equal(denied.body.code, expected);
        assert.equal(f.rpcCalls.length, 1);
        assert.ok(f.queries.every((q) => q.operation === 'select'), 'no legacy write, retry or audit after a refused RPC');
        assert.doesNotMatch(JSON.stringify(denied.body), /fixture-private/);
      }
    }
    f.rpcResult.error = null;
    for (const data of [null, {}, { id: lead, workspace_id: foreignWorkspace, responsible_user_id: staff },
      { id: lead, workspace_id: workspace, responsible_user_id: assignee },
      { id: assignee, workspace_id: workspace, responsible_user_id: staff }]) {
      f.rpcResult.data = data;
      const denied = await f.call('leads', 'PATCH', { id: lead, responsibleUserId: staff });
      assert.equal(denied.statusCode, 502);
      assert.equal(f.rpcCalls.length, 1);
      assert.ok(f.queries.every((q) => q.operation === 'select'));
    }
    f.rpcResult.error = { code: '42883', message: 'Missing synthetic RPC' };
    const distributed = await f.call('leads', 'PATCH', { id: lead, responsibleUserId: assignee });
    assert.equal(distributed.statusCode, 200);
    assert.equal(f.rpcCalls.length, 0);
    assert.equal(f.queries.find((q) => q.table === 'leads' && q.operation === 'update')?.payload?.responsible_user_id, assignee);
  }, 'admin');
});

test('admin cannot assign other admins, owners, inactive or foreign staff or substitute a forged actor', async () => {
  await fixture(async (f) => {
    for (const change of [
      { role: 'admin', status: 'active', workspace_id: workspace },
      { role: 'owner', status: 'active', workspace_id: workspace },
      { role: 'manager', status: 'active', workspace_id: workspace },
      { role: 'lead_manager', status: 'inactive', workspace_id: workspace },
      { role: 'admin', status: 'inactive', workspace_id: workspace },
      { role: 'lead_manager', status: 'active', workspace_id: foreignWorkspace },
      { role: 'admin', status: 'active', workspace_id: foreignWorkspace },
    ]) {
      Object.assign(f.rows.staff_users[1], change);
      const listed = await f.call('lead-assignees');
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(listed.body.data.assignees.map((row: Row) => row.id), [staff]);
      for (const key of ['responsibleUserId', 'responsible_user_id']) for (const nested of [false, true]) {
        const body = nested ? { id: lead, updates: { [key]: assignee } } : { id: lead, [key]: assignee };
        const denied = await f.call('leads', 'PATCH', body);
        assert.equal(denied.statusCode, 400, JSON.stringify(change));
        assert.ok(f.queries.every((q) => q.operation === 'select'));
      }
      const denied = await f.call('leads', 'POST', { name: 'Synthetic denied', phone: '+77000000002', responsibleUserId: assignee });
      assert.equal(denied.statusCode, 400);
      assert.ok(f.queries.every((q) => q.operation === 'select'));
    }
    Object.assign(f.rows.staff_users[1], { role: 'admin', status: 'active', workspace_id: workspace });
    const forged = { staffUserId: assignee, staff_user_id: assignee, actorStaffUserId: assignee, role: 'admin', userId: user };
    for (const nested of [false, true]) {
      const body = nested ? { id: lead, ...forged, updates: { responsibleUserId: assignee, ...forged } }
        : { id: lead, responsible_user_id: assignee, ...forged };
      const denied = await f.call('leads', 'PATCH', body, forged);
      assert.ok([400, 403].includes(denied.statusCode));
      assert.ok(f.queries.every((q) => q.operation === 'select'));
    }
    f.rows.staff_users[0].status = 'inactive';
    for (const [route, method, body] of [['lead-assignees', 'GET', undefined], ['leads', 'PATCH', { id: lead, responsibleUserId: staff }]] as const) {
      assert.equal((await f.call(route, method, body)).statusCode, 403);
      assert.ok(f.queries.every((q) => q.operation === 'select'));
    }
  }, 'admin');
});

test('owner does not gain self-assignment and lead managers do not gain distribution or team reports', async () => {
  await fixture(async (f) => {
    for (const key of ['responsibleUserId', 'responsible_user_id']) {
      assert.equal((await f.call('leads', 'PATCH', { id: lead, updates: { [key]: staff }, staffUserId: staff, role: 'admin' })).statusCode, 400);
      assert.ok(f.queries.every((q) => q.operation === 'select'));
    }
  });
  await fixture(async (f) => {
    for (const route of ['lead-assignees', 'lead-team-analytics']) {
      assert.equal((await f.call(route)).statusCode, 403);
      assert.ok(f.queries.every((q) => q.operation === 'select'));
    }
    assert.equal((await f.call('leads', 'PATCH', { id: lead, responsibleUserId: staff })).statusCode, 400);
    assert.equal(f.rpcCalls.length, 0);
    assert.ok(f.queries.every((q) => q.operation === 'select'));
  }, 'lead_manager');
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
      { id: '66666666-6666-4666-8666-666666666666', workspace_id: workspace, role: 'admin', status: 'active', full_name: 'Local distributor' },
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
