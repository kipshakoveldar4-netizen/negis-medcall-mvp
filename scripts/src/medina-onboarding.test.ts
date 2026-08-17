import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// MB — подключение клиники с портала Medina Control.
//
// Форма заменяет provision-скрипт, но не его принципы: ни одной выдуманной
// строки, ниша без умолчания, пароль не проходит нигде. Набор закрепляет
// ровно эти принципы плюс честность полусозданного состояния.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "crm", "platform-onboarding.ts");
const credsPath = path.join(repoRoot, "lib", "crm", "platform-onboarding-credentials.ts");
const controlSrc = path.join(repoRoot, "artifacts", "medina-control", "src");

type OnboardingModule = {
  validateOnboardingRequest: (body: Record<string, unknown>) =>
    | { name: string; vertical: string; ownerEmail: string; ownerName: string; timeZone: string }
    | { status: number; error: string; code: string; details?: string[] };
};

const { validateOnboardingRequest } = (await import(pathToFileURL(modulePath).href)) as OnboardingModule;

const VALID = {
  name: "Салон Люкс",
  vertical: "beauty",
  ownerEmail: "Owner@Salon.kz",
  ownerName: "Имя Владельца",
  timeZone: "Asia/Almaty",
};

test("MB1 ниша обязательна и умолчания у неё нет", () => {
  const missing = validateOnboardingRequest({ ...VALID, vertical: "" });
  assert.ok("status" in missing && missing.status === 400, "без ниши — отказ");

  const wrong = validateOnboardingRequest({ ...VALID, vertical: "salon" });
  assert.ok("status" in wrong, "выдуманная ниша — отказ, а не подстановка клиники");

  const ok = validateOnboardingRequest(VALID);
  assert.ok(!("status" in ok));
  assert.equal(ok.vertical, "beauty");
  assert.equal(ok.ownerEmail, "owner@salon.kz", "почта нормализуется");
});

test("MB2 часовой пояс проверяется, имя подставляется из почты", () => {
  const badZone = validateOnboardingRequest({ ...VALID, timeZone: "Asia/Nowhere" });
  assert.ok("status" in badZone, "нераспознанный пояс — отказ");

  const noZone = validateOnboardingRequest({ ...VALID, timeZone: "" });
  assert.ok("status" in noZone, "пояс обязателен");

  const noName = validateOnboardingRequest({ ...VALID, ownerName: "" });
  assert.ok(!("status" in noName));
  assert.equal(noName.ownerName, "owner@salon.kz", "пустое имя — почта, а не выдумка");
});

test("MB3 инвайт-путь паролей не видит, парольный путь заперт в своём модуле", async () => {
  // Раньше пароль не проходил через подключение нигде. С появлением
  // упрощённого пути (владелец платформы задаёт логин и пароль сам — его
  // явное решение от 2026-08-17) правило сузилось, но не исчезло: инвайт-путь
  // остаётся слепым к паролям, а парольный живёт в единственном модуле,
  // и его собственные инварианты закрепляет MB10.
  const server = await readFile(modulePath, "utf8");
  for (const word of ["password", "createUser", "auth.admin"]) {
    assert.ok(!server.toLowerCase().includes(word.toLowerCase()), `инвайт-сервер: нет ${word}`);
  }
  const form = await readFile(path.join(controlSrc, "screens", "Onboarding.tsx"), "utf8");
  assert.ok(form.includes("/join"), "форма объясняет путь через страницу приглашения");
  assert.ok(
    /body: JSON\.stringify\(\{ name, vertical, ownerEmail, ownerName, timeZone, \.\.\.\(confirmAdditional \? \{ confirmAdditionalWorkspace: true \} : \{\}\) \}\),/.test(form),
    "инвайт-POST собирается без поля password, даже если оно заполнено",
  );
  assert.ok(form.includes("platform-onboarding-credentials"), "парольный режим зовёт свой отдельный маршрут");
});

