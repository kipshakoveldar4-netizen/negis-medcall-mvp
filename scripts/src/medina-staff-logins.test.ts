import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// L — вход по логину вместо почты.
//
// Владелец: «сделай так чтобы могли по именам делать логин, а то с почтами
// много мороки». Supabase умеет вход только по адресу, поэтому нику
// сопоставляется служебный адрес. Отсюда три опасности, которые держат пины:
// расхождение преобразования между входом и сервером, захват чужого логина
// через пути, где адрес называет человек, и приглашение, выписанное на
// служебный адрес чужой клиники.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "auth", "staff-logins.ts");

type LoginsModule = {
  STAFF_LOGIN_MINT_DOMAIN: string;
  STAFF_LOGIN_DOMAINS: readonly string[];
  normalizeLogin: (raw: unknown) => string;
  isLoginShape: (value: string) => boolean;
  loginFromFullName: (fullName: unknown) => string;
  emailFromLogin: (login: string) => string;
  isSyntheticEmail: (email: unknown) => boolean;
  loginFromEmail: (email: unknown) => string;
  loginOrEmailToAuthEmail: (raw: unknown) => string;
  loginWithSuffix: (base: string, attempt: number, randomByte?: () => number) => string;
};

const logins = (await import(pathToFileURL(modulePath).href)) as LoginsModule;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("L1 логин из имени: латиница, произносимый, и длинное ФИО не рвётся", () => {
  assert.equal(logins.loginFromFullName("Айгуль Ботанова"), "aigul.botanova");
  assert.equal(logins.loginFromFullName("Дана Ким"), "dana.kim");
  // Казахские буквы обязаны переводиться, иначе «Ұлжан» станет «лжан».
  assert.equal(logins.loginFromFullName("Ұлжан Қыдырбек"), "ulzhan.qydyrbek");

  // Длинное ФИО сокращается по-человечески: имя плюс инициал фамилии. Обрезка
  // посередине давала обрубленное ИМЯ, которое невозможно продиктовать.
  const long = logins.loginFromFullName("Айгуль Мухаметкалиевагульнурсултанкызы");
  assert.ok(logins.isLoginShape(long), `длинное ФИО даёт годный логин: ${long}`);
  assert.ok(long.length <= 24 && long.startsWith("aigul"), long);

  // Пустое и мусорное имя не превращается в логин молча.
  assert.equal(logins.loginFromFullName("!!!"), "");
  assert.equal(logins.loginFromFullName(42), "");
});

test("L2 разделители не различают людей, а форма отсеивает мусор", () => {
  // Дефис и подчёркивание приводятся к точке: человек, набравший разделитель
  // иначе, получил бы «неверный логин», неотличимый от неверного пароля.
  // Заодно «_» — символ LIKE-шаблона, на котором в этом проекте уже был баг.
  assert.equal(logins.normalizeLogin("Aigul-Botanova"), "aigul.botanova");
  assert.equal(logins.normalizeLogin("aigul_botanova"), "aigul.botanova");
  assert.equal(logins.normalizeLogin("  AIGUL.BOTANOVA  "), "aigul.botanova");
  assert.equal(logins.normalizeLogin("aigul..botanova"), "aigul.botanova");

  assert.ok(logins.isLoginShape("aigul.botanova"));
  assert.ok(!logins.isLoginShape("ab"), "слишком короткий");
  assert.ok(!logins.isLoginShape("aigul."), "точка на конце");
  assert.ok(!logins.isLoginShape("aigul@x"), "«собака» в логине недопустима");

  // Обрезка по длине не имеет права оставить точку на конце: такой логин не
  // прошёл бы собственную проверку формы, и длинное имя стало бы невыдаваемым.
  const trimmed = logins.normalizeLogin(`${"a".repeat(23)}.botanova`);
  assert.ok(!trimmed.endsWith("."), trimmed);
  assert.ok(logins.isLoginShape(trimmed), trimmed);
});

