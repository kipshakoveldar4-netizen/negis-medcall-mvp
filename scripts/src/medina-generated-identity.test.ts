import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { Script } from "node:vm";

type IdentityInput = { workspaceId: string; idempotencyKey: string; mimeType: string };
type Identity = { assetId: string; fileName: string; storagePath: string; keyDigest: string };
type IdentityModule = { generatedCreativeIdentity(input: IdentityInput): Identity };

// Dynamic path keeps the scripts project's rootDir intact. This imports the
// actual pure production helper, never a transpiled rewrite or an SDK double.
const actual = await import(new URL("../../lib/crm/generated-identity.ts", import.meta.url).href) as IdentityModule;
assert.equal(typeof actual.generatedCreativeIdentity, "function");
const identity = actual.generatedCreativeIdentity;
const WORKSPACE = "abcdef01-2345-4678-9abc-def012345678";
const FOREIGN_WORKSPACE = "abcdef01-2345-4678-9abc-def012345679";
const KEY = "synthetic-job-G5-C53";
const VERSION = "medina-generated-v1";
const DNS_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
const formats = [
  { mimeType: "image/jpeg", kind: "image", extension: "jpg" },
  { mimeType: "image/png", kind: "image", extension: "png" },
  { mimeType: "image/webp", kind: "image", extension: "webp" },
  { mimeType: "video/mp4", kind: "video", extension: "mp4" },
  { mimeType: "video/quicktime", kind: "video", extension: "mov" },
  { mimeType: "video/webm", kind: "video", extension: "webm" },
] as const;
const input = (changes: Partial<IdentityInput> = {}): IdentityInput => ({
  workspaceId: WORKSPACE, idempotencyKey: KEY, mimeType: "image/png", ...changes,
});

// Independent RFC 4122 reference: SHA-1 over DNS namespace bytes + UTF-8 name,
// truncated to 128 bits with the version and variant bits explicitly set.
function referenceUuid5(name: string) {
  const bytes = createHash("sha1").update(DNS_NAMESPACE).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function referenceDigest(workspaceId: string, key: string) {
  return createHash("sha256").update(JSON.stringify([VERSION, workspaceId.toLowerCase(), key]), "utf8").digest("hex");
}

function assertIdentity(value: Identity, candidate: IdentityInput) {
  const format = formats.find(format => format.mimeType === candidate.mimeType);
  assert.ok(format, "The test's expected format must be explicit");
  const keyDigest = referenceDigest(candidate.workspaceId, candidate.idempotencyKey);
  assert.deepEqual(value, {
    assetId: referenceUuid5(`${VERSION}:${keyDigest}`),
    keyDigest,
    fileName: `negis-${format.kind}-${keyDigest.slice(0, 20)}.${format.extension}`,
    storagePath: `${candidate.workspaceId.toLowerCase()}/generated/${keyDigest}`,
  }, "Canonical identity must match independent digest/UUID references exactly");
  assert.match(value.keyDigest, /^[0-9a-f]{64}$/);
  assert.match(value.assetId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(value.storagePath.split("/").length, 3);
}

test("Generated identity: independent UUIDv5 reference matches the RFC DNS vector", () => {
  // The target only exposes generated identities, not a general UUID factory.
  // Anchor the reference before using it to check actual production asset IDs.
  assert.equal(referenceUuid5("www.widgets.com"), "21f7f8de-8051-5b89-8680-0195ef798b6a");
  const candidate = input();
  assertIdentity(identity(candidate), candidate);
});

for (const format of formats) {
  test(`Generated identity: ${format.mimeType} has exact deterministic UUID, digest, canonical name and path`, () => {
    const candidate = Object.freeze(input({ mimeType: format.mimeType }));
    const before = { ...candidate };
    const first = identity(candidate);
    assertIdentity(first, candidate);
    assert.deepEqual(identity(candidate), first);
    assert.deepEqual(candidate, before, "The pure helper must not mutate its caller's input");
  });
}

test("Generated identity: MIME never changes the key digest, asset ID or storage path", () => {
  const values = formats.map(format => {
    const candidate = input({ mimeType: format.mimeType });
    const value = identity(candidate);
    assertIdentity(value, candidate);
    return value;
  });
  for (const key of ["keyDigest", "assetId", "storagePath"] as const) {
    assert.equal(new Set(values.map(value => value[key])).size, 1, `${key} must not encode MIME or image/video kind`);
  }
  assert.equal(new Set(values.map(value => value.fileName)).size, formats.length, "Only the canonical filename reflects media type");
});

test("Generated identity: tenant UUID case normalizes before hashing and UUID derivation", () => {
  const lowercase = identity(input());
  const uppercaseInput = Object.freeze(input({ workspaceId: WORKSPACE.toUpperCase() }));
  const uppercase = identity(uppercaseInput);
  assertIdentity(uppercase, uppercaseInput);
  assert.deepEqual(uppercase, lowercase);
  assert.equal(uppercaseInput.workspaceId, WORKSPACE.toUpperCase());
});

test("Generated identity: changing tenant or exact key produces independent identities", () => {
  const candidates = [input(), input({ workspaceId: FOREIGN_WORKSPACE }), input({ idempotencyKey: `${KEY}-2` }),
    input({ workspaceId: FOREIGN_WORKSPACE, idempotencyKey: `${KEY}-2` })];
  const values = candidates.map(candidate => {
    const value = identity(candidate);
    assertIdentity(value, candidate);
    return value;
  });
  for (const key of ["assetId", "keyDigest", "fileName", "storagePath"] as const) {
    assert.equal(new Set(values.map(value => value[key])).size, candidates.length, `${key} must separate tenants and requests`);
  }
});

test("Generated identity: UTC midnight, month and year changes cannot change a retry identity", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 11, 31, 23, 59, 59) });
  const candidate = input();
  const first = identity(candidate);
  assertIdentity(first, candidate);
  for (const time of [Date.UTC(2027, 0, 1), Date.UTC(2027, 1, 1), Date.UTC(2036, 11, 31)]) {
    t.mock.timers.setTime(time);
    assert.deepEqual(identity(candidate), first, "Retries cannot depend on a calendar storage prefix or clock-derived ID");
  }
});

