import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { seedPartnerLedger } from './partner-ledger-cases.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
const cap=async(db,x,start=x.start)=>(await one(db,'select public.capture_growth_partner_source_v2($1,$2,$3,\'link\',$4) value',[x.id,x.hash,x.partner.code,start])).value;
const purge=async(db,limit=100)=>(await one(db,'select public.purge_growth_partner_sources($1) n',[limit])).n;
async function denied(db,fn,code){await db.query('savepoint entry_denial');try{await assert.rejects(fn,e=>e.code===code);}finally{await db.query('rollback to savepoint entry_denial;release savepoint entry_denial');}}
async function rollback(db,fn){await db.query('begin');try{await fn();}finally{await db.query('rollback');}}
async function seed(db){const at=(await one(db,"select date_trunc('milliseconds',clock_timestamp()) at")).at;
  return{id:randomUUID(),hash:createHash('sha256').update(randomBytes(32)).digest('hex'),start:at.toISOString(),partner:await seedPartnerLedger(db),actor:randomUUID(),workspaces:[]};}
async function cleanup(db,x){await db.query('delete from public.growth_partner_sources where id=$1',[x.id]);
  await db.query('delete from public.growth_referrals where workspace_id=any($1::uuid[])',[x.workspaces]);await db.query('delete from public.staff_users where workspace_id=any($1::uuid[])',[x.workspaces]);
  await db.query('delete from public.workspaces where id=any($1::uuid[])',[x.workspaces]);await db.query('delete from public.growth_partners where id=$1',[x.partner.partner]);await db.query('delete from public.growth_contributor_profiles where id=$1',[x.partner.profile]);}
async function expire(db,x){await db.query("update public.growth_partner_sources set captured_at=statement_timestamp()-interval '8 days',expires_at=statement_timestamp()-interval '1 day' where id=$1",[x.id]);}
async function blocked(db,waiter,blocker){for(let i=0;i<160;i++){if((await one(db,'select $1::int=any(pg_blocking_pids($2::int)) yes',[blocker,waiter])).yes)return;await new Promise(r=>setTimeout(r,15));}assert.fail('Expected real entry authority wait');}

