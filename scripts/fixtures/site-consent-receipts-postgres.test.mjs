import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { startDisposablePostgres } from './disposable-postgres.mjs';
import intakeModule from '../../lib/crm/site-intake-handler.ts';
import pageModule from '../../lib/crm/site-page.ts';
import supabaseModule from '../../lib/supabase/server.ts';
import { createPageRenderer, createPages as defaultPages } from '../../artifacts/medina-site/render.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registry = createRequire(import.meta.url)(path.join(root, 'lib/site/consent-registry.cjs'));
const bind = notice => ({ ...notice, sha256: createHash('sha256').update(JSON.stringify([
  notice.version, notice.text, notice.purpose, notice.policyRevision, notice.policyUrl,
])).digest('hex') });
const notice = bind({ version: 'synthetic-receipt-v1', text: 'SYNTHETIC TEST ONLY <not legal copy> "quoted" \\ \nТест \u2028',
  purpose: 'SYNTHETIC PURPOSE', policyRevision: 'SYNTHETIC-REV-1', policyUrl: 'https://policy.fixture.invalid/synthetic/v1' });
const resolveConsent = registry.createSiteConsentRegistry([notice]);
const render = createPageRenderer(resolveConsent);
const inquiry = { name: 'Synthetic visitor', phone: '+77000000001', business: 'Synthetic business',
  service: 'call-center', pagePath: '/ru/', consentVersion: notice.version, consent: true };
const one = async (client, sql, args = []) => (await client.query(sql, args)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));

async function call(handler, req) {
  let status = 0, payload, html;
  const headers = {};
  const res = { setHeader(k, v) { headers[k] = v; }, status(v) { status = v; return res; },
    json(v) { payload = v; }, end(v) { html = v; } };
  await handler(req, res);
  return { status, payload, html, headers };
}

async function submitActualForm(html, handler, requestKey) {
  const formHtml = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/)?.[0]; assert.ok(formHtml);
  const attr = name => { const match = formHtml.match(new RegExp(`\\b${name}="([^"]+)"`)); assert.ok(match); return match[1]; };
  const dataset = { intakeEndpoint: attr('data-intake-endpoint'), siteKey: attr('data-site-key'),
    consentVersion: attr('data-consent-version') };
  const browserRequests = [], responses = [];
  let submit, challenge;
  const fieldset = { disabled: false }, button = { disabled: false, textContent: '' }, status = { textContent: '' };
  const form = { dataset, querySelector(selector) {
    if (selector === 'button') return button;
    if (selector === 'fieldset') return fieldset;
    if (selector === '[data-challenge]') return {};
    throw new Error(`Unexpected selector ${selector}`);
  }, reportValidity() { return true; }, addEventListener(event, fn) { assert.equal(event, 'submit'); submit = fn; } };
  const window = { turnstile: { render(_element, options) { challenge = options.callback; return 'fake-widget'; }, reset() {} } };
  runInNewContext(await readFile(path.join(root, 'artifacts/medina-site/form.js'), 'utf8'), {
    window, location: { pathname: '/ru/' }, document: { querySelector(selector) {
      assert.equal(selector, 'form[data-intake-endpoint]'); return form;
    }, getElementById(id) { assert.equal(id, 'form-status'); return status; }, createElement() { return {}; }, head: { append() {} } },
    FormData: class { get(key) { return key === 'consent' ? 'on' : inquiry[key]; } },
    crypto: { randomUUID: () => requestKey }, AbortController, setTimeout, clearTimeout,
    fetch: async (url, init) => {
      assert.equal(url, dataset.intakeEndpoint); assert.equal(init.credentials, 'omit');
      const body = JSON.parse(init.body); browserRequests.push(body);
      const response = await call(handler, { method: 'POST', headers: {
        origin: new URL(url).origin, 'content-type': 'application/json',
      }, body });
      responses.push(response);
      return { ok: response.status === 200, text: async () => JSON.stringify(response.payload) };
    },
  });
  window.medinaChallengeReady(); assert.ok(challenge); challenge('synthetic-challenge');
  assert.ok(submit); await submit({ preventDefault() {} });
  assert.equal(browserRequests.length, 1); assert.equal(responses.length, 1);
  return { body: browserRequests[0], response: responses[0], dataset };
}

