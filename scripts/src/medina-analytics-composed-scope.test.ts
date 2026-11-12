import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { analyticsBundle, ids, ownedAnalyticsBrowser, panels, stopAnalyticsBundler, type Panel } from "./medina-analytics-composed-fixture.js";

// G3 acceptance supplements (not copies) the isolated hook scheduler tests.
// Actual React DOM composes MortgageAnalytics -> MortgageScope/session/hooks ->
// both real child reports over owned loopback HTTP with fake auth and data.
// It proves observable frontend lifetimes, not backend permissions or SQL.
type Wire = Record<string, any>;
type SyntheticSnapshot = { timeZone: string; members: Wire[]; memberMetrics: Wire[]; contacts: Wire[]; metrics: Wire };
const { mortgageBrowserRequest } = await import(new URL("../fixtures/mortgage-browser-store.ts", import.meta.url).href) as {
  mortgageBrowserRequest(url: URL, init: RequestInit | undefined, role: string): Promise<Response>;
};
const { mortgageOutcomesBrowserRequest } = await import(new URL("../fixtures/mortgage-outcomes-browser-store.ts", import.meta.url).href) as {
  mortgageOutcomesBrowserRequest(url: URL, init: RequestInit | undefined, role: string, snapshot: SyntheticSnapshot): Response;
};
type Phase = "http" | "body";
type Seen = { index: number; panel: Panel; workspace: string; actor: string; role: string; days: number; marker: string;
  phase?: Phase; response: ServerResponse; release(status?: number): void };
const marker = (workspace: string, panel: Panel, n: number) => `Synthetic-${workspace === ids.workspaceA ? "A" : "B"}-${panel}-${n}:`;
const noReport = (state: Wire) => {
  assert.equal(state.tables, 0); assert.deepEqual(state.rows, []);
  assert.deepEqual(state.meters, []); assert.deepEqual(state.stats, []);
  assert.deepEqual(state.cells, []);
  assert.doesNotMatch(state.text, /Synthetic-/);
};

