import assert from "node:assert/strict";
import test from "node:test";

const imported = await import(new URL("../../lib/crm/partner-company-contracts.ts", import.meta.url).href);
const { parsePartnerCompany, parsePartnerCompanyApplication, parsePartnerCompanyContext, parsePartnerCompanyReceipt,
  parsePartnerCompanyReviewCommand, parsePartnerCompanyReviewReceipt, parsePartnerCompanyPage } =
  (imported.default ?? imported) as RuntimeContract;

// Keep the actual module import runtime-only so scripts retains its own rootDir.
type Company = Readonly<{ name: string; purpose: "clinic_services" | "marketing" | "mortgage_leads";
  vertical: "clinic" | "beauty" | "dental" | null; timeZone: string; ownerName: string }>;
type CompanyState = "pending" | "approved" | "rejected";
type Application = Readonly<{ id: string; revision: string; state: CompanyState; company: Company; workspaceId: string | null;
  sourceState: "captured" | "expired" | "pending_payment" | "bound"; expiresAt: string; submittedAt: string; reviewedAt: string | null }>;
type Context = Readonly<{ sourceId: string; expiresAt: string; applicantEmail: string;
  notice: Readonly<{ version: string; purpose: "partner_company_registration"; text: string;
    policyRevision: string; policyUrl: string; sha256: string }> }>;
type ReviewCommand = Readonly<{ requestId: string; applicationId: string; revision: string; action: "approve" | "reject" }>;
type Page = Readonly<{ items: readonly Application[]; offset: number; state: CompanyState | null; hasMore: boolean }>;
type RuntimeContract = {
  parsePartnerCompany(value: unknown): Company | null;
  parsePartnerCompanyApplication(value: unknown): Application | null;
  parsePartnerCompanyContext(value: unknown): Context | null;
  parsePartnerCompanyReceipt(value: unknown): Readonly<Row> | null;
  parsePartnerCompanyReviewCommand(value: unknown): ReviewCommand | null;
  parsePartnerCompanyReviewReceipt(value: unknown): Readonly<Row> | null;
  parsePartnerCompanyPage(value: unknown, expected?: { offset: number; state: CompanyState | null }): Page | null;
};
type Row = Record<string, unknown>;
type Parser = (value: unknown) => unknown;
type Shape = { name: string; parse: Parser; fixture: () => object };

const applicationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const originalRevision = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const terminalRevision = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const sourceId = "dddddddd-dddd-4ddd-bddd-dddddddddddd";
const workspaceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const reviewRequestId = "ffffffff-ffff-4fff-9fff-ffffffffffff";
const submittedAt = "2026-10-28T12:00:00.123456Z";
const reviewedAt = "2026-10-29T12:00:00.123457Z";
const expiresAt = "2026-11-04T12:00:00.123456Z";

function company(patch: Partial<Company> = {}): Company {
  return { name: "Synthetic Company", purpose: "marketing", vertical: null, timeZone: "UTC",
    ownerName: "Synthetic Owner", ...patch };
}

function application(patch: Partial<Application> = {}): Application {
  return { id: applicationId, revision: originalRevision, state: "pending", company: company(), workspaceId: null,
    sourceState: "captured", expiresAt, submittedAt, reviewedAt: null, ...patch };
}

function terminal(state: "approved" | "rejected" = "approved", patch: Partial<Application> = {}): Application {
  return application({ state, revision: terminalRevision, reviewedAt, workspaceId: state === "approved" ? workspaceId : null,
    sourceState: state === "approved" ? "pending_payment" : "captured", ...patch });
}

function notice(patch: Partial<Context["notice"]> = {}): Context["notice"] {
  return { version: "notice.v1", purpose: "partner_company_registration", text: "Synthetic company registration notice.",
    policyRevision: "policy-v1", policyUrl: "https://policy.example.test/privacy", sha256: "ab".repeat(32), ...patch };
}

function context(patch: Partial<Context> = {}): Context {
  return { sourceId, expiresAt, notice: notice(), applicantEmail: "owner@example.test", ...patch };
}

function receipt(state: "unconfirmed" | "abandoned" | "committed" = "committed") {
  return state === "committed" ? { state, requestId: applicationId, sourceId, application: application() }
    : { state, requestId: applicationId, sourceId };
}

function command(patch: Partial<ReviewCommand> = {}): ReviewCommand {
  return { requestId: reviewRequestId, applicationId, revision: originalRevision, action: "approve", ...patch };
}

function reviewReceipt(state: "unconfirmed" | "abandoned" | "committed" = "committed", action: ReviewCommand["action"] = "approve") {
  return state === "committed" ? { ...command({ action }), state, application: terminal(action === "approve" ? "approved" : "rejected") }
    : { ...command({ action }), state };
}

