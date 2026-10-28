import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import test from 'node:test';
import tls from 'node:tls';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds } from './partner-entry-http-fixture.mjs';

const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOURNAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SOURCE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DRY_RUN_TIMESTAMP = '2026-10-28_12-00';
const DRY_RUN_START = '2026-10-29T00:00:00.000Z';
const DRY_RUN_TITLE = 'SYNTHETIC PAUSED DRY RUN';
const SYNTHETIC_PAGE = '9876543210', SYNTHETIC_ACCOUNT = 'act_1234567890';
const DISABLED = 'ACTIVE \u0437\u0430\u043f\u0443\u0441\u043a \u0432\u044b\u043a\u043b\u044e\u0447\u0435\u043d \u0432 Admin Center.';
const ROLE_DENIED = 'ACTIVE \u0437\u0430\u043f\u0443\u0441\u043a \u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d \u0442\u043e\u043b\u044c\u043a\u043e owner/admin.';
const CONFIRMATION = '\u0417\u0410\u041f\u0423\u0421\u0422\u0418\u0422\u042c';
const baseBody = {
  workspaceId: WORKSPACE, campaignName: 'SYNTHETIC ACTIVE SETTING REGRESSION',
  selectedCityId: 'almaty', primaryText: 'Professional consultation in Almaty. Book a specialist consultation.',
  headline: 'Consultation in Almaty', description: 'Book a consultation with a specialist.',
  statusMode: 'ACTIVE', creativeType: 'image', imageUrl: 'https://creative.fixture.invalid/image.jpg',
  creativeUrl: 'https://creative.fixture.invalid/image.jpg', landingUrl: 'https://wa.me/77010000000',
  fileName: 'synthetic.jpg', mimeType: 'image/jpeg', dailyBudget: 20, totalBudget: 140, currency: 'USD',
  complianceConfirmed: true, manualApprovalConfirmed: true, activeConfirmation: CONFIRMATION, dryRun: false,
};

// Only the owned HTTP transport may open a socket. VM fetch has its own exact
// synthetic Auth adapter; neither it nor external packages may reach a provider.
function networkTrap() {
  const ports = new Set(), attempts = [], restorers = [];
  const replace = (object, key, value) => {
    const original = object[key]; object[key] = value;
    restorers.push(() => { object[key] = original; });
    return original;
  };
  const deny = kind => { attempts.push(kind); throw Error('Unapproved network: ' + kind); };
  const originalRequest = http.request;
  replace(http, 'request', function (url, ...args) {
    if (!(url instanceof URL) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !ports.has(Number(url.port)) || url.pathname !== '/api/crm/meta-launch') return deny('http.request');
    return originalRequest.call(this, url, ...args);
  });
  const originalConnect = net.Socket.prototype.connect;
  replace(net.Socket.prototype, 'connect', function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = first && typeof first === 'object' ? first : { port: first, host: args[1] };
    if (options.host !== '127.0.0.1' || !ports.has(Number(options.port))) return deny('Socket.connect');
    return originalConnect.apply(this, args);
  });
  for (const [object, key, kind] of [
    [http, 'get', 'http.get'], [https, 'request', 'https.request'], [https, 'get', 'https.get'],
    [http2, 'connect', 'http2.connect'], [tls, 'connect', 'tls.connect'], [dgram, 'createSocket', 'dgram.createSocket'],
  ]) replace(object, key, () => deny(kind));
  for (const object of [dns, dns.promises]) for (const key of Object.keys(object)) {
    if (!/^(lookup|resolve|reverse)/.test(key) || typeof object[key] !== 'function') continue;
    if (key !== 'lookup') { replace(object, key, () => deny('dns.' + key)); continue; }
    if (object === dns.promises) replace(object, key, async (host, options) => {
      if (host !== '127.0.0.1') return deny('dns.lookup');
      return options?.all ? [{ address: host, family: 4 }] : { address: host, family: 4 };
    });
    else replace(object, key, (host, options, callback) => {
      if (host !== '127.0.0.1') return deny('dns.lookup');
      const done = typeof options === 'function' ? options : callback;
      process.nextTick(() => options?.all ? done(null, [{ address: host, family: 4 }]) : done(null, host, 4));
    });
  }
  replace(globalThis, 'fetch', async () => deny('fetch'));
  syncBuiltinESMExports();
  return { ports, attempts, restore() { for (const restore of restorers.reverse()) restore(); syncBuiltinESMExports(); } };
}

