import assert from "node:assert/strict";
import test from "node:test";

type Expected = { offset: number; month: string | null };
type HistoryItem = {
  id: string;
  kind: "first_payment" | "renewal" | "payout";
  occurredAt: string;
  amountMinor: string;
  currency: string;
};
type ReadyPage = Expected & {
  state: "ready";
  generatedAt: string;
  items: HistoryItem[];
  hasMore: boolean;
};

const { parsePartnerHistory, PARTNER_HISTORY_PAGE_SIZE } = await import(
  new URL("../../lib/crm/partner-history-contracts.ts", import.meta.url).href
) as {
  PARTNER_HISTORY_PAGE_SIZE: number;
  parsePartnerHistory(value: unknown, expected: Expected): ReadyPage | { state: "not_activated" | "suspended" } | null;
};

const expected: Expected = { offset: 0, month: null };
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nextId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const generatedAt = "2026-10-28T01:02:03.123456Z";

function item(patch: Record<string, unknown> = {}) {
  return { id, kind: "first_payment", occurredAt: "2026-10-27T12:00:00.123456Z", amountMinor: "12345", currency: "KZT", ...patch };
}

function page(patch: Record<string, unknown> = {}) {
  return { state: "ready", generatedAt, offset: 0, month: null, items: [item()], hasMore: false, ...patch };
}

function pageItems(count: number) {
  return Array.from({ length: count }, (_, index) => item({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    occurredAt: `2026-10-27T12:00:${String(59 - index).padStart(2, "0")}Z`,
  }));
}

function accepted(value: unknown, request: Expected = expected): ReadyPage {
  const result = parsePartnerHistory(value, request);
  assert.ok(result, "a valid history page must not be refused");
  assert.equal(result.state, "ready");
  if (result.state !== "ready") assert.fail("expected a ready history page");
  return result;
}

test("the real history parser exposes a twenty-item page and preserves a valid payload", () => {
  assert.equal(PARTNER_HISTORY_PAGE_SIZE, 20);
  const value = page();
  assert.deepEqual(accepted(value), value);
});

for (const state of ["not_activated", "suspended"] as const) {
  test(`${state} is an exact, one-key sentinel even for a filtered subsequent page`, () => {
    assert.deepEqual(parsePartnerHistory({ state }, expected), { state });
    assert.deepEqual(parsePartnerHistory({ state }, { offset: 1_000_000, month: "2026-10" }), { state });
    for (const extra of ["generatedAt", "offset", "month", "items", "hasMore", "privateAuth", "unknown"]) {
      assert.equal(parsePartnerHistory({ state, [extra]: null }, expected), null, extra);
    }
    assert.equal(parsePartnerHistory({ state, items: [] }, expected), null);
  });
}

test("invalid outer values and unrecognized states fail closed", () => {
  for (const value of [undefined, null, true, false, 0, 1, NaN, Infinity, "ready", "{}", [], [page()], {},
    { state: "pending" }, page({ state: null }), page({ state: "READY" })]) {
    assert.equal(parsePartnerHistory(value, expected), null);
  }
});

test("every ready key must be present as an own property", () => {
  for (const key of Object.keys(page())) {
    const value: Record<string, unknown> = page();
    delete value[key];
    assert.equal(parsePartnerHistory(value, expected), null, `missing ${key}`);
    value[`replacement_${key}`] = null;
    assert.equal(parsePartnerHistory(value, expected), null, `substituted ${key}`);
  }
  assert.equal(parsePartnerHistory(Object.assign(Object.create({ generatedAt }), {
    state: "ready", offset: 0, month: null, items: [], hasMore: false, replacement: null,
  }), expected), null);
});

for (const key of ["partnerId", "workspaceId", "actorId", "privateAuth", "total", "nextOffset", "unknown", "__proto__"]) {
  test(`ready payload refuses the unknown key ${key}`, () => {
    assert.equal(parsePartnerHistory({ ...page(), [key]: "must-not-be-returned" }, expected), null);
  });
}

