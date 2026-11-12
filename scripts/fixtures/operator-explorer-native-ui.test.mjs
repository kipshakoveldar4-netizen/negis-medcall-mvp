import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ownedRecoveryBrowser, root } from '../src/appointment-recovery-committed-fixture.ts';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startNativePostgres } from './native-postgres.mjs';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds } from './partner-entry-http-fixture.mjs';
import {
  seedOperatorExplorer, operatorExplorerNativeAdapter, operatorExplorerNativeBundle,
  operatorExplorerNativeServer, explorerFinancialSnapshot, stopOperatorExplorerBuilds,
} from './operator-explorer-native-ui-fixture.mjs';

const SEARCH = 'read_growth_operator_lead_search';
const STAGE = 'set_growth_operator_lead_stage';
const BOOK = 'create_growth_operator_booking';
const list = '.operator-lead-explorer__list > li';
const details = '.operator-lead-explorer__details';
const bookingForm = `${details} form:not(.operator-lead-explorer__stage-editor)`;
const notice = '.operator-lead-explorer__notice:not(:has(.operator-lead-explorer__spinner))';
const busyNotice = '.operator-lead-explorer__spinner';
const row = id => `[data-lead-id="${id}"]`;
const literal = JSON.stringify;
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const zero = { appointments: 0, clients: 0, receipts: 0, booking_audits: 0, stage_audits: 0 };
const copy = {
  stageSaved: '\u0421\u0442\u0430\u0434\u0438\u044f \u0437\u0430\u044f\u0432\u043a\u0438 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0430.',
  booked: '\u0417\u0430\u043f\u0438\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0430',
  cancelled: '\u0417\u0430\u043f\u0438\u0441\u044c \u043e\u0442\u043c\u0435\u043d\u0435\u043d\u0430',
  no_show: '\u041f\u0430\u0446\u0438\u0435\u043d\u0442 \u043d\u0435 \u043f\u0440\u0438\u0448\u0451\u043b',
  incomplete: '\u0417\u0430\u043f\u0438\u0441\u044c \u0442\u0440\u0435\u0431\u0443\u0435\u0442 \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438',
  check: '\u041f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435',
};

async function until(check, message = 'Owned Explorer condition did not settle') {
  for (let n = 0; n < 400; n++) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
}

async function publicCounts(db) {
  const names = (await db.query("select tablename from pg_catalog.pg_tables where schemaname='public' order by tablename")).rows.map(r => r.tablename);
  assert.ok(names.length && names.every(name => /^[a-z][a-z0-9_]*$/.test(name)));
  return (await db.query(names.map(name => `select '${name}' table_name,count(*)::int rows from public.${name}`).join(' union all ') + ' order by table_name')).rows;
}

const calls = (ctx, name) => ctx.native.controls.calls.filter(call => call.name === name);
const writes = (ctx, method) => ctx.server.controls.requests.filter(request => request.route !== 'operator-lead-search' && request.method === method);
const state = (ctx, lead) => one(ctx.db, 'select stage_id,status,client_id from public.leads where id=$1', [lead]);
const counts = async (ctx, expected = {}) => assert.deepEqual(await ctx.f.counts(), { ...zero, ...expected });

async function capture(ctx, label, selector) {
  const layout = await ctx.browser.evaluate(`const target=document.querySelector(${literal(selector)});if(!target)throw Error('Missing screenshot target');
    target.scrollIntoView({block:'center',behavior:'instant'});
    const controls=[...target.querySelectorAll('button,select,input,textarea')].flatMap(el=>{
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);if(!r.width||!r.height||s.visibility==='hidden')return [];
      let bad=r.left < -1||r.right>innerWidth+1||r.top < -1||r.bottom>innerHeight+1||el.scrollWidth>el.clientWidth+1;
      for(let p=el.parentElement;p&&p!==document.body;p=p.parentElement){const ps=getComputedStyle(p),pr=p.getBoundingClientRect();
        if(/hidden|clip|auto|scroll/.test(ps.overflowX))bad ||= r.left<pr.left-1||r.right>pr.right+1;
        if(/hidden|clip|auto|scroll/.test(ps.overflowY))bad ||= r.top<pr.top-1||r.bottom>pr.bottom+1;}
      return [{tag:el.tagName,left:r.left,right:r.right,top:r.top,bottom:r.bottom,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,clipped:bad}];});
    const r=target.getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
      controls,clipped:controls.filter(c=>c.clipped),targetVisible:r.bottom>0&&r.top<innerHeight,targetFullyVisible:r.top>=0&&r.bottom<=innerHeight};`);
  const name = `${ctx.prefix}-${label}-${layout.width}.png`;
  await writeFile(path.join(ctx.evidenceDirectory, name), await ctx.browser.screenshot());
  ctx.screenshots.push({ file: name, ...layout });
  assert.ok(layout.scrollWidth <= layout.width, 'The actual stylesheet must fit the viewport');
  assert.equal(layout.targetVisible, true);
  assert.equal(layout.targetFullyVisible, true, 'The selected stage/booking/recovery surface must fit inside the screenshot');
  assert.ok(layout.controls.length, 'A screenshot must contain the actual selected surface controls');
  assert.deepEqual(layout.clipped, [], 'Selected surface controls/text must fit the viewport and their clipping ancestors');
}

