import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const STAGED_CREATIVE_BUCKET = "ad-creatives-staging";
export const STAGED_CREATIVE_LIFETIME_MS = 2 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const formats: Record<string, { kind: "image" | "video"; extensions: string[]; maxBytes: number }> = {
  "image/jpeg": { kind: "image", extensions: ["jpg", "jpeg"], maxBytes: 10 * 1024 * 1024 },
  "image/png": { kind: "image", extensions: ["png"], maxBytes: 10 * 1024 * 1024 },
  "image/webp": { kind: "image", extensions: ["webp"], maxBytes: 10 * 1024 * 1024 },
  "video/mp4": { kind: "video", extensions: ["mp4"], maxBytes: 100 * 1024 * 1024 },
  "video/quicktime": { kind: "video", extensions: ["mov"], maxBytes: 100 * 1024 * 1024 },
  "video/webm": { kind: "video", extensions: ["webm"], maxBytes: 100 * 1024 * 1024 },
};

export type StagedCreativeActor = { workspaceId: string; userId: string; staffUserId: string };
export type StagedCreativeTicket = Readonly<StagedCreativeActor & {
  v: 1; id: string; fileName: string; mimeType: string; fileSize: number; issuedAt: number; expiresAt: number;
}>;
export class StagedCreativeTicketError extends Error {
  constructor() { super("creative_upload_ticket_unconfirmed"); }
}

function validActor(actor: StagedCreativeActor): boolean {
  return [actor?.workspaceId, actor?.userId, actor?.staffUserId].every(value => typeof value === "string" && UUID.test(value));
}

function canonical(ticket: StagedCreativeTicket): string {
  return JSON.stringify({ v: ticket.v, id: ticket.id, workspaceId: ticket.workspaceId, userId: ticket.userId,
    staffUserId: ticket.staffUserId, fileName: ticket.fileName, mimeType: ticket.mimeType, fileSize: ticket.fileSize,
    issuedAt: ticket.issuedAt, expiresAt: ticket.expiresAt });
}

function valid(ticket: StagedCreativeTicket, now: number): boolean {
  const format = typeof ticket?.mimeType === "string" && Object.hasOwn(formats, ticket.mimeType) ? formats[ticket.mimeType] : undefined;
  return Boolean(ticket && validActor(ticket) && ticket.v === 1 && UUID.test(ticket.id) && format
    && typeof ticket.fileName === "string" && ticket.fileName.length > 0 && Buffer.byteLength(ticket.fileName) <= 255
    && !/[\\/\u0000-\u001f\u007f]/.test(ticket.fileName)
    && format.extensions.includes(ticket.fileName.split(".").at(-1)?.toLowerCase() || "")
    && Number.isSafeInteger(ticket.fileSize) && ticket.fileSize > 0 && ticket.fileSize <= format.maxBytes
    && Number.isSafeInteger(now) && Number.isSafeInteger(ticket.issuedAt) && ticket.issuedAt >= 0 && ticket.issuedAt <= now
    && Number.isSafeInteger(ticket.expiresAt) && ticket.expiresAt > now
    && ticket.expiresAt - ticket.issuedAt === STAGED_CREATIVE_LIFETIME_MS);
}

function signature(payload: string, secret: string): Buffer {
  if (typeof secret !== "string" || secret.length < 32) throw new StagedCreativeTicketError();
  return createHmac("sha256", secret).update("medina:staged-creative:v1\n").update(payload).digest();
}

/** A signed manifest is not authorization; the route must resolve a live actor again. */
export function issueStagedCreativeTicket(input: StagedCreativeActor & {
  fileName: string; mimeType: string; fileSize: number;
}, secret: string, now = Date.now()): { handle: string; ticket: StagedCreativeTicket } {
  const ticket: StagedCreativeTicket = { v: 1, id: randomUUID(), workspaceId: input.workspaceId, userId: input.userId,
    staffUserId: input.staffUserId, fileName: input.fileName, mimeType: input.mimeType, fileSize: input.fileSize,
    issuedAt: now, expiresAt: now + STAGED_CREATIVE_LIFETIME_MS };
  if (!valid(ticket, now)) throw new StagedCreativeTicketError();
  return { handle: sealStagedCreativeTicket(ticket, secret, now), ticket: Object.freeze(ticket) };
}

/** Used only for the exact immutable manifest returned by server admission. */
export function sealStagedCreativeTicket(ticket: StagedCreativeTicket, secret: string, now = Date.now()): string {
  if (!valid(ticket, now)) throw new StagedCreativeTicketError();
  const payload = Buffer.from(canonical(ticket)).toString("base64url");
  return `u1.${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function readStagedCreativeTicket(handle: unknown, actor: StagedCreativeActor, secret: string, now = Date.now()): StagedCreativeTicket {
  try {
    if (!validActor(actor) || typeof handle !== "string" || handle.length > 2048) throw new StagedCreativeTicketError();
    const parts = /^u1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(handle);
    if (!parts) throw new StagedCreativeTicketError();
    const mac = Buffer.from(parts[2]!, "base64url"), expected = signature(parts[1]!, secret);
    if (mac.length !== expected.length || mac.toString("base64url") !== parts[2] || !timingSafeEqual(mac, expected)) throw new StagedCreativeTicketError();
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8"), ticket = JSON.parse(json) as StagedCreativeTicket;
    if (!valid(ticket, now) || canonical(ticket) !== json || Buffer.from(json).toString("base64url") !== parts[1]
      || ticket.workspaceId !== actor.workspaceId || ticket.userId !== actor.userId || ticket.staffUserId !== actor.staffUserId) throw new StagedCreativeTicketError();
    return Object.freeze(ticket);
  } catch { throw new StagedCreativeTicketError(); }
}

export function stagedCreativePath(ticket: StagedCreativeTicket): string {
  if (!valid(ticket, ticket.issuedAt)) throw new StagedCreativeTicketError();
  return `${ticket.workspaceId}/staged/${ticket.id}/original.${ticket.fileName.split(".").at(-1)!.toLowerCase()}`;
}

export function verifiedCreativeIdentity(ticket: StagedCreativeTicket, sha256: string): { id: string; storageBucket: string; storagePath: string } {
  if (!valid(ticket, ticket.issuedAt) || !/^[0-9a-f]{64}$/.test(sha256)) throw new StagedCreativeTicketError();
  return { id: ticket.id, storageBucket: "ad-creatives",
    storagePath: `${ticket.workspaceId}/verified/${ticket.id}/${sha256}.${ticket.fileName.split(".").at(-1)!.toLowerCase()}` };
}

export function stagedCreativeKind(ticket: StagedCreativeTicket): "image" | "video" {
  if (!valid(ticket, ticket.issuedAt)) throw new StagedCreativeTicketError();
  return formats[ticket.mimeType]!.kind;
}
