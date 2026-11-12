import assert from "node:assert/strict";
import test from "node:test";

type Row = Record<string, unknown>;
type Group = "new" | "in_progress" | "booked" | "postponed" | "lost" | "other";
type Query = { search: string; group: "all" | Group; requestId: string | null; offset: number };
type Company = { requestId: string; displayName: string; leadScope: "assigned" | "clinic" };
type Lead = { id: string; requestId: string; name: string; phone: string; status: string;
  stageId: string | null; stageName: string; group: Group; source: string; createdAt: string | null };
type Stages = { requestId: string; items: { id: string; name: string }[] };
type Report = { generatedAt: string; offset: number; filters: Pick<Query, "group" | "requestId">; companies: Company[];
  totals: Record<"all" | Group, string>; matched: string; items: Lead[]; stageOptions: Stages[]; hasMore: boolean };

const { parseOperatorLeadSearchBody, parseOperatorLeadSearchReport, parseOperatorLeadSearchRpcReport, OPERATOR_LEAD_SEARCH_PATH,
  OPERATOR_LEAD_SEARCH_PAGE_SIZE, operatorLeadGroups, operatorLeadGroupLabels } = await import(
  new URL("../../lib/crm/operator-lead-search-contracts.ts", import.meta.url).href
) as {
  parseOperatorLeadSearchBody(value: unknown): Query | null;
  parseOperatorLeadSearchReport(value: unknown, expected: Query): Report | null;
  parseOperatorLeadSearchRpcReport(value: unknown, expected: Query): Report | null;
  OPERATOR_LEAD_SEARCH_PATH: string;
  OPERATOR_LEAD_SEARCH_PAGE_SIZE: number;
  operatorLeadGroups: readonly Group[];
  operatorLeadGroupLabels: Record<"all" | Group, string>;
};

const groups: Group[] = ["new", "in_progress", "booked", "postponed", "lost", "other"];
const allGroups = ["all", ...groups] as const;
const requestA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const stageA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const stageB = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const generatedAt = "2026-10-28T01:02:03.123456Z";
const maxCount = "9223372036854775807";
const fixtureId = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

function query(patch: Partial<Query> = {}): Query {
  return { search: "", group: "all", requestId: null, offset: 0, ...patch };
}

function company(patch: Row = {}): Company {
  return { requestId: requestA, displayName: "Clinic A", leadScope: "assigned", ...patch } as Company;
}

function lead(patch: Row = {}): Lead {
  return { id: fixtureId(1), requestId: requestA, name: "Same contact", phone: "+77011234567", status: "new",
    stageId: stageA, stageName: "New", group: "new", source: "Website", createdAt: generatedAt, ...patch } as Lead;
}

function totals(patch: Row = {}): Report["totals"] {
  return { all: "1", new: "1", in_progress: "0", booked: "0", postponed: "0", lost: "0", other: "0", ...patch } as Report["totals"];
}

function report(patch: Row = {}): Report {
  return { generatedAt, offset: 0, filters: { group: "all", requestId: null }, companies: [company()],
    totals: totals(), matched: "1", items: [lead()], stageOptions: [{ requestId: requestA, items: [{ id: stageA, name: "New" }] }],
    hasMore: false, ...patch } as Report;
}

function empty(patch: Row = {}): Report {
  return report({ totals: totals({ all: "0", new: "0" }), matched: "0", items: [], stageOptions: [], ...patch });
}

function complete(): Report {
  return report({ companies: [company(), company({ requestId: requestB, displayName: "Clinic B", leadScope: "clinic" })],
    totals: totals({ all: "6", new: "1", in_progress: "1", booked: "1", postponed: "1", lost: "1", other: "1" }), matched: "6",
    items: groups.map((group, index) => lead({ id: fixtureId(index + 1), group,
      requestId: index < 3 ? requestA : requestB, stageId: index < 3 ? stageA : stageB,
      createdAt: `2026-10-28T01:02:0${5 - index}.123456Z` })),
    stageOptions: [{ requestId: requestA, items: [{ id: stageA, name: "Active A" }] },
      { requestId: requestB, items: [{ id: stageB, name: "Active B" }] }] });
}

function page(count: string, offset: number, length: number, hasMore: boolean, group: Group = "new"): Report {
  return report({ offset, totals: totals({ new: "0", all: count, [group]: count }), matched: count,
    items: Array.from({ length }, (_, index) => lead({ id: fixtureId(index + 1), group })),
    stageOptions: length === 0 ? [] : report().stageOptions, hasMore });
}

