import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const sql = await readFile(new URL('../../migrations/099_application_function_default_access.sql', import.meta.url), 'utf8');
const previous = await readFile(new URL('../../migrations/023_public_privilege_hardening.sql', import.meta.url), 'utf8');
const one = async (db, query, args = []) => (await db.query(query, args)).rows[0];
const defaults = db => db.query('select defaclrole,defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by 1,2,3');
const allowed = (db, name, role = 'anon') => one(db, 'select has_function_privilege($1,$2,\'EXECUTE\') as value', [role, name]);

test('099 future-routine defaults: real SQL semantics without external services', { timeout: 90000 }, async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('create role anon; create role authenticated; create role service_role; create role other_creator; create role inherited_reader; create schema owned_other;');
  await db.exec(previous);
  await db.exec("create function public.default_probe_old() returns integer language sql as 'select 1'");
  assert.equal((await allowed(db, 'public.default_probe_old()')).value, true, '023 per-schema revocation does not override global PUBLIC default');
  const baseline = await defaults(db);
  for (const grant of [
    'alter default privileges grant execute on functions to anon',
    'alter default privileges in schema public grant execute on functions to authenticated',
    'alter default privileges in schema public grant execute on functions to inherited_reader',
  ]) {
    await t.test(`unreviewed direct/inherited grant refuses atomically: ${grant}`, async () => {
      await db.exec('grant inherited_reader to anon');
      await db.exec(grant);
      const before = await defaults(db);
      await assert.rejects(db.exec(sql), /application_function_defaults_browser_access_unconfirmed/);
      await db.exec('rollback');
      assert.deepEqual(await defaults(db), before);
      await db.exec(grant.replace(' grant execute on functions to ', ' revoke execute on functions from '));
      await db.exec('revoke inherited_reader from anon');
    });
  }
  await t.test('wrong application creator refuses instead of changing another role defaults', async () => {
    await db.exec('set role anon');
    try { await assert.rejects(db.exec(sql), /application_function_defaults_dependencies_unconfirmed/); }
    finally { await db.exec('rollback; reset role'); }
    assert.deepEqual(await defaults(db), baseline);
  });
  await t.test('global change preserves existing routines, explicit server rights, tables/sequences and other creators', async () => {
    await db.exec('alter default privileges grant execute on functions to service_role');
    const old = await one(db, "select proacl::text as acl from pg_proc where oid='public.default_probe_old()'::regprocedure");
    const otherDefaults = (await defaults(db)).rows.filter(row => row.defaclobjtype !== 'f');
    await db.exec(sql);
    assert.deepEqual(await one(db, "select proacl::text as acl from pg_proc where oid='public.default_probe_old()'::regprocedure"), old);
    assert.deepEqual((await defaults(db)).rows.filter(row => row.defaclobjtype !== 'f'), otherDefaults);
    await db.exec("create function public.default_probe_new() returns integer language sql as 'select 1'; create function owned_other.default_probe_new() returns integer language sql as 'select 1'");
    for (const name of ['public.default_probe_new()', 'owned_other.default_probe_new()']) {
      for (const role of ['anon', 'authenticated']) assert.equal((await allowed(db, name, role)).value, false);
      assert.equal((await allowed(db, name, 'service_role')).value, true);
    }
    await db.exec('grant usage,create on schema owned_other to other_creator; set role other_creator');
    try { await db.exec("create function owned_other.other_creator_probe() returns integer language sql as 'select 1'"); }
    finally { await db.exec('reset role'); }
    assert.equal((await allowed(db, 'owned_other.other_creator_probe()')).value, true, '099 makes no claim about a different creator');
    const before = await defaults(db); await db.exec(sql); assert.deepEqual(await defaults(db), before);
  });
});