async function receipt(ctx, name, width, height) {
  const actorFor = token => Object.entries(ctx.f?.tokens ?? {}).find(([, value]) => 'Bearer ' + value === token)?.[0] ?? null;
  const http = (ctx.server?.controls.requests ?? []).map(request => {
    const url = new URL(request.url, 'http://owned.invalid');
    if (url.searchParams.get('search')) url.searchParams.set('search', '[redacted]');
    return { route: request.route, method: request.method, url: url.pathname + url.search, actorId: actorFor(request.actorToken),
      body: request.route === 'operator-lead-search' ? null : request.body, status: request.status, cache: request.cache };
  });
  const workspaces = [...(ctx.f?.a.companies ?? []), ...(ctx.f?.b.companies ?? [])].map(c => c.workspace);
  const bookings = workspaces.length ? (await ctx.db.query(`select b.request_key,b.operator_request_id,b.lead_id,b.doctor_id,b.service_ids,
    b.starts_local::text,b.time_zone,a.id appointment_id,a.starts_at,a.price_minor::text,a.duration_minutes,a.status
    from public.growth_operator_bookings b join public.appointments a on a.id=b.appointment_id
    where b.workspace_id=any($1::uuid[]) order by b.request_key`, [workspaces])).rows : [];
  const mutationLeads = [...new Set(calls(ctx, STAGE).map(call => call.args.p_lead_id))];
  const stages = mutationLeads.length ? (await ctx.db.query('select id,workspace_id,stage_id,status from public.leads where id=any($1::uuid[]) order by id', [mutationLeads])).rows : [];
  const value = { name, viewport: { width, height },
    boundary: 'Standalone actual OperatorLeadExplorer + OperatorBookingForm + HTTP catch-all + native SQL; controlled parent and synthetic SDK/Auth responder, not live Auth or full Portal acceptance.',
    http, native: ctx.native.controls.calls.map(call => call.name === SEARCH
      ? { ...call, args: { ...call.args, p_search: '[redacted]' } } : call), catalogueReads: ctx.native.controls.reads,
    counts: ctx.f ? await ctx.f.counts() : null, bookings, stages, screenshots: ctx.screenshots };
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /Bearer |owned\.[0-9a-f-]+\.signature|PRIVATE_|\+77000005201|EXPLORER_MATCHED|client_name|client_phone/);
  return value;
}

async function select(ctx, selector, value) {
  await ctx.browser.waitFor(`document.querySelector(${literal(selector)}) && !document.querySelector(${literal(selector)}).disabled`);
  await ctx.browser.evaluate(`const s=document.querySelector(${literal(selector)});s.value=${literal(value)};s.dispatchEvent(new Event('change',{bubbles:true}));`);
}

async function ready(ctx, size) {
  await ctx.browser.waitFor(`document.querySelector('.operator-lead-explorer')?.getAttribute('aria-busy')==='false' && document.querySelectorAll(${literal(list)}).length===${size}`);
}

async function readAction(ctx, action, size) {
  const before = calls(ctx, SEARCH).length;
  await action();
  await until(() => calls(ctx, SEARCH).length > before, 'A real Explorer action must reach the native search RPC');
  await ready(ctx, size);
}

async function laterPage(ctx) {
  await ready(ctx, 20);
  await readAction(ctx, () => ctx.browser.evaluate("document.querySelector('.operator-lead-explorer__pages button:last-child').click();"), 10);
  assert.deepEqual(calls(ctx, SEARCH).at(-1).args, { p_actor: ctx.f.a.actor, p_search: '', p_group: 'all', p_request_id: null, p_offset: 20 });
  for (const c of ctx.f.a.companies) {
    assert.equal(await ctx.browser.evaluate(`return !!document.querySelector(${literal(row(c.leads[0]))});`), true, 'Both same-contact base leads are on the actual later page');
  }
}

async function openLead(ctx, lead) {
  const selector = row(lead);
  await ctx.browser.waitFor(`!!document.querySelector(${literal(selector)})`);
  if (!await ctx.browser.evaluate(`return !!document.querySelector(${literal(selector + ' ' + details)});`)) {
    await ctx.browser.evaluate(`document.querySelector(${literal(selector + ' .operator-lead-explorer__row button')}).click();`);
  }
  await ctx.browser.waitFor(`!!document.querySelector(${literal(selector + ' ' + details)})`);
}

async function sendStage(ctx, c, lead, target) {
  await openLead(ctx, lead);
  const form = row(lead) + ' .operator-lead-explorer__stage-editor';
  await select(ctx, form + ' select', target);
  await ctx.browser.waitFor(`!document.querySelector(${literal(form + ' button[type=submit]')}).disabled`);
  if (ctx.captureStage) {
    await capture(ctx, 'stage-ready', row(lead) + ' ' + details);
    ctx.captureStage = false;
  }
  await ctx.browser.evaluate(`document.querySelector(${literal(form)}).requestSubmit();`);
}