function page(patch: Partial<Page> = {}): Page {
  return { items: [application()], offset: 0, state: null, hasMore: false, ...patch };
}

function pageItems(count: number): Application[] {
  return Array.from({ length: count }, (_, index) => application({
    id: `00000000-0000-4000-8000-${(count - index).toString(16).padStart(12, "0")}`,
  }));
}

function accepted<T>(parse: (value: unknown) => T | null, value: unknown): T {
  const result = parse(value);
  assert.notEqual(result, null, "valid synthetic payload must be accepted");
  return result as T;
}

function assertDetachedFrozen(actual: unknown, input: unknown): void {
  if (!input || typeof input !== "object") return;
  assert.ok(actual && typeof actual === "object");
  assert.notEqual(actual, input);
  assert.equal(Object.isFrozen(actual), true);
  assert.equal(Object.isFrozen(input), false);
  for (const key of Object.keys(input)) {
    assertDetachedFrozen((actual as Row)[key], (input as Row)[key]);
  }
}

const shapes: Shape[] = [
  { name: "company", parse: parsePartnerCompany, fixture: company },
  { name: "application", parse: parsePartnerCompanyApplication, fixture: application },
  { name: "approved application", parse: parsePartnerCompanyApplication, fixture: () => terminal() },
  { name: "rejected application", parse: parsePartnerCompanyApplication, fixture: () => terminal("rejected") },
  { name: "context", parse: parsePartnerCompanyContext, fixture: context },
  { name: "nested notice", parse: value => parsePartnerCompanyContext({ ...context(), notice: value }), fixture: notice },
  ...(["unconfirmed", "abandoned", "committed"] as const).map(state => ({
    name: `${state} submit receipt`, parse: parsePartnerCompanyReceipt, fixture: () => receipt(state),
  })),
  { name: "review command", parse: parsePartnerCompanyReviewCommand, fixture: command },
  ...(["unconfirmed", "abandoned", "committed"] as const).map(state => ({
    name: `${state} review receipt`, parse: parsePartnerCompanyReviewReceipt, fixture: () => reviewReceipt(state),
  })),
  { name: "rejected review receipt", parse: parsePartnerCompanyReviewReceipt, fixture: () => reviewReceipt("committed", "reject") },
  { name: "page", parse: parsePartnerCompanyPage, fixture: page },
];

test("the actual portable contract exports all seven parsers", () => {
  for (const parse of [parsePartnerCompany, parsePartnerCompanyApplication, parsePartnerCompanyContext,
    parsePartnerCompanyReceipt, parsePartnerCompanyReviewCommand, parsePartnerCompanyReviewReceipt, parsePartnerCompanyPage]) {
    assert.equal(typeof parse, "function");
  }
});

for (const { name, parse, fixture } of shapes) {
  test(`${name}: accepts JSON, reordered own keys, and null-prototype records`, () => {
    const value = fixture();
    const expected = accepted(parse, value);
    for (const wire of [JSON.parse(JSON.stringify(value)), Object.fromEntries(Object.entries(value).reverse()),
      Object.assign(Object.create(null), value)]) {
      assert.deepEqual(accepted(parse, wire), expected);
    }
  });

  test(`${name}: refuses primitives, arrays, boxed values, and decorated arrays`, () => {
    for (const value of [undefined, null, false, true, 0, 1, NaN, Infinity, 0n, Symbol("synthetic"), "{}", [],
      [fixture()], new String("synthetic"), new Date(submittedAt), () => fixture(), Object.assign([], fixture())]) {
      assert.equal(parse(value), null, typeof value);
    }
  });

  test(`${name}: every key must be own and cannot be replaced or inherited`, () => {
    for (const key of Object.keys(fixture())) {
      const value = { ...fixture() } as Row;
      const inherited = value[key];
      delete value[key];
      assert.equal(parse(value), null, `missing ${key}`);
      Object.setPrototypeOf(value, { [key]: inherited });
      assert.equal(parse(value), null, `inherited ${key}`);
      value[`replacement_${key}`] = inherited;
      assert.equal(parse(value), null, `padded inherited ${key}`);
    }
  });

  test(`${name}: exact keys refuse private and prototype-shaped JSON additions`, () => {
    for (const key of ["unexpected", "privateAuth", "actorId", "ownerEmail", "capability", "__proto__", "constructor", "prototype"]) {
      const value = { ...fixture(), [key]: "synthetic-only" };
      assert.equal(parse(value), null, key);
      assert.equal(parse(JSON.parse(JSON.stringify(value))), null, `JSON ${key}`);
    }
  });

  if (name !== "nested notice") {
    test(`${name}: returns a recursively detached frozen copy and leaves input unchanged`, () => {
      const value = fixture();
      const before = structuredClone(value);
      const result = accepted(parse, value);
      assert.deepEqual(result, before);
      assertDetachedFrozen(result, value);
      assert.deepEqual(value, before);
      Object.freeze(value);
      assert.deepEqual(accepted(parse, value), before);
      const invalid = Object.freeze({ ...fixture(), unexpected: true });
      assert.equal(parse(invalid), null);
      assert.equal(invalid.unexpected, true);
    });
  }
}

