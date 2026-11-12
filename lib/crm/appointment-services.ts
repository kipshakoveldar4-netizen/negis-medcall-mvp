export type AppointmentServiceItem = {
  serviceId: string;
  name: string;
  priceMinor: number | null;
  durationMinutes: number;
};

export const MAX_APPOINTMENT_SERVICES = 20;
const MAX_PRICE = 10_000_000_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeAppointmentServices(
  value: unknown,
): AppointmentServiceItem[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_APPOINTMENT_SERVICES
  ) {
    throw new Error("Выберите от 1 до 20 услуг.");
  }
  const seen = new Set<string>();
  const items = value.map((raw): AppointmentServiceItem => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Проверьте список услуг.");
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const serviceId =
      typeof item.serviceId === "string" ? item.serviceId.trim() : "";
    if (!name || name.length > 200)
      throw new Error("Укажите название каждой услуги, не более 200 символов.");
    if (
      (item.serviceId != null && typeof item.serviceId !== "string") ||
      (serviceId && !UUID.test(serviceId))
    )
      throw new Error("Проверьте выбранную услугу.");
    if (serviceId && seen.has(serviceId))
      throw new Error("Эта услуга уже добавлена в запись.");
    if (serviceId) seen.add(serviceId);
    const price = item.priceMinor;
    if (
      price !== null &&
      (typeof price !== "number" ||
        !Number.isSafeInteger(price) ||
        price < 0 ||
        price > MAX_PRICE)
    )
      throw new Error("Проверьте цену каждой услуги.");
    const minutes = item.durationMinutes;
    if (
      typeof minutes !== "number" ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > 600
    )
      throw new Error("Укажите длительность каждой услуги от 1 до 600 минут.");
    return {
      serviceId,
      name,
      priceMinor: price as number | null,
      durationMinutes: minutes,
    };
  });
  const total = summarizeAppointmentServices(items);
  if (total.durationMinutes > 600)
    throw new Error("Общая длительность записи не должна превышать 600 минут.");
  if (items.reduce((sum, item) => sum + (item.priceMinor ?? 0), 0) > MAX_PRICE)
    throw new Error("Общая цена записи слишком велика.");
  return items;
}

export function readAppointmentServices(
  value: unknown,
): AppointmentServiceItem[] {
  if (!Array.isArray(value) || !value.length) return [];
  return normalizeAppointmentServices(value);
}

export function summarizeAppointmentServices(
  items: readonly AppointmentServiceItem[],
) {
  return {
    service: items.map((item) => item.name).join(" + "),
    // A multi-service sale must not be attributed in full to just its first service.
    serviceId: items.length === 1 ? items[0].serviceId : "",
    durationMinutes: items.reduce((sum, item) => sum + item.durationMinutes, 0),
    priceMinor:
      items.length && items.every((item) => item.priceMinor !== null)
        ? items.reduce((sum, item) => sum + (item.priceMinor ?? 0), 0)
        : null,
  };
}

export function appointmentPriceFromInput(input: string): number | null {
  const normalized = input.trim().replace(",", ".");
  if (!normalized) return null;
  if (!/^\d{1,9}(?:\.\d{0,2})?$/.test(normalized))
    throw new Error(
      "Цена должна быть числом, не более двух знаков после запятой.",
    );
  const [whole, fraction = ""] = normalized.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (minor > MAX_PRICE) throw new Error("Цена слишком велика.");
  return minor;
}
