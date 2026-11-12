import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const migrations = new URL('../../migrations/', import.meta.url);
const read = file => readFile(new URL(file, migrations), 'utf8');
const migration = await read('086_video_job_promotion.sql');
const tableOnly = source => source.slice(0, source.indexOf('insert into storage.buckets'));
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ASSET='cccccccc-cccc-4ccc-8ccc-cccccccccccc', JOB='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const VERSION='2026-10-25T00:00:00.000Z', ORIGIN='https://video-promotion.fixture.invalid';
const output=`optimized/${A}/${JOB}-${'a'.repeat(20)}.mp4`, thumbnail=output.slice(0,-4)+'-thumbnail.jpg';
const result={storage_origin:ORIGIN,storage_bucket:'ad-creatives',storage_path:output,
  public_url:`${ORIGIN}/storage/v1/object/public/ad-creatives/${output}`,file_size:40,sha256:'b'.repeat(64),
  thumbnail_path:thumbnail,thumbnail_public_url:`${ORIGIN}/storage/v1/object/public/ad-creatives/${thumbnail}`,
  thumbnail_size:12,thumbnail_sha256:'c'.repeat(64),input_size:100};
const signature='public.finalize_video_job(uuid,uuid,text,timestamptz,integer,timestamptz,jsonb)';
const sql='select public.finalize_video_job($1,$2,$3,$4,$5,$6,$7) as receipt';
const args=(changes={})=>[JOB,A,'qa-worker',VERSION,1,VERSION,result].map((value,index)=>Object.hasOwn(changes,index)?changes[index]:value);
const observe=promise=>promise.then(value=>({value}),error=>({error}));

