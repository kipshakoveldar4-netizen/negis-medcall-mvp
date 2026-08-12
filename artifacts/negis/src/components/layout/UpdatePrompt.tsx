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
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // На http без localhost работник не регистрируется вовсе — это ограничение
    // браузера, а не наше.
    if (!window.isSecureContext) return;

    let cancelled = false;
    let registered: ServiceWorkerRegistration | null = null;

    // Проверка при возвращении к вкладке: приложение, открытое сутками, иначе
    // не узнает о новой версии до перезапуска. Слушатель вешается здесь, а не
    // внутри асинхронного блока: возврат функции оттуда ничего не отписывает —
    // React ждёт её от самого эффекта.
    const recheck = () => {
      if (document.visibilityState === "visible") void registered?.update();
    };
    document.addEventListener("visibilitychange", recheck);

    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js");
        if (cancelled) return;
        registered = registration;

        // Версия могла приехать, пока вкладка была закрыта.
        if (registration.waiting) setWaiting(registration.waiting);

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // «installed» при уже работающем контроллере означает: новая
            // версия готова и ждёт разрешения занять место старой.
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              setWaiting(installing);
            }
          });
        });
      } catch {
        // Не зарегистрировался — приложение продолжает работать как обычный
        // сайт. Это ухудшение, а не поломка, и пугать им оператора незачем.
      }
    })();

    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", recheck);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!waiting) return null;

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 sm:left-auto sm:right-4 sm:w-96">
      <div className="neu-card flex items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black text-[#0F172A]">Вышла новая версия</p>
          <p className="text-xs font-semibold text-[#64748B]">
            Обновление уже скачано. Применить сейчас — страница перезагрузится.
          </p>
        </div>
        <button type="button" className="neu-btn-primary shrink-0 text-sm" onClick={() => waiting.postMessage("skip-waiting")}>
          Обновить
        </button>
      </div>
    </div>
  );
}
