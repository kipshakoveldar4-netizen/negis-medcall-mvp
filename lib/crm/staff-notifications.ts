// Кому и о чём шлём пуш сотруднику. Чистые правила, без запросов и отправки.
//
// Разделение то же, что у lib/crm/reminders.ts: решение «кому и что» проверяется
// тестом целиком, а доставка — тонкий слой вокруг. Иначе правило адресации можно
// было бы проверить только наблюдением за живыми мастерами.

import { clinicTimeLabel } from "./reminders";
import { redactContacts } from "./contact-privacy";

export type StaffNotificationEvent = "created" | "cancelled" | "rescheduled";

export interface AppointmentSnapshot {
  doctorId: string;
  doctorName: string;
  client: string;
  service: string;
  startsAt: string;
}

export interface DoctorCard {
  id: string;
  fullName: string;
  staffUserId: string;
}

export type RecipientDecision =
  | { staffUserId: string }
  | { skipped: string };

/** Не более пяти устройств на событие: у мастера обычно одно-два. */
export const MAX_ENDPOINTS_PER_EVENT = 5;
/** Общий бюджет отправки: функция отвечает после неё, тянуть нельзя. */
export const PUSH_SEND_BUDGET_MS = 3000;

/**
 * Кому адресовано событие.
 *
 * Правило целиком, включая все причины отказа — их видно в логе оператора, и по
 * ним же строится подсказка в интерфейсе («мастер не связан с учётной записью»
 * означает, что уведомления ему не дойдут никогда, пока карточку не связали).
 */
export function resolveRecipient(input: {
  appointment: AppointmentSnapshot;
  doctors: readonly DoctorCard[];
  actorStaffUserId: string;
  nowMs: number;
}): RecipientDecision {
  const { appointment, doctors, actorStaffUserId, nowMs } = input;

  const startsAtMs = Date.parse(appointment.startsAt);
  if (!Number.isFinite(startsAtMs)) return { skipped: "время визита не разобрано" };
  // О прошедшем визите уведомлять нечего: это перенос истории, а не новость.
  if (startsAtMs <= nowMs) return { skipped: "визит уже прошёл" };

  let card: DoctorCard | undefined;
  if (appointment.doctorId) {
    card = doctors.find((doctor) => doctor.id === appointment.doctorId);
    if (!card) return { skipped: "карточка мастера не найдена" };
  } else {
    // Вся история до 033 и любая строка, у которой деградация сняла колонку
    // doctor_id, знает мастера только по имени.
    const name = appointment.doctorName.trim().toLowerCase();
    if (!name) return { skipped: "мастер не указан" };
    const matches = doctors.filter((doctor) => doctor.fullName.trim().toLowerCase() === name);
    // Два совпадения — не отправляем НИКОМУ. В салоне две Дильназ, и уведомление
    // о клиенте одной, ушедшее другой, — это утечка, а не неудобство.
    if (matches.length !== 1) return { skipped: matches.length === 0 ? "мастер не найден по имени" : "имя неоднозначно" };
    card = matches[0];
  }

  if (!card.staffUserId) return { skipped: "мастер не связан с учётной записью" };
  if (card.staffUserId === actorStaffUserId) return { skipped: "сам себе" };
  return { staffUserId: card.staffUserId };
}

export interface StaffNotification {
  title: string;
  text: string;
  url: string;
  tag: string;
}

/**
 * Текст уведомления.
 *
 * Телефон, WhatsApp и заметка не попадают сюда ни одним полем: уведомление видно
 * на экране блокировки любому, кто взял телефон в руки. Готовый объект всё равно
 * прогоняется через redactContacts с ролью мастера — на случай, если однажды
 * кто-то добавит в текст заметку, где администратор написал «перезвонить на +7…».
 */
export function notificationFor(input: {
  event: StaffNotificationEvent;
  appointment: AppointmentSnapshot;
  timeZone: string;
  clientNameVisible?: boolean;
}): StaffNotification | null {
  const { event, appointment, timeZone } = input;
  const when = clinicTimeLabel(appointment.startsAt, timeZone);
  if (!when) return null;

  const clientNameVisible = input.clientNameVisible !== false;
  const client = clientNameVisible ? appointment.client.trim() : "";
  const service = appointment.service.trim();

  const title = event === "created" ? "Новая запись" : event === "rescheduled" ? "Запись перенесена" : "Запись отменена";
  const parts = [when];
  if (client) parts.push(client);
  if (service) parts.push(service);

  const draft: Record<string, unknown> = {
    title,
    text: parts.join(" · "),
    // Экран записей на нужном дне: уведомление без места, куда нажать, заставляет
    // искать запись руками.
    url: `/appointments?date=${appointment.startsAt.slice(0, 10)}`,
    // Один tag на визит и событие: два уведомления об одной отмене не нужны.
    tag: `appointment:${event}:${appointment.startsAt}`,
  };
  return redactContacts(draft, "doctor") as unknown as StaffNotification;
}