test("an empty, known page is accepted without being confused with unavailable history", () => {
  for (const offset of [0, 1, 19, 20, 999_999, 1_000_000]) {
    const value = page({ offset, items: [] });
    assert.deepEqual(accepted(value, { offset, month: null }), value);
  }
});

for (const offset of [-1, -0.1, 0.5, 20.5, 1_000_001, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity]) {
  test(`invalid offset ${String(offset)} is refused in payloads and expected request context`, () => {
    assert.equal(parsePartnerHistory(page({ offset }), expected), null);
    assert.equal(parsePartnerHistory(page({ offset }), { offset, month: null }), null);
    for (const state of ["not_activated", "suspended"]) {
      assert.equal(parsePartnerHistory({ state }, { offset, month: null }), null);
    }
  });
}

test("offset binding is exact and never coerces caller or response values", () => {
  assert.equal(parsePartnerHistory(page({ offset: 20 }), expected), null);
  assert.equal(parsePartnerHistory(page(), { offset: 20, month: null }), null);
  for (const offset of ["0", "20", null, false, {}, [], 0n]) {
    assert.equal(parsePartnerHistory(page({ offset }), expected), null);
  }
});

for (const month of [null, "0001-01", "2026-01", "2026-12", "9999-12"]) {
  test(`valid month boundary ${String(month)} is retained`, () => {
    const value = page({ month, items: [] });
    assert.deepEqual(accepted(value, { offset: 0, month }), value);
  });
}

for (const month of ["", "0000-01", "2026-00", "2026-13", "2026-1", "026-01", "10000-01", "2026-10-01", " 2026-10", "2026-10 ", "2026-10\n"]) {
  test(`invalid month ${JSON.stringify(month)} is refused even when request and response agree`, () => {
    assert.equal(parsePartnerHistory(page({ month, items: [] }), { offset: 0, month }), null);
    assert.equal(parsePartnerHistory({ state: "not_activated" }, { offset: 0, month }), null);
  });
}

test("month binding is exact, including null, and rejects non-string filters", () => {
  const request = { offset: 0, month: "2026-10" };
  for (const month of [null, "2026-09", "2026-11", 202610, false, [], {}, undefined]) {
    assert.equal(parsePartnerHistory(page({ month }), request), null);
  }
  assert.equal(parsePartnerHistory(page({ month: "2026-10" }), expected), null);
});

test("filtered items must remain inside the requested UTC calendar month", () => {
  const request = { offset: 0, month: "2026-10" };
  const value = page({ month: request.month, items: [
    item({ occurredAt: "2026-10-31T23:59:59.999999Z" }),
    item({ id: nextId, occurredAt: "2026-10-01T00:00:00Z" }),
  ] });
  assert.deepEqual(accepted(value, request), value);
  for (const occurredAt of ["2026-09-30T23:59:59.999999Z", "2026-11-01T00:00:00Z", "2025-10-27T12:00:00Z"]) {
    assert.equal(parsePartnerHistory(page({ month: request.month, items: [item({ occurredAt })] }), request), null);
  }
  assert.ok(accepted(page({ items: [item({ occurredAt: "2026-11-01T00:00:00Z" }),
    item({ id: nextId, occurredAt: "2026-09-30T23:59:59.999999Z" })] })));
});

for (const timestamp of ["0001-01-01T00:00:00Z", "9999-12-31T23:59:59.999999Z", "2000-02-29T12:34:56Z",
  "2024-02-29T12:34:56Z", "2026-10-27T12:34:56Z", "2026-10-27T12:34:56.1Z", "2026-10-27T12:34:56.12Z",
  "2026-10-27T12:34:56.123Z", "2026-10-27T12:34:56.1234Z", "2026-10-27T12:34:56.12345Z", "2026-10-27T12:34:56.123456Z"]) {
  test(`real UTC timestamp ${timestamp} is accepted without losing fractional digits`, () => {
    assert.equal(accepted(page({ generatedAt: timestamp })).generatedAt, timestamp);
    assert.equal(accepted(page({ items: [item({ occurredAt: timestamp })] })).items[0].occurredAt, timestamp);
  });
}

