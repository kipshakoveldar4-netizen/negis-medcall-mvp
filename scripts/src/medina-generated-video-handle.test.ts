import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

type HandleInput = { workspaceId: string; generationKey: string; providerJobId: string };
type HandleValue = HandleInput & { legacy: boolean };
type ActualModule = {
  signGeneratedVideoJobHandle(input: HandleInput, secret: string): string;
  readGeneratedVideoJobHandle(handle: unknown, workspaceId: unknown, secret: unknown): HandleValue | null;
  generatedVideoRequestDigest(prompt: unknown, format: unknown): string;
};
const actual = await import(new URL("../../lib/content-studio/generated-video-handle.ts", import.meta.url).href) as ActualModule;
const legacy = await import(new URL("../../lib/content-studio/generation.ts", import.meta.url).href) as {
  signVideoJobHandle(input: { workspaceId: string; jobId: string; secret: string }): string;
};
const WORKSPACE = "abcdef01-2345-4678-9abc-def012345678";
const FOREIGN = "abcdef01-2345-4678-9abc-def012345679";
const KEY = "v2:12345678-1234-4567-89ab-123456789abc";
const SECOND_KEY = "v2:12345678-1234-4567-89ab-123456789abd";
const SECRET = "synthetic-only-HMAC-key-not-a-service-credential";
const PROVIDER = "video_synthetic_56";
const input = (patch: Partial<HandleInput> = {}): HandleInput => ({ workspaceId: WORKSPACE, generationKey: KEY, providerJobId: PROVIDER, ...patch });

function independentlySignPayload(text: string | Buffer, secret = SECRET) {
  const encoded = Buffer.from(text).toString("base64url");
  const key = createHmac("sha256", secret).update("medina/content-studio/generated-video-handle/v2").digest();
  const mac = createHmac("sha256", key).update(`g2.${encoded}`).digest("base64url");
  return `g2.${encoded}.${mac}`;
}

test("Generated video handle: exact domain-separated canonical wire format and immutable input", () => {
  const candidate = Object.freeze(input());
  const handle = actual.signGeneratedVideoJobHandle(candidate, SECRET);
  const payload = JSON.stringify({ version: 2, ...candidate });
  assert.equal(handle, independentlySignPayload(payload));
  assert.deepEqual(actual.readGeneratedVideoJobHandle(handle, WORKSPACE, SECRET), { ...candidate, legacy: false });
  assert.equal(actual.signGeneratedVideoJobHandle(candidate, SECRET), handle);
  assert.equal(handle.includes(SECRET), false);
  assert.deepEqual(candidate, input());
});

test("Generated video handle: workspace UUID case is canonical and foreign tenants or keys cannot replay", () => {
  const handle = actual.signGeneratedVideoJobHandle(input({ workspaceId: WORKSPACE.toUpperCase() }), SECRET);
  assert.equal(handle, actual.signGeneratedVideoJobHandle(input(), SECRET));
  assert.deepEqual(actual.readGeneratedVideoJobHandle(handle, WORKSPACE.toUpperCase(), SECRET), { ...input(), legacy: false });
  assert.equal(actual.readGeneratedVideoJobHandle(handle, FOREIGN, SECRET), null);
  assert.equal(actual.readGeneratedVideoJobHandle(handle, WORKSPACE, `${SECRET}-rotated`), null);
  for (const patch of [{ generationKey: SECOND_KEY }, { providerJobId: `${PROVIDER}-other` }, { workspaceId: FOREIGN }]) {
    assert.notEqual(actual.signGeneratedVideoJobHandle(input(patch), SECRET), handle);
  }
});

test("Generated video handle: both signed binding fields survive exact Unicode and delimiter encoding", () => {
  for (const providerJobId of ["video:ab:cd", "video.a-b_c", 'video/quoted-"\\-suffix', "video-\u4e2d\u6587"]) {
    const candidate = input({ providerJobId });
    assert.deepEqual(actual.readGeneratedVideoJobHandle(actual.signGeneratedVideoJobHandle(candidate, SECRET), WORKSPACE, SECRET),
      { ...candidate, legacy: false });
  }
});

test("Generated video handle: cannot substitute legacy-purpose or raw-secret HMACs", () => {
  const payload = Buffer.from(JSON.stringify({ version: 2, ...input() })).toString("base64url");
  const rawSignature = createHmac("sha256", SECRET).update(`g2.${payload}`).digest("base64url");
  assert.equal(actual.readGeneratedVideoJobHandle(`g2.${payload}.${rawSignature}`, WORKSPACE, SECRET), null);
  const legacySigned = legacy.signVideoJobHandle({ workspaceId: WORKSPACE, jobId: `g2.${payload}`, secret: SECRET });
  assert.equal(actual.readGeneratedVideoJobHandle(legacySigned, WORKSPACE, SECRET), null, "A malformed g2 handle cannot downgrade to legacy");
});

