import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';
import { startOwnedPartnerHttp } from './partner-entry-native-http-cases.mjs';
import { seedOperatorWorkday, cleanupOperatorWorkday } from './operator-workday-cases.mjs';

const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const groups = ['new', 'in_progress', 'booked', 'postponed', 'lost', 'other'];
const financialTables = ['platform_subscription_payments', 'growth_partner_commissions', 'growth_partner_payouts', 'deals', 'growth_operator_arrivals'];
const financialSnapshot = async db => (await db.query('select * from (' + financialTables.map(name =>
  `select '${name}' table_name,to_jsonb(r) value from public.${name} r`).join(' union all ') + ') q order by table_name,value::text')).rows;
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected owned lead-search request to wait before native RPC');
}

export async function exerciseOperatorLeadSearchHttp(db, fixture, t) {
  t.after(stopPartnerEntryBuilds);
  const financialBefore = await financialSnapshot(db);
  const controls = { hold: false, release: null, fault: null, isolation: false };
  const calls = [], native = [], expectedStages = new Map();
  let x, other, f, server;
  const release = () => { controls.release?.(); controls.release = null; };
  const adapter = { async rpc(name, args) {
    assert.equal(name, 'read_growth_operator_lead_search');
    assert.deepEqual(Object.keys(args).sort(), ['p_actor', 'p_group', 'p_offset', 'p_request_id', 'p_search']);
    calls.push(structuredClone(args));
    if (controls.hold) {
      controls.hold = false;
      await new Promise(resolve => { controls.release = resolve; });
    }
    const client = await fixture.connect();
    let data;
    try {
      await client.query('set role service_role');
      if (controls.isolation) await client.query('begin isolation level repeatable read');
      data = (await one(client, 'select public.read_growth_operator_lead_search($1,$2,$3,$4,$5) v',
        [args.p_actor, args.p_search, args.p_group, args.p_request_id, args.p_offset])).v;
      native.push({ args: structuredClone(args), code: null });
    } catch (error) {
      native.push({ args: structuredClone(args), code: error.code });
      return { data: null, error: { code: error.code, message: 'PRIVATE_SEARCH_SQL_DIAGNOSTIC' } };
    } finally { await client.end(); }

    // SDK/DTO faults wrap a real native read; no SQL report is manufactured.
    const value = structuredClone(data);
    switch (controls.fault) {
      case 'wrong-offset': value.offset = args.p_offset + 1; break;
      case 'wrong-search': value.filters.search = 'PRIVATE_WRONG_SEARCH'; break;
      case 'wrong-group': value.filters.group = args.p_group === 'all' ? 'new' : 'all'; break;
      case 'wrong-company': value.filters.requestId = other.companies[0].request; break;
      case 'malformed': value.items = null; break;
      case 'inconsistent': value.matched = '999'; break;
      case 'private-field': value.items[0].notes = 'PRIVATE_SEARCH_NOTE'; break;
      case 'missing-rpc': return { data: value, error: { code: 'PGRST202', message: 'PRIVATE_SEARCH_RPC_DIAGNOSTIC' } };
      case 'serialization': return { data: value, error: { code: '40001', message: 'PRIVATE_SEARCH_SNAPSHOT_DIAGNOSTIC' } };
      default: assert.equal(controls.fault, null);
    }
    return { data: value, error: null };
  } };

  function inspect(status, headers, value) {
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|owned-only-not-credential|auth_user_id|workspace_id|workspaceId|price_minor|currency|approved_by|notes|request_key/);
    if (status !== 200) {
      assert.equal(value.success, false);
      assert.equal(value.data, undefined);
      assert.doesNotMatch(JSON.stringify(value), /SEARCHHTTP_[AB]|\+7\d{10}|"(?:items|companies|totals|matched|stageOptions)"/);
    } else assert.equal(value.success, true);
    return { status, value };
  }

  async function call(body = {}, { query = '', method = 'POST', token = 'owned.search.signature', suffix = '' } = {}) {
    const url = server.origin + '/api/crm/operator-lead-search' + suffix + (query ? '?' + query : '');
    const headers = { Origin: ENTRY_ORIGIN, ...(token ? { Authorization: 'Bearer ' + token } : {}) };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    return inspect(response.status, response.headers, await response.json());
  }

  function assertReport(result, { group = 'all', requestId = null, offset = 0, matched, ids, all = matched } = {}) {
    assert.equal(result.status, 200);
    const report = result.value.data;
    assert.deepEqual(report.filters, { group, requestId });
    assert.equal(report.offset, offset);
    assert.equal(report.matched, String(matched));
    assert.equal(report.totals.all, String(all));
    for (const key of groups) assert.equal(report.totals[key], key === 'in_progress' ? String(all) : '0');
    assert.equal(report.hasMore, false);
    assert.deepEqual(report.items.map(item => item.id).sort(), [...ids].sort());
    assert.ok(report.items.every(item => item.group === 'in_progress' && item.stageId === null && item.stageName === ''));
    assert.deepEqual(report.stageOptions, [...new Set(report.items.map(item => item.requestId))].sort().map(id => ({ requestId: id, items: expectedStages.get(id) })));
    return report;
  }

  try {
    x = await seedOperatorWorkday(db, { companies: 2, visits: 0, label: 'SEARCHHTTP_A' });
    other = await seedOperatorWorkday(db, { companies: 1, visits: 0, label: 'SEARCHHTTP_B' });
    for(const company of [...x.companies,...other.companies])expectedStages.set(company.request,
      (await db.query('select id,name from public.lead_stages where workspace_id=$1 and is_active order by sort_order,id',[company.workspace])).rows);
    for (const [i, id] of other.companies[0].leads.entries()) {
      await db.query('update public.leads set phone=$2 where id=$1', [id, '+7888888000' + i]);
    }
    f = await partnerEntryHttpFixture(adapter, {
      approved: false,
      identities: new Map([['owned.search.signature', x.actor], ['owned.other.signature', other.actor], ['owned.nonoperator.signature', randomUUID()]]),
      env: { MEDINA_PARTNER_ENTRY_ENABLED: 'false' },
    });
    server = await startOwnedPartnerHttp(f.handler, ['/api/crm/operator-lead-search', '/api/crm/operator-lead-search/extra']);
    const assigned = x.companies[0], clinic = x.companies[1];
    const ownIds = [...assigned.leads.slice(0, 2), ...clinic.leads];
    const expectedArgs = (values = {}) => ({ p_actor: x.actor, p_search: '', p_group: 'all', p_request_id: null, p_offset: 0, ...values });

    await t.test('124 actual HTTP/Auth/router rejects identity, workspace, clock, limit and malformed selectors without native reads', async () => {
      assert.equal((await call({}, { token: null })).status, 401);
      assert.equal((await call({}, { token: 'owned.unknown.signature' })).status, 401);
      f.state.authUnavailable = true;
      try { assert.equal((await call()).status, 503); } finally { f.state.authUnavailable = false; }
      for (const query of [
        'actor=' + other.actor, 'actorId=' + other.actor, 'p_actor=' + other.actor, 'auth_user_id=' + other.actor,
        'operatorId=' + other.profile, 'profileId=' + other.profile,
        'workspaceId=' + clinic.workspace, 'workspace_id=' + clinic.workspace, 'workspace=' + clinic.workspace,
        'now=2026-01-01', 'date=2026-01-01', 'timeZone=UTC', 'timezone=UTC', 'limit=1000', 'pageSize=1000',
        'offset=0', 'offset=0&offset=20', 'search=PRIVATE_URL_INPUT', 'search=a&search=b',
        'group=all', 'group=all&group=new', 'requestId=' + assigned.request,
      ]) assert.equal((await call({}, { query })).status, 400, query);
      for (const body of [{ actor: other.actor }, { workspaceId: other.companies[0].workspace }, { now: '2026-01-01' },
        { limit: 1000 }, { offset: -1 }, { offset: '0' }, { offset: 1000001 }, { search: 'x'.repeat(121) }, { search: '\u0000' },
        { group: 'unknown' }, { requestId: 'not-a-uuid' }]) assert.equal((await call(body)).status, 400);
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((await call({}, { method })).status, 405, method);
      assert.equal((await call({}, { method: 'GET', query: 'search=PRIVATE_URL_INPUT' })).status, 405);
      assert.equal((await call({}, { suffix: '/extra' })).status, 404);
      assert.equal((await call({}, { query: 'path=operator-lead-search' })).status, 400);
      assert.deepEqual(calls, []);
      assert.deepEqual(native, []);
    });

    await t.test('124 actual native report isolates both operators and assigned/clinic contacts, with absent-stage in_progress fallback', async () => {
      const own = assertReport(await call(), { matched: 6, ids: ownIds });
      assert.deepEqual(calls.at(-1), expectedArgs());
      assert.deepEqual(own.companies, x.companies.map((company, i) => ({
        requestId: company.request, displayName: 'SEARCHHTTP_A company ' + i, leadScope: company.scope,
      })).sort((a, b) => a.requestId < b.requestId ? -1 : 1));
      assert.ok(own.items.every(item => item.name.startsWith('SEARCHHTTP_A permitted lead ') && item.phone.startsWith('+7000000')));
      assert.doesNotMatch(JSON.stringify(own), /SEARCHHTTP_B|\+7888888/);
      const foreign = assertReport(await call({}, { token: 'owned.other.signature' }), { matched: 2, ids: other.companies[0].leads.slice(0, 2) });
      assert.ok(foreign.items.every(item => item.name.startsWith('SEARCHHTTP_B permitted lead ') && item.phone.startsWith('+7888888')));
      assert.doesNotMatch(JSON.stringify(foreign), /SEARCHHTTP_A|\+7000000/);
      assert.deepEqual(calls.at(-1), expectedArgs({ p_actor: other.actor }));
      assert.equal((await call({}, { token: 'owned.nonoperator.signature' })).status, 403);
      assert.equal(native.at(-1).code, 'P1241');
      assert.equal((await call({ requestId: other.companies[0].request })).status, 403);
      assert.equal(native.at(-1).code, 'P1241');
    });

    await t.test('124 actual search/company/group/offset filters are exact without search echoes or out-of-scope matches', async () => {
      const search = 'searchhttp_a PERMITTED lead 0/0';
      assertReport(await call({ search: '  ' + search + '  ' }), { matched: 1, ids: [assigned.leads[0]] });
      assert.deepEqual(calls.at(-1), expectedArgs({ p_search: search }));
      const phone = '+70000000001';
      assertReport(await call({ search: phone }), { matched: 1, ids: [assigned.leads[1]] });
      assert.deepEqual(calls.at(-1), expectedArgs({ p_search: phone }));
      for (const search of ['SEARCHHTTP_B', '+78888880000', 'SEARCHHTTP_A permitted lead 0/2', 'SEARCHHTTP_A permitted lead 0/3', '%', '%_', '\\']) {
        assertReport(await call({ search }), { matched: 0, ids: [] });
      }
      for (const company of [assigned, clinic]) {
        const ids = company.scope === 'assigned' ? company.leads.slice(0, 2) : company.leads;
        const report = assertReport(await call({ requestId: company.request.toUpperCase() }), { requestId: company.request, matched: ids.length, ids });
        assert.equal(report.companies.length, 2);
        assert.deepEqual(calls.at(-1), expectedArgs({ p_request_id: company.request }));
      }
      for (const group of ['all', ...groups]) {
        const ids = ['all', 'in_progress'].includes(group) ? ownIds : [];
        assertReport(await call({ group }), { group, matched: ids.length, all: 6, ids });
        assert.deepEqual(calls.at(-1), expectedArgs({ p_group: group }));
      }
      const combinedSearch = 'SEARCHHTTP_A permitted lead 1/2';
      assertReport(await call({ search: combinedSearch, group: 'in_progress', requestId: clinic.request, offset: 0 }), {
        group: 'in_progress', requestId: clinic.request, matched: 1, ids: [clinic.leads[2]],
      });
      assert.deepEqual(calls.at(-1), expectedArgs({ p_search: combinedSearch, p_group: 'in_progress', p_request_id: clinic.request }));
      const first = assertReport(await call(), { matched: 6, ids: ownIds });
      const next = assertReport(await call({ offset: 1 }), { offset: 1, matched: 6, ids: first.items.slice(1).map(item => item.id) });
      assert.deepEqual(next.items, first.items.slice(1));
      assert.deepEqual(calls.at(-1), expectedArgs({ p_offset: 1 }));
      for (const offset of [20, 1000000]) {
        assertReport(await call({ offset }), { offset, matched: 6, ids: [] });
        assert.deepEqual(calls.at(-1), expectedArgs({ p_offset: offset }));
      }
    });

    await t.test('124 wrong-page/filter, malformed/private/inconsistent DTO and synthetic SDK missing-RPC errors expose no stale report', async () => {
      for (const fault of ['wrong-offset', 'wrong-search', 'wrong-group', 'wrong-company', 'malformed', 'inconsistent', 'private-field', 'missing-rpc', 'serialization']) {
        controls.fault = fault;
        try {
          const before = native.length;
          assert.equal((await call()).status, 503, fault);
          assert.equal(native.length, before + 1, 'Every DTO/SDK fault follows an actual native reader call');
          assert.equal(native.at(-1).code, null);
        } finally { controls.fault = null; }
        assertReport(await call(), { matched: 6, ids: ownIds });
      }
    });

    await t.test('124 actual native lock timeout and stronger-isolation inconsistency return 503 without contacts or zero/stale totals', async () => {
      const blocker = await fixture.connect();
      try {
        await blocker.query('begin');
        await blocker.query('select id from public.growth_operator_requests where id=$1 for update', [assigned.request]);
        assert.equal((await call()).status, 503);
        assert.ok(['55P03', 'P1242'].includes(native.at(-1).code), 'Failure must originate in the locked native reader');
      } finally { try { await blocker.query('rollback'); } finally { await blocker.end(); } }
      assertReport(await call(), { matched: 6, ids: ownIds });
      controls.isolation = true;
      try {
        assert.equal((await call()).status, 503);
        assert.equal(native.at(-1).code, 'P1242');
      } finally { controls.isolation = false; }
      assertReport(await call(), { matched: 6, ids: ownIds });
    });

    await t.test('124 committed nonfinite lead date makes the actual native report unavailable rather than partial or stale', async () => {
      const lead = assigned.leads[0];
      const saved = (await one(db, 'select created_at::text value from public.leads where id=$1', [lead])).value;
      try {
        await db.query("update public.leads set created_at='infinity' where id=$1", [lead]);
        assert.equal((await call()).status, 503);
        assert.equal(native.at(-1).code, 'P1242');
      } finally { await db.query('update public.leads set created_at=$2::timestamptz where id=$1', [lead, saved]); }
      assertReport(await call(), { matched: 6, ids: ownIds });
    });

    await t.test('124 profile revoked while actual HTTP waits after Auth but before native RPC returns 403, never old contacts', async () => {
      const before = native.length;
      controls.hold = true;
      const pending = call();
      try {
        await until(() => controls.release);
        assert.equal(native.length, before);
        assert.deepEqual(calls.at(-1), expectedArgs());
        assert.equal(f.state.auth.at(-1), 'Bearer owned.search.signature');
        await db.query("update public.growth_operator_profiles set status='suspended',accepting_requests=false where id=$1", [x.profile]);
        release();
        assert.equal((await pending).status, 403);
        assert.equal(native.length, before + 1);
        assert.equal(native.at(-1).code, 'P1241');
      } finally {
        release();
        try { await pending; } finally {
          await db.query("update public.growth_operator_profiles set status='approved',accepting_requests=true where id=$1", [x.profile]);
        }
      }
      assertReport(await call(), { matched: 6, ids: ownIds });
    });

    await t.test('124 native HTTP reads and refusal cases leave all financial tables unchanged', async () => {
      assert.deepEqual(await financialSnapshot(db), financialBefore);
    });
  } finally {
    release();
    f?.close();
    try { if (server) await server.close(); } finally {
      try { if (other) await cleanupOperatorWorkday(db, other); } finally {
        if (x) await cleanupOperatorWorkday(db, x);
      }
    }
    if (f) { assert.deepEqual(f.state.unexpected, []); assert.deepEqual(f.state.challenges, []); }
    if (server) assert.deepEqual(server.state.errors, []);
    assert.deepEqual(await financialSnapshot(db), financialBefore);
  }
}