const invalidTimestamps: unknown[] = [
  null, undefined, 0, NaN, Infinity, new Date(generatedAt), "", "2026-10-27", "not-a-date",
  "0000-01-01T00:00:00Z", "10000-01-01T00:00:00Z", "+002026-10-27T00:00:00Z",
  "1900-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z",
  "2026-04-31T00:00:00Z", "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-00T00:00:00Z",
  "2026-01-32T00:00:00Z", "2026-10-27T24:00:00Z", "2026-10-27T12:60:00Z", "2026-10-27T12:00:60Z",
  "2026-10-27T12:00Z", "2026-10-27 12:00:00Z", "2026-10-27t12:00:00z", "2026-10-27T12:00:00",
  "2026-10-27T12:00:00+00:00", "2026-10-27T12:00:00+05:00", "2026-10-27T12:00:00.Z",
  "2026-10-27T12:00:00.1234567Z", " 2026-10-27T12:00:00Z", "2026-10-27T12:00:00Z\n",
];

for (const [index, timestamp] of invalidTimestamps.entries()) {
  test(`invalid UTC timestamp case ${index + 1} is refused for both timestamp fields`, () => {
    assert.equal(parsePartnerHistory(page({ generatedAt: timestamp }), expected), null);
    assert.equal(parsePartnerHistory(page({ items: [item({ occurredAt: timestamp })] }), expected), null);
  });
}

test("items require exactly the five public keys, with no omission or private additions", () => {
  for (const key of Object.keys(item())) {
    const value: Record<string, unknown> = item();
    delete value[key];
    assert.equal(parsePartnerHistory(page({ items: [value] }), expected), null, `missing ${key}`);
    value[`replacement_${key}`] = null;
    assert.equal(parsePartnerHistory(page({ items: [value] }), expected), null, `substituted ${key}`);
  }
  for (const key of ["partnerId", "workspaceId", "paymentId", "payoutId", "email", "privateAuth", "unknown", "__proto__"]) {
    assert.equal(parsePartnerHistory(page({ items: [item({ [key]: "must-not-be-returned" })] }), expected), null, key);
  }
  for (const value of [null, undefined, false, 0, "item", [], [item()]]) {
    assert.equal(parsePartnerHistory(page({ items: [value] }), expected), null);
  }
});

test("UUID versions one through five and RFC variants are accepted and normalized to lowercase", () => {
  for (const version of [1, 2, 3, 4, 5]) {
    for (const variant of ["8", "9", "a", "b"]) {
      const value = `ABCDEFAB-CDEF-${version}ABC-${variant}ABC-ABCDEFABCDEF`;
      assert.equal(accepted(page({ items: [item({ id: value })] })).items[0].id, value.toLowerCase());
    }
  }
});