test("G3 composed analytics scope with actual React and owned Chromium/HTTP", { timeout: 180_000 }, async t => {
  t.after(stopAnalyticsBundler);
  const script = await analyticsBundle();
  const seen: Seen[] = [], failures: string[] = [];
  let plans: Partial<Record<Panel, Phase>> = {};
  const server = createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) { res.writeHead(403).end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'");
    if (req.method === "GET" && req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(script); return; }
    if (req.method === "GET" && req.url === "/favicon.ico") { res.writeHead(204).end(); return; }
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<!doctype html><html lang="ru"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return;
    }
    try {
      assert.equal(req.method, "GET", "No mutations in analytics acceptance");
      const url = new URL(req.url!, "http://127.0.0.1");
      const panel = url.pathname.slice("/api/crm/".length) as Panel;
      assert.ok(panels.includes(panel)); assert.equal(url.pathname, `/api/crm/${panel}`);
      const workspace = url.searchParams.get("workspaceId")!, days = Number(url.searchParams.get("days"));
      const actor = String(req.headers["x-fixture-actor"]), role = String(req.headers["x-fixture-role"]);
      const index = Number(req.headers["x-fixture-request"]);
      assert.ok(Number.isSafeInteger(index) && index >= 0 && !seen.some(item => item.index === index));
      assert.ok([ids.workspaceA, ids.workspaceB].some(value => value === workspace));
      assert.ok([ids.actorA, ids.actorB].some(value => value === actor));
      assert.ok(["owner", "admin"].includes(role), "Manager denial must happen at render, before transport");
      assert.ok([7, 30, 90].includes(days));
      const name = marker(workspace, panel, seen.length), phase = plans[panel];
      const snapshot = (await (await mortgageBrowserRequest(url, undefined, role)).json() as { data: SyntheticSnapshot }).data;
      snapshot.timeZone = workspace === ids.workspaceA ? "Asia/Almaty" : "UTC";
      snapshot.members.forEach((member: Wire, i: number) => { member.name = `${name}-member-${i}`; });
      snapshot.memberMetrics.forEach((member: Wire, i: number) => { member.name = `${name}-member-${i}`; });
      // Synthetic fixtures have no mutations here. Give the current lead cohort
      // one booked and one postponed lead for nonzero conversion controls.
      snapshot.contacts[0].status = "booked"; snapshot.contacts[1].status = "postponed";
      // Independent synthetic reply revisions distinguish stale aggregates even
      // when the table names are correct. Historical counts need no current lead.
      const delta = Math.max(0, index - 2);
      snapshot.memberMetrics[0].doneTasks = delta;
      let payload: Wire = { success: true, mode: "supabase", data: snapshot };
      if (panel === "mortgage-results") {
        payload = await mortgageOutcomesBrowserRequest(url, undefined, role, snapshot).json() as Wire;
        payload.data.members[0].signedInPeriod = delta;
      }
      if (panel === "lead-team-analytics") {
        const generatedAt = "2026-10-25T10:00:00.000Z";
        payload = { success: true, mode: "supabase", data: { analytics: {
          timeZone: snapshot.timeZone, generatedAt, period: { days, from: new Date(Date.parse(generatedAt) - days * 86_400_000).toISOString(), to: generatedAt },
          totalLeads: snapshot.metrics.totalLeads, unassignedLeads: snapshot.metrics.unassignedLeads, otherAssigneeLeads: 0,
          activityStatus: "available", members: snapshot.members.map((member: Wire) => {
            const mine = snapshot.contacts.filter((contact: Wire) => contact.responsibleUserId === member.id);
            return { staffId: member.id, name: member.name, role: member.role, status: member.status,
              assigned: { total: mine.length, new: mine.filter((c: Wire) => c.status === "new").length,
                inProgress: mine.filter((c: Wire) => c.status === "in_progress").length,
                booked: mine.filter((c: Wire) => c.status === "booked").length,
                postponed: mine.filter((c: Wire) => c.status === "postponed").length, lost: 0, other: 0 },
              activity: { updatedEvents: 13, createdEvents: 7, touchedLeads: 5, lastRecordedAt: generatedAt } };
          }),
        } } };
        // Additional synthetic new assignments preserve every cohort identity.
        const analytics = payload.data.analytics;
        analytics.members[2].assigned.new += delta;
        analytics.members[2].assigned.total += delta;
        analytics.totalLeads += delta;
      }
      const body = JSON.stringify(payload);
      let finished = false;
      const release = (status = 200) => {
        assert.equal(finished, false, "Each owned response is released once"); finished = true;
        assert.equal(res.destroyed, false, "Adversarial transport must actually permit a late response");
        if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
        else assert.equal(status, 200, "Cannot change status after a native JSON decoder started");
        res.end(status === 200 ? phase === "body" ? body.slice(1) : body : JSON.stringify({ success: false, code: "permission_denied" }));
      };
      seen.push({ index, panel, workspace, actor, role, days, marker: name, phase, response: res, release });
      if (phase === "body") { res.writeHead(200, { "Content-Type": "application/json" }); res.write(body.slice(0, 1)); res.flushHeaders(); }
      else if (!phase) release();
    } catch (error) { failures.push(error instanceof Error ? error.stack! : String(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  t.after(async () => {
    for (const item of seen) item.response.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await ownedAnalyticsBrowser(origin); t.after(browser.close);
  const run = browser.evaluate, wait = browser.waitFor;
  const snapshot = () => run<Wire>("await f.tick();return f.snapshot();");
  const ready = async () => { await wait("f.snapshot().tables===4 && f.snapshot().busy===0"); return snapshot(); };
  const requests = async (count: number) => {
    for (let i = 0; i < 150; i++) { assert.deepEqual(failures, []); if (seen.length >= count) return; await delay(20); }
    assert.fail(`Expected ${count} owned requests; got ${seen.length}`);
  };
  const clean = async (role = "owner") => {
    await run("f.unmount();");
    for (const item of seen) item.response.destroy();
    seen.length = 0; plans = {};
    await run(`f.reset(${JSON.stringify(role)});f.mount();`);
    if (role !== "lead_manager") { await requests(3); await ready(); }
  };
  const startAll = async (phase: Phase) => {
    const start = seen.length; plans = Object.fromEntries(panels.map(panel => [panel, phase]));
    await run(`for(const panel of ${JSON.stringify(panels)})f.reload(panel);`); await requests(start + 3);
    const pending = seen.slice(start);
    if (phase === "body") await wait(`f.decoding.length===${start + 3}`);
    return pending;
  };
  const assertNoLateMarkers = async (pending: Seen[]) => {
    const state = await snapshot();
    for (const item of pending) assert.ok(!state.text.includes(item.marker), `Stale marker ${item.marker} must not render`);
    return state;
  };
  const delivered = async (pending: Seen[]) => {
    // HTTP must reach the fake transport; every already-reading native JSON
    // must finish. A fixed sleep cannot stand in for actual late delivery.
    await wait(`${JSON.stringify(pending.map(item => item.index))}.every(index=>f.received.includes(index))`);
    await wait(`${JSON.stringify(pending.filter(item => item.phase === "body").map(item => item.index))}.every(index=>f.decoded.includes(index))`);
  };

  for (const role of ["owner", "admin"]) {
    await t.test(`${role} positive composition and same-actor token refresh keep all three reports usable`, async () => {
      await clean(role); const before = await ready();
      assert.equal(before.rows.length, 12); assert.ok(before.meters.includes(33.3)); assert.match(before.text, /20%/);
      assert.ok(before.text.includes("15:00 GMT+5"), "The actual DOM must use workspace A's +5 report zone");
      assert.equal(before.alerts.length, 0); assert.equal(before.listeners, 2);
      for (const item of seen) assert.ok(before.text.includes(item.marker));
      await run("f.refresh();"); const refreshed = await snapshot();
      assert.deepEqual(refreshed.rows, before.rows); assert.equal(seen.length, 3);
      await startAll("body"); noReport(await snapshot());
      for (const item of seen.slice(3)) item.release();
      await delivered(seen.slice(3));
      await ready(); assert.deepEqual(seen.map(item => item.role), Array(6).fill(role));
    });
  }

  await t.test("manager direct render denies the actual report before any data request", async () => {
    await clean("lead_manager"); const state = await snapshot(); noReport(state);
    assert.equal(state.alerts.length, 1); assert.match(state.text, /владельцу и администратору/);
    assert.deepEqual(state.requests, []); assert.equal(seen.length, 0);
  });

  for (const change of ["role", "workspace", "actor", "auth ABA"] as const) {
    await t.test(`ready ${change} render removes every prior report before returning to a fresh A lifetime`, async () => {
      await clean(); const old = [...seen]; await run("f.capture();");
      let hidden: Wire;
      if (change === "role") hidden = await run("f.patch({userRole:'lead_manager'});return f.snapshot();");
      else if (change === "workspace") hidden = await run(`f.patch({clinicId:${JSON.stringify(ids.workspaceB)}});return f.snapshot();`);
      else if (change === "actor") hidden = await run(`f.actor(${JSON.stringify(ids.actorB)});return f.snapshot();`);
      else hidden = await run("f.aba();return f.snapshot();");
      noReport(hidden);
      if (change === "workspace" || change === "actor") {
        await requests(6); const switched = await ready();
        if (change === "workspace") {
          assert.ok(switched.text.includes("10:00 UTC"), "Workspace B's report must use its own zone");
          assert.ok(!switched.text.includes("GMT+5"), "No timestamp may retain workspace A's report zone");
        }
        await run(change === "workspace" ? `f.patch({clinicId:${JSON.stringify(ids.workspaceA)}});` : `f.actor(${JSON.stringify(ids.actorA)});`);
      } else if (change === "role") {
        assert.equal(seen.length, 3); await run("f.patch({userRole:'owner'});");
      }
      const expected = change === "workspace" || change === "actor" ? 9 : 6;
      await requests(expected); const fresh = await ready();
      assert.ok(fresh.text.includes("15:00 GMT+5"), "The fresh A lifetime must restore A's report-owned zone");
      await run("f.stale();f.refresh();"); const after = await assertNoLateMarkers(old);
      assert.deepEqual(after.rows, fresh.rows); assert.deepEqual(after.stats, fresh.stats);
      assert.deepEqual(after.cells, fresh.cells);
      assert.equal(seen.length, expected);
    });
  }

  for (const deniedPanel of panels) {
    await t.test(`${deniedPanel} 403 removes already-ready sibling rows and statistics`, async () => {
      await clean(); const siblings = seen.filter(item => item.panel !== deniedPanel);
      plans[deniedPanel] = "http";
      await run(`f.reload(${JSON.stringify(deniedPanel)});`); await requests(4);
      const loading = await snapshot();
      for (const item of siblings) assert.ok(loading.text.includes(item.marker), "Sibling is ready at the moment of denial");
      seen[3].release(403); await delivered([seen[3]]);
      await wait("f.snapshot().alerts.some(text=>text.includes('\u043e\u0442\u043e\u0437\u0432\u0430\u043d'))");
      noReport(await snapshot());
      await run("f.refresh();"); noReport(await snapshot()); assert.equal(seen.length, 4);
    });
  }

  for (const panel of panels) for (const phase of ["http", "body"] as const) {
    await t.test(`${panel} period 30/7/90/30 ABA rejects late ${phase} without resetting its siblings`, async () => {
      await clean(); const original = seen.find(item => item.panel === panel)!;
      const siblings = seen.filter(item => item.panel !== panel);
      plans[panel] = phase;
      await run(`f.period(${JSON.stringify(panel)},7);`); await requests(4);
      if (phase === "body") await wait("f.decoding.includes(3)");
      const pending7 = seen[3];
      const loading = await snapshot(); assert.ok(!loading.text.includes(original.marker));
      for (const sibling of siblings) assert.ok(loading.text.includes(sibling.marker), "Unchanged sibling stays ready");
      await run(`f.period(${JSON.stringify(panel)},90);`); await requests(5);
      if (phase === "body") await wait("f.decoding.includes(4)");
      const pending90 = seen[4]; plans = {};
      await run(`f.period(${JSON.stringify(panel)},30);`); await requests(6);
      const current = await ready(); assert.ok(current.text.includes(seen[5].marker));
      await run("f.history=[];");
      pending90.release(); pending7.release();
      await delivered([pending7, pending90]);
      const after = await assertNoLateMarkers([original, pending7, pending90]);
      assert.deepEqual(after.rows, current.rows); assert.deepEqual(after.stats, current.stats);
      assert.deepEqual(after.cells, current.cells);
      assert.deepEqual(after.meters, current.meters); assert.equal(seen.length, 6);
      assert.deepEqual(seen.filter(item => item.panel === panel).map(item => item.days), [30, 7, 90, 30]);
      for (const state of await run<Wire[]>("return f.history;")) {
        for (const item of [original, pending7, pending90]) assert.ok(!state.text.includes(item.marker));
      }
    });
  }

  for (const phase of ["http", "body"] as const) for (const change of ["role", "workspace", "actor", "auth ABA", "unmount"] as const) {
    await t.test(`${change} with all reports pending ${phase} cannot restore old rows/stats on return to A`, async () => {
      await clean(); await run("f.capture();"); const pending = await startAll(phase);
      noReport(await snapshot()); plans = {};
      if (change === "role") {
        const denied = await run<Wire>("f.patch({userRole:'lead_manager'});return f.snapshot();");
        noReport(denied); assert.match(denied.text, /владельцу и администратору/);
        assert.equal(seen.length, 6); await run("f.patch({userRole:'owner'});");
      } else if (change === "workspace") {
        const switched = await run<Wire>(`f.patch({clinicId:${JSON.stringify(ids.workspaceB)}});return f.snapshot();`);
        noReport(switched); await requests(9); await ready();
        assert.ok(seen.slice(6).every(item => item.workspace === ids.workspaceB));
        await run(`f.patch({clinicId:${JSON.stringify(ids.workspaceA)}});`);
      } else if (change === "actor") {
        const switched = await run<Wire>(`f.actor(${JSON.stringify(ids.actorB)});return f.snapshot();`);
        noReport(switched); await requests(9); await ready();
        assert.ok(seen.slice(6).every(item => item.actor === ids.actorB));
        await run(`f.actor(${JSON.stringify(ids.actorA)});`);
      } else if (change === "auth ABA") {
        const switched = await run<Wire>("f.aba();return f.snapshot();"); noReport(switched);
      } else {
        const unmounted = await run<Wire>("f.unmount();return f.snapshot();"); noReport(unmounted);
        assert.equal(unmounted.listeners, 0);
        for (const item of pending) item.release();
        await delivered(pending);
        await run("f.stale();await f.tick();"); noReport(await snapshot()); assert.equal(seen.length, 6);
        await run("f.mount();");
      }
      const expected = change === "actor" || change === "workspace" ? 12 : 9;
      await requests(expected); const fresh = await ready();
      assert.ok(seen.slice(-3).every(item => item.workspace === ids.workspaceA && item.actor === ids.actorA && item.role === "owner" && item.days === 30));
      await run("f.history=[];f.stale();");
      if (change !== "unmount") for (const item of pending) item.release();
      await delivered(pending);
      const after = await assertNoLateMarkers(pending);
      assert.deepEqual(after.rows, fresh.rows); assert.deepEqual(after.stats, fresh.stats); assert.deepEqual(after.meters, fresh.meters);
      assert.deepEqual(after.cells, fresh.cells);
      assert.equal(seen.length, expected, "Retained controls cannot dispatch into a fresh lifetime");
      const history = await run<Wire[]>("return f.history;");
      for (const state of history) for (const item of pending) assert.ok(!state.text.includes(item.marker));
    });
  }

  for (const deniedPanel of panels) for (const phase of ["http", "body"] as const) {
    await t.test(`${deniedPanel} HTTP 403 revokes the composed report despite sibling late ${phase} success`, async () => {
      await clean(); await run("f.capture();");
      plans = Object.fromEntries(panels.map(panel => [panel, panel === deniedPanel ? "http" : phase]));
      await run(`for(const panel of ${JSON.stringify(panels)})f.reload(panel);`); await requests(6);
      const pending = seen.slice(3), denied = pending.find(item => item.panel === deniedPanel)!;
      if (phase === "body") await wait("f.decoding.length===5");
      noReport(await snapshot()); denied.release(403);
      await wait("f.snapshot().alerts.some(text=>text.includes('\u043e\u0442\u043e\u0437\u0432\u0430\u043d'))");
      const revoked = await snapshot(); noReport(revoked);
      assert.equal(revoked.listeners, 2); // Scope remains revoked, not a fresh authorized mount.
      await run("f.history=[];");
      for (const item of pending) if (item !== denied) item.release();
      await delivered(pending);
      await run(`f.stale();f.refresh();f.patch({user:{id:${JSON.stringify(ids.actorA)}}});await f.tick();`);
      const after = await snapshot(); noReport(after); assert.deepEqual(after.alerts, revoked.alerts);
      assert.equal(after.requests.length, 6); assert.equal(seen.length, 6);
      assert.ok(!after.decoding.includes(denied.index), "Scope refuses 403 before its body is read");
      for (const state of await run<Wire[]>("return f.history;")) noReport(state);
    });
  }

  await t.test("late obsolete 403 cannot revoke a fresh authorized A after workspace A/B/A", async () => {
    await clean(); const pending = await startAll("http"); plans = {};
    await run(`f.patch({clinicId:${JSON.stringify(ids.workspaceB)}});`); await requests(9); await ready();
    await run(`f.patch({clinicId:${JSON.stringify(ids.workspaceA)}});`); await requests(12); const fresh = await ready();
    pending[0].release(403); for (const item of pending.slice(1)) item.release(); await delivered(pending);
    const after = await assertNoLateMarkers(pending);
    assert.deepEqual(after.rows, fresh.rows); assert.deepEqual(after.stats, fresh.stats); assert.deepEqual(after.alerts, []);
    assert.deepEqual(after.cells, fresh.cells);
    assert.equal(seen.length, 12);
  });

  await run("f.unmount();");
  assert.equal((await snapshot()).listeners, 0);
  assert.deepEqual(failures, []); assert.deepEqual(browser.exceptions, []);
  assert.ok(browser.requests.every(url => url.startsWith(origin + "/")), "Only owned loopback URLs were requested");
});