function assertStageWire(ctx, c, lead, target, before, status = 200) {
  const request = writes(ctx, 'PATCH').at(-1), call = calls(ctx, STAGE).at(-1);
  assert.deepEqual(request.body, { leadId: lead, stageId: target, expectedStageId: before.stage_id, expectedStatus: before.status });
  assert.equal(request.url, `/api/crm/operator-leads?requestId=${c.request}`);
  assert.equal(request.actorToken, 'Bearer ' + ctx.f.tokens[ctx.f.a.actor]);
  assert.equal(request.status, status);
  assert.deepEqual(call.args, { p_request_id: c.request, p_operator_user_id: ctx.f.a.actor, p_lead_id: lead,
    p_stage_id: target, p_expected_stage_id: before.stage_id, p_expected_status: before.status });
  return call;
}

async function groupCounts(ctx, expected) {
  const actual = await ctx.browser.evaluate("return Object.fromEntries([...document.querySelectorAll('[data-lead-group]')].map(b=>[b.dataset.leadGroup,b.querySelector('.operator-lead-explorer__count').textContent]));");
  assert.deepEqual(actual, { all: '30', new: '0', in_progress: '30', booked: '0', postponed: '0', lost: '0', other: '0', ...expected });
}

async function openBooking(ctx, c, lead) {
  await openLead(ctx, lead);
  await ctx.browser.evaluate(`document.querySelector(${literal(row(lead) + ' .operator-lead-explorer__booking-button')}).click();`);
  await ctx.browser.waitFor(`!!document.querySelector(${literal(bookingForm)})`);
  await until(() => calls(ctx, 'read_growth_operator_booking_context').some(call => call.args.p_request_id === c.request && call.args.p_lead_id === lead));
  const context = calls(ctx, 'read_growth_operator_booking_context').at(-1);
  assert.deepEqual(context.args, { p_request_id: c.request, p_operator_user_id: ctx.f.a.actor, p_lead_id: lead });
}

async function fillBooking(ctx, c, lead, startsLocal = '2030-01-07T10:00') {
  await openBooking(ctx, c, lead);
  await ctx.browser.waitFor(`!!document.querySelector(${literal(bookingForm + ' select option[value="' + c.doctor + '"]')})`);
  await select(ctx, bookingForm + ' select', c.doctor);
  await ctx.browser.waitFor(`document.querySelectorAll(${literal(bookingForm + ' input[type=checkbox]')}).length===2`);
  await ctx.browser.evaluate(`for(const c of document.querySelectorAll(${literal(bookingForm + ' input[type=checkbox]')})){if(!c.checked)c.click();}
    const d=document.querySelector(${literal(bookingForm + ' input[type=datetime-local]')});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(d,${literal(startsLocal)});
    d.dispatchEvent(new Event('input',{bubbles:true}));d.dispatchEvent(new Event('change',{bubbles:true}));`);
  await ctx.browser.waitFor(`!document.querySelector(${literal(bookingForm + ' button[type=submit]')}).disabled`);
  const text = (await ctx.browser.evaluate(`return document.querySelector(${literal(bookingForm)}).innerText;`)).replace(/\s/g, ' ');
  assert.match(text, /1 500,50/);
  assert.match(text, /75/);
  if (ctx.captureBooking) {
    await capture(ctx, 'booking-ready', bookingForm);
    ctx.captureBooking = false;
  }
  return { leadId: lead, doctorId: c.doctor, serviceIds: c.services, startsLocal, timeZone: c.zone };
}

const submitBooking = ctx => ctx.browser.evaluate(`document.querySelector(${literal(bookingForm)}).requestSubmit();`);

function assertBookingWire(ctx, c, lead, expected, status = 200) {
  const request = writes(ctx, 'POST').at(-1), call = calls(ctx, BOOK).at(-1);
  const key = request.body.requestKey;
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(request.body, { ...expected, requestKey: key });
  assert.equal(request.url, `/api/crm/operator-bookings?requestId=${c.request}`);
  assert.equal(request.actorToken, 'Bearer ' + ctx.f.tokens[ctx.f.a.actor]);
  assert.equal(request.status, status);
  assert.deepEqual(call.args, { p_request_id: c.request, p_operator_user_id: ctx.f.a.actor, p_lead_id: lead,
    p_request_key: key, p_doctor_id: c.doctor, p_service_ids: expected.serviceIds, p_starts_local: expected.startsLocal, p_time_zone: c.zone });
  return { request, call, key };
}

