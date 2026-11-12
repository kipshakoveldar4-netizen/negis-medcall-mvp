import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (name: string) => import(pathToFileURL(path.join(root, name)).href);
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const channelKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const phone = '+77010000001';
const tables = { channelTable: 'wazzup_channels', channelKeyColumn: 'channel_id', ledgerTable: 'wazzup_inbound_messages' };
const message = { channelKey, messageId: 'fixture-message-1', phone, contactName: 'Fixture person', text: 'Fixture incoming request' };
type Row = Record<string, any>;

async function fixture(run: (f: {
  state: Row; calls: Row[]; client: Row;
  process(messages?: Row[], providerTables?: Row): Promise<Row>;
}) => Promise<void>) {
  const state: Row = { channel: { workspace_id: workspace, enabled: true, atomic_inbound: true },
    seen: false, results: ['created'], rpcError: null, channelError: null, missingFlag: false };
  const calls: Row[] = [];
  const client: Row = {
    from(table: string) {
      const call: Row = { table, operation: 'select', filters: {} }; calls.push(call);
      const builder: Row = {};
      const settle = () => {
        if (table.endsWith('inbound_messages')) return { data: state.seen ? { id: 'fixture-receipt' } : null, error: null };
        if (table === 'wazzup_channels' || table === 'whatsapp_cloud_numbers') {
          if (state.channelError) return { data: null, error: state.channelError };
          if (state.missingFlag && call.columns.includes('atomic_inbound')) {
            return { data: null, error: { code: '42703', message: 'column wazzup_channels.atomic_inbound does not exist' } };
          }
          const data = state.channel ? { ...state.channel } : null;
          if (data && !call.columns.includes('atomic_inbound')) delete data.atomic_inbound;
          return { data, error: null };
        }
        if (table === 'leads') return { data: [{ id: 'fixture-existing-lead' }], error: null };
        throw new Error(`Unexpected local fixture table: ${table}`);
      };
      Object.assign(builder, {
        select(columns: string) { call.columns = columns; return builder; },
        eq(key: string, value: unknown) { call.filters[key] = value; return builder; },
        neq: () => builder, limit: () => builder,
        insert(row: Row) { call.operation = 'insert'; call.row = row; return Promise.resolve({ error: null }); },
        maybeSingle: async () => settle(),
        then(resolve: (value: unknown) => unknown) { return Promise.resolve(settle()).then(resolve); },
      });
      return builder;
    },
    async rpc(name: string, args: Row) {
      calls.push({ rpc: name, args });
      return { data: state.results.shift(), error: state.rpcError };
    },
  };
  const core = await load('lib/crm/inbound-whatsapp.ts') as {
    processInboundWhatsAppMessages(client: unknown, tables: Row, messages: Row[]): Promise<Row>;
  };
  await run({ state, calls, client, process: (messages = [message], providerTables = tables) =>
    core.processInboundWhatsAppMessages(client, providerTables, messages) });
}

test('opted-in Wazzup messages use only the atomic RPC and return real created/repeat/ignore counts', async () => {
  await fixture(async f => {
    f.state.results = ['created', 'repeat', 'ignored'];
    const result = await f.process([message, { ...message, messageId: 'fixture-message-2' }, { ...message, messageId: 'fixture-message-3' }]);
    assert.deepEqual(result, { created: 1, repeats: 1, ignored: 1 });
    const rpcs = f.calls.filter(c => c.rpc);
    assert.equal(rpcs.length, 3);
    assert.deepEqual(rpcs[0], { rpc: 'process_wazzup_inbound_message', args: {
      p_channel_id: channelKey, p_message_id: message.messageId, p_phone: phone,
      p_contact_name: message.contactName, p_text: message.text,
    } });
    assert.ok(f.calls.every(c => c.rpc || [tables.channelTable, tables.ledgerTable].includes(c.table)));
    assert.ok(f.calls.every(c => c.operation !== 'insert'), 'lead and receipt must not be separate API writes');
  });
});

test('an RPC error or malformed result never falls back to legacy writes', async () => {
  for (const result of [undefined, null, {}, 'success', 'created']) await fixture(async f => {
    f.state.results = [result];
    if (result === 'created') f.state.rpcError = { code: 'PGRST202', message: 'Synthetic missing function with private row details' };
    await assert.rejects(() => f.process(), /atomic inbound (failed|invalid result)/);
    assert.ok(f.calls.every(c => c.operation !== 'insert' && c.table !== 'leads'));
  });
});

