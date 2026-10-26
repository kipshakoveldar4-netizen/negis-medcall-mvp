export type OperatorProfile = {
  id: string;
  displayName: string;
  status: "pending" | "approved" | "suspended";
  acceptingRequests: boolean;
};

export type OperatorRequest = {
  id: string;
  displayName: string;
  clinicBrief: string;
  status: "requested" | "accepted" | "declined" | "ended";
  pricePerArrivalMinor: string | null;
  currency: string;
  leadScope: OperatorLeadScope;
};

export type OperatorLeadScope = "assigned" | "clinic";
export const operatorLeadScopeLabels = {
  assigned: "Только назначенные заявки",
  clinic: "Все заявки клиники",
} as const;
export type OperatorLead = {
  id: string;
  name: string;
  phone: string;
  status: string;
  stageId?: string | null;
  stageName?: string;
  source: string;
  createdAt: string;
  assigned?: boolean;
};

export type OperatorList<T> = { items: T[]; hasMore: boolean };
export type OperatorDoctor = { id: string; name: string; specialty: string };
export type OperatorBooking = {
  id: string;
  startsAt: string | null;
  service: string | null;
  doctorName: string | null;
  priceMinor: string | null;
  durationMinutes: number | null;
  status: keyof typeof operatorBookingStatusLabels | null;
  timeZone: string;
};
export const operatorBookingStatusLabels = {
  scheduled: "Запланировано", confirmed: "Подтверждено", arrived: "Пациент пришёл", no_show: "Не пришёл", cancelled: "Отменено",
} as const;
export type OperatorCommandAction = "propose" | "accept" | "decline" | "withdraw" | "end";
export type OperatorCommandResult =
  | { state: "unconfirmed"; commandId: string }
  | { state: "abandoned"; commandId: string; action: OperatorCommandAction; targetId: string; closedAt: string }
  | { state: "committed"; commandId: string; action: OperatorCommandAction; targetId: string; requestId: string;
      statusAtCommit: "requested" | "accepted" | "declined" | "ended"; committedAt: string };