async function assertBookingRows(ctx, c, lead, key) {
  const saved = await one(ctx.db, `select a.*,a.price_minor::text exact_price,b.request_key,b.operator_request_id,b.lead_id,
    b.service_ids,b.starts_local::text local_start,b.time_zone,l.client_id lead_client_id
    from public.appointments a join public.growth_operator_bookings b on b.appointment_id=a.id
    join public.leads l on l.id=b.lead_id where a.id=$1`, [key]);
  assert.equal(saved.id, key);
  assert.equal(saved.request_key, key);
  assert.equal(saved.workspace_id, c.workspace);
  assert.equal(saved.operator_request_id, c.request);
  assert.equal(saved.lead_id, lead);
  assert.equal(saved.doctor_id, c.doctor);
  assert.deepEqual(saved.service_ids, c.services);
  assert.equal(saved.local_start, '2030-01-07 10:00:00');
  assert.equal(saved.time_zone, c.zone);
  assert.equal(saved.starts_at.toISOString(), c.zone === 'UTC' ? '2030-01-07T10:00:00.000Z' : '2030-01-07T05:00:00.000Z');
  assert.equal(saved.exact_price, '150050');
  assert.equal(saved.duration_minutes, 75);
  assert.equal(saved.status, 'scheduled');
  assert.equal(saved.service, 'Public service A + Public service B');
  assert.equal(saved.doctor_name, 'Public booked specialist');
  assert.deepEqual(saved.service_items, c.services.map((id, i) => ({ serviceId: id, name: 'Public service ' + (i ? 'B' : 'A'), priceMinor: i ? 25001 : 125049, durationMinutes: i ? 30 : 45 })));
  assert.equal(saved.client_id, saved.lead_client_id);
  const client = await one(ctx.db, 'select workspace_id,full_name,phone_normalized from public.clients where id=$1', [saved.client_id]);
  assert.deepEqual(client, { workspace_id: c.workspace, full_name: 'EXPLORER_MATCHED', phone_normalized: '+77000005201' });
  const audit = (await ctx.db.query("select actor_role,entity_id,metadata from public.audit_logs where workspace_id=$1 and action='operator_appointment_created'", [c.workspace])).rows;
  assert.deepEqual(audit, [{ actor_role: 'operator', entity_id: key, metadata: { operator_request_id: c.request, lead_id: lead } }]);
  return saved;
}

async function booked(ctx, expected = copy.booked) {
  await ctx.browser.waitFor(`document.querySelector(${literal(notice)})?.textContent.includes(${literal(expected)}) && !document.querySelector(${literal(bookingForm)})`);
  await ready(ctx, 20);
  assert.deepEqual((await ctx.browser.evaluate('return f.snapshot();')).attempts, []);
}

async function retainedAttempt(ctx, expected, key) {
  const attempts = (await ctx.browser.evaluate('return f.snapshot();')).attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0][0], `medina_operator_booking_attempt_v1:${ctx.f.a.actor}:${ctx.f.a.companies.find(c => c.leads.includes(expected.leadId)).request}:${expected.leadId}`);
  const value = JSON.parse(attempts[0][1]);
  assert.deepEqual(value.payload, expected);
  assert.equal(value.actorId, ctx.f.a.actor);
  assert.equal(value.requestId, ctx.f.a.companies.find(c => c.leads.includes(expected.leadId)).request);
  assert.equal(value.requestKey, key);
  assert.doesNotMatch(attempts[0][1], /EXPLORER|phone|clientName|full_name/);
  return value;
}

async function committedWithoutAck(ctx, c) {
  await laterPage(ctx);
  const expected = await fillBooking(ctx, c, c.leads[0]);
  ctx.server.controls.mode = 'drop';
  await submitBooking(ctx);
  await until(() => writes(ctx, 'POST').length === 1);
  const original = assertBookingWire(ctx, c, c.leads[0], expected);
  await ctx.browser.waitFor(`document.querySelector(${literal(bookingForm + ' button[type=submit]')})?.textContent.includes(${literal(copy.check)})`);
  await counts(ctx, { appointments: 1, clients: 1, receipts: 1, booking_audits: 1 });
  await assertBookingRows(ctx, c, c.leads[0], original.key);
  assert.equal((await retainedAttempt(ctx, expected, original.key)).uncertain, true);
  return { expected, original };
}

async function reloadRecovery(ctx, c, expected, original) {
  const boot = await ctx.browser.evaluate('return f.bootId;');
  await ctx.browser.load();
  assert.notEqual(await ctx.browser.evaluate('return f.bootId;'), boot, 'Recovery must survive an actual document reload');
  await laterPage(ctx);
  await openBooking(ctx, c, c.leads[0]);
  await ctx.browser.waitFor(`document.querySelector(${literal(bookingForm + ' button[type=submit]')})?.textContent.includes(${literal(copy.check)})`);
  assert.equal(await ctx.browser.evaluate(`return document.querySelector(${literal(bookingForm + ' fieldset')}).disabled;`), true);
  assert.equal(await ctx.browser.evaluate(`return document.querySelector(${literal(bookingForm + ' button[type=submit]')}).disabled;`), false);
  await retainedAttempt(ctx, expected, original.key);
  assert.equal(writes(ctx, 'POST').length, 1, 'Reload/reopen must not automatically retry a mutation');
  if (ctx.captureRecovery) await capture(ctx, 'recovery-ready', bookingForm);
  await submitBooking(ctx);
  await until(() => writes(ctx, 'POST').length === 2);
  const replay = assertBookingWire(ctx, c, c.leads[0], expected);
  assert.deepEqual(replay.request.body, original.request.body, 'Recovery must replay the exact original key and ordered payload');
  assert.deepEqual(replay.call.args, original.call.args);
  assert.equal(replay.key, original.key);
}

async function view(ctx) {
  return ctx.browser.evaluate(`return {actor:f.actor,rows:[...document.querySelectorAll(${literal(list)})].map(r=>r.dataset.leadId),
    company:document.querySelector('.operator-lead-explorer__company select')?.value,
    group:document.querySelector('.operator-lead-explorer__group-select select')?.value,
    open:document.querySelector(${literal(details)})?.id??null,notice:document.querySelector(${literal(notice)})?.textContent??null,
    attempts:f.snapshot().attempts,denials:f.denials};`);
}