for (const value of [null, undefined, 123, "", "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa", "not-a-uuid",
  "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-6aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa", "00000000-0000-0000-0000-000000000000",
  "gaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ` ${id}`, `${id}\n`, `${id}0`]) {
  test(`malformed or unsupported UUID ${JSON.stringify(value)} is refused`, () => {
    assert.equal(parsePartnerHistory(page({ items: [item({ id: value })] }), expected), null);
  });
}

test("only the three public event kinds are accepted without coercion", () => {
  for (const kind of ["first_payment", "renewal", "payout"]) {
    assert.equal(accepted(page({ items: [item({ kind })] })).items[0].kind, kind);
  }
  for (const kind of [null, undefined, 0, false, "", "payment", "refund", "FIRST_PAYMENT", "payout ", ["payout"], { toString: () => "payout" }]) {
    assert.equal(parsePartnerHistory(page({ items: [item({ kind })] }), expected), null);
  }
});

test("canonical natural amounts preserve exact strings through the sixty-four-digit boundary", () => {
  for (const amountMinor of ["0", "1", "9007199254740991", "9007199254740992", "9007199254740993",
    "900719925474099301", "1" + "0".repeat(63), "9".repeat(64)]) {
    const result = accepted(page({ items: [item({ amountMinor })] })).items[0].amountMinor;
    assert.equal(typeof result, "string");
    assert.equal(result, amountMinor);
    assert.equal(BigInt(result), BigInt(amountMinor));
  }
  const result = accepted(page({ items: [
    item({ amountMinor: "9007199254740993" }),
    item({ id: nextId, occurredAt: "2026-10-27T12:00:00.123455Z", amountMinor: "9007199254740992" }),
  ] }));
  assert.equal(BigInt(result.items[0].amountMinor) - BigInt(result.items[1].amountMinor), 1n);
});

const invalidAmounts: unknown[] = [null, undefined, true, false, 0, 1, -1, 1.5, NaN, Infinity, -Infinity, 9007199254740992, 1n,
  "", "00", "01", "-0", "-1", "+1", "1.0", "1.5", ".5", "1e3", "1E3", "0x10", "1,000", " 1", "1 ", "1\n",
  "NaN", "Infinity", "9".repeat(65), "0".repeat(65), [], {}, new String("1")];

for (const [index, amountMinor] of invalidAmounts.entries()) {
  test(`noncanonical or non-string amount case ${index + 1} is refused`, () => {
    assert.equal(parsePartnerHistory(page({ items: [item({ amountMinor })] }), expected), null);
  });
}

test("currency is exactly three uppercase ASCII letters, not a coerced or trimmed value", () => {
  for (const currency of ["KZT", "USD", "EUR", "AAA", "ZZZ"]) {
    assert.equal(accepted(page({ items: [item({ currency })] })).items[0].currency, currency);
  }
  for (const currency of [null, undefined, 123, "", "KZ", "KZTT", "kzt", "KzT", "US1", " KZT", "KZT ", "KZT\n", ["KZT"], new String("KZT")]) {
    assert.equal(parsePartnerHistory(page({ items: [item({ currency })] }), expected), null);
  }
});

test("page-size boundaries and hasMore must agree exactly", () => {
  for (const count of [0, 1, 19, 20]) {
    const value = page({ items: pageItems(count) });
    assert.deepEqual(accepted(value), value);
  }
  const full = page({ items: pageItems(20), hasMore: true });
  assert.deepEqual(accepted(full), full);
  for (const count of [0, 1, 19, 21]) {
    assert.equal(parsePartnerHistory(page({ items: pageItems(count), hasMore: true }), expected), null);
  }
  assert.equal(parsePartnerHistory(page({ items: pageItems(21), hasMore: false }), expected), null);
  for (const hasMore of [undefined, null, 0, 1, "true", "false", [], {}]) {
    assert.equal(parsePartnerHistory(page({ items: pageItems(20), hasMore }), expected), null);
  }
  for (const items of [undefined, null, {}, "[]", 20, new Array(1)]) {
    assert.equal(parsePartnerHistory(page({ items }), expected), null);
  }
});

test("duplicate composite event identities are refused, including case-only UUID differences", () => {
  for (const duplicate of [item(), item({ id: id.toUpperCase() }),
    item({ occurredAt: "2026-10-26T12:00:00Z", amountMinor: "999", currency: "USD" })]) {
    assert.equal(parsePartnerHistory(page({ items: [item(), duplicate] }), expected), null);
  }
  assert.equal(parsePartnerHistory(page({ items: [item(),
    item({ id: nextId, occurredAt: "2026-10-26T12:00:00Z" }),
    item({ occurredAt: "2026-10-25T12:00:00Z" }),
  ] }), expected), null);
});

test("the same UUID may identify different event kinds in ASCII kind order", () => {
  const value = page({ items: [item({ kind: "first_payment" }), item({ kind: "payout", id: id.toUpperCase() }), item({ kind: "renewal" })] });
  const result = accepted(value);
  assert.deepEqual(result.items.map(entry => [entry.kind, entry.id]), [
    ["first_payment", id], ["payout", id], ["renewal", id],
  ]);
  assert.equal(parsePartnerHistory(page({ items: [item({ kind: "renewal" }), item({ kind: "payout" })] }), expected), null);
});

test("descending instants outrank kind and UUID order and are never silently re-sorted", () => {
  const newer = item({ id: nextId, kind: "renewal", occurredAt: "2026-10-28T00:00:00Z" });
  const older = item({ kind: "first_payment", occurredAt: "2026-10-27T23:59:59.999999Z" });
  const value = page({ items: [newer, older] });
  assert.deepEqual(accepted(value), value);
  assert.equal(parsePartnerHistory(page({ items: [older, newer] }), expected), null);
});

test("ordering compares all six fractional digits instead of Date.parse milliseconds", () => {
  const newer = item({ id: nextId, occurredAt: "2026-10-27T12:00:00.123456Z" });
  const older = item({ occurredAt: "2026-10-27T12:00:00.123455Z" });
  const value = page({ items: [newer, older] });
  assert.deepEqual(accepted(value), value);
  assert.equal(parsePartnerHistory(page({ items: [older, newer] }), expected), null);
});

test("differently sized fractions are normalized before comparing timestamps", () => {
  for (const [newerTime, olderTime] of [
    ["2026-10-27T12:00:00.1Z", "2026-10-27T12:00:00.099999Z"],
    ["2026-10-27T12:00:00.000001Z", "2026-10-27T12:00:00Z"],
    ["2026-10-27T12:00:00.12345Z", "2026-10-27T12:00:00.123449Z"],
  ]) {
    const newer = item({ id: nextId, occurredAt: newerTime });
    const older = item({ occurredAt: olderTime });
    assert.deepEqual(accepted(page({ items: [newer, older] })).items, [newer, older]);
    assert.equal(parsePartnerHistory(page({ items: [older, newer] }), expected), null);
  }
});

test("equivalent fractions use kind then lowercase UUID as deterministic tiebreakers", () => {
  for (const [firstTime, secondTime] of [
    ["2026-10-27T12:00:00Z", "2026-10-27T12:00:00.000000Z"],
    ["2026-10-27T12:00:00.1Z", "2026-10-27T12:00:00.100000Z"],
    ["2026-10-27T12:00:00.12345Z", "2026-10-27T12:00:00.123450Z"],
  ]) {
    const first = item({ occurredAt: firstTime });
    const second = item({ id: nextId.toUpperCase(), occurredAt: secondTime });
    const result = accepted(page({ items: [first, second] }));
    assert.deepEqual(result.items, [first, { ...second, id: nextId }]);
    assert.equal(parsePartnerHistory(page({ items: [second, first] }), expected), null);
    const payout = item({ id, kind: "payout", occurredAt: secondTime });
    assert.ok(accepted(page({ items: [first, payout] })));
    assert.equal(parsePartnerHistory(page({ items: [payout, first] }), expected), null);
  }
});

test("an invalid row anywhere rejects the whole page without mutating the original payload", () => {
  const value = page({ items: [item({ id: id.toUpperCase() }),
    item({ id: nextId, occurredAt: "2026-10-26T00:00:00Z" }),
  ] });
  const original = structuredClone(value);
  assert.equal(accepted(value).items[0].id, id);
  assert.deepEqual(value, original);
  assert.equal(parsePartnerHistory(page({ items: [value.items[0], item({ id: nextId, amountMinor: "01" })] }), expected), null);
  assert.deepEqual(value, original);
});
