import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startPartnerCompanyNativeBase } from './partner-company-native-base.mjs';
import { exercisePartnerCompanyCommandClosure, exercisePartnerCompanyCommandNativeHttp, partnerCompanyFinancialSnapshot } from './partner-company-command-native-http-cases.mjs';

test('125 actual compiled HTTP to owned native partner-company closure and queue; no external services', { timeout: 300000 }, async t => {
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1', 'Explicit owned native opt-in only; no remote DSN');
  const reviewed = await readReviewedChain(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const migration = reviewed.find(entry => entry.file === '125_partner_company_command_recovery.sql');
  assert.ok(migration, 'Require Main reviewed migration 125 before native startup');
  process.stderr.write(`Migration 125 native apply starting; sha256=${migration.sha256}\n`);
  let base;
  try { base = await startPartnerCompanyNativeBase(125); }
  catch (error) {
    process.stderr.write(`Migration 125 native apply FAILED; code=${error.code ?? 'unknown'} position=${error.position ?? 'unknown'} message=${error.message}\n`);
    throw error;
  }
  t.after(() => base.close());
  const { db, fixture, chain } = base;
  assert.deepEqual(chain.map(e => [e.file, e.sha256]), reviewed.filter(e => Number(e.file.slice(0, 3)) <= 125).map(e => [e.file, e.sha256]));
  process.stderr.write('Migration 125 first native apply succeeded\n');
  try { await db.query(migration.source); }
  catch (error) {
    process.stderr.write(`Migration 125 native reapply FAILED; code=${error.code ?? 'unknown'} position=${error.position ?? 'unknown'} message=${error.message}\n`);
    throw error;
  }
  process.stderr.write('Migration 125 native reapply succeeded\n');
  t.diagnostic('Migration 125 applied through Main native base and reapplied successfully before behavior cases');
  assert.deepEqual(await partnerCompanyFinancialSnapshot(db), []);
  await exercisePartnerCompanyCommandClosure(db, fixture, migration.source, t);
  await exercisePartnerCompanyCommandNativeHttp(db, fixture, t);
  assert.deepEqual(await partnerCompanyFinancialSnapshot(db), []);
  for (const { name } of (await db.query(`select relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' order by relname`)).rows)
    assert.equal((await db.query('select count(*)::int v from public."' + name.replaceAll('"', '""') + '"')).rows[0].v, 0, 'All exact owned fixtures cleaned: ' + name);
  t.diagnostic(`Reviewed ${chain[0].file} through ${chain.at(-1).file}; real lock waits and exact owned cleanup.`);
});