export async function exercisePartnerEntryAnchor(db,fixture,source,t){
  await t.test('113 first-entry signed time, not a later DB retry/sign-in time, defines the seven-day window',async()=>rollback(db,async()=>{
    const x=await seed(db);x.start=new Date(Date.parse(x.start)-2*86400000).toISOString();await db.query('set local role service_role');const first=await cap(db,x);
    assert.equal(Date.parse(first.capturedAt),Date.parse(x.start));assert.equal(Date.parse(first.expiresAt)-Date.parse(x.start),7*86400000);
    assert.deepEqual(await cap(db,x),first);await denied(db,()=>cap(db,x,new Date(Date.parse(x.start)+1000).toISOString()),'P1132');
  }));
  for(const [label,start,code]of[['expired','2000-01-01T00:00:00Z','P1133'],['future','2999-01-01T00:00:00Z','P1132'],['infinite','infinity','P1132'],['missing',null,'P1132']])
    await t.test('113 refuses '+label+' entry without leaving a source',async()=>rollback(db,async()=>{
      const x=await seed(db);await db.query('set local role service_role');await denied(db,()=>cap(db,x,start),code);await db.query('reset role');
      assert.equal((await one(db,'select count(*)::int n from public.growth_partner_sources')).n,0);
    }));
  await t.test('113 cleanup erases expired unbound hashes/actors, preserves fresh and registered bindings, and is bounded',async()=>rollback(db,async()=>{
    const old=await seed(db),fresh=await seed(db),bound=await seed(db);await cap(db,old);await cap(db,fresh);await cap(db,bound);await expire(db,old);
    const w=randomUUID();bound.workspaces.push(w);await db.query("insert into public.workspaces(id,name,created_at) values($1,'Owned bound fixture',clock_timestamp())",[w]);
    await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,'bound@example.invalid','Owned bound owner','owner','active')",[randomUUID(),w,bound.actor]);
    await db.query('select public.claim_growth_partner_source($1,$2,$3)',[bound.actor,bound.id,bound.hash]);await db.query('select public.bind_growth_partner_source($1,$2,$3)',[bound.actor,bound.id,w]);await expire(db,bound);
    await db.query('set local role service_role');assert.equal(await purge(db,1),1);assert.equal(await purge(db),0);
    for(const limit of [null,0,101])await denied(db,()=>purge(db,limit),'P1132');
    await db.query('reset role');assert.deepEqual((await db.query('select id from public.growth_partner_sources order by id')).rows.map(r=>r.id),[fresh.id,bound.id].sort());
    assert.equal((await one(db,'select count(*)::int n from public.growth_referrals')).n,1);
  }));
  await t.test('113 a delayed original cannot recreate an expired source after privacy cleanup',async()=>rollback(db,async()=>{
    const x=await seed(db);await cap(db,x);await expire(db,x);
    const old=(await one(db,'select captured_at at from public.growth_partner_sources where id=$1',[x.id])).at.toISOString();
    await db.query('set local role service_role');assert.equal(await purge(db),1);await denied(db,()=>cap(db,x,old),'P1133');
    await denied(db,()=>db.query('select public.capture_growth_partner_source($1,$2,$3,\'link\')',[x.id,x.hash,x.partner.code]),'42501');
    await db.query('reset role');assert.equal((await one(db,'select count(*)::int n from public.growth_partner_sources')).n,0);
  }));
  await t.test('113 only service entries; old capture and all direct source grants stay closed',async()=>rollback(db,async()=>{
    for(const role of ['anon','authenticated','service_role']){
      for(const sig of ['public.capture_growth_partner_source_v2(uuid,text,text,text,timestamptz)','public.purge_growth_partner_sources(integer)'])
        assert.equal((await one(db,'select has_function_privilege($1,$2,\'EXECUTE\') yes',[role,sig])).yes,role==='service_role');
      assert.equal((await one(db,'select has_function_privilege($1,\'public.capture_growth_partner_source(uuid,text,text,text)\',\'EXECUTE\') yes',[role])).yes,false);
      assert.equal((await one(db,'select has_table_privilege($1,\'public.growth_partner_sources\',\'SELECT,INSERT,UPDATE,DELETE,TRUNCATE\') yes',[role])).yes,false);
    }
  }));
  for(const kind of ['intent','row'])await t.test('113 cleanup skips an in-flight '+kind+' lock instead of deadlocking',async()=>{
    const x=await seed(db),a=await fixture.connect(),b=await fixture.connect();try{
      await cap(db,x);await expire(db,x);await a.query('begin');
      if(kind==='intent')await a.query("select pg_advisory_xact_lock(hashtextextended('partner-source:'||$1::text,0))",[x.id]);
      else await a.query('select id from public.growth_partner_sources where id=$1 for update',[x.id]);
      await b.query('set role service_role');assert.equal(await purge(b),0);await a.query('commit');assert.equal(await purge(b),1);
    }finally{await a.query('rollback');await a.end();await b.end();await cleanup(db,x);}
  });
  await t.test('113 expiry after a real profile wait rolls back the initial legacy insert too',async()=>{
    const x=await seed(db),a=await fixture.connect(),b=await fixture.connect();let pending;try{
      const now=(await one(db,"select date_trunc('milliseconds',clock_timestamp()) at")).at;
      x.start=new Date(now.getTime()-7*86400000+2000).toISOString();await a.query('begin');await a.query('select id from public.growth_contributor_profiles where id=$1 for update',[x.partner.profile]);
      const ap=(await one(a,'select pg_backend_pid() id')).id,bp=(await one(b,'select pg_backend_pid() id')).id;
      await b.query('set role service_role');pending=observed(cap(b,x));await blocked(db,bp,ap);await new Promise(r=>setTimeout(r,2100));await a.query('commit');
      assert.equal((await pending).error?.code,'P1133');assert.equal((await one(db,'select count(*)::int n from public.growth_partner_sources')).n,0);
    }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();await cleanup(db,x);}
  });
  await t.test('113 concurrent cleanup workers remove different rows once without overwriting another worker',async()=>{
    const x=await seed(db),y=await seed(db),a=await fixture.connect(),b=await fixture.connect();try{
      await cap(db,x);await cap(db,y);await expire(db,x);await expire(db,y);await a.query('begin;set local role service_role');assert.equal(await purge(a,1),1);
      await b.query('set role service_role');assert.equal(await purge(b,2),1);await a.query('commit');assert.equal(await purge(b,100),0);
    }finally{await a.query('rollback');await a.end();await b.end();await cleanup(db,x);await cleanup(db,y);}
  });
  await t.test('113 rerun preserves captured data and closure of the old writer',async()=>{
    const x=await seed(db);try{const first=await cap(db,x);await db.query(source);assert.deepEqual(await cap(db,x),first);
      assert.equal((await one(db,"select has_function_privilege('service_role','public.capture_growth_partner_source(uuid,text,text,text)','EXECUTE') yes")).yes,false);
    }finally{await cleanup(db,x);}
  });
}
