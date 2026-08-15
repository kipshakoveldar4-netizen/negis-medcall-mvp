import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { crmErrorMessage, crmFetch } from "@/lib/api";
import { isRealWorkspace, readWorkspaceId } from "@/lib/demoStorage";
import { capitalize, termsFor, type Terms } from "../../../../../lib/vertical/terms";

// Справочник исполнителей — врачей или мастеров — и их график.
//
// Отдельный компонент, а не шестьсот строк внутрь AdminCenter: так уже сделан
// раздел WhatsApp, и вкладка остаётся одной строкой в разметке.
//
// Своего маршрута у экрана нет намеренно. Отдельный /doctors стоил бы шести
// согласованных регистраций — ленивый импорт, права маршрута, сам маршрут,
// боковое меню, мобильное меню, заголовок и проверка мобильной вёрстки, — и
// всё это ради адреса, для аудитории, которая и так сидит в настройках.

type ClinicDoctor = {
  id: string;
  fullName: string;
  specialty: string;
  /** Сколько клиентов ведёт одновременно. Единица — обычный приём. */
  capacity: number;
  sortOrder: number;
  isActive: boolean;
};

type Shift = {
  id: string;
  doctorId: string;
  weekday: number | null;
  onDate: string;
  onDateEnd: string;
  isWorking: boolean;
  startMinute: number | null;
  endMinute: number | null;
  note: string;
};

type ScreenState = "loading" | "ready" | "failed" | "unavailable";

/** Общепринятые русские сокращения. label.slice(0, 2) давал «По», «Че», «Пя». */
const WEEKDAY_SHORT: Record<number, string> = { 1: "Пн", 2: "Вт", 3: "Ср", 4: "Чт", 5: "Пт", 6: "Сб", 7: "Вс" };

const WEEKDAYS: Array<{ iso: number; label: string }> = [
  { iso: 1, label: "Понедельник" },
  { iso: 2, label: "Вторник" },
  { iso: 3, label: "Среда" },
  { iso: 4, label: "Четверг" },
  { iso: 5, label: "Пятница" },
  { iso: 6, label: "Суббота" },
  { iso: 7, label: "Воскресенье" },
];

/**
 * Пояса, из которых выбирают. Закрытый список, а не свободный ввод: строка,
 * которую не понимает Intl, молча выключила бы правило графика целиком.
 */
const TIME_ZONES = [
  "Asia/Almaty",
  "Asia/Aqtobe",
  "Asia/Aqtau",
  "Asia/Atyrau",
  "Asia/Oral",
  "Asia/Qostanay",
  "Asia/Qyzylorda",
  "Asia/Tashkent",
  "Asia/Bishkek",
  "Europe/Moscow",
];

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function doctorFromApi(record: Record<string, unknown>): ClinicDoctor {
  return {
    id: readText(record.id),
    fullName: readText(record.fullName) || readText(record.full_name),
    specialty: readText(record.specialty),
    capacity: Number(record.capacity) || 1,
    sortOrder: readNullableInt(record.sortOrder ?? record.sort_order) ?? 0,
    isActive:
      record.isActive === undefined && record.is_active === undefined
        ? true
        : Boolean(record.isActive ?? record.is_active),
  };
}

function shiftFromApi(record: Record<string, unknown>): Shift {
  return {
    id: readText(record.id),
    doctorId: readText(record.doctorId) || readText(record.doctor_id),
    weekday: readNullableInt(record.weekday),
    onDate: readText(record.onDate) || readText(record.on_date),
    onDateEnd: readText(record.onDateEnd) || readText(record.on_date_end),
    isWorking:
      record.isWorking === undefined && record.is_working === undefined
        ? true
        : Boolean(record.isWorking ?? record.is_working),
    startMinute: readNullableInt(record.startMinute ?? record.start_minute),
    endMinute: readNullableInt(record.endMinute ?? record.end_minute),
    note: readText(record.note),
  };
}

