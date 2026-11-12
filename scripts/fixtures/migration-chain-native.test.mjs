import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startNativePostgres } from './native-postgres.mjs';
import { digest, readReviewedChain } from './migration-chain-review.mjs';
import { legacyServerPrivilegeMatrix as directServiceResources } from './legacy-server-access-requirements.mjs';
import { exerciseLegacyAccessRefusals, legacyAccessSnapshot, proveLegacyAccessBaseline, proveLegacyAccessRepair } from './legacy-server-access-cases.mjs';
import { legacyCrmRlsSnapshot,exerciseLegacyCrmRlsRefusals,proveLegacyCrmRlsBaseline,
  proveLegacyCrmRlsChange,proveLegacyCrmRlsEnforcement } from './legacy-crm-rls-cases.mjs';
import { exerciseDeletionOperations } from './site-deletion-operations-cases.mjs';
import { proveDeletionOperationConcurrency } from './site-deletion-operations-native-cases.mjs';
import { reproduceNamesakeCapacityRefusal, exerciseCapacityIdentity, exerciseCapacityMigrationRefusals } from './appointment-capacity-identity-cases.mjs';
import { exerciseMortgageReportClock, exerciseReportClockRefusals } from './mortgage-report-clock-cases.mjs';
import { exerciseAnalyticsTimezone, exerciseAnalyticsTimezoneRefusals } from './analytics-timezone-cases.mjs';
import { exerciseContributorCumulative, exerciseDepartedOperatorAuthor } from './contributor-cumulative-cases.mjs';
import { reproduceUnboundVideoDispatch, exerciseVideoQuotaDispatch, exerciseVideoQuotaMissing } from './video-quota-dispatch-cases.mjs';
import { reproduceUnboundOperatorProposal, exerciseOperatorCommands } from './operator-command-recovery-fixture.mjs';
import { exerciseOperatorCommandClosure, operatorLegacySignatures } from './operator-command-closure-cases.mjs';
import { exercisePartnerLedger } from './partner-ledger-cases.mjs';
import { exerciseCreatorJobs, exerciseCreatorJobRefusals, reproduceUnfencedCreatorCommand } from './creator-job-cases.mjs';
import { exerciseCreatorClosure, exerciseCreatorClosureRefusals } from './creator-command-closure-cases.mjs';
import { exercisePartnerSources, partnerSourceHelpers } from './partner-source-cases.mjs';
import { exercisePartnerEntryAnchor } from './partner-entry-cases.mjs';
import { exercisePartnerEntryHttp } from './partner-entry-native-http-cases.mjs';
import { exercisePartnerTerms } from './partner-terms-cases.mjs';
import { exercisePartnerTermsHttp } from './partner-terms-native-http-cases.mjs';
import { exerciseFirstPaidWindow } from './partner-first-paid-window-cases.mjs';
import { exercisePartnerCompanyApproval } from './partner-company-approval-cases.mjs';
import { exercisePartnerHistory } from './partner-history-cases.mjs';
import { exercisePartnerHistoryHttp } from './partner-history-native-http-cases.mjs';
import { exerciseOperatorWorkday } from './operator-workday-cases.mjs';
import { exerciseOperatorWorkdayHttp } from './operator-workday-native-http-cases.mjs';
import { exerciseOperatorLeadSearch } from './operator-lead-search-cases.mjs';
import { exerciseOperatorLeadSearchHttp } from './operator-lead-search-native-http-cases.mjs';
import { exerciseAppointmentActor,exerciseAppointmentActorDependencies } from './appointment-actor-cases.mjs';
import { exerciseAppointmentReadiness,exerciseAppointmentReadinessBeforeCutover,exerciseAppointmentPatchReadinessBeforeCutover,exerciseAppointmentVersionReadinessBeforeCutover,exerciseAppointmentEntryReadinessBeforeCutover,exerciseAppointmentJournalReadinessBeforeCutover } from './appointment-actor-readiness-cases.mjs';
import { exerciseAppointmentVersionEntryBefore,exerciseAppointmentVersionEntry } from './appointment-version-entry-cases.mjs';
import { exerciseAppointmentPatch,exerciseAppointmentPatchDependencies } from './appointment-patch-cases.mjs';
import { exerciseAppointmentJournalBefore,exerciseAppointmentJournal } from './appointment-patch-journal-cases.mjs';
import { prepareAppointmentEditVersion,exerciseAppointmentEditVersion } from './appointment-edit-version-cases.mjs';

