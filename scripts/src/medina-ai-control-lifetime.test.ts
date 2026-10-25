import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Owned browser fixture has no separate declaration file.
import { startControlFixture } from "./medina-ai-control-lifetime.fixture.mjs";

// Green: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-ai-control-lifetime.test.ts
// Red:   node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-ai-control-lifetime.test.ts --baseline
// Review-only demo/404 regression: append --review-only (ten red probes before the review fix).
test("AiControlCenter actual React, current ProtectedPage, synthetic Auth and actual HTTP helper", { timeout: 180_000 }, async t => {
  const b = await startControlFixture(t, process.argv.includes("--baseline"));
  const mutations = (s: any) => s.calls.filter((c: any) => c.method !== "GET");
  const ready = async () => { await b.settle(); const s = await b.state(); assert.ok(s.tasks > 0, s.text); return s; };
  const reset = async (hold = false, gated = true) => { await b.reset(hold, gated); if (!hold) await ready(); };
  const changes: Record<string, string> = {
    actor: "f.patch({user:{id:'synthetic-B'}});",
    workspace: "f.patch({clinicId:'synthetic-workspace-B'});",
    role: "f.patch({userRole:'admin'});",
    roleLoss: "f.patch({userRole:'lead_manager',rolePermissions:{dashboard:false}});",
    permissionLoss: "f.patch({userRole:'admin',rolePermissions:{dashboard:false}});",
    purposeLoss: "f.patch({workspacePurpose:'mortgage_leads'});",
    workspaceLoss: "f.patch({clinicId:null});",
    loading: "f.patch({isLoading:true});",
    signingOut: "f.patch({isSigningOut:true});",
    sdkABA: "f.aba();",
  };

  if (process.argv.includes("--baseline")) {
    await t.test("RED original aggregate must not publish its pending A snapshot after A/B/A", async () => {
      await reset(true); const old = (await b.state()).calls.length;
      await b.evaluate(changes.workspace); await b.settle(); await b.evaluate("f.restore();"); await b.settle();
      await b.evaluate(`for(let i=0;i<${old};i++)f.answer(i);`); await b.settle();
      assert.doesNotMatch((await b.state()).text, /Record synthetic-A synthetic-workspace-A/);
    });
    await t.test("RED original settled task callback must stop before token lookup after A/B/A", async () => {
      await reset(); await b.evaluate("f.capture();"); await b.evaluate(changes.workspace); await b.settle(); await b.evaluate("f.restore();"); await b.settle();
      const before = await b.state(); await b.evaluate("f.invoke();"); await b.settle();
      assert.equal((await b.state()).lookups, before.lookups);
    });
    await t.test("RED original synchronous duplicate task callbacks must dispatch only once", async () => {
      await reset(); await b.evaluate("f.capture();f.invoke();f.invoke();"); await b.settle();
      assert.equal(mutations(await b.state()).length, 1);
    });
    b.assertIsolated();
    return;
  }

  await t.test("review: actual Auth demo owner route reads existing local rows with no token, HTTP or writes", async () => {
    await b.evaluate("f.unmount();f.reset();f.demo();");
    const before = await b.state();
    assert.equal(before.auth.user.id, "demo-user"); assert.equal(before.auth.userRole, "owner"); assert.equal(before.auth.session, null); assert.equal(before.auth.workspacePurpose, "clinic_services");
    await b.evaluate("f.mount();"); await b.settle(); let s = await b.state();
    assert.match(s.text, /Операционный обзор/); assert.match(s.text, /Stored demo lead/); assert.match(s.text, /Stored demo client/);
    assert.equal(s.metrics["Новые заявки"].value, "1"); assert.equal(s.metrics["Выручка сегодня"].value.replace(/\s/g, ""), "5678₸");
    assert.ok(s.tasks > 0); assert.equal(s.enabledTasks, 0); assert.equal(s.sdkListeners, 0);
    await b.evaluate("f.capture();f.invoke();f.emit(null);f.aba();"); await b.settle(); s = await b.state();
    assert.match(s.text, /Stored demo lead/); assert.deepEqual(s.calls, []); assert.equal(s.lookups, 0); assert.deepEqual(s.toasts, []);
    assert.deepEqual(s.storage, before.storage); assert.deepEqual(s.storageWrites, []); assert.equal(s.blockedDemoHTTP, 0); assert.equal(s.platformMounts, 0);
  });

  for (const resource of ["health", "storage-health", "targeting/health", "meta-launches", "leads", "clients", "appointments", "deals"]) {
    await t.test(`review: ${resource} 404 is unavailable, not auth revocation or automatic writes`, async () => {
      await reset(true); const before = await b.state();
      const index = before.calls.findIndex((c: any) => c.url.includes(resource === "targeting/health" ? "/api/targeting/health?" : `/api/crm/${resource}?`)); assert.ok(index >= 0);
      await b.evaluate(`f.answer(${index},{status:404,body:{success:true,mode:'supabase',data:f.calls[${index}].defaultBody.data}});f.answerReads();`); await b.settle(); const s = await b.state();
      assert.match(s.text, /Операционный обзор/); assert.match(s.text, /Не удалось/); assert.ok(s.calls.every((c: any) => !c.aborted)); assert.equal(mutations(s).length, 0); assert.deepEqual(s.toasts, []);
      if (resource === "leads") { assert.equal(s.metrics["Новые заявки"].value, "—"); assert.match(s.sections["Новые заявки"], /Не удалось/); assert.doesNotMatch(s.text, /Обработайте новые заявки/); }
      else assert.equal(s.metrics["Новые заявки"].value, "1", "unrelated successful leads stay visible");
      if (resource === "appointments") assert.equal(s.metrics["Выручка сегодня"].value, "—", "no daily revenue without required clinic-day source");
      if (resource === "meta-launches") { assert.equal(s.metrics["Реклама требует внимания"].value, "—"); assert.doesNotMatch(s.text, /Последний запуск:|Запусков пока нет/); }
      assert.match(s.text, /Record synthetic-A synthetic-workspace-A/, "unrelated CRM records remain visible");
    });
  }

  await t.test("review: current task 404 never reports success or clears unrelated data; no automatic retry", async () => {
    await reset(); await b.evaluate("f.capture();f.invoke();"); await b.settle(); const before = await b.state();
    await b.evaluate("f.answer(f.calls.length-1,{status:404,body:{success:true,mode:'supabase'}});"); await b.settle(); const s = await b.state();
    assert.match(s.text, /Record synthetic-A synthetic-workspace-A/); assert.equal(s.busy, false); assert.equal(s.calls.length, before.calls.length); assert.equal(s.lookups, before.lookups);
    assert.deepEqual(s.toasts.map((v: any) => v.kind), ["error"]); assert.ok(s.calls.every((c: any) => !c.aborted));
  });
  if (process.argv.includes("--review-only")) { b.assertIsolated(); return; }

  await t.test("empty explicit demo stays empty without seeding or any remote reads", async () => {
    await b.evaluate("f.unmount();f.reset();f.demo({records:false});"); const before = await b.state();
    await b.evaluate("f.mount();"); await b.settle(); const s = await b.state();
    assert.match(s.text, /Операционный обзор/); assert.doesNotMatch(s.text, /Stored demo|Record synthetic/); assert.equal(s.metrics["Новые заявки"].value, "0");
    assert.deepEqual(s.storage, before.storage); assert.deepEqual(s.storageWrites, []); assert.deepEqual(s.calls, []); assert.equal(s.lookups, 0); assert.equal(s.blockedDemoHTTP, 0); assert.equal(s.platformMounts, 0);
    for (const key of ["leads", "clients", "appointments", "deals"]) assert.equal(s.storage[`negis_demo_${key}`], undefined);
  });

  for (const resource of ["leads", "clients", "appointments", "deals"]) for (const raw of ["{invalid", "[null]"]) {
    await t.test(`malformed existing demo ${resource} ${raw} is unavailable, never seeded or fetched`, async () => {
      await b.evaluate(`f.unmount();f.reset();f.demo();localStorage.setItem('negis_demo_${resource}',${JSON.stringify(raw)});f.storageWrites=[];`); const before = await b.state();
      await b.evaluate("f.mount();"); await b.settle(); const s = await b.state();
      assert.match(s.text, /Не удалось загрузить часть данных обзора/); assert.deepEqual(s.storage, before.storage); assert.deepEqual(s.storageWrites, []); assert.deepEqual(s.calls, []); assert.equal(s.lookups, 0); assert.equal(s.blockedDemoHTTP, 0);
      const label = { leads: "Новые заявки", clients: "Пациенты для повторного визита", appointments: "Записи сегодня", deals: "Выручка сегодня" }[resource]!;
      assert.equal(s.metrics[label].value, "—");
    });
  }

  await t.test("UUID workspace cannot opt into local demo reads even with explicit demo Auth", async () => {
    await b.evaluate("f.unmount();f.reset();f.demo({workspaceId:'00000000-0000-4000-8000-000000000011'});f.mount();"); await b.settle(); const s = await b.state();
    assert.equal(s.text, ""); assert.deepEqual(s.calls, []); assert.equal(s.lookups, 0); assert.deepEqual(s.storageWrites, []);
  });

  await t.test("pending real reads and captured task actions cannot cross real/demo/real lifetime transitions", async () => {
    await reset(); await b.evaluate("f.capture('real');f.demo();"); await b.settle(); let s = await b.state();
    assert.match(s.text, /Stored demo lead/); const lookups = s.lookups, calls = s.calls.length;
    await b.evaluate("f.invoke('real');f.capture('demo');f.invoke('demo');"); await b.settle(); s = await b.state(); assert.equal(s.lookups, lookups); assert.equal(s.calls.length, calls);
    await b.evaluate("f.holdReads=true;f.emit('synthetic-A');f.restore();"); await b.settle(); s = await b.state(); assert.doesNotMatch(s.text, /Stored demo/);
    const pending = s.calls.slice(calls).map((_: any, i: number) => i + calls); assert.equal(pending.length, 8);
    await b.evaluate("f.demo();"); await b.settle(); const before = await b.state();
    await b.evaluate(`for(const i of ${JSON.stringify(pending)})f.answer(i);f.invoke('real');f.invoke('demo');`); await b.settle(); s = await b.state();
    assert.match(s.text, /Stored demo lead/); assert.doesNotMatch(s.text, /Record synthetic/); assert.equal(s.lookups, before.lookups); assert.deepEqual(s.toasts, []); assert.equal(s.blockedDemoHTTP, 0);
  });

  await t.test("same-session aggregate and exact recommendation payload; synchronous double click creates once", async () => {
    await reset(); let s = await b.state();
    assert.equal(s.calls.length, 8);
    assert.ok(s.text.includes("Record synthetic-A synthetic-workspace-A"));
    for (const c of s.calls) { assert.match(c.url, /workspaceId=synthetic-workspace-A/); assert.equal(c.auth, "Bearer synthetic-token-1"); }
    await b.evaluate("f.capture();f.invoke();f.invoke();f.refresh();"); await b.settle(); s = await b.state();
    assert.equal(mutations(s).length, 1);
    const index = s.calls.findIndex((c: any) => c.method === "POST");
    assert.deepEqual(s.calls[index].body, { workspaceId: "synthetic-workspace-A", title: "Открыть заявки", status: "new", priority: "high" });
    assert.match(s.calls[index].url, /^\/api\/crm\/tasks\?workspaceId=synthetic-workspace-A$/);
    await b.evaluate(`f.answer(${index});`); await b.settle(); s = await b.state();
    assert.equal(s.busy, false); assert.deepEqual(s.toasts.map((v: any) => v.kind), ["success"]);
    assert.equal(s.calls.length, 9, "no provider or extra refresh request");
    await b.evaluate("f.capture('low',3);f.invoke('low');"); await b.settle(); s = await b.state();
    const low = mutations(s)[1]; assert.equal(low.auth, "Bearer synthetic-token-2");
    assert.deepEqual(low.body, { workspaceId: "synthetic-workspace-A", title: "Открыть продажи", status: "new", priority: "medium" });
  });

  for (const [transition, code] of Object.entries(changes)) {
    for (const outcome of ["headers-success", "headers-error", "body-success", "body-error"]) {
      const heldBody = outcome.startsWith("body"), failed = outcome.endsWith("error");
      await t.test(`pending aggregate ${outcome} retires across ${transition} A/B/A`, async () => {
        await reset(true); const old = (await b.state()).calls.length; assert.equal(old, 8);
        if (heldBody) { await b.evaluate(`f.answerReads({holdBody:true,${failed ? "body:{success:false,error:'Stale private error'}" : ""}});`); await b.settle(); assert.ok((await b.state()).heldUsed.every(Boolean)); }
        await b.evaluate(code); await b.settle();
        let s = await b.state(); assert.doesNotMatch(s.text, /Record synthetic-A synthetic-workspace-A/);
        await b.evaluate(`f.holdReads=false;f.restore();for(let i=${old};i<f.calls.length;i++)if(!f.calls[i].answered)f.answer(i);`); await ready();
        const before = await b.state();
        await b.evaluate(heldBody ? "f.release();" : `for(let i=0;i<${old};i++)f.answer(i,${failed ? "{status:500,body:{success:false,error:'Stale private error'}}" : "{}"});`);
        await b.settle(); s = await b.state();
        assert.equal(s.text, before.text); assert.deepEqual(s.toasts, []); assert.equal(s.calls.length, before.calls.length);
        assert.ok(s.calls.slice(0, old).every((c: any) => c.aborted));
      });
    }
    await t.test(`settled recommendation callback is retired before token lookup after ${transition} A/B/A`, async () => {
      await reset(); await b.evaluate("f.capture();"); await b.evaluate(code); await b.settle(); await b.evaluate("f.restore();"); await ready();
      const before = await b.state(); await b.evaluate("f.invoke();"); await b.settle(); const after = await b.state();
      assert.equal(after.lookups, before.lookups); assert.equal(after.calls.length, before.calls.length); assert.deepEqual(after.toasts, []);
      await b.evaluate("f.click();"); await b.settle(); assert.equal(mutations(await b.state()).length, 1, "fresh control remains usable");
    });
    for (const outcome of ["success", "error", "transport"]) {
      await t.test(`pending task ${outcome} cannot settle fresh state after ${transition} A/B/A`, async () => {
        await reset(); await b.evaluate("f.capture();f.invoke();"); await b.settle();
        const index = (await b.state()).calls.findIndex((c: any) => c.method === "POST");
        if (outcome !== "transport") { await b.evaluate(`f.answer(${index},{holdBody:true,body:{success:${outcome === "success"},mode:'supabase',error:'Stale private error'}});`); await b.settle(); }
        await b.evaluate(code); await b.settle(); await b.evaluate("f.restore();"); await ready();
        await b.evaluate("f.capture('new');f.invoke('new');"); await b.settle();
        const before = await b.state(); assert.equal(before.busy, true);
        await b.evaluate(outcome === "transport" ? `f.answer(${index},{lost:true});` : "f.release();"); await b.settle();
        let s = await b.state(); assert.equal(s.busy, true); assert.deepEqual(s.toasts, []); assert.deepEqual(s.warnings, []);
        const lookups = s.lookups, calls = s.calls.length;
        await b.evaluate("f.invoke();"); await b.settle(); s = await b.state();
        assert.equal(s.lookups, lookups, "stale click refused before token lookup"); assert.equal(s.calls.length, calls);
        assert.equal(s.calls[index].aborted, true);
        await b.evaluate(`f.answer(${calls - 1});`); await b.settle(); s = await b.state();
        assert.equal(s.busy, false); assert.deepEqual(s.toasts.map((v: any) => v.kind), ["success"]);
      });
    }
  }

  await t.test("actor change while task token lookup is pending cannot rebind to B or return to A", async () => {
    await reset(); const lookups = (await b.state()).lookups;
    await b.evaluate("f.holdToken=true;f.capture();f.invoke();f.invoke();"); await b.settle();
    let s = await b.state(); assert.equal(mutations(s).length, 0); assert.equal(s.lookups, lookups + 1);
    await b.evaluate("f.aba();f.releaseTokens();"); await ready(); s = await b.state();
    assert.equal(mutations(s).length, 0); assert.deepEqual(s.toasts, []);
    const before = s.lookups; await b.evaluate("f.invoke();"); await b.settle(); assert.equal((await b.state()).lookups, before);
  });

  await t.test("same-actor token refresh preserves pending aggregate and original workspace payload", async () => {
    await reset(true); await b.evaluate("f.answerReads({holdBody:true});f.refresh();"); await b.settle();
    await b.evaluate("f.release();"); await ready(); const s = await b.state(); assert.equal(s.calls.length, 8); assert.ok(s.calls.every((c: any) => !c.aborted));
  });

  for (const status of [401, 403]) {
    for (const operation of ["read", "task"]) {
      await t.test(`${operation} ${status} retires at headers before decoding denied body`, async () => {
        await reset(operation === "read");
        if (operation === "task") { await b.evaluate("f.capture();f.invoke();"); await b.settle(); }
        const s = await b.state(), index = operation === "read" ? 4 : s.calls.length - 1;
        await b.evaluate(`f.answer(${index},{status:${status},holdBody:true});`); await b.settle();
        const after = await b.state(); assert.equal(after.tasks, 0); assert.deepEqual(after.heldUsed, [false]); assert.deepEqual(after.toasts, []);
        if (operation === "task") { await b.evaluate("f.invoke();"); await b.settle(); assert.equal((await b.state()).lookups, after.lookups); }
        await b.evaluate("f.release();");
      });
    }
  }

  const affected: Record<string, { metrics: string[]; sections: string[]; recommendation: string }> = {
    "meta-launches": { metrics: ["Реклама требует внимания"], sections: [], recommendation: "Проверьте неудачный запуск рекламы" },
    leads: { metrics: ["Новые заявки", "Необработанные лиды"], sections: ["Новые заявки", "Заявки по источникам"], recommendation: "Обработайте новые заявки" },
    clients: { metrics: ["Пациенты для повторного визита"], sections: [], recommendation: "Подготовьте повторное предложение" },
    appointments: { metrics: ["Записи сегодня", "Выручка сегодня"], sections: ["Ближайшие записи"], recommendation: "Проверьте записи на сегодня" },
    deals: { metrics: ["Выручка сегодня"], sections: ["Неоплаченные продажи"], recommendation: "Свяжите продажи с рекламными кампаниями" },
  };
  for (const resource of Object.keys(affected)) {
    for (const failure of ["http", "missing", "demo", "malformed", "invalidRows", "transport", "notSuccess"]) {
      await t.test(`required ${resource} ${failure} never invents zero data or recommendations`, async () => {
        await b.evaluate("f.unmount();f.reset();f.holdReads=true;f.patch({clinicId:'00000000-0000-4000-8000-000000000011'});f.localRows();f.storageWrites=[];f.mount();"); await b.settle();
        const s = await b.state(); const index = s.calls.findIndex((c: any) => c.url.includes(`/api/crm/${resource}?`));
        const options = failure === "http" ? "{status:500}" : failure === "missing" ? "{body:{success:true,mode:'supabase',data:{}}}" : failure === "demo" ? "{body:{success:true,mode:'demo',data:f.calls[" + index + "].defaultBody.data}}" : failure === "invalidRows" ? JSON.stringify({ body: { success: true, mode: "supabase", data: { [resource === "meta-launches" ? "launches" : resource]: [null] } } }) : failure === "transport" ? "{lost:true}" : failure === "notSuccess" ? "{body:{success:false,mode:'supabase'}}" : "{raw:'{invalid'}";
        await b.evaluate(`f.answer(${index},${options});f.answerReads();`); await b.settle();
        const after = await b.state(); assert.match(after.text, /Не удалось загрузить часть данных обзора/);
        for (const label of affected[resource].metrics) { assert.equal(after.metrics[label].value, "—"); assert.match(after.metrics[label].text, /Не удалось проверить/); }
        for (const title of affected[resource].sections) assert.match(after.sections[title], /Не удалось/);
        assert.ok(!after.text.includes(affected[resource].recommendation)); assert.doesNotMatch(after.text, /Stored demo|Критичных CRM-действий пока нет/);
        assert.match(after.text, /Record synthetic/, "unrelated successful sources remain visible");
        assert.equal(mutations(after).length, 0); assert.deepEqual(after.storageWrites, []); assert.deepEqual(after.toasts, []);
      });
    }
  }

  await t.test("optional health failure remains unknown without blocking valid required data", async () => {
    await reset(true); await b.evaluate("for(let i=0;i<3;i++)f.answer(i,{status:500});f.answerReads();"); await ready();
    assert.match((await b.state()).text, /Не удалось проверить/);
  });
  await t.test("current task failure is visible, demo success refused, same-session retry remains usable", async () => {
    await reset(); await b.evaluate("f.capture();f.invoke();"); await b.settle();
    await b.evaluate("f.answer(f.calls.length-1,{body:{success:true,mode:'demo'}});"); await b.settle();
    let s = await b.state(); assert.deepEqual(s.toasts.map((v: any) => v.kind), ["error"]); assert.equal(s.busy, false);
    await b.evaluate("f.invoke();"); await b.settle(); s = await b.state(); assert.equal(mutations(s).length, 2);
    assert.deepEqual(mutations(s)[0].body, mutations(s)[1].body);
  });

  for (const operation of ["read", "task"]) for (const outcome of ["success", "error"]) {
    await t.test(`${operation} unmount ignores late ${outcome} and captured task click`, async () => {
      await reset(operation === "read");
      if (operation === "task") { await b.evaluate("f.capture();f.invoke();"); await b.settle(); }
      await b.evaluate(operation === "read" ? `f.answerReads({holdBody:true,${outcome === "error" ? "status:500,body:{success:false,error:'Stale read error'}" : ""}});` : `f.answer(f.calls.length-1,{holdBody:true,body:{success:${outcome === "success"},mode:'supabase'}});`); await b.settle();
      await b.evaluate("f.unmount();"); const before = await b.state();
      await b.evaluate(`f.release();${operation === "task" ? "f.invoke();" : ""}`); await b.settle();
      const after = await b.state(); assert.equal(after.text, ""); assert.deepEqual(after.toasts, []); assert.deepEqual(after.warnings, []); assert.equal(after.lookups, before.lookups); assert.equal(after.calls.length, before.calls.length);
      await b.evaluate("f.holdReads=false;f.mount();"); await ready();
    });
  }

  await t.test("page itself refuses route loss even without ProtectedPage; route gate denies mortgage/role", async () => {
    for (const gated of [false, true]) for (const code of [changes.purposeLoss, changes.roleLoss, changes.workspaceLoss]) {
      await reset(false, gated); await b.evaluate("f.capture();"); await b.evaluate(code); await b.settle(); const before = await b.state();
      assert.equal(before.tasks, 0); await b.evaluate("f.invoke();"); await b.settle(); assert.equal((await b.state()).lookups, before.lookups);
    }
  });
  b.assertIsolated();
});