test("Generated identity: incoming filename and timestamp hints cannot redirect canonical naming", () => {
  const firstInput = Object.freeze({ ...input(), fileName: "old-job.png", now: "2026-01-01T00:00:00Z" });
  const laterInput = Object.freeze({ ...input(), fileName: `../../${FOREIGN_WORKSPACE}/different.png`, now: "2036-12-31T23:59:59Z" });
  const first = identity(firstInput);
  assertIdentity(first, firstInput);
  assert.deepEqual(identity(laterInput), first);
  assert.equal(first.storagePath.includes(".."), false);
  assert.equal(first.storagePath.includes(FOREIGN_WORKSPACE), false);
  assert.equal(first.fileName.includes("old-job"), false);
});

const exactKeys = [
  "job:ab:c", "job:a:bc", "job|ab|c", "job|a|bc", 'job:["a","b"]', 'job:["a,b"]',
  "job/a/b", "job\\a\\b", 'job-quote-"-suffix', "job-quote-\\\"-suffix",
  "job A B", "job A  B", "Job-A", "job-a", "caf\u00e9", "cafe\u0301", "job-\u4e2d\u6587", "job/../segment",
];

test("Generated identity: JSON encoding preserves key delimiters, escaping, case, interior spaces and exact Unicode", () => {
  const values = exactKeys.map(idempotencyKey => {
    const candidate = input({ idempotencyKey });
    const value = identity(candidate);
    assertIdentity(value, candidate);
    assert.equal(value.fileName.includes(idempotencyKey), false, "Raw job keys must not become canonical names");
    return value;
  });
  for (const key of ["keyDigest", "assetId", "storagePath"] as const) {
    assert.equal(new Set(values.map(value => value[key])).size, exactKeys.length, `${key} must not collapse distinct exact keys`);
  }
});

test("Generated identity: SHA-256 input is the versioned JSON tuple, not concatenation or a MIME-specific key", () => {
  const candidate = input({ idempotencyKey: 'synthetic:["tenant", "job"]\\suffix' });
  const value = identity(candidate);
  assertIdentity(value, candidate);
  for (const wrongInput of [candidate.idempotencyKey, `${candidate.workspaceId}:${candidate.idempotencyKey}`,
    `${VERSION}:${candidate.workspaceId}:${candidate.idempotencyKey}`,
    JSON.stringify([VERSION, candidate.workspaceId, candidate.idempotencyKey, candidate.mimeType])]) {
    assert.notEqual(value.keyDigest, createHash("sha256").update(wrongInput).digest("hex"));
  }
});

test("Generated identity: a 512-character exact key is accepted without truncation", () => {
  const prefix = "k".repeat(511);
  const candidates = [input({ idempotencyKey: `${prefix}a` }), input({ idempotencyKey: `${prefix}b` })];
  const values = candidates.map(candidate => {
    const value = identity(candidate);
    assertIdentity(value, candidate);
    return value;
  });
  assert.notEqual(values[0]!.keyDigest, values[1]!.keyDigest, "The last permitted character is part of the key");
  assert.notEqual(values[0]!.assetId, values[1]!.assetId);
});

