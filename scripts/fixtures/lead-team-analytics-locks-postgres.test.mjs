import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselineFile = 'migrations/083_lead_team_analytics_snapshot.sql';
const candidateFile = 'migrations/095_lead_team_analytics_clock.sql';
const signature = 'public.read_lead_team_analytics(uuid,uuid,uuid,integer)';
const activitySignature = 'public.read_lead_team_activity_snapshot(uuid,timestamp with time zone,timestamp with time zone)';
const dependencies = [
  '009_medcall_mvp_persistence.sql', '010_staff_ready_crm.sql', '011_staff_auth_foundation.sql',
  '014_meta_ad_launches.sql', '019_crm_lead_pipeline_foundation.sql', '028_leads_phone_normalized.sql',
  '029_audit_logs_change_journal.sql', '038_staff_join_requests.sql',
  '069_assigned_lead_manager.sql', '070_mortgage_workspace.sql',
];
const row = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
const digest = source => createHash('sha256').update(source).digest('hex');
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const read = async (db, actor, days = 7) => (await row(db,
  'select public.read_lead_team_analytics($1,$2,$3,$4) as report',
  [actor.workspace, actor.id, actor.auth, days])).report;
const own = (report, actor) => {
  const member = report.members.find(item => item.staffId === actor.id);
  assert.ok(member, 'The authorized member must be present');
  return member;
};
const functionBody = source => {
  const start = source.indexOf('create or replace function public.read_lead_team_analytics(');
  assert.ok(start >= 0);
  const end = source.indexOf('end; $$;', start);
  assert.ok(end > start);
  return source.slice(start, end + 'end; $$;'.length);
};
const withoutComments = source => source.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ')
  .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
