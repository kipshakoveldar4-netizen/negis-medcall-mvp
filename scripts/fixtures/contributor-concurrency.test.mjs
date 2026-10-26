import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { startNativePostgres } from './native-postgres.mjs';

test('contributor races on owned native PostgreSQL, no external database', { timeout: 220_000 }, async t => {
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1', 'Explicit disposable native fixture opt-in required');
  const fixture = await startNativePostgres();
  t.after(() => fixture.close());
  const setup = await fixture.connect(), a = await fixture.connect(), b = await fixture.connect();
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const migration = await readFile(new URL('../../migrations/105_contributor_applications.sql', import.meta.url), 'utf8');
  await setup.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;');
  await setup.query('create table public.existing_financial_fixture(id int primary key,amount bigint); insert into public.existing_financial_fixture values(1,123456789012345);');
  await setup.query(migration); await setup.query(migration);
  const apply = async (client, partner, creator, actor = 1) => (await client.query("select public.apply_growth_contributor($1,'Native QA',$2,$3,'{}') value", [id(actor), partner, creator])).rows[0].value;
  const review = async (client, row, role) => (await client.query("select public.review_growth_contributor($1,$2,$3,$4,'approve') value", [row.id, row.revision, id(90), role])).rows[0].value;
  await t.test('concurrent role applications keep one identity and union of requested roles', async () => {
    const values = await Promise.all([apply(a, true, false), apply(b, false, true)]);
    assert.equal(values[0].id, values[1].id);
    const { rows } = await setup.query('select * from public.growth_contributor_profiles where auth_user_id=$1', [id(1)]);
    assert.equal(rows.length, 1); assert.equal(rows[0].partner_status, 'pending'); assert.equal(rows[0].creator_status, 'pending');
  });
  await t.test('same-revision concurrent reviews have one winner and an explicit stale conflict', async () => {
    const row = await apply(setup, true, true);
    const values = await Promise.allSettled([review(a, row, 'partner'), review(b, row, 'creator')]);
    assert.equal(values.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(values.find(value => value.status === 'rejected').reason.code, 'P1052');
    const { rows: [saved] } = await setup.query('select * from public.growth_contributor_profiles where auth_user_id=$1', [id(1)]);
    assert.equal([saved.partner_status, saved.creator_status].filter(status => status === 'approved').length, 1);
    assert.notEqual(saved.revision, row.revision);
  });
  await t.test('migration and approvals do not mutate pre-existing financial rows', async () => {
    const { rows } = await setup.query('select id,amount::text from public.existing_financial_fixture');
    assert.deepEqual(rows, [{ id: 1, amount: '123456789012345' }]);
    assert.equal((await setup.query("select count(*)::int n from pg_policies where tablename='growth_contributor_profiles'")).rows[0].n, 0);
  });
});
