import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { readReviewedChain } from './migration-chain-review.mjs';
import { seedCreatorJobFixture, cleanupCreatorJobFixture } from './creator-job-cases.mjs';
import { creatorNativeAdapter, compiledCreatorRouter, creatorNativeBundle, creatorNativeServer, stopCreatorFixtureBuilds } from './creator-jobs-native-http-fixture.mjs';
import { ownedRecoveryBrowser, root } from '../src/appointment-recovery-committed-fixture.ts';
const { parseCreatorCommandResult, parseCreatorJobDetail } = await import(new URL('../../lib/crm/creator-job-contracts.ts', import.meta.url).href);
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
async function until(check) { for (let n = 0; n < 200; n++) { if (await check()) return; await delay(25); } assert.fail('Owned native HTTP condition did not settle'); }
const commandPrefix = 'medina_creator_command_v1:';

test('creator real forms/transport, compiled catch-all, real authorization and native service-role SQL; synthetic Auth authority only', { timeout: 360000 }, async t => {
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1', 'Explicit owned native opt-in, no DSN or remote fallback');
  const chain = await readReviewedChain(path.join(root, 'migrations'));
  const fixture = await startNativePostgres(); t.after(() => fixture.close()); t.after(stopCreatorFixtureBuilds);
  const db = await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for (const entry of chain) await db.query(entry.source);
  const output = await mkdtemp(path.join(root, 'node_modules/.cache/creator-native-http-'));
  const identities = new Map(), native = creatorNativeAdapter(fixture), api = await compiledCreatorRouter(native.adapter, identities);
  t.after(() => api.close());
  async function seed() {
    const f = await seedCreatorJobFixture(db); f.admin = randomUUID(); f.adminAuth = randomUUID(); f.doctor = randomUUID(); f.doctorAuth = randomUUID();
    await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values
      ($1,$2,$3,'owned-admin@example.invalid','Owned admin','admin','active'),($4,$2,$5,'owned-doctor@example.invalid','Owned doctor','doctor','active')`, [f.admin, f.w, f.adminAuth, f.doctor, f.doctorAuth]);
    await db.query("update public.workspaces set name='PRIVATE_OTHER_COMPANY' where id=$1", [f.otherW]);
    f.actors = [f.owner, f.actor, f.other, f.adminAuth, f.doctorAuth];
    f.tokens = Object.fromEntries(f.actors.map(actor => [actor, `owned.${randomUUID()}.signature`]));
    for (const [actor, token] of Object.entries(f.tokens)) identities.set(token, actor);
    f.counts = () => one(db, `select
      (select count(*)::int from public.growth_creator_jobs where workspace_id=$1) jobs,
      (select count(*)::int from public.growth_creator_commands where actor_id=any($2::uuid[])) commands,
      (select count(*)::int from public.growth_creator_submissions where job_id in(select id from public.growth_creator_jobs where workspace_id=$1)) submissions,
      (select count(*)::int from public.growth_creator_events where job_id in(select id from public.growth_creator_jobs where workspace_id=$1)) events,
      (select count(*)::int from public.growth_creator_command_fences where actor_auth_user_id=any($2::uuid[])) fences`, [f.w, f.actors]);
    f.cleanup = async () => {
      native.release();
      await db.query('delete from public.growth_creator_command_fences where actor_auth_user_id=any($1::uuid[])', [f.actors]);
      await db.query('delete from public.workspace_settings where workspace_id=any($1::uuid[])', [[f.w, f.otherW]]);
      await db.query('delete from public.staff_users where id=any($1::uuid[])', [[f.admin, f.doctor]]);
      await cleanupCreatorJobFixture(db, f);
      for (const token of Object.values(f.tokens)) identities.delete(token);
    }; return f;
  }
  async function call(server, f, actor, route, { method = 'GET', body, raw, query = '', token } = {}) {
    const response = await fetch(server.origin + '/api/crm/' + route + query, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { ...(actor || token ? { Authorization: 'Bearer ' + (token ?? f.tokens[actor]) } : {}), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
      ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(body) }) });
    const payload = await response.json();
    if (!route.startsWith('owned-unknown')) assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(payload), /fixture-only-not-a-credential|PRIVATE_AUTH_DIAGNOSTIC|PRIVATE_NATIVE_READ_DIAGNOSTIC|PRIVATE_OTHER_COMPANY|growth_creator_commands|auth_user_id|actor_id/);
    return { status: response.status, payload };
  }
  const create = (f, requestId = randomUUID(), terms = f.terms) => ({ requestId, action: 'create', terms });
  const change = (job, action, payload = {}, requestId = randomUUID()) => ({ requestId, jobId: job.id, revision: job.revision, action, payload });
  async function committed(server, f, actor, route, body) {
    const result = await call(server, f, actor, route, { method: 'POST', body, query: route.startsWith('clinic-') ? '?workspaceId=' + f.w : '' });
    assert.equal(result.status, 200, JSON.stringify(result.payload)); const value = parseCreatorCommandResult(result.payload.data); assert.equal(value?.state, 'committed'); return value;
  }
  await t.test('compiled router parses real raw JSON, verifies Auth, membership/role/purpose and closed selectors before any business write', async () => {
    const f = await seed(), server = await creatorNativeServer(api.handler, '');
    try {
      const start = native.controls.calls.length;
      for (const actor of [null, 'invalid']) {
        const result = await call(server, f, null, 'creator-jobs', actor ? { token: 'forged.payload.signature' } : {}); assert.equal(result.status, 401);
      }
      for (const actor of [f.owner, f.adminAuth]) {
        const result = await call(server, f, actor, 'clinic-creator-jobs', { query: '?workspaceId=' + f.w }); assert.equal(result.status, 200); assert.deepEqual(result.payload.data, { items: [], hasMore: false });
      }
      assert.equal((await call(server, f, f.doctorAuth, 'clinic-creator-jobs', { query: '?workspaceId=' + f.w })).status, 403);
      assert.equal((await call(server, f, f.actor, 'clinic-creator-jobs', { query: '?workspaceId=' + f.w })).status, 403);
      const reads = native.controls.reads.length;
      assert.equal((await call(server, f, f.actor, 'creator-jobs')).status, 200);
      assert.equal(native.controls.reads.length, reads, 'Approved independent creator never needs a staff membership');
      assert.equal((await call(server, f, f.owner, 'creator-jobs')).status, 403, 'Company ownership is not creator approval');
      for (const body of [{ ...create(f), actorId: f.other }, { ...create(f), paid: true }, create(f, randomUUID(), { ...f.terms, feeMinor: 1 })])
        assert.equal((await call(server, f, f.owner, 'clinic-creator-jobs', { method: 'POST', body, query: '?workspaceId=' + f.w })).status, 400);
      assert.equal((await call(server, f, f.owner, 'clinic-creator-jobs', { method: 'POST', raw: '{bad', query: '?workspaceId=' + f.w })).status, 400);
      assert.equal((await call(server, f, f.actor, 'creator-jobs', { query: '?workspaceId=' + f.w })).status, 400);
      assert.equal((await call(server, f, f.owner, 'clinic-creator-jobs', { query: '?workspaceId=' + f.w + '&workspaceId=' + f.otherW })).status, 403);
      assert.equal((await call(server, f, f.owner, 'clinic-creator-jobs/extra', { query: '?workspaceId=' + f.w })).status, 404);
      assert.equal((await call(server, f, f.owner, 'owned-unknown')).status, 404);
      await db.query("insert into public.workspace_settings(workspace_id,key,value) values($1,'workspace_purpose','{\"purpose\":\"mortgage_leads\"}')", [f.w]);
      const before = native.controls.calls.length;
      assert.equal((await call(server, f, f.owner, 'clinic-creator-jobs', { query: '?workspaceId=' + f.w })).status, 403);
      assert.equal(native.controls.calls.length, before, 'Purpose narrows before any creator RPC');
      await db.query('delete from public.workspace_settings where workspace_id=$1', [f.w]);
      native.controls.failReads = true;
      assert.equal((await call(server, f, f.owner, 'clinic-creator-jobs', { query: '?workspaceId=' + f.w })).status, 503); native.controls.failReads = false;
      api.auth.unavailable = true; assert.equal((await call(server, f, f.actor, 'creator-jobs')).status, 503); api.auth.unavailable = false;
      assert.ok(native.controls.calls.length > start); assert.deepEqual(await f.counts(), { jobs: 0, commands: 0, submissions: 0, events: 0, fences: 0 });
    } finally { native.controls.failReads = false; api.auth.unavailable = false; await server.release(); await server.close(); assert.deepEqual(server.controls.errors, []); await f.cleanup(); }
  });
  await t.test('administrator uses its own verified staff identity, can replay/cancel only the original intent, and loses receipt access after revocation', async () => {
    const f = await seed(), server = await creatorNativeServer(api.handler, '');
    try {
      const body = create(f), before = native.controls.calls.length;
      const made = await committed(server, f, f.adminAuth, 'clinic-creator-jobs', body);
      const dispatched = native.controls.calls.slice(before).find(entry => entry.name === 'execute_growth_creator_job_v2');
      assert.ok(dispatched); assert.equal(dispatched.args.p_actor, f.adminAuth); assert.equal(dispatched.args.p_staff, f.admin); assert.equal(dispatched.args.p_workspace, f.w);
      const replay = await committed(server, f, f.adminAuth, 'clinic-creator-jobs', body); assert.equal(replay.result.replayed, true); assert.equal(replay.result.job.id, made.result.job.id);
      const snapshot = await f.counts();
      assert.equal((await call(server, f, f.adminAuth, 'clinic-creator-jobs', { method: 'POST', query: '?workspaceId=' + f.w, body: { ...body, terms: { ...body.terms, feeMinor: '1' } } })).status, 409);
      assert.deepEqual(await f.counts(), snapshot);
      const ownerRead = await call(server, f, f.owner, 'clinic-creator-job-command', { query: '?workspaceId=' + f.w + '&requestId=' + body.requestId });
      assert.equal(ownerRead.status, 200); assert.equal(ownerRead.payload.data.state, 'unconfirmed', 'Another allowed company actor still cannot adopt this command');
      const cancelled = await committed(server, f, f.adminAuth, 'clinic-creator-jobs', change(made.result.job, 'cancel')); assert.equal(cancelled.result.job.state, 'cancelled');
      await db.query("update public.staff_users set status='inactive' where id=$1", [f.admin]);
      const calls = native.controls.calls.length;
      assert.equal((await call(server, f, f.adminAuth, 'clinic-creator-job-command', { query: '?workspaceId=' + f.w + '&requestId=' + body.requestId })).status, 403);
      assert.equal(native.controls.calls.length, calls, 'Revoked membership is stopped by the actual router before receipt RPC');
      assert.deepEqual(await f.counts(), { jobs: 1, commands: 2, submissions: 0, events: 2, fences: 0 });
    } finally { await server.close(); assert.deepEqual(server.controls.errors, []); await f.cleanup(); }
  });

  async function browserFor(f, side = 'company') {
    const server = await creatorNativeServer(api.handler, await creatorNativeBundle(f, side));
    let browser;
    try { browser = await ownedRecoveryBrowser(server.origin, { settleTimeoutMs: 12000 }); }
    catch (error) { await server.close(); throw error; }
    const run = browser.evaluate, wait = browser.waitFor;
    const click = text => run(`const e=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing enabled button '+${JSON.stringify(text)});e.click();`);
    const fill = (name, value) => run(`const l=[...document.querySelectorAll('label')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(name)})),e=l?.querySelector('input,textarea,select');if(!e||e.disabled)throw Error('Missing field '+${JSON.stringify(name)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));`);
    const open = async () => { await wait(`!!document.querySelector('button[aria-label^="Открыть задание:"]')`); await run(`document.querySelector('button[aria-label^="Открыть задание:"]').click();`); await wait(`!!document.querySelector('[aria-label="Карточка задания"] h4')`); };
    const view = async (side, actor) => { await run(`f.change(${JSON.stringify(side)}${actor ? ',' + JSON.stringify(actor) : ''});`); await wait(`!!document.querySelector('[aria-label="Задания авторов"] h2')`); };
    const draft = async title => {
      await wait(`!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Новое задание'&&!e.disabled)`); await click('Новое задание');
      await wait(`!!document.querySelector('select option[value="${f.profile}"]')`); await fill('Автор', f.profile); await fill('Название', title); await fill('Бриф', 'OWNED PRIVATE BRIEF ' + title);
      await fill('Вознаграждение', '9007199254740993,01'); await fill('Срок', '2030-01-07T10:15'); await fill('Условия использования контента', 'Owned technical terms, not a public legal agreement');
    };
    const pending = () => run(`return f.snapshot().metadata;`);
    return { server, browser, run, wait, click, fill, open, view, draft, pending, async close() {
      native.release(); await server.release(); await browser.close(); await server.close();
      assert.deepEqual(browser.exceptions, []); assert.ok(browser.requests.every(url => url.startsWith(server.origin + '/') || url.startsWith('data:')), 'Only owned HTTP assets/API'); assert.deepEqual(server.controls.errors, []);
    } };
  }
  for (const width of [375, 1440]) await t.test(`${width}: real UI through compiled authorization and SQL completes revisions/approval without payments`, async () => {
    const f = await seed(), b = await browserFor(f);
    try {
      await b.browser.viewport(width, 1000); await b.draft('Owned native ' + width); await b.click('Предложить задание');
      await b.wait(`document.querySelector('[aria-label="Карточка задания"]')?.innerText.includes('Предложено')`);
      assert.equal((await one(db, 'select fee_minor::text fee from public.growth_creator_jobs where workspace_id=$1', [f.w])).fee, '900719925474099301');
      await b.view('creator', f.other); await b.wait(`document.body.innerText.includes('заданий пока нет')`);
      assert.equal(await b.run(`return document.body.innerText.includes('OWNED PRIVATE BRIEF');`), false);
      await b.view('creator'); await b.open();
      await b.run(`document.querySelector('[aria-label="Карточка задания"] input[type=checkbox]').click();`); await b.click('Принять задание');
      await b.wait(`!!document.querySelector('form[aria-label="Результат задания"]')`); await b.fill('Ссылки на результат', 'https://example.com/native-v1.mp4'); await b.fill('Комментарий', 'Owned first version'); await b.click('Отправить результат');
      await b.wait(`document.querySelector('[aria-label="Версии результата"]')?.innerText.includes('Версия 1')`);
      await b.view('company'); await b.open(); await b.fill('Что доработать', 'Owned change request'); await b.click('Запросить доработку'); await b.wait(`document.querySelector('[aria-label="Карточка задания"]')?.innerText.includes('Нужна доработка')`);
      await b.view('creator'); await b.open(); await b.fill('Ссылки на результат', 'https://example.com/native-v2.mp4'); await b.click('Отправить результат'); await b.wait(`document.querySelector('[aria-label="Версии результата"]')?.innerText.includes('Версия 2')`);
      await b.view('company'); await b.open(); await b.click('Принять результат'); await b.click('Подтвердить'); await b.wait(`document.querySelector('[aria-label="Карточка задания"]')?.innerText.includes('Результат принят:')`);
      assert.deepEqual(await f.counts(), { jobs: 1, commands: 6, submissions: 2, events: 6, fences: 0 }); assert.deepEqual(await b.pending(), []);
      assert.equal(await b.run('return f.snapshot().overflow;'), false); await writeFile(path.join(output, `native-approved-${width}.png`), await b.browser.screenshot());
      const job = (await one(db, 'select id from public.growth_creator_jobs where workspace_id=$1', [f.w]));
      const detail = await call(b.server, f, f.actor, 'creator-job-detail', { query: '?jobId=' + job.id }); assert.ok(parseCreatorJobDetail(detail.payload.data));
      assert.equal((await call(b.server, f, f.other, 'creator-job-detail', { query: '?jobId=' + job.id })).status, 403);
      assert.equal((await call(b.server, f, f.owner, 'clinic-creator-job-detail', { query: '?workspaceId=' + f.otherW + '&jobId=' + job.id })).status, 403);
    } finally { await b.close(); await f.cleanup(); }
  });
  for (const action of ['create', 'accept', 'submit']) await t.test(`lost ${action} acknowledgement survives an actual page reload and resolves without another business row`, async () => {
    const f = await seed(), b = await browserFor(f, action === 'create' ? 'company' : 'creator');
    try {
      let offered;
      if (action === 'create') await b.draft('Owned dropped create');
      else {
        const made = await committed(b.server, f, f.owner, 'clinic-creator-jobs', create(f));
        offered = made.result.job;
        if (action === 'submit') await committed(b.server, f, f.actor, 'creator-jobs', change(offered, 'accept', { termsRevision: offered.termsRevision }));
        await b.run(`document.querySelector('button[aria-label="Обновить задания"]').click();`); await b.open();
        if (action === 'accept') await b.run(`document.querySelector('[aria-label="Карточка задания"] input[type=checkbox]').click();`);
        else await b.fill('Ссылки на результат', 'https://example.com/once.mp4');
      }
      const baseline = await f.counts(); b.server.controls.mode = 'drop';
      await b.click({ create: 'Предложить задание', accept: 'Принять задание', submit: 'Отправить результат' }[action]);
      await b.wait(`!!document.querySelector('[aria-label="Состояние отправки"]')&&![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Проверить состояние').disabled`);
      const after = await f.counts(); assert.deepEqual(after, { ...baseline, jobs: baseline.jobs + (action === 'create' ? 1 : 0),
        commands: baseline.commands + 1, events: baseline.events + 1, submissions: baseline.submissions + (action === 'submit' ? 1 : 0) });
      const metadata = await b.pending(); assert.equal(metadata.length, 1); assert.doesNotMatch(metadata[0], /BRIEF|terms|feeMinor|https|900719/);
      const retained = JSON.parse(metadata[0]);
      const acceptanceSnapshot = () => one(db, 'select accepted_at::text accepted_at,terms_revision,revision from public.growth_creator_jobs where id=$1', [offered.id]);
      const accepted = action === 'accept' ? await acceptanceSnapshot() : null;
      if (action === 'accept') {
        assert.ok(accepted?.accepted_at); assert.equal(accepted.terms_revision, offered.termsRevision);
        assert.deepEqual(retained, { actorId: f.actor, workspaceId: null, requestId: retained.requestId, action: 'accept', targetId: offered.id });
      }
      await b.browser.load(); await b.wait(`!!document.querySelector('[aria-label="Состояние отправки"]')`);
      assert.equal(await b.run(`return document.body.innerText.includes('Повторить исходную отправку');`), false);
      assert.deepEqual(await b.pending(), metadata); await b.click('Проверить состояние'); await b.wait(`!document.querySelector('[aria-label="Состояние отправки"]')`);
      if (action === 'accept') {
        await b.wait(`!!document.querySelector('form[aria-label="Результат задания"] button[type=submit]:not(:disabled)')`);
        assert.equal(await b.run(`return document.body.innerText.includes('Принять задание');`), false);
        assert.deepEqual(await acceptanceSnapshot(), accepted);
        for (const name of ['execute_growth_creator_job_v2', 'read_growth_creator_command_v2'])
          assert.equal(native.controls.calls.filter(entry => entry.name === name && entry.args.p_request === retained.requestId).length, 1);
        assert.equal(b.server.controls.requests.filter(entry => entry.path === 'creator-job-command' && entry.method === 'GET' && entry.state === 'committed').length, 1);
      }
      assert.deepEqual(await f.counts(), after); assert.deepEqual(await b.pending(), []);
    } finally { await b.close(); await f.cleanup(); }
  });
  await t.test('reload closes a still-unprocessed original and native SQL refuses its later delivery', async () => {
    const f = await seed(), b = await browserFor(f);
    try {
      await b.draft('Owned delayed original'); b.server.controls.mode = 'before'; await b.click('Предложить задание'); await until(() => b.server.controls.held.length === 1);
      await b.browser.load(); await b.wait(`!!document.querySelector('[aria-label="Состояние отправки"]')`); await b.click('Проверить состояние');
      await b.wait(`document.body.innerText.includes('Исход отправки ещё не подтверждён.')`);
      await b.run(`document.querySelector('[aria-label="Состояние отправки"] input[type=checkbox]').click();`); await b.click('Закрыть отправку'); await b.wait(`!document.querySelector('[aria-label="Состояние отправки"]')`);
      await b.server.release(); assert.deepEqual(await f.counts(), { jobs: 0, commands: 0, submissions: 0, events: 0, fences: 1 });
      assert.ok(b.server.controls.requests.some(r => r.method === 'POST' && r.path === 'clinic-creator-jobs' && r.state === 'abandoned'));
    } finally { await b.close(); await f.cleanup(); }
  });
  await t.test('a held committed reply cannot publish after A-B-A; fresh A reads the original receipt', async () => {
    const f = await seed(), b = await browserFor(f);
    try {
      await b.draft('Owned held reply'); b.server.controls.mode = 'after'; await b.click('Предложить задание'); await until(() => b.server.controls.held.length === 1);
      await b.view('creator', f.other); assert.equal(await b.run(`return document.body.innerText.includes('OWNED PRIVATE BRIEF');`), false);
      await b.view('company'); await b.wait(`!!document.querySelector('[aria-label="Состояние отправки"]')&&document.querySelectorAll('button[aria-label^="Открыть задание:"]').length===1`);
      const before = await b.run('return document.body.innerText;'); await b.server.release(); await delay(80); assert.equal(await b.run('return document.body.innerText;'), before);
      await b.click('Проверить состояние'); await b.wait(`!document.querySelector('[aria-label="Состояние отправки"]')`);
      assert.deepEqual(await f.counts(), { jobs: 1, commands: 1, submissions: 0, events: 1, fences: 0 });
    } finally { await b.close(); await f.cleanup(); }
  });
  for (const origin of ['company', 'creator']) await t.test(`${origin} revocation after router authorization but before SQL hides the form and saves nothing`, async () => {
    const f = await seed(), b = await browserFor(f, origin);
    try {
      if (origin === 'company') await b.draft('Owned revoked staff');
      else {
        const made = await committed(b.server, f, f.owner, 'clinic-creator-jobs', create(f));
        await committed(b.server, f, f.actor, 'creator-jobs', change(made.result.job, 'accept', { termsRevision: made.result.job.termsRevision }));
        await b.run(`document.querySelector('button[aria-label="Обновить задания"]').click();`); await b.open(); await b.fill('Ссылки на результат', 'https://example.com/revoked.mp4');
      }
      const baseline = await f.counts(); native.controls.holdNextWriter = true; await b.click(origin === 'company' ? 'Предложить задание' : 'Отправить результат'); await until(() => native.controls.held !== null);
      if (origin === 'company') await db.query("update public.staff_users set status='inactive' where id=$1", [f.staff]);
      else await db.query("update public.growth_contributor_profiles set creator_status='suspended' where id=$1", [f.profile]);
      native.release(); await b.wait(`document.body.innerText.includes('Доступ к заданиям изменился.')`);
      assert.deepEqual(await f.counts(), baseline); assert.equal(await b.run(`return !!document.querySelector('form')||document.body.innerText.includes('OWNED PRIVATE BRIEF')||!!document.querySelector('[aria-label="Карточка задания"]');`), false);
    } finally { await b.close(); await f.cleanup(); }
  });
  await t.test('a malformed native committed reply remains unconfirmed until a strict outcome read', async () => {
    const f = await seed(), b = await browserFor(f);
    try {
      await b.draft('Owned malformed reply'); native.controls.malformedNextWrite = true; await b.click('Предложить задание');
      await b.wait(`document.body.innerText.includes('Результат не подтверждён.')`);
      assert.equal((await b.pending()).length, 1); const before = await f.counts(); assert.equal(before.jobs, 1);
      await b.click('Проверить состояние'); await b.wait(`!document.querySelector('[aria-label="Состояние отправки"]')`); assert.deepEqual(await f.counts(), before);
    } finally { await b.close(); await f.cleanup(); }
  });
  await t.test('SDK actor changes before parent notification stop the real client transport before HTTP', async () => {
    const f = await seed(), b = await browserFor(f);
    try {
      await b.draft('Owned raw SDK change'); const before = b.server.controls.requests.filter(r => r.method === 'POST').length;
      await b.run(`f.raw(f.ids.b);document.querySelector('form[aria-label="Новое задание автору"]').requestSubmit();`);
      await b.wait(`document.body.innerText.includes('Доступ к заданиям изменился.')`);
      assert.equal(b.server.controls.requests.filter(r => r.method === 'POST').length, before); assert.equal((await f.counts()).jobs, 0);
    } finally { await b.close(); await f.cleanup(); }
  });
  assert.deepEqual(api.auth.unexpected, []); assert.ok(api.auth.calls.length > 0);
  for (const table of ['platform_subscription_payments', 'growth_partner_commissions', 'growth_partner_payouts'])
    assert.equal((await one(db, `select count(*)::int n from public.${table}`)).n, 0, 'No payment, referral income or payout');
  for (const { tablename } of (await db.query("select tablename from pg_tables where schemaname='public'")).rows)
    assert.equal((await one(db, 'select count(*)::int n from public."' + tablename.replaceAll('"', '""') + '"')).n, 0, 'All owned fictional rows removed: ' + tablename);
  console.log('Creator compiled/native HTTP screenshots: ' + output);
});
