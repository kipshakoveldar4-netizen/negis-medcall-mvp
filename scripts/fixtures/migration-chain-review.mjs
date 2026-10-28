import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Raw-byte review receipts, not a released/applied migration manifest. 059 and
// 065 deliberately describe the current protected worktree, never git show.
const reviewed = `
2d680411aca4580d15c5c551d2b64ce683dcfe4589fb758fdd9f6e6b3dbf5612 009_medcall_mvp_persistence.sql
d15f29acabe29813bef89c08e99c000671c17d8459cd63b57b0952b2536e7603 010_staff_ready_crm.sql
4ca7d1848977d8341db876d6438fff36aa46e8d5cfb5e98fc183432b3ac73605 011_staff_auth_foundation.sql
7fe65625c8efee6c0606a6b2f2dd5aec1ccc72aeb54dbd1f2c0158219e2bc5c7 012_appointments_calendar_fields.sql
7a6d95861fd87c2158448e3c15553aa3883fe04b9e82facb92e5d044b06e5a86 013_release_admin_settings.sql
20fd8bc7de1f6d64f86bb06d153c12de69a4573aab1a166e86e56123a7d8bcab 014_meta_ad_launches.sql
b43152043921976464942b2eb39a0e1d3fbc95d1ce38ae84c7aee2fc8cc0cb5e 015_ad_creative_assets.sql
37f49f9c111356d925eabd195e93b35a37362f4933963ee98637cf0eb0d41159 016_video_processing_jobs.sql
a0c2c08011f7c4ef9ce59f92a8eaab1dd641cdc403c09823231bd5b17d59e8b3 017_video_jobs_completed_at.sql
362ef873fbc75be238c9446d757554d2d2ef07659bfeaee952f64a88f485f2a6 018_video_processing_jobs_contract.sql
615b12765d3442bbb52a625a4ea4b8e2ac09cc3a649c740d8f8789e4ad743649 019_crm_lead_pipeline_foundation.sql
fb860ee77c9e9ab9dba3076acfcf7b76536bc11f3806bfe174e07e976447a7cf 020_crm_deals_foundation.sql
dc605a08aac4ee2bf4730537fd03db9fbc7bb3844194bb319e286b359aad5f5a 021_meta_campaign_insights_foundation.sql
4ea80235d7469cbae2477aab030c2b3e579c2c64caa896adc727472c71e89d08 022_meta_insights_scheduler_foundation.sql
67029c5ab33ec63af85954bb34d56801b72e41a9c454c2f31283452ad01fbc61 023_public_privilege_hardening.sql
35aeccdada75a1031ffc1c4ceb727e08a585528c90a3f1bba2a32cd94c999512 024_staff_invitations.sql
4f97b23d7e7fed01991004db958f39390a084c2969019f77eaa5ef5666749221 025_staff_invitations_service_role_grant.sql
adf72f73173025364a0b7a7d53177e7326b3d60b40e4560d91ad518dceb214c4 026_wazzup_channels.sql
8b660b7352ae8144da330f71f56e0b87ff4d4e9ef269ea6896de4b43461882d8 027_whatsapp_cloud_numbers.sql
889aaef28413f9d85c0c3af9b34e325ac3fa2ccd4399170f165c4f819f0f6978 028_leads_phone_normalized.sql
e270b1f66a4265264e8cacb93bf36f82b884ee6ede316385e22e028cc3fa83ba 029_audit_logs_change_journal.sql
05f5f97a9f89c7ac7b3674d94d4fdfb2c346f3041f8bea9ca116741489c9b3db 030_clients_phone_normalized.sql
9f30d15688ec045057e4b1c775eb06de8b49201630ad855e756c27341fd4769d 031_tasks_links_and_authorship.sql
968e16396ab55dcf2c452ce8d711642f9ce2475ce2f6982a40990ae1f8a10c5f 032_clinic_services_directory.sql
b80f70a554d33d0786530546919cad7ce1601ae9561914a09d4213213aa3761f 033_doctor_directory_and_schedule.sql
990b3dae243c9399296831a4863ddf295ca1aa1e2417dc3fd8e447bfda524a66 034_platform_subscriptions.sql
245e4497c6392f7d4b40411f27eeec767ef27eb01d06c329fcab3609e70d641a 035_service_role_grant_parity.sql
58740a381bdc5a4d0e854ac29b8c632f70202d02f3d0d093477f74978456b866 036_doctor_capacity.sql
772069d1a76fd644d4139f2f388c3ccdbbd282c095959aa1733262160b248f78 037_platform_recommendations.sql
d3ff431eaf3e0a08723732f4e9b4004f7e45fd1e9f73eddf2e19874b8a91c1f6 038_staff_join_requests.sql
f574b13d8a04c691c64f78e98cc3d7068f786ff4899e380ddb4ef33af21d8bc8 039_appointments_calendar_columns_repair.sql
5bfe6b70946ac4709c8c59d9dd25b432813ae6d98c738990287898a6389faacc 040_services_per_master_and_schedule_windows.sql
ed3185d7b59ffbe565f0facae8d38fecdad55c44218fa105adfa850b94b18850 041_appointment_reminders.sql
735fd742241bac956980cb597ccc63d37f4e5bb023e5a19e68154c9b984cf90b 042_client_masters.sql
b9a8e58c63e78da35813eeb20d4a27ddba76797e8f74080340d313d71336c843 043_appointment_author.sql
1f76caaa223c3c81d9ba35353dec662791143254c6ae5b42e91eb61a8c886a62 044_staff_push_subscriptions.sql
feb4ccddceaabb06867ee57fb8713594a4c7e7d47f0f32b1af3e7a9ae896bd9e 045_appointment_price.sql
a8fe6c13d086bfbbe5600c886f5f1c30aa663eafbe5efaa1d322b46286e54c45 046_doctor_salary_terms.sql
b28377923453fe7343679fba17d665e33fbdde5c82c307bd2fc3e23f84791500 047_tiktok_ad_account_connections.sql
448414186cff5abbb733c13737a103a5c6f596456760a62dfa7216c147458999 048_tiktok_video_uploads.sql
a66f2836685f6c49ac7fa2a20e3f2de1bcf03f701c15680050674f045343b86e 049_tiktok_video_readiness.sql
3a3e20070d2a7093f88ee82afe4d80339558fdd8040956ce2b5eb496c0c701aa 050_tiktok_disabled_campaign_launches.sql
8f3e2c91e7cae21522692439f007edc47bef7bc8bcd404044f466bbe674025c2 051_content_generation_usage.sql
37122e0474ed17f922b53d0d7f1724e45dcac09662d0e952a12d0002bcde9950 052_operators_and_partner_ledger.sql
b564a226c27e6d561a741bcffda4dc8f9a1fd8d880d9e9fd0432a98e387cdc19 053_operator_request_lifecycle.sql
c43073d140bc8e93fe0a3ec691a62439a5c9fe38e0b3bf32475785bdef6f0938 054_operator_lead_access.sql
89ee0aca05f2f8f620e846dc525d09b762ed3390fe732d5d47aaba7c770ce4fd 055_appointment_service_items.sql
a5befbb25d83c91d4fa6edff12d1ea01501393d3701b22b54e20b9ef01a19363 056_operator_lead_processing.sql
3f3a5f4471e8057868419458a6177e704245b8f05d318672532864697a357c85 057_operator_catalog_booking.sql
d94395d093ef0512877f600beaa5d17ad7a06ee2d1fbdaad464cd5900c33e04f 058_public_site_intake_foundation.sql
c56c820f9b29b28f96de34b51cb63af44f29be207b7c76740c491c9811aaae47 059_site_blog_drafts.sql
8fd7e87b032f672026dad68373d757470360d8b1581038f1f9951ae3b0770826 060_site_blog_publication.sql
9492ff5ffc19da4394c09a9d15e99ae44d90db672df22239ee847080d7976ed6 061_appointment_arrival_payment.sql
4bb9c8e5013c51617f102ef2937aff319d7d495146e3fa79aca112935b3b681f 062_site_inquiry_manual_deletion.sql
a6584266be148b221423120b5603ffc892d658d0f1b2c276c5cb335d493c7493 063_atomic_appointment_client.sql
61295ab4e9bd3005e58a8edd7c9a1f5a2a6c742fb59547eeaa5834575ecdfa4a 064_appointment_create_requests.sql
ccc908b1a91126540b78dedcbfb75ae86e191d057fbeeeb4742241e8a0c61984 065_operator_arrival_attribution.sql
88b6368b45ac27023932b0142fb476fedac935ee4437c11d41fa2e0d4faa56e0 066_operator_arrival_control_calls.sql
9ce067532c13ea1707fa21176152d468e87de4b75020b9403c2aa7648b705e57 067_atomic_platform_subscription.sql
44fb5cc03dd716d3afe085b605930a4345a8f01662d810f24b37b78b531ff1f4 068_workspaces_row_security.sql
190d351c9686a5d2a817808aad7edf0ec3b36b386c2d226155008d24f25a8b46 069_assigned_lead_manager.sql
24c1467911e14cc4e2c77301dc3cd474bcc8560b80d7609fde6ebea37dfa7943 070_mortgage_workspace.sql
c923ac4712bef5390aaded2fec4651f9024b55ad1d4e741b5e06681cab3ceaae 071_atomic_wazzup_inbound.sql
cf289f079754973dbd04f604144524ec27ee57a205b45a25d3968e2b2ae224ce 072_atomic_appointment_capacity.sql
dea42958ec8d3b2869c2922ad324890e1655235cde77ad688ed4d5c57a8e9fa9 073_peak_appointment_capacity.sql
363730f8ca346d8f3d98c648900d7df26db52526aaf30ab2b360d142d4b2179e 074_operator_arrival_access_locks.sql
bee77fe71782ad6242eacfc33184b3a3c1228252e40c33349fbd4bc78e8acec2 075_meta_account_workspace_uniqueness.sql
38e7fb99f898974064c4fe0255d1189008d3360bad9b8adbec268de6262da2c5 076_crm_sale_create_requests.sql
3c92950a81e21176fef40f60b220ed23030c73150a2f044334639e9870601d21 077_mortgage_admin_self_assignment.sql
e518cdf0f01bdaec2bb1541599c06530187548fca349019ef54ed218d814ea9e 078_mortgage_signed_contracts.sql
001459962292f85e9ef7f2abbd243e649f5f4647e39081dbc80d28216be5d642 079_meta_insights_server_access.sql
74d3d410cf807e002a81c645a0de18b863426c601857db5a18556556d6a7a1c4 080_postponed_lead_stage.sql
3281ef0e02f474777d37aa55f6d0d066882c11e0b9602a3e57c22d0dce321fd2 081_content_usage_reservation_column_scope.sql
6f936603321b1042fc7d9c1315e16ff5fa06ef03a7d77383d7f5f14397c19240 082_ad_creative_assets_server_access.sql
c02a4a5a41fee140cc592550e649ba20670d28af64b4f6eaea86175279e2418c 083_lead_team_analytics_snapshot.sql
faff0c4a6d236b023e9fbdb507cc7cd4e0a008904bbe3e2ceb33026f8c921c23 084_platform_subscription_operations.sql
a66dab1635c4da9a631b63d4ca48a21da27de78362db66da5c0ade9521c3441a 085_generated_creative_identity.sql
8ad71f0b656af50ab818cd15e75c463bffc203e69b604695fe69923a6ccfd1c2 086_video_job_promotion.sql
6bd1b265223a5b406365a418c910f81cd52467fc6d983746cc9803fd4a484094 087_staged_creative_foundation.sql
c284e9ba1668c2b64938da47a1547a75a9478b2bcb8fafec574fff1e0dedb47e 088_staged_creative_workflow.sql
f065ba86c31e640cd4db68b7b6f8a16f85371cf5be724e476df1c93d37d8c1c0 089_staged_creative_reclamation.sql
ebba17c2ee9108e35c17da426d66715599931510c4f542e5c249edabab41ea5c 090_generated_video_workflow.sql
45a5e55fcbcad21a6352d8ebb2ed2ff72ba4781673495f695fe95f71b284b6c5 091_lead_taxonomy_server_access.sql
b3f11c786e638190e7aed959ed9dbb2959816753fa13dad34659b506edaface5 092_generated_video_terminal_failure.sql
a280302dcb95464378a30f0aae555a0246b59fe87224079167e60b2f39a39d40 093_site_consent_receipts.sql
b7c2349c8dac884895e53d7553659c60d41305f17d3abb8dd07c4e355bd6e24e 094_operator_request_concurrency.sql
0054003d2c6fd0c0c5798d9ed5a330acb22d00bf95062117c2c9cdd91da05f10 095_lead_team_analytics_clock.sql
637baa42277fde94c33f42741998042576f54cf23ad79db0d33f6c63f5f35f15 096_operator_request_actor_mutations.sql
2aca206a7ee20758e0e18fc8cc0940c6eaee8cbeb157702dfda151bb43f16b68 097_content_telegram_delivery_admission.sql
ce26941b100f8fa5b368bb53c383254da03ba7f026b75a88ed3e62314364be61 098_legacy_server_access.sql
12150cb38aed391a1570e8df391129377337e3959a835a583cc897f27ca0a7b7 099_application_function_default_access.sql
e11717ba583fcacb491db52d85404c71c8a32f49b08afb269726b4fc8a36cfe0 100_legacy_crm_row_security.sql
8a526e071fbef948b664121e443cadce53865fc898d35b99c9e97d1fdb810e30 101_site_deletion_operations.sql
e0bebcea54224c0c0184a0aa4d2d554596a059c22827755955d36aadcf19beef 102_appointment_capacity_explicit_identity.sql
e77b5457680a491e421748a79d3ac74b5e39116db204f78ac6e98aa4585d0a11 103_mortgage_report_clock.sql
3a8afb0ec9229728f584943755f436e1b3ef8b04bcfe7a7ad36cc5c77c5bc929 104_analytics_report_timezone.sql
f392419d625826ece3d002737b8ebc5ebd82b769b9b2b615a62fbfd07bfdfa5c 105_contributor_applications.sql
15267fb3ffd06ad4e67120661c3938eb580eaa8c39e50ae5cf08c5780e2b246f 106_generated_video_quota_dispatch.sql
5c71da01a45aed17d8225e9801047b5e0deb5da3f7c3c59e08b40aae9fd94312 107_operator_request_commands.sql
292fd8647bac6411c2131427c4c834f9c6d25441db1b9a5f969ce24b2487fae7 108_operator_command_closure.sql
71c5c8183f444061492550468ac0e62417f3402bb54e8961860be7fb353db3ba 109_partner_ledger_read.sql
87097453d461654253841ea057c7e0e6c3523e1a109a0f72d5ae3b75e0eb2615 110_creator_job_workflow.sql
ca00557aafe4bab78a8e7643ad45ab4bea3d292ebd0f0ad2010f13f18e425a7f 111_creator_command_closure.sql
92ca09297469d73c7174e5a57d428f38eb3f375ab1f1c9c2486d00e82b7769b2 112_partner_first_source.sql
9a8bd2b19c2ed7bde215b38ad08856177f8677ec52132f2f54a642ca86ccc6f4 113_partner_entry_anchor.sql
b1aa8d89b58dc7a0a56f444524b3fe66e42a8c85abf52180dacbfb7cdc88db3a 114_partner_terms_activation.sql
3a8f70cd9878ecad79e48acb9f4c847b37ff7589f3e0981398fa95170675cffb 115_appointment_request_actor.sql
567eb91556edeb94d74f76b3fe32115e5347164203f3cffa6d4fc9a49ef9ec75 116_appointment_patch_actor.sql
6ddda2adbaddb36f64d959127dd2bd005e52d116724dee840cf31c62bc362fdf 117_appointment_edit_version.sql
aaa99158d91016da7fc358962a31f499fb26d6bf86d50a9ecbc52d1f5b2edf75 118_appointment_version_entry.sql
38730dd70d0a717855066a898aa11616f21dc904ce946ef68651450eda6001fe 119_appointment_patch_journal.sql
df902b31c2ba714a46b2e5be7bc504f15a252177c3b06112d56f32741c09b43f 120_partner_first_paid_window.sql
c07f599caca533412618f4a7875fccc4891582356396e9b549b487a19e06749d 121_partner_company_approval.sql
3acd89b11fa12c27b4391cc626016378f2712a922301d356723b48a55d392330 122_partner_history_read.sql
789e5443268b1c4079686b9e6a69585834f6ca42cd1095d47cad8c2b592217f3 123_operator_workday_read.sql
0ffb000be6c33ff6cf431bf6ae269ac39499a5b7dc762235ef37adf62b5f287b 124_operator_lead_search.sql
018dcdbbe7cb8f6f01b9476f723cd6fc3cc34f678066bc8979fcb03602ab874c 125_partner_company_command_recovery.sql
54aa252bf9252aeac1cd489230f485924deba6a64d5264260c96b23f76e2b6b5 126_partner_company_applicant_inbox.sql
`.trim().split('\n').map(line => line.split(' '));

