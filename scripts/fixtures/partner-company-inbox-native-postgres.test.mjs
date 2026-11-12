import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startPartnerCompanyNativeBase } from './partner-company-native-base.mjs';
import { exercisePartnerCompanyInboxNative, exercisePartnerCompanyInboxNativeHttp, exercisePartnerCompanyInboxRerunRefusals, partnerCompanyInboxFinancialSnapshot } from './partner-company-inbox-native-cases.mjs';

export async function runPartnerCompanyInboxNativeTests(base, reviewed, migration, t) {
  const { db, fixture, chain } = base;
  assert.deepEqual(chain.map(entry => [entry.file, entry.sha256]), reviewed.filter(entry => Number(entry.file.slice(0, 3)) <= 126).map(entry => [entry.file, entry.sha256]));
  assert.deepEqual(await partnerCompanyInboxFinancialSnapshot(db), []);
  await exercisePartnerCompanyInboxRerunRefusals(db, migration.source, t);
  await exercisePartnerCompanyInboxNative(db, fixture, migration.source, t);
  await exercisePartnerCompanyInboxNativeHttp(db, fixture, t);
  assert.deepEqual(await partnerCompanyInboxFinancialSnapshot(db), []);
  for (const { name } of (await db.query(`select c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' order by c.relname`)).rows) {
    assert.equal((await db.query('select count(*)::int n from public."' + name.replaceAll('"', '""') + '"')).rows[0].n, 0, 'All exact owned fixtures cleaned: ' + name);
  }
  t.diagnostic(`Reviewed ${chain[0].file} through ${chain.at(-1).file}; actual service RPCs, native lock waits, compiled HTTP, exact cleanup.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  test('126 own company inbox on owned native PostgreSQL and actual compiled HTTP; no external services', { timeout: 900000 }, async t => {
    assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1', 'Explicit owned native opt-in only; no remote DSN');
    const reviewed = await readReviewedChain(fileURLToPath(new URL('../../migrations/', import.meta.url)));
    const migration = reviewed.find(entry => entry.file === '126_partner_company_applicant_inbox.sql');
    assert.ok(migration, 'Require Main reviewed migration 126 before native startup');
    process.stderr.write(`Migration 126 native apply starting; sha256=${migration.sha256}\n`);
    let base;
    try { base = await startPartnerCompanyNativeBase(126); }
    catch (error) {
      process.stderr.write(`Migration 126 first native apply FAILED; code=${error.code ?? 'unknown'} position=${error.position ?? 'unknown'} message=${error.message}\n`);
      throw error;
    }
    t.after(() => base.close());
    process.stderr.write('Migration 126 first actual native apply succeeded\n');
    try { await base.db.query(migration.source); }
    catch (error) {
      process.stderr.write(`Migration 126 native reapply FAILED; code=${error.code ?? 'unknown'} position=${error.position ?? 'unknown'} message=${error.message}\n`);
      throw error;
    }
    process.stderr.write('Migration 126 actual native reapply succeeded\n');
    await runPartnerCompanyInboxNativeTests(base, reviewed, migration, t);
  });
}
