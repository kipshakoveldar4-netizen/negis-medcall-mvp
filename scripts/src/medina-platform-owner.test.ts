import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// PO — панель владельца ПЛАТФОРМЫ.
//
// Это единственное место в продукте, которое читает поперёк арендаторов
// сознательно и широко, то есть делает ровно то, что весь предыдущий этап
// безопасности запрещал. Поэтому проверок здесь больше, чем кода.
//
// Главное, что они держат: доступ не выдаётся ролью. Все шесть ролей живут в
// staff_users и назначаются владельцем КЛИНИКИ — значит роль «владелец
// платформы» он рано или поздно назначит себе, и никакая проверка внутри
// приложения этому не помешает. Список в переменной окружения правит только
// тот, у кого есть доступ к развёртыванию.
//
// Ничего здесь не обращается к production, к базе и к сети.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const platformAuthPath = path.join(repoRoot, "lib", "auth", "platform.ts");
const platformHandlerPath = path.join(repoRoot, "lib", "crm", "platform.ts");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const registryPath = path.join(repoRoot, "lib", "crm", "authorization.ts");
const migrationPath = path.join(repoRoot, "migrations", "034_platform_subscriptions.sql");

type PlatformModule = {
  parsePlatformOwnerIds: (raw: string | undefined) => string[];
  platformOwnerIds: (env?: NodeJS.ProcessEnv) => string[];
  PLATFORM_OWNER_ENV: string;
  PlatformAuthError: new () => Error & { statusCode: number; code: string };
};

const platform = (await import(pathToFileURL(platformAuthPath).href)) as PlatformModule;

async function codeOf(file: string): Promise<string> {
  const source = await readFile(file, "utf8");
  return source
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ");
}

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

test("PO1 пустой список означает «выключено», а не «пускать всех»", () => {
  assert.deepEqual(platform.parsePlatformOwnerIds(undefined), []);
  assert.deepEqual(platform.parsePlatformOwnerIds(""), []);
  assert.deepEqual(platform.parsePlatformOwnerIds("   "), []);

  // Умолчание — единственное, что стоит между владельцем клиники и данными
  // всех остальных клиник, и оно обязано быть отказом.
  const code = platform.PlatformAuthError;
  const refusal = new code();
  assert.equal(refusal.statusCode, 404);
});

test("PO2 в список попадают только настоящие идентификаторы", () => {
  // Заготовка в файле развёртывания не должна становиться пропуском.
  assert.deepEqual(platform.parsePlatformOwnerIds("замените_меня"), []);
  assert.deepEqual(platform.parsePlatformOwnerIds("admin"), []);
  assert.deepEqual(platform.parsePlatformOwnerIds("*"), []);
  assert.deepEqual(platform.parsePlatformOwnerIds("00000000-0000-0000-0000-000000000000"), []);

  assert.deepEqual(platform.parsePlatformOwnerIds(OWNER_A), [OWNER_A]);
  assert.deepEqual(platform.parsePlatformOwnerIds(`${OWNER_A}, ${OWNER_B}`), [OWNER_A, OWNER_B]);
  assert.deepEqual(platform.parsePlatformOwnerIds(`${OWNER_A} ${OWNER_B}`), [OWNER_A, OWNER_B]);
  assert.deepEqual(platform.parsePlatformOwnerIds(`${OWNER_A},${OWNER_A}`), [OWNER_A], "повтор не удваивает");
  assert.deepEqual(platform.parsePlatformOwnerIds(OWNER_A.toUpperCase()), [OWNER_A], "регистр не важен");
});

test("PO3 отказ ничего не рассказывает о списке", () => {
  const refusal = new platform.PlatformAuthError();

  assert.equal(refusal.message, "Not found");
  assert.equal(refusal.code, "not_found");
  // 404, а не 403: существование панели — тоже сведения. Владельцу клиники
  // незачем знать, что в продукте есть экран со списком всех клиник.
  assert.equal(refusal.statusCode, 404);

  const text = `${refusal.message} ${JSON.stringify(refusal)}`;
  assert.ok(!text.includes(OWNER_A), "идентификаторы не утекают в текст ошибки");
  assert.ok(!/список|allowlist|env/i.test(text), "и о самом списке отказ не говорит");
});

