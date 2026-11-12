import assert from "node:assert/strict";
import test from "node:test";

type Row = Record<string, unknown>;
type Parser = (value: unknown) => Readonly<Row> | null;

const policyVersion = "2026-10-27-7d-self-v1";
const profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const profileRevision = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const agreementRevision = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const referralCode = "ABCDEF0123456789ABCDEF0123456789";
const origin = "https://referral.example.test";
const capturedAt = "2026-10-28T12:34:56.123Z";
const expiresAt = "2026-11-04T12:34:56.123Z";

function link(patch: Row = {}) {
  return { profileId, profileRevision, agreementRevision, referralCode,
    url: `${origin}/r/${referralCode}`, policyVersion, ...patch };
}

function notice(patch: Row = {}) {
  return { version: "notice.v1", text: "Synthetic partner attribution notice.", purpose: "partner_attribution",
    policyRevision: "policy-v1", policyUrl: "https://policy.example.test/privacy", sha256: "ab".repeat(32), ...patch };
}

function entryNotice(patch: Row = {}) {
  return { siteKey: "synthetic_site-1", notice: notice(), ...patch };
}

function prepared(patch: Row = {}) {
  return { prepared: true, expiresAt, ...patch };
}

function captured(patch: Row = {}) {
  return { id: profileId, capturedAt, expiresAt, policyVersion, ...patch };
}

const imported = await import(new URL("../../lib/crm/partner-link-contracts.ts", import.meta.url).href);
const cookieModule = await import(new URL("../../lib/crm/partner-entry-cookie.ts", import.meta.url).href);
const cookiePolicy = cookieModule.default ?? cookieModule;
// The root contract can load as CJS from the scripts package's ESM test runner.
const { PARTNER_LINK_POLICY, parsePartnerLink, parsePartnerEntryNotice, parsePartnerEntryPrepared,
  parsePartnerEntryCaptured } = (imported.default ?? imported) as {
    PARTNER_LINK_POLICY: string;
    parsePartnerLink(value: unknown): Readonly<ReturnType<typeof link>> | null;
    parsePartnerEntryNotice(value: unknown): Readonly<ReturnType<typeof entryNotice>> | null;
    parsePartnerEntryPrepared(value: unknown): Readonly<ReturnType<typeof prepared>> | null;
    parsePartnerEntryCaptured(value: unknown): Readonly<ReturnType<typeof captured>> | null;
  };

function accepted<T extends Row>(parse: Parser, value: T): Readonly<T> {
  const result = parse(value);
  assert.ok(result, "valid synthetic payload must be accepted");
  return result as Readonly<T>;
}

const parsers: { name: string; parse: Parser; fixture: () => Row }[] = [
  { name: "link", parse: parsePartnerLink, fixture: link },
  { name: "entry notice", parse: parsePartnerEntryNotice, fixture: entryNotice },
  { name: "prepared entry", parse: parsePartnerEntryPrepared, fixture: prepared },
  { name: "captured entry", parse: parsePartnerEntryCaptured, fixture: captured },
];

const shapes: typeof parsers = [...parsers, {
  name: "nested notice",
  parse: (value: unknown) => parsePartnerEntryNotice(entryNotice({ notice: value })),
  fixture: notice,
}];

test("the actual contract exports the current policy and four callable parsers", () => {
  assert.equal(PARTNER_LINK_POLICY, policyVersion);
  assert.equal(PARTNER_LINK_POLICY, cookiePolicy.PARTNER_POLICY_VERSION, "Public DTO and sealed server capability use the same source policy");
  assert.equal(Date.parse(expiresAt) - Date.parse(capturedAt), cookiePolicy.PARTNER_WINDOW_MS);
  for (const { parse } of parsers) assert.equal(typeof parse, "function");
});

