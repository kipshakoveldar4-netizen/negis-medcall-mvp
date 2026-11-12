import assert from "node:assert/strict";
import test from "node:test";
import { startJoinWorkspaceFixture } from "./medina-join-workspace-lifetime.fixture";

// Current: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-join-workspace-lifetime.test.ts
// Red proof: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-join-workspace-lifetime.test.ts --baseline
// Only the page is replaced with db73c4a in baseline mode; shared helpers stay actual.
const accept = "Принять приглашение";
const retry = "Повторить";
const switchAccount = "Это не я — войти под другой почтой";
const selector = "negis_workspace_selector";
const invitation = "negis_pending_invite";
const baseline = process.argv.includes("--baseline");
type Fixture = Awaited<ReturnType<typeof startJoinWorkspaceFixture>>;
type Boundary = "account" | "context-account" | "ABA" | "workspace" | "role" | "permissions" | "logout" | "logout-pending" | "logout-tombstone" | "unmount";
const boundaries: Boundary[] = ["account", "context-account", "ABA", "workspace", "role", "permissions", "logout", "logout-pending", "logout-tombstone", "unmount"];

async function ready(f: Fixture, options: Record<string, unknown> = {}) {
  await f.call("mount", options);
  return f.until(s => s.buttons.some((b: any) => b.label === accept), "Current actor is ready to accept");
}
async function invalidate(f: Fixture, boundary: Boundary) {
  if (boundary === "account") await f.call("actor", "B");
  if (boundary === "context-account") await f.call("patch", { user: { id: "B" }, session: { user: { id: "B" } } });
  if (boundary === "ABA") { await f.call("actor", "B"); await f.call("actor", "A"); }
  if (boundary === "workspace") await f.call("patch", { clinicId: "synthetic-workspace-B" });
  if (boundary === "role") await f.call("patch", { userRole: "doctor" });
  if (boundary === "permissions") await f.call("patch", { rolePermissions: { crm: false } });
  if (boundary === "logout") await f.call("actor", null);
  if (boundary === "logout-pending") await f.call("patch", { isSigningOut: true });
  if (boundary === "logout-tombstone") await f.call("markLogout");
  if (boundary === "unmount") await f.call("unmount");
}
function noAcceptanceEffects(state: any) {
  assert.equal(state.local[selector], undefined, "No stale response can select a workspace");
  assert.deepEqual(state.navigations, [], "No stale callback can navigate");
  assert.deepEqual(state.notices, [], "No stale callback can publish a toast");
  assert.ok(!state.text.includes("Готово."), "No optimistic or stale joined state");
}