function exactKeys(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Exact synthetic journal field allowlist');
}

function pausedPreview(payload) {
  exactKeys(payload, ['campaign', 'adSet', 'creative', 'ad', 'launchTimestamp', 'budgetLevel', 'warnings']);
  assert.deepEqual(payload.campaign, {
    name: DRY_RUN_TITLE + ' - ' + DRY_RUN_TIMESTAMP, objective: 'OUTCOME_LEADS', buying_type: 'AUCTION',
    special_ad_categories: [], is_adset_budget_sharing_enabled: false, status: 'PAUSED',
  });
  assert.equal(payload.adSet.status, 'PAUSED'); assert.equal(payload.ad.status, 'PAUSED');
  assert.equal(payload.adSet.campaign_id, 'META_CAMPAIGN_ID'); assert.equal(payload.adSet.daily_budget, '2000');
  assert.equal(payload.adSet.start_time, DRY_RUN_START); assert.equal(payload.adSet.placementsMode, 'instagram_only');
  assert.deepEqual(payload.adSet.targeting.publisher_platforms, ['instagram']);
  assert.deepEqual(payload.adSet.targeting.geo_locations, { cities: [{ key: '1301648' }] });
  assert.equal(payload.creative.asset.fileType, 'image'); assert.equal(payload.creative.usesLinkData, true);
  assert.equal(payload.creative.usesVideoData, false); assert.equal(payload.launchTimestamp, DRY_RUN_TIMESTAMP);
  assert.equal(payload.budgetLevel, 'adset'); assert.deepEqual(payload.warnings, []);
  assert.doesNotMatch(JSON.stringify(payload), /\bACTIVE\b|\bactive\b|launch_active|create_paused/);
}

function dryRunLaunchRow(row, role, requestBody) {
  const fixed = {
    workspace_id: WORKSPACE, launched_by: 'SYNTHETIC QA ACTOR', launched_by_role: role,
    source_module: 'meta-active-setting-http', source_id: SOURCE_ID,
    campaign_name: DRY_RUN_TITLE + ' - ' + DRY_RUN_TIMESTAMP, objective: 'OUTCOME_LEADS',
    status: 'dry_run', meta_status: 'DRY_RUN', budget_daily_minor: 2000, budget_total_minor: 14000,
    currency: 'USD', start_time: DRY_RUN_START, end_time: null,
    page_id: SYNTHETIC_PAGE, instagram_actor_id: null, ad_account_id: SYNTHETIC_ACCOUNT, last_error: null,
  };
  const ids = [['campaign', 'metaCampaignId', 'meta_campaign_id'], ['adset', 'metaAdSetId', 'meta_adset_id'],
    ['creative', 'metaCreativeId', 'meta_creative_id'], ['ad', 'metaAdId', 'meta_ad_id']];
  exactKeys(row, [...Object.keys(fixed), ...ids.map(([, , field]) => field), 'payload', 'compliance', 'meta_response', 'updated_at']);
  for (const [key, value] of Object.entries(fixed)) assert.deepEqual(row[key], value, 'Only tagged dry-run journal values: ' + key);
  assert.deepEqual(row.payload, requestBody); assert.equal(row.payload.statusMode, 'PAUSED'); assert.equal(row.payload.dryRun, true);
  assert.equal(typeof row.updated_at, 'string'); assert.equal(new Date(row.updated_at).toISOString(), row.updated_at);
  exactKeys(row.meta_response, ['dryRun', 'payload', ...ids.map(([, field]) => field)]);
  assert.equal(row.meta_response.dryRun, true);
  for (const [kind, camel, snake] of ids) {
    assert.match(row[snake], new RegExp('^dryrun_' + kind + '_[0-9]+$')); assert.equal(row.meta_response[camel], row[snake]);
  }
  exactKeys(row.compliance, ['status', 'issues', 'safeText', 'safeTextStatus', 'safeTextIssues', 'safeParts', 'disclaimer']);
  assert.ok(['safe', 'needs_review'].includes(row.compliance.status));
  assert.ok(['safe', 'needs_review'].includes(row.compliance.safeTextStatus));
  assert.deepEqual(row.compliance.safeParts, { headline: requestBody.headline, text: requestBody.primaryText, description: requestBody.description });
  for (const issues of [row.compliance.issues, row.compliance.safeTextIssues]) {
    assert.ok(Array.isArray(issues));
    for (const issue of issues) {
      exactKeys(issue, ['code', 'severity', 'message', ...(Object.hasOwn(issue, 'match') ? ['match'] : [])]);
      assert.equal(issue.severity, 'review'); assert.equal(typeof issue.code, 'string'); assert.equal(typeof issue.message, 'string');
    }
  }
  assert.equal(typeof row.compliance.safeText, 'string'); assert.equal(typeof row.compliance.disclaimer, 'string');
  pausedPreview(row.meta_response.payload);
  assert.doesNotMatch(JSON.stringify(row), /"(?:ACTIVE|active|launch_active|create_paused)"/);
}

