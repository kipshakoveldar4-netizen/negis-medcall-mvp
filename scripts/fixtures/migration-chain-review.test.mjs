import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { digest, inspectMigration, migrationReview, migrationTokens, preflightChain, readReviewedChain } from './migration-chain-review.mjs';

const directory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const chain = await readReviewedChain(directory);
const records = () => chain.map(({ file, source }) => ({ file, source }));

test('review covers the contiguous actual worktree 009-126, including protected 059/065 and coordinated candidates', () => {
  assert.equal(chain.length, 118);
  assert.deepEqual(chain.map(entry => Number(entry.file.slice(0, 3))), Array.from({ length: 118 }, (_, i) => i + 9));
  for (const entry of chain) assert.equal(digest(entry.source), migrationReview[entry.file]);
  assert.ok(Object.isFrozen(migrationReview));
  assert.ok(chain.every(entry => Object.isFrozen(entry)));
});

test('126 adds only a service-only own-company inbox with no body, table, provider or financial writes',()=>{
  const e=chain.find(v=>v.file.startsWith('126_'));
  assert.deepEqual(e.evidence.tables,[]);assert.deepEqual(e.evidence.rls,[]);
  assert.deepEqual(e.evidence.functions.map(f=>f.name),['public.list_own_growth_partner_companies']);
  assert.deepEqual(e.evidence.dynamicSqlLines,[]);assert.deepEqual(e.evidence.extensions,[]);assert.deepEqual(e.evidence.storageCatalogueLines,[]);
  assert.match(e.source,/a\.applicant_auth_user_id=p_actor/);assert.match(e.source,/s\.role='owner' and s\.status='active'/);
  assert.match(e.source,/offset p_offset limit 21/);assert.match(e.source,/P1262/);
  assert.match(e.source,/item:=public\.read_growth_partner_company\(p_actor,candidate\.id\)/);
  assert.doesNotMatch(e.source,/grant\s+(?:select|insert|update|delete)|(?:insert into|update|delete from) public\./i);
});

test('125 closes absent company commands without rewriting 121, direct browser access, finance or provider effects',()=>{
  const e=chain.find(v=>v.file.startsWith('125_'));
  assert.deepEqual(e.evidence.tables,['public.growth_partner_company_submission_fences','public.growth_partner_company_review_fences']);
  assert.deepEqual(e.evidence.rls,e.evidence.tables);
  assert.deepEqual(e.evidence.functions.map(f=>f.name),['public.submit_growth_partner_company','public.review_growth_partner_company',
    'public.read_growth_partner_company_submission','public.read_growth_partner_company_review','public.list_growth_partner_companies']);
  assert.deepEqual(e.evidence.dynamicSqlLines,[]);assert.deepEqual(e.evidence.extensions,[]);assert.deepEqual(e.evidence.storageCatalogueLines,[]);
  for(const name of ['submit_growth_partner_company','review_growth_partner_company']){
    const original=chain.find(v=>v.file.startsWith('121_')).evidence.functions.find(f=>f.name==='public.'+name);
    assert.ok(e.source.includes(digest(original.body.replaceAll('\r\n','\n'))));
    assert.match(e.source,new RegExp('rename to '+name+'_121'));
  }
  assert.match(e.source,/offset p_offset limit 21/);assert.match(e.source,/P1252/);assert.match(e.source,/P1253/);
  assert.doesNotMatch(e.source,/grant\s+(?:select|insert|update|delete)|on\s+delete\s+cascade|(?:insert into|update|delete from) public\.(?:platform_subscription|growth_referrals|growth_partner_commissions|growth_partner_payouts|workspaces|staff_users)/i);
});