const malformedPayloads: Array<[string, string]> = [
  ["version 1", JSON.stringify({ version: 1, ...input() })],
  ["string version", JSON.stringify({ version: "2", ...input() })],
  ["extra field", JSON.stringify({ version: 2, ...input(), url: "https://foreign.invalid/raw.mp4" })],
  ["missing generation key", JSON.stringify({ version: 2, workspaceId: WORKSPACE, providerJobId: PROVIDER })],
  ["foreign workspace", JSON.stringify({ version: 2, ...input({ workspaceId: FOREIGN }) })],
  ["uppercase workspace payload", JSON.stringify({ version: 2, ...input({ workspaceId: WORKSPACE.toUpperCase() }) })],
  ["array", JSON.stringify([2, WORKSPACE, KEY, PROVIDER])],
  ["null", "null"],
  ["broken JSON", '{"version":2'],
  ["duplicate field", `{"version":2,"workspaceId":"${WORKSPACE}","generationKey":"${KEY}","providerJobId":"wrong","providerJobId":"${PROVIDER}"}`],
  ["alternate property order", JSON.stringify({ workspaceId: WORKSPACE, version: 2, generationKey: KEY, providerJobId: PROVIDER })],
  ["leading JSON whitespace", ` ${JSON.stringify({ version: 2, ...input() })}`],
  ["legacy rather than request key", JSON.stringify({ version: 2, ...input({ generationKey: PROVIDER }) })],
  ["wrong request UUID version", JSON.stringify({ version: 2, ...input({ generationKey: KEY.replace("-4567-", "-5567-") }) })],
  ["wrong request UUID variant", JSON.stringify({ version: 2, ...input({ generationKey: KEY.replace("89ab", "79ab") }) })],
  ["provider object", JSON.stringify({ version: 2, ...input(), providerJobId: { id: PROVIDER } })],
  ["empty provider", JSON.stringify({ version: 2, ...input({ providerJobId: "" }) })],
  ["provider control", JSON.stringify({ version: 2, ...input({ providerJobId: "video\nforeign" }) })],
  ["provider over byte limit", JSON.stringify({ version: 2, ...input({ providerJobId: "\u4e2d".repeat(171) }) })],
  ["provider lone surrogate", JSON.stringify({ version: 2, ...input({ providerJobId: "video-\ud800" }) })],
];
for (const [name, payload] of malformedPayloads) {
  test(`Generated video handle: refuses authenticated but noncanonical payload ${name}`, () => {
    assert.equal(actual.readGeneratedVideoJobHandle(independentlySignPayload(payload), WORKSPACE, SECRET), null);
  });
}

test("Generated video handle: malformed wire inputs, encodings and signatures fail closed without coercion", () => {
  const handle = actual.signGeneratedVideoJobHandle(input(), SECRET);
  const [version, payload, mac] = handle.split(".");
  const invalid: unknown[] = [undefined, null, 42, true, {}, [handle], new String(handle), "", " ", ` ${handle}`, `${handle}\n`,
    "x".repeat(2049), `g3.${payload}.${mac}`, `${version}.${payload}`, `${version}.${payload}.${mac}.extra`,
    `${version}.${payload}=.${mac}`, `${version}.${payload}.${mac}=`, `${version}.${payload}.${mac!.slice(1)}`,
    `${version}.${payload}.!${mac!.slice(1)}`, `${version}.!${payload}.${mac}`, `${version}..${mac}`,
    `${version}.${payload}.${mac![0] === "a" ? "b" : "a"}${mac!.slice(1)}`];
  for (const candidate of invalid) assert.equal(actual.readGeneratedVideoJobHandle(candidate, WORKSPACE, SECRET), null);
  for (const candidate of [undefined, null, 12, {}, "", ` ${WORKSPACE}`, `${WORKSPACE}/foreign`]) {
    assert.equal(actual.readGeneratedVideoJobHandle(handle, candidate, SECRET), null);
  }
  for (const secret of [undefined, null, 12, {}, "", ` ${SECRET}`, `${SECRET}\n`, "s".repeat(16385)]) {
    assert.equal(actual.readGeneratedVideoJobHandle(handle, WORKSPACE, secret), null);
  }
});

test("Generated video handle: detects payload tampering before treating it as a provider job", () => {
  const handle = actual.signGeneratedVideoJobHandle(input(), SECRET);
  const parts = handle.split(".");
  parts[1] = Buffer.from(JSON.stringify({ version: 2, ...input({ generationKey: SECOND_KEY }) })).toString("base64url");
  assert.equal(actual.readGeneratedVideoJobHandle(parts.join("."), WORKSPACE, SECRET), null);
});

