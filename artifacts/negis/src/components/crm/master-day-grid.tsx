import { useMemo } from "react";
import {
  gridBounds,
  minuteOfClinicDay,
  placeColumn,
  workingIntervals,
  type GridAppointment,
  type GridShift,
} from "../../lib/dayGrid";

/**
 * Общая сетка дня: колонка на мастера, запись — прямоугольник.
 *
 * Владелец салона попросил календарь, где видно сразу всех мастеров: «все
 * записи всех мастеров, чтобы только владелец и админы видели общую
 * информацию». Список по времени этого не даёт — в нём не видно, у кого день
 * забит, а у кого пусто, и куда ещё влезет клиент.
 *
 * Кто это видит, решает не компонент: экран показывает его владельцу и
 * администратору. Мастеру общий календарь не показывается, и это то же
 * правило, что и в остальном продукте, — его записи ему сервер и так сузил.
 *
 * Вся арифметика — в lib/dayGrid.ts и покрыта тестами. Здесь только разметка.
 */

export type GridDoctor = { id: string; fullName: string; specialty: string };

type Props = {
  dateKey: string;
  isoWeekday: number;
  timeZone: string;
  doctors: readonly GridDoctor[];
  shifts: readonly GridShift[];
  appointments: readonly (GridAppointment & {
    client: string;
    service: string;
    status: string;
    notes: string;
  })[];
  /** Минута «сейчас» в поясе клиники, если показан сегодняшний день. */
  nowMinute: number | null;
  onOpen: (id: string) => void;
  specialistPlural: string;
};

/** Высота часа. Меньше — подписи не читаются на телефоне, больше — день не помещается. */
const HOUR_HEIGHT = 64;
const MINUTE = HOUR_HEIGHT / 60;

/** Цвет блока говорит о статусе — то же значение, что и у бейджа в списке. */
const STATUS_TONE: Record<string, { bar: string; bg: string; text: string }> = {
  scheduled: { bar: "#22c55e", bg: "rgba(34,197,94,0.12)", text: "#14532d" },
  confirmed: { bar: "#16a34a", bg: "rgba(22,163,74,0.16)", text: "#14532d" },
  arrived: { bar: "#0ea5e9", bg: "rgba(14,165,233,0.14)", text: "#0c4a6e" },
  done: { bar: "#64748b", bg: "rgba(100,116,139,0.12)", text: "#334155" },
  cancelled: { bar: "#94a3b8", bg: "rgba(148,163,184,0.10)", text: "#475569" },
  no_show: { bar: "#f97316", bg: "rgba(249,115,22,0.14)", text: "#7c2d12" },
};

const toneFor = (status: string) => STATUS_TONE[status] ?? STATUS_TONE.scheduled;