/** «09:00» ⇄ 540. Минуты за полночь показываются как 02:00 следующего дня. */
function minuteToTime(minute: number | null): string {
  if (minute === null) return "";
  const normalized = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function timeToMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Детали сервера по-русски. Оператор не должен читать `weekday must be…`.
 *
 * Функция от словаря ниши, а не константа: сервер говорит «врач» для любой
 * ниши, и перевод — единственное место, где салон услышит «мастер».
 */
function detailTextFor(terms: Terms): Record<string, string> {
  return {
    "fullName is required": `Укажите имя ${terms.specialistGenitive}.`,
    "fullName must be unique within the workspace": `${capitalize(terms.specialist)} с таким именем уже есть.`,
    "doctorId is required": `Сначала выберите ${terms.specialistGenitive}.`,
    "either weekday or onDate is required, not both": "Строка графика — либо день недели, либо дата.",
    "a day off must not carry working hours": `У выходного не может быть часов ${terms.dutyGenitive}.`,
    "startMinute and endMinute are required for a working row": `Укажите начало и конец ${terms.dutyGenitive}.`,
    "endMinute must be after startMinute and no more than 24 hours later":
      `Конец ${terms.dutyGenitive} должен быть позже начала и не длиннее суток.`,
    "onDateEnd must not be earlier than onDate": "Конец периода не может быть раньше начала.",
  };
}

function refusalText(status: number, error: string, details: string[], detailText: Record<string, string>): string {
  const translated = details.map((detail) => detailText[detail]).filter(Boolean);
  if (translated.length > 0) return translated.join(" ");
  if (error && /[а-яё]/i.test(error)) return error;
  return crmErrorMessage(status);
}

type Envelope = {
  success?: boolean;
  mode?: string;
  error?: string;
  details?: string[];
  data?: Record<string, unknown>;
};

async function readEnvelope(response: Response): Promise<Envelope | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    return null;
  }
}

