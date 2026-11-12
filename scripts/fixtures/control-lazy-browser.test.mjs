import assert from 'node:assert/strict';
import { mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createControlLazyBrowser,createControlProductionGuest,createControlGuestBrowser,stopControlLazyBuilds } from './control-lazy-browser-fixture.mjs';
import { ownedRecoveryBrowser,root } from '../src/appointment-recovery-committed-fixture.ts';
async function until(check){for(let n=0;n<200;n++){if(check())return;await delay(25);}assert.fail('Owned chunk barrier did not settle');}
test('actual Control App with split modules, real React/transport and synthetic Auth/HTTP only',{timeout:300000},async t=>{
  t.after(stopControlLazyBuilds);const output=await mkdtemp(path.join(root,'node_modules/.cache/control-lazy-browser-'));
  const reports=[],artifacts=[];let runIndex=0;
  t.diagnostic('Owned Control browser artifacts: '+output);
  t.after(async()=>{await writeFile(path.join(output,'report.json'),JSON.stringify({reports,artifacts},null,2));});
  const capture=async(b,name)=>{const file=path.join(output,name+'.png');await writeFile(file,await b.browser.screenshot());artifacts.push(file);};
  async function open(guest=false,label='lazy-navigation'){const server=await createControlLazyBrowser();let browser;
    try{browser=await ownedRecoveryBrowser(server.origin+(guest?'/?guest=1':''),{settleTimeoutMs:12000});}catch(error){await server.close();throw error;}
    const run=browser.evaluate,wait=browser.waitFor;
    const click=text=>run(`const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing button '+${JSON.stringify(text)});e.click();`);
    const fill=(id,value)=>run(`const e=document.getElementById(${JSON.stringify(id)});if(!e||e.disabled)throw Error('Missing input '+${JSON.stringify(id)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));`);
    const form=async()=>{await click('Подключить клинику');await wait(`!!document.getElementById('ob-name')`);await click('Ссылка-приглашение');await fill('ob-name','Owned lazy company');await fill('ob-vertical','clinic');await fill('ob-email','owned@example.invalid');await fill('ob-owner','Owned lazy owner');};
    return{server,browser,run,wait,click,fill,form,async close(){server.release();try{await browser.close();}finally{await server.close();}
      const report={label,serverClosed:!server.listening,sourceHashes:server.sourceHashes,screens:server.screens,api:server.controls.api,companies:server.companies.snapshot(),requests:browser.requests,exceptions:browser.exceptions,
        loopbackOnly:browser.requests.every(v=>v.startsWith(server.origin+'/')||v.startsWith('data:'))};
      reports.push(report);const log=path.join(output,`run-${++runIndex}-${label}.json`);await writeFile(log,JSON.stringify(report,null,2));artifacts.push(log);
      assert.equal(report.serverClosed,true);assert.deepEqual(browser.exceptions,[]);assert.equal(report.loopbackOnly,true);}};
  }
  await t.test('guest requests no business screen; sign-in fetches only the selected overview',async()=>{
    const b=await open(true);try{await b.wait(`document.body.innerText.includes('Вход в портал')`);assert.equal(b.server.controls.api.length,0);
      for(const file of Object.values(b.server.screens))assert.equal(b.server.controls.requests.includes(file),false);
      await b.run(`f.change('A');`);await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);
      assert.equal(b.server.controls.requests.includes(b.server.screens.Overview),true);
      assert.equal(Object.keys(b.server.screens).length,6);
      for(const key of ['Onboarding','Operators','Contributors','ClinicCard','PartnerCompanies'])assert.equal(b.server.controls.requests.includes(b.server.screens[key]),false);
    }finally{await b.close();}
  });
  await t.test('all six owned split screens stay unloaded for a guest with empty storage and synthetic SDK',async()=>{
    const server=await createControlGuestBrowser();let browser;
    try{browser=await ownedRecoveryBrowser(server.url,{settleTimeoutMs:12000});await browser.waitFor(`document.body.innerText.includes('Вход в портал')&&!!document.querySelector('input[type="password"]')`);
      assert.equal(await browser.evaluate(`return document.querySelector('button[type="submit"]').disabled;`),false,'Public fixture config is ready, not a blocked configuration fallback');
      assert.equal(await browser.evaluate(`return sessionStorage.length;`),0);assert.equal(server.screens.length,6);
      assert.deepEqual(server.api,[]);for(const file of server.screens)assert.equal(server.requests.includes(file),false);
      assert.deepEqual(browser.exceptions,[]);assert.ok(browser.requests.every(v=>v.startsWith(server.origin+'/')||v.startsWith('data:')),'CSP also prevents any external request before it can leave the browser');
    }finally{await browser?.close();await server.close();}
  });
  await t.test('actual production Vite chunks and real SDK initialize guest login with empty storage and no external connection',async()=>{
    const server=await createControlProductionGuest();let browser;
    try{browser=await ownedRecoveryBrowser(server.origin,{settleTimeoutMs:12000});await browser.waitFor(`document.body.innerText.includes('Вход в портал')&&!!document.querySelector('input[type="password"]')`);
      assert.equal(await browser.evaluate(`return document.querySelector('button[type="submit"]').disabled;`),false,'Public fixture config is ready, not a blocked configuration fallback');
      assert.equal(server.screens.length,6);assert.equal(await browser.evaluate(`return sessionStorage.length;`),0);
      assert.deepEqual(server.api,[]);for(const file of server.screens)assert.equal(server.requests.includes(file),false);
      assert.deepEqual(browser.exceptions,[]);assert.ok(browser.requests.every(v=>v.startsWith(server.origin+'/')||v.startsWith('data:')),'CSP also prevents any external request before it can leave the browser');
      const file=path.join(output,'production-guest.json');
      await writeFile(file,JSON.stringify({mode:'actual Vite build and real SDK; explicit synthetic public overrides; no API dispatch',sourceHashes:server.sourceHashes,screens:server.screens,api:server.api,requests:browser.requests,exceptions:browser.exceptions},null,2));artifacts.push(file);
    }finally{try{await browser?.close();}finally{await server.close();}}
  });
  await t.test('pending navigation unmounts the previous valid form and its retained submit cannot dispatch',async()=>{
    const b=await open();try{await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);await b.form();
      await b.run(`const e=document.querySelector('main form');f.submit=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onSubmit;`);
      b.server.controls.hold=b.server.screens.Operators;await b.click('Операторы');await until(()=>b.server.controls.held.length===1);await b.wait(`document.querySelector('main')?.innerText.includes('Загружаем раздел...')`);
      assert.equal(await b.run(`return !!document.getElementById('ob-name');`),false);const before=b.server.fixture.snapshot().ownerCounters.mutations;
      await b.run(`f.submit({preventDefault(){}});`);await delay(40);assert.equal(b.server.fixture.snapshot().ownerCounters.mutations,before);
      b.server.release();await b.wait(`document.querySelector('h1')?.textContent==='Операторы колл-центра'`);
      await b.form();await b.run(`document.querySelector('main form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
      await until(()=>b.server.fixture.snapshot().ownerCounters.mutations===before+1);
    }finally{await b.close();}
  });
  for(const screen of [{key:'Operators',menu:'Операторы',heading:'Операторы колл-центра',path:'/api/crm/platform-operators'},
    {key:'PartnerCompanies',menu:'Заявки компаний',heading:'Компании партнёров',path:'/api/crm/platform-partner-companies'}])await t.test(`A-B-A during pending ${screen.key} module resets navigation and never mounts the retired screen`,async()=>{
    const b=await open();try{await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);b.server.controls.hold=b.server.screens[screen.key];await b.click(screen.menu);await until(()=>b.server.controls.held.length===1);
      await b.run(`f.aba();`);await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);b.server.release();await delay(80);
      assert.equal(await b.run(`return document.querySelector('h1')?.textContent;`),'Платформа Medina');assert.equal(b.server.controls.api.filter(v=>v.path===screen.path).length,0);
      await b.click(screen.menu);await b.wait(`document.querySelector('h1')?.textContent===${JSON.stringify(screen.heading)}`);assert.ok(b.server.controls.api.some(v=>v.path===screen.path));
    }finally{await b.close();}
  });
  await t.test('chunk failure is contained; other navigation and explicit reload remain usable',async()=>{
    const b=await open();try{await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);b.server.controls.fail=b.server.screens.Contributors;await b.click('Блогеры');await b.wait(`document.querySelector('[role="alert"]')?.innerText.includes('Не удалось загрузить раздел')`);
      assert.equal(await b.run(`return !![...document.querySelectorAll('button')].find(e=>e.textContent==='Обновить страницу');`),true);
      await b.click('Обзор');await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);await b.click('Блогеры');await b.wait(`!!document.querySelector('[role="alert"]')`);
      const id=await b.run(`return f.bootId;`);await b.click('Обновить страницу');await b.wait(`f&&f.bootId!==${JSON.stringify(id)}&&document.querySelector('h1')?.textContent==='Платформа Medina'`);
      await b.click('Блогеры');await b.wait(`document.querySelector('h1')?.textContent==='Блогеры'`);await b.click('Выйти');await b.wait(`document.body.innerText.includes('Вход в портал')`);
    }finally{await b.close();}
  });
  for(const width of [375,1440])await t.test(`${width}: loading status and failure actions fit the current Control layout`,async()=>{
    const b=await open();try{await b.browser.viewport(width,1000);await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);b.server.controls.hold=b.server.screens.Onboarding;await b.click('Подключить клинику');await until(()=>b.server.controls.held.length===1);
      await b.wait(`document.querySelector('main')?.innerText.includes('Загружаем раздел...')`);assert.equal(await b.run(`return f.snapshot().overflow;`),false);
      if(width===375)assert.ok(await b.run(`return document.querySelector('.side').getBoundingClientRect().height<=220;`),'Mobile menu must not expand into a half-screen hero while content is short');
      await capture(b,`loading-${width}`);
      b.server.release();await b.wait(`!!document.getElementById('ob-name')`);b.server.controls.fail=b.server.screens.Contributors;await b.click('Блогеры');await b.wait(`!!document.querySelector('[role="alert"]')`);
      if(width===375)assert.ok(await b.run(`return document.querySelector('.side').getBoundingClientRect().height<=220;`),'Failed content must not stretch the mobile menu either');
      assert.equal(await b.run(`return f.snapshot().overflow;`),false);await capture(b,`failure-${width}`);
    }finally{await b.close();}
  });
  const companyRows=`document.querySelectorAll('.pc-row')`;
  const reviewCalls=b=>b.server.companies.requests.filter(r=>r.kind==='review');
  const marker=async b=>b.run(`const keys=Object.keys(sessionStorage).filter(k=>k.startsWith('medina-control:partner-company-review:v1:'));return keys.map(k=>[k,JSON.parse(sessionStorage.getItem(k))]);`);
  const selectCompany=async b=>{await b.run(`document.querySelector('.pc-row').click();`);await b.wait(`!!document.querySelector('.pc-detail')`);};
  const consent=async(b,selector='dialog')=>{await b.run(`const e=document.querySelector(${JSON.stringify(selector)}+' input[type="checkbox"]');if(!e||e.disabled)throw Error('Missing enabled consent');e.click();`);};
  const companyQueue=async(b,width)=>{await b.browser.viewport(width,1000);await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);await b.click('Заявки компаний');await b.wait(`${companyRows}.length===20`);};
  const approveDialog=async b=>{await b.click('Одобрить');await b.wait(`document.querySelector('dialog')?.matches(':modal')`);};
  async function fit(b){
    const result=await b.run(`return {overflow:document.documentElement.scrollWidth>innerWidth+1,
      controls:[...document.querySelectorAll('.partner-companies button,.partner-companies select,.partner-companies input')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&(r.left< -1||r.right>innerWidth+1);}).map(e=>e.textContent||e.id),
      dialog:(()=>{const d=document.querySelector('dialog');if(!d)return true;const r=d.getBoundingClientRect();return d.matches(':modal')&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()};`);
    assert.equal(result.overflow,false);assert.deepEqual(result.controls,[]);assert.equal(result.dialog,true);
  }
  for(const width of [375,1440])await t.test(`${width}: company queue/detail and actual native approve/reject dialogs persist across reload`,async()=>{
    const b=await open(false,`company-dialog-${width}`);try{
      await companyQueue(b,width);const first=b.server.companies.snapshot().rows[0];
      assert.deepEqual(b.server.companies.requests[0].query,{offset:'0',state:'pending'});
      assert.equal(b.server.controls.requests.includes(b.server.screens.PartnerCompanies),true);
      await fit(b);await capture(b,`company-queue-${width}`);await selectCompany(b);
      assert.equal(await b.run(`return document.querySelector('.pc-detail').innerText.includes(${JSON.stringify(first.company.ownerName)});`),true);
      assert.equal(await b.run(`return document.querySelector('.pc-detail').querySelectorAll('select,input').length;`),0);
      await b.run(`document.querySelector('.pc-detail').scrollIntoView({block:'start'});`);await fit(b);await capture(b,`company-detail-${width}`);
      await approveDialog(b);
      assert.equal(await b.run(`return document.querySelector('dialog input').checked;`),false);
      assert.equal(await b.run(`return [...document.querySelectorAll('dialog button')].find(e=>e.textContent==='Создать новое пространство').disabled;`),true);
      await b.run(`document.querySelector('dialog button.btn-primary').click();`);assert.equal(reviewCalls(b).length,0);
      await consent(b);await consent(b);assert.equal(await b.run(`return document.querySelector('dialog button.btn-primary').disabled;`),true);
      await consent(b);await b.click('Отмена');await b.wait(`!document.querySelector('dialog')`);assert.equal(reviewCalls(b).length,0);
      await approveDialog(b);assert.equal(await b.run(`return document.querySelector('dialog input').checked;`),false);
      assert.equal(await b.run(`return document.querySelector('dialog').innerText.includes('новое рабочее пространство')&&document.querySelector('dialog').innerText.includes(${JSON.stringify(first.company.ownerName)});`),true);
      await fit(b);await capture(b,`company-approve-dialog-${width}`);await consent(b);await b.click('Создать новое пространство');
      await b.wait(`!document.querySelector('dialog')&&!document.querySelector('.pc-recovery')&&document.querySelector('.pc-success')?.innerText.includes('Одобрение подтверждено')`);
      assert.equal(b.server.companies.counts.commits,1);assert.deepEqual(await marker(b),[]);
      const saved=b.server.companies.snapshot().rows.find(row=>row.id===first.id);assert.equal(saved.state,'approved');assert.ok(saved.workspaceId);assert.notEqual(saved.revision,first.revision);
      await b.fill('pc-state','approved');await b.wait(`${companyRows}.length===1`);await selectCompany(b);
      assert.equal(await b.run(`return document.querySelector('.pc-detail').innerText.includes(${JSON.stringify(saved.workspaceId)});`),true);
      await fit(b);await capture(b,`company-approved-${width}`);
      await b.browser.load();await companyQueue(b,width);await b.fill('pc-state','approved');await b.wait(`${companyRows}.length===1`);
      assert.equal(await b.run(`return document.querySelector('.pc-row').innerText.includes(${JSON.stringify(first.company.name)});`),true);
      await b.fill('pc-state','all');await b.wait(`${companyRows}.length===20&&document.getElementById('pc-state').value==='all'`);
      assert.deepEqual(b.server.companies.requests.at(-1).query,{offset:'0'});
      await b.run(`document.querySelector('[aria-label="Следующая страница"]').click();`);await b.wait(`${companyRows}.length===2&&document.querySelector('.pc-pagination').innerText.includes('Страница 2')`);
      assert.deepEqual(b.server.companies.requests.at(-1).query,{offset:'20'});await fit(b);await capture(b,`company-page-two-${width}`);
      await b.fill('pc-state','pending');await b.wait(`${companyRows}.length===20`);await selectCompany(b);await b.click('Отклонить');
      await b.wait(`document.querySelector('dialog')?.matches(':modal')&&document.querySelector('dialog h2').textContent==='Отклонить заявку?'`);
      assert.equal(await b.run(`return [...document.querySelectorAll('dialog button')].find(e=>e.textContent==='Отклонить заявку').disabled;`),true);
      await fit(b);await capture(b,`company-reject-dialog-${width}`);await consent(b);await b.click('Отклонить заявку');
      await b.wait(`document.querySelector('.pc-success')?.innerText.includes('Отклонение заявки подтверждено')&&!document.querySelector('.pc-recovery')`);
      assert.equal(b.server.companies.counts.commits,2);assert.equal(reviewCalls(b).at(-1).body.action,'reject');
    }finally{await b.close();}
  });
  for(const width of [375,1440])await t.test(`${width}: lost response retry, metadata-only reload recovery, and explicit close use the original command`,async()=>{
    const b=await open(false,`company-recovery-${width}`);try{
      await companyQueue(b,width);await selectCompany(b);b.server.companies.fault={kind:'review',when:'before',mode:'lose'};
      await approveDialog(b);await consent(b);await b.click('Создать новое пространство');
      await b.wait(`!!document.querySelector('.pc-recovery')&&!!document.querySelector('.pc-error')&&![...document.querySelectorAll('button')].find(e=>e.textContent==='Проверить результат').disabled`);
      const first=reviewCalls(b)[0],metadata=first.body,stored=await marker(b);assert.equal(stored.length,1);assert.deepEqual(stored[0][1],metadata);
      assert.deepEqual(Object.keys(stored[0][1]).sort(),['action','applicationId','requestId','revision']);
      assert.equal(JSON.stringify(stored).includes('Synthetic company'),false);assert.equal(JSON.stringify(stored).includes('Synthetic owner'),false);
      assert.equal(await b.run(`return [...document.querySelectorAll('button')].find(e=>e.textContent==='Повторить исходную отправку').disabled;`),true);
      await b.click('Проверить результат');await b.wait(`!!document.querySelector('.pc-recovery input')&&![...document.querySelectorAll('button')].find(e=>e.textContent==='Повторить исходную отправку').disabled`);
      assert.deepEqual(b.server.companies.requests.filter(r=>r.kind==='read').at(-1).query,metadata);
      await fit(b);await b.run(`document.querySelector('.pc-recovery').scrollIntoView({block:'start'});`);await capture(b,`company-unknown-${width}`);
      await b.click('Повторить исходную отправку');await b.wait(`!document.querySelector('.pc-recovery')&&!!document.querySelector('.pc-success')`);
      assert.equal(reviewCalls(b)[1].rawBody,first.rawBody);assert.equal(b.server.companies.counts.commits,1);assert.deepEqual(await marker(b),[]);
      await b.wait(`${companyRows}.length===20`);await selectCompany(b);b.server.companies.fault={kind:'review',when:'before',mode:'lose'};
      await approveDialog(b);await consent(b);await b.click('Создать новое пространство');await b.wait(`!!document.querySelector('.pc-recovery')&&!!document.querySelector('.pc-error')`);
      const second=reviewCalls(b).at(-1).body;assert.notEqual(second.requestId,metadata.requestId);
      await b.click('Проверить результат');await b.wait(`!!document.querySelector('.pc-recovery input')&&![...document.querySelectorAll('button')].find(e=>e.textContent==='Повторить исходную отправку').disabled`);
      await b.run(`const e=[...document.querySelectorAll('button')].find(e=>e.textContent==='Повторить исходную отправку');f.retiredCompanyRetry=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onClick;`);
      b.server.companies.fault={kind:'close',when:'before',mode:'lose'};await consent(b,'.pc-recovery');await b.click('Закрыть отправку');
      await b.wait(`!document.querySelector('.pc-recovery input')&&!!document.querySelector('.pc-error')&&![...document.querySelectorAll('button')].find(e=>e.textContent==='Проверить результат').disabled`);
      await b.click('Проверить результат');await b.wait(`!!document.querySelector('.pc-recovery input')`);
      const reviewsBefore=reviewCalls(b).length;await b.run(`f.retiredCompanyRetry();`);await delay(60);assert.equal(reviewCalls(b).length,reviewsBefore);
      assert.equal(await b.run(`return [...document.querySelectorAll('button')].some(e=>e.textContent==='Повторить исходную отправку');`),false);
      await fit(b);await b.run(`document.querySelector('.pc-recovery').scrollIntoView({block:'start'});`);await capture(b,`company-close-unknown-${width}`);
      await b.browser.load();await companyQueue(b,width);await b.wait(`!!document.querySelector('.pc-recovery')`);
      assert.equal(await b.run(`return [...document.querySelectorAll('button')].some(e=>e.textContent==='Повторить исходную отправку');`),false);
      assert.deepEqual((await marker(b))[0][1],second);await b.click('Проверить результат');await b.wait(`!!document.querySelector('.pc-recovery input')`);
      assert.deepEqual(b.server.companies.requests.filter(r=>r.kind==='read').at(-1).query,second);
      assert.equal(await b.run(`return [...document.querySelectorAll('button')].find(e=>e.textContent==='Закрыть отправку').disabled;`),true);
      await fit(b);await b.run(`document.querySelector('.pc-recovery').scrollIntoView({block:'start'});`);await capture(b,`company-restored-recovery-${width}`);
      await consent(b,'.pc-recovery');await b.click('Закрыть отправку');await b.wait(`!document.querySelector('.pc-recovery')&&document.querySelector('.pc-success')?.innerText.includes('отправка закрыта')`);
      assert.deepEqual(b.server.companies.requests.filter(r=>r.kind==='close').at(-1).body,{operation:'close',...second});
      assert.equal(b.server.companies.counts.commits,1);assert.deepEqual(await marker(b),[]);
      await b.wait(`${companyRows}.length===20`);await selectCompany(b);b.server.companies.fault={kind:'review',when:'after',mode:'lose'};
      await approveDialog(b);await consent(b);await b.click('Создать новое пространство');await b.wait(`!!document.querySelector('.pc-recovery')&&!!document.querySelector('.pc-error')`);
      const third=reviewCalls(b).at(-1).body;assert.equal(b.server.companies.counts.commits,2);
      await b.browser.load();await companyQueue(b,width);await b.wait(`!!document.querySelector('.pc-recovery')`);await b.click('Проверить результат');
      await b.wait(`!document.querySelector('.pc-recovery')&&document.querySelector('.pc-success')?.innerText.includes('Одобрение подтверждено')`);
      assert.deepEqual(b.server.companies.requests.filter(r=>r.kind==='read').at(-1).query,third);assert.equal(b.server.companies.counts.commits,2);
      assert.deepEqual(await marker(b),[]);await fit(b);await capture(b,`company-committed-recovery-${width}`);
    }finally{await b.close();}
  });
  for(const width of [375,1440])await t.test(`${width}: held decision survives account denial and ABA only as original receipt metadata`,async()=>{
    const b=await open(false,`company-aba-${width}`);try{
      await companyQueue(b,width);await selectCompany(b);await approveDialog(b);await consent(b);
      await b.run(`const e=document.querySelector('dialog button.btn-primary');f.retiredCompanyDecision=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onClick;`);
      b.server.companies.fault={kind:'review',when:'after',mode:'hold'};await b.click('Создать новое пространство');await until(()=>b.server.companies.held.length===1);
      const command=reviewCalls(b)[0].body;assert.deepEqual((await marker(b))[0][1],command);
      await b.run(`f.change('B');`);await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);await b.click('Заявки компаний');
      await b.wait(`document.querySelector('h1')?.textContent==='Доступ закрыт'`);
      assert.equal(await b.run(`return document.body.innerText.includes('Synthetic company')||document.body.innerText.includes('Synthetic owner')||!!document.querySelector('.pc-recovery');`),false);
      assert.equal(b.server.companies.requests.filter(r=>r.actor==='B').every(r=>r.kind==='list'&&r.method==='GET'),true);
      assert.equal(b.server.companies.counts.denied,1);await fit(b);await capture(b,`company-account-denied-${width}`);
      await b.run(`f.change('A');`);await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);
      b.server.companies.release();await b.run(`f.retiredCompanyDecision();`);await delay(80);
      assert.equal(await b.run(`return document.querySelector('h1')?.textContent;`),'Платформа Medina');assert.equal(reviewCalls(b).length,1);
      assert.deepEqual((await marker(b))[0][1],command);await b.click('Заявки компаний');await b.wait(`!!document.querySelector('.pc-recovery')&&${companyRows}.length===20`);
      assert.equal(await b.run(`return [...document.querySelectorAll('button')].some(e=>e.textContent==='Повторить исходную отправку');`),false);
      await b.click('Проверить результат');await b.wait(`!document.querySelector('.pc-recovery')&&!!document.querySelector('.pc-success')`);
      assert.deepEqual(b.server.companies.requests.filter(r=>r.kind==='read').at(-1).query,command);
      assert.equal(b.server.companies.counts.commits,1);assert.deepEqual(await marker(b),[]);await fit(b);await capture(b,`company-aba-recovered-${width}`);
    }finally{await b.close();}
  });
  t.diagnostic('Owned Control loading screenshots: '+output);
});