function accepted(value: unknown, expected = query()): Report {
  const parsed = parseOperatorLeadSearchReport(value, expected);
  assert.ok(parsed, "a complete valid report must be accepted");
  return parsed;
}

function refused(value: unknown, label: string, ...expectedQuery: [unknown?]) {
  const expected = expectedQuery.length === 0 ? query() : expectedQuery[0];
  assert.ok(parseOperatorLeadSearchReport(value, expected as Query) === null, label);
}

test("the actual exports expose exactly six stage groups plus all and a twenty-row page", () => {
  assert.equal(OPERATOR_LEAD_SEARCH_PAGE_SIZE, 20);
  assert.deepEqual(operatorLeadGroups, groups);
  assert.deepEqual(Object.keys(operatorLeadGroupLabels), allGroups);
  for (const group of allGroups) assert.ok(operatorLeadGroupLabels[group].trim());
  assert.deepEqual(accepted(complete()), complete());
});

test("JSON body defaults, trimmed search and lowercase request UUIDs are canonical", () => {
  assert.deepEqual(parseOperatorLeadSearchBody({}), query());
  assert.deepEqual(parseOperatorLeadSearchBody({ search: "  Alice +7701 %_  ", group: "postponed",
    requestId: requestA.toUpperCase(), offset: 21 }), query({ search: "Alice +7701 %_", group: "postponed", requestId: requestA, offset: 21 }));
  assert.deepEqual(parseOperatorLeadSearchBody({ search: "   ", requestId: null }), query());
  assert.deepEqual(parseOperatorLeadSearchBody({ search: "a".repeat(120) }), query({ search: "a".repeat(120) }));
  for (const group of allGroups) assert.deepEqual(parseOperatorLeadSearchBody({ group }), query({ group }));
  assert.equal(parseOperatorLeadSearchBody({ search: "a".repeat(121) }), null);
});

test("JSON body must be an object and refuses unknown authority, pagination and private selectors", () => {
  for (const body of [undefined, null, [], 0, true, "{}", new Date(), Buffer.alloc(0)]) {
    assert.equal(parseOperatorLeadSearchBody(body), null);
  }
  for (const key of ["unknown", "path", "__proto__", "actorId", "workspaceId", "companyId", "leadId", "limit", "pageSize", "sort", "clock", "now", "stageId"]) {
    assert.equal(parseOperatorLeadSearchBody({ [key]: "injected" }), null, key);
  }
  for (const field of ["search", "group", "requestId", "offset"]) {
    for (const value of [[], ["all"], [requestA], ["0", "20"], {}, false, ...(field === "offset" ? [] : [1]), ...(field === "requestId" ? [] : [null])]) {
      assert.equal(parseOperatorLeadSearchBody({ [field]: value }), null, `${field} must never coerce ${String(value)}`);
    }
  }
  for (const group of ["", "ALL", "NEW", "new ", "unknown", "closed"]) assert.equal(parseOperatorLeadSearchBody({ group }), null);
  for (const search of ["name\n", "name\r", "name\t", "name\u0000", "name\u007f"]) {
    assert.equal(parseOperatorLeadSearchBody({ search }), null, "controls cannot disappear during trimming");
  }
});

test("body offsets are JSON integers from zero through one million", () => {
  for (const offset of [0, 1, 19, 20, 21, 999_999, 1_000_000]) {
    assert.deepEqual(parseOperatorLeadSearchBody({ offset }), query({ offset }));
  }
  for (const offset of ["", "0", "00", "20", "20\n", "1.0", "1e1", -1, 0.5, 1_000_001, NaN, Infinity, 1n]) {
    assert.equal(parseOperatorLeadSearchBody({ offset }), null, `offset ${String(offset)}`);
  }
});

for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
  test(`body rejects a request UUID with trailing ${JSON.stringify(suffix)}`, () => {
    assert.equal(parseOperatorLeadSearchBody({ requestId: `${requestA}${suffix}` }), null);
  });
}

test("the path is fixed and every filter round-trips through JSON only", () => {
  assert.equal(OPERATOR_LEAD_SEARCH_PATH, "operator-lead-search");
  const expected = query({ search: "A +7701 %_ &group=lost ?/#=", group: "in_progress", requestId: requestB, offset: 1_000_000 });
  assert.deepEqual(parseOperatorLeadSearchBody(JSON.parse(JSON.stringify(expected))), expected);
});

