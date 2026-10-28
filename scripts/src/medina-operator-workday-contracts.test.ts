import assert from "node:assert/strict";
import test from "node:test";

type Company = {
  requestId: string; displayName: string; leadScope: "assigned" | "clinic";
  timeZone: string | null; localDate: string | null; dayStart: string | null; dayEnd: string | null;
};
type Visit = {
  appointmentId: string; requestId: string; startsAt: string; endsAt: string | null;
  status: "scheduled" | "confirmed" | "arrived" | "no_show" | "cancelled" | "unknown";
  clientName: string; clientPhone: string; service: string; doctorName: string;
  clinicConfirmedAt: string | null; operatorCheckResult: "confirmed" | "unconfirmed" | "unreachable" | null;
};
type Summary = {
  availableLeads: string; assignedLeads: string; clinicLeads: string; attributedBookings: string;
  clinicConfirmedArrivals: string; undatedBookings: string; contacts: "not_tracked";
  bookingStatuses: Record<Visit["status"], string>;
};
type Ready = { state: "ready"; total: string; actionable: string; items: Visit[]; hasMore: boolean };
type Report = {
  generatedAt: string; offset: number; companies: Company[]; summary: Summary;
  today: Ready | { state: "unavailable_timezone"; total: null; actionable: null; items: []; hasMore: false };
};
type Row = Record<string, unknown>;

const { parseOperatorWorkday, OPERATOR_WORKDAY_PAGE_SIZE, OPERATOR_WORKDAY_COMPANY_LIMIT } = await import(
  new URL("../../lib/crm/operator-workday-contracts.ts", import.meta.url).href
) as {
  parseOperatorWorkday(value: unknown, expectedOffset: number): Report | null;
  OPERATOR_WORKDAY_PAGE_SIZE: number;
  OPERATOR_WORKDAY_COMPANY_LIMIT: number;
};

const requestA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const appointmentA = "11111111-1111-4111-8111-111111111111";
const appointmentB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const generatedAt = "2026-10-28T01:02:03.123456Z";
const maxCount = "9223372036854775807";

test("ambiguous abbreviations refuse even with Intl-compatible boundaries; named fixed zones remain valid", () => {
  for (const [timeZone, hour] of [["CST", "05"], ["CST", "06"], ["EST", "04"], ["US/Eastern", "04"]]) {
    assert.equal(parseOperatorWorkday(noVisits({ generatedAt: "2026-10-28T12:00:00Z", companies: [company({ timeZone,
      localDate: "2026-10-28", dayStart: `2026-10-28T${hour}:00:00Z`, dayEnd: `2026-10-29T${hour}:00:00Z` })] }), 0), null);
  }
  assert.ok(parseOperatorWorkday(noVisits({ generatedAt: "2026-10-28T12:00:00Z", companies: [company({ timeZone: "Etc/GMT+6",
    localDate: "2026-10-28", dayStart: "2026-10-28T06:00:00Z", dayEnd: "2026-10-29T06:00:00Z" })] }), 0));
});

function company(patch: Row = {}): Company {
  return { requestId: requestA, displayName: "Clinic A", leadScope: "assigned", timeZone: "Asia/Qyzylorda",
    localDate: "2026-10-28", dayStart: "2026-10-27T19:00:00Z", dayEnd: "2026-10-28T19:00:00Z", ...patch } as Company;
}

function visit(patch: Row = {}): Visit {
  return { appointmentId: appointmentA, requestId: requestA, startsAt: "2026-10-28T04:00:00.123456Z",
    endsAt: "2026-10-28T04:30:00.123456Z", status: "scheduled", clientName: "Patient A", clientPhone: "+77011234567",
    service: "Consultation", doctorName: "Doctor A", clinicConfirmedAt: null, operatorCheckResult: null, ...patch } as Visit;
}

function summary(patch: Row = {}): Summary {
  return { availableLeads: "3", assignedLeads: "1", clinicLeads: "2", attributedBookings: "7",
    clinicConfirmedArrivals: "2", undatedBookings: "1", contacts: "not_tracked",
    bookingStatuses: Object.hasOwn(patch, "attributedBookings") ? buckets({ scheduled: patch.attributedBookings })
      : buckets({ scheduled: "1", confirmed: "1", arrived: "1", no_show: "1", cancelled: "1", unknown: "2" }),
    ...patch } as Summary;
}

function buckets(patch: Row = {}): Summary["bookingStatuses"] {
  return { scheduled: "0", confirmed: "0", arrived: "0", no_show: "0", cancelled: "0", unknown: "0", ...patch } as Summary["bookingStatuses"];
}

function today(patch: Row = {}): Ready {
  return { state: "ready", total: "1", actionable: patch.total ?? "1", items: [visit()], hasMore: false, ...patch } as Ready;
}

function report(patch: Row = {}): Report {
  return { generatedAt, offset: 0, companies: [company()], summary: summary(), today: today(), ...patch } as Report;
}

function unavailable() {
  return { state: "unavailable_timezone", total: null, actionable: null, items: [], hasMore: false } as const;
}

function noVisits(patch: Row = {}): Report {
  return report({ today: today({ total: "0", actionable: "0", items: [] }), ...patch });
}

function emptyReport(patch: Row = {}): Report {
  return noVisits({ companies: [], summary: summary({ availableLeads: "0", assignedLeads: "0", clinicLeads: "0",
    attributedBookings: "0", clinicConfirmedArrivals: "0", undatedBookings: "0" }), ...patch });
}

function pageVisits(length: number): Visit[] {
  return Array.from({ length }, (_, index) => visit({
    appointmentId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    startsAt: `2026-10-28T04:00:${String(index).padStart(2, "0")}Z`, endsAt: null,
  }));
}

function page(total: string, offset: number, length: number, hasMore: boolean): Report {
  return report({ offset, summary: summary({ attributedBookings: maxCount, undatedBookings: "0" }),
    today: today({ total, actionable: total, items: pageVisits(length), hasMore }) });
}

function accepted(value: unknown, offset = 0): Report {
  const result = parseOperatorWorkday(value, offset);
  assert.ok(result, "a valid operator workday must not be refused");
  return result;
}

function ready(value: unknown, offset = 0): Ready {
  const result = accepted(value, offset);
  assert.equal(result.today.state, "ready");
  if (result.today.state !== "ready") assert.fail("expected a ready agenda");
  return result.today;
}

function refused(value: unknown, label: string, ...expectedOffset: [unknown?]) {
  const offset = expectedOffset.length === 0 ? 0 : expectedOffset[0];
  assert.ok(parseOperatorWorkday(value, offset as number) === null, label);
}

