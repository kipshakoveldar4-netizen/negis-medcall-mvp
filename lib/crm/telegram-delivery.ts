import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readContentVideoVersion } from "../content-studio/telegram-delivery-guard";
import { getSupabaseServerClient } from "../supabase/server";

type Row = Record<string, unknown>;
type Actor = { workspaceId: string; staffUserId: string; userId: string };
export class TelegramDeliveryError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export type TelegramDelivery = {
  actor: Actor; videoId: string; version: string; kind: "package" | "test";
  dispatchId: string; contentHash: string; partHashes: string[]; recipientHash: string;
  replayed: boolean; client: SupabaseClient;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Freshness belongs to the browser's explicit intent UUID, not a timestamp/TTL.
const TEST_NAMESPACE_VERSION = "2000-01-01T00:00:00.000000Z";
const TEXT_FIELDS = ["title", "hook", "script", "voiceover", "cta", "caption", "avatarPrompt", "tapnowPrompt"] as const;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export const telegramDeliveryHash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const unavailable = () => new TelegramDeliveryError(503, "telegram_delivery_unconfirmed");
const invalid = () => new TelegramDeliveryError(400, "telegram_delivery_invalid");

function canonicalTelegramChatId(value: unknown): string | null {
  if (typeof value !== "string" || !/^-?[1-9][0-9]{0,15}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && Math.abs(number) <= 2 ** 52 - 1 ? value : null;
}

/** Resolve a mutable public alias once, before admission; never send content to an alias. */
export async function resolveTelegramRecipient(input: { token: string; chatId: string; fetcher: typeof fetch }): Promise<string> {
  const refused = () => new TelegramDeliveryError(503, "telegram_recipient_unconfirmed");
  if (typeof input.token !== "string" || !input.token || input.token.length > 8192) throw refused();
  const numeric = canonicalTelegramChatId(input.chatId);
  if (numeric) return numeric;
  if (typeof input.chatId !== "string" || !/^@[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(input.chatId)) throw refused();
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await input.fetcher(`https://api.telegram.org/bot${input.token}/getChat`, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: input.chatId }),
        });
        if (controller.signal.aborted || !response.ok || response.status !== 200 || response.redirected || !response.body) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* An unconfirmed body is never retained. */ }
          throw refused();
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let bytes = 0, reads = 0;
        while (true) {
          const item = await reader.read();
          if (controller.signal.aborted || ++reads > 65_537) throw refused();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 64 * 1024) throw refused();
          chunks.push(item.value);
        }
        const body = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
        const chat = object(body.result);
        const id = typeof chat.id === "number" ? canonicalTelegramChatId(String(chat.id)) : null;
        if (body.ok !== true || !id || !["channel", "supergroup"].includes(String(chat.type))
          || (chat.active_usernames !== undefined && (!Array.isArray(chat.active_usernames)
            || chat.active_usernames.some(value => typeof value !== "string")))) throw refused();
        const names = [chat.username, ...(Array.isArray(chat.active_usernames) ? chat.active_usernames : [])];
        if (!names.some(name => typeof name === "string" && `@${name}`.toLowerCase() === input.chatId.toLowerCase())) throw refused();
        return id;
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(refused()); }, 10_000); }),
    ]);
  } catch { throw refused(); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    try { void reader?.cancel().catch(() => {}); } catch { /* Never let cleanup expose provider diagnostics. */ }
  }
}

async function rpc(client: SupabaseClient, name: string, args: Row): Promise<Row> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Never retry admission or a part start after an ambiguous commit. In
    // particular a lost ACK must not mint another dispatcher or resend a part.
    const { data, error } = await Promise.race([Promise.resolve(client.rpc(name, args)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(unavailable()), 20_000);
    })]);
    if (error) {
      const code = object(error).code;
      if (code === "P9701") throw invalid();
      if (code === "P9702") throw new TelegramDeliveryError(409, "telegram_delivery_conflict");
      if (code === "P9703") throw new TelegramDeliveryError(409, "telegram_delivery_quarantined");
      if (code === "P9704" || code === "42501") throw new TelegramDeliveryError(403, "telegram_delivery_access_denied");
      if (code === "P9705") throw new TelegramDeliveryError(429, "telegram_delivery_capacity");
      throw unavailable();
    }
    return object(data);
  } catch (error) {
    if (error instanceof TelegramDeliveryError) throw error;
    throw unavailable();
  } finally { if (timer) clearTimeout(timer); }
}

