import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startNativePostgres } from './native-postgres.mjs';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ACTOR, ENTRY_OTHER, ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';
import { startOwnedPartnerHttp } from './partner-entry-native-http-cases.mjs';

const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const readArgs = ['p_actor', 'p_side', 'p_profile', 'p_request', 'p_close', 'p_action'];
const financialTables = ['platform_subscription_payments', 'growth_partner_commissions', 'growth_partner_payouts',
  'platform_subscriptions', 'growth_referrals', 'workspaces', 'deals', 'growth_operator_arrivals'];
const linkTables = ['growth_contributor_profiles', 'growth_partners', 'growth_partner_terms',
  'growth_partner_term_commands', 'growth_partner_sources'];
const rowsSnapshot = async (db, tables) => (await db.query('select * from (' + tables.map(table =>
  `select '${table}' relation, to_jsonb(r) value from public.${table} r`).join(' union all ')
  + ') owned_snapshot order by relation, value::text')).rows;

async function accessSnapshot(db) {
  return (await db.query(`select * from (
    select 'relation' kind, c.oid::regclass::text name,
      jsonb_build_array(c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) value
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    union all select 'column',a.attrelid::regclass::text||'.'||a.attname,to_jsonb(a.attacl)
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and a.attnum>0 and not a.attisdropped
    union all select 'function',p.oid::regprocedure::text,jsonb_build_array(p.proowner,p.proacl,p.prosecdef,p.proconfig)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    union all select 'policy',p.polrelid::regclass::text||'.'||p.polname,to_jsonb(p) from pg_policy p
      join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    union all select 'schema',n.nspname,jsonb_build_array(n.nspowner,n.nspacl) from pg_namespace n where n.nspname='public'
    union all select 'default',d.oid::text,to_jsonb(d) from pg_default_acl d
    union all select 'role',r.rolname,jsonb_build_array(r.rolsuper,r.rolinherit,r.rolcanlogin,r.rolbypassrls)
      from pg_roles r where r.rolname in ('postgres','anon','authenticated','service_role')
    union all select 'membership',m.oid::text,to_jsonb(m) from pg_auth_members m
  ) access_snapshot order by kind,name`)).rows;
}

async function seedAccepted(db, fixture, owned, actor) {
  const applied = (await one(db, "select public.apply_growth_contributor($1,'Owned HTTP link partner',true,true,'{}') v", [actor])).v;
  const x = { actor, profile: applied.id, requests: [], partner: null, hasTerms: false };
  owned.push(x);
  const approved = (await one(db, "select public.review_growth_contributor($1,$2,$3,'partner','approve') v",
    [x.profile, applied.revision, ENTRY_ACTOR])).v;
  x.profileRevision = approved.revision;
  const client = await fixture.connect();
  try {
    await client.query('set role service_role');
    const execute = async (side, action, revision, payload) => {
      const request = randomUUID();
      const result = (await one(client, 'select public.execute_growth_partner_terms($1,$2,$3,$4,$5,$6,$7,$8) v',
        [side === 'platform' ? ENTRY_ACTOR : actor, side, x.profile, request, x.profileRevision, revision, action, payload])).v;
      x.requests.push(request);
      x.hasTerms = true;
      return result;
    };
    const offered = await execute('platform', 'offer', null,
      { firstCommissionBps: 1750, renewalCommissionBps: 650, terms: 'SYNTHETIC private link terms only' });
    const accepted = await execute('partner', 'accept', offered.result.agreement.revision, { accepted: true });
    x.agreement = accepted.result.agreement;
  } finally { await client.end(); }
  x.partner = (await one(db, 'select partner_id from public.growth_partner_terms where profile_id=$1', [x.profile])).partner_id;
  assert.equal(x.agreement.state, 'accepted');
  assert.equal(x.agreement.commercialStatus, 'active');
  assert.match(x.agreement.referralCode, /^[A-F0-9]{32}$/);
  return x;
}

