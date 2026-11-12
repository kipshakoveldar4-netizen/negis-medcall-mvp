import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, afterEach, before, beforeEach } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const phone = '+77010000001';
const query = async (sql: string, args: unknown[] = []) => (await db.query<Record<string, any>>(sql, args)).rows[0];
const counts = () => query(`select (select count(*)::int from leads) as leads,
  (select count(*)::int from wazzup_inbound_messages) as receipts`);
const empty = { leads: 0, receipts: 0 };

before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 23, 26, 28]);
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    if (numbers.has(Number(file.slice(0, 3)))) await db.exec(
      (await readFile(path.join(root, 'migrations', file), 'utf8')).replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, ''),
    );
  }
  await db.exec(`insert into workspaces(id,name) values('${id(900)}','Existing local channel fixture');
    insert into wazzup_channels(workspace_id,channel_id,enabled) values('${id(900)}','existing-local-channel',true);`);
  const migration = await readFile(path.join(root, 'migrations/071_atomic_wazzup_inbound.sql'), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  assert.deepEqual(await query('select enabled,atomic_inbound from wazzup_channels'), { enabled: true, atomic_inbound: false });
  assert.deepEqual(await counts(), empty, 'applying 071 twice must neither enable intake nor create leads');
  await db.exec(`delete from workspaces where id='${id(900)}'`);
});
after(() => db.close());
beforeEach(() => db.exec(`begin;
  insert into workspaces(id,name) values('${id(1)}','Local inbound A'),('${id(2)}','Local inbound B');
  insert into wazzup_channels(workspace_id,channel_id,enabled,atomic_inbound) values
    ('${id(1)}','${id(11)}',true,true),('${id(2)}','${id(12)}',true,true),
    ('${id(1)}','${id(13)}',false,true),('${id(1)}','${id(14)}',true,false);`));
afterEach(() => db.exec('rollback'));

function input() { return { channel: id(11), message: id(21), phone, name: 'Local incoming person', text: 'Synthetic request' }; }
async function submit(p = input(), role = 'service_role') {
  assert.ok(['service_role', 'anon', 'authenticated'].includes(role));
  await db.exec(`savepoint inbound_call; set local role ${role}`);
  try {
    const result = await query('select public.process_wazzup_inbound_message($1,$2,$3,$4,$5) as kind',
      [p.channel, p.message, p.phone, p.name, p.text]);
    await db.exec('reset role; release savepoint inbound_call');
    return { kind: result.kind as string, code: null };
  } catch (error) {
    await db.exec('rollback to savepoint inbound_call; release savepoint inbound_call');
    return { kind: null, code: (error as { code: string }).code };
  }
}

test('atomic Wazzup creates one unassigned lead and a matching receipt with local taxonomy', async () => {
  assert.deepEqual(await submit(), { kind: 'created', code: null });
  const lead = await query('select * from leads');
  const receipt = await query('select * from wazzup_inbound_messages');
  assert.equal(lead.workspace_id, id(1));
  assert.equal(lead.full_name, input().name);
  assert.equal(lead.phone, phone);
  assert.equal(lead.phone_normalized, phone);
  assert.equal(lead.source, 'whatsapp');
  assert.equal(lead.status, 'new');
  assert.equal(lead.responsible_user_id, null, 'the admin, not inbound, assigns a manager');
  assert.equal(lead.client_id, null);
  assert.equal(lead.notes, 'WhatsApp: Synthetic request');
  assert.equal((await query('select workspace_id,semantic_group from lead_stages where id=$1', [lead.stage_id])).workspace_id, id(1));
  assert.equal((await query('select source_key from lead_sources where id=$1', [lead.source_id])).source_key, 'whatsapp');
  assert.equal(receipt.lead_id, lead.id);
  assert.equal(receipt.workspace_id, id(1));
  assert.equal(receipt.channel_id, id(11));
  assert.equal(receipt.kind, 'created');
});

test('an exact replay or changed replay cannot create a second lead or rewrite the first', async () => {
  await submit();
  const original = await query('select * from leads');
  assert.deepEqual(await submit(), { kind: 'ignored', code: null });
  assert.deepEqual(await submit({ ...input(), phone: '+77010000002', name: 'Changed fixture', text: 'Changed text' }), { kind: 'ignored', code: null });
  assert.deepEqual(await counts(), { leads: 1, receipts: 1 });
  assert.deepEqual(await query('select * from leads'), original);
});

test('another message for an open phone records a repeat without overwriting assignment or notes', async () => {
  await db.exec(`insert into staff_users(id,workspace_id,full_name,email,role)
    values('${id(31)}','${id(1)}','Local existing assignee','fixture@example.invalid','admin');
    insert into leads(workspace_id,full_name,phone,status,source,notes,responsible_user_id)
    values('${id(1)}','Existing local person','8 (701) 000-00-01','new','manual','Keep existing notes','${id(31)}');`);
  const original = await query('select * from leads');
  assert.deepEqual(await submit(), { kind: 'repeat', code: null });
  assert.deepEqual(await query('select * from leads'), original);
  assert.equal((await query('select lead_id,kind from wazzup_inbound_messages')).lead_id, original.id);
  assert.deepEqual(await counts(), { leads: 1, receipts: 1 });
});

test('two different messages for one phone create one lead and two receipts', async () => {
  assert.equal((await submit()).kind, 'created');
  assert.equal((await submit({ ...input(), message: id(22) })).kind, 'repeat');
  assert.deepEqual(await counts(), { leads: 1, receipts: 2 });
  assert.equal((await query('select count(distinct lead_id)::int as leads from wazzup_inbound_messages')).leads, 1);
});