for (const { name, parse, fixture } of parsers) {
  test(`${name}: valid wire payloads and reordered own keys preserve their values`, () => {
    const value = fixture();
    assert.deepEqual(accepted(parse, JSON.parse(JSON.stringify(value))), value);
    assert.deepEqual(accepted(parse, Object.fromEntries(Object.entries(value).reverse())), value);
    assert.deepEqual(accepted(parse, Object.assign(Object.create(null), value)), value);
  });

  test(`${name}: success returns a detached frozen copy without freezing its input`, () => {
    const value = fixture();
    const before = structuredClone(value);
    const result = accepted(parse, value);
    assert.notEqual(result, value);
    assert.deepEqual(value, before);
    assert.equal(Object.isFrozen(value), false);
    assert.equal(Object.isFrozen(result), true);
    for (const key of Object.keys(result)) {
      assert.equal(Reflect.set(result, key, "changed"), false, key);
      assert.equal(Reflect.deleteProperty(result, key), false, key);
    }
    assert.equal(Reflect.defineProperty(result, "unexpected", { value: true }), false);
    for (const key of Object.keys(value)) Reflect.set(value, key, "input changed later");
    assert.deepEqual(result, before);
  });

  test(`${name}: already frozen inputs are accepted and still copied`, () => {
    const value = fixture();
    if (name === "entry notice") Object.freeze(value.notice);
    Object.freeze(value);
    const result = accepted(parse, value);
    assert.notEqual(result, value);
    assert.deepEqual(result, value);
    assert.equal(Object.isFrozen(result), true);
  });

  test(`${name}: refusal does not mutate input, including a frozen malformed payload`, () => {
    const value = { ...fixture(), privateAuth: "synthetic-only" };
    const before = structuredClone(value);
    assert.equal(parse(value), null);
    assert.deepEqual(value, before);
    assert.equal(Object.isFrozen(value), false);
    if (name === "entry notice") Object.freeze((value as Row).notice);
    Object.freeze(value);
    assert.equal(parse(value), null);
    assert.deepEqual(value, before);
  });
}

for (const { name, parse, fixture } of shapes) {
  test(`${name}: rejects nonobjects, arrays, and decorated arrays`, () => {
    for (const value of [undefined, null, true, false, 0, 1, NaN, Infinity, 0n, Symbol("synthetic"),
      "{}", "ready", [], [fixture()], new Date(capturedAt), new String("payload"), () => fixture(),
      Object.assign([], fixture())]) {
      assert.equal(parse(value), null, String(value));
    }
  });

  test(`${name}: every key is required and a substituted key cannot pad the shape`, () => {
    for (const key of Object.keys(fixture())) {
      const value = fixture();
      delete value[key];
      assert.equal(parse(value), null, `missing ${key}`);
      value[`replacement_${key}`] = "synthetic";
      assert.equal(parse(value), null, `substituted ${key}`);
    }
  });

  test(`${name}: rejects unknown own keys including prototype-shaped JSON keys`, () => {
    for (const key of ["unexpected", "privateAuth", "actorId", "workspaceId", "__proto__", "constructor", "prototype"]) {
      assert.equal(parse({ ...fixture(), [key]: "synthetic" }), null, key);
    }
  });

  test(`${name}: inherited required keys cannot replace own keys, even with padded key count`, () => {
    for (const key of Object.keys(fixture())) {
      const value = fixture();
      const inherited = value[key];
      delete value[key];
      Object.setPrototypeOf(value, { [key]: inherited });
      assert.equal(parse(value), null, `inherited ${key}`);
      value[`replacement_${key}`] = "synthetic";
      assert.equal(parse(value), null, `inherited ${key} plus an unexpected own key`);
    }
  });
}

test("entry notice: nested content is independently copied and frozen", () => {
  const value = entryNotice();
  const before = structuredClone(value);
  const result = accepted(parsePartnerEntryNotice, value);
  assert.notEqual(result.notice, value.notice);
  assert.equal(Object.isFrozen(result.notice), true);
  assert.equal(Object.isFrozen(value.notice), false);
  for (const key of Object.keys(result.notice)) {
    assert.equal(Reflect.set(result.notice, key, "changed"), false, key);
    assert.equal(Reflect.deleteProperty(result.notice, key), false, key);
  }
  assert.equal(Reflect.defineProperty(result.notice, "unexpected", { value: true }), false);
  value.notice.text = "Later synthetic input mutation";
  value.notice.sha256 = "0".repeat(64);
  value.notice = notice({ version: "replacement" });
  assert.deepEqual(result, before);

  const frozen = entryNotice({ notice: Object.freeze(notice()) });
  Object.freeze(frozen);
  const copied = accepted(parsePartnerEntryNotice, frozen);
  assert.notEqual(copied.notice, frozen.notice);
  assert.equal(Object.isFrozen(copied.notice), true);
});

