import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Lightbulb } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { crmFetch } from "@/lib/api";
import { isRealWorkspace } from "@/lib/demoStorage";

// Рекомендации платформы Medina — карточки на главном экране клиники.
//
// Совет пишет владелец платформы из портала Medina Control; здесь он
// показывается владельцу и администратору клиники с кнопкой в нужный раздел.
// Прочтение отмечается само при первом показе, «Сделано» и «Скрыть» — руками.
//
// Компонент обязан быть НЕВИДИМЫМ во всех остальных случаях: нет права — нет
// запроса; таблица ещё не применена — сервер отвечает available:false, и
// главная выглядит ровно как раньше. Сломанная загрузка советов не имеет
// права ронять сводку: отказ уходит в консоль, а не на экран.

type Recommendation = {
  id: string;
  title: string;
  body: string;
  actionPath: string;
  status: string;
};

/**
 * Кнопка ведёт только внутрь продукта. Путь пришёл из базы платформы, но
 * проверка на месте всё равно обязана быть: внешняя ссылка в кнопке, по
 * которой владелец кликает не глядя, — фишинговый примитив.
 */
function isInternalPath(value: string): boolean {
  // Обратный слэш — тот же протокол-относительный обход, что и «//»: браузер
  // нормализует «/\evil» в ссылку наружу.
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("://") && !value.includes("\\");
}

const SECTION_LABELS: Record<string, string> = {
  "/appointments": "Открыть записи",
  "/staff-schedule": "Открыть график",
  "/services": "Открыть услуги",
  "/ads-automation": "Открыть рекламу",
  "/marketplace": "Открыть маркет",
  "/admin": "Открыть настройки",
};

export function PlatformRecommendations() {
  const { userRole } = useAuth();
  const [, setLocation] = useLocation();
  const [items, setItems] = useState<Recommendation[]>([]);
  // Пока отметка едет на сервер, обе кнопки карточки выключены: двойной клик
  // не должен отправить два PATCH и переписать «сделана» на «скрыта».
  const [busyId, setBusyId] = useState("");
  const markedRead = useRef(false);

  // Советы адресованы тем, кто может их выполнить: владельцу, админу,
  // управляющему. Остальным ролям запрос не отправляется вовсе — сервер всё
  // равно откажет, а сводка регистратора не должна дёргать лишний маршрут.
  const canSee = userRole === "owner" || userRole === "admin" || userRole === "manager";

  useEffect(() => {
    if (!canSee || !isRealWorkspace()) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await crmFetch("/api/crm/recommendations");
        const body = await response.json().catch(() => null);
        if (cancelled || !response.ok || body?.data?.available === false) return;
        const list = (Array.isArray(body?.data?.items) ? (body.data.items as Recommendation[]) : []).filter(
          (item) => item.status === "sent" || item.status === "read",
        );
        setItems(list);

        // «Прочитана» отмечается фактом показа, один раз за загрузку: платформа
        // видит не клик, а то, что совет действительно был на экране.
        if (!markedRead.current) {
          markedRead.current = true;
          for (const item of list.filter((entry) => entry.status === "sent")) {
            void crmFetch("/api/crm/recommendations", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: item.id, status: "read" }),
            }).catch(() => undefined);
          }
        }
      } catch (error) {
        console.warn("[recommendations] read failed", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canSee]);

  async function resolve(id: string, status: "done" | "dismissed") {
    if (busyId) return;
    setBusyId(id);
    // Сначала сервер, потом экран: карточка, исчезнувшая при неудавшейся
    // отметке, вернулась бы при следующем входе и выглядела бы привидением.
    try {
      const response = await crmFetch("/api/crm/recommendations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!response.ok) return;
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      console.warn("[recommendations] mark failed", error);
    } finally {
      setBusyId("");
    }
  }

  if (!canSee || items.length === 0) return null;

  return (
    <section className="mb-5 grid gap-3">
      {items.map((item) => (
        <article key={item.id} className="neu-card border-l-4 border-l-[#0D9488] p-4">
          <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.12em] text-[#0D9488]">
            <Lightbulb size={13} />
            Рекомендация платформы Medina
          </p>
          <h3 className="mt-1 text-base font-black text-[#0F172A]">{item.title}</h3>
          <p className="mt-1 text-sm font-semibold leading-relaxed text-[#475569]">{item.body}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {item.actionPath && isInternalPath(item.actionPath) ? (
              <button type="button" className="neu-btn-primary px-4 py-2 text-sm" onClick={() => setLocation(item.actionPath)}>
                {SECTION_LABELS[item.actionPath] || "Открыть раздел"}
              </button>
            ) : null}
            <button type="button" className="neu-btn px-4 py-2 text-sm" disabled={busyId === item.id} onClick={() => void resolve(item.id, "done")}>
              Сделано
            </button>
            <button type="button" className="neu-btn px-4 py-2 text-sm" disabled={busyId === item.id} onClick={() => void resolve(item.id, "dismissed")}>
              Скрыть
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