test("PO4 значение переменной окружения не выводится нигде", async () => {
  const auth = await readFile(platformAuthPath, "utf8");
  const handler = await readFile(platformHandlerPath, "utf8");

  for (const [name, source] of [["gate", auth], ["handler", handler]] as const) {
    assert.ok(!/console\.(log|info|warn|error)/.test(source), `${name}: панель не пишет в лог`);
  }
  // Имя переменной — не секрет, а её значение возвращать нельзя ни в каком виде.
  assert.ok(auth.includes("MEDINA_PLATFORM_OWNER_IDS"), "имя переменной объявлено одним местом");
  assert.equal(platform.PLATFORM_OWNER_ENV, "MEDINA_PLATFORM_OWNER_IDS");
  assert.ok(
    !/return[^\n]*process\.env\[/.test(auth),
    "значение переменной не возвращается наружу",
  );
});

test("PO5 подлинность проверяется раньше принадлежности к списку", async () => {
  const code = await codeOf(platformAuthPath);
  const authIndex = code.indexOf("requireAuthenticatedUser");
  const listIndex = code.indexOf("platformOwnerIds()");

  assert.ok(authIndex > 0 && listIndex > 0, "оба шага на месте");
  // Обратный порядок позволил бы неаутентифицированному запросу узнать по
  // разнице ответов, пуст список или нет.
  assert.ok(authIndex < listIndex, "сначала токен, потом список");
});

test("PO6 маршрут платформы не строит контекст рабочего пространства", async () => {
  const router = await codeOf(routerPath);

  const branch = router.slice(
    router.indexOf('route.authorization.kind === "platform"'),
    router.indexOf('route.authorization.kind === "internal_hmac"'),
  );
  assert.ok(branch.length > 0, "ветка платформы существует");
  assert.ok(branch.includes("requirePlatformOwner"), "и она вызывает гейт");
  assert.ok(
    !branch.includes("attachWorkspaceContext"),
    "подставить сюда чей-то workspaceId значило бы выдать одну из клиник за «свою»",
  );
  assert.ok(!branch.includes("requireWorkspaceAccess"), "членство в клинике здесь ничего не решает");
});

test("PO7 маршруты платформы объявлены без ролей и прав клиники", async () => {
  const registry = (await import(pathToFileURL(registryPath).href)) as {
    CRM_ROUTE_AUTHORIZATION: Record<string, { kind: string; methods: string[]; roles?: unknown; permissions?: unknown }>;
    CRM_RESOURCE_AUTHORIZATION: Record<string, { kind: string }>;
  };

  const platformRoutes = Object.entries(registry.CRM_ROUTE_AUTHORIZATION).filter(
    ([, entry]) => entry.kind === "platform",
  );
  assert.ok(platformRoutes.length >= 2, "обзор и подписки");

  for (const [key, entry] of platformRoutes) {
    assert.ok(!entry.roles, `${key}: роль клиники не решает доступ`);
    assert.ok(!entry.permissions, `${key}: право клиники не решает доступ`);
    assert.ok(!entry.methods.includes("DELETE"), `${key}: удаления нет — подписка отменяется`);
  }

  for (const [key, entry] of Object.entries(registry.CRM_RESOURCE_AUTHORIZATION)) {
    assert.notEqual(entry.kind, "platform", `${key}: обычный ресурс обязан иметь арендатора`);
  }
});

test("PO8 панель не отдаёт ни одной строки пациента", async () => {
  const handler = await codeOf(platformHandlerPath);

  // «В клинике 340 клиентов» — сведения о клиенте платформы. «Айнур Садыкова,
  // +7 701…» — сведения о пациенте чужой клиники, и второго владельцу
  // платформы видеть незачем, даже если технически он может.
  assert.ok(/count: "exact", head: true/.test(handler), "счётчики считаются без выгрузки строк");

  for (const forbidden of ["full_name", "phone", "phone_normalized", "notes", "diagnosis", "amount_minor"]) {
    assert.ok(!handler.includes(`"${forbidden}"`), `панель не выбирает ${forbidden}`);
  }

  // Из клиник берутся ровно четыре административные колонки.
  assert.ok(
    handler.includes('.select("id, name, owner_email, created_at")'),
    "по клинике — только административные поля",
  );
});

test("PO9 цена нигде не подставляется по умолчанию", async () => {
  const handler = await codeOf(platformHandlerPath);
  const migration = await readFile(migrationPath, "utf8");

  // Подставленная цена на панели читается как настоящая цена продукта.
  assert.ok(!/priceMinor\s*\|\|\s*\d/.test(handler), "цена не заменяется числом при пустом значении");
  assert.ok(!/price_minor:\s*[1-9]/.test(handler), "и не назначается в коде");
  assert.ok(/price_minor bigint not null default 0/.test(migration), "в базе умолчание — ноль");

  // Ноль — законное значение: бесплатный доступ существует и это не то же
  // самое, что «цена не задана».
  assert.ok(/check \(price_minor >= 0\)/.test(migration));
});

test("PO10 годовая подписка приводится к месяцу, а валюты не складываются", async () => {
  const handler = await codeOf(platformHandlerPath);

  assert.ok(/period === "yearly"/.test(handler), "годовой период учтён");
  assert.ok(/priceMinor \/ 12/.test(handler), "и приведён к месяцу");
  // Сумма из тенге и рублей — не сумма.
  assert.ok(handler.includes("mixedCurrencies"), "разные валюты не складываются молча");
});

test("PO11 миграция подписок закрыта так же, как остальные", async () => {
  const migration = await readFile(migrationPath, "utf8");

  assert.ok(/enable row level security/.test(migration));
  assert.ok(/revoke all on table public\.platform_subscriptions from anon, authenticated/.test(migration));
  assert.ok(/grant select, insert, update\s+on table public\.platform_subscriptions\s+to service_role/.test(migration));
  assert.ok(!/grant[^;]*delete/i.test(migration), "подписка отменяется, а не удаляется");

  // Одна действующая подписка на клинику, история сохраняется.
  assert.ok(/create unique index[\s\S]{0,200}where status = 'active'/.test(migration));
});
