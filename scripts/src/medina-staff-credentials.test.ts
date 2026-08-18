import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// SC — заведение сотрудника с паролем.
//
// Второй путь зачисления появился потому, что письма-приглашения до клиник
// доходят плохо. Он снимает ОДНО доказательство (контроль над почтой) и обязан
// сохранить все остальные границы: роль строго ниже своей, чужой аккаунт не
// захватывается, арендатор из проверенного контекста, пароль нигде не оседает.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "crm", "staff-credentials.ts");

type Module = {
  validateStaffCredentialsRequest: (
    body: Record<string, unknown>,
    actorRole: string,
  ) => { email: string; role: string; fullName: string } | { status: number; error: string; code: string; details?: string[] };
};

const { validateStaffCredentialsRequest } = (await import(pathToFileURL(modulePath).href)) as Module;

const VALID = { email: "Nurse@Clinic.kz", role: "receptionist", fullName: "Айгуль", password: "Xk7mPq2wRt" };

test("SC1 роль назначается строго ниже своей, владелец — никем", () => {
  const ok = validateStaffCredentialsRequest(VALID, "owner");
  assert.ok(!("status" in ok));
  assert.equal(ok.email, "nurse@clinic.kz", "почта нормализуется");
  assert.equal(ok.role, "receptionist");

  // Админ не заводит второго админа: у canAssignRole ранг строго меньше.
  const peer = validateStaffCredentialsRequest({ ...VALID, role: "admin" }, "admin");
  assert.ok("status" in peer && peer.status === 403, "равный ранг — отказ");
  assert.ok("status" in peer && peer.code === "permission_denied");

  const ownerRole = validateStaffCredentialsRequest({ ...VALID, role: "owner" }, "owner");
  assert.ok("status" in ownerRole, "владельца не заводит даже владелец");

  const byStranger = validateStaffCredentialsRequest(VALID, "receptionist");
  assert.ok("status" in byStranger, "роль без права назначения ничего не назначает");

  const unknownRole = validateStaffCredentialsRequest({ ...VALID, role: "директор" }, "owner");
  assert.ok("status" in unknownRole, "выдуманная роль — отказ");
});

test("SC2 правила пароля те же, что у подключения клиники", () => {
  const short = validateStaffCredentialsRequest({ ...VALID, password: "Ab3defg" }, "owner");
  assert.ok("status" in short && short.status === 400);

  const spaced = validateStaffCredentialsRequest({ ...VALID, password: "Secret123 " }, "owner");
  assert.ok("status" in spaced, "хвостовой пробел теряется при передаче — отказ");

  const cyrillic = validateStaffCredentialsRequest({ ...VALID, password: "я".repeat(37) }, "owner");
  assert.ok("status" in cyrillic, "предел bcrypt считается байтами");

  const missing = validateStaffCredentialsRequest({ ...VALID, password: undefined }, "owner");
  assert.ok("status" in missing, "без пароля путь не имеет смысла");

  const noName = validateStaffCredentialsRequest({ ...VALID, fullName: "" }, "owner");
  assert.ok(!("status" in noName));
  assert.equal(noName.fullName, "nurse@clinic.kz", "пустое имя — почта, а не выдумка");
});

test("SC3 пароль не оседает ни в таблицах, ни в ответах, ни в логе", async () => {
  // Судим код без комментариев: слова «пароль» и «password» стоят и в
  // объяснениях, а пин обязан падать на поведении (урок VT12).
  const source = (await readFile(modulePath, "utf8"))
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, " ");

  const inserts = source.match(/\.insert\((\{[\s\S]*?\}|\[[\s\S]*?\])\)/g) || [];
  assert.ok(inserts.length >= 1, "вставка сотрудника найдена");
  assert.equal((source.match(/\.insert\(/g) || []).length, inserts.length, "инсертов через переменную нет");
  for (const literal of inserts) {
    assert.ok(!/password(?!_reset_required)/i.test(literal), "в таблицу пароль не пишется");
  }
  for (const literal of source.match(/sendJson\(res,[\s\S]*?\}\);/g) || []) {
    assert.ok(!/password/i.test(literal.replace(/password_rejected|invalid_staff_credentials/g, "")), "ответ без пароля");
  }
  for (const literal of source.match(/console\.[a-z]+\([\s\S]*?\);/g) || []) {
    assert.ok(!/password/i.test(literal), "в журнале пароля нет");
    assert.ok(!/email|validated\.email/.test(literal), "и почты сотрудника тоже: журнал административный");
  }
  assert.ok(/password_reset_required: true/.test(source), "пароль задал не сотрудник — флаг честный");
});