export function DoctorSchedule() {
  const { userRole, rolePermissions, vertical } = useAuth();
  const terms = termsFor(vertical);
  const detailText = useMemo(() => detailTextFor(terms), [terms]);
  const [doctors, setDoctors] = useState<ClinicDoctor[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [timeZone, setTimeZone] = useState("");
  const [screen, setScreen] = useState<ScreenState>("loading");
  const [failureText, setFailureText] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState({ fullName: "", specialty: "", capacity: "1", sortOrder: "0", isActive: true });
  const [saving, setSaving] = useState(false);
  const [exception, setException] = useState({ from: "", to: "", note: "", working: false, start: "09:00", end: "18:00" });

  const generation = useRef(0);

  /** Правит тот, кто отвечает за клинику. Нет права — нет и кнопок. */
  const canManage = useMemo(
    () => userRole === "owner" || userRole === "admin" || userRole === "manager" || Boolean(rolePermissions.admin),
    [rolePermissions.admin, userRole],
  );

  /** Часовой пояс пишется через настройки, а они только для владельца и админа. */
  const canSetTimeZone = userRole === "owner" || userRole === "admin";

  const load = async (options: { quiet?: boolean } = {}) => {
    const current = generation.current + 1;
    generation.current = current;
    if (!options.quiet) setScreen("loading");

    if (!isRealWorkspace()) {
      if (generation.current !== current) return;
      setScreen("unavailable");
      return;
    }

    try {
      const workspaceId = encodeURIComponent(readWorkspaceId());
      const [doctorsResponse, shiftsResponse] = await Promise.all([
        crmFetch(`/api/crm/clinic-doctors?workspaceId=${workspaceId}`),
        crmFetch(`/api/crm/doctor-schedule?workspaceId=${workspaceId}`),
      ]);
      const doctorsBody = await readEnvelope(doctorsResponse);
      const shiftsBody = await readEnvelope(shiftsResponse);
      if (generation.current !== current) return;

      if (!doctorsResponse.ok || doctorsBody?.success !== true) {
        // Пустой список здесь был бы неправдой: «не удалось прочитать» и
        // «врачей нет» — разные ответы, и второй заставил бы завести всех
        // заново поверх существующих.
        console.warn("[doctors] read failed", doctorsResponse.status, doctorsBody?.error);
        setFailureText(refusalText(doctorsResponse.status, readText(doctorsBody?.error), doctorsBody?.details || [], detailText));
        setScreen("failed");
        return;
      }

      if (doctorsBody.data?.directoryAvailable === false) {
        setDoctors([]);
        setShifts([]);
        setScreen("unavailable");
        return;
      }

      const rawDoctors = doctorsBody.data?.doctors ?? doctorsBody.data?.items;
      const list = (Array.isArray(rawDoctors) ? rawDoctors : []).map((item) => doctorFromApi(item as Record<string, unknown>));
      list.sort((a, b) => a.sortOrder - b.sortOrder || a.fullName.localeCompare(b.fullName, "ru"));
      setDoctors(list);

      if (shiftsResponse.ok && shiftsBody?.success === true) {
        const rawShifts = shiftsBody.data?.shifts ?? shiftsBody.data?.items;
        setShifts((Array.isArray(rawShifts) ? rawShifts : []).map((item) => shiftFromApi(item as Record<string, unknown>)));
        setTimeZone(readText(shiftsBody.data?.timeZone));
      }

      setSelectedId((current2) => (current2 && list.some((doctor) => doctor.id === current2) ? current2 : list[0]?.id ?? ""));
      setScreen("ready");
    } catch (error) {
      if (generation.current !== current) return;
      console.warn("[doctors] read threw", error);
      setFailureText(crmErrorMessage(error));
      setScreen("failed");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!formOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFormOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [formOpen]);

  const write = async (path: string, method: "POST" | "PATCH", payload: Record<string, unknown>): Promise<boolean> => {
    try {
      const response = await crmFetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, workspaceId: readWorkspaceId() }),
      });
      const body = await readEnvelope(response);
      if (!response.ok || body?.success !== true) {
        console.warn("[doctors] write failed", path, method, response.status, body?.error, (body?.details || []).join("; "));
        toast.error(refusalText(response.status, readText(body?.error), body?.details || [], detailText));
        return false;
      }
      return true;
    } catch (error) {
      console.warn("[doctors] write threw", path, method, error);
      toast.error(crmErrorMessage(error));
      return false;
    }
  };

  const submitDoctor = async () => {
    const fullName = form.fullName.trim();
    if (!fullName) {
      toast.error(`Укажите имя ${terms.specialistGenitive}`);
      return;
    }
    setSaving(true);
    try {
      const fields = {
        fullName,
        specialty: form.specialty.trim(),
        capacity: readNullableInt(form.capacity) ?? 1,
        sortOrder: readNullableInt(form.sortOrder) ?? 0,
        isActive: form.isActive,
      };
      const ok = editingId
        ? await write("/api/crm/clinic-doctors", "PATCH", { id: editingId, ...fields })
        : await write("/api/crm/clinic-doctors", "POST", fields);
      if (!ok) return;
      setFormOpen(false);
      toast.success(`${capitalize(terms.specialist)} ${editingId ? "обновлён" : "добавлен"}`);
      await load({ quiet: true });
    } finally {
      setSaving(false);
    }
  };

  const selected = doctors.find((doctor) => doctor.id === selectedId) ?? null;
  const mine = useMemo(() => shifts.filter((shift) => shift.doctorId === selectedId), [selectedId, shifts]);
  const weeklyByDay = useMemo(() => {
    const map = new Map<number, Shift[]>();
    for (const shift of mine) {
      if (shift.weekday === null) continue;
      const list = map.get(shift.weekday) ?? [];
      list.push(shift);
      map.set(shift.weekday, list);
    }
    return map;
  }, [mine]);
  const exceptions = useMemo(() => mine.filter((shift) => Boolean(shift.onDate)), [mine]);

  const saveWeekday = async (iso: number, start: string, end: string) => {
    if (!selectedId) return;
    const startMinute = timeToMinute(start);
    const endMinute = timeToMinute(end);
    if (startMinute === null || endMinute === null) {
      toast.error("Время указывается как 09:00");
      return;
    }
    // Смена через полночь: 22:00–02:00 хранится как [1320, 1560).
    const normalizedEnd = endMinute <= startMinute ? endMinute + 1440 : endMinute;
    // Строк на один день может оказаться несколько: правится КАЖДАЯ. Прежняя
    // версия трогала первую, рапортовала успех — и правило продолжало читать
    // вторую, то есть экран показывал одно, а сервер судил по другому.
    const existing = weeklyByDay.get(iso) ?? [];
    const payload = { doctorId: selectedId, weekday: iso, isWorking: true, startMinute, endMinute: normalizedEnd };
    let ok = true;
    if (existing.length === 0) {
      ok = await write("/api/crm/doctor-schedule", "POST", payload);
    } else {
      for (const row of existing) {
        ok = (await write("/api/crm/doctor-schedule", "PATCH", { id: row.id, ...payload })) && ok;
      }
    }
    if (!ok) return;
    toast.success("График сохранён");
    await load({ quiet: true });
  };

  const setDayOff = async (iso: number) => {
    if (!selectedId) return;
    const existing = weeklyByDay.get(iso) ?? [];
    const payload = { doctorId: selectedId, weekday: iso, isWorking: false, startMinute: null, endMinute: null };
    let ok = true;
    if (existing.length === 0) {
      ok = await write("/api/crm/doctor-schedule", "POST", payload);
    } else {
      for (const row of existing) {
        ok = (await write("/api/crm/doctor-schedule", "PATCH", { id: row.id, ...payload })) && ok;
      }
    }
    if (!ok) return;
    toast.success("День отмечен как нерабочий");
    await load({ quiet: true });
  };

  const addException = async () => {
    if (!selectedId) return;
    if (!exception.from) {
      toast.error("Укажите дату");
      return;
    }
    const payload: Record<string, unknown> = {
      doctorId: selectedId,
      onDate: exception.from,
      onDateEnd: exception.to || exception.from,
      isWorking: exception.working,
      note: exception.note.trim(),
    };
    if (exception.working) {
      const start = timeToMinute(exception.start);
      const end = timeToMinute(exception.end);
      if (start === null || end === null) {
        toast.error("Время указывается как 09:00");
        return;
      }
      payload.startMinute = start;
      payload.endMinute = end <= start ? end + 1440 : end;
    }
    const ok = await write("/api/crm/doctor-schedule", "POST", payload);
    if (!ok) return;
    setException({ from: "", to: "", note: "", working: false, start: "09:00", end: "18:00" });
    toast.success("Исключение добавлено");
    await load({ quiet: true });
  };

  /**
   * Исключение можно ПЕРЕНЕСТИ, но нельзя удалить.
   *
   * У платформы нет DELETE ни для одного ресурса, а у строки графика нет
   * колонки «архивная»: снять её нечем. Прежняя кнопка «Снять» отправляла
   * пустую дату — сервер отвергал такое тело, а если бы принял, строка
   * нарушила бы ограничение «ровно один ключ: день недели или дата».
   * Кнопки, которая не может сработать, здесь больше нет; вместо неё —
   * перенос дат, и честная строка о том, что удаления пока не существует.
   */
  const moveException = async (shift: Shift, from: string, to: string) => {
    if (!from) {
      toast.error("Укажите дату");
      return;
    }
    const ok = await write("/api/crm/doctor-schedule", "PATCH", {
      id: shift.id,
      onDate: from,
      onDateEnd: to || from,
    });
    if (!ok) return;
    toast.success("Даты исключения изменены");
    await load({ quiet: true });
  };

  const saveTimeZone = async (zone: string) => {
    const ok = await write("/api/crm/admin-settings", "POST", { key: "clinic_schedule", value: { timeZone: zone } });
    if (!ok) return;
    setTimeZone(zone);
    toast.success(`Часовой пояс ${terms.orgGenitive} сохранён`);
  };

  const resolvedSummary = useMemo(() => {
    if (!selected) return "";
    const working = WEEKDAYS
      .filter((day) => (weeklyByDay.get(day.iso) ?? []).some((shift) => shift.isWorking))
      .map((day) => WEEKDAY_SHORT[day.iso]);
    // «Строк нет вовсе» и «все дни отмечены нерабочими» — разные состояния, и
    // второе правило как раз ПРИМЕНЯЕТ, отказывая всю неделю. Прежняя сводка
    // печатала для него «ничем не ограничена» — прямо наоборот.
    if (mine.length === 0) return `График не задан — запись к этому ${terms.specialistDative} ничем не ограничена.`;
    if (working.length === 0) return "Все дни отмечены нерабочими: запись будет предупреждать в любой день.";
    if (working.length === 7) return `${capitalize(terms.specialist)} принимает все дни недели.`;
    return `${capitalize(terms.specialist)} принимает: ${working.join(", ")}. В остальные дни запись будет предупреждать.`;
    // terms в зависимостях обязателен: без него смена ниши на лету оставляла
    // бы сводку на словаре прежней ниши, пока остальной экран уже переключился.
  }, [mine.length, selected, terms, weeklyByDay]);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
      <section className="neu-card">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-[#0F172A]">{capitalize(terms.specialistPlural)}</h2>
            <p className="text-sm text-[#64748B]">Кто принимает в {terms.orgPrepositional}. Имя отсюда подставляется в запись.</p>
          </div>
          {canManage && screen === "ready" ? (
            <button
              type="button"
              className="neu-btn px-3 py-2"
              onClick={() => {
                setEditingId("");
                setForm({ fullName: "", specialty: "", capacity: "1", sortOrder: "0", isActive: true });
                setFormOpen(true);
              }}
            >
              <Plus size={15} />
            </button>
          ) : null}
        </div>

        {screen === "loading" ? (
          <p className="text-sm font-semibold text-[#64748B]" aria-live="polite">Загружаем данные…</p>
        ) : null}

        {screen === "failed" ? (
          <div className="rounded-2xl bg-rose-50 p-4 text-sm font-semibold text-rose-900" aria-live="polite">
            Не удалось загрузить справочник {terms.specialistGenitivePlural}. Это не значит, что их нет.
            <p className="mt-1 font-normal">{failureText}</p>
            <button type="button" className="neu-btn mt-3 px-3 py-2 text-xs" onClick={() => void load()}>
              <RefreshCw size={13} />
              Попробовать снова
            </button>
          </div>
        ) : null}

        {screen === "unavailable" ? (
          <p className="rounded-2xl bg-slate-100 p-4 text-sm font-semibold text-[#64748B]">
            Справочник {terms.specialistGenitivePlural} ещё не включён. Поле «{capitalize(terms.specialist)}» в записи работает как раньше — текстом.
          </p>
        ) : null}

        {screen === "ready" && doctors.length === 0 ? (
          <p className="text-sm font-semibold text-[#64748B]">
            {canManage
              ? `${capitalize(terms.specialistGenitivePlural)} пока нет. Добавьте первого — он появится в форме записи.`
              : `${capitalize(terms.specialistGenitivePlural)} пока нет. Список заполняет администратор ${terms.orgGenitive}.`}
          </p>
        ) : null}

        {screen === "ready" && doctors.length > 0 ? (
          <div className="grid gap-2">
            {doctors.map((doctor) => (
              <button
                key={doctor.id}
                type="button"
                onClick={() => setSelectedId(doctor.id)}
                className={`rounded-2xl border p-3 text-left ${
                  doctor.id === selectedId ? "border-[#0D9488] bg-[#ECFDF5]" : "border-[#E2E8F0] bg-white/70"
                }`}
                style={{ opacity: doctor.isActive ? 1 : 0.55 }}
              >
                <span className="block font-bold text-[#0F172A]">{doctor.fullName}</span>
                <span className="mt-0.5 block text-xs text-[#64748B]">
                  {doctor.specialty || "Специальность не указана"}
                  {doctor.capacity > 1 ? ` · ведёт ${doctor.capacity} одновременно` : ""}
                  {doctor.isActive ? "" : " · скрыт"}
                </span>
                {canManage ? (
                  <span
                    className="mt-2 inline-block text-xs font-bold text-[#0D9488]"
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditingId(doctor.id);
                      setForm({
                        fullName: doctor.fullName,
                        specialty: doctor.specialty,
                        capacity: String(doctor.capacity),
                        sortOrder: String(doctor.sortOrder),
                        isActive: doctor.isActive,
                      });
                      setFormOpen(true);
                    }}
                  >
                    Изменить
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="neu-card">
        <div className="mb-4">
          <h2 className="text-lg font-black text-[#0F172A]">График {terms.dutyGenitive}</h2>
          <p className="text-sm text-[#64748B]">
            Часы задаются во времени {terms.orgGenitive}. Пока часовой пояс не выбран, график при записи не применяется.
          </p>
        </div>

        <label className="mb-5 block">
          <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Часовой пояс {terms.orgGenitive}</span>
          {canSetTimeZone ? (
            <select className="neu-input w-full" value={timeZone} onChange={(event) => void saveTimeZone(event.target.value)}>
              <option value="">Не выбран — график не применяется</option>
              {TIME_ZONES.map((zone) => (
                <option key={zone} value={zone}>{zone}</option>
              ))}
            </select>
          ) : (
            <p className="text-sm font-semibold text-[#0F172A]">
              {timeZone || "Не выбран — график не применяется"}
            </p>
          )}
        </label>

        {screen !== "ready" || !selected ? (
          <p className="text-sm font-semibold text-[#64748B]">Выберите {terms.specialistGenitive} слева, чтобы задать его график.</p>
        ) : (
          <div className="grid gap-4">
            <p className="rounded-2xl bg-[#F1F5F9] p-3 text-sm font-semibold text-[#334155]">{resolvedSummary}</p>

            <div className="grid gap-2">
              {WEEKDAYS.map((day) => {
                const rows = weeklyByDay.get(day.iso) ?? [];
                const working = rows.find((shift) => shift.isWorking) ?? null;
                return (
                  <div key={day.iso} className="flex flex-wrap items-center gap-2 rounded-2xl border border-[#E2E8F0] bg-white/70 p-3">
                    <span className="w-32 text-sm font-bold text-[#0F172A]">{day.label}</span>
                    {working ? (
                      <>
                        {/* key включает врача и сами значения: без него поле с
                            defaultValue не обновляется при смене врача, и у
                            второго врача показывались часы первого. */}
                        <input
                          key={`start-${selectedId}-${day.iso}-${working.startMinute}`}
                          className="neu-input w-28"
                          type="time"
                          step={300}
                          defaultValue={minuteToTime(working.startMinute)}
                          disabled={!canManage}
                          onBlur={(event) => canManage && void saveWeekday(day.iso, event.target.value, minuteToTime(working.endMinute))}
                        />
                        <span className="text-sm text-[#64748B]">до</span>
                        <input
                          key={`end-${selectedId}-${day.iso}-${working.endMinute}`}
                          className="neu-input w-28"
                          type="time"
                          step={300}
                          defaultValue={minuteToTime(working.endMinute)}
                          disabled={!canManage}
                          onBlur={(event) => canManage && void saveWeekday(day.iso, minuteToTime(working.startMinute), event.target.value)}
                        />
                        {working.endMinute !== null && working.endMinute > 1440 ? (
                          <span className="text-xs font-semibold text-[#0369A1]">следующий день</span>
                        ) : null}
                        {canManage ? (
                          <button type="button" className="neu-btn px-3 py-1.5 text-xs" onClick={() => void setDayOff(day.iso)}>
                            Не работает
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <span className="text-sm font-semibold text-[#64748B]">
                          {rows.length > 0 ? "Не работает" : "Не задано"}
                        </span>
                        {canManage ? (
                          <button
                            type="button"
                            className="neu-btn px-3 py-1.5 text-xs"
                            onClick={() => void saveWeekday(day.iso, "09:00", "18:00")}
                          >
                            Задать 09:00–18:00
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-black text-[#0F172A]">Исключения: отпуск, выходной, особые часы</h3>
              <p className="mb-2 text-xs text-[#64748B]">
                Исключение можно перенести на другую дату, но удалить его в этой версии нельзя — у строк графика ещё нет
                архивирования.
              </p>
              {exceptions.length === 0 ? (
                <p className="text-sm text-[#64748B]">Исключений нет.</p>
              ) : (
                <div className="grid gap-2">
                  {exceptions.map((shift) => (
                    <div key={shift.id} className="flex flex-wrap items-center gap-2 rounded-2xl border border-[#E2E8F0] bg-white/70 p-3 text-sm">
                      <span className="font-bold text-[#0F172A]">
                        {shift.onDate}
                        {shift.onDateEnd && shift.onDateEnd !== shift.onDate ? ` — ${shift.onDateEnd}` : ""}
                      </span>
                      <span className="text-[#64748B]">
                        {shift.isWorking
                          ? `${minuteToTime(shift.startMinute)}–${minuteToTime(shift.endMinute)}`
                          : "не работает"}
                      </span>
                      {shift.note ? <span className="text-[#64748B]">· {shift.note}</span> : null}
                      {canManage ? (
                        <label className="ml-auto flex items-center gap-2 text-xs font-semibold text-[#64748B]">
                          Перенести на
                          <input
                            className="neu-input w-36"
                            type="date"
                            defaultValue={shift.onDate}
                            onBlur={(event) => {
                              if (event.target.value && event.target.value !== shift.onDate) {
                                void moveException(shift, event.target.value, shift.onDateEnd);
                              }
                            }}
                          />
                        </label>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              {canManage ? (
                <div className="mt-3 flex flex-wrap items-end gap-2 rounded-2xl border border-dashed border-[#CBD5E1] p-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold uppercase text-[#64748B]">С</span>
                    <input className="neu-input w-40" type="date" value={exception.from} onChange={(event) => setException((c) => ({ ...c, from: event.target.value }))} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold uppercase text-[#64748B]">По</span>
                    <input className="neu-input w-40" type="date" value={exception.to} onChange={(event) => setException((c) => ({ ...c, to: event.target.value }))} />
                  </label>
                  <label className="flex items-center gap-2 text-sm font-semibold text-[#334155]">
                    <input type="checkbox" checked={exception.working} onChange={(event) => setException((c) => ({ ...c, working: event.target.checked }))} />
                    Особые часы
                  </label>
                  {exception.working ? (
                    <>
                      <input className="neu-input w-28" type="time" step={300} value={exception.start} onChange={(event) => setException((c) => ({ ...c, start: event.target.value }))} />
                      <input className="neu-input w-28" type="time" step={300} value={exception.end} onChange={(event) => setException((c) => ({ ...c, end: event.target.value }))} />
                    </>
                  ) : null}
                  <label className="block flex-1 min-w-[180px]">
                    <span className="mb-1 block text-xs font-bold uppercase text-[#64748B]">Причина</span>
                    <input className="neu-input w-full" value={exception.note} onChange={(event) => setException((c) => ({ ...c, note: event.target.value }))} placeholder="Отпуск, конференция…" />
                  </label>
                  <button type="button" className="neu-btn-primary px-4 py-2 text-sm" onClick={() => void addException()}>
                    Добавить
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </section>

      {formOpen ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.35)" }} onClick={() => setFormOpen(false)}>
          {/* max-h + overflow обязательны: без них на iPhone SE карточка выше
              экрана, а прокрутить нечем — ни заголовок, ни «Сохранить» не
              достать. Тот же приём, что у остальных модалок продукта. */}
          <div className="neu-card max-h-[90vh] w-full max-w-md overflow-y-auto bg-white p-5" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-black text-[#0F172A]">{editingId ? `Изменить ${terms.specialistGenitive}` : `Новый ${terms.specialist}`}</h3>
              <button type="button" className="neu-btn px-3 py-2" onClick={() => setFormOpen(false)} aria-label="Закрыть">
                <X size={15} />
              </button>
            </div>
            <div className="mt-4 grid gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-bold uppercase text-[#64748B]">ФИО</span>
                <input className="neu-input w-full" value={form.fullName} onChange={(event) => setForm((c) => ({ ...c, fullName: event.target.value }))} placeholder="Сауле Ахметова" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold uppercase text-[#64748B]">Специальность</span>
                <input className="neu-input w-full" value={form.specialty} onChange={(event) => setForm((c) => ({ ...c, specialty: event.target.value }))} placeholder="Косметолог" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold uppercase text-[#64748B]">Клиентов одновременно</span>
                <input
                  className="neu-input w-full"
                  inputMode="numeric"
                  value={form.capacity}
                  onChange={(event) => setForm((c) => ({ ...c, capacity: event.target.value }))}
                />
                {/*
                  Единица — обычный приём: второй клиент в тот же интервал будет
                  отклонён. Больше единицы имеет смысл там, где мастер и правда
                  ведёт нескольких: одному нанесена краска и он выдерживает,
                  второму в это время делают укладку.
                */}
                <span className="mt-1 block text-xs font-semibold text-[#64748B]">
                  1 — {terms.visit} один на один. Больше — столько записей {terms.specialist} может вести параллельно.
                </span>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold uppercase text-[#64748B]">Порядок в списке</span>
                <input className="neu-input w-full" inputMode="numeric" value={form.sortOrder} onChange={(event) => setForm((c) => ({ ...c, sortOrder: event.target.value }))} />
              </label>
              <label className="flex items-center gap-2 text-sm font-semibold text-[#334155]">
                <input type="checkbox" checked={form.isActive} onChange={(event) => setForm((c) => ({ ...c, isActive: event.target.checked }))} />
                Принимает — показывать в форме записи
              </label>
            </div>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="neu-btn px-4 py-2 text-sm" onClick={() => setFormOpen(false)}>Отмена</button>
              <button type="button" className="neu-btn-primary px-4 py-2 text-sm" disabled={saving} onClick={() => void submitDoctor()}>
                {saving ? "Сохраняем…" : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
