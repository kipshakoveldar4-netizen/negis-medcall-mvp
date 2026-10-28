import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Protocol/CAS controller-unit double only. The real adapter still validates
// the actor, intent, version and returned hashes. This does not model SQL
// authorization or concurrency: 097's embedded/native suites own that proof.
type Row = Record<string, any>;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const delivery = await import(pathToFileURL(path.join(root, "lib/crm/telegram-delivery.ts")).href) as {
  TelegramDeliveryError: new (status: number, code: string) => Error;
  telegramDeliveryHash(value: string): string;
  resolveTelegramRecipient(input: Row): Promise<string>;
  admitTelegramDelivery(input: Row, client: Row): Promise<Row>;
  beginTelegramDeliveryPart(value: Row, part: number): Promise<void>;
  acknowledgeTelegramDeliveryPart(value: Row, part: number, hash: string): Promise<void>;
};
export const controllerActor = {
  staffUserId: "22222222-2222-4222-8222-222222222222",
  userId: "44444444-4444-4444-8444-444444444444",
};
export function telegramControllerRpcFixture() {
  const parts = new Map<string, number>();
  const client = { async rpc(name: string, args: Row) {
    if (name === "admit_content_telegram_delivery") {
      parts.set(args.p_dispatch_id, args.p_manifest.parts.length);
      return { data: { state: "admitted", dispatchId: args.p_dispatch_id,
        contentSha256: delivery.telegramDeliveryHash(args.p_manifest.text),
        recipientSha256: args.p_recipient_sha256,
        partSha256: args.p_manifest.parts.map(delivery.telegramDeliveryHash) }, error: null };
    }
    assert.equal(name, "advance_content_telegram_delivery");
    assert.ok(parts.has(args.p_dispatch_id), "The unit protocol must pass its admitted dispatcher");
    return { data: { part: args.p_part_index, state: args.p_acknowledgement_sha256 === null ? "dispatching"
      : args.p_part_index === parts.get(args.p_dispatch_id)! - 1 ? "succeeded" : "acknowledged" }, error: null };
  } };
  return {
    ...delivery,
    admitTelegramDelivery: (input: Row) => delivery.admitTelegramDelivery(input, client),
  };
}