test("invalid and unavailable outer values are not converted to a successful empty report", () => {
  for (const value of [undefined, null, true, false, 0, NaN, Infinity, "{}", [], [report()], {}, new Date(),
    { success: false, error: "unavailable" }, { state: "unavailable" }, { success: true, data: report() }]) {
    refused(value, `invalid outer value ${String(value)}`);
  }
  assert.deepEqual(accepted(empty()), empty());
  assert.deepEqual(accepted(empty({ companies: [] })), empty({ companies: [] }));
  refused(empty({ totals: null, matched: null }), "unknown counts are not confirmed zero");
  refused(empty({ totals: {}, matched: "0" }), "missing groups are not zero");
  refused(report({ companies: [] }), "nonzero counts require an authorized manifest");
});

test("an exhausted empty page cannot give an empty manifest nonzero totals", () => {
  const value = empty({ companies: [], offset: 1, totals: totals(), matched: "1" });
  refused(value, "paging, group arithmetic and stage coverage are valid but there is no authorized company", query({ offset: 1 }));
});

const recordTargets = ["report", "filters", "company", "totals", "lead", "stageOptions", "stage"] as const;
function recordAt(value: Report, target: typeof recordTargets[number]): Row {
  switch (target) {
    case "report": return value as unknown as Row;
    case "filters": return value.filters;
    case "company": return value.companies[0];
    case "totals": return value.totals;
    case "lead": return value.items[0];
    case "stageOptions": return value.stageOptions[0];
    case "stage": return value.stageOptions[0].items[0];
  }
}

for (const target of recordTargets) {
  test(`${target} requires every public key as an own property`, () => {
    for (const key of Object.keys(recordAt(report(), target))) {
      const value = report(), row = recordAt(value, target), original = row[key];
      delete row[key];
      refused(value, `${target}.${key} missing`);
      row[`replacement_${key}`] = original;
      refused(value, `${target}.${key} substituted`);
      delete row[`replacement_${key}`];
      Object.setPrototypeOf(row, { [key]: original });
      refused(value, `${target}.${key} inherited`);
    }
  });
  for (const key of ["unknown", "privateAuth", "actorId", "workspaceId", "companyId", "leadId", "clientId", "appointmentId",
    "accessToken", "authorization", "notes", "medicalHistory", "priceMinor", "amountMinor", "currency", "commissionMinor", "payoutMinor", "__proto__"]) {
    test(`${target} refuses the extra private field ${key} without stripping it`, () => {
      const value = report();
      Object.defineProperty(recordAt(value, target), key, { value: "must-not-leak", enumerable: true, configurable: true });
      refused(value, `${target}.${key} must refuse the whole response`);
    });
  }
}

test("nested records and collections refuse null, primitive, array and sparse substitutions", () => {
  for (const invalid of [null, undefined, false, 0, "[]", {}]) {
    refused(report({ companies: invalid }), "companies must be an array");
    refused(report({ items: invalid }), "leads must be an array");
    refused(report({ stageOptions: invalid }), "stage options must be an array");
    const value = report();
    (value.stageOptions[0] as unknown as Row).items = invalid;
    refused(value, "active stage items must be an array");
  }
  for (const invalid of [null, undefined, false, 0, "row", []]) {
    refused(report({ filters: invalid }), "filters must be a record");
    refused(report({ totals: invalid }), "totals must be a record");
    refused(report({ companies: [invalid] }), "company must be a record");
    refused(report({ items: [invalid] }), "lead must be a record");
    refused(report({ stageOptions: [invalid] }), "stage list must be a record");
    refused(report({ stageOptions: [{ requestId: requestA, items: [invalid] }] }), "stage must be a record");
  }
  refused(report({ companies: new Array(1) }), "sparse manifest");
  refused(report({ items: new Array(1) }), "sparse lead page");
  refused(report({ stageOptions: new Array(1) }), "sparse stage lists");
  refused(report({ stageOptions: [{ requestId: requestA, items: new Array(1) }] }), "sparse stages");
});

for (const group of allGroups) {
  test(`${group} selection preserves all seven server totals and binds matched only to the selected group`, () => {
    const value = complete();
    value.filters.group = group;
    if (group !== "all") {
      value.items = value.items.filter(item => item.group === group);
      value.matched = "1";
      value.stageOptions = value.stageOptions.filter(stages => stages.requestId === value.items[0].requestId);
    }
    assert.deepEqual(accepted(value, query({ group })), value);
    const mismatch = structuredClone(value);
    mismatch.filters.group = group === "all" ? "new" : "all";
    refused(mismatch, "selected group must echo the request", query({ group }));
  });
}

