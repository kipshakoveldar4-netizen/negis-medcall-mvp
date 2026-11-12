import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPartnerTermsFixture } from './partner-terms-browser.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(url,events){const ws=new WebSocket(url),pending=new Map();let sequence=0;
  ws.addEventListener('message',event=>{const v=JSON.parse(String(event.data));if(!v.id){events(v.method,v.params);return;}const item=pending.get(v.id);if(!item)return;
    pending.delete(v.id);clearTimeout(item.timer);v.error?item.reject(Error(JSON.stringify(v.error))):item.resolve(v.result);});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned CDP connect timeout')),10000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Owned CDP error'));},{once:true});});
  return{call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});},close(){for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Closed'));}pending.clear();ws.close();}};
}
test('partner terms actual Control/Portal React UI, synthetic Auth/API only, owned desktop/mobile browser',{timeout:240000},async t=>{
  const executable=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(existsSync);assert.ok(executable,'Installed browser required, no download');
  const server=await createPartnerTermsFixture(),profile=await mkdtemp(path.join(tmpdir(),'medina-partner-terms-owned-'));
  const outBase=path.join(root,'node_modules/.cache/partner-terms-browser');await mkdir(outBase,{recursive:true});const output=await mkdtemp(path.join(outBase,'run-'));
  const browser=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--disable-sync','--disable-component-update',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore',env:Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','HOME','DISPLAY'].includes(key)))});
  const exited=new Promise(r=>{browser.once('exit',r);browser.once('error',r);});let cdp;
  t.after(async()=>{if(cdp)await cdp.call('Browser.close').catch(()=>{});await Promise.race([exited,delay(5000)]);if(browser.exitCode===null&&browser.signalCode===null){browser.kill();await Promise.race([exited,delay(5000)]);}
    cdp?.close();await server.close();assert.ok(browser.exitCode!==null||browser.signalCode!==null);assert.equal(path.dirname(profile),path.resolve(tmpdir()));assert.ok(path.basename(profile).startsWith('medina-partner-terms-owned-'));await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
  let port;for(let n=0;n<250;n++){try{port=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];}catch{}if(/^\d+$/.test(port??''))break;await delay(80);}assert.match(port??'',/^\d+$/);
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(10000)})).json(),exceptions=[],requests=[];
  cdp=await connect(targets.find(v=>v.type==='page').webSocketDebuggerUrl,(name,p)=>{if(name==='Runtime.exceptionThrown')exceptions.push(p.exceptionDetails);if(name==='Network.requestWillBeSent')requests.push(p.request.url);});
  for(const name of ['Page','Runtime','Network'])await cdp.call(name+'.enable');
  const evaluate=async body=>{const r=await cdp.call('Runtime.evaluate',{expression:`(async()=>{${body}})()`,awaitPromise:true,returnByValue:true});assert.equal(r.exceptionDetails,undefined,JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async body=>{for(let n=0;n<250;n++){if(await evaluate(body))return;await delay(40);}assert.fail('Wait failed: '+body+'\n'+await evaluate('return document.body.innerText;')+'\n'+await evaluate('return JSON.stringify(window.__partnerTermsQA.calls.slice(-6));')+'\n'+JSON.stringify(exceptions));};
  const click=async(text,selector='button')=>{const p=await evaluate(`const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing enabled '+${JSON.stringify(text)});e.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`);
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});};
  const fill=async(label,value)=>evaluate(`const l=[...document.querySelectorAll('label')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})),e=l?.querySelector('input,textarea');if(!e||e.disabled)throw Error('Missing field');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));`);
  const view=async mode=>{await evaluate(`window.__partnerTermsQA.view(${JSON.stringify(mode)});`);await wait(`return document.querySelector('h1')?.textContent===${JSON.stringify(mode==='owner'?'Блогеры':'Кабинет блогера')};`);};
  const open=async index=>{await wait(`return document.querySelectorAll('.operator-row').length===2;`);const p=await evaluate(`const e=[...document.querySelectorAll('.operator-row')[${index}].querySelectorAll('button')].find(e=>e.textContent.trim()==='Условия партнёрства');e.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`);
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await wait(`return !!document.querySelector('[aria-label="Условия выбранного партнёра"] .partner-terms');`);};
  const formReady=()=>wait(`return !!document.querySelector('form[aria-label="Предложение партнёрских условий"]');`);
  const writes=()=>evaluate(`return window.__partnerTermsQA.calls.filter(c=>c.method==='POST').length;`);
  const metadata=()=>evaluate(`return [...Array(sessionStorage.length)].map((_,i)=>sessionStorage.key(i)).filter(k=>k.startsWith('medina_partner_terms_v1:')).map(k=>sessionStorage.getItem(k));`);
  const offer=async text=>{await formReady();await fill('Первая оплата','23,50');await fill('Продления','6.50');await fill('Текст предложения',text);};
  const checkbox=()=>click('Принимаю указанные проценты и текст условий этого предложения.','label');
  const screenshot=async name=>{const r=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,name),Buffer.from(r.data,'base64'));};
  const fit=async(name)=>{for(const width of [375,1440]){await cdp.call('Emulation.setDeviceMetricsOverride',{width,height:1050,deviceScaleFactor:1,mobile:width===375});await evaluate('await document.fonts.ready;');
      assert.equal(await evaluate('return document.documentElement.scrollWidth<=innerWidth;'),true);assert.equal(await evaluate(`return [...document.querySelectorAll('.partner-terms input,.partner-terms textarea,.partner-terms button')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;});`),true);await screenshot(name+'-'+width+'.png');}};
  const resetB=()=>evaluate(`const q=window.__partnerTermsQA;q.heads.delete(q.ids.profileB);for(const[k,v]of q.receipts)if(v.profileId===q.ids.profileB){q.receipts.delete(k);q.intents.delete(k);}q.profiles.get(q.ids.b).revision=crypto.randomUUID();q.profiles.get(q.ids.b).partnerStatus='approved';q.remount();`);
  await cdp.call('Page.navigate',{url:server.origin+'/review'});await cdp.call('Page.bringToFront');await wait(`return !!window.__partnerTermsQA?.view&&document.querySelectorAll('.operator-row').length===2;`);
  await t.test('owner enters explicit decimal rates, no default, real Control styles fit 375/1440',async()=>{
    await open(0);await formReady();assert.deepEqual(await evaluate(`return [...document.querySelectorAll('.pt-form input')].map(e=>e.value);`),['','']);await offer('PRIVATE A TERMS '+ 'А'.repeat(140));await fit('owner-offer');
    await click('Предложить условия');await wait(`return document.querySelector('.partner-terms')?.innerText.includes('Ожидает решения');`);
    assert.equal(await evaluate(`return window.__partnerTermsQA.heads.get(window.__partnerTermsQA.ids.profileA).agreement.firstCommissionBps;`),2350);assert.deepEqual(await metadata(),[]);
  });
  await t.test('partner explicitly accepts exact version, stale checkbox callback cannot submit',async()=>{
    await view('a');await wait(`return document.querySelector('.partner-terms')?.innerText.includes('PRIVATE A TERMS');`);await fit('partner-offer');
    assert.equal(await evaluate(`return [...document.querySelectorAll('button')].find(e=>e.textContent.includes('Принять условия')).disabled;`),true);
    await checkbox();await evaluate(`const e=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Принять условия'));window.__partnerTermsQA.oldAccept=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onClick;`);
    await checkbox();const before=await writes();await evaluate('window.__partnerTermsQA.oldAccept();');assert.equal(await writes(),before);
    await checkbox();await click('Принять условия');await wait(`return !!document.querySelector('.pt-code code');`);assert.match(await evaluate(`return document.querySelector('.pt-code code').textContent;`),/^[A-F0-9]{32}$/);
    await wait(`return document.querySelector('[aria-label="Партнёрская статистика"]')?.innerText.includes('Подтверждённых начислений и выплат пока нет.');`);await fit('partner-active');
  });
  await t.test('lost offer ACK retains metadata only; exact retry does not create another proposal',async()=>{
    await view('owner');await open(1);await offer('PRIVATE B LOST');await evaluate('window.__partnerTermsQA.loseNext();');await click('Предложить условия');
    await wait(`return document.body.innerText.includes('Тестовый потерянный ответ');`);assert.equal((await metadata()).length,1);assert.equal((await metadata()).some(v=>/PRIVATE|Commission|payload|password/.test(v)),false);
    await click('Повторить исходную отправку');await wait(`return !document.querySelector('[aria-label="Результат отправки условий"]');`);
    const sent=await evaluate(`return window.__partnerTermsQA.calls.filter(c=>c.method==='POST'&&c.body?.payload?.terms==='PRIVATE B LOST').map(c=>c.body);`);assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);
  });
  await t.test('real reload loses body, restores descriptor, and explicit close fences an unknown acceptance',async()=>{
    await view('b');await wait(`return document.querySelector('.partner-terms')?.innerText.includes('PRIVATE B LOST');`);await checkbox();await evaluate('window.__partnerTermsQA.failBeforeNext();');await click('Принять условия');
    await wait(`return !!document.querySelector('[aria-label="Результат отправки условий"]');`);const seed=await evaluate('return window.__partnerTermsQA.dump();');
    const script=await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:'window.__partnerTermsBackendSeed='+JSON.stringify(seed)+';'});await cdp.call('Page.reload');
    await wait(`return !!document.querySelector('[aria-label="Результат отправки условий"]');`);await cdp.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:script.identifier});
    assert.equal(await evaluate(`return document.body.innerText.includes('Повторить исходную отправку');`),false);await click('Проверить результат');await wait(`return document.body.innerText.includes('Результат пока не подтверждён.');`);
    await click('Закрыть неподтверждённую отправку. Уже сохранённое действие не отменяется.','label');await click('Закрыть отправку');await wait(`return !document.querySelector('[aria-label="Результат отправки условий"]');`);
    assert.equal(await evaluate(`return window.__partnerTermsQA.heads.get(window.__partnerTermsQA.ids.profileB).agreement.referralCode;`),null);
  });
  await t.test('committed acceptance survives remount and resolves without a second activation',async()=>{
    await wait(`return !![...document.querySelectorAll('button')].find(e=>e.textContent.includes('Принять условия'));`);await checkbox();await evaluate('window.__partnerTermsQA.loseNext();');await click('Принять условия');await wait(`return document.body.innerText.includes('Тестовый потерянный ответ');`);
    const code=await evaluate(`return window.__partnerTermsQA.heads.get(window.__partnerTermsQA.ids.profileB).agreement.referralCode;`);await evaluate('window.__partnerTermsQA.remount();');await wait(`return !!document.querySelector('[aria-label="Результат отправки условий"]');`);
    assert.equal(await evaluate(`return document.body.innerText.includes('Повторить исходную отправку');`),false);await click('Проверить результат');await wait(`return !document.querySelector('[aria-label="Результат отправки условий"]');`);
    assert.equal(await evaluate(`return window.__partnerTermsQA.heads.get(window.__partnerTermsQA.ids.profileB).agreement.referralCode;`),code);
  });
  await t.test('closing and reopening the same owner profile retires retained submit/close callbacks',async()=>{
    await view('owner');await resetB();await open(1);await offer('PRIVATE RETIRED FORM');await evaluate(`const f=document.querySelector('.pt-form'),b=document.querySelector('[aria-label="Закрыть условия партнёра"]');window.__partnerTermsQA.oldSubmit=f[Object.keys(f).find(k=>k.startsWith('__reactProps$'))].onSubmit;window.__partnerTermsQA.oldClose=b[Object.keys(b).find(k=>k.startsWith('__reactProps$'))].onClick;b.click();`);
    await wait(`return !document.querySelector('.pt-form');`);await open(1);await formReady();const before=await writes();await evaluate(`window.__partnerTermsQA.oldSubmit({preventDefault(){}});window.__partnerTermsQA.oldClose();`);assert.equal(await writes(),before);assert.equal(await evaluate(`return !!document.querySelector('.pt-form');`),true);
  });
  await t.test('queued owner submit is retired by a synchronous owner-partner-owner switch before dispatch',async()=>{
    await offer('PRIVATE QUEUED ABA');await evaluate(`const e=document.querySelector('.pt-form');window.__partnerTermsQA.queued=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onSubmit;`);
    const before=await writes();await evaluate(`const q=window.__partnerTermsQA;q.view('a');q.view('owner');q.queued({preventDefault(){}});`);
    await wait(`return document.querySelector('h1')?.textContent==='Блогеры';`);assert.equal(await writes(),before);assert.deepEqual(await metadata(),[]);await open(1);await formReady();
  });
  await t.test('withdraw/decline confirmations are exact-version actions and cancelled handlers stay retired',async()=>{
    await offer('PRIVATE CANCEL');await click('Предложить условия');await wait(`return document.querySelector('.partner-terms')?.innerText.includes('Ожидает решения');`);
    await click('Отозвать предложение');await wait(`return !!document.querySelector('[aria-label="Подтверждение решения по условиям"]');`);
    await evaluate(`const e=document.querySelector('[aria-label="Подтверждение решения по условиям"] button');window.__partnerTermsQA.oldConfirm=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onClick;`);
    await click('Отмена');const before=await writes();await evaluate('window.__partnerTermsQA.oldConfirm();');assert.equal(await writes(),before);
    await click('Отозвать предложение');await click('Подтвердить');await formReady();await offer('PRIVATE DECLINE');await click('Предложить условия');
    await wait(`return document.querySelector('.partner-terms')?.innerText.includes('Ожидает решения');`);await view('b');await wait(`return document.querySelector('.partner-terms')?.innerText.includes('PRIVATE DECLINE');`);
    await click('Отклонить');await click('Подтвердить');await wait(`return document.querySelector('.partner-terms')?.innerText.includes('Предложение отклонено');`);await view('owner');await open(1);await formReady();
  });
  await t.test('held owner result and queued callback cannot publish or dispatch after A-B-A',async()=>{
    await offer('PRIVATE HELD OWNER');await evaluate(`window.__partnerTermsQA.holdNext('platform-partner-terms');`);await click('Предложить условия');await wait(`return window.__partnerTermsQA.heads.has(window.__partnerTermsQA.ids.profileB);`);
    await view('a');assert.equal(await evaluate(`return document.body.innerText.includes('PRIVATE HELD OWNER');`),false);await view('owner');await open(1);await wait(`return !!document.querySelector('[aria-label="Результат отправки условий"]');`);
    const before=await evaluate('return document.body.innerText;');await evaluate('window.__partnerTermsQA.release();');await delay(100);assert.equal(await evaluate('return document.body.innerText;'),before);
    await click('Проверить результат');await wait(`return !document.querySelector('[aria-label="Результат отправки условий"]');`);
  });
  await t.test('revoked partner focus hides terms before a stale private response returns',async()=>{
    await view('b');await wait(`return document.querySelector('.partner-terms')?.innerText.includes('PRIVATE HELD OWNER');`);await checkbox();await evaluate(`const e=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Принять условия'));window.__partnerTermsQA.oldAccept=e[Object.keys(e).find(k=>k.startsWith('__reactProps$'))].onClick;window.__partnerTermsQA.holdNext('partner-terms','GET');window.dispatchEvent(new Event('focus'));`);
    await wait(`return !document.body.innerText.includes('PRIVATE HELD OWNER');`);await evaluate(`const q=window.__partnerTermsQA;q.profiles.get(q.ids.b).partnerStatus='suspended';q.profiles.get(q.ids.b).revision=crypto.randomUUID();window.dispatchEvent(new Event('focus'));q.release();`);
    await wait(`return document.body.innerText.includes('Приостановлено');`);assert.equal(await evaluate(`return document.body.innerText.includes('PRIVATE HELD OWNER')||!!document.querySelector('.pt-code');`),false);
    const before=await writes();await evaluate('window.__partnerTermsQA.oldAccept();');assert.equal(await writes(),before);
  });
  await t.test('damaged or lying command storage blocks a new owner write before API dispatch',async()=>{
    await view('owner');await resetB();await evaluate(`const q=window.__partnerTermsQA;sessionStorage.setItem('medina_partner_terms_v1:'+q.ids.owner+':platform:'+q.ids.profileB,'{bad');`);
    await open(1);await wait(`return document.body.innerText.includes('Ключ исходной отправки недоступен.');`);assert.equal(await evaluate(`return !!document.querySelector('.pt-form');`),false);
    await evaluate(`const q=window.__partnerTermsQA;sessionStorage.removeItem('medina_partner_terms_v1:'+q.ids.owner+':platform:'+q.ids.profileB);q.remount();`);await open(1);await offer('PRIVATE NOT SENT');
    await evaluate(`const q=window.__partnerTermsQA;q.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('medina_partner_terms_v1:'))return;return q.originalSet.call(this,k,v);};`);
    const before=await writes();await click('Предложить условия');await wait(`return document.body.innerText.includes('Запрос не отправлен.');`);assert.equal(await writes(),before);
    await evaluate(`Storage.prototype.setItem=window.__partnerTermsQA.originalSet;`);
  });
  assert.deepEqual(exceptions,[]);assert.equal(requests.every(url=>url.startsWith(server.origin)||url.startsWith(server.origin.replace('http:','ws:'))||/^(data:|about:)/.test(url)),true);
  t.diagnostic('Owned screenshot output: '+output);
});
