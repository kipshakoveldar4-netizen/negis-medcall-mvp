import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { PROMPT_MAX_LENGTH, readSignedVideoJobHandle } from "./generation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEY = /^v2:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_INFO = "medina/content-studio/generated-video-handle/v2";
const MAX_HANDLE_LENGTH = 2048;
const MAX_PROVIDER_ID_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type GeneratedVideoJobHandle = {
  workspaceId: string;
  generationKey: string;
  providerJobId: string;
  legacy: boolean;
};

type HandleInput = Omit<GeneratedVideoJobHandle, "legacy">;

function validSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16384
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function validProviderId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PROVIDER_ID_LENGTH
    && Buffer.byteLength(value, "utf8") <= MAX_PROVIDER_ID_LENGTH
    && Buffer.from(value, "utf8").toString("utf8") === value
    && value.trim() === value && !/[\u0000-\u0020\u007f]/.test(value);
}

function canonicalPayload(input: HandleInput): string {
  return JSON.stringify({ version: 2, workspaceId: input.workspaceId,
    generationKey: input.generationKey, providerJobId: input.providerJobId });
}

function signature(payload: string, secret: string): Buffer {
  const key = createHmac("sha256", secret).update(KEY_INFO).digest();
  return createHmac("sha256", key).update(`g2.${payload}`).digest();
}

export function generatedVideoRequestDigest(prompt: unknown, format: unknown): string {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > PROMPT_MAX_LENGTH
    || typeof format !== "string" || !format || format.length > 128 || format.trim() !== format
    || /[\u0000-\u001f\u007f]/.test(format)) throw new Error("generated_video_request_invalid");
  return createHash("sha256")
    .update(JSON.stringify(["medina-generated-video-request-v2", prompt.trim(), format])).digest("hex");
}

export function signGeneratedVideoJobHandle(input: HandleInput, secret: string): string {
  if (!input || typeof input.workspaceId !== "string" || !UUID.test(input.workspaceId)
    || typeof input.generationKey !== "string" || !REQUEST_KEY.test(input.generationKey)
    || !validProviderId(input.providerJobId) || !validSecret(secret)) {
    throw new Error("generated_video_handle_invalid");
  }
  const payload = Buffer.from(canonicalPayload({ ...input, workspaceId: input.workspaceId.toLowerCase() })).toString("base64url");
  return `g2.${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function readGeneratedVideoJobHandle(handle: unknown, workspaceId: unknown, secret: unknown): GeneratedVideoJobHandle | null {
  if (typeof handle !== "string" || !handle || handle.length > MAX_HANDLE_LENGTH || handle.trim() !== handle
    || typeof workspaceId !== "string" || !UUID.test(workspaceId) || !validSecret(secret)) return null;
  const workspace = workspaceId.toLowerCase();
  if (!handle.startsWith("g2.")) {
    const providerJobId = readSignedVideoJobHandle({ handle, workspaceId: workspace, secret });
    return validProviderId(providerJobId)
      ? { workspaceId: workspace, generationKey: providerJobId, providerJobId, legacy: true } : null;
  }
  const parts = handle.split(".");
  if (parts.length !== 3 || parts[0] !== "g2" || !parts[1] || !BASE64URL.test(parts[1])
    || !parts[2] || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
  const payload = Buffer.from(parts[1], "base64url");
  const provided = Buffer.from(parts[2], "base64url");
  if (payload.toString("base64url") !== parts[1] || provided.length !== 32 || provided.toString("base64url") !== parts[2]
    || !timingSafeEqual(provided, signature(parts[1], secret))) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(payload.toString("utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || row.version !== 2 || row.workspaceId !== workspace
    || typeof row.generationKey !== "string" || !REQUEST_KEY.test(row.generationKey)
    || !validProviderId(row.providerJobId)) return null;
  const value = { workspaceId: workspace, generationKey: row.generationKey, providerJobId: row.providerJobId };
  // One canonical encoding rejects duplicate JSON fields and alternate UTF-8/base64 representations.
  if (!payload.equals(Buffer.from(canonicalPayload(value)))) return null;
  return { ...value, legacy: false };
}
