import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startNativePostgres } from './native-postgres.mjs';
import { digest, readReviewedChain } from './migration-chain-review.mjs';
import { legacyServerPrivilegeMatrix as directServiceResources } from './legacy-server-access-requirements.mjs';
import { exerciseLegacyAccessRefusals, legacyAccessSnapshot, proveLegacyAccessBaseline, proveLegacyAccessRepair } from './legacy-server-access-cases.mjs';

// Native application-chain acceptance, NOT an authority to release migrations.
// 001-008 require an undocumented legacy baseline; data/*.sql is deliberately
// not this application chain. No SQL is stripped, rewritten, or git-substituted.
// Supabase's Auth/Storage services are not simulated: only the two minimal
// Storage catalogue relations referenced by 015/016/087 are scaffolded. This
// proves PostgreSQL application compatibility, not remote Storage enforcement,
// Auth identity, API authorization, worker processing, delivery, or migration
// idempotency on existing/live datasets. Legacy RLS omissions are reported.

const directory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const browserRoles = ['anon', 'authenticated'];

async function role(db, name, action) {
  assert.ok([...browserRoles, 'service_role'].includes(name));
  await db.query(`set role ${quote(name)}`);
  let failure;
  try { return await action(); }
  catch (error) { failure = error; throw error; }
  finally {
    try { await db.query('reset role'); }
    catch (error) {
      // An unexpected RPC failure aborts its owned outer transaction. Preserve
      // that original error; the outer rollback restores the transaction's role.
      if (!failure || error.code !== '25P02') throw error;
    }
  }
}

async function rollback(db, action) {
  await db.query('begin');
  try { return await action(); } finally { await db.query('rollback'); }
}

async function denied(operation, code = '42501') {
  const result = await observed(operation);
  assert.equal(result.error?.code, code, result.error?.message ?? 'Unexpected success');
}

async function allPublicTables(db) {
  return (await db.query(`select c.oid::regclass::text as qualified,c.relname as name,c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') order by c.relname`)).rows;
}

async function requireEmptyBusinessData(db, tables) {
  for (const table of tables) assert.equal((await one(db, `select count(*)::int as n from public.${quote(table.name)}`)).n, 0,
    `${table.qualified}: source application must not provision/enable integrations, accounts, campaigns or monetary data`);
}

async function requireNoExternalFacilities(db, after = false) {
  assert.deepEqual((await db.query('select extname from pg_extension order by extname')).rows.map(item => item.extname),
    after ? ['pgcrypto', 'plpgsql'] : ['plpgsql'], 'No network, cron, foreign database or extra extension may enter this fixture');
  assert.equal((await one(db, 'show shared_preload_libraries')).shared_preload_libraries, '');
  for (const table of ['pg_foreign_server', 'pg_foreign_table', 'pg_subscription', 'pg_event_trigger']) {
    assert.equal((await one(db, `select count(*)::int as n from pg_catalog.${table}`)).n, 0, `${table} must be empty`);
  }
  assert.equal((await one(db, 'select count(*)::int as n from pg_listening_channels()')).n, 0,
    'No listener consumes the source migrations\' local pgrst reload notifications');
}