const uuidSlots = [
  ...["profileId", "profileRevision", "agreementRevision"].map(key => ({
    name: `link.${key}`,
    parse: (value: unknown) => parsePartnerLink(link({ [key]: value })),
    key,
  })),
  { name: "captured.id", parse: (value: unknown) => parsePartnerEntryCaptured(captured({ id: value })), key: "id" },
];

for (const { name, parse, key } of uuidSlots) {
  test(`${name}: accepts UUID versions one through five, RFC variants, and preserves case`, () => {
    for (const version of [1, 2, 3, 4, 5]) {
      for (const variant of ["8", "9", "a", "b"]) {
        const id = `abcdefab-cdef-${version}abc-${variant}abc-abcdefabcdef`;
        for (const value of [id, id.toUpperCase()]) {
          const result = parse(value);
          assert.ok(result, value);
          assert.equal((result as Row)[key], value);
        }
      }
    }
  });

  test(`${name}: refuses malformed UUIDs, unsupported versions, variants, and coercion`, () => {
    for (const value of [null, undefined, false, 1, 0n, [], {}, new String(profileId), "", "not-a-uuid",
      profileId.replaceAll("-", ""), `{${profileId}}`, `urn:uuid:${profileId}`, profileId.slice(1), `${profileId}0`,
      "gaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff", ` ${profileId}`, `${profileId} `,
      ...["\n", "\r", "\r\n", "\u2028", "\u2029", "\u0000"].map(suffix => profileId + suffix),
      ...["0", "6", "7", "8", "f"].map(version => `aaaaaaaa-aaaa-${version}aaa-8aaa-aaaaaaaaaaaa`),
      ...["0", "1", "2", "3", "4", "5", "6", "7", "c", "d", "e", "f"].map(variant =>
        `aaaaaaaa-aaaa-4aaa-${variant}aaa-aaaaaaaaaaaa`)]) {
      assert.equal(parse(value), null, String(value));
    }
  });
}

for (const { name, parse, fixture } of parsers.filter(({ name }) => name === "link" || name === "captured entry")) {
  test(`${name}: policy version is an exact string, never coerced or trimmed`, () => {
    for (const value of [undefined, null, false, 1, [], {}, new String(policyVersion), "", "2026-10-26-7d-self-v1",
      "2026-10-27-30d-self-v1", policyVersion.toUpperCase(), ` ${policyVersion}`, `${policyVersion} `,
      `${policyVersion}\n`]) {
      assert.equal(parse({ ...fixture(), policyVersion: value }), null, String(value));
    }
  });
}

test("link: referral codes are exactly 32 uppercase hexadecimal characters tied to the URL", () => {
  for (const code of ["0".repeat(32), "A".repeat(32), "F".repeat(32), referralCode]) {
    const value = link({ referralCode: code, url: `${origin}/r/${code}` });
    assert.deepEqual(accepted(parsePartnerLink, value), value);
  }
  for (const code of [null, undefined, false, 123, [], {}, new String(referralCode), "", "A".repeat(31),
    "A".repeat(33), referralCode.toLowerCase(), `G${referralCode.slice(1)}`, ` ${referralCode}`, `${referralCode} `,
    `${referralCode}\n`, `${referralCode}\u0000`]) {
    assert.equal(parsePartnerLink(link({ referralCode: code,
      url: typeof code === "string" ? `${origin}/r/${code}` : link().url })), null, String(code));
  }
  const otherCode = "0".repeat(32);
  assert.equal(parsePartnerLink(link({ url: `${origin}/r/${otherCode}` })), null);
  assert.equal(parsePartnerLink(link({ referralCode: otherCode })), null);
});

test("link: any canonical HTTPS origin and a canonical non-default port are allowed", () => {
  for (const host of [origin, "https://other.example.test", "https://referral.example.test:8443", "https://[2001:db8::1]:8443"]) {
    const value = link({ url: `${host}/r/${referralCode}` });
    assert.deepEqual(accepted(parsePartnerLink, value), value);
  }
});

