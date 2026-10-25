import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ids, ownedRecoveryBrowser, recoveryBundle, stopRecoveryBundler, visit } from "./appointment-recovery-committed-fixture.js";

// Scope: actual frontend React/actions/serverAuth/crmFetch over owned HTTP.
// This deliberately does not claim that a fake receipt ledger proves real SQL,
// backend revocation, appointment capacity or customer/production behavior.
type Wire = Record<string, any>;
type Receipt = { request: Wire; item: Wire };
type Seen = { actor: string; workspace: string; request: Wire; replayed: boolean; response: ServerResponse; finish(): void };
type Mode = "normal" | "drop" | "headers" | "body" | "deny";

test("G2 committed recovery uses actual React with owned SDK and HTTP doubles", { timeout: 180_000 }, async t => {
  t.after(stopRecoveryBundler);
  const script = await recoveryBundle();
  const receipts = new Map<string, Receipt>(), seen: Seen[] = [], denied = new Set<string>();
  let mode: Mode = "normal", denialStatus = 403, failures: string[] = [];
  const server = createServer(async (req, res) => {
    const address = server.address() as { port: number };
    if (req.headers.host !== `127.0.0.1:${address.port}`) { res.writeHead(403).end(); return; }
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" && req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(script); return; }
    if (req.method === "GET" && req.url === "/favicon.ico") { res.writeHead(204).end(); return; }
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
      res.end('<!doctype html><html lang="en"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/api/crm/appointments?workspaceId=")) { res.writeHead(403).end(); return; }
    try {
      let raw = "";
      for await (const chunk of req) { raw += String(chunk); assert.ok(raw.length < 32_000); }
      const request: Wire = JSON.parse(raw), workspace = new URL(req.url, "http://127.0.0.1").searchParams.get("workspaceId")!;
      const actor = String(req.headers.authorization).replace("Bearer synthetic-", "");
      assert.ok([ids.A, ids.B].some(value => value === actor));
      assert.ok([ids.workspace, ids.otherWorkspace].some(value => value === workspace));
      assert.equal(request.workspaceId, workspace);
      assert.match(request.requestKey, /^[0-9a-f-]{36}$/);
      const identity = `${workspace}:${actor}:${request.requestKey}`, stored = receipts.get(identity);
      const refused = mode === "deny" || denied.has(`${workspace}:${actor}`);
      let receipt = stored;
      if (!refused && !receipt) {
        receipt = { request: structuredClone(request), item: { ...request, id: randomUUID() } };
        receipts.set(identity, receipt);
      }
      if (stored) assert.deepEqual(request, stored.request, "same-key retry keeps the original whole wire intent");
      const body = JSON.stringify(refused ? { success: false, code: "permission_denied", error: "Synthetic revoked membership" }
        : { success: true, mode: "supabase", data: { item: receipt!.item, replayed: Boolean(stored), clientCreated: false } });
      let finished = false;
      const finish = () => { if (!finished && !res.destroyed) { finished = true; res.end(modeAtDispatch === "body" ? body.slice(1) : body); } };
      const modeAtDispatch = mode;
      seen.push({ actor, workspace, request, replayed: Boolean(stored), response: res, finish });
      res.writeHead(refused ? denialStatus : stored ? 200 : 201, { "Content-Type": "application/json" });
      if (modeAtDispatch === "drop") {
        // Truncate the body after headers reached the browser. Destroying a
        // fresh connection before headers allows Chromium to transparently
        // retry POST, which would be a different transport experiment.
        res.write(body.slice(0, 1)); res.flushHeaders();
        setTimeout(() => res.destroy(), 30); return;
      }
      if (modeAtDispatch === "headers") return;
      if (modeAtDispatch === "body") { res.write(body.slice(0, 1)); res.flushHeaders(); return; }
      finish();
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  t.after(async () => { for (const item of seen) item.response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const browser = await ownedRecoveryBrowser(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  t.after(browser.close);
  const run = browser.evaluate, wait = browser.waitFor;
  const snapshot = () => run<Wire>("await f.tick();return f.snapshot();");
  const requests = async (count: number) => {
    for (let i = 0; i < 100; i++) { if (seen.length >= count) return; await delay(20); }
    assert.fail(`Expected ${count} owned HTTP requests, got ${seen.length}: ${failures.join('; ')}`);
  };
  const clean = async () => {
    for (const item of seen) item.response.destroy();
    mode = "normal"; denialStatus = 403; receipts.clear(); seen.length = 0; denied.clear(); failures = [];
    await run("sessionStorage.clear();"); await browser.load();
    assert.equal((await snapshot()).sdkListeners, 1);
  };
  const lostCommit = async () => {
    mode = "drop"; await run("f.draft();f.start();"); await requests(1); await wait("f.tasks[0]?.done");
    const state = await snapshot();
    assert.equal(seen.length, 1, "the controlled lost response is not a browser-transparent retransmission");
    assert.equal(receipts.size, 1); assert.equal(state.uncertain, true); assert.equal(state.modalOpen, true);
    assert.equal(state.successes.length, 0); assert.equal(state.items.length, 0);
    assert.equal(state.attempt.requestKey, seen[0].request.requestKey); assert.equal(state.receipts.length, 1);
    return state;
  };
  const noAdoption = (state: Wire) => { assert.deepEqual(state.items, []); assert.deepEqual(state.successes, []); assert.deepEqual(state.handoffs, []); };

  await t.test("lost success response then same-actor replay adopts exactly one committed item and original binding", async () => {
    await clean(); const before = await lostCommit();
    const key = seen[0].request.requestKey, committed = [...receipts.values()][0].item;
    await browser.load(); await wait("f.view.unconfirmedCreate");
    const restored = await snapshot();
    assert.equal(restored.attempt.requestKey, key); assert.equal(restored.form.clientId, ids.client);
    assert.equal(restored.form.durationMinutes, visit.durationMinutes); assert.equal(restored.form.phone, visit.phone);
    mode = "normal"; await run("f.start();"); await requests(2); await wait("f.tasks[0]?.done");
    const after = await snapshot();
    assert.deepEqual(seen[1].request, seen[0].request); assert.equal(seen[1].replayed, true); assert.equal(receipts.size, 1);
    assert.equal(after.items.length, 1); assert.equal(after.items[0].id, committed.id);
    assert.equal(after.items[0].clientId, ids.client); assert.equal(after.items[0].doctorId, ids.doctor);
    assert.equal(after.items[0].durationMinutes, 45); assert.equal(after.items[0].priceMinor, 120000);
    assert.equal(after.receipts.length, 0); assert.equal(after.uncertain, false); assert.equal(after.modalOpen, false);
    assert.equal(after.successes.length, 1); assert.match(after.successes[0], /уже сохранена/);
    assert.equal(before.attempt.payload.startsAt, after.items[0].startsAt);
  });

  for (const transition of ["account", "workspace", "role", "ABA"] as const) {
    for (const phase of ["token", "headers", "body", "captured handler"] as const) {
      await t.test(`committed replay: ${transition} during ${phase} rejects stale adoption without losing the original receipt`, async () => {
        await clean(); const original = await lostCommit(); mode = "normal";
        if (phase === "token") await run("f.holdToken=true;f.start();");
        else if (phase === "captured handler") await run("window.obsoleteCreate=f.capture();");
        else { mode = phase; await run("f.start();"); await requests(2); if (phase === "body") await run("await f.tick();"); }
        if (phase === "token") await wait("f.tokens.length===2");
        const change = transition === "account" ? `f.actor('${ids.B}');` : transition === "workspace" ? `f.workspace('${ids.otherWorkspace}');`
          : transition === "role" ? "f.role(null);" : "f.aba();";
        await run(change + "await f.tick();");
        const afterChange = await snapshot();
        const existingCalls = seen.length;
        if (phase === "captured handler") await run("window.obsoleteCreate();");
        else if (phase === "token") await run("f.releaseToken(1);");
        else { seen[1].finish(); assert.equal(seen[1].response.writableEnded, true, "owned response has actually been completed"); }
        await wait("f.tasks[1]?.done");
        const after = await snapshot(); noAdoption(after);
        assert.equal(receipts.size, 1); assert.equal(after.receipts.length, 1);
        assert.equal(JSON.parse(after.receipts[0][1]).requestKey, original.attempt.requestKey);
        assert.equal(seen.length, existingCalls, "token/handler changes cannot dispatch, response changes cannot dispatch another request");
        assert.equal(after.modalOpen, afterChange.modalOpen); assert.deepEqual(after.form, afterChange.form);
        assert.equal(after.saving, afterChange.saving); assert.equal(after.locked, afterChange.locked);
        if (transition !== "ABA") assert.equal(after.form.phone, "", "another actor/workspace/role cannot see the private draft");
        else assert.equal(after.attempt.requestKey, original.attempt.requestKey, "new A lifetime retains a separately recoverable original intent");
      });
    }
  }

  for (const phase of ["headers", "body"] as const) {
    await t.test(`pending A -> B -> A: new live replay may settle while original ${phase} callback remains pending`, async () => {
      await clean(); mode = phase; await run("f.draft();f.start();"); await requests(1);
      const key = seen[0].request.requestKey;
      await run(`f.actor('${ids.B}');await f.tick();`);
      noAdoption(await snapshot());
      await run(`f.actor('${ids.A}');await f.tick();`); await wait("f.view.unconfirmedCreate");
      mode = "normal"; await run("f.start();"); await requests(2); await wait("f.tasks[1]?.done");
      const settled = await snapshot();
      assert.equal(settled.items.length, 1); assert.equal(settled.receipts.length, 0); assert.equal(settled.successes.length, 1);
      assert.equal(seen[1].request.requestKey, key); assert.equal(seen[1].replayed, true); assert.equal(receipts.size, 1);
      seen[0].finish(); await wait("f.tasks[0]?.done");
      const late = await snapshot();
      assert.deepEqual(late.items, settled.items); assert.deepEqual(late.successes, settled.successes);
      assert.equal(late.receipts.length, 0, "old catch must not resurrect an already reconciled receipt");
      assert.equal(late.attempt, null); assert.equal(late.modalOpen, false);
    });
  }

  for (const status of [401, 403, 404]) {
    await t.test(`committed recovery: HTTP ${status} redacts private draft before a held body and preserves the original outcome`, async () => {
      await clean(); const original = await lostCommit(); denied.add(`${ids.workspace}:${ids.A}`); mode = "body"; denialStatus = status;
      await run("f.start();"); await requests(2); await wait("f.tasks[1]?.done");
      const state = await snapshot(); noAdoption(state);
      assert.equal(receipts.size, 1); assert.equal(state.receipts.length, 1); assert.equal(state.uncertain, true);
      assert.equal(state.attempt.requestKey, original.attempt.requestKey);
      assert.equal(state.form.phone, "", "a denied replay must redact the private draft without declaring the original create rolled back");
      assert.equal(state.form.client, ""); assert.equal(state.form.notes, "");
      assert.deepEqual(state.attempt.payload, original.attempt.payload);
      await run("f.refresh();f.view.setCreateRecoveryRead(value=>value+1);await f.tick();");
      const reRead = await snapshot(); assert.equal(reRead.form.phone, ""); assert.equal(reRead.form.client, "");
      assert.equal(reRead.attempt.requestKey, original.attempt.requestKey); assert.equal(seen.length, 2);
      denied.clear(); mode = "normal"; await run("f.start();"); await requests(3); await wait("f.tasks[2]?.done");
      const reauthorized = await snapshot(); assert.equal(reauthorized.items.length, 1); assert.equal(reauthorized.successes.length, 1);
      assert.equal(reauthorized.receipts.length, 0); assert.equal(seen[2].replayed, true); assert.equal(receipts.size, 1);
      assert.deepEqual(seen[2].request, seen[0].request);
    });
  }

  await t.test("initial queued token A -> B -> A cannot dispatch after a newer lifetime has reconciled the same intent", async () => {
    await clean(); await run("f.holdToken=true;f.draft();f.start();"); await wait("f.tokens.length===1");
    const original = await snapshot(); assert.equal(seen.length, 0); assert.equal(original.receipts.length, 1);
    await run("f.aba();await f.tick();f.start();"); await wait("f.tokens.length===2");
    await run("f.releaseToken(1);"); await requests(1); await wait("f.tasks[1]?.done");
    const reconciled = await snapshot(); assert.equal(reconciled.items.length, 1); assert.equal(reconciled.receipts.length, 0);
    assert.equal(seen[0].request.requestKey, original.attempt.requestKey); assert.equal(receipts.size, 1);
    await run("f.releaseToken(0);"); await wait("f.tasks[0]?.done");
    const late = await snapshot(); assert.equal(seen.length, 1); assert.deepEqual(late.items, reconciled.items);
    assert.equal(late.receipts.length, 0); assert.equal(late.successes.length, 1); assert.equal(late.attempt, null);
  });

  await t.test("same-actor token refresh does not cancel committed reconciliation", async () => {
    await clean(); await lostCommit(); mode = "normal";
    await run("f.holdToken=true;f.start();"); await wait("f.tokens.length===2");
    await run("f.refresh();f.releaseToken(1);"); await requests(2); await wait("f.tasks[1]?.done");
    const state = await snapshot(); assert.equal(state.items.length, 1); assert.equal(state.successes.length, 1); assert.equal(state.receipts.length, 0);
  });

  await t.test("functional collection callback released after account/workspace/role/ABA invalidation cannot adopt the old confirmed item", async () => {
    for (const change of [`f.actor('${ids.B}');`, `f.workspace('${ids.otherWorkspace}');`, "f.role(null);", "f.aba();"]) {
      await clean(); await lostCommit(); mode = "normal";
      await run("f.holdCollection=true;f.start();"); await requests(2); await wait("f.tasks[1]?.done && f.collectionQueue.length===1");
      await run(change + "f.releaseCollection();await f.tick();");
      const state = await snapshot(); assert.deepEqual(state.items, []); assert.equal(state.receipts.length, 0);
    }
  });

  assert.deepEqual(failures, []); assert.deepEqual(browser.exceptions, []);
  assert.ok(browser.requests.every(url => url.startsWith(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)), "fixture requests stay on its owned HTTP origin");
});