test('G5-C54 actual 015/016 table foundations + 017/018/082/085/086 on owned PostgreSQL', {timeout:300000}, async t=>{
  t.diagnostic('086 SHA-256: '+createHash('sha256').update(migration).digest('hex'));
  const fixture=await startDisposablePostgres();
  try {
    const db=await fixture.connect();
    await db.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      alter default privileges grant all on tables to anon,authenticated;
      create table public.workspaces(id uuid primary key); create table public.meta_campaign_launches(id uuid primary key);
      insert into public.workspaces values('${A}'),('${B}');`);
    for(const name of ['015_ad_creative_assets.sql','016_video_processing_jobs.sql']) {
      const source=await read(name); assert.ok(source.includes('insert into storage.buckets')); await db.query(tableOnly(source));
    }
    for(const name of ['017_video_jobs_completed_at.sql','018_video_processing_jobs_contract.sql','082_ad_creative_assets_server_access.sql','085_generated_creative_identity.sql']) await db.query(await read(name));
    await db.query('grant select(raw_path),update(claimed_by) on public.video_processing_jobs to authenticated');
    assert.equal((await db.query(`select has_table_privilege('anon','public.video_processing_jobs','INSERT') as allowed`)).rows[0].allowed,true,
      'Scaffold reproduces broad default grants, not the state of any cloud database');
    await db.query(migration);
    const seed=async()=>{
      await db.query('delete from public.video_processing_jobs'); await db.query('delete from public.ad_creative_assets');
      await db.query(`insert into public.ad_creative_assets(id,workspace_id,file_name,file_type,mime_type,file_size,storage_bucket,storage_path,metadata,updated_at)
        values($1,$2,'source.mov','video','video/quicktime',100,'ad-creatives-raw',$3,'{"retained":true}',$4)`,[ASSET,A,`${A}/source.mov`,VERSION]);
      await db.query(`insert into public.video_processing_jobs(id,workspace_id,asset_id,status,raw_bucket,raw_path,raw_size,source_file_name,source_mime_type,
        output_bucket,claimed_by,claimed_at,attempts) values($1,$2,$3,'uploading','ad-creatives-raw',$4,100,'source.mov','video/quicktime','ad-creatives','qa-worker',$5,1)`,
      [JOB,A,ASSET,`${A}/source.mov`,VERSION]);
    };
    const snapshot=async()=>({job:(await db.query('select to_jsonb(j) as row from public.video_processing_jobs j')).rows,
      asset:(await db.query('select to_jsonb(a) as row from public.ad_creative_assets a')).rows});
    await t.test('a regressed legacy asset column grant prevents migration instead of silently accepting a weak dependency',async()=>{
      await db.query('grant select(id) on public.ad_creative_assets to authenticated');
      try {await assert.rejects(db.query(migration),/video_promotion_dependencies_unconfirmed/); await db.query('rollback');}
      finally {await db.query(await read('082_ad_creative_assets_server_access.sql'));}
    });
    await t.test('browser CRUD, legacy column grants and function execution remain denied even with permissive policies',async()=>{
      await db.query('create policy synthetic_all on public.video_processing_jobs for all to anon,authenticated using(true) with check(true)');
      for(const role of ['anon','authenticated']) {
        assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed',[role,signature])).rows[0].allowed,false);
        const browser=await fixture.connect();
        try { await browser.query(`set role ${role}`);
          for(const query of ['select * from public.video_processing_jobs','select raw_path,claimed_by from public.video_processing_jobs',
            "insert into public.video_processing_jobs(status) values('queued')","update public.video_processing_jobs set claimed_by='forged'",'delete from public.video_processing_jobs'])
            await assert.rejects(browser.query(query),error=>error.code==='42501');
          await assert.rejects(browser.query(sql,args()),error=>error.code==='42501');
        } finally {await browser.end();}
      }
    });
    await t.test('service promotion commits both records and exact replay does not rewrite metadata or timestamps',async()=>{
      await seed(); const server=await fixture.connect();
      try {await server.query('set role service_role');
        const saved=(await server.query(sql,args())).rows[0].receipt;
        assert.deepEqual(saved,{jobId:JOB,workspaceId:A,assetId:ASSET,status:'ready',promotion:result});
        const before=await snapshot(); const a=before.asset[0].row,j=before.job[0].row;
        assert.equal(a.metadata.retained,true); assert.equal(a.file_name,'source.mp4'); assert.equal(a.storage_path,output);
        assert.equal(j.status,'ready'); assert.equal(j.raw_deleted_at,null); assert.equal(j.promotion_receipt.result.sha256,result.sha256);
        assert.deepEqual((await server.query(sql,args())).rows[0].receipt,saved); assert.deepEqual(await snapshot(),before);
        await assert.rejects(server.query(sql,args({6:{...result,sha256:'d'.repeat(64)}})),/video_promotion_replay_refused/);
        assert.deepEqual(await snapshot(),before);
      } finally {await server.end();}
    });
    await t.test('a failure while setting job ready rolls back the earlier asset update',async()=>{
      await seed(); const before=await snapshot();
      await db.query(`create function public.synthetic_ready_failure() returns trigger language plpgsql as $$ begin
        if new.status='ready' then raise exception 'SYNTHETIC_READY_FAILURE'; end if; return new; end $$;
        create trigger synthetic_ready_failure before update on public.video_processing_jobs for each row execute function public.synthetic_ready_failure()`);
      try {await assert.rejects(db.query(sql,args()),/SYNTHETIC_READY_FAILURE/); assert.deepEqual(await snapshot(),before);}
      finally {await db.query('drop trigger synthetic_ready_failure on public.video_processing_jobs; drop function public.synthetic_ready_failure()');}
    });
    for(const [name,changes] of [['wrong workspace',{1:B}],['wrong worker',{2:'other'}],['wrong attempt',{4:2}],
      ['wrong claim timestamp',{3:'2026-10-24T00:00:00Z'}],['null attempt',{4:null}],['changed asset version',{5:'2026-10-24T00:00:00Z'}],
      ['foreign output path',{6:{...result,storage_path:output.replace(A,B)}}],['changed URL',{6:{...result,public_url:'https://other.invalid/file'}}],
      ['bad hash',{6:{...result,sha256:'not-a-hash'}}],['string size',{6:{...result,file_size:'40'}}],
      ['extra field',{6:{...result,unknown:true}}],['unknown result',{6:null}]]) {
      await t.test(`${name} refuses without partial updates`,async()=>{await seed(); const before=await snapshot();
        await assert.rejects(db.query(sql,args(changes))); assert.deepEqual(await snapshot(),before);});
    }
    await t.test('generated immutable origin refuses without changing its identity or the job',async()=>{
      await seed(); await db.query(`update public.ad_creative_assets set generated_key='v1:synthetic',generated_sha256=repeat('f',64) where id=$1`,[ASSET]);
      const before=await snapshot(); await assert.rejects(db.query(sql,args()),/video_promotion_asset_refused/); assert.deepEqual(await snapshot(),before);
    });
    await t.test('a linked foreign asset is never promoted and a detached job never changes that asset',async()=>{
      await seed(); await db.query('update public.ad_creative_assets set workspace_id=$1 where id=$2',[B,ASSET]);
      const before=await snapshot(); await assert.rejects(db.query(sql,args()),/video_promotion_asset_refused/); assert.deepEqual(await snapshot(),before);
      await db.query('update public.video_processing_jobs set asset_id=null where id=$1',[JOB]);
      const saved=(await db.query(sql,args({5:null}))).rows[0].receipt; assert.equal(saved.assetId,null);
      assert.deepEqual((await snapshot()).asset,before.asset);
    });
    await t.test('two finalizers serialize on one claim and the second returns the unchanged receipt',async()=>{
      await seed(); const left=await fixture.connect(),right=await fixture.connect();
      try {
        const holder=(await left.query('select pg_backend_pid() as pid')).rows[0].pid,waiter=(await right.query('select pg_backend_pid() as pid')).rows[0].pid;
        await left.query('begin'); const first=(await left.query(sql,args())).rows[0].receipt;
        const savedAt=(await left.query('select updated_at from public.ad_creative_assets where id=$1',[ASSET])).rows[0].updated_at;
        const pending=observe(right.query(sql,args())); let blocked=false;
        for(let attempt=0;attempt<50;attempt++){if((await db.query('select $1::int=any(pg_blocking_pids($2::int)) as blocked',[holder,waiter])).rows[0].blocked){blocked=true;break;} await delay(20);}
        assert.equal(blocked,true); await left.query('commit'); const second=await pending;
        assert.equal(second.error,undefined); assert.deepEqual(second.value.rows[0].receipt,first);
        assert.equal(new Date((await snapshot()).asset[0].row.updated_at).getTime(),savedAt.getTime());
      } finally {await left.query('rollback').catch(()=>{});await left.end();await right.end();}
    });
    await t.test('a stale worker waits for the job row lock then refuses a newly committed claim',async()=>{
      await seed(); const left=await fixture.connect(),right=await fixture.connect();
      try {
        const holder=(await left.query('select pg_backend_pid() as pid')).rows[0].pid, waiter=(await right.query('select pg_backend_pid() as pid')).rows[0].pid;
        await left.query('begin'); await left.query('select id from public.video_processing_jobs where id=$1 for update',[JOB]);
        const pending=observe(right.query(sql,args())); let blocked=false;
        for(let attempt=0;attempt<50;attempt++){if((await db.query('select $1::int=any(pg_blocking_pids($2::int)) as blocked',[holder,waiter])).rows[0].blocked){blocked=true;break;} await delay(20);}
        assert.equal(blocked,true); await left.query("update public.video_processing_jobs set claimed_by='other',attempts=2 where id=$1",[JOB]);
        await left.query('commit'); assert.match((await pending).error?.message??'',/video_promotion_claim_refused/);
        assert.equal((await snapshot()).asset[0].row.storage_path,`${A}/source.mov`);
      } finally {await left.query('rollback').catch(()=>{});await left.end();await right.end();}
    });
    await t.test('repeat migration preserves rows, RLS, browser denial and unrelated workspace',async()=>{
      const before=await snapshot(); await db.query(migration); assert.deepEqual(await snapshot(),before);
      assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.video_processing_jobs'::regclass")).rows[0].relrowsecurity,true);
      assert.equal((await db.query("select has_any_column_privilege('authenticated','public.video_processing_jobs','SELECT,INSERT,UPDATE,REFERENCES') as allowed")).rows[0].allowed,false);
      assert.equal((await db.query('select count(*)::int as n from public.workspaces')).rows[0].n,2);
    });
    for(const [name,grant] of [
      ['table','grant select on public.video_processing_jobs to synthetic_legacy'],
      ['column','grant select(raw_path) on public.video_processing_jobs to synthetic_legacy'],
      ['function',`grant execute on function ${signature} to synthetic_legacy`],
    ]) await t.test(`an inherited browser ${name} grant aborts migration with rows unchanged`,async()=>{
      const before=await snapshot();
      await db.query('create role synthetic_legacy nologin; grant synthetic_legacy to authenticated');
      try {
        await db.query(grant);
        await assert.rejects(db.query(migration),/video_promotion_browser_access_unconfirmed/); await db.query('rollback');
        assert.deepEqual(await snapshot(),before);
      } finally {
        await db.query(`revoke synthetic_legacy from authenticated;
          revoke all on table public.video_processing_jobs from synthetic_legacy;
          revoke select(raw_path) on table public.video_processing_jobs from synthetic_legacy;
          revoke all on function ${signature} from synthetic_legacy; drop role synthetic_legacy`);
      }
    });
  } finally {await fixture.close();}
});