test("nested company, notice, and item references cannot mutate successful results later", () => {
  const app = application();
  const appResult = accepted(parsePartnerCompanyApplication, app);
  Reflect.set(app.company, "name", "Changed synthetic company");
  assert.equal(appResult.company.name, "Synthetic Company");
  const ctx = context();
  const ctxResult = accepted(parsePartnerCompanyContext, ctx);
  Reflect.set(ctx.notice, "text", "Changed synthetic notice");
  assert.equal(ctxResult.notice.text, notice().text);
  assert.equal(Reflect.set(ctxResult, "applicantEmail", "other@example.test"), false);
  const value = page();
  const result = accepted(parsePartnerCompanyPage, value);
  Reflect.set(value.items[0], "id", sourceId);
  Reflect.set(value.items, "0", terminal());
  assert.equal(result.items[0].id, applicationId);
  assert.equal(result.items[0].state, "pending");
});

test("company: purpose and vertical combinations follow SQL 121", () => {
  for (const purpose of ["clinic_services", "marketing", "mortgage_leads"] as const) {
    for (const vertical of [null, "clinic", "beauty", "dental"] as const) {
      const value = company({ purpose, vertical });
      if (purpose === "clinic_services" ? vertical !== null : vertical === null) {
        assert.deepEqual(accepted(parsePartnerCompany, value), value);
      } else assert.equal(parsePartnerCompany(value), null, `${purpose}/${vertical}`);
    }
  }
  for (const purpose of [null, undefined, true, 0, [], {}, "", "MARKETING", "marketing ", "marketing\n"]) {
    assert.equal(parsePartnerCompany({ ...company(), purpose }), null);
  }
  for (const vertical of [undefined, false, 0, [], {}, "", "CLINIC", "clinic ", "clinic\n", "other"]) {
    assert.equal(parsePartnerCompany({ ...company({ purpose: "clinic_services" }), vertical }), null);
  }
});

for (const [key, min, max] of [["name", 2, 120], ["ownerName", 1, 120]] as const) {
  test(`company.${key}: exact text bounds, no trimming, controls, or coercion`, () => {
    for (const value of ["x".repeat(min), "x".repeat(max), "Synthetic \u0418\u043c\u044f"]) {
      assert.equal(accepted(parsePartnerCompany, { ...company(), [key]: value })[key], value);
    }
    for (const value of [undefined, null, false, 1, [], {}, new String("Synthetic"), "x".repeat(min - 1),
      "x".repeat(max + 1), " Synthetic", "Synthetic ", "Synthetic\n", "\tSynthetic", "   ", "\u00a0Synthetic",
      ...Array.from({ length: 32 }, (_, code) => `Synthetic${String.fromCharCode(code)}name`), "Synthetic\u007fname"]) {
      assert.equal(parsePartnerCompany({ ...company(), [key]: value }), null, JSON.stringify(value));
    }
  });
}

test("company.timeZone: validates real zones without normalizing the supplied name", () => {
  for (const timeZone of ["UTC", "Etc/UTC", "Asia/Qyzylorda", "America/New_York"]) {
    assert.equal(accepted(parsePartnerCompany, company({ timeZone })).timeZone, timeZone);
  }
  for (const timeZone of [undefined, null, false, 1, [], {}, new String("UTC"), "", "x".repeat(81),
    "Not/A_Zone", " UTC", "UTC ", "UTC\n", "UTC\u0000"]) {
    assert.equal(parsePartnerCompany({ ...company(), timeZone }), null, String(timeZone));
  }
});

test("company.timeZone: numeric offsets are not SQL pg_timezone_names entries", () => {
  for (const timeZone of ["+05:00", "-03:30", "+0500"]) {
    assert.equal(parsePartnerCompany(company({ timeZone })), null, timeZone);
  }
});

