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
  assert.ok(/приглашени/i.test(source), "и называет работающий путь — приглашение");
  // Повтор после сбоя на нашей же стороне — не «чужой аккаунт»: отказ обязан
  // сказать, что пароль, заданный минуту назад, уже работает.
  assert.ok(/если аккаунт создали вы — тем, что вы задали/.test(source), "и различает свой прерванный проход");

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
  // Каждое обращение к таблицам ограничено своей клиникой — либо фильтром
  // (чтение и обновление), либо полем в записи (вставка). Счётчик сверяется с
  // числом обращений: новый запрос мимо клиники уронит пин, а не проскочит.
  const tableCalls = (source.match(/\.from\("staff_(users|invitations)"\)/g) || []).length;
  const scopedByFilter = (source.match(/\.eq\("workspace_id", context\.workspaceId\)/g) || []).length;
  const scopedByColumn = (source.match(/workspace_id: context\.workspaceId,/g) || []).length;
  // Ровно ОДИН запрос смотрит за пределы своей клиники, и это не дыра, а
  // граница: смена пароля обязана узнать, не работает ли этот аккаунт где-то
  // ещё (иначе пароль от чужой клиники уходит вместе с ним). Он читает только
  // id членства — ни одной строки чужой клиники наружу не попадает.
  const crossClinicProbes = source.match(/\.neq\("workspace_id", context\.workspaceId\)/g) || [];
  assert.equal(crossClinicProbes.length, 1, "за пределы клиники смотрит ровно один запрос");
  assert.ok(/\.select\("id"\)\s*\.eq\("auth_user_id", targetAuthUserId\)\s*\.neq\("workspace_id"/.test(source), "и берёт только id членства");
  assert.equal(scopedByFilter + scopedByColumn + crossClinicProbes.length, tableCalls, "ни одного запроса мимо своей клиники");
  assert.ok(tableCalls >= 5, "путь ходит в обе таблицы");
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

  // Пин на ОТСУТСТВИЕ. Прежняя редакция запрещала ЛЮБУЮ адресацию
  // пользователя и любой PUT: тогда законного случая писать пароль
  // существующему аккаунту не было вовсе, и запрет ловил захват чужого входа
  // одной строкой.
  //
  // Теперь такой случай появился — «задать новый пароль своему сотруднику»
  // (забытый пароль иначе чинится только письмом, а письма не доходят), и
  // запрет пришлось сузить, а не снять. Разница между законным и захватом —
  // ОТКУДА берётся адрес: захват требует идентификатора аккаунта из запроса,
  // законный путь читает его из строки staff_users своей клиники. Пины ниже
  // держат именно это.
  assert.equal((source.match(/\/auth\/v1\/admin\/users/g) || []).length, 2, "к Admin API ходят ровно дважды: создать и сменить пароль");
  const addressed = source.match(/\/auth\/v1\/admin\/users\/\$\{[^}]+\}/g) || [];
  assert.equal(addressed.length, 1, "конкретный пользователь адресуется ровно в одном месте");
  assert.equal(addressed[0], "/auth/v1/admin/users/${encodeURIComponent(targetAuthUserId)}", "и только идентификатором из строки сотрудника");
  // targetAuthUserId читается ИЗ БАЗЫ по своей клинике, а не из тела.
  assert.ok(
    /const targetAuthUserId = readString\(target\.auth_user_id\);/.test(source),
    "идентификатор аккаунта приходит из строки сотрудника",
  );
  assert.ok(
    /\.eq\("id", staffUserId\)\s*\.eq\("workspace_id", context\.workspaceId\)/.test(source),
    "строка сотрудника отбирается по своей клинике",
  );
  assert.ok(!/body\.authUserId|body\.auth_user_id/.test(source), "идентификатор аккаунта не принимается из запроса");
  assert.ok(!/method: "DELETE"/.test(source), "аккаунты отсюда не удаляются");
  assert.ok(!/generate_link|\/auth\/v1\/recover/.test(source), "и ссылки за человека не выписываются");

  // «Себе нельзя» — словами, а не косвенно через дедуп. Сравнение с ИТОГОВЫМ
  // адресом, а не с сырым body.email: на пути логина body.email пуст, и
  // проверка молчала бы — осталась бы только косвенная (already_member),
  // которая исчезает при первом же послаблении дедупа.
  assert.ok(
    /normalizeEmail\(context\.email\) === normalizeEmail\(validated\.email\)/.test(source),
    "свой вход отбивается явной проверкой по итоговому адресу",
  );
  const selfCheckAt = source.indexOf("normalizeEmail(context.email) === normalizeEmail(validated.email)");
  const validateAt = source.indexOf("const validated = validateStaffCredentialsRequest");
  assert.ok(validateAt > 0 && selfCheckAt > validateAt, "и стоит после валидации, где адрес уже известен");

  // Непогашенное приглашение — второй путь в ту же клинику: молчать о сбое
  // отзыва нельзя.
  assert.ok(/const \{ error: revokeError \}/.test(source) && /if \(revokeError\)/.test(source), "сбой отзыва приглашений называется");

  // Отказы оставляют след с причиной — иначе жалобу «не могу завести
  // сотрудника» нечем расследовать.
  assert.ok((source.match(/auditRefusal\(/g) || []).length >= 4, "каждый класс отказа попадает в журнал");
});