test('a lost lead is not reopened or changed when a new inquiry is received', async () => {
  await db.exec(`insert into leads(workspace_id,full_name,phone,status,notes)
    values('${id(1)}','Lost local person','${phone}','lost','Keep lost state')`);
  const lost = await query('select * from leads');
  assert.equal((await submit()).kind, 'created');
  assert.deepEqual(await counts(), { leads: 2, receipts: 1 });
  assert.deepEqual(await query('select * from leads where id=$1', [lost.id]), lost);
});

test('a legacy null status is still an open lead for deduplication', async () => {
  await db.exec(`insert into leads(workspace_id,full_name,phone,status)
    values('${id(1)}','Local null-status person','${phone}',null)`);
  assert.equal((await submit()).kind, 'repeat');
  assert.deepEqual(await counts(), { leads: 1, receipts: 1 });
});

test('identical phones in different workspaces never share a lead or receipt', async () => {
  assert.equal((await submit()).kind, 'created');
  assert.equal((await submit({ ...input(), channel: id(12), message: id(22) })).kind, 'created');
  assert.deepEqual(await counts(), { leads: 2, receipts: 2 });
  const mismatches = await query(`select count(*)::int as count from wazzup_inbound_messages r
    join leads l on l.id=r.lead_id where r.workspace_id<>l.workspace_id`);
  assert.equal(mismatches.count, 0);
});

test('unknown, disabled and unopted channels are ignored without domain writes', async () => {
  for (const channel of [id(99), id(13), id(14)]) {
    assert.deepEqual(await submit({ ...input(), channel }), { kind: 'ignored', code: null });
  }
  assert.deepEqual(await counts(), empty);
});

test('stopping the mapping is rechecked for each new message', async () => {
  await submit();
  await db.exec(`update wazzup_channels set enabled=false where channel_id='${id(11)}'`);
  assert.equal((await submit({ ...input(), message: id(22), phone: '+77010000002' })).kind, 'ignored');
  assert.deepEqual(await counts(), { leads: 1, receipts: 1 });
});

test('a receipt failure rolls the new lead back and a later retry creates it exactly once', async () => {
  await db.exec(`create function public.fixture_reject_wazzup_receipt() returns trigger language plpgsql as $$
    begin raise exception 'Synthetic receipt rejection'; end; $$;
    create trigger fixture_reject_wazzup_receipt before insert on wazzup_inbound_messages
    for each row execute function public.fixture_reject_wazzup_receipt();`);
  assert.equal((await submit()).code, 'P0001');
  assert.deepEqual(await counts(), empty);
  await db.exec('drop trigger fixture_reject_wazzup_receipt on wazzup_inbound_messages');
  assert.equal((await submit()).kind, 'created');
  assert.equal((await submit()).kind, 'ignored');
  assert.deepEqual(await counts(), { leads: 1, receipts: 1 });
});

test('a deleted lead leaves its receipt and cannot be recreated by a replay', async () => {
  await submit();
  await db.exec('delete from leads');
  assert.equal((await submit()).kind, 'ignored');
  assert.deepEqual(await counts(), { leads: 0, receipts: 1 });
  assert.equal((await query('select lead_id from wazzup_inbound_messages')).lead_id, null);
});

test('missing local taxonomy does not borrow another workspace classification', async () => {
  await db.exec(`delete from lead_stages where workspace_id='${id(1)}';
    delete from lead_sources where workspace_id='${id(1)}';`);
  assert.equal((await submit()).kind, 'created');
  const lead = await query('select stage_id,source_id from leads');
  assert.deepEqual(lead, { stage_id: null, source_id: null });
});

test('name and notes are bounded, and an empty name falls back to the normalized phone', async () => {
  assert.equal((await submit({ ...input(), name: 'N'.repeat(300), text: 'T'.repeat(2000) })).kind, 'created');
  assert.deepEqual(await query('select length(full_name)::int as name,length(notes)::int as notes from leads'), { name: 200, notes: 1010 });
  await submit({ ...input(), message: id(22), phone: '+77010000002', name: ' ', text: '' });
  const lead = await query('select full_name,notes from leads where phone=$1', ['+77010000002']);
  assert.deepEqual(lead, { full_name: '+77010000002', notes: null });
});

test('invalid normalized phone and request identifiers fail without writes', async () => {
  for (const change of [{ phone: '' }, { phone: '87010000001' }, { phone: '+7 text' },
    { phone: '+' + '7'.repeat(33) }, { channel: '' }, { message: '' }, { message: 'M'.repeat(201) }]) {
    assert.equal((await submit({ ...input(), ...change })).code, 'P7101', JSON.stringify(change));
  }
  assert.deepEqual(await counts(), empty);
});

test('only service_role can execute the secured atomic function', async () => {
  for (const role of ['anon', 'authenticated']) assert.equal((await submit(input(), role)).code, '42501');
  const functionMeta = await query(`select prosecdef,proconfig from pg_proc
    where oid='public.process_wazzup_inbound_message(text,text,text,text,text)'::regprocedure`);
  assert.equal(functionMeta.prosecdef, true);
  assert.ok(functionMeta.proconfig.some((entry: string) => /^search_path=(?:""|)$/.test(entry)));
  assert.deepEqual(await counts(), empty);
  assert.equal((await submit()).kind, 'created');
});
