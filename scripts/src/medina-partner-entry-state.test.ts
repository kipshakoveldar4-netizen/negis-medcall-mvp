import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { Script } from "node:vm";

type Row = Record<string, unknown>;
type Operation = "read" | "claim" | "capture";
type Frame = { id: string; startedAt: string; source: string };
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");

async function declarations(file: string, names: string[]) {
  const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected = new Map<string, string>();
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text)) {
      selected.set(statement.name.text, statement.getText(ast));
    } else if (ts.isVariableStatement(statement)) {
      const declared = statement.declarationList.declarations.map(d => d.name.getText(ast));
      if (!declared.some(name => names.includes(name))) continue;
      assert.ok(declared.every(name => names.includes(name)), `${file}: unexpected shared declaration`);
      for (const name of declared) selected.set(name, statement.getText(ast));
    }
  }
  assert.deepEqual([...selected.keys()].sort(), [...names].sort(), `${file}: use actual declarations`);
  return { ast, code: [...new Set(selected.values())].join("\n") };
}

// Extract current code, including the real UUID predicate and handler call flags;
// do not import app bootstrap, configuration, SDKs, or a second parser.
const entry = await declarations("lib/crm/partner-entry.ts", ["record", "keys", "normalizedInstant", "parseResult"]);
const auth = await declarations("lib/auth/server.ts", ["UUID_PATTERN", "isUuidValue"]);
const cookie = await declarations("lib/crm/partner-entry-cookie.ts", ["PARTNER_WINDOW_MS", "PARTNER_POLICY_VERSION"]);
const calls: import("typescript").CallExpression[] = [];
function findParserCall(node: import("typescript").Node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "parseResult") calls.push(node);
  ts.forEachChild(node, findParserCall);
}
findParserCall(entry.ast);
assert.equal(calls.length, 1, "exercise the actual handler's parseResult invocation");
const compiled = ts.transpileModule([
  cookie.code, auth.code, entry.code,
  `exports.parse = (value, frame, op) => { const result = { data: value }; return ${calls[0]!.getText(entry.ast)}; };`,
].join("\n"), {
  fileName: "partner-entry-state.extracted.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
assert.deepEqual(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [], []);
const actual = {} as { parse(value: unknown, frame: Frame, op: Operation): Row | null; PARTNER_POLICY_VERSION: string };
const forbiddenCalls: unknown[][] = [];
function forbidden(...args: unknown[]): never {
  forbiddenCalls.push(args);
  throw Error("No imports or network allowed in the partner-entry parser fixture");
}
new Script(compiled.outputText, { filename: "partner-entry-state.actual.cjs" }).runInNewContext({
  exports: actual, Date, fetch: forbidden, require: forbidden, process: { env: {} },
});

const frame: Frame = { id: "11111111-1111-4111-8111-111111111111", startedAt: "2026-10-27T01:02:03.123Z", source: "link" };
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const captureKeys = ["id", "capturedAt", "expiresAt", "policyVersion"];
const fullKeys = [...captureKeys, "state", "source", "workspaceId"];
const operations: Operation[] = ["read", "claim", "capture"];
const fullOperations: Operation[] = ["read", "claim"];
const states = ["captured", "expired", "pending_payment", "bound"] as const;
function capture(): Row {
  return { id: frame.id, capturedAt: frame.startedAt, expiresAt: "2026-11-03T01:02:03.123Z", policyVersion: actual.PARTNER_POLICY_VERSION };
}
function full(state: typeof states[number] = "captured", source = frame.source): Row {
  return { ...capture(), state, source, workspaceId: state === "pending_payment" || state === "bound" ? workspaceId : null };
}
function parse(value: unknown, op: Operation = "read", expected = frame) {
  return actual.parse(value, expected, op);
}
function accepted(value: Row, op: Operation = "read", expected = frame) {
  const before = Object.getOwnPropertyDescriptors(value);
  assert.strictEqual(parse(value, op, expected), value, `${op}: preserve the verified receipt unchanged`);
  assert.deepEqual(Object.getOwnPropertyDescriptors(value), before, "do not strip, normalize, or mutate the receipt");
}

for (const op of fullOperations) {
  for (const source of ["link", "promo_code"]) {
    test(`${op}: accepts all supported full states for ${source}, including pending_payment and expired-bound`, () => {
      for (const state of states) {
        const value = full(state, source);
        assert.deepEqual(Object.keys(value).sort(), [...fullKeys].sort());
        accepted(Object.freeze(value), op, { ...frame, source });
      }
      accepted(Object.freeze({ ...full("expired", source), workspaceId }), op, { ...frame, source });
    });
  }
}

test("capture accepts only the four-field receipt; read and claim require the full state", () => {
  const receipt = capture();
  assert.deepEqual(Object.keys(receipt).sort(), [...captureKeys].sort());
  accepted(Object.freeze(receipt), "capture");
  for (const op of fullOperations) assert.equal(parse(receipt, op), null, op);
  for (const state of states) assert.equal(parse(full(state), "capture"), null, state);
  assert.equal(parse({ ...full("expired"), workspaceId }, "capture"), null);
});

test("only read accepts the exact unconfirmed sentinel, never capture or claim", () => {
  accepted(Object.freeze({ state: "unconfirmed" }));
  for (const op of ["claim", "capture"] as const) assert.equal(parse({ state: "unconfirmed" }, op), null, op);
  for (const value of [
    { state: "unconfirmed", workspaceId: null }, { state: "unconfirmed", id: frame.id },
    { ...full(), state: "unconfirmed" }, { State: "unconfirmed" }, { state: "UNCONFIRMED" },
    Object.assign(Object.create({ state: "unconfirmed" }), { extra: true }),
  ]) {
    for (const op of operations) assert.equal(parse(value, op), null, `${op}: ${JSON.stringify(value)}`);
  }
});

for (const op of operations) {
  test(`${op}: rejects non-records and empty or unrelated objects`, () => {
    for (const value of [null, undefined, false, true, 0, "", "unconfirmed", [], [full()], () => full(), {}, { success: true, data: full() }]) {
      assert.equal(parse(value, op), null, typeof value);
    }
    assert.equal(parse(Object.assign([], op === "capture" ? capture() : full()), op), null, "arrays with all expected properties");
  });

  test(`${op}: requires every expected key as its own enumerable property, without replacements or extras`, () => {
    const receipts = op === "capture" ? [capture()] : [...states.map(state => full(state)), { ...full("expired"), workspaceId }];
    for (const value of receipts) {
      const expectedKeys = Object.keys(value);
      for (const key of expectedKeys) {
        const missing = { ...value }; delete missing[key];
        assert.equal(parse(missing, op), null, `missing ${key}`);
        assert.equal(parse({ ...missing, replacement: value[key] }, op), null, `substituted ${key}, same key count`);
        const inherited = Object.assign(Object.create({ [key]: value[key] }), missing);
        assert.equal(parse(inherited, op), null, `inherited ${key}`);
        inherited.replacement = true;
        assert.equal(Object.keys(inherited).length, expectedKeys.length);
        assert.equal(parse(inherited, op), null, `inherited ${key} plus filler, same key count`);
        const hidden = Object.defineProperty({ ...missing }, key, { value: value[key], enumerable: false });
        assert.equal(parse(hidden, op), null, `non-enumerable ${key}`);
      }
      for (const extra of ["actorId", "partnerId", "capabilityHash", "unexpected"]) {
        assert.equal(parse({ ...value, [extra]: otherId }, op), null, `extra ${extra}`);
      }
      accepted(Object.assign(Object.create(null), value), op);
      accepted(Object.fromEntries(Object.entries(value).reverse()), op);
    }
  });

  test(`${op}: binds id and policy to the original frame and current policy`, () => {
    const receipts = op === "capture" ? [capture()] : states.map(state => full(state));
    for (const value of receipts) {
      for (const id of [otherId, null, undefined, "", 123, { id: frame.id }]) assert.equal(parse({ ...value, id }, op), null, `id ${JSON.stringify(id)}`);
      assert.equal(parse(value, op, { ...frame, id: otherId }), null, "receipt for a different intent");
      for (const policyVersion of [null, undefined, "", "old-policy", `${actual.PARTNER_POLICY_VERSION} `, { version: actual.PARTNER_POLICY_VERSION }]) {
        assert.equal(parse({ ...value, policyVersion }, op), null, `policy ${JSON.stringify(policyVersion)}`);
      }
    }
  });
}

for (const op of fullOperations) {
  test(`${op}: captured is unbound, expired may be bound, pending_payment and bound require a UUID`, () => {
    for (const state of states) {
      for (const value of [undefined, "", "not-a-uuid", "22222222222242228222222222222222", `${workspaceId}x`, 7, {}, [], { toString: () => workspaceId }]) {
        assert.equal(parse({ ...full(state), workspaceId: value }, op), null, `${state}: ${String(value)}`);
      }
    }
    assert.equal(parse({ ...full("captured"), workspaceId }, op), null, "captured must not be bound");
    accepted({ ...full("expired"), workspaceId: null }, op);
    accepted({ ...full("expired"), workspaceId }, op);
    for (const state of ["pending_payment", "bound"] as const) {
      assert.equal(parse({ ...full(state), workspaceId: null }, op), null, `${state} cannot be unbound`);
      accepted({ ...full(state), workspaceId }, op);
    }
    // isUuidValue is intentionally not a cookie-v4-only validator.
    const generalUuid = "AAAAAAAA-BBBB-1CCC-2DDD-EEEEEEEEEEEE";
    for (const state of ["expired", "pending_payment", "bound"] as const) accepted({ ...full(state), workspaceId: generalUuid }, op);
  });

  test(`${op}: rejects unknown states and sources or a different original source`, () => {
    for (const state of [undefined, null, "", "pending", "paid", "expired-bound", "BOUND", "bound ", 1, ["bound"], { toString: () => "bound" }]) {
      assert.equal(parse({ ...full("bound"), state }, op), null, `state ${JSON.stringify(state)}`);
    }
    for (const state of states) {
      for (const source of [undefined, null, "", "promo_code", "unknown", "LINK", "link ", 1, ["link"]]) {
        assert.equal(parse({ ...full(state), source }, op), null, `${state} source ${JSON.stringify(source)}`);
      }
      assert.equal(parse(full(state), op, { ...frame, source: "promo_code" }), null, `${state}: other frame source`);
    }
  });
}

const malformedDates: unknown[] = [
  undefined, null, 0, new Date(frame.startedAt), "", "not-a-date", "infinity",
  "2026-10-27", "2026-10-27T01:02:03Z", "2026-10-27T01:02:03.12Z",
  "2026-10-27T01:02:03.1230Z", "2026-10-27T01:02:03.123001Z",
  "2026-10-27T01:02:03.123+00:00", "2026-10-27T01:02:03.123z", "2026-10-27T01:02:03.123Z ",
  "2026-02-30T01:02:03.123Z", "2026-13-01T01:02:03.123Z", "2026-10-27T24:00:00.000Z",
];
for (const op of operations) {
  test(`${op}: rejects malformed capture/expiry dates, shifted anchors and any changed seven-day window`, () => {
    const receipts = op === "capture" ? [capture()] : [...states.map(state => full(state)), { ...full("expired"), workspaceId }];
    for (const value of receipts) {
      for (const key of ["capturedAt", "expiresAt"]) {
        for (const date of malformedDates) assert.equal(parse({ ...value, [key]: date }, op), null, `${value.state ?? "capture"} ${key}: ${String(date)}`);
        for (const delta of [-1, 1]) {
          const shifted = new Date(Date.parse(value[key] as string) + delta).toISOString();
          assert.equal(parse({ ...value, [key]: shifted }, op), null, `${key} shifted by ${delta}ms`);
        }
      }
      const shiftedStart = new Date(Date.parse(frame.startedAt) + 1).toISOString();
      assert.equal(parse(value, op, { ...frame, startedAt: shiftedStart }), null, "original cookie anchor differs");
      assert.equal(parse({ ...value, capturedAt: shiftedStart, expiresAt: "2026-11-03T01:02:03.124Z" }, op), null, "moving both timestamps must not reset the window");
    }
  });

  test(`${op}: accepts millisecond UTC and PostgreSQL zero-microsecond padding without rewriting dates`, () => {
    const receipts = op === "capture" ? [capture()] : [...states.map(state => full(state)), { ...full("expired"), workspaceId }];
    for (const value of receipts) {
      for (const padCapture of [false, true]) {
        for (const padExpiry of [false, true]) {
          accepted(Object.freeze({ ...value,
            capturedAt: padCapture ? "2026-10-27T01:02:03.123000Z" : frame.startedAt,
            expiresAt: padExpiry ? "2026-11-03T01:02:03.123000Z" : "2026-11-03T01:02:03.123Z",
          }), op);
        }
      }
    }
  });
}

test("the extracted parser never imports application modules or attempts a network request", () => {
  assert.deepEqual(forbiddenCalls, []);
});