const formatMinute = (minute: number) => {
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

export function MasterDayGrid({
  dateKey,
  isoWeekday,
  timeZone,
  doctors,
  shifts,
  appointments,
  nowMinute,
  onOpen,
  specialistPlural,
}: Props) {
  const columns = useMemo(() => {
    // Записи без ссылки на карточку мастера — отдельная колонка, а не пропажа.
    // Свободный ввод имени в продукте законен, и вся история до 033 такая.
    const byDoctor = new Map<string, typeof appointments[number][]>();
    for (const item of appointments) {
      const key = item.doctorId || "";
      const bucket = byDoctor.get(key);
      if (bucket) bucket.push(item);
      else byDoctor.set(key, [item]);
    }

    const known = doctors.map((doctor) => ({
      doctor,
      items: byDoctor.get(doctor.id) ?? [],
    }));
    const loose = byDoctor.get("") ?? [];
    return loose.length > 0
      ? [...known, { doctor: { id: "", fullName: "Без карточки", specialty: "имя вписано вручную" }, items: loose }]
      : known;
  }, [appointments, doctors]);

  const placedColumns = useMemo(
    () => columns.map((column) => ({
      ...column,
      ...placeColumn(column.items, timeZone),
      intervals: workingIntervals(shifts, column.doctor.id, dateKey, isoWeekday),
    })),
    [columns, dateKey, isoWeekday, shifts, timeZone],
  );

  const [dayStart, dayEnd] = useMemo(() => {
    const starts = placedColumns.flatMap((column) => column.placed.flatMap((entry) => [entry.startMinute, entry.endMinute]));
    const intervals = placedColumns.flatMap((column) => column.intervals);
    return gridBounds(starts, intervals);
  }, [placedColumns]);

  const hours = useMemo(() => {
    const list: number[] = [];
    for (let minute = dayStart; minute <= dayEnd; minute += 60) list.push(minute);
    return list;
  }, [dayEnd, dayStart]);

  // Получасовые линии без подписей. Салон записывает на «в половине третьего»
  // чаще, чем на ровный час, и по часовой сетке такой блок не с чем сверить
  // глазом: он просто висит между линиями. Подписи у них нет намеренно —
  // цифры каждые полчаса на телефоне превращают шкалу в кашу.
  const halfHours = useMemo(() => {
    const list: number[] = [];
    for (let minute = dayStart + 30; minute < dayEnd; minute += 60) list.push(minute);
    return list;
  }, [dayEnd, dayStart]);

  const height = (dayEnd - dayStart) * MINUTE;
  const unreadable = placedColumns.flatMap((column) => column.unreadable);

  if (doctors.length === 0) {
    return (
      <section className="negis-glass p-6 text-center">
        <p className="text-sm font-black" style={{ color: "var(--negis-text)" }}>Справочник {specialistPlural} пуст</p>
        <p className="mt-2 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>
          Колонки в календаре — это карточки {specialistPlural}. Заведите их в справочнике, и день соберётся сам.
        </p>
      </section>
    );
  }

  return (
    <section className="negis-glass p-3 sm:p-4">
      <div className="overflow-x-auto">
        <div className="flex min-w-max">
          {/* Часы слева. Отдельная колонка, а не подписи внутри: иначе они
              уезжают вместе с горизонтальной прокруткой и день теряет шкалу. */}
          <div className="sticky left-0 z-20 w-12 flex-none" style={{ background: "var(--negis-surface)" }}>
            <div className="h-12" />
            <div className="relative" style={{ height }}>
              {hours.map((minute) => (
                <div
                  key={minute}
                  className="absolute right-2 -translate-y-1/2 text-[11px] font-black tabular-nums"
                  style={{ top: (minute - dayStart) * MINUTE, color: "var(--negis-muted)" }}
                >
                  {formatMinute(minute)}
                </div>
              ))}
            </div>
          </div>

          {placedColumns.map((column) => (
            <div key={column.doctor.id || "loose"} className="w-36 flex-none border-l" style={{ borderColor: "var(--negis-border)" }}>
              <div className="flex h-12 flex-col justify-center px-2">
                <span className="truncate text-sm font-black" style={{ color: "var(--negis-text)" }}>
                  {column.doctor.fullName}
                </span>
                <span className="truncate text-[11px] font-bold" style={{ color: "var(--negis-muted)" }}>
                  {column.doctor.specialty || "—"}
                </span>
              </div>

              <div className="relative" style={{ height, background: "var(--negis-surface)" }}>
                {/* Нерабочее время закрашено: пустая белая клетка и «мастер не
                    принимает» на экране выглядят одинаково, а значат разное. */}
                {column.intervals.length > 0 ? (
                  <div className="absolute inset-0" style={{ background: "rgba(148,163,184,0.18)" }}>
                    {column.intervals.map(([from, to]) => (
                      <div
                        key={`${from}-${to}`}
                        className="absolute inset-x-0"
                        style={{
                          top: (Math.max(from, dayStart) - dayStart) * MINUTE,
                          height: (Math.min(to, dayEnd) - Math.max(from, dayStart)) * MINUTE,
                          background: "var(--negis-surface)",
                        }}
                      />
                    ))}
                  </div>
                ) : null}

                {hours.map((minute) => (
                  <div
                    key={minute}
                    className="absolute inset-x-0 border-t"
                    style={{ top: (minute - dayStart) * MINUTE, borderColor: "var(--negis-border)" }}
                  />
                ))}
                {halfHours.map((minute) => (
                  <div
                    key={`half-${minute}`}
                    className="absolute inset-x-0 border-t"
                    style={{ top: (minute - dayStart) * MINUTE, borderColor: "var(--negis-border)", opacity: 0.45 }}
                  />
                ))}

                {column.placed.map((entry) => {
                  const tone = toneFor(entry.item.status);
                  const width = 100 / entry.lanes;
                  return (
                    <button
                      key={entry.item.id}
                      type="button"
                      onClick={() => onOpen(entry.item.id)}
                      className="absolute overflow-hidden rounded-lg px-1.5 py-1 text-left"
                      style={{
                        top: (entry.startMinute - dayStart) * MINUTE,
                        height: Math.max((entry.endMinute - entry.startMinute) * MINUTE - 2, 18),
                        left: `${entry.lane * width}%`,
                        width: `calc(${width}% - 3px)`,
                        background: tone.bg,
                        borderLeft: `3px solid ${tone.bar}`,
                        color: tone.text,
                      }}
                      title={`${formatMinute(entry.startMinute)} · ${entry.item.client}${entry.item.service ? ` · ${entry.item.service}` : ""}`}
                    >
                      <span className="block text-[11px] font-black tabular-nums">{formatMinute(entry.startMinute)}</span>
                      <span className="block truncate text-[12px] font-black">{entry.item.client || "Без имени"}</span>
                      {entry.item.service ? (
                        <span className="block truncate text-[11px] font-semibold opacity-80">{entry.item.service}</span>
                      ) : null}
                    </button>
                  );
                })}

                {nowMinute !== null && nowMinute >= dayStart && nowMinute <= dayEnd ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2"
                    style={{ top: (nowMinute - dayStart) * MINUTE, borderColor: "#ef4444" }}
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      {unreadable.length > 0 ? (
        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-black text-amber-900">Вне сетки: {unreadable.length}</p>
          <p className="mt-1 text-xs font-semibold text-amber-800">
            У этих записей не удалось прочитать время, поэтому места на сетке у них нет. Счётчик их считает,
            чтобы они не исчезли молча.
          </p>
          <ul className="mt-2 space-y-1 text-sm font-semibold text-amber-900">
            {unreadable.map((item) => (
              <li key={item.id}>{item.doctor || "без мастера"} · {item.startsAt || "время не задано"}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export { minuteOfClinicDay };