export const migrationReview = Object.freeze(Object.fromEntries(reviewed.map(([sha256, file]) => [file, sha256])));
export const digest = source => createHash('sha256').update(source).digest('hex');

// Only inspect already pinned sources. This bounded tokenizer extracts review
// evidence, not arbitrary SQL safety: an unknown digest always stops the gate.
export function migrationTokens(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('--', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      assert.equal(depth, 0, 'Unterminated SQL comment'); continue;
    }
    const offset = i, escaped = /[eE]/.test(source[i]) && source[i + 1] === "'";
    if (source[i] === "'" || source[i] === '"' || escaped) {
      if (escaped) i++;
      const quote = source[i++]; let value = '', closed = false;
      while (i < source.length) {
        if (source[i] === quote) { i++; if (source[i] === quote) { value += quote; i++; } else { closed = true; break; } }
        else if (escaped && source[i] === '\\') { value += source[i++]; assert.ok(i < source.length); value += source[i++]; }
        else value += source[i++];
      }
      assert.ok(closed, 'Unterminated SQL quote');
      tokens.push({ kind: quote === '"' ? 'identifier' : 'string', value, offset }); continue;
    }
    const dollar = source.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/)?.[0];
    if (dollar) {
      const end = source.indexOf(dollar, i + dollar.length); assert.ok(end >= 0, 'Unterminated SQL body');
      tokens.push({ kind: 'body', value: source.slice(i + dollar.length, end), offset, bodyStart: i + dollar.length }); i = end + dollar.length; continue;
    }
    const word = source.slice(i).match(/^[a-zA-Z_][a-zA-Z_0-9$]*/)?.[0];
    if (word) { tokens.push({ kind: 'word', value: word.toLowerCase(), offset }); i += word.length; }
    else tokens.push({ kind: 'symbol', value: source[i++], offset });
  }
  return tokens;
}