function assertClockOnlyChange(baseline, candidate) {
  const expected = functionBody(baseline)
    .replace('v_role text; v_now timestamptz:=statement_timestamp(); v_from timestamptz;', 'v_role text;')
    .replace("v_from:=v_now-p_days*interval '24 hours';", '')
    .replace('with staff as materialized (',
      'with report_clock as materialized (select clock_timestamp() as at), staff as materialized (')
    .replace('select public.read_lead_team_activity_snapshot(p_workspace_id,v_from,v_now) as value',
      "select public.read_lead_team_activity_snapshot(p_workspace_id, c.at-p_days*interval '24 hours',c.at) as value from report_clock c")
    .replace("'generatedAt',v_now,'period',jsonb_build_object('days',p_days,'from',v_from,'to',v_now)",
      "'generatedAt',c.at,'period',jsonb_build_object('days',p_days,'from',c.at-p_days*interval '24 hours','to',c.at)")
    .replace('from activity_quality q;', 'from activity_quality q cross join report_clock c;');
  assert.equal(withoutComments(functionBody(candidate)), withoutComments(expected));
  assert.equal((withoutComments(functionBody(candidate)).match(/clock_timestamp\(/g) ?? []).length, 1);
}
async function denied(operation, code = 'P7001') {
  await assert.rejects(operation, error => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

async function seed(db, role = 'owner') {
  const actor = { workspace: randomUUID(), id: randomUUID(), auth: randomUUID() };
  await db.query('insert into public.workspaces(id,name) values($1,$2)',
    [actor.workspace, 'Synthetic analytics lock clock']);
  await db.query(`insert into public.workspace_settings(workspace_id,key,value)
    values($1,'workspace_purpose','{"purpose":"mortgage_leads"}')`, [actor.workspace]);
  await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
    values($1,$2,$3,$4,'Synthetic owner',$5,'active')`,
  [actor.id, actor.workspace, actor.auth, `${actor.id}@example.invalid`, role]);
  return actor;
}

async function waitForBlock(observer, waiter, holder) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await row(observer, `select pg_blocking_pids(pid) as blockers,query_start
      from pg_stat_activity where pid=$1`, [waiter]);
    if (state?.blockers.includes(holder)) return state;
    await delay(10);
  }
  assert.fail('No authoritative PostgreSQL row-lock wait was observed');
}

async function delayedRead(fixture, observer, actor, { revoke = null, gate = 'membership', days = 7 } = {}) {
  const holder = await fixture.connect(), waiter = await fixture.connect();
  let pending;
  try {
    const holderPid = (await row(holder, 'select pg_backend_pid() as pid')).pid;
    const waiterPid = (await row(waiter, 'select pg_backend_pid() as pid')).pid;
    await waiter.query('set role service_role');
    await holder.query('begin');
    if (gate === 'purpose') await holder.query(`update public.workspace_settings set value=value
      where workspace_id=$1 and key='workspace_purpose'`, [actor.workspace]);
    else await holder.query('update public.staff_users set full_name=full_name where id=$1', [actor.id]);
    pending = observed(read(waiter, actor, days));
    await waitForBlock(observer, waiterPid, holderPid);
    // The clock barrier is PostgreSQL's actual query_start, not a guessed sleep.
    const clock = await row(observer, `select query_start::text as started,
      clock_timestamp()>query_start as crossed from pg_stat_activity where pid=$1`, [waiterPid]);
    assert.equal(clock.crossed, true);
    if (revoke) await revoke(holder);
    const id = randomUUID();
    await holder.query(`insert into public.leads(id,workspace_id,responsible_user_id,status,full_name)
      values($1,$2,$3,'new','Synthetic post-lock lead')`, [id, actor.workspace, actor.id]);
    const events = await row(holder, `with inserted as (
      insert into public.audit_logs(workspace_id,actor_staff_user_id,entity_id,action,actor_kind,entity_type,created_at)
      select $1,$2,$3,'updated','manual','lead',at from (
        values($4::timestamptz-$5::integer*interval '24 hours'+interval '1 microsecond'),
          (clock_timestamp()),(clock_timestamp())
      ) times(at) returning created_at
    ) select min(created_at)::text as old_at,max(created_at)::text as fresh_at,
      min(created_at)<$4::timestamptz as lower_boundary,
      max(created_at)>$4::timestamptz as later_than_statement from inserted`,
    [actor.workspace, actor.id, id, clock.started, days]);
    assert.equal(events.lower_boundary, true);
    assert.equal(events.later_than_statement, true);
    await holder.query('commit');
    return { ...(await pending), ...events, started: clock.started };
  } finally {
    await holder.query('rollback').catch(() => {});
    if (pending) await pending;
    await holder.end();
    await waiter.end();
  }
}

test('095 source contract changes only the clock in the existing business snapshot', async () => {
  assertClockOnlyChange(await readFile(path.join(root, baselineFile), 'utf8'),
    await readFile(path.join(root, candidateFile), 'utf8'));
});

test('lead team analytics clock and access locks on owned disposable PostgreSQL',
  { timeout: 300000 }, async t => {
    const baseline = await readFile(path.join(root, baselineFile), 'utf8');
    const candidate = await readFile(path.join(root, candidateFile), 'utf8');
    const fixture = await startDisposablePostgres();
    try {
      const db = await fixture.connect();
      t.diagnostic(`PostgreSQL ${(await row(db, 'show server_version')).server_version}; 083 SHA-256 ${digest(baseline)}`);
      await db.query(`create role anon nologin; create role authenticated nologin;
        create role service_role nologin bypassrls;
        grant usage on schema public to anon,authenticated,service_role`);
      for (const file of dependencies) {
        if (file.startsWith('014_')) {
          const source = await readFile(path.join(root, 'migrations/013_release_admin_settings.sql'), 'utf8');
          const ddl = source.match(/create table if not exists public\.workspace_settings\s*\([\s\S]*?\n\);/g);
          assert.equal(ddl?.length, 1);
          await db.query(ddl[0]);
        }
        await db.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
      }
      await t.test('095 refuses missing 083 without installing a partial function', async () => {
        try { await denied(db.query(candidate), 'P0001'); }
        finally { await db.query('rollback'); }
        assert.equal((await row(db, 'select to_regprocedure($1) as fn', [signature])).fn, null);
      });
      await db.query(baseline);

      await t.test('083 reproduces a post-lock workload with an older activity cutoff', async () => {
        const actor = await seed(db);
        const result = await delayedRead(fixture, db, actor);
        if (result.error) throw result.error;
        const report = result.value;
        const comparison = await row(db, `select
          $1::timestamptz=$2::timestamptz as statement_anchored,
          $1::timestamptz<$3::timestamptz as stale_upper,
          $4::timestamptz between $5::timestamptz and $1::timestamptz as stale_lower`,
        [report.period.to, result.started, result.fresh_at, result.old_at, report.period.from]);
        assert.equal(comparison.statement_anchored, true);
        assert.equal(comparison.stale_upper, true);
        assert.equal(comparison.stale_lower, true);
        assert.equal(report.totalLeads, 1, 'The new business row is visible after the authorization lock');
        assert.equal(own(report, actor).assigned.new, 1);
        assert.equal(own(report, actor).activity.updatedEvents, 1,
          '083 wrongly counts the now-too-old event and omits the two new events');
        assert.equal(Date.parse(own(report, actor).activity.lastRecordedAt), Date.parse(result.old_at));
      });

      const activityBefore = (await row(db, 'select pg_get_functiondef($1::regprocedure) as body', [activitySignature])).body;
      await db.query(candidate);
      t.diagnostic(`095 SHA-256 ${digest(candidate)}; actual 029/070/083 functions, no mocked SQL authority`);
      await t.test('095 changes only the main function clock, preserving SQL formulas and limits', async () => {
        assertClockOnlyChange(baseline, candidate);
        assert.equal((await row(db, 'select pg_get_functiondef($1::regprocedure) as body', [activitySignature])).body,
          activityBefore, 'The private STABLE activity snapshot must be unchanged');
        const before = (await row(db, 'select pg_get_functiondef($1::regprocedure) as body', [signature])).body;
        await db.query(candidate);
        assert.equal((await row(db, 'select pg_get_functiondef($1::regprocedure) as body', [signature])).body, before);
        const info = await row(db, `select prosecdef,provolatile,proconfig,pronargdefaults,
          prorettype::regtype::text as returns from pg_proc where oid=$1::regprocedure`, [signature]);
        assert.equal(info.prosecdef, true);
        assert.equal(info.provolatile, 'v');
        assert.ok(info.proconfig.includes('search_path=""'));
        assert.equal(info.pronargdefaults, 1);
        assert.equal(info.returns, 'jsonb');
      });

      for (const role of ['owner', 'admin']) for (const days of [7, 30, 90]) {
        await t.test(`095 uses fresh ${days}-day boundaries for ${role} after both authorization lock gates`, async () => {
          for (const gate of ['membership', 'purpose']) {
            const actor = await seed(db, role);
            const result = await delayedRead(fixture, db, actor, { gate, days });
            if (result.error) throw result.error;
            const report = result.value;
            const comparison = await row(db, `select
              $1::timestamptz>$2::timestamptz as after_statement,
              $1::timestamptz>=$3::timestamptz as after_new_event,
              $4::timestamptz<$5::timestamptz as old_event_excluded,
              $1::timestamptz-$5::timestamptz=$6::integer*interval '24 hours' as exact_days`,
            [report.period.to, result.started, result.fresh_at, result.old_at, report.period.from, days]);
            assert.deepEqual(comparison, {
              after_statement: true, after_new_event: true, old_event_excluded: true, exact_days: true,
            });
            assert.equal(report.period.days, days);
            assert.equal(report.generatedAt, report.period.to);
            assert.equal(report.activityStatus, 'available');
            assert.equal(report.totalLeads, 1);
            assert.equal(own(report, actor).assigned.total, 1);
            assert.equal(own(report, actor).assigned.new, 1);
            assert.equal(own(report, actor).activity.updatedEvents, 2);
            assert.equal(own(report, actor).activity.touchedLeads, 1);
            assert.equal(Date.parse(own(report, actor).activity.lastRecordedAt), Date.parse(result.fresh_at));
          }
        });
      }

      const revocations = [
        ['inactive membership', 'membership', (c, a) => c.query("update public.staff_users set status='inactive' where id=$1", [a.id])],
        ['demoted role', 'membership', (c, a) => c.query("update public.staff_users set role='lead_manager' where id=$1", [a.id])],
        ['changed auth binding', 'membership', (c, a) => c.query('update public.staff_users set auth_user_id=$2 where id=$1', [a.id, randomUUID()])],
        ['changed purpose', 'purpose', (c, a) => c.query(`update public.workspace_settings set value='{"purpose":"clinic_services"}'
          where workspace_id=$1 and key='workspace_purpose'`, [a.workspace])],
      ];
      for (const [name, gate, revoke] of revocations) {
        await t.test(`${name} before the accepted authorization lock returns only P7001, never a report`, async () => {
          const actor = await seed(db);
          const result = await delayedRead(fixture, db, actor, { gate, revoke: c => revoke(c, actor) });
          assert.equal(result.error?.code, 'P7001');
          assert.equal(Object.hasOwn(result, 'value'), false);
          await denied(read(db, actor));
        });
        await t.test(`${name} after accepted authorization waits until the report transaction completes`, async () => {
          const actor = await seed(db);
          const holder = await fixture.connect(), waiter = await fixture.connect();
          let pending;
          try {
            const holderPid = (await row(holder, 'select pg_backend_pid() as pid')).pid;
            const waiterPid = (await row(waiter, 'select pg_backend_pid() as pid')).pid;
            await holder.query('begin');
            const accepted = await read(holder, actor);
            assert.equal(accepted.workspaceId, actor.workspace);
            pending = observed(revoke(waiter, actor));
            await waitForBlock(db, waiterPid, holderPid);
            assert.equal((await read(holder, actor)).workspaceId, actor.workspace);
            await holder.query('commit');
            const outcome = await pending;
            if (outcome.error) throw outcome.error;
            await denied(read(db, actor));
          } finally {
            await holder.query('rollback').catch(() => {});
            if (pending) await pending;
            await holder.end();
            await waiter.end();
          }
        });
      }

      for (const isolation of ['repeatable read', 'serializable']) {
        await t.test(`${isolation} refuses an identity changed after its snapshot with 40001`, async () => {
          const actor = await seed(db);
          const holder = await fixture.connect(), waiter = await fixture.connect();
          let pending;
          try {
            const holderPid = (await row(holder, 'select pg_backend_pid() as pid')).pid;
            const waiterPid = (await row(waiter, 'select pg_backend_pid() as pid')).pid;
            await waiter.query(`begin isolation level ${isolation}`);
            await waiter.query('select count(*) from public.staff_users where id=$1', [actor.id]);
            await holder.query('begin');
            await holder.query("update public.staff_users set status='inactive' where id=$1", [actor.id]);
            pending = observed(read(waiter, actor));
            await waitForBlock(db, waiterPid, holderPid);
            await holder.query('commit');
            const outcome = await pending;
            assert.equal(outcome.error?.code, '40001');
            assert.equal(Object.hasOwn(outcome, 'value'), false);
          } finally {
            await holder.query('rollback').catch(() => {});
            await waiter.query('rollback').catch(() => {});
            if (pending) await pending;
            await holder.end();
            await waiter.end();
          }
        });
      }

      await t.test('fresh clock is not transaction time; invalid periods and role restrictions remain', async () => {
        const actor = await seed(db);
        for (const days of [null, 0, -1, 8, 31, 365]) await denied(read(db, actor, days), 'P8303');
        const manager = await seed(db, 'lead_manager');
        await denied(read(db, manager));
        await denied(read(db, { ...actor, auth: randomUUID() }));
        await db.query('begin');
        try {
          const bound = await row(db, 'select clock_timestamp()::text as at,transaction_timestamp()::text as transaction_at');
          const report = (await row(db, 'select public.read_lead_team_analytics($1,$2,$3) as report',
            [actor.workspace, actor.id, actor.auth])).report;
          const times = await row(db, `select $1::timestamptz>=$2::timestamptz as fresh,
            $1::timestamptz>$3::timestamptz as not_transaction_time`,
          [report.generatedAt, bound.at, bound.transaction_at]);
          assert.deepEqual(times, { fresh: true, not_transaction_time: true });
          assert.equal(report.period.days, 30);
        } finally { await db.query('rollback'); }
      });

      await t.test('private audit boundary inclusion and its caller snapshot remain unchanged', async () => {
        const actor = await seed(db), lead = randomUUID();
        const bounds = await row(db, `select clock_timestamp()-interval '7 days' as start,
          clock_timestamp() as finish`);
        await db.query(`insert into public.audit_logs
          (workspace_id,actor_staff_user_id,entity_id,action,actor_kind,entity_type,created_at)
          select $1,$2,$3,'updated','manual','lead',at from (
            values($4::timestamptz),($5::timestamptz),
              ($4::timestamptz-interval '1 microsecond'),($5::timestamptz+interval '1 microsecond')
          ) edges(at)`, [actor.workspace, actor.id, lead, bounds.start, bounds.finish]);
        const result = (await row(db, 'select public.read_lead_team_activity_snapshot($1,$2,$3) as result',
          [actor.workspace, bounds.start, bounds.finish])).result;
        assert.equal(result.complete, true);
        assert.equal(result.actors.length, 1);
        assert.equal(result.actors[0].updated, 2);
        assert.equal(result.actors[0].touched, 1);
        assert.equal(Date.parse(result.actors[0].last_at), bounds.finish.getTime());
        assert.equal((await row(db, 'select provolatile from pg_proc where oid=$1::regprocedure',
          [activitySignature])).provolatile, 's');
      });

      await t.test('business CTE and STABLE journal remain one coherent snapshot during a real table lock wait', async () => {
        const actor = await seed(db);
        const memberId = randomUUID(), auth = randomUUID(), stageId = randomUUID(), leadId = randomUUID();
        await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
          values($1,$2,$3,$4,'Snapshot A','lead_manager','active')`,
        [memberId, actor.workspace, auth, `${memberId}@example.invalid`]);
        await db.query(`insert into public.lead_stages(id,workspace_id,stage_key,name,semantic_group,is_active)
          values($1,$2,'synthetic_clock','Snapshot stage','new',true)`, [stageId, actor.workspace]);
        await db.query(`insert into public.leads(id,workspace_id,responsible_user_id,status,stage_id)
          values($1,$2,$3,'lost',$4)`, [leadId, actor.workspace, memberId, stageId]);
        await db.query(`insert into public.audit_logs(id,workspace_id,actor_staff_user_id,entity_id,action,actor_kind,entity_type,created_at)
          values($1,$2,$3,$4,'updated','manual','lead',clock_timestamp()-interval '1 minute')`,
        [leadId, actor.workspace, memberId, leadId]);
        const holder = await fixture.connect(), waiter = await fixture.connect();
        let pending;
        try {
          const holderPid = (await row(holder, 'select pg_backend_pid() as pid')).pid;
          const waiterPid = (await row(waiter, 'select pg_backend_pid() as pid')).pid;
          for (let round = 0; round < 4; round++) {
            const next = round % 2 === 0 ? 'B' : 'A';
            await holder.query('begin');
            await holder.query('lock table public.audit_logs in access exclusive mode');
            pending = observed(read(waiter, actor));
            await waitForBlock(db, waiterPid, holderPid);
            await holder.query('update public.staff_users set full_name=$2 where id=$1', [memberId, `Snapshot ${next}`]);
            await holder.query('update public.lead_stages set semantic_group=$2 where id=$1',
              [stageId, next === 'A' ? 'new' : 'booked']);
            await holder.query('update public.audit_logs set action=$2 where id=$1', [leadId, next === 'A' ? 'updated' : 'created']);
            await holder.query('commit');
            const result = await pending;
            pending = null;
            if (result.error) throw result.error;
            const member = result.value.members.find(item => item.staffId === memberId);
            assert.ok(member);
            assert.equal(result.value.totalLeads, 1);
            assert.equal(result.value.activityStatus, 'available');
            const old = member.name === 'Snapshot A';
            assert.equal(member.assigned.total, 1);
            assert.equal(member.assigned.new, old ? 1 : 0);
            assert.equal(member.assigned.booked, old ? 0 : 1);
            assert.equal(member.activity.updatedEvents, old ? 1 : 0);
            assert.equal(member.activity.createdEvents, old ? 0 : 1);
            const current = (await read(db, actor)).members.find(item => item.staffId === memberId);
            assert.equal(current.name, `Snapshot ${next}`);
          }
        } finally {
          await holder.query('rollback').catch(() => {});
          if (pending) await pending;
          await holder.end();
          await waiter.end();
        }
      });

      await t.test('service-only grants and private helper stay closed to browser roles', async () => {
        const actor = await seed(db);
        const caller = await fixture.connect();
        try {
          for (const role of ['anon', 'authenticated', 'service_role']) {
            assert.equal((await row(db, "select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).allowed,
              role === 'service_role');
            assert.equal((await row(db, "select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, activitySignature])).allowed, false);
            await caller.query(`set role ${role}`);
            if (role === 'service_role') assert.equal((await read(caller, actor)).workspaceId, actor.workspace);
            else await denied(read(caller, actor), '42501');
          }
          assert.equal((await row(db, `select count(*)::int as grants from pg_proc p
            cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
            where p.oid=$1::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE'`, [signature])).grants, 0);
        } finally { await caller.end(); }
      });
      assert.equal(digest(await readFile(path.join(root, baselineFile), 'utf8')), digest(baseline));
      assert.equal(digest(await readFile(path.join(root, candidateFile), 'utf8')), digest(candidate));
    } finally {
      await fixture.close();
      t.diagnostic('Owned PostgreSQL stopped and removed; no external database contacted');
    }
  });