test("L3 преобразование логина в адрес обратимо и не ходит в базу", () => {
  for (const name of ["Айгуль Ботанова", "Дана Ким", "Ұлжан Қыдырбек"]) {
    const login = logins.loginFromFullName(name);
    assert.equal(logins.loginFromEmail(logins.emailFromLogin(login)), login, name);
  }

  // Одно поле на входе: с «@» — почта, без — логин.
  assert.equal(logins.loginOrEmailToAuthEmail("aigul.botanova"), `aigul.botanova@${logins.STAFF_LOGIN_MINT_DOMAIN}`);
  assert.equal(logins.loginOrEmailToAuthEmail(" Aigul.Botanova "), `aigul.botanova@${logins.STAFF_LOGIN_MINT_DOMAIN}`);
  assert.equal(logins.loginOrEmailToAuthEmail("Aigul@Mail.RU"), "aigul@mail.ru");
  // Кириллица на входе даёт пустоту, а не чужой логин: транслитерировать на
  // странице входа нельзя — правка таблицы стала бы массовой блокировкой.
  assert.equal(logins.loginOrEmailToAuthEmail("Айгуль"), "");

  // Настоящая почта служебной не считается — иначе её перестали бы показывать.
  assert.ok(!logins.isSyntheticEmail("aigul@mail.ru"));
  assert.equal(logins.loginFromEmail("aigul@mail.ru"), "aigul@mail.ru");
});

test("L4 домен: один на выдачу, список на разбор, и он не .local", async () => {
  assert.ok(logins.STAFF_LOGIN_DOMAINS.includes(logins.STAFF_LOGIN_MINT_DOMAIN), "новый домен опознаётся");
  assert.ok(logins.STAFF_LOGIN_DOMAINS.length > 1, "прежние домены продолжают опознаваться после смены");
  assert.ok(
    !logins.STAFF_LOGIN_MINT_DOMAIN.endsWith(".local"),
    "«.local» — зона mDNS: имя может разрешиться в устройство в сети клиники",
  );
  // Ранее выданные адреса обязаны опознаваться и показываться логином.
  assert.ok(logins.isSyntheticEmail("aigul@staff.negis.local"));
  assert.equal(logins.loginFromEmail("aigul@staff.negis.local"), "aigul");

  // Домен зашит в одном месте: литерал в других модулях означает расхождение
  // при первой же смене.
  for (const file of [
    "lib/crm/staff-credentials.ts",
    "artifacts/negis/src/pages/Login.tsx",
    "artifacts/negis/src/pages/AdminCenter.tsx",
  ]) {
    const source = stripComments(await readFile(path.join(repoRoot, file), "utf8"));
    assert.ok(!source.includes("staff.negis."), `${file} не знает домена — он приходит из модуля`);
  }
});

test("L5 хвост занятого логина случайный, а не счётчик", async () => {
  // Счётчик сообщал бы, СКОЛЬКО на платформе таких логинов, то есть измерял бы
  // клиентскую базу — ровно то, ради чего список клиник не показывается.
  const bytes = [0, 1, 2, 3, 4, 5];
  let index = 0;
  const suffixed = logins.loginWithSuffix("aigul", 1, () => bytes[index++ % bytes.length]);
  assert.notEqual(suffixed, "aigul");
  assert.ok(logins.isLoginShape(suffixed), suffixed);
  assert.ok(!/aigul2$/.test(suffixed), `хвост не должен быть номером попытки: ${suffixed}`);
  assert.equal(logins.loginWithSuffix("aigul", 0), "aigul", "первая попытка — без хвоста");

  const source = stripComments(await readFile(modulePath, "utf8"));
  assert.ok(/SUFFIX_ALPHABET/.test(source));
  assert.ok(!/attempt \+ 1/.test(source), "номер попытки в логин не попадает");
});