const uuidSlots: { name: string; parse: Parser }[] = [
  ...["id", "revision"].map(key => ({ name: `application.${key}`,
    parse: (value: unknown) => parsePartnerCompanyApplication({ ...application(), [key]: value }) })),
  { name: "approved.workspaceId", parse: value => parsePartnerCompanyApplication({ ...terminal(), workspaceId: value }) },
  { name: "context.sourceId", parse: value => parsePartnerCompanyContext({ ...context(), sourceId: value }) },
  { name: "submit.requestId", parse: value => parsePartnerCompanyReceipt({ ...receipt("unconfirmed"), requestId: value }) },
  { name: "submit.sourceId", parse: value => parsePartnerCompanyReceipt({ ...receipt(), sourceId: value }) },
  ...["requestId", "applicationId", "revision"].map(key => ({ name: `review command.${key}`,
    parse: (value: unknown) => parsePartnerCompanyReviewCommand({ ...command(), [key]: value }) })),
  ...["requestId", "applicationId", "revision"].map(key => ({ name: `review receipt.${key}`,
    parse: (value: unknown) => parsePartnerCompanyReviewReceipt({ ...reviewReceipt("unconfirmed"), [key]: value }) })),
];

for (const { name, parse } of uuidSlots) {
  test(`${name}: accepts UUID versions 1-5 and RFC variants, including uppercase`, () => {
    for (const version of [1, 2, 3, 4, 5]) {
      for (const variant of ["8", "9", "a", "b"]) {
        const value = `abcdefab-cdef-${version}abc-${variant}abc-abcdefabcdef`;
        assert.ok(parse(value), value);
        assert.ok(parse(value.toUpperCase()), value.toUpperCase());
      }
    }
  });

  test(`${name}: refuses malformed UUIDs, wrong variants, and nonstrings`, () => {
    for (const value of [undefined, null, false, 1, [], {}, new String(applicationId), "", "not-a-uuid",
      applicationId.replaceAll("-", ""), `{${applicationId}}`, `urn:uuid:${applicationId}`, ` ${applicationId}`,
      `${applicationId} `, `${applicationId}\u0000`, "00000000-0000-0000-0000-000000000000",
      ...["0", "6", "7", "8", "f"].map(version => `aaaaaaaa-aaaa-${version}aaa-8aaa-aaaaaaaaaaaa`),
      ...["0", "1", "7", "c", "d", "e", "f"].map(variant => `aaaaaaaa-aaaa-4aaa-${variant}aaa-aaaaaaaaaaaa`)]) {
      assert.equal(parse(value), null, String(value));
    }
  });

  test(`${name}: trailing line terminators cannot satisfy an exact UUID`, () => {
    for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      assert.equal(parse(applicationId + suffix), null, JSON.stringify(suffix));
    }
  });
}

const timeSlots: { name: string; parse: Parser }[] = [
  { name: "context.expiresAt", parse: value => parsePartnerCompanyContext({ ...context(), expiresAt: value }) },
  { name: "application.submittedAt", parse: value => parsePartnerCompanyApplication({ ...application(),
    submittedAt: value, expiresAt: "9999-12-31T23:59:59.999999Z" }) },
  { name: "application.expiresAt", parse: value => parsePartnerCompanyApplication({ ...application(),
    submittedAt: "0001-01-01T00:00:00Z", expiresAt: value }) },
  { name: "application.reviewedAt", parse: value => parsePartnerCompanyApplication({ ...terminal(),
    submittedAt: "0001-01-01T00:00:00Z", reviewedAt: value }) },
];

for (const { name, parse } of timeSlots) {
  test(`${name}: accepts real UTC dates with zero through six fractional digits`, () => {
    for (const value of ["0001-01-02T00:00:00Z", "9999-12-30T23:59:59.999999Z", "2000-02-29T12:34:56Z",
      "2024-02-29T23:59:59Z", ...["1", "12", "123", "1234", "12345", "123456", "000001", "999999"]
        .map(fraction => `2026-10-28T12:00:00.${fraction}Z`)]) {
      assert.ok(parse(value), value);
    }
  });

  test(`${name}: refuses rolled dates, offsets, excessive precision, and nonstrings`, () => {
    for (const value of [undefined, null, false, 0, NaN, Infinity, [], {}, new Date(submittedAt), new String(submittedAt), "",
      "0000-01-01T00:00:00Z", "10000-01-01T00:00:00Z", "+002026-10-28T00:00:00Z", "1900-02-29T00:00:00Z",
      "2100-02-29T00:00:00Z", "2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z",
      "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-00T00:00:00Z", "2026-01-32T00:00:00Z",
      "2026-10-28T24:00:00Z", "2026-10-28T12:60:00Z", "2026-10-28T12:00:60Z", "2026-10-28", "not-a-date",
      "2026-10-28T12:00:00.Z", "2026-10-28T12:00:00.1234567Z", "2026-10-28T12:00:00+00:00",
      "2026-10-28T12:00:00-05:00", "2026-10-28T12:00:00", "2026-10-28 12:00:00Z", "2026-10-28t12:00:00z",
      ` ${submittedAt}`, `${submittedAt} `, `${submittedAt}\n`, `${submittedAt}\r`, `${submittedAt}\u0000`]) {
      assert.equal(parse(value), null, String(value));
    }
  });
}