test("Generated video handle: invalid UTF-8 and noncanonical base64url cannot create alternate authenticated handles", () => {
  const invalidUtf8 = Buffer.concat([Buffer.from(`{"version":2,"workspaceId":"${WORKSPACE}","generationKey":"${KEY}","providerJobId":"video-`),
    Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  assert.equal(actual.readGeneratedVideoJobHandle(independentlySignPayload(invalidUtf8), WORKSPACE, SECRET), null);
  const handle = actual.signGeneratedVideoJobHandle(input(), SECRET);
  const [version, payload, mac] = handle.split(".");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(mac!.at(-1)!);
  const noncanonicalMac = `${mac!.slice(0, -1)}${alphabet[last ^ 1]}`;
  assert.deepEqual(Buffer.from(noncanonicalMac, "base64url"), Buffer.from(mac!, "base64url"), "Fixture only changes unused padding bits");
  assert.equal(actual.readGeneratedVideoJobHandle(`${version}.${payload}.${noncanonicalMac}`, WORKSPACE, SECRET), null);
});

test("Generated video handle: sign refuses malformed or coerced inputs and accepts exact 512-byte provider ID", () => {
  for (const generationKey of ["", PROVIDER, ` ${KEY}`, `${KEY}\n`, KEY.toUpperCase(), KEY.replace("-4567-", "-3567-"), KEY.replace("89ab", "79ab")]) {
    assert.throws(() => actual.signGeneratedVideoJobHandle(input({ generationKey }), SECRET), /generated_video_handle_invalid/);
  }
  for (const providerJobId of ["", " ", ` ${PROVIDER}`, `${PROVIDER}\n`, "video job", "x".repeat(513), "\u4e2d".repeat(171), "video-\ud800"]) {
    assert.throws(() => actual.signGeneratedVideoJobHandle(input({ providerJobId }), SECRET), /generated_video_handle_invalid/);
  }
  for (const workspaceId of ["", ` ${WORKSPACE}`, "demo", WORKSPACE.replace("4678", "0678")]) {
    assert.throws(() => actual.signGeneratedVideoJobHandle(input({ workspaceId }), SECRET), /generated_video_handle_invalid/);
  }
  for (const secret of ["", ` ${SECRET}`, `${SECRET}\n`, "s".repeat(16385)]) {
    assert.throws(() => actual.signGeneratedVideoJobHandle(input(), secret), /generated_video_handle_invalid/);
  }
  const candidate = input({ providerJobId: "p".repeat(512) });
  const handle = actual.signGeneratedVideoJobHandle(candidate, SECRET);
  assert.ok(handle.length <= 2048);
  assert.deepEqual(actual.readGeneratedVideoJobHandle(handle, WORKSPACE, SECRET), { ...candidate, legacy: false });
});

test("Generated video handle: legacy reader verifies the old signature and binds exact provider ID as generation key", () => {
  for (const providerJobId of [PROVIDER, "video.job:legacy", "p".repeat(512)]) {
    const handle = legacy.signVideoJobHandle({ workspaceId: WORKSPACE, jobId: providerJobId, secret: SECRET });
    assert.deepEqual(actual.readGeneratedVideoJobHandle(handle, WORKSPACE, SECRET),
      { workspaceId: WORKSPACE, generationKey: providerJobId, providerJobId, legacy: true });
    assert.equal(actual.readGeneratedVideoJobHandle(handle, FOREIGN, SECRET), null);
    assert.equal(actual.readGeneratedVideoJobHandle(handle, WORKSPACE, `${SECRET}-wrong`), null);
  }
  for (const providerJobId of ["", "p".repeat(513), "\u4e2d".repeat(171), "video job", "video\u0000id", "video\nid", "video-\ud800"]) {
    const handle = legacy.signVideoJobHandle({ workspaceId: WORKSPACE, jobId: providerJobId, secret: SECRET });
    assert.equal(actual.readGeneratedVideoJobHandle(handle, WORKSPACE, SECRET), null);
  }
});

test("Generated video request digest: exact versioned prompt/format tuple excludes provider configuration", () => {
  const prompt = "  Synthetic mortgage consultation\nsecond line  ";
  const format = "reels";
  const expected = createHash("sha256").update(JSON.stringify(["medina-generated-video-request-v2", prompt.trim(), format])).digest("hex");
  assert.equal(actual.generatedVideoRequestDigest(prompt, format), expected);
  assert.equal(actual.generatedVideoRequestDigest(prompt.trim(), format), expected);
  assert.notEqual(actual.generatedVideoRequestDigest(`${prompt.trim()}!`, format), expected);
  assert.notEqual(actual.generatedVideoRequestDigest(prompt, "stories"), expected);
  assert.notEqual(actual.generatedVideoRequestDigest("a\nb", format), actual.generatedVideoRequestDigest("a b", format));
  assert.notEqual(actual.generatedVideoRequestDigest("caf\u00e9", format), actual.generatedVideoRequestDigest("cafe\u0301", format));
});

test("Generated video request digest: malformed inputs cannot be silently coerced or truncated", () => {
  for (const prompt of [undefined, null, {}, [], 12, "", "  ", "p".repeat(4001)]) {
    assert.throws(() => actual.generatedVideoRequestDigest(prompt, "reels"), /generated_video_request_invalid/);
  }
  for (const format of [undefined, null, {}, [], 12, "", " ", " reels", "reels\n", "f".repeat(129)]) {
    assert.throws(() => actual.generatedVideoRequestDigest("Synthetic prompt", format), /generated_video_request_invalid/);
  }
  assert.match(actual.generatedVideoRequestDigest("p".repeat(4000), "f".repeat(128)), /^[0-9a-f]{64}$/);
});