const recordTargets = ["report", "company", "summary", "bookingStatuses", "today", "visit"] as const;
function recordAt(value: Report, target: typeof recordTargets[number]): Row {
  switch (target) {
    case "report": return value as unknown as Row;
    case "company": return value.companies[0] as unknown as Row;
    case "summary": return value.summary as unknown as Row;
    case "bookingStatuses": return value.summary.bookingStatuses;
    case "today": return value.today as unknown as Row;
    case "visit": return (value.today as Ready).items[0] as unknown as Row;
  }
}

test("the actual parser preserves the public report and exposes the fixed bounds", () => {
  assert.equal(OPERATOR_WORKDAY_PAGE_SIZE, 20);
  assert.equal(OPERATOR_WORKDAY_COMPANY_LIMIT, 1000);
  assert.deepEqual(accepted(report()), report());
});

test("invalid outer values fail closed instead of becoming empty reports", () => {
  for (const value of [undefined, null, true, false, 0, NaN, Infinity, "{}", [], [report()], {}, new Date()]) {
    refused(value, `invalid outer value ${String(value)}`);
  }
});

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

  for (const key of ["unknown", "privateAuth", "actorId", "workspaceId", "companyId", "leadId", "accessToken",
    "authorization", "priceMinor", "amountMinor", "currency", "commissionMinor", "payoutMinor", "__proto__"]) {
    test(`${target} refuses the extra private or money field ${key}`, () => {
      const value = report();
      Object.defineProperty(recordAt(value, target), key, { value: "must-not-leak", enumerable: true, configurable: true });
      refused(value, `${target}.${key} must reject the entire report`);
    });
  }
}

test("nested collections and records reject primitive, array, null, and sparse substitutes", () => {
  for (const value of [undefined, null, false, 0, "[]", {}]) {
    refused(report({ companies: value }), "companies must be an array");
    refused(report({ today: today({ items: value }) }), "items must be an array");
  }
  for (const value of [undefined, null, false, 0, "row", [], [company()]]) {
    refused(report({ companies: [value] }), "company must be a record");
    refused(report({ summary: value }), "summary must be a record");
    refused(report({ summary: summary({ bookingStatuses: value }) }), "bookingStatuses must be a record");
    refused(report({ today: value }), "today must be a record");
    refused(report({ today: today({ items: [value] }) }), "visit must be a record");
  }
  refused(report({ companies: new Array(1) }), "sparse companies");
  refused(report({ today: today({ items: new Array(1) }) }), "sparse items");
});

test("offsets bind exactly, admit every integer through one million, and never coerce", () => {
  for (const offset of [0, 1, 19, 20, 21, 999_999, 1_000_000]) {
    const value = noVisits({ offset });
    assert.deepEqual(accepted(value, offset), value);
    refused(value, "response offset must match the original request", offset === 0 ? 1 : 0);
  }
  for (const offset of [-1, -0.1, 0.1, 20.5, 1_000_001, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity,
    "0", "20", null, undefined, false, [], {}, 0n]) {
    refused(noVisits({ offset }), `invalid wire offset ${String(offset)}`);
    refused(noVisits({ offset }), `invalid expected offset ${String(offset)}`, offset as number);
    refused(report(), `caller offset is validated independently: ${String(offset)}`, offset as number);
  }
});

test("UUID versions one through five and RFC variants normalize company and visit identities", () => {
  for (const version of [1, 2, 3, 4, 5]) {
    for (const variant of ["8", "9", "A", "B"]) {
      const id = `ABCDEFAB-CDEF-${version}ABC-${variant}ABC-ABCDEFABCDEF`;
      const value = report({ companies: [company({ requestId: id })],
        today: today({ items: [visit({ requestId: id, appointmentId: id })] }) });
      const parsed = accepted(value);
      assert.equal(parsed.companies[0].requestId, id.toLowerCase());
      assert.equal(ready(value).items[0].requestId, id.toLowerCase());
      assert.equal(ready(value).items[0].appointmentId, id.toLowerCase());
    }
  }
});

const invalidUuids: unknown[] = [null, undefined, 0, false, [], {}, "", "not-a-uuid", requestA.replaceAll("-", ""),
  "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-6aaa-8aaa-aaaaaaaaaaaa",
  "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
  "aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa", "gaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "00000000-0000-0000-0000-000000000000", ` ${requestA}`, `${requestA} `, `${requestA}0`,
  `${requestA}\n`, `${requestA}\r`, `${requestA}\r\n`, `${requestA}\u2028`];

for (const [index, id] of invalidUuids.entries()) {
  test(`malformed UUID case ${index + 1} is rejected independently in all identity fields`, () => {
    refused(noVisits({ companies: [company({ requestId: id })] }), `company.requestId ${JSON.stringify(id)}`);
    refused(report({ today: today({ items: [visit({ appointmentId: id })] }) }), `appointmentId ${JSON.stringify(id)}`);
    refused(report({ today: today({ items: [visit({ requestId: id })] }) }), `visit.requestId ${JSON.stringify(id)}`);
  });
}

test("the entire sorted company manifest survives empty and later agenda pages, up to 1000", () => {
  for (const length of [0, 1, 19, 20, 21, 999, 1000]) {
    const companies = Array.from({ length }, (_, index) => company({
      requestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      leadScope: index % 2 === 0 ? "assigned" : "clinic", displayName: "Same display name",
    }));
    for (const offset of [0, 1_000_000]) {
      const value = emptyReport({ companies, offset });
      const parsed = accepted(value, offset);
      assert.deepEqual(parsed, value);
      assert.equal(parsed.companies.length, length);
    }
  }
  const tooMany = Array.from({ length: 1001 }, (_, index) => company({
    requestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  }));
  refused(noVisits({ companies: tooMany }), "1001 companies exceeds the complete-manifest limit");
});

test("company order and uniqueness use lowercase request UUIDs, never display names", () => {
  const first = company({ requestId: requestA.toUpperCase(), displayName: "Z last alphabetically" });
  const second = company({ requestId: requestB, displayName: "A first alphabetically", leadScope: "clinic" });
  const result = accepted(noVisits({ companies: [first, second] }));
  assert.deepEqual(result.companies.map(c => c.requestId), [requestA, requestB]);
  refused(noVisits({ companies: [second, first] }), "unsorted companies are not silently sorted");
  for (const duplicate of [company(), company({ requestId: requestA.toUpperCase(), leadScope: "clinic", displayName: "Other" })]) {
    refused(noVisits({ companies: [company(), duplicate] }), "duplicate request, including case-only duplicate");
  }
  refused(noVisits({ companies: [company(), second, company()] }), "nonadjacent duplicate company");
});

