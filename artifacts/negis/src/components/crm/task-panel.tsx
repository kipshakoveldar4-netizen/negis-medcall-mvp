import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ListTodo, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { crmFetch } from "@/lib/api";
import { readWorkspaceId } from "@/lib/demoStorage";

// Задачи по одной записи.
//
// Один компонент на весь продукт, как и панель истории: заявка и клиент
// задают один и тот же вопрос — «что дальше делать по этому», — и расхождение
// начинается с копии. Список сужает сервер (?leadId= / ?clientId=), а не
// браузер: отдать все задачи клиники и отфильтровать здесь — это тот самый
// механизм, которым список превращается в свалку ровно тогда, когда PostgREST
// молча обрежет выдачу.
//
// Чего панель НЕ делает: не показывает чужие задачи, не даёт менять срок и
// исполнителя после создания, не заводит подзадач и напоминаний. Первая
// версия отвечает на один вопрос и закрывает задачу в один клик; остальное
// живёт на экране задач.

export type TaskEntity = "lead" | "client";

type Task = {
  id: string;
  title: string;
  owner: string;
  deadline: string;
  priority: string;
  status: string;
  assigneeUserId?: string;
};

type StaffOption = { id: string; name: string };

type LoadState = "loading" | "ready" | "failed";

const OPEN_STATUSES = new Set(["new", "in_progress"]);

/** Русские написания, которые могли попасть в базу до канонизации (миграция 031). */
const STATUS_ALIASES: Record<string, string> = {
  "новые": "new",
  "новая": "new",
  "в работе": "in_progress",
  "готово": "done",
  "выполнено": "done",
};

function statusKey(raw: string): string {
  const value = (raw || "").trim().toLowerCase();
  if (value === "new" || value === "in_progress" || value === "done") return value;
  return STATUS_ALIASES[value] ?? "new";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function taskFromRecord(raw: unknown): Task {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: str(record.id),
    title: str(record.title),
    owner: str(record.owner) || str(record.assignee_name),
    deadline: str(record.deadline) || str(record.due_at),
    priority: str(record.priority),
    status: str(record.status),
    assigneeUserId: str(record.assigneeUserId) || str(record.assignee_user_id) || undefined,
  };
}

function staffFromRecord(raw: unknown): StaffOption | null {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = str(record.id);
  if (!id) return null;
  const name = str(record.name) || str(record.full_name) || str(record.fullName) || str(record.email) || "Сотрудник";
  return { id, name };
}

