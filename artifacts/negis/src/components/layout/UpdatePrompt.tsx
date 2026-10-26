import { useEffect, useState } from "react";

// «Вышла новая версия» — и кнопка, которая её применяет.
//
// Без этой плашки обновление работает, но с задержкой: браузер скачивает новую
// сборку в фоне и показывает её при СЛЕДУЮЩЕМ открытии приложения. Для CRM,
// которую держат открытой весь день, «следующее открытие» — это завтра.
//
// Перезагружать молча нельзя: регистратор может стоять посреди заполнения
// карточки, и несохранённое исчезнет. Поэтому решение остаётся за человеком, а
// приложение только сообщает.
//
// Отдельная причина, по которой это вообще важно: старая сборка против нового
// сервера — это отказы без объяснения. Кнопка не работает, ошибка непонятная,
// и никто не связывает одно с другим.

export function UpdatePrompt() {
  const [prompt, setPrompt] = useState<{ reloadOnly: boolean; apply: () => void } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // На http без localhost работник не регистрируется вовсе — это ограничение
    // браузера, а не наше.
    if (!window.isSecureContext) return;

    let cancelled = false;
    let registered: ServiceWorkerRegistration | null = null;
    const serviceWorker = navigator.serviceWorker;
    let controller = serviceWorker.controller;
    let waiting: ServiceWorker | null = null;
    let requested: ServiceWorker | null = null;
    let reloadOnly = false;
    let reloading = false;
    let reloadRecovery: number | undefined;
    let installing: ServiceWorker | null = null;
    let onInstallingStateChange: (() => void) | null = null;

    setPrompt(null);
    setUpdating(false);
    setFailed(false);

    const reload = () => {
      if (cancelled || reloading) return;
      reloading = true;
      requested = null;
      setUpdating(true);
      window.location.reload();
      // A beforeunload warning can cancel navigation. If this document is
      // still alive, offer a new explicit reload instead of a permanent lock.
      reloadRecovery = window.setTimeout(() => {
        if (cancelled) return;
        reloading = false;
        reloadOnly = true;
        waiting = null;
        setUpdating(false);
        setPrompt({ reloadOnly: true, apply: reload });
      }, 1000);
    };

    const offerWaiting = (worker: ServiceWorker) => {
      if (cancelled || reloading || reloadOnly || requested || worker.state !== "installed"
        || registered?.waiting !== worker || !serviceWorker.controller || serviceWorker.controller === worker) return;
      waiting = worker;
      setFailed(false);
      setPrompt({ reloadOnly: false, apply: () => {
        if (cancelled || reloading || reloadOnly || requested || waiting !== worker) return;
        // Контроллер мог смениться до доставки controllerchange этой вкладке.
        if (serviceWorker.controller === worker) { reload(); return; }
        if (registered?.waiting !== worker || worker.state !== "installed") return;
        requested = worker;
        setUpdating(true);
        setFailed(false);
        try {
          worker.postMessage("skip-waiting");
        } catch {
          requested = null;
          if (cancelled || reloading) return;
          setUpdating(false);
          setFailed(true);
        }
      } });
    };

    const stopWatchingInstalling = () => {
      if (installing && onInstallingStateChange) {
        installing.removeEventListener("statechange", onInstallingStateChange);
      }
      installing = null;
      onInstallingStateChange = null;
    };
    const onUpdateFound = () => {
      if (cancelled || !registered) return;
      const worker = registered.installing;
      if (worker === installing) return;
      stopWatchingInstalling();
      if (!worker) return;
      installing = worker;
      onInstallingStateChange = () => {
        if (cancelled || installing !== worker) return;
        if (worker.state === "installed") {
          offerWaiting(worker);
          stopWatchingInstalling();
        } else if (worker.state === "redundant") {
          stopWatchingInstalling();
        }
      };
      worker.addEventListener("statechange", onInstallingStateChange);
      onInstallingStateChange();
    };

    // Проверка при возвращении к вкладке: приложение, открытое сутками, иначе
    // не узнает о новой версии до перезапуска. Слушатель вешается здесь, а не
    // внутри асинхронного блока: возврат функции оттуда ничего не отписывает —
    // React ждёт её от самого эффекта.
    const recheck = async () => {
      if (cancelled || document.visibilityState !== "visible" || !registered) return;
      try {
        await registered.update();
      } catch {
        // Проверка в фоне может не пройти без сети; повторим при возвращении.
      }
    };
    document.addEventListener("visibilitychange", recheck);

    void (async () => {
      try {
        const registration = await serviceWorker.register("/sw.js");
        if (cancelled) return;
        registered = registration;

        // Версия могла приехать, пока вкладка была закрыта.
        if (registration.waiting) offerWaiting(registration.waiting);
        registration.addEventListener("updatefound", onUpdateFound);
        // Установка могла начаться ещё до завершения register().
        onUpdateFound();
      } catch {
        // Не зарегистрировался — приложение продолжает работать как обычный
        // сайт. Это ухудшение, а не поломка, и пугать им оператора незачем.
      }
    })();

    const onControllerChange = () => {
      if (cancelled || reloading) return;
      const previous = controller;
      controller = serviceWorker.controller;
      if (!controller || controller === previous) return;
      if (requested === controller) { reload(); return; }
      requested = null;
      waiting = null;
      setUpdating(false);
      setFailed(false);
      // Первое получение контроллера не требует обновления страницы.
      if (!previous) { setPrompt(null); return; }
      reloadOnly = true;
      // Другая вкладка уже применила версию: skip-waiting больше не нужен.
      setPrompt({ reloadOnly: true, apply: reload });
    };
    serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      requested = null;
      if (reloadRecovery !== undefined) window.clearTimeout(reloadRecovery);
      stopWatchingInstalling();
      registered?.removeEventListener("updatefound", onUpdateFound);
      document.removeEventListener("visibilitychange", recheck);
      serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!prompt) return null;

  return (
    <div className="fixed inset-x-3 bottom-[calc(92px+env(safe-area-inset-bottom))] z-40 sm:left-auto sm:right-4 sm:w-96 lg:bottom-3">
      <div className="neu-card flex flex-col items-stretch gap-3 p-4 sm:flex-row sm:items-center" role="status">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black text-[#0F172A]">Вышла новая версия</p>
          <p className="text-xs font-semibold text-[#64748B]">
            {failed ? "Не удалось применить обновление. Попробуйте ещё раз."
              : prompt.reloadOnly ? "Новая версия уже запущена. Перезагрузите страницу, когда сохраните изменения."
                : "Обновление скачано. Сохраните изменения: страница перезагрузится."}
          </p>
        </div>
        <button type="button" className="neu-btn-primary w-full shrink-0 whitespace-nowrap text-sm sm:w-auto"
          disabled={updating} aria-busy={updating} onClick={prompt.apply}>
          {updating ? "Обновляем..." : prompt.reloadOnly ? "Перезагрузить" : "Обновить"}
        </button>
      </div>
    </div>
  );
}
