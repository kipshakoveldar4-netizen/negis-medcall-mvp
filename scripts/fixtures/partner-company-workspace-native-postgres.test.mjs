import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startPartnerCompanyNativeBase } from './partner-company-native-base.mjs';
import { stopPartnerEntryBuilds } from './partner-entry-http-fixture.mjs';
import { exercisePartnerCompanyWorkspaceNativeHttp, partnerCompanyWorkspaceSnapshot } from './partner-company-workspace-native-cases.mjs';

export async function runPartnerCompanyWorkspaceNativeTests(base, reviewed, t) {
  const { db, fixture, chain } = base;
  const expected = reviewed.filter(entry => Number(entry.file.slice(0, 3)) <= 126);
  assert.deepEqual(chain.map(entry => [entry.file, entry.sha256]), expected.map(entry => [entry.file, entry.sha256]));
  assert.equal(chain.length, 118);
  assert.ok(chain[0].file.startsWith('009_'));
  assert.equal(chain.at(-1).file, '126_partner_company_applicant_inbox.sql');
  assert.deepEqual(await partnerCompanyWorkspaceSnapshot(db), []);
  const metrics = await exercisePartnerCompanyWorkspaceNativeHttp(db, fixture, t);
  assert.deepEqual(await partnerCompanyWorkspaceSnapshot(db), []);
  for (const { name } of (await db.query(`select c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' order by c.relname`)).rows) {
    assert.equal((await db.query('select count(*)::int n from public."' + name.replaceAll('"', '""') + '"')).rows[0].n, 0,
      'All owned native workspace fixtures removed: ' + name);
  }
  t.diagnostic(`${chain.length} reviewed migrations 009-126; ${metrics.http} owned HTTP requests, ${metrics.rpc} actual service_role reads, ${metrics.waits.length} pg_blocking_pids-proven waits; exact financial/company snapshots and all-public-table cleanup passed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  test('approved partner-company workspace on owned native PostgreSQL through actual compiled HTTP', { timeout: 900000 }, async t => {
    assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1', 'Explicit owned native opt-in only; no external DSN');
    const reviewed = await readReviewedChain(fileURLToPath(new URL('../../migrations/', import.meta.url)));
    assert.equal(reviewed.at(-1).file, '126_partner_company_applicant_inbox.sql');
    process.stderr.write('Workspace native endpoint integration starting once; reviewed 009-126; owned loopback PostgreSQL only.\n');
    let base;
    try {
      base = await startPartnerCompanyNativeBase(126);
      process.stderr.write('Owned native 009-126 apply complete; beginning focused compiled HTTP workspace cases.\n');
      await runPartnerCompanyWorkspaceNativeTests(base, reviewed, t);
    } finally {
      try { if (base) await base.close(); }
      finally { stopPartnerEntryBuilds(); }
    }
  });
}