const invalidKeys: Array<{ label: string; value: unknown }> = [
  { label: "missing", value: undefined }, { label: "null", value: null },
  { label: "boolean", value: true }, { label: "number", value: 42 }, { label: "zero", value: 0 },
  { label: "NaN", value: Number.NaN }, { label: "array", value: [KEY] }, { label: "object", value: {} },
  { label: "boxed string", value: new String(KEY) }, { label: "string-coercible object", value: { toString: () => KEY } },
  { label: "empty", value: "" }, { label: "spaces only", value: "   " }, { label: "tabs and newline only", value: "\t\r\n" },
  { label: "leading space", value: ` ${KEY}` }, { label: "trailing space", value: `${KEY} ` },
  { label: "leading tab", value: `\t${KEY}` }, { label: "trailing newline", value: `${KEY}\n` },
  { label: "nonbreaking leading space", value: `\u00a0${KEY}` }, { label: "trailing byte order mark", value: `${KEY}\ufeff` },
  { label: "513 characters", value: "k".repeat(513) },
];
for (const { label, value } of invalidKeys) {
  test(`Generated identity: rejects ${label} key instead of coercing, trimming or truncating`, () => {
    assert.throws(() => identity({ ...input(), idempotencyKey: value } as IdentityInput));
  });
}

test("Generated identity: workspace inputs must be UUID tenant strings, never coerced or path-like", () => {
  const invalid: unknown[] = [undefined, null, true, 12, {}, [WORKSPACE], new String(WORKSPACE),
    { toString: () => WORKSPACE }, "", " ", "demo-workspace", WORKSPACE.slice(1), WORKSPACE.replace(/-/g, ""),
    `g${WORKSPACE.slice(1)}`, `../${WORKSPACE}`, `${WORKSPACE}/generated/foreign`, `${WORKSPACE}?tenant=other`];
  for (const workspaceId of invalid) {
    assert.throws(() => identity({ ...input(), workspaceId } as IdentityInput), `Reject invalid tenant ${String(workspaceId)}`);
  }
});

test("Generated identity: rejects unsupported or malformed MIME values without extension guessing", () => {
  const invalid: unknown[] = [undefined, null, true, 42, {}, ["image/png"], new String("image/png"),
    { toString: () => "image/png" }, "", " ", "image/gif", "image/svg+xml", "image/jpg", "text/html",
    "application/octet-stream", "image/png; charset=utf-8", "image/../png", "video/unknown", "png", ".jpg"];
  for (const mimeType of invalid) {
    assert.throws(() => identity({ ...input(), mimeType } as IdentityInput), `Reject invalid MIME ${String(mimeType)}`);
  }
});

test("Generated identity: direct generated-video storage is refused before any SDK, persistence or public URL effect", async () => {
  const ts = createRequire(new URL("../../package.json", import.meta.url))("typescript") as typeof import("typescript");
  const server = await readFile(new URL("../../lib/crm/server.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("server.ts", server, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "storeGeneratedCreative");
  assert.ok(declaration, "Execute the complete actual production writer, not a copied guard");
  const compiled = ts.transpileModule(`${declaration.getText(ast)}\nexports.store = storeGeneratedCreative;`, {
    fileName: "generated-video-refusal.actual.ts", reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(compiled.diagnostics ?? [], []);
  const effects: string[] = [];
  const forbidden = (name: string) => () => { effects.push(name); throw new Error(`Unexpected ${name}`); };
  const exported: { store?: (input: Record<string, unknown>) => Promise<unknown> } = {};
  new Script(compiled.outputText).runInNewContext({ exports: exported, Buffer,
    getSupabaseServerClient: forbidden("SDK access"), buildAdCreativeStoragePath: forbidden("storage path"),
    generatedCreativeIdentity: forbidden("identity lookup"), validateCreativeAssetBody: forbidden("persistence preparation"),
    buildSupabaseStoragePublicUrl: forbidden("public URL"), persistAdCreativeAsset: forbidden("database write"),
    AD_CREATIVE_BUCKET: "synthetic-public-bucket" });
  assert.equal(typeof exported.store, "function");
  for (const mimeType of ["video/mp4", "video/quicktime", "video/webm", "video/unknown", "VIDEO/MP4", " video/mp4 ", "video/mp4; charset=utf-8"]) {
    for (const idempotencyKey of [undefined, KEY, "v2:12345678-1234-4567-89ab-123456789abc"]) {
      await assert.rejects(exported.store!({ workspaceId: WORKSPACE, fileName: "raw.mp4", mimeType,
        buffer: Buffer.from("not-native-validated"), idempotencyKey,
        metadata: { kind: "generated-video", nativeValidated: true, generatedKey: "forged-browser-proof" } }),
      (error: unknown) => error !== null && typeof error === "object" && "message" in error
        && error.message === "generated_video_native_validation_required");
      assert.deepEqual(effects, [], "No public storage, SDK initialization, database operation or forged metadata trust");
    }
  }
});