test('G8-C7L2 immutable notice receipts on owned native PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  t.after(() => fixture.close());
  const db = await fixture.connect();
  const service = await fixture.connect();
  await db.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon, authenticated, service_role;');
  const selected = new Set([9, 10, 11, 12, 13, 14, 19, 20, 26, 27, 30, 31, 32, 33, 34, 36, 40, 45, 52, 53, 54, 55, 56, 57, 58, 62]);
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    if (selected.has(Number(file.slice(0, 3)))) await db.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
  }
  const seed = async () => {
    const workspace = randomUUID(), site = randomUUID(), staff = randomUUID(), auth = randomUUID(), siteKey = `synthetic-${randomUUID()}`;
    await db.query("insert into public.workspaces(id,name) values($1,'Synthetic consent fixture')", [workspace]);
    await db.query(`insert into public.crm_intake_sites(id,site_key,workspace_id,consent_version,allowed_page_paths,enabled,manual_deletion_enabled)
      values($1,$2,$3,$4,array['/ru/'],true,true)`, [site, siteKey, workspace, notice.version]);
    await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,full_name,email,role)
      values($1,$2,$3,'Synthetic owner',$4,'owner')`, [staff, workspace, auth, `${auth}@fixture.invalid`]);
    const counts = () => one(db, `select
      (select count(*)::int from public.leads where workspace_id=$1) as leads,
      (select count(*)::int from public.crm_site_inquiries where site_id=$2) as inquiries,
      (select count(*)::int from public.crm_site_consent_receipts where site_id=$2) as audits`, [workspace, site]);
    const accept = async (client = service, key = randomUUID(), value = inquiry, snapshot = notice) =>
      (await one(client, 'select public.accept_crm_site_inquiry_with_consent($1,$2,$3::jsonb,$4::jsonb) as result',
        [siteKey, key, JSON.stringify(value), JSON.stringify(snapshot)])).result;
    return { workspace, site, staff, auth, siteKey, counts, accept };
  };
  const legacy = await seed(), legacyKey = randomUUID();
  await db.query('select public.accept_crm_site_inquiry($1,$2,$3::jsonb)', [legacy.siteKey, legacyKey, inquiry]);
  const legacyBefore = await one(db, 'select row_to_json(i) as value from public.crm_site_inquiries i where site_id=$1', [legacy.site]);
  // Deliberately permissive direct defaults must not survive on the new audit table/functions.
  await db.query('alter default privileges grant all on tables to anon, authenticated, service_role; alter default privileges grant execute on functions to anon, authenticated, service_role;');
  const sql = await readFile(path.join(root, 'migrations/093_site_consent_receipts.sql'), 'utf8');
  await db.query(sql);
  await service.query('set role service_role');
  t.diagnostic(`Owned PostgreSQL ${(await one(db, 'show server_version')).server_version}; 093 SHA-256 ${createHash('sha256').update(sql).digest('hex')}; actual 058/062/093, no external DB`);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External network forbidden in consent audit tests'); });
  t.after(() => supabaseModule.setSupabaseServerClientFactoryForTests(null));

  await t.test('legacy version-only rows are preserved byte-for-byte, never backfilled or promoted on retry', async () => {
    assert.deepEqual(await one(db, 'select row_to_json(i) as value from public.crm_site_inquiries i where site_id=$1', [legacy.site]), legacyBefore);
    await assert.rejects(legacy.accept(service, legacyKey), /consent_receipt_unavailable/);
    assert.deepEqual(await legacy.counts(), { leads: 1, inquiries: 1, audits: 0 });
  });
  await t.test('hash canonicalization agrees with registry for Unicode, escaped text and line separators', async () => {
    assert.equal((await one(db, 'select public.valid_crm_site_consent_receipt($1::jsonb) as valid', [notice])).valid, true);
  });
  await t.test('browser ACL, inherited default grants, direct service mutations and legacy RPC are closed', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const permissions = await one(db, `select
        has_any_column_privilege($1,'public.crm_site_consent_receipts','SELECT') as can_read,
        has_any_column_privilege($1,'public.crm_site_consent_receipts','INSERT,UPDATE,REFERENCES') as can_mutate,
        has_table_privilege($1,'public.crm_site_consent_receipts','DELETE,TRUNCATE,TRIGGER') as can_remove,
        has_function_privilege($1,'public.accept_crm_site_inquiry(text,uuid,jsonb)','EXECUTE') as legacy,
        has_function_privilege($1,'public.accept_crm_site_inquiry_with_consent(text,uuid,jsonb,jsonb)','EXECUTE') as audited`, [role]);
      assert.deepEqual(permissions, { can_read: role === 'service_role', can_mutate: false, can_remove: false, legacy: false, audited: role === 'service_role' });
    }
    assert.equal((await one(db, "select relrowsecurity from pg_class where oid='public.crm_site_consent_receipts'::regclass")).relrowsecurity, true);
    await assert.rejects(service.query('select public.accept_crm_site_inquiry($1,$2,$3)', [legacy.siteKey, randomUUID(), inquiry]), /permission denied/);
    const anon = await fixture.connect(); await anon.query('set role anon');
    await assert.rejects(legacy.accept(anon), /permission denied/);
    await assert.rejects(anon.query('select notice_snapshot from public.crm_site_consent_receipts'), /permission denied/);
  });
  await t.test('accepted new inquiry atomically stores exact server snapshot, purpose, revision, hash and tenant', async () => {
    const f = await seed(); assert.deepEqual(await f.accept(), { accepted: true });
    const audit = await one(service, 'select * from public.crm_site_consent_receipts where site_id=$1', [f.site]);
    assert.deepEqual(audit.notice_snapshot, notice); assert.equal(audit.workspace_id, f.workspace);
    assert.equal(audit.binding_version, 'site-consent-v1');
    const saved = await one(db, 'select inquiry,consent_received_at from public.crm_site_inquiries where id=$1', [audit.inquiry_id]);
    assert.deepEqual(saved.inquiry, inquiry); assert.deepEqual(saved.consent_received_at, audit.consent_received_at);
    assert.deepEqual(await f.counts(), { leads: 1, inquiries: 1, audits: 1 });
  });
  await t.test('lost ACK replay is exact and cannot create another receipt or change its timestamp', async () => {
    const f = await seed(), key = randomUUID(); await f.accept(service, key);
    const before = await one(db, 'select row_to_json(r) as value from public.crm_site_consent_receipts r where site_id=$1', [f.site]);
    assert.deepEqual(await f.accept(service, key), { accepted: true });
    assert.deepEqual(await f.counts(), { leads: 1, inquiries: 1, audits: 1 });
    assert.deepEqual(await one(db, 'select row_to_json(r) as value from public.crm_site_consent_receipts r where site_id=$1', [f.site]), before);
  });
  for (const field of ['text', 'purpose', 'policyRevision', 'policyUrl', 'sha256']) {
    await t.test(`tampered ${field} without matching registry hash rolls back the entire intake`, async () => {
      const f = await seed(); await assert.rejects(f.accept(service, randomUUID(), inquiry, { ...notice, [field]: 'tampered' }), /invalid_consent_receipt/);
      assert.deepEqual(await f.counts(), { leads: 0, inquiries: 0, audits: 0 });
    });
  }
  await t.test('recomputed changed text/revision conflicts on replay instead of rewriting the accepted notice', async () => {
    const f = await seed(), key = randomUUID(); await f.accept(service, key);
    for (const field of ['text', 'policyRevision']) {
      await assert.rejects(f.accept(service, key, inquiry, bind({ ...notice, [field]: 'Changed synthetic revision' })), /request_conflict/);
    }
    assert.deepEqual((await one(db, 'select notice_snapshot from public.crm_site_consent_receipts where site_id=$1', [f.site])).notice_snapshot, notice);
  });
  await t.test('unknown version, malformed snapshots and visitor tenant/notice overrides never insert', async () => {
    const f = await seed();
    for (const snapshot of [null, {}, [], { ...notice, workspace_id: f.workspace }, { ...notice, sha256: null }, { ...notice, text: 1 }]) {
      await assert.rejects(f.accept(service, randomUUID(), inquiry, snapshot), /invalid_consent_receipt/);
    }
    const unknown = bind({ ...notice, version: 'unknown-synthetic' });
    await assert.rejects(f.accept(service, randomUUID(), { ...inquiry, consentVersion: unknown.version }, unknown), /invalid_inquiry/);
    for (const value of [{ ...inquiry, workspaceId: randomUUID() }, { ...inquiry, notice_snapshot: notice }]) {
      await assert.rejects(f.accept(service, randomUUID(), value), /invalid_inquiry/);
    }
    assert.deepEqual(await f.counts(), { leads: 0, inquiries: 0, audits: 0 });
  });
  await t.test('direct 058-owner call and raw inquiry insert cannot commit without the new audit', async () => {
    const f = await seed();
    await assert.rejects(db.query('select public.accept_crm_site_inquiry($1,$2,$3)', [f.siteKey, randomUUID(), inquiry]), /consent_receipt_required/);
    await assert.rejects(service.query('insert into public.crm_site_inquiries(site_id,request_key,inquiry) values($1,$2,$3)',
      [f.site, randomUUID(), inquiry]), /consent_receipt_required/);
    assert.deepEqual(await f.counts(), { leads: 0, inquiries: 0, audits: 0 });
  });
  await t.test('audit write failure rolls back new lead, inquiry and receipt without public success', async () => {
    const f = await seed();
    await db.query('alter table public.crm_site_consent_receipts add constraint synthetic_audit_failure check(false) not valid');
    try { await assert.rejects(f.accept(), /synthetic_audit_failure/); }
    finally { await db.query('alter table public.crm_site_consent_receipts drop constraint synthetic_audit_failure'); }
    assert.deepEqual(await f.counts(), { leads: 0, inquiries: 0, audits: 0 });
  });
  await t.test('receipt and accepted inquiry identity are immutable; direct cross-tenant audit binding is denied', async () => {
    const f = await seed(), other = await seed(); await f.accept(); await other.accept();
    await assert.rejects(db.query('update public.crm_site_consent_receipts set notice_snapshot=$1 where site_id=$2', [notice, f.site]), /consent_receipt_immutable/);
    await assert.rejects(db.query("update public.crm_site_inquiries set inquiry=jsonb_set(inquiry,'{consentVersion}','\"other\"') where site_id=$1", [f.site]), /consent_receipt_immutable/);
    const id = (await one(db, 'select inquiry_id from public.crm_site_consent_receipts where site_id=$1', [f.site])).inquiry_id;
    await db.query('begin');
    try {
      await db.query('delete from public.crm_site_consent_receipts where inquiry_id=$1', [id]);
      await assert.rejects(db.query(`insert into public.crm_site_consent_receipts(inquiry_id,site_id,workspace_id,notice_snapshot,consent_received_at)
        select id,$2,$3,$4,consent_received_at from public.crm_site_inquiries where id=$1`, [id, other.site, other.workspace, notice]), /consent_receipt_mismatch/);
    } finally { await db.query('rollback'); }
    assert.deepEqual(await f.counts(), { leads: 1, inquiries: 1, audits: 1 });
    assert.deepEqual(await other.counts(), { leads: 1, inquiries: 1, audits: 1 });
  });
  await t.test('concurrent same-key submissions serialize and replay one immutable audit', async () => {
    const f = await seed(), a = await fixture.connect(), b = await fixture.connect();
    const key = randomUUID(); await a.query('begin; set local role service_role'); await b.query('set role service_role');
    try {
      await f.accept(a, key);
      const aPid = (await one(a, 'select pg_backend_pid() as id')).id;
      const bPid = (await one(b, 'select pg_backend_pid() as id')).id;
      const pending = observed(f.accept(b, key));
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await one(db, 'select $1::int=any(pg_blocking_pids($2)) as blocked', [aPid, bPid])).blocked) { blocked = true; break; }
        await delay(10);
      }
      assert.equal(blocked, true, 'Observed actual database contention, not a sleep-only assertion');
      await a.query('commit'); assert.deepEqual((await pending).value, { accepted: true });
      assert.deepEqual(await f.counts(), { leads: 1, inquiries: 1, audits: 1 });
    } finally { await a.query('rollback'); await a.end(); await b.end(); }
  });
  await t.test('existing 062 explicit erasure also removes notice snapshot and refuses erased transport replay', async () => {
    const f = await seed(), key = randomUUID(); await f.accept(service, key);
    const saved = await one(db, `select l.id,l.updated_at::text as updated_at,i.id as inquiry_id from public.leads l
      join public.crm_site_inquiries i on i.lead_id=l.id where l.workspace_id=$1`, [f.workspace]);
    const erased = await one(service, 'select public.delete_crm_site_inquiry($1,$2,$3,$4,$5,$6,$7,$8,true) as result',
      [f.workspace, f.siteKey, saved.id, [saved.inquiry_id], saved.updated_at, f.staff, f.auth, randomUUID()]);
    assert.deepEqual(erased.result, { deleted: true, receiptsDeleted: 1, replayed: false });
    assert.deepEqual(await f.counts(), { leads: 0, inquiries: 0, audits: 0 });
    await assert.rejects(f.accept(service, key), /inquiry_erased/);
  });
  await t.test('actual page -> form.js -> handler -> 058/093 stores the displayed synthetic notice, not browser-supplied snapshot', async () => {
    const f = await seed();
    const env = { MEDINA_PUBLIC_SITE_ENABLED: 'true', MEDINA_PUBLIC_SITE_WORKSPACE_ID: f.workspace,
      MEDINA_SITE_ORIGIN: 'https://site.fixture.invalid', MEDINA_SITE_INDEXABLE: 'false', MEDINA_SITE_FORM_ENABLED: 'true',
      MEDINA_SITE_INTAKE_ENABLED: 'true', MEDINA_SITE_INTAKE_KEY: f.siteKey,
      MEDINA_SITE_TURNSTILE_SECRET: 'SYNTHETIC-NOT-A-SECRET', MEDINA_SITE_TURNSTILE_SITE_KEY: 'synthetic-public-fixture' };
    const previous = Object.entries(env).map(([k]) => [k, process.env[k]]);
    let rpcCalls = 0;
    Object.assign(process.env, env);
    supabaseModule.setSupabaseServerClientFactoryForTests(() => ({
      from(table) {
        let key;
        const q = { select() { return q; }, eq(_field, value) { key = value; return q; }, not() { return q; }, order() { return q; },
          async limit() { assert.equal(table, 'site_blog_posts'); return { data: [], error: null }; },
          async maybeSingle() { assert.equal(table, 'crm_intake_sites');
            return { data: await one(db, 'select workspace_id,enabled,consent_version,allowed_page_paths from public.crm_intake_sites where site_key=$1', [key]), error: null }; },
        }; return q;
      },
      async rpc(name, args) {
        rpcCalls++; assert.equal(name, 'accept_crm_site_inquiry_with_consent');
        assert.deepEqual(args.p_consent_receipt, notice); assert.deepEqual(args.p_inquiry, inquiry);
        try { return { data: (await one(service, 'select public.accept_crm_site_inquiry_with_consent($1,$2,$3,$4) as result',
          [args.p_site_key, args.p_request_key, args.p_inquiry, args.p_consent_receipt])).result, error: null }; }
        catch (error) { return { data: null, error: { message: error.message } }; }
      },
    }));
    try {
      const page = await call(pageModule.createSitePageHandler({ resolveConsent, renderPages: render }), { method: 'GET', query: { page: '/ru/' } });
      assert.equal(page.status, 200); assert.match(page.html, /&lt;not legal copy&gt;/);
      assert.ok(page.html.includes(`data-notice-sha256="${notice.sha256}"`));
      const handler = intakeModule.createSiteIntakeHandler({ env: () => env, resolveConsent, verify: async () => true });
      const sent = await submitActualForm(page.html, handler, randomUUID());
      assert.equal(sent.response.status, 200); assert.deepEqual(sent.response.payload, { success: true });
      assert.deepEqual(Object.keys(sent.body).sort(), ['challengeToken', 'inquiry', 'requestKey']);
      assert.deepEqual(sent.body.inquiry, inquiry); assert.equal(sent.dataset.sent, 'true'); assert.equal(rpcCalls, 1);
      assert.deepEqual((await one(db, 'select notice_snapshot from public.crm_site_consent_receipts where site_id=$1', [f.site])).notice_snapshot, notice);
      assert.deepEqual(await f.counts(), { leads: 1, inquiries: 1, audits: 1 });
      // The unchanged production renderer/registry has no approved notices or active form.
      assert.equal(registry.resolveSiteConsent(notice.version), null);
      assert.doesNotMatch(defaultPages({ endpoint: `${env.MEDINA_SITE_ORIGIN}/api/crm/site-inquiry`, siteKey: 'fixture',
        consentVersion: notice.version }, { preview: false, origin: env.MEDINA_SITE_ORIGIN }).get('/ru/'), /data-intake-endpoint/);
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      supabaseModule.setSupabaseServerClientFactoryForTests(null);
    }
  });
});
