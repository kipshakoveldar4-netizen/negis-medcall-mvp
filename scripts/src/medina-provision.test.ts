import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// PR — провижининг настоящего рабочего пространства.
//
// Скрипт передаёт CRM живому салону, поэтому проверки здесь в основном про то,
// чего он НЕ делает. Настоящее пространство отличается от демонстрационного
// ровно одним: в нём нет ни одной выдуманной строки. Выдуманный клиент в
// настоящей CRM всплывает в отчётах, рассылках и статистике, и вычистить его
// сложнее, чем не создать.
//
// Ничего здесь не запускает скрипт против базы: проверяется исходник.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "src", "provision-workspace.ts");

const source = await readFile(scriptPath, "utf8");
const code = source
  .replace(/(^|\s)\/\/.*$/gm, "$1")
  .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ");

test("PR1 скрипт не создаёт ни одной выдуманной строки", () => {
  // Ровно четыре вставки: пространство, владелец, ниша, часовой пояс.
  const inserts = code.match(/insertOne\(\s*"([a-z_]+)"/g) || [];
  assert.equal(inserts.length, 4, `вставок ровно четыре, найдено: ${inserts.join(", ")}`);

  // И ни одна не касается данных: клиентов, заявок, записей, врачей, продаж.
  for (const table of ["clients", "leads", "appointments", "clinic_doctors", "deals", "tasks", "calls"]) {
    assert.ok(!code.includes(`"${table}"`), `таблица ${table} не трогается`);
  }
});

test("PR2 пароли не проходят через скрипт", () => {
  // Пароль — секрет. Пользователя Auth создаёт владелец платформы в панели
  // Supabase; надёжный путь — «Invite user», где салон задаёт пароль сам.
  for (const word of ["password", "createUser", "auth.admin", "service_role_key ="]) {
    assert.ok(!code.toLowerCase().includes(word.toLowerCase()), `в скрипте нет ${word}`);
  }
  assert.ok(source.includes("Invite user"), "и безопасный путь назван в подсказке");
});

test("PR3 без подтверждения скрипт отказывается", () => {
  assert.ok(code.includes('arg("confirm") !== CONFIRM'), "подтверждение обязательно");
  assert.ok(/const CONFIRM = "[А-ЯЁ-]+"/u.test(source), "и его нельзя набрать случайно");
});

test("PR4 ниша обязательна и умолчания у неё нет", () => {
  // Ниша меняет правила проверки рекламы. Выбрать её молча значило бы выбрать
  // за клиента: салон с медицинскими правилами не сможет назвать свою услугу.
  assert.ok(/vertical !== "beauty" && vertical !== "clinic"/.test(code), "только два значения");
  const required = code.slice(code.indexOf("for (const [flag, value]"), code.indexOf("] as const"));
  assert.ok(required.includes('"vertical"'), "ниша в списке обязательных");
  assert.ok(required.includes('"timezone"'), "часовой пояс тоже");
  assert.ok(required.includes('"owner-auth-id"'), "и привязка владельца");
});

test("PR5 повторный запуск не создаёт второе пространство молча", () => {
  // Скрипт не идемпотентен: второй запуск создал бы вторую клинику с тем же
  // владельцем. Существующее членство — отказ, обходится только явным флагом.
  assert.ok(/\.eq\("auth_user_id", ownerAuthId\)/.test(code), "существующие членства проверяются");
  assert.ok(/allowSecond/.test(code), "и отказ обходится только явным флагом");
  assert.ok(
    /!allowSecond && Array\.isArray\(existing\) && existing\.length > 0/.test(code),
    "флаг действительно участвует в условии, а не просто объявлен",
  );
});

test("PR6 владелец получает роль owner и активный статус", () => {
  assert.ok(/role: "owner"/.test(code), "иначе он не сможет пригласить сотрудников");
  assert.ok(/status: "active"/.test(code), "и не войдёт вовсе: сервер пускает только активные членства");
  assert.ok(/auth_user_id: ownerAuthId/.test(code), "и привязан к пользователю Auth");
});

test("PR7 ниша и пояс пишутся под теми же ключами, что читает сервер", async () => {
  const server = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");

  assert.ok(code.includes('"workspace_vertical"') || code.includes('key: "workspace_vertical"'), "ключ ниши");
  assert.ok(code.includes('"clinic_schedule"') || code.includes('key: "clinic_schedule"'), "ключ пояса");
  // Литерал ключа ниши живёт в одном месте — lib/vertical/terms.ts, — а сервер
  // берёт его оттуда константой. Проверяем оба звена, а не ищем литерал там,
  // где его по замыслу нет.
  const terms = await readFile(path.join(repoRoot, "lib", "vertical", "terms.ts"), "utf8");
  assert.ok(terms.includes('VERTICAL_SETTINGS_KEY = "workspace_vertical"'), "литерал объявлен в словаре");
  assert.ok(server.includes('.eq("key", VERTICAL_SETTINGS_KEY)'), "сервер читает по этой константе");
  assert.ok(server.includes('"clinic_schedule"'), "и тот же ключ пояса");
});
