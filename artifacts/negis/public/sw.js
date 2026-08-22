/* eslint-disable no-restricted-globals */

// Service worker Medina OS: иконка на экране, свой запуск, обновления сами.
//
// Он существует ради двух вещей. Первая — без него Android не предлагает
// установку вообще: «Установить приложение» показывается только сайтам, у
// которых есть service worker с обработчиком fetch. Вторая — обновления: новая
// сборка меняет BUILD_ID, браузер видит другой файл, ставит новую версию рядом
// и ждёт, пока страница разрешит переключиться.
//
// ГЛАВНОЕ ОГРАНИЧЕНИЕ, и оно не про производительность. Ответы /api/ этот
// работник не трогает НИКОГДА: ни читает из кэша, ни кладёт в него. Здесь
// медицинская CRM, и ответ с карточкой пациента, осевший в кэше на телефоне,
// переживёт и выход из аккаунта, и передачу телефона другому человеку. Тот же
// принцип уже действует в браузерном кэше приложения: он живёт только в памяти
// вкладки и умирает вместе с ней.
//
// Кэшируется исключительно оболочка: собранные файлы с хэшем в имени и
// стартовая страница. Файл с хэшем неизменяем по построению — его содержимое
// не может измениться без смены имени, поэтому его безопасно отдавать из кэша
// сразу и не спрашивать сеть.

const BUILD_ID = "__BUILD_ID__";
const SHELL_CACHE = `medina-shell-${BUILD_ID}`;

/** Пути, которые работник не обслуживает ни при каких условиях. */
function isNeverCached(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/") ||
    url.searchParams.has("no-sw")
  );
}

/** Файл сборки с хэшем в имени: содержимое неизменяемо. */
function isImmutableAsset(url) {
  return /\/assets\/.+\.[0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|jpg|svg)$/.test(url.pathname);
}

self.addEventListener("install", (event) => {
  // Стартовая страница кладётся заранее: без неё офлайн-запуск покажет ошибку
  // браузера вместо приложения.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(["/", "/manifest.webmanifest"]))
      .catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Кэши прошлых сборок удаляются: они больше никому не нужны, а место на
      // телефоне занимают.
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith("medina-shell-") && name !== SHELL_CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// Страница просит переключиться на уже скачанную версию — по нажатию человека,
// а не молча посреди работы: молчаливая перезагрузка посреди заполнения формы
// стирает несохранённое.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
  if (event.data === "build-id") event.source?.postMessage({ type: "build-id", buildId: BUILD_ID });
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url)) return;

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  if (request.mode === "navigate") {
    // Сеть первой: приложение обязано показывать свежее, а кэш здесь только на
    // случай, когда сети нет вовсе.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached || Response.error())),
    );
  }
});

// ── Пуш-уведомления сотрудникам ────────────────────────────────────────────
//
// Два обработчика, без которых подписка бессмысленна: браузер доставит
// сообщение, но показывать его некому.

self.addEventListener("push", (event) => {
  // Тело всегда наше и всегда JSON, но проверяем: сообщение без тела приходит
  // от самого push-сервиса при проверке канала, и падать на нём нельзя.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    payload = {};
  }

  const title = payload.title || "Медина";
  const options = {
    body: payload.text || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // tag склеивает повторы об одном событии: два уведомления об одной отмене
    // не нужны.
    tag: payload.tag || "negis",
    data: { url: payload.url || "/appointments" },
    // Вибрация короткая: мастер работает руками, телефон часто в кармане.
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/appointments";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      // Уже открытое приложение переиспользуем: второе окно поверх первого —
      // это два разных состояния одного календаря.
      for (const client of windows) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
