export type VerifiedCreativeAsset = {
  id: string;
  workspaceId: string;
  fileName: string;
  fileType: "image";
  mimeType: string;
  fileSize: number;
  storageBucket: "ad-creatives";
  storagePath: string;
  publicUrl: string;
  status: "uploaded" | "ready";
  [key: string]: unknown;
};

export type VerifiedCreativeUploadInput = {
  workspaceId: string;
  file: Blob;
  fileName: string;
  mimeType: string;
  requestKey: string;
  storageOrigin: string;
  request: (url: string, init: RequestInit) => Promise<{ success: boolean; mode: string; data: unknown }>;
  upload: (bucket: string, path: string, token: string, file: Blob,
    opts: { contentType: string; upsert: false }) => Promise<{ data?: unknown; error?: unknown }>;
  // The caller owns a captured, monotonic session lifetime, including ABA changes.
  assertCurrent: () => Promise<void>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxBytes = 10 * 1024 * 1024;
const stagingBucket = "ad-creatives-staging";
const formats: Record<string, readonly string[]> = {
  "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"],
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function confirmedData(value: unknown, code: string): Record<string, unknown> {
  const envelope = record(value), data = record(envelope?.data);
  if (envelope?.success !== true || envelope.mode !== "supabase" || !data) throw new Error(code);
  return data;
}

function validateInput(input: VerifiedCreativeUploadInput): string {
  const { workspaceId, file, fileName, mimeType, requestKey, storageOrigin } = input;
  const extension = typeof fileName === "string" ? fileName.split(".").at(-1)!.toLowerCase() : "";
  let trustedOrigin = false;
  try {
    const url = new URL(storageOrigin);
    trustedOrigin = url.protocol === "https:" && url.origin === storageOrigin && !url.username && !url.password;
  } catch { /* An invalid origin must fail before any dispatch. */ }
  if (!trustedOrigin || !uuid.test(workspaceId) || !uuid4.test(requestKey)
    || !Object.hasOwn(formats, mimeType) || !formats[mimeType]!.includes(extension)
    || typeof fileName !== "string" || !fileName || new TextEncoder().encode(fileName).length > 255
    || /[\\/\u0000-\u001f\u007f]/.test(fileName)
    || !(file instanceof Blob) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxBytes
    || (file.type !== "" && file.type !== mimeType)) throw new Error("creative_upload_request_unconfirmed");
  return extension;
}

function privateTicket(value: unknown, input: VerifiedCreativeUploadInput, extension: string) {
  const code = "creative_upload_ticket_unconfirmed", ticket = confirmedData(value, code);
  const parts = typeof ticket.storagePath === "string" ? ticket.storagePath.split("/") : [];
  if ((ticket.bucket !== stagingBucket && ticket.storageBucket !== stagingBucket)
    || (ticket.bucket !== undefined && ticket.bucket !== stagingBucket)
    || (ticket.storageBucket !== undefined && ticket.storageBucket !== stagingBucket)
    || parts.length !== 4 || parts[0] !== input.workspaceId || parts[1] !== "staged" || !uuid4.test(parts[2]!)
    || parts[3] !== `original.${extension}`
    || typeof ticket.uploadHandle !== "string" || ticket.uploadHandle.length > 2048
    || !/^u1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket.uploadHandle)
    || (ticket.uploadRequired !== undefined && typeof ticket.uploadRequired !== "boolean")
    || (ticket.finalized !== undefined && ticket.finalized !== false)
    || (ticket.uploadRequired === false
      ? ticket.token !== undefined || ticket.signedUrl !== undefined
      : typeof ticket.token !== "string" || !ticket.token.trim() || ticket.token !== ticket.token.trim())
    || ticket.fileName !== input.fileName || ticket.fileType !== "image"
    || ticket.mimeType !== input.mimeType || ticket.fileSize !== input.file.size
    || (ticket.workspaceId !== undefined && ticket.workspaceId !== input.workspaceId)
    || (ticket.requestKey !== undefined && ticket.requestKey !== input.requestKey)
    || (ticket.operationId !== undefined && ticket.operationId !== parts[2])
    || ticket.publicUrl !== undefined || ticket.asset !== undefined || ticket.item !== undefined
    || ticket.ready === true || ticket.status === "ready") throw new Error(code);
  return { nonce: parts[2]!, storagePath: ticket.storagePath as string, uploadHandle: ticket.uploadHandle,
    token: ticket.uploadRequired === false ? null : ticket.token as string };
}

