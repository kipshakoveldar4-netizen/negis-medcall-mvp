import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { digest, inspectMigration, migrationReview, migrationTokens } from './migration-chain-review.mjs';
import { legacyServerAccessRequirements as requirements } from './legacy-server-access-requirements.mjs';
import { exerciseLegacyAccessRefusals, legacyAccessSnapshot, proveLegacyAccessBaseline, proveLegacyAccessRepair } from './legacy-server-access-cases.mjs';

const read = file => readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
const sql = await read('098_legacy_server_access.sql');
const schema = JSON.parse(sql.match(/\$required\$([\s\S]*?)\$required\$::jsonb/)?.[1] ?? 'null');

test('098 exact source scope: seven typed API shapes, seven RLS flags and no browser/default/role/data mutation', () => {
  assert.deepEqual(Object.keys(schema).sort(), requirements.map(item => item.table).sort());
  for (const requirement of requirements) assert.deepEqual(Object.keys(schema[requirement.table]).sort(), [...requirement.columns].sort());
  const evidence = inspectMigration(sql);
  assert.deepEqual(evidence.tables, []); assert.deepEqual(evidence.functions, []);
  assert.deepEqual(evidence.extensions, []); assert.deepEqual(evidence.notifications, []); assert.deepEqual(evidence.dynamicSqlLines, []);
  assert.deepEqual(evidence.rls.sort(), requirements.map(item => `public.${item.table}`).sort());
  assert.doesNotMatch(sql, /\balter\s+default\s+privileges\b|\b(?:create|alter|drop)\s+role\b|\bdisable\s+row\s+level\s+security\b/i);
  const tokens = migrationTokens(sql);
  const grants = []; let statement = [];
  for (const token of tokens) {
    if (token.kind === 'symbol' && token.value === ';') {
      if (statement[0]?.value === 'grant') grants.push(statement);
      assert.ok(!['insert', 'update', 'delete', 'truncate', 'revoke'].includes(statement[0]?.value), 'No business DML or existing-ACL rewrite');
      statement = [];
    } else statement.push(token);
  }
  assert.equal(grants.length, 2);
  for (const grant of grants) {
    const to = grant.findIndex(token => token.value === 'to');
    assert.deepEqual(grant.slice(to + 1).map(token => token.value), ['service_role']);
    assert.ok(!grant.some(token => token.value === 'all' || token.value === 'delete' || token.value === 'with'));
  }
});

// This focused emulator deliberately loads ONLY the unchanged CREATE TABLE
// statements needed for shape/ACL cases, not migration 009 or a cumulative
// chain. It neither strips pgcrypto from a purported chain nor proves native
// compatibility. The native gate separately applies every complete SQL file.
async function tableShapes() {
  const wanted = new Set(['public.workspaces', ...requirements.map(item => `public.${item.table}`)]), found = new Map();
  for (const file of ['009_medcall_mvp_persistence.sql', '010_staff_ready_crm.sql', '013_release_admin_settings.sql', '014_meta_ad_launches.sql']) {
    const source = await read(file); assert.equal(digest(source), migrationReview[file], file);
    let statement = [];
    for (const token of migrationTokens(source)) {
      if (token.kind === 'symbol' && token.value === ';') {
        if (statement[0]?.value === 'create' && statement[1]?.value === 'table') {
          const whole = source.slice(statement[0].offset, token.offset + 1);
          const [table] = inspectMigration(whole).tables;
          if (wanted.has(table)) found.set(table, whole);
        }
        statement = [];
      } else statement.push(token);
    }
  }
  assert.equal(found.size, wanted.size);
  return [...found.values()];
}

test('098 focused PostgreSQL-emulator ACL/rollback cases, not native chain authority', { timeout: 120000 }, async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  const db = { query: async (query, args = []) => args.length ? pg.query(query, args) : (await pg.exec(query)).at(-1) };
  await db.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role;');
  for (const statement of await tableShapes()) await db.query(statement);
  await db.query(await read('023_public_privilege_hardening.sql'));
  const w = randomUUID(), launch = randomUUID(), campaign = randomUUID();
  await db.query("insert into public.workspaces(id,name) values($1,'Synthetic 098')", [w]);
  await db.query("insert into public.content_videos(workspace_id,title) values($1,'Synthetic unit, no generation')", [w]);
  await db.query("insert into public.meta_ad_accounts(workspace_id,account_name) values($1,'Synthetic unit, no account connection')", [w]);
  await db.query("insert into public.meta_campaign_launches(id,workspace_id,campaign_name) values($1,$2,'Synthetic unit, no launch')", [launch, w]);
  await db.query("insert into public.meta_launch_audit_logs(workspace_id,launch_id,action) values($1,$2,'synthetic-no-external-action')", [w, launch]);
  await db.query("insert into public.release_checks(workspace_id,check_key) values($1,'synthetic')", [w]);
  await db.query("insert into public.targeting_campaigns(id,workspace_id,campaign_name) values($1,$2,'Synthetic unit, no campaign')", [campaign, w]);
  await db.query("insert into public.targeting_reports(campaign_id,summary) values($1,'Synthetic unit, no provider')", [campaign]);
  await db.query('create policy owned_098_preserved on public.content_videos for select to authenticated using(true)');
  await t.test('baseline requires actual emulator permission errors, not only text matching', async () => assert.equal((await proveLegacyAccessBaseline(db)).length, 17));
  await exerciseLegacyAccessRefusals(db, sql, t);
  const before = await legacyAccessSnapshot(db);
  await db.query(sql);
  await t.test('098 grants only the matrix, preserves rows/defaults/policies/roles and is idempotent', async () => proveLegacyAccessRepair(db, before, sql));
});
