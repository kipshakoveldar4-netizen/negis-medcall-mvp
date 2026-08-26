import assert from "node:assert/strict";
import { createECDH, generateKeyPairSync, verify } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Модули из lib/ грузятся по адресу, как в соседних наборах: у пакета scripts
// нет пути внутрь lib, и статический импорт туда не разрешается.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = async (file: string) => import(pathToFileURL(path.join(repoRoot, "lib", "crm", file)).href);

type Keys = { publicKey: string; privateKey: string; subject: string };
type Device = { endpoint: string; p256dh: string; auth: string };
type Snapshot = { doctorId: string; doctorName: string; client: string; service: string; startsAt: string };

const push = (await load("web-push.ts")) as {
  buildVapidAuthorization: (endpoint: string, keys: Keys, nowSeconds: number) => string;
  classifyPushStatus: (status: number) => string;
  encryptPushPayload: (payload: string, subscription: Device) => Buffer;
  readVapidKeys: (env: NodeJS.ProcessEnv) => Keys | null;
};
const rules = (await load("staff-notifications.ts")) as {
  notificationFor: (input: {
    event: "created" | "cancelled";
    appointment: Snapshot;
    timeZone: string;
    clientNameVisible?: boolean;
  }) => { title: string; text: string; url: string; tag: string } | null;
  resolveRecipient: (input: {
    appointment: Snapshot;
    doctors: readonly { id: string; fullName: string; staffUserId: string }[];
    actorStaffUserId: string;
    nowMs: number;
  }) => { staffUserId: string } | { skipped: string };
};

const { buildVapidAuthorization, classifyPushStatus, encryptPushPayload, readVapidKeys } = push;
const { notificationFor, resolveRecipient } = rules;

// Пуш сотрудникам: криптография и правило адресации.
//
// Проверять это наблюдением нельзя. Уведомление, которое не дошло, ничем не
// отличается от уведомления, которое не отправляли, а сообщение с неверной
// подписью push-сервис отклоняет молча — 401 без тела. Поэтому обе половины
// написаны так, чтобы их можно было предъявить тесту целиком.

function makeVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-65);
  return {
    keys: {
      publicKey: raw.toString("base64url"),
      privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      subject: "mailto:owner@example.kz",
    },
    publicKeyObject: publicKey,
  };
}

function makeDeviceKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/abcdefghijklmnop",
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: Buffer.alloc(16, 7).toString("base64url"),
  };
}