function completedReplay(value: unknown, input: VerifiedCreativeUploadInput, extension: string): VerifiedCreativeAsset | null {
  const code = "creative_upload_ticket_unconfirmed", data = confirmedData(value, code);
  if (data.finalized !== true) return null;
  if (typeof data.operationId !== "string" || !uuid4.test(data.operationId) || data.requestKey !== input.requestKey
    || (data.workspaceId !== undefined && data.workspaceId !== input.workspaceId)
    || (data.uploadRequired !== undefined && data.uploadRequired !== false)
    || data.token !== undefined || data.signedUrl !== undefined || data.uploadHandle !== undefined
    || data.bucket !== undefined || data.storageBucket !== undefined || data.storagePath !== undefined
    || data.publicUrl !== undefined) throw new Error(code);
  return verifiedAsset(value, input, data.operationId, extension);
}

function verifiedAsset(value: unknown, input: VerifiedCreativeUploadInput, nonce: string, extension: string): VerifiedCreativeAsset {
  const code = "creative_upload_asset_unconfirmed", data = confirmedData(value, code);
  if ((data.operationId !== undefined && data.operationId !== nonce)
    || (data.requestKey !== undefined && data.requestKey !== input.requestKey)
    || (data.workspaceId !== undefined && data.workspaceId !== input.workspaceId)) throw new Error(code);
  const validate = (value: unknown): VerifiedCreativeAsset => {
    const asset = record(value);
    const prefix = `${input.workspaceId}/verified/${nonce}/`;
    const path = typeof asset?.storagePath === "string" ? asset.storagePath : "";
    if (!asset || asset.id !== nonce || asset.workspaceId !== input.workspaceId || asset.fileType !== "image"
      || asset.fileName !== input.fileName || asset.mimeType !== input.mimeType
      || typeof asset.fileSize !== "number" || !Number.isSafeInteger(asset.fileSize) || asset.fileSize <= 0 || asset.fileSize > maxBytes
      || asset.storageBucket !== "ad-creatives" || !path.startsWith(prefix)
      || !/^[0-9a-f]{64}\.(jpg|jpeg|png|webp)$/.test(path.slice(prefix.length)) || !path.endsWith(`.${extension}`)
      || asset.publicUrl !== `${input.storageOrigin}/storage/v1/object/public/ad-creatives/${path}`
      || (asset.status !== "uploaded" && asset.status !== "ready")) throw new Error(code);
    return asset as VerifiedCreativeAsset;
  };
  const asset = validate(data.asset !== undefined ? data.asset : data.item);
  if (data.asset !== undefined && data.item !== undefined) {
    const item = validate(data.item);
    for (const key of ["id", "workspaceId", "fileName", "fileType", "mimeType", "fileSize", "storageBucket", "storagePath", "publicUrl", "status"]) {
      if (asset[key] !== item[key]) throw new Error(code);
    }
  }
  return asset;
}

export async function uploadVerifiedCreativeImage(input: VerifiedCreativeUploadInput): Promise<VerifiedCreativeAsset> {
  const attempt = { ...input };
  const { workspaceId, file, fileName, mimeType, requestKey, request, upload, assertCurrent } = attempt;
  const extension = validateInput(attempt);
  const query = `?workspaceId=${encodeURIComponent(workspaceId)}`;
  const init = (body: unknown): RequestInit => ({ method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  let signed: unknown;
  await assertCurrent();
  try {
    signed = await request(`/api/crm/ad-creatives/signed-upload${query}`,
      init({ fileName, fileType: "image", mimeType, fileSize: file.size, requestKey }));
  } finally { await assertCurrent(); }
  const completed = completedReplay(signed, attempt, extension);
  if (completed) return completed;
  const ticket = privateTicket(signed, attempt, extension);

  if (ticket.token !== null) {
    await assertCurrent();
    try {
      await upload(stagingBucket, ticket.storagePath, ticket.token, file, { contentType: mimeType, upsert: false });
    } catch {
      // A lost SDK acknowledgement does not prove the private object is absent.
      // Finalization is the only authority; never upload again here.
    } finally { await assertCurrent(); }
  }

  let finalized: unknown;
  await assertCurrent();
  try {
    finalized = await request(`/api/crm/ad-creatives/finalize-upload${query}`, init({ uploadHandle: ticket.uploadHandle }));
  } finally { await assertCurrent(); }
  return verifiedAsset(finalized, attempt, ticket.nonce, extension);
}
