// Печатает пару ключей VAPID для пуш-уведомлений. Запускается один раз.
//
// Ничего не пишет в репозиторий и ничего не читает из окружения: значения
// печатаются в консоль, и владелец сам кладёт их в переменные окружения Vercel.
// Приватный ключ, попавший в файл репозитория, — это возможность слать
// уведомления от имени салона любому, у кого есть доступ к коду.

import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

// Публичный ключ — последние 65 байт SPKI: несжатая точка P-256, ровно в том
// виде, в каком его ждёт браузер в applicationServerKey.
const publicRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-65);

process.stdout.write(
  [
    "Пара ключей VAPID создана. Скопируйте в переменные окружения Vercel:",
    "",
    `NEGIS_VAPID_PUBLIC_KEY=${publicRaw.toString("base64url")}`,
    `NEGIS_VAPID_PRIVATE_KEY=${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")}`,
    "NEGIS_VAPID_SUBJECT=mailto:  ← сюда почту владельца салона",
    "",
    "Публичный ключ уходит в браузер — это нормально. Приватный не показывайте",
    "никому и не кладите в репозиторий: он позволяет слать уведомления от имени",
    "салона. Смена пары отключает все уже подписанные устройства — им придётся",
    "включить уведомления заново.",
    "",
  ].join("\n"),
);