test("MB14 вторая клиника той же почте — только по явному подтверждению, частичные отказы ведут в перевыпуск", async () => {
  // Молчаливый дубль был главным источником путаницы: повтор формы после
  // истёкшего приглашения или парольного подключения создавал вторую клинику.
  const source = await readFile(modulePath, "utf8");
  assert.ok(/owner_already_has_workspace/.test(source), "у почты с клиникой — отказ, не дубль");
  assert.ok(/confirmAdditionalWorkspace !== true/.test(source), "явный флаг пропускает легитимные два салона");
  assert.ok(/escapeLikePattern\(validated\.ownerEmail\)/.test(source), "почта в проверках — значение, не LIKE-шаблон");
  const partials = source.match(/data: \{ existingWorkspaceId: workspaceId \}/g) || [];
  assert.ok(partials.length >= 2, "оба частичных отказа несут id для кнопки перевыпуска");
  assert.ok(!/этой же формой/.test(source), "совет «повторите этой же формой» изгнан: он создавал дубль");

  const creds = await readFile(credsPath, "utf8");
  assert.ok((creds.match(/data: \{ existingWorkspaceId: workspaceId \}/g) || []).length >= 2, "парольные частичные отказы тоже несут id");

  const form = await readFile(path.join(controlSrc, "screens", "Onboarding.tsx"), "utf8");
  assert.ok(/Да, создать вторую клинику/.test(form), "подтверждение дубля — явная кнопка");
  assert.ok(/partial_onboarding/.test(form) && /partial_credentials_onboarding/.test(form), "кнопка перевыпуска знает частичные коды");
  // Якорь — сам onChange поля почты: пин, который удовлетворяется любым
  // упоминанием clearOutcome, вакуумный.
  assert.ok(
    /setOwnerEmail\(event\.target\.value\);\s*clearOutcome\(\);/.test(form),
    "правка почты гасит прежний отказ и его кнопки",
  );

  // Парольный путь закрыт тем же guard-ом ДО createUser: без него повтор
  // подключения после истёкшего приглашения без Auth-аккаунта молча создавал
  // вторую клинику — ровно в режиме по умолчанию.
  const credsSource = await readFile(credsPath, "utf8");
  assert.ok(/owner_already_has_workspace/.test(credsSource), "парольный путь: у почты с клиникой — отказ с перевыпуском");
  assert.ok(
    credsSource.indexOf("owner_already_has_workspace") < credsSource.indexOf("/auth/v1/admin/users"),
    "проверка владения стоит до создания аккаунта",
  );
});

