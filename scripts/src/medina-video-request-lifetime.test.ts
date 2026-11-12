import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

const actual = await import(new URL("../../lib/content-studio/video-request-lifetime.ts", import.meta.url).href);
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

test("video lifetime expires at 50 seconds even when an operation ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lifetime = new actual.VideoRequestLifetime(); t.after(() => lifetime.close());
  let ended = false, calls = 0;
  const pending = lifetime.run(() => { calls++; return new Promise<never>(() => {}); }).catch((error: unknown) => { ended = true; return error; });
  await flush(); t.mock.timers.tick(49_999); await flush(); assert.equal(ended, false);
  t.mock.timers.tick(1); await flush(); assert.equal(ended, true); assert.equal(calls, 1);
  assert.ok(await pending instanceof actual.VideoRequestDeadlineError); assert.equal(lifetime.signal.aborted, true);
});

test("retirement before the dispatch microtask prevents the operation entirely", async () => {
  const lifetime = new actual.VideoRequestLifetime(); let calls = 0;
  const pending = lifetime.run(() => calls++); lifetime.close();
  await assert.rejects(pending, actual.VideoRequestDeadlineError); assert.equal(calls, 0);
  await assert.rejects(lifetime.run(() => calls++), actual.VideoRequestDeadlineError); assert.equal(calls, 0);
});

test("a monotonic deadline rejects a late result even before the timer callback gets a turn", async t => {
  let now = 1; t.mock.method(performance, "now", () => now);
  const lifetime = new actual.VideoRequestLifetime(); t.after(() => lifetime.close());
  await assert.rejects(lifetime.run(() => { now = 50_001; return "late"; }), actual.VideoRequestDeadlineError);
  assert.equal(lifetime.signal.aborted, true);
});

test("remaining per-stage time cannot reset the total request deadline", async t => {
  let now = 100; t.mock.method(performance, "now", () => now);
  const lifetime = new actual.VideoRequestLifetime(); t.after(() => lifetime.close());
  assert.equal(lifetime.remainingMs(15000), 15000); now += 49_000;
  assert.equal(lifetime.remainingMs(15000), 1000); now += 999.5; assert.equal(lifetime.remainingMs(15000), 1);
  now += 0.5; assert.throws(() => lifetime.remainingMs(15000), actual.VideoRequestDeadlineError);
});

test("step timeout may reconcile within the same request but cannot extend its total lifetime", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lifetime = new actual.VideoRequestLifetime(); t.after(() => lifetime.close());
  let ended = false; const first = lifetime.run(() => new Promise<never>(() => {}), 20_000).catch(() => { ended = true; });
  await flush(); t.mock.timers.tick(20_000); await flush(); assert.equal(ended, true); await first;
  assert.equal(lifetime.signal.aborted, false);
  const second = lifetime.run(() => new Promise<never>(() => {}), 20_000).catch(() => {});
  await flush(); t.mock.timers.tick(20_000); await second;
  let final = false; const third = lifetime.run(() => new Promise<never>(() => {}), 20_000).catch((error: unknown) => { final = true; return error; });
  await flush(); t.mock.timers.tick(10_000); await flush(); assert.equal(final, true);
  assert.ok(await third instanceof actual.VideoRequestDeadlineError);
});

test("invalid total and step budgets cannot dispatch an operation", async () => {
  for (const value of [0, -1, 50001, 1.5, NaN, Infinity]) assert.throws(() => new actual.VideoRequestLifetime(value));
  const lifetime = new actual.VideoRequestLifetime(); let calls = 0;
  try { for (const value of [0, -1, 50001, 1.5, NaN, Infinity]) {
    await assert.rejects(lifetime.run(() => calls++, value)); await flush(); assert.equal(calls, 0);
  } } finally { lifetime.close(); }
});
