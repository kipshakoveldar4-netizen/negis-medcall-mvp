// Подписка этого устройства на уведомления.
//
// Главное здесь — не «включить», а честно назвать состояние. Пуш не работает в
// доброй половине обычных случаев, и каждый из них выглядит одинаково: тишина.
// Сотрудник, который думает, что уведомления включены, пропускает запись и
// винит в этом приложение — а разрешение он не давал вовсе, или открыл сайт в
// браузере айфона вместо установленного приложения.

export type PushSupport =
  | "ok"
  | "insecure"
  | "no-serviceworker"
  | "no-push"
  | "ios-needs-install"
  | "denied";

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS притворяется Mac'ом: отличаем по касаниям.
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function describePushSupport(): PushSupport {
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator)) return "no-serviceworker";
  // На iOS пуш есть только у приложения, добавленного на домашний экран. В
  // вкладке Safari PushManager отсутствует вовсе — но сказать об этом надо
  // человеческими словами, а не «не поддерживается».
  if (!("PushManager" in window)) return isIos() && !isStandalone() ? "ios-needs-install" : "no-push";
  if (isIos() && !isStandalone()) return "ios-needs-install";
  if (typeof Notification !== "undefined" && Notification.permission === "denied") return "denied";
  return "ok";
}

/** Человеческое объяснение состояния — без жаргона и без ложной надежды. */
export function explainPushSupport(support: PushSupport): string {
  switch (support) {
    case "ios-needs-install":
      return "На айфоне уведомления работают только у приложения, добавленного на экран «Домой». Откройте меню «Поделиться» → «На экран Домой», зайдите с этого значка и включите уведомления там.";
    case "denied":
      return "Уведомления запрещены в настройках браузера. Разрешите их для этого сайта — до этого включить их отсюда нельзя.";
    case "insecure":
      return "Уведомления работают только на защищённом соединении.";
    case "no-serviceworker":
    case "no-push":
      return "Этот браузер не умеет уведомления. Попробуйте Chrome на Android или установите приложение на экран «Домой».";
    default:
      return "";
  }
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

/** «Android · Chrome» — чтобы человек узнал своё устройство в списке. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const platform = isIos() ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Устройство";
  const browser = /EdgA?\//.test(ua)
    ? "Edge"
    : /YaBrowser/.test(ua)
      ? "Яндекс"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "браузер";
  return `${platform} · ${browser}`;
}

export interface DeviceSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
}

function readKey(subscription: PushSubscription, name: "p256dh" | "auth"): string {
  const key = subscription.getKey(name);
  if (!key) return "";
  let binary = "";
  new Uint8Array(key).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function readThisDeviceSubscription(): Promise<DeviceSubscription | null> {
  if (describePushSupport() !== "ok") return null;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (!existing) return null;
  return {
    endpoint: existing.endpoint,
    p256dh: readKey(existing, "p256dh"),
    auth: readKey(existing, "auth"),
    label: deviceLabel(),
  };
}

export async function subscribeThisDevice(publicKey: string): Promise<DeviceSubscription> {
  if (!publicKey) throw new Error("Уведомления ещё не настроены в системе");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Без разрешения уведомления приходить не будут");

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Без этого флага браузер отказывает: тихие уведомления запрещены.
      userVisibleOnly: true,
      applicationServerKey: base64UrlToArrayBuffer(publicKey),
    }));

  return {
    endpoint: subscription.endpoint,
    p256dh: readKey(subscription, "p256dh"),
    auth: readKey(subscription, "auth"),
    label: deviceLabel(),
  };
}

export async function unsubscribeThisDevice(): Promise<string> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return "";
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}
