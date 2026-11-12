import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
const DNS_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");

export function generatedCreativeIdentity(input: { workspaceId: unknown; idempotencyKey: unknown; mimeType: unknown }) {
  if (typeof input.workspaceId !== "string" || !UUID.test(input.workspaceId)
    || typeof input.idempotencyKey !== "string" || !input.idempotencyKey || input.idempotencyKey.length > 512
    || input.idempotencyKey.trim() !== input.idempotencyKey || /[\u0000-\u001f\u007f]/.test(input.idempotencyKey) || typeof input.mimeType !== "string"
    || !Object.hasOwn(extensions, input.mimeType)) throw new Error("generated_identity_invalid");
  const workspace = input.workspaceId.toLowerCase();
  const keyDigest = createHash("sha256").update(JSON.stringify(["medina-generated-v1", workspace, input.idempotencyKey])).digest("hex");
  // RFC 4122 v5 over a SHA-256-prehashed name, not a random UUID per poll.
  const id = createHash("sha1").update(DNS_NAMESPACE).update(`medina-generated-v1:${keyDigest}`).digest().subarray(0, 16);
  id[6] = (id[6]! & 0x0f) | 0x50; id[8] = (id[8]! & 0x3f) | 0x80;
  const hex = id.toString("hex");
  return { assetId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    keyDigest, fileName: `negis-${input.mimeType.startsWith("image/") ? "image" : "video"}-${keyDigest.slice(0, 20)}.${extensions[input.mimeType]}`,
    storagePath: `${workspace}/generated/${keyDigest}` };
}

export function isLegacyGeneratedVideoIdentity(input: { workspaceId: string; idempotencyKey: string; fileName: unknown; storagePath: unknown }): boolean {
  if (!UUID.test(input.workspaceId) || typeof input.fileName !== "string" || !/^negis-video-\d{13}\.mp4$/.test(input.fileName)
    || typeof input.storagePath !== "string") return false;
  const job = input.idempotencyKey.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!job) return false;
  const prefix = `${input.workspaceId.toLowerCase()}/`;
  if (!input.storagePath.startsWith(prefix)) return false;
  const suffix = input.storagePath.slice(prefix.length);
  return /^\d{4}\/(0[1-9]|1[0-2])\//.test(suffix) && suffix.slice(8) === `${job}-${input.fileName}`;
}