test("MB10 парольный путь: без письма, пароль не сохраняется и не возвращается", async () => {
  // Все проверки — по коду без комментариев: пин, который удовлетворяется
  // строкой из шапки-комментария, вакуумный (урок этого репо — VT12).
  const creds = (await readFile(credsPath, "utf8"))
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  // Прямой вызов Admin API: supabase-js 2.105 больше не возит auth.admin —
  // клиентский вызов упал бы и в типах (сборка Vercel это поймала), и в
  // рантайме.
  assert.ok(creds.includes("/auth/v1/admin/users"), "аккаунт создаёт GoTrue Admin API — пароль уходит только туда, в хэш");
  assert.ok(/email_confirm: true,/.test(creds), "подтверждающее письмо не отправляется — в этом смысл пути");
  // Ни в одну таблицу пароль не пишется: в insert-литералах слово password
  // допустимо только как имя флага password_reset_required.
  const inserts = creds.match(/\.insert\((\{[\s\S]*?\}|\[[\s\S]*?\])\)/g) || [];
  assert.ok(inserts.length >= 3, "все три insert найдены");
  for (const literal of inserts) {
    assert.ok(!/password(?!_reset_required)/i.test(literal), "insert без пароля");
  }
  // Каждый insert — литерал на месте: insert(переменная) регекс бы не увидел.
  assert.equal((creds.match(/\.insert\(/g) || []).length, inserts.length, "инсертов через переменную нет");
  // Обходных путей пароля наружу нет: модуль не апдейтит, не логирует и
  // отвечает только через локальный sendJson.
  assert.ok(!/\.update\(|\.upsert\(/.test(creds), "модуль только вставляет");
  assert.ok(!/console\./.test(creds), "модуль ничего не логирует");
  assert.equal((creds.match(/res\.status\(/g) || []).length, 1, "единственный выход наружу — sendJson");
  // И ни в один ответ пароль не попадает — даже в детали ошибок.
  // password_rejected — имя кода отказа, не значение: единственное исключение.
  for (const literal of creds.match(/sendJson\(res,[\s\S]*?\}\);/g) || []) {
    assert.ok(!/password/i.test(literal.replace(/password_rejected/g, "")), "ответ без пароля");
  }
  // Якорь — сам insert пространства: read-only выборки (имя клиники для 409)
  // стоят раньше createUser и мусора не оставляют.
  assert.ok(
    creds.indexOf("/auth/v1/admin/users") < creds.indexOf(".insert({ name: validated.name"),
    "аккаунт создаётся раньше insert пространства: отказ «почта занята» не оставляет мусора",
  );
  assert.ok(/email_already_registered/.test(creds), "занятая почта — явный отказ: пароль чужому аккаунту не задаётся");
  assert.ok(/password_reset_required: true/.test(creds), "пароль задал не владелец — флаг честный");
  assert.ok(/role: "owner"/.test(creds) && /auth_user_id: authUserId/.test(creds), "владелец привязан входом с первой секунды");
  // Почта в дедуп-проверках — значение, не LIKE-шаблон: «_» без экранирования
  // матчил бы чужую почту, и 409 принёс бы чужой existingWorkspaceId.
  assert.equal((creds.match(/\.ilike\(/g) || []).length, (creds.match(/\.ilike\("[^"]+", escapeLikePattern\(/g) || []).length, "каждый ilike экранирован");
});

test("MB11 парольный маршрут платформенный, только POST, правила формы общие", async () => {
  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");
  assert.ok(/"platform-onboarding-credentials": \{ kind: "platform", methods: \["POST"\] \}/.test(registry));
  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  assert.ok(/case "platform-onboarding-credentials":\s*return handlePlatformOnboardingCredentials\(req, res\);/.test(router));
  const creds = await readFile(credsPath, "utf8");
  assert.ok(/validateOnboardingRequest\(/.test(creds), "ниша без умолчания, пояс и почта — теми же правилами, что у инвайта");
  assert.ok(/invitation_already_pending/.test(creds), "живое приглашение той же почты блокирует и парольный путь");
});

type CredsModule = { validateOwnerPassword: (value: unknown) => string[] };
const { validateOwnerPassword } = (await import(pathToFileURL(credsPath).href)) as CredsModule;

test("MB12 правила пароля: 8 символов — 72 байта, не из одних пробелов", () => {
  assert.ok(validateOwnerPassword("Ab3defg").length > 0, "короче 8 — отказ");
  assert.equal(validateOwnerPassword("Ab3defgh").length, 0, "8 символов проходят");
  assert.equal(validateOwnerPassword("x".repeat(72)).length, 0, "72 байта проходят");
  assert.ok(validateOwnerPassword("x".repeat(73)).length > 0, "длиннее 72 байт — отказ: bcrypt молча обрезал бы");
  // Предел меряется байтами: 37 кириллических букв — это 74 байта UTF-8.
  assert.ok(validateOwnerPassword("я".repeat(37)).length > 0, "кириллица считается за два байта");
  assert.equal(validateOwnerPassword("я".repeat(36)).length, 0, "36 кириллических букв (72 байта) проходят");
  assert.ok(validateOwnerPassword("        ").length > 0, "восемь пробелов — не пароль");
  // Хвостовой пробел невидим на экране и теряется при передаче: владелец
  // получил бы «Invalid login credentials» без шанса понять почему.
  assert.ok(validateOwnerPassword("Secret123 ").length > 0, "хвостовой пробел — отказ");
  assert.ok(validateOwnerPassword(" Secret123").length > 0, "ведущий пробел — отказ");
  assert.ok(validateOwnerPassword(undefined).length > 0, "отсутствие пароля — отказ");
});

test("MB13 портал: парольный режим по умолчанию, пароль показывается один раз", async () => {
  const form = await readFile(path.join(controlSrc, "screens", "Onboarding.tsx"), "utf8");
  assert.ok(/useState<Mode>\("credentials"\)/.test(form), "упрощённый путь — умолчание: его и просили");
  assert.ok(/email_already_registered/.test(form) && /Переключить на приглашение/.test(form), "занятая почта ведёт в инвайт-режим кнопкой");
  assert.ok(/setShownPassword\(password\)/.test(form) && /setPassword\(""\)/.test(form), "пароль переезжает на экран результата и очищается в форме");
  assert.ok(/generatePassword/.test(form), "пароль можно сгенерировать, а не выдумывать на ходу");
});

test("MB4 приглашение владельца — той же машинерией, что у сотрудников", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.ok(/createInvitationToken\(\)/.test(source), "токен из общего модуля");
  assert.ok(/token_hash: tokenHash/.test(source), "в базе только хэш");
  assert.ok(/role: "owner"/.test(source), "роль — владелец нового пространства");
  assert.ok(/invited_by_staff_user_id: null/.test(source), "приглашает платформа, а не сотрудник");
  assert.ok(/sendSupabaseInviteEmail\(/.test(source), "письмо — best effort тем же путём");
});

test("MB5 полусозданное состояние называется, а не угадывается", async () => {
  const source = await readFile(modulePath, "utf8");
  const partials = source.match(/partial_onboarding/g) || [];
  assert.equal(partials.length, 2, "оба поздних отказа помечены");
  assert.ok(/Пространство \$\{workspaceId\}/.test(source), "и называют созданное пространство по id");
});

test("MB6 живое приглашение той же почты не даёт создать второе пространство", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.ok(/invitation_already_pending/.test(source), "повтор — явный отказ");
  assert.ok(/\.gt\("expires_at"/.test(source), "истёкшие приглашения не блокируют");
  assert.ok(/\.is\("accepted_at", null\)/.test(source) && /\.is\("revoked_at", null\)/.test(source), "принятые и отозванные — тоже");
});

test("MB7 маршрут платформенный и только POST", async () => {
  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");
  assert.ok(/"platform-onboarding": \{ kind: "platform", methods: \["POST"\] \}/.test(registry));
  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  assert.ok(/case "platform-onboarding":\s*return handlePlatformOnboarding\(req, res\);/.test(router));
});

test("MB9 живое приглашение — не тупик: перевыпуск отзывает старое и выписывает новое", async () => {
  const source = await readFile(modulePath, "utf8");
  const reissue = source.slice(
    source.indexOf("export async function handlePlatformInvitationReissue"),
    source.indexOf("export async function handlePlatformOnboarding"),
  );
  assert.ok(reissue.length > 0, "обработчик перевыпуска существует");
  // Сначала отзыв, потом новая ссылка: два живых токена на одну почту — это
  // два пути в одно пространство, и потерянный никто бы не отозвал.
  assert.ok(
    reissue.indexOf("revoked_at: now") < reissue.indexOf("createInvitationToken()"),
    "старые приглашения отзываются до выписки нового",
  );
  assert.ok(/owner_already_member/.test(reissue), "принявшего владельца не приглашают второй раз");

  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");
  assert.ok(/"platform-invitation-reissue": \{ kind: "platform", methods: \["POST"\] \}/.test(registry));
  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  assert.ok(/case "platform-invitation-reissue":\s*return handlePlatformInvitationReissue\(req, res\);/.test(router));

  const form = await readFile(path.join(controlSrc, "screens", "Onboarding.tsx"), "utf8");
  assert.ok(/invitation_already_pending/.test(form) && /Перевыпустить приглашение/.test(form), "409 формы предлагает перевыпуск на месте");
});

test("MB8 портал показывает ссылку один раз и не выбирает нишу молча", async () => {
  const form = await readFile(path.join(controlSrc, "screens", "Onboarding.tsx"), "utf8");
  assert.ok(/<option value="">/.test(form), "первый пункт ниши пуст — выбор обязателен");
  assert.ok(/result\.acceptUrl/.test(form), "ссылка отдаётся владельцу платформы");
  assert.ok(/показывается один раз/i.test(form), "и портал говорит, что второй раз её не покажут");
  const app = await readFile(path.join(controlSrc, "App.tsx"), "utf8");
  assert.ok(app.includes("Подключить клинику"), "пункт меню ведёт к работающей форме");
});
