import { generatedCreativeIdentity } from "./generated-identity";

export function generatedVideoIdentity(input: { workspaceId: unknown; generationKey: unknown }) {
  if (typeof input.generationKey === "string" && (Buffer.byteLength(input.generationKey, "utf8") > 512
    || Buffer.from(input.generationKey, "utf8").toString("utf8") !== input.generationKey
    || (input.generationKey.startsWith("v2:")
      && !/^v2:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.generationKey)))) {
    throw new Error("generated_video_identity_invalid");
  }
  const identity = generatedCreativeIdentity({ workspaceId: input.workspaceId,
    idempotencyKey: input.generationKey, mimeType: "video/mp4" });
  return { assetId: identity.assetId, keyDigest: identity.keyDigest, fileName: identity.fileName,
    rawPath: `${String(input.workspaceId).toLowerCase()}/generated-raw/${identity.keyDigest}/original.mp4`,
    generatedKey: `v1:${input.generationKey}` };
}