test("SC4 чужой аккаунт не захватывается, а членство строится сервером", async () => {
  const source = (await readFile(modulePath, "utf8")).replace(/(^|\s)\/\/[^\n]*/g, "$1");

  // Занятая почта — отказ. Задавать пароль существующему аккаунту нельзя:
  // это был бы захват чужого входа, а не заведение сотрудника.
  assert.ok(/email_already_registered/.test(source));
  assert.ok(/пригласите ссылкой/i.test(source), "и называет работающий путь");
  // Повтор после сбоя на нашей же стороне — не «чужой аккаунт»: отказ обязан
  // сказать, что пароль, заданный минуту назад, уже работает.
  assert.ok(/он войдёт с тем паролем, который вы задали/.test(source), "и различает свой прерванный проход");

  // auth_user_id приходит ОТ Admin API, а не из тела запроса — именно из-за
  // обратного когда-то отключили POST /api/crm/staff.
  assert.ok(/auth_user_id: authUserId/.test(source));
  assert.ok(/const authUserId = readString\(asRecord\(await created\.json\(\)/.test(source), "идентификатор читается из ответа Supabase");
  assert.ok(!/body\.authUserId|body\.auth_user_id/.test(source), "браузер не называет аккаунт");

  // Арендатор — из проверенного контекста, а не из тела. Пинится и ФИЛЬТР
  // выборки дубликата: без него проверка «уже в команде» смотрела бы на всю
  // платформу, а не на свою клинику.
  assert.ok(/readWorkspaceContext\(req\)/.test(source));
  assert.ok(/workspace_id: context\.workspaceId/.test(source));
  assert.equal(
    (source.match(/\.eq\("workspace_id", context\.workspaceId\)/g) || []).length,
    3,
    "выборка дубликата, отзыв приглашений и привязка строки — все ограничены своей клиникой",
  );
  assert.ok(!/body\.workspaceId/.test(source), "клиника не берётся из запроса");

  // Роль актора — тоже из контекста: подстановка «owner» или значения из тела
  // сняла бы ограничение «строго ниже своей».
  assert.ok(/validateStaffCredentialsRequest\(body, context\.role\)/.test(source), "роль актора — из проверенного контекста");
  assert.ok(!/body\.actorRole|body\.role as StaffRole/.test(source), "актор не называет свою роль сам");

  // Заданный пароль обязан дойти до Supabase — иначе сотрудник войти не сможет,
  // а экран покажет пароль, которого у аккаунта нет.
  assert.ok(/const password = String\(body\.password\);/.test(source));
  assert.ok(/\bpassword,\n/.test(source), "пароль уходит в тело запроса к Admin API");

  // Аккаунт создаётся ДО строки сотрудника: отказ «почта занята» не оставляет
  // ни висящих приглашений, ни половины членства.
  assert.ok(source.indexOf("/auth/v1/admin/users") < source.indexOf('from("staff_users")\n    .insert'), "аккаунт первым");
  assert.ok(/escapeLikePattern\(validated\.email\)/.test(source), "почта в выборках — значение, не LIKE-шаблон");
});

test("SC4c сотрудник без привязанного входа достраивается, а не отвергается", async () => {
  // Строка без auth_user_id — это ровно тот человек, который войти НЕ может
  // (так выглядят сотрудники из seed). Отказ «уже в команде» отправлял бы
  // менять роль там, где роль ни при чём, а другого пути привязать вход нет.
  const source = (await readFile(modulePath, "utf8")).replace(/(^|\s)\/\/[^\n]*/g, "$1");
  assert.ok(/select\("id, auth_user_id"\)/.test(source), "привязка входа читается вместе со строкой");
  assert.ok(/existingStaffId && existingLinked/.test(source), "отказ только для того, кто уже может войти");
  assert.ok(/\.is\("auth_user_id", null\)/.test(source), "гонка закрыта: привязывается только непривязанная строка");
  assert.ok(/linkedExisting: true/.test(source), "ответ отличает достройку от создания");
  // Второй профиль того же человека развалил бы историю: на строку уже
  // ссылаются задачи и журнал.
  assert.ok(
    source.indexOf("if (existingStaffId) {") < source.indexOf('.from("staff_users")\n    .insert('),
    "достройка проверяется раньше вставки",
  );
});

test("SC4b единственное обращение к Auth — создание, и себе завести нельзя", async () => {
  const source = (await readFile(modulePath, "utf8")).replace(/(^|\s)\/\/[^\n]*/g, "$1");

  // Пин на ОТСУТСТВИЕ: захват чужого входа требовал бы кода, умеющего писать
  // пароль существующему пользователю. Наличие строки email_already_registered
  // такой код рядом переживёт — а этот пин нет.
  assert.equal((source.match(/\/auth\/v1\/admin\/users/g) || []).length, 1, "ровно одно обращение к Admin API");
  assert.equal((source.match(/\/auth\/v1\/admin\/users\/\$\{/g) || []).length, 0, "и оно не адресует конкретного пользователя");
  assert.ok(!/method: "(PUT|PATCH|DELETE)"/.test(source), "пароль существующему аккаунту не переписывается");
  assert.ok(!/generate_link|\/auth\/v1\/recover/.test(source), "и ссылки за человека не выписываются");

  // «Себе нельзя» — словами, а не косвенно через дедуп.
  assert.ok(
    /normalizeEmail\(context\.email\) === normalizeEmail\(body\.email\)/.test(source),
    "своя почта отбивается явной проверкой",
  );

  // Непогашенное приглашение — второй путь в ту же клинику: молчать о сбое
  // отзыва нельзя.
  assert.ok(/const \{ error: revokeError \}/.test(source) && /if \(revokeError\)/.test(source), "сбой отзыва приглашений называется");

  // Отказы оставляют след с причиной — иначе жалобу «не могу завести
  // сотрудника» нечем расследовать.
  assert.ok((source.match(/auditRefusal\(/g) || []).length >= 4, "каждый класс отказа попадает в журнал");
});

test("SC5 маршрут закрыт правом manage_staff и только POST", async () => {
  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");
  assert.ok(
    /"staff-credentials": \{\s*kind: "browser",\s*methods: \["POST"\],\s*permissions: \{ POST: "manage_staff" \},/.test(registry),
    "browser-маршрут, один метод, право управления сотрудниками",
  );
  // Отключение staff POST остаётся в силе: новый путь не воскрешает его.
  assert.ok(/disabledMethods: \["POST"\]/.test(registry), "POST /api/crm/staff по-прежнему отключён");

  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  assert.ok(/case "staff-credentials":\s*return handleStaffCredentials\(req, res\);/.test(router));
});

test("SC6 экран предлагает пароль первым и показывает его один раз", async () => {
  const admin = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdminCenter.tsx"), "utf8");
  assert.ok(/useState<"password" \| "invite">\("password"\)/.test(admin), "умолчание — пароль: письма не доходят");
  assert.ok(/staff-credentials/.test(admin), "экран зовёт новый маршрут");
  assert.ok(/setCreatedStaff\(\{ email, password: staffPassword \}\)/.test(admin), "пароль показывается из состояния экрана");
  assert.ok(/setStaffPassword\(""\)/.test(admin), "и стирается из формы сразу после отправки");
  assert.ok(/generateStaffPassword/.test(admin), "пароль можно сгенерировать, а не выдумывать");
  assert.ok(/показывается один раз/.test(admin), "экран честно говорит, что второй раз пароль не покажут");
  // Главная кнопка обязана звать обработчик: без этой связи можно удалить
  // серверный вызов, и все прочие пины останутся зелёными.
  assert.ok(/onClick=\{createStaffWithPassword\}/.test(admin), "кнопка «Добавить сотрудника» вызывает парольный путь");
  // Переключение режима не стирает единственную копию пароля.
  const modeSwitch = admin.slice(admin.indexOf('aria-pressed={staffMode === "password"}'), admin.indexOf("Ссылка-приглашение"));
  assert.ok(!/setIssuedInvite\(null\)|setCreatedStaff\(null\)/.test(modeSwitch), "переключение режима ничего не уничтожает");
  // Пароль не оседает в браузере нигде, кроме состояния экрана.
  assert.ok(!/writeStored\([^)]*[Pp]assword/.test(admin) && !/localStorage[^\n]*[Pp]assword/.test(admin), "пароль не пишется в localStorage");
  // Роли выше своей не предлагаются: сервер их отклонит.
  assert.ok(/canAssignRole\(serverAdminAuth\.role \|\| "admin", role\)/.test(admin));
});