test("RPC search echo is checked exactly, stripped for HTTP, and refused by the public parser", () => {
  const expected = query({ search: "Synthetic Alice +77015551234", group: "new", requestId: requestA, offset: 1 });
  const value = empty({ offset: 1, filters: { group: "new", requestId: requestA } });
  const rpc = { ...value, filters: { ...value.filters, search: expected.search } };
  assert.deepEqual(parseOperatorLeadSearchRpcReport(rpc, expected), value);
  assert.equal(parseOperatorLeadSearchRpcReport(value, expected), null, "missing RPC echo");
  refused(rpc, "even a correct search echo is not allowed over HTTP", expected);
  assert.deepEqual(accepted(value, expected), value);
  for (const search of ["", expected.search.toLowerCase(), " " + expected.search, null]) {
    assert.equal(parseOperatorLeadSearchRpcReport({ ...rpc, filters: { ...rpc.filters, search } }, expected), null);
  }
  for (const [field, mismatch] of [["group", "all"],
    ["requestId", null], ["requestId", requestB], ["requestId", requestA.toUpperCase()]] as const) {
    const changed = structuredClone(value);
    (changed.filters as Row)[field] = mismatch;
    refused(changed, `filter ${field} must echo exactly`, expected);
  }
  refused({ ...value, offset: 0 }, "response offset must echo exactly", expected);
  refused(value, "a selected request must exist even on an empty page", { ...expected, requestId: requestB });
});

test("expected queries themselves must be canonical before any report is accepted", () => {
  for (const expected of [null, undefined, {}, [], false, query({ search: " padded " }), query({ search: "a".repeat(121) }),
    query({ search: "a\n" }), query({ group: "unknown" as Group }), query({ requestId: requestA.toUpperCase() }),
    query({ requestId: "bad" })]) {
    refused(empty(), "invalid expected query must fail closed", expected);
  }
  for (const offset of [-1, 0.5, 1_000_001, NaN, Infinity, "0", null, undefined, false, [], {}, 0n]) {
    refused(empty({ offset }), `invalid expected and response offset ${String(offset)}`, { ...query(), offset });
  }
  for (const offset of [0, 1, 19, 20, 21, 999_999, 1_000_000]) {
    const value = empty({ offset });
    assert.deepEqual(accepted(value, query({ offset })), value);
    refused(value, "wrong response offset", query({ offset: offset === 0 ? 1 : 0 }));
  }
});

test("matching response echoes cannot legitimize a noncanonical expected search", () => {
  for (const search of [" padded ", "a".repeat(121), "control\n", "control\u0000", null, undefined, 1, false, []]) {
    const expected = { ...query(), search };
    const value = empty();
    assert.equal(parseOperatorLeadSearchRpcReport({ ...value, filters: { ...value.filters, search } }, expected as Query), null);
  }
});

test("selected group and company membership are checked beyond matching filter echoes", () => {
  const selected = report({ companies: complete().companies, filters: { group: "all", requestId: requestA } });
  assert.deepEqual(accepted(selected, query({ requestId: requestA })), selected);
  const value = complete();
  value.filters.requestId = requestA;
  refused(value, "a manifest member from company B cannot enter an A-only result", query({ requestId: requestA }));
  const groupMismatch = report({ filters: { group: "new", requestId: null },
    totals: totals({ all: "2", other: "1" }), items: [lead({ group: "other" })] });
  refused(groupMismatch, "group counts and page size agree but the row is from another group", query({ group: "new" }));
  const foreign = report({ items: [lead({ requestId: requestC })], stageOptions: [{ requestId: requestC, items: [] }] });
  refused(foreign, "unknown request must not be authorized by a matching stage list");
  const missing = empty({ companies: [] });
  missing.filters.requestId = requestA;
  refused(missing, "zero results cannot fabricate authorization", query({ requestId: requestA }));
});

for (const group of groups) {
  test(`${group} counts retain exact int64 decimal strings, never Number precision`, () => {
    for (const [count, length, hasMore] of [["0", 0, false], ["1", 1, false], ["9007199254740991", 20, true],
      ["9007199254740992", 20, true], ["9007199254740993", 20, true], [maxCount, 20, true]] as const) {
      const value = page(count, 0, length, hasMore, group);
      assert.deepEqual(accepted(value), value);
      value.filters.group = group;
      assert.deepEqual(accepted(value, query({ group })), value);
    }
  });
}

const invalidCounts: unknown[] = [null, undefined, false, true, 0, 1, -1, 1.5, NaN, Infinity, 1n, [], {}, new String("1"),
  "", "00", "01", "-0", "-1", "+1", "1.0", "1e0", "0x1", "1,000", " 1", "1 ",
  "NaN", "Infinity", "9223372036854775808", "9999999999999999999", "10000000000000000000"];

