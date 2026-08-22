// Web Push своими руками: подпись VAPID и шифрование тела по RFC 8291.
//
// Пакет web-push сюда не берётся, и это осознанный выбор. Во-первых, в
// pnpm-workspace.yaml стоит minimumReleaseAge с прямым требованием не плодить
// зависимости: цепочка поставок npm — вектор атаки номер один. Во-вторых, всё,
// что делает тот пакет, — ровно две вещи ниже, и обе целиком есть в node:crypto.
// В-третьих, в проекте уже трижды написана подпись руками: lib/auth/worker.ts,
// lib/wazzup/webhook.ts, lib/whatsapp-cloud/webhook.ts.
//
// Модуль ничего не знает ни о базе, ни о записях: на вход — подписка и текст, на
// выход — класс исхода. Это позволяет проверять его тестом целиком.

import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Исход попытки — по классам, а не «ок / не ок».
 *
 * Разница между ними решает судьбу строки в базе: «gone» — устройство мертво и
 * строку надо пометить; «retry» — push-сервис занят, и трогать строку нельзя,
 * иначе временная перегрузка чужого сервиса тихо отпишет всех мастеров.
 */
export type PushOutcome = "delivered" | "gone" | "retry" | "rejected";

export interface PushResult {
  outcome: PushOutcome;
  status: number;
}

const TTL_SECONDS = 3600;
const RECORD_SIZE = 4096;
const REQUEST_TIMEOUT_MS = 2500;

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function bufferToBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Ключи VAPID из окружения. Значения не логируются и не возвращаются наружу:
 * вызывающий получает либо готовый набор, либо null.
 */
export function readVapidKeys(env: NodeJS.ProcessEnv = process.env): VapidKeys | null {
  const publicKey = (env.NEGIS_VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (env.NEGIS_VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (env.NEGIS_VAPID_SUBJECT ?? "").trim();
  if (!publicKey || !privateKey) return null;
  // Субъект обязателен по спецификации: push-сервис хочет знать, кому писать при
  // злоупотреблении. Без него FCM отвечает отказом, поэтому подставлять «что
  // угодно» нельзя — лучше честно не отправить.
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/**
 * Заголовок Authorization для push-сервиса: JWT ES256, подписанный ключом VAPID.
 *
 * Две ловушки, каждая из которых даёт 401 без объяснений:
 * — подпись обязана быть в формате r||s (64 байта), а не DER, отсюда dsaEncoding;
 * — aud — это ORIGIN эндпойнта, а не полный URL; на полный URL FCM отвечает отказом.
 */
export function buildVapidAuthorization(endpoint: string, keys: VapidKeys, nowSeconds: number): string {
  const audience = new URL(endpoint).origin;
  const header = bufferToBase64Url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bufferToBase64Url(
    Buffer.from(JSON.stringify({ aud: audience, exp: nowSeconds + 12 * 60 * 60, sub: keys.subject })),
  );
  const signingInput = Buffer.from(`${header}.${payload}`);
  const privateKey = createPrivateKey({
    key: Buffer.from(keys.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign("sha256", signingInput, { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${payload}.${bufferToBase64Url(signature)}, k=${keys.publicKey}`;
}

/**
 * Шифрование тела по RFC 8291 (Content-Encoding: aes128gcm).
 *
 * Собственный эфемерный ключ на каждое сообщение, общий секрет с устройством
 * через ECDH, из него HKDF даёт ключ и одноразовый вектор. Формат тела задан
 * спецификацией жёстко: соль, размер записи, длина ключа, сам ключ, шифротекст.
 */
export function encryptPushPayload(payload: string, subscription: PushSubscriptionKeys): Buffer {
  const userPublicKey = base64UrlToBuffer(subscription.p256dh);
  const authSecret = base64UrlToBuffer(subscription.auth);
  if (userPublicKey.length !== 65) throw new Error("push: p256dh неверной длины");
  if (authSecret.length !== 16) throw new Error("push: auth неверной длины");

  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const serverPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(userPublicKey);

  const info = Buffer.concat([Buffer.from("WebPush: info\0"), userPublicKey, serverPublicKey]);
  const inputKeyingMaterial = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, info, 32));

  const salt = randomBytes(16);
  const contentKey = Buffer.from(
    hkdfSync("sha256", inputKeyingMaterial, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", inputKeyingMaterial, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );

  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  // 0x02 — признак последней записи. Без него устройство ждёт продолжения и
  // молча ничего не показывает.
  const plaintext = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])]);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE, 0);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublicKey.length]), serverPublicKey, ciphertext]);
}

/** Класс исхода по коду ответа push-сервиса. Вынесено отдельно ради теста. */
export function classifyPushStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status >= 500) return "retry";
  return "rejected";
}

export async function sendWebPush(
  subscription: PushSubscriptionKeys,
  payload: string,
  keys: VapidKeys,
  nowSeconds: number,
): Promise<PushResult> {
  const body = encryptPushPayload(payload, subscription);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: buildVapidAuthorization(subscription.endpoint, keys, nowSeconds),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(TTL_SECONDS),
      Urgency: "high",
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Тело ответа не читается и не логируется: там нет ничего полезного, а вот
  // эндпойнт устройства в лог попасть не должен.
  return { outcome: classifyPushStatus(response.status), status: response.status };
}