async function cleanup(db, owned) {
  for (const x of owned) {
    const commands = await db.query(`delete from public.growth_partner_term_commands
      where profile_id=$1 and request_key=any($2::uuid[]) and actor_id=any($3::uuid[])`,
    [x.profile, x.requests, [ENTRY_ACTOR, x.actor]]);
    assert.equal(commands.rowCount, x.requests.length, 'Only the exact owned terms commands are removed');
    assert.equal((await db.query('delete from public.growth_partner_terms where profile_id=$1', [x.profile])).rowCount, Number(x.hasTerms));
    if (x.partner) assert.equal((await db.query('delete from public.growth_partners where id=$1 and auth_user_id=$2',
      [x.partner, x.actor])).rowCount, 1);
    assert.equal((await db.query('delete from public.growth_contributor_profiles where id=$1 and auth_user_id=$2',
      [x.profile, x.actor])).rowCount, 1);
  }
}

test('partner link actual compiled HTTP/router -> existing terms reader -> owned native PostgreSQL; no financial writes',
  { timeout: 300000 }, async t => {
    assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1', 'Explicit local native PostgreSQL opt-in; no DSN fallback');
    const directory = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const chain = await readReviewedChain(directory);
    const fixture = await startNativePostgres();
    let db, http, server, financialBefore, accessBefore;
    const owned = [], calls = [], sqlErrors = [];
    t.after(async () => {
      try {
        await server?.close();
        http?.close();
        if (db) {
          await cleanup(db, owned);
          if (financialBefore) assert.deepEqual(await rowsSnapshot(db, financialTables), financialBefore, 'Financial data unchanged after exact owned cleanup');
          if (accessBefore) assert.deepEqual(await accessSnapshot(db), accessBefore, 'All public ACL/RLS and role memberships preserved');
          for (const { name } of (await db.query(`select c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='r' order by c.relname`)).rows)
            assert.equal((await one(db, 'select count(*)::int n from public."' + name.replaceAll('"', '""') + '"')).n, 0,
              'No synthetic business rows remain: ' + name);
        }
        if (http) {
          assert.deepEqual(http.state.unexpected, []);
          assert.deepEqual(http.state.challenges, []);
        }
        if (server) assert.deepEqual(server.state.errors, []);
      } finally { stopPartnerEntryBuilds(); await fixture.close(); }
    });
    db = await fixture.connect();
    assert.deepEqual(await one(db, 'select current_user,current_database() db,host(inet_server_addr()) host'),
      { current_user: 'postgres', db: 'medina_disposable_test', host: '127.0.0.1' });
    assert.equal((await one(db, 'show server_version_num')).server_version_num, '170011');
    assert.deepEqual((await readReviewedChain(directory)).map(e => [e.file, e.sha256]), chain.map(e => [e.file, e.sha256]),
      'Reviewed raw migration bytes must remain unchanged during native startup');
    await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
      alter table storage.objects enable row level security;`);
    for (const entry of chain) await db.query(entry.source);
    financialBefore = await rowsSnapshot(db, financialTables);
    assert.deepEqual(financialBefore, [], 'No financial fixtures or company accounts are provisioned');
    accessBefore = await accessSnapshot(db);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const table of ['growth_partner_terms', 'growth_partner_term_commands']) {
        assert.equal((await one(db, "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') yes", [role, 'public.' + table])).yes, false);
        assert.equal((await one(db, "select has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') yes", [role, 'public.' + table])).yes, false);
      }
      assert.equal((await one(db, "select has_function_privilege($1,'public.read_growth_partner_terms(uuid,text,uuid,uuid,boolean,text)','EXECUTE') yes", [role])).yes,
        role === 'service_role');
    }
    assert.equal((await one(db, "select has_table_privilege('service_role','public.growth_partners','INSERT,UPDATE,DELETE,TRUNCATE') yes")).yes, false);
    const own = await seedAccepted(db, fixture, owned, ENTRY_OTHER), foreign = await seedAccepted(db, fixture, owned, randomUUID());
    const adapter = { async rpc(name, args) {
      assert.equal(name, 'read_growth_partner_terms', 'Link GET must use only the existing reader, never a financial or terms writer');
      assert.deepEqual(Object.keys(args).sort(), [...readArgs].sort());
      assert.equal(args.p_side, 'partner');
      assert.equal(args.p_request, null);
      assert.equal(args.p_close, false);
      assert.equal(args.p_action, null);
      calls.push({ name, args: structuredClone(args) });
      const client = await fixture.connect();
      try {
        await client.query('set role service_role');
        const data = (await one(client, 'select public.read_growth_partner_terms($1,$2,$3,$4,$5,$6) v', readArgs.map(key => args[key]))).v;
        return { data, error: null };
      } catch (error) {
        sqlErrors.push(error.code);
        return { data: null, error: { code: error.code, message: 'PRIVATE_LINK_SQL_DIAGNOSTIC' } };
      } finally { await client.end(); }
    } };
    http = await partnerEntryHttpFixture(adapter);
    server = await startOwnedPartnerHttp(http.handler, ['/api/crm/partner-link']);
    async function call(profile = own.profile) {
      const before = await rowsSnapshot(db, [...linkTables, ...financialTables]), count = calls.length;
      const authCount = http.state.auth.length;
      const response = await fetch(server.origin + '/api/crm/partner-link?' + new URLSearchParams({ profileId: profile }),
        { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { Origin: ENTRY_ORIGIN, Authorization: 'Bearer owned.other.signature' } });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const value = await response.json();
      assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|SYNTHETIC private|owned-only-not-credential|auth_user_id|offered_by|decided_by/);
      assert.deepEqual(calls.slice(count), [{ name: 'read_growth_partner_terms', args: {
        p_actor: ENTRY_OTHER, p_side: 'partner', p_profile: profile, p_request: null, p_close: false, p_action: null,
      } }], 'Actual router must forward the verified actor and exact profile to native SQL');
      assert.ok(http.state.auth.length > authCount, 'Each real HTTP request must verify identity');
      assert.ok(http.state.auth.slice(authCount).every(token => token === 'Bearer owned.other.signature'), 'Only the request identity is verified');
      assert.deepEqual(await rowsSnapshot(db, [...linkTables, ...financialTables]), before, 'GET must not change terms, code, receipts, sources or financial data');
      return { status: response.status, value };
    }
    const denied = async profile => assert.deepEqual(await call(profile),
      { status: 403, value: { success: false, code: 'partner_link_access_denied' } });
    await t.test('approved own active accepted terms return the exact server-confirmed referral link', async () => {
      assert.deepEqual(await call(), { status: 200, value: { success: true, data: {
        profileId: own.profile, profileRevision: own.profileRevision, agreementRevision: own.agreement.revision,
        referralCode: own.agreement.referralCode, url: ENTRY_ORIGIN + '/r/' + own.agreement.referralCode,
        policyVersion: '2026-10-27-7d-self-v1',
      } } });
    });
    await t.test('a foreign approved active accepted profile cannot disclose its link to the verified actor', async () => {
      assert.notEqual(foreign.agreement.referralCode, own.agreement.referralCode);
      await denied(foreign.profile);
    });
    await t.test('revoked partner approval denies the previously available own link', async () => {
      try {
        assert.equal((await db.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1 and auth_user_id=$2",
          [own.profile, own.actor])).rowCount, 1);
        await denied(own.profile);
      } finally { await db.query("update public.growth_contributor_profiles set partner_status='approved' where id=$1 and auth_user_id=$2", [own.profile, own.actor]); }
    });
    await t.test('commercial suspension denies accepted terms even while contributor approval remains active', async () => {
      assert.equal((await one(db, 'select partner_status from public.growth_contributor_profiles where id=$1', [own.profile])).partner_status, 'approved');
      assert.equal((await db.query("update public.growth_partners set status='suspended' where id=$1 and auth_user_id=$2", [own.partner, own.actor])).rowCount, 1);
      await denied(own.profile);
    });
    assert.deepEqual(sqlErrors, ['P1141', 'P1141', 'P1141'], 'Every denial is the real SQL authority check, not an HTTP stub');
    assert.equal(calls.length, 4);
    assert.deepEqual(await rowsSnapshot(db, financialTables), financialBefore, 'Activation and link reads never write financial data');
    assert.deepEqual(await accessSnapshot(db), accessBefore, 'Link path does not widen application access');
    t.diagnostic(`Reviewed full chain ${chain[0].file} through ${chain.at(-1).file}; 4 real HTTP reads; 3 native P1141 denials; exact owned cleanup and financial/ACL snapshots.`);
  });
