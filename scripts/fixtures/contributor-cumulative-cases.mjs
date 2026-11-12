import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
async function rollback(db, action) { await db.query('begin'); try { return await action(); } finally { await db.query('rollback'); } }
async function asRole(db, role, action) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.query(`set local role ${role}`);
  try { return await action(); } finally { await db.query('reset role'); }
}
async function denied(db, action, code = '42501') {
  await db.query('savepoint contributor_denial');
  try { await assert.rejects(action, error => error.code === code); }
  finally { await db.query('rollback to savepoint contributor_denial; release savepoint contributor_denial'); }
}
const apply = async (db, actor, partner = true, creator = true) => (await one(db,
  "select public.apply_growth_contributor($1,'Cumulative synthetic applicant',$2,$3,array['https://example.com/portfolio']) value", [actor, partner, creator])).value;
const review = async (db, row, owner, role, action = 'approve') => (await one(db,
  'select public.review_growth_contributor($1,$2,$3,$4,$5) value', [row.id, row.revision, owner, role, action])).value;

async function noBusinessEffects(db) {
  for (const table of ['workspaces', 'staff_users', 'growth_operator_profiles', 'growth_operator_requests',
    'growth_partners', 'growth_referrals', 'platform_subscriptions', 'platform_subscription_payments',
    'growth_partner_commissions', 'growth_partner_payouts', 'leads', 'appointments', 'deals',
    'content_generation_usage', 'meta_campaign_launches', 'tiktok_campaign_launches']) {
    assert.equal((await one(db, `select count(*)::int n from public.${table}`)).n, 0,
      `${table}: contributor intake/review must not activate clinic, role, commercial channel or expense`);
  }
}

export async function exerciseContributorCumulative(db, source, t) {
  await t.test('105 service RPCs survive 099 global defaults and keep intake separate from commercial/clinic activation', async () => rollback(db, async () => {
    const actor = randomUUID(), owner = randomUUID();
    const applied = await asRole(db, 'service_role', () => apply(db, actor));
    assert.equal(applied.partner_status, 'pending'); assert.equal(applied.creator_status, 'pending');
    const partner = await asRole(db, 'service_role', () => review(db, applied, owner, 'partner'));
    const creator = await asRole(db, 'service_role', () => review(db, partner, owner, 'creator'));
    const suspended = await asRole(db, 'service_role', () => review(db, creator, owner, 'partner', 'suspend'));
    assert.equal(suspended.partner_status, 'suspended'); assert.equal(suspended.creator_status, 'approved');
    assert.equal(suspended.partner_reviewed_by, owner); assert.equal(suspended.auth_user_id, actor);
    await noBusinessEffects(db);
  }));
  await t.test('105 actual browser roles cannot invoke service RPCs or read/write applicant data after the full chain', async () => rollback(db, async () => {
    const actor = randomUUID(), owner = randomUUID(); const row = await apply(db, actor);
    for (const role of ['anon', 'authenticated']) await asRole(db, role, async () => {
      await denied(db, () => db.query('select * from public.growth_contributor_profiles'));
      await denied(db, () => apply(db, actor));
      await denied(db, () => review(db, row, owner, 'creator'));
      await denied(db, () => db.query("update public.growth_contributor_profiles set creator_status='approved'"));
    });
    await asRole(db, 'service_role', async () => {
      assert.equal((await one(db, 'select count(*)::int n from public.growth_contributor_profiles')).n, 1);
      await denied(db, () => db.query("update public.growth_contributor_profiles set creator_status='approved'"));
      await denied(db, () => db.query('delete from public.growth_contributor_profiles'));
    });
  }));
  await t.test('105 RLS still hides all applicant rows under an accidental browser read grant', async () => rollback(db, async () => {
    await apply(db, randomUUID()); await apply(db, randomUUID());
    await db.query('grant select on public.growth_contributor_profiles to anon,authenticated');
    for (const role of ['anon', 'authenticated']) await asRole(db, role, async () => {
      assert.equal((await one(db, 'select count(*)::int n from public.growth_contributor_profiles')).n, 0);
    });
  }));
  await t.test('105 full-chain replay and second-role addition never erase review, mutate identity or issue money', async () => rollback(db, async () => {
    const actor = randomUUID(), owner = randomUUID();
    const first = await apply(db, actor, true, false);
    const approved = await review(db, first, owner, 'partner');
    const additional = await apply(db, actor);
    assert.equal(additional.partner_status, 'approved'); assert.equal(additional.creator_status, 'pending');
    assert.notEqual(additional.revision, approved.revision);
    const replay = (await one(db, "select public.apply_growth_contributor($1,'Replacement name',true,true,'{}') value", [actor])).value;
    assert.deepEqual(replay, additional);
    await denied(db, () => review(db, first, owner, 'creator'), 'P1052');
    await noBusinessEffects(db);
  }));
  await t.test('105 exact rerun with a committed reviewed synthetic applicant preserves row and ACLs', async () => {
    const actor = randomUUID(), owner = randomUUID();
    let created;
    try {
      created = await apply(db, actor);
      const approved = await review(db, created, owner, 'creator');
      const before = (await one(db, 'select to_jsonb(p) value from public.growth_contributor_profiles p where id=$1', [created.id])).value;
      assert.equal(before.creator_status, approved.creator_status);
      await db.query(source);
      assert.deepEqual((await one(db, 'select to_jsonb(p) value from public.growth_contributor_profiles p where id=$1', [created.id])).value, before);
      assert.deepEqual(await one(db, `select has_table_privilege('authenticated','public.growth_contributor_profiles','SELECT,INSERT,UPDATE,DELETE') browser,
        has_table_privilege('service_role','public.growth_contributor_profiles','SELECT') server_read,
        has_table_privilege('service_role','public.growth_contributor_profiles','INSERT,UPDATE,DELETE') server_write`),
        { browser: false, server_read: true, server_write: false });
      await noBusinessEffects(db);
    } finally {
      if (created) {
        const removed = await db.query('delete from public.growth_contributor_profiles where id=$1 and auth_user_id=$2', [created.id, actor]);
        assert.equal(removed.rowCount, 1, 'Only this committed synthetic applicant may be removed');
      }
    }
  });
}

