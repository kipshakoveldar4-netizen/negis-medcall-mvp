import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Script } from 'node:vm';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const migrations = new URL('../../migrations/', import.meta.url);
const table = 'public.platform_subscription_operations';
const signatures = [
  'public.apply_platform_subscription_operation(uuid,uuid,uuid,text,jsonb)',
  'public.read_platform_subscription_operation(uuid,uuid,uuid)',
  'public.abandon_platform_subscription_operation(uuid,uuid,uuid)',
];
const helperSignature = 'public.platform_subscription_operation_receipt(public.platform_subscription_operations,boolean)';
const applySql = 'select public.apply_platform_subscription_operation($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb) as receipt';
const readSql = 'select public.read_platform_subscription_operation($1::uuid,$2::uuid,$3::uuid) as receipt';
const abandonSql = 'select public.abandon_platform_subscription_operation($1::uuid,$2::uuid,$3::uuid) as receipt';
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
const identity = operation => [operation.actor, operation.request, operation.workspace];
const intent = (workspace, kind, payload, actor = randomUUID(), request = randomUUID()) => ({ workspace, kind, payload, actor, request });
const replacement = (expectedActiveId = null, changes = {}) => ({
  expectedActiveId, plan: 'basic', priceMinor: 0, currency: 'KZT', billingPeriod: 'monthly',
  note: 'Synthetic manual administrative assignment', ...changes,
});
const transition = (item, status, changes = {}) => ({
  subscriptionId: item.id, expectedUpdatedAt: item.updated_at, expectedStatus: item.status, status, ...changes,
});
const apply = async (client, operation) => (await client.query(applySql,
  [...identity(operation), operation.kind, JSON.stringify(operation.payload)])).rows[0].receipt;
const read = async (client, operation) => (await client.query(readSql, identity(operation))).rows[0].receipt;
const abandon = async (client, operation) => (await client.query(abandonSql, identity(operation))).rows[0].receipt;
const legacyReplace = async (client, workspace, plan = 'basic') => (await client.query(
  "select public.replace_platform_subscription($1,$2,0,'KZT','monthly','Synthetic legacy manual assignment') as item",
  [workspace, plan])).rows[0].item;

function committed(receipt, operation, replayed = false) {
  assert.deepEqual(receipt, {
    requestKey: operation.request, workspaceId: operation.workspace, actorId: operation.actor,
    kind: operation.kind, state: 'committed', replayed, item: receipt.item,
  });
  assert.equal(receipt.item.workspace_id, operation.workspace);
  assert.equal(receipt.item.price_minor, 0);
  assert.equal(receipt.item.currency, 'KZT');
  assert.ok(receipt.item.id);
  assert.ok(receipt.item.updated_at);
  return receipt;
}

function abandoned(receipt, operation, replayed = false) {
  assert.deepEqual(receipt, {
    requestKey: operation.request, workspaceId: operation.workspace, actorId: operation.actor,
    kind: null, state: 'abandoned', replayed, item: null,
  });
  return receipt;
}

async function waitForLock(observer, waiter, holder) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const { blockers } = (await observer.query('select pg_blocking_pids($1) as blockers', [waiter])).rows[0];
    if (blockers.includes(holder)) return;
    await delay(15);
  }
  assert.fail(`Expected PostgreSQL backend ${waiter} to wait for backend ${holder}`);
}