for (const [index, count] of invalidCounts.entries()) {
  test(`invalid count case ${index + 1} is refused in each of the seven totals and matched`, () => {
    for (const field of allGroups) refused(report({ totals: totals({ [field]: count }) }), `totals.${field}: ${String(count)}`);
    refused(report({ matched: count }), `matched: ${String(count)}`);
  });
}

for (const field of allGroups) {
  test(`totals.${field} refuses noncanonical one-count representations with exact arithmetic and page coverage`, () => {
    for (const count of [1, 1n, true, "01", "+1", " 1", "1 ", "0x1"]) {
      const group: Group = field === "all" ? "new" : field;
      const value = page("1", 0, 1, false, group);
      (value.totals as Row)[field] = count;
      const expected = query({ group: field === "all" ? "new" : "all" });
      value.filters.group = expected.group;
      refused(value, "the altered bucket is not selected, so matched still agrees exactly with its valid selected total", expected);
    }
  });
}

for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
  for (const field of allGroups) {
    test(`totals.${field} refuses trailing ${JSON.stringify(suffix)} while arithmetic and paging remain valid`, () => {
      const value = page("1", 0, 1, false, field === "all" ? "new" : field);
      value.totals[field] = `1${suffix}`;
      if (field === "all") value.matched = `1${suffix}`;
      refused(value, `totals.${field} is not a canonical decimal string`);
    });
  }
  test(`matched refuses trailing ${JSON.stringify(suffix)} even when it equals the selected bucket`, () => {
    const value = report({ matched: `1${suffix}`, totals: totals({ all: `1${suffix}` }) });
    refused(value, "matched and selected total agree numerically but are not canonical");
  });
}

test("all totals equal the exact sum of six groups, including precision and int64 overflow boundaries", () => {
  const exact = page(maxCount, 0, 20, true);
  exact.totals.new = "9223372036854775806";
  exact.totals.other = "1";
  assert.deepEqual(accepted(exact), exact);
  for (const patch of [{ all: "9007199254740992", new: "9007199254740993" },
    { all: "9007199254740993", new: "9007199254740992" },
    { all: maxCount, new: maxCount, other: "1" }, { all: "2", new: "1" }]) {
    const value = page(patch.all, 1_000_000, patch.all === "2" ? 0 : 20, patch.all !== "2");
    value.totals = totals(patch);
    refused(value, "bucket sum mismatch is not hidden by Number rounding", query({ offset: 1_000_000 }));
  }
});

test("matched equality and every visible group lower bound are independent of sum and page length", () => {
  const matched = page("2", 0, 1, false);
  matched.matched = "1";
  refused(matched, "matched=1 has a full final page but disagrees with selected all=2");
  for (const group of groups) {
    const other: Group = group === "new" ? "other" : "new";
    const value = page("1", 0, 1, false, other);
    value.items[0].group = group;
    refused(value, `a visible ${group} row cannot have a zero ${group} count`);
  }
});

const validPages = [
  ["0", 0, 0, false], ["1", 0, 1, false], ["19", 0, 19, false], ["20", 0, 20, false],
  ["21", 0, 20, true], ["21", 1, 20, false], ["21", 19, 2, false], ["21", 20, 1, false],
  ["21", 21, 0, false], ["21", 22, 0, false], ["41", 20, 20, true], ["41", 40, 1, false],
  ["1000001", 1_000_000, 1, false], [maxCount, 1_000_000, 20, true],
] as const;

for (const [count, offset, length, hasMore] of validPages) {
  test(`complete page: matched=${count} offset=${offset} rows=${length} hasMore=${hasMore}`, () => {
    const value = page(count, offset, length, hasMore);
    assert.deepEqual(accepted(value, query({ offset })), value);
    refused({ ...value, hasMore: !hasMore }, "hasMore is exact, not a hint", query({ offset }));
    if (length > 0) {
      const partial = structuredClone(value);
      partial.items.pop();
      if (length === 1) partial.stageOptions = [];
      refused(partial, "a short page cannot pass as complete", query({ offset }));
    }
  });
}

test("the twenty-plus-one sentinel is never exposed and empty or partial pages cannot mask more rows", () => {
  for (const [count, offset, length, hasMore] of [["21", 0, 21, false], ["21", 0, 19, true],
    ["21", 20, 0, true], ["21", 21, 1, false], ["20", 0, 19, false], ["0", 0, 1, false]] as const) {
    refused(page(count, offset, length, hasMore), "page cardinality must be exact", query({ offset }));
  }
  for (const hasMore of [0, 1, "false", "true", null, undefined]) refused(report({ hasMore }), "hasMore is a boolean");
});