export async function exerciseDepartedOperatorAuthor(db, t) {
  for (const action of ['accept', 'decline']) for (const departure of ['inactive', 'rebound']) {
    await t.test(`108 keyed operator ${action} preserves original 096 terms after author ${departure}`, async () => rollback(db, async () => {
      const workspace = randomUUID(), staff = randomUUID(), actor = randomUUID(), operator = randomUUID(), operatorAuth = randomUUID();
      await db.query("insert into public.workspaces(id,name) values($1,'Cumulative operator synthetic')", [workspace]);
      await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
        values($1,$2,$3,'cumulative@fixture.invalid','Synthetic author','admin','active')`, [staff, workspace, actor]);
      await db.query(`insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at)
        values($1,$2,'Synthetic operator','approved',true,$3,clock_timestamp())`, [operator, operatorAuth, actor]);
      const proposed = await asRole(db, 'service_role', async () => (await one(db,
        "select public.execute_clinic_operator_command_v2($1,$2,$3,$4,'propose',null,$5,$6,0::bigint,'assigned') value",
        [randomUUID(), workspace, staff, actor, operator, 'Synthetic technical zero terms; no payment'])).value);
      assert.equal(proposed.state, 'committed');
      const request = proposed.requestId;
      if (departure === 'inactive') await db.query("update public.staff_users set status='inactive' where id=$1", [staff]);
      else await db.query('update public.staff_users set auth_user_id=$2 where id=$1', [staff, randomUUID()]);
      const baseline = await one(db, 'select requested_by_staff_user_id,clinic_brief,price_per_arrival_minor::text price,currency,lead_scope from public.growth_operator_requests where id=$1', [request]);
      const returned = await asRole(db, 'service_role', async () => (await one(db,
        'select public.execute_growth_operator_command_v2($1,$2,$3,$4) value', [randomUUID(), request, operatorAuth, action])).value);
      assert.equal(returned.state, 'committed'); assert.equal(returned.requestId, request); assert.equal(returned.action, action);
      const after = await one(db, 'select requested_by_staff_user_id,clinic_brief,price_per_arrival_minor::text price,currency,lead_scope from public.growth_operator_requests where id=$1', [request]);
      assert.deepEqual(after, baseline);
      assert.equal((await one(db, 'select status from public.growth_operator_requests where id=$1', [request])).status, action === 'accept' ? 'accepted' : 'declined');
      await asRole(db, 'service_role', () => denied(db, () => db.query(
        "select public.execute_clinic_operator_command_v2($1,$2,$3,$4,'withdraw',$5,null,null,null,null)",
        [randomUUID(), workspace, staff, actor, request]), 'P9601'));
    }));
  }
}