// All commercial-looking fields are synthetic 0 KZT. These are manual owner
// operations, not payment/provider confirmation or proof of paid entitlement.
test('manual subscription operation receipts on owned disposable PostgreSQL', { timeout: 360000 }, async t => {
  const fixture = await startDisposablePostgres();
  try {
    const db = await fixture.connect();
    await db.query(`create role anon; create role authenticated; create role service_role bypassrls;
      create role subscription_public_probe;
      grant usage on schema public to anon,authenticated,service_role,subscription_public_probe;`);
    for (const name of ['009_medcall_mvp_persistence.sql', '034_platform_subscriptions.sql',
      '067_atomic_platform_subscription.sql', '084_platform_subscription_operations.sql']) {
      await db.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    const connectService = async () => {
      const client = await fixture.connect();
      await client.query('set role service_role');
      return client;
    };
    const service = await connectService();
    const workspace = async () => {
      const id = randomUUID();
      await db.query("insert into public.workspaces(id,name) values($1,'Synthetic manual operation fixture')", [id]);
      return id;
    };
    const subscriptions = async id => (await db.query(
      'select to_jsonb(s) as item from public.platform_subscriptions s where workspace_id=$1 order by id', [id])).rows.map(row => row.item);
    const operationRows = async id => (await db.query(`select to_jsonb(o) as item from ${table} o
      where workspace_id=$1 order by actor_auth_user_id,request_id`, [id])).rows.map(row => row.item);
    const snapshot = async () => (await db.query(`select
      (select coalesce(jsonb_agg(to_jsonb(s) order by id),'[]'::jsonb) from public.platform_subscriptions s) as subscriptions,
      (select coalesce(jsonb_agg(to_jsonb(o) order by actor_auth_user_id,request_id),'[]'::jsonb) from ${table} o) as operations,
      (select coalesce(jsonb_agg(to_jsonb(w) order by id),'[]'::jsonb) from public.workspaces w) as workspaces`)).rows[0];
    const unchangedError = async (action, code) => {
      const before = await snapshot();
      const result = await observe(action());
      assert.equal(result.error?.code, code, result.error?.message || 'Expected rejection, received a successful result');
      assert.deepEqual(await snapshot(), before, 'rejection must not leave domain writes or a reserved request key');
    };
    const peers = async body => {
      const clients = [];
      const pids = [];
      try {
        for (let i = 0; i < 3; i++) {
          const client = await connectService();
          clients.push(client);
          pids.push((await client.query('select pg_backend_pid() as pid')).rows[0].pid);
        }
        await body(clients, pids);
      } finally {
        // An assertion failure must not leave a waiter preventing peer cleanup.
        if (pids.length) await db.query(`select pg_cancel_backend(pid) from pg_stat_activity
          where pid=any($1::int[]) and state='active'`, [pids]);
        for (const client of clients) {
          await client.query('rollback');
          await client.end();
        }
      }
    };

    await t.test('RLS and grants expose only the three service RPCs, never the operation table or receipt helper', async () => {
      const operation = intent(await workspace(), 'replace', replacement());
      const catalog = (await db.query(`select c.relrowsecurity as rls,
        (select count(*)::int from pg_policy where polrelid=c.oid) as policies,
        exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) where grantee=0) as public_grant
        from pg_class c where c.oid=$1::regclass`, [table])).rows[0];
      assert.deepEqual(catalog, { rls: true, policies: 0, public_grant: false });
      for (const signature of [...signatures, helperSignature]) {
        const metadata = (await db.query(`select p.prosecdef as definer,p.proconfig as config,p.provolatile as volatility,
          p.prorettype='jsonb'::regtype as jsonb,
          exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee=0 and privilege_type='EXECUTE') as public_execute
          from pg_proc p where p.oid=$1::regprocedure`, [signature])).rows[0];
        assert.ok(metadata, signature);
        assert.equal(metadata.jsonb, true, signature);
        assert.deepEqual(metadata.config, ['search_path=""'], signature);
        assert.equal(metadata.public_execute, false, signature);
        if (signature === helperSignature) assert.equal(metadata.volatility, 'i', 'receipt helper must be IMMUTABLE');
        else assert.equal(metadata.definer, true, signature);
        for (const role of ['anon', 'authenticated', 'subscription_public_probe', 'service_role']) {
          assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows[0].allowed,
            role === 'service_role' && signature !== helperSignature, `${role}: ${signature}`);
        }
      }
      for (const role of ['anon', 'authenticated', 'subscription_public_probe', 'service_role']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          assert.equal((await db.query('select has_table_privilege($1,$2,$3) as allowed', [role, table, privilege])).rows[0].allowed,
            false, `${role} must not have ${privilege} on the private operation table`);
        }
        const client = await fixture.connect();
        try {
          await client.query(`set role ${role}`);
          const denied = [
            () => client.query(`select * from ${table}`),
            () => client.query(`insert into ${table}(actor_auth_user_id,request_id,workspace_id,state) values($1,$2,$3,'abandoned')`, identity(operation)),
            () => client.query(`update ${table} set state='abandoned' where false`),
            () => client.query(`delete from ${table} where false`),
            () => client.query('select public.platform_subscription_operation_receipt(null::public.platform_subscription_operations,true)'),
          ];
          if (role !== 'service_role') denied.push(() => apply(client, operation), () => read(client, operation), () => abandon(client, operation));
          for (const action of denied) await unchangedError(action, '42501');
        } finally { await client.end(); }
      }
      assert.equal(await read(service, operation), null);
      committed(await apply(service, operation), operation);
    });

    await t.test('read is non-mutating and a miss does not reserve identity or prevent a later apply', async () => {
      const operation = intent(await workspace(), 'replace', replacement());
      const before = await snapshot();
      await service.query('begin read only');
      try {
        assert.equal(await read(service, operation), null);
        assert.equal(await read(service, operation), null);
      } finally { await service.query('rollback'); }
      assert.deepEqual(await snapshot(), before);
      const saved = committed(await apply(service, operation), operation);
      await service.query('begin read only');
      try { assert.deepEqual(await read(service, operation), { ...saved, replayed: true }); }
      finally { await service.query('rollback'); }
    });

    await t.test('operation CHECK rejects inconsistent SQL NULL fields as well as JSON null fields', async () => {
      const id = await workspace();
      const pending = { state: 'pending', kind: 'replace', payload: JSON.stringify(replacement()), result: null };
      const saved = { ...pending, state: 'committed', result: JSON.stringify({ synthetic: true }) };
      const cases = [
        { label: 'valid pending', row: pending, code: null },
        { label: 'valid committed', row: saved, code: null },
        { label: 'valid abandoned', row: { state: 'abandoned', kind: null, payload: null, result: null }, code: null },
        { label: 'pending SQL NULL kind', row: { ...pending, kind: null } },
        { label: 'pending SQL NULL payload', row: { ...pending, payload: null } },
        { label: 'pending SQL NULL kind and payload', row: { ...pending, kind: null, payload: null } },
        { label: 'committed SQL NULL kind', row: { ...saved, kind: null } },
        { label: 'committed SQL NULL payload', row: { ...saved, payload: null } },
        { label: 'committed SQL NULL result', row: { ...saved, result: null } },
        { label: 'committed SQL NULL kind, payload and result', row: { ...saved, kind: null, payload: null, result: null } },
        { label: 'pending JSON null payload', row: { ...pending, payload: 'null' } },
        { label: 'committed JSON null payload', row: { ...saved, payload: 'null' } },
        { label: 'committed JSON null result', row: { ...saved, result: 'null' } },
        { label: 'pending non-null result', row: { ...pending, result: '{}' } },
        { label: 'abandoned non-null kind', row: { state: 'abandoned', kind: 'replace', payload: null, result: null } },
        { label: 'abandoned JSON null payload', row: { state: 'abandoned', kind: null, payload: 'null', result: null } },
        { label: 'abandoned JSON null result', row: { state: 'abandoned', kind: null, payload: null, result: 'null' } },
      ];
      const before = await snapshot();
      const actual = [];
      await db.query('begin');
      try {
        for (const { label, row } of cases) {
          await db.query('savepoint synthetic_operation_check');
          const inserted = await observe(db.query(`insert into ${table}
            (actor_auth_user_id,request_id,workspace_id,kind,payload,state,result)
            values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
          [randomUUID(), randomUUID(), id, row.kind, row.payload, row.state, row.result]));
          actual.push({ label, code: inserted.error?.code ?? null });
          await db.query('rollback to savepoint synthetic_operation_check');
          await db.query('release savepoint synthetic_operation_check');
        }
      } finally { await db.query('rollback'); }
      assert.deepEqual(await snapshot(), before, 'constraint probes must leave no malformed records');
      assert.deepEqual(actual, cases.map(({ label, code = '23514' }) => ({ label, code })),
        'CHECK must reject SQL NULL holes, not only JSON null values');
    });

    await t.test('actor plus request key identifies intent; JSON key order replays but changed payload, kind or workspace conflicts', async () => {
      const firstWorkspace = await workspace(), secondWorkspace = await workspace();
      const operation = intent(firstWorkspace, 'replace', replacement());
      const saved = committed(await apply(service, operation), operation);
      assert.equal(saved.item.status, 'active');
      assert.deepEqual(await subscriptions(firstWorkspace), [saved.item]);
      const reordered = Object.fromEntries(Object.entries(operation.payload).reverse());
      const beforeReplay = await snapshot();
      assert.deepEqual(await apply(service, { ...operation, payload: reordered }), { ...saved, replayed: true });
      assert.deepEqual(await snapshot(), beforeReplay);
      for (const changes of [{ plan: 'pro' }, { note: null }, { billingPeriod: 'yearly' }, { expectedActiveId: saved.item.id }]) {
        await unchangedError(() => apply(service, { ...operation, payload: { ...operation.payload, ...changes } }), 'P8407');
      }
      await unchangedError(() => apply(service, { ...operation, workspace: secondWorkspace }), 'P8407');
      await unchangedError(() => apply(service, { ...operation, kind: 'status', payload: transition(saved.item, 'paused') }), 'P8407');
      assert.equal(await read(service, { ...operation, actor: randomUUID() }), null);
      assert.equal(await read(service, { ...operation, workspace: secondWorkspace }), null);
      await unchangedError(() => abandon(service, { ...operation, workspace: secondWorkspace }), 'P8407');
      const otherActor = { ...operation, actor: randomUUID(), workspace: secondWorkspace };
      const otherSaved = committed(await apply(service, otherActor), otherActor);
      assert.notEqual(otherSaved.item.id, saved.item.id);
      assert.deepEqual(await read(service, operation), { ...saved, replayed: true });
      assert.deepEqual(await read(service, otherActor), { ...otherSaved, replayed: true });
    });

    await t.test('saved acknowledgements remain immutable after later status changes, cancellation and replacement', async () => {
      const id = await workspace();
      const first = intent(id, 'replace', replacement());
      const initial = committed(await apply(service, first), first);
      const pause = intent(id, 'status', transition(initial.item, 'paused'));
      const paused = committed(await apply(service, pause), pause);
      const next = intent(id, 'replace', replacement(null, { plan: 'standard' }));
      const current = committed(await apply(service, next), next);
      const cancel = intent(id, 'status', transition(paused.item, 'cancelled'));
      const cancelled = committed(await apply(service, cancel), cancel);
      assert.equal(cancelled.item.id, initial.item.id, 'a paused historical row is an exact target');
      assert.ok(cancelled.item.ended_at);
      const before = await snapshot();
      for (const [operation, saved] of [[first, initial], [pause, paused], [cancel, cancelled], [next, current]]) {
        assert.deepEqual(await read(service, operation), { ...saved, replayed: true });
        assert.deepEqual(await apply(service, operation), { ...saved, replayed: true });
        assert.deepEqual(await abandon(service, operation), { ...saved, replayed: true });
      }
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual((await subscriptions(id)).filter(row => row.status === 'active'), [current.item]);
      assert.equal(initial.item.status, 'active');
      assert.equal(paused.item.status, 'paused');
    });

    await t.test('status compares exact workspace, id, status and microsecond version; cancelled rows are terminal and no-ops still compare', async () => {
      const id = await workspace(), foreignWorkspace = await workspace();
      const active = await legacyReplace(service, id);
      const foreign = await legacyReplace(service, foreignWorkspace);
      await db.query("update public.platform_subscriptions set updated_at='2026-01-02T03:04:05.123456Z' where id=$1", [active.id]);
      const exact = (await subscriptions(id))[0];
      assert.match(exact.updated_at, /123456/);
      const base = intent(id, 'status', transition(exact, 'paused'));
      for (const changes of [
        { subscriptionId: randomUUID() }, { subscriptionId: foreign.id, expectedUpdatedAt: foreign.updated_at },
        { expectedStatus: 'paused' }, { expectedUpdatedAt: '2026-01-02T03:04:05.123455Z' },
        { expectedUpdatedAt: '2026-01-02T03:04:05.123Z' },
      ]) {
        const operation = { ...base, request: randomUUID(), payload: { ...base.payload, ...changes } };
        await unchangedError(() => apply(service, operation), 'P8404');
        assert.equal(await read(service, operation), null);
      }
      const noop = intent(id, 'status', transition(exact, 'active'));
      assert.deepEqual(committed(await apply(service, noop), noop).item, exact);
      const paused = committed(await apply(service, base), base).item;
      assert.equal(paused.id, active.id);
      assert.equal(paused.status, 'paused');
      assert.notEqual(paused.updated_at, exact.updated_at);
      assert.equal(paused.ended_at, null);
      const staleNoop = intent(id, 'status', transition(exact, 'paused'));
      await unchangedError(() => apply(service, staleNoop), 'P8404');
      const pausedNoop = intent(id, 'status', transition(paused, 'paused'));
      assert.deepEqual(committed(await apply(service, pausedNoop), pausedNoop).item, paused);
      const resume = intent(id, 'status', transition(paused, 'active'));
      const resumed = committed(await apply(service, resume), resume).item;
      assert.equal(resumed.id, active.id);
      assert.equal(resumed.status, 'active');
      assert.equal(resumed.ended_at, null);
      const cancel = intent(id, 'status', transition(resumed, 'cancelled'));
      const cancelled = committed(await apply(service, cancel), cancel).item;
      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.ended_at);
      for (const status of ['active', 'paused']) {
        const operation = intent(id, 'status', transition(cancelled, status));
        await unchangedError(() => apply(service, operation), 'P8404');
      }
      const cancelledNoop = intent(id, 'status', transition(cancelled, 'cancelled'));
      assert.deepEqual(committed(await apply(service, cancelledNoop), cancelledNoop).item, cancelled);
      assert.deepEqual(await subscriptions(foreignWorkspace), [foreign]);
    });

    await t.test('paused history can be targeted but cannot resume over a different active row', async () => {
      const id = await workspace();
      const old = await legacyReplace(service, id);
      const pause = intent(id, 'status', transition(old, 'paused'));
      const paused = committed(await apply(service, pause), pause).item;
      const replace = intent(id, 'replace', replacement(null, { plan: 'pro', billingPeriod: 'yearly', note: null }));
      const current = committed(await apply(service, replace), replace).item;
      assert.equal(current.note, null);
      assert.equal(current.billing_period, 'yearly');
      const resumeOld = intent(id, 'status', transition(paused, 'active'));
      await unchangedError(() => apply(service, resumeOld), 'P8404');
      const cancel = intent(id, 'status', transition(paused, 'cancelled'));
      const cancelled = committed(await apply(service, cancel), cancel).item;
      assert.equal(cancelled.id, old.id);
      assert.deepEqual((await subscriptions(id)).find(row => row.id === current.id), current);
      const staleNull = intent(id, 'replace', replacement(null));
      await unchangedError(() => apply(service, staleNull), 'P8404');
      const staleId = intent(id, 'replace', replacement(old.id));
      await unchangedError(() => apply(service, staleId), 'P8404');
      const fresh = { ...staleId, payload: replacement(current.id) };
      committed(await apply(service, fresh), fresh);
    });

    await t.test('strict new-operation payloads and missing workspaces reject without writes', async () => {
      const id = await workspace();
      const item = await legacyReplace(service, id);
      const valid = replacement(item.id);
      const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
      const replacements = [null, [], 'replace', ...['expectedActiveId', 'plan', 'priceMinor', 'currency', 'billingPeriod'].map(key => without(valid, key)),
        ...[
          { expectedActiveId: true }, { expectedActiveId: 'not-a-uuid' }, { plan: 'unknown' },
          { priceMinor: -1 }, { priceMinor: 0.5 }, { priceMinor: '0' }, { priceMinor: null },
          { priceMinor: 9007199254740992 }, { currency: 'kzt' }, { currency: null },
          { billingPeriod: 'weekly' }, { note: {} }, { note: 'x'.repeat(2001) }, { extra: true },
        ].map(changes => ({ ...valid, ...changes }))];
      const status = transition(item, 'paused');
      const statuses = [null, [], ...Object.keys(status).map(key => without(status, key)),
        ...[
          { subscriptionId: 'not-a-uuid' }, { subscriptionId: null }, { expectedStatus: 'unknown' },
          { status: 'unknown' }, { expectedUpdatedAt: '2026-01-02T03:04:05' },
          { expectedUpdatedAt: '2026-13-40T03:04:05Z' }, { expectedUpdatedAt: 0 }, { extra: true },
        ].map(changes => ({ ...status, ...changes }))];
      for (const [kind, payloads] of [['replace', replacements], ['status', statuses]]) {
        for (const payload of payloads) {
          const operation = intent(id, kind, payload);
          await unchangedError(() => apply(service, operation), 'P8403');
        }
      }
      for (const kind of [null, 'checkout', 'payment', 'REPLACE']) {
        await unchangedError(() => apply(service, intent(id, kind, valid)), 'P8403');
      }
      const operation = intent(id, 'replace', valid);
      for (const field of ['actor', 'request', 'workspace']) {
        const invalid = { ...operation, [field]: null };
        for (const call of [apply, read, abandon]) await unchangedError(() => call(service, invalid), 'P8403');
      }
      const missing = intent(randomUUID(), 'replace', replacement());
      assert.equal(await read(service, missing), null);
      await unchangedError(() => apply(service, missing), 'P8402');
      await unchangedError(() => abandon(service, missing), 'P8402');
    });

    await t.test('invalid price JSON types return P8403 instead of leaking cast errors', async () => {
      const id = await workspace();
      for (const priceMinor of [null, true, false, {}, [], '', 'not-a-number', '0', '9'.repeat(2000)]) {
        const operation = intent(id, 'replace', replacement(null, { priceMinor }));
        await unchangedError(() => apply(service, operation), 'P8403');
        assert.equal(await read(service, operation), null);
      }
    });

    await t.test('unsafe and bigint-overflow numeric prices return P8403 without domain writes or receipts', async () => {
      const id = await workspace();
      // Keep exact JSON numeric tokens beyond JavaScript's safe integer range.
      const prices = ['9007199254740992', '9223372036854775807', '9223372036854775808',
        '-9223372036854775809', '1e1000', '9'.repeat(2000)];
      for (const price of prices) {
        const operation = intent(id, 'replace', replacement());
        await unchangedError(() => service.query(`select public.apply_platform_subscription_operation(
          $1::uuid,$2::uuid,$3::uuid,$4::text,jsonb_set($5::jsonb,'{priceMinor}',$6::jsonb)) as receipt`,
        [...identity(operation), operation.kind, JSON.stringify(operation.payload), price]), 'P8403');
        assert.equal(await read(service, operation), null);
      }
    });

    await t.test('actual subscription API handler accepts real SQL receipts for apply, replay, recovery, status and abandon', async () => {
      const id = await workspace(), actor = randomUUID();
      const ts = createRequire(new URL('../../package.json', import.meta.url))('typescript');
      const evaluate = async (file, resolve) => {
        const compiled = ts.transpileModule(await readFile(new URL(`../../${file}`, import.meta.url), 'utf8'), {
          fileName: file, reportDiagnostics: true,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        });
        assert.deepEqual(compiled.diagnostics ?? [], [], `Cannot compile actual ${file}`);
        const exports = {};
        new Script(compiled.outputText, { filename: file }).runInNewContext({
          exports, require: resolve, Date, Error, URL, Buffer, process: { env: {} },
          fetch() { assert.fail('No external HTTP in the real-handler receipt bridge'); },
        });
        return exports;
      };
      // Use the real trusted owner carrier; router/network authentication is not
      // part of this bounded handler-to-PostgreSQL receipt compatibility test.
      const owner = await evaluate('lib/auth/platform.ts', name => {
        assert.equal(name, './server');
        return { requireAuthenticatedUser() { assert.fail('No network authentication in this fixture'); } };
      });
      const calls = [];
      const sdk = {
        from() { assert.fail('Receipt operations must never fall back to direct table access'); },
        async rpc(name, args) {
          const call = {
            apply_platform_subscription_operation: apply,
            read_platform_subscription_operation: read,
            abandon_platform_subscription_operation: abandon,
          }[name];
          assert.ok(call, `Unexpected RPC ${name}`);
          assert.equal(args.p_actor_auth_user_id, actor, 'actor comes from the trusted carrier, not the request body');
          calls.push(name);
          const result = await observe(call(service, intent(args.p_workspace_id, args.p_kind, args.p_payload,
            args.p_actor_auth_user_id, args.p_request_id)));
          return { data: result.value ?? null, error: result.error ?? null };
        },
      };
      const platform = await evaluate('lib/crm/platform.ts', name => {
        if (name === '../auth/platform') return owner;
        if (name === '../supabase/server') return { getSupabaseServerClient: () => sdk };
        assert.ok(['./clinic-signals', './staff-invitations', '../vertical/terms', '../content-studio/usage'].includes(name), name);
        return new Proxy({}, { get() { assert.fail(`Unexpected handler dependency ${name}`); } });
      });
      const invoke = async (method, operation, changes = {}) => {
        const req = { method, query: { workspaceId: id, requestKey: operation.request },
          body: { workspaceId: id, requestKey: operation.request, ...operation.payload, actorId: randomUUID(), ...changes } };
        owner.attachPlatformOwner(req, { userId: actor, email: 'synthetic-owner@example.invalid' });
        let status, body, sends = 0;
        const headers = {};
        const res = {
          setHeader(name, value) { headers[name.toLowerCase()] = value; },
          status(value) { status = value; return res; },
          json(value) { sends++; body = JSON.parse(JSON.stringify(value)); },
        };
        await platform.handlePlatformSubscriptions(req, res);
        assert.equal(sends, 1);
        assert.equal(headers['cache-control'], 'private, no-store');
        return { status, body };
      };
      const receiptResponse = (response, receipt, status = 200) => {
        const { item, ...operation } = receipt;
        assert.deepEqual(response, { status, body: { success: true, data: { item, operation } } });
      };
      const failureResponse = (response, code) => {
        assert.equal(response.status, 409, JSON.stringify(response.body));
        assert.equal(response.body.success, false);
        assert.equal(response.body.code, code);
        assert.deepEqual(Object.keys(response.body).sort(), ['code', 'error', 'success']);
      };
      const first = intent(id, 'replace', replacement(), actor);
      assert.deepEqual(await invoke('GET', first), { status: 200, body: { success: true, data: { item: null, operation: null } } });
      const created = await invoke('POST', first);
      const original = await read(service, first);
      committed(original, first, true);
      receiptResponse(created, { ...original, replayed: false }, 201);
      receiptResponse(await invoke('POST', first), original, 201);
      const pause = intent(id, 'status', transition(original.item, 'paused'), actor);
      const patched = await invoke('PATCH', pause);
      const paused = await read(service, pause);
      committed(paused, pause, true);
      receiptResponse(patched, { ...paused, replayed: false });
      receiptResponse(await invoke('GET', first), original);
      failureResponse(await invoke('POST', first, { plan: 'pro' }), 'subscription_request_conflict');
      failureResponse(await invoke('PATCH', { ...pause, request: randomUUID() }), 'subscription_conflict');
      const closed = intent(id, 'replace', replacement(), actor);
      const abandonedResponse = await invoke('POST', closed, { abandon: true });
      const tombstone = await read(service, closed);
      abandoned(tombstone, closed, true);
      receiptResponse(abandonedResponse, { ...tombstone, replayed: false });
      receiptResponse(await invoke('GET', closed), tombstone);
      failureResponse(await invoke('POST', closed), 'subscription_request_abandoned');
      receiptResponse(await invoke('POST', first, { abandon: true }), original);
      assert.deepEqual(await subscriptions(id), [paused.item]);
      assert.ok(signatures.every(signature => calls.includes(signature.split('(')[0].slice('public.'.length))));
    });

    await t.test('two absent reads and concurrent identical requests produce one immutable result; other workspaces remain independent', async () => {
      const id = await workspace(), independent = await workspace();
      const operation = intent(id, 'replace', replacement());
      await peers(async ([a, b, c], [aPid, bPid]) => {
        await a.query('begin');
        await b.query('begin');
        assert.equal(await read(a, operation), null);
        assert.equal(await read(b, operation), null);
        const saved = committed(await apply(a, operation), operation);
        const waiting = observe(apply(b, operation));
        await waitForLock(db, bPid, aPid);
        assert.deepEqual(await subscriptions(id), []);
        assert.deepEqual(await operationRows(id), [], 'uncommitted pending and result records are private to the transaction');
        await c.query('begin read only');
        await c.query("set local statement_timeout='1000ms'");
        assert.equal(await read(c, operation), null, 'read intentionally does not lock or prove non-execution');
        await c.query('commit');
        const unrelated = intent(independent, 'replace', replacement());
        committed(await apply(c, unrelated), unrelated);
        await a.query('commit');
        const replay = await waiting;
        assert.ifError(replay.error);
        assert.deepEqual(replay.value, { ...saved, replayed: true });
        await b.query('commit');
        assert.deepEqual(await subscriptions(id), [saved.item]);
        assert.equal((await operationRows(id)).length, 1);
      });
    });

    for (const conflict of ['payload', 'kind', 'workspace']) {
      await t.test(`concurrent same-key changed ${conflict} waits for the winner then returns P8407`, async () => {
        const id = await workspace(), other = await workspace();
        const operation = intent(id, 'replace', replacement());
        await peers(async ([a, b], [aPid, bPid]) => {
          await a.query('begin');
          await b.query('begin');
          const saved = committed(await apply(a, operation), operation);
          const changed = conflict === 'payload' ? { ...operation, payload: replacement(null, { plan: 'pro' }) }
            : conflict === 'kind' ? { ...operation, kind: 'status', payload: transition(saved.item, 'paused') }
              : { ...operation, workspace: other };
          const waiting = observe(apply(b, changed));
          await waitForLock(db, bPid, aPid);
          await a.query('commit');
          assert.equal((await waiting).error?.code, 'P8407');
          await b.query('rollback');
          assert.deepEqual(await subscriptions(id), [saved.item]);
          assert.deepEqual(await subscriptions(other), []);
          assert.equal((await operationRows(id)).length, 1);
          assert.deepEqual(await operationRows(other), []);
        });
      });
    }

    await t.test('different request keys replacing the same expected row serialize and the loser leaves no receipt', async () => {
      const id = await workspace();
      const prior = await legacyReplace(service, id);
      const first = intent(id, 'replace', replacement(prior.id));
      const second = intent(id, 'replace', replacement(prior.id, { plan: 'standard' }));
      await peers(async ([a, b], [aPid, bPid]) => {
        await a.query('begin');
        await b.query('begin');
        const winner = committed(await apply(a, first), first);
        const waiting = observe(apply(b, second));
        await waitForLock(db, bPid, aPid);
        await a.query('commit');
        assert.equal((await waiting).error?.code, 'P8404');
        await b.query('rollback');
        assert.equal(await read(service, second), null);
        assert.equal((await operationRows(id)).length, 1);
        assert.deepEqual((await subscriptions(id)).filter(row => row.status === 'active'), [winner.item]);
        const corrected = { ...second, payload: replacement(winner.item.id, { plan: 'standard' }) };
        committed(await apply(service, corrected), corrected);
      });
    });

    await t.test('067 winning the workspace lock invalidates a queued replacement expectation', async () => {
      const id = await workspace();
      const prior = await legacyReplace(service, id);
      const operation = intent(id, 'replace', replacement(prior.id));
      await peers(async ([a, b], [aPid, bPid]) => {
        await a.query('begin');
        const legacy = await legacyReplace(a, id, 'standard');
        const waiting = observe(apply(b, operation));
        await waitForLock(db, bPid, aPid);
        assert.deepEqual((await subscriptions(id)).filter(row => row.status === 'active'), [prior]);
        await a.query('commit');
        assert.equal((await waiting).error?.code, 'P8404');
        assert.equal(await read(service, operation), null);
        assert.deepEqual((await subscriptions(id)).filter(row => row.status === 'active'), [legacy]);
        assert.deepEqual(await operationRows(id), []);
      });
    });

    await t.test('operation winning the workspace lock makes 067 wait without rewriting the saved acknowledgement', async () => {
      const id = await workspace();
      const operation = intent(id, 'replace', replacement());
      await peers(async ([a, b], [aPid, bPid]) => {
        await a.query('begin');
        const saved = committed(await apply(a, operation), operation);
        const waiting = observe(legacyReplace(b, id, 'pro'));
        await waitForLock(db, bPid, aPid);
        await a.query('commit');
        const legacy = await waiting;
        assert.ifError(legacy.error);
        const rows = await subscriptions(id);
        assert.equal(rows.find(row => row.id === saved.item.id).status, 'cancelled');
        assert.deepEqual(rows.filter(row => row.status === 'active'), [legacy.value]);
        assert.deepEqual(await read(service, operation), { ...saved, replayed: true });
        assert.deepEqual(await apply(service, operation), { ...saved, replayed: true });
      });
    });

    await t.test('status resume shares the 067 workspace lock and rechecks for a different active row', async () => {
      const id = await workspace();
      const initial = await legacyReplace(service, id);
      const pause = intent(id, 'status', transition(initial, 'paused'));
      const paused = committed(await apply(service, pause), pause).item;
      const resume = intent(id, 'status', transition(paused, 'active'));
      await peers(async ([a, b], [aPid, bPid]) => {
        await a.query('begin');
        const legacy = await legacyReplace(a, id, 'pro');
        const waiting = observe(apply(b, resume));
        await waitForLock(db, bPid, aPid);
        await a.query('commit');
        assert.equal((await waiting).error?.code, 'P8404');
        assert.equal(await read(service, resume), null);
        const rows = await subscriptions(id);
        assert.deepEqual(rows.find(row => row.id === paused.id), paused);
        assert.deepEqual(rows.filter(row => row.status === 'active'), [legacy]);
      });
    });

    await t.test('same-version concurrent status writes serialize; the stale loser cannot overwrite the winner', async () => {
      const id = await workspace();
      const initial = await legacyReplace(service, id);
      const pause = intent(id, 'status', transition(initial, 'paused'));
      const cancel = intent(id, 'status', transition(initial, 'cancelled'));
      await peers(async ([a, b], [aPid, bPid]) => {
        await a.query('begin');
        const saved = committed(await apply(a, pause), pause);
        const waiting = observe(apply(b, cancel));
        await waitForLock(db, bPid, aPid);
        await a.query('commit');
        assert.equal((await waiting).error?.code, 'P8404');
        assert.deepEqual(await subscriptions(id), [saved.item]);
        assert.equal(await read(service, cancel), null);
      });
    });

    await t.test('a rolled-back apply leaves no receipt and an identical waiting request executes exactly once', async () => {
      const id = await workspace();
      const prior = await legacyReplace(service, id);
      const operation = intent(id, 'replace', replacement(prior.id));
      await peers(async ([a, b], [aPid, bPid]) => {
        const before = await snapshot();
        await a.query('begin');
        const rolledBack = committed(await apply(a, operation), operation);
        const waiting = observe(apply(b, operation));
        await waitForLock(db, bPid, aPid);
        assert.deepEqual(await snapshot(), before);
        await a.query('rollback');
        const result = await waiting;
        assert.ifError(result.error);
        const saved = committed(result.value, operation);
        assert.notEqual(saved.item.id, rolledBack.item.id);
        const rows = await subscriptions(id);
        assert.equal(rows.length, 2);
        assert.equal(rows.find(row => row.id === prior.id).status, 'cancelled');
        assert.deepEqual(rows.filter(row => row.status === 'active'), [saved.item]);
        assert.equal((await operationRows(id)).length, 1);
        assert.deepEqual(await read(service, operation), { ...saved, replayed: true });
      });
    });

    await t.test('failure after cancellation rolls back the domain row and pending receipt before a waiter succeeds', async () => {
      const id = await workspace();
      const prior = await legacyReplace(service, id);
      const failing = intent(id, 'replace', replacement(prior.id, { note: 'Synthetic injected domain failure' }));
      const following = intent(id, 'replace', replacement(prior.id, { plan: 'pro' }));
      await db.query(`create function public.synthetic_operation_insert_gate() returns trigger language plpgsql as $$
        begin
          if new.note='Synthetic injected domain failure' then
            perform pg_advisory_xact_lock(840901);
            raise exception using errcode='P9901',message='synthetic_subscription_insert_failure';
          end if;
          return new;
        end; $$;
        create trigger synthetic_operation_insert_gate before insert on public.platform_subscriptions
          for each row execute function public.synthetic_operation_insert_gate();`);
      try {
        await peers(async ([a, b, gate], [aPid, bPid, gatePid]) => {
          const before = await snapshot();
          await gate.query('begin');
          await gate.query('select pg_advisory_xact_lock(840901)');
          await a.query('begin');
          const failure = observe(apply(a, failing));
          await waitForLock(db, aPid, gatePid);
          const waiting = observe(apply(b, following));
          await waitForLock(db, bPid, aPid);
          assert.deepEqual(await snapshot(), before);
          await gate.query('commit');
          assert.equal((await failure).error?.code, 'P9901');
          await a.query('rollback');
          const result = await waiting;
          assert.ifError(result.error);
          const saved = committed(result.value, following);
          assert.equal(await read(service, failing), null);
          assert.deepEqual((await subscriptions(id)).filter(row => row.status === 'active'), [saved.item]);
          assert.equal((await subscriptions(id)).length, 2);
          assert.equal((await operationRows(id)).length, 1);
        });
      } finally {
        await db.query(`drop trigger synthetic_operation_insert_gate on public.platform_subscriptions;
          drop function public.synthetic_operation_insert_gate()`);
      }
      await unchangedError(() => apply(service, failing), 'P8404');
      const current = (await subscriptions(id)).find(row => row.status === 'active');
      const retry = { ...failing, payload: replacement(current.id, { note: failing.payload.note }) };
      committed(await apply(service, retry), retry);
    });

    await t.test('receipt-write failure rolls back a successful replacement and the same key can be retried', async () => {
      const id = await workspace();
      const prior = await legacyReplace(service, id);
      const operation = intent(id, 'replace', replacement(prior.id, { note: 'Synthetic injected receipt failure' }));
      await db.query(`create function public.synthetic_operation_receipt_failure() returns trigger language plpgsql as $$
        begin
          if new.state='committed' and new.payload->>'note'='Synthetic injected receipt failure' then
            raise exception using errcode='P9902',message='synthetic_receipt_write_failure';
          end if;
          return new;
        end; $$;
        create trigger synthetic_operation_receipt_failure before update on ${table}
          for each row execute function public.synthetic_operation_receipt_failure();`);
      try {
        await unchangedError(() => apply(service, operation), 'P9902');
        assert.equal(await read(service, operation), null);
      } finally {
        await db.query(`drop trigger synthetic_operation_receipt_failure on ${table};
          drop function public.synthetic_operation_receipt_failure()`);
      }
      const saved = committed(await apply(service, operation), operation);
      assert.deepEqual((await subscriptions(id)).filter(row => row.status === 'active'), [saved.item]);
      assert.equal((await operationRows(id)).length, 1);
    });

    await t.test('abandon first is durable, idempotent, scoped to actor plus key, and prevents every late apply', async () => {
      const id = await workspace(), other = await workspace();
      const operation = intent(id, 'replace', replacement());
      assert.equal(await read(service, operation), null);
      const saved = abandoned(await abandon(service, operation), operation);
      const before = await snapshot();
      assert.deepEqual(await abandon(service, operation), { ...saved, replayed: true });
      assert.deepEqual(await read(service, operation), { ...saved, replayed: true });
      assert.deepEqual(await snapshot(), before);
      for (const changed of [operation, { ...operation, payload: replacement(null, { plan: 'pro' }) },
        { ...operation, kind: 'status', payload: transition({ id: randomUUID(), updated_at: '2026-01-02T03:04:05.123456Z', status: 'active' }, 'paused') }]) {
        await unchangedError(() => apply(service, changed), 'P8409');
      }
      await unchangedError(() => apply(service, { ...operation, workspace: other }), 'P8407');
      await unchangedError(() => abandon(service, { ...operation, workspace: other }), 'P8407');
      assert.equal(await read(service, { ...operation, workspace: other }), null);
      assert.equal(await read(service, { ...operation, actor: randomUUID() }), null);
      assert.deepEqual(await subscriptions(id), []);
      const independentActor = { ...operation, actor: randomUUID() };
      committed(await apply(service, independentActor), independentActor);
      assert.deepEqual(await read(service, operation), { ...saved, replayed: true });
    });

    await t.test('abandon winning the lock blocks concurrent late apply without a subscription mutation', async () => {
      const id = await workspace();
      const operation = intent(id, 'replace', replacement());
      await peers(async ([a, b], [aPid, bPid]) => {
        await a.query('begin');
        const saved = abandoned(await abandon(a, operation), operation);
        const waiting = observe(apply(b, operation));
        await waitForLock(db, bPid, aPid);
        assert.equal(await read(service, operation), null);
        await a.query('commit');
        assert.equal((await waiting).error?.code, 'P8409');
        assert.deepEqual(await subscriptions(id), []);
        assert.equal((await operationRows(id)).length, 1);
        assert.deepEqual(await read(service, operation), { ...saved, replayed: true });
      });
    });

    await t.test('apply winning the lock makes abandon report the committed receipt, never an undo', async () => {
      const id = await workspace();
      const operation = intent(id, 'replace', replacement());
      await peers(async ([a, b], [aPid, bPid]) => {
        await a.query('begin');
        const saved = committed(await apply(a, operation), operation);
        const waiting = observe(abandon(b, operation));
        await waitForLock(db, bPid, aPid);
        assert.equal(await read(service, operation), null);
        await a.query('commit');
        const result = await waiting;
        assert.ifError(result.error);
        assert.deepEqual(result.value, { ...saved, replayed: true });
        assert.deepEqual(await subscriptions(id), [saved.item]);
        assert.equal((await operationRows(id)).length, 1);
      });
    });

    await t.test('rolling back abandon lets a queued apply execute; rolling back apply lets abandon create a tombstone', async () => {
      for (const first of ['abandon', 'apply']) {
        const id = await workspace();
        const operation = intent(id, 'replace', replacement());
        await peers(async ([a, b], [aPid, bPid]) => {
          const before = await snapshot();
          await a.query('begin');
          await (first === 'abandon' ? abandon(a, operation) : apply(a, operation));
          const waiting = observe(first === 'abandon' ? apply(b, operation) : abandon(b, operation));
          await waitForLock(db, bPid, aPid);
          assert.deepEqual(await snapshot(), before);
          await a.query('rollback');
          const result = await waiting;
          assert.ifError(result.error);
          if (first === 'abandon') {
            committed(result.value, operation);
            assert.deepEqual(await subscriptions(id), [result.value.item]);
          } else {
            abandoned(result.value, operation);
            assert.deepEqual(await subscriptions(id), []);
            await unchangedError(() => apply(service, operation), 'P8409');
          }
          assert.equal((await operationRows(id)).length, 1);
        });
      }
    });

    await t.test('concurrent abandon calls converge on a single tombstone', async () => {
      const id = await workspace();
      const operation = intent(id, 'replace', replacement());
      await peers(async ([a, b], [aPid, bPid]) => {
        await a.query('begin');
        const saved = abandoned(await abandon(a, operation), operation);
        const waiting = observe(abandon(b, operation));
        await waitForLock(db, bPid, aPid);
        await a.query('commit');
        const result = await waiting;
        assert.ifError(result.error);
        assert.deepEqual(result.value, { ...saved, replayed: true });
        assert.equal((await operationRows(id)).length, 1);
        assert.deepEqual(await subscriptions(id), []);
      });
    });

    await t.test('a pre-existing broken pending record fails closed for apply, read and abandon', async () => {
      const id = await workspace();
      const operation = intent(id, 'replace', replacement());
      await db.query(`insert into ${table}(actor_auth_user_id,request_id,workspace_id,kind,payload,state)
        values($1,$2,$3,$4,$5::jsonb,'pending')`, [...identity(operation), operation.kind, JSON.stringify(operation.payload)]);
      for (const call of [apply, read, abandon]) await unchangedError(() => call(service, operation), 'P8408');
      assert.deepEqual(await subscriptions(id), []);
    });

    const records = (await db.query('select to_jsonb(s) as item from public.platform_subscriptions s')).rows.map(row => row.item);
    assert.ok(records.length > 0);
    assert.ok(records.every(row => row.price_minor === 0 && row.currency === 'KZT'), 'only synthetic zero-KZT assignments may be persisted');
    assert.deepEqual((await db.query(`select workspace_id,count(*)::int as n from public.platform_subscriptions
      where status='active' group by workspace_id having count(*)>1`)).rows, []);
    t.diagnostic('Real migrations 009/034/067/084; synthetic manual 0 KZT only; no .env, cloud, payment or provider calls.');
  } finally {
    await fixture.close();
  }
});