test("JoinWorkspace: actual React/SDK and synthetic HTTP acceptance lifetime", { timeout: 180_000 }, async t => {
  t.diagnostic(`Page source: ${baseline ? "db73c4a baseline" : "working tree"}; shared API/auth helpers are unchanged`);
  const f = await startJoinWorkspaceFixture(t, baseline);
  for (const options of [{ strict: false }, {}, { hash: true }, { stashed: "synthetic-invite" }]) {
    await t.test(`positive original invitation acceptance ${JSON.stringify(options)}`, async () => {
      await ready(f, options);
      await f.call("patch", { userRole: null, clinicId: null });
      await f.until(s => s.buttons.some((b: any) => b.label === accept), "Membership is not required to accept");
      await f.call("fill", "  Synthetic Invited Person  ");
      await f.call("click", accept);
      let state = await f.until(s => s.calls.length === 1, "One original acceptance POST");
      assert.equal(state.calls[0].url, "/api/crm/staff-invitations/accept");
      assert.equal(state.calls[0].method, "POST");
      assert.deepEqual(state.calls[0].body, { token: "synthetic-invite", fullName: "Synthetic Invited Person" });
      const jwt = state.calls[0].authorization.replace(/^Bearer /, "").split(".")[1];
      assert.equal(JSON.parse(Buffer.from(jwt, "base64").toString()).sub, "A");
      noAcceptanceEffects(state);
      await f.call("reply", 0, { success: true, data: { workspaceId: "synthetic-invited-workspace", role: "owner" } });
      state = await f.until(s => s.text.includes("Готово."), "Server-confirmed acceptance");
      assert.equal(state.local[selector], "synthetic-invited-workspace");
      assert.equal(state.tab[invitation], undefined);
      assert.deepEqual(state.context, { actor: "A", role: null, workspace: null }, "No local membership or role assignment");
      assert.deepEqual(state.navigations, []);
      await f.call("fireTimers");
      assert.deepEqual((await f.snapshot()).navigations, ["http://join.fixture.invalid/dashboard"]);
      await f.checkIsolation();
    });
  }

  await t.test("duplicate captured click and refresh dispatch one POST, not a second acceptance", async () => {
    await ready(f);
    await f.call("capture", accept, "accept");
    await f.call("double", accept);
    await f.until(s => s.calls.length > 0, "Acceptance dispatched");
    await f.call("refresh");
    await f.call("invoke", "accept");
    assert.equal((await f.snapshot()).calls.length, 1, "Synchronous request lock survives refresh and retained callbacks");
    await f.call("reply", 0);
    await f.until(s => s.text.includes("Готово."), "Original acceptance completes");
    await f.call("refresh");
    await f.call("invoke", "accept");
    const state = await f.snapshot();
    assert.equal(state.calls.length, 1);
    assert.ok(state.text.includes("Готово."), "Refresh cannot reopen accepted invitation");
  });

  for (const [status, code, copy] of [
    [403, "workspace_access_denied", "Недостаточно прав"],
    [404, "invitation_not_found", "Приглашение не найдено"],
    [410, "invitation_expired", "Срок приглашения истёк"],
    [409, "invitation_revoked", "Приглашение отозвано"],
    [409, "invitation_accepted", "Это приглашение уже использовано"],
    [403, "invitation_email_mismatch", "Приглашение выписано на другой адрес"],
    [401, "authentication_required", "Сессия истекла"],
  ] as const) {
    await t.test(`current denied/invalid token ${code} remains server-authoritative and retryable`, async () => {
      await ready(f, { stashed: "synthetic-invite" });
      await f.call("click", accept);
      await f.until(s => s.calls.length === 1, "Original request");
      await f.call("reply", 0, { success: false, code, error: "Do not show raw server text" }, status);
      let state = await f.until(s => s.text.includes(copy), "Russian error is preserved");
      noAcceptanceEffects(state);
      assert.equal(state.tab[invitation], "synthetic-invite", "Denied token is not cleared");
      assert.ok(!state.text.includes("Do not show"));
      await f.call("double", retry);
      state = await f.until(s => s.calls.length === 2, "Exactly one current retry");
      assert.equal(state.calls.length, 2);
      assert.deepEqual(state.calls[1].body, state.calls[0].body);
      await f.call("reply", 1);
      await f.until(s => s.text.includes("Готово."), "A fresh confirmed retry works");
    });
  }

  for (const body of [null, {}, { success: false }, { success: true, data: {} }, { success: true, data: { workspaceId: 7 } }]) {
    await t.test(`malformed HTTP success cannot grant membership ${JSON.stringify(body)}`, async () => {
      await ready(f); await f.call("click", accept);
      await f.until(s => s.calls.length === 1, "Original request");
      await f.call("reply", 0, body);
      const state = await f.until(s => s.buttons.some((b: any) => b.label === retry), "Malformed success is retryable");
      noAcceptanceEffects(state);
    });
  }

  await t.test("lost current response remains retryable without optimistic membership", async () => {
    await ready(f); await f.call("click", accept);
    await f.until(s => s.calls.length === 1, "Original request");
    await f.call("lose", 0);
    noAcceptanceEffects(await f.until(s => s.buttons.some((b: any) => b.label === retry), "Lost response error"));
    await f.call("click", retry);
    await f.until(s => s.calls.length === 2, "Current retry request");
    await f.call("reply", 1);
    await f.until(s => s.text.includes("Готово."), "Current retry accepted");
  });

  await t.test("initial lookup failure is caught and can be retried", async () => {
    await f.call("mount", { failLookup: true, strict: false });
    await f.until(s => s.buttons.some((b: any) => b.label === "Проверить снова"), "Failed lookup has a current retry");
    await f.call("capture", "Проверить снова", "lookup-retry");
    await f.call("click", "Проверить снова");
    await f.until(s => s.buttons.some((b: any) => b.label === accept), "Retried lookup resolves");
    await f.call("invoke", "lookup-retry");
    const state = await f.snapshot();
    assert.equal(state.subscriptions.filter((s: any) => s.active).length, 1);
    assert.equal(state.calls.length, 0);
  });

  await t.test("late initial session A cannot replace a newer SDK B session", async () => {
    await f.call("mount", { holdLookups: true, strict: false });
    await f.until(s => s.lookups.length === 1, "Initial A lookup held");
    await f.call("actor", "B");
    await f.call("patch", { user: { id: "B" }, session: { user: { id: "B" } } });
    await f.call("releaseLookups");
    const state = await f.until(s => s.text.includes("b@example.invalid"), "Only current B can become ready");
    assert.ok(!state.text.includes("a@example.invalid"));
    assert.deepEqual(state.inputs, [""]);
    await f.call("click", accept);
    const sent = await f.until(s => s.calls.length === 1, "B explicit acceptance remains usable");
    const jwt = sent.calls[0].authorization.replace(/^Bearer /, "").split(".")[1];
    assert.equal(JSON.parse(Buffer.from(jwt, "base64").toString()).sub, "B");
  });

  await t.test("initial lookup and retained SDK subscription are inert after unmount", async () => {
    await f.call("mount", { holdLookups: true, strict: false });
    await f.until(s => s.lookups.length === 1, "Startup session lookup held");
    await f.call("unmount");
    await f.call("rawEvent", 0);
    await f.call("releaseLookups");
    const state = await f.snapshot();
    assert.equal(state.text, ""); assert.equal(state.calls.length, 0);
    assert.equal(state.subscriptions.filter((s: any) => s.active).length, 0);
    noAcceptanceEffects(state);
  });

  await t.test("late lookup rejection after logout intent cannot publish an error or retry", async () => {
    await f.call("mount", { holdLookups: true, failLookup: true, strict: false });
    await f.until(s => s.lookups.length === 1, "Failing startup lookup held");
    await f.call("markLogout"); await f.call("releaseLookups");
    const state = await f.snapshot();
    assert.ok(state.text.includes("Проверяем приглашение"));
    assert.equal(state.buttons.length, 0); noAcceptanceEffects(state);
  });

  await t.test("same-actor replacement sign-in invalidates a request unlike a token refresh", async () => {
    await ready(f); await f.call("click", accept);
    await f.until(s => s.calls.length === 1, "Original request");
    await f.call("actor", "A");
    await f.call("reply", 0);
    await f.call("fireTimers", true);
    const state = await f.snapshot();
    assert.equal(state.calls[0].aborted, true); noAcceptanceEffects(state);
  });

  await t.test("current unauthenticated login stashes token before leaving", async () => {
    await f.call("mount", { actor: null });
    await f.until(s => s.buttons.some((b: any) => b.label === "У меня есть пароль — войти"), "Current auth action");
    await f.call("click", "У меня есть пароль — войти");
    const state = await f.snapshot();
    assert.equal(state.tab[invitation], "synthetic-invite");
    assert.deepEqual(state.navigations, ["/login"]);
    assert.equal(state.calls.length, 0);
  });

  for (const boundary of boundaries) {
    await t.test(`before access-token resolution: ${boundary} cannot dispatch old invitation data`, async () => {
      await ready(f);
      await f.call("fill", "Old actor draft");
      await f.call("capture", accept, "accept");
      await f.call("capture", switchAccount, "switch");
      await f.call("captureInput");
      await f.set({ holdLookups: true, lookupMode: "latest" });
      await f.call("click", accept);
      await f.until(s => s.lookups.length > 0, "CRM access-token lookup held before HTTP");
      await invalidate(f, boundary);
      await f.call("invoke", "accept"); await f.call("invoke", "switch"); await f.call("invoke", "input");
      await f.call("releaseLookups");
      await f.call("fireTimers", true);
      const state = await f.snapshot();
      assert.equal(state.calls.length, 0, "No old payload may enter a later session, even after token lookup");
      assert.equal(state.signouts, 0, "Retained switch-account cannot log out another session");
      assert.ok(!state.inputs.includes("stale-value"));
      noAcceptanceEffects(state);
    });

    for (const stage of ["reply", "body", "error", "retry"] as const) {
      await t.test(`${stage} after ${boundary} cannot affect a new invitation lifetime`, async () => {
        await ready(f, { stashed: "synthetic-invite" });
        await f.call("click", accept);
        await f.until(s => s.calls.length === 1, "Original acceptance sent");
        if (stage === "retry") {
          await f.call("reply", 0, { success: false, code: "invitation_email_mismatch" }, 403);
          await f.until(s => s.buttons.some((b: any) => b.label === retry), "Current retry visible");
          await f.call("capture", retry, "retry");
          await f.call("capture", "Войти под другой почтой", "switch");
        }
        if (stage === "body") {
          await f.call("reply", 0, { success: true, data: { workspaceId: "synthetic-invited-workspace" } }, 200, true);
          await f.until(s => s.calls[0].bodyUsed, "Actual response bytes are being read");
        }
        await invalidate(f, boundary);
        if (stage === "reply") await f.call("reply", 0);
        if (stage === "error") await f.call("reply", 0, { success: false, code: "invitation_not_found" }, 404);
        if (stage === "body") await f.call("releaseBodies");
        if (stage === "retry") { await f.call("invoke", "retry"); await f.call("invoke", "switch"); }
        await f.call("fireTimers", true);
        const state = await f.snapshot();
        assert.equal(state.calls.length, 1, "Old replies/retries cannot start another request");
        if (boundary !== "logout-tombstone" && stage !== "retry") assert.equal(state.calls[0].aborted, true, "Retired pending transport is aborted");
        assert.equal(state.tab[invitation], "synthetic-invite", "Old success cannot consume the pending token");
        assert.equal(state.signouts, 0);
        noAcceptanceEffects(state);
        if (stage !== "retry") assert.ok(!state.text.includes("Приглашение не найдено"), "Stale error is suppressed");
      });
    }

    await t.test(`already scheduled redirect after ${boundary} is cancelled and retained timer is inert`, async () => {
      await ready(f); await f.call("click", accept);
      await f.until(s => s.calls.length === 1, "Original request");
      await f.call("reply", 0);
      await f.until(s => s.text.includes("Готово."), "Current success schedules navigation");
      await invalidate(f, boundary);
      await f.call("fireTimers", true);
      assert.deepEqual((await f.snapshot()).navigations, []);
    });
  }

  for (const patch of [{ isDemoMode: true }, { isImpersonation: true }]) {
    await t.test(`demo/impersonation transition refuses old acceptance ${JSON.stringify(patch)}`, async () => {
      await ready(f); await f.call("capture", accept, "accept");
      await f.set({ holdLookups: true }); await f.call("click", accept);
      await f.until(s => s.lookups.length > 0, "Token lookup held");
      await f.call("patch", patch); await f.call("releaseLookups"); await f.call("invoke", "accept");
      assert.equal((await f.snapshot()).calls.length, 0);
    });
  }

  await t.test("retained unauthenticated login/recovery callbacks cannot run after sign-in", async () => {
    await f.call("mount", { actor: null });
    await f.until(s => s.buttons.some((b: any) => b.label === "У меня есть пароль — войти"), "Unauthenticated invitation");
    await f.call("fill", "synthetic@example.invalid");
    await f.call("capture", "У меня есть пароль — войти", "login");
    await f.call("capture", "Выслать письмо для пароля", "recovery");
    await f.call("captureInput");
    await f.call("actor", "A");
    await f.call("invoke", "login"); await f.call("invoke", "recovery"); await f.call("invoke", "input");
    const state = await f.snapshot();
    assert.deepEqual(state.navigations, []);
    assert.equal(state.recoveries, 0);
    assert.ok(!state.inputs.includes("stale-value"));
  });

  await t.test("current account switch keeps token but makes its captured action single-use", async () => {
    await ready(f); await f.call("capture", switchAccount, "switch");
    await f.call("click", switchAccount);
    await f.until(s => s.buttons.some((b: any) => b.label === "У меня есть пароль — войти"), "Sign-out returns to invitation auth");
    await f.call("actor", "B");
    await f.call("patch", { user: { id: "B" }, session: { user: { id: "B" } } });
    await f.call("invoke", "switch");
    const state = await f.until(s => s.text.includes("b@example.invalid"), "New current account usable");
    assert.equal(state.signouts, 1);
    assert.equal(state.tab[invitation], "synthetic-invite");
    assert.equal(state.calls.length, 0);
  });

  await t.test("missing token never resolves a session or sends acceptance", async () => {
    await f.call("mount", { missing: true });
    const state = await f.until(s => s.text.includes("Ссылка неполная"), "Incomplete invitation is rejected locally");
    assert.equal(state.calls.length, 0);
    assert.equal(state.subscriptions.filter((s: any) => s.active).length, 0);
    noAcceptanceEffects(state);
  });
  await f.call("cleanup");
  assert.equal((await f.snapshot()).subscriptions.filter((s: any) => s.active).length, 0, "All SDK subscriptions are disposed");
  await f.checkIsolation();
});