const linkUrlRefusals: Record<string, unknown[]> = {
  credentials: [
    `https://user@referral.example.test/r/${referralCode}`,
    `https://user:password@referral.example.test/r/${referralCode}`,
    `https://:password@referral.example.test/r/${referralCode}`,
    `https://%75ser@referral.example.test/r/${referralCode}`,
    `https://@referral.example.test/r/${referralCode}`,
  ],
  query: [`${link().url}?source=synthetic`, `${link().url}?`, `${link().url}?code=${referralCode}`],
  hash: [`${link().url}#fragment`, `${link().url}#`, `${link().url}#?code=${referralCode}`],
  encoding: [
    `${origin}/%72/${referralCode}`, `${origin}/r/%41${referralCode.slice(1)}`,
    `${origin}/r/${referralCode}%2F`, `${origin}/r%2F${referralCode}`,
    `${origin}/r/${referralCode}%3Fsource=synthetic`, `${origin}/r/${referralCode}%23fragment`,
    `${origin}/r/${referralCode}%5C`, `${origin}/r/%2541${referralCode.slice(1)}`,
    `https://%72eferral.example.test/r/${referralCode}`,
  ],
  path: [
    `${origin}/r/${referralCode}/`, `${origin}//r/${referralCode}`, `${origin}/R/${referralCode}`,
    `${origin}/prefix/r/${referralCode}`, `${origin}/r/${referralCode}/extra`,
    `${origin}/x/../r/${referralCode}`, `${origin}/%2e/r/${referralCode}`, `${origin}/./r/${referralCode}`,
    `${origin}\\r\\${referralCode}`, `https:\\referral.example.test\\r\\${referralCode}`,
    `${origin}/r/${referralCode}\\`,
  ],
  protocol: [
    `http://referral.example.test/r/${referralCode}`, `ftp://referral.example.test/r/${referralCode}`,
    `javascript:${link().url}`, `data:text/plain,${link().url}`, `//referral.example.test/r/${referralCode}`,
    `/r/${referralCode}`, `https:referral.example.test/r/${referralCode}`,
    `https:/referral.example.test/r/${referralCode}`, `https:///referral.example.test/r/${referralCode}`,
  ],
  noncanonicalPortAndCase: [
    `https://referral.example.test:443/r/${referralCode}`, `https://referral.example.test:0443/r/${referralCode}`,
    `https://referral.example.test:08443/r/${referralCode}`, `https://referral.example.test:/r/${referralCode}`,
    `https://referral.example.test:65536/r/${referralCode}`, `https://referral.example.test:-1/r/${referralCode}`,
    `https://referral.example.test:not-a-port/r/${referralCode}`, `HTTPS://referral.example.test/r/${referralCode}`,
    `https://Referral.Example.Test/r/${referralCode}`, `${origin}/r/${referralCode.toLowerCase()}`,
  ],
  whitespaceAndControls: [
    ` ${link().url}`, `${link().url} `, `${link().url}\n`, `${link().url}\r`, `${link().url}\t`,
    `https://referral.\nexample.test/r/${referralCode}`, `${origin}/r/\t${referralCode}`,
    `${link().url}\u0000`, `${link().url}\u2028`, `${link().url}\u00a0`,
  ],
  malformedAndTypes: [null, undefined, true, 1, [], {}, new String(link().url), "", "not-a-url", "https://",
    `https://[invalid]/r/${referralCode}`, `https://bad%host/r/${referralCode}`, `https://${"a".repeat(2050)}/r/${referralCode}`],
};

for (const [category, urls] of Object.entries(linkUrlRefusals)) {
  test(`link: refuses ${category} URL alterations`, () => {
    for (const url of urls) assert.equal(parsePartnerLink(link({ url })), null, String(url));
  });
}

test("entry notice: site keys and notice versions honor their ASCII shapes and exact length bounds", () => {
  for (const siteKey of ["a", "A0_-", "x".repeat(100)]) {
    assert.equal(accepted(parsePartnerEntryNotice, entryNotice({ siteKey })).siteKey, siteKey);
  }
  for (const version of ["1", "v1.0_A-B", "x".repeat(40)]) {
    const value = entryNotice({ notice: notice({ version }) });
    assert.equal(accepted(parsePartnerEntryNotice, value).notice.version, version);
  }
  for (const siteKey of [null, undefined, false, 0, [], {}, new String("site"), "", "x".repeat(101),
    "site.key", "site/key", "site key", " site", "site ", "site\n", "site\r", "site\u0000", "site\u2028", "s\u0456te"]) {
    assert.equal(parsePartnerEntryNotice(entryNotice({ siteKey })), null, String(siteKey));
  }
  for (const version of [null, undefined, false, 0, [], {}, new String("v1"), "", "x".repeat(41), "v1/0", "v1+0",
    "v 1", " v1", "v1 ", "v1\n", "v1\r", "v1\u0000", "v1\u2029", "v\u00e9"]) {
    assert.equal(parsePartnerEntryNotice(entryNotice({ notice: notice({ version }) })), null, String(version));
  }
});

