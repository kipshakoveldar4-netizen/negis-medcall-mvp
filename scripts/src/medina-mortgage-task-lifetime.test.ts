import assert from "node:assert/strict";
import test from "node:test";
// No app bootstrap, env, real session, backend, native PG or dependencies installed.
// --baseline executes the exact original two UI sources from 37e1d3e.
// @ts-expect-error Owned JS fixture intentionally has no separate declaration file.
import { startMortgageTaskBrowser } from "../fixtures/mortgage-task-lifetime-browser.mjs";

test("G2 mortgage task lifetime: actual React/Chromium and original workspace hook", { timeout: 180_000 }, async t => {
  const b = await startMortgageTaskBrowser(t, process.argv.includes("--baseline"));
  const mutations = (state: any) => state.calls.filter((call: any) => call.method !== "GET");
  const ready = async () => { await b.wait("document.querySelector('button[aria-label^=\"Выполнить:\"]')"); };
  const reset = async () => { await b.reset(); await ready(); };
  const open = async (action: string) => {
    await b.evaluate(`f.open(${action === "edit"});`);
    if (action === "create") {
      await b.wait("[...document.querySelectorAll('button')].some(n=>n.textContent.includes('Contact synthetic-A')&&n.textContent.includes('000-'))");
      await b.evaluate("f.select();");
    }
    await b.wait("document.querySelector('button[type=submit]')&&!document.querySelector('button[type=submit]').disabled");
    await b.evaluate("f.fill('title','Original draft');f.fill('notes','Original notes');");
    await b.settle();
  };
  const begin = async (action: string) => {
    if (action !== "status") await open(action);
    await b.evaluate(action === "status" ? "f.capture('status');f.invoke('status');f.invoke('status');" : "f.capture('submit');f.invoke('submit');f.invoke('submit');");
    await b.settle();
    const state = await b.state();
    assert.equal(mutations(state).length, 1, "synchronous duplicate handler must issue exactly one mutation");
    return state.calls.findIndex((call: any) => call.method !== "GET");
  };

  for (const width of [390, 1440]) {
    await b.viewport(width);
    for (const action of ["create", "edit", "status"]) {
      await t.test(`${width}px current ${action}, rapid double click and same-actor refresh`, async () => {
        await reset(); const index = await begin(action); let state = await b.state();
        const call = mutations(state)[0];
        assert.equal(call.actor, "synthetic-A"); assert.match(call.url, /workspaceId=synthetic-workspace-A/);
        assert.equal(call.method, action === "create" ? "POST" : "PATCH");
        assert.equal(call.body.kind, "task"); assert.equal(call.body.leadId, "synthetic-client");
        assert.equal(call.body.status, action === "status" ? "done" : "open");
        if (action === "create") assert.match(call.body.requestId, /^[0-9a-f-]{36}$/);
        else { assert.equal(call.body.id, "synthetic-task"); assert.equal(call.body.expectedUpdatedAt, "2026-10-25T10:00:00.123456Z"); }
        await b.evaluate(`f.refresh();f.answer(${index});`); await b.settle(); state = await b.state();
        assert.equal(state.dialog, false); assert.equal(state.statusDisabled, false);
        assert.equal(mutations(state).length, 1);
        assert.ok(state.calls.slice(index + 1).some((call: any) => call.method === "GET"), "confirmed save refreshes the current list");
      });
    }
  }

  for (const action of ["create", "edit", "status"]) {
    for (const transition of ["actor", "workspace", "role", "silent-SDK"]) {
      for (const outcome of ["success", "error", "denial"]) {
        await t.test(`${action} pending ${outcome} cannot affect fresh editor after ${transition} A/B/A`, async () => {
          await reset(); const index = await begin(action);
          if (action !== "status") await b.evaluate("f.capture('field');");
          if (outcome !== "denial") await b.evaluate(`f.answer(${index},{holdBody:true,body:${outcome === "error" ? "{success:false,mode:'supabase',error:'Old actor error'}" : "{success:true,mode:'supabase'}"},status:${outcome === "error" ? 400 : 200}});`);
          await b.settle();
          const transitions: Record<string, string> = {
            actor: "f.patch({user:{id:'synthetic-B'}});",
            workspace: "f.patch({clinicId:'synthetic-workspace-B'});",
            role: "f.patch({userRole:'admin'});",
            "silent-SDK": "f.aba();",
          };
          await b.evaluate(transitions[transition]); await ready();
          let changed = await b.state();
          assert.equal(changed.dialog, false); assert.doesNotMatch(changed.text, /Old actor error|Original draft|Original notes/);
          if (transition === "actor") assert.doesNotMatch(changed.text, /Task synthetic-A|Contact synthetic-A/);
          const returns: Record<string, string> = { actor: "f.patch({user:{id:'synthetic-A'}});", workspace: "f.patch({clinicId:'synthetic-workspace-A'});", role: "f.patch({userRole:'owner'});", "silent-SDK": "" };
          await b.evaluate(returns[transition]); await ready();
          await open("create"); await b.evaluate("f.fill('title','New actor draft');f.fill('notes','New actor notes');"); await b.settle();
          const before = await b.state();
          await b.evaluate(outcome === "denial" ? `f.answer(${index},{status:403,holdBody:true});` : "f.release();");
          await b.settle(); changed = await b.state();
          assert.equal(changed.dialog, true); assert.equal(changed.title, "New actor draft"); assert.equal(changed.notes, "New actor notes");
          assert.equal(changed.saving, false); assert.equal(changed.statusDisabled, false);
          assert.doesNotMatch(changed.text, /Old actor error/); assert.equal(changed.calls.length, before.calls.length, "no stale refresh");
          assert.equal(changed.calls[index].aborted, true);
          await b.evaluate(`f.invoke('${action === "status" ? "status" : "submit"}');f.release();`); await b.settle();
          if (action !== "status") { await b.evaluate("f.invoke('field');"); await b.settle(); assert.equal((await b.state()).title, "New actor draft"); }
          assert.equal((await b.state()).calls.length, before.calls.length, "old captured mutation permanently retired");
        });
      }
    }
  }

  for (const action of ["create", "edit", "status"]) {
    for (const status of [401, 403, 404]) {
      await t.test(`${action} ${status} headers retire actions before denial body`, async () => {
        await reset(); const index = await begin(action);
        await b.evaluate(`f.answer(${index},{status:${status},holdBody:true});`); await b.settle();
        let state = await b.state(); assert.equal(state.dialog, false);
        assert.doesNotMatch(state.text, /Contact synthetic-A|Task synthetic-A|Original draft/);
        assert.deepEqual(state.heldUsed, [false], "denied body must not be decoded");
        assert.match(state.text, status === 401 ? /Сеанс завершён/ : status === 403 ? /отозван/ : /недоступны/);
        const before = state.calls.length;
        await b.evaluate(`f.invoke('${action === "status" ? "status" : "submit"}');f.release();`); await b.settle();
        state = await b.state(); assert.equal(state.calls.length, before); assert.equal(state.dialog, false);
      });
    }
    for (const outcome of ["success", "error"]) {
      await t.test(`${action} unmount fences late ${outcome} body and captured handler`, async () => {
        await reset(); const index = await begin(action);
        await b.evaluate(`f.answer(${index},{holdBody:true,body:${outcome === "error" ? "{success:false,mode:'supabase',error:'Unmounted error'}" : "{success:true,mode:'supabase'}"},status:${outcome === "error" ? 400 : 200}});`); await b.settle();
        await b.evaluate("f.unmount();"); const before = (await b.state()).calls.length;
        await b.evaluate(`f.release();f.invoke('${action === "status" ? "status" : "submit"}');`); await b.settle();
        const state = await b.state(); assert.equal(state.calls.length, before); assert.equal(state.dialog, false); assert.doesNotMatch(state.text, /Unmounted error/);
        await b.evaluate("f.mount();"); await ready();
      });
    }
  }

  for (const transition of ["actor", "workspace", "role", "silent-SDK"]) {
    await t.test(`settled field/error/contact state and late contact body retire across ${transition} A/B/A`, async () => {
      await reset(); await open("edit");
      await b.evaluate("f.fill('title','');f.submit();"); await b.settle();
      assert.match((await b.state()).text, /Укажите название/);
      await b.evaluate("f.holdReads=true;f.button('Сменить клиента').click();");
      await b.wait("document.querySelector('input[id$=\"-client\"]')");
      await b.evaluate("f.fill('client','Old search');");
      await b.wait("f.calls.some(c=>c.method==='GET'&&!c.answered)");
      const oldRead = (await b.state()).calls.findIndex((c: any) => c.url.includes("q=Old+search")); assert.ok(oldRead >= 0);
      await b.evaluate(`f.answer(${oldRead},{holdBody:true,body:{success:false,mode:'supabase',error:'Old contact search error'},status:400});f.holdReads=false;`);
      await b.settle();
      const changes: Record<string, string> = {
        actor: "f.patch({user:{id:'synthetic-B'}});", workspace: "f.patch({clinicId:'synthetic-workspace-B'});", role: "f.patch({userRole:'admin'});", "silent-SDK": "f.aba();",
      };
      await b.evaluate(changes[transition]); await ready();
      const back: Record<string, string> = { actor: "f.patch({user:{id:'synthetic-A'}});", workspace: "f.patch({clinicId:'synthetic-workspace-A'});", role: "f.patch({userRole:'owner'});", "silent-SDK": "" };
      await b.evaluate(back[transition]); await ready(); await b.evaluate("f.open();");
      await b.wait("document.querySelector('input[id$=\"-client\"]')");
      await b.evaluate("f.release();"); await b.settle();
      const state = await b.state(); assert.equal(state.title, ""); assert.equal(state.notes, "");
      assert.doesNotMatch(state.text, /Укажите название|Old contact search error|Original notes/);
      assert.equal(await b.evaluate("return document.querySelector('input[id$=\"-client\"]').value;"), "");
    });
  }

  for (const action of ["create", "edit", "status"]) {
    await t.test(`${action} unknown outcome retains draft/status, never reports success or cancellation`, async () => {
      await reset(); const index = await begin(action); const original = mutations(await b.state())[0].body;
      await b.evaluate(`f.answer(${index},{lost:true});`); await b.settle();
      let state = await b.state(); assert.match(state.alerts, /Synthetic lost response/); assert.doesNotMatch(state.alerts, /успешно|отменено/i);
      assert.equal(state.statusDisabled, false); assert.equal(state.calls.length, index + 1, "no unconfirmed refresh");
      if (action !== "status") { assert.equal(state.dialog, true); assert.equal(state.title, "Original draft"); assert.equal(state.saving, false); }
      await b.evaluate(action === "status" ? "f.status();" : "f.submit();"); await b.settle(); state = await b.state();
      assert.equal(mutations(state).length, 2); assert.deepEqual(mutations(state)[1].body, original, "current retry retains request ID/version, never invents success");
    });
  }

  for (const action of ["create", "edit"]) {
    await t.test(`cancelled ${action} form's captured submit cannot dispatch after form unmount in a still-current workspace`, async () => {
      await reset(); await open(action); await b.evaluate("f.capture('submit');f.button('Отмена').click();"); await b.settle();
      assert.equal((await b.state()).dialog, false);
      const before = (await b.state()).calls.length;
      await b.evaluate("f.invoke('submit');"); await b.settle();
      assert.equal((await b.state()).calls.length, before, "retired form must not dispatch a mutation");
      await open(action); await b.evaluate("f.submit();"); await b.settle();
      assert.equal(mutations(await b.state()).length, 1, "fresh form remains usable after cancellation");
    });
  }
  b.assertIsolated();
});