test("SC4d занятая почта отдаёт готовую ссылку-приглашение, а не тупик", async () => {
  // Аккаунт может существовать и потому, что наш собственный заход оборвался
  // после его создания: тогда человек уже есть в Auth, а сотрудником не стал,
  // и вход показывает «аккаунт не привязан к клинике». Приглашение — путь,
  // где человек соглашается сам, и ссылка нужна сразу: письма не доходят.
  const source = (await readFile(modulePath, "utf8")).replace(/(^|\s)\/\/[^\n]*/g, "$1");
  assert.ok(/issueInvitationFor\(supabase, req, context, validated\)/.test(source), "отказ выписывает приглашение");
  assert.ok(/data: \{ acceptUrl: invitation\.acceptUrl/.test(source), "и возвращает ссылку администратору");
  // Два живых токена на одну почту — два пути в клинику: прежние отзываются.
  const helper = source.slice(source.indexOf("async function issueInvitationFor"), source.indexOf("export type StaffCredentialsRejection"));
  assert.ok(helper.indexOf("revoked_at") < helper.indexOf("createInvitationToken()"), "прежние приглашения гасятся до выписки нового");
  assert.ok(/invited_by_staff_user_id: context\.staffUserId/.test(helper), "в приглашении видно, кто его выписал");
  assert.ok(/token_hash: tokenHash/.test(helper), "в базе только хэш токена");

  const admin = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdminCenter.tsx"), "utf8");
  assert.ok(/responseBody\.data\?\.acceptUrl/.test(admin), "экран читает ссылку из отказа");
  assert.ok(/setStaffMode\("invite"\)/.test(admin), "и показывает её в режиме приглашения");
});

test("SC7 смена пароля: только своему сотруднику, ниже своей роли, и никогда себе", async () => {
  const source = (await readFile(modulePath, "utf8")).replace(/(^|\s)\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, " ");
  const reset = source.slice(source.indexOf("export async function handleStaffPasswordReset"), source.indexOf("export async function handleStaffCredentials"));
  assert.ok(reset.length > 0, "обработчик смены пароля существует");

  // Себе — отказ: свой пароль обязан знать только его владелец, и путь для
  // этого один — «Забыли пароль?».
  assert.ok(/staffUserId === context\.staffUserId/.test(reset), "своя строка отбивается явной проверкой");
  assert.ok(/Забыли пароль/.test(reset), "и отказ называет работающий путь");

  // Роль цели строго ниже своей; владелец недоступен никому — его пароль
  // последний ключ от клиники.
  assert.ok(/canAssignRole\(context\.role, targetRole\)/.test(reset), "роль цели сравнивается с ролью актора");

  // Цель — член ЭТОЙ клиники: чужая строка не найдётся фильтром, и ответ на
  // чужой идентификатор неотличим от ответа на несуществующий.
  assert.ok(/\.eq\("workspace_id", context\.workspaceId\)/.test(reset), "строка отбирается по своей клинике");
  assert.ok(/code: "staff_not_found"/.test(reset), "чужой и несуществующий сотрудник отвечают одинаково");

  // Непривязанному входу менять нечего — это отдельный внятный отказ, а не 502.
  assert.ok(/code: "staff_not_linked"/.test(reset), "сотрудник без входа получает свой отказ");

  // ГЛАВНАЯ ГРАНИЦА: проверки выше закрывают СТРОКУ, а пароль пишется в
  // АККАУНТ, общий на всю платформу. Клиника B, законно зачислившая владельца
  // клиники A рядовым мастером, иначе получала бы вход в клинику A целиком.
  assert.ok(/code: "account_shared_with_other_clinic"/.test(reset), "аккаунт, работающий в другой клинике, не трогается");
  assert.ok(
    /\.eq\("auth_user_id", targetAuthUserId\)\s*\.neq\("workspace_id", context\.workspaceId\)/.test(reset),
    "чужие членства этого аккаунта ищутся явным запросом",
  );
  assert.ok(
    reset.indexOf('.neq("workspace_id", context.workspaceId)') < reset.indexOf("/auth/v1/admin/users/"),
    "и проверка стоит ДО записи пароля",
  );
  assert.ok(/platformOwnerIds\(\)\.includes\(targetAuthUserId\)/.test(reset), "владельцу платформы пароль отсюда не меняется");

  // Пауза: членства отбираются по status active, поэтому «пароль задан» без
  // активации обещал бы вход, которого не будет, и убивал бы прежний пароль.
  assert.ok(/code: "staff_paused"/.test(reset), "сотруднику на паузе пароль не меняется молча");
  assert.ok(/select\("id, role, status, auth_user_id, full_name"\)/.test(reset), "статус читается вместе со строкой");

  // Пароль не оседает нигде: в ответе его нет, в журнале его нет, в таблицу
  // пишется только честный флаг «пароль задал не сотрудник».
  const responses = reset.match(/sendJson\(res,[\s\S]*?\}\);/g) || [];
  for (const literal of responses) {
    assert.ok(!/password/i.test(literal.replace(/password_rejected|invalid_staff_credentials/g, "")), "ответ без пароля");
  }
  assert.ok(/password_reset_required: true/.test(reset), "флаг «пароль задал не сотрудник» ставится");
  assert.ok(/\[staff-credentials\] reset workspace=/.test(reset), "смена оставляет след с актором и сотрудником");

  const admin = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdminCenter.tsx"), "utf8");
  assert.ok(/method: "PATCH"/.test(admin) && /staffUserId: member\.id/.test(admin), "экран называет строку сотрудника, а не аккаунт");
  assert.ok(/kind: "reset"/.test(admin), "результат отличает смену пароля от заведения");
  // Смена ломает работающий пароль мгновенно: случайный клик по соседней
  // кнопке выкинул бы человека из системы посреди смены.
  const resetHandler = admin.slice(admin.indexOf("async function resetStaffPassword"), admin.indexOf("async function copyStaffCredentials"));
  assert.ok(/window\.confirm\(/.test(resetHandler), "смена пароля требует подтверждения");
  assert.ok(
    resetHandler.indexOf("window.confirm(") < resetHandler.indexOf("generateStaffPassword()"),
    "и подтверждение спрашивается до запроса, а не после",
  );
  assert.ok(/staff_not_linked/.test(admin) && /auth_account_missing/.test(admin), "новые отказы переведены на русский");
});

test("SC5 маршрут закрыт правом manage_staff: POST заводит, PATCH меняет пароль", async () => {
  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");
  // PATCH добавлен осознанно: смена пароля — та же ответственность (кто
  // получает доступ к клинике), поэтому то же право, тот же ресурс, тот же
  // модуль. Разводить это по двум маршрутам значило бы дать двум близнецам
  // разные замки.
  assert.ok(
    /"staff-credentials": \{\s*kind: "browser",\s*methods: \["POST", "PATCH"\],\s*permissions: \{ POST: "manage_staff", PATCH: "manage_staff" \},/.test(registry),
    "browser-маршрут, оба глагола за manage_staff",
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
  // Пароль по-прежнему берётся ТОЛЬКО из состояния экрана: сервер его не
  // возвращает и не хранит. А вот адрес теперь приезжает с сервера — при входе
  // по логину он мог получить хвост из-за столкновения, и печать отправленного
  // значения выдала бы человеку логин, которым нельзя войти.
  assert.ok(/setCreatedStaff\(\{ email: issued, password: staffPassword, kind: "created" \}\)/.test(admin), "пароль из состояния экрана, адрес — из ответа сервера");
  assert.ok(/const issued = responseBody\.data\?\.login \|\| responseBody\.data\?\.email/.test(admin), "показывается выданный логин");
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

// ── Смена пароля самим сотрудником ──────────────────────────────────────────
//
// Владелец попросил: «после пароли в настройках могут поменять сами же
// сотрудники». Форма профиля для этого уже была, но с двумя дырами: правила
// пароля в ней были свои (шесть символов против восьми на сервере), а сама она
// жила в боковом меню, скрытом на телефоне классом `hidden md:block`, — то есть
// в салоне, где работают с телефонов, сменить пароль было нельзя вообще.

/** Пины должны цепляться за код, а не за прозу: комментарии вырезаем. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const profileDialogPath = path.join(
  repoRoot, "artifacts", "negis", "src", "components", "layout", "ProfileDialog.tsx",
);

test("SC8 правила пароля одни на сервер и на кабинет", async () => {
  const rules = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "auth", "password-rules.ts")).href
  )) as { validatePasswordRules: (value: unknown) => string[] };

  assert.equal(rules.validatePasswordRules("Xk7mPq2wRt").length, 0, "нормальный пароль проходит");
  assert.ok(rules.validatePasswordRules("Xk7mPq2").length > 0, "семь символов — отказ, а кабинет пускал шесть");
  assert.ok(rules.validatePasswordRules(`${"а".repeat(37)}`).length > 0, "37 кириллических букв — это 74 байта, bcrypt обрежет");
  assert.ok(rules.validatePasswordRules("Xk7mPq2wRt ").length > 0, "хвостовой пробел теряется при передаче");
  assert.ok(rules.validatePasswordRules(123).length > 0, "не строка — не пароль");

  // Сервер обязан делегировать, иначе числа разъедутся снова.
  const onboarding = stripComments(await readFile(
    path.join(repoRoot, "lib", "crm", "platform-onboarding-credentials.ts"), "utf8",
  ));
  assert.ok(/validatePasswordRules/.test(onboarding), "validateOwnerPassword зовёт общие правила");
  assert.ok(!/password\.length < 8/.test(onboarding), "своей копии минимума на сервере не осталось");

  const dialog = stripComments(await readFile(profileDialogPath, "utf8"));
  assert.ok(/validatePasswordRules/.test(dialog), "кабинет судит по тем же правилам");
  assert.ok(!/length < 6/.test(dialog), "шестизначный минимум в кабинете не воскресает");
});

test("SC9 свой пароль меняют, предъявив текущий, и рабочую сессию это не трогает", async () => {
  const dialog = stripComments(await readFile(profileDialogPath, "utf8"));

  // Порядок обязателен: сначала проверка текущего пароля, потом запись нового.
  const checkAt = dialog.indexOf("await verifyCurrentPassword(");
  const updateAt = dialog.indexOf("supabase.auth.updateUser");
  assert.ok(checkAt > 0, "текущий пароль проверяется");
  assert.ok(updateAt > checkAt, "проверка идёт ДО записи нового пароля");
  assert.ok(/if \(!currentPassword\)/.test(dialog), "без текущего пароля смена не начинается");
  assert.ok(/newPassword !== repeatPassword/.test(dialog), "опечатка в новом пароле — потерянный доступ, поэтому повтор");

  // Намерение сменить пароль определяют ТОЛЬКО поля нового пароля: пока в счёт
  // шло и поле «текущий», менеджер паролей подставлял его сам, и человек,
  // менявший одно лишь имя, упирался в претензию к нетронутому полю.
  assert.ok(
    /const wantsPasswordChange = newPassword\.length > 0 \|\| repeatPassword\.length > 0;/.test(dialog),
    "заполненный «текущий пароль» сам по себе не превращает сохранение имени в смену пароля",
  );

  // Проверка не трогает основной клиент: удачный вход подменил бы сессию и
  // перечитал членства — человека с двумя клиниками выбросило бы в выбор
  // клиники посреди диалога.
  assert.ok(!/supabase\.auth\.signInWithPassword/.test(dialog), "основной клиент паролем не логинится");
  assert.ok(!/createClient\(/.test(dialog), "второго клиента Supabase диалог не создаёт");

  const client = stripComments(await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "lib", "supabase.ts"), "utf8",
  ));
  // Три исхода, а не два: сеть и 429 не имеют права выглядеть как «пароль неверный».
  assert.ok(/PasswordCheck = 'ok' \| 'wrong' \| 'unavailable'/.test(client), "у проверки три исхода");
  assert.ok(/scope=local/.test(client), "сессию проверки гасят локально");
  assert.ok(!/scope=global/.test(client), "глобальный выход завершил бы и рабочую сессию");
  assert.ok(/if \(check === 'unavailable'\)/.test(dialog), "недоступность проверки — отдельный ответ человеку");

  // Закрыть диалог во время записи нельзя: человек уходил уверенным, что
  // отменил, а пароль тем временем менялся.
  assert.ok(/if \(saving\) return;/.test(dialog), "«Отмена» и подложка заблокированы на время записи");
});

test("SC10 под имперсонацией и без своей сессии диалог не пишет НИЧЕГО", async () => {
  const dialog = stripComments(await readFile(profileDialogPath, "utf8"));

  // Сессия имперсонации принадлежит ВЛАДЕЛЬЦУ клиники: её выдаёт магической
  // ссылкой /api/impersonation/session. И пароль, и user_metadata.full_name —
  // поля одного и того же ГЛОБАЛЬНОГО аккаунта, поэтому запрет обязан стоять на
  // всей записи. Ревью поймало, что он стоял только на ветке пароля: сотрудник
  // платформы переименовывал владельца во всех его клиниках, и выглядело это
  // как действие самого владельца.
  assert.ok(
    /const canEditAccount = Boolean\(session\?\.user\?\.id\) && !isImpersonation && !isDemoMode/.test(dialog),
    "право писать в аккаунт — только своя настоящая сессия",
  );
  assert.ok(/if \(!canEditAccount\) \{ toast\.error\(blockedReason\); return; \}/.test(dialog),
    "запрет стоит первым в пути сохранения, до всякой ветки про пароль");
  const guardAt = dialog.indexOf("if (!canEditAccount)");
  const nameWriteAt = dialog.indexOf("data: { full_name: name }");
  assert.ok(guardAt > 0 && nameWriteAt > guardAt, "запись имени идёт ПОСЛЕ запрета, а не мимо него");

  // Экраны восстановления — второй путь к тому же аккаунту. Форма нового пароля
  // не имеет права открываться по одной лишь живой сессии.
  const reset = stripComments(await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "pages", "ResetPassword.tsx"), "utf8",
  ));
  assert.ok(/arrivedByRecoveryLink/.test(reset), "форма открывается по приходу со ссылки восстановления");
  assert.ok(!/getSession\(\)\.then/.test(reset), "живой сессии самой по себе для смены пароля мало");
  assert.ok(/validatePasswordRules/.test(reset), "и правила пароля там общие, а не своя копия");
});

test("SC11 профиль открывается и с телефона", async () => {
  const mobile = stripComments(await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "components", "layout", "MobileNav.tsx"), "utf8",
  ));
  assert.ok(/import \{ ProfileDialog \}/.test(mobile), "мобильное меню знает диалог профиля");
  assert.ok(/showProfile && <ProfileDialog/.test(mobile), "и показывает его");
  assert.ok(/setShowProfile\(true\)/.test(mobile), "в ящике есть пункт, который его открывает");

  // Боковое меню — вторая поверхность того же диалога, своей копии формы там
  // больше нет: две копии разъехались бы правилами, как разъехались числа.
  const sidebar = stripComments(await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "components", "layout", "Sidebar.tsx"), "utf8",
  ));
  assert.ok(/showProfile && <ProfileDialog/.test(sidebar), "боковое меню зовёт тот же диалог");
  assert.ok(!/auth\.updateUser/.test(sidebar), "своей формы смены пароля в сайдбаре не осталось");

  // Именно это и было сломано: сайдбар на телефоне не отрисовывается.
  const layout = await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "components", "layout", "PageLayout.tsx"), "utf8",
  );
  assert.ok(/hidden md:block[\s\S]{0,80}<Sidebar \/>/.test(layout), "сайдбар по-прежнему скрыт на узких экранах");
});
