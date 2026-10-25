import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const readTelegramMigration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
export const hash = text => createHash('sha256').update(text).digest('hex');
export const ADMIT = `select public.admit_content_telegram_delivery($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,$6::text,$7::uuid,$8::text,$9::jsonb) as result`;
export const ADVANCE = `select public.advance_content_telegram_delivery($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,$6::text,$7::uuid,$8::integer,$9::text,$10::text) as result`;
export const migrationName = '097_content_telegram_delivery_admission.sql';
export async function setupTelegramDatabase(client, embedded = false, beforeMigration) {
  await client.exec('create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to anon,authenticated,service_role;');
  for (const name of ['009_medcall_mvp_persistence.sql','010_staff_ready_crm.sql','011_staff_auth_foundation.sql']) {
    let sql = await readTelegramMigration(name);
    if (embedded) sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/ig, '');
    await client.exec(sql);
  }
  if(beforeMigration) await beforeMigration();
  await client.exec(await readTelegramMigration(migrationName));
}
export async function telegramScenario(client, change = {}) {
  const workspace = randomUUID(), staff = randomUUID(), auth = randomUUID(), video = randomUUID(), dispatch = randomUUID();
  const version = '2090-10-25T08:00:00.123456+00:00', title = 'Synthetic content';
  await client.query('insert into public.workspaces(id,name) values($1,$2)', [workspace,'Synthetic Telegram workspace']);
  await client.query(`insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
    values($1,$2,$3,$4,'Synthetic actor','admin','active')`, [staff,workspace,auth,`${staff}@example.invalid`]);
  await client.query('insert into public.content_videos(id,workspace_id,title,updated_at) values($1,$2,$3,$4::timestamptz)', [video,workspace,title,version]);
  const snapshot = { title,hook:'',script:'',voiceover:'',cta:'',caption:'',hashtags:[],avatarPrompt:'',tapnowPrompt:'' };
  const text = `ИИ студия контента: ${title}`;
  const manifest = { snapshot,text,parts:[text],...change };
  const args = [workspace,staff,auth,video,version,'package',dispatch,hash('synthetic recipient'),JSON.stringify(manifest)];
  const admit = (overrides = {}, db = client) => {
    const values = [...args]; for(const [index,value] of Object.entries(overrides)) values[Number(index)] = value;
    return db.query(ADMIT,values).then(result => result.rows[0].result);
  };
  const advance = (index, ack = null, overrides = {}, db = client) => {
    const values = [workspace,staff,auth,video,version,'package',dispatch,index,hash(manifest.parts[index] ?? ''),ack];
    for(const [key,value] of Object.entries(overrides)) values[Number(key)] = value;
    return db.query(ADVANCE, values).then(result => result.rows[0].result);
  };
  const state = () => client.query('select * from public.content_telegram_deliveries where workspace_id=$1',[workspace]).then(r=>r.rows);
  return { workspace,staff,auth,video,dispatch,version,manifest,args,admit,advance,state };
}
export async function telegramSqlCases(t, client) {
  await t.test('exact actor, tenant and current microsecond version required before admission', async () => {
    const f=await telegramScenario(client);
    for(const change of [{1:randomUUID()},{2:randomUUID()},{0:randomUUID()}]) await assert.rejects(f.admit(change),e=>e.code==='P9704'||e.code==='23503');
    await assert.rejects(f.admit({4:'2090-10-25T08:00:00.123455+00:00'}),e=>e.code==='P9702');
    const altered=structuredClone(f.manifest);altered.snapshot.title='Changed';
    await assert.rejects(f.admit({8:JSON.stringify(altered)}),e=>e.code==='P9702');
    await assert.rejects(f.admit({8:JSON.stringify({...f.manifest,text:'caller text'})}),e=>e.code==='P9702');
    assert.equal((await f.state()).length,0);
    assert.equal((await f.admit()).state,'admitted');
    assert.equal((await client.query("select to_char(package_version at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') as value from public.content_telegram_deliveries where workspace_id=$1",[f.workspace])).rows[0].value,
      '2090-10-25 08:00:00.123456');
  });
  await t.test('one admission; pending, partial and unknown results never expire or release', async () => {
    const f=await telegramScenario(client,{parts:['part one','part two']});
    await f.admit(); await assert.rejects(f.admit({6:randomUUID()}),e=>e.code==='P9703');
    await f.advance(0); await assert.rejects(f.advance(0),e=>e.code==='P9703');
    await assert.rejects(f.advance(1),e=>e.code==='P9703');
    await f.advance(0,hash('receipt one'));await f.advance(0,hash('receipt one'));
    await assert.rejects(f.advance(0,hash('changed receipt')),e=>e.code==='P9702');
    await f.advance(1);
    await client.query("update public.content_telegram_deliveries set updated_at='2000-01-01' where workspace_id=$1",[f.workspace]);
    await assert.rejects(f.admit({6:randomUUID()}),e=>e.code==='P9703');
    assert.equal((await f.state())[0].in_flight,1);
  });
  await t.test('exact success replay sends nothing; content, chunks, recipient and snapshot conflicts deny', async () => {
    const f=await telegramScenario(client);await f.admit();await f.advance(0);await f.advance(0,hash('receipt'));
    assert.equal((await f.admit({6:randomUUID()})).state,'succeeded');
    for(const overrides of [
      {7:hash('different recipient')},
      {8:JSON.stringify({...f.manifest,text:'different'})},
      {8:JSON.stringify({...f.manifest,parts:['different']})},
      {8:JSON.stringify({...f.manifest,snapshot:{...f.manifest.snapshot,hook:'different'}})},
    ]) await assert.rejects(f.admit(overrides),e=>e.code==='P9702');
    await client.query("update public.content_videos set status='telegram_ready',updated_at='2090-10-25T08:00:01.654321Z' where id=$1",[f.video]);
    assert.equal((await f.admit({4:'2090-10-25T08:00:01.654321Z'})).state,'succeeded','a status-only bump is not another send');
    await assert.rejects(f.advance(0),e=>e.code==='P9703');
    await client.query("update public.staff_users set role='lead_manager' where id=$1",[f.staff]);
    await assert.rejects(f.admit(),e=>e.code==='P9704');
  });
  await t.test('dispatch and ACK recheck live actor; other staff cannot take over the dispatcher', async () => {
    const f=await telegramScenario(client);await f.admit();
    await assert.rejects(f.advance(0,null,{6:randomUUID()}),e=>e.code==='P9704');
    await assert.rejects(f.advance(0,null,{1:randomUUID()}),e=>e.code==='P9704');
    await assert.rejects(f.advance(0,null,{8:hash('wrong part')}),e=>e.code==='P9702');
    await client.query("update public.staff_users set status='inactive' where id=$1",[f.staff]);
    await assert.rejects(f.advance(0),e=>e.code==='P9704');
    await client.query("update public.staff_users set status='active' where id=$1",[f.staff]);
    await f.advance(0);
    await client.query("update public.staff_users set auth_user_id=$2 where id=$1",[f.staff,randomUUID()]);
    await assert.rejects(f.advance(0,hash('receipt')),e=>e.code==='P9704');
    assert.equal((await f.state())[0].in_flight,0);
  });
  await t.test('package version checked again immediately before every part', async () => {
    const f=await telegramScenario(client);await f.admit();
    await client.query("update public.content_videos set updated_at='2090-10-25T08:00:00.123457Z' where id=$1",[f.video]);
    await assert.rejects(f.advance(0),e=>e.code==='P9702');
    assert.equal((await f.state())[0].in_flight,null);
  });
  await t.test('one provider message identity cannot acknowledge two different parts', async () => {
    const f=await telegramScenario(client,{parts:['first','second']});await f.admit();
    await f.advance(0);await f.advance(0,hash('provider message one'));await f.advance(1);
    await assert.rejects(f.advance(1,hash('provider message one')),e=>e.code==='P9702');
    assert.equal((await f.state())[0].in_flight,1);assert.equal((await f.state())[0].acknowledgements.length,1);
    await f.advance(1,hash('provider message two'));
    assert.equal((await f.state())[0].status,'succeeded');
  });
  await t.test('new ledger exposes no direct table/column/browser-RPC privileges or recipient/content secrets', async () => {
    for(const role of ['anon','authenticated','service_role']) {
      for(const table of ['content_telegram_deliveries','content_telegram_delivery_guards']) {
        const {rows}=await client.query(`select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as direct,
          has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as columns,
          (select relrowsecurity from pg_class where oid=$2::regclass) as rls`,[role,`public.${table}`]);
        assert.equal(rows[0].direct,false); assert.equal(rows[0].columns,false); assert.equal(rows[0].rls,true);
      }
      const {rows}=await client.query(`select has_function_privilege($1,'public.admit_content_telegram_delivery(uuid,uuid,uuid,uuid,timestamptz,text,uuid,text,jsonb)','EXECUTE') as allowed`,[role]);
      assert.equal(rows[0].allowed,role==='service_role');
    }
    const columns=(await client.query("select column_name from information_schema.columns where table_name='content_telegram_deliveries'")).rows.map(r=>r.column_name);
    for(const secret of ['token','chat_id','snapshot','manifest','text','parts']) assert.ok(!columns.includes(secret));
  });
  await t.test('test namespace binds one explicit UUID intent; fresh manual intent admits another dispatcher', async () => {
    const f=await telegramScenario(client),first=randomUUID(),next=randomUUID();
    const text='✅ Telegram подключён к Medina OS Content Studio',manifest={snapshot:{},text,parts:[text]};
    const options={3:first,4:'2000-01-01T00:00:00Z',5:'test',8:JSON.stringify(manifest)};
    const part={3:first,4:'2000-01-01T00:00:00Z',5:'test',8:hash(text)};
    assert.equal((await f.admit(options)).state,'admitted');
    await f.advance(0,null,part);await f.advance(0,hash('first fake test ACK'),part);
    assert.equal((await f.admit({...options,6:randomUUID()})).state,'succeeded');
    assert.equal((await f.admit({...options,3:next,6:randomUUID()})).state,'admitted');
    await assert.rejects(f.admit({...options,3:next,6:randomUUID()}),e=>e.code==='P9703');
    for(const change of [
      {3:'00000000-0000-1000-8000-000000000097'},
      {4:'2000-01-01T00:00:00.000001Z'},
      {8:JSON.stringify({...manifest,text:'arbitrary business message'})},
      {8:JSON.stringify({...manifest,snapshot:{title:'business payload'}})},
      {8:JSON.stringify({...manifest,parts:['arbitrary chunk']})},
    ]) await assert.rejects(f.admit({...options,...change}),e=>e.code==='P9701');
    const rows=await f.state();assert.equal(rows.length,2);assert.equal(rows.filter(row=>row.status==='succeeded').length,1);
  });
  await t.test('bound 10000-row retention stops new admission and never deletes old uncertainty', async () => {
    const f=await telegramScenario(client);
    await client.query(`insert into public.content_telegram_deliveries(workspace_id,video_id,package_version,kind,dispatch_id,staff_user_id,auth_user_id,
      content_sha256,snapshot_sha256,recipient_sha256,part_sha256)
      select $1,gen_random_uuid(),$2,'package',gen_random_uuid(),$3,$4,repeat('a',64),repeat('b',64),repeat('c',64),jsonb_build_array(repeat('d',64))
      from generate_series(1,10000)`,[f.workspace,f.version,f.staff,f.auth]);
    await assert.rejects(f.admit(),e=>e.code==='P9705');
    assert.equal((await f.state()).length,10000);
  });
}
