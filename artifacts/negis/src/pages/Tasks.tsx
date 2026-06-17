import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { CalendarDays, Check, Search, Trash2 } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

interface LeadTaskLead {
  id: string;
  full_name: string | null;
  phone: string | null;
  assigned_to: string | null;
  comment: string | null;
}

interface Agent {
  id: string;
  name: string;
  user_id: string | null;
}

interface ClientTask {
  id: string;
  leadId: string;
  leadName: string;
  phone: string;
  text: string;
  dueDate: string;
  status: string;
  createdAt: string;
  originalLine: string;
}

const columns = [
  { id: 'overdue', title: 'Просрочено', hint: 'Дата уже прошла' },
  { id: 'today', title: 'Сегодня', hint: 'Нужно сделать сегодня' },
  { id: 'upcoming', title: 'Будущие', hint: 'Запланировано дальше' },
  { id: 'noDate', title: 'Без даты', hint: 'Нужно уточнить срок' },
  { id: 'done', title: 'Выполнено', hint: 'Закрытые задачи' },
] as const;

type TaskColumnId = (typeof columns)[number]['id'];

function taskBody(line: string) {
  return line.replace(/^\[([^\]]+)\]\s*Задача:\s*/i, '');
}

function taskCreatedAt(line: string) {
  return line.match(/^\[([^\]]+)\]/)?.[1] ?? '';
}

function taskField(body: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body.match(new RegExp(`(?:^|;)\\s*${escaped}:\\s*([^;]+)`, 'i'))?.[1]?.trim() ?? '';
}

function parseTasks(lead: LeadTaskLead): ClientTask[] {
  return (lead.comment ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^\[[^\]]+\]\s*Задача:/i.test(line))
    .map((line, index) => {
      const body = taskBody(line);
      const text = body.split(';')[0]?.trim() || 'Задача';
      return {
        id: `${lead.id}-${index}`,
        leadId: lead.id,
        leadName: lead.full_name || 'Без имени',
        phone: lead.phone || '',
        text,
        dueDate: taskField(body, 'срок'),
        status: taskField(body, 'статус') || 'todo',
        createdAt: taskCreatedAt(line),
        originalLine: line,
      };
    });
}

function columnForTask(task: ClientTask, today: string) {
  if (task.status === 'done') return 'done';
  if (!task.dueDate) return 'noDate';
  if (task.dueDate < today) return 'overdue';
  if (task.dueDate === today) return 'today';
  return 'upcoming';
}

function localDateOffset(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function upsertTaskField(line: string, label: string, value: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`((?:^|;)\\s*${escaped}:\\s*)[^;]+`, 'i');
  if (re.test(line)) return line.replace(re, `$1${value}`);
  return `${line}; ${label}: ${value}`;
}

function removeTaskField(line: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return line
    .replace(new RegExp(`;\\s*${escaped}:\\s*[^;]+`, 'i'), '')
    .replace(new RegExp(`^\\s*${escaped}:\\s*[^;]+;?\\s*`, 'i'), '')
    .trim();
}