function sdkAdapter(role, setting, journalBody = null) {
  const reads = [], writes = [], violations = [], journalCalls = []; let savedLaunch;
  const refuse = message => { violations.push(message); throw Error(message); };
  const checked = action => {
    try { return action(); } catch (error) { violations.push('Synthetic dry-run journal contract: ' + error.message); throw error; }
  };
  const adapter = {
    rpc(name) { writes.push({ table: 'RPC', method: name }); return refuse('Unexpected RPC'); },
    from(table) {
      const filters = []; let columns;
      const run = async single => {
        reads.push({ table, columns, filters: structuredClone(filters), single });
        if (table === 'staff_users') {
          assert.equal(columns, 'id, workspace_id, role, status'); assert.equal(single, false);
          assert.deepEqual(filters, [['eq', 'auth_user_id', ACTOR], ['eq', 'status', 'active']]);
          return { data: [{ id: STAFF, workspace_id: WORKSPACE, role, status: 'active' }], error: null };
        }
        if (table !== 'workspace_settings') return refuse('Unexpected table read: ' + table);
        const key = filters.find(([method, field]) => method === 'eq' && field === 'key')?.[2];
        if (key === 'meta_live_launch_enabled') {
          assert.equal(columns, 'value'); assert.equal(single, true);
          assert.deepEqual(filters, [['eq', 'workspace_id', WORKSPACE], ['eq', 'key', key]]);
          if (setting.throws) throw Error('SYNTHETIC_SETTING_READ_ERROR');
          if (setting.error) return { data: null, error: { message: 'SYNTHETIC_SETTING_READ_ERROR' } };
          return { data: setting.missing ? null : { value: structuredClone(setting.value) }, error: null };
        }
        if (!['workspace_purpose', 'workspace_vertical'].includes(key)) return refuse('Unexpected setting read');
        assert.equal(single, false); assert.equal(columns, 'workspace_id, value');
        assert.deepEqual(filters, [['in', 'workspace_id', [WORKSPACE]], ['eq', 'key', key]]);
        return { data: [], error: null };
      };
      const q = {
        select(value) { columns = value; return q; },
        eq(key, value) { filters.push(['eq', key, structuredClone(value)]); return q; },
        in(key, value) { filters.push(['in', key, structuredClone(value)]); return q; },
        maybeSingle() { return run(true); },
        then(resolve, reject) { return run(false).then(resolve, reject); },
      };
      for (const method of ['insert', 'update', 'upsert', 'delete']) q[method] = value => {
        const row = structuredClone(value); writes.push({ table, method, ...(journalBody ? { row } : {}) });
        if (!journalBody || method !== 'insert' || !['meta_campaign_launches', 'meta_launch_audit_logs'].includes(table)) {
          return refuse('Unexpected persistence: ' + table + '.' + method);
        }
        return checked(() => {
          assert.deepEqual(filters, []); assert.equal(columns, undefined);
          if (table === 'meta_campaign_launches') {
            assert.equal(writes.length, 1); assert.deepEqual(journalCalls, []);
            dryRunLaunchRow(row, role, journalBody); journalCalls.push('launch.insert');
            // This is a synthetic SDK acknowledgement, not a database commit.
            return { select(value) { return checked(() => {
              assert.equal(value, '*'); assert.deepEqual(journalCalls, ['launch.insert']); journalCalls.push('launch.select');
              return { single() { return checked(() => {
                assert.deepEqual(journalCalls, ['launch.insert', 'launch.select']); journalCalls.push('launch.single');
                savedLaunch = { ...row, id: JOURNAL_ID, created_at: DRY_RUN_START };
                return Promise.resolve({ data: structuredClone(savedLaunch), error: null });
              }); } };
            }); } };
          }
          assert.equal(writes.length, 2); assert.ok(savedLaunch);
          assert.deepEqual(journalCalls, ['launch.insert', 'launch.select', 'launch.single']);
          exactKeys(row, ['workspace_id', 'launch_id', 'actor_name', 'actor_role', 'action', 'details']);
          assert.equal(row.workspace_id, WORKSPACE); assert.equal(row.launch_id, JOURNAL_ID);
          assert.equal(row.actor_name, 'SYNTHETIC QA ACTOR'); assert.equal(row.actor_role, role); assert.equal(row.action, 'dry_run');
          exactKeys(row.details, ['campaignName', 'statusMode', 'launchTimestamp', 'dryRun', 'complianceStatus', 'targeting']);
          assert.equal(row.details.campaignName, savedLaunch.campaign_name); assert.equal(row.details.statusMode, 'PAUSED');
          assert.equal(row.details.launchTimestamp, DRY_RUN_TIMESTAMP); assert.equal(row.details.dryRun, true);
          assert.equal(row.details.complianceStatus, savedLaunch.compliance.status);
          const targeting = row.details.targeting;
          exactKeys(targeting, ['cityInput', 'selectedCity', 'cityId', 'labelRu', 'canonicalName', 'cityKey', 'cityKeySource', 'selected',
            'candidates', 'rejectedCandidates', 'geoMode', 'city', 'radiusKm', 'cityRadiusKm', 'usesRadius', 'fallbackCountry',
            'source', 'cityWarning', 'warning', 'placementsMode', 'publisher_platforms', 'instagram_positions']);
          const labelRu = '\u0410\u0441\u0442\u0430\u043d\u0430';
          assert.deepEqual(targeting, {
            cityInput: labelRu, selectedCity: { id: 'astana', labelRu, canonicalName: 'Astana' },
            cityId: 'astana', labelRu, canonicalName: 'Astana', cityKey: '1301648', cityKeySource: 'static',
            selected: { key: '1301648', name: 'Astana', type: 'city', country_code: 'KZ', accepted: true, matchConfidence: 'exact' },
            candidates: [], rejectedCandidates: [], geoMode: 'city', city: 'Astana', radiusKm: 0, cityRadiusKm: '-',
            usesRadius: false, fallbackCountry: false, source: 'static', cityWarning: '', warning: '',
            placementsMode: 'instagram_only', publisher_platforms: ['instagram'], instagram_positions: ['stream', 'story', 'explore', 'reels'],
          });
          assert.doesNotMatch(JSON.stringify(row), /"(?:ACTIVE|active|launch_active|create_paused)"/);
          journalCalls.push('audit.insert'); return Promise.resolve({ data: null, error: null });
        });
      };
      return q;
    },
  };
  return { adapter, reads, writes, violations, journalCalls };
}