const identifier = token => token && ['word', 'identifier'].includes(token.kind);
function object(tokens, start) {
  assert.ok(identifier(tokens[start]), 'Unrecognized migration object');
  return tokens[start + 1]?.value === '.'
    ? `${tokens[start].value}.${tokens[start + 2].value}` : `public.${tokens[start].value}`;
}

export function inspectMigration(source) {
  const tokens = migrationTokens(source), statements = [];
  let statement = [];
  for (const token of tokens) {
    if (token.value === ';' && token.kind === 'symbol') { if (statement.length) statements.push(statement); statement = []; }
    else statement.push(token);
  }
  if (statement.length) statements.push(statement);
  const evidence = { extensions: [], notifications: [], tables: [], rls: [], functions: [], dynamicSqlLines: [], storageCatalogueLines: [] };
  const line = token => source.slice(0, token.offset).split('\n').length;
  const outward = /\b(?:dblink(?:_connect|_connect_u|_exec|_send_query)?|http_(?:get|post|put|patch|delete|head|request)|http|curl|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_write_file|pg_ls_dir|pg_file_write|pg_execute_server_program|pg_reload_conf|pg_logical_emit_message)\s*\(/i;
  const walk = list => {
    const code = list.filter(token => !['string', 'body'].includes(token.kind)).map(token => token.value).join(' ');
    assert.doesNotMatch(code, outward, 'Outward or host-file SQL requires separate review; never execute it here');
    assert.doesNotMatch(code, /\b(?:net|cron|aws_s3|pg_cron|pg_net)\s*\./i, 'External/scheduled SQL is forbidden in this fixture');
    assert.doesNotMatch(code, /\b(?:copy|load|listen|unlisten)\b|\b(?:create|alter)\s+(?:subscription|server|foreign|event\s+trigger)\b|\balter\s+system\b/i,
      'A process/file/worker/external database effect is outside this fixture');
    for (const token of list) {
      if (token.kind === 'body') walk(migrationTokens(token.value));
      // Dynamic strings are not executed by this scanner. Exact source receipts
      // cover the finite reviewed ACL-format/foreign-key-query statements.
    }
  };
  walk(tokens);
  for (const entry of statements) {
    let at = 1;
    if (entry[0]?.value === 'create' && entry[1]?.value === 'or' && entry[2]?.value === 'replace') at = 3;
    if (entry[0]?.value === 'create' && entry[at]?.value === 'extension') {
      const start = entry[at + 1]?.value === 'if' ? at + 4 : at + 1;
      assert.equal(entry[start]?.value, 'pgcrypto', 'Only preinstalled pgcrypto is reviewed; no extension download/fallback');
      evidence.extensions.push({ name: entry[start].value, line: line(entry[0]) });
    }
    if (entry[0]?.value === 'notify') {
      assert.deepEqual(entry.map(token => token.value), ['notify', 'pgrst', ',', 'reload schema'], 'Only the inert local PostgREST reload notification is reviewed');
      evidence.notifications.push(line(entry[0]));
    }
    if (entry[0]?.value === 'create' && entry[at]?.value === 'table') {
      const start = entry[at + 1]?.value === 'if' ? at + 4 : at + 1;
      evidence.tables.push(object(entry, start));
    }
    if (entry[0]?.value === 'alter' && entry[1]?.value === 'table') {
      const start = entry[2]?.value === 'if' ? 4 : 2;
      if (entry.some((token, i) => token.value === 'enable' && entry[i + 1]?.value === 'row')) evidence.rls.push(object(entry, start));
    }
    if (entry[0]?.value === 'create' && entry[at]?.value === 'function') {
      const lang = entry.findIndex(token => token.value === 'language');
      assert.ok(lang >= 0 && ['sql', 'plpgsql'].includes(entry[lang + 1]?.value), 'Only local SQL/plpgsql routines are reviewed');
      const body = entry.find(token => token.kind === 'body'); assert.ok(body, 'Unrecognized function body requires review');
      evidence.functions.push({ name: object(entry, at + 1), body: body.value, line: line(entry[0]) });
    }
  }
  const effects = (list, base = 0) => {
    for (const [i, token] of list.entries()) {
      if (token.kind === 'body') effects(migrationTokens(token.value), base + token.bodyStart);
      if (token.kind === 'word' && token.value === 'execute' && list[i + 1]?.value !== 'function'
        && !['grant', 'revoke'].includes(list[i - 1]?.value)) evidence.dynamicSqlLines.push(source.slice(0, base + token.offset).split('\n').length);
      if (token.value === 'storage') evidence.storageCatalogueLines.push(source.slice(0, base + token.offset).split('\n').length);
    }
  };
  effects(tokens);
  return evidence;
}

export function preflightChain(records) {
  const expected = Object.keys(migrationReview).sort();
  assert.deepEqual(records.map(record => record.file), expected,
    'Chain membership/order changed: inspect every new/removed/renamed migration before any native startup');
  assert.deepEqual(expected.map(file => Number(file.slice(0, 3))), Array.from({ length: expected.length }, (_, i) => i + 9),
    'The reviewed cumulative application chain must be contiguous from 009');
  return records.map(record => {
    assert.equal(digest(record.source), migrationReview[record.file], `${record.file}: source changed after outward-effect review`);
    return Object.freeze({ ...record, sha256: migrationReview[record.file], evidence: inspectMigration(record.source) });
  });
}

export async function readReviewedChain(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter(entry => /^\d{3}_.+\.sql$/.test(entry.name) && Number(entry.name.slice(0, 3)) >= 9);
  assert.ok(files.every(entry => entry.isFile() && !entry.isSymbolicLink()), 'Migration sources cannot be directory/symlink substitutions');
  const records = [];
  for (const { name: file } of files.sort((a, b) => a.name.localeCompare(b.name))) records.push({ file, source: await readFile(path.join(directory, file), 'utf8') });
  return preflightChain(records);
}
