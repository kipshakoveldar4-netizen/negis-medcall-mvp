import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const file = "artifacts/negis/src/pages/partner-entry-client.ts";
const compiled = ts.transpileModule(await readFile(path.join(root, file), "utf8"), {
  fileName: file, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
assert.deepEqual(compiled.diagnostics ?? [], [], "The actual transport must transpile");

type Operation = "notice" | "prepare" | "capture";
type Init = {
  method: string; credentials: string; mode: string; redirect: string; cache: string;
  referrerPolicy: string; headers: Record<string, string>; body: string; signal: AbortSignal;
};
type Reply = { ok: boolean; json(): Promise<unknown> };
type ClientError = Error & { code: string };
type Client = {
  isPartnerEntryCode(code: string): boolean;
  requestPartnerEntry(op: Operation, body: unknown, signal: AbortSignal): Promise<unknown>;
  PartnerEntryRequestError: new (code: string) => ClientError;
};

function fixture(respond: (url: string, init: Init) => Promise<Reply>) {
  const calls: { url: string; init: Init }[] = [];
  const exports = {};
  const forbidden = new Proxy({}, { get() { assert.fail("No storage or logging is allowed in transport tests"); } });
  new Script(compiled.outputText, { filename: file }).runInNewContext({
    exports, Error, console: forbidden, localStorage: forbidden, sessionStorage: forbidden,
    fetch(url: string, init: Init) { calls.push({ url, init }); return respond(url, init); },
    require(name: string) { assert.fail(`Unexpected transport dependency: ${name}`); },
  });
  return { client: exports as Client, calls };
}

const reply = (value: unknown, ok = true): Reply => ({ ok, json: async () => value });
const code = "ABCDEF0123456789ABCDEF0123456789";
const prepareBody = Object.freeze({ code, source: "link", consent: true,
  consentVersion: "synthetic-v1", challengeToken: "synthetic-challenge-only" });

for (const op of ["notice", "prepare", "capture"] as const) {
  test(`${op}: actual transport sends only anonymous same-origin JSON and unwraps data`, async () => {
    const data = Object.freeze({ synthetic: op });
    const f = fixture(async () => reply({ success: true, data }));
    const controller = new AbortController();
    const body = op === "prepare" ? prepareBody : Object.freeze({});
    assert.equal(await f.client.requestPartnerEntry(op, body, controller.signal), data);
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, `/api/crm/partner-entry?op=${op}`);
    assert.deepEqual(JSON.parse(JSON.stringify(init)), {
      method: "POST", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store",
      referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body), signal: {},
    });
    assert.equal(init.signal, controller.signal);
    assert.equal(Object.keys(init.headers).some(key => /authorization|cookie/i.test(key)), false);
    assert.deepEqual(JSON.parse(init.body), body);
  });
}

test("prepare replay serializes the exact original body without adding identity or time", async () => {
  const f = fixture(async () => reply({ success: true, data: { prepared: true, expiresAt: "synthetic-deadline" } }));
  const signal = new AbortController().signal;
  await f.client.requestPartnerEntry("prepare", prepareBody, signal);
  await f.client.requestPartnerEntry("prepare", prepareBody, signal);
  assert.equal(f.calls[0].init.body, f.calls[1].init.body);
  assert.deepEqual(Object.keys(JSON.parse(f.calls[0].init.body)), ["code", "source", "consent", "consentVersion", "challengeToken"]);
  assert.equal(Object.isFrozen(prepareBody), true);
});

const knownFailures = ["partner_notice_changed", "challenge_failed", "partner_entry_expired", "invalid_partner_cookie",
  "partner_entry_not_prepared", "partner_source_unavailable", "partner_entry_unavailable", "rate_limited"];
for (const code of knownFailures) {
  test(`actual transport preserves the safe failure code ${code}, not server message text`, async () => {
    const f = fixture(async () => reply({ success: false, code, message: prepareBody.challengeToken }, false));
    await assert.rejects(f.client.requestPartnerEntry("prepare", prepareBody, new AbortController().signal), error => {
      assert.ok(error instanceof f.client.PartnerEntryRequestError);
      assert.equal(error.code, code);
      assert.equal(error.name, "PartnerEntryRequestError");
      assert.equal(error.message.includes(prepareBody.challengeToken), false);
      return true;
    });
  });
}