/** Срок хранится как момент времени; «Сегодня» — это формат показа, а не значение. */
function formatDue(value: string): string {
  const raw = (value || "").trim();
  if (!raw) return "";
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return raw;
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `сегодня ${time}`;
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function isOverdue(value: string): boolean {
  const at = Date.parse((value || "").trim());
  return Number.isFinite(at) && at < Date.now();
}

/** `datetime-local` даёт время без зоны; в базу уходит момент. */
function toIso(local: string): string {
  if (!local) return "";
  const at = Date.parse(local);
  return Number.isFinite(at) ? new Date(at).toISOString() : "";
}

export function TaskPanel({
  entityType,
  entityId,
  clientId,
  canManage,
}: {
  entityType: TaskEntity;
  entityId: string;
  /** Заявка почти всегда «про пациента»: связь ставится обеими, когда она известна. */
  clientId?: string;
  canManage: boolean;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [saving, setSaving] = useState(false);

  const filterParam = entityType === "lead" ? "leadId" : "clientId";

  const load = useCallback(async () => {
    if (!entityId) return;
    setState("loading");
    try {
      const workspaceId = readWorkspaceId();
      const query = `${filterParam}=${encodeURIComponent(entityId)}`
        + (workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : "");
      const response = await crmFetch(`/api/crm/tasks?${query}`);
      const body = (await response.json()) as { success?: boolean; mode?: string; data?: { tasks?: unknown[] } };
      // Отказ базы приходит как 502. Показать его пустым списком значило бы
      // соврать: запись без задач и запись, задачи которой не удалось
      // прочитать, выглядели бы одинаково.
      if (!response.ok || body.success !== true) {
        setState("failed");
        return;
      }
      setTasks((Array.isArray(body.data?.tasks) ? body.data.tasks : []).map(taskFromRecord));
      setState("ready");
    } catch {
      setState("failed");
    }
  }, [entityId, filterParam]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    void (async () => {
      try {
        const workspaceId = readWorkspaceId();
        const response = await crmFetch(`/api/crm/staff?workspaceId=${encodeURIComponent(workspaceId)}`);
        const body = (await response.json()) as { success?: boolean; data?: { staff?: unknown[] } };
        if (cancelled || body.success !== true) return;
        setStaff((Array.isArray(body.data?.staff) ? body.data.staff : []).map(staffFromRecord).filter(Boolean) as StaffOption[]);
      } catch {
        // Без списка сотрудников задачу всё равно можно поставить — без исполнителя.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canManage]);

  const { open, closed } = useMemo(() => {
    const openTasks: Task[] = [];
    const closedTasks: Task[] = [];
    for (const task of tasks) {
      (OPEN_STATUSES.has(statusKey(task.status)) ? openTasks : closedTasks).push(task);
    }
    // Ближайший срок первым; задачи без срока — в конец, они ничего не ждут.
    openTasks.sort((a, b) => {
      const left = Date.parse(a.deadline || "");
      const right = Date.parse(b.deadline || "");
      if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
      if (!Number.isFinite(left)) return 1;
      if (!Number.isFinite(right)) return -1;
      return left - right;
    });
    return { open: openTasks, closed: closedTasks };
  }, [tasks]);

  const create = async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const response = await crmFetch("/api/crm/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: readWorkspaceId(),
          title: trimmed,
          status: "new",
          priority: "medium",
          ...(due ? { deadline: toIso(due) } : {}),
          ...(assignee ? { assigneeUserId: assignee } : {}),
          [entityType === "lead" ? "leadId" : "clientId"]: entityId,
          ...(entityType === "lead" && clientId ? { clientId } : {}),
        }),
      });
      const body = (await response.json()) as { success?: boolean; mode?: string };
      if (!response.ok || body.success !== true) {
        // Причина уходит оператору в консоль, тост остаётся по-русски и без
        // внутренних имён полей.
        console.warn("tasks: create refused", response.status);
        toast.error("Не удалось поставить задачу. Ничего не сохранено.");
        return;
      }
      setTitle("");
      setDue("");
      setAssignee("");
      toast.success("Задача поставлена");
      await load();
    } catch (error) {
      console.warn("tasks: create failed", error instanceof Error ? error.message : error);
      toast.error("Не удалось поставить задачу. Проверьте список перед повтором.");
    } finally {
      setSaving(false);
    }
  };

  const close = async (task: Task) => {
    try {
      const response = await crmFetch("/api/crm/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          workspaceId: readWorkspaceId(),
          updates: { status: "done" },
        }),
      });
      const body = (await response.json()) as { success?: boolean };
      if (!response.ok || body.success !== true) {
        console.warn("tasks: close refused", response.status);
        toast.error("Не удалось закрыть задачу. Изменение отменено.");
        return;
      }
      await load();
    } catch (error) {
      console.warn("tasks: close failed", error instanceof Error ? error.message : error);
      toast.error("Не удалось закрыть задачу. Изменение отменено.");
    }
  };

  return (
    <section className="neu-sm p-4" aria-label="Задачи">
      <div className="mb-3 flex items-center gap-2">
        <ListTodo size={15} style={{ color: "var(--negis-primary)" }} />
        <p className="text-xs font-semibold" style={{ color: "var(--negis-ink-strong)" }}>
          Задачи
        </p>
        {state === "ready" && open.length > 0 ? (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={{ background: "var(--negis-mint)", color: "var(--negis-mint-ink)" }}
          >
            {open.length}
          </span>
        ) : null}
      </div>

      {state === "loading" ? (
        <div className="flex items-center gap-2 py-2" style={{ color: "var(--negis-muted-2)" }}>
          <Loader2 className="animate-spin" size={14} />
          <span className="text-xs">Загружаем…</span>
        </div>
      ) : null}

      {state === "failed" ? (
        <p className="text-xs" style={{ color: "var(--negis-error)" }}>
          Не удалось загрузить задачи. Это не значит, что их нет — попробуйте открыть карточку ещё раз.
        </p>
      ) : null}

      {state === "ready" ? (
        <div className="flex flex-col gap-2.5">
          {open.length === 0 && closed.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--negis-muted-2)" }}>
              Задач пока нет. Поставьте первую — она появится и здесь, и на экране «Задачи».
            </p>
          ) : null}

          {open.map((task) => (
            <div key={task.id} className="flex items-start gap-2.5">
              {canManage ? (
                <button
                  type="button"
                  aria-label="Закрыть задачу"
                  className="mt-0.5 shrink-0"
                  style={{ color: "var(--negis-faint)" }}
                  onClick={() => void close(task)}
                >
                  <CheckCircle2 size={16} />
                </button>
              ) : null}
              <div className="min-w-0">
                <p className="text-xs font-semibold" style={{ color: "var(--negis-ink-strong)" }}>
                  {task.title}
                </p>
                <p className="text-[11px]" style={{ color: isOverdue(task.deadline) ? "var(--negis-error)" : "var(--negis-muted-2)" }}>
                  {[task.owner, formatDue(task.deadline)].filter(Boolean).join(" · ") || "Без исполнителя и срока"}
                </p>
              </div>
            </div>
          ))}

          {closed.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-[11px] font-semibold" style={{ color: "var(--negis-muted-2)" }}>
                Закрытые ({closed.length})
              </summary>
              <ul className="mt-1.5 flex flex-col gap-1">
                {closed.map((task) => (
                  <li key={task.id} className="text-[11px]" style={{ color: "var(--negis-faint)" }}>
                    {task.title}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {canManage && state !== "loading" ? (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--negis-hair)" }}>
          <input
            className="neu-input text-xs"
            placeholder="Что нужно сделать"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="task-title-input"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="datetime-local"
              className="neu-input text-xs sm:flex-1"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              aria-label="Срок"
            />
            <select
              className="neu-input text-xs sm:flex-1"
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              aria-label="Исполнитель"
            >
              <option value="">Без исполнителя</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>{member.name}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="neu-btn-primary justify-center text-xs"
            onClick={() => void create()}
            disabled={saving || !title.trim()}
            data-testid="task-create-button"
          >
            <Plus size={14} />
            {saving ? "Ставим…" : "Поставить задачу"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