test("company scope is exactly assigned or clinic; contact tracking is not a numeric proxy", () => {
  for (const leadScope of ["assigned", "clinic"]) assert.equal(accepted(noVisits({ companies: [company({ leadScope })] })).companies[0].leadScope, leadScope);
  for (const leadScope of [null, undefined, 0, false, "all", "ASSIGNED", "assigned ", ["clinic"], {}]) {
    refused(noVisits({ companies: [company({ leadScope })] }), `invalid scope ${String(leadScope)}`);
  }
  for (const contacts of [null, undefined, 0, "0", "tracked", "NOT_TRACKED", "not_tracked ", []]) {
    refused(report({ summary: summary({ contacts }) }), "contacts is exactly not_tracked");
  }
});

const summaryCounts = ["availableLeads", "assignedLeads", "clinicLeads", "attributedBookings", "clinicConfirmedArrivals", "undatedBookings"] as const;

function oneCount(field: typeof summaryCounts[number], value: unknown): Report {
  const sums = { availableLeads: "1", assignedLeads: field === "clinicLeads" ? "0" : "1",
    clinicLeads: field === "clinicLeads" ? "1" : "0", attributedBookings: field === "attributedBookings" ? "1" : "2",
    clinicConfirmedArrivals: "1", undatedBookings: field === "attributedBookings" ? "0" : "1" };
  return report({ summary: summary({ ...sums, bookingStatuses: buckets({ scheduled: sums.attributedBookings }), [field]: value }) });
}

test("all counts retain exact canonical decimal strings through signed BigInt maximum", () => {
  for (const field of summaryCounts) assert.ok(accepted(oneCount(field, "1")));
  for (const count of ["0", "1", "9007199254740991", "9007199254740992", "9007199254740993", maxCount]) {
    for (const scope of ["assignedLeads", "clinicLeads"] as const) {
      const value = noVisits({ summary: summary({ availableLeads: count, assignedLeads: scope === "assignedLeads" ? count : "0",
        clinicLeads: scope === "clinicLeads" ? count : "0", attributedBookings: count, clinicConfirmedArrivals: count, undatedBookings: count }) });
      assert.deepEqual(accepted(value), value);
    }
  }
  const value = page(maxCount, 1_000_000, 20, true);
  value.today = today({ ...(value.today as Ready), actionable: maxCount });
  assert.deepEqual(accepted(value, 1_000_000), value);
});

test("all six mandatory status buckets accept exact counts independently through BigInt maximum", () => {
  for (const field of ["scheduled", "confirmed", "arrived", "no_show", "cancelled", "unknown"]) {
    for (const count of ["0", "1", "9007199254740993", maxCount]) {
      const value = noVisits({ summary: summary({ attributedBookings: count, clinicConfirmedArrivals: "0", undatedBookings: "0",
        bookingStatuses: buckets({ [field]: count }) }) });
      assert.deepEqual(accepted(value), value);
    }
  }
});

test("booking status totals must equal attributedBookings exactly, even above safe Number precision", () => {
  for (const patch of [
    { attributedBookings: "6" }, { attributedBookings: "8" },
    { attributedBookings: "9007199254740992", bookingStatuses: buckets({ scheduled: "9007199254740992", unknown: "1" }) },
    { attributedBookings: "9007199254740993", bookingStatuses: buckets({ scheduled: "9007199254740992" }) },
    { attributedBookings: maxCount, bookingStatuses: buckets({ scheduled: maxCount, unknown: "1" }) },
  ]) {
    refused(noVisits({ summary: summary({ bookingStatuses: summary().bookingStatuses, ...patch }) }), `status sum mismatch ${JSON.stringify(patch)}`);
  }
  const exact = noVisits({ summary: summary({ attributedBookings: maxCount, undatedBookings: "0", clinicConfirmedArrivals: "0",
    bookingStatuses: buckets({ scheduled: "9223372036854775806", unknown: "1" }) }) });
  assert.deepEqual(accepted(exact), exact);
});

const invalidCounts: unknown[] = [null, undefined, true, false, 0, 1, -1, 1.5, NaN, Infinity, 1n, [], {}, new String("1"),
  "", "00", "01", "-0", "-1", "+1", "1.0", "1.5", ".5", "1e0", "1E0", "0x1", "1,000", " 1", "1 ",
  "1\n", "1\r", "1\r\n", "1\u2028", "NaN", "Infinity", "9223372036854775808", "9999999999999999999", "10000000000000000000"];

for (const [index, count] of invalidCounts.entries()) {
  test(`noncanonical or out-of-range count case ${index + 1} is rejected in every summary and agenda count`, () => {
    for (const field of summaryCounts) refused(oneCount(field, count), `${field}: ${String(count)} (${JSON.stringify(typeof count)})`);
    refused(report({ today: today({ total: count, actionable: "1" }) }), `today.total: ${String(count)}`);
    refused(report({ today: today({ actionable: count }) }), `today.actionable: ${String(count)}`);
    for (const field of ["scheduled", "confirmed", "arrived", "no_show", "cancelled", "unknown"]) {
      const statuses = buckets({ [field]: count });
      refused(noVisits({ summary: summary({ attributedBookings: "1", clinicConfirmedArrivals: "0", undatedBookings: "0",
        bookingStatuses: statuses }) }), `bookingStatuses.${field}: ${String(count)}`);
    }
  });
}

test("lead sums and booking subsets use exact integer relationships, not rounded Numbers", () => {
  const valid = noVisits({ summary: summary({ availableLeads: maxCount, assignedLeads: "9223372036854775806", clinicLeads: "1",
    attributedBookings: "9007199254740993", clinicConfirmedArrivals: "9007199254740993", undatedBookings: "9007199254740993" }) });
  assert.deepEqual(accepted(valid), valid);
  for (const patch of [
    { availableLeads: "4" }, { availableLeads: "2" },
    { availableLeads: "9007199254740992", assignedLeads: "9007199254740992", clinicLeads: "1" },
    { availableLeads: maxCount, assignedLeads: maxCount, clinicLeads: "1" },
    { attributedBookings: "9007199254740992", clinicConfirmedArrivals: "9007199254740993" },
    { attributedBookings: "9007199254740992", undatedBookings: "9007199254740993" },
  ]) refused(noVisits({ summary: summary(patch) }), `invalid exact relation ${JSON.stringify(patch)}`);
  refused(report({ today: today({ total: "8", actionable: "0", items: pageVisits(8) }) }), "today.total exceeds attributed bookings");
  refused(report({ today: today({ actionable: "2" }) }), "actionable exceeds total");
  refused(report({ summary: summary({ attributedBookings: "9007199254740992", undatedBookings: "0" }),
    today: today({ total: "9007199254740993", actionable: "0", items: pageVisits(20), hasMore: true }) }), "today total differs by one above Number precision");
  refused(report({ summary: summary({ attributedBookings: maxCount }),
    today: today({ total: "9007199254740992", actionable: "9007199254740993", items: pageVisits(20), hasMore: true }) }), "actionable differs by one above Number precision");
});

