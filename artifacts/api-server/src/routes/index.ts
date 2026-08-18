import { Router } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import webhookRouter from "./webhook";
import impersonationRouter from "./impersonation";
import adsTikTokRouter from "./ads-tiktok";

// ВНИМАНИЕ. У этого express-приложения нет ни одного слоя авторизации:
// app.ts подключает только cors() и парсеры тела. Поэтому здесь подключается
// ровно то, что либо безопасно без авторизации, либо проверяет подпись само.
//
// Отключены и не подключаются обратно без разбора:
//
//   auth-reset      — POST /api/auth/reset-password СБРАСЫВАЛ пароль любому по
//                     одной лишь почте: находил пользователя и тут же ставил
//                     ему случайный временный пароль. Кто угодно мог выкинуть
//                     владельца клиники из его же кабинета. С логинами это
//                     стало бы вдвойне опасно: адрес выводится из имени.
//   auth-register   — создавал аккаунт, клинику и владельца без единой
//                     проверки. В основном приложении этот путь закрыт
//                     намеренно (api/auth/register.ts отвечает 410, пин I28),
//                     а здесь он оставался открытым чёрным ходом.
//   employees       — CRUD сотрудников без авторизации.
//   test-auth       — POST /api/test/login, тестовый вход в проде.
//
// Ни один из них не вызывается ни фронтендом, ни порталом платформы: это
// остатки времён до Security-2. Возвращать что-то из этого можно только вместе
// с проверкой JWT и членства, как это сделано в lib/auth/server.ts.

const router = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(webhookRouter);
router.use(impersonationRouter);
router.use(adsTikTokRouter);

export default router;
