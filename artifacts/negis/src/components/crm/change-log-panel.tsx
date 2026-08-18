import { useEffect, useState } from "react";
import { History, Loader2 } from "lucide-react";
import { crmFetch } from "@/lib/api";
import { readWorkspaceId } from "@/lib/demoStorage";
import { staffRoleLabels } from "../../../../../lib/vertical/terms";
import { useAuth } from "@/contexts/AuthContext";
import type { StaffRole } from "@/lib/permissions";

// История изменений одной записи.
//
// Один компонент на весь продукт, а не по копии на экран: этой серией правок
// шесть карточек метрики сводились в одну ровно потому, что расхождение
// начинается с копии. Заявка и клиент читают одну и ту же ленту.
//
// Что панель НЕ делает: не показывает текст заметки и не показывает телефон
// целиком — сервер их туда и не кладёт (lib/crm/change-journal.ts). Здесь
// нечего фильтровать, и это правильный порядок: данные, которых нет в ответе,
// невозможно показать по ошибке.

export type ChangeLogEntity = "lead" | "client" | "deal" | "appointment";

type ChangeEntry = { field: string; label: string; from: string | null; to: string | null };

type JournalEvent = {
  id: string;
  action: string;
  actorName: string | null;
  actorRole: string | null;
  actorKind: string | null;
  createdAt: string | null;
  changes: ChangeEntry[];
};

type LoadState = "loading" | "ready" | "failed";

/**
 * Как показать значение поля.
 *
 * Страница знает то, чего не знает журнал: что `new` — это «Новая», а uuid
 * ответственного — это Айгерим. Журнал хранит то, что было записано, и не
 * переписывает прошлое при переименовании справочника; читаемое имя
 * подставляется на экране.
 */
export type ValueResolver = (field: string, value: string | null) => string | null;

const ACTION_LABEL: Record<string, string> = {
  created: "Запись создана",
  updated: "Изменение",
  overbooked: "Время занято — записано поверх",
  booked_outside_schedule: "Вне графика врача — записано поверх",
};

const ACTOR_KIND_LABEL: Record<string, string> = {
  manual: "",
  integration: "интеграция",
  automation: "автоматика",
  system: "система",
};

function dayHeading(iso: string | null): string {
  if (!iso) return "Без даты";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "Без даты";
  const today = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(at, today)) return "Сегодня";
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (sameDay(at, yesterday)) return "Вчера";
  return at.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
}

function timeOfDay(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function actorLine(event: JournalEvent, roleTitles: Record<string, string>): string {
  const kind = ACTOR_KIND_LABEL[event.actorKind ?? "manual"] ?? "";
  if (kind) return kind;
  // Подпись роли — словом ниши: в салоне «Мастер», а не «Врач».
  const role = event.actorRole && event.actorRole in roleTitles
    ? roleTitles[event.actorRole as StaffRole]
    : event.actorRole;
  // Имя — снимок на момент события. Если его нет, роль всё равно говорит
  // больше, чем пустая строка.
  return [event.actorName, role].filter(Boolean).join(" · ") || "Сотрудник";
}

function ChangeLine({ change, resolve }: { change: ChangeEntry; resolve?: ValueResolver }) {
  const show = (value: string | null) => {
    const resolved = resolve ? resolve(change.field, value) : value;
    return resolved || "—";
  };

  // Поле уровня «факт»: сервер сознательно не прислал значений.
  if (change.from === null && change.to === null) {
    return (
      <p className="text-xs" style={{ color: "var(--negis-ink-2)" }}>
        <span className="font-semibold">{change.label}</span>
        <span style={{ color: "var(--negis-muted-2)" }}> — изменено</span>
      </p>
    );
  }

  return (
    <p className="text-xs" style={{ color: "var(--negis-ink-2)" }}>
      <span className="font-semibold">{change.label}: </span>
      <span style={{ color: "var(--negis-muted-2)" }}>{show(change.from)}</span>
      <span style={{ color: "var(--negis-faint)" }}> → </span>
      <span className="font-semibold">{show(change.to)}</span>
    </p>
  );
}

export function ChangeLogPanel({
  entityType,
  entityId,
  resolveValue,
}: {
  entityType: ChangeLogEntity;
  entityId: string;
  resolveValue?: ValueResolver;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [events, setEvents] = useState<JournalEvent[]>([]);
  const { vertical } = useAuth();
  const roleTitles = staffRoleLabels(vertical);

  useEffect(() => {
    if (!entityId) return;
    let cancelled = false;
    setState("loading");

    void (async () => {
      try {
        const workspaceId = readWorkspaceId();
        const query = `entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`
          + (workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : "");
        const response = await crmFetch(`/api/crm/change-log?${query}`);
        const body = (await response.json()) as { success?: boolean; events?: JournalEvent[] };
        if (cancelled) return;
        // Отказ базы приходит как 502 с success:false. Показать его пустой
        // лентой значило бы соврать: заявка, над которой работали трое, и
        // заявка, историю которой не удалось прочитать, выглядели бы одинаково.
        if (!response.ok || body.success !== true) {
          setState("failed");
          return;
        }
        setEvents(Array.isArray(body.events) ? body.events : []);
        setState("ready");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [entityType, entityId]);

  const groups: Array<{ heading: string; items: JournalEvent[] }> = [];
  for (const event of events) {
    const heading = dayHeading(event.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.items.push(event);
    else groups.push({ heading, items: [event] });
  }

  return (
    <section className="neu-sm p-4" aria-label="История изменений">
      <div className="mb-3 flex items-center gap-2">
        <History size={15} style={{ color: "var(--negis-primary)" }} />
        <p className="text-xs font-semibold" style={{ color: "var(--negis-ink-strong)" }}>
          История изменений
        </p>
      </div>

      {state === "loading" ? (
        <div className="flex items-center gap-2 py-2" style={{ color: "var(--negis-muted-2)" }}>
          <Loader2 className="animate-spin" size={14} />
          <span className="text-xs">Загружаем…</span>
        </div>
      ) : null}

      {state === "failed" ? (
        <p className="text-xs" style={{ color: "var(--negis-error)" }}>
          Не удалось загрузить историю. Это не значит, что её нет — попробуйте открыть карточку ещё раз.
        </p>
      ) : null}

      {state === "ready" && events.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--negis-muted-2)" }}>
          Изменений пока нет. Здесь появится, кто и когда правил запись.
        </p>
      ) : null}

      {state === "ready" && groups.length > 0 ? (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <div key={group.heading}>
              <p
                className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.09em]"
                style={{ color: "var(--negis-faint)" }}
              >
                {group.heading}
              </p>
              <ul className="flex flex-col gap-2.5">
                {group.items.map((event) => (
                  <li key={event.id} className="flex gap-3">
                    <span
                      className="shrink-0 pt-0.5 text-[11px] font-semibold tabular-nums"
                      style={{ color: "var(--negis-muted-2)" }}
                    >
                      {timeOfDay(event.createdAt)}
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold" style={{ color: "var(--negis-ink-strong)" }}>
                        {actorLine(event, roleTitles)}
                      </p>
                      {event.changes.length === 0 ? (
                        <p className="text-xs" style={{ color: "var(--negis-muted-2)" }}>
                          {ACTION_LABEL[event.action] ?? event.action}
                        </p>
                      ) : (
                        event.changes.map((change) => (
                          <ChangeLine key={`${event.id}-${change.field}`} change={change} resolve={resolveValue} />
                        ))
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
