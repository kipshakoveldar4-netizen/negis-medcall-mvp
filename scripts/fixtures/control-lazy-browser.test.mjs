import assert from 'node:assert/strict';
import { mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createControlLazyBrowser,createControlProductionGuest,stopControlLazyBuilds } from './control-lazy-browser-fixture.mjs';
import { ownedRecoveryBrowser,root } from '../src/appointment-recovery-committed-fixture.ts';
async function until(check){for(let n=0;n<200;n++){if(check())return;await delay(25);}assert.fail('Owned chunk barrier did not settle');}
test('actual Control App with split modules, real React/transport and synthetic Auth/HTTP only',{timeout:180000},async t=>{
  t.after(stopControlLazyBuilds);const output=await mkdtemp(path.join(root,'node_modules/.cache/control-lazy-browser-'));
  async function open(guest=false){const server=await createControlLazyBrowser(),browser=await ownedRecoveryBrowser(server.origin+(guest?'/?guest=1':''),{settleTimeoutMs:12000});
    const run=browser.evaluate,wait=browser.waitFor;
    const click=text=>run(`const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing button '+${JSON.stringify(text)});e.click();`);
    const fill=(id,value)=>run(`const e=document.getElementById(${JSON.stringify(id)});if(!e||e.disabled)throw Error('Missing input '+${JSON.stringify(id)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));`);
    const form=async()=>{await click('Подключить клинику');await wait(`!!document.getElementById('ob-name')`);await click('Ссылка-приглашение');await fill('ob-name','Owned lazy company');await fill('ob-vertical','clinic');await fill('ob-email','owned@example.invalid');await fill('ob-owner','Owned lazy owner');};
    return{server,browser,run,wait,click,fill,form,async close(){server.release();await browser.close();await server.close();assert.deepEqual(browser.exceptions,[]);assert.ok(browser.requests.every(v=>v.startsWith(server.origin+'/')||v.startsWith('data:')));}};
  }
  await t.test('guest requests no business screen; sign-in fetches only the selected overview',async()=>{
    const b=await open(true);try{await b.wait(`document.body.innerText.includes('Вход в портал')`);assert.equal(b.server.controls.api.length,0);
      for(const file of Object.values(b.server.screens))assert.equal(b.server.controls.requests.includes(file),false);
      await b.run(`f.change('A');`);await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);
      assert.equal(b.server.controls.requests.includes(b.server.screens.Overview),true);
      for(const key of ['Onboarding','Operators','Contributors','ClinicCard'])assert.equal(b.server.controls.requests.includes(b.server.screens[key]),false);
    }finally{await b.close();}
  });
  await t.test('actual production Vite chunks and real SDK initialize guest login with empty storage and no external connection',async()=>{
    const server=await createControlProductionGuest();let browser;
    try{browser=await ownedRecoveryBrowser(server.origin,{settleTimeoutMs:12000});await browser.waitFor(`document.body.innerText.includes('Вход в портал')&&!!document.querySelector('input[type="password"]')`);
      assert.equal(await browser.evaluate(`return document.querySelector('button[type="submit"]').disabled;`),false,'Public fixture config is ready, not a blocked configuration fallback');
      assert.deepEqual(server.api,[]);for(const file of server.screens)assert.equal(server.requests.includes(file),false);
      assert.deepEqual(browser.exceptions,[]);assert.ok(browser.requests.every(v=>v.startsWith(server.origin+'/')||v.startsWith('data:')),'CSP also prevents any external request before it can leave the browser');
    }finally{await browser?.close();await server.close();}
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
  await t.test('A-B-A while a module is pending resets navigation and never mounts the retired screen',async()=>{
    const b=await open();try{await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);b.server.controls.hold=b.server.screens.Operators;await b.click('Операторы');await until(()=>b.server.controls.held.length===1);
      await b.run(`f.aba();`);await b.wait(`document.querySelector('h1')?.textContent==='Платформа Medina'`);b.server.release();await delay(80);
      assert.equal(await b.run(`return document.querySelector('h1')?.textContent;`),'Платформа Medina');assert.equal(b.server.controls.api.filter(v=>v.path==='/api/crm/platform-operators').length,0);
      await b.click('Операторы');await b.wait(`document.querySelector('h1')?.textContent==='Операторы колл-центра'`);assert.ok(b.server.controls.api.some(v=>v.path==='/api/crm/platform-operators'));
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
      await writeFile(path.join(output,`loading-${width}.png`),await b.browser.screenshot());
      b.server.release();await b.wait(`!!document.getElementById('ob-name')`);b.server.controls.fail=b.server.screens.Contributors;await b.click('Блогеры');await b.wait(`!!document.querySelector('[role="alert"]')`);
      if(width===375)assert.ok(await b.run(`return document.querySelector('.side').getBoundingClientRect().height<=220;`),'Failed content must not stretch the mobile menu either');
      assert.equal(await b.run(`return f.snapshot().overflow;`),false);await writeFile(path.join(output,`failure-${width}.png`),await b.browser.screenshot());
    }finally{await b.close();}
  });
  t.diagnostic('Owned Control loading screenshots: '+output);
});