// Native application-chain acceptance, NOT an authority to release migrations.
// 001-008 require an undocumented legacy baseline; data/*.sql is deliberately
// not this application chain. No SQL is stripped, rewritten, or git-substituted.
// Supabase's Auth/Storage services are not simulated: only the two minimal
// Storage catalogue relations referenced by 015/016/087 are scaffolded. This
// proves PostgreSQL application compatibility, not remote Storage enforcement,
// Auth identity, API authorization, worker processing, delivery, or migration
// idempotency on existing/live datasets. Missing source-table RLS is a failure.

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

async function proveRlsAuthorityAfterWait(fixture,observer,sql,t) {
  const lock=await fixture.connect(),runner=await fixture.connect();
  try {
    const pid=(await one(runner,'select pg_backend_pid() as value')).value;
    for(const [name,change,restore,message] of [
      ['server bypass revoked','alter role service_role nobypassrls','alter role service_role bypassrls','legacy_crm_rls_roles_unconfirmed'],
      ['browser bypass added','alter role anon bypassrls','alter role anon nobypassrls','legacy_crm_rls_roles_unconfirmed'],
      ['browser privileged membership added','grant service_role to authenticated','revoke service_role from authenticated','legacy_crm_rls_role_membership_unconfirmed'],
    ]) {
      let passed=false;
      await t.test(`100 rechecks ${name} after a real native DDL lock wait`,async()=>{
        const before=await legacyCrmRlsSnapshot(observer);
        await lock.query('begin; lock table public.calls in access exclusive mode');
        const work=observed(runner.query(sql));let changed=false;
        try {
          const end=Date.now()+3500;let waiting=false;
          while(Date.now()<end) {
            if((await one(observer,'select wait_event_type from pg_stat_activity where pid=$1',[pid]))?.wait_event_type==='Lock') {waiting=true;break;}
            await delay(10);
          }
          assert.equal(waiting,true,'The exact migration transaction must be waiting on its owned table lock');
          await observer.query(change);changed=true;
          await lock.query('commit');
          assert.equal((await work).error?.message,message);
        } finally {
          await lock.query('rollback');await work;await runner.query('rollback');
          if(changed) await observer.query(restore);
        }
        assert.deepEqual(await legacyCrmRlsSnapshot(observer),before,'A concurrent authority change must leave all application state unchanged');
        passed=true;
      });
      assert.ok(passed,'Do not accept 100 after a failed concurrent-authority proof');
    }
  } finally {await lock.end();await runner.end();}
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
  t.diagnostic('Only fresh attested loopback PostgreSQL 17.11. Partner entry/terms also exercise owned loopback HTTP with synthetic external Auth; only entry uses synthetic Turnstile/notice data. No real Auth/Storage, cron, external providers or workers; native query errors are not skipped.');
  t.diagnostic('Protected dirty 059 and restored 065 are executed exactly as read, not modified/staged/replaced. This is not an applied/released manifest.');

  let legacyBefore;
  await exerciseVideoQuotaMissing(db,chain.find(entry=>entry.file==='106_generated_video_quota_dispatch.sql').source,t);
  let legacyRlsBefore;
  let verifyOldAppointmentVersion;
  for (const entry of chain) {
    if(entry.file==='119_appointment_patch_journal.sql'){
      await exerciseAppointmentJournalReadinessBeforeCutover(db,t);await exerciseAppointmentJournalBefore(db,entry.source,t);
    }
    if(entry.file==='118_appointment_version_entry.sql'){
      await exerciseAppointmentEntryReadinessBeforeCutover(db,t);
      await exerciseAppointmentVersionEntryBefore(db,entry.source,t);
    }
    if(entry.file==='117_appointment_edit_version.sql'){
      await exerciseAppointmentVersionReadinessBeforeCutover(db,t);
      verifyOldAppointmentVersion=await prepareAppointmentEditVersion(db,entry.source,t);
    }
    if(entry.file==='116_appointment_patch_actor.sql'){
      await exerciseAppointmentPatchReadinessBeforeCutover(db,t);await exerciseAppointmentPatchDependencies(db,entry.source,t);
    }
    if(entry.file==='115_appointment_request_actor.sql'){
      await exerciseAppointmentReadinessBeforeCutover(db,t);await exerciseAppointmentActorDependencies(db,entry.source,t);
    }
    if(entry.file==='111_creator_command_closure.sql'){
      await reproduceUnfencedCreatorCommand(db,t);await exerciseCreatorClosureRefusals(db,entry.source,t);
    }
    if(entry.file==='110_creator_job_workflow.sql')await exerciseCreatorJobRefusals(db,entry.source,t);
    if(entry.file==='106_generated_video_quota_dispatch.sql') await reproduceUnboundVideoDispatch(db,t);
    if(entry.file==='107_operator_request_commands.sql') await reproduceUnboundOperatorProposal(db,t);
    if (entry.file === '102_appointment_capacity_explicit_identity.sql') {
      let reproduced=false;
      await t.test('before 102, full 009-101 chain still refuses distinct linked namesakes', async () => {
        await reproduceNamesakeCapacityRefusal(db);reproduced=true;
      });
      assert.ok(reproduced,'Do not accept 102 without reproducing the actual prior refusal');
    }
    if (entry.file === '100_legacy_crm_row_security.sql') {
      let baselinePassed=false;
      await t.test('before 100, actual temporary read grant exposes both synthetic tenants on the seven unprotected tables',async()=>{
        await proveLegacyCrmRlsBaseline(db);baselinePassed=true;
      });
      assert.ok(baselinePassed,'Do not accept 100 without reproducing the missing RLS boundary');
      await exerciseLegacyCrmRlsRefusals(db,entry.source,t);
      await proveRlsAuthorityAfterWait(fixture,db,entry.source,t);
      legacyRlsBefore=await legacyCrmRlsSnapshot(db);
    }
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
    if(entry.file==='101_site_deletion_operations.sql') await exerciseDeletionOperations(db,t);
    if(entry.file==='102_appointment_capacity_explicit_identity.sql') {
      await exerciseCapacityMigrationRefusals(db,entry.source,t);
      await exerciseCapacityIdentity(db,t);
    }
    if(entry.file==='103_mortgage_report_clock.sql') {
      await exerciseReportClockRefusals(db,entry.source,t);
      await exerciseMortgageReportClock(db,t);
    }
    if(entry.file==='104_analytics_report_timezone.sql') {
      await exerciseAnalyticsTimezoneRefusals(db,entry.source,t);
      await exerciseAnalyticsTimezone(db,t);
    }
    if(entry.file==='105_contributor_applications.sql') await exerciseContributorCumulative(db,entry.source,t);
    if(entry.file==='106_generated_video_quota_dispatch.sql') await exerciseVideoQuotaDispatch(db,fixture,entry.source,t);
    if(entry.file==='107_operator_request_commands.sql') await exerciseOperatorCommands(db,fixture,entry.source,t);
    if(entry.file==='108_operator_command_closure.sql') await exerciseOperatorCommandClosure(db,fixture,entry.source,t);
    if(entry.file==='109_partner_ledger_read.sql') await exercisePartnerLedger(db,fixture,entry.source,t);
    if(entry.file==='110_creator_job_workflow.sql') await exerciseCreatorJobs(db,fixture,entry.source,t);
    if(entry.file==='111_creator_command_closure.sql') await exerciseCreatorClosure(db,fixture,entry.source,t);
    if(entry.file==='112_partner_first_source.sql') await exercisePartnerSources(db,fixture,entry.source,t);
    if(entry.file==='113_partner_entry_anchor.sql'){await exercisePartnerEntryAnchor(db,fixture,entry.source,t);await exercisePartnerEntryHttp(db,fixture,t);}
    if(entry.file==='114_partner_terms_activation.sql'){await exercisePartnerTerms(db,fixture,entry.source,t);await exercisePartnerTermsHttp(db,fixture,t);}
    if(entry.file==='115_appointment_request_actor.sql'){
      await exerciseAppointmentActor(db,fixture,t);
    }
    if(entry.file==='116_appointment_patch_actor.sql')await exerciseAppointmentPatch(db,fixture,t);
    if(entry.file==='117_appointment_edit_version.sql'){
      await verifyOldAppointmentVersion();await exerciseAppointmentEditVersion(db,entry.source,t);
    }
    if(entry.file==='118_appointment_version_entry.sql'){
      await exerciseAppointmentVersionEntry(db,entry.source,t);await exerciseAppointmentPatch(db,fixture,t,{versioned:true});
    }
    if(entry.file==='119_appointment_patch_journal.sql'){
      await exerciseAppointmentJournal(db,entry.source,t);
      await exerciseAppointmentPatch(db,fixture,t,{versioned:true,journaled:true});await exerciseAppointmentReadiness(db,t);
    }
    if(entry.file==='120_partner_first_paid_window.sql')await exerciseFirstPaidWindow(db,fixture,entry.source,t);
    if(entry.file==='121_partner_company_approval.sql')await exercisePartnerCompanyApproval(db,fixture,entry.source,t,{
      legacyPurge:chain.find(e=>e.file.startsWith('113_')).evidence.functions.find(f=>f.name==='public.purge_growth_partner_sources').body,
    });
    if(entry.file==='122_partner_history_read.sql'){await exercisePartnerHistory(db,fixture,entry.source,t);await exercisePartnerHistoryHttp(db,fixture,t);}
    if(entry.file==='123_operator_workday_read.sql'){await exerciseOperatorWorkday(db,fixture,entry.source,t);await exerciseOperatorWorkdayHttp(db,fixture,t);}
    if(entry.file==='124_operator_lead_search.sql'){await exerciseOperatorLeadSearch(db,fixture,entry.source,t);await exerciseOperatorLeadSearchHttp(db,fixture,t);}
    if(entry.file==='100_legacy_crm_row_security.sql') {
      let repaired=false;
      await t.test('100 changes only seven RLS flags and protects actual rows after an accidental DML grant, with full rollback',async()=>{
        await proveLegacyCrmRlsChange(db,legacyRlsBefore,entry.source);
        await proveLegacyCrmRlsEnforcement(db);repaired=true;
      });
      assert.ok(repaired,'Do not continue cumulative acceptance after a failed 100 protection proof');
    }
    if (entry.file === '098_legacy_server_access.sql') {
      let repaired = false;
      await t.test('098 cumulative repair changes only reviewed ACL/RLS, restores all 17 operations and is idempotent', async () => {
        await proveLegacyAccessRepair(db, legacyBefore, entry.source); repaired = true;
      });
      assert.ok(repaired, 'Do not continue cumulative acceptance after a failed 098 repair');
    }
  }

  await proveDeletionOperationConcurrency(fixture,db,t);
  await exerciseDepartedOperatorAuthor(db,t);
  const tables = await allPublicTables(db);
  await t.test('every source-created table is real; no unknown application baseline was added', async () => {
    const expected = [...new Set(chain.flatMap(entry => entry.evidence.tables))].sort();
    assert.deepEqual(tables.map(table => `public.${table.name}`).sort(), expected);
    const requiredRls = new Set(chain.flatMap(entry => entry.evidence.rls));
    for (const table of tables) if (requiredRls.has(`public.${table.name}`)) assert.equal(table.rls, true, `${table.name}: a later migration disabled required RLS`);
    assert.deepEqual(tables.filter(table=>!table.rls).map(table=>table.name),[],
      'Every application table in this exact chain needs RLS; this is not a claim about service-role tenant filtering');
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
    const originalPayment=chain.find(e=>e.file.startsWith('052_')).evidence.functions.find(f=>f.name==='public.confirm_growth_subscription_payment');
    expected.set('public.confirm_growth_subscription_payment_052',{...originalPayment,name:'public.confirm_growth_subscription_payment_052',file:'052 preserved privately by 120'});
    for(const name of ['submit_growth_partner_company','review_growth_partner_company']){
      const original=chain.find(e=>e.file.startsWith('121_')).evidence.functions.find(f=>f.name==='public.'+name);
      expected.set('public.'+name+'_121',{...original,name:'public.'+name+'_121',file:'121 preserved privately by 125'});
    }
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
    for (const table of ['platform_subscription_operations', 'content_telegram_deliveries', 'content_telegram_delivery_guards', 'site_deletion_operations','growth_operator_request_commands','growth_operator_command_fences',
      'growth_creator_jobs','growth_creator_submissions','growth_creator_commands','growth_creator_events','growth_creator_command_fences','growth_partner_sources','growth_partner_payment_windows','growth_partner_company_applications','growth_partner_company_submission_fences','growth_partner_company_review_fences','crm_appointment_request_actors']) {
      const result = await one(db, `select has_table_privilege('service_role',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as tab,
        has_any_column_privilege('service_role',$1,'SELECT,INSERT,UPDATE,REFERENCES') as col`, [`public.${table}`]);
      assert.deepEqual(result, { tab: false, col: false }, `${table}: no direct service access may be restored`);
    }
    for (const [table, select] of [['crm_site_consent_receipts', true], ['growth_operator_requests', true], ['growth_contributor_profiles', true],['appointments',true]]) {
      const result = await one(db, `select has_table_privilege('service_role',$1,'SELECT') as read,
        has_table_privilege('service_role',$1,'INSERT,UPDATE,DELETE,TRUNCATE') as write,
        has_any_column_privilege('service_role',$1,'INSERT,UPDATE') as column_write`, [`public.${table}`]);
      assert.deepEqual(result, { read: select, write: false, column_write: false }, `${table}: only the reviewed reader remains`);
    }
    for (const signature of ['public.accept_growth_operator_request(uuid,uuid)', 'public.lock_clinic_operator_actor(uuid,uuid,uuid)',
      'public.accept_crm_site_inquiry(text,uuid,jsonb)', 'public.valid_crm_site_consent_receipt(jsonb)',
      'public.delete_crm_site_inquiry(uuid,text,uuid,uuid[],timestamptz,uuid,uuid,uuid,boolean)',
      'public.lock_site_deletion_operation_actor(uuid,uuid,uuid)', 'public.validate_site_deletion_operation_request(jsonb)',
      'public.creator_job_actor(uuid,uuid,uuid)','public.creator_job_keys(jsonb,text[])','public.creator_job_text(jsonb,integer)','public.creator_job_links(jsonb)','public.creator_job_dto(uuid)',
      'public.execute_growth_creator_job(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb)','public.read_growth_creator_command(uuid,uuid,uuid,uuid)',
      'public.creator_command_result_v2(uuid,uuid,uuid,uuid,text,uuid)',
      'public.operator_request_command_receipt(public.growth_operator_request_commands)', 'public.confirm_operator_request_command(uuid,uuid,text,uuid,uuid,text)',
      ...operatorLegacySignatures,...partnerSourceHelpers,'public.bind_growth_referral(uuid,text,text)','public.bind_growth_partner_source(uuid,uuid,uuid)','public.capture_growth_partner_source(uuid,text,text,text)',
      'public.partner_terms_actor(uuid,text,uuid)','public.partner_terms_snapshot(public.growth_contributor_profiles)','public.lock_operator_command_reader(uuid,text,uuid,uuid)',
      'public.lock_crm_appointment_actor(uuid,uuid,uuid,text)','public.crm_appointment_targets_actor(jsonb,jsonb)',
      'public.read_crm_appointment_create_request(uuid,uuid,uuid,text)','public.create_crm_appointment_once(uuid,uuid,uuid,text,jsonb,jsonb,text)',
      'public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)','public.stamp_appointment_edit_version()',
      'public.confirm_growth_subscription_payment_052(uuid,uuid,bigint,text,timestamptz,uuid,uuid)',
      'public.valid_partner_company(jsonb)','public.guard_partner_company_application()',
      'public.partner_company_result(public.growth_partner_company_applications)',
      'public.submit_growth_partner_company_121(uuid,uuid,text,uuid,jsonb,text,jsonb)',
      'public.review_growth_partner_company_121(uuid,uuid,uuid,uuid,text)',
      'public.operator_workday_zone(text)','public.operator_workday_day_start(date,text)',
      'public.create_crm_appointment_with_new_client(uuid,jsonb,jsonb)',
      'public.operator_command_result_v2(uuid,uuid,text,uuid,uuid,text,uuid)',
      'public.site_deletion_operation_receipt(public.site_deletion_operations,boolean)']) {
      assert.equal((await one(db, "select has_function_privilege('service_role',$1,'EXECUTE') as allowed", [signature])).allowed, false, signature);
    }
    for (const name of ['admit_content_telegram_delivery', 'advance_content_telegram_delivery', 'accept_crm_site_inquiry_with_consent',
      'read_lead_team_analytics', 'read_generated_video_workflow', 'read_platform_subscription_operation',
      'prepare_site_deletion_operation', 'read_site_deletion_operations', 'execute_site_deletion_operation', 'close_site_deletion_operation',
      'apply_growth_contributor', 'review_growth_contributor','execute_clinic_operator_command_v2','execute_growth_operator_command_v2',
      'read_operator_request_command_v2','close_operator_request_command_v2','read_growth_partner_ledger','read_growth_partner_history','read_growth_operator_workday','read_growth_operator_lead_search',
      'read_growth_creator_jobs','execute_growth_creator_job_v2','read_growth_creator_command_v2','close_growth_creator_command_v2',
      'read_growth_creator_directory','read_growth_creator_job_detail',
      'capture_growth_partner_source_v2','purge_growth_partner_sources','claim_growth_partner_source','read_growth_partner_source',
      'submit_growth_partner_company','read_growth_partner_company','review_growth_partner_company',
      'read_growth_partner_company_submission','read_growth_partner_company_review','list_growth_partner_companies',
      'list_own_growth_partner_companies',
      'execute_growth_partner_terms','read_growth_partner_terms','confirm_growth_subscription_payment','read_crm_appointment_request_v2','create_crm_appointment_v2','patch_crm_appointment_journaled']) {
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
      const propose = async () => (await one(db,
        "select public.execute_clinic_operator_command_v2($1,$2,$3,$4,'propose',null,$5,$6,0::bigint,'assigned') value",
        [randomUUID(), workspace, staff, auth, operator, 'Synthetic technical terms, no payment or accrual'])).value;
      const first = await propose(); assert.equal(first.state, 'committed'); const request = first.requestId;
      const withdrawn = (await one(db,
        "select public.execute_clinic_operator_command_v2($1,$2,$3,$4,'withdraw',$5,null,null,null,null) value",
        [randomUUID(), workspace, staff, auth, request])).value;
      assert.equal(withdrawn.state, 'committed'); assert.equal(withdrawn.requestId, request); assert.equal(withdrawn.statusAtCommit, 'declined');
      const next = await propose(); assert.equal(next.state, 'committed'); const second = next.requestId;
      assert.notEqual(second, request);
      for (const action of ['accept', 'end']) {
        const result = (await one(db, 'select public.execute_growth_operator_command_v2($1,$2,$3,$4) value', [randomUUID(), second, operatorAuth, action])).value;
        assert.equal(result.state, 'committed'); assert.equal(result.requestId, second); assert.equal(result.action, action);
        assert.equal(result.statusAtCommit, action === 'accept' ? 'accepted' : 'ended');
      }
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