test("today and undated bookings are disjoint subsets of attributed bookings", () => {
  const exact = report({ summary: summary({ undatedBookings: "6" }) });
  assert.deepEqual(accepted(exact), exact);
  refused(report({ summary: summary({ undatedBookings: "7" }) }), "today.total=1 + undated=7 exceeds attributed=7");
  const large = page("9007199254740992", 0, 20, true);
  large.summary = summary({ attributedBookings: "9007199254740993", undatedBookings: "1" });
  assert.deepEqual(accepted(large), large);
  refused({ ...large, summary: summary({ attributedBookings: "9007199254740992", undatedBookings: "1" }) }, "disjoint sum differs by one above safe Number precision");
  refused(report({ summary: summary({ attributedBookings: maxCount, undatedBookings: maxCount }) }), "adding today to max undated cannot wrap or round");
});

test("visible scheduled and confirmed rows bound global actionable from below and terminal rows bound it above", () => {
  const rows = pageVisits(20).map((row, index) => ({ ...row, status: index < 10 ? "scheduled" : "cancelled" }) as Visit);
  for (const offset of [0, 5]) {
    const value = report({ offset, summary: summary({ attributedBookings: "40", undatedBookings: "0",
      bookingStatuses: buckets({ scheduled: "20", cancelled: "20" }) }),
      today: today({ total: "25", actionable: "10", items: rows, hasMore: offset === 0 }) });
    for (const actionable of ["10", "11", "14", "15"]) {
      const valid = { ...value, today: { ...value.today, actionable } };
      assert.deepEqual(accepted(valid, offset), valid);
    }
    for (const actionable of ["0", "9", "16", "25"]) {
      refused({ ...value, today: { ...value.today, actionable } }, `visible 10 actionable / 10 terminal, total=25 cannot have actionable=${actionable}`, offset);
    }
  }
  const full = report({ summary: summary({ attributedBookings: "20", undatedBookings: "0",
    bookingStatuses: buckets({ scheduled: "10", cancelled: "10" }) }),
    today: today({ total: "20", actionable: "10", items: rows }) });
  assert.deepEqual(accepted(full), full);
  refused({ ...full, today: { ...full.today, actionable: "9" } }, "a complete agenda cannot understate actionable");
  refused({ ...full, today: { ...full.today, actionable: "11" } }, "a complete agenda cannot overstate actionable");
  const confirmed = report({ today: today({ items: [visit({ status: "confirmed" })] }) });
  assert.deepEqual(accepted(confirmed), confirmed);
  refused({ ...confirmed, today: { ...confirmed.today, actionable: "0" } }, "confirmed is actionable independently of clinic confirmation");
});

test("when all 25 bookings are Today, 15 global scheduled and 10 cancelled require exactly 15 actionable", () => {
  const rows = pageVisits(20).map((row, index) => ({ ...row, status: index < 10 ? "scheduled" : "cancelled" }) as Visit);
  for (const offset of [0, 5]) {
    const value = report({ offset, summary: summary({ attributedBookings: "25", undatedBookings: "0",
      bookingStatuses: buckets({ scheduled: "15", cancelled: "10" }) }),
      today: today({ total: "25", actionable: "15", items: rows, hasMore: offset === 0 }) });
    assert.deepEqual(accepted(value, offset), value);
    for (let count = 0; count <= 25; count++) {
      if (count === 15) continue;
      refused({ ...value, today: { ...value.today, actionable: String(count) } },
        `all 25 bookings are Today with 15 scheduled and 10 cancelled, so actionable=${count} is impossible`, offset);
    }
  }
});

test("Today actionable cannot exceed all global scheduled and confirmed bookings on a later page", () => {
  const rows = pageVisits(5).map(row => ({ ...row, status: "cancelled" }) as Visit);
  const value = report({ offset: 20, summary: summary({ attributedBookings: "25", clinicConfirmedArrivals: "0", undatedBookings: "0",
    bookingStatuses: buckets({ cancelled: "25" }) }),
    today: today({ total: "25", actionable: "0", items: rows }) });
  assert.deepEqual(accepted(value, 20), value);
  refused({ ...value, today: { ...value.today, actionable: "1" } },
    "total=25 offset=20, visible=5 cancelled, global cancelled=25 scheduled=0 confirmed=0 cannot have actionable=1", 20);
});

test("Today terminal count cannot exceed all global terminal bookings on a later page", () => {
  const value = report({ offset: 20, summary: summary({ attributedBookings: "25", clinicConfirmedArrivals: "0", undatedBookings: "0",
    bookingStatuses: buckets({ scheduled: "25" }) }),
    today: today({ total: "25", actionable: "25", items: pageVisits(5) }) });
  assert.deepEqual(accepted(value, 20), value);
  refused({ ...value, today: { ...value.today, actionable: "24" } },
    "total=25 offset=20, visible=5 scheduled, global scheduled=25 and all terminal buckets=0 cannot have actionable=24", 20);
});

test("visible clinic confirmations cannot exceed summary arrivals and do not derive from status", () => {
  const value = report({ summary: summary({ clinicConfirmedArrivals: "1" }),
    today: today({ actionable: "0", items: [visit({ status: "unknown", clinicConfirmedAt: generatedAt })] }) });
  assert.deepEqual(accepted(value), value);
  refused({ ...value, summary: summary({ clinicConfirmedArrivals: "0" }) }, "one visible clinic confirmation contradicts zero confirmed arrivals");
  const two = report({ summary: summary({ clinicConfirmedArrivals: "2", bookingStatuses: buckets({ scheduled: "7" }) }), today: today({ total: "2", items: [
    visit({ clinicConfirmedAt: generatedAt }), visit({ appointmentId: appointmentB, clinicConfirmedAt: generatedAt }),
  ] }) });
  assert.deepEqual(accepted(two), two);
  refused({ ...two, summary: { ...two.summary, clinicConfirmedArrivals: "1" } }, "two visible clinic confirmations exceed summary one");
  const statusOnly = report({ summary: summary({ clinicConfirmedArrivals: "0" }),
    today: today({ actionable: "0", items: [visit({ status: "arrived" })] }) });
  assert.deepEqual(accepted(statusOnly), statusOnly);
});

test("each visible status count must fit its corresponding global bucket without changing the bucket sum", () => {
  for (const [status, actionable] of [["scheduled", "1"], ["confirmed", "1"], ["arrived", "0"], ["no_show", "0"], ["cancelled", "0"], ["unknown", "0"]] as const) {
    const global = buckets({ [status]: "1", ...(status === "unknown" ? { scheduled: "6" } : { unknown: "6" }) });
    const value = report({ summary: summary({ bookingStatuses: global }), today: today({ actionable, items: [visit({ status })] }) });
    assert.deepEqual(accepted(value), value);
    const impossible = buckets({ [status === "unknown" ? "scheduled" : "unknown"]: "7" });
    refused({ ...value, summary: summary({ bookingStatuses: impossible }) }, `visible ${status}=1 but global ${status}=0, still total=7`);
  }
});

