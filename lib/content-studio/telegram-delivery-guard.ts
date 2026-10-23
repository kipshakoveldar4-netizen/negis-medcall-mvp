type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Locks = { request<T>(name: string, callback: () => T | Promise<T>): Promise<T> };
export type TelegramDeliveryReceipt = { key: string; attemptId: string };

const storageError = "Не удалось сохранить защиту от повторной отправки Telegram. Пакет можно скопировать.";
const duplicateError = "Этот пакет уже отправлялся или его доставка не подтверждена. Проверьте Telegram; повторная отправка заблокирована, чтобы не создать дубли. Пакет можно скопировать.";

export async function reserveTelegramDelivery(input: {
  storage: Storage; locks?: Locks; actorId: string; workspaceId: string; videoId: string;
  packageText: string; isCurrent: () => boolean;
}): Promise<TelegramDeliveryReceipt> {
  if (!input.locks || !globalThis.crypto?.subtle || !input.packageText.trim()
    || [input.actorId, input.workspaceId, input.videoId].some(value => !value || value.length > 128)) throw Error(storageError);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.packageText));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const key = `negis_telegram_delivery_v1::${JSON.stringify([input.actorId, input.workspaceId, input.videoId, fingerprint])}`;
  return input.locks.request(key, () => {
    if (!input.isCurrent()) throw Error("Отправка отменена: аккаунт или пакет изменился.");
    let previous: string | null;
    try { previous = input.storage.getItem(key); } catch { throw Error(storageError); }
    // A damaged or ambiguous receipt must not silently permit another send.
    if (previous !== null) throw Error(duplicateError);
    const attemptId = crypto.randomUUID();
    const raw = JSON.stringify({ version: 1, attemptId, state: "uncertain" });
    try {
      input.storage.setItem(key, raw);
      if (input.storage.getItem(key) !== raw) throw Error("receipt_not_persisted");
    } catch { throw Error(storageError); }
    return { key, attemptId };
  });
}

export function confirmTelegramDelivery(storage: Storage, receipt: TelegramDeliveryReceipt): void {
  try {
    const current = JSON.parse(storage.getItem(receipt.key) || "null");
    if (current?.version !== 1 || current.attemptId !== receipt.attemptId) throw Error("receipt_changed");
    const raw = JSON.stringify({ version: 1, attemptId: receipt.attemptId, state: "sent" });
    storage.setItem(receipt.key, raw);
    if (storage.getItem(receipt.key) !== raw) throw Error("receipt_not_persisted");
  } catch { throw Error(storageError); }
}

// Release only a proven unsent demo/auth refusal, never a timeout or partial send.
export function releaseUnsentTelegramDelivery(storage: Storage, receipt: TelegramDeliveryReceipt): void {
  try {
    const current = JSON.parse(storage.getItem(receipt.key) || "null");
    if (current?.version === 1 && current.attemptId === receipt.attemptId && current.state === "uncertain") {
      storage.removeItem(receipt.key);
    }
  } catch { /* A retained receipt is safer than an unguarded retry. */ }
}