test("entry notice: purpose is exactly partner_attribution", () => {
  for (const purpose of [null, undefined, false, 1, [], {}, new String("partner_attribution"), "", "analytics",
    "marketing", "PARTNER_ATTRIBUTION", "partner_attribution ", " partner_attribution", "partner_attribution\n"]) {
    assert.equal(parsePartnerEntryNotice(entryNotice({ notice: notice({ purpose }) })), null, String(purpose));
  }
});

test("entry notice: text is nonblank, bounded, and preserved including legal line breaks", () => {
  for (const text of ["x", "x".repeat(20_000), "  Synthetic text  ", "Line one\nLine two\r\n\tIndented",
    "\u041f\u0430\u0440\u0442\u043d\u0435\u0440 attribution"]) {
    const value = entryNotice({ notice: notice({ text }) });
    assert.equal(accepted(parsePartnerEntryNotice, value).notice.text, text);
  }
  for (const text of [null, undefined, false, 0, [], {}, new String("text"), "", " ", "\t\r\n", "\u00a0",
    "x".repeat(20_001)]) {
    assert.equal(parsePartnerEntryNotice(entryNotice({ notice: notice({ text }) })), null, String(text));
  }
  for (const code of [...Array.from({ length: 9 }, (_, index) => index), 11, 12,
    ...Array.from({ length: 18 }, (_, index) => index + 14), 127]) {
    const text = `Synthetic${String.fromCharCode(code)}notice`;
    assert.equal(parsePartnerEntryNotice(entryNotice({ notice: notice({ text }) })), null, `control ${code}`);
  }
});

test("entry notice: policy revisions are nonblank strings of at most 120 characters, not trimmed", () => {
  for (const policyRevision of ["1", "r".repeat(120), " revision 1 "]) {
    const value = entryNotice({ notice: notice({ policyRevision }) });
    assert.equal(accepted(parsePartnerEntryNotice, value).notice.policyRevision, policyRevision);
  }
  for (const policyRevision of [null, undefined, false, 0, [], {}, new String("revision"), "", " ", "\t\n",
    "r".repeat(121)]) {
    assert.equal(parsePartnerEntryNotice(entryNotice({ notice: notice({ policyRevision }) })), null, String(policyRevision));
  }
});

test("entry notice: safe HTTPS policy URLs allow queries, encoding, and noncanonical origins", () => {
  const prefix = "https://policy.example.test/";
  for (const policyUrl of ["https://policy.example.test", "https://other.example.test:8443/privacy?revision=1",
    "HTTPS://Policy.Example.Test:0443/privacy?revision=v1%2F2", "https://policy.example.test/legal%20notice",
    prefix + "a".repeat(2048 - prefix.length)]) {
    const value = entryNotice({ notice: notice({ policyUrl }) });
    assert.equal(accepted(parsePartnerEntryNotice, value).notice.policyUrl, policyUrl);
  }
});

test("entry notice: policy URLs refuse unsafe protocols, credentials, fragments, whitespace, and backslashes", () => {
  const prefix = "https://policy.example.test/";
  for (const policyUrl of [null, undefined, false, 0, [], {}, new String(prefix), "", "not-a-url", "/privacy",
    "//policy.example.test/privacy", "http://policy.example.test/privacy", "ftp://policy.example.test/privacy",
    "javascript:alert(1)", "data:text/plain,policy", "https://", "https://[invalid]/privacy",
    "https://user@policy.example.test/privacy", "https://user:password@policy.example.test/privacy",
    "https://:password@policy.example.test/privacy", "https://%75ser@policy.example.test/privacy",
    `${prefix}privacy#revision`, `${prefix}privacy?revision=1#fragment`, ` ${prefix}`, `${prefix} `,
    `${prefix}\n`, `${prefix}\r`, `${prefix}\t`, "https://policy.\nexample.test/privacy",
    "https://policy.example.test\\privacy", "https:\\policy.example.test\\privacy",
    prefix + "a".repeat(2049 - prefix.length)]) {
    assert.equal(parsePartnerEntryNotice(entryNotice({ notice: notice({ policyUrl }) })), null, String(policyUrl));
  }
});