test("no-company reports are known zero reports and refuse any invented totals", () => {
  assert.deepEqual(accepted(emptyReport()), emptyReport());
  for (const field of summaryCounts) {
    const value = emptyReport();
    value.summary[field] = "1";
    if (field === "availableLeads" || field === "assignedLeads") {
      value.summary.availableLeads = "1"; value.summary.assignedLeads = "1";
    }
    if (field === "clinicLeads") { value.summary.availableLeads = "1"; value.summary.clinicLeads = "1"; }
    if (field === "clinicConfirmedArrivals" || field === "undatedBookings") value.summary.attributedBookings = "1";
    value.summary.bookingStatuses = buckets({ scheduled: value.summary.attributedBookings });
    refused(value, `no companies but ${field} is positive`);
  }
  refused(emptyReport({ today: unavailable() }), "no companies is not missing timezone");
});

const dayFixtures = [
  { label: "UTC+5 crosses the UTC calendar boundary", generatedAt: "2026-10-27T20:00:00.000001Z", timeZone: "Asia/Qyzylorda",
    localDate: "2026-10-28", dayStart: "2026-10-27T19:00:00Z", dayEnd: "2026-10-28T19:00:00Z" },
  { label: "UTC day", generatedAt, timeZone: "UTC", localDate: "2026-10-28", dayStart: "2026-10-28T00:00:00Z", dayEnd: "2026-10-29T00:00:00Z" },
  { label: "negative offset has the previous local date", generatedAt, timeZone: "America/New_York", localDate: "2026-10-27",
    dayStart: "2026-10-27T04:00:00Z", dayEnd: "2026-10-28T04:00:00Z" },
  { label: "23-hour DST spring day", generatedAt: "2026-03-08T12:00:00Z", timeZone: "America/New_York", localDate: "2026-03-08",
    dayStart: "2026-03-08T05:00:00Z", dayEnd: "2026-03-09T04:00:00Z" },
  { label: "25-hour DST autumn day", generatedAt: "2026-11-01T12:00:00Z", timeZone: "America/New_York", localDate: "2026-11-01",
    dayStart: "2026-11-01T04:00:00Z", dayEnd: "2026-11-02T05:00:00Z" },
  { label: "skipped midnight starts at local 01:00", generatedAt: "2018-11-04T12:00:00Z", timeZone: "America/Sao_Paulo", localDate: "2018-11-04",
    dayStart: "2018-11-04T03:00:00Z", dayEnd: "2018-11-05T02:00:00Z" },
  { label: "date-line jump skips the following civil date", generatedAt: "2011-12-29T12:00:00Z", timeZone: "Pacific/Apia", localDate: "2011-12-29",
    dayStart: "2011-12-29T10:00:00Z", dayEnd: "2011-12-30T10:00:00Z" },
] as const;

for (const fixture of dayFixtures) {
  test(`company-local day accepts ${fixture.label} without assuming a 24-hour duration`, () => {
    const { label: _label, generatedAt: at, ...day } = fixture;
    const value = noVisits({ generatedAt: at, companies: [company(day)] });
    assert.deepEqual(accepted(value), value);
    assert.deepEqual(accepted({ ...value, generatedAt: day.dayStart }).companies, value.companies);
    refused({ ...value, generatedAt: day.dayEnd }, "generatedAt cannot equal the exclusive day end");
    refused({ ...value, companies: [company({ ...day, localDate: "2026-10-29" })] }, "date must come from this company's timezone");
    for (const field of ["dayStart", "dayEnd"] as const) {
      const shifted = new Date(Date.parse(day[field]) + 1000).toISOString();
      refused({ ...value, companies: [company({ ...day, [field]: shifted })] }, `${field} must be the exact transition, not one second later`);
      const earlier = new Date(Date.parse(day[field]) - 1000).toISOString();
      refused({ ...value, companies: [company({ ...day, [field]: earlier })] }, `${field} cannot be one second earlier`);
      refused({ ...value, companies: [company({ ...day, [field]: day[field].replace("Z", ".000001Z") })] }, `${field} must not hide a microsecond displacement`);
    }
  });
}

test("companies at the same generated instant may have different civil dates and boundaries", () => {
  const value = noVisits({ companies: [company(), company({ requestId: requestB, leadScope: "clinic", timeZone: "America/New_York",
    localDate: "2026-10-27", dayStart: "2026-10-27T04:00:00Z", dayEnd: "2026-10-28T04:00:00Z" })] });
  assert.deepEqual(accepted(value), value);
  refused({ ...value, companies: [value.companies[0], { ...value.companies[1], localDate: "2026-10-28" }] }, "never reuse another company's local date");
});

test("timezone and civil-date fields are exact and reject invalid or contradictory boundaries", () => {
  for (const timeZone of [undefined, false, 5, [], {}, "", "Not/A_Zone", " Asia/Qyzylorda", "Asia/Qyzylorda ", "+05:00", "UTC\n"]) {
    refused(noVisits({ companies: [company({ timeZone })] }), `invalid timezone ${String(timeZone)}`);
  }
  for (const localDate of [null, undefined, 20261028, "2026-10-27", "2026-1-28", "2026-02-30", "2026-10-28T00:00:00Z", "2026-10-28\n"]) {
    refused(noVisits({ companies: [company({ localDate })] }), `invalid localDate ${String(localDate)}`);
  }
  for (const patch of [
    { dayStart: null }, { dayEnd: null }, { dayStart: "2026-10-28T19:00:00Z" }, { dayEnd: "2026-10-27T19:00:00Z" },
    { dayStart: "2026-10-26T19:00:00Z" }, { dayEnd: "2026-10-29T19:00:00Z" },
    { timeZone: "America/New_York", localDate: "2026-03-08", dayStart: "2026-03-08T05:00:00Z", dayEnd: "2026-03-09T05:00:00Z" },
  ]) refused(noVisits({ companies: [company(patch)] }), `contradictory boundaries ${JSON.stringify(patch)}`);
  const zeroFractions = noVisits({ companies: [company({ dayStart: "2026-10-27T19:00:00.000000Z", dayEnd: "2026-10-28T19:00:00.0Z" })] });
  assert.deepEqual(accepted(zeroFractions), zeroFractions);
});