test("application: microsecond chronology does not round, truncate, or compare raw fractional strings", () => {
  const start = "2026-10-28T12:00:00.123456Z";
  const end = "2026-10-28T12:00:00.123457Z";
  const value = terminal("approved", { submittedAt: start, expiresAt: end, reviewedAt: start });
  assert.deepEqual(accepted(parsePartnerCompanyApplication, value), value);
  assert.equal(parsePartnerCompanyApplication({ ...value, expiresAt: start }), null);
  assert.equal(parsePartnerCompanyApplication({ ...value, expiresAt: "2026-10-28T12:00:00.123455Z" }), null);
  assert.equal(parsePartnerCompanyApplication({ ...value, reviewedAt: "2026-10-28T12:00:00.123455Z" }), null);
  assert.ok(parsePartnerCompanyApplication(terminal("approved", { submittedAt: "2026-10-28T12:00:00.1Z",
    expiresAt: "2026-10-28T12:00:00.100001Z", reviewedAt: "2026-10-28T12:00:00.100000Z" })));
  assert.equal(parsePartnerCompanyApplication(application({ submittedAt: "2026-10-28T12:00:00.1Z",
    expiresAt: "2026-10-28T12:00:00.100000Z" })), null);
});

test("application: pending and terminal state, workspace, source, and review fields are coherent", () => {
  for (const state of ["pending", "approved", "rejected"] as const) {
    for (const sourceState of ["captured", "expired", "pending_payment", "bound"] as const) {
      const value = state === "pending" ? application({ sourceState }) : terminal(state, { sourceState });
      const valid = state === "approved" ? sourceState !== "captured" : sourceState === "captured" || sourceState === "expired";
      if (valid) assert.deepEqual(accepted(parsePartnerCompanyApplication, value), value);
      else assert.equal(parsePartnerCompanyApplication(value), null, `${state}/${sourceState}`);
    }
    const value = state === "pending" ? application() : terminal(state);
    assert.equal(parsePartnerCompanyApplication({ ...value, workspaceId: state === "approved" ? null : workspaceId }), null);
    assert.equal(parsePartnerCompanyApplication({ ...value, reviewedAt: state === "pending" ? reviewedAt : null }), null);
  }
  for (const state of [undefined, null, false, 1, [], {}, "", "PENDING", "pending ", "pending\n", "committed"]) {
    assert.equal(parsePartnerCompanyApplication({ ...application(), state }), null);
  }
  for (const sourceState of [undefined, null, false, 1, [], {}, "", "CAPTURED", "captured ", "captured\n", "approved"]) {
    assert.equal(parsePartnerCompanyApplication({ ...application(), sourceState }), null);
  }
});

test("application: late approval or rejection retains the expired original source window", () => {
  for (const state of ["approved", "rejected"] as const) {
    const value = terminal(state, { sourceState: "expired", reviewedAt: "2026-11-05T12:00:00.123456Z" });
    assert.deepEqual(accepted(parsePartnerCompanyApplication, value), value);
  }
});

for (const { name, parse } of [
  { name: "pending sourceState", parse: (value: unknown) => parsePartnerCompanyApplication({ ...application(), sourceState: value }) },
  { name: "approved sourceState", parse: (value: unknown) => parsePartnerCompanyApplication({ ...terminal(), sourceState: value }) },
  { name: "submit receipt state", parse: (value: unknown) => parsePartnerCompanyReceipt({ ...receipt("unconfirmed"), state: value }) },
]) {
  test(`${name}: malformed JSON objects fail closed before enum coercion`, () => {
    for (const value of [JSON.parse('{"toString":null}'), JSON.parse('{"toString":{}}'), Object.create(null)]) {
      assert.equal(parse(value), null);
    }
  });

  test(`${name}: invalid enum types cannot invoke coercion hooks`, () => {
    let calls = 0;
    const value = { toString() { calls += 1; throw new Error("synthetic coercion trap"); } };
    assert.equal(parse(value), null);
    assert.equal(calls, 0);
  });
}

test("nested company validation propagates through applications, receipts, and pages", () => {
  for (const company of [null, [], { ...application().company, ownerName: "Synthetic\u0000Owner" },
    { ...application().company, unexpected: true }, { ...application().company, purpose: "clinic_services", vertical: null }]) {
    const pending = { ...application(), company };
    const approved = { ...terminal(), company };
    assert.equal(parsePartnerCompanyApplication(pending), null);
    assert.equal(parsePartnerCompanyReceipt({ ...receipt(), application: pending }), null);
    assert.equal(parsePartnerCompanyReviewReceipt({ ...reviewReceipt(), application: approved }), null);
    assert.equal(parsePartnerCompanyPage({ ...page(), items: [pending] }), null);
  }
});