export default function Tasks() {
  const { clinicId, user, userRole } = useAuth();
  const [tasks, setTasks] = useState<ClientTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionTaskId, setActionTaskId] = useState('');
  const [dragTaskId, setDragTaskId] = useState('');
  const [search, setSearch] = useState('');
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  useEffect(() => {
    if (clinicId) loadTasks();
  }, [clinicId, userRole, user?.id]);

  const loadTasks = async () => {
    if (!clinicId) return;
    setLoading(true);
    try {
      const { data: agents } = await supabase
        .from('agents')
        .select('id, name, user_id')
        .eq('clinic_id', clinicId)
        .order('name');

      let query = supabase
        .from('leads')
        .select('id, full_name, phone, assigned_to, comment')
        .eq('clinic_id', clinicId)
        .eq('pipeline', 'sales')
        .not('comment', 'is', null)
        .order('updated_at', { ascending: false });

      if (userRole === 'agent') {
        const mine = (agents as Agent[] | null)?.find(agent => agent.user_id === user?.id);
        const ids = [mine?.id, user?.id].filter(Boolean) as string[];
        if (ids.length === 0) {
          setTasks([]);
          setLoading(false);
          return;
        }
        query = query.in('assigned_to', ids);
      }

      const { data, error } = await query;
      if (error) throw error;
      setTasks((data ?? []).flatMap(parseTasks));
    } catch (err: any) {
      toast.error(err?.message || 'Не удалось загрузить задачи');
    } finally {
      setLoading(false);
    }
  };

  const updateTaskLine = async (task: ClientTask, updater: (line: string) => string | null) => {
    if (!clinicId) return false;
    setActionTaskId(task.id);
    try {
      const { data, error } = await supabase
        .from('leads')
        .select('comment')
        .eq('clinic_id', clinicId)
        .eq('id', task.leadId)
        .single();
      if (error) throw error;

      const lines = String(data?.comment ?? '').split('\n');
      const index = lines.findIndex(line => line.trim() === task.originalLine);
      if (index === -1) throw new Error('Задача уже изменилась. Обновите список.');

      const nextLine = updater(lines[index].trim());
      if (nextLine === null) lines.splice(index, 1);
      else lines[index] = nextLine;

      const { error: updateError } = await supabase
        .from('leads')
        .update({
          comment: lines.map(line => line.trim()).filter(Boolean).join('\n'),
          updated_at: new Date().toISOString(),
        })
        .eq('clinic_id', clinicId)
        .eq('id', task.leadId);
      if (updateError) throw updateError;

      await loadTasks();
      return true;
    } catch (err: any) {
      toast.error(err?.message || 'Не удалось обновить задачу');
      return false;
    } finally {
      setActionTaskId('');
    }
  };

  const completeTask = async (task: ClientTask) => {
    const saved = await updateTaskLine(task, line => {
      if (/(^|;)\s*статус:\s*[^;]+/i.test(line)) {
        return line.replace(/((?:^|;)\s*статус:\s*)[^;]+/i, '$1done');
      }
      return `${line}; статус: done`;
    });
    if (saved) toast.success('Задача выполнена');
  };

  const deleteTask = async (task: ClientTask) => {
    const ok = window.confirm('Удалить задачу?');
    if (!ok) return;
    const deleted = await updateTaskLine(task, () => null);
    if (deleted) toast.success('Задача удалена');
  };

  const moveTask = async (task: ClientTask, columnId: TaskColumnId) => {
    const saved = await updateTaskLine(task, line => {
      let next = upsertTaskField(line, 'статус', columnId === 'done' ? 'done' : 'todo');
      if (columnId === 'overdue') next = upsertTaskField(next, 'срок', localDateOffset(-1));
      if (columnId === 'today') next = upsertTaskField(next, 'срок', localDateOffset(0));
      if (columnId === 'upcoming') next = upsertTaskField(next, 'срок', localDateOffset(1));
      if (columnId === 'noDate') next = removeTaskField(next, 'срок');
      return next;
    });
    if (saved) toast.success('Задача перенесена');
  };

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(task =>
      task.leadName.toLowerCase().includes(q) ||
      task.phone.includes(q) ||
      task.text.toLowerCase().includes(q),
    );
  }, [tasks, search]);

  const grouped = useMemo(() => {
    const result: Record<(typeof columns)[number]['id'], ClientTask[]> = {
      overdue: [],
      today: [],
      upcoming: [],
      noDate: [],
      done: [],
    };
    filteredTasks.forEach(task => {
      result[columnForTask(task, today)].push(task);
    });
    Object.values(result).forEach(list => {
      list.sort((a, b) => (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99'));
    });
    return result;
  }, [filteredTasks, today]);

  return (
    <PageLayout>
      <div className="space-y-5">
        <div className="flex justify-between items-center gap-4">
          <div>
            <h2 className="text-2xl font-bold">Задачи</h2>
            <p className="text-sm text-[#64748B] mt-1">Задачи, созданные в карточках клиентов.</p>
          </div>
          <Link href="/sales">
            <button className="neu-btn-primary">Открыть клиентов</button>
          </Link>
        </div>

        <div className="neu-card p-4 flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-64">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94A3B8]" />
            <input
              className="neu-input pl-9 text-sm"
              placeholder="Имя клиента, телефон или текст задачи"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <button className="neu-btn" onClick={loadTasks} disabled={loading}>
            {loading ? 'Загрузка...' : 'Обновить'}
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 min-h-0">
          {columns.map(column => (
            <section
              key={column.id}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                const task = tasks.find(item => item.id === e.dataTransfer.getData('text/plain'));
                setDragTaskId('');
                if (task && columnForTask(task, today) !== column.id) moveTask(task, column.id);
              }}
              className={`rounded-2xl border bg-white overflow-hidden h-[calc(100dvh-260px)] min-h-[520px] flex flex-col transition-colors ${dragTaskId ? 'border-[#BFDBFE]' : 'border-[#E7ECF3]'}`}
            >
              <div className="p-4 border-b border-[#E7ECF3] bg-[#F8FAFC]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-[#0B1220]">{column.title}</h3>
                    <p className="text-xs text-[#94A3B8] mt-0.5">{column.hint}</p>
                  </div>
                  <span className="rounded-full bg-white border border-[#E7ECF3] px-2.5 py-1 text-xs font-bold text-[#64748B]">
                    {grouped[column.id].length}
                  </span>
                </div>
              </div>

              <div className="p-3 space-y-3 overflow-y-auto overscroll-contain flex-1">
                {grouped[column.id].length === 0 ? (
                  <div className="py-10 text-center text-sm text-[#94A3B8]">Нет задач</div>
                ) : grouped[column.id].map(task => (
                  <article
                    key={task.id}
                    draggable={actionTaskId !== task.id}
                    onDragStart={e => {
                      setDragTaskId(task.id);
                      e.dataTransfer.setData('text/plain', task.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDragTaskId('')}
                    className={`rounded-xl border border-[#E7ECF3] bg-white p-4 shadow-sm cursor-grab active:cursor-grabbing transition ${dragTaskId === task.id ? 'opacity-60 ring-2 ring-[#BFDBFE]' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-bold text-[#0B1220] truncate">{task.leadName}</div>
                        {task.phone && <div className="text-xs text-[#94A3B8] mt-0.5">{task.phone}</div>}
                      </div>
                      {task.dueDate && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[#EFF6FF] px-2 py-1 text-xs font-semibold text-[#2859C5] shrink-0">
                          <CalendarDays size={12} />
                          {new Date(`${task.dueDate}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                        </span>
                      )}
                    </div>
                    <p className="mt-3 text-sm text-[#475569] line-clamp-3">{task.text}</p>
                    <div className="mt-4 flex items-center justify-between gap-3">
                      <span className="text-[11px] text-[#CBD5E1]">{task.createdAt}</span>
                      <Link href="/sales">
                        <button className="rounded-lg border border-[#E7ECF3] bg-[#F8FAFC] px-3 py-1.5 text-xs font-semibold text-[#1E325C]">
                          Клиент
                        </button>
                      </Link>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {task.status !== 'done' ? (
                        <button
                          onClick={() => completeTask(task)}
                          disabled={actionTaskId === task.id}
                          className="rounded-lg border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-xs font-semibold text-[#16A34A] disabled:opacity-50 flex items-center justify-center gap-1.5"
                        >
                          <Check size={13} />
                          Выполнено
                        </button>
                      ) : (
                        <div className="rounded-lg border border-[#E7ECF3] bg-[#F8FAFC] px-3 py-2 text-xs font-semibold text-[#94A3B8] text-center">
                          Закрыта
                        </div>
                      )}
                      <button
                        onClick={() => deleteTask(task)}
                        disabled={actionTaskId === task.id}
                        className="rounded-lg border border-[#FEE2E2] bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-[#DC2626] disabled:opacity-50 flex items-center justify-center gap-1.5"
                      >
                        <Trash2 size={13} />
                        Удалить
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </PageLayout>
  );
}