test("L6 занятый ЛОГИН не превращается в приглашение — это дыра между клиниками", async () => {
  const source = stripComments(await readFile(path.join(repoRoot, "lib", "crm", "staff-credentials.ts"), "utf8"));

  // Приглашение доказывает владение почтой. На служебный адрес доказывать
  // нечего: принять ссылку смог бы владелец такого логина — сотрудник ДРУГОЙ
  // клиники, и проверка «адрес сессии совпал» у него прошла бы.
  const inviteAt = source.indexOf("issueInvitationFor(supabase, req, context, validated)");
  const loginBranchAt = source.indexOf("login_unavailable");
  assert.ok(inviteAt > 0 && loginBranchAt > 0, "обе ветки на месте");
  assert.ok(loginBranchAt < inviteAt, "логин уходит в свою ветку ДО ветки приглашения");
  assert.ok(/if \(!created && validated\.login && failure\?\.taken\)/.test(source), "исчерпание попыток — отдельный отказ");

  // Тело ответа Admin API читается один раз: повторный .json() вернул бы
  // пустоту, и «почта занята» стало бы «непонятным сбоем».
  assert.equal((source.match(/async function readFailure/g) ?? []).length, 1);
  assert.ok(!/isTaken\(created\)/.test(source), "двойного чтения тела не осталось");

  // Экран обязан печатать ВЫДАННЫЙ логин: при столкновении он получил хвост.
  // Логин обязан вернуться и в УСПЕХЕ, и в частичных отказах: пароль уже
  // применён к адресу с хвостом, а у входа по логину нет письма-восстановления.
  // Печать базового логина в такой строке сжигала бы аккаунт.
  assert.ok(
    (source.match(/login: loginFromEmail\(issuedEmail\)/g) ?? []).length >= 5,
    "логин возвращается во всех ветках, включая частичные отказы",
  );

  // Поиск существующей строки на пути логина не идёт: ключом был бы базовый
  // адрес, а аккаунт создаётся с хвостом. И две разные «Дана Ким» в одной
  // клинике получали бы «этот человек уже в команде» — про другого человека.
  assert.ok(/const \{ data: existing, error: existingError \} = validated\.login/.test(source), "дедуп по адресу — только для почты");
});

test("L7 служебный адрес нельзя назвать руками ни на одном пути", async () => {
  const files: Record<string, string> = {
    "lib/crm/staff-credentials.ts": "заведение сотрудника",
    "lib/crm/staff-join-requests.ts": "самозапись по коду клиники",
    "lib/crm/staff-invitations.ts": "приглашение по почте",
  };
  for (const [file, why] of Object.entries(files)) {
    const source = stripComments(await readFile(path.join(repoRoot, file), "utf8"));
    assert.ok(/isSyntheticEmail\(/.test(source), `${why}: служебный адрес отвергается (${file})`);
  }
});

test("L8 вход: поле принимает логин, а «Забыли пароль?» ему не врёт", async () => {
  const login = stripComments(await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "Login.tsx"), "utf8"));

  // type="email" отверг бы «aigul» браузерной проверкой ещё до отправки, и вся
  // ветка входа по логину была бы мертва.
  assert.ok(!/type="email"/.test(login), "поле входа не почтовое");
  assert.ok(/autoComplete="username"/.test(login) && /autoCapitalize="none"/.test(login), "iOS не переделает aigul в Aigul");
  assert.ok(/loginOrEmailToAuthEmail\(email\)/.test(login), "преобразование — общим модулем, а не своей копией");

  // Письмо в служебный домен уйдёт в никуда, а плашка «письмо уже в пути»
  // стала бы прямой ложью человеку, у которого почты нет.
  const resetBody = login.slice(login.indexOf("const sendPasswordReset"), login.indexOf("const submit"));
  // Прежний пин закреплял литерал `!email.includes("@")` — то есть фиксировал
  // дефект как требование: служебный адрес «собаку» содержит и проходил насквозь.
  const guardAt = resetBody.indexOf("isSyntheticEmail(email)");
  const sendAt = resetBody.indexOf("resetPasswordForEmail");
  assert.ok(guardAt > 0 && sendAt > guardAt, "логин отсекается ДО обращения к сети");
  assert.ok(/администратор/.test(resetBody), "и человеку сказано, к кому идти");

  // Форм входа в продукте ДВЕ: /login и модалка на корне сайта. Обновить одну
  // значило запереть сотрудника, который открыл главную страницу.
  const landing = stripComments(await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "Landing.tsx"), "utf8"));
  assert.ok(/loginOrEmailToAuthEmail\(data\.email\)/.test(landing), "лендинг входит тем же преобразованием");
  assert.ok(/min\(3, .Введите логин или почту.\)/.test(landing), "схема входа не требует почты");
  assert.ok(/isSyntheticEmail\(data\.email\)/.test(landing), "и не шлёт письмо на служебный адрес");

  const join = stripComments(await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "JoinWorkspace.tsx"), "utf8"));
  assert.ok(/isSyntheticEmail\(/.test(join), "приглашение тоже не обещает письмо логину");
});