test("context: applicantEmail preserves valid server-supplied values without adding an owner field", () => {
  for (const applicantEmail of ["owner@example.test", "Synthetic.Owner+tag@Example.Test", `${"a".repeat(241)}@example.test`]) {
    assert.equal(applicantEmail.length <= 254, true);
    assert.equal(accepted(parsePartnerCompanyContext, context({ applicantEmail })).applicantEmail, applicantEmail);
  }
  for (const applicantEmail of [undefined, null, false, 1, [], {}, new String("owner@example.test"), "", "owner", "owner@example",
    "@example.test", "owner@@example.test", "owner @example.test", " owner@example.test", "owner@example.test ",
    `${"a".repeat(242)}@example.test`]) {
    assert.equal(parsePartnerCompanyContext({ ...context(), applicantEmail }), null, String(applicantEmail));
  }
});

test("context: applicantEmail refuses trailing line terminators and embedded ASCII controls", () => {
  for (const applicantEmail of ["owner@example.test\n", "owner@example.test\r", "owner@example.test\r\n",
    "owner@example.test\u2028", "owner@example.test\u2029", "ow\u0000ner@example.test", "owner@exam\u0000ple.test",
    "owner@example.test\u0000", "ow\u007fner@example.test"]) {
    assert.equal(parsePartnerCompanyContext(context({ applicantEmail })), null, JSON.stringify(applicantEmail));
  }
});

test("notice: only the company registration purpose and bounded exact versions are accepted", () => {
  for (const version of ["1", "v1.0_A-B", "x".repeat(40)]) {
    assert.equal(accepted(parsePartnerCompanyContext, context({ notice: notice({ version }) })).notice.version, version);
  }
  for (const purpose of [undefined, null, false, 1, "partner_attribution", "marketing", "PARTNER_COMPANY_REGISTRATION",
    "partner_company_registration ", "partner_company_registration\n"]) {
    assert.equal(parsePartnerCompanyContext({ ...context(), notice: { ...notice(), purpose } }), null);
  }
  for (const version of [undefined, null, false, 1, [], {}, "", "x".repeat(41), "v1/0", "v 1", " v1", "v1 ", "v1\u0000"]) {
    assert.equal(parsePartnerCompanyContext({ ...context(), notice: { ...notice(), version } }), null);
  }
});

test("notice: version and SHA-256 shapes refuse final line terminators", () => {
  for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    assert.equal(parsePartnerCompanyContext(context({ notice: notice({ version: `v1${suffix}` }) })), null, `version ${JSON.stringify(suffix)}`);
    assert.equal(parsePartnerCompanyContext(context({ notice: notice({ sha256: "ab".repeat(32) + suffix }) })), null,
      `sha256 ${JSON.stringify(suffix)}`);
  }
});

test("notice: legal text preserves line breaks, is nonblank and bounded, and refuses unsafe controls", () => {
  for (const text of ["x", "x".repeat(20_000), "  Synthetic notice  ", "Line one\nLine two\r\n\tIndented"]) {
    assert.equal(accepted(parsePartnerCompanyContext, context({ notice: notice({ text }) })).notice.text, text);
  }
  for (const text of [undefined, null, false, 1, [], {}, "", " \t\r\n", "\u00a0", "x".repeat(20_001),
    "Synthetic\u0000notice", "Synthetic\u000bnotice", "Synthetic\u001fnotice", "Synthetic\u007fnotice"]) {
    assert.equal(parsePartnerCompanyContext({ ...context(), notice: { ...notice(), text } }), null);
  }
  for (const policyRevision of ["", " revision", "revision ", "revision\n", "r".repeat(121), "r\u0000v"]) {
    assert.equal(parsePartnerCompanyContext(context({ notice: notice({ policyRevision }) })), null);
  }
  for (const sha256 of ["", "a".repeat(63), "a".repeat(65), "AB".repeat(32), "g".repeat(64), " " + "a".repeat(64)]) {
    assert.equal(parsePartnerCompanyContext(context({ notice: notice({ sha256 }) })), null);
  }
});