async function ownedHttp(handler, trap) {
  const errors = [], active = new Set(); let origin;
  const server = http.createServer((req, out) => {
    const pending = (async () => {
      const url = new URL(req.url, origin);
      assert.equal(req.headers.host, new URL(origin).host); assert.equal(req.method, 'POST');
      assert.equal(url.pathname, '/api/crm/meta-launch');
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 65536); chunks.push(chunk); }
      req.query = { ...Object.fromEntries(url.searchParams), path: ['meta-launch'] };
      req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let status = 200, body; const headers = {};
      const res = {
        status(value) { status = value; return res; },
        setHeader(key, value) { headers[key] = value; return res; },
        json(value) { body = value; return res; }, end(value) { body = value; return res; },
      };
      await handler(req, res);
      out.writeHead(status, headers).end(JSON.stringify(body));
    })().catch(error => { errors.push(error.stack); if (!out.destroyed) out.writeHead(500).end('{}'); });
    active.add(pending); void pending.finally(() => active.delete(pending));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; trap.ports.add(port); origin = 'http://127.0.0.1:' + port;
  return {
    errors,
    async send(role, body) {
      return await new Promise((resolve, reject) => {
        const request = http.request(new URL('/api/crm/meta-launch?workspaceId=' + WORKSPACE, origin), {
          method: 'POST', agent: false, headers: { 'content-type': 'application/json', authorization: 'Bearer owned.' + role + '.signature' },
        }, response => {
          const chunks = []; let bytes = 0;
          response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) response.destroy(Error('Response too large')); else chunks.push(chunk); });
          response.on('error', reject);
          response.on('end', () => {
            try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
            catch (error) { reject(error); }
          });
        });
        request.setTimeout(10000, () => request.destroy(Error('Owned HTTP deadline')));
        request.on('error', reject); request.end(JSON.stringify(body));
      });
    },
    async close() {
      await Promise.all([...active]); server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); trap.ports.delete(port);
    },
  };
}