test("entry notice: sha256 is only a 64-character lowercase hexadecimal shape, not a recomputed digest", () => {
  for (const sha256 of ["0".repeat(64), "f".repeat(64), "0123456789abcdef".repeat(4)]) {
    const value = entryNotice({ notice: notice({ text: "Different synthetic notice text", sha256 }) });
    assert.equal(accepted(parsePartnerEntryNotice, value).notice.sha256, sha256);
  }
  for (const sha256 of [null, undefined, false, 0, [], {}, new String("ab".repeat(32)), "", "a".repeat(63),
    "a".repeat(65), "AB".repeat(32), "g".repeat(64), ` ${"a".repeat(64)}`, `${"a".repeat(64)} `,
    `${"a".repeat(64)}\n`, `${"a".repeat(64)}\r`, `${"a".repeat(64)}\u2028`, `${"a".repeat(64)}\u0000`,
    `sha256:${"a".repeat(64)}`]) {
    assert.equal(parsePartnerEntryNotice(entryNotice({ notice: notice({ sha256 }) })), null, String(sha256));
  }
});

test("prepared entry: the success flag must be the boolean true", () => {
  for (const value of [null, undefined, false, 0, 1, "true", "false", [], {}, new Boolean(true)]) {
    assert.equal(parsePartnerEntryPrepared(prepared({ prepared: value })), null, String(value));
  }
});

const canonicalTimestamps = ["0000-01-01T00:00:00.000Z", "0001-01-01T00:00:00.000Z",
  "2000-02-29T12:34:56.001Z", "2024-02-29T23:59:59.999Z", "2026-10-28T12:34:56.123Z",
  "9999-12-31T23:59:59.999Z"];

test("prepared entry: accepts real canonical millisecond UTC dates without a freshness or seven-day requirement", () => {
  for (const timestamp of canonicalTimestamps) {
    assert.deepEqual(accepted(parsePartnerEntryPrepared, prepared({ expiresAt: timestamp })),
      { prepared: true, expiresAt: timestamp });
  }
});

const invalidTimestamps: unknown[] = [null, undefined, false, 0, 1, NaN, Infinity, [], {}, new Date(capturedAt),
  new String(capturedAt), "", "not-a-date", "2026-10-28", "2026-10-28T12:34:56Z", "2026-10-28T12:34:56.Z",
  "2026-10-28T12:34:56.1Z", "2026-10-28T12:34:56.12Z", "2026-10-28T12:34:56.1230Z",
  "2026-10-28T12:34:56.12300Z", "2026-10-28T12:34:56.1230000Z",
  "1900-02-29T00:00:00.000Z", "2100-02-29T00:00:00.000Z", "2026-02-29T00:00:00.000Z",
  "2026-02-30T00:00:00.000Z", "2026-04-31T00:00:00.000Z", "2026-00-01T00:00:00.000Z",
  "2026-13-01T00:00:00.000Z", "2026-01-00T00:00:00.000Z", "2026-01-32T00:00:00.000Z",
  "2026-10-28T24:00:00.000Z", "2026-10-28T12:60:00.000Z", "2026-10-28T12:00:60.000Z",
  "2026-10-28T12:34:56.123+00:00", "2026-10-28T12:34:56.123+05:00", "2026-10-28T12:34:56.123-05:00",
  "2026-10-28T12:34:56.123", "2026-10-28 12:34:56.123Z", "2026-10-28t12:34:56.123z",
  "+002026-10-28T12:34:56.123Z", "10000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z",
  ` ${capturedAt}`, `${capturedAt} `, `${capturedAt}\n`, `${capturedAt}\r`, `${capturedAt}\u0000`];

for (const [index, timestamp] of invalidTimestamps.entries()) {
  test(`entry dates: malformed or noncanonical timestamp ${index + 1} is rejected in all date fields`, () => {
    assert.equal(parsePartnerEntryPrepared(prepared({ expiresAt: timestamp })), null, "prepared.expiresAt");
    assert.equal(parsePartnerEntryCaptured(captured({ capturedAt: timestamp })), null, "captured.capturedAt");
    assert.equal(parsePartnerEntryCaptured(captured({ expiresAt: timestamp })), null, "captured.expiresAt");
  });
}

