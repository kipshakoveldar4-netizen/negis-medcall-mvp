import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { ownedRecoveryBrowser, root } from "./appointment-recovery-committed-fixture.js";

// Actual React/arrival component/operatorApi/crmFetch/serverAuth. Only SDK and
// responses are local doubles. This does not prove real Auth, SQL or pixels.
const frontend = path.join(root, "artifacts/negis");
const req = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(req.resolve("vite/package.json"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>;
  stop(): void;
};
const A = "00000000-0000-4000-8000-000000004101", B = "00000000-0000-4000-8000-000000004102";
const R = "00000000-0000-4000-8000-000000004103";
const W = "00000000-0000-4000-8000-000000004105";
const component = JSON.stringify(path.join(frontend, "src/components/operators/OperatorArrivals.tsx").replaceAll("\\", "/"));
const mocks = `
import{flushSync}from'react-dom';
let actor='${A}';const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
export const hasSupabaseFrontendEnv=true,isSignOutPending=()=>false,getSignOutRevision=()=>0;
export const f={calls:[],reads:0,auth:[],holdAuth:false,denials:0,clinic:false,view:{isCurrentMutationScope:()=>true},
 session(){const g=gate(),saved=actor;this.auth.push(g);if(!this.holdAuth)g.resolve();return g.promise.then(()=>({data:{session:{user:{id:saved},access_token:'owned-'+saved}},error:null}));},
 rows(){return[0,1].map(n=>({appointmentId:'appointment-'+n,arrivalId:this.clinic?null:'arrival-'+n,status:'arrived',clientName:'Owned patient '+n,clientPhone:'OWNED-'+n,startsAt:'2026-10-26T09:00:00Z',priceMinor:'0',currency:'KZT'}));},
 article(n){return[...document.querySelectorAll('article')][n];},
 buttons(n){return[...this.article(n).querySelectorAll('button')];},
 click(n,choice=0){flushSync(()=>this.buttons(n)[choice].click());},
 refresh(){flushSync(()=>document.querySelector('[aria-label="Обновить приходы"]').click());},
 next(){flushSync(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Далее').click());},
 async tick(){await new Promise(r=>setTimeout(r,20));},
 reply(n,outcome){const c=this.calls[n];if(outcome==='network')c.reject(Error('Synthetic connection lost'));else c.resolve(Response.json(outcome===200?{success:true}:{success:false,error:'Synthetic failure '+outcome},{status:outcome}));},
 snapshot(){return{calls:this.calls.map(c=>({method:c.method,body:c.body})),reads:this.reads,denials:this.denials,
  rows:[...document.querySelectorAll('article')].map(a=>({name:a.querySelector('p')?.textContent,disabled:[...a.querySelectorAll('button')].map(b=>b.disabled)})),
  alerts:[...document.querySelectorAll('[role="alert"]')].map(n=>n.textContent)};},
 actor(value){actor=value;this.replace({actorId:value});},raw(value){actor=value;},};
export const supabase={auth:{getSession:()=>f.session()}};
window.fetch=async(url,init={})=>{if(!String(url).startsWith('/api/crm/'))throw Error('External request forbidden');
 if((init.method||'GET')==='GET'){f.reads++;return Response.json({success:true,data:{items:f.rows(),hasMore:true}});}
 let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});f.calls.push({method:init.method,body:JSON.parse(init.body),resolve,reject});return promise;};
`;
const entry = `
import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{OperatorArrivals}from ${component};import{f}from'owned-arrival-command';
function Host(){const[props,setProps]=React.useState({actorId:'${A}',requestId:'${R}',workspaceId:undefined});
 const live=React.useRef({active:true});f.replace=value=>{live.current.active=false;live.current={active:true};flushSync(()=>setProps(old=>({...old,...value})));};
 const scope=live.current;return<OperatorArrivals {...props} isSessionCurrent={()=>scope.active} onAccessDenied={()=>f.denials++}/>;}
const app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<Host/>));
f.mode=clinic=>{f.clinic=clinic;f.replace({workspaceId:clinic?'${W}':undefined});};
f.unmount=()=>flushSync(()=>app.unmount());window.__appointmentRecovery=f;
`;

test("arrival commands keep row ownership in actual React/Chromium and transport", { timeout: 180_000 }, async t => {
  t.after(() => esbuild.stop());
  const built = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, loader: "tsx" },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.BASE_URL": '"/"', "import.meta.env.VITE_API_BASE_URL": '""' },
    plugins: [{ name: "owned-arrival-command", setup(build: any) {
      build.onResolve({ filter: /^(owned-arrival-command|@\/lib\/supabase|@\/lib\/authSignOut)$/ }, () => ({ path: "mocks", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: mocks, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => {
        const base = path.join(frontend, "src", args.path.slice(2)), file = [base + ".ts", base + ".tsx"].find(existsSync);
        assert.ok(file); return { path: file };
      });
    } }],
  });
  const server = createServer((request, response) => {
    if (request.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) { response.writeHead(403).end(); return; }
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/bundle.js") { response.setHeader("Content-Type", "application/javascript"); response.end(built.outputFiles[0].text); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'");
    response.end('<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/bundle.js"></script></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const browser = await ownedRecoveryBrowser(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  t.after(browser.close);
  const run = browser.evaluate, wait = browser.waitFor;
  const snapshot = () => run<any>("await f.tick();return f.snapshot();");
  async function reset(clinic: boolean) {
    await browser.load(); await run(`f.mode(${clinic});`); await wait("document.querySelectorAll('article').length===2");
  }
  for (const width of [375, 1440]) {
    await browser.viewport(width, 900);
    for (const clinic of [false, true]) {
      const kind = clinic ? "confirm" : "call";
      for (const page of [false, true]) for (const outcome of [200, 503, "network"] as const) {
        await t.test(`${width} ${kind}: ${page ? "page" : "refresh"} cannot duplicate a pending row before ${outcome}`, async () => {
          await reset(clinic); await run("f.click(0);"); await wait("f.calls.length===1");
          await run(page ? "f.next();" : "f.refresh();"); await wait("document.querySelectorAll('article').length===2");
          const before = await snapshot(); assert.ok(before.rows[0].disabled.every(Boolean));
          await run("f.click(0);f.click(0);"); assert.equal((await snapshot()).calls.length, 1);
          await run(`f.reply(0,${JSON.stringify(outcome)});`); await wait("!f.buttons(0)[0].disabled");
          const after = await snapshot(); assert.equal(after.reads, before.reads); assert.deepEqual(after.alerts, []);
          assert.equal(after.denials, 0); assert.equal(after.calls.length, 1);
        });
      }
      await t.test(`${width} ${kind}: independent rows cannot release each other's pending command`, async () => {
        await reset(clinic); await run("f.click(0);"); await wait("f.calls.length===1");
        await run("f.click(1);"); await wait("f.calls.length===2");
        assert.ok((await snapshot()).rows.every((row: any) => row.disabled.every(Boolean)));
        await run("f.refresh();"); await wait("document.querySelectorAll('article').length===2");
        await run("f.reply(1,200);"); await wait("!f.buttons(1)[0].disabled");
        assert.ok((await snapshot()).rows[0].disabled.every(Boolean));
        await run("f.reply(0,'network');"); await wait("!f.buttons(0)[0].disabled");
        assert.equal((await snapshot()).calls.length, 2);
      });
      await t.test(`${width} ${kind}: refresh cancels a queued lookup and releases its row without dispatch`, async () => {
        await reset(clinic); await run("f.holdAuth=true;f.click(0);");
        await wait("f.auth.length>0 && f.buttons(0)[0].disabled");
        await run("f.refresh();f.holdAuth=false;for(const g of f.auth)g.resolve();");
        await wait("document.querySelectorAll('article').length===2 && !f.buttons(0)[0].disabled");
        assert.equal((await snapshot()).calls.length, 0);
      });
      for (const aba of [false, true]) await t.test(`${width} ${kind}: late old-account reply cannot release ${aba ? "returned" : "replacement"} actor's row`, async () => {
        await reset(clinic); await run("f.click(0);"); await wait("f.calls.length===1");
        await run(`f.actor('${B}');`); if (aba) await run(`f.actor('${A}');`);
        await run("f.refresh();"); await wait("document.querySelectorAll('article').length===2");
        await run("f.click(0);"); await wait("f.calls.length===2");
        const before = await snapshot(); await run("f.reply(0,403);");
        assert.deepEqual(await snapshot(), before);
        await run("f.reply(1,503);"); await wait("!f.buttons(0)[0].disabled");
        assert.equal((await snapshot()).denials, 0);
      });
    }
  }
  assert.deepEqual(browser.exceptions, []);
  assert.ok(browser.requests.every(url => new URL(url).hostname === "127.0.0.1"));
});
