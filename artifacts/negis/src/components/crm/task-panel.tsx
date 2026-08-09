import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ListTodo, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { crmErrorMessage, crmFetch } from "@/lib/api";
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
//
// Режима «только смотреть» здесь нет намеренно: в каталоге прав нет роли,
// у которой есть view_tasks без manage_tasks, поэтому проп, который никогда
// не бывает false, был бы мёртвой веткой, притворяющейся живой. Когда права
// разделят, режим появится вместе с ролью, а не заранее.

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

/**
 * Написания, которые могли попасть в базу до канонизации (миграция 031).
 *
 * Список обязан совпадать с серверным (TASK_STATUS_ALIASES в lib/crm/server.ts).
 * Первая версия была копией вдвое короче, и три написания, означающие «сделано»
 * — «завершено», completed, closed, — панель относила к открытым: закрытая
 * задача висела в работе с зелёным счётчиком.
 */
const STATUS_ALIASES: Record<string, string> = {
  "новые": "new",
  "новая": "new",
  "в работе": "in_progress",
  "готово": "done",
  "выполнено": "done",
  "завершено": "done",
  todo: "new",
  open: "new",
  progress: "in_progress",
  completed: "done",
  closed: "done",
};

function statusKey(raw: string): string {
  const value = (raw || "").trim().toLowerCase();
  if (value === "new" || value === "in_progress" || value === "done") return value;
  // Неизвестное показываем как открытое: спрятать работу хуже, чем показать
  // лишнюю строку. Угадывать «сделано» сервер отказывается, и панель тоже.
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

/**
 * Только те, кому задачу действительно можно поручить.
 *
 * Сервер отказывает в задаче на неактивного сотрудника (400), а панель
 * показывала бы общий тост без причины — оператор жал бы «поставить» снова и
 * снова с тем же исходом. Соседний список того же штата на той же карточке
 * фильтрует так же.
 */
function staffFromRecord(raw: unknown): StaffOption | null {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = str(record.id);
  if (!id) return null;
  const status = (str(record.status) || "active").toLowerCase();
  if (status !== "active") return null;
  const name = str(record.name) || str(record.full_name) || str(record.fullName) || str(record.email) || "Сотрудник";
  return { id, name };
}

/** Срок хранится как момент времени; «сегодня» — это формат показа, а не значение. */
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

/** Причина отказа словами оператора, а не одним текстом на все случаи. */
function refusalText(status: number, details?: string[]): string {
  const detail = (details ?? []).filter(Boolean).join(", ");
  if (detail) return detail;
  return crmErrorMessage(status);
}

export function TaskPanel({
  entityType,
  entityId,
  clientId,
}: {
  entityType: TaskEntity;
  entityId: string;
  /** Заявка почти всегда «про пациента»: связь ставится обеими, когда она известна. */
  clientId?: string;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [failureText, setFailureText] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [saving, setSaving] = useState(false);
  const [closingId, setClosingId] = useState("");

  /**
   * Номер поколения запроса.
   *
   * Два закрытия подряд запускают два перечитывания, и ответ первого может
   * прийти последним — тогда только что закрытая задача снова нарисуется
   * открытой. Ответ более старого поколения просто игнорируется. Тот же
   * механизм закрывает и переключение между карточками.
   */
  const generation = useRef(0);

  const filterParam = entityType === "lead" ? "leadId" : "clientId";

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!entityId) {
      setTasks([]);
      setState("ready");
      return;
    }
    const mine = ++generation.current;
    // Перечитывание после записи не гасит список: иначе одно нажатие галочки
    // стирало бы всю панель до спиннера вместе с формой и набранным текстом.
    if (!options.quiet) setState("loading");
    try {
      const workspaceId = readWorkspaceId();
      const query = `${filterParam}=${encodeURIComponent(entityId)}`
        + (workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : "");
      const response = await crmFetch(`/api/crm/tasks?${query}`);
      const body = (await response.json()) as { success?: boolean; details?: string[]; data?: { tasks?: unknown[] } };
      if (mine !== generation.current) return;
      // Отказ базы приходит как 502. Показать его пустым списком значило бы
      // соврать: запись без задач и запись, задачи которой не удалось
      // прочитать, выглядели бы одинаково.
      if (!response.ok || body.success !== true) {
        setFailureText(refusalText(response.status, body.details));
        setState("failed");
        return;
      }
      setTasks((Array.isArray(body.data?.tasks) ? body.data.tasks : []).map(taskFromRecord));
      setState("ready");
    } catch (error) {
      if (mine !== generation.current) return;
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 0;
      setFailureText(refusalText(status));
      setState("failed");
    }
  }, [entityId, filterParam]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const workspaceId = readWorkspaceId();
        const response = await crmFetch(`/api/crm/staff?workspaceId=${encodeURIComponent(workspaceId)}`);
        const body = (await response.json()) as { success?: boolean; data?: { staff?: unknown[] } };
        if (cancelled || !response.ok || body.success !== true) return;
        setStaff((Array.isArray(body.data?.staff) ? body.data.staff : []).map(staffFromRecord).filter(Boolean) as StaffOption[]);
      } catch {
        // Список сотрудников читается правом manage_staff, которого нет ни у
        // ресепшн, ни у врача, ни у маркетолога, ни у менеджера. Для них поле
        // «Исполнитель» просто не появится — пустой выпадающий список выглядел
        // бы так, будто в клинике нет сотрудников.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      const body = (await response.json()) as { success?: boolean; error?: string; details?: string[] };
      if (!response.ok || body.success !== true) {
        // Разобранное тело называет, какое именно поле не прошло проверку.
        // Выбрасывать его и логировать один код ответа значило бы оставить
        // единственный диагностический канал панели пустым.
        console.warn("tasks: create refused", response.status, body.error ?? "", (body.details ?? []).join("; "));
        toast.error(refusalText(response.status, body.details));
        return;
      }
      setTitle("");
      setDue("");
      setAssignee("");
      toast.success("Задача поставлена");
      await load({ quiet: true });
    } catch (error) {
      console.warn("tasks: create failed", error instanceof Error ? error.message : String(error));
      toast.error("Не удалось поставить задачу. Проверьте список перед повтором.");
    } finally {
      setSaving(false);
    }
  };

  const close = async (task: Task) => {
    if (closingId) return;
    setClosingId(task.id);
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
      const body = (await response.json()) as { success?: boolean; error?: string; details?: string[] };
      if (!response.ok || body.success !== true) {
        console.warn("tasks: close refused", response.status, body.error ?? "", (body.details ?? []).join("; "));
        toast.error(refusalText(response.status, body.details));
        return;
      }
      await load({ quiet: true });
    } catch (error) {
      console.warn("tasks: close failed", error instanceof Error ? error.message : String(error));
      toast.error("Не удалось закрыть задачу. Изменение отменено.");
    } finally {
      setClosingId("");
    }
  };

  const showList = state === "ready" || (state === "loading" && tasks.length > 0);

  return (
    <section className="neu-sm p-4" aria-label="Задачи">
      <div className="mb-3 flex items-center gap-2">
        <ListTodo size={15} style={{ color: "var(--negis-primary)" }} />
        <p className="text-xs font-semibold" style={{ color: "var(--negis-ink-strong)" }}>
          Задачи
        </p>
        {showList && open.length > 0 ? (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={{ background: "var(--negis-mint)", color: "var(--negis-mint-ink)" }}
          >
            {open.length}
          </span>
        ) : null}
      </div>

      {state === "loading" && tasks.length === 0 ? (
        <div className="flex items-center gap-2 py-2" style={{ color: "var(--negis-muted-2)" }}>
          <Loader2 className="animate-spin" size={14} />
          <span className="text-xs">Загружаем…</span>
        </div>
      ) : null}

      {state === "failed" ? (
        <p className="text-xs" style={{ color: "var(--negis-error)" }}>
          {failureText || "Не удалось загрузить задачи."} Это не значит, что задач нет.
        </p>
      ) : null}

      {showList ? (
        <div className="flex flex-col gap-2.5">
          {open.length === 0 && closed.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--negis-muted-2)" }}>
              Задач пока нет. Поставьте первую — она появится и здесь, и на экране «Задачи».
            </p>
          ) : null}

          {open.map((task) => (
            <div key={task.id} className="flex items-start gap-2.5">
              <button
                type="button"
                aria-label={`Закрыть задачу: ${task.title}`}
                title="Закрыть задачу"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
                style={{ background: "var(--negis-ground)", color: "var(--negis-ink-2)" }}
                disabled={closingId === task.id}
                onClick={() => void close(task)}
              >
                {closingId === task.id ? <Loader2 className="animate-spin" size={15} /> : <CheckCircle2 size={16} />}
              </button>
              <div className="min-w-0 pt-1">
                <p className="break-words text-xs font-semibold" style={{ color: "var(--negis-ink-strong)" }}>
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
                  <li key={task.id} className="break-words text-[11px]" style={{ color: "var(--negis-faint)" }}>
                    {task.title}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {/* Форма показывается только когда список прочитан. Форма поверх отказа
          принимает ввод, результат которого оператор всё равно не увидит. */}
      {showList ? (
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
            {staff.length > 0 ? (
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
            ) : null}
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