for (const code of [undefined, null, 123, {}, "invalid_request", "partner_source_unconfirmed", "unknown-synthetic-code"]) {
  test(`unknown/nonstring failure code ${JSON.stringify(code)} becomes unconfirmed`, async () => {
    const f = fixture(async () => reply({ success: false, code }, false));
    await assert.rejects(f.client.requestPartnerEntry("capture", {}, new AbortController().signal), error => {
      assert.ok(error instanceof f.client.PartnerEntryRequestError);
      assert.equal(error.code, "unconfirmed");
      return true;
    });
  });
}

const malformed = [null, undefined, false, 0, "payload", [], [{ success: true, data: {} }], {},
  { data: {} }, { success: "true", data: {} }, { success: false, data: {} }, { success: true }];
for (const [index, value] of malformed.entries()) {
  test(`HTTP success alone cannot confirm malformed envelope ${index}`, async () => {
    const f = fixture(async () => reply(value));
    await assert.rejects(f.client.requestPartnerEntry("capture", {}, new AbortController().signal), error => {
      assert.ok(error instanceof f.client.PartnerEntryRequestError);
      assert.equal(error.code, "unconfirmed");
      return true;
    });
  });
}

test("an unsuccessful HTTP response cannot confirm a success-shaped envelope", async () => {
  const f = fixture(async () => reply({ success: true, data: { captured: true } }, false));
  await assert.rejects(f.client.requestPartnerEntry("capture", {}, new AbortController().signal), error => {
    assert.ok(error instanceof f.client.PartnerEntryRequestError);
    assert.equal(error.code, "unconfirmed");
    return true;
  });
});

test("malformed JSON becomes unconfirmed without exposing parser text", async () => {
  const f = fixture(async () => ({ ok: true, json: async () => { throw new SyntaxError(prepareBody.challengeToken); } }));
  await assert.rejects(f.client.requestPartnerEntry("prepare", prepareBody, new AbortController().signal), error => {
    assert.ok(error instanceof f.client.PartnerEntryRequestError);
    assert.equal(error.code, "unconfirmed");
    assert.equal(error.message.includes(prepareBody.challengeToken), false);
    return true;
  });
});

test("network and redirect refusal remain rejections, never a success acknowledgement", async () => {
  for (const failure of [new TypeError("Synthetic offline"), new TypeError("Synthetic redirect refused")]) {
    const f = fixture(async () => { throw failure; });
    await assert.rejects(f.client.requestPartnerEntry("capture", {}, new AbortController().signal), error => error === failure);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.redirect, "error");
  }
});

test("pre-aborted signal is forwarded unchanged to the synthetic fetch boundary", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture(async (_url, init) => { assert.equal(init.signal.aborted, true); throw init.signal.reason; });
  await assert.rejects(f.client.requestPartnerEntry("notice", {}, controller.signal), error => error === controller.signal.reason);
  assert.equal(f.calls[0].init.signal, controller.signal);
});

test("abort during a held request rejects through the original signal without retry", async () => {
  const controller = new AbortController();
  const f = fixture((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const pending = f.client.requestPartnerEntry("capture", {}, controller.signal);
  const rejected = assert.rejects(pending, error => error === controller.signal.reason);
  controller.abort();
  await rejected;
  assert.equal(f.calls.length, 1);
});

test("actual code guard accepts only the canonical uppercase 32-hex path value", () => {
  const f = fixture(async () => { assert.fail("Code validation must not request anything"); });
  assert.equal(f.client.isPartnerEntryCode(code), true);
  for (const invalid of ["", code.toLowerCase(), code.slice(1), `${code}0`, ` ${code}`, `${code}\n`,
    `${code}?source=link`, `/r/${code}`, "%41".repeat(32), "G".repeat(32)]) {
    assert.equal(f.client.isPartnerEntryCode(invalid), false, JSON.stringify(invalid));
  }
  assert.equal(f.calls.length, 0);
});
