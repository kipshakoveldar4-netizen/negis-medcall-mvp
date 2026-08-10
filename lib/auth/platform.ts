import type { VercelRequest } from "@vercel/node";

import { requireAuthenticatedUser } from "./server";

/**
 * Отказ панели платформы.
 *
 * Свой тип, а не WorkspaceAdminAuthError: у того статус ограничен 401/403/503,
 * а здесь нужен именно 404 — существование панели тоже сведения, и владельцу
 * клиники незачем знать, что в продукте есть экран со списком всех клиник.
 */
export class PlatformAuthError extends Error {
  readonly statusCode = 404;
  readonly code = "not_found";

  constructor() {
    super("Not found");
    this.name = "PlatformAuthError";
  }
}

// Владелец платформы — не роль.
//
// Все шесть ролей продукта живут в staff_users и привязаны к одному рабочему
// пространству; `owner` — это владелец КЛИНИКИ, и выше него в модели нет
// ничего. Панель платформы по определению читает поперёк арендаторов, то есть
// делает ровно то, что весь предыдущий этап безопасности запрещал.
//
// Поэтому доступ к ней не выдаётся ролью и не хранится в базе. Роль в базе
// правит владелец клиники — он администратор своего пространства и может
// назначать роли; значит роль «владелец платформы» он рано или поздно назначит
// себе, и никакая проверка внутри приложения этому не помешает. Список же в
// переменной окружения правит только тот, у кого есть доступ к настройкам
// развёртывания. Это единственная граница, которую нельзя перейти изнутри
// продукта.
//
// Тот же приём уже применён к фоновому работнику Meta Insights: подпись HMAC
// плюс список разрешённых рабочих пространств в переменной окружения
// (lib/auth/worker.ts). Здесь список — идентификаторы пользователей Supabase.
//
// Значение переменной никуда не выводится: ни в ответ, ни в лог, ни в текст
// ошибки. Отказ говорит «нет доступа», а не «вас нет в списке из N человек».

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PLATFORM_OWNER_ENV = "MEDINA_PLATFORM_OWNER_IDS";

/**
 * Разбор списка владельцев платформы.
 *
 * Принимает идентификаторы через запятую или пробел. Всё, что не похоже на
 * UUID, отбрасывается молча: строка «замените_меня» в файле развёртывания не
 * должна становиться пропуском, а сообщать о её содержимом нельзя.
 */
export function parsePlatformOwnerIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    const candidate = token.trim().toLowerCase();
    if (candidate && UUID_PATTERN.test(candidate)) seen.add(candidate);
  }
  return Array.from(seen);
}

export function platformOwnerIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return parsePlatformOwnerIds(env[PLATFORM_OWNER_ENV]);
}

export type PlatformOwnerContext = {
  userId: string;
  email: string;
};

/**
 * Пропускает только владельца платформы.
 *
 * Порядок проверок значим. Сперва — подлинность токена (тот же путь, что и у
 * любого другого маршрута), и только потом — принадлежность к списку. Обратный
 * порядок позволил бы неаутентифицированному запросу узнать, пуст список или
 * нет, по разнице между ответами.
 *
 * Пустой список означает «панель выключена», а не «пускать всех». Умолчание
 * здесь — единственное, что стоит между владельцем клиники и данными всех
 * остальных клиник, и оно обязано быть отказом.
 */
export async function requirePlatformOwner(req: VercelRequest): Promise<PlatformOwnerContext> {
  const user = await requireAuthenticatedUser(req);

  const allowed = platformOwnerIds();
  if (allowed.length === 0) throw new PlatformAuthError();
  if (!allowed.includes(String(user.id).toLowerCase())) throw new PlatformAuthError();

  return { userId: String(user.id), email: String(user.email || "") };
}
