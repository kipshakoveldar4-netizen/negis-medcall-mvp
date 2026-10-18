import { dayKeyInZone } from "./clinicDay";
import { formatSlot, minuteOfClinicDay } from "./dayGrid";

export function requireWorkspaceTimeZone(timeZone: string): string {
  if (!timeZone) throw new Error("Сервер не вернул часовой пояс рабочего пространства.");
  try { new Intl.DateTimeFormat("en-GB", { timeZone }).format(0); }
  catch { throw new Error("Сервер вернул неверный часовой пояс рабочего пространства."); }
  return timeZone;
}

export function workspaceLocalDateTime(iso: string | null | undefined, timeZone: string): string {
  requireWorkspaceTimeZone(timeZone);
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  const minute = minuteOfClinicDay(iso, timeZone);
  return minute === null ? "" : `${dayKeyInZone(Date.parse(iso), timeZone)}T${formatSlot(minute)}`;
}

export function workspaceDateTimeToIso(local: string, timeZone: string, unchangedIso?: string | null): string {
  requireWorkspaceTimeZone(timeZone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error("Укажите дату и время.");
  const wall = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== local) throw new Error("Проверьте дату и время.");
  if (unchangedIso && workspaceLocalDateTime(unchangedIso, timeZone) === local) return unchangedIso;
  // Reuse the calendar's existing offset probes, never the device's wall clock.
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = wall + hours * 3_600_000;
    const formatted = workspaceLocalDateTime(new Date(instant).toISOString(), timeZone);
    offsets.add(Date.parse(`${formatted}:00Z`) - instant);
  }
  const candidates = [...offsets].map((offset) => wall - offset)
    .filter((instant) => workspaceLocalDateTime(new Date(instant).toISOString(), timeZone) === local);
  if (candidates.length === 0) throw new Error("Это время отсутствует из-за перевода часов. Выберите другое время.");
  if (candidates.length !== 1) throw new Error("Это время повторяется из-за перевода часов. Выберите другое время.");
  return new Date(candidates[0]).toISOString();
}