test('actual operator Explorer browser actions reach catch-all and owned native SQL without retargeting or duplicate recovery', { timeout: 900000 }, async t => {
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1', 'Explicit disposable native opt-in; no external database or download fallback');
  const assets = await stat(path.join(root, 'artifacts/negis/dist/public/assets')).catch(() => null);
  assert.ok(assets?.isDirectory(), 'Build the local frontend with pnpm --filter @workspace/negis run build before starting PostgreSQL');
  let fixture, db, failed;
  try {
    const evidenceDirectory = await mkdtemp(path.join(root, 'node_modules/.cache/operator-explorer-native-ui-'));
    console.log('Owned Explorer evidence directory: ' + evidenceDirectory);
    const chain = await readReviewedChain(path.join(root, 'migrations'));
    assert.equal(chain[0].file.slice(0, 3), '009');
    assert.ok(chain.some(entry => entry.file === '124_operator_lead_search.sql'));
    fixture = await startNativePostgres();
    db = await fixture.connect();
    await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
      alter table storage.objects enable row level security;`);
    for (const entry of chain) await db.query(entry.source);
    const clean = await publicCounts(db), financial = await explorerFinancialSnapshot(db);
    let caseNumber = 0;

    async function scenario(name, width, height, action) {
      await t.test(name, { timeout: 60000 }, async () => {
        const ctx = { db, native: operatorExplorerNativeAdapter(fixture), evidenceDirectory, screenshots: [],
          prefix: `${String(++caseNumber).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 75)}` };
        let failure;
        try {
          ctx.f = await seedOperatorExplorer(db);
          assert.equal(ctx.f.a.companies[0].extraLeads.length, 24);
          const identities = new Map(Object.entries(ctx.f.tokens).map(([actor, token]) => [token, actor]));
          ctx.router = await partnerEntryHttpFixture(ctx.native.adapter, { approved: false, identities, env: { MEDINA_PARTNER_ENTRY_ENABLED: 'false' } });
          ctx.server = await operatorExplorerNativeServer(ctx.router.handler, await operatorExplorerNativeBundle(ctx.f));
          ctx.browser = await ownedRecoveryBrowser(ctx.server.origin, { settleTimeoutMs: 15000 });
          await ctx.browser.viewport(width, height);
          await ready(ctx, 20);
          await groupCounts(ctx, {});
          await counts(ctx);
          assert.ok(calls(ctx, SEARCH).every(call => call.args.p_actor === ctx.f.a.actor && call.args.p_offset === 0));
          await action(ctx);
          await until(() => ctx.server.controls.active.size === 0);
          assert.deepEqual(ctx.server.controls.errors, []);
          assert.deepEqual(ctx.router.state.unexpected, []);
          assert.deepEqual(ctx.router.state.challenges, []);
          assert.deepEqual(ctx.browser.exceptions, []);
          assert.ok(ctx.server.controls.requests.every(request => request.cache === 'no-store'));
          const searches = ctx.server.controls.requests.filter(request => request.route === 'operator-lead-search');
          assert.ok(searches.length > 0);
          assert.ok(searches.every(request => request.method === 'POST' && request.url === '/api/crm/operator-lead-search'));
          assert.equal((await ctx.browser.evaluate('return f.snapshot();')).overflow, false);
          assert.equal(await ctx.browser.evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true);
          assert.ok(ctx.browser.requests.every(url => {
            if (new URL(url).origin === ctx.server.origin) return true;
            return /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)
              && createHash('sha256').update(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')).digest('hex')
                === 'eb81a37ffe395a3a8115531f89d79d95cc521e967078294c0cdd21b5e6227405';
          }), 'Only the owned HTTP origin and the pinned native date-input icon are allowed');
          assert.deepEqual(await explorerFinancialSnapshot(db), financial);
        } catch (error) { failure = error; }
        finally {
          // Release both sides before draining HTTP or tearing down the owned rows.
          ctx.native.release();
          ctx.server?.release();
          const errors = [];
          for (const close of [() => ctx.browser?.close(), () => ctx.server?.close(), () => ctx.router?.close()]) {
            try { await close(); } catch (error) { errors.push(error); }
          }
          let evidence;
          try { evidence = await receipt(ctx, name, width, height); } catch (error) { errors.push(error); }
          const cleanup = { financialUnchanged: false, publicBusinessRowsRestored: false };
          for (const close of [() => ctx.f?.cleanup(),
            async () => { assert.deepEqual(await explorerFinancialSnapshot(db), financial); cleanup.financialUnchanged = true; },
            async () => { const actual = await publicCounts(db); assert.deepEqual(actual, clean); cleanup.publicBusinessRowsRestored = true;
              cleanup.remainingPublicBusinessRows = actual.reduce((total, row) => total + row.rows, 0); }]) {
            try { await close(); } catch (error) { errors.push(error); }
          }
          try {
            await writeFile(path.join(evidenceDirectory, ctx.prefix + '.json'), JSON.stringify({ ...evidence, cleanup,
              outcome: failure || errors.length ? 'failed' : 'passed', failureType: failure?.name ?? null, cleanupErrorTypes: errors.map(error => error.name) }, null, 2));
          } catch (error) { errors.push(error); }
          if (failure || errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], name + ': browser/native failure or owned cleanup mismatch');
        }
      });
    }

    for (const [width, height] of [[375, 900], [1440, 1000]]) {
      await scenario(`${width}: later-page stages, both same-contact companies, exact UTC bookings and custom lost totals`, width, height, async ctx => {
        ctx.captureStage = true;
        ctx.captureBooking = true;
        const saved = [];
        for (const [index, c] of ctx.f.a.companies.entries()) {
          await laterPage(ctx);
          const before = await state(ctx, c.leads[0]);
          await sendStage(ctx, c, c.leads[0], c.deferred);
          await until(() => writes(ctx, 'PATCH').length === index + 1);
          assert.equal(assertStageWire(ctx, c, c.leads[0], c.deferred, before).code, null);
          await ctx.browser.waitFor(`document.querySelector(${literal(notice)})?.textContent===${literal(copy.stageSaved)}`);
          await ready(ctx, 20);
          assert.equal((await state(ctx, c.leads[0])).stage_id, c.deferred);
          assert.equal((await state(ctx, c.leads[0])).status, 'OWNED Deferred');
          await groupCounts(ctx, { in_progress: String(29 - index), postponed: String(index + 1) });
          await laterPage(ctx);
          const expected = await fillBooking(ctx, c, c.leads[0]);
          await submitBooking(ctx);
          await until(() => writes(ctx, 'POST').length === index + 1);
          const wire = assertBookingWire(ctx, c, c.leads[0], expected);
          await booked(ctx);
          saved.push(await assertBookingRows(ctx, c, c.leads[0], wire.key));
          await counts(ctx, { appointments: index + 1, clients: index + 1, receipts: index + 1, booking_audits: index + 1, stage_audits: index + 1 });
        }
        assert.notEqual(saved[0].client_id, saved[1].client_id, 'Matching contact data must not cross company boundaries');
        assert.equal(calls(ctx, BOOK).length, 2);
        assert.ok(ctx.native.controls.reads.some(read => read.table === 'clinic_services' && read.selected.includes('::text') && read.count === 21));
        const c = ctx.f.a.companies[0];
        await laterPage(ctx);
        const before = await state(ctx, c.leads[0]);
        await sendStage(ctx, c, c.leads[0], c.lost);
        await until(() => writes(ctx, 'PATCH').length === 3);
        assertStageWire(ctx, c, c.leads[0], c.lost, before);
        await ready(ctx, 20);
        await groupCounts(ctx, { in_progress: '28', postponed: '1', lost: '1' });
        await readAction(ctx, () => ctx.browser.evaluate("document.querySelector('[data-lead-group=lost]').click();"), 1);
        assert.deepEqual(await ctx.browser.evaluate(`return [...document.querySelectorAll(${literal(list)})].map(r=>r.dataset.leadId);`), [c.leads[0]]);
        assert.match((await ctx.browser.evaluate('return f.snapshot();')).text, /OWNED Lost/);
        await counts(ctx, { appointments: 2, clients: 2, receipts: 2, booking_audits: 2, stage_audits: 3 });
      });
    }

    for (const field of ['stage_id', 'status']) {
      await scenario(`CAS: a database-only ${field} change after the UI read refuses the original stage command`, 1440, 1000, async ctx => {
        const c = ctx.f.a.companies[0], lead = c.leads[0];
        await laterPage(ctx);
        await openLead(ctx, lead);
        const before = await state(ctx, lead);
        if (field === 'stage_id') await db.query('update public.leads set stage_id=$2 where id=$1', [lead, c.lost]);
        else await db.query("update public.leads set status='OWNED concurrent status' where id=$1", [lead]);
        const changed = await state(ctx, lead);
        assert.equal(field === 'stage_id' ? changed.status : changed.stage_id, field === 'stage_id' ? before.status : before.stage_id);
        await sendStage(ctx, c, lead, c.deferred);
        await until(() => writes(ctx, 'PATCH').length === 1);
        assert.equal(assertStageWire(ctx, c, lead, c.deferred, before, 409).code, 'PT409');
        await ctx.browser.waitFor("!!document.querySelector('.operator-lead-explorer__error')");
        await ready(ctx, 20);
        assert.deepEqual(await state(ctx, lead), changed);
        assert.equal((await view(ctx)).notice, null);
        assert.equal(calls(ctx, STAGE).length, 1);
        await counts(ctx);
      });
    }

    await scenario('closing a filled but unsent booking and lead detail makes no mutation or recovery key', 375, 900, async ctx => {
      const c = ctx.f.a.companies[0];
      await laterPage(ctx);
      await fillBooking(ctx, c, c.leads[0]);
      await ctx.browser.evaluate(`document.querySelector(${literal(row(c.leads[0]) + ' .operator-lead-explorer__booking-button')}).click();`);
      await ctx.browser.waitFor(`!document.querySelector(${literal(bookingForm)})`);
      await openBooking(ctx, c, c.leads[0]);
      await ctx.browser.waitFor(`!!document.querySelector(${literal(bookingForm + ' select')})`);
      assert.equal(await ctx.browser.evaluate(`return document.querySelector(${literal(bookingForm + ' select')}).value;`), '');
      assert.equal(await ctx.browser.evaluate(`return document.querySelector(${literal(bookingForm + ' input[type=datetime-local]')}).value;`), '');
      await ctx.browser.evaluate(`document.querySelector(${literal(row(c.leads[0]) + ' .operator-lead-explorer__row button')}).click();`);
      await ctx.browser.waitFor(`!document.querySelector(${literal(details)})`);
      assert.deepEqual((await ctx.browser.evaluate('return f.snapshot();')).attempts, []);
      assert.equal(writes(ctx, 'POST').length + writes(ctx, 'PATCH').length, 0);
      assert.equal(calls(ctx, BOOK).length + calls(ctx, STAGE).length, 0);
      await counts(ctx);
    });

    for (const result of ['scheduled', 'cancelled', 'no_show', 'incomplete']) {
      await scenario(`committed truncated ACK: actual reload/reopen recovers the current ${result} appointment with the exact key`, result === 'scheduled' ? 375 : 1440, result === 'scheduled' ? 900 : 1000, async ctx => {
        ctx.captureRecovery = result === 'scheduled' || result === 'cancelled';
        const c = ctx.f.a.companies[1];
        const { expected, original } = await committedWithoutAck(ctx, c);
        await db.query('update public.clinic_services set base_price_minor=999999,duration_minutes=90 where workspace_id=$1', [c.workspace]);
        if (result === 'cancelled') await db.query("update public.appointments set status='cancelled',starts_at=starts_at+interval '1 day',price_minor=null,duration_minutes=720,doctor_name=null,service=null where id=$1", [original.key]);
        if (result === 'no_show') await db.query("update public.appointments set status='no_show',starts_at=starts_at+interval '1 day' where id=$1", [original.key]);
        if (result === 'incomplete') await db.query('update public.appointments set starts_at=null,price_minor=null,duration_minutes=null,doctor_name=null,service=null where id=$1', [original.key]);
        await reloadRecovery(ctx, c, expected, original);
        await booked(ctx, result === 'scheduled' ? copy.booked : copy[result]);
        await counts(ctx, { appointments: 1, clients: 1, receipts: 1, booking_audits: 1 });
        assert.equal(calls(ctx, BOOK).length, 2);
        const current = await one(db, 'select starts_at,price_minor::text price,duration_minutes,status from public.appointments where id=$1', [original.key]);
        assert.equal(current.status, ['scheduled', 'incomplete'].includes(result) ? 'scheduled' : result);
        assert.equal(current.price, ['cancelled', 'incomplete'].includes(result) ? null : '150050');
        assert.equal(current.duration_minutes, result === 'incomplete' ? null : result === 'cancelled' ? 720 : 75);
        assert.equal(current.starts_at?.toISOString() ?? null, result === 'incomplete' ? null : result === 'scheduled' ? '2030-01-07T05:00:00.000Z' : '2030-01-08T05:00:00.000Z');
        const text = await ctx.browser.evaluate(`return document.querySelector(${literal(notice)}).textContent;`);
        assert.ok(!text.startsWith(copy.booked) || result === 'scheduled', 'Changed current receipts must not be presented as a newly scheduled success');
        if (result === 'incomplete') assert.doesNotMatch(text, /07\.01\.2030|08\.01\.2030|10:00/);
        else {
          assert.ok(text.includes(result === 'scheduled' ? '07.01.2030' : '08.01.2030'));
          assert.ok(text.includes('10:00'), 'The current receipt is displayed in its original clinic timezone');
        }
      });
    }

    for (const transition of ['company-filter', 'page', 'actor-ABA']) {
      await scenario(`held committed stage reply cannot publish or retarget after ${transition}`, transition === 'company-filter' ? 375 : 1440, transition === 'company-filter' ? 900 : 1000, async ctx => {
        const c = ctx.f.a.companies[0], lead = c.leads[0];
        await laterPage(ctx);
        const before = await state(ctx, lead);
        ctx.server.controls.mode = 'after';
        await sendStage(ctx, c, lead, c.deferred);
        await until(() => ctx.server.controls.held.length === 1);
        assertStageWire(ctx, c, lead, c.deferred, before);
        assert.equal((await state(ctx, lead)).stage_id, c.deferred);
        if (transition === 'company-filter') {
          const other = ctx.f.a.companies[1];
          await readAction(ctx, () => select(ctx, '.operator-lead-explorer__company select', other.request), 4);
          await openLead(ctx, other.leads[0]);
        } else if (transition === 'page') {
          await readAction(ctx, () => ctx.browser.evaluate("document.querySelector('.operator-lead-explorer__pages button:first-child').click();"), 20);
          const next = await ctx.browser.evaluate(`return document.querySelector(${literal(list)}).dataset.leadId;`);
          assert.notEqual(next, lead);
          await openLead(ctx, next);
        } else {
          await readAction(ctx, () => ctx.browser.evaluate(`f.switchActor(${literal(ctx.f.b.actor)});`), 2);
          assert.doesNotMatch((await ctx.browser.evaluate('return f.snapshot();')).text, /EXPLORER_A|EXPLORER_MATCHED|\+77000005201/);
          await readAction(ctx, () => ctx.browser.evaluate(`f.switchActor(${literal(ctx.f.a.actor)});`), 20);
          await laterPage(ctx);
          await openLead(ctx, ctx.f.a.companies[1].leads[0]);
        }
        if (transition !== 'actor-ABA') {
          assert.equal(await ctx.browser.evaluate(`return !!document.querySelector(${literal(busyNotice)});`), true, 'The pending stage status must survive a query change until its ACK settles');
          assert.equal(await ctx.browser.evaluate(`return document.querySelector(${literal(details + ' .operator-lead-explorer__stage-editor select')}).disabled;`), true);
          await ctx.browser.evaluate(`document.querySelector(${literal(details + ' .operator-lead-explorer__stage-editor')}).requestSubmit();`);
        } else {
          assert.equal(await ctx.browser.evaluate(`return !!document.querySelector(${literal(busyNotice)});`), false, 'A replaced actor lifetime does not inherit the old pending indicator');
        }
        const stable = await view(ctx), reads = calls(ctx, SEARCH).length;
        assert.equal(stable.notice, null);
        ctx.server.release();
        await ctx.browser.waitFor(`!document.querySelector(${literal(busyNotice)})`);
        assert.equal(await ctx.browser.evaluate(`return document.querySelector(${literal(details + ' .operator-lead-explorer__stage-editor select')}).disabled;`), false, 'The pending stage lock clears after the original ACK settles');
        await delay(100);
        assert.deepEqual(await view(ctx), stable, 'The retired reply cannot replace the current selection, filters, notice or receipt');
        assert.equal(calls(ctx, SEARCH).length, reads, 'A retired success must not refresh/retarget the current report');
        assert.equal(writes(ctx, 'PATCH').length, 1);
        assert.equal(calls(ctx, STAGE).length, 1);
        assert.equal((await state(ctx, lead)).stage_id, c.deferred);
        assert.equal((await state(ctx, ctx.f.a.companies[1].leads[0])).stage_id, null);
        await counts(ctx, { stage_audits: 1 });
      });
    }

    for (const revoked of ['profile', 'assignment']) {
      await scenario(`revoked ${revoked} after synthetic Auth verification and before native ${revoked === 'profile' ? 'stage' : 'booking'} denies the write and clears contacts/forms`, 375, 900, async ctx => {
        const c = ctx.f.a.companies[0], lead = c.leads[0], before = await state(ctx, lead);
        await laterPage(ctx);
        const authBefore = ctx.router.state.auth.length;
        let expected;
        if (revoked === 'profile') {
          ctx.native.controls.holdNext = STAGE;
          await sendStage(ctx, c, lead, c.deferred);
        } else {
          expected = await fillBooking(ctx, c, lead);
          ctx.native.controls.holdNext = BOOK;
          await submitBooking(ctx);
        }
        await until(() => ctx.native.controls.held.length === 1);
        assert.ok(ctx.router.state.auth.length >= authBefore + 2, 'Real catch-all and business handler authentication precede the held native mutation');
        assert.equal(ctx.router.state.auth.at(-1), 'Bearer ' + ctx.f.tokens[ctx.f.a.actor]);
        if (revoked === 'profile') await db.query("update public.growth_operator_profiles set status='suspended',accepting_requests=false where id=$1", [ctx.f.a.profile]);
        else await db.query('select public.set_growth_operator_lead_assignment($1,$2,$3,false)', [c.request, lead, c.staff]);
        ctx.native.release();
        await until(() => writes(ctx, revoked === 'profile' ? 'PATCH' : 'POST').length === 1);
        if (revoked === 'profile') assert.equal(assertStageWire(ctx, c, lead, c.deferred, before, 403).code, 'P0001');
        else {
          const wire = assertBookingWire(ctx, c, lead, expected, 403);
          assert.equal(wire.call.code, 'P0001');
          await retainedAttempt(ctx, expected, wire.key);
        }
        await ctx.browser.waitFor(`f.denials.length===1 && !document.querySelector(${literal(list)}) && !document.querySelector(${literal(details)}) && !document.querySelector(${literal(bookingForm)})`);
        const snapshot = await ctx.browser.evaluate('return f.snapshot();');
        assert.deepEqual(snapshot.denials, [ctx.f.a.actor]);
        assert.doesNotMatch(snapshot.text, /EXPLORER_A|EXPLORER_MATCHED|\+77000005201|Public booked specialist|Public service/);
        assert.deepEqual(await state(ctx, lead), before);
        assert.equal(calls(ctx, revoked === 'profile' ? STAGE : BOOK).length, 1);
        await counts(ctx);
      });
    }
    assert.deepEqual(await publicCounts(db), clean);
    assert.deepEqual(await explorerFinancialSnapshot(db), financial);
    t.diagnostic(`Exact raw ${chain[0].file} through ${chain.at(-1).file}; actual Explorer, HTTP catch-all and service-role SQL; synthetic identity/SDK boundary only.`);
  } catch (error) { failed = error; }
  finally {
    const errors = [];
    for (const close of [() => db?.end(), () => fixture?.close(), () => stopOperatorExplorerBuilds(), () => stopPartnerEntryBuilds()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (failed || errors.length) throw new AggregateError([...(failed ? [failed] : []), ...errors], 'Explorer native suite or resource cleanup failed');
  }
});