test("captured entry: a seven-day UTC window survives leap days, month and year changes, and DST dates", () => {
  const windows = [
    [capturedAt, expiresAt],
    ["0000-02-25T00:00:00.000Z", "0000-03-03T00:00:00.000Z"],
    ["1900-02-25T00:00:00.000Z", "1900-03-04T00:00:00.000Z"],
    ["2000-02-24T23:59:59.999Z", "2000-03-02T23:59:59.999Z"],
    ["2024-02-25T12:34:56.001Z", "2024-03-03T12:34:56.001Z"],
    ["2026-10-25T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
    ["2026-12-28T12:34:56.123Z", "2027-01-04T12:34:56.123Z"],
    ["9999-12-24T23:59:59.999Z", "9999-12-31T23:59:59.999Z"],
  ];
  for (const [start, end] of windows) {
    const value = captured({ capturedAt: start, expiresAt: end });
    assert.deepEqual(accepted(parsePartnerEntryCaptured, value), value);
  }
});

test("captured entry: the window is exactly seven days, including one-millisecond boundaries", () => {
  for (const duration of [-604_800_000, -1, 0, 1, 86_400_000, 518_400_000, 604_799_000, 604_799_999,
    604_800_001, 604_801_000, 691_200_000]) {
    const end = new Date(Date.parse(capturedAt) + duration).toISOString();
    assert.equal(parsePartnerEntryCaptured(captured({ expiresAt: end })), null, `window ${duration}ms`);
  }
  assert.equal(parsePartnerEntryCaptured(captured({ capturedAt: expiresAt, expiresAt: capturedAt })), null);
});

test("captured entry: SQL six-digit fractions normalize only when all submillisecond digits are zero", () => {
  for (const [fraction, sqlFraction] of [["000", "000000"], ["001", "001000"], ["123", "123000"], ["999", "999000"]]) {
    const start = `2026-10-28T12:34:56.${fraction}Z`;
    const end = `2026-11-04T12:34:56.${fraction}Z`;
    const sqlStart = `2026-10-28T12:34:56.${sqlFraction}Z`;
    const sqlEnd = `2026-11-04T12:34:56.${sqlFraction}Z`;
    for (const [wireStart, wireEnd] of [[sqlStart, sqlEnd], [sqlStart, end], [start, sqlEnd]]) {
      const value = captured({ capturedAt: wireStart, expiresAt: wireEnd });
      const before = structuredClone(value);
      Object.freeze(value);
      const result = accepted(parsePartnerEntryCaptured, value);
      assert.deepEqual(result, captured({ capturedAt: start, expiresAt: end }));
      assert.notEqual(result, value);
      assert.equal(Object.isFrozen(result), true);
      assert.deepEqual(value, before);
    }
    assert.equal(parsePartnerEntryPrepared(prepared({ expiresAt: sqlEnd })), null,
      "SQL microsecond normalization belongs only to the captured response");
  }
});

test("captured entry: real submillisecond timestamps cannot be truncated into a seven-day window", () => {
  for (const fraction of ["000001", "000999", "001001", "123001", "123456", "123999", "999999",
    "1230001", "123000000", "123000000000"]) {
    const start = `2026-10-28T12:34:56.${fraction}Z`;
    const end = `2026-11-04T12:34:56.${fraction}Z`;
    assert.equal(parsePartnerEntryPrepared(prepared({ expiresAt: end })), null, fraction);
    assert.equal(parsePartnerEntryCaptured(captured({ capturedAt: start, expiresAt: end })), null, fraction);
    assert.equal(parsePartnerEntryCaptured(captured({ capturedAt: start })), null, `start ${fraction}`);
    assert.equal(parsePartnerEntryCaptured(captured({ expiresAt: end })), null, `end ${fraction}`);
  }
});

test("captured entry: invalid calendar dates cannot pass merely because Date.parse rolls them into a seven-day window", () => {
  for (const [start, end] of [
    ["2026-02-30T00:00:00.000Z", "2026-03-09T00:00:00.000Z"],
    ["2026-04-31T00:00:00.000Z", "2026-05-08T00:00:00.000Z"],
    ["2026-10-28T24:00:00.000Z", "2026-11-05T00:00:00.000Z"],
    ["2026-02-22T00:00:00.000Z", "2026-02-29T00:00:00.000Z"],
    ["2026-04-24T00:00:00.000Z", "2026-04-31T00:00:00.000Z"],
  ]) {
    assert.equal(Date.parse(end) - Date.parse(start), 604_800_000, "fixture isolates date normalization from duration");
    assert.equal(parsePartnerEntryCaptured(captured({ capturedAt: start, expiresAt: end })), null, `${start} -> ${end}`);
  }
});