test("notice: policy URLs are safe HTTPS without credentials, fragments, whitespace, or backslashes", () => {
  for (const policyUrl of ["https://policy.example.test", "https://policy.example.test/privacy?revision=v1%2F2",
    "https://policy.example.test:8443/privacy", "HTTPS://Policy.Example.Test/privacy"]) {
    assert.equal(accepted(parsePartnerCompanyContext, context({ notice: notice({ policyUrl }) })).notice.policyUrl, policyUrl);
  }
  for (const policyUrl of [undefined, null, false, 1, [], {}, "", "not-a-url", "/privacy", "//policy.example.test/privacy",
    "http://policy.example.test/privacy", "javascript:alert(1)", "https://", "https://[invalid]/privacy",
    "https://user@policy.example.test/privacy", "https://user:password@policy.example.test/privacy",
    "https://policy.example.test/privacy#fragment", " https://policy.example.test/privacy", "https://policy.example.test/privacy\n",
    "https://policy.example.test\\privacy", "https://policy.example.test/" + "a".repeat(2048)]) {
    assert.equal(parsePartnerCompanyContext({ ...context(), notice: { ...notice(), policyUrl } }), null, String(policyUrl));
  }
});

test("submit receipt: exact noncommitted branches never carry an application", () => {
  for (const state of ["unconfirmed", "abandoned"] as const) {
    assert.deepEqual(accepted(parsePartnerCompanyReceipt, receipt(state)), receipt(state));
    for (const application of [undefined, null, {}, terminal()]) {
      assert.equal(parsePartnerCompanyReceipt({ ...receipt(state), application }), null);
    }
  }
  for (const state of [undefined, null, false, 1, [], {}, "", "pending", "COMMITTED", "committed ", "committed\n"]) {
    assert.equal(parsePartnerCompanyReceipt({ ...receipt(), state }), null);
  }
  assert.equal(parsePartnerCompanyReceipt({ state: "committed", requestId: applicationId, sourceId }), null);
});

test("submit receipt: requestId binds the application UUID case-insensitively across all application states", () => {
  for (const app of [application(), terminal(), terminal("rejected")]) {
    const value = { ...receipt(), application: app };
    assert.deepEqual(accepted(parsePartnerCompanyReceipt, value), value);
    assert.ok(parsePartnerCompanyReceipt({ ...value, requestId: applicationId.toUpperCase() }));
    assert.ok(parsePartnerCompanyReceipt({ ...value, application: { ...app, id: applicationId.toUpperCase() } }));
    assert.equal(parsePartnerCompanyReceipt({ ...value, requestId: sourceId }), null);
    assert.equal(parsePartnerCompanyReceipt({ ...value, application: { ...app, id: sourceId } }), null);
    assert.equal(parsePartnerCompanyReceipt({ ...value, application: { ...app, privateAuth: "synthetic" } }), null);
  }
});

test("review command: approve and reject are exact actions with no browser-selected actor", () => {
  for (const action of ["approve", "reject"] as const) {
    assert.deepEqual(accepted(parsePartnerCompanyReviewCommand, command({ action })), command({ action }));
  }
  for (const action of [undefined, null, false, 1, [], {}, new String("approve"), "", "approved", "APPROVE", "approve ", "approve\n"]) {
    assert.equal(parsePartnerCompanyReviewCommand({ ...command(), action }), null);
  }
  for (const key of ["actor", "owner", "ownerId", "workspaceId", "reviewedBy"]) {
    assert.equal(parsePartnerCompanyReviewCommand({ ...command(), [key]: sourceId }), null, key);
  }
});

test("review receipt: terminal application binds ID, action, and a changed original revision", () => {
  for (const action of ["approve", "reject"] as const) {
    const value = reviewReceipt("committed", action);
    assert.ok(parsePartnerCompanyReviewReceipt({ ...value, applicationId: applicationId.toUpperCase(),
      revision: originalRevision.toUpperCase() }));
    assert.equal(parsePartnerCompanyReviewReceipt({ ...value, applicationId: sourceId }), null);
    assert.equal(parsePartnerCompanyReviewReceipt({ ...value, action: action === "approve" ? "reject" : "approve" }), null);
    for (const revision of [terminalRevision, terminalRevision.toUpperCase()]) {
      assert.equal(parsePartnerCompanyReviewReceipt({ ...value, revision }), null);
    }
    assert.equal(parsePartnerCompanyReviewReceipt({ ...value, application: application() }), null);
    assert.equal(parsePartnerCompanyReviewReceipt({ ...value, application: { ...terminal(), id: sourceId } }), null);
    assert.equal(parsePartnerCompanyReviewReceipt({ ...value, application: { ...terminal(), revision: null } }), null);
  }
});

test("review receipt: noncommitted states retain exact metadata and cannot smuggle terminal data", () => {
  for (const state of ["unconfirmed", "abandoned"] as const) {
    for (const action of ["approve", "reject"] as const) {
      const value = reviewReceipt(state, action);
      assert.deepEqual(accepted(parsePartnerCompanyReviewReceipt, value), value);
      for (const application of [undefined, null, terminal()]) {
        assert.equal(parsePartnerCompanyReviewReceipt({ ...value, application }), null);
      }
    }
  }
  for (const state of [undefined, null, false, 1, [], {}, "", "pending", "COMMITTED", "committed ", "committed\n"]) {
    assert.equal(parsePartnerCompanyReviewReceipt({ ...reviewReceipt(), state }), null);
  }
});