test('G7 cumulative 009-current reviewed SQL on attested PostgreSQL 17.11', { timeout: 480000 }, async t => {
  // Full membership, raw bytes, functions/languages and outward effects are
  // checked BEFORE starting even the owned server. No DSN is accepted anywhere.
  const chain = await readReviewedChain(directory);
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1',
    'Explicit MEDINA_TEST_POSTGRES_NATIVE=1 is required; no Docker/DSN fallback and no skip');
  const fixture = await startNativePostgres();
  t.after(() => fixture.close());
  const db = await fixture.connect();
  assert.equal((await one(db, 'show server_version_num')).server_version_num, '170011');
  assert.equal((await one(db, 'show listen_addresses')).listen_addresses, '127.0.0.1');
  assert.deepEqual(await one(db, 'select current_user, current_database() as db, pg_catalog.host(pg_catalog.inet_server_addr()) as host'),
    { current_user: 'postgres', db: 'medina_disposable_test', host: '127.0.0.1' });
  await requireNoExternalFacilities(db);
  const crypto = await one(db, "select default_version from pg_available_extensions where name='pgcrypto'");
  assert.ok(crypto?.default_version, '009 needs preinstalled pgcrypto files; never remove CREATE EXTENSION, install or download a fallback');
  assert.deepEqual(await allPublicTables(db), [], 'The owned database must have no prior application schema');

  // No auth.users, fake auth.uid(), application table/function or permissive
  // default privilege is added by this fixture. Every application ACL is SQL.
  await db.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
    alter table storage.objects enable row level security;`);
  const bootstrap = await one(db, `select to_regnamespace('auth') as auth,
    (select count(*)::int from pg_tables where schemaname='storage') as storage_tables,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('storage','public')) as routines`);
  assert.deepEqual(bootstrap, { auth: null, storage_tables: 2, routines: 0 });
  assert.deepEqual((await readReviewedChain(directory)).map(item => [item.file, item.sha256]), chain.map(item => [item.file, item.sha256]),
    'Source must remain identical while the owned native server starts');
  t.diagnostic('Only fresh attested loopback PostgreSQL 17.11; no Auth/Storage/cron/HTTP services, keys, providers or workers. Native query errors are not skipped.');
  t.diagnostic('Protected dirty 059 and restored 065 are executed exactly as read, not modified/staged/replaced. This is not an applied/released manifest.');

  let legacyBefore;
  for (const entry of chain) {
    if (entry.file === '099_application_function_default_access.sql') {
      await t.test('before 099, actual new application routine is still PUBLIC-callable despite 023', async () => rollback(db, async () => {
        await db.query("create function public.owned_chain_default_before_099() returns integer language sql as 'select 1'");
        for (const name of browserRoles) {
          assert.equal((await one(db, "select has_function_privilege($1,'public.owned_chain_default_before_099()','EXECUTE') as allowed", [name])).allowed, true);
          assert.equal((await role(db, name, () => one(db, 'select public.owned_chain_default_before_099() as value'))).value, 1);
        }
      }));
    }
    if (entry.file === '098_legacy_server_access.sql') {
      let baselinePassed = false;
      await t.test('before 098, reproduce all 17 actual native source-chain permission failures', async () => {
        const missing = await proveLegacyAccessBaseline(db);
        t.diagnostic(`Fresh-source-chain only, not cloud ACL evidence: ${missing.join(', ')}`);
        baselinePassed = true;
      });
      assert.ok(baselinePassed, 'Do not accept 098 without the original native failure proof');
      await exerciseLegacyAccessRefusals(db, entry.source, t);
      legacyBefore = await legacyAccessSnapshot(db);
    }
    let passed = false;
    await t.test(`apply original ${entry.file}`, async () => {
      try { await db.query(entry.source); }
      catch (error) {
        const position = Number(error.position);
        const line = Number.isInteger(position) && position > 0 ? entry.source.slice(0, position - 1).split('\n').length : 'server-context';
        await db.query('rollback');
        throw new Error(`${entry.file}:${line}: ${error.code ?? 'unknown'} ${error.message}; no SQL removal or compensating baseline is allowed`, { cause: error });
      }
      passed = true;
      t.diagnostic(`${entry.file} SHA-256 ${entry.sha256}; local notify=${entry.evidence.notifications.length}; dynamic SQL lines=${entry.evidence.dynamicSqlLines.join(',') || 'none'}`);
    });
    // Stop after the first failed migration. Running later steps on a partial
    // chain would mislabel dependent SQL as independently accepted.
    assert.ok(passed, `${entry.file} failed; the remaining cumulative gate is unexecuted`);
    if (entry.file === '098_legacy_server_access.sql') {
      let repaired = false;
      await t.test('098 cumulative repair changes only reviewed ACL/RLS, restores all 17 operations and is idempotent', async () => {
        await proveLegacyAccessRepair(db, legacyBefore, entry.source); repaired = true;
      });
      assert.ok(repaired, 'Do not continue cumulative acceptance after a failed 098 repair');
    }
  }

  const tables = await allPublicTables(db);
  await t.test('every source-created table is real; no unknown application baseline was added', async () => {
    const expected = [...new Set(chain.flatMap(entry => entry.evidence.tables))].sort();
    assert.deepEqual(tables.map(table => `public.${table.name}`).sort(), expected);
    const requiredRls = new Set(chain.flatMap(entry => entry.evidence.rls));
    for (const table of tables) if (requiredRls.has(`public.${table.name}`)) assert.equal(table.rls, true, `${table.name}: a later migration disabled required RLS`);
    t.diagnostic(`Authoritative legacy RLS omissions (not fixed or blessed by this gate): ${tables.filter(table => !table.rls).map(table => table.name).join(', ') || 'none'}`);
  });

  await t.test('entire cumulative chain creates no business records or external facilities', async () => {
    await requireEmptyBusinessData(db, tables);
    await requireNoExternalFacilities(db, true);
    const buckets = (await db.query('select id,name,public,file_size_limit from storage.buckets order by id')).rows;
    assert.deepEqual(buckets, [
      { id: 'ad-creatives', name: 'ad-creatives', public: true, file_size_limit: '104857600' },
      { id: 'ad-creatives-raw', name: 'ad-creatives-raw', public: false, file_size_limit: '524288000' },
      { id: 'ad-creatives-staging', name: 'ad-creatives-staging', public: false, file_size_limit: '104857600' },
    ]);
    const policy = await one(db, "select permissive,roles::text[] as roles,cmd,qual,with_check from pg_policies where schemaname='storage' and tablename='objects' and policyname='medina_staged_creatives_browser_guard'");
    assert.ok(policy); assert.equal(policy.permissive, 'RESTRICTIVE'); assert.equal(policy.cmd, 'ALL');
    assert.deepEqual([...policy.roles].sort(), [...browserRoles].sort());
    assert.match(policy.qual, /bucket_id IS DISTINCT FROM 'ad-creatives-staging'/); assert.equal(policy.qual, policy.with_check);
  });

  await t.test('last function bodies are installed cumulatively, including 081/094/095/096/097', async () => {
    const expected = new Map(chain.flatMap(entry => entry.evidence.functions.map(fn => [fn.name, { ...fn, file: entry.file }])));
    const functions = (await db.query(`select n.nspname||'.'||p.proname as name,p.prosrc as body,p.oid::regprocedure::text as signature
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')`)).rows;
    assert.deepEqual([...new Set(functions.map(fn => fn.name))].sort(), [...expected.keys()].sort());
    for (const fn of functions) assert.equal(fn.body, expected.get(fn.name)?.body, `${fn.signature}: final SQL differs from ${expected.get(fn.name)?.file}`);
  });

  await t.test('all browser table/column/sequence/function privileges remain closed after all candidates', async () => {
    for (const name of browserRoles) {
      assert.equal((await one(db, "select has_schema_privilege($1,'public','CREATE') as allowed", [name])).allowed, false);
      const leaks = (await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p','v','m','f') and
        (has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`, [name])).rows;
      assert.deepEqual(leaks, [], `${name}: effective inherited/PUBLIC/column ACL leak`);
      assert.deepEqual((await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and case when c.relkind='S'
          then has_sequence_privilege($1,c.oid,'SELECT,UPDATE,USAGE') else false end`, [name])).rows, []);
      assert.deepEqual((await db.query(`select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and has_function_privilege($1,p.oid,'EXECUTE')`, [name])).rows, []);
      await role(db, name, async () => {
        for (const table of tables) await denied(db.query(`select * from public.${quote(table.name)} limit 0`));
        await denied(db.query('select public.read_lead_team_analytics($1,$2,$3,30)', [randomUUID(), randomUUID(), randomUUID()]));
      });
    }
  });

  await t.test('099 global function defaults and existing table/sequence defaults protect future application objects', async () => rollback(db, async () => {
    await db.query(`create table public.owned_chain_default_probe(id bigint generated always as identity);
      create function public.owned_chain_default_probe() returns integer language sql as 'select 1'`);
    for (const name of browserRoles) {
      const result = await one(db, `select has_table_privilege($1,'public.owned_chain_default_probe','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as tab,
        has_any_column_privilege($1,'public.owned_chain_default_probe','SELECT,INSERT,UPDATE,REFERENCES') as col,
        has_sequence_privilege($1,pg_get_serial_sequence('public.owned_chain_default_probe','id'),'SELECT,UPDATE,USAGE') as seq,
        has_function_privilege($1,'public.owned_chain_default_probe()','EXECUTE') as fn`, [name]);
      assert.deepEqual(result, { tab: false, col: false, seq: false, fn: false });
      await role(db, name, async () => {
        await db.query('savepoint owned_default_denial');
        try { await denied(db.query('select public.owned_chain_default_probe()')); }
        finally { await db.query('rollback to savepoint owned_default_denial'); }
      });
    }
  }));

  await t.test('RPC-only and read-only server boundaries survive later migrations', async () => {
    for (const table of ['platform_subscription_operations', 'content_telegram_deliveries', 'content_telegram_delivery_guards']) {
      const result = await one(db, `select has_table_privilege('service_role',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as tab,
        has_any_column_privilege('service_role',$1,'SELECT,INSERT,UPDATE,REFERENCES') as col`, [`public.${table}`]);
      assert.deepEqual(result, { tab: false, col: false }, `${table}: no direct service access may be restored`);
    }
    for (const [table, select] of [['crm_site_consent_receipts', true], ['growth_operator_requests', true]]) {
      const result = await one(db, `select has_table_privilege('service_role',$1,'SELECT') as read,
        has_table_privilege('service_role',$1,'INSERT,UPDATE,DELETE,TRUNCATE') as write,
        has_any_column_privilege('service_role',$1,'INSERT,UPDATE') as column_write`, [`public.${table}`]);
      assert.deepEqual(result, { read: select, write: false, column_write: false }, `${table}: only the reviewed reader remains`);
    }
    for (const signature of ['public.accept_growth_operator_request(uuid,uuid)', 'public.lock_clinic_operator_actor(uuid,uuid,uuid)',
      'public.accept_crm_site_inquiry(text,uuid,jsonb)', 'public.valid_crm_site_consent_receipt(jsonb)']) {
      assert.equal((await one(db, "select has_function_privilege('service_role',$1,'EXECUTE') as allowed", [signature])).allowed, false, signature);
    }
    for (const name of ['create_clinic_operator_request', 'transition_clinic_operator_request', 'transition_growth_operator_request',
      'admit_content_telegram_delivery', 'advance_content_telegram_delivery', 'accept_crm_site_inquiry_with_consent',
      'read_lead_team_analytics', 'read_generated_video_workflow', 'read_platform_subscription_operation']) {
      const functions = (await db.query(`select p.oid::regprocedure::text as signature,has_function_privilege('service_role',p.oid,'EXECUTE') as allowed
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [name])).rows;
      assert.equal(functions.length, 1, name); assert.equal(functions[0].allowed, true, name);
    }
  });

  await t.test('fresh-chain service rights cover actual legacy content/advertising adapters without implicit cloud defaults', async () => {
    const missing = [];
    for (const [table, privileges] of Object.entries(directServiceResources)) {
      for (const privilege of privileges) {
        const result = await one(db, "select has_table_privilege('service_role',$1,$2) as allowed", [`public.${table}`, privilege]);
        if (!result.allowed) missing.push(`${table}:${privilege}`);
      }
      if (privileges.includes('SELECT')) {
        await role(db, 'service_role', async () => {
          const result = await observed(db.query(`select * from public.${quote(table)} limit 0`));
          if (result.error) {
            assert.equal(result.error.code, '42501', `${table}: record the actual native failure, not a guessed grant omission`);
            assert.ok(missing.includes(`${table}:SELECT`), `${table}: effective ACL inspection must agree with actual SQL`);
          } else assert.ok(!missing.includes(`${table}:SELECT`), `${table}: actual read must agree with effective ACL`);
        });
      }
    }
    assert.deepEqual(missing, [], 'Fresh application chain is not ready: add a separately reviewed forward repair, not blanket grants in the fixture or changes to old SQL');
  });

  await t.test('representative server RPCs compose with final triggers and grants, with complete rollback', async () => rollback(db, async () => {
    const workspace = randomUUID(), other = randomUUID(), staff = randomUUID(), auth = randomUUID();
    await role(db, 'service_role', async () => {
      await db.query("insert into public.workspaces(id,name) values($1,'Owned chain synthetic'),($2,'Owned chain foreign')", [workspace, other]);
      assert.equal((await one(db, 'select count(*)::int as n from public.lead_stages where workspace_id=$1', [workspace])).n, 5,
        '019 trigger + 080 new default + 091 narrowed seed grants compose under service_role');
      await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
        values($1,$2,$3,'chain@fixture.invalid','Synthetic chain administrator','admin','active')`, [staff, workspace, auth]);
      await db.query(`insert into public.workspace_settings(workspace_id,key,value) values($1,'workspace_purpose','{"purpose":"mortgage_leads"}'),
        ($1,'clinic_schedule','{"timeZone":"Asia/Almaty"}')`, [workspace]);
      const report = (await one(db, 'select public.read_lead_team_analytics($1,$2,$3,30) as value', [workspace, staff, auth])).value;
      assert.equal(report.workspaceId, workspace); assert.equal(report.totalLeads, 0); assert.equal(report.members.length, 1);
      assert.equal(report.generatedAt, report.period.to); assert.equal(report.activityStatus, 'available');
      assert.equal((await one(db, 'select public.read_generated_video_workflow($1,$2,$3,$4) as value', [workspace, staff, auth, 'v2:' + 'a'.repeat(64)])).value, null);
      assert.equal((await one(db, 'select public.read_platform_subscription_operation($1,$2,$3) as value', [auth, randomUUID(), workspace])).value, null);
    });
    const operator = randomUUID(), operatorAuth = randomUUID();
    await db.query(`insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at)
      values($1,$2,'Synthetic chain operator','approved',true,$3,clock_timestamp())`, [operator, operatorAuth, auth]);
    await role(db, 'service_role', async () => {
      const request = (await one(db, 'select public.create_clinic_operator_request($1,$2,$3,$4,$5,0::bigint,$6) as id',
        [workspace, staff, auth, operator, 'Synthetic technical terms, no payment or accrual', 'assigned'])).id;
      assert.equal((await one(db, 'select public.transition_clinic_operator_request($1,$2,$3,$4,$5) as id', [workspace, staff, auth, request, 'withdraw'])).id, request);
      const second = (await one(db, 'select public.create_clinic_operator_request($1,$2,$3,$4,$5,0::bigint,$6) as id',
        [workspace, staff, auth, operator, 'Synthetic technical terms, no payment or accrual', 'assigned'])).id;
      assert.equal((await one(db, 'select public.transition_growth_operator_request($1,$2,$3) as id', [second, operatorAuth, 'accept'])).id, second);
      assert.equal((await one(db, 'select public.transition_growth_operator_request($1,$2,$3) as id', [second, operatorAuth, 'end'])).id, second);
    });
    // The source Telegram RPC records a fake admission only. No Telegram API,
    // recipient/key, actual message, dispatch or success acknowledgement exists.
    const telegramText = '\u2705 Telegram \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d \u043a Medina OS Content Studio';
    await role(db, 'service_role', async () => {
      const result = (await one(db, 'select public.admit_content_telegram_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as value',
        [workspace, staff, auth, randomUUID(), '2000-01-01T00:00:00Z', 'test', randomUUID(),
          'b'.repeat(64), { text: telegramText, snapshot: {}, parts: [telegramText] }])).value;
      assert.equal(result.state, 'admitted');
    });
    const site = `chain-${randomUUID()}`, key = randomUUID();
    const notice = { version: 'synthetic-chain-v1', text: 'Synthetic local notice, not legal approval', purpose: 'Synthetic compatibility test',
      policyRevision: 'synthetic-1', policyUrl: 'https://fixture.invalid/synthetic' };
    const receipt = { ...notice, sha256: digest(JSON.stringify([notice.version, notice.text, notice.purpose, notice.policyRevision, notice.policyUrl])) };
    const inquiry = { name: 'Synthetic visitor', phone: '+77000000001', business: 'Synthetic business', service: 'call-center',
      pagePath: '/ru/', consentVersion: notice.version, consent: true };
    await db.query(`insert into public.crm_intake_sites(site_key,workspace_id,consent_version,allowed_page_paths,enabled)
      values($1,$2,$3,array['/ru/'],true)`, [site, workspace, notice.version]);
    await role(db, 'service_role', async () => {
      const call = () => one(db, 'select public.accept_crm_site_inquiry_with_consent($1,$2,$3::jsonb,$4::jsonb) as value', [site, key, inquiry, receipt]);
      assert.deepEqual((await call()).value, { accepted: true }); assert.deepEqual((await call()).value, { accepted: true });
    });
    await db.query('set constraints all immediate');
    assert.equal((await one(db, 'select count(*)::int as n from public.crm_site_consent_receipts where workspace_id=$1', [workspace])).n, 1);
    assert.equal((await one(db, 'select count(*)::int as n from public.leads where workspace_id=$1', [workspace])).n, 1);
    assert.equal((await one(db, 'select count(*)::int as n from public.leads where workspace_id=$1', [other])).n, 0);
    for (const table of ['content_generation_usage', 'platform_subscriptions', 'platform_subscription_payments', 'growth_partner_commissions',
      'growth_partner_payouts', 'deals', 'meta_campaign_launches', 'tiktok_campaign_launches', 'video_processing_jobs', 'ad_creative_assets']) {
      assert.equal((await one(db, `select count(*)::int as n from public.${quote(table)}`)).n, 0, `${table}: no generation, expense, campaign, sale, native job or payment`);
    }
  }));

  await t.test('all synthetic data rolled back and exact source receipts remain current', async () => {
    await requireEmptyBusinessData(db, tables);
    await requireNoExternalFacilities(db, true);
    assert.deepEqual((await readReviewedChain(directory)).map(entry => [entry.file, entry.sha256]), chain.map(entry => [entry.file, entry.sha256]));
    t.diagnostic(`Cumulative application only: ${chain[0].file} through ${chain.at(-1).file}; ${chain.length} exact SQL files. No claim about release, existing datasets, remote facilities or isolated concurrency suites.`);
  });
});