test("L9 пачка: дедуп по исходной строке и печать выданного логина", async () => {
  const admin = stripComments(await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdminCenter.tsx"), "utf8"));
  const batch = admin.slice(admin.indexOf("async function createStaffBatch"), admin.indexOf("async function copyBatchCredentials"));

  // Дедуп только по ПОЧТЕ: одинаковые имена — обычное дело, и две «Дана Ким»
  // это две разные женщины. Дедуп по имени или по выведенному логину молча
  // выбрасывал бы вторую, и админ раздал бы девятнадцать паролей вместо
  // двадцати — узнав об этом в смену.
  assert.ok(/other\.email === row\.email/.test(batch), "дедуп по почте");
  assert.ok(!/other\.source === row\.source/.test(batch), "одинаковые имена не схлопываются");
  assert.ok(!/other\.login === row\.login/.test(batch), "и выведенный логин ключом не служит");
  assert.ok(/dropped/.test(batch), "пропущенные повторы названы в итоге, а не молчат");
  // Явный логин нормализуется, а не транслитерируется как имя: точка в
  // «aigul.b» иначе исчезала бы, и админ диктовал бы несуществующий логин.
  assert.ok(/normalizeLogin\(parts\[1\]\)/.test(batch), "желаемый логин из строки — через normalizeLogin");
  assert.ok(/loginFromFullName\(/.test(batch), "логин делается из имени общим модулем");
  assert.ok(/body\.data\?\.login/.test(batch), "печатается логин, выданный сервером");

  // Раздают по одному человеку в мессенджере — без имени непонятно, чей пароль.
  const copy = admin.slice(admin.indexOf("async function copyBatchCredentials"), admin.indexOf("async function loadInvitations"));
  assert.ok(/row\.source/.test(copy) && /row\.login/.test(copy), "в буфер уходит имя, логин и пароль");

  // Служебный адрес не показывается человеку нигде.
  assert.ok(/loginFromEmail\(member\.email\)/.test(admin), "в списке сотрудников — логин");
  assert.ok(!/\{member\.email\}/.test(admin), "сырого адреса на экране нет");
  assert.ok(/восстанавливается только кнопкой/.test(admin), "сказано, как восстанавливать пароль без почты");
});

test("L10 незащищённые маршруты api-server отключены", async () => {
  const router = await readFile(path.join(repoRoot, "artifacts", "api-server", "src", "routes", "index.ts"), "utf8");
  const code = stripComments(router);

  // У этого приложения нет авторизации вовсе (app.ts: только cors и парсеры), а
  // маршруты были административными: сброс пароля по одной почте, создание
  // клиники, CRUD сотрудников, тестовый вход. С логинами адрес выводится из
  // имени, и сброс стал бы кнопкой «выкинуть любого сотрудника».
  for (const disabled of ["authResetRouter", "authRegisterRouter", "employeesRouter", "testAuthRouter"]) {
    assert.ok(!code.includes(disabled), `${disabled} не подключён`);
  }
  assert.ok(code.includes("healthRouter") && code.includes("impersonationRouter"), "рабочие маршруты на месте");
  assert.ok(/ВНИМАНИЕ/.test(router), "в файле записано, почему они отключены");
});
