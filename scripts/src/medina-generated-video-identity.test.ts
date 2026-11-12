import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

type Input = { workspaceId: unknown; generationKey: unknown };
type Identity = { assetId: string; keyDigest: string; fileName: string; rawPath: string; generatedKey: string };
const actual = await import(new URL("../../lib/crm/generated-video-identity.ts", import.meta.url).href) as {
  generatedVideoIdentity(input: Input): Identity;
};
const WORKSPACE = "abcdef01-2345-4678-9abc-def012345678";
const FOREIGN = "abcdef01-2345-4678-9abc-def012345679";
const KEY = "v2:12345678-1234-4567-89ab-123456789abc";

function referenceIdentity(workspaceId: string, generationKey: string): Identity {
  const workspace = workspaceId.toLowerCase();
  const digest = createHash("sha256").update(JSON.stringify(["medina-generated-v1", workspace, generationKey])).digest("hex");
  const uuid = createHash("sha1").update(Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"))
    .update(`medina-generated-v1:${digest}`).digest().subarray(0, 16);
  uuid[6] = (uuid[6]! & 0x0f) | 0x50;
  uuid[8] = (uuid[8]! & 0x3f) | 0x80;
  const hex = uuid.toString("hex");
  return { assetId: [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-"),
    keyDigest: digest, fileName: `negis-video-${digest.slice(0, 20)}.mp4`,
    rawPath: `${workspace}/generated-raw/${digest}/original.mp4`, generatedKey: `v1:${generationKey}` };
}

test("Generated video identity: canonical private path and final identity match independent SHA/UUID derivation", () => {
  const candidate = Object.freeze({ workspaceId: WORKSPACE, generationKey: KEY });
  const identity = actual.generatedVideoIdentity(candidate);
  assert.deepEqual(identity, referenceIdentity(WORKSPACE, KEY));
  assert.deepEqual(actual.generatedVideoIdentity(candidate), identity);
  assert.deepEqual(candidate, { workspaceId: WORKSPACE, generationKey: KEY });
  assert.match(identity.assetId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(Object.hasOwn(identity, "publicUrl"), false);
  assert.equal(Object.hasOwn(identity, "storagePath"), false, "A private input identity cannot masquerade as a public output path");
});

test("Generated video identity: UTC/date boundaries, MIME and caller name cannot redirect the deterministic input", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 11, 31, 23, 59, 59) });
  const identity = actual.generatedVideoIdentity({ workspaceId: WORKSPACE, generationKey: KEY });
  t.mock.timers.setTime(Date.UTC(2027, 0, 1));
  const candidate = { workspaceId: WORKSPACE, generationKey: KEY, mimeType: "video/webm", fileName: "../../foreign.mp4" };
  assert.deepEqual(actual.generatedVideoIdentity(candidate), identity);
  assert.deepEqual(actual.generatedVideoIdentity({ workspaceId: WORKSPACE.toUpperCase(), generationKey: KEY }), identity);
});

test("Generated video identity: tenant and exact request/legacy keys produce different safe paths", () => {
  const keys = [KEY, KEY.replace(/c$/, "d"), "video_legacy-56", 'video:legacy/"\\segments', "\u4e2d\u6587"];
  const identities: Identity[] = [];
  for (const workspaceId of [WORKSPACE, FOREIGN]) {
    for (const generationKey of keys) {
      const identity = actual.generatedVideoIdentity({ workspaceId, generationKey });
      assert.deepEqual(identity, referenceIdentity(workspaceId, generationKey));
      assert.equal(identity.rawPath.split("/").length, 4);
      assert.equal(identity.rawPath.startsWith(`${workspaceId}/generated-raw/`), true);
      identities.push(identity);
    }
  }
  for (const field of ["assetId", "keyDigest", "rawPath"] as const) {
    assert.equal(new Set(identities.map(identity => identity[field])).size, identities.length);
  }
});

test("Generated video identity: rejects invalid request versions, tenant values and nonexact keys", () => {
  for (const workspaceId of [undefined, null, {}, 42, "", "demo", ` ${WORKSPACE}`, `${WORKSPACE}/foreign`]) {
    assert.throws(() => actual.generatedVideoIdentity({ workspaceId, generationKey: KEY }));
  }
  for (const generationKey of [undefined, null, 12, {}, [], "", " ", ` ${KEY}`, `${KEY}\n`, "video\u0000id",
    "x".repeat(513), "\u4e2d".repeat(171), "video-\ud800", "v2:invalid", `v2:${KEY.slice(3).toUpperCase()}`, KEY.replace("-4567-", "-5567-"), KEY.replace("89ab", "79ab")]) {
    assert.throws(() => actual.generatedVideoIdentity({ workspaceId: WORKSPACE, generationKey }), `Reject ${String(generationKey)}`);
  }
  assert.deepEqual(actual.generatedVideoIdentity({ workspaceId: WORKSPACE, generationKey: "x".repeat(512) }), referenceIdentity(WORKSPACE, "x".repeat(512)));
});