test("the complete manifest remains sorted and intact on selected-company and later empty pages up to 1000", () => {
  for (const length of [0, 1, 20, 21, 999, 1000]) {
    const companies = Array.from({ length }, (_, index) => company({ requestId: fixtureId(index + 1), displayName: "Same clinic name",
      leadScope: index % 2 === 0 ? "assigned" : "clinic" }));
    for (const offset of [0, 1_000_000]) {
      const value = empty({ companies, offset });
      assert.deepEqual(accepted(value, query({ offset })), value);
      if (length > 0) {
        value.filters.requestId = fixtureId(length);
        assert.equal(accepted(value, query({ offset, requestId: fixtureId(length) })).companies.length, length);
      }
    }
  }
  const companies = Array.from({ length: 1001 }, (_, index) => company({ requestId: fixtureId(index + 1) }));
  refused(empty({ companies }), "a 1001-company manifest is unavailable, never silently truncated");
});

test("manifest uniqueness and ordering use normalized UUIDs, not display names", () => {
  const first = company({ requestId: requestA.toUpperCase(), displayName: "Z clinic" });
  const second = company({ requestId: requestB, displayName: "A clinic", leadScope: "clinic" });
  assert.deepEqual(accepted(empty({ companies: [first, second] })).companies.map(c => c.requestId), [requestA, requestB]);
  refused(empty({ companies: [second, first] }), "unsorted manifest must not be silently repaired");
  refused(empty({ companies: [company(), company()] }), "duplicate company");
  refused(empty({ companies: [company(), company({ requestId: requestA.toUpperCase(), leadScope: "clinic" })] }), "case-only duplicate company");
  refused(empty({ companies: [company(), second, company()] }), "nonadjacent duplicate company");
  for (const leadScope of ["all", "ASSIGNED", "clinic ", null, undefined, 0, false, [], {}]) {
    refused(empty({ companies: [company({ leadScope })] }), "only assigned and clinic are valid scopes");
  }
});

test("active-stage lists cover exactly the page companies, not the whole authorized manifest", () => {
  const value = report({ companies: complete().companies });
  assert.deepEqual(accepted(value), value);
  assert.deepEqual(accepted(empty({ companies: complete().companies })).stageOptions, []);
  refused({ ...value, stageOptions: [] }, "missing page-company stages cannot become an empty active list");
  refused({ ...value, stageOptions: [{ requestId: requestB, items: [] }] }, "authorized but non-page company is not interchangeable");
  refused({ ...value, stageOptions: [{ requestId: requestC, items: [] }] }, "foreign company stage list");
  refused({ ...value, stageOptions: [...value.stageOptions, { requestId: requestB, items: [] }] }, "extra non-page stage list");
  const both = complete();
  both.stageOptions = [both.stageOptions[0], structuredClone(both.stageOptions[0])];
  refused(both, "same-length duplicate cannot conceal a missing page-company list");
  both.stageOptions[1].requestId = requestA.toUpperCase();
  refused(both, "case-only duplicate list");
  const unsorted = complete();
  unsorted.stageOptions.reverse();
  refused(unsorted, "stage list order is canonical request order");
});

test("active-stage IDs are unique per company through 1000, with empty and inactive-current-stage lists valid", () => {
  for (const length of [0, 1, 20, 999, 1000]) {
    const value = report({ stageOptions: [{ requestId: requestA,
      items: Array.from({ length }, (_, index) => ({ id: fixtureId(index + 1), name: "Same stage name" })) }] });
    assert.deepEqual(accepted(value), value);
  }
  const tooMany = report({ stageOptions: [{ requestId: requestA,
    items: Array.from({ length: 1001 }, (_, index) => ({ id: fixtureId(index + 1), name: "Active" })) }] });
  refused(tooMany, "1001 active stages cannot be silently truncated");
  for (const id of [stageA, stageA.toUpperCase()]) {
    refused(report({ stageOptions: [{ requestId: requestA, items: [{ id: stageA, name: "First" }, { id, name: "Second" }] }] }),
      "duplicate active stage UUID, including case-only duplicates");
  }
  const value = complete();
  value.stageOptions[1].items[0].id = stageA;
  assert.deepEqual(accepted(value), value, "uniqueness is scoped to each request's active list");
  const inactive = report({ items: [lead({ stageId: stageB, stageName: "Inactive assigned stage", group: "other" })],
    totals: totals({ new: "0", other: "1" }) });
  assert.deepEqual(accepted(inactive), inactive, "the current stage need not be an active action option");
});