const operatorCommandStatuses = { propose: "requested", accept: "accepted", decline: "declined", withdraw: "declined", end: "ended" } as const;
const BOOKING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bookingRow = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
function bookingTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,79}$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(0); return true; } catch { return false; }
}
function bookingInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || Number(parts[1]) === 0 || !Number.isFinite(Date.parse(value))) return false;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  calendar.setUTCHours(Number(parts[4]), Number(parts[5]), Number(parts[6]), 0);
  const actual = [calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(),
    calendar.getUTCHours(), calendar.getUTCMinutes(), calendar.getUTCSeconds()];
  return actual.every((part, index) => part === Number(parts[index + 1]));
}
export function parseOperatorCommandResult(value: unknown, commandId: string,
  expected?: { action: OperatorCommandAction; targetId: string }): OperatorCommandResult | null {
  const row = bookingRow(value);
  if (!row || !BOOKING_UUID.test(commandId) || typeof row.commandId !== "string"
    || row.commandId.toLowerCase() !== commandId.toLowerCase()) return null;
  if (row.state === "unconfirmed") return ["action", "targetId", "requestId", "statusAtCommit", "committedAt", "closedAt"].some(name => Object.hasOwn(row, name))
    ? null : { state: row.state, commandId: commandId.toLowerCase() };
  if (typeof row.action !== "string" || !Object.hasOwn(operatorCommandStatuses, row.action)
    || typeof row.targetId !== "string" || !BOOKING_UUID.test(row.targetId)
    || (expected && (row.action !== expected.action || row.targetId.toLowerCase() !== expected.targetId.toLowerCase()))) return null;
  const action = row.action as OperatorCommandAction;
  const base = { commandId: commandId.toLowerCase(), action, targetId: row.targetId.toLowerCase() };
  if (row.state === "abandoned" && bookingInstant(row.closedAt)
    && !["requestId", "statusAtCommit", "committedAt"].some(name => Object.hasOwn(row, name))) return { ...base, state: row.state, closedAt: row.closedAt };
  if (row.state !== "committed" || typeof row.requestId !== "string" || !BOOKING_UUID.test(row.requestId)
    || Object.hasOwn(row, "closedAt")
    || (action !== "propose" && row.requestId.toLowerCase() !== base.targetId)
    || row.statusAtCommit !== operatorCommandStatuses[action] || !bookingInstant(row.committedAt)) return null;
  return { ...base, state: row.state, requestId: row.requestId.toLowerCase(), statusAtCommit: operatorCommandStatuses[action], committedAt: row.committedAt };
}
export function parseOperatorBookingContext(value: unknown): { timeZone: string | null } | null {
  const row = bookingRow(value);
  return row && (row.timeZone === null || bookingTimeZone(row.timeZone)) ? { timeZone: row.timeZone } : null;
}
export function parseOperatorBooking(value: unknown, expectedRequestKey: string, expectedTimeZone: string): OperatorBooking | null {
  const row = bookingRow(value);
  // A replay reads the current appointment: explicit cleared fields are not a
  // partial response. Creation limits still belong to the booking mutation.
  if (typeof expectedRequestKey !== "string" || !BOOKING_UUID.test(expectedRequestKey.trim()) || !row
    || typeof row.id !== "string" || !BOOKING_UUID.test(row.id) || row.id.toLowerCase() !== expectedRequestKey.trim().toLowerCase()
    || (row.startsAt !== null && !bookingInstant(row.startsAt)) || !bookingTimeZone(row.timeZone) || row.timeZone !== expectedTimeZone
    || (row.service !== null && typeof row.service !== "string") || (row.doctorName !== null && typeof row.doctorName !== "string")
    || (row.priceMinor !== null && (typeof row.priceMinor !== "string" || row.priceMinor.trim() !== row.priceMinor
      || !/^(0|[1-9]\d{0,18})$/.test(row.priceMinor) || BigInt(row.priceMinor) > 9_223_372_036_854_775_807n))
    || (row.durationMinutes !== null && (typeof row.durationMinutes !== "number" || !Number.isInteger(row.durationMinutes)
      || row.durationMinutes < 1 || row.durationMinutes > 2_147_483_647))
    || (row.status !== null && (typeof row.status !== "string" || !Object.hasOwn(operatorBookingStatusLabels, row.status)))) return null;
  return { id: row.id.toLowerCase(), startsAt: row.startsAt, timeZone: row.timeZone, service: row.service,
    doctorName: row.doctorName, priceMinor: row.priceMinor, durationMinutes: row.durationMinutes,
    status: row.status as OperatorBooking["status"] };
}
export type OperatorArrivalCheckResult =
  | "confirmed"
  | "unconfirmed"
  | "unreachable";
export type OperatorArrival = {
  appointmentId: string;
  arrivalId: string | null;
  clientName: string;
  clientPhone?: string;
  startsAt: string;
  service: string;
  doctorName: string;
  status: string;
  priceMinor: string | null;
  currency: string | null;
  clinicConfirmedAt: string | null;
  operatorCheckedAt: string | null;
  operatorCheckResult: OperatorArrivalCheckResult | null;
};
export type OperatorService = {
  id: string;
  name: string;
  priceMinor: string | null;
  currency: string;
  durationMinutes: number | null;
};
export type OperatorLeadStage = { id: string; name: string };
export type OperatorLeadList = OperatorList<OperatorLead> & {
  stages?: OperatorLeadStage[];
  stageEditingAvailable?: boolean;
};
export const OPERATOR_PAGE_SIZE = 20;
export const operatorStatusLabels = {
  pending: "На проверке платформы",
  approved: "Одобрен",
  suspended: "Приостановлен",
  requested: "Ожидает ответа",
  accepted: "Сотрудничество подтверждено",
  declined: "Отклонено",
  ended: "Завершено",
} as const;

export const operatorArrivalCheckLabels: Record<
  OperatorArrivalCheckResult,
  string
> = {
  confirmed: "Пациент подтвердил приход",
  unconfirmed: "Пациент не подтвердил приход",
  unreachable: "Не удалось дозвониться",
};

// Decimal input and formatting never round an agreed price through floating point.
export function arrivalPriceToMinor(value: string): string | null {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d{1,14}(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? minor.toString() : null;
}

export function formatArrivalPrice(
  minor: string | null,
  currency: string,
): string {
  if (minor === null || !/^\d+$/.test(minor)) return "Цена не согласована";
  const value = BigInt(minor);
  const fraction = (value % 100n).toString().padStart(2, "0");
  return `${(value / 100n).toLocaleString("ru-RU")}${fraction === "00" ? "" : `,${fraction}`} ${currency === "KZT" ? "₸" : currency}`;
}