test("any missing company timezone makes Today unavailable atomically, without discarding summary or manifest", () => {
  const missing = company({ requestId: requestB, leadScope: "clinic", timeZone: null, localDate: null, dayStart: null, dayEnd: null });
  for (const offset of [0, 20, 1_000_000]) {
    const value = report({ offset, companies: [company(), missing], today: unavailable() });
    assert.deepEqual(accepted(value, offset), value);
    refused({ ...value, today: today() }, "no partially ready agenda when one company is missing timezone", offset);
    for (const patch of [{ total: "0" }, { actionable: "0" }, { items: [visit()] }, { hasMore: true }, { hasMore: 0 }, { privateAuth: "x" }]) {
      refused({ ...value, today: { ...unavailable(), ...patch } }, `unavailable is exact: ${JSON.stringify(patch)}`, offset);
    }
  }
  for (const field of ["localDate", "dayStart", "dayEnd"] as const) {
    refused(report({ companies: [company({ ...missing, [field]: company()[field] })], today: unavailable() }), `null timezone requires null ${field}`);
  }
  refused(report({ today: unavailable() }), "available timezones cannot claim unavailable");
  refused(report({ companies: [company({ timeZone: "Not/A_Zone", localDate: null, dayStart: null, dayEnd: null })], today: unavailable() }), "invalid timezone is not the null-timezone sentinel");
  for (const state of [null, undefined, "READY", "partial", "unavailable", "ready "]) {
    refused(report({ today: today({ state }) }), `unrecognized today state ${String(state)}`);
  }
});

const pagingFixtures = [
  ["0", 0, 0, false], ["1", 0, 1, false], ["19", 0, 19, false], ["20", 0, 20, false],
  ["21", 0, 20, true], ["41", 0, 20, true], ["21", 1, 20, false], ["22", 1, 20, true],
  ["21", 19, 2, false], ["20", 20, 0, false], ["21", 20, 1, false], ["40", 20, 20, false],
  ["41", 20, 20, true], ["41", 40, 1, false], ["1", 21, 0, false],
  ["0", 1_000_000, 0, false], ["1000001", 1_000_000, 1, false],
  ["1000020", 1_000_000, 20, false], ["1000021", 1_000_000, 20, true], [maxCount, 1_000_000, 20, true],
] as const;

for (const [total, offset, length, hasMore] of pagingFixtures) {
  test(`paging total=${total} offset=${offset} demands exactly ${length} rows and hasMore=${hasMore}`, () => {
    const value = page(total, offset, length, hasMore);
    assert.deepEqual(accepted(value, offset), value);
    refused({ ...value, today: { ...value.today, hasMore: !hasMore } }, "hasMore cannot contradict total and offset", offset);
    if (length > 0) refused(page(total, offset, length - 1, hasMore), "a short page cannot hide expected rows", offset);
    refused(page(total, offset, length + 1, hasMore), "an extra row cannot exceed total or page size", offset);
  });
}

test("paging metadata remains strict even for an empty or unavailable agenda", () => {
  for (const hasMore of [undefined, null, 0, 1, "true", "false", [], {}]) {
    refused(report({ today: today({ hasMore }) }), `hasMore is not coerced: ${String(hasMore)}`);
  }
  refused(report({ today: today({ total: null }) }), "ready total cannot be unknown");
  refused(report({ today: today({ actionable: null }) }), "ready actionable cannot be unknown");
  const missing = report({ companies: [company({ timeZone: null, localDate: null, dayStart: null, dayEnd: null })], today: unavailable() });
  refused({ ...missing, offset: 20 }, "unavailable responses are still bound to the original offset");
  refused({ ...missing, offset: 1_000_001 }, "unavailable responses still validate caller offset", 1_000_001);
});

test("every visit's original request must be in the complete current company manifest", () => {
  const value = report({ companies: [company({ leadScope: "assigned" }), company({ requestId: requestB, leadScope: "clinic" })],
    summary: summary({ bookingStatuses: buckets({ scheduled: "7" }) }),
    today: today({ total: "2", items: [visit(), visit({ appointmentId: appointmentB, requestId: requestB })] }) });
  assert.deepEqual(accepted(value), value);
  refused({ ...value, companies: [company()] }, "clinic-scoped access does not substitute for the original request");
  refused(report({ companies: [company({ requestId: requestB })] }), "same company display name is not a request identity");
  refused(report({ companies: [company(), company({ requestId: requestB, leadScope: "clinic" })],
    today: today({ items: [visit({ requestId: requestC })] }) }), "a third request may not be inferred from current clinic access");
  const duplicate = { ...value, today: today({ total: "2", items: [visit(), visit({ requestId: requestB })] }) };
  refused(duplicate, "one appointment may not appear twice under different requests");
});

test("public contact and booked catalog labels are preserved without inferring appointment-client or provider data", () => {
  const current = visit({ clientName: "Current authorized lead", clientPhone: "+77010000002",
    service: "Original booked public service", doctorName: "Original booked public doctor" });
  assert.deepEqual(ready(report({ today: today({ items: [current] }) })).items[0], current);
  for (const key of ["appointmentClient", "appointmentClientName", "appointmentClientPhone", "clientId", "doctorId", "serviceId", "leadContact",
    "futureContact", "providerResponse", "providerCredentials", "bookedDoctorPrivateNotes", "originalRequestPrivateAuth"]) {
    refused(report({ today: today({ items: [visit({ [key]: "not-public" })] }) }), `contact/catalog provenance does not authorize extra ${key}`);
  }
});

test("visit starts belong to their own company's half-open day, not any company's day", () => {
  const companies = [company(), company({ requestId: requestB, timeZone: "America/New_York", localDate: "2026-10-27",
    dayStart: "2026-10-27T04:00:00Z", dayEnd: "2026-10-28T04:00:00Z" })];
  for (const [requestId, startsAt] of [
    [requestA, "2026-10-27T19:00:00Z"], [requestA, "2026-10-28T18:59:59.999999Z"],
    [requestB, "2026-10-27T04:00:00Z"], [requestB, "2026-10-28T03:59:59.999999Z"],
  ]) assert.ok(accepted(report({ companies, today: today({ items: [visit({ requestId, startsAt, endsAt: null })] }) })));
  for (const [requestId, startsAt] of [
    [requestA, "2026-10-27T18:59:59.999999Z"], [requestA, "2026-10-28T19:00:00Z"],
    [requestB, "2026-10-28T04:00:00Z"], [requestB, "2026-10-27T03:59:59.999999Z"],
    [requestA, "2026-10-27T12:00:00Z"], [requestB, "2026-10-28T12:00:00Z"],
  ]) refused(report({ companies, today: today({ items: [visit({ requestId, startsAt, endsAt: null })] }) }), `${requestId}: ${startsAt} outside its own day`);
});

test("endsAt may be explicitly null, including an otherwise valid near-end-of-day visit", () => {
  for (const startsAt of ["2026-10-28T04:00:00Z", "2026-10-28T18:59:59.999999Z"]) {
    const value = report({ today: today({ items: [visit({ startsAt, endsAt: null })] }) });
    assert.deepEqual(accepted(value), value);
  }
  refused(report({ today: today({ items: [visit({ endsAt: undefined })] }) }), "nullable end must be explicit, not missing");
});

