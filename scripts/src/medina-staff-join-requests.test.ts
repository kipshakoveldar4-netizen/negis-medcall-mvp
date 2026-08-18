import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// J — третий путь зачисления: человек просится сам по коду клиники.
//
// Два первых пути начинает клиника (приглашение по почте и логин с паролем из
// рук в руки). Этот начинает человек, и потому у него другие опасности: он
// открыт любому аутентифицированному, он называет клинику по коду, и он
// заканчивается созданием членства. Пины держат ровно эти три границы.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "crm", "join-codes.ts");
const handlerPath = path.join(repoRoot, "lib", "crm", "staff-join-requests.ts");

type CodesModule = {
  generateJoinCode: (name: unknown) => string;
  normalizeJoinCode: (raw: unknown) => string;
  isJoinCodeShape: (value: string) => boolean;
  formatJoinCode: (stored: unknown) => string;
  joinCodePrefix: (name: unknown) => string;
};

const codes = (await import(pathToFileURL(modulePath).href)) as CodesModule;

/** Пины цепляются за код, а не за прозу: комментарии вырезаем. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("J1 код читается голосом, из криптоисточника и с настоящей энтропией", async () => {
  const code = codes.generateJoinCode("Медина Астана");
  assert.ok(codes.isJoinCodeShape(code), `сгенерированный код держит форму: ${code}`);
  assert.equal(code.slice(0, 4), "MEDI", "префикс берётся из названия — код узнают на слух");
  assert.equal(codes.joinCodePrefix("!!"), "MEDI", "название без букв — запасной префикс");
  // Ожидаемое значение выше совпадает с ЗАПАСНЫМ, поэтому само по себе оно
  // ничего не доказывает: `return FALLBACK_PREFIX` первой строкой прошёл бы.
  // Нужна клиника, чей префикс не равен запасному.
  assert.equal(codes.joinCodePrefix("Ажар"), "AZAR", "транслит работает, а не подменяется запасным");
  assert.equal(codes.generateJoinCode("Ажар").slice(0, 4), "AZAR");

  const secret = code.slice(4);
  assert.equal(secret.length, 8, "восемь знаков — это ≈40 бит; «MEDI-7431» из разговора было бы 10 000 вариантов");
  assert.ok(!/[ILO01]/.test(secret), "спутываемых символов в секретной части нет");

  const many = new Set(Array.from({ length: 50 }, () => codes.generateJoinCode("Медина")));
  assert.equal(many.size, 50, "коды не повторяются");

  // Энтропию держит источник случайности, и его надо пинить прямо: Math.random
  // дал бы ту же форму, тот же префикс и 50 различных значений — все ассерты
  // выше остались бы зелёными, а код стал бы предсказуемым.
  const source = stripComments(await readFile(modulePath, "utf8"));
  assert.ok(/globalThis\.crypto\.getRandomValues\(/.test(source), "секретная часть — из Web Crypto");
  assert.ok(!/Math\.random/.test(source), "Math.random в генераторе кода недопустим");
  // Отбраковка байтов от 248: без неё 256 % 31 = 8 перекосили бы алфавит.
  assert.ok(/byte >= limit/.test(source), "перекос алфавита убран отбраковкой, и это тоже прибито");
});

test("J2 ввод нормализуется, но спутываемые символы не подменяются", () => {
  assert.equal(codes.normalizeJoinCode(" medi-7k3n q82r "), "MEDI7K3NQ82R", "регистр, пробелы и дефисы значения не имеют");
  assert.equal(codes.formatJoinCode("MEDI7K3NQ82R"), "MEDI-7K3N-Q82R", "показывается группами — так диктуют");
  assert.equal(codes.formatJoinCode("me"), "ME", "маска работает и на половине набора");
  assert.equal(codes.normalizeJoinCode("MEDI-7K3N-Q82RXXXX").length, 16, "нормализация ничего не режет");
  assert.equal(codes.formatJoinCode("MEDI7K3NQ82RXXXX"), "MEDI-7K3N-Q82R", "а маска не даёт набрать больше кода");

  // Подмена I→1 и O→0 превратила бы «не найдено» в «нашлась ЧУЖАЯ клиника» —
  // ровно та утечка, ради которой список клиник закрыт.
  assert.equal(codes.normalizeJoinCode("MEDI-7I3N-Q82R"), "MEDI7I3NQ82R", "набранная I остаётся I");
  assert.ok(!codes.isJoinCodeShape("MEDI7I3NQ82R"), "и такой код просто не имеет формы");
});

test("J3 личность заявителя — из проверенного JWT, никогда из тела запроса", async () => {
  const handler = stripComments(await readFile(handlerPath, "utf8"));

  assert.ok(/const user = await requireAuthenticatedUser\(req\)|user = await requireAuthenticatedUser\(req\)/.test(handler));
  assert.ok(/auth_user_id: user\.id/.test(handler), "в заявку пишется идентификатор из сессии");
  assert.ok(/email: normalizeEmail\(user\.email/.test(handler), "и почта оттуда же");

  // Ровно эта граница закрыла POST /api/crm/staff: как только auth_user_id
  // приходит из браузера, любой аутентифицированный выписывает членство на
  // чужой аккаунт.
  assert.ok(!/body\.authUserId|body\.auth_user_id|body\.email/.test(handler), "тело запроса личность не называет");
  // Членство собирается из СТРОКИ заявки, а строка — из JWT.
  assert.ok(/auth_user_id: request\.auth_user_id/.test(handler), "членство берёт аккаунт из строки заявки");
});

test("J4 одобрение: арендатор из контекста, роль ниже своей, замок на pending", async () => {
  const handler = stripComments(await readFile(handlerPath, "utf8"));

  assert.ok(/\.eq\("workspace_id", context\.workspaceId\)/.test(handler), "арендатор — из проверенного контекста");
  assert.ok(!/workspace_id: body\.|workspaceId: body\./.test(handler), "и никогда из тела");
  assert.ok(/canAssignRole\(context\.role, role\)/.test(handler), "роль строго ниже своей");
  assert.ok(/isStaffRole\(role\)/.test(handler), "и вообще существует");

  // Порядок проверяется ВНУТРИ decideRequest, по вызовам. Прежний пин сравнивал
  // смещения в файле, а вставка живёт в attachMembership — объявленной ниже, —
  // поэтому перестановка вызовов пин не ломала: ревью это воспроизвело.
  const decide = handler.slice(handler.indexOf("async function decideRequest"), handler.indexOf("async function attachMembership"));
  assert.ok(decide.length > 400, "тело решения найдено");
  const claimAt = decide.indexOf('.eq("status", REQUEST_STATUS_PENDING)');
  const enrollAt = decide.indexOf("await attachMembership(");
  assert.ok(claimAt > 0, "захват заявки условным обновлением");
  assert.ok(enrollAt > claimAt, "членство пишется только ПОСЛЕ захвата: иначе два «Одобрить» дают две строки");

  // Одобренная заявка без сотрудника — худшее из состояний, поэтому откат
  // обязателен И обязан проверяться: он идёт в ту же отказавшую базу.
  assert.ok(/status: REQUEST_STATUS_PENDING, decided_at: null/.test(decide), "провал вставки возвращает заявку в очередь");
  assert.ok(/if \(restoreError \|\| !restored\)/.test(decide), "и результат отката читается");
  assert.ok(/join_request_stuck/.test(decide), "а застрявшее состояние называется вслух");
});

test("J5 одобрение не трогает аккаунты и не проверяет чужие клиники", async () => {
  const handler = stripComments(await readFile(handlerPath, "utf8"));

  // Пароля здесь нет вообще: аккаунт у человека уже свой.
  assert.ok(!/auth\/v1\/admin\/users/.test(handler), "Supabase Admin API не вызывается");
  assert.ok(!/password/i.test(handler.replace(/password_reset_required/g, "")), "пароль в этом пути не фигурирует");
  assert.ok(/password_reset_required: false/.test(handler), "пароль человек придумал сам — требовать смены не за что");

  // Асимметрия со сменой пароля: та пишет в АККАУНТ и потому отказывает при
  // членствах в других клиниках. Одобрение пишет локальную строку, и работать
  // в двух клиниках законно — проверка «нет ли чужих членств» была бы вредна.
  assert.ok(!/\.neq\("workspace_id"/.test(handler), "членства в других клиниках одобрению не мешают");
});

test("J6 неизвестный код: ничего, кроме кода отказа, и счётчик промахов до выборки", async () => {
  const handler = stripComments(await readFile(handlerPath, "utf8"));

  const throttleAt = handler.indexOf('.from("staff_join_code_attempts")');
  const lookupAt = handler.indexOf('.from("workspace_join_codes")');
  assert.ok(throttleAt > 0 && lookupAt > 0, "и счётчик, и выборка на месте");
  assert.ok(throttleAt < lookupAt, "счётчик промахов проверяется ДО обращения к кодам");
  assert.ok(/join_code_throttled/.test(handler), "перебор упирается в отказ");

  // В теле отказа — только код: ни имени клиники, ни идентификатора.
  const refusal = handler.slice(handler.indexOf("join_code_unknown") - 400, handler.indexOf("join_code_unknown") + 400);
  assert.ok(!/workspace_id: workspaceId|clinicName/.test(refusal), "неизвестный код не называет ни одной клиники");

  // Код клиники не должен попадать в журнал: строка лога с кодом — это
  // розданная входная дверь.
  const logs = handler.match(/audit\([^)]*\)/g) ?? [];
  assert.ok(logs.length > 0, "журнал ведётся");
  assert.ok(!logs.some((line) => /\bcode\b(?!_)/.test(line)), "но сам код в него не пишется");
});

test("J7 маршруты объявлены разными видами, и очередь клиники — за manage_staff", async () => {
  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");

  // Заявитель — bootstrap: членства у него нет ПО ЗАМЫСЛУ, и браузерная ветка
  // отказала бы ему раньше обработчика.
  assert.ok(/"join-request": \{ kind: "bootstrap", methods: \["GET", "POST"\] \}/.test(registry));
  assert.ok(
    /"staff-join-requests": \{\s*kind: "browser",\s*methods: \["GET", "PATCH"\],\s*permissions: \{ GET: "manage_staff", PATCH: "manage_staff" \},/.test(registry),
    "очередь клиники — обычный браузерный маршрут за правом manage_staff",
  );
  assert.ok(/"join-code": \{\s*kind: "browser",\s*methods: \["GET", "POST"\],/.test(registry));

  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  assert.ok(/case "join-request":\s*return handleJoinRequest\(req, res\);/.test(router));
  assert.ok(/case "staff-join-requests":\s*return handleStaffJoinRequests\(req, res\);/.test(router));
  assert.ok(/case "join-code":\s*return handleJoinCode\(req, res\);/.test(router));
});

test("J8 смену кода разрешает только владелец, и право считается по истории", async () => {
  const handler = stripComments(await readFile(handlerPath, "utf8"));
  // roles в реестре стоят на весь маршрут, а не на метод, поэтому проверка
  // живёт в обработчике — и потому обязана быть прибита пином.
  assert.ok(/requireWorkspaceRole\(context, \["owner"\]\)/.test(handler), "замена кода — решение владельца");
  // По ИСТОРИИ, а не по живому коду: сорванная ротация (код погашен, новый не
  // вставился) оставляла клинику без живого кода — и тогда следующий код
  // выпускал уже любой админ, то есть сбой раздавал право владельца.
  assert.ok(/const \{ count: everIssued/.test(handler), "право считается по всей истории кодов клиники");
  const historyAt = handler.indexOf("count: everIssued");
  const ownerAt = handler.indexOf('requireWorkspaceRole(context, ["owner"])');
  const revokeAt = handler.indexOf("revoked_by_staff_user_id: context.staffUserId");
  assert.ok(historyAt > 0 && ownerAt > historyAt, "сначала история, потом право");
  assert.ok(revokeAt > ownerAt, "и только потом гашение — отказ не должен оставлять клинику без кода");
  // Проигравшая гонку вкладка обязана показать ДЕЙСТВУЮЩИЙ код, а не 503:
  // иначе владелец диктует уже отозванный.
  assert.ok(/concurrent: true/.test(handler), "проигравший в гонке получает живой код, а не ошибку");
});

test("J9 миграция 038 по правилу паритета, и применённые не переписаны", async () => {
  const migration = await readFile(path.join(repoRoot, "migrations", "038_staff_join_requests.sql"), "utf8");

  for (const table of ["workspace_join_codes", "staff_join_requests", "staff_join_code_attempts"]) {
    assert.ok(new RegExp(`create table if not exists public\\.${table}`).test(migration), `${table} создаётся`);
    assert.ok(new RegExp(`alter table public\\.${table}\\s+enable row level security`).test(migration), `${table}: RLS`);
    assert.ok(new RegExp(`revoke all on table public\\.${table}\\s+from anon, authenticated`).test(migration), `${table}: revoke`);
    assert.ok(new RegExp(`grant [^;]*on table public\\.${table}\\s+to service_role`).test(migration), `${table}: грант служебной роли`);
  }
  // Проза шапки говорит про DELETE словами — судим по SQL без комментариев.
  const sql = migration.replace(/^\s*--.*$/gm, "").replace(/on delete (cascade|set null)/g, "");
  assert.ok(!/delete/i.test(sql), "DELETE не выдаётся: решённая заявка обязана остаться строкой");

  // Одна живая заявка на пару (клиника, аккаунт) — но отклонённая индекс
  // освобождает: промах мышью по «Отклонить» иначе закрывал бы дорогу навсегда.
  assert.ok(/staff_join_requests_pending_unique[\s\S]*where status = 'pending'/.test(migration));
  // Уникальность кода глобальная и вечная: переиспользованный код увёл бы
  // человека со старой бумажкой в чужую очередь.
  assert.ok(/workspace_join_codes_code_key\s+on public\.workspace_join_codes\(code\);/.test(migration));
  assert.ok(/workspace_join_codes_live_idx[\s\S]*where revoked_at is null/.test(migration));
  // Владельца не выдаёт даже ошибка в обработчике.
  assert.ok(/granted_role in \('admin'/.test(migration) && !/granted_role in \([^)]*'owner'/.test(migration));
});

test("J10 экран заявителя не ходит в таблицы и говорит по-русски", async () => {
  const page = stripComments(await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "pages", "JoinRequest.tsx"), "utf8",
  ));

  // Прямой доступ к таблицам из браузера раздал бы anon-ключу способ
  // перечислить клиники — то, ради чего список и закрыт.
  assert.ok(!/supabase\.from\(/.test(page), "страница не читает таблицы напрямую");
  assert.ok(!/\/rest\/v1/.test(page) && !/\.channel\(/.test(page));
  assert.ok(/crmFetch\("\/api\/crm\/join-request"/.test(page), "только наш маршрут");

  // Роль заявитель не выбирает: предзаполненная роль приезжает к админу, и
  // «Одобрить» нажимается не глядя.
  assert.ok(!/roleLabels|StaffRole/.test(page), "списка ролей на экране заявителя нет");

  for (const code of ["join_code_unknown", "join_code_throttled", "join_request_pending", "already_member", "join_queue_full"]) {
    assert.ok(page.includes(code), `есть русский текст на отказ ${code}`);
  }

  // Ни одна ветка не печатает сырое сообщение сервера или Supabase: прежний пин
  // запрещал ровно одно написание, и «User already registered» уезжало в
  // русский интерфейс мимо него.
  assert.ok(!/toast\.error\(String\(body\./.test(page), "английский код сервера в интерфейс не выводится");
  assert.ok(!/toast\.error\(error\.message/.test(page) && !/toast\.error\(error instanceof Error \? error\.message/.test(page),
    "сообщение Supabase переводится, а не печатается как есть");
  assert.ok(/function authErrorText/.test(page), "перевод ошибок входа есть отдельной функцией");
  assert.ok(/errorTextFor\(/.test(page), "а отказы сервера читаются по словарю");
  // Неизвестный статус тоже не печатается сырым.
  assert.ok(!/STATUS_LABELS\[request\.status\] \?\? request\.status/.test(page));
  // Правила пароля — общие с сервером: это третий экран, где человек придумывает
  // себе пароль сам.
  assert.ok(/validatePasswordRules/.test(page), "правила пароля не своя копия");
  assert.ok(!/password\.length < 8/.test(page), "и своего минимума не осталось");
});

test("J11 вход не разлогинивает заявителя, и админ узнаёт о заявке с экрана", async () => {
  const login = stripComments(await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "pages", "Login.tsx"), "utf8",
  ));
  const checkAt = login.indexOf('crmFetch("/api/crm/join-request")');
  const signOutAt = login.indexOf("await supabase.auth.signOut()");
  assert.ok(checkAt > 0, "вход спрашивает про заявку");
  assert.ok(signOutAt > checkAt, "и делает это ДО разлогина — иначе статус заявки не посмотреть");

  const admin = stripComments(await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdminCenter.tsx"), "utf8",
  ));
  assert.ok(/Заявки на вступление/.test(admin), "очередь названа на экране");
  assert.ok(/Код клиники/.test(admin) && /По коду нельзя войти/.test(admin), "и код объяснён");

  // Писем в продукте нет, поэтому уведомление — это экран. Счётчик обязан быть
  // виден ДО того, как админ дошёл до вкладки «Сотрудники»: плашка на «Обзоре»
  // (первая вкладка) плюс пилюля в самом списке вкладок.
  assert.ok(/просят доступ в клинику|просит доступ в клинику/.test(admin), "плашка на «Обзоре» говорит о заявках");
  const overview = admin.slice(admin.indexOf("function renderOverview"), admin.indexOf("function renderStaff"));
  assert.ok(/pendingJoinRequests\.length > 0/.test(overview) && /setActiveTab\("staff"\)/.test(overview),
    "и ведёт на вкладку с очередью");
  assert.ok(/tab\.id === "staff" && pendingJoinRequests\.length > 0/.test(admin), "пилюля с числом стоит на самой вкладке");
  // Вкладка читается из адреса: ссылку на /admin?tab=staff можно передать.
  assert.ok(/new URLSearchParams\(window\.location\.search\)\.get\("tab"\)/.test(admin));
});

test("J12 пачка: тот же маршрут, честные исходы и ни одного потерянного пароля", async () => {
  const admin = stripComments(await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdminCenter.tsx"), "utf8",
  ));

  const batch = admin.slice(admin.indexOf("async function createStaffBatch"), admin.indexOf("async function copyBatchCredentials"));
  assert.ok(batch.length > 400, "пачка на месте");
  // Каждая строка идёт тем же маршрутом, что и одиночное заведение: сервер
  // списка не получает, значит и второго набора проверок не появляется.
  assert.ok(/\/api\/crm\/staff-credentials\?workspaceId=/.test(batch), "тот же маршрут");
  assert.ok(/for \(const row of unique\)/.test(batch), "последовательно: двадцать одновременных созданий — это 429");
  assert.ok(/kind: "created"/.test(batch) && /kind: "invited"/.test(batch) && /kind: "failed"/.test(batch), "три честных исхода");
  assert.ok(/unique\.length > 30/.test(batch), "потолок на размер пачки");

  // Пароль сохраняется, если аккаунт УЖЕ создан: он единственный способ этому
  // человеку войти и принять приглашение, и выбросить его значит запереть
  // аккаунт навсегда.
  assert.ok(/partial_staff_credentials/.test(batch) && /staff_credentials_unreadable/.test(batch),
    "частичный успех распознаётся по коду сервера");
  assert.ok(/accountExists \? \{ password \} : \{\}/.test(batch), "и пароль в такой строке остаётся");

  // Поле ввода чистится только когда чистить нечего: иначе администратор
  // собирал бы заново адреса, которые не прошли.
  const clearAt = batch.indexOf('setBatchEmails("")');
  const guardAt = batch.indexOf("if (failed === 0)");
  assert.ok(guardAt > 0 && clearAt > guardAt, "список остаётся в поле, если были отказы");
  assert.ok(/toast\.warning\(/.test(batch), "и отказы не рапортуются успехом");

  // Имя не затирается префиксом почты у уже заведённого сотрудника.
  assert.ok(/row\.fullName \|\| row\.email\.split\("@"\)\[0\]/.test(batch), "имя из строки, если оно указано");
  assert.ok(/почта, Имя|«почта, Имя»/.test(admin), "и экран объясняет этот формат");

  // Пароли не оседают в браузере нигде, кроме состояния экрана.
  assert.ok(!/localStorage[^\n]*password/i.test(admin), "пароли не пишутся в localStorage");
  assert.ok(!/writeStored\([^)]*[Pp]assword/.test(admin), "и не уходят в постоянное хранилище экрана");
  // Подпись «второй раз не покажутся» обязана быть правдой.
  assert.ok(/if \(open\) setBatchResults\(null\)/.test(admin), "закрытие панели стирает пароли с экрана");
});