test('124 adds only a complete authorized search reader without business writes or browser grants',()=>{
  const e=chain.find(v=>v.file.startsWith('124_'));
  assert.deepEqual(e.evidence.tables,[]);assert.deepEqual(e.evidence.functions.map(f=>f.name),['public.read_growth_operator_lead_search']);
  assert.deepEqual(e.evidence.dynamicSqlLines,[]);assert.deepEqual(e.evidence.extensions,[]);assert.deepEqual(e.evidence.storageCatalogueLines,[]);
  assert.match(e.source,/report_clock as materialized/);assert.match(e.source,/cardinality\(v_locked\)/);assert.match(e.source,/strpos\(/);
  assert.doesNotMatch(e.source,/(?:insert into|update|delete from) public\./i);
});

test('123 adds only a complete own-workday reader and private native-zone helper without business writes',()=>{
  const e=chain.find(v=>v.file.startsWith('123_'));
  assert.deepEqual(e.evidence.tables,[]);assert.deepEqual(e.evidence.functions.map(f=>f.name),['public.operator_workday_zone','public.operator_workday_day_start','public.read_growth_operator_workday']);
  assert.deepEqual(e.evidence.dynamicSqlLines,[]);assert.deepEqual(e.evidence.storageCatalogueLines,[]);assert.deepEqual(e.evidence.extensions,[]);
  assert.match(e.source,/report_clock as materialized/);assert.match(e.source,/cardinality\(v_locked\)/);
  assert.match(e.source,/join accessible x/);assert.match(e.source,/s\.is_active/);assert.match(e.source,/d\.is_active/);
  assert.match(e.source,/revoke all on function public\.operator_workday_day_start\(date,text\) from public,anon,authenticated,service_role/);
  assert.doesNotMatch(e.source,/(?:insert into|update|delete from) public\./i);
});

test('122 adds a single authority-locked journal reader without business writes or browser grants',()=>{
  const e=chain.find(v=>v.file.startsWith('122_'));
  assert.deepEqual(e.evidence.tables,[]);assert.deepEqual(e.evidence.functions.map(f=>f.name),['public.read_growth_partner_history']);
  assert.deepEqual(e.evidence.dynamicSqlLines,[]);assert.deepEqual(e.evidence.storageCatalogueLines,[]);assert.deepEqual(e.evidence.extensions,[]);
  assert.match(e.source,/authority:=public\.read_growth_partner_ledger\(p_actor\)/);assert.match(e.source,/offset p_offset limit 21/);
  assert.match(e.source,/kind collate "C"/);assert.match(e.source,/grant execute on function public\.read_growth_partner_history\(uuid,integer,text\) to service_role/);
  assert.doesNotMatch(e.source,/grant\s+(?:select|insert|update|delete)|(?:insert into|update|delete from) public\./i);
});

test('121 creates only a private application and an explicitly approved company, without accounts or money',()=>{
  const e=chain.find(v=>v.file.startsWith('121_'));
  assert.deepEqual(e.evidence.tables,['public.growth_partner_company_applications']);assert.deepEqual(e.evidence.rls,e.evidence.tables);
  assert.equal(e.evidence.functions.length,7);assert.deepEqual(e.evidence.dynamicSqlLines,[]);assert.deepEqual(e.evidence.storageCatalogueLines,[]);
  assert.match(e.source,/revoke all on function public\.bind_growth_partner_source\(uuid,uuid,uuid\) from public,anon,authenticated,service_role/);
  assert.doesNotMatch(e.source,/grant\s+(?:select|insert|update|delete)|on\s+delete\s+cascade|(?:insert into|update|delete from) public\.(?:platform_subscriptions|platform_subscription_payments|growth_referrals|growth_partner_commissions|growth_partner_payouts)/i);
});

test('120 stages the original source and creates paid attribution only through the private original financial writer',()=>{
  const e=chain.find(v=>v.file.startsWith('120_'));
  assert.deepEqual(e.evidence.tables,['public.growth_partner_payment_windows']);assert.deepEqual(e.evidence.rls,e.evidence.tables);
  assert.deepEqual(e.evidence.functions.map(f=>f.name),['public.partner_source_result','public.bind_growth_partner_source','public.confirm_growth_subscription_payment']);
  assert.deepEqual(e.evidence.dynamicSqlLines,[]);assert.deepEqual(e.evidence.storageCatalogueLines,[]);assert.deepEqual(e.evidence.extensions,[]);
  assert.ok(e.source.includes(digest(chain.find(v=>v.file.startsWith('052_')).evidence.functions.find(f=>f.name==='public.confirm_growth_subscription_payment').body.replaceAll('\r\n','\n'))));
  assert.match(e.source,/rename to confirm_growth_subscription_payment_052/);
  assert.match(e.source,/p_paid_at>=saved\.captured_at.*p_paid_at<saved\.expires_at/);
  assert.match(e.source,/partner_payment_legacy_review_required/);
  assert.doesNotMatch(e.source,/grant\s+(?:select|insert|update|delete)|on\s+delete\s+cascade|(?:insert into|update|delete from) public\.(?:staff_users|workspaces|growth_contributor_profiles|growth_partner_commissions|growth_partner_payouts)/i);
});

test('107 adds only private committed operator command receipts and leaves the 096 implementation intact',()=>{
  const entry=chain.find(item=>item.file.startsWith('107_'));
  assert.deepEqual(entry.evidence.tables,['public.growth_operator_request_commands']);
  assert.deepEqual(entry.evidence.rls,entry.evidence.tables);
  assert.deepEqual(entry.evidence.functions.map(fn=>fn.name),['public.operator_request_command_receipt',
    'public.confirm_operator_request_command','public.execute_clinic_operator_command','public.execute_growth_operator_command','public.read_operator_request_command']);
  assert.equal(entry.evidence.dynamicSqlLines.length,0);assert.equal(entry.evidence.storageCatalogueLines.length,0);
  const previous=chain.find(item=>item.file.startsWith('096_'));
  for(const fn of previous.evidence.functions)assert.ok(entry.source.includes(digest(fn.body.replaceAll('\r\n','\n'))));
  assert.doesNotMatch(entry.source,/grant\s+(?:select|insert|update|delete)|on\s+delete\s+cascade/i);
});
test('108 adds only private command fences and coordinates four v2 entries with closure of old executors',()=>{
  const entry=chain.find(item=>item.file.startsWith('108_'));
  assert.deepEqual(entry.evidence.tables,['public.growth_operator_command_fences']);
  assert.deepEqual(entry.evidence.rls,entry.evidence.tables);assert.equal(entry.evidence.functions.length,6);
  assert.equal(entry.evidence.dynamicSqlLines.length,0);assert.equal(entry.evidence.storageCatalogueLines.length,0);
  assert.ok(entry.source.includes('revoke all on function public.create_clinic_operator_request'));
  assert.ok(entry.source.includes('close_operator_request_command_v2'));
  assert.doesNotMatch(entry.source,/on\s+delete\s+cascade|grant\s+(?:select|insert|update|delete)/i);
});

test('109 is a read-only single partner RPC with pinned writer locking protocol and no new table grants',()=>{
  const entry=chain.find(item=>item.file.startsWith('109_'));
  assert.deepEqual(entry.evidence.tables,[]);assert.deepEqual(entry.evidence.rls,[]);
  assert.deepEqual(entry.evidence.functions.map(fn=>fn.name),['public.read_growth_partner_ledger']);
  assert.equal(entry.evidence.dynamicSqlLines.length,0);assert.equal(entry.evidence.storageCatalogueLines.length,0);
  for(const fn of chain.find(item=>item.file.startsWith('052_')).evidence.functions.filter(fn=>['public.bind_growth_referral','public.confirm_growth_subscription_payment','public.confirm_growth_partner_payout'].includes(fn.name)))
    assert.ok(entry.source.includes(digest(fn.body.replaceAll('\r\n','\n'))));
  assert.doesNotMatch(entry.evidence.functions[0].body,/\b(?:insert|update\s+public|delete|truncate)\b/i);
});

test('110 has four private creator workflow relations, closed helpers and only three RPC entries; no payment or provider writes',()=>{
  const entry=chain.find(item=>item.file.startsWith('110_'));
  assert.deepEqual(entry.evidence.tables,['public.growth_creator_jobs','public.growth_creator_submissions','public.growth_creator_commands','public.growth_creator_events']);
  assert.deepEqual(entry.evidence.rls,entry.evidence.tables);assert.equal(entry.evidence.functions.length,8);
  assert.deepEqual(entry.evidence.dynamicSqlLines,[]);assert.deepEqual(entry.evidence.storageCatalogueLines,[]);assert.deepEqual(entry.evidence.extensions,[]);
  for(const fn of chain.find(item=>item.file.startsWith('105_')).evidence.functions)assert.ok(entry.source.includes(digest(fn.body.replaceAll('\r\n','\n'))));
  assert.doesNotMatch(entry.source,/on\s+delete\s+cascade|grant\s+(?:select|insert|update|delete)|(?:insert\s+into|update|delete\s+from)\s+public\.(?:growth_partner|platform_subscription|staff_users|workspaces|growth_contributor_profiles)/i);
});

test('111 closes old creator executors and adds one private stop fence plus scoped read models, with no external effects',()=>{
  const entry=chain.find(item=>item.file.startsWith('111_'));
  assert.deepEqual(entry.evidence.tables,['public.growth_creator_command_fences']);assert.deepEqual(entry.evidence.rls,entry.evidence.tables);
  assert.equal(entry.evidence.functions.length,6);assert.deepEqual(entry.evidence.dynamicSqlLines,[]);assert.deepEqual(entry.evidence.storageCatalogueLines,[]);
  assert.deepEqual(entry.evidence.extensions,[]);
  for(const fn of chain.find(item=>item.file.startsWith('110_')).evidence.functions)assert.ok(entry.source.includes(digest(fn.body.replaceAll('\r\n','\n'))));
  assert.match(entry.source,/revoke all on function public\.execute_growth_creator_job\(/);
  assert.doesNotMatch(entry.source,/on\s+delete\s+cascade|grant\s+(?:select|insert|update|delete)/i);
});

test('112 adds one private source receipt, three closed helpers and four service entries; preserves financial writers',()=>{
  const entry=chain.find(item=>item.file.startsWith('112_'));
  assert.deepEqual(entry.evidence.tables,['public.growth_partner_sources']); assert.deepEqual(entry.evidence.rls,entry.evidence.tables);
  assert.equal(entry.evidence.functions.length,7); assert.deepEqual(entry.evidence.dynamicSqlLines,[]);
  assert.deepEqual(entry.evidence.storageCatalogueLines,[]); assert.deepEqual(entry.evidence.extensions,[]);
  assert.match(entry.source,/revoke all on function public\.bind_growth_referral\(uuid,text,text\) from public,anon,authenticated,service_role/);
  assert.doesNotMatch(entry.source,/on\s+delete\s+cascade|grant\s+(?:select|insert|update|delete)|(?:insert\s+into|update|delete\s+from)\s+public\.(?:platform_subscription|growth_partner_commissions|growth_partner_payouts|staff_users|workspaces|growth_contributor_profiles)/i);
});

test('113 anchors first-entry time, closes the old capture and adds only a bounded private cleanup, without scheduling or other data writes',()=>{
  const e=chain.find(v=>v.file.startsWith('113_'));
  assert.deepEqual(e.evidence.tables,[]); assert.deepEqual(e.evidence.rls,[]); assert.equal(e.evidence.functions.length,2);
  assert.deepEqual(e.evidence.dynamicSqlLines,[]); assert.deepEqual(e.evidence.storageCatalogueLines,[]); assert.deepEqual(e.evidence.extensions,[]);
  for(const f of chain.find(v=>v.file.startsWith('112_')).evidence.functions)assert.ok(e.source.includes(digest(f.body.replaceAll('\r\n','\n'))));
  assert.match(e.source,/has_any_column_privilege\(role_name,'public\.growth_partner_sources','SELECT,INSERT,UPDATE,REFERENCES'\)/);
  assert.match(e.source,/has_function_privilege\(role_name,dependency\.signature,'EXECUTE'\)/);
  assert.match(e.source,/revoke all on function public\.capture_growth_partner_source\(uuid,text,text,text\) from public,anon,authenticated,service_role/);
  assert.doesNotMatch(e.source,/(?:insert into|update|delete from) public\.(?:staff_users|workspaces|growth_referrals|platform_subscription|growth_partner_commissions|growth_partner_payouts)/i);
});

test('114 initial commercial activation requires explicit offer/accept, private commands and no financial/workspace writes',()=>{
  const e=chain.find(v=>v.file.startsWith('114_'));
  assert.deepEqual(e.evidence.tables,['public.growth_partner_terms','public.growth_partner_term_commands']);
  assert.deepEqual(e.evidence.rls,e.evidence.tables);assert.equal(e.evidence.functions.length,4);
  assert.deepEqual(e.evidence.dynamicSqlLines,[]);assert.deepEqual(e.evidence.storageCatalogueLines,[]);assert.deepEqual(e.evidence.extensions,[]);
  assert.match(e.source,/revoke insert,update,delete,truncate,references,trigger on public\.growth_partners from service_role/);
  assert.doesNotMatch(e.source,/(?:insert into|update|delete from) public\.(?:staff_users|workspaces|growth_referrals|platform_subscription|growth_partner_commissions|growth_partner_payouts)/i);
});

test('115 pins exact actor and private provenance without changing legacy bodies or writing business rows during migration',()=>{
  const e=chain.find(v=>v.file.startsWith('115_'));
  assert.deepEqual(e.evidence.tables,['public.crm_appointment_request_actors']);assert.deepEqual(e.evidence.rls,e.evidence.tables);
  assert.equal(e.evidence.functions.length,4);assert.deepEqual(e.evidence.dynamicSqlLines,[]);assert.deepEqual(e.evidence.storageCatalogueLines,[]);assert.deepEqual(e.evidence.extensions,[]);
  for(const f of chain.filter(v=>['063','064'].includes(v.file.slice(0,3))).flatMap(v=>v.evidence.functions))assert.ok(e.source.includes(digest(f.body.replaceAll('\r\n','\n'))));
  assert.doesNotMatch(e.source,/grant\s+(?:select|insert|update|delete)|(?:insert into|update|delete from) public\.(?:staff_users|appointments|clients|deals|workspaces)/i);
  assert.match(e.source,/staff\.auth_user_id is distinct from p_actor/);assert.match(e.source,/staff\.role is distinct from p_role/);
});

for (const kind of ['missing', 'unknown', 'duplicate', 'reordered', 'renamed']) test(`preflight rejects ${kind} chain membership before any native startup`, () => {
  const value = records();
  if (kind === 'missing') value.splice(31, 1);
  if (kind === 'unknown') value.push({ file: '105_unknown.sql', source: 'select 1;' });
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

test('102 changes only the name-fallback predicate of the reviewed 073 capacity body', () => {
  const previous = chain.find(entry => entry.file.startsWith('073_'));
  const current = chain.find(entry => entry.file.startsWith('102_'));
  assert.deepEqual(current.evidence.tables, []);
  assert.deepEqual(current.evidence.rls, []);
  assert.deepEqual(current.evidence.functions.map(fn => fn.name), ['public.guard_appointment_capacity']);
  const canonical = body => body.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const old = canonical(previous.evidence.functions.find(fn => fn.name === 'public.guard_appointment_capacity').body);
  const intended = old.replace('a.doctor_id = any(doctor_ids) or pg_catalog.lower(pg_catalog.btrim(a.doctor_name)) = any(doctor_names)',
    'a.doctor_id = any(doctor_ids) or ((new_doctor is null or a.doctor_id is null) and pg_catalog.lower(pg_catalog.btrim(a.doctor_name)) = any(doctor_names))');
  assert.notEqual(intended, old);
  assert.equal(canonical(current.evidence.functions[0].body), intended);
});

test('103 preserves 070 business formulas and authorization while moving the clock after its waits', () => {
  const current=chain.find(e=>e.file.startsWith('103_'));
  assert.deepEqual(current.evidence.tables,[]);assert.deepEqual(current.evidence.rls,[]);
  assert.deepEqual(current.evidence.functions.map(fn=>fn.name),['public.read_mortgage_workspace','public.read_mortgage_results']);
  const canonical=body=>body.replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim();
  let expected=chain.find(e=>e.file.startsWith('070_')).evidence.functions.find(fn=>fn.name==='public.read_mortgage_workspace').body;
  const timing="  v_from:=coalesce(p_from,case when p_to is not null then p_to-interval '180 days' else v_now-interval '90 days' end);\n  v_to:=coalesce(p_to,case when p_from is not null then p_from+interval '180 days' else v_now+interval '90 days' end);\n  v_period:=v_now-make_interval(days=>p_days);\n  if v_to<=v_from or v_to-v_from>interval '366 days' then raise exception using errcode='P7003',message='invalid_range'; end if;\n";
  expected=expected.replace('v_now timestamptz := statement_timestamp();','v_now timestamptz;')
    .replace("where w.workspace_id=p_workspace_id and w.key='clinic_schedule';","where w.workspace_id=p_workspace_id and w.key='clinic_schedule' for share;")
    .replace(timing,'')
    .replace("if p_lead_id is not null and not (p_lead_id=any(v_ids)) then raise exception using errcode='P7002',message='lead_not_found'; end if;",
      "if p_lead_id is not null and not (p_lead_id=any(v_ids)) then raise exception using errcode='P7002',message='lead_not_found'; end if;\n v_now:=clock_timestamp();\n"+timing.replace('v_now-make_interval(days=>p_days)',"v_now-p_days*interval '24 hours'"))
    .replace("'metrics',v_metrics,'memberMetrics',v_member_metrics,'periodDays',p_days);",
      "'metrics',v_metrics,'memberMetrics',v_member_metrics,'periodDays',p_days, 'generatedAt',v_now,'period',jsonb_build_object('days',p_days,'from',v_period,'to',v_now));");
  assert.equal(canonical(current.evidence.functions[0].body),canonical(expected));
});

test('103 preserves 078 result cohorts/attribution and captures one exact clock inside its business statement', () => {
  const canonical=body=>body.replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim();
  let expected=chain.find(e=>e.file.startsWith('078_')).evidence.functions.find(fn=>fn.name==='public.read_mortgage_results').body;
  expected=expected.replace('v_role text; v_now timestamptz:=statement_timestamp(); v_from timestamptz; v_result jsonb;','v_role text; v_result jsonb;')
    .replace('v_from:=v_now-make_interval(days=>p_days);\n  with portfolio as (',"with report_clock as materialized (select clock_timestamp() as at), portfolio as (")
    .replaceAll('<=v_now','<=(select at from report_clock)')
    .replace('between v_from and v_now',"between (select at-p_days*interval '24 hours' from report_clock) and (select at from report_clock)")
    .replace("'generatedAt',v_now,'period',jsonb_build_object('days',p_days,'from',v_from,'to',v_now)",
      "'generatedAt',c.at,'period',jsonb_build_object('days',p_days,'from',c.at-p_days*interval '24 hours','to',c.at)")
    .replace("from members m),'[]'::jsonb)) into v_result;","from members m),'[]'::jsonb)) into v_result from report_clock c;");
  const actual=chain.find(e=>e.file.startsWith('103_')).evidence.functions[1].body;
  assert.equal(canonical(actual),canonical(expected));
  assert.equal((actual.match(/clock_timestamp\(/g)||[]).length,1);
});

test('104 preserves both report business statements and adds only a locked authorized timezone', () => {
  const current=chain.find(e=>e.file.startsWith('104_'));
  assert.deepEqual(current.evidence.tables,[]);assert.deepEqual(current.evidence.rls,[]);
  assert.deepEqual(current.evidence.functions.map(fn=>fn.name),['public.read_lead_team_analytics','public.read_mortgage_results']);
  const canonical=body=>body.replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim();
  const zone="select w.value->>'timeZone' into v_zone from public.workspace_settings w where w.workspace_id=p_workspace_id and w.key='clinic_schedule' for share; if v_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_zone) then raise exception using errcode='P7008',message='timezone_not_configured'; end if;";
  for(const [index,number,name] of [[0,'095_','public.read_lead_team_analytics'],[1,'103_','public.read_mortgage_results']]) {
    const old=canonical(chain.find(e=>e.file.startsWith(number)).evidence.functions.find(fn=>fn.name===name).body);
    const expected=old.replace('v_role text;','v_role text; v_zone text;')
      .replace('with report_clock as materialized',zone+' with report_clock as materialized')
      .replace("'generatedAt',c.at,","'timeZone',v_zone,'generatedAt',c.at,");
    assert.notEqual(expected,old);assert.equal(canonical(current.evidence.functions[index].body),expected);
    assert.equal((expected.match(/clock_timestamp\(/g)||[]).length,1);
  }
});

test('all local reload notifications are retained and every dynamic SQL line has its original source location', () => {
  assert.ok(chain.reduce((n, entry) => n + entry.evidence.notifications.length, 0) > 30);
  const dynamic = chain.filter(entry => entry.evidence.dynamicSqlLines.length);
  assert.deepEqual(dynamic.map(entry => Number(entry.file.slice(0, 3))), [62, 79, 82, 86, 88, 89, 90, 91, 116]);
  for (const entry of dynamic) for (const line of entry.evidence.dynamicSqlLines) {
    if (entry.file.startsWith('116_')) assert.equal(entry.source.split('\n')[line - 1].trim(),
      "execute 'update public.appointments set '||assignments||' where workspace_id=$2 and id=$3'");
    else assert.match(entry.source.split('\n')[line - 1], /execute\s+format/i);
  }
});

test('116 admits only a source-reviewed tenant/actor patch with bound values and no new table grants',()=>{
  const entry=chain.find(item=>item.file.startsWith('116_'));
  assert.deepEqual(entry.evidence.tables,[]);assert.deepEqual(entry.evidence.rls,[]);
  assert.deepEqual(entry.evidence.functions.map(fn=>fn.name),['public.patch_crm_appointment_as_actor']);
  assert.equal(entry.evidence.dynamicSqlLines.length,1);assert.deepEqual(entry.evidence.storageCatalogueLines,[]);
  assert.ok(entry.source.includes("format('%1$I=($1).%1$I',k)"));
  assert.ok(entry.source.includes('using next_row,p_workspace_id,p_appointment_id'));
  assert.ok(entry.source.includes('jsonb_object_keys(p_patch) k where k<>all'));
  assert.doesNotMatch(entry.source,/grant\s+(?:select|insert|update|delete)|alter\s+table|create\s+policy/i);
});

test('119 adds only a service-only journaled facade and closes effective old service PATCH',()=>{
  const entry=chain.find(item=>item.file.startsWith('119_'));
  assert.deepEqual(entry.evidence.tables,[]);
  assert.deepEqual(entry.evidence.functions.map(fn=>fn.name),['public.patch_crm_appointment_journaled']);
  assert.equal(entry.evidence.dynamicSqlLines.length,0);assert.equal(entry.evidence.storageCatalogueLines.length,0);
  assert.ok(entry.source.includes('d5f8355441890ab3bb910adcb34a0cd9e3211685431ffee7826e0eb283bb11a8'));
  assert.doesNotMatch(entry.source,/grant\s+(?:select|insert|update|delete)|alter\s+table|create\s+trigger/i);
});

test('118 introduces only a version-bound server facade and closes effective legacy execution',()=>{
  const entry=chain.find(item=>item.file.startsWith('118_'));
  assert.deepEqual(entry.evidence.tables,[]);assert.deepEqual(entry.evidence.rls,[]);
  assert.deepEqual(entry.evidence.dynamicSqlLines,[]);assert.deepEqual(entry.evidence.storageCatalogueLines,[]);
  assert.deepEqual(entry.evidence.functions.map(fn=>fn.name),['public.patch_crm_appointment_v2']);
  assert.ok(entry.source.includes("p_before||jsonb_build_object('edit_version',p_expected_edit_version)"));
  assert.ok(entry.source.includes("appointment_version_entry_legacy_access_unconfirmed"));
  assert.doesNotMatch(entry.source,/grant\s+(?:select|insert|update|delete)|alter\s+table|create\s+policy/i);
});

test('117 adds only a local edit token and a private invoker trigger, without backfill or grants',()=>{
  const entry=chain.find(item=>item.file.startsWith('117_'));
  assert.deepEqual(entry.evidence.tables,[]);assert.deepEqual(entry.evidence.rls,[]);
  assert.deepEqual(entry.evidence.dynamicSqlLines,[]);assert.deepEqual(entry.evidence.storageCatalogueLines,[]);
  assert.deepEqual(entry.evidence.functions.map(fn=>fn.name),['public.stamp_appointment_edit_version']);
  assert.match(entry.source,/security invoker set search_path=''/);
  assert.match(entry.source,/before update on public.appointments/);
  assert.doesNotMatch(entry.source,/\b(?:insert into|update public\.|delete from|grant |create policy)/i);
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
