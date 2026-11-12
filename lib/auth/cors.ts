import type { VercelRequest, VercelResponse } from "@vercel/node";

// Кросс-доменный доступ к /api/crm/* для портала Medina Control.
//
// CRM и API живут на одном домене, поэтому до появления портала CORS здесь не
// существовал вовсе — и для всех, кроме перечисленных в переменной окружения
// адресов, его по-прежнему нет. Пустой список означает «как раньше»: ни
// заголовков, ни ответа на preflight. Это то же умолчание-отказ, что и у
// списка владельцев платформы: браузерная политика — не замок, но и снимать
// её для всего интернета незачем.
//
// Разрешение по Origin не заменяет авторизацию: каждый запрос всё так же несёт
// Bearer-токен, и сервер проверяет его тем же путём, что и раньше. CORS лишь
// позволяет браузеру портала этот запрос отправить.

export const CONTROL_ORIGINS_ENV = "MEDINA_CONTROL_ORIGINS";

/**
 * Разбор списка разрешённых источников.
 *
 * Принимаются только полные origin вида https://host[:port] — без пути и без
 * завершающего слэша. Всё, что не разобралось как URL, отбрасывается молча:
 * опечатка в файле развёртывания не должна ни открывать «*», ни печататься.
 */
export function parseControlOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    const candidate = token.trim();
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      // origin отбрасывает путь и слэш сам; сравнение дальше — строгое.
      seen.add(url.origin);
    } catch {
      continue;
    }
  }
  return Array.from(seen);
}

function requestOrigin(req: VercelRequest): string {
  const header = req.headers.origin;
  return typeof header === "string" ? header : "";
}

export type ControlCorsOutcome = "none" | "allowed" | "preflight";

/**
 * Применяет CORS-заголовки, если источник запроса в списке.
 *
 * Возвращает «preflight», когда это OPTIONS от разрешённого источника: такой
 * запрос надо завершить пустым 204 до всякой авторизации — предзапрос браузера
 * не несёт токена по определению, и требовать его значило бы запретить порталу
 * вообще всё. Для источников не из списка не меняется ничего, включая ответ
 * на OPTIONS: снаружи по-прежнему невозможно узнать, что список существует.
 */
export function applyControlCors(
  req: VercelRequest,
  res: VercelResponse,
  env: NodeJS.ProcessEnv = process.env,
): ControlCorsOutcome {
  const allowed = parseControlOrigins(env[CONTROL_ORIGINS_ENV]);
  if (allowed.length === 0) return "none";

  const origin = requestOrigin(req);
  if (!origin || !allowed.includes(origin)) return "none";

  // Конкретный origin, не «*»: ответ кэшируется по Vary и не достаётся другим.
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");

  if ((req.method || "").toUpperCase() === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    return "preflight";
  }

  return "allowed";
}