test('unknown, disabled and replayed messages do not call the atomic RPC', async () => {
  for (const change of [{ channel: null }, { channel: { workspace_id: workspace, enabled: false, atomic_inbound: true } }, { seen: true }]) {
    await fixture(async f => {
      Object.assign(f.state, change);
      assert.deepEqual(await f.process(), { created: 0, repeats: 0, ignored: 1 });
      assert.ok(f.calls.every(c => !c.rpc && c.operation !== 'insert'));
    });
  }
});

test('unopted Wazzup and Cloud channels retain their existing pipeline', async () => {
  for (const cloud of [false, true]) await fixture(async f => {
    f.state.channel.atomic_inbound = cloud;
    const providerTables = cloud ? { channelTable: 'whatsapp_cloud_numbers', channelKeyColumn: 'phone_number_id',
      ledgerTable: 'whatsapp_cloud_inbound_messages' } : tables;
    assert.deepEqual(await f.process([message], providerTables), { created: 0, repeats: 1, ignored: 0 });
    assert.ok(f.calls.every(c => !c.rpc));
    assert.equal(f.calls.find(c => c.operation === 'insert')?.table, providerTables.ledgerTable);
    if (cloud) assert.equal(f.calls.find(c => c.table === providerTables.channelTable)?.columns, 'workspace_id, enabled');
  });
});

test('only a missing opt-in column permits the pre-071 legacy read', async () => {
  await fixture(async f => {
    f.state.missingFlag = true;
    assert.deepEqual(await f.process(), { created: 0, repeats: 1, ignored: 0 });
    assert.deepEqual(f.calls.filter(c => c.table === tables.channelTable).map(c => c.columns),
      ['workspace_id, enabled, atomic_inbound', 'workspace_id, enabled']);
    assert.ok(f.calls.every(c => !c.rpc));
  });
  for (const error of [{ code: '08006', message: 'Synthetic outage' }, { code: '42703', message: 'column enabled does not exist' }]) {
    await fixture(async f => {
      f.state.channelError = error;
      await assert.rejects(() => f.process(), /channel lookup/);
      assert.equal(f.calls.filter(c => c.table === tables.channelTable).length, 1);
      assert.ok(f.calls.every(c => !c.rpc && c.operation !== 'insert'));
    });
  }
});

test('atomic RPC input is bounded and carries no workspace, assignee or browser-owned fields', async () => {
  await fixture(async f => {
    await f.process([{ ...message, contactName: 'N'.repeat(300), text: 'T'.repeat(2000), workspaceId: 'foreign-fixture', responsibleUserId: 'foreign-manager' }]);
    const args = f.calls.find(c => c.rpc)!.args;
    assert.equal(args.p_contact_name.length, 200);
    assert.equal(args.p_text.length, 1000);
    assert.deepEqual(Object.keys(args).sort(), ['p_channel_id', 'p_contact_name', 'p_message_id', 'p_phone', 'p_text']);
  });
});

test('the real authenticated adapter returns retryable 503 without leaking an atomic SQL error', async () => {
  await fixture(async f => {
    const server = await load('lib/supabase/server.ts') as { setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void };
    const adapter = await load('lib/wazzup/webhook.ts') as { handleWazzupWebhook(req: unknown, res: unknown): Promise<unknown> };
    const previousSecret = process.env.WAZZUP_WEBHOOK_SECRET;
    const warn = console.warn;
    const warnings: string[] = [];
    process.env.WAZZUP_WEBHOOK_SECRET = 'local-atomic-fixture-only';
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    server.setSupabaseServerClientFactoryForTests(() => f.client);
    const res: Row = { statusCode: 0, body: null,
      status(code: number) { this.statusCode = code; return this; }, setHeader() { return this; },
      json(body: unknown) { this.body = body; return this; } };
    try {
      f.state.rpcError = { message: 'private-fixture-row-details', code: 'P0001' };
      await adapter.handleWazzupWebhook({ method: 'POST', query: {}, headers: { authorization: 'Bearer local-atomic-fixture-only' },
        body: { messages: [{ channelId: channelKey, messageId: message.messageId, chatType: 'whatsapp', status: 'inbound',
          chatId: phone, text: message.text, contact: { name: message.contactName } }] } }, res);
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, { success: false, error: 'Service unavailable' });
      assert.deepEqual(warnings, ['[wazzup] webhook processing failed']);
      assert.ok(f.calls.every(c => c.operation !== 'insert' && c.table !== 'leads'));
    } finally {
      console.warn = warn;
      server.setSupabaseServerClientFactoryForTests(null);
      if (previousSecret === undefined) delete process.env.WAZZUP_WEBHOOK_SECRET;
      else process.env.WAZZUP_WEBHOOK_SECRET = previousSecret;
    }
  });
});