test("a non-null end must be later than its start at full microsecond precision", () => {
  for (const endsAt of ["2026-10-28T04:00:00.123455Z", "2026-10-28T04:00:00.123456Z", "2026-10-27T20:00:00Z"]) {
    refused(report({ today: today({ items: [visit({ endsAt })] }) }), `non-positive visit interval: startsAt=2026-10-28T04:00:00.123456Z endsAt=${endsAt}`);
  }
  assert.equal(ready(report({ today: today({ items: [visit({ endsAt: "2026-10-28T04:00:00.123457Z" })] }) })).items[0].endsAt, "2026-10-28T04:00:00.123457Z");
});

test("status and clinic/operator confirmation remain separate facts, including unknown status", () => {
  for (const [status, actionable] of [["scheduled", "1"], ["confirmed", "1"], ["arrived", "0"], ["no_show", "0"], ["cancelled", "0"], ["unknown", "0"]]) {
    for (const confirmation of [
      { clinicConfirmedAt: null, operatorCheckResult: null },
      { clinicConfirmedAt: "2026-10-27T12:00:00.123456Z", operatorCheckResult: null },
      ...["confirmed", "unconfirmed", "unreachable"].map(operatorCheckResult => ({ clinicConfirmedAt: "2026-10-28T04:10:00.123456Z", operatorCheckResult })),
    ]) {
      const value = report({ today: today({ actionable, items: [visit({ status, ...confirmation })] }) });
      assert.deepEqual(accepted(value), value);
    }
  }
  for (const status of [null, undefined, 0, false, "", "completed", "UNKNOWN", "unknown ", ["unknown"], {}]) {
    refused(report({ today: today({ items: [visit({ status })] }) }), `invalid status ${String(status)}`);
  }
  for (const operatorCheckResult of ["confirmed", "unconfirmed", "unreachable"]) {
    refused(report({ today: today({ items: [visit({ operatorCheckResult, clinicConfirmedAt: null })] }) }), "operator check requires clinic confirmation");
  }
  for (const operatorCheckResult of [undefined, false, 0, "", "arrived", "CONFIRMED", "confirmed ", [], {}]) {
    refused(report({ today: today({ items: [visit({ operatorCheckResult, clinicConfirmedAt: generatedAt })] }) }), `invalid operator check ${String(operatorCheckResult)}`);
  }
});

test("agenda order is ascending instant, lowercase request UUID, then lowercase appointment UUID", () => {
  const companies = [company(), company({ requestId: requestB })];
  const aggregate = summary({ bookingStatuses: buckets({ scheduled: "7" }) });
  const rows = [visit(), visit({ appointmentId: appointmentB.toUpperCase() }),
    visit({ requestId: requestB.toUpperCase(), appointmentId: "22222222-2222-4222-8222-222222222222" })];
  const value = report({ companies, summary: aggregate, today: today({ total: "3", items: rows }) });
  assert.deepEqual(ready(value).items.map(v => [v.requestId, v.appointmentId]), [
    [requestA, appointmentA], [requestA, appointmentB], [requestB, "22222222-2222-4222-8222-222222222222"],
  ]);
  refused({ ...value, today: today({ total: "3", items: [rows[1], rows[0], rows[2]] }) }, "appointment tie-breaker reversed");
  refused({ ...value, today: today({ total: "3", items: [rows[2], rows[0], rows[1]] }) }, "request tie-breaker outranks appointment UUID");
  const earlier = visit({ requestId: requestB, appointmentId: appointmentB, startsAt: "2026-10-28T04:00:00.123455Z" });
  assert.deepEqual(ready(report({ companies, summary: aggregate, today: today({ total: "2", items: [earlier, rows[0]] }) })).items, [earlier, rows[0]]);
  refused(report({ companies, summary: aggregate, today: today({ total: "2", items: [rows[0], earlier] }) }), "instant outranks request and appointment ordering");
});

test("microsecond order and equivalent fractions are compared without millisecond rounding", () => {
  const aggregate = summary({ bookingStatuses: buckets({ scheduled: "7" }) });
  for (const [first, second] of [
    ["2026-10-28T04:00:00.123455Z", "2026-10-28T04:00:00.123456Z"],
    ["2026-10-28T04:00:00Z", "2026-10-28T04:00:00.000001Z"],
    ["2026-10-28T04:00:00.099999Z", "2026-10-28T04:00:00.1Z"],
    ["2026-10-28T04:00:00.123449Z", "2026-10-28T04:00:00.12345Z"],
  ]) {
    const earlier = visit({ appointmentId: appointmentB, startsAt: first, endsAt: null });
    const later = visit({ appointmentId: appointmentA, startsAt: second, endsAt: null });
    assert.deepEqual(ready(report({ summary: aggregate, today: today({ total: "2", items: [earlier, later] }) })).items, [earlier, later]);
    refused(report({ summary: aggregate, today: today({ total: "2", items: [later, earlier] }) }), `${second} must follow ${first}`);
  }
  for (const [first, second] of [
    ["2026-10-28T04:00:00Z", "2026-10-28T04:00:00.000000Z"],
    ["2026-10-28T04:00:00.1Z", "2026-10-28T04:00:00.100000Z"],
    ["2026-10-28T04:00:00.12345Z", "2026-10-28T04:00:00.123450Z"],
  ]) {
    const rows = [visit({ startsAt: first }), visit({ appointmentId: appointmentB, startsAt: second })];
    assert.deepEqual(ready(report({ summary: aggregate, today: today({ total: "2", items: rows }) })).items, rows);
    refused(report({ summary: aggregate, today: today({ total: "2", items: [...rows].reverse() }) }), "equivalent fractions use UUID tie-breakers");
  }
});

test("appointments cannot be duplicated, including normalized or nonadjacent identities", () => {
  const aggregate = summary({ bookingStatuses: buckets({ scheduled: "6", cancelled: "1" }) });
  for (const duplicate of [visit(), visit({ appointmentId: appointmentA.toUpperCase() }),
    visit({ startsAt: "2026-10-28T05:00:00Z", status: "cancelled", endsAt: null })]) {
    refused(report({ summary: aggregate, today: today({ total: "2", actionable: duplicate.status === "cancelled" ? "1" : "2", items: [visit(), duplicate] }) }), "duplicate appointment");
  }
  refused(report({ summary: aggregate, today: today({ total: "3", items: [visit(), visit({ appointmentId: appointmentB, startsAt: "2026-10-28T05:00:00Z", endsAt: null }),
    visit({ startsAt: "2026-10-28T06:00:00Z", endsAt: null })] }) }), "nonadjacent duplicate appointment");
  refused(report({ summary: aggregate, today: today({ total: "2", items: [visit({ appointmentId: appointmentB }),
    visit({ appointmentId: appointmentB.toUpperCase(), startsAt: "2026-10-28T05:00:00Z", endsAt: null })] }) }), "case-only duplicate appointment with alphabetic hex digits");
});

