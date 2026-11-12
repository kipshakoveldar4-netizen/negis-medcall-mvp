import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const read = name => readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8');
const migration = await read('087_staged_creative_foundation.sql');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID='cccccccc-cccc-4ccc-8ccc-cccccccccccc', USER='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const hash='a'.repeat(64), path=`${A}/verified/${ID}/${hash}.jpg`, url=`https://staging.fixture.invalid/storage/v1/object/public/ad-creatives/${path}`;

test('actual quarantine foundation on owned PostgreSQL; Storage API is not simulated as accepted', {timeout:300000},async t=>{
  t.diagnostic('087 SHA-256: '+createHash('sha256').update(migration).digest('hex'));
  const fixture=await startDisposablePostgres();
  try {
    const db=await fixture.connect();
    await db.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create table public.workspaces(id uuid primary key); create table public.meta_campaign_launches(id uuid primary key);
      insert into public.workspaces values('${A}'),('${B}');
      create schema storage; grant usage on schema public,storage to anon,authenticated,service_role;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
      alter table storage.objects enable row level security;
      grant all on storage.objects to anon,authenticated,service_role;
      create policy synthetic_broad on storage.objects for all to anon,authenticated using(true) with check(true);
      insert into storage.buckets values('unrelated','unrelated',false,20,array['image/jpeg']);
      insert into storage.objects(bucket_id,name) values('unrelated','existing'),(null,'existing-orphan');`);
    const base=await read('015_ad_creative_assets.sql');
    await db.query(base.slice(0,base.indexOf('insert into storage.buckets')));
    await db.query(await read('082_ad_creative_assets_server_access.sql'));
    await db.query(await read('085_generated_creative_identity.sql'));
    await db.query(migration);
    const seed=async()=>{
      await db.query('delete from public.ad_creative_assets');
      await db.query(`insert into public.ad_creative_assets(id,workspace_id,file_name,file_type,mime_type,file_size,storage_bucket,storage_path,public_url,
        verified_upload_key,verified_upload_sha256,verified_upload_actor_id,metadata)
        values($1,$2,'synthetic.jpg','image','image/jpeg',100,'ad-creatives',$3,$4,$1,$5,$6,'{"retained":true}')`,[ID,A,path,url,hash,USER]);
    };
    const snapshot=async()=>({assets:(await db.query('select to_jsonb(a) as row from public.ad_creative_assets a')).rows,
      buckets:(await db.query('select to_jsonb(b) as row from storage.buckets b order by id')).rows,
      objects:(await db.query('select to_jsonb(o) as row from storage.objects o order by bucket_id,id')).rows});
    await t.test('the new bucket is private and restrictive policy leaves unrelated files unchanged',async()=>{
      assert.equal((await db.query("select public from storage.buckets where id='ad-creatives-staging'")).rows[0].public,false);
      await db.query(`insert into storage.objects(bucket_id,name) values('ad-creatives-staging','private-synthetic')`);
      for(const role of ['anon','authenticated']) {
        const client=await fixture.connect();
        try {
          await client.query(`set role ${role}`);
          assert.deepEqual((await client.query('select bucket_id,name from storage.objects order by bucket_id')).rows,
            [{bucket_id:'unrelated',name:'existing'},{bucket_id:null,name:'existing-orphan'}]);
          await assert.rejects(client.query("insert into storage.objects(bucket_id,name) values('ad-creatives-staging','forged')"),error=>error.code==='42501');
          assert.equal((await client.query("update storage.objects set name='forged' where bucket_id='ad-creatives-staging'")).rowCount,0);
          assert.equal((await client.query("delete from storage.objects where bucket_id='ad-creatives-staging'")).rowCount,0);
        } finally {await client.end();}
      }
      const server=await fixture.connect();
      try {await server.query('set role service_role'); assert.equal((await server.query("select name from storage.objects where bucket_id='ad-creatives-staging'")).rows[0].name,'private-synthetic');}
      finally {await server.end();}
    });
    await t.test('a verified row admits exact metadata/status updates, not a forged file identity',async()=>{
      await seed(); const before=await snapshot();
      await db.query("update public.ad_creative_assets set status='archived',metadata=metadata||'{\"label\":\"Synthetic\"}' where id=$1",[ID]);
      const after=await snapshot(); assert.equal(after.assets[0].row.metadata.retained,true);
      assert.equal(after.assets[0].row.verified_upload_sha256,before.assets[0].row.verified_upload_sha256);
    });
    for(const [column,value] of [['id',USER],['workspace_id',B],['verified_upload_key',USER],['verified_upload_actor_id',A],
      ['verified_upload_sha256','b'.repeat(64)],['file_name','other.jpg'],['file_type','video'],['mime_type','image/png'],
      ['file_size',99],['storage_bucket','other'],['storage_path','other'],['public_url','https://other.invalid/file']]) {
      await t.test(`verified ${column} cannot be rewritten`,async()=>{
        await seed(); const before=await snapshot(); await assert.rejects(db.query(`update public.ad_creative_assets set ${column}=$1 where id=$2`,[value,ID]),/verified_creative_upload_immutable/);
        assert.deepEqual(await snapshot(),before);
      });
    }
    await t.test('partial or malformed verification cannot be grafted onto an unverified legacy row',async()=>{
      await db.query('delete from public.ad_creative_assets');
      await db.query(`insert into public.ad_creative_assets(id,workspace_id,file_name,metadata) values($1,$2,'legacy.jpg','{"retained":true}')`,[ID,A]);
      const before=await snapshot();
      for(const query of ["verified_upload_key=id",`verified_upload_sha256='${hash}'`,`verified_upload_actor_id='${USER}'`,
        `verified_upload_key=id,verified_upload_actor_id='${USER}',verified_upload_sha256='invalid'`]) {
        await assert.rejects(db.query(`update public.ad_creative_assets set ${query} where id=$1`,[ID]),/verified_creative_upload_invalid/);
        assert.deepEqual(await snapshot(),before);
      }
    });
    await t.test('a preexisting public staging bucket aborts migration instead of silently changing it',async()=>{
      await db.query("update storage.buckets set public=true where id='ad-creatives-staging'"); const before=await snapshot();
      try {await assert.rejects(db.query(migration),/creative_staging_bucket_unconfirmed/); await db.query('rollback'); assert.deepEqual(await snapshot(),before);}
      finally {await db.query("update storage.buckets set public=false where id='ad-creatives-staging'");}
    });
    await t.test('repeat migration does not backfill legacy rows or grant browser asset access',async()=>{
      const before=await snapshot(); await db.query(migration); assert.deepEqual(await snapshot(),before);
      for(const role of ['anon','authenticated']) assert.equal((await db.query("select has_any_column_privilege($1,'public.ad_creative_assets','SELECT,INSERT,UPDATE,REFERENCES') as allowed",[role])).rows[0].allowed,false);
      assert.equal((await db.query("select polpermissive from pg_policy where polname='medina_staged_creatives_browser_guard'")).rows[0].polpermissive,false);
    });
  } finally {await fixture.close();}
});