test("same phone and name are distinct contacts across and within companies, but lead IDs are globally unique", () => {
  const value = complete();
  assert.equal(accepted(value).items.length, 6);
  assert.equal(new Set(value.items.map(item => item.name)).size, 1);
  assert.equal(new Set(value.items.map(item => item.phone)).size, 1);
  for (const index of [1, 3, 5]) {
    const duplicate = complete();
    duplicate.items[index].id = duplicate.items[0].id;
    refused(duplicate, "duplicate lead UUID is refused even across different companies and timestamps");
  }
  const duplicate = complete();
  duplicate.items[0].id = stageA;
  duplicate.items[3].id = stageA.toUpperCase();
  refused(duplicate, "case-only duplicate lead UUID");
});

test("valid UUID versions and variants normalize every public identity without altering contact data", () => {
  for (const version of [1, 2, 3, 4, 5]) {
    for (const variant of ["8", "9", "A", "B"]) {
      const id = `ABCDEFAB-CDEF-${version}ABC-${variant}ABC-ABCDEFABCDEF`;
      const value = report({ companies: [company({ requestId: id })], items: [lead({ id, requestId: id, stageId: id })],
        stageOptions: [{ requestId: id, items: [{ id, name: "Active" }] }] });
      const parsed = accepted(value);
      assert.equal(parsed.companies[0].requestId, id.toLowerCase());
      assert.equal(parsed.items[0].id, id.toLowerCase());
      assert.equal(parsed.items[0].requestId, id.toLowerCase());
      assert.equal(parsed.items[0].stageId, id.toLowerCase());
      assert.equal(parsed.stageOptions[0].requestId, id.toLowerCase());
      assert.equal(parsed.stageOptions[0].items[0].id, id.toLowerCase());
      assert.equal(parsed.items[0].phone, value.items[0].phone);
    }
  }
});

const invalidUuids: unknown[] = [null, undefined, false, 0, [], {}, "", "not-a-uuid", requestA.replaceAll("-", ""),
  "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-6aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa", "gaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "00000000-0000-0000-0000-000000000000", ` ${requestA}`, `${requestA} `, `${requestA}0`];

for (const [index, id] of invalidUuids.entries()) {
  test(`malformed UUID case ${index + 1} is refused in every required identity`, () => {
    refused(empty({ companies: [company({ requestId: id })] }), "company.requestId");
    refused(report({ items: [lead({ id })] }), "lead.id");
    refused(report({ items: [lead({ requestId: id })] }), "lead.requestId");
    if (id !== null) refused(report({ items: [lead({ stageId: id })] }), "lead.stageId is nullable but otherwise a UUID");
    refused(report({ stageOptions: [{ requestId: id, items: [] }] }), "stageOptions.requestId");
    refused(report({ stageOptions: [{ requestId: requestA, items: [{ id, name: "Active" }] }] }), "active stage.id");
    if (id !== null && id !== undefined) assert.equal(parseOperatorLeadSearchBody({ requestId: id }), null);
  });
}

for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
  test(`all report UUID fields refuse trailing ${JSON.stringify(suffix)} with otherwise consistent references`, () => {
    const id = `${requestA}${suffix}`;
    const value = report({ companies: [company({ requestId: id })], items: [lead({ requestId: id })],
      stageOptions: [{ requestId: id, items: [{ id: stageA, name: "Active" }] }] });
    refused(value, "all company references agree, so only UUID syntax can refuse this report");
    refused(report({ items: [lead({ id })] }), "lead UUID syntax alone");
    refused(report({ items: [lead({ stageId: id })] }), "nullable current stage UUID syntax alone");
    refused(report({ stageOptions: [{ requestId: requestA, items: [{ id, name: "Active" }] }] }), "active-stage UUID syntax alone");
    value.filters.requestId = id;
    refused(value, "canonical expected request IDs cannot contain line breaks", query({ requestId: id }));
  });
}

function pair(first: Row = {}, second: Row = {}): Report {
  return report({ totals: totals({ all: "2", new: "2" }), matched: "2",
    items: [lead({ id: fixtureId(1), ...first }), lead({ id: fixtureId(2), ...second })] });
}