test("PN1 подпись VAPID проверяется ключом и не в формате DER", () => {
  const { keys, publicKeyObject } = makeVapidKeys();
  const header = buildVapidAuthorization("https://fcm.googleapis.com/fcm/send/xyz", keys, 1_700_000_000);

  const token = header.slice("vapid t=".length, header.indexOf(", k="));
  const [encodedHeader, encodedBody, encodedSignature] = token.split(".");
  const signature = Buffer.from(encodedSignature, "base64url");

  // 64 байта — это r||s. DER длиннее и переменной длины: именно на этом
  // push-сервисы отвечают 401, не объясняя причины.
  assert.equal(signature.length, 64, "подпись обязана быть r||s, а не DER");
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedBody}`),
      { key: publicKeyObject, dsaEncoding: "ieee-p1363" },
      signature,
    ),
    "подпись не проверяется собственным публичным ключом",
  );

  const body = JSON.parse(Buffer.from(encodedBody, "base64url").toString("utf8"));
  // aud — ОРИГИН, а не полный URL: на полный URL FCM отвечает отказом.
  assert.equal(body.aud, "https://fcm.googleapis.com");
  assert.equal(body.sub, "mailto:owner@example.kz");
  assert.equal(body.exp, 1_700_000_000 + 12 * 60 * 60);
  assert.equal(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")).alg, "ES256");
  assert.ok(header.includes(`, k=${keys.publicKey}`), "публичный ключ уходит в заголовке");
});

test("PN2 тело зашифровано по формату aes128gcm и соль не повторяется", () => {
  const device = makeDeviceKeys();
  const first = encryptPushPayload(JSON.stringify({ title: "Новая запись" }), device);
  const second = encryptPushPayload(JSON.stringify({ title: "Новая запись" }), device);

  // salt(16) + rs(4) + idlen(1) + ключ(65) + шифротекст с тегом(≥17)
  assert.ok(first.length > 16 + 4 + 1 + 65 + 17, "тело короче обязательного заголовка");
  assert.equal(first.readUInt32BE(16), 4096, "размер записи");
  assert.equal(first[20], 65, "длина публичного ключа отправителя");
  assert.equal(first[21], 4, "несжатая точка P-256 начинается с 0x04");
  assert.notEqual(
    first.subarray(0, 16).toString("hex"),
    second.subarray(0, 16).toString("hex"),
    "соль обязана быть разной",
  );
  assert.notEqual(
    first.subarray(21, 86).toString("hex"),
    second.subarray(21, 86).toString("hex"),
    "эфемерный ключ обязан быть разным: повтор раскрывает переписку",
  );
});

test("PN3 чужие ключи не принимаются молча", () => {
  const device = makeDeviceKeys();
  assert.throws(() => encryptPushPayload("{}", { ...device, p256dh: "AAAA" }), /p256dh/);
  assert.throws(() => encryptPushPayload("{}", { ...device, auth: "AAAA" }), /auth/);
});

test("PN4 класс исхода решает судьбу строки в базе", () => {
  assert.equal(classifyPushStatus(201), "delivered");
  assert.equal(classifyPushStatus(200), "delivered");
  assert.equal(classifyPushStatus(404), "gone");
  assert.equal(classifyPushStatus(410), "gone");
  // Перегрузка чужого сервиса не должна отписывать мастеров.
  assert.equal(classifyPushStatus(429), "retry");
  assert.equal(classifyPushStatus(503), "retry");
  assert.equal(classifyPushStatus(401), "rejected");
  assert.equal(classifyPushStatus(403), "rejected");
});

test("PN5 без субъекта VAPID отправка не собирается вовсе", () => {
  const base = { NEGIS_VAPID_PUBLIC_KEY: "pub", NEGIS_VAPID_PRIVATE_KEY: "priv" } as NodeJS.ProcessEnv;
  assert.equal(readVapidKeys({ ...base }), null, "субъекта нет — ключей нет");
  assert.equal(readVapidKeys({ ...base, NEGIS_VAPID_SUBJECT: "owner@example.kz" }), null, "без схемы не годится");
  assert.ok(readVapidKeys({ ...base, NEGIS_VAPID_SUBJECT: "mailto:owner@example.kz" }));
  assert.equal(readVapidKeys({ NEGIS_VAPID_SUBJECT: "mailto:a@b.kz" }), null, "без ключей отправки нет");
});

const DOCTORS = [
  { id: "d1", fullName: "Дильназ", staffUserId: "u1" },
  { id: "d2", fullName: "Дильназ", staffUserId: "u2" },
  { id: "d3", fullName: "Сабина Жумалина", staffUserId: "u3" },
  { id: "d4", fullName: "Аружан", staffUserId: "" },
];
const NOW = Date.parse("2026-08-22T09:00:00.000Z");
const FUTURE = "2026-08-23T05:00:00.000Z";

function decide(
  appointment: Partial<Snapshot>,
  actor = "admin",
) {
  return resolveRecipient({
    appointment: { doctorId: "", doctorName: "", client: "Гость", service: "Маникюр", startsAt: FUTURE, ...appointment },
    doctors: DOCTORS,
    actorStaffUserId: actor,
    nowMs: NOW,
  });
}

test("PN6 адресат берётся по карточке мастера", () => {
  assert.deepEqual(decide({ doctorId: "d3" }), { staffUserId: "u3" });
});

test("PN7 две Дильназ — не отправляем никому", () => {
  // Уведомление о клиенте одной, ушедшее другой, — это утечка, а не неудобство.
  assert.deepEqual(decide({ doctorName: "Дильназ" }), { skipped: "имя неоднозначно" });
  assert.deepEqual(decide({ doctorName: " сабина жумалина " }), { staffUserId: "u3" });
});

test("PN8 мастер без входа виден причиной, а не тишиной", () => {
  assert.deepEqual(decide({ doctorId: "d4" }), { skipped: "мастер не связан с учётной записью" });
  assert.deepEqual(decide({ doctorName: "Аружан" }), { skipped: "мастер не связан с учётной записью" });
});

test("PN9 себе не пишем и о прошлом не пишем", () => {
  assert.deepEqual(decide({ doctorId: "d3" }, "u3"), { skipped: "сам себе" });
  assert.deepEqual(decide({ doctorId: "d3", startsAt: "2026-08-22T08:00:00.000Z" }), { skipped: "визит уже прошёл" });
  assert.deepEqual(decide({ doctorId: "d3", startsAt: "не дата" }), { skipped: "время визита не разобрано" });
});

test("PN10 пустой мастер и неизвестная карточка названы своими причинами", () => {
  assert.deepEqual(decide({}), { skipped: "мастер не указан" });
  assert.deepEqual(decide({ doctorId: "нет такой" }), { skipped: "карточка мастера не найдена" });
  assert.deepEqual(decide({ doctorName: "Кто-то" }), { skipped: "мастер не найден по имени" });
});

test("PN11 в тексте нет телефона — даже если его вписали в услугу", () => {
  const notification = notificationFor({
    event: "created",
    appointment: {
      doctorId: "d3",
      doctorName: "Сабина",
      client: "Айгерим",
      service: "Маникюр, перезвонить +7 777 123 45 67",
      startsAt: FUTURE,
    },
    timeZone: "Asia/Almaty",
  });
  assert.ok(notification);
  assert.ok(!/\+7\s?7\d/.test(notification.text), `номер утёк на экран блокировки: ${notification.text}`);
  assert.equal(notification.title, "Новая запись");
  assert.ok(notification.text.includes("Айгерим"));
  assert.ok(notification.url.startsWith("/appointments?date=2026-08-23"));
});

test("PN12 отмена называется отменой, а имя клиента можно выключить", () => {
  const appointment = { doctorId: "d3", doctorName: "Сабина", client: "Айгерим", service: "Педикюр", startsAt: FUTURE };
  const cancelled = notificationFor({ event: "cancelled", appointment, timeZone: "Asia/Almaty" });
  assert.equal(cancelled?.title, "Запись отменена");
  assert.notEqual(cancelled?.tag, notificationFor({ event: "created", appointment, timeZone: "Asia/Almaty" })?.tag);

  const anonymous = notificationFor({ event: "created", appointment, timeZone: "Asia/Almaty", clientNameVisible: false });
  assert.ok(!anonymous?.text.includes("Айгерим"), "имя обязано исчезать по флагу, а не переписыванием");
  assert.ok(anonymous?.text.includes("Педикюр"));
});

test("PN13 нечитаемое время не превращается в бессмысленное уведомление", () => {
  assert.equal(
    notificationFor({
      event: "created",
      appointment: { doctorId: "d3", doctorName: "", client: "Гость", service: "", startsAt: "не дата" },
      timeZone: "Asia/Almaty",
    }),
    null,
  );
});

// ── Вторая половина: подписка, крючки и экран ──────────────────────────────

import { readFile } from "node:fs/promises";

async function source(...parts: string[]): Promise<string> {
  return readFile(path.join(repoRoot, ...parts), "utf8");
}

test("PN14 подписка объявлена в реестре и не принимает удаление", async () => {
  const registry = await source("lib", "crm", "authorization.ts");
  const router = await source("api", "crm", "[...path].ts");
  assert.match(registry, /"push-subscriptions": \{ kind: "browser", methods: \["GET", "POST", "PATCH"\] \}/);
  assert.ok(!/"push-subscriptions"[\s\S]{0,80}DELETE/.test(registry), "отписка — метка времени, а не удаление строки");
  assert.ok(router.includes('case "push-subscriptions":'), "маршрут раздаётся из общего catch-all");
});

test("PN15 устройство принадлежит сотруднику, а не сессии кабинета", async () => {
  const handler = await source("lib", "crm", "push-subscriptions.ts");
  // Владелец платформы, зашедший в клинику имперсонацией, не имеет строки
  // staff_users: подписать его телефон именем сотрудника клиники нельзя.
  assert.match(handler, /!isUuid\(staffUserId\)[\s\S]{0,120}staff_session_required/);
  // Отписать можно только СВОЁ устройство: сужение и по клинике, и по человеку.
  assert.match(handler, /\.update\(\{ revoked_at[\s\S]{0,220}\.eq\("staff_user_id", staffUserId\)/);
  // Ключи устройства наружу не отдаются — это полномочие отправки, не сведения.
  assert.ok(!/select\("[^"]*p256dh[^"]*"\)[\s\S]{0,400}devices/.test(handler), "ключи не уходят в ответ списка");
  assert.match(handler, /endpointTail: readString\(record\.endpoint\)\.slice\(-12\)/);
});

test("PN16 уведомление — побочное действие: после журнала, до ответа, без влияния на запись", async () => {
  const server = await source("lib", "crm", "server.ts");
  const handler = await source("lib", "crm", "push-subscriptions.ts");

  // Создание уведомляет сохранённой строкой.
  assert.match(server, /event: "created",\s*appointment: appointmentSnapshotFrom\(data\)/);
  // Отмена — только на ПЕРЕХОДЕ статуса, иначе правка комментария у отменённой
  // записи слала бы «запись отменена» заново.
  assert.match(server, /const nowReleased = nowStatus === "cancelled" \|\| nowStatus === "no_show"/);
  assert.match(server, /wasStatus !== nowStatus && nowReleased/);
  // Адресат отмены — из ДО-состояния: патч может сменить мастера и статус разом.
  // Снимки теперь берутся один раз (beforeSnapshot/afterSnapshot) — адресат
  // отмены по-прежнему из ДО-состояния.
  assert.match(server, /const beforeSnapshot = appointmentSnapshotFrom\(before\)/);
  assert.match(server, /event: "cancelled",\s*\n\s*appointment: beforeSnapshot/);
  // Контракт «никогда не бросает»: иначе сохранённая запись ответила бы ошибкой.
  assert.match(handler, /export async function notifyAppointmentEvent[\s\S]{0,400}try \{/);
  assert.match(handler, /\} catch \{[\s\S]{0,160}push: отправка не удалась/);
});

test("PN17 service worker умеет показать уведомление и открыть нужный день", async () => {
  const worker = await source("artifacts", "negis", "public", "sw.js");
  assert.match(worker, /addEventListener\("push"/);
  assert.match(worker, /addEventListener\("notificationclick"/);
  // Сообщение без тела приходит от самого push-сервиса при проверке канала:
  // падать на нём нельзя.
  assert.match(worker, /event\.data \? event\.data\.json\(\) : \{\}/);
  // Уже открытое приложение переиспользуется, а не открывается вторым окном.
  assert.match(worker, /matchAll\(\{ type: "window"[\s\S]{0,500}focus\(\)/);
  // Обработчики оболочки не тронуты.
  for (const existing of ['addEventListener("install"', 'addEventListener("activate"', 'addEventListener("fetch"']) {
    assert.ok(worker.includes(existing), `${existing} должен остаться на месте`);
  }
});

test("PN18 экран называет каждую причину тишины своими словами", async () => {
  const lib = await source("artifacts", "negis", "src", "lib", "push.ts");
  const screen = await source("artifacts", "negis", "src", "components", "layout", "PushSettings.tsx");

  // Айфон в браузере — самый частый случай молчаливого пуша в салоне.
  assert.ok(lib.includes("экран «Домой»"), "айфону объясняем установку, а не «не поддерживается»");
  assert.match(lib, /case "denied":/);
  assert.match(lib, /if \(isIos\(\) && !isStandalone\(\)\) return "ios-needs-install"/);

  assert.ok(screen.includes("нужна миграция 044"), "невключённая миграция названа номером");
  assert.ok(screen.includes("ещё не настроены владельцем"), "отсутствие ключей названо прямо");
  // Под имперсонацией и в демо ничего не пишем.
  assert.match(screen, /const readOnly = isImpersonation \|\| isDemoMode \|\| !clinicId/);
});

test("PN19 изменения записи: перенос, смена мастера и лишние пуши", async () => {
  const server = await source("lib", "crm", "server.ts");
  const rules = await source("lib", "crm", "staff-notifications.ts");

  // «Перенесена» — отдельное событие со своим заголовком.
  assert.ok(rules.includes('"rescheduled"'), "событие переноса существует");
  assert.ok(rules.includes('"Запись перенесена"'), "и называется по-русски");

  // Смена мастера — ДВЕ новости: прежнему «отменена» (по ДО-состоянию),
  // новому «новая» (по ПОСЛЕ-состоянию). Одна общая «изменилась» оставила бы
  // прежнего мастера искать запись, которой у него больше нет.
  const patchBlock = server.slice(server.indexOf("const doctorChanged ="), server.indexOf("const doctorChanged =") + 1800);
  assert.ok(patchBlock.includes('event: "cancelled",\n          appointment: beforeSnapshot'), "прежнему — отмена");
  assert.ok(patchBlock.includes('event: "created",\n          appointment: afterSnapshot'), "новому — новая запись");
  assert.ok(patchBlock.includes('event: "rescheduled",\n          appointment: afterSnapshot'), "перенос — со свежим временем");

  // Правка заметки или цены пуш не рождает: сравниваются мастер, время и
  // статус, а не «что-нибудь изменилось».
  assert.match(server, /const timeChanged = Boolean\(beforeSnapshot\.startsAt\) && beforeSnapshot\.startsAt !== afterSnapshot\.startsAt/);
  // Смена мастера без читаемого «до» не шлёт отмену в пустоту.
  assert.match(server, /doctorChanged && Object\.keys\(before\)\.length > 0/);
});

test("PN20 подписка чинит сама себя при загрузке приложения", async () => {
  const settings = await source("artifacts", "negis", "src", "components", "layout", "PushSettings.tsx");
  const layout = await source("artifacts", "negis", "src", "components", "layout", "PageLayout.tsx");

  assert.ok(settings.includes("export function PushSync()"), "компонент существует");
  // Только чинит уже включённое: разрешений не спрашивает и не подписывает.
  assert.ok(!settings.slice(settings.indexOf("export function PushSync()"), settings.indexOf("export function PushSettings()")).includes("subscribeThisDevice"),
    "PushSync не включает уведомления сам");
  assert.match(settings, /if \(isImpersonation \|\| isDemoMode \|\| !clinicId\) return;/);
  assert.ok(layout.includes("<PushSync />"), "смонтирован в каркасе страниц");
});
