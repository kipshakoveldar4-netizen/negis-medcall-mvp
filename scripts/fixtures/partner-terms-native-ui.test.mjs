import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { readReviewedChain } from './migration-chain-review.mjs';
import { partnerEntryHttpFixture,stopPartnerEntryBuilds,ENTRY_ACTOR } from './partner-entry-http-fixture.mjs';
import { partnerUiNativeAdapter,partnerUiNativeBundle,partnerUiNativeServer,stopPartnerUiBuilds } from './partner-terms-native-ui-fixture.mjs';
import { ownedRecoveryBrowser,root } from '../src/appointment-recovery-committed-fixture.ts';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const prefix='medina_partner_terms_v1:';
async function until(check){for(let n=0;n<250;n++){if(await check())return;await delay(30);}assert.fail('Owned partner SQL/HTTP condition did not settle');}

test('partner actual Control/Portal and transports -> compiled catch-all -> native SQL; synthetic Auth only',{timeout:360000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Explicit owned-native opt-in; no remote DSN or install fallback');
  const chain=await readReviewedChain(path.join(root,'migrations')),fixture=await startNativePostgres();t.after(()=>fixture.close());t.after(stopPartnerEntryBuilds);t.after(stopPartnerUiBuilds);
  const db=await fixture.connect();await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for(const e of chain)await db.query(e.source);
  const identities=new Map(),native=partnerUiNativeAdapter(fixture);
  const api=await partnerEntryHttpFixture(native.adapter,{approved:false,identities,env:{MEDINA_PLATFORM_OWNER_IDS:ENTRY_ACTOR,MEDINA_PARTNER_ENTRY_ENABLED:'false'}});t.after(()=>api.close());
  const output=await mkdtemp(path.join(root,'node_modules/.cache/partner-terms-native-ui-'));
  async function seed(dual=false){const f={owner:ENTRY_ACTOR,a:randomUUID(),b:randomUUID()};f.tokens=Object.fromEntries([f.owner,f.a,f.b].map(id=>[id,'owned.'+randomUUID()+'.signature']));
    for(const[id,token]of Object.entries(f.tokens))identities.set(token,id);
    for(const[actor,key,name]of [[f.a,'profileA','Owned partner A'],[f.b,'profileB','Owned partner B']]){
      const p=(await one(db,"select public.apply_growth_contributor($1,$2,true,$3,'{}') v",[actor,name,dual&&actor===f.a])).v;
      const p2=(await one(db,"select public.review_growth_contributor($1,$2,$3,'partner','approve') v",[p.id,p.revision,f.owner])).v;f[key]=p2.id;
      if(dual&&actor===f.a)await db.query("select public.review_growth_contributor($1,$2,$3,'creator','approve')",[p2.id,p2.revision,f.owner]);}
    f.counts=()=>one(db,`select (select count(*)::int from public.growth_partner_terms where profile_id=any($1::uuid[])) terms,
      (select count(*)::int from public.growth_partner_term_commands where profile_id=any($1::uuid[])) commands,
      (select count(*)::int from public.growth_partners where auth_user_id=any($2::uuid[])) partners,
      (select count(*)::int from public.platform_subscription_payments) payments`,[[f.profileA,f.profileB],[f.a,f.b]]);
    f.cleanup=async()=>{native.release();await db.query('delete from public.growth_partner_term_commands where profile_id=any($1::uuid[])',[[f.profileA,f.profileB]]);
      await db.query('delete from public.growth_partner_terms where profile_id=any($1::uuid[])',[[f.profileA,f.profileB]]);
      await db.query('delete from public.growth_partners where auth_user_id=any($1::uuid[])',[[f.a,f.b]]);
      await db.query('delete from public.growth_contributor_profiles where id=any($1::uuid[])',[[f.profileA,f.profileB]]);
      for(const token of Object.values(f.tokens))identities.delete(token);};return f;
  }
  async function browserFor(f){const server=await partnerUiNativeServer(api.handler,await partnerUiNativeBundle(f));let browser;
    try{browser=await ownedRecoveryBrowser(server.origin,{settleTimeoutMs:12000});}catch(e){await server.close();throw e;}
    const run=browser.evaluate,wait=browser.waitFor;
    const click=(text,selector='button')=>run(`const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing enabled button '+${JSON.stringify(text)});e.click();`);
    const fill=(label,value)=>run(`const l=[...document.querySelectorAll('label')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})),e=l?.querySelector('input,textarea');if(!e||e.disabled)throw Error('Missing field');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));`);
    const view=async(mode,actor)=>{await run(`f.change(${JSON.stringify(mode)},${JSON.stringify(actor??(mode==='platform'?f.owner:f.a))});`);await wait(`document.querySelector('h1')?.textContent===${JSON.stringify(mode==='platform'?'Блогеры':'Кабинет блогера')}`);};
    const open=async(name='Owned partner A',form=true)=>{await wait(`document.querySelectorAll('.operator-row').length===2`);await run(`const row=[...document.querySelectorAll('.operator-row')].find(e=>e.querySelector('h2')?.textContent===${JSON.stringify(name)});[...row.querySelectorAll('button')].find(e=>e.textContent==='Условия партнёрства').click();`);await wait(`!!document.querySelector(${JSON.stringify(form?'.pt-form':'.partner-terms')})`);};
    const draft=async(text='PRIVATE NATIVE TERMS')=>{await fill('Первая оплата','23,50');await fill('Продления','6.50');await fill('Текст предложения',text);};
    const offer=async(text)=>{await open();await draft(text);await click('Предложить условия');await wait(`document.querySelector('.partner-terms')?.innerText.includes('Ожидает решения')`);};
    const accept=async()=>{await click('Принимаю указанные проценты и текст условий этого предложения.','label');await click('Принять условия');};
    const pending=()=>run(`return Object.keys(sessionStorage).filter(k=>k.startsWith(${JSON.stringify(prefix)})).map(k=>sessionStorage.getItem(k));`);
    const settled=()=>wait(`!!document.querySelector('[aria-label="Результат отправки условий"]')&&![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Проверить результат').disabled`);
    const reload=async()=>{const id=await run('return f.bootId;');await run('setTimeout(()=>location.reload(),0);');await wait(`f&&f.bootId!==${JSON.stringify(id)}&&!!document.querySelector('h1')`);};
    return{server,browser,run,wait,click,fill,view,open,draft,offer,accept,pending,settled,reload,async close(){native.release();await server.release();await until(()=>server.controls.active.size===0);await browser.close();await server.close();
      assert.deepEqual(browser.exceptions,[]);assert.ok(browser.requests.every(url=>url.startsWith(server.origin+'/')||url.startsWith('data:')),'Only owned same-origin HTTP assets/API');
      assert.deepEqual(server.controls.errors,[]);assert.ok(server.controls.requests.every(v=>v.cache==='no-store'));}};
  }
  for(const width of [375,1440])await t.test(`${width}: real owner offer and explicit partner acceptance refresh the real ledger, without payments`,async()=>{
    const f=await seed(),b=await browserFor(f);try{await b.browser.viewport(width,1050);await b.offer('PRIVATE NATIVE TERMS '+width);
      const stored=await one(db,'select first_commission_bps first,renewal_commission_bps renewal,terms_text terms from public.growth_partner_terms where profile_id=$1',[f.profileA]);assert.deepEqual(stored,{first:2350,renewal:650,terms:'PRIVATE NATIVE TERMS '+width});
      await b.view('partner');await b.wait(`document.querySelector('.partner-terms')?.innerText.includes('PRIVATE NATIVE TERMS')`);
      assert.equal(await b.run(`return [...document.querySelectorAll('button')].find(e=>e.textContent.includes('Принять условия')).disabled;`),true);
      await b.accept();await b.wait(`!!document.querySelector('.pt-code code')`);await b.wait(`document.querySelector('[aria-label="Партнёрская статистика"]')?.innerText.includes('Подтверждённых начислений и выплат пока нет.')`);
      const code=await b.run(`return document.querySelector('.pt-code code').textContent;`);assert.match(code,/^[A-F0-9]{32}$/);
      assert.equal((await one(db,'select referral_code from public.growth_partners where auth_user_id=$1',[f.a])).referral_code,code);
      assert.deepEqual(await f.counts(),{terms:1,commands:2,partners:1,payments:0});assert.deepEqual(await b.pending(),[]);assert.equal(await b.run('return f.snapshot().overflow;'),false);
      await writeFile(path.join(output,`accepted-${width}.png`),await b.browser.screenshot());
      await b.view('partner',f.b);await b.wait(`document.querySelector('.partner-terms')?.innerText.includes('Предложение условий пока не получено.')`);
      assert.equal(await b.run(`return document.body.innerText.includes(${JSON.stringify(code)})||document.body.innerText.includes('PRIVATE NATIVE TERMS');`),false);
    }finally{await b.close();await f.cleanup();}
  });
  for(const action of ['offer','accept'])await t.test(`lost real ${action} ACK survives actual reload and recovers exactly one committed command`,async()=>{
    const f=await seed(),b=await browserFor(f);try{
      if(action==='offer'){await b.open();await b.draft('PRIVATE LOST OFFER');b.server.controls.mode='drop';await b.click('Предложить условия');}
      else{await b.offer();await b.view('partner');await b.wait(`!!document.querySelector('.pt-check input')`);b.server.controls.mode='drop';await b.accept();}
      await b.settled();const before=await f.counts(),metadata=await b.pending();assert.equal(metadata.length,1);assert.doesNotMatch(metadata[0],/PRIVATE|Commission|payload|token|signature/);
      await b.reload();assert.equal(await b.run(`return document.body.innerText.includes('Повторить исходную отправку');`),false);
      if(action==='offer')await b.open('Owned partner A',false);await b.settled();await b.click('Проверить результат');await b.wait(`!document.querySelector('[aria-label="Результат отправки условий"]')`);
      assert.deepEqual(await f.counts(),before);assert.deepEqual(await b.pending(),[]);
    }finally{await b.close();await f.cleanup();}
  });
  await t.test('one approved person can be partner and creator independently, without granting creator access to another partner',async()=>{
    const f=await seed(true),b=await browserFor(f);try{await b.offer('PRIVATE DUAL ROLE');await b.view('partner');await b.wait(`document.querySelector('[aria-label="Задания авторов"]')?.innerText.includes('На этой странице заданий пока нет.')`);
      await b.wait(`!!document.querySelector('.pt-check input')`);await b.accept();await b.wait(`!!document.querySelector('.pt-code code')`);
      await b.wait(`document.querySelector('[aria-label="Партнёрская статистика"]')?.innerText.includes('Подтверждённых начислений и выплат пока нет.')`);
      assert.ok(native.controls.calls.some(c=>c.name==='read_growth_creator_jobs'&&c.args.p_actor===f.a));
      const denied=await fetch(b.server.origin+'/api/crm/creator-jobs',{headers:{Authorization:'Bearer '+f.tokens[f.b]},signal:AbortSignal.timeout(10000)});assert.equal(denied.status,403);
      await b.view('partner',f.b);await b.wait(`document.querySelector('.partner-terms')?.innerText.includes('Предложение условий пока не получено.')`);assert.equal(await b.run(`return !!document.querySelector('[aria-label="Задания авторов"]');`),false);
      assert.deepEqual(await f.counts(),{terms:1,commands:2,partners:1,payments:0});assert.equal((await one(db,'select count(*)::int n from public.growth_creator_jobs')).n,0);
    }finally{await b.close();await f.cleanup();}
  });
  await t.test('exact in-memory retry after lost HTTP ACK uses the original JSON and does not write another proposal',async()=>{
    const f=await seed(),b=await browserFor(f);try{await b.open();await b.draft('PRIVATE EXACT RETRY');b.server.controls.mode='drop';await b.click('Предложить условия');await b.settled();
      const before=await f.counts();await b.click('Повторить исходную отправку');await b.wait(`!document.querySelector('[aria-label="Результат отправки условий"]')`);
      const posts=b.server.controls.requests.filter(r=>r.route==='platform-partner-terms'&&r.method==='POST');assert.equal(posts.length,2);assert.deepEqual(posts[0].body,posts[1].body);
      assert.deepEqual(await f.counts(),before);assert.deepEqual(await b.pending(),[]);
    }finally{await b.close();await f.cleanup();}
  });
  await t.test('explicit withdrawal and decline preserve revisions and allow only a newly offered version to activate',async()=>{
    const f=await seed(),b=await browserFor(f);try{await b.offer('PRIVATE WITHDRAWN');await b.click('Отозвать предложение');await b.click('Подтвердить');await b.wait(`!!document.querySelector('.pt-form')`);
      await b.draft('PRIVATE DECLINED');await b.click('Предложить условия');await b.wait(`document.querySelector('.partner-terms')?.innerText.includes('Ожидает решения')`);
      await b.view('partner');await b.wait(`document.querySelector('.partner-terms')?.innerText.includes('PRIVATE DECLINED')`);await b.click('Отклонить');await b.click('Подтвердить');await b.wait(`document.querySelector('.partner-terms')?.innerText.includes('Предложение отклонено')`);
      assert.equal((await f.counts()).partners,0);await b.view('platform');await b.open();await b.draft('PRIVATE ACCEPTED NEW');await b.click('Предложить условия');await b.wait(`document.querySelector('.partner-terms')?.innerText.includes('Ожидает решения')`);
      await b.view('partner');await b.wait(`document.querySelector('.partner-terms')?.innerText.includes('PRIVATE ACCEPTED NEW')`);await b.accept();await b.wait(`!!document.querySelector('.pt-code code')`);
      assert.deepEqual(await f.counts(),{terms:1,commands:6,partners:1,payments:0});assert.deepEqual(await b.pending(),[]);
    }finally{await b.close();await f.cleanup();}
  });
  await t.test('unknown acceptance is explicitly fenced after remount; the delayed original SQL cannot activate a partner',async()=>{
    const f=await seed(),b=await browserFor(f);try{await b.offer();await b.view('partner');await b.wait(`!!document.querySelector('.pt-check input')`);native.controls.holdNext=true;await b.accept();await until(()=>native.controls.held);
      await b.view('partner');await b.settled();await b.click('Проверить результат');await b.wait(`document.body.innerText.includes('Результат пока не подтверждён.')`);
      await b.click('Закрыть неподтверждённую отправку. Уже сохранённое действие не отменяется.','label');await b.click('Закрыть отправку');await b.wait(`!document.querySelector('[aria-label="Результат отправки условий"]')`);
      native.release();await until(()=>b.server.controls.active.size===0);assert.deepEqual(await f.counts(),{terms:1,commands:2,partners:0,payments:0});
      assert.equal((await one(db,"select state from public.growth_partner_term_commands where intent->>'action'='accept'")).state,'abandoned');
      assert.equal(await b.run(`return !!document.querySelector('.pt-code code');`),false);await b.accept();await b.wait(`!!document.querySelector('.pt-code code')`);assert.equal((await f.counts()).partners,1);
    }finally{native.release();await b.close();await f.cleanup();}
  });
  await t.test('committed response held across A-B-A never publishes private terms/code into B and recovers only for A',async()=>{
    const f=await seed(),b=await browserFor(f);try{await b.offer('PRIVATE HELD A');await b.view('partner');await b.wait(`!!document.querySelector('.pt-check input')`);b.server.controls.mode='after';await b.accept();await until(()=>b.server.controls.held.length===1);
      await b.view('partner',f.b);await b.wait(`document.querySelector('.partner-terms')?.innerText.includes('Предложение условий пока не получено.')`);await b.server.release();await delay(80);
      assert.equal(await b.run(`return document.body.innerText.includes('PRIVATE HELD A')||!!document.querySelector('.pt-code');`),false);
      await b.view('partner');await b.settled();await b.click('Проверить результат');await b.wait(`!document.querySelector('[aria-label="Результат отправки условий"]')&&!!document.querySelector('.pt-code code')`);
      assert.deepEqual(await f.counts(),{terms:1,commands:2,partners:1,payments:0});
    }finally{await b.close();await f.cleanup();}
  });
  await t.test('approval revoked after HTTP identity check but before SQL rejects acceptance and hides the entire former private form',async()=>{
    const f=await seed(),b=await browserFor(f);try{await b.offer('PRIVATE REVOKED TERMS');await b.view('partner');await b.wait(`!!document.querySelector('.pt-check input')`);native.controls.holdNext=true;await b.accept();await until(()=>native.controls.held);
      const p=await one(db,'select revision from public.growth_contributor_profiles where id=$1',[f.profileA]);await db.query("select public.review_growth_contributor($1,$2,$3,'partner','suspend')",[f.profileA,p.revision,f.owner]);
      native.release();await b.wait(`document.body.innerText.includes('Доступ партнёра изменился.')`);assert.equal(await b.run(`return document.body.innerText.includes('PRIVATE REVOKED TERMS')||!!document.querySelector('.pt-check,.pt-code');`),false);
      assert.deepEqual(await f.counts(),{terms:1,commands:1,partners:0,payments:0});assert.ok(b.server.controls.requests.some(v=>v.method==='POST'&&v.route==='partner-terms'&&v.status===403));
    }finally{native.release();await b.close();await f.cleanup();}
  });
  assert.deepEqual(api.state.unexpected,[]);assert.equal(api.state.challenges.length,0,'No real or synthetic bot/advertising provider was needed');
  for(const{name}of(await db.query("select c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows)
    assert.equal((await one(db,'select count(*)::int n from public."'+name.replaceAll('"','""')+'"')).n,0,'No owned business fixture remains: '+name);
  t.diagnostic('Owned native UI screenshots: '+output);
});