test("page: exact size limit is twenty, with hasMore only on a full page", () => {
  for (const count of [0, 1, 19, 20]) {
    const value = page({ items: pageItems(count) });
    assert.deepEqual(accepted(parsePartnerCompanyPage, value), value);
    const more = { ...value, hasMore: true };
    if (count === 20) assert.deepEqual(accepted(parsePartnerCompanyPage, more), more);
    else assert.equal(parsePartnerCompanyPage(more), null, `hasMore with ${count} items`);
  }
  assert.equal(parsePartnerCompanyPage(page({ items: pageItems(21) })), null);
  for (const hasMore of [undefined, null, 0, 1, "false", "true", [], {}, new Boolean(false)]) {
    assert.equal(parsePartnerCompanyPage({ ...page(), hasMore }), null);
  }
});

test("page: offsets and state filters are validated and bound to the caller's exact request", () => {
  for (const offset of [0, 1, 19, 20, 999_999, 1_000_000]) {
    const value = page({ offset, items: [] });
    assert.deepEqual(parsePartnerCompanyPage(value, { offset, state: null }), value);
    assert.equal(parsePartnerCompanyPage(value, { offset: offset === 0 ? 1 : 0, state: null }), null);
  }
  for (const offset of [undefined, null, false, "0", 0n, [], {}, NaN, Infinity, -Infinity, -1, 0.5, 1_000_001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parsePartnerCompanyPage({ ...page(), offset }), null, String(offset));
  }
  for (const state of [null, "pending", "approved", "rejected"] as const) {
    const items = state === "approved" || state === "rejected" ? [terminal(state)] : [application()];
    const value = page({ state, items });
    assert.deepEqual(parsePartnerCompanyPage(value, { offset: 0, state }), value);
    assert.equal(parsePartnerCompanyPage(value, { offset: 0, state: state === null ? "pending" : null }), null);
    const wrong = state === "pending" ? terminal() : application();
    if (state !== null) assert.equal(parsePartnerCompanyPage({ ...value, items: [wrong] }, { offset: 0, state }), null);
  }
  for (const state of [undefined, false, 1, [], {}, "", "all", "PENDING", "pending ", "pending\n"]) {
    assert.equal(parsePartnerCompanyPage({ ...page(), state }), null);
  }
  assert.deepEqual(accepted(parsePartnerCompanyPage, page({ items: [application(), terminal("rejected", { id: originalRevision,
    submittedAt: "2026-10-27T12:00:00Z" })] })).state, null);
});

test("page: order is submittedAt DESC at microsecond precision, then case-insensitive UUID DESC", () => {
  const earlier = application({ id: workspaceId, submittedAt: "2026-10-28T12:00:00.123456Z" });
  const later = application({ id: applicationId, submittedAt: "2026-10-28T12:00:00.123457Z" });
  assert.ok(parsePartnerCompanyPage(page({ items: [later, earlier] })));
  assert.equal(parsePartnerCompanyPage(page({ items: [earlier, later] })), null);
  const high = application({ id: workspaceId.toUpperCase(), submittedAt: "2026-10-28T12:00:00.1Z" });
  const low = application({ id: applicationId, submittedAt: "2026-10-28T12:00:00.100000Z" });
  assert.ok(parsePartnerCompanyPage(page({ items: [high, low] })));
  assert.equal(parsePartnerCompanyPage(page({ items: [low, high] })), null);
  assert.equal(parsePartnerCompanyPage(page({ items: [high, { ...high, id: workspaceId }] })), null);
  assert.equal(parsePartnerCompanyPage(page({ items: [later, { ...earlier, id: applicationId.toUpperCase() }] })), null);
});

test("page: invalid nested items and sparse arrays fail without dropping or repairing data", () => {
  for (const index of [0, 10, 19]) {
    const items: unknown[] = pageItems(20);
    items[index] = { ...items[index] as Application, company: { ...company(), ownerEmail: "synthetic@example.test" } };
    assert.equal(parsePartnerCompanyPage({ ...page(), items }), null, `invalid item ${index}`);
    delete items[index];
    assert.equal(parsePartnerCompanyPage({ ...page(), items }), null, `sparse item ${index}`);
  }
  for (const items of [undefined, null, false, "[]", {}, new Array(20), [null], [false]]) {
    assert.equal(parsePartnerCompanyPage({ ...page(), items }), null);
  }
});