test("created timestamps sort DESC at microsecond precision and use nulls last", () => {
  for (const [first, second] of [["2026-10-28T01:02:03.123457Z", "2026-10-28T01:02:03.123456Z"],
    ["2026-10-28T01:02:03.000001Z", "2026-10-28T01:02:03Z"],
    ["2026-10-28T01:02:03.1Z", "2026-10-28T01:02:03.099999Z"],
    [generatedAt, null], [null, null]] as const) {
    const value = pair({ createdAt: first }, { createdAt: second });
    assert.deepEqual(accepted(value), value);
    if (first !== second) {
      const inverted = pair({ createdAt: second }, { createdAt: first });
      refused(inverted, "ordering must compare microseconds before UUIDs, with null last");
    }
  }
  const newestFirst = pair({ id: fixtureId(2), createdAt: "2026-10-28T01:02:03.123457Z" },
    { id: fixtureId(1), createdAt: "2026-10-28T01:02:03.123456Z" });
  assert.deepEqual(accepted(newestFirst), newestFirst, "timestamp ordering wins over the ID tie breaker");
});

test("equal instants and nulls tie by request UUID then lead UUID, including mixed timestamp precision", () => {
  for (const [firstTime, secondTime] of [[generatedAt, generatedAt], ["2026-10-28T01:02:03Z", "2026-10-28T01:02:03.000000Z"],
    ["2026-10-28T01:02:03.1Z", "2026-10-28T01:02:03.100000Z"], [null, null]] as const) {
    const sameRequest = pair({ createdAt: firstTime }, { createdAt: secondTime });
    assert.deepEqual(accepted(sameRequest), sameRequest);
    refused(pair({ id: fixtureId(2), createdAt: firstTime }, { id: fixtureId(1), createdAt: secondTime }), "same-request ID tie is ascending");
    const both = pair({ id: fixtureId(2), requestId: requestA.toUpperCase(), createdAt: firstTime },
      { id: fixtureId(1), requestId: requestB, createdAt: secondTime });
    both.companies = complete().companies;
    both.stageOptions = complete().stageOptions;
    assert.deepEqual(accepted(both).items.map(item => item.requestId), [requestA, requestB]);
    const inverted = structuredClone(both);
    inverted.items.reverse();
    refused(inverted, "equal instants tie by normalized request before ID");
  }
});

test("instants require real UTC calendar timestamps with at most six fractional digits", () => {
  for (const createdAt of [null, "2024-02-29T23:59:59Z", "2026-10-28T01:02:03.1Z", "2026-10-28T01:02:03.123456Z"]) {
    const value = report({ items: [lead({ createdAt })] });
    assert.deepEqual(accepted(value), value);
  }
  for (const instant of [undefined, false, 0, [], {}, "", "not-a-date", "2026-02-29T01:02:03Z", "2026-04-31T01:02:03Z",
    "0000-01-01T00:00:00Z", "2026-10-28", "2026-10-28T01:02:03", "2026-10-28 01:02:03Z", "2026-10-28T01:02:03+00:00",
    "2026-10-28T01:02:03.1234567Z", "2026-10-28T24:00:00Z", "2026-10-28T01:02:60Z", `${generatedAt}\n`]) {
    refused(report({ generatedAt: instant }), "generatedAt is a real UTC instant");
    refused(report({ items: [lead({ createdAt: instant })] }), "createdAt is a real UTC instant or null");
  }
  refused(report({ generatedAt: null }), "report generation is never an unknown timestamp");
});

test("public display strings enforce their independent bounds and reject control characters", () => {
  const fields: [typeof recordTargets[number], string, number, boolean][] = [
    ["company", "displayName", 200, false], ["lead", "name", 500, true], ["lead", "phone", 80, true],
    ["lead", "status", 300, true], ["lead", "stageName", 200, true], ["lead", "source", 300, true], ["stage", "name", 200, false],
  ];
  for (const [target, key, max, allowEmpty] of fields) {
    for (const text of ["x".repeat(max), ...(allowEmpty ? [""] : [])]) {
      const value = report();
      recordAt(value, target)[key] = text;
      assert.equal(recordAt(accepted(value), target)[key], text);
    }
    for (const text of ["x".repeat(max + 1), "control\n", "control\r", "control\t", "control\u0000", "control\u007f", null, undefined, false, 0, [], {},
      ...(!allowEmpty ? ["", "   "] : [])]) {
      const value = report();
      recordAt(value, target)[key] = text;
      refused(value, `${target}.${key} refuses invalid display data`);
    }
  }
  const value = report({ items: [lead({ stageId: null, stageName: "", name: "", phone: "", status: "", source: "" })] });
  assert.deepEqual(accepted(value), value, "missing optional display text must not manufacture contact details");
  for (const group of ["all", "NEW", "unknown", "new ", null, undefined, 0]) {
    refused(report({ items: [lead({ group })] }), "a row requires one of the six known semantic groups");
  }
});