async function sourceHashes() {
  return Object.fromEntries(await Promise.all(['api/crm/[...path].ts', 'lib/crm/server.ts', 'lib/meta/marketing.ts', 'lib/meta/cities.ts'].map(async file =>
    [file, createHash('sha256').update(await readFile(new URL('../../' + file, import.meta.url))).digest('hex')])));
}

const deniedSettings = [
  ['missing row', { missing: true }], ['missing enabled', { value: {} }],
  ['false', { value: { enabled: false } }], ['null', { value: { enabled: null } }],
  ['read error', { error: true }], ['read throws', { throws: true }],
  ['zero', { value: { enabled: 0 } }], ['false string', { value: { enabled: 'false' } }],
  ['object', { value: { enabled: {} } }], ['array', { value: { enabled: [] } }],
  ['number 1', { value: { enabled: 1 } }], ['number -1', { value: { enabled: -1 } }],
  ...['true', '1', 'yes', 'on'].map(value => ['truthy string ' + value, { value: { enabled: value } }]),
];

test('Meta ACTIVE persisted approval through real loopback HTTP/Auth/router/launch', { timeout: 120000 }, async t => {
  const hashes = await sourceHashes(); t.diagnostic('Current compiled source SHA-256: ' + JSON.stringify(hashes));
  const trap = networkTrap();
  t.after(async () => {
    try {
      stopPartnerEntryBuilds(); assert.deepEqual(trap.attempts, [], 'No non-owned native network attempts');
      assert.deepEqual(trap.ports.size, 0, 'All owned listeners closed');
      assert.deepEqual(await sourceHashes(), hashes, 'Inspected sources did not change during this run');
    } finally { trap.restore(); }
  });
  async function exercise(role, setting, overrides = {}, options = {}) {
    const requestBody = { ...baseBody, ...overrides };
    if (options.dryRunJournal) {
      assert.equal(options.expectedStatus, 200); assert.equal(requestBody.statusMode, 'PAUSED'); assert.equal(requestBody.dryRun, true);
    }
    const sdk = sdkAdapter(role, setting, options.dryRunJournal ? requestBody : null);
    const fixture = await partnerEntryHttpFixture(sdk.adapter, {
      approved: false, identities: new Map([['owned.' + role + '.signature', ACTOR]]),
      // Intentionally no Meta credentials/city key: an admitted request reaches
      // the later country-fallback refusal, before any provider or persistence.
      env: { MEDINA_PARTNER_ENTRY_ENABLED: 'false', META_WORKSPACE_ID: WORKSPACE, ...options.env },
    });
    let server;
    try {
      server = await ownedHttp(fixture.handler, trap);
      const response = await server.send(role, requestBody);
      options.checkResponse?.(response);
      assert.deepEqual(fixture.state.auth, ['Bearer owned.' + role + '.signature'], 'Real synthetic Auth verification reached');
      assert.deepEqual(fixture.state.challenges, [], 'No unrelated challenge');
      assert.deepEqual(fixture.state.unexpected, [], 'Zero provider fetch calls, including caught attempts');
      assert.deepEqual(trap.attempts, [], 'Zero external native calls, including caught attempts');
      // ACTIVE refusals keep a strict zero-write invariant. Only PAUSED controls
      // acknowledge the existing tagged journal, in memory, without a real DB.
      if (options.dryRunJournal) {
        assert.deepEqual(sdk.writes.map(({ table, method }) => [table, method]),
          [['meta_campaign_launches', 'insert'], ['meta_launch_audit_logs', 'insert']]);
        assert.deepEqual(sdk.journalCalls, ['launch.insert', 'launch.select', 'launch.single', 'audit.insert']);
        assert.equal(response.body.mode, 'supabase', 'Handler label for the synthetic SDK acknowledgement only');
        assert.equal(response.body.data.launchId, JOURNAL_ID); assert.equal(response.body.data.launch.id, JOURNAL_ID);
        assert.deepEqual(response.body.data.metaPayload, sdk.writes[0].row.meta_response.payload);
      } else assert.deepEqual(sdk.writes, [], 'Zero launch/audit/other writes or RPCs');
      assert.deepEqual(sdk.violations, []); assert.deepEqual(server.errors, []);
      assert.equal(sdk.reads.filter(read => read.table === 'staff_users').length, 1);
      assert.equal(sdk.reads.filter(read => read.filters.some(([, key, value]) => key === 'key' && value === 'meta_live_launch_enabled')).length, 1);
      assert.equal(response.status, options.expectedStatus ?? 400, JSON.stringify(response.body));
      assert.equal(response.body.success, options.expectedStatus === 200);
      return response.body;
    } finally { try { await server?.close(); } finally { fixture.close(); } }
  }
  function laterBoundary(body) {
    assert.equal(body.error, 'Validation error'); assert.equal(body.details?.length, 1);
    assert.match(body.details[0], /^Meta city key /);
    assert.equal(body.data?.targetingResolution?.fallbackCountry, true);
    assert.equal(body.data?.targetingResolution?.geoMode, 'country');
    assert.equal(body.data?.selectedCity?.id, 'almaty');
    assert.ok(!body.details.includes(DISABLED), 'Boolean true passed only the approval gate, not a real launch');
  }
  for (const role of ['owner', 'admin']) {
    await t.test(role + ': boolean true reaches the later safe city-key boundary', async () => {
      laterBoundary(await exercise(role, { value: { enabled: true } }));
    });
    for (const [name, setting] of deniedSettings) await t.test(role + ': ' + name + ' must keep ACTIVE disabled', async () => {
      const body = await exercise(role, setting);
      assert.equal(body.error, 'Validation error');
      assert.deepEqual(body.details, [DISABLED], 'Must be the exact ACTIVE approval refusal, not unrelated invalid input or a later city error');
    });
    await t.test(role + ': body approval and privileged role claims cannot override stored false', async () => {
      const body = await exercise(role, { value: { enabled: false } }, {
        liveLaunchEnabled: true, enabled: true, actorRole: 'owner', launchedByRole: 'owner', budgetOverrideConfirmed: true,
      });
      assert.deepEqual(body.details, [DISABLED]);
    });
    await t.test(role + ': both budget caps still require an explicit override', async () => {
      const body = await exercise(role, { value: { enabled: true } }, { dailyBudget: 51, totalBudget: 301 });
      assert.equal(body.details?.length, 2); assert.ok(body.details.every(value => value.endsWith('owner/admin override.')));
      assert.ok(body.details.some(value => value.includes('50 USD'))); assert.ok(body.details.some(value => value.includes('300 USD')));
    });
    await t.test(role + ': authorized budget override still reaches only the safe later boundary', async () => {
      laterBoundary(await exercise(role, { value: { enabled: true } }, { dailyBudget: 51, totalBudget: 301, budgetOverrideConfirmed: true }));
    });
  }
  for (const forgedRole of ['owner', 'admin']) await t.test('verified marketer cannot forge ' + forgedRole + ' or budget authority', async () => {
    const body = await exercise('marketer', { value: { enabled: true } }, {
      actorRole: forgedRole, launchedByRole: forgedRole, liveLaunchEnabled: true,
      dailyBudget: 51, totalBudget: 301, budgetOverrideConfirmed: true,
    });
    assert.equal(body.details?.length, 3); assert.ok(body.details.includes(ROLE_DENIED));
    assert.equal(body.details.filter(value => value.endsWith('owner/admin override.')).length, 2);
  });
  for (const role of ['owner', 'admin']) for (const [name, enabled] of [['false', false], ['malformed object', {}]]) {
    await t.test(role + ': PAUSED dry-run with ' + name + ' ACTIVE approval returns 200 with only synthetic dry-run journal calls', async paused => {
      const body = await exercise(role, { value: { enabled } }, {
        campaignName: DRY_RUN_TITLE, selectedCityId: 'astana', statusMode: 'PAUSED',
        primaryText: 'Professional consultation in Astana. Book a specialist consultation.',
        headline: 'Consultation in Astana', dryRun: true, activeConfirmation: '',
        launchedBy: 'SYNTHETIC QA ACTOR', sourceModule: 'meta-active-setting-http', sourceId: SOURCE_ID,
        launchTimestamp: DRY_RUN_TIMESTAMP, startDate: DRY_RUN_START, endDate: '',
      }, {
        expectedStatus: 200, dryRunJournal: true,
        // Synthetic connection identifiers only. Astana's current static city
        // key avoids lookup. Only this control admits dry-run journal doubles.
        env: { META_ACCESS_TOKEN: 'synthetic-meta-not-a-credential', META_AD_ACCOUNT_ID: SYNTHETIC_ACCOUNT, META_PAGE_ID: SYNTHETIC_PAGE },
        checkResponse(response) {
          assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.success, true);
          const { data } = response.body;
          assert.equal(data.dryRun, true); assert.equal(data.status, 'dry_run'); assert.equal(data.metaStatus, 'PAUSED');
          assert.equal(data.launch.status, 'dry_run'); assert.equal(data.launch.metaStatus, 'DRY_RUN');
          pausedPreview(data.metaPayload);
          for (const field of ['metaCampaignId', 'metaAdSetId', 'metaCreativeId', 'metaAdId']) assert.match(data[field], /^dryrun_/);
          assert.equal(response.body.details, undefined); assert.ok(!JSON.stringify(response.body).includes(DISABLED));
          assert.doesNotMatch(JSON.stringify(data.metaPayload), /\bACTIVE\b/);
        },
      });
      paused.diagnostic('Actual handler response: HTTP 200, mode=' + body.mode
        + ' labels an in-memory SDK double, not real Supabase; dryRun=true, status=dry_run, campaign/adSet/ad=PAUSED;'
        + ' exactly tagged launch/audit journal calls, zero provider calls, no real database or cloud proof');
    });
  }
});