function actorArgs(actor: Actor): Row {
  if (![actor.workspaceId, actor.staffUserId, actor.userId].every(value => typeof value === "string" && UUID.test(value))) {
    throw new TelegramDeliveryError(403, "telegram_delivery_access_denied");
  }
  return { p_workspace_id: actor.workspaceId, p_staff_user_id: actor.staffUserId, p_auth_user_id: actor.userId };
}

/** Only hashes of configured credentials/recipient enter the durable ledger. */
export async function admitTelegramDelivery(input: {
  actor: Actor; payload: Row; isTest: boolean; packageText: string; parts: string[]; token: string; chatId: string;
}, client = getSupabaseServerClient()): Promise<TelegramDelivery> {
  const args = actorArgs(input.actor);
  if (!client) throw unavailable();
  const payload = input.payload;
  const videoId = input.isTest ? payload.testRequestId : payload.id ?? payload.videoId;
  const version = input.isTest ? TEST_NAMESPACE_VERSION : readContentVideoVersion(payload.updatedAt ?? payload.expectedUpdatedAt);
  if (typeof videoId !== "string" || !UUID.test(videoId) || !version
    || (input.isTest && !UUID4.test(videoId))
    || (!input.isTest && ((payload.id !== undefined && payload.videoId !== undefined && payload.id !== payload.videoId)
      || (payload.updatedAt !== undefined && payload.expectedUpdatedAt !== undefined && payload.updatedAt !== payload.expectedUpdatedAt)))
    || typeof input.token !== "string" || !input.token || input.token.length > 8192
    || canonicalTelegramChatId(input.chatId) !== input.chatId || !input.packageText || Buffer.byteLength(input.packageText) > 240000
    || !Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 64
    || input.parts.some(part => typeof part !== "string" || !part || part.length > 4096)) throw invalid();
  const snapshot: Row = {};
  if (!input.isTest) {
    for (const field of TEXT_FIELDS) {
      if (payload[field] != null && typeof payload[field] !== "string") throw invalid();
      snapshot[field] = payload[field] ?? "";
    }
    if (payload.hashtags != null && (!Array.isArray(payload.hashtags) || payload.hashtags.some(tag => typeof tag !== "string"))) throw invalid();
    snapshot.hashtags = payload.hashtags ?? [];
  }
  const dispatchId = randomUUID(), contentHash = telegramDeliveryHash(input.packageText);
  const partHashes = input.parts.map(telegramDeliveryHash);
  const recipientHash = telegramDeliveryHash(JSON.stringify(["telegram-recipient-v1", input.token, input.chatId]));
  const result = await rpc(client, "admit_content_telegram_delivery", {
    ...args, p_video_id: videoId, p_package_version: version, p_kind: input.isTest ? "test" : "package",
    p_dispatch_id: dispatchId, p_recipient_sha256: recipientHash,
    p_manifest: { snapshot, text: input.packageText, parts: input.parts },
  });
  if (result.contentSha256 !== contentHash || result.recipientSha256 !== recipientHash
    || !Array.isArray(result.partSha256) || JSON.stringify(result.partSha256) !== JSON.stringify(partHashes)
    || !["admitted", "succeeded"].includes(String(result.state))
    || (result.state === "admitted" && result.dispatchId !== dispatchId)) throw unavailable();
  return { actor: input.actor, videoId, version, kind: input.isTest ? "test" : "package", dispatchId,
    contentHash, partHashes, recipientHash, replayed: result.state === "succeeded", client };
}

async function advance(delivery: TelegramDelivery, index: number, acknowledgement: string | null): Promise<void> {
  if (delivery.replayed || !Number.isSafeInteger(index) || index < 0 || index >= delivery.partHashes.length
    || (acknowledgement !== null && !HASH.test(acknowledgement))) throw invalid();
  const result = await rpc(delivery.client, "advance_content_telegram_delivery", {
    ...actorArgs(delivery.actor), p_video_id: delivery.videoId, p_package_version: delivery.version, p_kind: delivery.kind,
    p_dispatch_id: delivery.dispatchId, p_part_index: index, p_part_sha256: delivery.partHashes[index],
    p_acknowledgement_sha256: acknowledgement,
  });
  if (result.part !== index || result.state !== (acknowledgement === null ? "dispatching"
    : index === delivery.partHashes.length - 1 ? "succeeded" : "acknowledged")) throw unavailable();
}
export const beginTelegramDeliveryPart = (delivery: TelegramDelivery, index: number): Promise<void> => advance(delivery, index, null);
export const acknowledgeTelegramDeliveryPart = (delivery: TelegramDelivery, index: number, acknowledgement: string): Promise<void> =>
  advance(delivery, index, acknowledgement);
