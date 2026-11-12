import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const foundation = await readFile(new URL('../../migrations/021_meta_campaign_insights_foundation.sql', import.meta.url), 'utf8');
const access = await readFile(new URL('../../migrations/079_meta_insights_server_access.sql', import.meta.url), 'utf8');
// Only the standalone transaction boundaries are removed, never PL/pgSQL blocks.
const begin = /^[\t ]*begin;[\t ]*\r?$/gim;
const commit = /^[\t ]*commit;[\t ]*\r?$/gim;
assert.equal([...access.matchAll(begin)].length, 1);
assert.equal([...access.matchAll(commit)].length, 1);
const accessBody = access.replace(begin, '').replace(commit, '');
const tables = ['meta_campaign_insights', 'meta_insights_sync_runs'];
const browserRoles = ['anon', 'authenticated'];
const crud = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const tablePrivileges = [...crud, 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const columnPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
const workspace = '10000000-0000-4000-8000-000000000001';
const otherWorkspace = '10000000-0000-4000-8000-000000000002';
const launch = '20000000-0000-4000-8000-000000000001';
const otherLaunch = '20000000-0000-4000-8000-000000000002';

async function rejected(action, code, message) {
  const error = await action().then(() => null, reason => reason);
  assert.equal(error?.code, code, error?.message ?? 'SQL unexpectedly succeeded');
  if (message) assert.equal(error.message, message);
  return error;
}

async function inTransaction(db, action) {
  await db.query('begin');
  try { return await action(); }
  finally { await db.query('rollback'); }
}

async function asRole(db, role, action) {
  assert.ok([...browserRoles, 'service_role'].includes(role));
  await db.query(`set local role ${role}`);
  try { return await action(); }
  finally { await db.query('reset role'); }
}

async function statementRejected(db, action, code) {
  await db.query('savepoint rejected_statement');
  try { return await rejected(action, code); }
  finally {
    await db.query('rollback to savepoint rejected_statement');
    await db.query('release savepoint rejected_statement');
  }
}

async function migrate(db) {
  await db.query(foundation);
  await db.query(accessBody);
}

async function insertRow(db, table, overrides = {}) {
  assert.ok(tables.includes(table));
  const values = {
    id: randomUUID(), workspace_id: workspace, meta_campaign_launch_id: launch,
    ...(table === tables[0]
      ? { meta_campaign_id: 'fictional-campaign', date_start: '2031-01-01', date_stop: '2031-01-01', currency: 'USD' }
      : { sync_scope: 'campaign', status: 'pending', date_start: '2031-01-01', date_stop: '2031-01-01' }),
    ...overrides,
  };
  const columns = Object.keys(values);
  for (const column of columns) assert.match(column, /^[a-z_]+$/);
  const result = await db.query(`insert into public.${table} (${columns.join(',')})
    values (${columns.map((_, i) => `$${i + 1}`).join(',')}) returning to_jsonb(${table}) as item`, Object.values(values));
  return result.rows[0].item;
}

async function rows(db, table) {
  assert.ok([...tables, 'workspaces', 'meta_campaign_launches', 'deals'].includes(table));
  return (await db.query(`select to_jsonb(item) as item from public.${table} item order by id`)).rows;
}

async function relationState(db) {
  return (await db.query(`select c.relname, c.relrowsecurity, c.relforcerowsecurity,
    c.relacl::text as acl,
    (select jsonb_agg(jsonb_build_object('name', a.attname, 'acl', a.attacl::text) order by a.attnum)
      from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`)).rows;
}

async function assertNoFoundation(db) {
  assert.deepEqual((await db.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and (relname like 'meta_campaign_insights%' or relname like 'meta_insights_sync_runs%')`)).rows, []);
}

async function assertAccess(db) {
  const roles = (await db.query(`select rolname, rolcanlogin, rolsuper, rolbypassrls
    from pg_roles where rolname = any($1::text[]) order by rolname`, [[...browserRoles, 'service_role']])).rows;
  assert.equal(roles.length, 3);
  for (const role of roles) {
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolcanlogin, false);
    assert.equal(role.rolbypassrls, role.rolname === 'service_role');
  }
  for (const table of tables) {
    const name = `public.${table}`;
    assert.equal((await db.query('select relrowsecurity from pg_class where oid = $1::regclass', [name])).rows[0].relrowsecurity, true);
    for (const privilege of crud) {
      assert.equal((await db.query('select has_table_privilege($1, $2, $3) as allowed', ['service_role', name, privilege])).rows[0].allowed, true);
    }
    for (const role of browserRoles) {
      for (const privilege of tablePrivileges) {
        assert.equal((await db.query('select has_table_privilege($1, $2, $3) as allowed', [role, name, privilege])).rows[0].allowed, false, `${role} ${table} ${privilege}`);
      }
      for (const privilege of columnPrivileges) {
        assert.equal((await db.query('select has_any_column_privilege($1, $2, $3) as allowed', [role, name, privilege])).rows[0].allowed, false, `${role} ${table} column ${privilege}`);
      }
    }
    // PUBLIC is ACL grantee zero, not an actual PostgreSQL role.
    const acl = await db.query(`select x.grantee from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
      where c.oid = $1::regclass and (x.grantee = 0 or x.grantee in (select oid from pg_roles where rolname = any($2::text[])))
      union all
      select x.grantee from pg_attribute a cross join lateral aclexplode(a.attacl) x
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
      and (x.grantee = 0 or x.grantee in (select oid from pg_roles where rolname = any($2::text[])))`, [name, browserRoles]);
    assert.deepEqual(acl.rows, [], `no PUBLIC/browser table or column ACL remains on ${table}`);
  }
}

function directAction(db, table, operation) {
  switch (operation) {
    case 'SELECT': return db.query(`select * from public.${table}`);
    case 'INSERT': return insertRow(db, table, { date_start: '2031-03-01', date_stop: '2031-03-01' });
    case 'UPDATE': return db.query(`update public.${table} set date_stop = date_stop`);
    case 'DELETE': return db.query(`delete from public.${table}`);
    default: throw new Error('Unknown test operation');
  }
}

async function assertDirectDenial(db) {
  for (const role of browserRoles) {
    await asRole(db, role, async () => {
      for (const table of tables) {
        for (const operation of crud) {
          await statementRejected(db, () => directAction(db, table, operation), '42501');
        }
      }
    });
  }
}

test('Meta Insights 021 + 079 access on disposable PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  let db;
  try {
    db = await fixture.connect();
    const observer = await fixture.connect();
    // Minimal synthetic dependencies, not application migrations or real records.
    await db.query(`create role anon nologin nosuperuser nobypassrls;
      create role authenticated nologin nosuperuser nobypassrls;
      create role service_role nologin nosuperuser bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      create table public.workspaces (id uuid primary key, name text not null);
      create table public.meta_campaign_launches (id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade);
      create table public.deals (id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade, note text);
      grant select(note) on public.deals to public;
      grant insert on public.deals to anon;
      grant update(note) on public.deals to authenticated;
      grant select, insert, update, delete on public.deals to service_role;`);
    for (const [w, l] of [[workspace, launch], [otherWorkspace, otherLaunch]]) {
      await db.query('insert into public.workspaces values ($1, $2)', [w, 'Fictional Insights fixture']);
      await db.query('insert into public.meta_campaign_launches values ($1, $2)', [l, w]);
      await db.query('insert into public.deals values ($1, $2, $3)', [randomUUID(), w, 'Fictional unrelated deal']);
    }
    const baseline = await relationState(db);
    const dependencyRows = {};
    for (const table of ['workspaces', 'meta_campaign_launches', 'deals']) dependencyRows[table] = await rows(db, table);

    for (const missing of ['both', ...tables]) {
      await t.test(`missing 021 (${missing}) aborts and rolls back all transaction changes`, async () => {
        await inTransaction(db, async () => {
          await db.query('insert into public.workspaces values ($1, $2)', [randomUUID(), 'Rollback sentinel']);
          if (missing !== 'both') {
            await db.query(foundation);
            await db.query(`drop table public.${missing}`);
          }
          await rejected(() => db.query(accessBody), 'P7901', 'meta_insights_access_requires_021');
          await rejected(() => db.query('select 1'), '25P02');
        });
        await assertNoFoundation(db);
        assert.deepEqual(await relationState(db), baseline);
        assert.deepEqual(await rows(db, 'workspaces'), dependencyRows.workspaces);
      });
    }

    for (const variant of ['missing', 'non-bypass']) {
      await t.test(`${variant} service_role fails closed and rolls back exact 021 + 079`, async () => {
        await inTransaction(db, async () => {
          await db.query(variant === 'missing'
            ? 'revoke usage on schema public from service_role; revoke all on public.deals from service_role; drop role service_role'
            : 'alter role service_role nobypassrls');
          await db.query(foundation);
          await rejected(() => db.query(accessBody), 'P7902', 'meta_insights_access_requires_server_roles');
          await rejected(() => db.query('select 1'), '25P02');
        });
        await assertNoFoundation(db);
        assert.deepEqual(await relationState(db), baseline);
        assert.equal((await db.query("select rolbypassrls from pg_roles where rolname = 'service_role'")).rows[0].rolbypassrls, true);
      });
    }

    await t.test('failure after exact 021 + 079 rolls back foundation tables, indexes and ACLs', async () => {
      await inTransaction(db, async () => {
        await migrate(db);
        await assertAccess(db);
        await rejected(() => db.query('select 1 / 0'), '22012');
      });
      await assertNoFoundation(db);
      assert.deepEqual(await relationState(db), baseline);
    });

    await t.test('exact 021 + 079 become visible atomically with RLS and server-only CRUD', async () => {
      await db.query('begin');
      try {
        await db.query(foundation);
        await assertNoFoundation(observer);
        await db.query(accessBody);
        await assertAccess(db);
        await assertNoFoundation(observer);
        await asRole(db, 'service_role', async () => {
          for (const table of tables) {
            await insertRow(db, table);
            await insertRow(db, table, { workspace_id: otherWorkspace, meta_campaign_launch_id: otherLaunch });
          }
        });
        await db.query('commit');
      } finally { await db.query('rollback'); }
      await assertAccess(observer);
      for (const table of tables) assert.equal((await rows(observer, table)).length, 2);
      for (const table of Object.keys(dependencyRows)) assert.deepEqual(await rows(db, table), dependencyRows[table]);
    });

    const fictionalRows = {};
    for (const table of tables) fictionalRows[table] = await rows(db, table);
    const securedState = await relationState(db);

    for (const table of tables) {
      await t.test(`service_role performs real insert/read/update/delete on ${table}`, async () => {
        await inTransaction(db, () => asRole(db, 'service_role', async () => {
          assert.equal((await db.query(`select * from public.${table}`)).rowCount, 2);
          const item = await insertRow(db, table, { date_start: '2031-02-01', date_stop: '2031-02-01' });
          const field = table === tables[0] ? 'spend_minor' : 'rows_upserted';
          assert.equal((await db.query(`update public.${table} set ${field} = 42 where id = $1 returning id`, [item.id])).rowCount, 1);
          assert.equal(Number((await db.query(`select ${field} as value from public.${table} where id = $1`, [item.id])).rows[0].value), 42);
          assert.equal((await db.query(`delete from public.${table} where id = $1 returning id`, [item.id])).rowCount, 1);
          assert.equal((await db.query(`select * from public.${table} where id = $1`, [item.id])).rowCount, 0);
        }));
        assert.deepEqual(await rows(db, table), fictionalRows[table]);
      });
      for (const role of browserRoles) {
        for (const operation of crud) {
          await t.test(`${role} direct ${operation} on ${table} is permission denied`, async () => {
            await inTransaction(db, () => asRole(db, role, () => statementRejected(db, () => directAction(db, table, operation), '42501')));
            assert.deepEqual(await rows(db, table), fictionalRows[table]);
          });
        }
      }
      await t.test(`${table} RLS independently blocks browser rows even with temporary CRUD grants`, async () => {
        await inTransaction(db, async () => {
          assert.equal((await db.query('select 1 from pg_policies where schemaname = $1 and tablename = $2', ['public', table])).rowCount, 0);
          await db.query(`grant select, insert, update, delete on public.${table} to anon, authenticated`);
          for (const role of browserRoles) {
            await asRole(db, role, async () => {
              for (const operation of ['SELECT', 'UPDATE', 'DELETE']) assert.equal((await directAction(db, table, operation)).rowCount, 0);
              await statementRejected(db, () => directAction(db, table, 'INSERT'), '42501');
            });
          }
        });
        assert.deepEqual(await rows(db, table), fictionalRows[table]);
      });
    }

    for (const grantee of ['public', ...browserRoles]) {
      for (const level of ['table', 'column']) {
        await t.test(`legacy ${grantee.toUpperCase()} ${level} grants are revoked without changing rows or unrelated permissions`, async () => {
          await inTransaction(db, async () => {
            for (const table of tables) {
              if (level === 'table') {
                await db.query(`grant all privileges on table public.${table} to ${grantee}`);
              } else {
                const columns = (await db.query(`select quote_ident(attname) as name from pg_attribute
                  where attrelid = $1::regclass and attnum > 0 and not attisdropped order by attnum`, [`public.${table}`])).rows.map(row => row.name).join(',');
                await db.query(`grant ${columnPrivileges.map(privilege => `${privilege} (${columns})`).join(',')} on table public.${table} to ${grantee}`);
              }
              const role = grantee === 'public' ? 'anon' : grantee;
              assert.equal((await db.query('select has_any_column_privilege($1, $2, $3) as allowed', [role, `public.${table}`, 'SELECT'])).rows[0].allowed, true);
              assert.equal((await db.query('select has_table_privilege($1, $2, $3) as allowed', [role, `public.${table}`, 'SELECT'])).rows[0].allowed, level === 'table');
            }
            await migrate(db);
            await assertAccess(db);
            await assertDirectDenial(db);
            for (const table of tables) assert.deepEqual(await rows(db, table), fictionalRows[table]);
            assert.deepEqual(await relationState(db), securedState);
          });
        });
      }
    }

    for (const role of browserRoles) {
      for (const level of ['table', 'column']) {
        await t.test(`inherited ${role} ${level} grant fails the final contract and rolls back all migration changes`, async () => {
          await inTransaction(db, async () => {
            await db.query(`create role meta_insights_legacy_reader nologin nosuperuser nobypassrls;
              grant meta_insights_legacy_reader to ${role};
              revoke all on table public.meta_campaign_insights, public.meta_insights_sync_runs from service_role;
              grant all on table public.meta_campaign_insights, public.meta_insights_sync_runs to anon, authenticated;`);
            for (const table of tables) {
              await db.query(`alter table public.${table} disable row level security;
                grant update(id) on table public.${table} to anon, authenticated;
                grant ${level === 'table' ? 'select' : 'select(id)'} on table public.${table} to meta_insights_legacy_reader;`);
            }
            const legacyState = await relationState(db);
            await db.query('savepoint migration_attempt');
            await rejected(() => migrate(db), 'P7903', 'meta_insights_access_contract_mismatch');
            await rejected(() => db.query('select 1'), '25P02');
            await db.query('rollback to savepoint migration_attempt');
            await db.query('release savepoint migration_attempt');
            assert.deepEqual(await relationState(db), legacyState, 'RLS enables, revokes and server grants must all roll back');
            assert.equal((await db.query("select pg_has_role($1, 'meta_insights_legacy_reader', 'USAGE') as inherited", [role])).rows[0].inherited, true);
            for (const table of tables) {
              assert.deepEqual(await rows(db, table), fictionalRows[table]);
              assert.equal((await db.query('select has_table_privilege($1, $2, $3) as allowed', ['service_role', `public.${table}`, 'SELECT'])).rows[0].allowed, false);
              assert.equal((await db.query('select has_table_privilege($1, $2, $3) as allowed', ['meta_insights_legacy_reader', `public.${table}`, 'SELECT'])).rows[0].allowed, level === 'table');
              assert.equal((await db.query('select has_any_column_privilege($1, $2, $3) as allowed', ['meta_insights_legacy_reader', `public.${table}`, 'SELECT'])).rows[0].allowed, true);
            }
          });
          assert.deepEqual(await relationState(db), securedState);
          assert.equal((await db.query("select 1 from pg_roles where rolname = 'meta_insights_legacy_reader'")).rowCount, 0);
          await assertAccess(db);
        });
      }
    }

    await t.test('repeating exact 021 + 079 twice preserves fictional rows and every unrelated table/column permission', async () => {
      await inTransaction(db, async () => {
        await migrate(db);
        await migrate(db);
        await assertAccess(db);
        await assertDirectDenial(db);
        assert.deepEqual(await relationState(db), securedState);
        for (const table of tables) assert.deepEqual(await rows(db, table), fictionalRows[table]);
        for (const table of Object.keys(dependencyRows)) assert.deepEqual(await rows(db, table), dependencyRows[table]);
      });
    });

    const constraintTest = (name, table, overrides, code) => t.test(name, async () => {
      await inTransaction(db, () => asRole(db, 'service_role', () => statementRejected(db,
        () => insertRow(db, table, { date_start: '2031-04-01', date_stop: '2031-04-01', ...overrides }), code)));
      assert.deepEqual(await rows(db, table), fictionalRows[table]);
    });
    for (const table of tables) {
      for (const column of ['workspace_id', 'meta_campaign_launch_id']) {
        await constraintTest(`${table} rejects missing ${column} foreign key`, table, { [column]: randomUUID() }, '23503');
      }
      await constraintTest(`${table} rejects an inverted date range`, table, { date_stop: '2031-03-31' }, '23514');
    }
    for (const column of ['spend_minor', 'currency_exponent', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'meta_leads']) {
      await constraintTest(`meta_campaign_insights rejects negative ${column}`, tables[0], { [column]: -1 }, '23514');
    }
    await constraintTest('meta_campaign_insights rejects currency exponent above six', tables[0], { currency_exponent: 7 }, '23514');
    await constraintTest('meta_insights_sync_runs rejects negative rows_upserted', tables[1], { rows_upserted: -1 }, '23514');
    await constraintTest('meta_campaign_insights rejects a duplicate workspace/launch/date tuple', tables[0], { date_start: '2031-01-01', date_stop: '2031-01-01' }, '23505');
    await constraintTest('meta_campaign_insights rejects non-object action_counts', tables[0], { action_counts: '[]' }, '23514');
    await constraintTest('meta_insights_sync_runs rejects an unknown status', tables[1], { status: 'fictional-invalid' }, '23514');

    await t.test('zero metrics, nullable leads and optional sync dates/launch remain valid', async () => {
      await inTransaction(db, () => asRole(db, 'service_role', async () => {
        const metric = await insertRow(db, tables[0], { date_start: '2031-05-01', date_stop: '2031-05-01', meta_leads: null, currency_exponent: 0 });
        for (const column of ['spend_minor', 'impressions', 'reach', 'clicks', 'inline_link_clicks']) assert.equal(metric[column], 0);
        assert.equal(metric.meta_leads, null);
        assert.deepEqual(metric.action_counts, {});
        const run = await insertRow(db, tables[1], { meta_campaign_launch_id: null, date_start: null, date_stop: null });
        for (const column of ['meta_campaign_launch_id', 'date_start', 'date_stop']) assert.equal(run[column], null);
        assert.equal(run.rows_upserted, 0);
      }));
    });

    await t.test('launch cascade/set-null and workspace cascades preserve the other fictional workspace', async () => {
      await inTransaction(db, async () => {
        await db.query('delete from public.meta_campaign_launches where id = $1', [launch]);
        assert.equal((await rows(db, tables[0])).length, 1);
        const runs = (await rows(db, tables[1])).map(row => row.item);
        assert.equal(runs.length, 2);
        assert.equal(runs.find(row => row.workspace_id === workspace).meta_campaign_launch_id, null);
        assert.equal(runs.find(row => row.workspace_id === otherWorkspace).meta_campaign_launch_id, otherLaunch);
        await db.query('delete from public.workspaces where id = $1', [workspace]);
        for (const table of tables) assert.deepEqual(await rows(db, table), fictionalRows[table].filter(row => row.item.workspace_id === otherWorkspace));
      });
      for (const table of tables) assert.deepEqual(await rows(db, table), fictionalRows[table]);
    });
  } finally {
    await fixture.close();
    await t.test('cleanup closes existing sessions, stops the owned cluster and is repeatable', async () => {
      if (db) await assert.rejects(() => db.query('select 1'));
      let unexpected;
      try { await assert.rejects(async () => { unexpected = await fixture.connect(); }); }
      finally { if (unexpected) await unexpected.end(); }
      await fixture.close();
    });
    t.diagnostic('Cleanup complete: one disposable cluster closed; no external database, HTTP or provider used.');
  }
});
