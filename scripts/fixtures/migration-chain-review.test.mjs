import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { digest, inspectMigration, migrationReview, migrationTokens, preflightChain, readReviewedChain } from './migration-chain-review.mjs';

const directory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const chain = await readReviewedChain(directory);
const records = () => chain.map(({ file, source }) => ({ file, source }));

test('review covers the contiguous actual worktree 009-101, including protected 059/065 and coordinated candidates', () => {
  assert.equal(chain.length, 93);
  assert.deepEqual(chain.map(entry => Number(entry.file.slice(0, 3))), Array.from({ length: 93 }, (_, i) => i + 9));
  for (const entry of chain) assert.equal(digest(entry.source), migrationReview[entry.file]);
  assert.ok(Object.isFrozen(migrationReview));
  assert.ok(chain.every(entry => Object.isFrozen(entry)));
});

for (const kind of ['missing', 'unknown', 'duplicate', 'reordered', 'renamed']) test(`preflight rejects ${kind} chain membership before any native startup`, () => {
  const value = records();
  if (kind === 'missing') value.splice(31, 1);
  if (kind === 'unknown') value.push({ file: '102_unknown.sql', source: 'select 1;' });
  if (kind === 'duplicate') value.splice(20, 0, value[20]);
  if (kind === 'reordered') [value[0], value[1]] = [value[1], value[0]];
  if (kind === 'renamed') value[0] = { ...value[0], file: '009_changed.sql' };
  assert.throws(() => preflightChain(value), /Chain membership\/order changed/);
});

for (const suffix of [
  '\n-- a benign edit still needs a refreshed review receipt\n',
  "\nselect net.http_post('https://fixture.invalid');",
  "\nselect dblink_connect('remote');",
  "\nselect cron.schedule('* * * * *','select 1');",
  "\ncopy (select 1) to program 'fake';",
  "\ndo $$begin execute 'se' || 'lect pg_read_file(' || quote_literal('fake') || ')'; end$$;",
]) test(`any unreviewed source bytes stop admission (${suffix.trim().slice(0, 55)})`, () => {
  const value = records(); value[20].source += suffix;
  assert.throws(() => preflightChain(value), /source changed after outward-effect review/);
});

test('preflight reports installed-only pgcrypto and finite local Storage catalogue effects without editing SQL', () => {
  assert.deepEqual(chain.flatMap(entry => entry.evidence.extensions.map(extension => [entry.file, extension.name])),
    [['009_medcall_mvp_persistence.sql', 'pgcrypto']]);
  assert.deepEqual(chain.filter(entry => entry.evidence.storageCatalogueLines.length).map(entry => entry.file),
    ['015_ad_creative_assets.sql', '016_video_processing_jobs.sql', '087_staged_creative_foundation.sql']);
  assert.ok(chain.find(entry => entry.file.startsWith('009_')).source.includes('CREATE EXTENSION IF NOT EXISTS pgcrypto;'));
  assert.ok(chain.find(entry => entry.file.startsWith('059_')).source.includes('Private editorial drafts only'));
  assert.ok(chain.find(entry => entry.file.startsWith('065_')).evidence.functions.some(fn => fn.name === 'public.confirm_growth_operator_arrival'));
});

test('022 defines future claim state but contains no call to a scheduler or Meta', () => {
  const entry = chain.find(item => item.file.startsWith('022_'));
  assert.deepEqual(entry.evidence.tables, ['public.meta_insights_sync_state']);
  assert.equal(entry.evidence.dynamicSqlLines.length, 0);
  assert.equal(entry.evidence.notifications.length, 0);
  assert.ok(entry.evidence.functions.some(fn => fn.name === 'public.claim_due_meta_insights_sync_states'));
});

test('all local reload notifications are retained and every dynamic SQL line has its original source location', () => {
  assert.ok(chain.reduce((n, entry) => n + entry.evidence.notifications.length, 0) > 30);
  const dynamic = chain.filter(entry => entry.evidence.dynamicSqlLines.length);
  assert.deepEqual(dynamic.map(entry => Number(entry.file.slice(0, 3))), [62, 79, 82, 86, 88, 89, 90, 91]);
  for (const entry of dynamic) for (const line of entry.evidence.dynamicSqlLines) assert.match(entry.source.split('\n')[line - 1], /execute\s+format/i);
});

for (const sql of [
  'select net.http_post();', 'select "cron".schedule();', 'select dblink_connect();',
  'do $$begin perform pg_read_file(); end$$;', 'copy t to program \'fake\';',
  'create server external foreign data wrapper fake;', 'create subscription external connection \'fake\' publication p;',
  'create event trigger fake on ddl_command_end execute function public.fake();', 'alter system set x=1;',
  "load 'fake';", 'listen fake;', 'unlisten *;',
]) test(`effect inspection refuses an unapproved outward facility: ${sql.slice(0, 65)}`, () => {
  assert.throws(() => inspectMigration(sql), /Outward|External|outside this fixture/);
});

test('comments, quoted strings and nested dollar bodies do not invent source statements or hide unknown source hashes', () => {
  const source = `-- create extension unsafe;
    /* outer /* cron.schedule() */ select dblink(); */
    create function public.fake() returns text language sql as $body$select 'hello; -- comment'::text$body$;
    notify pgrst,'reload schema';`;
  const evidence = inspectMigration(source);
  assert.equal(evidence.functions.length, 1); assert.equal(evidence.functions[0].body, "select 'hello; -- comment'::text");
  assert.equal(evidence.notifications.length, 1); assert.deepEqual(evidence.extensions, []);
  const changed = records(); changed[0].source += source;
  assert.throws(() => preflightChain(changed), /source changed/);
});

for (const sql of ['create extension pg_net;', 'create extension if not exists pg_cron;',
  'create function public.fake() returns text language plpython3u as $$x$$;', "notify other,'reload schema';"]) {
  test(`unreviewed extension/language/notification fails closed: ${sql}`, () => {
    assert.throws(() => inspectMigration(sql), /preinstalled pgcrypto|SQL\/plpgsql|local PostgREST/);
  });
}

for (const value of ["'unfinished", '"unfinished', '$body$unfinished', '/* unfinished', '/* /* nested */']) {
  test(`unterminated review input fails closed: ${JSON.stringify(value)}`, () => assert.throws(() => migrationTokens(value), /Unterminated/));
}

test('native entry point preserves the existing owned PostgreSQL helper and does not choose any environment DSN', async () => {
  const source = await readFile(new URL('./migration-chain-native.test.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ startNativePostgres \} from '\.\/native-postgres\.mjs'/);
  assert.deepEqual([...source.matchAll(/process\.env\.([A-Z_]+)/g)].map(match => match[1]), ['MEDINA_TEST_POSTGRES_NATIVE']);
  assert.doesNotMatch(source, /(?:execFile|spawn|startDisposablePostgres|pg\.Client|DATABASE_URL|SUPABASE|git\s+show|\.replace\s*\()/);
  assert.match(source, /await db\.query\(entry\.source\)/);
  assert.ok(source.indexOf('await readReviewedChain(directory)') < source.indexOf('await startNativePostgres()'));
  assert.match(source, /assert\.ok\(crypto\?\.default_version/);
});