const invalidInstants: unknown[] = [null, undefined, 0, NaN, Infinity, new Date(generatedAt), "", "not-a-date", "2026-10-28",
  "0000-01-01T00:00:00Z", "10000-01-01T00:00:00Z", "+002026-10-28T00:00:00Z", "275760-09-13T00:00:00Z",
  "1900-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z",
  "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-00T00:00:00Z", "2026-01-32T00:00:00Z",
  "2026-10-28T24:00:00Z", "2026-10-28T04:60:00Z", "2026-10-28T04:00:60Z", "2026-10-28T04:00Z",
  "2026-10-28 04:00:00Z", "2026-10-28t04:00:00z", "2026-10-28T04:00:00", "2026-10-28T04:00:00+00:00",
  "2026-10-28T04:00:00+05:00", "2026-10-28T04:00:00.Z", "2026-10-28T04:00:00.1234567Z", " 2026-10-28T04:00:00Z",
  "2026-10-28T04:00:00Z ", "2026-10-28T04:00:00Z\n", "2026-10-28T04:00:00Z\r", "2026-10-28T04:00:00Z\r\n", "2026-10-28T04:00:00Z\u2028"];

for (const [index, instant] of invalidInstants.entries()) {
  test(`invalid UTC instant case ${index + 1} is rejected in all instant fields without throwing`, () => {
    refused(emptyReport({ generatedAt: instant }), `generatedAt: ${String(instant)}`);
    for (const field of ["startsAt", "endsAt", "clinicConfirmedAt"]) {
      if (instant !== null || field === "startsAt") refused(report({ today: today({ items: [visit({ [field]: instant })] }) }), `${field}: ${String(instant)}`);
    }
    for (const field of ["dayStart", "dayEnd"]) {
      refused(noVisits({ companies: [company({ [field]: instant })] }), `${field}: ${String(instant)}`);
    }
  });
}

test("real UTC instants preserve one through six fractional digits and calendar extremes", () => {
  for (const at of ["0001-01-01T00:00:00Z", "9999-12-31T23:59:59.999999Z", "2000-02-29T12:34:56Z", "2024-02-29T12:34:56Z"]) {
    assert.equal(accepted(emptyReport({ generatedAt: at })).generatedAt, at);
  }
  for (const fraction of ["", ".1", ".12", ".123", ".1234", ".12345", ".123456"]) {
    const at = `2026-10-28T04:00:00${fraction}Z`;
    assert.equal(accepted(noVisits({ generatedAt: at })).generatedAt, at);
    const value = report({ today: today({ items: [visit({ startsAt: at, endsAt: `2026-10-28T05:00:00${fraction}Z`, clinicConfirmedAt: at })] }) });
    assert.deepEqual(accepted(value), value);
  }
  refused(noVisits({ generatedAt: "9999-12-31T12:00:00Z", companies: [company({ timeZone: "UTC", localDate: "9999-12-31",
    dayStart: "9999-12-31T00:00:00Z", dayEnd: "+010000-01-01T00:00:00Z" })] }), "overflowed day end is not a valid four-digit instant");
});

test("public text retains whitespace and valid Unicode but enforces field bounds without coercion", () => {
  const fields = [["company", "displayName", 200], ["visit", "clientName", 500], ["visit", "clientPhone", 80],
    ["visit", "service", 4000], ["visit", "doctorName", 200]] as const;
  for (const [target, field, limit] of fields) {
    for (const text of ["A".repeat(limit), "\u041a\u043b\u0438\u043d\u0438\u043a\u0430", "\u533b\u9662", " Line\tTwo\nThree\r "]) {
      const value = report(); recordAt(value, target)[field] = text;
      assert.equal(recordAt(accepted(value), target)[field], text);
    }
    for (const text of [undefined, null, 0, false, [], {}, new String("Patient"), "A".repeat(limit + 1), "A\u0000B", "A\u0008B", "A\u000bB", "A\u000cB", "A\u001fB", "A\u007fB"]) {
      const value = report(); recordAt(value, target)[field] = text;
      refused(value, `${target}.${field} invalid or over ${limit} characters`);
    }
    if (target === "visit") {
      const value = report(); recordAt(value, target)[field] = "";
      assert.deepEqual(accepted(value), value);
    }
  }
  for (const displayName of ["", " ", "\t\r\n"]) refused(noVisits({ companies: [company({ displayName })] }), "company name must not be blank");
});

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}

test("successful parsing normalizes into detached objects without mutating or sorting the input", () => {
  const value = report({ companies: [company({ requestId: requestA.toUpperCase() })],
    today: today({ items: [visit({ requestId: requestA.toUpperCase(), appointmentId: appointmentB.toUpperCase() })] }) });
  const original = structuredClone(value);
  freezeDeep(value);
  const parsed = accepted(value);
  assert.deepEqual(value, original);
  assert.notEqual(parsed, value);
  assert.notEqual(parsed.companies, value.companies);
  assert.notEqual(parsed.companies[0], value.companies[0]);
  assert.notEqual(parsed.summary, value.summary);
  assert.notEqual(parsed.summary.bookingStatuses, value.summary.bookingStatuses);
  assert.notEqual(parsed.today, value.today);
  assert.notEqual(ready(parsed).items, (value.today as Ready).items);
  assert.notEqual(ready(parsed).items[0], (value.today as Ready).items[0]);
  parsed.companies[0].displayName = "Changed output";
  parsed.summary.availableLeads = "99";
  parsed.summary.bookingStatuses.scheduled = "99";
  (parsed.today as Ready).items[0].clientName = "Changed output";
  assert.deepEqual(value, original);
});

test("one invalid late row rejects the whole report, without partial repair or input mutation", () => {
  const bad = page("20", 0, 20, false);
  (bad.today as Ready).items[19].requestId = requestC;
  const original = structuredClone(bad);
  freezeDeep(bad);
  refused(bad, "the last row references a request outside the manifest");
  assert.deepEqual(bad, original);
  const unsorted = report({ companies: [company({ requestId: requestB }), company()] });
  const before = structuredClone(unsorted);
  freezeDeep(unsorted);
  refused(unsorted, "do not sort the caller's manifest to make it valid");
  assert.deepEqual(unsorted, before);
  const missing = report({ companies: [company({ timeZone: null, localDate: null, dayStart: null, dayEnd: null })], today: unavailable() });
  const missingBefore = structuredClone(missing);
  freezeDeep(missing);
  assert.deepEqual(accepted(missing), missingBefore);
  assert.deepEqual(missing, missingBefore);
});
